"use strict";

/**
 * 用真实轨迹离线复盘执行环的选路（不执行任何动作）
 *
 * 目的：在真跑之前先确认——图给了什么、门禁放行了什么、执行环会挑哪个。
 * 这里 execute 只打印不动作，是刻意的：能核对决策，不会碰到世界。
 */

const fs = require("node:fs");
const path = require("node:path");

const G = require(path.join(__dirname, "..", "src", "skill-graph.cjs"));
const L = require(path.join(__dirname, "..", "src", "brain-loop.cjs"));

const TRACE = path.join(
  process.env.APPDATA || "",
  "Cyrene",
  "plugin-data",
  "cyrene-craft",
  "traces",
  "current.jsonl",
);

function loadRows() {
  const text = fs.readFileSync(TRACE, "utf8");
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      /* 半行忽略 */
    }
  }
  return rows;
}

async function main() {
  const rows = loadRows();
  console.log(`真实轨迹：${rows.length} 条`);

  const graph = G.buildGraph(rows, { now: Date.now() });
  console.log(`图：${graph.nodes.size} 节点 / ${graph.edges.size} 边 / ${graph.episodes} 段经历`);

  console.log("\n节点：");
  for (const [id, n] of graph.nodes) {
    const rate = n.runs ? Math.round((n.success / n.runs) * 100) : 0;
    console.log(`  ${id.padEnd(34)} 跑过 ${String(n.runs).padStart(3)} 次  成功 ${rate}%`);
  }

  console.log("\n边（权重 > 0 才参与扩散）：");
  const edges = [...graph.edges.values()].sort((a, b) => b.weight - a.weight);
  for (const e of edges) {
    const mark = e.weight ? " " : "×";
    console.log(
      `  ${mark} ${e.from} → ${e.to}`.padEnd(60) +
        `count=${e.count} weight=${e.weight.toFixed(3)}`,
    );
  }

  // 当前节点：最后一条真实动作
  const last = [...rows].reverse().find((r) => r && r.tool && r.origin !== "skill");
  const current = last ? G.nodeIdOf(last.tool, last.args) : "";
  console.log(`\n当前节点：${current || "（无）"}`);

  const result = G.nextAction(
    graph,
    { current, connected: true, health: 20, food: 20 },
    { limit: 6 },
  );
  console.log(`\n决策：${result.pick ? result.pick.tool : "无"}${result.note ? `（${result.note}）` : ""}`);
  for (const c of result.candidates) {
    const check = L.checkExecutable(c, {});
    console.log(
      `  ${check.ok ? "可执行" : "被拦下"}  ${c.tool}  分数 ${c.score.toFixed(3)}` +
        `  能量 ${c.energy.toFixed(3)}  跑过 ${c.runs} 次` +
        (check.ok ? "" : `  ← ${check.reason}`),
    );
  }

  console.log("\n执行环会怎么走（dry-run，不真的动手）：");
  const planned = [];
  await L.runLoop({
    graph,
    current,
    nextAction: G.nextAction,
    getWorld: async () => ({ connected: true, health: 20, food: 20, inventory: {} }),
    execute: async (tool, args) => {
      planned.push({ tool, args });
      console.log(`  → ${tool} ${JSON.stringify(args)}`);
      return { ok: true };
    },
    opts: { stepDelayMs: 0, maxSteps: 5, stallSteps: 3 },
  });

  if (!planned.length) {
    console.log("  （一步都没走出去）");
  } else {
    console.log(`\n共会执行 ${planned.length} 步`);
  }
}

main().catch((e) => {
  console.error("失败：", e.message);
  process.exitCode = 1;
});
