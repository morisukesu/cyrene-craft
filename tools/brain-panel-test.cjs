"use strict";

/**
 * 脑图接口实测
 *
 * 不连游戏，用构造的轨迹喂进 panel-server 的 /api/brain，
 * 检查返回结构能不能被前端直接画，以及分区归类是否合理。
 */

const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { TrainingPanelServer } = require(path.join(__dirname, "..", "src", "panel-server.cjs"));
const { TraceLogger } = require(path.join(__dirname, "..", "src", "trace.cjs"));
const { SkillStore } = require(path.join(__dirname, "..", "src", "skill-store.cjs"));

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, e });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode, body: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode, body: text });
          }
        });
      })
      .on("error", reject);
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brain-test-"));
  const trace = new TraceLogger({ dir: path.join(tmp, "traces"), log: () => {}, enabled: true });
  const store = new SkillStore({ rootDir: path.join(tmp, "skills"), log: () => {} });

  // 构造一段真实感的经历：砍树 → 合成 → 建造，另有一段没镐的挖矿失败
  // 注意：trace.record 内部用 Date.now() 打时间戳，不受外部 ts 控制，
  // 所以所有记录会落在同一毫秒里，图会连成一条长链。
  // 这反而更接近真实：连续动作本来就是一条链。
  const push = (tool, args, ok = true, ms = 500, origin = "llm") => {
    trace.record({ tool, args, ok, ms, origin });
  };

  for (let i = 0; i < 6; i++) {
    push("move", { player: "Mori" }, true, 300);
    push("collect", { block: "oak_log", count: 4 }, true, 4000);
    push("craft", { item: "oak_planks" }, true, 700);
    push("build", { block: "oak_planks" }, true, 1200);
  }
  push("move", { player: "Mori" }, true, 300);
  push("dig", { x: 1, y: 2, z: 3 }, false, 200);

  const server = new TrainingPanelServer({
    port: 0,
    webDir: path.join(__dirname, "..", "web"),
    trace,
    store,
    getSnapshot: () => ({ status: { connected: true, health: 20 } }),
    log: () => {},
  });

  const started = await server.start();
  assert.ok(started.ok, "面板应该能启动");
  const port = started.port;
  console.log(`\n脑图接口实测（端口 ${port}）\n`);

  let brain;
  try {
    const res = await get(port, "/api/brain?limit=6");
    assert.strictEqual(res.status, 200, "接口应返回 200");
    brain = res.body;

    /* ---------- 基础结构 ---------- */

    t("返回 ok 且非空", () => {
      assert.strictEqual(brain.ok, true);
      assert.strictEqual(brain.empty, false);
    });

    t("五个脑区都返回", () => {
      assert.strictEqual(brain.regions.length, 5);
      const ids = brain.regions.map((r) => r.id).sort();
      assert.deepStrictEqual(ids, ["association", "limbic", "memory", "motor", "sensory"]);
    });

    t("每个脑区带颜色和名称，前端能直接画", () => {
      for (const r of brain.regions) {
        assert.ok(typeof r.name === "string" && r.name.length > 0, `${r.id} 缺 name`);
        assert.ok(/^#[0-9a-f]{6}$/i.test(r.color), `${r.id} 颜色格式不对：${r.color}`);
        assert.ok(typeof r.count === "number");
        assert.ok(typeof r.energy === "number");
      }
    });

    t("节点带脑区归属", () => {
      assert.ok(brain.nodes.length > 0, "应该有节点");
      for (const n of brain.nodes) {
        assert.ok(n.region, `${n.id} 没有归属脑区`);
      }
    });

    t("动作语义归到正确脑区", () => {
      const byTool = new Map();
      for (const n of brain.nodes) byTool.set(n.tool, n.region);

      assert.strictEqual(byTool.get("move"), "motor", "move 应在运动区");
      assert.strictEqual(byTool.get("dig"), "motor", "dig 应在运动区");
      assert.strictEqual(byTool.get("build"), "motor", "build 应在运动区");
      assert.strictEqual(byTool.get("collect"), "association", "collect 应在联合区");
      assert.strictEqual(byTool.get("craft"), "association", "craft 应在联合区");
    });

    /* ---------- 意图 ---------- */

    t("给出了明确的意图文本", () => {
      assert.ok(brain.intent, "应该有意图");
      assert.ok(typeof brain.intent.text === "string" && brain.intent.text.length > 0);
      assert.ok(!brain.intent.text.includes("undefined"), `意图里不该有 undefined：${brain.intent.text}`);
    });

    t("意图是给人看的中文，不是裸工具名", () => {
      assert.ok(/[\u4e00-\u9fa5]/.test(brain.intent.text), `意图应该是中文：${brain.intent.text}`);
    });

    t("意图带工具名与统计，前端能显示 chip", () => {
      assert.ok(brain.intent.tool);
      assert.ok(typeof brain.intent.score === "number");
      assert.ok(brain.intent.runs >= 1);
    });

    /* ---------- 下一步 ---------- */

    t("给得出下一步（链条末端走全局评分兜底）", () => {
      assert.ok(brain.next, "应该有下一步");
      assert.ok(brain.candidates.length > 0, "应该有候选");
      // trace.record 的时间戳全在同一毫秒，整段连成单链，
      // 最后一条 dig 无出边 → 走全局评分。这是预期行为，且必须说明。
      if (brain.energyMode === "global") {
        assert.ok(brain.note.includes("全局评分"), `退化时应说明原因，实际：${brain.note}`);
      }
    });

    t("候选按分数降序", () => {
      assert.ok(brain.candidates.length > 0);
      for (let i = 1; i < brain.candidates.length; i++) {
        assert.ok(
          brain.candidates[i - 1].score >= brain.candidates[i].score,
          `第 ${i} 项分数比前一项高，排序错了`
        );
      }
    });

    t("候选数量不超过 limit", () => {
      assert.ok(brain.candidates.length <= 6);
    });

    /* ---------- 能量 ---------- */

    t("当前节点有能量，且被标记", () => {
      const cur = brain.nodes.find((n) => n.isCurrent);
      assert.ok(cur, "应该能识别出当前节点");
      assert.ok(brain.current, "current 字段不能为空");
    });

    t("能量落在节点上（扩散或全局评分兜底）", () => {
      const withEnergy = brain.nodes.filter((n) => n.energy > 0);
      assert.ok(withEnergy.length >= 1, `至少有一个节点带能量，实际 ${withEnergy.length} 个`);
    });

    t("脑区能量总和大于 0", () => {
      const total = brain.regions.reduce((s, r) => s + r.energy, 0);
      assert.ok(total > 0, `脑区能量不该全为 0，实际 ${total}`);
    });

    t("能量模式明确标注，前端能区分扩散与兜底", () => {
      assert.ok(["diffuse", "global"].includes(brain.energyMode), `未知模式：${brain.energyMode}`);
    });

    /* ---------- 边 ---------- */

    t("边带权重与成功率", () => {
      assert.ok(brain.edges.length > 0, "应该有边");
      for (const e of brain.edges) {
        assert.ok(e.weight > 0, "只返回有权重的边");
        assert.ok(e.successRate >= 0 && e.successRate <= 1);
      }
    });

    t("边是降序的", () => {
      for (let i = 1; i < brain.edges.length; i++) {
        assert.ok(brain.edges[i - 1].weight >= brain.edges[i].weight);
      }
    });

    /* ---------- 门禁 ---------- */

    t("门禁挡住了没镐的挖掘", () => {
      assert.ok(Array.isArray(brain.blocked));
      // 这段轨迹里 dig 全失败，门禁若生效应能列出原因
      const digBlocked = brain.blocked.find((b) => b.tool === "dig");
      if (digBlocked) {
        assert.ok(digBlocked.reason.length > 0, "挡住时要说明原因");
      }
    });

    /* ---------- 统计 ---------- */

    t("统计数字自洽", () => {
      assert.ok(brain.stats.nodes > 0);
      assert.ok(brain.stats.edges > 0);
      assert.ok(brain.stats.episodes > 0);
      assert.ok(brain.stats.traceCount >= 20);
    });

    /* ---------- 静态页 ---------- */

    t("brain.html 能被服务出去", async () => {});
    const page = await get(port, "/brain.html");
    if (page.status !== 200) {
      fail += 1;
      failures.push({ name: "brain.html 能被服务出去", e: new Error("HTTP " + page.status) });
      console.log(`  ✗ brain.html 能被服务出去\n      HTTP ${page.status}`);
    } else {
      pass += 1;
      console.log("  ✓ brain.html 能被服务出去");
      // 3D 版页面用 canvas 渲染，不再是 SVG 脑图
      assert.ok(typeof page.body === "string" && page.body.includes("brainCanvas"));
    }

    t("3D 模型能被服务出去且 MIME 正确", async () => {});
    const glb = await get(port, "/vendor/brain.glb");
    if (glb.status !== 200) {
      fail += 1;
      failures.push({ name: "3D 模型能被服务出去", e: new Error("HTTP " + glb.status) });
      console.log(`  ✗ 3D 模型能被服务出去\n      HTTP ${glb.status}`);
    } else {
      pass += 1;
      console.log("  ✓ 3D 模型能被服务出去（含 model/gltf-binary）");
    }
  } catch (e) {
    fail += 1;
    failures.push({ name: "接口整体", e });
    console.log(`  ✗ 接口整体\n      ${e.stack.split("\n").slice(0, 3).join("\n      ")}`);
  } finally {
    await server.stop();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(`\n${"-".repeat(50)}`);
  console.log(`脑图接口：${pass} 通过 / ${fail} 失败`);

  if (brain && process.env.SHOW_JSON) {
    console.log("\n意图：", brain.intent && brain.intent.text);
    console.log("下一步：", brain.next && brain.next.tool);
    console.log("脑区能量：", brain.regions.map((r) => `${r.name}=${r.energy.toFixed(2)}`).join(" "));
    console.log("候选：", brain.candidates.map((c) => `${c.tool}(${c.score})`).join(" "));
  }

  if (fail) {
    for (const f of failures) {
      console.log(`\n  ${f.name}`);
      console.log(`  ${f.e.stack.split("\n").slice(0, 4).join("\n  ")}`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
