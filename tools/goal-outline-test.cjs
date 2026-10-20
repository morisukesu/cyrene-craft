"use strict";

/**
 * 大纲提纯（Goal Outline）单元测试
 *
 * 覆盖：
 *   1. 缩进链变成前置依赖
 *   2. 注解 [collect oak_log] / [craft ...] / [manual]
 *   3. 只写物品名时按采集处理
 *   4. @id 显式命名
 *   5. 重复标题自动加序号
 *   6. 显式 id 重复被拒绝
 *   7. checkpoint / priority 注解
 *   8. 空输入与缺产物被拒绝
 *   9. 最终仍走 parseGraph 校验
 *  10. tab 缩进
 */

const G = require("../src/goal-graph.cjs");
const O = require("../src/goal-outline.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

/* 1. 缩进链 */
try {
  const text = [
    "# 主线",
    "- 取得原木 [collect oak_log] @get_wood",
    "  - 做出木镐 [craft wooden_pickaxe] @craft_pickaxe",
    "    - 取得圆石 [collect cobblestone] @get_cobble",
    "- 击败末影龙 @dragon",
  ].join("\n");

  const r = O.parseOutline(text);
  if (!r.ok) throw new Error(r.errors.join("；"));
  if (r.graph.name !== "主线") throw new Error(`图名不对：${r.graph.name}`);

  const byId = new Map(r.graph.nodes.map((n) => [n.id, n]));
  if (byId.get("get_wood").requires.length !== 0) throw new Error("根节点不该有前置");
  if (byId.get("craft_pickaxe").requires.join(",") !== "get_wood") {
    throw new Error(`木镐前置不对：${byId.get("craft_pickaxe").requires}`);
  }
  if (byId.get("get_cobble").requires.join(",") !== "craft_pickaxe") {
    throw new Error(`圆石前置不对：${byId.get("get_cobble").requires}`);
  }
  if (byId.get("dragon").requires.length !== 0) throw new Error("同级节点不该有前置");
  if (byId.get("dragon").kind !== "manual") throw new Error("没写类型应为 manual");

  ok("解析：缩进链正确变成前置依赖");
} catch (e) {
  fail("缩进链", e);
}

/* 2. 只写物品名 */
try {
  const r = O.parseOutline("- 砍点橡木 [oak_log]");
  if (!r.ok) throw new Error(r.errors.join("；"));
  const node = r.graph.nodes[0];
  if (node.kind !== "collect") throw new Error(`类型不对：${node.kind}`);
  if (node.recipe !== "oak_log") throw new Error(`产物不对：${node.recipe}`);

  ok("注解：只写物品名按采集处理");
} catch (e) {
  fail("物品名注解", e);
}

/* 3. 重复标题自动加序号 */
try {
  const r = O.parseOutline("- 取得原木 [collect oak_log]\n- 取得原木 [collect oak_log]");
  if (!r.ok) throw new Error(r.errors.join("；"));
  const ids = r.graph.nodes.map((n) => n.id);
  if (new Set(ids).size !== 2) throw new Error(`id 没区分：${ids.join(",")}`);

  ok("命名：重复标题自动加序号");
} catch (e) {
  fail("重复标题", e);
}

/* 4. 显式 id 重复被拒绝 */
try {
  const r = O.parseOutline("- 甲 [collect oak_log] @same\n- 乙 [collect oak_log] @same");
  if (r.ok) throw new Error("重复 id 不该通过");
  if (!r.errors.some((x) => x.includes("id 重复"))) {
    throw new Error(`错误信息不对：${r.errors.join("；")}`);
  }

  ok("校验：显式重复 id 被拒绝");
} catch (e) {
  fail("重复 id", e);
}

/* 5. checkpoint / priority */
try {
  const r = O.parseOutline("- 取得原木 [collect oak_log] {checkpoint=false, priority=88}");
  if (!r.ok) throw new Error(r.errors.join("；"));
  const node = r.graph.nodes[0];
  if (node.checkpoint !== false) throw new Error("checkpoint 没生效");
  if (node.priority !== 88) throw new Error(`priority 不对：${node.priority}`);

  ok("注解：checkpoint 与 priority 生效");
} catch (e) {
  fail("checkpoint/priority", e);
}

/* 6. 空输入 */
try {
  const r = O.parseOutline("   \n\n");
  if (r.ok) throw new Error("空输入不该通过");
  if (!r.errors.length) throw new Error("空输入没有报错");

  ok("校验：空大纲被拒绝");
} catch (e) {
  fail("空输入", e);
}

/* 7. collect 缺产物 */
try {
  const r = O.parseOutline("- 取得原木 [collect]");
  if (r.ok) throw new Error("缺产物不该通过");
  if (!r.errors.some((x) => x.includes("需要写清产物"))) {
    throw new Error(`错误信息不对：${r.errors.join("；")}`);
  }

  ok("校验：collect 缺产物被拒绝");
} catch (e) {
  fail("缺产物", e);
}

/* 8. 最终仍走 parseGraph */
try {
  const r = O.parseOutline("# 图\n- 甲 [collect oak_log]\n  - 乙 [craft stick]");
  if (!r.ok) throw new Error(r.errors.join("；"));

  const reparsed = G.parseGraph(r.graph);
  if (!reparsed.ok) throw new Error(`二次校验失败：${reparsed.errors.join("；")}`);
  if (!reparsed.graph.order.length) throw new Error("没有拓扑顺序");

  ok("校验：生成结果能通过 goal-graph 的完整校验");
} catch (e) {
  fail("二次校验", e);
}

/* 9. tab 缩进 */
try {
  const r = O.parseOutline("- 甲 [collect oak_log]\n\t- 乙 [craft stick]");
  if (!r.ok) throw new Error(r.errors.join("；"));
  const child = r.graph.nodes.find((n) => n.title === "乙");
  if (!child || child.requires.length !== 1) throw new Error("tab 缩进没识别成前置");

  ok("解析：tab 缩进同样有效");
} catch (e) {
  fail("tab 缩进", e);
}

/* 10. 统计 */
try {
  const r = O.parseOutline(
    "# 三层\n- 甲 [collect oak_log]\n  - 乙 [craft stick]\n    - 丙 [craft crafting_table]",
  );
  if (!r.ok) throw new Error(r.errors.join("；"));
  if (r.stats.nodes !== 3) throw new Error(`节点数不对：${r.stats.nodes}`);
  if (r.stats.depth !== 3) throw new Error(`层数不对：${r.stats.depth}`);

  ok("统计：节点数与层数正确");
} catch (e) {
  fail("统计", e);
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
