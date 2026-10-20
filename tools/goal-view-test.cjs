"use strict";

/**
 * 目标视图（Goal View）单元测试
 *
 * 覆盖：
 *   1. 空输入
 *   2. 节点状态：done / active / ready / blocked / manual
 *   3. 依赖深度（多前置取最大层）
 *   4. 图进度、下一个节点、依赖边
 *   5. 小目标与节点的对应关系
 *   6. 步骤归因透传
 *   7. 坏图不把视图带崩
 *
 * 纯函数测试：不需要临时目录，也不碰追踪器。
 */

const G = require("../src/goal-graph.cjs");
const V = require("../src/goal-view.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

function parse(nodes, name = "主线") {
  const parsed = G.parseGraph({ kind: G.KIND, name, nodes });
  if (!parsed.ok) throw new Error(parsed.errors.join("；"));
  return parsed.graph;
}

/** 一条带分叉与占位的图 */
function sampleGraph() {
  return parse([
    { id: "a", title: "取得原木", kind: "collect", recipe: "oak_log", priority: 100 },
    { id: "b", title: "做出木棍", kind: "craft", recipe: "stick", priority: 90, requires: ["a"] },
    { id: "c", title: "做出木镐", kind: "craft", recipe: "wooden_pickaxe", priority: 80, requires: ["a"] },
    { id: "d", title: "取得铁矿石", kind: "collect", recipe: "iron_ore", priority: 70, requires: ["c"] },
    { id: "e", title: "烧出铁锭", kind: "manual", priority: 60, requires: ["d"] },
    { id: "f", title: "做出铁镐", kind: "craft", recipe: "iron_pickaxe", priority: 50, requires: ["b", "c"] },
  ]);
}

/* 1. 空输入 */
try {
  const view = V.buildGoalView({});
  if (!view.ok) throw new Error("空输入应当返回 ok");
  if (view.bigGoals.length !== 0) throw new Error("空输入不该有图");
  if (view.current !== null) throw new Error("空输入不该有当前目标");
  if (view.smallGoals.length !== 0) throw new Error("空输入不该有小目标");
  ok("空输入：返回空视图而不是报错");
} catch (e) {
  fail("空输入", e);
}

/* 2. 节点状态 */
try {
  const graph = sampleGraph();
  const done = new Set(["a"]);
  const current = {
    id: "graph:主线:b",
    graphName: "主线",
    graphNodeId: "b",
    status: "active",
    progress: 0,
    count: 1,
  };

  const view = V.buildGoalView({
    graphs: [graph],
    graphDone: new Map([["主线", done]]),
    snapshot: {
      current,
      goals: [current],
      counts: { active: 1, pending: 0, done: 0, failed: 0 },
    },
  });

  const nodes = new Map(view.bigGoals[0].nodes.map((n) => [n.id, n]));
  if (nodes.get("a").status !== "done") throw new Error(`a 状态 ${nodes.get("a").status}`);
  if (nodes.get("b").status !== "active") throw new Error(`b 状态 ${nodes.get("b").status}`);
  if (nodes.get("c").status !== "ready") throw new Error(`c 状态 ${nodes.get("c").status}`);
  if (nodes.get("d").status !== "blocked") throw new Error(`d 状态 ${nodes.get("d").status}`);
  if (nodes.get("e").status !== "manual") throw new Error(`e 状态 ${nodes.get("e").status}`);

  ok("状态：done / active / ready / blocked / manual 全部判定正确");
} catch (e) {
  fail("节点状态", e);
}

/* 3. 依赖深度 */
try {
  const graph = sampleGraph();
  const view = V.buildGoalView({ graphs: [graph] });
  const depth = new Map(view.bigGoals[0].nodes.map((n) => [n.id, n.depth]));

  if (depth.get("a") !== 0) throw new Error(`a 深度 ${depth.get("a")}`);
  if (depth.get("b") !== 1) throw new Error(`b 深度 ${depth.get("b")}`);
  if (depth.get("c") !== 1) throw new Error(`c 深度 ${depth.get("c")}`);
  if (depth.get("d") !== 2) throw new Error(`d 深度 ${depth.get("d")}`);
  if (depth.get("e") !== 3) throw new Error(`e 深度 ${depth.get("e")}`);
  // f 同时依赖 b(1) 与 c(1)，深度应为 2
  if (depth.get("f") !== 2) throw new Error(`f 深度 ${depth.get("f")}`);

  ok("深度：分叉节点取最大前置层 + 1");
} catch (e) {
  fail("依赖深度", e);
}

/* 4. 进度 / 下一个 / 边 */
try {
  const graph = sampleGraph();
  const view = V.buildGoalView({
    graphs: [graph],
    graphDone: new Map([["主线", new Set(["a"])]]),
  });
  const big = view.bigGoals[0];

  if (big.total !== 6) throw new Error(`总数 ${big.total}`);
  if (big.done !== 1) throw new Error(`完成数 ${big.done}`);
  if (big.percent !== 17) throw new Error(`百分比 ${big.percent}`);
  if (!big.next || big.next.id !== "b") throw new Error(`下一个 ${big.next && big.next.id}`);
  if (big.edges.length !== 6) throw new Error(`边数 ${big.edges.length}`);

  ok("汇总：进度、下一个节点与依赖边正确");
} catch (e) {
  fail("汇总", e);
}

/* 5. 小目标映射到节点 */
try {
  const graph = sampleGraph();
  const goal = {
    id: "graph:主线:c",
    kind: "craft",
    target: "wooden_pickaxe",
    title: "做出木镐",
    graphName: "主线",
    graphNodeId: "c",
    status: "pending",
    progress: 0,
    count: 1,
    failures: 2,
    attempts: 3,
  };

  const view = V.buildGoalView({
    graphs: [graph],
    graphDone: new Map([["主线", new Set(["a"])]]),
    snapshot: { goals: [goal], current: null },
  });
  const node = view.bigGoals[0].nodes.find((n) => n.id === "c");

  if (node.goalId !== goal.id) throw new Error("节点没有关联目标");
  if (node.goalStatus !== "pending") throw new Error("目标状态没带过来");
  if (node.failures !== 2) throw new Error("失败次数没带过来");

  ok("映射：节点能读出对应的小目标状态");
} catch (e) {
  fail("小目标映射", e);
}

/* 6. 步骤归因透传 */
try {
  const steps = [
    { at: 1, tool: "collect", args: { block: "oak_log" }, ok: true, goals: [] },
  ];
  const view = V.buildGoalView({
    snapshot: { recentSteps: steps, counts: { active: 0, pending: 0, done: 1, failed: 0 } },
  });

  if (view.stepLog.length !== 1) throw new Error("步骤没透传");
  if (view.counts.done !== 1) throw new Error("计数没透传");

  ok("透传：步骤归因与计数原样带出");
} catch (e) {
  fail("步骤透传", e);
}

/* 7. 坏图隔离 */
try {
  const view = V.buildGoalView({
    graphs: [null, { name: "坏图", nodes: "nope" }, sampleGraph()],
    graphDone: new Map(),
  });

  if (view.bigGoals.length !== 1) throw new Error(`应只剩 1 张好图，实际 ${view.bigGoals.length}`);

  ok("健壮性：坏图被跳过，好图照常渲染");
} catch (e) {
  fail("坏图隔离", e);
}

report();

function report() {
  console.log("");
  console.log("═".repeat(56));
  for (const r of results) {
    console.log(`${r.pass ? "  ✔" : "  ✘"} ${r.name}`);
    if (!r.pass) console.log(`       ${r.err && r.err.message ? r.err.message : r.err}`);
  }
  console.log("═".repeat(56));
  const passed = results.filter((r) => r.pass).length;
  console.log(`通过 ${passed} / ${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
}
