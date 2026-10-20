"use strict";

/**
 * 目标层（Goal）单元测试
 *
 * 覆盖：
 *   1. 空背包生成木头目标
 *   2. 背包木头够了不生成
 *   3. 有镐 + 缺圆石 → 生成圆石目标
 *   4. 没镐 + 缺圆石 → 不生成（挖不动）
 *   5. 选中后只有一个 active
 *   6. 同一个目标不会重复生成
 *   7. 偏置：相关动作 2.0
 *   8. 偏置：无关动作 0.85
 *   9. 偏置：失败过的动作 0.2
 *  10. 偏置：没有目标时恒为 1
 *  11. collect 按 mined 推进
 *  12. 达到 count 变 done
 *  13. 完成后进历史
 *  14. 完成后冷静期内不重新生成
 *  15. 完成冷静期过后可以重新生成
 *  16. 单次失败拉黑动作但不判死
 *  17. 连续失败到上限判 failed
 *  18. 失败目标冷静期内不重新生成
 *  19. 无关动作不推进进度
 *  20. 规则抛错不影响其它规则
 *  21. 目标数超过上限时按优先级裁剪
 *  22. 已有 active 时 refresh 不横跳
 *  23. snapshot 结构完整
 *
 * 全部离线：纯内存，不碰 bot、不碰文件。
 */

const {
  GOAL_STATUS,
  PRIORITY,
  GoalTracker,
  createGoal,
  advanceGoal,
  biasOf,
  goalIdOf,
  countMatching,
  countOf,
  hasPickaxe,
  inventoryCounts,
} = require("../src/goal.cjs");
const { nodeIdOf } = require("../src/skill-graph.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

/** 可控时钟 */
function makeClock(start = 1_000_000) {
  let ts = start;
  return {
    now: () => ts,
    advance(ms) {
      ts += ms;
    },
  };
}

/** 造一个 tracker，规则可覆盖 */
function makeTracker(opts = {}) {
  const clock = opts.clock || makeClock();
  const tracker = new GoalTracker({
    now: clock.now,
    maxGoals: opts.maxGoals,
    maxFailures: opts.maxFailures,
    blockMs: opts.blockMs,
    doneCooldownMs: opts.doneCooldownMs,
    rules: opts.rules,
  });
  return { tracker, clock };
}

/** 背包数组 */
function inv(items) {
  return Object.entries(items).map(([name, count]) => ({ name, count }));
}

/* 1. 空背包生成木头目标 */
try {
  const { tracker } = makeTracker();
  const snap = tracker.refresh({ inventory: [] });

  if (!snap.current) throw new Error("空背包没有生成目标");
  if (snap.current.id !== "collect:oak_log") {
    throw new Error(`目标不对：${snap.current.id}`);
  }
  if (snap.current.count !== 4) throw new Error(`数量不对：${snap.current.count}`);

  ok("生成：空背包生成 collect:oak_log ×4");
} catch (e) {
  fail("生成木头目标", e);
}

/* 2. 背包木头够了不生成 */
try {
  const { tracker } = makeTracker();
  const snap = tracker.refresh({ inventory: inv({ oak_log: 8 }) });

  if (snap.current) throw new Error(`不该有目标：${snap.current.id}`);

  ok("生成：木头足够时不生成目标");
} catch (e) {
  fail("木头足够", e);
}

/* 3. 有镐 + 缺圆石 */
try {
  const { tracker } = makeTracker();
  const snap = tracker.refresh({
    inventory: inv({ oak_log: 8, wooden_pickaxe: 1, cobblestone: 2 }),
  });

  const ids = snap.goals.map((g) => g.id);
  if (!ids.includes("collect:cobblestone")) {
    throw new Error(`没有生成圆石目标：${JSON.stringify(ids)}`);
  }

  ok("生成：有镐且圆石不足时生成 collect:cobblestone");
} catch (e) {
  fail("圆石目标", e);
}

/* 4. 没镐 + 缺圆石 */
try {
  const { tracker } = makeTracker();
  const snap = tracker.refresh({
    inventory: inv({ oak_log: 8, cobblestone: 0 }),
  });

  const ids = snap.goals.map((g) => g.id);
  if (ids.includes("collect:cobblestone")) {
    throw new Error("没镐仍然生成了圆石目标");
  }

  ok("生成：没镐时不生成圆石目标");
} catch (e) {
  fail("没镐不生成", e);
}

/* 5. 只有一个 active */
try {
  const { tracker } = makeTracker();
  const snap = tracker.refresh({
    inventory: inv({ oak_log: 0, wooden_pickaxe: 1, cobblestone: 0 }),
  });

  const active = snap.goals.filter((g) => g.status === GOAL_STATUS.ACTIVE);
  if (active.length !== 1) throw new Error(`active 有 ${active.length} 个`);
  if (!snap.current || snap.current.status !== GOAL_STATUS.ACTIVE) {
    throw new Error("current 不是 active");
  }

  ok("选中：同一时刻只有一个 active");
} catch (e) {
  fail("唯一 active", e);
}

/* 6. 同一个目标不会重复生成 */
try {
  const { tracker } = makeTracker();
  tracker.refresh({ inventory: [] });
  const snap = tracker.refresh({ inventory: [] });

  const same = snap.goals.filter((g) => g.id === "collect:oak_log");
  if (same.length !== 1) throw new Error(`重复生成了 ${same.length} 个`);

  ok("生成：同一目标不重复");
} catch (e) {
  fail("目标去重", e);
}

/* 7. 偏置：相关动作 */
try {
  const goal = createGoal({ kind: "collect", target: "oak_log", count: 4 });
  goal.status = GOAL_STATUS.ACTIVE;

  const factor = biasOf(goal, { tool: "collect", args: { block: "oak_log" } });
  if (factor !== 2.0) throw new Error(`相关动作偏置不对：${factor}`);

  ok("偏置：相关动作 ×2.0");
} catch (e) {
  fail("偏置相关", e);
}

/* 8. 偏置：无关动作 */
try {
  const goal = createGoal({ kind: "collect", target: "oak_log", count: 4 });
  goal.status = GOAL_STATUS.ACTIVE;

  const factor = biasOf(goal, { tool: "collect", args: { block: "sand" } });
  if (factor !== 0.85) throw new Error(`无关动作偏置不对：${factor}`);

  ok("偏置：无关动作 ×0.85");
} catch (e) {
  fail("偏置无关", e);
}

/* 9. 偏置：失败过的动作 */
try {
  const goal = createGoal({ kind: "collect", target: "oak_log", count: 4 });
  goal.status = GOAL_STATUS.ACTIVE;
  // 节点 id 由 skill-graph 决定（collect:block=oak_log），不要手写
  goal.blockedActions.push(nodeIdOf("collect", { block: "oak_log" }));

  const factor = biasOf(goal, { tool: "collect", args: { block: "oak_log" } });
  if (factor !== 0.2) throw new Error(`失败动作偏置不对：${factor}`);

  ok("偏置：失败过的动作 ×0.2");
} catch (e) {
  fail("偏置失败动作", e);
}

/* 10. 偏置：没有目标 */
try {
  const factor = biasOf(null, { tool: "collect", args: { block: "oak_log" } });
  if (factor !== 1) throw new Error(`无目标偏置应为 1，实际 ${factor}`);

  ok("偏置：没有目标时恒为 1");
} catch (e) {
  fail("偏置无目标", e);
}

/* 11. collect 按 mined 推进 */
try {
  const goal = createGoal({ kind: "collect", target: "oak_log", count: 4 });
  goal.status = GOAL_STATUS.ACTIVE;

  advanceGoal(goal, {
    tool: "collect",
    args: { block: "oak_log" },
    ok: true,
    data: { mined: 2, complete: false },
  });

  if (goal.progress !== 2) throw new Error(`进度不对：${goal.progress}`);

  ok("推进：collect 按 mined 累计");
} catch (e) {
  fail("按 mined 推进", e);
}

/* 12. 达到 count 变 done */
try {
  const goal = createGoal({ kind: "collect", target: "oak_log", count: 4 });

  advanceGoal(goal, {
    tool: "collect",
    args: { block: "oak_log" },
    ok: true,
    data: { mined: 4, complete: true },
  });

  if (goal.status !== GOAL_STATUS.DONE) throw new Error(`状态不对：${goal.status}`);
  if (goal.progress !== 4) throw new Error(`进度不对：${goal.progress}`);

  ok("推进：达到 count 变 done");
} catch (e) {
  fail("完成目标", e);
}

/* 13. 完成后进历史 */
try {
  const { tracker } = makeTracker();
  tracker.refresh({ inventory: [] });
  tracker.noteStep({
    tool: "collect",
    args: { block: "oak_log" },
    ok: true,
    data: { mined: 4, complete: true },
  });

  const snap = tracker.refresh({ inventory: inv({ oak_log: 4 }) });
  if (!snap.history.some((h) => h.id === "collect:oak_log" && h.status === GOAL_STATUS.DONE)) {
    throw new Error(`历史里没有完成记录：${JSON.stringify(snap.history)}`);
  }
  if (snap.current) throw new Error("完成后仍然有当前目标");

  ok("结算：完成的目标进历史");
} catch (e) {
  fail("完成进历史", e);
}

/* 14. 完成后冷静期内不重新生成 */
try {
  const { tracker, clock } = makeTracker({ doneCooldownMs: 20_000 });
  tracker.refresh({ inventory: [] });
  tracker.noteStep({
    tool: "collect",
    args: { block: "oak_log" },
    ok: true,
    data: { mined: 4, complete: true },
  });

  // 背包还没更新，规则仍然会命中，但冷静期应该挡住
  clock.advance(5_000);
  const snap = tracker.refresh({ inventory: [] });
  if (snap.current) throw new Error(`冷静期内又生成了：${snap.current.id}`);

  ok("结算：完成后冷静期内不重新生成");
} catch (e) {
  fail("完成冷静期", e);
}

/* 15. 冷静期过后可以重新生成 */
try {
  const { tracker, clock } = makeTracker({ doneCooldownMs: 20_000 });
  tracker.refresh({ inventory: [] });
  tracker.noteStep({
    tool: "collect",
    args: { block: "oak_log" },
    ok: true,
    data: { mined: 4, complete: true },
  });

  clock.advance(25_000);
  const snap = tracker.refresh({ inventory: [] });
  if (!snap.current || snap.current.id !== "collect:oak_log") {
    throw new Error("冷静期过后没有重新生成");
  }

  ok("结算：冷静期过后可以重新生成");
} catch (e) {
  fail("冷静期结束", e);
}

/* 16. 单次失败拉黑但不判死 */
try {
  const goal = createGoal({ kind: "collect", target: "oak_log", count: 4 });

  advanceGoal(goal, {
    tool: "collect",
    args: { block: "oak_log" },
    ok: false,
    error: "走不过去",
  });

  if (goal.status === GOAL_STATUS.FAILED) throw new Error("一次失败就被判死");
  if (!goal.blockedActions.includes(nodeIdOf("collect", { block: "oak_log" }))) {
    throw new Error(`没有拉黑动作：${JSON.stringify(goal.blockedActions)}`);
  }
  if (goal.failures !== 1) throw new Error(`失败次数不对：${goal.failures}`);

  ok("失败：单次失败拉黑但不判死");
} catch (e) {
  fail("单次失败", e);
}

/* 17. 连续失败到上限判 failed */
try {
  const goal = createGoal({ kind: "collect", target: "oak_log", count: 4 });

  for (let i = 0; i < 3; i++) {
    advanceGoal(goal, {
      tool: "collect",
      args: { block: "oak_log" },
      ok: false,
      error: `失败 ${i}`,
    });
  }

  if (goal.status !== GOAL_STATUS.FAILED) throw new Error(`状态不对：${goal.status}`);

  ok("失败：连续失败到上限判 failed");
} catch (e) {
  fail("失败上限", e);
}

/* 18. 失败目标冷静期内不重新生成 */
try {
  const { tracker, clock } = makeTracker({ blockMs: 60_000 });
  tracker.refresh({ inventory: [] });

  for (let i = 0; i < 3; i++) {
    tracker.noteStep({
      tool: "collect",
      args: { block: "oak_log" },
      ok: false,
      error: "走不过去",
    });
  }

  clock.advance(1_000);
  const snap = tracker.refresh({ inventory: [] });
  if (snap.current) throw new Error(`失败冷静期内又生成了：${snap.current.id}`);

  ok("失败：失败目标冷静期内不重新生成");
} catch (e) {
  fail("失败冷静期", e);
}

/* 19. 无关动作不推进 */
try {
  const goal = createGoal({ kind: "collect", target: "oak_log", count: 4 });

  advanceGoal(goal, {
    tool: "collect",
    args: { block: "sand" },
    ok: true,
    data: { mined: 4 },
  });

  if (goal.progress !== 0) throw new Error(`无关动作推进了进度：${goal.progress}`);

  ok("推进：无关动作不影响进度");
} catch (e) {
  fail("无关动作", e);
}

/* 20. 规则抛错不影响其它规则 */
try {
  const rules = [
    {
      id: "broken",
      priority: 50,
      when: () => {
        throw new Error("规则炸了");
      },
      build: () => ({ kind: "collect", target: "broken", count: 1 }),
    },
    {
      id: "fine",
      priority: PRIORITY.MATERIAL,
      when: () => true,
      build: () => ({ kind: "collect", target: "oak_log", count: 4 }),
    },
  ];

  const { tracker } = makeTracker({ rules });
  const snap = tracker.refresh({ inventory: [] });

  if (!snap.current || snap.current.target !== "oak_log") {
    throw new Error("坏规则把好规则一起带崩了");
  }
  if (snap.goals.some((g) => g.target === "broken")) {
    throw new Error("抛错的规则仍然生成了目标");
  }

  ok("健壮性：单条规则抛错不影响其它规则");
} catch (e) {
  fail("规则健壮性", e);
}

/* 21. 超过上限按优先级裁剪 */
try {
  const rules = Array.from({ length: 5 }, (_, i) => ({
    id: `r${i}`,
    priority: (i + 1) * 10,
    when: () => true,
    build: () => ({ kind: "collect", target: `block_${i}`, count: 1 }),
  }));

  const { tracker } = makeTracker({ rules, maxGoals: 3 });
  const snap = tracker.refresh({ inventory: [] });

  if (snap.goals.length !== 3) throw new Error(`没有按上限裁剪：${snap.goals.length}`);
  const targets = snap.goals.map((g) => g.target);
  if (!targets.includes("block_4") || !targets.includes("block_3")) {
    throw new Error(`裁掉了高优先级：${JSON.stringify(targets)}`);
  }

  ok("容量：超过上限时按优先级裁剪");
} catch (e) {
  fail("容量上限", e);
}

/* 22. 已有 active 时 refresh 不横跳 */
try {
  const { tracker } = makeTracker();
  tracker.refresh({ inventory: [] });
  const first = tracker.current();
  if (!first) throw new Error("第一次没有选中目标");

  // 再刷新一次，优先级相同，不应该换目标
  tracker.refresh({ inventory: [] });
  const second = tracker.current();
  if (!second || second.id !== first.id) {
    throw new Error(`目标横跳了：${first.id} -> ${second && second.id}`);
  }

  ok("稳定：已有 active 时 refresh 不横跳");
} catch (e) {
  fail("目标稳定", e);
}

/* 23. snapshot 结构 */
try {
  const { tracker } = makeTracker();
  const snap = tracker.refresh({ inventory: [] });

  for (const key of ["current", "goals", "history", "counts"]) {
    if (!(key in snap)) throw new Error(`snapshot 缺字段：${key}`);
  }
  if (typeof snap.counts.active !== "number") throw new Error("counts.active 不是数字");

  const current = snap.current;
  for (const key of ["id", "kind", "target", "count", "progress", "status"]) {
    if (!(key in current)) throw new Error(`目标摘要缺字段：${key}`);
  }

  ok("结构：snapshot 字段完整");
} catch (e) {
  fail("snapshot 结构", e);
}

/* 24. 背包工具函数 */
try {
  const counts = inventoryCounts([{ name: "oak_log", count: 2 }, { name: "oak_log", count: 3 }]);
  if (counts.get("oak_log") !== 5) throw new Error("数组背包没有累加");
  if (countMatching(inv({ oak_log: 2, birch_log: 3 }), /_log$/) !== 5) {
    throw new Error("匹配统计不对");
  }
  if (countOf(inv({ oak_log: 7 }), "oak_log") !== 7) throw new Error("单物品统计不对");
  if (!hasPickaxe(inv({ stone_pickaxe: 1 }))) throw new Error("没认出镐");
  if (hasPickaxe(inv({ oak_log: 1 }))) throw new Error("把木头当成镐");
  if (goalIdOf({ kind: "collect", target: "oak_log" }) !== "collect:oak_log") {
    throw new Error("目标 id 规则不对");
  }

  ok("工具：背包统计与目标 id 正确");
} catch (e) {
  fail("背包工具", e);
}

/* 25. 有材料没镐 → 生成 craft 目标 */
try {
  const { tracker } = makeTracker();
  const snap = tracker.refresh({
    inventory: inv({ oak_log: 73, oak_planks: 88, stick: 4 }),
  });

  if (!snap.current) throw new Error("没有生成目标");
  if (snap.current.id !== "craft:wooden_pickaxe") {
    throw new Error(`目标不对：${snap.current.id}`);
  }
  if (snap.current.priority !== PRIORITY.TOOL) {
    throw new Error(`优先级不对：${snap.current.priority}`);
  }

  ok("生成：有木板有棍子没镐时生成 craft:wooden_pickaxe");
} catch (e) {
  fail("工具目标", e);
}

/* 26. 已经有镐时不再造 */
try {
  const { tracker } = makeTracker();
  const snap = tracker.refresh({
    inventory: inv({ oak_planks: 88, stick: 4, wooden_pickaxe: 1 }),
  });

  if (snap.goals.some((g) => g.id === "craft:wooden_pickaxe")) {
    throw new Error("有镐仍然生成了木镐目标");
  }

  ok("生成：已经有镐时不重复生成");
} catch (e) {
  fail("不重复造工具", e);
}

/* 27. craft 动作推进 craft 目标 */
try {
  const goal = createGoal({ kind: "craft", target: "wooden_pickaxe", count: 1 });

  advanceGoal(goal, {
    tool: "craft",
    args: { item: "wooden_pickaxe" },
    ok: true,
    data: { ok: true, item: "wooden_pickaxe", crafted: 1 },
  });

  if (goal.status !== GOAL_STATUS.DONE) throw new Error(`状态不对：${goal.status}`);

  ok("推进：craft 成功一次完成目标");
} catch (e) {
  fail("craft 推进", e);
}

/* 28. 目标图：就绪节点变成目标 */
try {
  const { parseGraph } = require("../src/goal-graph.cjs");

  const graph = parseGraph({
    kind: "cyrene-craft-goals",
    name: "主线",
    nodes: [
      { id: "a", title: "第一件事", kind: "collect", recipe: "oak_log", priority: 120 },
      { id: "b", title: "第二件事", kind: "craft", recipe: "stick", priority: 110, requires: ["a"] },
    ],
  }).graph;

  const { tracker } = makeTracker();
  tracker.graphs = [graph];
  const snap = tracker.refresh({ inventory: [] });

  if (!snap.current) throw new Error("没有生成图目标");
  if (snap.current.graphNodeId !== "a") {
    throw new Error(`目标不对：${snap.current.graphNodeId}`);
  }
  if (snap.current.priority !== 120) throw new Error("优先级没带过来");
  if (snap.current.source !== "guide") throw new Error("来源没标成 guide");

  ok("目标图：就绪节点变成目标，优先级压过状态差规则");
} catch (e) {
  fail("目标图生成", e);
}

/* 29. 目标图：前置未完成时不放出下游 */
try {
  const { parseGraph } = require("../src/goal-graph.cjs");

  const graph = parseGraph({
    kind: "cyrene-craft-goals",
    name: "主线",
    nodes: [
      { id: "a", title: "第一件事", kind: "collect", recipe: "oak_log", priority: 120 },
      { id: "b", title: "第二件事", kind: "craft", recipe: "stick", priority: 110, requires: ["a"] },
    ],
  }).graph;

  const { tracker } = makeTracker();
  tracker.graphs = [graph];
  tracker.graphDone.set("主线", new Set(["a"]));

  const snap = tracker.refresh({ inventory: [] });
  if (!snap.current || snap.current.graphNodeId !== "b") {
    throw new Error(`没有推进到 b：${snap.current && snap.current.graphNodeId}`);
  }

  ok("目标图：前置完成后自动放出下游节点");
} catch (e) {
  fail("目标图推进", e);
}

/* 30. 目标图：manual 节点不生成执行目标 */
try {
  const { parseGraph } = require("../src/goal-graph.cjs");

  const graph = parseGraph({
    kind: "cyrene-craft-goals",
    name: "主线",
    nodes: [
      { id: "a", title: "占位", kind: "manual", priority: 200 },
      { id: "b", title: "后面的事", kind: "craft", recipe: "stick", priority: 10, requires: ["a"] },
    ],
  }).graph;

  const { tracker } = makeTracker();
  tracker.graphs = [graph];
  const snap = tracker.refresh({ inventory: [] });

  if (snap.goals.some((g) => g.graphNodeId === "a")) {
    throw new Error("manual 节点生成了目标");
  }
  if (snap.current && snap.current.graphNodeId === "b") {
    throw new Error("manual 没挡住下游");
  }

  ok("目标图：manual 节点占位，不执行也不放行下游");
} catch (e) {
  fail("manual 占位", e);
}

/* 31. 目标图：节点完成时回调落盘 */
try {
  const { parseGraph } = require("../src/goal-graph.cjs");

  const graph = parseGraph({
    kind: "cyrene-craft-goals",
    name: "主线",
    nodes: [
      { id: "a", title: "第一件事", kind: "collect", recipe: "oak_log", priority: 120 },
    ],
  }).graph;

  const events = [];
  const { tracker } = makeTracker();
  tracker.graphs = [graph];
  tracker.onNodeDone = (graphName, nodeId) => events.push(`${graphName}:${nodeId}`);

  tracker.refresh({ inventory: [] });
  tracker.noteStep({
    tool: "collect",
    args: { block: "oak_log" },
    ok: true,
    data: { mined: 1, complete: true },
  });

  if (!events.includes("主线:a")) {
    throw new Error(`没有回调：${JSON.stringify(events)}`);
  }
  if (!tracker.graphDone.get("主线").has("a")) {
    throw new Error("图进度没有更新");
  }

  ok("目标图：节点完成时回调上层落盘");
} catch (e) {
  fail("节点完成回调", e);
}

/* 30. 步骤归因：每一步记录推进了哪些目标 */
try {
  const { tracker } = makeTracker();
  tracker.refresh({ inventory: [] });

  const snap = tracker.noteStep({
    tool: "collect",
    args: { block: "oak_log" },
    ok: true,
    data: { mined: 2 },
    at: Date.now(),
  });

  const last = snap.recentSteps[snap.recentSteps.length - 1];
  if (!last) throw new Error("没有记下这一步");
  if (last.tool !== "collect") throw new Error(`工具不对：${last.tool}`);
  if (!Array.isArray(last.goals) || !last.goals.length) {
    throw new Error("没有目标归因");
  }
  if (last.goals[0].id !== "collect:oak_log") {
    throw new Error(`归因目标不对：${last.goals[0].id}`);
  }
  if (last.goals[0].progress !== 2) {
    throw new Error(`进度不对：${last.goals[0].progress}`);
  }

  ok("步骤归因：每一步记录推进了哪些目标");
} catch (e) {
  fail("步骤归因", e);
}

/* 30b. 采集诊断：collect 的接近策略写进 stepLog */
try {
  const { tracker } = makeTracker();
  tracker.refresh({ inventory: [] });

  const snap = tracker.noteStep({
    tool: "collect",
    args: { block: "oak_log" },
    ok: false,
    error: "到了位置但距离仍有 7.1 格",
    data: {
      complete: false,
      reason: "到了位置但距离仍有 7.1 格",
      approachReason: "所有接近策略都失败",
      terrainKey: "v1:9:abc",
      tried: [
        { kind: "walk", dist: 7.1 },
        { kind: "pillar", error: "垫高失败" },
      ],
    },
    at: Date.now(),
  });

  const row = snap.recentSteps[snap.recentSteps.length - 1];
  if (!row.approach) throw new Error("stepLog 没有接近诊断");
  if (row.approach.reason !== "所有接近策略都失败") throw new Error("接近原因没保留");
  if (row.approach.tried.length !== 2) throw new Error("tried 没保留");

  ok("采集诊断：接近策略与失败原因写进每一步");
} catch (e) {
  fail("采集诊断", e);
}

/* 31. 变更通知：refresh 与 noteStep 各推一次 */
try {
  const { tracker } = makeTracker();
  let fired = 0;
  tracker.onChange = () => {
    fired += 1;
  };

  tracker.refresh({ inventory: [] });
  tracker.noteStep({
    tool: "collect",
    args: { block: "oak_log" },
    ok: true,
    data: { mined: 1 },
    at: Date.now(),
  });

  if (fired !== 2) throw new Error(`通知次数不对：${fired}`);

  ok("变更通知：refresh 与 noteStep 各推一次");
} catch (e) {
  fail("变更通知", e);
}

/* 32. 对账：图节点已满足，直接完成并回调落盘 */
try {
  const graph = {
    name: "g",
    nodes: [
      { id: "get_stone", kind: "collect", recipe: "cobblestone", priority: 10, requires: [] },
    ],
  };
  const tracker = new GoalTracker({ graphs: [graph], rules: [], doneCooldownMs: 0 });
  let fired = 0;
  tracker.onNodeDone = () => {
    fired += 1;
  };

  const snap = tracker.refresh({ inventory: [{ name: "cobblestone", count: 9 }] });

  if (snap.goals.length) throw new Error("已满足的图节点还生成了目标");
  if (!tracker.graphDone.get("g")?.has("get_stone")) throw new Error("节点没有记完成");
  if (fired !== 1) throw new Error(`落盘回调次数不对：${fired}`);
  if (snap.repairs.length !== 1) throw new Error("repairs 没记录");

  ok("对账：背包已满足的图节点直接完成");
} catch (e) {
  fail("对账图节点", e);
}

/* 33. 对账：active 目标背包满足后完成，并放出下游节点 */
try {
  const graph = {
    name: "g",
    nodes: [
      { id: "get_stone", kind: "collect", recipe: "cobblestone", priority: 10, requires: [] },
      {
        id: "craft_pick",
        kind: "craft",
        recipe: "stone_pickaxe",
        priority: 9,
        requires: ["get_stone"],
      },
    ],
  };
  const tracker = new GoalTracker({ graphs: [graph], rules: [], doneCooldownMs: 0 });

  const first = tracker.refresh({ inventory: [] });
  if (first.current?.graphNodeId !== "get_stone") throw new Error("首个目标不对");

  const second = tracker.refresh({
    inventory: [{ name: "cobblestone", count: 3 }],
  });

  if (second.current?.graphNodeId !== "craft_pick") {
    throw new Error(`下游没有放出：${second.current?.graphNodeId}`);
  }
  if (!tracker.graphDone.get("g")?.has("get_stone")) throw new Error("上游没有完成");

  ok("对账：active 目标满足后完成并放出下游");
} catch (e) {
  fail("对账 active 目标", e);
}

/* 34. 对账幂等：重复 refresh 不重复回调、不重复记 repair */
try {
  const graph = {
    name: "g",
    nodes: [
      { id: "get_stone", kind: "collect", recipe: "cobblestone", priority: 10, requires: [] },
    ],
  };
  const tracker = new GoalTracker({ graphs: [graph], rules: [], doneCooldownMs: 0 });
  let fired = 0;
  tracker.onNodeDone = () => {
    fired += 1;
  };

  const world = { inventory: [{ name: "cobblestone", count: 9 }] };
  tracker.refresh(world);
  tracker.refresh(world);
  tracker.refresh(world);

  if (fired !== 1) throw new Error(`重复回调：${fired}`);
  if (tracker.repairLog.length !== 1) throw new Error("repairLog 重复记录");

  ok("对账：重复 refresh 幂等");
} catch (e) {
  fail("对账幂等", e);
}

/* 35. 对账：空背包不误判 */
try {
  const graph = {
    name: "g",
    nodes: [
      { id: "get_stone", kind: "collect", recipe: "cobblestone", priority: 10, requires: [] },
    ],
  };
  const tracker = new GoalTracker({ graphs: [graph], rules: [], doneCooldownMs: 0 });
  const snap = tracker.refresh({ inventory: [] });

  if (tracker.graphDone.get("g")?.has("get_stone")) throw new Error("空背包误判完成");
  if (snap.current?.graphNodeId !== "get_stone") throw new Error("空背包应该保留目标");

  ok("对账：空背包不误判");
} catch (e) {
  fail("对账空背包", e);
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
