"use strict";

/**
 * L2 延展层单元测试：归因分析 + 优化提案
 *
 * 这一层全是判断，最容易变成噪音。
 * 所以测试重点不只是「算出数」，还要守住几条纪律：
 *   - 样本不足不下结论
 *   - 报错能归因，归不进去就说未归类
 *   - 提案必须带可执行的 change
 *   - 提案允许为空（没问题是正常状态，不能硬造问题）
 *
 * 用法：node tools/insight-test.cjs
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SkillStore } = require("../src/skill-store.cjs");
const {
  analyzeSkill,
  analyzeStore,
  proposeForSkill,
  classifyFailure,
  formatReport,
  MIN_RUNS_FOR_RATE,
  MAX_SEARCH_RADIUS,
  MIN_SAMPLES_FOR_TAIL,
} = require("../src/skill-insight.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

const tmpRoot = path.join(os.tmpdir(), `cyrene-insight-test-${process.pid}`);
fs.rmSync(tmpRoot, { recursive: true, force: true });
fs.mkdirSync(tmpRoot, { recursive: true });

const store = new SkillStore({ rootDir: path.join(tmpRoot, "skills"), log: () => {} });

/** 造一个技能对象（不走磁盘） */
function mkSkill(over) {
  return {
    name: "chop_oak",
    description: "采集 oak_log",
    level: 1,
    steps: [{ cmd: "collect", args: { block: "oak_log", count: 1, radius: 48 } }],
    params: {},
    stats: { runs: 0, success: 0, fail: 0, durations: [], lastRunAt: null, failures: [] },
    ...over,
  };
}

const detail = (error, step = 0) => ({ error, step, cmd: "collect", at: new Date().toISOString() });

(async () => {
  /* 1. 没跑过的技能：不给健康度，也不给负面提案 */
  try {
    const a = analyzeSkill(mkSkill());
    if (a.successRate !== null) throw new Error("没跑过时 successRate 应为 null");
    if (a.health !== "unknown") throw new Error(`没跑过时健康度应为 unknown，实际 ${a.health}`);
    const props = proposeForSkill(a, mkSkill());
    const bad = props.find((p) => p.kind !== "investigate" && p.kind !== "tighten_radius");
    if (bad) throw new Error(`样本不足时不该给 ${bad.kind} 这种结论性提案`);
    ok("没跑过的技能：健康度 unknown，不硬下结论");
  } catch (e) {
    fail("没跑过的技能不硬下结论", e);
  }

  /* 2. 样本不足明确说样本不足 */
  try {
    const a = analyzeSkill(
      mkSkill({ stats: { runs: 2, success: 2, fail: 0, durations: [3000, 3200], failures: [] } }),
    );
    if (a.health !== "unknown") throw new Error(`跑 2 次不该给健康度，实际 ${a.health}`);
    const props = proposeForSkill(a, mkSkill());
    if (!props.some((p) => p.kind === "investigate")) throw new Error("缺少 investigate 提案");
    if (!/样本不足/.test(props[0].title)) throw new Error("标题里应说明样本不足");
    ok(`样本不足时明确说明（阈值 ${MIN_RUNS_FOR_RATE} 次）`);
  } catch (e) {
    fail("样本不足时明确说明", e);
  }

  /* 3. 成功率与健康度分级 */
  try {
    const healthy = analyzeSkill(
      mkSkill({ stats: { runs: 10, success: 9, fail: 1, durations: [], failures: [detail("x")] } }),
    );
    if (healthy.successRate !== 0.9) throw new Error(`成功率应为 0.9，实际 ${healthy.successRate}`);
    if (healthy.health !== "healthy") throw new Error(`应为 healthy，实际 ${healthy.health}`);

    const unstable = analyzeSkill(
      mkSkill({ stats: { runs: 10, success: 5, fail: 5, durations: [], failures: [] } }),
    );
    if (unstable.health !== "unstable") throw new Error(`应为 unstable，实际 ${unstable.health}`);

    const broken = analyzeSkill(
      mkSkill({ stats: { runs: 5, success: 0, fail: 5, durations: [], failures: [] } }),
    );
    if (broken.health !== "broken") throw new Error(`应为 broken，实际 ${broken.health}`);
    ok("健康度分级：healthy / unstable / broken 判定正确");
  } catch (e) {
    fail("健康度分级", e);
  }

  /* 4. 失败归因：中文报错能归类 */
  try {
    const cases = [
      ["(-999999, -999999, -999999) 没有方块（区块可能未加载）", "env_missing"],
      ["寻路超时，卡在坐标附近", "path_blocked"],
      ["背包里没有 oak_log", "inventory"],
      ["服务器拒绝了这个操作：permission denied", "permission"],
      ["连接已断开", "disconnected"],
      ["block 参数不能为空", "param_invalid"],
      ["某个从没见过的奇怪错误", "unknown"],
    ];
    for (const [text, want] of cases) {
      const got = classifyFailure(text).kind;
      if (got !== want) throw new Error(`「${text}」应归为 ${want}，实际 ${got}`);
    }
    const empty = classifyFailure("");
    if (empty.kind !== "unknown") throw new Error("空错误文本应归为 unknown");
    ok("失败归因：5 类常见报错 + 未归类都判断正确");
  } catch (e) {
    fail("失败归因准确性", e);
  }

  /* 5. 制造失败样本 → 归因聚合 + 环境类提案 */
  try {
    const failures = [
      detail("没有方块（区块可能未加载）", 0),
      detail("没有方块（区块可能未加载）", 0),
      detail("寻路超时", 0),
    ];
    const skill = mkSkill({
      stats: { runs: 6, success: 3, fail: 3, durations: [3000, 3100, 3200, 3300], failures },
    });
    const a = analyzeSkill(skill);
    if (a.causes.length !== 2) throw new Error(`应有 2 类原因，实际 ${a.causes.length}`);
    if (a.causes[0].kind !== "env_missing") throw new Error(`最多的应是 env_missing，实际 ${a.causes[0].kind}`);
    if (a.causes[0].count !== 2) throw new Error(`env_missing 应出现 2 次，实际 ${a.causes[0].count}`);

    const props = proposeForSkill(a, skill);
    if (!props.some((p) => p.kind === "add_precondition")) throw new Error("环境类失败应给 add_precondition");
    if (!props.some((p) => p.kind === "tighten_radius")) throw new Error("半径 48 应给 tighten_radius");
    ok("失败归因聚合：按类别计数、取最多的一类，并给出对应提案");
  } catch (e) {
    fail("失败归因聚合", e);
  }

  /* 6. 半径提案的改动值必须可执行 */
  try {
    const skill = mkSkill({
      stats: { runs: 5, success: 5, fail: 0, durations: [40000, 41000, 39000, 42000], failures: [] },
    });
    const a = analyzeSkill(skill);
    const props = proposeForSkill(a, skill);
    const radiusProp = props.find((p) => p.kind === "tighten_radius");
    if (!radiusProp) throw new Error("半径 48 应产生提案");
    if (radiusProp.change.to !== MAX_SEARCH_RADIUS) throw new Error("改动目标应是上限 16");
    if (radiusProp.change.from !== 48) throw new Error(`from 应是 48，实际 ${radiusProp.change.from}`);
    ok(`半径提案带可执行改动（48 → ${MAX_SEARCH_RADIUS}）`);
  } catch (e) {
    fail("半径提案可执行", e);
  }

  /* 7. 耗时趋势：变慢要能看出来 */
  try {
    const durations = [3000, 3100, 3000, 3100, 9000, 9200, 9100, 9000];
    const a = analyzeSkill(mkSkill({ stats: { runs: 8, success: 8, fail: 0, durations, failures: [] } }));
    if (!a.trend) throw new Error("8 个样本应能算出趋势");
    if (a.trend.direction !== "slower") throw new Error(`应判为 slower，实际 ${a.trend.direction}`);
    if (a.trend.ratio < 1.5) throw new Error(`比值应明显大于 1.5，实际 ${a.trend.ratio}`);

    const stable = analyzeSkill(
      mkSkill({ stats: { runs: 8, success: 8, fail: 0, durations: [3000, 3100, 3000, 3100, 3050, 3000, 3100, 3000], failures: [] } }),
    );
    if (stable.trend.direction !== "stable") throw new Error(`应判为 stable，实际 ${stable.trend.direction}`);
    ok("耗时趋势：用前后半段中位数比，变慢/稳定都判断正确");
  } catch (e) {
    fail("耗时趋势判定", e);
  }

  /* 8. 全部失败 → 建议停用 */
  try {
    const skill = mkSkill({
      stats: {
        runs: 4, success: 0, fail: 4, durations: [1000, 1000, 1000, 1000],
        failures: [detail("没有方块"), detail("没有方块"), detail("没有方块"), detail("没有方块")],
      },
    });
    const a = analyzeSkill(skill);
    const props = proposeForSkill(a, skill);
    if (!props.some((p) => p.kind === "demote")) throw new Error("全失败应给 demote 提案");
    ok("连续全失败：给出停用/回退手写流程的提案");
  } catch (e) {
    fail("连续全失败给停用提案", e);
  }

  /* 9. 稳定高成功率 → 建议 L3 */
  try {
    const durations = new Array(20).fill(4000);
    const skill = mkSkill({ stats: { runs: 20, success: 20, fail: 0, durations, failures: [] } });
    const a = analyzeSkill(skill);
    if (!a.l3Ready) throw new Error("20 次全成功应满足 L3 条件");
    const props = proposeForSkill(a, skill);
    if (!props.some((p) => p.kind === "promote_l3")) throw new Error("应给 promote_l3 提案");
    ok("20 次全成功：判定可沉淀到 L3");
  } catch (e) {
    fail("L3 沉淀判定", e);
  }

  /* 10. 健康的技能不该被硬造问题 */
  try {
    const skill = mkSkill({
      steps: [{ cmd: "collect", args: { block: "oak_log", count: 8, radius: 16 } }],
      params: { count: { default: 8, min: 1, max: 64 } },
      stats: { runs: 10, success: 10, fail: 0, durations: new Array(10).fill(4000), failures: [] },
    });
    const a = analyzeSkill(skill);
    const props = proposeForSkill(a, skill);
    const bad = props.filter((p) => p.kind !== "promote_l3" && p.kind !== "investigate");
    if (bad.length) throw new Error(`健康技能不该有问题提案，实际给了 ${bad.map((p) => p.kind).join("/")}`);
    ok("健康技能不硬造问题（只允许 promote_l3 / investigate）");
  } catch (e) {
    fail("健康技能不硬造问题", e);
  }

  /* 11. 全库汇总：整体成功率按总量算，不用平均值 */
  try {
    store.save("big", {
      description: "跑很多次",
      steps: [{ cmd: "collect", args: { block: "oak_log", count: 4, radius: 8 } }],
      stats: { runs: 100, success: 90, fail: 10, durations: [4000], failures: [] },
    });
    store.save("tiny", {
      description: "只跑过三次全失败",
      steps: [{ cmd: "dig", args: { x: 1, y: 2, z: 3 } }],
      stats: { runs: 3, success: 0, fail: 3, durations: [500], failures: [detail("没有方块")] },
    });

    const r = analyzeStore(store);
    if (r.summary.skillCount !== 2) throw new Error(`应有 2 个技能，实际 ${r.summary.skillCount}`);
    if (r.summary.totalRuns !== 103) throw new Error(`总运行应是 103，实际 ${r.summary.totalRuns}`);
    const want = Math.round((90 / 103) * 1000) / 1000;
    if (r.summary.overallRate !== want) throw new Error(`整体成功率应按总量算 = ${want}，实际 ${r.summary.overallRate}`);
    if (!r.summary.unhealthy.includes("tiny")) throw new Error("broken 技能应进 unhealthy 名单");
    ok("全库汇总：整体成功率按总量算，小样本不会把均值拉偏");
  } catch (e) {
    fail("全库汇总口径", e);
  }

  /* 12. 提案排序：高危在前 */
  try {
    const r = analyzeStore(store);
    const firstHigh = r.proposals.findIndex((p) => p.severity === "high");
    const firstInfo = r.proposals.findIndex((p) => p.severity === "info");
    if (firstHigh === -1) throw new Error("应有 high 级提案");
    if (firstInfo !== -1 && firstInfo < firstHigh) throw new Error("info 不该排在 high 前面");
    ok("提案排序：high 在 info 之前");
  } catch (e) {
    fail("提案排序", e);
  }

  /* 13. 报告渲染：有内容、有长度上限、空库能说不空 */
  try {
    const r = analyzeStore(store);
    const text = formatReport(r, { maxProposals: 1 });
    if (!/技能 2 个/.test(text)) throw new Error(`报告头部不对：${text.slice(0, 80)}`);
    if (!/优化提案/.test(text)) throw new Error("报告里应有提案段落");
    // 限制 1 条时不能把全部提案都吐出来
    const listed = text.split("\n").filter((l) => l.startsWith("[")).length;
    if (listed > 1) throw new Error(`maxProposals=1 时列了 ${listed} 条`);

    const emptyStore = new SkillStore({ rootDir: path.join(tmpRoot, "empty-skills"), log: () => {} });
    const emptyText = formatReport(analyzeStore(emptyStore));
    if (!/空的/.test(emptyText)) throw new Error(`空库报告应说明没有数据，实际：${emptyText}`);
    ok("报告渲染：头部/提案/长度上限/空库提示都正确");
  } catch (e) {
    fail("报告渲染", e);
  }

  /* 14. 失败细节落盘再读回：字段完整、最多 10 条 */
  try {
    const s2 = new SkillStore({ rootDir: path.join(tmpRoot, "skills2"), log: () => {} });
    s2.save("probe", {
      description: "探针",
      steps: [{ cmd: "collect", args: { block: "oak_log", count: 1 } }],
    });

    for (let i = 0; i < 15; i += 1) {
      s2.recordRun("probe", false, 1200, { error: `第 ${i} 次失败：没有方块`, step: 0, cmd: "collect" });
    }

    const back = s2.get("probe");
    if (back.stats.fail !== 15) throw new Error(`失败次数应是 15，实际 ${back.stats.fail}`);
    if (back.stats.failures.length !== 10) throw new Error(`失败明细最多留 10 条，实际 ${back.stats.failures.length}`);
    const last = back.stats.failures[back.stats.failures.length - 1];
    if (!/第 14 次失败/.test(last.error)) throw new Error("应保留最新的失败记录");
    if (last.cmd !== "collect" || last.step !== 0) throw new Error("失败明细的 cmd/step 丢了");

    const a = analyzeSkill(back);
    if (a.causes[0].kind !== "env_missing") throw new Error("读回的失败应能归因");
    ok("失败明细落盘：字段完整、最多保留 10 条、能参与归因");
  } catch (e) {
    fail("失败明细落盘", e);
  }

  /* 15. 真实数据回放：中位数看不出长尾，长尾指标必须能抓住 */
  try {
    // 2026-10-20 真机跑 chop_oak 的 15 次原始耗时（毫秒）
    const REAL = [
      29529, 32598, 12339, 19026, 25210,
      35882, 14332, 13711, 24127, 16080,
      11880, 583467, 28170, 18923, 190456,
    ];
    const skill = mkSkill({
      stats: { runs: 15, success: 14, fail: 1, durations: REAL, failures: [] },
    });
    const a = analyzeSkill(skill);

    // 中位数抗异常值：它应该仍然报「稳定」
    if (a.trend.direction !== "stable") {
      throw new Error(`中位数趋势仍应判 stable（这正是它看不见长尾的证明），实际 ${a.trend.direction}`);
    }

    // 长尾必须被抓出来
    if (!a.tail) throw new Error("15 个样本应能算出长尾");
    if (!a.tail.flagged) throw new Error("583 秒 / 190 秒这种尖峰必须被判为长尾");

    // 两次超标的运行（583467 和 190456）都远超中位数 3 倍
    if (a.tail.slowRuns !== 2) throw new Error(`异常慢应有 2 次，实际 ${a.tail.slowRuns}`);
    if (a.tail.worstMs !== 583467) throw new Error(`最慢应是 583467，实际 ${a.tail.worstMs}`);

    // p90 会被尖峰抬高
    if (!(a.tail.p90Ms > a.medianMs)) throw new Error("长尾样本的 p90 应高于中位数");

    ok(`真实数据回放：中位数判 stable，长尾指标抓出 ${a.tail.slowRuns} 次尖峰（最慢 ${(a.tail.worstMs / 1000).toFixed(1)}s）`);
  } catch (e) {
    fail("真实数据回放：长尾必须被抓出", e);
  }

  /* 16. 长尾提案要带可执行建议 */
  try {
    const REAL = [
      29529, 32598, 12339, 19026, 25210,
      35882, 14332, 13711, 24127, 16080,
      11880, 583467, 28170, 18923, 190456,
    ];
    const skill = mkSkill({
      steps: [{ cmd: "collect", args: { block: "oak_log", count: 3, radius: 16 } }],
      stats: { runs: 15, success: 14, fail: 1, durations: REAL, failures: [] },
    });
    const a = analyzeSkill(skill);
    const props = proposeForSkill(a, skill);

    const tailProp = props.find((p) => p.kind === "long_tail");
    if (!tailProp) throw new Error("应产生 long_tail 提案");
    if (!tailProp.change || tailProp.change.action !== "bound_search") {
      throw new Error("长尾提案应建议收束搜索范围");
    }
    if (!Array.isArray(tailProp.change.suggest) || !tailProp.change.suggest.length) {
      throw new Error("应给出具体建议列表");
    }
    if (!/583|中位数/.test(tailProp.title)) throw new Error(`标题应含量化信息，实际：${tailProp.title}`);
    ok("长尾提案带可执行建议（bound_search + 具体改法）");
  } catch (e) {
    fail("长尾提案可执行", e);
  }

  /* 17. 分布均匀时不误报长尾 */
  try {
    const even = [20000, 21000, 22000, 20500, 21500, 20800, 21200, 20600];
    const a = analyzeSkill(
      mkSkill({ stats: { runs: 8, success: 8, fail: 0, durations: even, failures: [] } }),
    );
    if (!a.tail) throw new Error("8 个样本应能算长尾");
    if (a.tail.flagged) throw new Error(`分布均匀不该报长尾，实际 ratio=${a.tail.ratio} slowRuns=${a.tail.slowRuns}`);
    if (a.tail.slowRuns !== 0) throw new Error(`不该有异常慢，实际 ${a.tail.slowRuns}`);

    const props = proposeForSkill(a, mkSkill({ stats: { runs: 8, success: 8, fail: 0, durations: even, failures: [] } }));
    if (props.some((p) => p.kind === "long_tail")) throw new Error("均匀分布不该给长尾提案");
    ok("分布均匀时不误报长尾");
  } catch (e) {
    fail("均匀分布不误报", e);
  }

  /* 18. 样本太少时不算长尾（避免 3 个样本就下结论） */
  try {
    const a = analyzeSkill(
      mkSkill({ stats: { runs: 3, success: 3, fail: 0, durations: [1000, 1000, 99999], failures: [] } }),
    );
    if (a.tail !== null) throw new Error(`样本 < ${MIN_SAMPLES_FOR_TAIL} 时不该算长尾`);
    ok(`样本不足 ${MIN_SAMPLES_FOR_TAIL} 条时不判定长尾`);
  } catch (e) {
    fail("少样本不算长尾", e);
  }

  /* ---- 报告 ---- */
  console.log("");
  console.log("═".repeat(60));
  for (const r of results) {
    console.log(`${r.pass ? "  ✔" : "  ✘"} ${r.name}`);
    if (!r.pass) console.log(`       ${r.err && r.err.message ? r.err.message : r.err}`);
  }
  console.log("═".repeat(60));
  const passed = results.filter((r) => r.pass).length;
  console.log(`通过 ${passed} / ${results.length}`);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(passed === results.length ? 0 : 1);
})();
