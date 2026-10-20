"use strict";

/**
 * 采集边界测试：距离上限 / 寻路超时 / 卡顿收工
 *
 * 起因：chop_oak 的 15 次真实耗时里，有两次是 583 秒和 190 秒。
 * 排查下来 collect 只设了「9 分钟总时限」，中间没有任何刹车：
 *   - 找不到目标就退出（这个有）
 *   - 找到了但很远，goto 会一直算下去（没有超时）
 *   - 目标超出搜索半径外一点点的位置，走很久收益却一样（没有必达距离）
 *
 * 这里只测纯逻辑部分：withTimeout 的行为，以及编译器的参数推导。
 * 真实寻路行为要真连才能验。
 *
 * 用法：node tools/collect-test.cjs
 */

const {
  withTimeout,
  harvestRequirement,
  inventoryCountMap,
  positiveDeltas,
} = require("../src/bot-runtime.cjs");
const { compileEpisode } = require("../src/skill-compiler.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* 1. 正常完成：不该被超时打断 */
  try {
    const fast = async () => {
      await sleep(20);
      return "done";
    };
    const v = await withTimeout(fast(), 500, "测试");
    if (v !== "done") throw new Error(`应返回 done，实际 ${v}`);
    ok("操作先完成时不触发超时");
  } catch (e) {
    fail("正常完成不被超时打断", e);
  }

  /* 2. 卡住的操作会被超时切断 */
  try {
    const hang = () => new Promise(() => {}); // 永不 resolve，模拟 goto 卡死
    const started = Date.now();
    let threw = null;
    try {
      await withTimeout(hang(), 120, "寻路");
    } catch (e) {
      threw = e;
    }
    const spent = Date.now() - started;

    if (!threw) throw new Error("卡死的操作必须超时");
    if (!/超时/.test(threw.message)) throw new Error(`错误信息应说明超时，实际：${threw.message}`);
    if (spent > 800) throw new Error(`超时响应太慢：${spent}ms`);
    ok(`卡死的操作被及时切断（${spent}ms，错误可读）`);
  } catch (e) {
    fail("卡死操作被切断", e);
  }

  /* 3. 超时时要真的停掉寻路器，不能让它后台空转 */
  try {
    let stopped = false;
    const hang = () => new Promise(() => {});
    try {
      await withTimeout(hang(), 80, "寻路", () => {
        stopped = true;
      });
    } catch {
      /* 预期 */
    }
    if (!stopped) throw new Error("超时回调没被执行，寻路器不会被 stop");
    ok("超时会调用清理回调（停掉寻路器）");
  } catch (e) {
    fail("超时清理回调", e);
  }

  /* 4. 清理回调自己抛错，不能掩盖超时本身 */
  try {
    const hang = () => new Promise(() => {});
    let threw = null;
    try {
      await withTimeout(hang(), 80, "寻路", () => {
        throw new Error("清理失败了");
      });
    } catch (e) {
      threw = e;
    }
    if (!threw) throw new Error("应该抛超时错误");
    if (!/超时/.test(threw.message)) throw new Error(`清理失败不该覆盖超时信息，实际：${threw.message}`);
    ok("清理回调抛错时，超时错误仍然清晰");
  } catch (e) {
    fail("清理抛错不掩盖超时", e);
  }

  /* 5. 操作本身抛错时，原错误要原样传出 */
  try {
    const boom = async () => {
      await sleep(10);
      throw new Error("寻路器自己报的错");
    };
    let threw = null;
    try {
      await withTimeout(boom(), 500, "寻路");
    } catch (e) {
      threw = e;
    }
    if (!threw) throw new Error("原错误应被抛出");
    if (/超时/.test(threw.message)) throw new Error("不该被误判成超时");
    if (!/寻路器自己报的错/.test(threw.message)) throw new Error(`原错误丢了：${threw.message}`);
    ok("操作自身的错误原样传出，不被超时逻辑吞掉");
  } catch (e) {
    fail("原错误透传", e);
  }

  /* 6. 编译器给采集步骤补上 maxDistance */
  try {
    const compiled = compileEpisode([{ tool: "collect", args: { block: "oak_log", count: 3 }, ok: true, origin: "llm", ms: 3000 }], {});
    if (!compiled) throw new Error("应该能编译");
    const step = compiled.steps[0];
    if (!Number.isFinite(step.args.maxDistance)) throw new Error("应自动补上 maxDistance");
    if (step.args.maxDistance > 16) throw new Error(`maxDistance 不该超过 16，实际 ${step.args.maxDistance}`);
    ok(`编译器自动补 maxDistance=${step.args.maxDistance}（技能自带距离界线）`);
  } catch (e) {
    fail("编译器补 maxDistance", e);
  }

  /* 7. 半径很大时，maxDistance 跟着收紧 */
  try {
    const compiled = compileEpisode([{ tool: "collect", args: { block: "oak_log", count: 1, radius: 48 }, ok: true, origin: "llm", ms: 3000 }], {});
    const step = compiled.steps[0];
    if (step.args.radius !== 16) throw new Error(`radius 应收紧到 16，实际 ${step.args.radius}`);
    if (step.args.maxDistance > 16) throw new Error(`maxDistance 应跟着收，实际 ${step.args.maxDistance}`);
    if (step.args.maxDistance > step.args.radius) {
      throw new Error("maxDistance 不该大于 radius（那等于没有界线）");
    }
    ok(`radius 48 → 16，maxDistance 同步收到 ${step.args.maxDistance}`);
  } catch (e) {
    fail("半径联动收紧", e);
  }

  /* 8. 原本就小的半径，maxDistance 不超过它 */
  try {
    const compiled = compileEpisode([{ tool: "collect", args: { block: "stone", count: 1, radius: 6 }, ok: true, origin: "llm", ms: 3000 }], {});
    const step = compiled.steps[0];
    if (step.args.maxDistance > 6) throw new Error(`radius 6 时 maxDistance 不该超 6，实际 ${step.args.maxDistance}`);
    ok(`小半径时 maxDistance=${step.args.maxDistance} 不超过 radius`);
  } catch (e) {
    fail("小半径联动", e);
  }

  /* 9. 非采集命令不该被塞 maxDistance */
  try {
    const compiled = compileEpisode([{ tool: "dig", args: { x: 1, y: 2, z: 3 }, ok: true, origin: "llm", ms: 200 }], {});
    const step = compiled.steps[0];
    if ("maxDistance" in step.args) throw new Error("dig 不该被塞 maxDistance");
    ok("非采集命令不会被塞 maxDistance");
  } catch (e) {
    fail("非采集不加参数", e);
  }

  /* 10. 版本先验：工具要求从 minecraft-data 读，不写死方块表 */
  try {
    const mcData = {
      blocksByName: {
        stone: { harvestTools: { 1: true } },
        dirt: {},
      },
    };
    const bare = harvestRequirement(mcData, "stone", null);
    const wrong = harvestRequirement(mcData, "stone", { type: 99 });
    const right = harvestRequirement(mcData, "stone", { type: 1 });
    const soft = harvestRequirement(mcData, "dirt", null);

    if (!bare || !/需要可用工具/.test(bare)) throw new Error(`空手 stone 应报缺工具：${bare}`);
    if (!wrong) throw new Error("错误工具也应报缺工具");
    if (right !== null) throw new Error("正确工具应放行");
    if (soft !== null) throw new Error("不需要工具的方块不该拦");

    ok("版本先验：工具要求从 minecraft-data 读");
  } catch (e) {
    fail("工具先验", e);
  }

  /* 11. 实际收益：按背包增量算，不按方块名算 */
  try {
    const before = new Map([["cobblestone", 2]]);
    const after = new Map([
      ["cobblestone", 5],
      ["dirt", 1],
    ]);
    const deltas = positiveDeltas(before, after);

    if (deltas[0].name !== "cobblestone" || deltas[0].count !== 3) {
      throw new Error(`主要掉落物不对：${JSON.stringify(deltas)}`);
    }

    const bot = {
      inventory: {
        items: () => [
          { name: "stone", count: 2 },
          { name: "stone", count: 3 },
        ],
      },
    };
    if (inventoryCountMap(bot).get("stone") !== 5) {
      throw new Error("背包合并计数不对");
    }

    ok("实际收益：按背包增量统计");
  } catch (e) {
    fail("收益统计", e);
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
  process.exit(passed === results.length ? 0 : 1);
})();
