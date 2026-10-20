"use strict";

/**
 * 执行环单元测试（brain-loop.cjs）
 *
 * 全部离线：不连服务器、不碰磁盘、不等真实时间。
 * 每一项都在验一个「如果这条错了，昔涟会真的去做错事」的点 ——
 * 尤其是坐标清洗和停止条件，那两条错了不会有报错，只会有静默的傻。
 */

const assert = require("node:assert");
const path = require("node:path");

const L = require(path.join(__dirname, "..", "src", "brain-loop.cjs"));

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  return (async () => {
    try {
      await fn();
      pass += 1;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      fail += 1;
      failures.push({ name, err });
      console.log(`  ✗ ${name}\n      ${err.message}`);
    }
  })();
}

/**
 * 每次返回「新的、没做过的」候选。
 *
 * 执行环现在会跳过本轮已做过的节点（同一个动作连做两遍不算下一步），
 * 所以测步数/停滞这类「跑多久」的用例，必须让每步都是新动作，
 * 否则停下来的是去重规则，而不是被测的那条停止条件。
 */
function freshPlanner(build) {
  const used = new Set();
  let seq = 0;
  return (graph, world, opts) => {
    for (let i = 0; i < 200; i++) {
      seq += 1;
      const c = build(seq);
      const id = `${c.tool}:${JSON.stringify(c.args)}`;
      if (used.has(id)) continue;
      used.add(id);
      return { pick: c, candidates: [c], note: "" };
    }
    return { pick: null, candidates: [], note: "候选耗尽" };
  };
}

/** 造一个 pick 形状的候选。override 用来覆盖 runs / successRate 等统计字段 */
function cand(tool, args = {}, score = 1, override = {}) {
  return {
    id: `${tool}`,
    tool,
    args,
    score,
    energy: score,
    hop: 1,
    via: "seed",
    runs: 3,
    successRate: 1,
    avgMs: 100,
    ...override,
  };
}

/**
 * 造一个假决策器：按给定顺序吐候选，吐完就返回空。
 * 这样可以在不建真图的情况下测循环本身。
 * 注意「吐完返回空」很重要 —— 如果让它重复吐最后一行，
 * 测出来的就不再是「序列走完自然停」，而是「步数上限截断」。
 */
function fakePlanner(sequence, note = "") {
  let i = 0;
  return (graph, world, opts) => {
    const row = sequence[i];
    i += 1;
    if (!row || !row.length) {
      return { pick: null, candidates: [], note: note || "序列已走完" };
    }
    return { pick: row[0], candidates: row, note: "" };
  };
}

async function main() {
  console.log("\nbrain-loop 执行环\n");

  /* ---------------- 参数清洗 ---------------- */

  await t("坐标参数被剥掉，其余保留", () => {
    const args = L.sanitizeArgs({ args: { block: "oak_log", count: 8, x: 10, y: 64, z: 3 } });
    assert.deepStrictEqual(args, { block: "oak_log", count: 8 });
  });

  await t("清洗不改动原节点", () => {
    const node = { args: { block: "stone", x: 1, y: 2, z: 3 } };
    L.sanitizeArgs(node);
    assert.strictEqual(node.args.x, 1, "原对象不该被就地修改");
  });

  await t("没有 args 时返回空对象", () => {
    assert.deepStrictEqual(L.sanitizeArgs({}), {});
    assert.deepStrictEqual(L.sanitizeArgs(null), {});
  });

  /* ---------------- 可执行判定 ---------------- */

  await t("dig 被拦下：图里只有旧坐标", () => {
    const r = L.checkExecutable(cand("dig", { x: 10, y: 64, z: 3 }));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /实时坐标/);
  });

  await t("place 被拦下：同样需要实时坐标", () => {
    assert.strictEqual(L.checkExecutable(cand("place", { block: "stone" })).ok, false);
  });

  await t("move 走去坐标被拦下", () => {
    const r = L.checkExecutable(cand("move", { x: 1, y: 2, z: 3 }));
    assert.strictEqual(r.ok, false);
  });

  await t("move 跟玩家放行", () => {
    assert.strictEqual(L.checkExecutable(cand("move", { player: "Mori" })).ok, true);
  });

  await t("collect 不受坐标影响，放行", () => {
    assert.strictEqual(L.checkExecutable(cand("collect", { block: "oak_log", radius: 16 })).ok, true);
  });

  await t("危险命令一律不放行", () => {
    for (const tool of L.FORBIDDEN_TOOLS) {
      const r = L.checkExecutable(cand(tool));
      assert.strictEqual(r.ok, false, `${tool} 不该被自动执行`);
    }
  });

  await t("say / command 被拦下：对外发声不连跑", () => {
    assert.strictEqual(L.checkExecutable(cand("say", { message: "hi" })).ok, false);
    assert.strictEqual(L.checkExecutable(cand("command", { command: "/list" })).ok, false);
  });

  await t("deny 策略生效", () => {
    const deny = new Set(["build"]);
    assert.strictEqual(L.checkExecutable(cand("build", { block: "stone" }), { deny }).ok, false);
  });

  await t("没有工具名时报不可执行", () => {
    assert.strictEqual(L.checkExecutable({}).ok, false);
    assert.strictEqual(L.checkExecutable(null).ok, false);
  });

  await t("成功率太低且样本够多时被跳过", () => {
    const r = L.checkExecutable(cand("collect", { block: "oak_log" }, 1, { runs: 14, successRate: 0.5 }));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /50%/);
    assert.match(r.reason, /14 次/);
  });

  await t("刚跌破门槛的也会被跳过", () => {
    // 实跑里 collect 掉到 64%，正是这条把它拦下来的
    const r = L.checkExecutable(cand("collect", { block: "oak_log" }, 1, { runs: 14, successRate: 0.64 }));
    assert.strictEqual(r.ok, false);
  });

  await t("样本不够时成功率再低也不否决", () => {
    // 跑过 2 次失败 1 次就是 50%，样本太少不能判死刑
    const r = L.checkExecutable(cand("collect", { block: "oak_log" }, 1, { runs: 2, successRate: 0.5 }));
    assert.strictEqual(r.ok, true);
  });

  await t("成功率达标时放行", () => {
    const r = L.checkExecutable(cand("collect", { block: "oak_log" }, 1, { runs: 20, successRate: 0.8 }));
    assert.strictEqual(r.ok, true);
  });

  await t("门槛值可以覆盖", () => {
    const node = cand("collect", { block: "oak_log" }, 1, { runs: 10, successRate: 0.6 });
    assert.strictEqual(L.checkExecutable(node, { minSuccessRate: 0.7 }).ok, false);
    assert.strictEqual(L.checkExecutable(node, { minSuccessRate: 0.5 }).ok, true);
  });

  await t("没有成功率字段时不触发否决", () => {
    const r = L.checkExecutable({ tool: "collect", args: { block: "oak_log" }, runs: 99 });
    assert.strictEqual(r.ok, true);
  });

  /* ---------------- 结果判定 ---------------- */

  await t("complete:false 算没做成，哪怕 ok 是 true", () => {
    const v = L.judgeOutcome({ ok: true, complete: false, reason: "32 格内找不到 oak_log" });
    assert.strictEqual(v.ok, false);
    assert.match(v.error, /找不到/);
  });

  await t("complete:true 算做成了", () => {
    assert.strictEqual(L.judgeOutcome({ ok: true, complete: true }).ok, true);
  });

  await t("没有 complete 字段时按 ok 处理", () => {
    assert.strictEqual(L.judgeOutcome({ ok: true }).ok, true);
    assert.strictEqual(L.judgeOutcome({}).ok, true);
    assert.strictEqual(L.judgeOutcome(null).ok, true);
  });

  await t("complete:false 但没给 reason 时有兜底文案", () => {
    const v = L.judgeOutcome({ complete: false });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.error, "没有达成目标");
  });

  /* ---------------- 主循环 ---------------- */

  await t("正常跑完并记录每一步", async () => {
    const planner = fakePlanner([
      [cand("collect", { block: "oak_log" }, 3)],
      [cand("craft", { item: "oak_planks" }, 2)],
    ]);

    const result = await L.runLoop({
      graph: {},
      current: "seed",
      nextAction: planner,
      getWorld: async () => ({ connected: true }),
      execute: async () => ({ ok: true }),
      opts: { stepDelayMs: 0, maxSteps: 4 },
    });

    assert.strictEqual(result.executed, 2);
    assert.strictEqual(result.succeeded, 2);
    assert.strictEqual(result.steps[0].tool, "collect");
    assert.strictEqual(result.steps[1].tool, "craft");
    assert.strictEqual(result.stopped, "序列已走完", "序列走完该自然收工，而不是撞步数上限");
  });

  await t("执行的是清洗后的参数，不含坐标", async () => {
    let seen = null;
    await L.runLoop({
      graph: {},
      nextAction: fakePlanner([[cand("collect", { block: "oak_log", x: 9, y: 9, z: 9 })]]),
      getWorld: async () => ({}),
      execute: async (tool, args) => {
        seen = args;
        return { ok: true };
      },
      opts: { stepDelayMs: 0, maxSteps: 1 },
    });
    assert.deepStrictEqual(seen, { block: "oak_log" });
  });

  await t("步数上限到了就停", async () => {
    const result = await L.runLoop({
      graph: {},
      nextAction: freshPlanner((n) => cand("collect", { block: `block_${n}`, count: 1 }, 1)),
      getWorld: async () => ({}),
      execute: async () => ({ ok: true }),
      opts: { stepDelayMs: 0, maxSteps: 3, stallSteps: 99 },
    });
    assert.strictEqual(result.executed, 3);
    assert.match(result.stopped, /步数上限/);
  });

  await t("同一个动作不会被连做两遍", async () => {
    const result = await L.runLoop({
      graph: {},
      nextAction: () => ({
        pick: cand("collect", { block: "oak_log" }),
        candidates: [cand("collect", { block: "oak_log" })],
        note: "",
      }),
      getWorld: async () => ({}),
      execute: async () => ({ ok: true }),
      opts: { stepDelayMs: 0, maxSteps: 5, stallSteps: 99 },
    });
    assert.strictEqual(result.executed, 1, "第二步该因为「本轮已经做过」被跳过");
    assert.ok(result.skipped.some((s) => s.reason.includes("已经做过")));
  });

  await t("连续失败达到阈值就停", async () => {
    const result = await L.runLoop({
      graph: {},
      nextAction: freshPlanner((n) => cand("collect", { block: `stone_${n}` })),
      getWorld: async () => ({}),
      execute: async () => ({ ok: false, error: "挖不动" }),
      opts: { stepDelayMs: 0, maxSteps: 8, maxFailures: 2, stallSteps: 99 },
    });
    assert.strictEqual(result.executed, 2);
    assert.strictEqual(result.failed, 2);
    assert.match(result.stopped, /连续失败 2 次/);
  });

  await t("成功会重置失败计数", async () => {
    let n = 0;
    const result = await L.runLoop({
      graph: {},
      nextAction: freshPlanner((i) => cand("collect", { block: `log_${i}` })),
      getWorld: async () => ({}),
      execute: async () => {
        n += 1;
        return n === 1 ? { ok: false, error: "偶尔失败" } : { ok: true };
      },
      opts: { stepDelayMs: 0, maxSteps: 5, maxFailures: 2, stallSteps: 99 },
    });
    assert.strictEqual(result.stopped.includes("连续失败"), false, "中间成功过就不该算连续失败");
    assert.strictEqual(result.executed, 5);
  });

  await t("分数不涨会停，不会原地打转", async () => {
    // 每步换一个新动作（否则先撞的是去重规则），但分数固定不涨
    const result = await L.runLoop({
      graph: {},
      nextAction: freshPlanner((n) => cand("collect", { block: `log_${n}` }, 2)),
      getWorld: async () => ({}),
      execute: async () => ({ ok: true }),
      opts: { stepDelayMs: 0, maxSteps: 20, stallSteps: 3, maxFailures: 99 },
    });
    assert.ok(result.executed <= 4, `应该早早停下，实际跑了 ${result.executed} 步`);
    assert.match(result.stopped, /分数没有上升/);
  });

  await t("分数持续上涨时不触发停滞", async () => {
    let s = 1;
    const result = await L.runLoop({
      graph: {},
      nextAction: freshPlanner((n) => {
        s *= 2;
        return cand("collect", { block: `log_${n}` }, s);
      }),
      getWorld: async () => ({}),
      execute: async () => ({ ok: true }),
      opts: { stepDelayMs: 0, maxSteps: 5, stallSteps: 3, maxFailures: 99 },
    });
    assert.strictEqual(result.executed, 5);
    assert.match(result.stopped, /步数上限/);
  });

  await t("首选被挡时顺位换下一个候选", async () => {
    const row = [cand("dig", { x: 1, y: 2, z: 3 }, 9), cand("collect", { block: "oak_log" }, 5)];
    const result = await L.runLoop({
      graph: {},
      nextAction: fakePlanner([row]),
      getWorld: async () => ({}),
      execute: async (tool) => ({ ok: tool === "collect" }),
      opts: { stepDelayMs: 0, maxSteps: 1 },
    });
    assert.strictEqual(result.steps[0].tool, "collect", "该跳过 dig 去挖木头");
    assert.ok(result.skipped.some((s) => s.tool === "dig"));
  });

  await t("候选全被挡住时一步都不执行，并说明原因", async () => {
    const row = [cand("dig", { x: 1, y: 2, z: 3 }, 9), cand("say", { message: "hi" }, 5)];
    const result = await L.runLoop({
      graph: {},
      nextAction: fakePlanner([row]),
      getWorld: async () => ({}),
      execute: async () => {
        throw new Error("不该被执行");
      },
      opts: { stepDelayMs: 0, maxSteps: 3 },
    });
    assert.strictEqual(result.executed, 0);
    assert.match(result.stopped, /候选都不可执行/);
    assert.match(result.stopped, /dig/);
  });

  await t("没有 pick 时直接收工", async () => {
    const result = await L.runLoop({
      graph: {},
      nextAction: () => ({ pick: null, candidates: [], note: "图太稀疏" }),
      getWorld: async () => ({}),
      execute: async () => ({ ok: true }),
      opts: { stepDelayMs: 0 },
    });
    assert.strictEqual(result.executed, 0);
    assert.strictEqual(result.stopped, "图太稀疏");
  });

  await t("世界状态每步都重取一次", async () => {
    let calls = 0;
    await L.runLoop({
      graph: {},
      nextAction: freshPlanner((n) => cand("collect", { block: `log_${n}` })),
      getWorld: async () => {
        calls += 1;
        return {};
      },
      execute: async () => ({ ok: true }),
      opts: { stepDelayMs: 0, maxSteps: 3, stallSteps: 99 },
    });
    assert.strictEqual(calls, 3, "每步都该重新取世界状态");
  });

  await t("连接断开时立即停", async () => {
    const result = await L.runLoop({
      graph: {},
      nextAction: () => ({ pick: cand("collect", { block: "oak_log" }), candidates: [cand("collect", { block: "oak_log" })], note: "" }),
      getWorld: async () => ({}),
      execute: async () => ({ ok: true }),
      isConnected: () => false,
      opts: { stepDelayMs: 0, maxSteps: 5 },
    });
    assert.strictEqual(result.executed, 0);
    assert.match(result.stopped, /连接已断开/);
  });

  await t("外部停止信号生效", async () => {
    let n = 0;
    const result = await L.runLoop({
      graph: {},
      nextAction: () => ({ pick: cand("collect", { block: "oak_log" }), candidates: [cand("collect", { block: "oak_log" })], note: "" }),
      getWorld: async () => ({}),
      execute: async () => {
        n += 1;
        return { ok: true };
      },
      shouldStop: () => n >= 1,
      opts: { stepDelayMs: 0, maxSteps: 5, stallSteps: 99 },
    });
    assert.strictEqual(result.executed, 1);
    assert.match(result.stopped, /停止请求/);
  });

  await t("execute 抛错被记为失败，不炸掉整个环", async () => {
    let n = 0;
    const result = await L.runLoop({
      graph: {},
      nextAction: freshPlanner((i) => cand("collect", { block: `log_${i}` })),
      getWorld: async () => ({}),
      execute: async () => {
        n += 1;
        if (n === 1) throw new Error("bridge 断了");
        return { ok: true };
      },
      opts: { stepDelayMs: 0, maxSteps: 2, maxFailures: 2, stallSteps: 99 },
    });
    assert.strictEqual(result.steps[0].ok, false);
    assert.match(result.steps[0].error, /bridge 断了/);
    assert.strictEqual(result.succeeded, 1);
  });

  await t("current 随执行推进，visited 累积", async () => {
    const result = await L.runLoop({
      graph: {},
      current: "seed",
      nextAction: fakePlanner([
        [cand("collect", { block: "oak_log" })],
        [cand("craft", { item: "oak_planks" })],
      ]),
      getWorld: async () => ({}),
      execute: async () => ({ ok: true }),
      opts: { stepDelayMs: 0, maxSteps: 2, stallSteps: 99 },
    });
    assert.strictEqual(result.finalCurrent, "craft:item=oak_planks");
    assert.ok(result.visited.includes("seed"));
    assert.ok(result.visited.includes("collect:block=oak_log"));
  });

  await t("visited 会被传给下一轮决策，避免原地打转", async () => {
    let received = null;
    await L.runLoop({
      graph: {},
      nextAction: (graph, world, opts) => {
        received = opts.visited;
        return {
          pick: cand("collect", { block: "oak_log" }),
          candidates: [cand("collect", { block: "oak_log" })],
          note: "",
        };
      },
      getWorld: async () => ({}),
      execute: async () => ({ ok: true }),
      opts: { stepDelayMs: 0, maxSteps: 2, stallSteps: 99 },
    });
    assert.ok(received instanceof Set);
    assert.ok(received.has("collect:block=oak_log"), "第二轮该知道上一步做过什么");
  });

  await t("没跑任何步骤时 ok 为 false", async () => {
    const result = await L.runLoop({
      graph: {},
      nextAction: () => ({ pick: null, candidates: [], note: "空" }),
      getWorld: async () => ({}),
      execute: async () => ({ ok: true }),
      opts: { stepDelayMs: 0 },
    });
    assert.strictEqual(result.ok, false);
  });

  /* ---------------- 文本输出 ---------------- */

  await t("formatRun 输出成功与失败步骤", () => {
    const text = L.formatRun({
      executed: 2,
      succeeded: 1,
      failed: 1,
      stopped: "连续失败 2 次",
      skipped: [],
      steps: [
        { step: 1, tool: "collect", args: { block: "oak_log" }, ok: true, ms: 1200, error: null },
        { step: 2, tool: "craft", args: { item: "plank" }, ok: false, ms: 300, error: "缺材料" },
      ],
    });
    assert.match(text, /成功 1 次/);
    assert.match(text, /✔ 1\. collect/);
    assert.match(text, /✘ 2\. craft/);
    assert.match(text, /缺材料/);
    assert.match(text, /停止原因/);
  });

  await t("formatRun 在零执行时说明原因", () => {
    const text = L.formatRun({ executed: 0, steps: [], skipped: [], stopped: "图太稀疏" });
    assert.match(text, /没有执行任何动作/);
    assert.match(text, /图太稀疏/);
  });

  await t("formatRun 带上被跳过的候选", () => {
    const text = L.formatRun({
      executed: 1,
      succeeded: 1,
      failed: 0,
      stopped: "步数上限",
      skipped: [{ tool: "dig", reason: "需要实时坐标" }],
      steps: [{ step: 1, tool: "collect", args: {}, ok: true, ms: 100, error: null }],
    });
    assert.match(text, /跳过的候选/);
    assert.match(text, /dig/);
  });

  /* ---------------- 收尾 ---------------- */

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);

  if (fail) {
    for (const f of failures) console.log(`失败项：${f.name}\n${f.err.stack}\n`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("测试框架本身崩了：", e);
  process.exitCode = 1;
});
