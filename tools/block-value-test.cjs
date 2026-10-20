"use strict";

/**
 * 方块资源珍惜度单元测试
 *
 * 1. 珍惜度：泥土 < 木板 < 玻璃 < 铁块 < 钻石块
 * 2. 消耗顺序：泥土优先于木板和钻石块
 * 3. 目标资源：橡木原木不会被拿来垫脚
 * 4. 珍贵方块：钻石块和铁块都不当消耗品
 * 5. 脚手架：显式优先，但目标需要时让位
 */

const B = require("../src/block-value.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* 1. 珍惜度排序 */
try {
  assert(B.valueOf("dirt") === 0, "泥土不是 0 级");
  assert(B.valueOf("cobblestone") === 0, "圆石不是 0 级");
  assert(B.valueOf("oak_planks") === 1, "木板不是 1 级");
  assert(B.valueOf("oak_log") === 1, "原木不是 1 级");
  assert(B.valueOf("glass") === 2, "玻璃不是 2 级");
  assert(B.valueOf("iron_block") === 3, "铁块不是 3 级");
  assert(B.valueOf("diamond_block") === 4, "钻石块不是 4 级");
  assert(B.valueOf("netherite_block") === 4, "下界合金块不是 4 级");
  assert(B.valueOf("unknown_block") === 2, "未知方块没有按 2 级保守处理");

  ok("珍惜度：泥土 < 木板 < 玻璃 < 铁块 < 钻石块");
} catch (e) {
  fail("珍惜度", e);
}

/* 2. 优先无价值方块 */
try {
  const pick = B.pickConsumable([
    { name: "oak_planks", count: 64 },
    { name: "dirt", count: 8 },
    { name: "diamond_block", count: 1 },
  ]);

  assert(pick && pick.name === "dirt", `没选泥土：${JSON.stringify(pick)}`);
  ok("消耗顺序：泥土优先于木板和钻石块");
} catch (e) {
  fail("消耗顺序", e);
}

/* 3. 当前目标资源被排除 */
try {
  const pick = B.pickConsumable(
    [
      { name: "oak_log", count: 61 },
      { name: "dirt", count: 3 },
    ],
    { protectedItems: ["oak_log"] },
  );

  assert(pick && pick.name === "dirt", `目标资源没被排除：${JSON.stringify(pick)}`);
  ok("目标资源：橡木原木不会被拿来垫脚");
} catch (e) {
  fail("目标资源", e);
}

/* 4. 珍贵方块永不被选 */
try {
  const pick = B.pickConsumable([
    { name: "diamond_block", count: 10 },
    { name: "iron_block", count: 10 },
  ]);

  assert(pick === null, `珍贵方块被选中：${JSON.stringify(pick)}`);
  ok("珍贵方块：钻石块和铁块都不当消耗品");
} catch (e) {
  fail("珍贵方块", e);
}

/* 5. 指定脚手架优先，但受保护时排除 */
try {
  const pick = B.pickConsumable(
    [
      { name: "dirt", count: 8 },
      { name: "scaffolding", count: 16 },
    ],
    { prefer: "scaffolding" },
  );
  assert(pick && pick.name === "scaffolding", `没有优先脚手架：${JSON.stringify(pick)}`);

  const blocked = B.pickConsumable(
    [
      { name: "dirt", count: 8 },
      { name: "scaffolding", count: 16 },
    ],
    { prefer: "scaffolding", protectedItems: ["scaffolding"] },
  );
  assert(blocked && blocked.name === "dirt", `被保护的脚手架仍被选：${JSON.stringify(blocked)}`);

  ok("脚手架：显式优先，但目标需要时让位");
} catch (e) {
  fail("脚手架", e);
}

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
