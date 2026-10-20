"use strict";

/**
 * 肌肉记忆（Muscle）单元测试
 *
 * 覆盖：
 *   1. 世界指纹稳定性
 *   2. 坐标不进入指纹
 *   3. 物资分组与分档
 *   4. 样本不足不命中
 *   5. 成功率不足不命中
 *   6. 样本够且成功率高才命中
 *   7. TTL 过期回落
 *   8. 连续失败删除记忆
 *   9. 同一局面换动作重置统计
 *  10. 持久化与重新加载
 *  11. 条数上限与 LRU 淘汰
 *  12. 升级为技能记忆
 *  13. 统计数字
 *
 * 全部离线，不连服务器；只在临时目录里读写 muscle.json。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const M = require("../src/muscle.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

/** 每个测试用自己的临时文件，互不污染 */
function tempFile(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muscle-${tag}-`));
  return { dir, file: path.join(dir, "muscle.json") };
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清不掉不影响测试结论 */
  }
}

/** 一个典型的「在橡木林里、有斧子、吃饱」的世界 */
function world(extra = {}) {
  return {
    dimension: "overworld",
    isDay: true,
    health: 20,
    food: 18,
    inventory: { stone_axe: 1, oak_log: 4, bread: 3 },
    blocks: ["oak_log", "oak_leaves", "grass_block"],
    position: { x: 10, y: 64, z: -3 },
    ...extra,
  };
}

function make(file, config = {}) {
  return new M.Muscle({
    file,
    // 单元测试要能立刻重新命中，所以关掉最短间隔；生产默认是 3 秒
    config: { saveDebounceMs: 0, minIntervalMs: 0, ...config },
    log: () => {},
  });
}

/* 1. 指纹稳定 */
try {
  const a = M.fingerprint(world(), "collect:block=oak_log");
  const b = M.fingerprint(world(), "collect:block=oak_log");
  if (a !== b) throw new Error(`同一世界生成了不同指纹：\n${a}\n${b}`);
  ok("指纹稳定：同一世界重复生成结果一致");
} catch (e) {
  fail("指纹稳定", e);
}

/* 2. 坐标不进入指纹 */
try {
  const a = M.fingerprint(world({ position: { x: 0, y: 64, z: 0 } }), "collect");
  const b = M.fingerprint(world({ position: { x: 999, y: 12, z: -500 } }), "collect");
  if (a !== b) throw new Error("坐标变化影响了指纹，缓存会活不过一步");
  ok("坐标不进入指纹：走多远都是同一个局面");
} catch (e) {
  fail("坐标不进入指纹", e);
}

/* 3. 物资分组 */
try {
  const counts = M.groupInventory({ oak_log: 3, birch_log: 2, stone_axe: 1, bread: 4 });
  if (counts.log !== 5) throw new Error(`原木分组不对：${counts.log}`);
  if (counts.axe !== 1) throw new Error(`斧子分组不对：${counts.axe}`);
  if (counts.food !== 4) throw new Error(`食物分组不对：${counts.food}`);

  const bits = M.inventoryBits({ oak_log: 3 });
  if (!bits.includes("log1")) throw new Error(`分档不对：${bits}`);
  ok("物资分组：不同木头归为一类，数量按档位压缩");
} catch (e) {
  fail("物资分组", e);
}

/* 4. 样本不足不命中 */
try {
  const { dir, file } = tempFile("young");
  const m = make(file);
  m.remember({ world: world(), current: "c", tool: "collect", args: { block: "oak_log" }, ok: true });
  m.remember({ world: world(), current: "c", tool: "collect", args: { block: "oak_log" }, ok: true });
  const hit = m.recall({ world: world(), current: "c" });
  if (hit) throw new Error(`只跑了 2 次就直出：${JSON.stringify(hit)}`);
  cleanup(dir);
  ok("样本不足：跑不够 3 次不直出");
} catch (e) {
  fail("样本不足", e);
}

/* 5. 成功率不足不命中 */
try {
  const { dir, file } = tempFile("rate");
  const m = make(file);
  for (const flags of [true, false, false]) {
    m.remember({ world: world(), current: "c", tool: "collect", args: { block: "oak_log" }, ok: flags });
  }
  const hit = m.recall({ world: world(), current: "c" });
  if (hit) throw new Error(`成功率 33% 也直出了：${JSON.stringify(hit)}`);
  cleanup(dir);
  ok("成功率不足：三次里错两次不直出");
} catch (e) {
  fail("成功率不足", e);
}

/* 6. 样本够且成功率高才命中 */
try {
  const { dir, file } = tempFile("ready");
  const m = make(file);
  for (let i = 0; i < 3; i++) {
    m.remember({ world: world(), current: "c", tool: "collect", args: { block: "oak_log" }, ok: true, ms: 100 });
  }
  const hit = m.recall({ world: world(), current: "c" });
  if (!hit) throw new Error("三次全成功仍未命中");
  if (hit.tool !== "collect") throw new Error(`工具不对：${hit.tool}`);
  if (hit.args.block !== "oak_log") throw new Error(`参数不对：${JSON.stringify(hit.args)}`);
  if (hit.rate !== 1) throw new Error(`成功率应为 1：${hit.rate}`);
  cleanup(dir);
  ok("直出：三次全成功之后命中，参数原样带回");
} catch (e) {
  fail("直出命中", e);
}

/* 7. TTL 过期 */
try {
  const { dir, file } = tempFile("ttl");
  const m = make(file, { ttlMs: 1000 });
  for (let i = 0; i < 3; i++) {
    m.remember({ world: world(), current: "c", tool: "collect", args: { block: "oak_log" }, ok: true });
  }
  const key = M.fingerprint(world(), "c");
  m.entries.get(key).lastAt = Date.now() - 5000;

  const hit = m.recall({ world: world(), current: "c" });
  if (hit) throw new Error("过期记忆仍然命中");
  if (m.entries.has(key)) throw new Error("过期条目没有清掉");
  cleanup(dir);
  ok("TTL 过期：旧记忆自动清掉，回落图计算");
} catch (e) {
  fail("TTL 过期", e);
}

/* 8. 连续失败删除记忆 */
try {
  const { dir, file } = tempFile("fail");
  const m = make(file);
  for (let i = 0; i < 3; i++) {
    m.remember({ world: world(), current: "c", tool: "collect", args: { block: "oak_log" }, ok: true });
  }
  const key = M.fingerprint(world(), "c");

  // 一次失败只是把成功率拉到 3/4，低于直出门槛，但条目还在。
  // 这里查条目本身，不查 recall —— 两件事：记忆存在 ≠ 现在还允许直出。
  m.remember({ world: world(), current: "c", tool: "collect", args: { block: "oak_log" }, ok: false });
  if (!m.entries.has(key)) throw new Error("一次失败就删了记忆，太急");
  if (m.recall({ world: world(), current: "c" })) throw new Error("成功率 75% 仍然直出");

  m.remember({ world: world(), current: "c", tool: "collect", args: { block: "oak_log" }, ok: false });
  if (m.entries.has(key)) throw new Error("连续两次失败后记忆还在");
  cleanup(dir);
  ok("连续失败：两次失败后删除该条记忆");
} catch (e) {
  fail("连续失败", e);
}

/* 9. 同一局面换动作重置统计 */
try {
  const { dir, file } = tempFile("switch");
  const m = make(file);
  for (let i = 0; i < 3; i++) {
    m.remember({ world: world(), current: "c", tool: "collect", args: { block: "oak_log" }, ok: true });
  }
  m.remember({ world: world(), current: "c", tool: "move", args: { player: "mori" }, ok: true });

  const hit = m.recall({ world: world(), current: "c" });
  if (hit) throw new Error("换动作后仍按旧统计直出");
  cleanup(dir);
  ok("换动作：同一局面换了动作，统计从头开始");
} catch (e) {
  fail("换动作重置", e);
}

/* 10. 持久化与重新加载 */
try {
  const { dir, file } = tempFile("persist");
  const m = make(file);
  for (let i = 0; i < 3; i++) {
    m.remember({ world: world(), current: "c", tool: "collect", args: { block: "oak_log" }, ok: true });
  }
  m.flush();

  const again = make(file);
  const hit = again.recall({ world: world(), current: "c" });
  if (!hit) throw new Error("重启后读不到记忆");
  if (hit.tool !== "collect") throw new Error(`重启后记忆错位：${hit.tool}`);
  cleanup(dir);
  ok("持久化：写盘后新实例能读回");
} catch (e) {
  fail("持久化", e);
}

/* 11. 条数上限与 LRU 淘汰 */
try {
  const { dir, file } = tempFile("lru");
  const m = make(file, { maxEntries: 2 });

  // 三条不同记忆，靠 current 区分。
  // 每写一条就把 lastAt 往前推，制造明确的先后顺序；
  // 条目可能已经被上一轮 trim 掉，所以取到再改。
  for (const [node, order] of [["a", 1], ["b", 2], ["c", 3]]) {
    for (let i = 0; i < 3; i++) {
      m.remember({ world: world(), current: node, tool: "collect", args: { block: node }, ok: true });
      const entry = m.entries.get(M.fingerprint(world(), node));
      if (entry) entry.lastAt = Date.now() + order;
    }
  }

  if (m.entries.size > 2) throw new Error(`没有按上限裁剪：${m.entries.size}`);
  const hasA = m.entries.has(M.fingerprint(world(), "a"));
  if (hasA) throw new Error("最旧的条目没有被淘汰");
  cleanup(dir);
  ok("上限淘汰：超过 maxEntries 时丢弃最久未用的一条");
} catch (e) {
  fail("上限淘汰", e);
}

/* 12. 升级为技能记忆 */
try {
  const { dir, file } = tempFile("promote");
  const m = make(file);
  for (let i = 0; i < 3; i++) {
    m.remember({ world: world(), current: "c", tool: "collect", args: { block: "oak_log" }, ok: true });
  }
  const key = M.fingerprint(world(), "c");
  if (!m.promote(key, "auto_chop_oak")) throw new Error("升级失败");

  const hit = m.recall({ world: world(), current: "c" });
  if (!hit || hit.kind !== "skill") throw new Error(`没有升级成技能：${JSON.stringify(hit)}`);
  if (hit.name !== "auto_chop_oak") throw new Error(`技能名不对：${hit.name}`);
  cleanup(dir);
  ok("技能升级：动作记忆可以升级成整段技能记忆");
} catch (e) {
  fail("技能升级", e);
}

/* 13. 统计数字 */
try {
  const { dir, file } = tempFile("stats");
  const m = make(file);
  for (let i = 0; i < 3; i++) {
    m.remember({ world: world(), current: "c", tool: "collect", args: { block: "oak_log" }, ok: true });
  }
  m.recall({ world: world(), current: "c" });
  m.recall({ world: world(), current: "other" });

  const snap = m.snapshot();
  if (snap.stats.learn !== 3) throw new Error(`learn 应为 3：${snap.stats.learn}`);
  if (snap.stats.recall !== 2) throw new Error(`recall 应为 2：${snap.stats.recall}`);
  if (snap.stats.hit !== 1) throw new Error(`hit 应为 1：${snap.stats.hit}`);
  cleanup(dir);
  ok("统计：learn / recall / hit 计数正确");
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
