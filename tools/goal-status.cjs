"use strict";

/**
 * 目标图状态检查（只读）
 *
 * 把插件用的目标图、进度和 GoalTracker 在本地重建一遍，
 * 用「空背包」当作刷新时的世界快照，看 goal.current 会落到哪个节点。
 *
 * 用法：
 *   node tools/goal-status.cjs                  # 插件默认记忆树
 *   node tools/goal-status.cjs <记忆树根>        # 指定 .cyrene-craft 根目录
 *   node tools/goal-status.cjs --json           # 机器可读
 *
 * 只读：不会写 progress.json，也不会改技能库。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const G = require("../src/goal-graph.cjs");
const S = require("../src/goal-store.cjs");
const { GoalTracker } = require("../src/goal.cjs");

/** 插件数据目录下的默认记忆树 */
function defaultRoot() {
  const appData =
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Cyrene", "plugin-data", "cyrene-craft", ".cyrene-craft");
}

function parseArgs(argv) {
  const out = { root: "", json: false };
  for (const arg of argv) {
    if (arg === "--json") out.json = true;
    else if (!arg.startsWith("-")) out.root = arg;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root || defaultRoot());

  if (!fs.existsSync(S.dirOf(root))) {
    console.error(`没有目标图目录：${S.dirOf(root)}`);
    process.exit(2);
  }

  const loaded = S.loadGraphs(root);
  const progress = S.loadProgress(root);
  const graphDone = new Map(
    Object.entries(progress).map(([name, list]) => [name, new Set(list)]),
  );

  // 空背包：只用来让状态差规则参与排序。
  // 目标图节点优先级更高时，current 一定落在图节点上。
  const tracker = new GoalTracker({ graphs: loaded.graphs, graphDone });
  const snapshot = tracker.refresh({ inventory: {} });

  const report = {
    root,
    errors: loaded.errors,
    graphs: loaded.graphs.map((graph) => {
      const done = graphDone.get(graph.name) || new Set();
      const next = G.nextNode(graph, done);
      return {
        name: graph.name,
        total: graph.nodes.length,
        done: [...done],
        progress: G.progressOf(graph, done),
        next: next ? { id: next.id, title: next.title, kind: next.kind } : null,
        ready: G.readyNodes(graph, done).map((n) => ({ id: n.id, title: n.title })),
      };
    }),
    current: snapshot.current,
    goals: snapshot.goals.map((g) => ({
      id: g.id,
      kind: g.kind,
      target: g.target,
      status: g.status,
      priority: g.priority,
    })),
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`记忆树：${root}`);
  if (loaded.errors.length) {
    for (const err of loaded.errors) {
      console.log(`  ⚠ ${err.file}：${err.errors.join("；")}`);
    }
  }

  for (const g of report.graphs) {
    console.log(
      `图：${g.name}｜${g.progress.done}/${g.progress.total}｜` +
        `下一个：${g.next ? `${g.next.title}（${g.next.id}）` : "已完成"}`,
    );
    if (g.ready.length > 1) {
      console.log(`  就绪：${g.ready.map((n) => `${n.title}（${n.id}）`).join("、")}`);
    }
  }

  if (!snapshot.current) {
    console.log("goal.current：无（没有可执行目标）");
    return;
  }

  const c = snapshot.current;
  console.log(
    `goal.current：${c.id}（${c.kind} ${c.target} ${c.progress}/${c.count}，优先级 ${c.priority}）`,
  );
}

main();
