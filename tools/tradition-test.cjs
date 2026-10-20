"use strict";

/**
 * 流派层（提纯机制）单元测试
 *
 * 覆盖：
 *   1. pathScore 四个因子（成功率 / 步骤 / 耗时 / 新鲜度）
 *   2. 目标识别与分组
 *   3. 组内竞争（primary / backup / candidate / archived）
 *   4. 连续弱 3 次归档
 *   5. LCS 相似度与合并
 *   6. 技能库剪枝（含不超限的保护用例）
 *   7. 图剪枝（stale 边 / 孤立节点 / 上限）
 *   8. consolidate 汇总与 dry-run
 *   9. 归档恢复补丁
 *
 * 全部纯函数，不碰文件。
 */

const {
  pathScore,
  goalOf,
  groupByGoal,
  rank,
  similarity,
  lcsLength,
  planMerges,
  pruneSkills,
  pruneGraph,
  consolidate,
  restorePatch,
  WEAK_STREAK_LIMIT,
} = require("../src/tradition.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

const NOW = Date.parse("2026-10-20T00:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();
const DAY = 86400000;

function makeSkill(name, opts = {}) {
  return {
    name,
    steps: opts.steps || [{ cmd: "collect", args: { block: "oak_log", count: 3 } }],
    stats: {
      runs: opts.runs === undefined ? 10 : opts.runs,
      success: opts.success === undefined ? 10 : opts.success,
      fail: opts.fail === undefined ? 0 : opts.fail,
      durations: opts.durations || [1000],
      lastRunAt: opts.lastRunAt === undefined ? NOW_ISO : opts.lastRunAt,
    },
    archived: Boolean(opts.archived),
    competition: { weakStreak: opts.weakStreak === undefined ? 0 : opts.weakStreak, lastEvalAt: null },
  };
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* 1. pathScore 基准：全是 1 → 1 */
try {
  const s = makeSkill("base");
  const score = pathScore(s, { now: NOW });
  if (!near(score, 1)) throw new Error(`基准分应为 1，实际 ${score}`);
  ok("pathScore：成功率 1、1 步、1 秒、刚跑过 → 1");
} catch (e) {
  fail("pathScore 基准", e);
}

/* 2. 成功率平方（balanced） */
try {
  const s = makeSkill("half", { success: 5 });
  const score = pathScore(s, { now: NOW });
  if (!near(score, 0.25)) throw new Error(`应为 0.25，实际 ${score}`);
  ok("pathScore：50% 成功率在 balanced 下按平方计（0.25）");
} catch (e) {
  fail("pathScore 成功率", e);
}

/* 3. 步骤数惩罚 */
try {
  const s = makeSkill("two_steps", {
    steps: [
      { cmd: "collect", args: { block: "oak_log" } },
      { cmd: "craft", args: { item: "oak_planks" } },
    ],
  });
  const score = pathScore(s, { now: NOW });
  if (!near(score, 0.5)) throw new Error(`2 步应减半，实际 ${score}`);
  ok("pathScore：步骤翻倍，分数减半");
} catch (e) {
  fail("pathScore 步骤", e);
}

/* 4. 耗时惩罚 */
try {
  const s = makeSkill("slow", { durations: [2000, 2000] });
  const score = pathScore(s, { now: NOW });
  if (!near(score, 0.5)) throw new Error(`2 秒应减半，实际 ${score}`);
  ok("pathScore：平均耗时 2 秒，分数减半");
} catch (e) {
  fail("pathScore 耗时", e);
}

/* 5. 新鲜度衰减 */
try {
  const s = makeSkill("old", { lastRunAt: new Date(NOW - 30 * DAY).toISOString() });
  const score = pathScore(s, { now: NOW });
  if (!near(score, 0.5)) throw new Error(`30 天前应衰减一半，实际 ${score}`);
  ok("pathScore：30 天没跑，新鲜度衰减一半");
} catch (e) {
  fail("pathScore 新鲜度", e);
}

/* 6. 无样本 */
try {
  const s = makeSkill("fresh", { runs: 0, success: 0 });
  if (pathScore(s, { now: NOW }) !== 0) throw new Error("无样本应为 0");
  ok("pathScore：无样本技能分数为 0");
} catch (e) {
  fail("pathScore 无样本", e);
}

/* 7. goalOf 跳过查询步骤 */
try {
  const s = makeSkill("with_scan", {
    steps: [
      { cmd: "scan", args: { block: "oak_log" } },
      { cmd: "collect", args: { block: "oak_log" } },
    ],
  });
  if (goalOf(s) !== "collect:oak_log") throw new Error(`目标错了：${goalOf(s)}`);
  ok("goalOf：跳过 scan 等查询步骤，取真正的动作");
} catch (e) {
  fail("goalOf", e);
}

/* 8. groupByGoal 分组且跳过归档 */
try {
  const skills = [
    makeSkill("oak_a"),
    makeSkill("oak_b"),
    makeSkill("stone_a", { steps: [{ cmd: "collect", args: { block: "stone" } }] }),
    makeSkill("oak_old", { archived: true }),
  ];
  const groups = groupByGoal(skills);
  const oak = groups.find((g) => g.goal === "collect:oak_log");
  const stone = groups.find((g) => g.goal === "collect:stone");
  if (!oak || oak.skills.length !== 2) throw new Error(`橡木组应为 2 条，实际 ${oak ? oak.skills.length : "无"}`);
  if (!stone || stone.skills.length !== 1) throw new Error("石头组应为 1 条");
  if (groups.some((g) => g.skills.some((s) => s.archived))) throw new Error("归档技能不应进组");
  ok("groupByGoal：按目标分组，归档技能不参与");
} catch (e) {
  fail("groupByGoal", e);
}

/* 9. rank：primary / backup / archived */
try {
  const a = makeSkill("a");
  const b = makeSkill("b", { success: 9 });
  const c = makeSkill("c", { success: 8 });
  const d = makeSkill("d", { success: 1 });

  const result = rank([{ goal: "collect:oak_log", skills: [a, b, c, d] }], { now: NOW });
  const entries = result.groups[0].entries;
  const status = Object.fromEntries(entries.map((e) => [e.name, e.status]));

  if (status.a !== "primary") throw new Error(`a 应为 primary，实际 ${status.a}`);
  if (status.b !== "backup" || status.c !== "backup") throw new Error("b/c 应为 backup");
  if (status.d !== "archived") throw new Error(`d 应为 archived，实际 ${status.d}`);
  if (result.groups[0].primary !== "a") throw new Error("primary 字段不对");
  ok("rank：头部 primary、2–3 名 backup、其余归档");
} catch (e) {
  fail("rank 状态", e);
}

/* 10. rank：整组无样本 → candidate，不归档 */
try {
  const a = makeSkill("new_a", { runs: 0, success: 0 });
  const b = makeSkill("new_b", { runs: 0, success: 0 });
  const result = rank([{ goal: "collect:oak_log", skills: [a, b] }], { now: NOW });
  const entries = result.groups[0].entries;
  if (!entries.every((e) => e.status === "candidate")) throw new Error("应全部是 candidate");
  if (result.archive.length !== 0) throw new Error("无样本组不应归档");
  ok("rank：整组都没样本时标 candidate，先观望不归档");
} catch (e) {
  fail("rank 无样本组", e);
}

/* 11. rank：连续弱 3 次归档 */
try {
  const a = makeSkill("strong");
  const weak = makeSkill("weak", { success: 1, weakStreak: WEAK_STREAK_LIMIT - 1 });

  const result = rank([{ goal: "collect:oak_log", skills: [a, weak] }], { now: NOW });
  const entry = result.groups[0].entries.find((e) => e.name === "weak");
  if (entry.weakStreak !== WEAK_STREAK_LIMIT) throw new Error(`弱计数应为 3，实际 ${entry.weakStreak}`);
  if (entry.status !== "archived") throw new Error(`连续 3 次弱应归档，实际 ${entry.status}`);
  ok("rank：连续 3 次低于主流程 60% → 归档");
} catch (e) {
  fail("rank 弱淘汰", e);
}

/* 12. similarity：相同步骤 */
try {
  const a = makeSkill("a");
  const b = makeSkill("b");
  if (!near(similarity(a, b), 1)) throw new Error(`相同步骤应为 1，实际 ${similarity(a, b)}`);
  ok("similarity：完全相同的步骤 → 1");
} catch (e) {
  fail("similarity 相同", e);
}

/* 13. similarity：部分重合 */
try {
  const a = makeSkill("a", {
    steps: [
      { cmd: "collect", args: { block: "oak_log" } },
      { cmd: "dig", args: { block: "stone" } },
    ],
  });
  const b = makeSkill("b", { steps: [{ cmd: "collect", args: { block: "oak_log" } }] });
  if (!near(similarity(a, b), 0.5)) throw new Error(`应为 0.5，实际 ${similarity(a, b)}`);
  ok("similarity：LCS / max(len) = 1 / 2 = 0.5");
} catch (e) {
  fail("similarity 部分", e);
}

/* 14. similarity：数量不同不算不同流派 */
try {
  const a = makeSkill("a", { steps: [{ cmd: "collect", args: { block: "oak_log", count: 3 } }] });
  const b = makeSkill("b", { steps: [{ cmd: "collect", args: { block: "oak_log", count: 8 } }] });
  if (!near(similarity(a, b), 1)) throw new Error("数量不同不应影响相似度");
  ok("similarity：同一目标不同数量仍视为同一流派");
} catch (e) {
  fail("similarity 数量", e);
}

/* 15. lcsLength 边界 */
try {
  if (lcsLength([], []) !== 0) throw new Error("空序列应为 0");
  if (lcsLength(["a", "b", "c"], ["a", "c"]) !== 2) throw new Error("LCS 应为 2");
  ok("lcsLength：空序列与常见子序列都正确");
} catch (e) {
  fail("lcsLength", e);
}

/* 16. planMerges：保留高分、统计相加 */
try {
  const a = makeSkill("a");
  const b = makeSkill("b", { success: 5 });
  const merges = planMerges([{ goal: "collect:oak_log", skills: [a, b] }], { now: NOW });

  if (merges.length !== 1) throw new Error(`应合并 1 条，实际 ${merges.length}`);
  if (merges[0].keep !== "a" || merges[0].drop !== "b") throw new Error("保留/丢弃对象错了");
  if (merges[0].stats.runs !== 20) throw new Error(`runs 应累加到 20，实际 ${merges[0].stats.runs}`);
  if (merges[0].stats.success !== 15) throw new Error(`success 应累加到 15，实际 ${merges[0].stats.success}`);
  if (!merges[0].archivedReason.includes("并入 a")) throw new Error("归档备注缺少并入目标");
  ok("planMerges：保留高分、统计相加、备注记「并入 X」");
} catch (e) {
  fail("planMerges", e);
}

/* 17. planMerges：不同目标不合并 */
try {
  const a = makeSkill("a");
  const b = makeSkill("b", { steps: [{ cmd: "collect", args: { block: "stone" } }] });
  const merges = planMerges([{ goal: "collect:oak_log", skills: [a] }, { goal: "collect:stone", skills: [b] }], { now: NOW });
  if (merges.length !== 0) throw new Error("不同目标不应合并");
  ok("planMerges：不同目标不合并");
} catch (e) {
  fail("planMerges 隔离", e);
}

/* 18. pruneSkills：不超限一条都不删 */
try {
  const skills = [makeSkill("a"), makeSkill("b")];
  const result = pruneSkills(skills, { limit: 10, now: NOW });
  if (result.archive.length !== 0) throw new Error(`不应归档，实际 ${result.archive.join(",")}`);
  ok("pruneSkills：未超上限时一条都不删");
} catch (e) {
  fail("pruneSkills 保护", e);
}

/* 19. pruneSkills：超限归档尾部 */
try {
  const a = makeSkill("a");
  const b = makeSkill("b", { success: 9 });
  const c = makeSkill("c", { success: 1 });
  const result = pruneSkills([a, b, c], { limit: 2, now: NOW });
  if (result.archive.length !== 1 || result.archive[0] !== "c") {
    throw new Error(`应归档最低分的 c，实际 ${result.archive.join(",")}`);
  }
  ok("pruneSkills：超上限时归档分数最低的尾部");
} catch (e) {
  fail("pruneSkills 超限", e);
}

/* 20. pruneGraph：删 stale 边与孤立节点 */
try {
  const nodes = new Map([
    ["a", { id: "a", runs: 5, success: 5, lastAt: NOW }],
    ["b", { id: "b", runs: 1, success: 1, lastAt: NOW }],
    ["c", { id: "c", runs: 3, success: 3, lastAt: NOW }],
  ]);
  const edges = new Map([
    ["a\u0000c", { from: "a", to: "c", weight: 0.5, lastAt: NOW, count: 5, success: 5 }],
    ["b\u0000c", { from: "b", to: "c", weight: 0, lastAt: NOW - 8 * DAY, count: 1, success: 0 }],
  ]);

  const result = pruneGraph({ nodes, edges }, { now: NOW });
  if (!result.dropEdges.includes("b\u0000c")) throw new Error("stale 边没删");
  if (!result.dropNodes.includes("b")) throw new Error("孤立且 runs<2 的节点没删");
  if (result.graph.edges.has("b\u0000c")) throw new Error("返回图里 stale 边还在");
  if (result.graph.nodes.has("b")) throw new Error("返回图里孤立节点还在");
  ok("pruneGraph：权重 0 且超过 7 天的边、孤立低样本节点被清理");
} catch (e) {
  fail("pruneGraph stale", e);
}

/* 21. pruneGraph：保护有样本的孤立节点 */
try {
  const nodes = new Map([["lonely", { id: "lonely", runs: 5, success: 5, lastAt: NOW }]]);
  const result = pruneGraph({ nodes, edges: new Map() }, { now: NOW });
  if (result.dropNodes.includes("lonely")) throw new Error("runs>=2 的孤立节点不应删");
  ok("pruneGraph：孤立但跑过 2 次以上的节点保留");
} catch (e) {
  fail("pruneGraph 保护", e);
}

/* 22. pruneGraph：节点上限按 runs × 成功率淘汰 */
try {
  const nodes = new Map([
    ["a", { id: "a", runs: 1, success: 1, lastAt: NOW }],
    ["b", { id: "b", runs: 2, success: 2, lastAt: NOW }],
    ["c", { id: "c", runs: 3, success: 3, lastAt: NOW }],
  ]);
  const edges = new Map([
    ["a\u0000b", { from: "a", to: "b", weight: 0.5, lastAt: NOW, count: 2, success: 2 }],
    ["b\u0000c", { from: "b", to: "c", weight: 0.5, lastAt: NOW, count: 2, success: 2 }],
  ]);

  const result = pruneGraph({ nodes, edges }, { now: NOW, maxNodes: 2 });
  if (!result.dropNodes.includes("a")) throw new Error(`应淘汰最低分的 a，实际 ${result.dropNodes.join(",")}`);
  if (result.dropNodes.includes("c")) throw new Error("不应淘汰最高分的 c");
  ok("pruneGraph：节点超上限时淘汰 runs × 成功率最低的尾部");
} catch (e) {
  fail("pruneGraph 上限", e);
}

/* 23. consolidate：串联与摘要 */
try {
  const a = makeSkill("a");
  const b = makeSkill("b", { success: 5 });
  const c = makeSkill("c", { steps: [{ cmd: "collect", args: { block: "stone" } }] });

  const plan = consolidate({ skills: [a, b, c], now: NOW, dryRun: true });
  if (plan.merges.length !== 1) throw new Error(`应合并 1 条，实际 ${plan.merges.length}`);
  if (!plan.archiveSkills.includes("b")) throw new Error("被合并的 b 应进入归档清单");
  if (plan.dryRun !== true) throw new Error("dryRun 标记丢了");
  if (!plan.summary.includes("dry-run")) throw new Error("摘要应标明 dry-run");
  ok(`consolidate：串联完成，摘要「${plan.summary}」`);
} catch (e) {
  fail("consolidate", e);
}

/* 24. restorePatch */
try {
  const patch = restorePatch();
  if (patch.archived !== false) throw new Error("restore 后 archived 应为 false");
  if (patch.archivedReason !== null) throw new Error("restore 后原因应清空");
  if (patch.competition.weakStreak !== 0) throw new Error("restore 后弱计数应清零");
  ok("restorePatch：归档技能可恢复，竞争状态清零");
} catch (e) {
  fail("restorePatch", e);
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
