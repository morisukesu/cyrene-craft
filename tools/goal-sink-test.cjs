"use strict";

/**
 * 目标沉淀（Goal Sink）测试
 *
 * 覆盖：
 *   1. 技能名安全化与长度上限
 *   2. 按图名 + 节点 id 找节点
 *   3. checkpoint=false 不沉淀
 *   4. 没有轨迹 / 轨迹编不出技能时不硬造
 *   5. 节点完成 → 编译 → 落盘，source 记住来源
 *   6. 同名技能已存在不覆盖
 *   7. 两张图共用节点 id 时自动加短哈希
 *   8. 接线验证：示例图刷新后 goal.current = get_wood
 *   9. 完成 get_wood 后解锁 craft_wooden_pickaxe，且技能已沉淀
 *  10. 沉淀失败不影响进度落盘
 *
 * 全部离线：图与技能都走临时目录。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const G = require("../src/goal-graph.cjs");
const S = require("../src/goal-store.cjs");
const K = require("../src/goal-sink.cjs");
const { GoalTracker } = require("../src/goal.cjs");
const { SkillStore, NAME_RE } = require("../src/skill-store.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `goal-sink-${tag}-`));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 一段成功的采集轨迹：先走过去，再砍木头 */
function episode() {
  return [
    { tool: "move", args: { x: 10, y: 64, z: -3 }, ok: true, ms: 800, origin: "autoplay" },
    { tool: "collect", args: { block: "oak_log", count: 1, radius: 16 }, ok: true, ms: 4200, origin: "autoplay" },
  ];
}

function fakeTrace(list = episode()) {
  return {
    latestCompilableEpisode() {
      return list;
    },
  };
}

/** 示例图（真实文件） */
function exampleGraph() {
  const text = fs.readFileSync(
    path.join(__dirname, "..", "examples", "minecraft-mainline.json"),
    "utf8",
  );
  const parsed = G.parseGraph(text);
  if (!parsed.ok) throw new Error(parsed.errors.join("；"));
  return parsed.graph;
}

/* 1. 技能名安全化 */
try {
  const dirty = K.safeName("取得原木 / #1");
  if (!NAME_RE.test(dirty)) throw new Error(`安全化后仍非法：${dirty}`);

  const long = K.baseNameOf("x".repeat(120));
  if (long.length > K.MAX_NAME) throw new Error(`名字没截断：${long.length}`);
  if (!NAME_RE.test(long)) throw new Error(`截断后非法：${long}`);

  const fallback = K.safeName("全部是中文");
  if (!NAME_RE.test(fallback)) throw new Error(`回退名非法：${fallback}`);

  ok("命名：安全化后符合技能名规则");
} catch (e) {
  fail("技能名安全化", e);
}

/* 2. 找节点 */
try {
  const graph = exampleGraph();
  const node = K.findNode([graph], graph.name, "get_wood");
  if (!node || node.recipe !== "oak_log") throw new Error("没找到 get_wood");

  if (K.findNode([graph], "不存在的图", "get_wood")) throw new Error("错误图名也找到了");
  if (K.findNode([graph], graph.name, "nope")) throw new Error("错误节点也找到了");

  ok("查找：按图名与节点 id 精确定位");
} catch (e) {
  fail("找节点", e);
}

/* 3. checkpoint=false */
try {
  const graph = {
    name: "不沉淀图",
    nodes: [{ id: "a", title: "看一遍", kind: "collect", recipe: "oak_log", checkpoint: false }],
  };
  const dir = tempDir("checkpoint");
  const store = new SkillStore({ rootDir: dir, log: () => {} });

  const r = K.precipitateNode({
    graphs: [graph],
    graphName: graph.name,
    nodeId: "a",
    trace: fakeTrace(),
    store,
  });

  if (r.ok) throw new Error("checkpoint=false 仍然沉淀了");
  if (r.reason !== "checkpoint-off") throw new Error(`原因不对：${r.reason}`);

  cleanup(dir);
  ok("纪律：checkpoint=false 不沉淀");
} catch (e) {
  fail("checkpoint=false", e);
}

/* 4. 没有轨迹 / 编不出来 */
try {
  const graph = exampleGraph();
  const dir = tempDir("empty");
  const store = new SkillStore({ rootDir: dir, log: () => {} });

  const none = K.precipitateNode({
    graphs: [graph],
    graphName: graph.name,
    nodeId: "get_wood",
    trace: { latestCompilableEpisode: () => null },
    store,
  });
  if (none.ok || none.reason !== "no-episode") throw new Error(`空轨迹原因不对：${none.reason}`);

  const junk = K.precipitateNode({
    graphs: [graph],
    graphName: graph.name,
    nodeId: "get_wood",
    trace: fakeTrace([{ tool: "scan", args: {}, ok: true, origin: "autoplay" }]),
    store,
  });
  if (junk.ok || junk.reason !== "not-compilable") {
    throw new Error(`不可编译轨迹原因不对：${junk.reason}`);
  }
  if (fs.readdirSync(dir).some((f) => f.endsWith(".json"))) {
    throw new Error("不该落盘任何技能");
  }

  cleanup(dir);
  ok("克制：没有可用轨迹时不硬造技能");
} catch (e) {
  fail("无轨迹不硬造", e);
}

/* 5. 正常沉淀 */
try {
  const graph = exampleGraph();
  const dir = tempDir("ok");
  const store = new SkillStore({ rootDir: dir, log: () => {} });

  const r = K.precipitateNode({
    graphs: [graph],
    graphName: graph.name,
    nodeId: "get_wood",
    trace: fakeTrace(),
    store,
  });

  if (!r.ok) throw new Error(`沉淀失败：${r.reason}`);
  if (r.name !== "goal_get_wood") throw new Error(`名字不对：${r.name}`);

  const saved = store.get(r.name);
  if (!saved) throw new Error("技能没落盘");
  if (!saved.steps.length) throw new Error("技能没有步骤");
  if (!saved.source || !saved.source.goal) throw new Error("没有记录来源");
  if (saved.source.goal.graph !== graph.name) throw new Error("来源图名不对");
  if (saved.source.goal.node !== "get_wood") throw new Error("来源节点不对");

  cleanup(dir);
  ok(`沉淀：${r.name}（${r.steps} 步），来源已记录`);
} catch (e) {
  fail("正常沉淀", e);
}

/* 6. 同名不覆盖 */
try {
  const graph = exampleGraph();
  const dir = tempDir("exists");
  const store = new SkillStore({ rootDir: dir, log: () => {} });

  const first = K.precipitateNode({
    graphs: [graph],
    graphName: graph.name,
    nodeId: "get_wood",
    trace: fakeTrace(),
    store,
  });
  if (!first.ok) throw new Error(`第一次失败：${first.reason}`);

  const before = store.get(first.name);
  const second = K.precipitateNode({
    graphs: [graph],
    graphName: graph.name,
    nodeId: "get_wood",
    trace: fakeTrace(),
    store,
  });

  if (second.ok) throw new Error("第二次不该覆盖");
  if (second.reason !== "exists") throw new Error(`原因不对：${second.reason}`);

  const after = store.get(first.name);
  if (after.updatedAt !== before.updatedAt) throw new Error("技能被悄悄改了");

  cleanup(dir);
  ok("纪律：同名技能已存在就不覆盖");
} catch (e) {
  fail("同名不覆盖", e);
}

/* 7. 跨图同名节点 */
try {
  const g1 = exampleGraph();
  const g2 = {
    name: "另一条路线",
    nodes: [{ id: "get_wood", title: "捡树枝", kind: "collect", recipe: "oak_log" }],
  };
  const dir = tempDir("collide");
  const store = new SkillStore({ rootDir: dir, log: () => {} });

  const a = K.precipitateNode({
    graphs: [g1],
    graphName: g1.name,
    nodeId: "get_wood",
    trace: fakeTrace(),
    store,
  });
  const b = K.precipitateNode({
    graphs: [g2],
    graphName: g2.name,
    nodeId: "get_wood",
    trace: fakeTrace(),
    store,
  });

  if (!a.ok || !b.ok) throw new Error(`有一个没沉淀：${a.reason} / ${b.reason}`);
  if (a.name === b.name) throw new Error("两张图共用了同一个技能名");
  if (!NAME_RE.test(b.name)) throw new Error(`加后缀后非法：${b.name}`);

  cleanup(dir);
  ok(`命名：跨图同名加短哈希（${b.name}）`);
} catch (e) {
  fail("跨图同名", e);
}

/* 8 + 9. 接线：刷新落到 get_wood，完成后解锁下游并沉淀 */
try {
  const dir = tempDir("wire");
  S.importGraph(dir, fs.readFileSync(
    path.join(__dirname, "..", "examples", "minecraft-mainline.json"),
    "utf8",
  ));

  const loaded = S.loadGraphs(dir);
  if (!loaded.graphs.length) throw new Error("图没读回来");

  const graphDone = new Map(
    Object.entries(S.loadProgress(dir)).map(([name, list]) => [name, new Set(list)]),
  );

  const store = new SkillStore({ rootDir: path.join(dir, "skills"), log: () => {} });
  const sunk = [];

  const tracker = new GoalTracker({
    graphs: loaded.graphs,
    graphDone,
    onNodeDone: (graphName, nodeId) => {
      S.markNodeDone(dir, graphName, nodeId);
      sunk.push(
        K.precipitateNode({
          graphs: tracker.graphs,
          graphName,
          nodeId,
          trace: fakeTrace(),
          store,
        }),
      );
    },
  });

  // 第一次刷新：空背包，状态差规则也会生成 collect:oak_log；
  // 目标图节点的优先级更高，必须赢。
  const snap1 = tracker.refresh({ inventory: {} });
  const expected = `graph:${loaded.graphs[0].name}:get_wood`;

  if (!snap1.current) throw new Error("刷新后没有当前目标");
  if (snap1.current.id !== expected) {
    throw new Error(`当前目标落点不对：${snap1.current.id}`);
  }
  if (snap1.current.target !== "oak_log") {
    throw new Error(`目标物不对：${snap1.current.target}`);
  }

  // 完成 get_wood：一次成功的 oak_log 采集
  tracker.noteStep({
    tool: "collect",
    args: { block: "oak_log", count: 1 },
    ok: true,
    data: { mined: 1 },
    at: Date.now(),
  });

  const progress = S.loadProgress(dir);
  if (!progress[loaded.graphs[0].name] || !progress[loaded.graphs[0].name].includes("get_wood")) {
    throw new Error(`进度没落盘：${JSON.stringify(progress)}`);
  }
  if (!sunk.length || !sunk[0].ok) {
    throw new Error(`节点完成没沉淀：${sunk.length ? sunk[0].reason : "回调没触发"}`);
  }
  if (!store.get("goal_get_wood")) throw new Error("技能库里没有 goal_get_wood");

  // 第二次刷新：get_wood 完成 → 解锁木镐节点
  const snap2 = tracker.refresh({ inventory: {} });
  const expected2 = `graph:${loaded.graphs[0].name}:craft_wooden_pickaxe`;
  if (!snap2.current || snap2.current.id !== expected2) {
    throw new Error(`下游没解锁：${snap2.current ? snap2.current.id : "无目标"}`);
  }

  cleanup(dir);
  ok("接线：刷新落到 get_wood，完成后解锁 craft_wooden_pickaxe");
  ok("接线：节点完成即沉淀出 goal_get_wood");
} catch (e) {
  fail("解锁与沉淀接线", e);
}

/* 10. 沉淀失败不影响进度 */
try {
  const graph = exampleGraph();
  const dir = tempDir("sinkfail");

  const tracker = new GoalTracker({
    graphs: [graph],
    onNodeDone: (graphName, nodeId) => {
      S.markNodeDone(dir, graphName, nodeId);
      K.precipitateNode({
        graphs: tracker.graphs,
        graphName,
        nodeId,
        trace: fakeTrace(),
        store: {
          get: () => null,
          save() {
            throw new Error("磁盘满了");
          },
        },
      });
    },
  });

  tracker.refresh({ inventory: {} });
  tracker.noteStep({
    tool: "collect",
    args: { block: "oak_log", count: 1 },
    ok: true,
    data: { mined: 1 },
    at: Date.now(),
  });

  const progress = S.loadProgress(dir);
  if (!progress[graph.name] || !progress[graph.name].includes("get_wood")) {
    throw new Error("沉淀失败把进度一起带崩了");
  }

  cleanup(dir);
  ok("隔离：沉淀失败不影响进度落盘");
} catch (e) {
  fail("沉淀失败隔离", e);
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
