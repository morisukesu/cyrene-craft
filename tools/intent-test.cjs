"use strict";

/**
 * 意图层（Grounding）单元测试
 *
 * 覆盖：
 *   1. intentOfStep：目标提取
 *   2. intentOfStep：坐标提取（三项齐才认）
 *   3. intentOfStep：上下文型命令不带目标
 *   4. intentOfStep：无信息量时返回 null
 *   5. renderIntent：多步串联
 *   6. renderIntent：参数占位符展开
 *   7. stripCoord / indexHint
 *   8. diagnose：四类归因
 *   9. 编译器集成：intent 被写进技能
 *  10. 存储往返：intent / cause / hint 不丢
 *  11. 索引：用意图首段而非描述
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  intentOfStep,
  renderIntent,
  diagnose,
  stripCoord,
  indexHint,
  CONTEXT_ONLY,
} = require("../src/skill-intent.cjs");
const { compileEpisode } = require("../src/skill-compiler.cjs");
const { SkillStore } = require("../src/skill-store.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

const tmpRoot = path.join(os.tmpdir(), `cyrene-intent-test-${process.pid}`);
const skillsDir = path.join(tmpRoot, "skills");
const store = () => new SkillStore({ rootDir: skillsDir, log: () => {} });

const row = (tool, args, extra = {}) => ({
  ts: Date.now(),
  tool,
  args,
  ok: true,
  ms: 500,
  origin: "llm",
  ...extra,
});

(async () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  /* 1. 目标提取 */
  try {
    const it = intentOfStep({ cmd: "collect", args: { block: "oak_log", count: 8 } });
    if (!it) throw new Error("应生成意图，实际 null");
    if (it.verb !== "Mine") throw new Error(`动词应为 Mine，实际 ${it.verb}`);
    if (it.target !== "oak_log") throw new Error(`目标应为 oak_log，实际 ${it.target}`);
    if (it.text !== "Mine oak_log") throw new Error(`文本不符：${it.text}`);
    ok("collect 生成 Mine + 目标");
  } catch (e) {
    fail("collect 生成 Mine + 目标", e);
  }

  /* 2. 坐标提取 */
  try {
    const full = intentOfStep({ cmd: "dig", args: { x: 10, y: 64, z: -3 } });
    if (!full || full.coord !== "(10, 64, -3)") throw new Error(`坐标不符：${full && full.coord}`);

    // 缺一项就不认，不猜
    const partial = intentOfStep({ cmd: "dig", args: { x: 10, y: 64 } });
    if (partial !== null) throw new Error("坐标不全时不该生成意图");

    // 字符串数字也接受
    const asText = intentOfStep({ cmd: "dig", args: { x: "10", y: "64", z: "-3" } });
    if (!asText || asText.coord !== "(10, 64, -3)") throw new Error("字符串数字应被接受");
    ok("坐标三项齐才生成，缺项返回 null");
  } catch (e) {
    fail("坐标三项齐才生成，缺项返回 null", e);
  }

  /* 3. 上下文型命令 */
  try {
    if (!CONTEXT_ONLY.has("move")) throw new Error("move 应在上下文型集合里");
    const it = intentOfStep({ cmd: "move", args: { player: "Mori", x: 1, y: 2, z: 3 } });
    if (!it) throw new Error("move 带坐标时仍应生成意图");
    if (it.target !== null) throw new Error("move 不该声明目标，目标来自上下文");
    if (it.coord !== "(1, 2, 3)") throw new Error(`move 坐标应保留，实际 ${it.coord}`);
    ok("上下文型命令不声明目标");
  } catch (e) {
    fail("上下文型命令不声明目标", e);
  }

  /* 4. 无信息量返回 null */
  try {
    if (intentOfStep({ cmd: "collect", args: {} }) !== null) throw new Error("空参数应返回 null");
    if (intentOfStep({ cmd: "unknown_cmd", args: { block: "oak_log" } }) !== null) {
      throw new Error("未知命令应返回 null");
    }
    if (intentOfStep(null) !== null) throw new Error("null 输入应返回 null");
    ok("无信息量不硬造意图");
  } catch (e) {
    fail("无信息量不硬造意图", e);
  }

  /* 5. 多步串联 */
  try {
    const steps = [
      { cmd: "move", args: { x: 1, y: 64, z: 1 } },
      { cmd: "dig", args: { x: 1, y: 64, z: 1 } },
      { cmd: "collect", args: { block: "oak_log", count: 2 } },
    ];
    const text = renderIntent(steps, {});
    const parts = text.split(" → ");
    if (parts.length !== 3) throw new Error(`应有 3 段，实际 ${parts.length}：${text}`);
    if (!parts[0].startsWith("Approach")) throw new Error(`首段应为 Approach：${parts[0]}`);
    if (!parts[2].startsWith("Mine oak_log")) throw new Error(`末段不符：${parts[2]}`);
    ok("多步意图用 → 串联");
  } catch (e) {
    fail("多步意图用 → 串联", e);
  }

  /* 6. 参数占位符展开 */
  try {
    const steps = [{ cmd: "collect", args: { block: "oak_log", count: "${count}" } }];
    const text = renderIntent(steps, { count: { default: 16, min: 1, max: 64 } });
    if (!text.includes("count=16")) throw new Error(`应展开默认值，实际：${text}`);

    // 没有参数表时不该崩，也不该瞎编
    const bare = renderIntent(steps, null);
    if (bare.includes("count=")) throw new Error(`无参数表时不该出现 count，实际：${bare}`);
    ok("占位符按参数表展开，缺表时不瞎编");
  } catch (e) {
    fail("占位符按参数表展开，缺表时不瞎编", e);
  }

  /* 7. 坐标剥离与索引摘要 */
  try {
    const intent = "Mine oak_log @(-9, 129, 9) → Mine oak_log @(1, 2, 3) count=8";
    const stripped = stripCoord(intent);
    if (stripped.includes("@(")) throw new Error(`坐标应被剥离：${stripped}`);

    const hint = indexHint(intent);
    if (hint !== "Mine oak_log") throw new Error(`索引摘要应为首段无坐标，实际：${hint}`);

    // 超长截断
    const long = indexHint(`Mine ${"x".repeat(120)}`, 20);
    if (long.length > 20) throw new Error(`应截断到 20 字内，实际 ${long.length}`);
    if (!long.endsWith("…")) throw new Error("截断应有省略号");

    if (indexHint(null) !== "") throw new Error("null 应返回空字符串");
    ok("坐标剥离与索引摘要正确");
  } catch (e) {
    fail("坐标剥离与索引摘要正确", e);
  }

  /* 8. 归因四类 */
  try {
    const intent = "Mine oak_log";

    const miss = diagnose(intent, { error: "nearby block not found" });
    if (miss.cause !== "intent_miss") throw new Error(`应判 intent_miss，实 ${miss.cause}`);
    if (!miss.hint.includes("Mine oak_log")) throw new Error("提示里应带上意图");

    const far = diagnose(intent, { error: "target exceeds maxDistance 16" });
    if (far.cause !== "param_off") throw new Error(`应判 param_off，实际 ${far.cause}`);

    const env1 = diagnose(intent, { error: "operation timeout after 30s" });
    if (env1.cause !== "env") throw new Error(`应判 env，实际 ${env1.cause}`);

    const env2 = diagnose(intent, { error: "Not connected to server" });
    if (env2.cause !== "env") throw new Error(`断线应判 env，实际 ${env2.cause}`);

    const unk = diagnose(intent, { error: "something weird" });
    if (unk.cause !== "unknown") throw new Error(`应判 unknown，实际 ${unk.cause}`);

    // 空报错不该崩
    if (diagnose(null, null).cause !== "unknown") throw new Error("null 输入应判 unknown");
    ok("失败归因四类判定正确");
  } catch (e) {
    fail("失败归因四类判定正确", e);
  }

  /* 9. 编译器集成 */
  try {
    const episode = [
      row("collect", { block: "oak_log", count: 6 }),
      row("collect", { block: "oak_log", count: 6 }),
    ];
    const compiled = compileEpisode(episode);
    if (!compiled) throw new Error("应编译出技能");
    if (typeof compiled.intent !== "string") throw new Error("技能应带 intent 字段");
    if (!compiled.intent.startsWith("Mine oak_log")) throw new Error(`意图不符：${compiled.intent}`);
    if (!compiled.intent.includes("count=6")) throw new Error(`应带 count 默认值：${compiled.intent}`);

    // 纯查询轨迹 → 编不出技能，也不该产出意图
    const nothing = compileEpisode([row("status", {}), row("scan", { block: "oak_log" })]);
    if (nothing !== null) throw new Error("查询类轨迹应返回 null");
    ok("编译器产出意图字段");
  } catch (e) {
    fail("编译器产出意图字段", e);
  }

  /* 10. 储往返：intent / cause / hint 不丢 */
  try {
    const s = store();
    const compiled = compileEpisode([row("collect", { block: "oak_log", count: 4 })]);
    s.save("chop_oak", compiled);

    const loaded = s.get("chop_oak");
    if (!loaded.intent) throw new Error("intent 在存储往返中丢失");
    if (!loaded.intent.includes("oak_log")) throw new Error(`intent 内容不符：${loaded.intent}`);

    // 记一次失败，检查归因结论被持久化
    s.recordRun("chop_oak", false, 3000, {
      error: "nearby oak_log not found",
      step: 0,
      cmd: "collect",
    });

    const again = s.get("chop_oak");
    const f = again.stats.failures[0];
    if (!f) throw new Error("失败记录未写入");
    if (f.cause !== "intent_miss") throw new Error(`cause 应持久化为 intent_miss，实际 ${f.cause}`);
    if (!f.intent) throw new Error("失败记录应带上当时的意图");
    if (!f.hint) throw new Error("失败记录应带上归因提示");

    // 再存一次，确认归一化没把归因抹掉
    s.save("chop_oak", again);
    const third = s.get("chop_oak");
    if (third.stats.failures[0].cause !== "intent_miss") {
      throw new Error("归一化抹掉了 cause");
    }
    ok("intent / cause / hint 存储往返不丢");
  } catch (e) {
    fail("intent / cause / hint 存储往返不丢", e);
  }

  /* 11. 索引使用意图首段 */
  try {
    const s = store();
    const compiled = compileEpisode([row("collect", { block: "oak_log", count: 8 })]);
    s.save("chop_oak_idx", compiled);

    const idx = s.index(500);
    if (!idx.includes("Mine oak_log")) throw new Error(`索引应含意图首段：${idx}`);
    if (idx.includes("@(")) throw new Error(`索引不该含坐标：${idx}`);

    // 没有 intent 的老技能要能降级到 description，不能崩
    s.save("legacy_skill", {
      description: "老技能描述",
      intent: null,
      steps: [{ cmd: "dig", args: { x: 1, y: 2, z: 3 } }],
    });
    const idx2 = s.index(500);
    if (!idx2.includes("老技能描述")) throw new Error(`应降级到 description：${idx2}`);
    ok("索引优先用意图，缺失时降级不崩");
  } catch (e) {
    fail("索引优先用意图，缺失时降级不崩", e);
  }

  /* 结果汇总 */
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);

  console.log("");
  for (const r of results) {
    console.log(`  ${r.pass ? "✓" : "✗"} ${r.name}${r.pass ? "" : `  ← ${r.err.message}`}`);
  }
  console.log("");
  console.log(`意图层测试：${passed}/${results.length} 通过`);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (failed.length) process.exitCode = 1;
})();
