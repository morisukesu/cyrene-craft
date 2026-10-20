"use strict";

/**
 * 路线流派（tradition 扩展）单元测试
 *
 * 覆盖：
 *   1. 步骤签名：pillar / jump / move / dig 各自稳定
 *   2. 两条路线提纯出公共段
 *   3. 只有一条路线时不构成流派
 *   4. 不同 goal 分组互不污染
 *   5. 模板的相对偏移能映射到新目标
 *   6. rankRoutes 按成功率排序
 *   7. rankRoutes 步骤多的排在后面
 *   8. 空路线库返回空数组
 *
 * 全部离线。
 */

const T = require("../src/tradition.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

function route(over) {
  return {
    id: over.id || "r1",
    goal: over.goal || "collect:oak_log",
    terrainKey: over.terrainKey || "v1:9:000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    steps: over.steps || [],
    runs: over.runs == null ? 3 : over.runs,
    ok: over.ok == null ? 3 : over.ok,
    lastAt: over.lastAt || Date.now(),
  };
}

/* 1. 步骤签名 */
try {
  if (T.routeStepSignature({ action: "move", args: { dx: 1 } }) !== "move") {
    throw new Error("move 签名不对");
  }
  if (T.routeStepSignature({ action: "pillar", args: { height: 3 } }) !== "pillar:3") {
    throw new Error("pillar 签名不对");
  }
  if (T.routeStepSignature({ action: "jump" }) !== "jump") throw new Error("jump 签名不对");
  if (T.routeStepSignature({ action: "dig", args: { x: 1 } }) !== "dig") {
    throw new Error("dig 签名不对");
  }
  ok("步骤签名：move / pillar / jump / dig 各自稳定");
} catch (e) {
  fail("步骤签名", e);
}

/* 2-4. 模板提取 */
try {
  const routes = [
    route({
      id: "r1",
      runs: 4,
      ok: 4,
      steps: [
        { action: "move", args: { dx: 1, dy: 1, dz: 0 } },
        { action: "pillar", args: { height: 2 } },
      ],
    }),
    route({
      id: "r2",
      runs: 2,
      ok: 1,
      steps: [
        { action: "move", args: { dx: 0, dy: 1, dz: 1 } },
        { action: "pillar", args: { height: 2 } },
        { action: "jump", args: {} },
      ],
    }),
  ];

  const templates = T.extractRouteTemplates(routes);
  if (templates.length !== 1) throw new Error(`模板数量不对：${templates.length}`);
  const tpl = templates[0];
  if (tpl.goal !== "collect:oak_log") throw new Error("goal 不对");
  if (tpl.support !== 2) throw new Error(`support 不对：${tpl.support}`);
  if (!tpl.signatures.includes("move") || !tpl.signatures.includes("pillar:2")) {
    throw new Error(`公共段不对：${JSON.stringify(tpl.signatures)}`);
  }
  if (tpl.signatures.includes("jump")) throw new Error("jump 只出现在一条路线里，不该进模板");

  // 只有一条路线不构成流派
  if (T.extractRouteTemplates([routes[0]]).length !== 0) {
    throw new Error("单条路线不该构成模板");
  }

  // 不同 goal 分组
  const mixed = T.extractRouteTemplates([
    ...routes,
    route({ id: "r3", goal: "collect:stone", steps: [{ action: "move" }] }),
    route({ id: "r4", goal: "collect:stone", steps: [{ action: "move" }] }),
  ]);
  if (mixed.length !== 2) throw new Error(`分组数量不对：${mixed.length}`);

  ok("模板提取：两条路线提纯公共段，单条不构成流派，goal 分组互不污染");
} catch (e) {
  fail("模板提取", e);
}

/* 5. 模板映射 */
try {
  const tpl = {
    steps: [
      { action: "pillar", args: { height: 2 } },
      { action: "move", args: { dx: 1, dy: 1, dz: 0 } },
    ],
  };
  const abs = T.applyRouteTemplate(tpl, { x: 10, y: 64, z: -5 });
  if (abs[1].args.x !== 11 || abs[1].args.y !== 65 || abs[1].args.z !== -5) {
    throw new Error(`映射不对：${JSON.stringify(abs[1])}`);
  }
  if (abs[0].action !== "pillar" || "x" in abs[0].args) {
    throw new Error("无坐标步骤被破坏");
  }
  ok("模板映射：相对偏移正确映射到新目标");
} catch (e) {
  fail("模板映射", e);
}

/* 6-8. 排序与空库 */
try {
  const routes = [
    route({ id: "slow", runs: 4, ok: 1, steps: [{ action: "move" }] }),
    route({ id: "fast", runs: 4, ok: 4, steps: [{ action: "move" }] }),
    route({
      id: "long",
      runs: 4,
      ok: 4,
      steps: [{ action: "move" }, { action: "pillar" }, { action: "jump" }, { action: "dig" }],
    }),
  ];

  const ranked = T.rankRoutes(routes);
  if (ranked[0].id !== "fast") throw new Error(`第一名不对：${ranked[0].id}`);
  if (ranked.findIndex((r) => r.id === "slow") !== ranked.length - 1) {
    throw new Error("低成功率的没有排在最后");
  }
  const fastIndex = ranked.findIndex((r) => r.id === "fast");
  const longIndex = ranked.findIndex((r) => r.id === "long");
  if (fastIndex > longIndex) throw new Error("步骤多的没有排在后面");

  if (T.rankRoutes([]).length !== 0) throw new Error("空库应返回空数组");

  ok("路线排序：成功率高在前，步骤多在后，空库安全");
} catch (e) {
  fail("路线排序", e);
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
