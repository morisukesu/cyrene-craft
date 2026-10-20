"use strict";

/**
 * 目标规划层（Goal Plan）单元测试
 *
 * 覆盖：
 *   1. 材料齐全 → 只做成品
 *   2. 有木板有棍子没工作台 → 先做工作台、放下、再做木镐
 *   3. 附近已有工作台 → 跳过做工作台
 *   4. 缺木板 → 先做木板
 *   5. 缺原木 → 先采原木，再做木板，再做成品
 *   6. 箱子里有木板 → 先去箱子拿
 *   7. 箱子只够一部分 → 拿完还接着做
 *   8. 什么都没有 → 报缺料，不留半截成品步骤
 *   9. 采集目标 → 一步 collect
 *  10. 采集目标箱子里有 → 一步 withdraw
 *  11. 递归深度限制：超过上限不硬编
 *  12. isStepNeeded：背包变了就跳过
 *  13. stepToAction：步骤映射成工具调用
 *  14. formatPlan：输出顺序可读
 *
 * 全部离线：纯函数，不碰 bot、不碰文件。
 */

const {
  RECIPES,
  countOf,
  hasBlockNearby,
  containerStock,
  planGoal,
  isStepNeeded,
  stepToAction,
  formatPlan,
} = require("../src/goal-plan.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

const inv = (items) => Object.entries(items).map(([name, count]) => ({ name, count }));

/** 把步骤压成 "kind:target" 便于断言 */
const shape = (plan) => plan.steps.map((s) => `${s.kind}:${s.target}`);

/** 附近有工作台时的 blocks */
const blocksWithTable = [{ name: "crafting_table", count: 1, reachable: true }];

/* 1. 材料齐全 */
try {
  const plan = planGoal(
    { kind: "craft", target: "wooden_pickaxe", count: 1 },
    { inventory: inv({ oak_planks: 8, stick: 4 }), blocks: blocksWithTable },
  );

  if (!plan.ok) throw new Error(`不该失败：${plan.reason}`);
  if (shape(plan).join(",") !== "craft:wooden_pickaxe") {
    throw new Error(`步骤不对：${shape(plan).join(",")}`);
  }

  ok("规划：材料齐全时只做成品");
} catch (e) {
  fail("材料齐全", e);
}

/* 2. 没工作台 → 先做工作台 */
try {
  const plan = planGoal(
    { kind: "craft", target: "wooden_pickaxe", count: 1 },
    { inventory: inv({ oak_planks: 8, stick: 4 }), blocks: [] },
  );

  const order = shape(plan).join(",");
  const expected = "craft:crafting_table,place:crafting_table,craft:wooden_pickaxe";
  if (order !== expected) throw new Error(`步骤不对：${order}`);

  ok("规划：没工作台时先做并放下");
} catch (e) {
  fail("没工作台", e);
}

/* 3. 已有工作台 → 跳过 */
try {
  const plan = planGoal(
    { kind: "craft", target: "wooden_pickaxe", count: 1 },
    { inventory: inv({ oak_planks: 8, stick: 4 }), blocks: blocksWithTable },
  );

  if (shape(plan).some((s) => s.startsWith("place:"))) {
    throw new Error(`不该再放工作台：${shape(plan).join(",")}`);
  }

  ok("规划：附近已有工作台时不重复做");
} catch (e) {
  fail("已有工作台", e);
}

/* 4. 缺木板 → 先做木板 */
try {
  const plan = planGoal(
    { kind: "craft", target: "wooden_pickaxe", count: 1 },
    { inventory: inv({ oak_log: 4, stick: 5 }), blocks: blocksWithTable },
  );

  const order = shape(plan).join(",");
  if (!order.startsWith("craft:oak_planks")) {
    throw new Error(`没有先做木板：${order}`);
  }
  if (!order.endsWith("craft:wooden_pickaxe")) {
    throw new Error(`没有做成品：${order}`);
  }

  ok("规划：缺木板时先做木板");
} catch (e) {
  fail("缺木板", e);
}

/* 5. 缺原木 → 先采原木 */
try {
  const plan = planGoal(
    { kind: "craft", target: "wooden_pickaxe", count: 1 },
    { inventory: inv({ stick: 5 }), blocks: blocksWithTable },
  );

  const order = shape(plan).join(",");
  const expected = "collect:oak_log,craft:oak_planks,craft:wooden_pickaxe";
  if (order !== expected) throw new Error(`步骤不对：${order}`);

  ok("规划：缺原木时先采再一步步做上来");
} catch (e) {
  fail("缺原木", e);
}

/* 6. 箱子里有木板 */
try {
  const plan = planGoal(
    { kind: "craft", target: "wooden_pickaxe", count: 1 },
    {
      inventory: inv({ stick: 4 }),
      blocks: blocksWithTable,
      containers: [
        { position: { x: 1, y: 64, z: 1 }, items: [{ name: "oak_planks", count: 16 }] },
      ],
    },
  );

  const order = shape(plan).join(",");
  if (!order.startsWith("withdraw:oak_planks")) {
    throw new Error(`没有先去箱子拿：${order}`);
  }
  if (order.includes("collect:oak_log")) {
    throw new Error(`箱子有货还去砍树：${order}`);
  }

  ok("规划：箱子里有货时优先去拿");
} catch (e) {
  fail("箱子取货", e);
}

/* 7. 箱子只够一部分 */
try {
  const plan = planGoal(
    { kind: "craft", target: "wooden_pickaxe", count: 1 },
    {
      inventory: inv({ oak_log: 2, stick: 4 }),
      blocks: blocksWithTable,
      containers: [
        { position: { x: 1, y: 64, z: 1 }, items: [{ name: "oak_planks", count: 1 }] },
      ],
    },
  );

  const order = shape(plan).join(",");
  if (!order.includes("withdraw:oak_planks")) {
    throw new Error(`没有取箱子里的那份：${order}`);
  }
  // 还差的部分要靠原木补
  if (!order.includes("craft:oak_planks")) {
    throw new Error(`剩下的没补上：${order}`);
  }

  ok("规划：箱子只够一部分时拿完继续做");
} catch (e) {
  fail("部分取货", e);
}

/* 8. 什么都没有 → 从采集开始 */
try {
  const plan = planGoal(
    { kind: "craft", target: "wooden_pickaxe", count: 1 },
    { inventory: [], blocks: [] },
  );

  if (!plan.ok) throw new Error(`应该能从零开始：${plan.reason}`);
  const order = shape(plan).join(",");
  if (!order.startsWith("collect:oak_log")) {
    throw new Error(`没有从采集开始：${order}`);
  }
  if (!order.endsWith("craft:wooden_pickaxe")) {
    throw new Error(`没有做到成品：${order}`);
  }

  ok("规划：从零开始时先采集再一步步做上来");
} catch (e) {
  fail("从零开始", e);
}

/* 8b. 真正搞不到的东西 → 报缺料 */
try {
  const plan = planGoal(
    { kind: "craft", target: "diamond_pickaxe", count: 1 },
    { inventory: [], blocks: [] },
  );

  if (plan.ok) throw new Error("不该判定为可执行");
  if (!plan.missing.length) throw new Error("应当记录缺料");
  if (!plan.reason || !plan.reason.includes("缺")) {
    throw new Error(`缺料说明不对：${plan.reason}`);
  }

  ok("规划：搞不到的原料会明确报缺");
} catch (e) {
  fail("真正缺料", e);
}

/* 9. 采集目标 */
try {
  const plan = planGoal(
    { kind: "collect", target: "oak_log", count: 4 },
    { inventory: inv({ oak_log: 1 }), blocks: [] },
  );

  if (plan.steps.length !== 1) throw new Error(`步骤数不对：${plan.steps.length}`);
  if (plan.steps[0].kind !== "collect" || plan.steps[0].count !== 3) {
    throw new Error(`采集步骤不对：${JSON.stringify(plan.steps[0])}`);
  }

  ok("规划：采集目标只差几个就采几个");
} catch (e) {
  fail("采集目标", e);
}

/* 10. 采集目标箱子里有 */
try {
  const plan = planGoal(
    { kind: "collect", target: "oak_log", count: 4 },
    {
      inventory: [],
      blocks: [],
      containers: [
        { position: { x: 2, y: 64, z: 2 }, items: [{ name: "oak_log", count: 8 }] },
      ],
    },
  );

  if (plan.steps.length !== 1 || plan.steps[0].kind !== "withdraw") {
    throw new Error(`应该去箱子拿：${shape(plan).join(",")}`);
  }

  ok("规划：采集目标也先看箱子");
} catch (e) {
  fail("采集看箱子", e);
}

/* 11. 深度限制 */
try {
  const plan = planGoal(
    { kind: "craft", target: "wooden_pickaxe", count: 1 },
    { inventory: [], blocks: [] },
    { depth: 1 },
  );

  if (plan.ok) throw new Error("深度限制下不该判定为可执行");
  if (!plan.missing.length) throw new Error("应当记录缺料");

  ok("规划：深度限制生效，不会无限递归");
} catch (e) {
  fail("深度限制", e);
}

/* 12. isStepNeeded */
try {
  const step = { kind: "craft", target: "oak_planks", count: 4 };

  if (!isStepNeeded(step, { inventory: inv({ oak_planks: 1 }) })) {
    throw new Error("材料不够时应该还需要");
  }
  if (isStepNeeded(step, { inventory: inv({ oak_planks: 8 }) })) {
    throw new Error("材料够了应该跳过");
  }

  const placeStep = { kind: "place", target: "crafting_table", count: 1 };
  if (!isStepNeeded(placeStep, { blocks: [] })) throw new Error("没工作台应该要放");
  if (isStepNeeded(placeStep, { blocks: blocksWithTable })) {
    throw new Error("已有工作台应该跳过");
  }

  ok("判定：步骤前置条件复查正确");
} catch (e) {
  fail("isStepNeeded", e);
}

/* 13. stepToAction */
try {
  if (stepToAction({ kind: "collect", target: "oak_log", count: 2 }).tool !== "collect") {
    throw new Error("collect 映射不对");
  }
  if (stepToAction({ kind: "craft", target: "stick", count: 1 }).tool !== "craft") {
    throw new Error("craft 映射不对");
  }
  if (stepToAction({ kind: "withdraw", target: "oak_planks", count: 4 }).tool !== "container") {
    throw new Error("withdraw 映射不对");
  }
  if (stepToAction({ kind: "place", target: "crafting_table" }).tool !== "place") {
    throw new Error("place 映射不对");
  }

  ok("映射：步骤能转成工具调用");
} catch (e) {
  fail("stepToAction", e);
}

/* 14. 工具函数 */
try {
  if (countOf(inv({ oak_log: 3 }), "oak_log") !== 3) throw new Error("countOf 数组不对");
  if (countOf({ oak_log: 5 }, "oak_log") !== 5) throw new Error("countOf 对象不对");
  if (!hasBlockNearby(blocksWithTable, "crafting_table")) throw new Error("没认出工作台");
  if (hasBlockNearby([], "crafting_table")) throw new Error("空列表误判");

  const stock = containerStock(
    [{ position: { x: 0, y: 0, z: 0 }, items: [{ name: "oak_planks", count: 4 }] }],
    "oak_planks",
  );
  if (stock.total !== 4) throw new Error("容器统计不对");

  const text = formatPlan({ steps: [{ kind: "craft", target: "stick", count: 1 }] });
  if (!text.includes("craft:stick")) throw new Error(`formatPlan 不对：${text}`);

  if (!RECIPES.wooden_pickaxe.needsTable) throw new Error("配方标记不对");

  ok("工具：统计 / 容器 / 格式化 / 配方表");
} catch (e) {
  fail("工具函数", e);
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
