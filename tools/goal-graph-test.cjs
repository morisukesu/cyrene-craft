"use strict";

/**
 * 目标图（Goal Graph + Store）单元测试
 *
 * 覆盖：
 *   1. 解析有效图
 *   2. 拒绝重复 id
 *   3. 拒绝不存在的依赖
 *   4. 拒绝成环
 *   5. 就绪节点：只放出无依赖的
 *   6. 完成一个节点后解锁下游
 *   7. 优先级排序
 *   8. 进度统计
 *   9. formatGraph 输出
 *  10. 导入写盘 + 重新读回
 *  11. 进度写盘 + 重新读回
 *  12. 坏文件不影响其它图
 *  13. 内置示例图可解析
 *
 * 全部离线：图解析是纯函数，存储走临时目录。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const G = require("../src/goal-graph.cjs");
const S = require("../src/goal-store.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `goal-graph-${tag}-`));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 一张三条节点的链：a → b → c */
function chain() {
  return {
    kind: G.KIND,
    name: "测试链",
    nodes: [
      { id: "a", title: "第一件事", priority: 30, recipe: "oak_log", kind: "collect" },
      { id: "b", title: "第二件事", priority: 20, requires: ["a"], recipe: "stick" },
      { id: "c", title: "第三件事", priority: 10, requires: ["b"], recipe: "torch" },
    ],
  };
}

/* 1. 解析有效图 */
try {
  const parsed = G.parseGraph(chain());
  if (!parsed.ok) throw new Error(parsed.errors.join("；"));
  if (parsed.graph.nodes.length !== 3) throw new Error("节点数不对");
  if (parsed.graph.order.join(",") !== "a,b,c") {
    throw new Error(`拓扑顺序不对：${parsed.graph.order.join(",")}`);
  }

  ok("解析：有效图通过，拓扑顺序正确");
} catch (e) {
  fail("解析有效图", e);
}

/* 2. 重复 id */
try {
  const parsed = G.parseGraph({
    kind: G.KIND,
    name: "重复",
    nodes: [
      { id: "a", recipe: "oak_log" },
      { id: "a", recipe: "stick" },
    ],
  });

  if (parsed.ok) throw new Error("重复 id 不该通过");
  if (!parsed.errors.some((x) => x.includes("重复"))) {
    throw new Error(`错误信息不对：${parsed.errors.join("；")}`);
  }

  ok("校验：重复 id 被拒绝");
} catch (e) {
  fail("重复 id", e);
}

/* 3. 不存在的依赖 */
try {
  const parsed = G.parseGraph({
    kind: G.KIND,
    name: "悬空依赖",
    nodes: [{ id: "a", requires: ["nope"], recipe: "oak_log" }],
  });

  if (parsed.ok) throw new Error("悬空依赖不该通过");
  if (!parsed.errors.some((x) => x.includes("nope"))) {
    throw new Error(`错误信息没指出问题依赖：${parsed.errors.join("；")}`);
  }

  ok("校验：依赖不存在的节点被拒绝");
} catch (e) {
  fail("悬空依赖", e);
}

/* 4. 成环 */
try {
  const parsed = G.parseGraph({
    kind: G.KIND,
    name: "环",
    nodes: [
      { id: "a", requires: ["b"], recipe: "oak_log" },
      { id: "b", requires: ["a"], recipe: "stick" },
    ],
  });

  if (parsed.ok) throw new Error("成环不该通过");
  if (!parsed.errors.some((x) => x.includes("成环"))) {
    throw new Error(`没有指出环：${parsed.errors.join("；")}`);
  }

  ok("校验：依赖成环被拒绝");
} catch (e) {
  fail("成环", e);
}

/* 5. 就绪节点 */
try {
  const parsed = G.parseGraph(chain());
  const ready = G.readyNodes(parsed.graph, new Set());

  if (ready.length !== 1 || ready[0].id !== "a") {
    throw new Error(`初始就绪不对：${ready.map((n) => n.id).join(",")}`);
  }

  ok("就绪：只放出没有前置的节点");
} catch (e) {
  fail("就绪节点", e);
}

/* 6. 完成解锁下游 */
try {
  const parsed = G.parseGraph(chain());
  const done = new Set(["a"]);
  const ready = G.readyNodes(parsed.graph, done);

  if (ready.length !== 1 || ready[0].id !== "b") {
    throw new Error(`解锁不对：${ready.map((n) => n.id).join(",")}`);
  }

  const next = G.nextNode(parsed.graph, done);
  if (!next || next.id !== "b") throw new Error("nextNode 没给出 b");

  ok("推进：完成一个节点解锁下游");
} catch (e) {
  fail("解锁下游", e);
}

/* 7. 优先级排序 */
try {
  const parsed = G.parseGraph({
    kind: G.KIND,
    name: "并排",
    nodes: [
      { id: "low", priority: 10, recipe: "oak_log" },
      { id: "high", priority: 90, recipe: "stick" },
      { id: "mid", priority: 50, recipe: "torch" },
    ],
  });

  const ready = G.readyNodes(parsed.graph, new Set());
  if (ready.map((n) => n.id).join(",") !== "high,mid,low") {
    throw new Error(`排序不对：${ready.map((n) => n.id).join(",")}`);
  }

  ok("排序：无依赖节点按优先级出队");
} catch (e) {
  fail("优先级排序", e);
}

/* 8. 进度统计 */
try {
  const parsed = G.parseGraph(chain());
  const p1 = G.progressOf(parsed.graph, new Set());
  const p2 = G.progressOf(parsed.graph, new Set(["a"]));

  if (p1.total !== 3 || p1.done !== 0 || p1.percent !== 0) throw new Error("初始进度不对");
  if (p2.done !== 1 || p2.percent !== 33) throw new Error(`进度不对：${JSON.stringify(p2)}`);

  ok("进度：完成数与百分比正确");
} catch (e) {
  fail("进度统计", e);
}

/* 9. formatGraph */
try {
  const parsed = G.parseGraph(chain());
  const text = G.formatGraph(parsed.graph, new Set());

  if (!text.includes("测试链")) throw new Error(`没有图名：${text}`);
  if (!text.includes("第一件事")) throw new Error(`没有下一个节点：${text}`);

  ok("输出：formatGraph 带图名与下一个节点");
} catch (e) {
  fail("formatGraph", e);
}

/* 10. 导入 + 读回 */
try {
  const dir = tempDir("import");
  const imported = S.importGraph(dir, chain());

  if (!imported.ok) throw new Error(imported.errors.join("；"));

  const loaded = S.loadGraphs(dir);
  if (!loaded.graphs.length) throw new Error("读不回来");
  if (loaded.graphs[0].name !== "测试链") throw new Error("名字不对");

  cleanup(dir);
  ok("存储：导入写盘后能读回");
} catch (e) {
  fail("导入读回", e);
}

/* 11. 进度持久化 */
try {
  const dir = tempDir("progress");
  S.importGraph(dir, chain());

  S.markNodeDone(dir, "测试链", "a");
  const progress = S.loadProgress(dir);

  if (!progress["测试链"] || !progress["测试链"].includes("a")) {
    throw new Error(`进度没写进去：${JSON.stringify(progress)}`);
  }

  cleanup(dir);
  ok("存储：节点进度能持久化");
} catch (e) {
  fail("进度持久化", e);
}

/* 12. 坏文件不影响其它图 */
try {
  const dir = tempDir("bad");
  S.importGraph(dir, chain());

  fs.writeFileSync(
    path.join(S.dirOf(dir), "broken.json"),
    "{ this is not json",
    "utf8",
  );

  const loaded = S.loadGraphs(dir);
  if (loaded.graphs.length !== 1) throw new Error("好文件被连累了");
  if (!loaded.errors.length) throw new Error("坏文件没有报错");

  cleanup(dir);
  ok("存储：单份坏文件不影响其它图");
} catch (e) {
  fail("坏文件隔离", e);
}

/* 13. 内置示例图 */
try {
  const file = path.join(__dirname, "..", "examples", "minecraft-mainline.json");
  const text = fs.readFileSync(file, "utf8");
  const parsed = G.parseGraph(text);

  if (!parsed.ok) throw new Error(parsed.errors.join("；"));
  if (parsed.graph.nodes.length < 10) throw new Error("示例节点太少");

  const ready = G.readyNodes(parsed.graph, new Set());
  if (!ready.length) throw new Error("示例图没有任何起点");

  // 末影龙必须是最后一环：前置链要能走通
  const dragon = parsed.graph.nodes.find((n) => n.id === "defeat_ender_dragon");
  if (!dragon) throw new Error("示例里没有击败末影龙");
  if (!dragon.requires.length) throw new Error("末影龙没有前置");

  ok(`示例图：${parsed.graph.nodes.length} 个节点，起点 ${ready[0].title}`);
} catch (e) {
  fail("示例图", e);
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
