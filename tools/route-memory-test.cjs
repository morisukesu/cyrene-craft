"use strict";

/**
 * 路线记忆（RouteMemory）单元测试
 *
 * 覆盖：
 *   1. 初始为空
 *   2. 记住一次成功
 *   3. 样本不足不直出
 *   4. 跑够两次成功才命中
 *   5. 命中时把相对偏移映射到新目标
 *   6. 地形不相似不命中
 *   7. goal 不同不命中
 *   8. 连续失败两次删除路线
 *   9. 负记忆写入后命中
 *  10. 负记忆对别的 goal 不生效
 *  11. 负记忆过期
 *  12. 持久化后新实例能读回
 *  13. 容量上限淘汰
 *  14. 相对化 / 绝对化往返不丢信息
 *
 * 全部离线，只在临时目录里读写 routes.json。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const T = require("../src/terrain.cjs");
const { RouteMemory, relativizeSteps, absolutizeSteps } = require("../src/route-memory.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

function tempFile(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `route-${tag}-`));
  return { dir, file: path.join(dir, "routes.json") };
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function flat(n, h) {
  return Array.from({ length: n }, () => Array.from({ length: n }, () => h));
}

function plateau(n, h, delta, half = 1) {
  const g = flat(n, h);
  const c = Math.floor(n / 2);
  for (let dz = -half; dz <= half; dz++) {
    for (let dx = -half; dx <= half; dx++) g[c + dz][c + dx] = h + delta;
  }
  return g;
}

function make(file, config = {}) {
  return new RouteMemory({
    file,
    config: { saveDebounceMs: 0, minIntervalMs: 0, ...config },
    log: () => {},
  });
}

const keyA = T.fingerprint(flat(33, 10));
const keyB = T.fingerprint(plateau(33, 10, 6));

/* 1. 初始为空 */
try {
  const { dir, file } = tempFile("empty");
  const store = make(file);
  const snap = store.snapshot();
  if (snap.routes !== 0 || snap.blocked !== 0) throw new Error("新库不是空的");
  cleanup(dir);
  ok("初始为空：新库没有路线、没有负记忆");
} catch (e) {
  fail("初始为空", e);
}

/* 2. 记住一次成功 */
try {
  const { dir, file } = tempFile("remember");
  const store = make(file);
  const entry = store.remember({
    terrainKey: keyA,
    goal: "collect:oak_log",
    targetPos: { x: 10, y: 12, z: -11 },
    approach: { x: 11, y: 13, z: -11 },
    steps: [{ action: "move", args: { x: 11, y: 13, z: -11 } }],
    ok: true,
    ms: 4200,
  });
  if (!entry) throw new Error("没有写入条目");
  if (entry.runs !== 1 || entry.ok !== 1) throw new Error(`统计不对：${JSON.stringify(entry)}`);
  cleanup(dir);
  ok("记住成功：runs / ok 从 1 开始");
} catch (e) {
  fail("记住成功", e);
}

/* 3-5. 样本门槛与相对偏移映射 */
try {
  const { dir, file } = tempFile("recall");
  const store = make(file);

  const payload = {
    terrainKey: keyA,
    goal: "collect:oak_log",
    targetPos: { x: 10, y: 12, z: -11 },
    approach: { x: 11, y: 13, z: -11 },
    steps: [
      { action: "move", args: { x: 11, y: 13, z: -11 } },
      { action: "jump", args: {} },
    ],
    ok: true,
    ms: 4200,
  };

  store.remember(payload);
  if (store.recall({ terrainKey: keyA, goal: "collect:oak_log", targetPos: { x: 30, y: 16, z: -20 } })) {
    throw new Error("只跑过一次就直出了");
  }

  store.remember(payload);
  const hit = store.recall({
    terrainKey: keyA,
    goal: "collect:oak_log",
    targetPos: { x: 30, y: 16, z: -20 },
  });

  if (!hit) throw new Error("跑够两次仍然没有命中");
  if (!hit.approach) throw new Error("没有返回接近点");
  // 原偏移 (+1,+1,0)，新目标 (30,16,-20) → 接近点 (31,17,-20)
  if (hit.approach.x !== 31 || hit.approach.y !== 17 || hit.approach.z !== -20) {
    throw new Error(`接近点映射不对：${JSON.stringify(hit.approach)}`);
  }
  if (hit.steps[0].args.x !== 31 || hit.steps[0].args.y !== 17) {
    throw new Error(`步骤映射不对：${JSON.stringify(hit.steps[0])}`);
  }
  if (hit.steps[1].action !== "jump") throw new Error("无坐标步骤没有保留");

  cleanup(dir);
  ok("直出：两次成功后命中，相对偏移正确映射到新目标");
} catch (e) {
  fail("直出命中", e);
}

/* 6-7. 地形与 goal 门槛 */
try {
  const { dir, file } = tempFile("gate");
  const store = make(file);
  const payload = {
    terrainKey: keyA,
    goal: "collect:oak_log",
    targetPos: { x: 0, y: 10, z: 0 },
    approach: { x: 1, y: 11, z: 0 },
    steps: [{ action: "move", args: { x: 1, y: 11, z: 0 } }],
    ok: true,
  };
  store.remember(payload);
  store.remember(payload);

  if (store.recall({ terrainKey: keyB, goal: "collect:oak_log", targetPos: { x: 0, y: 10, z: 0 } })) {
    throw new Error("不相似的地形命中了");
  }
  if (store.recall({ terrainKey: keyA, goal: "collect:stone", targetPos: { x: 0, y: 10, z: 0 } })) {
    throw new Error("不同 goal 命中了");
  }

  cleanup(dir);
  ok("门槛：地形不相似或 goal 不同都不命中");
} catch (e) {
  fail("门槛", e);
}

/* 8. 连续失败删除 */
try {
  const { dir, file } = tempFile("fail");
  const store = make(file);
  const payload = {
    terrainKey: keyA,
    goal: "collect:oak_log",
    targetPos: { x: 0, y: 10, z: 0 },
    approach: { x: 1, y: 11, z: 0 },
    steps: [{ action: "move", args: { x: 1, y: 11, z: 0 } }],
    ok: true,
  };
  store.remember(payload);
  store.remember(payload);
  if (!store.recall({ terrainKey: keyA, goal: "collect:oak_log", targetPos: { x: 0, y: 10, z: 0 } })) {
    throw new Error("前置条件没建立：应该能命中");
  }

  // 换一个目标位置，避免命中间隔影响；失败两次
  const failPayload = { ...payload, ok: false };
  store.remember(failPayload);
  if (!store.snapshot().routes) throw new Error("一次失败就删了路线");
  store.remember(failPayload);
  if (store.snapshot().routes !== 0) throw new Error("连续两次失败后路线还在");

  cleanup(dir);
  ok("连续失败：两次失败后删除该路线");
} catch (e) {
  fail("连续失败", e);
}

/* 9-11. 负记忆 */
try {
  const { dir, file } = tempFile("blocked");
  const store = make(file);

  store.rememberBlocked({ terrainKey: keyA, goal: "collect:oak_log", ttlMs: 60_000 });
  if (!store.isBlocked({ terrainKey: keyA, goal: "collect:oak_log" })) {
    throw new Error("负记忆没有生效");
  }
  if (store.isBlocked({ terrainKey: keyA, goal: "collect:stone" })) {
    throw new Error("负记忆误伤了别的 goal");
  }
  if (store.isBlocked({ terrainKey: keyA, goal: "collect:oak_log", now: Date.now() + 120_000 })) {
    throw new Error("负记忆过期后仍然生效");
  }

  cleanup(dir);
  ok("负记忆：同地形同目标生效，别的 goal 不误伤，过期后失效");
} catch (e) {
  fail("负记忆", e);
}

/* 11b. 手动清负记忆：只清指定 goal */
try {
  const { dir, file } = tempFile("clear-blocked");
  const store = make(file);

  store.rememberBlocked({ terrainKey: keyA, goal: "collect:oak_log", ttlMs: 60_000 });
  store.rememberBlocked({ terrainKey: keyA, goal: "collect:stone", ttlMs: 60_000 });

  const removed = store.clearBlocked({ goal: "collect:oak_log" });
  if (removed !== 1) throw new Error(`清掉条数不对：${removed}`);
  if (store.isBlocked({ terrainKey: keyA, goal: "collect:oak_log" })) {
    throw new Error("目标负记忆还在");
  }
  if (!store.isBlocked({ terrainKey: keyA, goal: "collect:stone" })) {
    throw new Error("误清了别的 goal");
  }

  cleanup(dir);
  ok("手动清负记忆：只清指定 goal");
} catch (e) {
  fail("手动清负记忆", e);
}

/* 12. 持久化 */
try {
  const { dir, file } = tempFile("persist");
  const store = make(file);
  const payload = {
    terrainKey: keyA,
    goal: "collect:oak_log",
    targetPos: { x: 0, y: 10, z: 0 },
    approach: { x: 1, y: 11, z: 0 },
    steps: [{ action: "move", args: { x: 1, y: 11, z: 0 } }],
    ok: true,
  };
  store.remember(payload);
  store.remember(payload);
  store.flush();

  const again = make(file);
  const hit = again.recall({ terrainKey: keyA, goal: "collect:oak_log", targetPos: { x: 100, y: 64, z: 100 } });
  if (!hit) throw new Error("重启后读不到路线");
  if (hit.approach.x !== 101 || hit.approach.z !== 100) {
    throw new Error(`重启后映射不对：${JSON.stringify(hit.approach)}`);
  }

  cleanup(dir);
  ok("持久化：写盘后新实例能读回并正确映射");
} catch (e) {
  fail("持久化", e);
}

/* 13. 容量上限 */
try {
  const { dir, file } = tempFile("cap");
  const store = make(file, { maxEntries: 2 });

  for (const goal of ["collect:oak_log", "collect:stone", "collect:dirt"]) {
    const payload = {
      terrainKey: keyA,
      goal,
      targetPos: { x: 0, y: 10, z: 0 },
      approach: { x: 1, y: 11, z: 0 },
      steps: [{ action: "move", args: { x: 1, y: 11, z: 0 } }],
      ok: true,
    };
    store.remember(payload);
    store.remember(payload);
  }

  if (store.snapshot().routes > 2) {
    throw new Error(`没有按上限裁剪：${store.snapshot().routes}`);
  }

  cleanup(dir);
  ok("容量上限：超过 maxEntries 时按最近使用淘汰");
} catch (e) {
  fail("容量上限", e);
}

/* 14. 相对化 / 绝对化往返 */
try {
  const target = { x: 10, y: 20, z: -5 };
  const steps = [
    { action: "move", args: { x: 12, y: 21, z: -6 } },
    { action: "jump", args: {} },
    { action: "dig", args: { x: 10, y: 19, z: -5 } },
  ];

  const rel = relativizeSteps(steps, target);
  if (rel[0].args.dx !== 2 || rel[0].args.dy !== 1 || rel[0].args.dz !== -1) {
    throw new Error(`相对化不对：${JSON.stringify(rel[0])}`);
  }
  if ("x" in rel[0].args) throw new Error("相对化后仍带绝对坐标");

  const abs = absolutizeSteps(rel, { x: 100, y: 64, z: 100 });
  if (abs[0].args.x !== 102 || abs[0].args.y !== 65 || abs[0].args.z !== 99) {
    throw new Error(`绝对化不对：${JSON.stringify(abs[0])}`);
  }
  if (abs[1].action !== "jump" || "x" in abs[1].args) throw new Error("无坐标步骤被破坏");

  ok("步骤转换：相对化 / 绝对化往返不丢信息");
} catch (e) {
  fail("步骤转换", e);
}

/* 15. 混合步骤：move 转相对偏移，pillar / dig 原样保留 */
try {
  const { dir, file } = tempFile("mixed-steps");
  const store = make(file);
  const targetPos = { x: 10, y: 70, z: 10 };
  const payload = {
    terrainKey: keyA,
    goal: "collect:oak_log",
    targetPos,
    approach: { x: 9, y: 68, z: 10 },
    steps: [
      { action: "move", args: { x: 9, y: 64, z: 10 } },
      { action: "pillar", args: { height: 4 } },
      { action: "dig", args: { x: 10, y: 69, z: 10 } },
    ],
    ok: true,
    ms: 120,
  };

  store.remember(payload);
  store.remember(payload);

  const hit = store.recall({ terrainKey: keyA, goal: "collect:oak_log", targetPos });
  if (!hit) throw new Error("混合步骤没有命中原路线");

  const move = hit.steps.find((s) => s.action === "move");
  const pillar = hit.steps.find((s) => s.action === "pillar");
  const dig = hit.steps.find((s) => s.action === "dig");

  if (!move || move.args.x !== 9 || move.args.y !== 64 || move.args.z !== 10) {
    throw new Error(`move 没有还原成绝对坐标：${JSON.stringify(move)}`);
  }
  if (!pillar || pillar.args.height !== 4) throw new Error("pillar 的 height 丢了");
  if (!dig || dig.args.x !== 10 || dig.args.y !== 69 || dig.args.z !== 10) {
    throw new Error(`dig 没有还原成绝对坐标：${JSON.stringify(dig)}`);
  }

  cleanup(dir);
  ok("混合步骤：垫高与挖掘随路线一起复用");
} catch (e) {
  fail("混合步骤", e);
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
