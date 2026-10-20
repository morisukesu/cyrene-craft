"use strict";

/**
 * 地形感知（Terrain）单元测试
 *
 * 覆盖：
 *   1. 空矩阵返回空指纹
 *   2. 平面指纹稳定
 *   3. 整体抬高不改变指纹（相对高度）
 *   4. 不同地形指纹不同
 *   5. 完全相同相似度 1
 *   6. 整体平移相似度 1
 *   7. 局部差 1 格仍高分
 *   8. 差 3 格明显掉分
 *   9. 非法格式相似度 0
 *  10. 高度查询越界返回 null
 *  11. 高度查询取值正确
 *  12. 可站立面包含顶面
 *  13. 可站立面包含水平面
 *  14. 高差超出 reach 的水平面被排除
 *  15. 可站立面按距离排序
 *  16. 挡路列能被识别
 *  17. 平坦路径没有挡路列
 *  18. 平地规划给出 walk 策略
 *  19. 差 2 格给出 jump 策略
 *  20. 差 3 格给出 pillar 策略
 *  21. 没有可站立面时规划失败
 *  22. 规划结果带地形指纹
 *
 * 全部离线：纯高度矩阵，不连服务器、不碰文件。
 */

const T = require("../src/terrain.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

/** 造一块平地 */
function flat(n, h) {
  return Array.from({ length: n }, () => Array.from({ length: n }, () => h));
}

/** 在平地上抬出一块方形台地 */
function withPlateau(n, h, delta, half = 1) {
  const g = flat(n, h);
  const c = Math.floor(n / 2);
  for (let dz = -half; dz <= half; dz++) {
    for (let dx = -half; dx <= half; dx++) {
      g[c + dz][c + dx] = h + delta;
    }
  }
  return g;
}

/** 在平地上挖一个坑 */
function withPit(n, h, depth) {
  const g = flat(n, h);
  const c = Math.floor(n / 2);
  g[c][c] = h - depth;
  return g;
}

/** 把地形包成 terrain 对象（origin 在中心） */
function makeTerrain(heights) {
  const radius = Math.floor(heights.length / 2);
  return { heights, radius, origin: { x: 0, z: 0 } };
}

/* 1. 空矩阵 */
try {
  if (T.fingerprint([]) !== "") throw new Error("空矩阵应返回空串");
  if (T.fingerprint(null) !== "") throw new Error("null 应返回空串");
  ok("空矩阵：返回空指纹");
} catch (e) {
  fail("空矩阵", e);
}

/* 2. 平面指纹稳定 */
try {
  const a = T.fingerprint(flat(33, 64));
  const b = T.fingerprint(flat(33, 64));
  if (!a || a !== b) throw new Error(`平面指纹不稳定：${a} vs ${b}`);
  if (!a.startsWith("v1:9:")) throw new Error(`格式不对：${a}`);
  ok("平面指纹：格式正确且重复生成一致");
} catch (e) {
  fail("平面指纹", e);
}

/* 3. 整体抬高 */
try {
  const a = T.fingerprint(flat(33, 64));
  const b = T.fingerprint(flat(33, 100));
  if (a !== b) throw new Error("整体抬高改变了指纹，相对高度失效");
  ok("整体抬高：同一地形换个海拔仍是同一个指纹");
} catch (e) {
  fail("整体抬高", e);
}

/* 4. 不同地形 */
try {
  const a = T.fingerprint(flat(33, 64));
  const b = T.fingerprint(withPlateau(33, 64, 6));
  // 单格坑会被降采样的中位数滤掉，这是刻意的：一个坑不该改变整片地形的身份。
  // 要造出「另一种地形」，得让坑有足够大（5×5）。
  const c = T.fingerprint(withPlateau(33, 64, -5, 2));
  if (a === b) throw new Error("平地与台地指纹相同");
  if (a === c) throw new Error("平地与大坑指纹相同");
  ok("不同地形：平地 / 台地 / 大坑生成不同指纹");
} catch (e) {
  fail("不同地形", e);
}

/* 5-8. 相似度 */
try {
  const a = T.fingerprint(flat(33, 64));
  if (T.similarity(a, a) !== 1) throw new Error("自身相似度不是 1");

  const shifted = T.fingerprint(flat(33, 90));
  if (T.similarity(a, shifted) !== 1) throw new Error("整体平移后相似度不是 1");

  // 台地只影响中心几格，其余 8×8 格仍然一致
  const plateau = T.fingerprint(withPlateau(33, 64, 1, 1));
  const s1 = T.similarity(a, plateau);
  if (s1 <= 0.7) throw new Error(`差 1 格的地形相似度过低：${s1}`);

  const cliff = T.fingerprint(withPlateau(33, 64, 3, 1));
  const s2 = T.similarity(a, cliff);
  if (s2 >= s1) throw new Error(`差 3 格的地形不应该比差 1 格更像：${s2} vs ${s1}`);
  if (s2 > 0.85) throw new Error(`差 3 格的地形相似度仍然过高：${s2}`);

  ok("相似度：自身 1、整体平移 1、差 1 格高分、差 3 格明显掉分");
} catch (e) {
  fail("相似度", e);
}

/* 9. 非法格式 */
try {
  if (T.similarity("", "v1:9:000") !== 0) throw new Error("空串相似度不为 0");
  if (T.similarity("garbage", "v1:9:000") !== 0) throw new Error("非法格式相似度不为 0");
  if (T.similarity("v1:9:000", "v1:15:000") !== 0) throw new Error("不同格数不应比较");
  ok("非法格式：不认识或格数不同时相似度为 0");
} catch (e) {
  fail("非法格式", e);
}

/* 10-11. heightAt */
try {
  const terrain = makeTerrain(flat(33, 64));
  if (T.heightAt(terrain, 0, 0) !== 64) throw new Error("中心高度不对");
  if (T.heightAt(terrain, 100, 100) !== null) throw new Error("越界应返回 null");
  if (T.heightAt(terrain, 0, 100) !== null) throw new Error("z 越界应返回 null");
  ok("高度查询：中心取值正确，越界返回 null");
} catch (e) {
  fail("高度查询", e);
}

/* 12-15. standPoints */
try {
  const terrain = makeTerrain(flat(33, 10));
  const target = { x: 0, y: 10, z: 0 };
  const points = T.standPoints(target, terrain, { reach: 3 });

  if (!points.length) throw new Error("没有找到任何可站立面");
  if (!points.some((p) => p.face === "top" && p.y === 11)) {
    throw new Error(`缺少顶面站立点：${JSON.stringify(points)}`);
  }
  if (!points.some((p) => p.face === "east" && p.y === 11)) {
    throw new Error(`缺少水平站立点：${JSON.stringify(points)}`);
  }

  // 排序：顶面距离 1，水平面距离 sqrt(2)，顶面应该在最前
  if (points[0].face !== "top") throw new Error(`排序不对：${JSON.stringify(points)}`);

  // 目标高 5 格、周围地表 10：水平面 y=11 与目标差 6 > reach 3，应被排除
  const highTarget = { x: 0, y: 15, z: 0 };
  const highPoints = T.standPoints(highTarget, terrain, { reach: 3 });
  if (highPoints.some((p) => p.face === "east")) {
    throw new Error("高差超出 reach 的水平面没有被排除");
  }

  ok("可站立面：顶面 + 水平面，按距离排序，超大高差被排除");
} catch (e) {
  fail("可站立面", e);
}

/* 16-17. obstacles */
try {
  const n = 33;
  const h = 10;
  const heights = flat(n, h);
  const c = Math.floor(n / 2);

  // 在 from(0,10,-5) → target(0,10,5) 的直线上放一堵高墙
  heights[c + 3][c] = h + 4;

  const terrain = makeTerrain(heights);
  const blocks = T.obstacles(terrain, { x: 0, y: 10, z: -5 }, { x: 0, y: 10, z: 5 });
  if (!blocks.length) throw new Error("高墙没有被识别为挡路列");
  if (!blocks.some((b) => Math.abs(b.x - 0) <= 1 && Math.abs(b.z - 3) <= 1)) {
    throw new Error(`挡路列位置不对：${JSON.stringify(blocks)}`);
  }

  const flatBlocks = T.obstacles(makeTerrain(flat(n, h)), { x: 0, y: 10, z: -5 }, { x: 0, y: 10, z: 5 });
  if (flatBlocks.length) throw new Error(`平地不该有挡路列：${JSON.stringify(flatBlocks)}`);

  ok("挡路分析：高墙被识别，平地没有挡路列");
} catch (e) {
  fail("挡路分析", e);
}

/* 18-22. planRoute */
try {
  // 平地：from 和 nearest 都在 y=10/11，差 1，只该有 walk
  const flatTerrain = makeTerrain(flat(33, 10));
  const walk = T.planRoute({ x: 0, y: 10, z: -4 }, { x: 0, y: 10, z: 0 }, flatTerrain);
  if (!walk.ok) throw new Error(`平地规划失败：${walk.reason}`);
  if (!walk.strategies.some((s) => s.kind === "walk")) throw new Error("缺少 walk 策略");
  if (!walk.terrainKey) throw new Error("没有返回地形指纹");

  // 目标在半空 2 格：nearest.y=12，from.y=10 → dy=2，应有 jump
  const jump = T.planRoute({ x: 0, y: 10, z: -4 }, { x: 0, y: 11, z: 0 }, flatTerrain);
  if (!jump.strategies.some((s) => s.kind === "jump")) {
    throw new Error(`缺少 jump 策略：${JSON.stringify(jump.strategies.map((s) => s.kind))}`);
  }

  // 目标在半空 3 格：dy=3，背包有泥土时应有 pillar
  const pillar = T.planRoute(
    { x: 0, y: 10, z: -4 },
    { x: 0, y: 12, z: 0 },
    flatTerrain,
    { inventory: [{ name: "dirt", count: 8 }] },
  );
  if (!pillar.strategies.some((s) => s.kind === "pillar")) {
    throw new Error(`缺少 pillar 策略：${JSON.stringify(pillar.strategies.map((s) => s.kind))}`);
  }

  // 没有可站立面：把 target 放到高度矩阵之外
  const empty = T.planRoute({ x: 0, y: 10, z: 0 }, { x: 500, y: 10, z: 500 }, flatTerrain);
  if (empty.ok) throw new Error("越界目标不该规划成功");
  if (!empty.reason) throw new Error("失败时没有原因");

  ok("路线规划：walk / jump / pillar 三种策略，越界目标明确失败");
} catch (e) {
  fail("路线规划", e);
}

/* 23. 手段注册表：内置手段全部注册 */
try {
  const ids = T.listAffordances();
  for (const id of ["walk", "jump", "pillar", "scaffold", "bridge", "dig", "tunnel"]) {
    if (!ids.includes(id)) throw new Error(`注册表缺少 ${id}：${ids.join(", ")}`);
  }
  ok("手段注册表：内置手段全部注册");
} catch (e) {
  fail("手段注册表", e);
}

/* 24. 资源取舍：有更便宜的泥土时，脚手架排在后面 */
try {
  const terrain = makeTerrain(flat(33, 10));
  const plan = T.planRoute(
    { x: 0, y: 10, z: -4 },
    { x: 0, y: 12, z: 0 },
    terrain,
    {
      inventory: [
        { name: "scaffolding", count: 8 },
        { name: "dirt", count: 8 },
      ],
    },
  );

  const scaffold = plan.strategies.find((s) => s.kind === "scaffold");
  const pillar = plan.strategies.find((s) => s.kind === "pillar");

  if (!scaffold) throw new Error(`没有 scaffold：${plan.strategies.map((s) => s.kind).join(", ")}`);
  if (!pillar) throw new Error("没有 pillar");
  if (pillar.cost >= scaffold.cost) {
    throw new Error(`泥土没有排在脚手架之前：${pillar.cost} / ${scaffold.cost}`);
  }

  const pillarStep = pillar.steps.find((s) => s.action === "pillar");
  if (!pillarStep || pillarStep.args.item !== "dirt") {
    throw new Error(`垫方块没有用泥土：${JSON.stringify(pillarStep)}`);
  }

  const scaffoldStep = scaffold.steps.find((s) => s.action === "pillar");
  if (!scaffoldStep || scaffoldStep.args.item !== "scaffolding") {
    throw new Error("脚手架步骤没带 item");
  }

  ok("资源取舍：泥土优先，脚手架排在后面");
} catch (e) {
  fail("资源取舍", e);
}

/* 25. 隧道：朝目标方向挖开高列 */
try {
  const n = 33;
  const h = 10;
  const heights = flat(n, h);
  const c = Math.floor(n / 2);
  heights[c - 4][c] = h + 3;
  heights[c - 3][c] = h + 3;

  const terrain = makeTerrain(heights);
  const plan = T.planRoute({ x: 0, y: 10, z: -6 }, { x: 0, y: 10, z: 0 }, terrain);

  const tunnel = plan.strategies.find((s) => s.kind === "tunnel");
  if (!tunnel) throw new Error(`没有 tunnel：${plan.strategies.map((s) => s.kind).join(", ")}`);

  const digs = tunnel.steps.filter((s) => s.action === "dig");
  if (digs.length < 2) throw new Error(`隧道没有挖开高列：${JSON.stringify(tunnel.steps)}`);

  ok("隧道：朝目标方向挖开高列");
} catch (e) {
  fail("隧道", e);
}

/* 26. 代价排序：策略按 cost 从低到高 */
try {
  const terrain = makeTerrain(flat(33, 10));
  const plan = T.planRoute({ x: 0, y: 10, z: -4 }, { x: 0, y: 12, z: 0 }, terrain, {
    inventory: [{ name: "scaffolding", count: 8 }],
  });

  for (let i = 1; i < plan.strategies.length; i += 1) {
    if (plan.strategies[i].cost < plan.strategies[i - 1].cost) {
      throw new Error(
        `cost 没有升序：${plan.strategies.map((s) => `${s.kind}:${s.cost}`).join(" → ")}`,
      );
    }
  }

  ok("代价排序：策略按 cost 从低到高");
} catch (e) {
  fail("代价排序", e);
}

/* 27. 消耗品选择：目标资源不进消耗 */
try {
  const terrain = makeTerrain(flat(33, 10));

  const plan = T.planRoute(
    { x: 0, y: 10, z: -4 },
    { x: 0, y: 12, z: 0 },
    terrain,
    {
      inventory: [
        { name: "oak_log", count: 61 },
        { name: "dirt", count: 8 },
      ],
      targetBlock: "oak_log",
    },
  );

  const pillar = plan.strategies.find((s) => s.kind === "pillar");
  if (!pillar) throw new Error("没有 pillar");
  const step = pillar.steps.find((s) => s.action === "pillar");
  if (!step || step.args.item !== "dirt") {
    throw new Error(`垫高没有避开目标原木：${JSON.stringify(step)}`);
  }

  const onlyTarget = T.planRoute(
    { x: 0, y: 10, z: -4 },
    { x: 0, y: 12, z: 0 },
    terrain,
    {
      inventory: [{ name: "oak_log", count: 61 }],
      targetBlock: "oak_log",
    },
  );
  if (onlyTarget.strategies.some((s) => s.kind === "pillar")) {
    throw new Error("只剩目标原木时还生成了垫高");
  }

  ok("消耗品选择：目标原木不拿来垫高");
} catch (e) {
  fail("消耗品选择", e);
}

/* 28. 经验偏置：成功率高的手段代价更低 */
try {
  const terrain = makeTerrain(flat(33, 10));
  const base = T.planRoute(
    { x: 0, y: 10, z: -4 },
    { x: 0, y: 12, z: 0 },
    terrain,
    { inventory: [{ name: "dirt", count: 8 }] },
  );
  const biased = T.planRoute(
    { x: 0, y: 10, z: -4 },
    { x: 0, y: 12, z: 0 },
    terrain,
    { inventory: [{ name: "dirt", count: 8 }], bias: { pillar: 1 } },
  );

  const a = base.strategies.find((s) => s.kind === "pillar");
  const b = biased.strategies.find((s) => s.kind === "pillar");
  if (!a || !b) throw new Error("缺少 pillar");
  if (!(b.cost < a.cost)) throw new Error(`经验偏置没有降低成本：${a.cost} → ${b.cost}`);

  ok("经验偏置：成功率高的手段代价更低");
} catch (e) {
  fail("经验偏置", e);
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
