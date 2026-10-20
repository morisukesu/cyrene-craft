"use strict";

/**
 * 反射层（肌肉记忆）单元测试
 *
 * 覆盖：
 *   1. 文本归一化（全角 / 大小写 / 标点）
 *   2. 词命中与长度加权
 *   3. 否定词拦截与多次出现
 *   4. 泛词误命中防护
 *   5. 正则命中与正则否定
 *   6. 上下文门禁（连接 / 饥饿 / 生命）
 *   7. 候选排序与归档跳过
 *   8. 信心公式与样本系数
 *   9. pick 门槛
 *  10. 自动执行安全白名单
 *
 * 全部离线，不连服务器、不碰文件。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { match, confidence, pick, isAutoAllowed, normalizeText } = require("../src/reflex.cjs");
const { compileEpisode } = require("../src/skill-compiler.cjs");
const { SkillStore } = require("../src/skill-store.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

/**
 * 造一条技能。
 * 默认是「已练熟」的状态：10 次全成功。
 */
function makeSkill(name, words, extra = {}) {
  return {
    name,
    description: extra.description || "",
    steps: extra.steps || [{ cmd: "collect", args: { block: "oak_log" } }],
    triggers: {
      words,
      regex: extra.regex || [],
      context: extra.context || {},
    },
    stats: {
      runs: extra.runs === undefined ? 10 : extra.runs,
      success: extra.success === undefined ? 10 : extra.success,
      fail: 0,
      durations: [],
      lastRunAt: null,
    },
    safety: { idempotent: false, whitelist: extra.whitelist === undefined ? true : extra.whitelist, maxDurationMs: 30000 },
    archived: Boolean(extra.archived),
  };
}

const chopOak = makeSkill("chop_oak", ["砍", "木头", "橡木", "原木", "树", "oak_log"]);
const digStone = makeSkill("dig_stone", ["挖", "石头", "stone"], {
  steps: [{ cmd: "dig", args: { block: "stone" } }],
});

/* 1. 归一化 */
try {
  const text = normalizeText("ＯＡＫ＿ＬＯＧ，砍树！");
  if (text !== "oak_log 砍树") throw new Error(`归一化结果不对：${text}`);
  ok("归一化：全角转半角、统一小写、标点变空格");
} catch (e) {
  fail("归一化", e);
}

/* 2. 基本词命中 */
try {
  const hits = match("砍点木头", [chopOak]);
  if (hits.length !== 1) throw new Error(`应命中 1 条，实际 ${hits.length}`);
  if (hits[0].skill.name !== "chop_oak") throw new Error("命中了错误的技能");
  if (hits[0].score < 0.8) throw new Error(`组合命中分数偏低：${hits[0].score}`);
  ok("动词 + 目标同时命中，分数达到自动执行门槛");
} catch (e) {
  fail("基本词命中", e);
}

/* 3. 否定词拦截 */
try {
  const hits = match("不要砍树", [chopOak]);
  if (hits.length !== 0) throw new Error(`否定句不应命中，实际 ${hits.length}`);
  ok("否定词拦截：不要砍树 → 不命中");
} catch (e) {
  fail("否定词拦截", e);
}

/* 4. 另一种否定词 */
try {
  const hits = match("别挖石头", [digStone]);
  if (hits.length !== 0) throw new Error(`否定句不应命中，实际 ${hits.length}`);
  ok("否定词拦截：别挖石头 → 不命中");
} catch (e) {
  fail("否定词拦截（别）", e);
}

/* 5. 否定词只向前看 4 字 */
try {
  const hits = match("先别着急，去砍树", [chopOak]);
  if (hits.length !== 1) throw new Error(`否定词在窗口外时不应拦截，实际 ${hits.length}`);
  ok("否定词窗口外不误伤：先别着急，去砍树 → 命中");
} catch (e) {
  fail("否定词窗口边界", e);
}

/* 6. 同一个词多次出现，一次被否定一次有效 */
try {
  const hits = match("不要砍树，砍石头", [chopOak]);
  if (hits.length !== 1) throw new Error(`第二次出现应有效，实际 ${hits.length}`);
  ok("同词多次出现：前一次被否定，后一次仍有效");
} catch (e) {
  fail("同词多次出现", e);
}

/* 7. 泛词单独命中不过门槛 */
try {
  const hits = match("树", [chopOak]);
  if (hits.length !== 1) throw new Error("单字/泛词应能匹配到候选");
  if (hits[0].score >= 0.72) throw new Error(`泛词分数过高：${hits[0].score}`);
  ok(`泛词压分：单独说「树」分数 ${hits[0].score} < 0.72`);
} catch (e) {
  fail("泛词压分", e);
}

/* 8. 长词单独命中可过门槛 */
try {
  const table = makeSkill("craft_table", ["工作台"], { steps: [{ cmd: "craft", args: { item: "crafting_table" } }] });
  const hits = match("做个工作台", [table]);
  if (!hits.length) throw new Error("长词应命中");
  if (hits[0].score < 0.72) throw new Error(`长词分数偏低：${hits[0].score}`);
  ok(`长词高分：单独说「工作台」分数 ${hits[0].score} ≥ 0.72`);
} catch (e) {
  fail("长词高分", e);
}

/* 9. 正则命中 */
try {
  const reSkill = makeSkill("chop_regex", [], {
    regex: ["(砍|挖|采).{0,4}(木头|树|原木)"],
  });
  const hits = match("砍点木头", [reSkill]);
  if (!hits.length) throw new Error("正则应命中");
  if (hits[0].score !== 0.8) throw new Error(`正则基础分应为 0.8，实际 ${hits[0].score}`);
  ok("正则命中：基础分 0.8");
} catch (e) {
  fail("正则命中", e);
}

/* 10. 正则也要被否定词拦住 */
try {
  const reSkill = makeSkill("chop_regex", [], {
    regex: ["(砍|挖|采).{0,4}(木头|树|原木)"],
  });
  const hits = match("不要砍树", [reSkill]);
  if (hits.length !== 0) throw new Error(`否定句的正则不应命中，实际 ${hits.length}`);
  ok("正则命中同样受否定词拦截");
} catch (e) {
  fail("正则否定拦截", e);
}

/* 11. 上下文门禁：连接状态 */
try {
  const gated = makeSkill("chop_gated", ["砍", "木头"], {
    context: { requireConnected: true },
  });
  if (match("砍点木头", [gated]).length !== 0) throw new Error("未连接时不应命中");
  if (match("砍点木头", [gated], { connected: true }).length !== 1) throw new Error("已连接时应命中");
  ok("上下文门禁：requireConnected 生效");
} catch (e) {
  fail("上下文门禁 requireConnected", e);
}

/* 12. 上下文门禁：饥饿值 */
try {
  const gated = makeSkill("chop_food", ["砍", "木头"], { context: { minFood: 10 } });
  if (match("砍点木头", [gated], { food: 5 }).length !== 0) throw new Error("饥饿值不足不应命中");
  if (match("砍点木", [gated], { food: 15 }).length !== 1) throw new Error("饥饿值足够应命中");
  ok("上下文门禁：minFood 生效");
} catch (e) {
  fail("上下文门禁 minFood", e);
}

/* 13. 上下文门禁：生命值 */
try {
  const gated = makeSkill("chop_health", ["砍", "木头"], { context: { minHealth: 8 } });
  if (match("砍点木头", [gated], { health: 4 }).length !== 0) throw new Error("血量不足不应命中");
  if (match("砍点木头", [gated], { health: 18 }).length !== 1) throw new Error("血量足够应命中");
  ok("上下文门禁：minHealth 生效");
} catch (e) {
  fail("上下文门禁 minHealth", e);
}

/* 14. 多候选按分数降序 */
try {
  const weak = makeSkill("chop_weak", ["砍"]);
  const strong = makeSkill("chop_strong", ["砍", "木头"]);
  const hits = match("砍点木头", [weak, strong]);
  if (hits.length !== 2) throw new Error(`应有 2 条候选，实际 ${hits.length}`);
  if (hits[0].skill.name !== "chop_strong") throw new Error("排序错了，高分应在前");
  if (hits[0].score < hits[1].score) throw new Error("分数没有降序");
  ok("多候选按分数降序返回");
} catch (e) {
  fail("候选排序", e);
}

/* 15. 归档技能不参与匹配 */
try {
  const archived = makeSkill("chop_old", ["砍", "木头"], { archived: true });
  if (match("砍点木头", [archived]).length !== 0) throw new Error("归档技能不应命中");
  ok("归档技能不参与反射匹配");
} catch (e) {
  fail("归档技能跳过", e);
}

/* 16. 没有触发签名的技能不参与 */
try {
  const noTriggers = { name: "no_triggers", steps: [{ cmd: "collect", args: {} }] };
  if (match("砍点木头", [noTriggers]).length !== 0) throw new Error("无 triggers 不应命中");
  ok("无触发签名的技能安全跳过");
} catch (e) {
  fail("无 triggers 跳过", e);
}

/* 17. 空文本不命中 */
try {
  if (match("", [chopOak]).length !== 0) throw new Error("空文本不应命中");
  if (match("   ！？  ", [chopOak]).length !== 0) throw new Error("纯标点不应命中");
  ok("空文本与纯标点不产生候选");
} catch (e) {
  fail("空文本", e);
}

/* 18. 信心公式：满分因子 */
try {
  const conf = confidence({ skill: chopOak, score: 0.85 });
  if (conf !== 0.85) throw new Error(`应为 0.85，实际 ${conf}`);
  ok("信心公式：score × 成功率 × 样本系数 = 0.85");
} catch (e) {
  fail("信心公式", e);
}

/* 19. 无样本按 0 */
try {
  const fresh = makeSkill("chop_new", ["砍", "木头"], { runs: 0, success: 0 });
  const conf = confidence({ skill: fresh, score: 0.9 });
  if (conf !== 0) throw new Error(`无样本应为 0，实际 ${conf}`);
  ok("无样本技能信心为 0（先让模型跑几次再自动执行）");
} catch (e) {
  fail("无样本信心", e);
}

/* 20. 样本系数：5 次减半 */
try {
  const half = makeSkill("chop_half", ["砍", "木头"], { runs: 5, success: 5 });
  const conf = confidence({ skill: half, score: 0.9 });
  if (conf !== 0.45) throw new Error(`应为 0.45，实际 ${conf}`);
  ok("样本系数：5 次样本只算一半（min(1, runs/10)）");
} catch (e) {
  fail("样本系数", e);
}

/* 21. 成功率因子 */
try {
  const flaky = makeSkill("chop_flaky", ["砍", "木头"], { runs: 10, success: 5 });
  const conf = confidence({ skill: flaky, score: 0.9 });
  if (conf !== 0.45) throw new Error(`应为 0.45，实际 ${conf}`);
  ok("成功率因子：10 跑 5 成 → 信心减半");
} catch (e) {
  fail("成功率因子", e);
}

/* 22. pick 取最高且过门槛 */
try {
  const low = { skill: makeSkill("low", ["树"]), score: 0.6 };
  const high = { skill: chopOak, score: 0.85 };
  const best = pick([low, high]);
  if (!best) throw new Error("应选出候选");
  if (best.skill.name !== "chop_oak") throw new Error("选错了技能");
  if (best.confidence !== 0.85) throw new Error(`confidence 字段不对：${best.confidence}`);
  ok("pick：取信心最高且过 0.72 门槛的一条");
} catch (e) {
  fail("pick 选取", e);
}

/* 23. pick 全部低于门槛 */
try {
  const low = { skill: makeSkill("low", ["树"]), score: 0.6 };
  const best = pick([low]);
  if (best !== null) throw new Error("低于门槛应返回 null");
  ok("pick：全部低于门槛时返回 null，不硬选");
} catch (e) {
  fail("pick 门槛", e);
}

/* 24. pick 可调门槛 */
try {
  const low = { skill: makeSkill("low", ["树"]), score: 0.65 };
  const best = pick([low], { minConfidence: 0.5 });
  if (!best || best.skill.name !== "low") throw new Error("放宽门槛后应选中");
  ok("pick：minConfidence 可调");
} catch (e) {
  fail("pick 可调门槛", e);
}

/* 25. 白名单：正常技能放行 */
try {
  if (!isAutoAllowed(chopOak)) throw new Error("正常技能应允许自动执行");
  ok("安全门禁：普通技能放行");
} catch (e) {
  fail("白名单放行", e);
}

/* 26. 白名单：safety.whitelist=false */
try {
  const unsafe = makeSkill("unsafe", ["砍", "木头"], { whitelist: false });
  if (isAutoAllowed(unsafe)) throw new Error("whitelist=false 不应放行");
  ok("安全门禁：safety.whitelist=false 拒绝");
} catch (e) {
  fail("白名单拒绝", e);
}

/* 27. 白名单：say / command */
try {
  const saySkill = makeSkill("say_skill", ["说话"], { steps: [{ cmd: "say", args: { message: "hi" } }] });
  const cmdSkill = makeSkill("cmd_skill", ["指令"], { steps: [{ cmd: "command", args: { command: "/list" } }] });
  if (isAutoAllowed(saySkill)) throw new Error("say 不应放行");
  if (isAutoAllowed(cmdSkill)) throw new Error("command 不应放行");
  ok("安全门禁：say / command 一律拒绝");
} catch (e) {
  fail("危险命令拒绝", e);
}

/* 28. 白名单：连接类命令 */
try {
  for (const cmd of ["connect", "disconnect", "stop"]) {
    const s = makeSkill(`deny_${cmd}`, ["测试"], { steps: [{ cmd, args: {} }] });
    if (isAutoAllowed(s)) throw new Error(`${cmd} 不应放行`);
  }
  ok("安全门禁：connect / disconnect / stop 一律拒绝");
} catch (e) {
  fail("连接类命令拒绝", e);
}

/* 29. 白名单：步骤上限 */
try {
  const long = makeSkill("long_skill", ["长流程"], {
    steps: Array.from({ length: 31 }, () => ({ cmd: "collect", args: { block: "oak_log" } })),
  });
  if (isAutoAllowed(long)) throw new Error("31 步不应放行");
  ok("安全门禁：步骤超过 30 条拒绝");
} catch (e) {
  fail("步骤上限", e);
}

/* 30. 白名单：归档 / 空步骤 */
try {
  const archived = makeSkill("archived_skill", ["砍", "木头"], { archived: true });
  const empty = makeSkill("empty_skill", ["砍"], { steps: [] });
  if (isAutoAllowed(archived)) throw new Error("归档技能不应放行");
  if (isAutoAllowed(empty)) throw new Error("空步骤不应放行");
  ok("安全门禁：归档技能与空步骤拒绝");
} catch (e) {
  fail("归档与空步骤", e);
}

/* 31. 编译器从命令本身映射动词同义词 */
try {
  const compiled = compileEpisode([{ tool: "collect", args: { block: "oak_log", count: 3 }, ok: true }]);
  const words = (compiled && compiled.triggers && compiled.triggers.words) || [];

  if (!words.includes("砍")) throw new Error(`触发词缺少「砍」：${JSON.stringify(words)}`);

  const hits = match("砍点木头", [compiled]);
  if (!hits.length) throw new Error("「砍点木头」没有命中");
  if (hits[0].score < 0.8) throw new Error(`匹配分应 ≥ 0.8，实际 ${hits[0].score}`);

  ok("编译器从 collect 映射出「砍」，砍点木头匹配 ≥ 0.8");
} catch (e) {
  fail("命令动词映射", e);
}

/* 32. 旧触发签名读取时按新版本重算 */
try {
  const root = path.join(os.tmpdir(), `cyrene-trigger-migrate-${process.pid}`);
  const store = new SkillStore({ rootDir: root, log: () => {} });

  fs.writeFileSync(
    path.join(root, "legacy_chop.json"),
    JSON.stringify({
      name: "legacy_chop",
      description: "采集 橡木",
      steps: [{ cmd: "collect", args: { block: "oak_log" } }],
      triggers: { words: ["木头"], regex: [], context: {} },
      stats: { runs: 10, success: 10, fail: 0, durations: [], lastRunAt: null },
    }),
  );

  const skill = store.get("legacy_chop");
  if (!skill.triggers.words.includes("砍")) {
    throw new Error(`旧技能没有补出「砍」：${JSON.stringify(skill.triggers)}`);
  }
  if (skill.triggers.version !== 2) throw new Error(`版本没有升级：${skill.triggers.version}`);

  fs.rmSync(root, { recursive: true, force: true });
  ok("旧触发签名读取时按 v2 重算，补出「砍」");
} catch (e) {
  fail("触发签名版本迁移", e);
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
