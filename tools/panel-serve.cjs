"use strict";

/**
 * 训练面板独立启动器（调试用）
 *
 * 为什么需要它：
 *   面板平时跟着插件一起启动。但如果你想在插件没加载时单独看面板、
 *   或者想在改动前端后立刻预览效果，用这个脚本最省事。
 *
 * 它直接读真实的 plugin-data 目录，看到的就是插件正在用的轨迹、技能与目标图。
 * 目标视图用真实记忆树重建一次，所以离线也能看到节点树和 goal.current。
 *
 * 用法：
 *   node tools/panel-serve.cjs            # 默认 16051
 *   node tools/panel-serve.cjs 18000      # 换端口
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { TrainingPanelServer } = require("../src/panel-server.cjs");
const { TraceLogger } = require("../src/trace.cjs");
const { SkillStore } = require("../src/skill-store.cjs");
const { GoalTracker } = require("../src/goal.cjs");
const goalStore = require("../src/goal-store.cjs");
const goalView = require("../src/goal-view.cjs");
const goalOutline = require("../src/goal-outline.cjs");
const { parseGraph, depthsOf } = require("../src/goal-graph.cjs");

const root = path.resolve(__dirname, "..");

/** 真实数据目录：C:\Users\<name>\AppData\Roaming\Cyrene\plugin-data\cyrene-craft */
const dataDir =
  process.env.CYRENE_CRAFT_DATA ||
  path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Cyrene", "plugin-data", "cyrene-craft");

const memoryRoot = path.join(dataDir, ".cyrene-craft");
const traceDir = path.join(dataDir, "traces");
const skillsDir = path.join(memoryRoot, "skills");

const port = Number(process.argv[2]) || 16051;

console.log("训练面板（独立模式）");
console.log(`  数据目录：${dataDir}`);
console.log(`  记忆树：${memoryRoot}`);
console.log(`  轨迹目录：${traceDir}`);
console.log(`  技能目录：${skillsDir}`);
console.log("");

fs.mkdirSync(traceDir, { recursive: true });
fs.mkdirSync(skillsDir, { recursive: true });

const trace = new TraceLogger({ dir: traceDir, log: (m) => console.log(`[trace] ${m}`) });
const store = new SkillStore({ rootDir: skillsDir, log: (m) => console.log(`[skill] ${m}`) });

/* ---------------------------- 目标图 ---------------------------- */

const goalGraphs = { list: [], done: new Map() };
/** @type {TrainingPanelServer|null} */
let panel = null;

const tracker = new GoalTracker({
  graphs: [],
  onChange: () => {
    if (panel) panel.broadcastGoals();
  },
});

const reloadGoalGraphs = () => {
  const loaded = goalStore.loadGraphs(memoryRoot);
  const progress = goalStore.loadProgress(memoryRoot);

  goalGraphs.list = loaded.graphs;
  goalGraphs.done = new Map(
    Object.entries(progress).map(([name, list]) => [name, new Set(list)]),
  );
  tracker.graphs = goalGraphs.list;
  tracker.graphDone = goalGraphs.done;

  for (const err of loaded.errors) {
    console.log(`[goal] ${err.file} 读取失败：${err.errors.join("；")}`);
  }
  return loaded;
};

/** 预览：大纲或 JSON，只校验不写盘 */
const previewGoalInput = (input = {}) => {
  const body = input && typeof input === "object" ? input : {};

  if (typeof body.outline === "string" && body.outline.trim()) {
    const parsed = goalOutline.parseOutline(body.outline);
    return {
      ok: parsed.ok,
      mode: "outline",
      graph: parsed.graph,
      errors: parsed.errors,
      stats: {
        nodes: parsed.stats.nodes,
        depth: parsed.stats.depth,
        overwrite: parsed.ok
          ? goalGraphs.list.some((g) => g.name === parsed.graph.name)
          : false,
      },
    };
  }

  if (body.graph !== undefined && body.graph !== null && body.graph !== "") {
    const parsed = parseGraph(body.graph);
    let depth = 0;
    if (parsed.ok) {
      for (const d of depthsOf(parsed.graph).values()) depth = Math.max(depth, d);
      depth += 1;
    }
    return {
      ok: parsed.ok,
      mode: "json",
      graph: parsed.graph,
      errors: parsed.errors,
      stats: {
        nodes: parsed.graph ? parsed.graph.nodes.length : 0,
        depth,
        overwrite: parsed.ok
          ? goalGraphs.list.some((g) => g.name === parsed.graph.name)
          : false,
      },
    };
  }

  return {
    ok: false,
    mode: null,
    graph: null,
    errors: ["需要 outline（大纲文本）或 graph（目标图 JSON）"],
    stats: { nodes: 0, depth: 0, overwrite: false },
  };
};

/** 导入：真实写盘到记忆树；独立模式下只影响文件，不进游戏 */
const importGoalInput = (input = {}) => {
  const preview = previewGoalInput(input);
  if (!preview.ok) {
    return {
      ok: false,
      name: null,
      nodes: 0,
      file: "",
      overwritten: false,
      errors: preview.errors,
    };
  }

  const imported = goalStore.importGraph(memoryRoot, preview.graph);
  if (!imported.ok) {
    return {
      ok: false,
      name: null,
      nodes: 0,
      file: "",
      overwritten: false,
      errors: imported.errors,
    };
  }

  reloadGoalGraphs();
  if (panel) panel.broadcastGoals(true);

  return {
    ok: true,
    name: imported.graph.name,
    nodes: imported.graph.nodes.length,
    file: imported.file,
    overwritten: Boolean(preview.stats.overwrite),
    errors: [],
  };
};

/* ---------------------------- 轨迹预载 ---------------------------- */

/** 把磁盘上已有的轨迹读进内存，这样启动时就有历史可看 */
function preloadTraces(maxLines = 400) {
  const file = path.join(traceDir, "current.jsonl");
  if (!fs.existsSync(file)) return 0;

  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return 0;
  }

  const tail = lines.slice(-maxLines);
  let loaded = 0;
  for (const line of tail) {
    try {
      const row = JSON.parse(line);
      trace.recent.push(row);
      loaded += 1;
    } catch {
      /* 跳过坏行 */
    }
  }
  return loaded;
}

const loaded = preloadTraces();
if (loaded) console.log(`已载入 ${loaded} 条历史轨迹`);

/* ---------------------------- 启动 ---------------------------- */

reloadGoalGraphs();

panel = new TrainingPanelServer({
  port,
  webDir: path.join(root, "web"),
  trace,
  store,
  getSnapshot: () => ({
    status: { state: "standalone", note: "独立模式，未连接游戏" },
    memoryRoot,
    skillsDir,
  }),
  getGoalView: () =>
    goalView.buildGoalView({
      graphs: goalGraphs.list,
      graphDone: goalGraphs.done,
      snapshot: tracker.snapshot(),
    }),
  previewGoalGraph: previewGoalInput,
  importGoalGraph: importGoalInput,
  log: (m) => console.log(`[panel] ${m}`),
});

(async () => {
  // 用空背包刷一次，让面板启动时就能看到「如果现在连上会落到哪个节点」
  tracker.refresh({ inventory: {} });

  const result = await panel.start();
  if (!result.ok) {
    console.error(`启动失败：${result.error}`);
    process.exit(1);
  }

  console.log("");
  console.log("═".repeat(52));
  console.log(`  面板地址：${result.url}`);
  console.log(`  技能数量：${store.listNames().length}`);
  console.log(`  轨迹条数：${trace.snapshot().length}`);
  console.log(`  目标图：${goalGraphs.list.length} 张`);
  console.log("═".repeat(52));
  console.log("");
  console.log("按 Ctrl+C 停止。");

  const shutdown = async () => {
    console.log("\n正在停止…");
    await panel.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
})();
