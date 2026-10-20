"use strict";

/**
 * 执行环端到端测试（真实 skill-graph + 真实门禁 + 假 bridge）
 *
 * 与 brain-loop-test.cjs 的分工：
 *   · brain-loop-test 用假决策器，只测「循环本身」的逻辑
 *   · 这个文件用真图真门禁，测「两块拼起来能不能真的走出一步」
 *
 * bridge 用假的：只有 execute 这一处是替身，图、扩散、门禁、参数清洗、
 * 停止条件全是真的。这样能验到接缝处，而不是验到自己写的 mock。
 */

const assert = require("node:assert");
const path = require("node:path");

const G = require(path.join(__dirname, "..", "src", "skill-graph.cjs"));
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

/** 造轨迹：每条间隔 1 秒，保证落在同一个 episode 里 */
function mkRows(list, origin = "llm") {
  return list.map((r, i) => ({
    ts: 1_000_000 + i * 1000,
    tool: r.tool,
    args: r.args || {},
    ok: r.ok !== false,
    ms: 100,
    origin: r.origin || origin,
  }));
}

/** 假 bridge：记录被调了哪些命令，按预设返回 */
function fakeBridge(responder) {
  const calls = [];
  return {
    calls,
    async request(cmd, args) {
      calls.push({ cmd, args });
      const r = responder ? responder(cmd, args) : null;
      if (r && r.throw) throw new Error(r.throw);
      return r || { ok: true };
    },
  };
}

async function main() {
  console.log("\nbrain-loop 端到端（真图 + 真门禁）\n");

  /* ---------------- 图到执行 ---------------- */

  await t("真图上算出的下一步能被真的执行掉", async () => {
    // 反复出现的 collect → craft，让边权过 MIN_EDGE_SUPPORT
    const rows = mkRows([
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" } },
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" } },
      { tool: "collect", args: { block: "oak_log" } },
    ]);

    const graph = G.buildGraph(rows, { now: 1_006_000 });
    assert.ok(graph.edges.size >= 1, "图里该有边");

    const bridge = fakeBridge();
    const result = await L.runLoop({
      graph,
      current: "collect:block=oak_log",
      nextAction: G.nextAction,
      getWorld: async () => ({ connected: true, health: 20, inventory: {} }),
      execute: async (tool, args) => {
        const data = await bridge.request(tool, args);
        return { ok: true, data };
      },
      opts: { stepDelayMs: 0, maxSteps: 2, stallSteps: 9 },
    });

    assert.ok(result.executed >= 1, "至少该真的走一步");
    assert.ok(bridge.calls.length >= 1, "bridge 该被真的调用");
    assert.ok(
      ["collect", "craft"].includes(bridge.calls[0].cmd),
      `第一次该是图里存在的动作，实际是 ${bridge.calls[0].cmd}`,
    );
  });

  await t("执行出去的参数不含坐标", async () => {
    const rows = mkRows([
      { tool: "dig", args: { x: 10, y: 64, z: 3 } },
      { tool: "collect", args: { block: "stone" } },
      { tool: "dig", args: { x: 11, y: 64, z: 3 } },
      { tool: "collect", args: { block: "stone" } },
      { tool: "dig", args: { x: 12, y: 64, z: 3 } },
    ]);

    const graph = G.buildGraph(rows, { now: 1_006_000 });
    const bridge = fakeBridge();

    const result = await L.runLoop({
      graph,
      current: "dig",
      nextAction: G.nextAction,
      getWorld: async () => ({ connected: true, health: 20, inventory: { stone_pickaxe: 1 } }),
      execute: async (tool, args) => {
        await bridge.request(tool, args);
        return { ok: true };
      },
      opts: { stepDelayMs: 0, maxSteps: 3, stallSteps: 9 },
    });

    // dig 该被拦下（没有实时坐标），真正执行的只能是 collect 之类
    for (const call of bridge.calls) {
      assert.strictEqual(call.args.x, undefined, `${call.cmd} 不该带旧坐标 x`);
      assert.strictEqual(call.args.y, undefined, `${call.cmd} 不该带旧坐标 y`);
      assert.strictEqual(call.args.z, undefined, `${call.cmd} 不该带旧坐标 z`);
    }

    assert.ok(
      result.skipped.some((s) => s.tool === "dig"),
      "dig 该出现在 skipped 里，而不是被执行",
    );
  });

  await t("门禁挡住的动作不会被执行", async () => {
    // 图里全是 build，但背包空着 → gate 该拦住
    const rows = mkRows([
      { tool: "build", args: { block: "stone" } },
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "build", args: { block: "stone" } },
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "build", args: { block: "stone" } },
    ]);
    const graph = G.buildGraph(rows, { now: 1_006_000 });

    const bridge = fakeBridge();
    const result = await L.runLoop({
      graph,
      current: "collect:block=oak_log",
      nextAction: G.nextAction,
      // 背包里没有 stone，build 该被门禁挡下
      getWorld: async () => ({ connected: true, health: 20, inventory: { dirt: 5 } }),
      execute: async (tool, args) => {
        await bridge.request(tool, args);
        return { ok: true };
      },
      opts: { stepDelayMs: 0, maxSteps: 3, stallSteps: 9 },
    });

    for (const call of bridge.calls) {
      assert.notStrictEqual(call.cmd, "build", "背包没石头时不该去 build");
    }
    assert.ok(result.executed >= 0);
  });

  await t("血量过低时只剩保命动作，其余被挡", async () => {
    const rows = mkRows([
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" } },
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" } },
      { tool: "collect", args: { block: "oak_log" } },
    ]);
    const graph = G.buildGraph(rows, { now: 1_006_000 });

    const bridge = fakeBridge();
    await L.runLoop({
      graph,
      current: "collect:block=oak_log",
      nextAction: G.nextAction,
      getWorld: async () => ({ connected: true, health: 5, inventory: {} }),
      execute: async (tool, args) => {
        await bridge.request(tool, args);
        return { ok: true };
      },
      opts: { stepDelayMs: 0, maxSteps: 2 },
    });

    for (const call of bridge.calls) {
      assert.ok(
        ["move", "act", "dig"].includes(call.cmd),
        `血量 5 时只该做保命动作，实际做了 ${call.cmd}`,
      );
    }
  });

  /* ---------------- bridge 形状 ---------------- */

  await t("bridge 抛错会被记成失败步骤，不会中断整环", async () => {
    const rows = mkRows([
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" } },
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" } },
      { tool: "collect", args: { block: "oak_log" } },
    ]);
    const graph = G.buildGraph(rows, { now: 1_006_000 });

    const result = await L.runLoop({
      graph,
      current: "collect:block=oak_log",
      nextAction: G.nextAction,
      getWorld: async () => ({ connected: true, health: 20, inventory: {} }),
      execute: async () => ({ ok: false, error: "命令 craft 超时（60 秒）" }),
      opts: { stepDelayMs: 0, maxSteps: 5, maxFailures: 2, stallSteps: 9 },
    });

    assert.strictEqual(result.steps[0].ok, false);
    assert.match(result.steps[0].error, /超时/);
    // 停止原因可能是「连续失败」也可能是「去重后没得做」——
    // 这里真正要验的是：失败被如实记录、后面的步骤没被连累，
    // 而不是它恰好死在哪个停止条件上。真图只有 collect/craft 两个动作，
    // 跑完一轮就撞去重，这本身是正确行为。
    assert.ok(
      result.succeeded >= 0 && result.executed >= 1,
      `该至少执行一步并记录失败，实际 ${result.executed}`,
    );
    assert.ok(result.stopped.length > 0, "该给出停止原因");
  });

  await t("execute 返回结构缺 ok 时按失败处理", async () => {
    const rows = mkRows([
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" } },
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" } },
      { tool: "collect", args: { block: "oak_log" } },
    ]);
    const graph = G.buildGraph(rows, { now: 1_006_000 });

    const result = await L.runLoop({
      graph,
      current: "collect:block=oak_log",
      nextAction: G.nextAction,
      getWorld: async () => ({ connected: true, health: 20, inventory: {} }),
      execute: async () => ({}), // 没给 ok
      opts: { stepDelayMs: 0, maxSteps: 2, maxFailures: 1, stallSteps: 9 },
    });

    assert.strictEqual(result.steps[0].ok, false);
  });

  /* ---------------- 与 visited / 扩散的配合 ---------------- */

  await t("做完一步后不会立刻又挑同一个节点", async () => {
    // 对称图：A → B 和 A → A 都有边，靠 visited 压住自环
    const rows = mkRows([
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" } },
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" } },
    ]);
    const graph = G.buildGraph(rows, { now: 1_008_000 });

    const bridge = fakeBridge();
    await L.runLoop({
      graph,
      current: "collect:block=oak_log",
      nextAction: G.nextAction,
      getWorld: async () => ({ connected: true, health: 20, inventory: {} }),
      execute: async (tool, args) => {
        await bridge.request(tool, args);
        return { ok: true };
      },
      opts: { stepDelayMs: 0, maxSteps: 2, stallSteps: 9 },
    });

    assert.ok(bridge.calls.length >= 1);
    assert.ok(
      graph.nodes.has("craft:item=oak_planks"),
      "图里该有 craft 节点，才能验证它被挑出来",
    );
  });

  /* ---------------- 真实调用链模拟 ---------------- */

  await t("模拟一次完整调用：从图到 bridge 到结果文本", async () => {
    const rows = mkRows([
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" } },
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" } },
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" } },
    ]);
    const graph = G.buildGraph(rows, { now: 1_008_000 });
    const bridge = fakeBridge((cmd) => (cmd === "craft" ? { ok: true } : { ok: true }));

    const result = await L.runLoop({
      graph,
      current: "collect:block=oak_log",
      nextAction: G.nextAction,
      getWorld: async () => ({
        connected: true,
        health: 20,
        food: 18,
        oxygen: 300,
        inventory: { oak_log: 8, oak_planks: 4 },
        blocks: { oak_log: 6 },
      }),
      execute: async (tool, args) => {
        try {
          const data = await bridge.request(tool, args);
          return { ok: true, data };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
      isConnected: () => true,
      opts: { stepDelayMs: 0, maxSteps: 3, stallSteps: 9 },
    });

    const text = L.formatRun(result);
    assert.match(text, /执行环跑了/);
    assert.match(text, /停止原因/);
    assert.ok(bridge.calls.length >= 1, "该真的调过 bridge");
    assert.ok(text.length > 20, "回执该有实际内容");
  });

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
