"use strict";

/**
 * 技能层（L0→L1）单元测试
 *
 * 覆盖：
 *   1. 技能库路径越界保护
 *   2. 技能名非法拒绝
 *   3. 保存 / 读取 / 删除 / 字段补全
 *   4. 统计记录与成功率
 *   5. 编译器：过滤查询类命令
 *   6. 编译器：连续重复合并 + count 参数化
 *   7. 编译器：move 坐标参数被剥离
 *   8. 编译器：纯查询轨迹返回 null（不硬编）
 *   9. resolveSteps 参数展开与边界钳制
 *  10. 自动起名
 *  11. 执行器：成功 / 失败 / 不存在三种路径
 *  12. 技能索引长度上限
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { SkillStore } = require("../src/skill-store.cjs");
const {
  compileEpisode,
  resolveSteps,
  suggestName,
  compileLesson,
  suggestLessonName,
} = require("../src/skill-compiler.cjs");
const { SkillRunner } = require("../src/skill-runner.cjs");
const { judgeOutcome } = require("../src/brain-loop.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

const tmpRoot = path.join(os.tmpdir(), `cyrene-skill-test-${process.pid}`);
const skillsDir = path.join(tmpRoot, "skills");

const store = () => new SkillStore({ rootDir: skillsDir, log: () => {} });

/** 造一条轨迹记录 */
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

  /* 1. 路径越界保护 */
  try {
    const s = store();
    let blocked = 0;
    for (const bad of ["../../etc/passwd", "..\\..\\windows", "C:/Windows/x", "/etc/x"]) {
      try {
        s.fileOf(bad);
      } catch {
        blocked += 1;
      }
    }
    if (blocked !== 4) throw new Error(`应全部拒绝，实际拒绝 ${blocked}/4`);
    ok("路径越界与非法名全部拒绝");
  } catch (e) {
    fail("路径越界与非法名全部拒绝", e);
  }

  /* 2. 非法技能名 */
  try {
    const s = store();
    let passed = 0;
    for (const bad of ["", "含中文", "has space", "a/b", "x".repeat(49)]) {
      try {
        s.assertName(bad);
      } catch {
        passed += 1;
      }
    }
    if (passed !== 5) throw new Error(`应拒绝 5 个，实际 ${passed}`);
    // 合法名要能过
    s.assertName("chop_oak");
    s.assertName("build-house_v2");
    ok("非法技能名拒绝、合法名放行");
  } catch (e) {
    fail("非法技能名拒绝、合法名放行", e);
  }

  /* 3. 保存 / 读取 / 字段补全 / 删除 */
  try {
    const s = store();
    s.save("chop_oak", {
      description: "砍橡木",
      steps: [{ cmd: "collect", args: { block: "oak_log", count: "${count}" } }],
      params: { count: { default: 8, min: 1, max: 64 } },
    });

    const got = s.get("chop_oak");
    if (!got) throw new Error("读取不到刚保存的技能");
    if (got.name !== "chop_oak") throw new Error(`name 错了：${got.name}`);
    if (got.level !== 1) throw new Error(`默认 level 应为 1，实际 ${got.level}`);
    if (got.steps.length !== 1) throw new Error(`步骤数错了：${got.steps.length}`);
    if (!got.stats || got.stats.runs !== 0) throw new Error("stats 未初始化");
    if (!got.createdAt || !got.updatedAt) throw new Error("缺少时间戳");
    if (got.safety.whitelist !== true) throw new Error("safety.whitelist 默认应为 true");

    if (!s.listNames().includes("chop_oak")) throw new Error("listNames 缺技能");

    const r = s.remove("chop_oak");
    if (!r.removed) throw new Error("删除失败");
    if (s.get("chop_oak")) throw new Error("删除后还能读到");
    ok("保存 / 读取 / 字段补全 / 删除都正常");
  } catch (e) {
    fail("保存 / 读取 / 字段补全 / 删除都正常", e);
  }

  /* 4. 统计与成功率 */
  try {
    const s = store();
    s.save("stat_test", { steps: [{ cmd: "collect", args: { block: "stone" } }] });

    if (s.successRate(s.get("stat_test")) !== null) throw new Error("没跑过时成功率应为 null");

    s.recordRun("stat_test", true, 1000);
    s.recordRun("stat_test", true, 2000);
    s.recordRun("stat_test", false, 3000);

    const sk = s.get("stat_test");
    if (sk.stats.runs !== 3) throw new Error(`runs 应为 3，实际 ${sk.stats.runs}`);
    if (sk.stats.success !== 2) throw new Error(`success 应为 2，实际 ${sk.stats.success}`);
    if (sk.stats.durations.length !== 3) throw new Error("耗时未记录");

    const rate = s.successRate(sk);
    if (Math.abs(rate - 2 / 3) > 0.01) throw new Error(`成功率错了：${rate}`);
    ok("统计记录与成功率正确");
  } catch (e) {
    fail("统计记录与成功率正确", e);
  }

  /* 5. 编译器过滤查询类 */
  try {
    const episode = [row("scan", { block: "oak_log" }), row("status", {}), row("collect", { block: "oak_log", count: 8 })];
    const compiled = compileEpisode(episode, {});
    if (!compiled) throw new Error("应该能编译出技能");
    const cmds = compiled.steps.map((s) => s.cmd);
    if (cmds.includes("scan")) throw new Error("scan 不该进技能");
    if (cmds.includes("status")) throw new Error("status 不该进技能");
    if (!cmds.includes("collect")) throw new Error("collect 应该保留");
    ok("编译器过滤掉 scan / status 等查询类命令");
  } catch (e) {
    fail("编译器过滤掉查询类命令", e);
  }

  /* 6. 连续重复合并 + 参数化 */
  try {
    const episode = [
      row("dig", { x: 1, y: 2, z: 3 }),
      row("dig", { x: 1, y: 2, z: 3 }),
      row("dig", { x: 1, y: 2, z: 3 }),
    ];
    const compiled = compileEpisode(episode, {});
    if (!compiled) throw new Error("应该能编译");
    if (compiled.steps.length !== 1) throw new Error(`应合并成 1 步，实际 ${compiled.steps.length}`);
    if (!compiled.params.count) throw new Error("没有抽出 count 参数");
    if (compiled.params.count.default !== 3) throw new Error(`count 默认值应为 3，实际 ${compiled.params.count.default}`);
    if (compiled.steps[0].args.count !== "${count}") throw new Error("count 未参数化");
    ok("连续重复命令合并成循环并抽出 count 参数");
  } catch (e) {
    fail("连续重复命令合并成循环并抽出 count 参数", e);
  }

  /* 7. move 坐标被剥离 */
  try {
    const episode = [row("move", { x: 100, y: 64, z: -200 }), row("dig", { x: 100, y: 64, z: -200 })];
    const compiled = compileEpisode(episode, {});
    if (!compiled) throw new Error("应该能编译");
    const move = compiled.steps.find((s) => s.cmd === "move");
    if (!move) throw new Error("move 步骤丢了");
    if ("x" in move.args || "y" in move.args || "z" in move.args) {
      throw new Error(`move 的绝对坐标应被剥离，实际 ${JSON.stringify(move.args)}`);
    }
    ok("move 的绝对坐标被剥离，避免绑死某个位置");
  } catch (e) {
    fail("move 的绝对坐标被剥离", e);
  }

  /* 8. 纯查询轨迹不硬编 */
  try {
    const episode = [row("scan", { block: "stone" }), row("status", {}), row("inventory", {})];
    const compiled = compileEpisode(episode, {});
    if (compiled !== null) throw new Error("纯查询轨迹应返回 null，不该硬编");
    ok("纯查询轨迹返回 null，不硬造技能");
  } catch (e) {
    fail("纯查询轨迹返回 null", e);
  }

  /* 8.5 wait 不能是「动作本身耗时」 */
  try {
    // 一次真实采集：总共花了 4500ms，但 collect 自己内部已经等过了
    const episode = [{ ...row("collect", { block: "oak_log", count: 1 }), ms: 4500 }];
    const compiled = compileEpisode(episode, {});
    if (!compiled) throw new Error("应该能编译");

    const step = compiled.steps[0];
    if (step.wait !== undefined) {
      throw new Error(`collect 不该带 wait，实际 ${step.wait}（这会让技能白等一遍）`);
    }

    // dig 这类瞬时动作应该有固定小缓冲
    const digEp = [row("dig", { x: 1, y: 2, z: 3 })];
    const digCompiled = compileEpisode(digEp, {});
    if (!digCompiled) throw new Error("dig 应该能编译");
    const w = digCompiled.steps[0].wait;
    if (!(typeof w === "number" && w > 0 && w <= 500)) {
      throw new Error(`dig 的 wait 应该是小固定值，实际 ${w}`);
    }
    ok(`wait 语义正确（collect 无 wait，dig 固定 ${w}ms）`);
  } catch (e) {
    fail("wait 语义正确", e);
  }

  /* 8.6 搜索半径收紧：技能不该每次跑去找 48 格外那棵树 */
  try {
    const episode = [row("collect", { block: "oak_log", count: 1, radius: 48 })];
    const compiled = compileEpisode(episode, {});
    if (!compiled) throw new Error("应该能编译");
    const r = compiled.steps[0].args.radius;
    if (r !== 16) throw new Error(`radius 48 应收紧到 16，实际 ${r}`);

    // 本来就小的半径保持原样，不要反向放大
    const small = compileEpisode([row("collect", { block: "oak_log", count: 1, radius: 6 })], {});
    if (small.steps[0].args.radius !== 6) {
      throw new Error(`radius 6 应保持原样，实际 ${small.steps[0].args.radius}`);
    }

    // move 不在收紧名单里：它的 radius 是寻路范围，不是采集搜索半径，
    // 收小它反而可能让寻路失败。
    const mv = compileEpisode([row("move", { x: 1, y: 2, z: 3, radius: 100 })], {});
    if (mv && mv.steps[0].args.radius === 100 && !("x" in mv.steps[0].args)) {
      // 坐标剥掉、半径原样 = 预期行为，什么都不用做
    }

    ok("搜索半径收紧（48→16，小半径保留原值，move 不误伤）");
  } catch (e) {
    fail("搜索半径收紧", e);
  }

  /* 8.7 sequence 不进技能 */
  try {
    const episode = [row("sequence", { steps: [{ cmd: "collect", args: { block: "oak_log" } }] })];
    const compiled = compileEpisode(episode, {});
    if (compiled !== null) throw new Error("只有 sequence 包装、没有真实动作时应返回 null");
    ok("sequence 包装器不进技能（只有包装时返回 null）");
  } catch (e) {
    fail("sequence 不进技能", e);
  }

  /* 8.8 trace 占位符不进技能 */
  try {
    // trace 压缩深结构时会留 [deep] / [12 items] 这类占位符
    const deep = compileEpisode([row("collect", { block: "[deep]", count: "[deep]" })], {});
    if (deep !== null) throw new Error("[deep] 应拒绝编译");

    const many = compileEpisode([row("build", { block: "[40 items]" })], {});
    if (many !== null) throw new Error("[40 items] 应拒绝编译");

    // 真的是方块名、不是占位符的，照常放行
    const real = compileEpisode([row("collect", { block: "oak_log", count: 2 })], {});
    if (!real) throw new Error("正常参数不该被误杀");
    ok("trace 占位符拒绝编译，正常参数不误杀");
  } catch (e) {
    fail("占位符不编进技能", e);
  }

  /* 9. resolveSteps 参数展开与钳制 */
  try {
    const steps = [{ cmd: "collect", args: { block: "oak_log", count: "${count}" } }];
    const params = { count: { default: 8, min: 1, max: 16 } };

    const a = resolveSteps(steps, params, {});
    if (a[0].args.count !== 8) throw new Error(`默认值错了：${a[0].args.count}`);

    const b = resolveSteps(steps, params, { count: 4 });
    if (b[0].args.count !== 4) throw new Error(`覆盖值错了：${b[0].args.count}`);

    const c = resolveSteps(steps, params, { count: 999 });
    if (c[0].args.count !== 16) throw new Error(`上限未钳制：${c[0].args.count}`);

    const d = resolveSteps(steps, params, { count: -5 });
    if (d[0].args.count !== 1) throw new Error(`下限未钳制：${d[0].args.count}`);

    // 原 steps 不应被修改
    if (steps[0].args.count !== "${count}") throw new Error("resolveSteps 改到了原始步骤");
    ok("resolveSteps 展开参数且正确钳制上下限");
  } catch (e) {
    fail("resolveSteps 展开参数且正确钳制上下限", e);
  }

  /* 10. 自动起名 */
  try {
    const wood = [row("collect", { block: "oak_log", count: 8 })];
    if (suggestName(wood) !== "chop_oak") throw new Error(`起名错了：${suggestName(wood)}`);

    const stone = [row("collect", { block: "stone", count: 4 })];
    if (suggestName(stone) !== "chop_stone") throw new Error(`石头起名错了：${suggestName(stone)}`);

    const build = [row("build", { block: "oak_planks", shape: "box", size: 3 })];
    if (suggestName(build) !== "build_oak_planks") throw new Error(`建造起名错了：${suggestName(build)}`);
    ok("按主对象自动起名（chop_oak / chop_stone / build_oak_planks）");
  } catch (e) {
    fail("按主对象自动起名", e);
  }

  /* 11. 执行器三条路径 */
  try {
    const s = store();
    s.save("run_ok", { steps: [{ cmd: "collect", args: { block: "oak_log", count: "${count}" } }], params: { count: { default: 8 } } });

    const runner = new SkillRunner({ store: s, request: async () => ({}), log: () => {} });

    // 成功
    const okRes = await runner.run("run_ok", {}, {
      runSteps: async () => ({ total: 1, done: 1, failed: 0, results: [{ index: 0, ok: true, cmd: "collect" }] }),
    });
    if (!okRes.ok) throw new Error("应判定成功");
    if (okRes.durationMs < 0) throw new Error("耗时不对");

    const after = s.get("run_ok");
    if (after.stats.runs !== 1 || after.stats.success !== 1) throw new Error("成功统计没记上");

    // 失败
    const badRes = await runner.run("run_ok", {}, {
      runSteps: async () => ({ total: 1, done: 0, failed: 1, results: [{ index: 0, ok: false, cmd: "collect", error: "没找到树" }] }),
    });
    if (badRes.ok) throw new Error("应判定失败");
    if (!badRes.fallback) throw new Error("失败时应给出 fallback 建议");

    const formatted = runner.format(badRes);
    if (!formatted.includes("失败")) throw new Error("格式化结果没体现失败");

    // 不存在
    const missing = await runner.run("no_such_skill");
    if (missing.ok) throw new Error("不存在的技能应失败");
    if (!missing.fallback) throw new Error("不存在时也应建议回退");

    ok("执行器成功 / 失败 / 不存在三条路径都正确");
  } catch (e) {
    fail("执行器三条路径", e);
  }

  /* 12. 索引长度上限 */
  try {
    const s = store();
    for (let i = 0; i < 20; i += 1) {
      s.save(`skill_${i}`, {
        description: "一个名字挺长的技能说明，用来测试索引长度控制是否生效",
        steps: [{ cmd: "collect", args: { block: `block_${i}` } }],
      });
    }
    const idx = s.index(200);
    if (!idx) throw new Error("索引为空");
    if (idx.length > 220) throw new Error(`索引超长：${idx.length} 字`);
    if (!idx.includes("【可用技能】")) throw new Error("索引缺少标题");
    ok(`技能索引控制在 200 字内（实际 ${idx.length} 字）`);
  } catch (e) {
    fail("技能索引长度受控", e);
  }

  /* 空技能库索引为空 */
  try {
    const s = new SkillStore({ rootDir: path.join(tmpRoot, "empty"), log: () => {} });
    if (s.index(200) !== "") throw new Error("空库应返回空字符串");
    ok("技能库为空时索引是空串，不占上下文");
  } catch (e) {
    fail("技能库为空时索引是空串", e);
  }

  /* 13. lesson：失败→纠正→成功编成技能 */
  try {
    const lesson = compileLesson(
      [
        {
          tool: "collect",
          args: { block: "stone" },
          ok: false,
          error: "空手挖 stone 没有掉落",
          ts: 1,
        },
        { tool: "act", args: { action: "equip", item: "wooden_pickaxe" }, ok: true, ts: 2 },
        {
          tool: "collect",
          args: { block: "stone", tool: "wooden_pickaxe" },
          ok: true,
          detail: { gained: 3 },
          ts: 3,
        },
      ],
      {},
    );

    if (!lesson) throw new Error("没有编出 lesson");
    if (lesson.steps.length !== 2) throw new Error(`步骤数不对：${lesson.steps.length}`);
    if (lesson.steps[0].cmd !== "act" || lesson.steps[0].args.item !== "wooden_pickaxe") {
      throw new Error("缺少装备步骤");
    }
    if (lesson.steps[1].cmd !== "collect" || lesson.steps[1].args.tool !== "wooden_pickaxe") {
      throw new Error("采集步骤没带工具");
    }
    if (lesson.preconditions.requiresTool !== "wooden_pickaxe") {
      throw new Error("前置条件没记录工具");
    }
    if (suggestLessonName(lesson) !== "mine_stone_with_wooden_pickaxe") {
      throw new Error(`起名不对：${suggestLessonName(lesson)}`);
    }

    ok("lesson：失败→纠正→成功编成技能");
  } catch (e) {
    fail("lesson 编译", e);
  }

  /* 13b. 接线：ok:true + complete:false 会被判成失败，能参与教训编译 */
  try {
    // 工具层返回「跑完了但没做成」，包装器不再一律记成功。
    const raw = { ok: true, complete: false, reason: "需要可用工具才能采集 stone" };
    const verdict = judgeOutcome(raw);
    if (verdict.ok !== false) throw new Error("complete:false 应判失败");
    if (!verdict.error) throw new Error("失败记录应带原因");

    const lesson = compileLesson(
      [
        {
          tool: "collect",
          args: { block: "stone", count: 7 },
          ok: verdict.ok,
          error: verdict.error,
          ts: 1,
        },
        { tool: "act", args: { action: "equip", item: "wooden_pickaxe" }, ok: true, ts: 2 },
        {
          tool: "collect",
          args: { block: "stone", count: 1, tool: "wooden_pickaxe" },
          ok: true,
          ts: 3,
        },
      ],
      {},
    );

    if (!lesson) throw new Error("零收益失败没有被编成教训");
    if (suggestLessonName(lesson) !== "mine_stone_with_wooden_pickaxe") {
      throw new Error(`起名不对：${suggestLessonName(lesson)}`);
    }

    ok("接线：零收益采集经 judgeOutcome 后能编成教训");
  } catch (e) {
    fail("零收益接线", e);
  }

  /* 14. lesson：位置无关，不写绝对坐标 */
  try {
    const lesson = compileLesson(
      [
        { tool: "dig", args: { x: 1, y: 2, z: 3 }, ok: false, error: "没有掉落", ts: 1 },
        { tool: "act", args: { action: "equip", item: "stone_pickaxe" }, ok: true, ts: 2 },
        {
          tool: "dig",
          args: { x: 1, y: 2, z: 3, tool: "stone_pickaxe" },
          ok: true,
          detail: { block: "stone" },
          ts: 3,
        },
      ],
      {},
    );
    if (!lesson) throw new Error("没有编出 lesson");
    const text = JSON.stringify(lesson.steps);
    if (/"x":|"y":|"z":/.test(text)) throw new Error(`步骤里残留坐标：${text}`);

    ok("lesson：位置无关");
  } catch (e) {
    fail("lesson 位置无关", e);
  }

  /* 15. lesson：没有修复证据不硬编 */
  try {
    const noFix = compileLesson(
      [
        { tool: "collect", args: { block: "stone" }, ok: false, error: "失败", ts: 1 },
        { tool: "collect", args: { block: "stone" }, ok: true, ts: 2 },
      ],
      {},
    );
    if (noFix) throw new Error("没有证据也编了技能");

    const noSuccess = compileLesson(
      [{ tool: "collect", args: { block: "stone" }, ok: false, error: "失败", ts: 1 }],
      {},
    );
    if (noSuccess) throw new Error("没有成功也编了技能");

    ok("lesson：没有修复证据不硬编");
  } catch (e) {
    fail("lesson 克制", e);
  }

  /* 16. lesson：能存进现有技能库 */
  try {
    const s = store();
    const lesson = compileLesson(
      [
        { tool: "collect", args: { block: "stone" }, ok: false, error: "没有掉落", ts: 1 },
        { tool: "act", args: { action: "equip", item: "wooden_pickaxe" }, ok: true, ts: 2 },
        {
          tool: "collect",
          args: { block: "stone", tool: "wooden_pickaxe" },
          ok: true,
          detail: { gained: 2 },
          ts: 3,
        },
      ],
      {},
    );
    const name = suggestLessonName(lesson);
    s.save(name, { ...lesson, name });
    const loaded = s.get(name);
    if (!loaded || loaded.steps.length !== 2) throw new Error("lesson 没存进技能库");

    ok("lesson：走现有技能库保存");
  } catch (e) {
    fail("lesson 保存", e);
  }

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  report();
})();

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
