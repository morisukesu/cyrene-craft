"use strict";

/**
 * 类脑决策层单元测试（skill-graph.cjs）
 *
 * 只测纯函数，不连服务器、不碰磁盘、不依赖时间以外的东西。
 * 每一项都在验一个「如果这条错了，决策会明显变傻」的点。
 */

const assert = require("node:assert");
const path = require("node:path");
const g = require(path.join(__dirname, "..", "src", "skill-graph.cjs"));

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

console.log("\nskill-graph 类脑决策层\n");

/* ---------------- 节点身份 ---------------- */

t("collect 带 block 时，block 进节点名", () => {
  const id = g.nodeIdOf("collect", { block: "oak_log", count: 8 });
  assert.strictEqual(id, "collect:block=oak_log");
});

t("count / radius 这类抖动参数不进节点名", () => {
  const a = g.nodeIdOf("collect", { block: "oak_log", count: 8, radius: 16 });
  const b = g.nodeIdOf("collect", { block: "oak_log", count: 64, radius: 48 });
  assert.strictEqual(a, b, "换个数量不该变成另一个节点");
});

t("不同 block 是不同的节点", () => {
  const a = g.nodeIdOf("collect", { block: "oak_log" });
  const b = g.nodeIdOf("collect", { block: "stone" });
  assert.notStrictEqual(a, b);
});

t("dig 的坐标不进节点名", () => {
  const a = g.nodeIdOf("dig", { x: 10, y: 64, z: 3 });
  const b = g.nodeIdOf("dig", { x: 99, y: 12, z: -7 });
  assert.strictEqual(a, "dig");
  assert.strictEqual(a, b);
});

t("只读工具不进图", () => {
  assert.strictEqual(g.isActionTool("scan"), false);
  assert.strictEqual(g.isActionTool("status"), false);
  assert.strictEqual(g.isActionTool("collect"), true);
  assert.strictEqual(g.isActionTool("dig"), true);
});

/* ---------------- 建图 ---------------- */

function mkTrace(rows) {
  return rows.map((r, i) => ({
    ts: 1000 + i * 1000,
    tool: r.tool,
    args: r.args || {},
    ok: r.ok !== false,
    ms: r.ms != null ? r.ms : 100,
    origin: r.origin || "llm",
  }));
}

t("连续两个动作产生一条边", () => {
  const rows = mkTrace([
    { tool: "collect", args: { block: "oak_log" } },
    { tool: "craft", args: { item: "oak_planks" } },
  ]);
  const graph = g.buildGraph(rows, { now: 2000 });
  assert.strictEqual(graph.nodes.size, 2);
  assert.strictEqual(graph.edges.size, 1);
  assert.strictEqual(graph.transitions, 1);
});

t("间隔超时会断开 episode，不产生边", () => {
  const rows = [
    { ts: 1000, tool: "collect", args: { block: "oak_log" }, ok: true, ms: 100, origin: "llm" },
    { ts: 1000 + 60_000, tool: "craft", args: { item: "oak_planks" }, ok: true, ms: 100, origin: "llm" },
  ];
  const graph = g.buildGraph(rows, { episodeGapMs: 15_000, now: 1000 + 60_000 });
  assert.strictEqual(graph.edges.size, 0, "隔了一分钟不该算作连续动作");
});

t("只读工具夹在中间，不断开 episode", () => {
  const rows = mkTrace([
    { tool: "collect", args: { block: "oak_log" } },
    { tool: "scan", args: { block: "stone" } },
    { tool: "craft", args: { item: "oak_planks" } },
  ]);
  const graph = g.buildGraph(rows, { now: 5000 });
  assert.strictEqual(graph.nodes.size, 2, "scan 不该成为节点");
  assert.strictEqual(graph.edges.size, 1, "collect → craft 应该连上");
});

t("origin=skill 的轨迹不参与建图", () => {
  const rows = mkTrace([
    { tool: "collect", args: { block: "oak_log" } },
    { tool: "craft", args: { item: "oak_planks" }, origin: "skill" },
  ]);
  const graph = g.buildGraph(rows, { now: 3000 });
  assert.strictEqual(graph.edges.size, 0, "技能自己跑出来的路径不能拿来引导决策");
});

t("origin=autopilot 的轨迹正常进图", () => {
  // 跟 skill 相反：执行环踩过的坑必须留下痕迹，
  // 否则图下次还会推荐同一个其实做不了的动作。
  const rows = mkTrace([
    { tool: "collect", args: { block: "oak_log" } },
    { tool: "craft", args: { item: "oak_planks" }, origin: "autopilot", ok: false },
  ]);
  const graph = g.buildGraph(rows, { now: 3000 });
  assert.strictEqual(graph.nodes.size, 2, "autopilot 应该建节点");
  assert.strictEqual(graph.edges.size, 1, "autopilot 应该建边");
});

t("autopilot 的失败会拉低节点成功率", () => {
  const rows = mkTrace([
    { tool: "collect", args: { block: "oak_log" } },
    { tool: "collect", args: { block: "oak_log" } },
    { tool: "collect", args: { block: "oak_log" }, origin: "autopilot", ok: false },
  ]);
  const graph = g.buildGraph(rows, { now: 5000 });
  const node = graph.nodes.get("collect:block=oak_log");
  assert.strictEqual(node.runs, 3);
  assert.strictEqual(node.fail, 1, "那条失败必须被算进去");
  assert.ok(node.success / node.runs < 1, "成功率该低于 100%");
});

t("同一对动作重复出现，边权会累计增长", () => {
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push(...mkTrace([
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" } },
    ]).map((r) => ({ ...r, ts: r.ts + i * 30_000 })));
  }
  const graph = g.buildGraph(rows, { now: 200_000 });
  const edge = [...graph.edges.values()][0];
  assert.strictEqual(edge.count, 5);
  assert.ok(edge.weight > 0, "5 次共现应该有权重");
});

t("低于支持度阈值的边权重为 0", () => {
  const rows = mkTrace([
    { tool: "collect", args: { block: "oak_log" } },
    { tool: "craft", args: { item: "oak_planks" } },
  ]);
  const graph = g.buildGraph(rows, { now: 2000 });
  const edge = [...graph.edges.values()][0];
  assert.strictEqual(edge.count, 1);
  assert.strictEqual(edge.weight, 0, "只出现一次不该参与排序");
});

t("失败次数多的边，权重低于成功的边", () => {
  const good = [];
  const bad = [];
  for (let i = 0; i < 10; i++) {
    good.push(...mkTrace([
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" }, ok: true },
    ]).map((r) => ({ ...r, ts: r.ts + i * 30_000 })));
    bad.push(...mkTrace([
      { tool: "collect", args: { block: "oak_log" } },
      { tool: "craft", args: { item: "oak_planks" }, ok: false },
    ]).map((r) => ({ ...r, ts: r.ts + i * 30_000 })));
  }
  const gGood = g.buildGraph(good, { now: 400_000 });
  const gBad = g.buildGraph(bad, { now: 400_000 });
  const wGood = [...gGood.edges.values()][0].weight;
  const wBad = [...gBad.edges.values()][0].weight;
  assert.ok(wGood > wBad, `成功边(${wGood.toFixed(2)})应高于失败边(${wBad.toFixed(2)})`);
  assert.strictEqual(wBad, 0, "全失败的边权应为 0");
});

/* ---------------- 能量扩散 ---------------- */

function buildSampleGraph() {
  // collect(oak) → craft(planks)   10 次
  // collect(oak) → craft(sticks)    4 次
  // craft(planks) → build           3 次
  const rows = [];
  let ts = 1000;
  for (let i = 0; i < 10; i++) {
    rows.push(
      { ts: ts += 1000, tool: "collect", args: { block: "oak_log" }, ok: true, ms: 500, origin: "llm" },
      { ts: ts += 1000, tool: "craft", args: { item: "oak_planks" }, ok: true, ms: 300, origin: "llm" },
      { ts: ts += 30_000, tool: "scan", args: {}, ok: true, ms: 10, origin: "llm" }
    );
  }
  for (let i = 0; i < 4; i++) {
    rows.push(
      { ts: ts += 1000, tool: "collect", args: { block: "oak_log" }, ok: true, ms: 500, origin: "llm" },
      { ts: ts += 1000, tool: "craft", args: { item: "stick" }, ok: true, ms: 200, origin: "llm" },
      { ts: ts += 30_000, tool: "scan", args: {}, ok: true, ms: 10, origin: "llm" }
    );
  }
  for (let i = 0; i < 3; i++) {
    rows.push(
      { ts: ts += 1000, tool: "craft", args: { item: "oak_planks" }, ok: true, ms: 300, origin: "llm" },
      { ts: ts += 1000, tool: "build", args: { block: "oak_planks" }, ok: true, ms: 900, origin: "llm" },
      { ts: ts += 30_000, tool: "scan", args: {}, ok: true, ms: 10, origin: "llm" }
    );
  }
  return g.buildGraph(rows, { now: ts });
}

t("从 collect 出发，能量能扩散到两跳外的节点", () => {
  const graph = buildSampleGraph();
  const energy = g.diffuse(graph, "collect:block=oak_log");
  assert.ok(energy.has("craft:item=oak_planks"), "第一跳应该到达 craft");
  assert.ok(energy.has("build:block=oak_planks"), "第二跳应该到达 build");
});

t("高频路径能量高于低频路径", () => {
  const graph = buildSampleGraph();
  const energy = g.diffuse(graph, "collect:block=oak_log");
  const planks = energy.get("craft:item=oak_planks").energy;
  const stick = energy.get("craft:item=stick").energy;
  assert.ok(planks > stick, `planks(${planks.toFixed(2)}) 应高于 stick(${stick.toFixed(2)})`);
});

t("visited 里的节点能量被打折", () => {
  const graph = buildSampleGraph();
  const plain = g.diffuse(graph, "collect:block=oak_log");
  const penalized = g.diffuse(graph, "collect:block=oak_log", {
    visited: new Set(["craft:item=oak_planks"]),
  });
  assert.ok(
    penalized.get("craft:item=oak_planks").energy < plain.get("craft:item=oak_planks").energy,
    "做过的动作应该降权"
  );
});

t("maxHops 限制扩散深度", () => {
  const graph = buildSampleGraph();
  const one = g.diffuse(graph, "collect:block=oak_log", { maxHops: 1 });
  assert.ok(one.has("craft:item=oak_planks"));
  assert.ok(!one.has("build:block=oak_planks"), "只走一跳不该到 build");
});

/* ---------------- 硬门禁 ---------------- */

t("血量低时，非保命动作被挡住", () => {
  const node = { tool: "craft", args: { item: "oak_planks" } };
  const r = g.gate(node, { health: 8 });
  assert.strictEqual(r.pass, false);
  assert.ok(r.reason.includes("保命"));
});

t("血量低时，逃跑动作放行", () => {
  const node = { tool: "move", args: {} };
  const r = g.gate(node, { health: 8 });
  assert.strictEqual(r.pass, true);
});

t("附近没有目标方块时，collect 被挡住", () => {
  const node = { tool: "collect", args: { block: "iron_ore" } };
  const r = g.gate(node, { blocks: { oak_log: 5 } });
  assert.strictEqual(r.pass, false);
  assert.ok(r.reason.includes("iron_ore"));
});

t("附近有目标方块时，collect 放行", () => {
  const node = { tool: "collect", args: { block: "oak_log" } };
  const r = g.gate(node, { blocks: { oak_log: 5 } });
  assert.strictEqual(r.pass, true);
});

t("背包没方块时，build 被挡住", () => {
  const node = { tool: "build", args: { block: "oak_planks" } };
  const r = g.gate(node, { inventory: { oak_log: 10 } });
  assert.strictEqual(r.pass, false);
});

t("背包有方块时，build 放行", () => {
  const node = { tool: "build", args: { block: "oak_planks" } };
  const r = g.gate(node, { inventory: { oak_planks: 10 } });
  assert.strictEqual(r.pass, true);
});

t("没镐时，挖硬方块被挡住", () => {
  const node = { tool: "dig", args: {} };
  const r = g.gate(node, { inventory: { dirt: 5 }, targetHardness: 3 });
  assert.strictEqual(r.pass, false);
  assert.ok(r.reason.includes("镐"));
});

t("有镐时，挖硬方块放行", () => {
  const node = { tool: "dig", args: {} };
  const r = g.gate(node, { inventory: { stone_pickaxe: 1 }, targetHardness: 3 });
  assert.strictEqual(r.pass, true);
});

t("溺水时，非保命动作被挡住", () => {
  const node = { tool: "craft", args: {} };
  const r = g.gate(node, { oxygen: 30 });
  assert.strictEqual(r.pass, false);
});

t("未连接时一律挡住", () => {
  const node = { tool: "collect", args: { block: "oak_log" } };
  const r = g.gate(node, { connected: false });
  assert.strictEqual(r.pass, false);
});

/* ---------------- 主入口 ---------------- */

t("nextAction 在最该做的动作上给出建议", () => {
  const graph = buildSampleGraph();
  const r = g.nextAction(graph, { current: "collect:block=oak_log", inventory: { oak_log: 20 } }, { now: Date.now() });
  assert.ok(r.pick, "应该有建议");
  assert.strictEqual(r.pick.tool, "craft");
  assert.ok(r.candidates.length >= 1);
});

t("门禁挡住的候选不出现在结果里", () => {
  const graph = buildSampleGraph();
  // 血量低，只剩 move/act/dig 能过；样本图里没有这些，应返回空
  const r = g.nextAction(graph, { current: "collect:block=oak_log", health: 5 });
  assert.strictEqual(r.pick, null);
  assert.ok(r.note.includes("前置条件") || r.note.includes("稀疏"));
});

t("空图给出明确的空结果，不编造", () => {
  const r = g.nextAction({ nodes: new Map(), edges: new Map() }, {});
  assert.strictEqual(r.pick, null);
  assert.ok(r.note.includes("还没有节点"));
});

t("没有当前节点时退化为全局评分", () => {
  const graph = buildSampleGraph();
  const r = g.nextAction(graph, {});
  assert.ok(r.pick, "没有当前节点也该给个起点建议");
});

t("formatSuggestion 输出不超过长度上限", () => {
  const graph = buildSampleGraph();
  const r = g.nextAction(graph, { current: "collect:block=oak_log" });
  const text = g.formatSuggestion(r, 120);
  assert.ok(text.length <= 120, `实际 ${text.length} 字`);
  assert.ok(text.includes("下一步建议"));
});

/* ---------------- 工具经验 ---------------- */

t("tool 参与节点身份：空手和木镐是两个节点", () => {
  const a = g.nodeIdOf("collect", { block: "stone" });
  const b = g.nodeIdOf("collect", { block: "stone", tool: "barehand" });
  const c = g.nodeIdOf("collect", { block: "stone", tool: "wooden_pickaxe" });
  assert.strictEqual(a, "collect:block=stone");
  assert.notStrictEqual(b, c, "不同工具应该分开统计");
});

t("totalGain 从 detail.gained 累计到节点", () => {
  const now = Date.now();
  const graph = g.buildGraph(
    [
      {
        ts: now - 3000,
        tool: "collect",
        args: { block: "stone", tool: "wooden_pickaxe" },
        ok: true,
        ms: 400,
        origin: "autoplay",
        detail: { gained: 3 },
      },
      {
        ts: now - 2000,
        tool: "collect",
        args: { block: "stone", tool: "wooden_pickaxe" },
        ok: true,
        ms: 600,
        origin: "autoplay",
        detail: { gained: 5 },
      },
    ],
    { now },
  );

  const node = graph.nodes.get("collect:block=stone:tool=wooden_pickaxe");
  assert.ok(node, "工具节点不存在");
  assert.strictEqual(node.totalGain, 8);
});

t("效率改变排序：高收益工具排到前面", () => {
  const now = Date.now();
  const graph = g.buildGraph(
    [
      // A -> 木镐：每次拿 5 个，跑两次让边权过支持度
      { ts: now - 7000, tool: "move", args: {}, ok: true, ms: 100, origin: "autoplay" },
      {
        ts: now - 6800,
        tool: "collect",
        args: { block: "stone", tool: "wooden_pickaxe" },
        ok: true,
        ms: 400,
        origin: "autoplay",
        detail: { gained: 5 },
      },
      { ts: now - 5000, tool: "move", args: {}, ok: true, ms: 100, origin: "autoplay" },
      {
        ts: now - 4800,
        tool: "collect",
        args: { block: "stone", tool: "wooden_pickaxe" },
        ok: true,
        ms: 400,
        origin: "autoplay",
        detail: { gained: 5 },
      },
      // A -> 空手：失败，也跑两次
      { ts: now - 4600, tool: "move", args: {}, ok: true, ms: 100, origin: "autoplay" },
      {
        ts: now - 4400,
        tool: "collect",
        args: { block: "stone", tool: "barehand" },
        ok: false,
        ms: 300,
        origin: "autoplay",
        detail: { gained: 0 },
      },
      { ts: now - 4000, tool: "move", args: {}, ok: true, ms: 100, origin: "autoplay" },
      {
        ts: now - 3800,
        tool: "collect",
        args: { block: "stone", tool: "barehand" },
        ok: false,
        ms: 300,
        origin: "autoplay",
        detail: { gained: 0 },
      },
    ],
    { now },
  );

  const r = g.nextAction(graph, { current: "move" }, { now });
  assert.ok(r.pick, "应该有候选");
  assert.strictEqual(r.pick.args.tool, "wooden_pickaxe");
});

t("候选输出带 avgGain / gainPerSec", () => {
  const now = Date.now();
  const graph = g.buildGraph(
    [
      { ts: now - 5000, tool: "move", args: {}, ok: true, ms: 100, origin: "autoplay" },
      {
        ts: now - 4800,
        tool: "collect",
        args: { block: "stone", tool: "wooden_pickaxe" },
        ok: true,
        ms: 500,
        origin: "autoplay",
        detail: { gained: 4 },
      },
      { ts: now - 3000, tool: "move", args: {}, ok: true, ms: 100, origin: "autoplay" },
      {
        ts: now - 2800,
        tool: "collect",
        args: { block: "stone", tool: "wooden_pickaxe" },
        ok: true,
        ms: 500,
        origin: "autoplay",
        detail: { gained: 4 },
      },
    ],
    { now },
  );

  const r = g.nextAction(graph, { current: "move" }, { now });
  const pick = r.pick;
  assert.ok(pick);
  assert.strictEqual(pick.avgGain, 4);
  assert.ok(pick.gainPerSec > 0);
});

/* ---------------- 汇总 ---------------- */

console.log(`\n${"-".repeat(50)}`);
console.log(`skill-graph：${pass} 通过 / ${fail} 失败${fail ? ` / 共 ${pass + fail} 项` : "（全过）"}`);

if (fail) {
  console.log("\n失败详情：");
  for (const f of failures) {
    console.log(`\n  ${f.name}`);
    console.log(`  ${f.err.stack.split("\n").slice(0, 3).join("\n  ")}`);
  }
  process.exit(1);
}
