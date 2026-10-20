"use strict";

/**
 * 类脑决策层实跑演示
 *
 * 不连服务器，用一段人工构造的「真实经历」喂进图里，
 * 看能量扩散到底会不会推荐合理的东西。
 */

const path = require("node:path");
const g = require(path.join(__dirname, "..", "src", "skill-graph.cjs"));

// 模拟一段真实的采矿经历：
//   反复：找树 → 砍木头 → 合成木板 → 放木板
// 偶尔：砍完木头直接合成木棍
// 一次意外：挖石头失败（没镐）
const rows = [];
let ts = Date.now() - 3600_000;

function push(tool, args, ok = true, ms = 500) {
  ts += 2000;
  rows.push({ ts, tool, args, ok, ms, origin: "llm" });
}
function rest() {
  ts += 30_000; // 断开 episode
}

for (let i = 0; i < 8; i++) {
  push("move", { player: "Mori" }, true, 300);
  push("collect", { block: "oak_log", count: 4, radius: 16 }, true, 4200);
  push("craft", { item: "oak_planks" }, true, 800);
  push("build", { block: "oak_planks" }, true, 1500);
  rest();
}

for (let i = 0; i < 3; i++) {
  push("collect", { block: "oak_log", count: 2 }, true, 3800);
  push("craft", { item: "stick" }, true, 600);
  rest();
}

// 挖石头：3 次成功，2 次失败（没镐）
for (let i = 0; i < 3; i++) {
  push("move", { player: "Mori" }, true, 300);
  push("dig", { x: 10 + i, y: 60, z: 5 }, true, 2100);
  rest();
}
for (let i = 0; i < 2; i++) {
  push("move", { player: "Mori" }, true, 300);
  push("dig", { x: 20, y: 40, z: 5 }, false, 200);
  rest();
}

console.log("输入轨迹：%d 条\n", rows.length);

const graph = g.buildGraph(rows);
console.log("建图结果：%d 节点 / %d 边 / %d 段经历\n", graph.nodes.size, graph.edges.size, graph.episodes);

console.log("── 节点清单 ──");
for (const [id, n] of graph.nodes) {
  console.log(`  ${id.padEnd(34)} 跑${n.runs}次 成功${n.success} 失败${n.fail}`);
}

console.log("\n── 边清单（按权重）──");
const edges = [...graph.edges.values()].sort((a, b) => b.weight - a.weight);
for (const e of edges) {
  console.log(
    `  ${e.from} → ${e.to}`.padEnd(58) +
      ` ${e.count}次  权${e.weight.toFixed(3)}`
  );
}

function show(title, ctx, opts) {
  console.log(`\n══ ${title} ══`);
  const r = g.nextAction(graph, ctx, opts);
  if (r.pick) {
    console.log(`  ${g.formatSuggestion(r)}`);
    console.log("  候选：");
    r.candidates.forEach((c, i) => {
      const args = Object.entries(c.args || {})
        .filter(([k]) => ["block", "item", "player", "count"].includes(k))
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      console.log(
        `    ${i + 1}. ${c.tool}${args ? `(${args})` : ""}  能量${c.energy.toFixed(3)} 跑${c.runs}次 成功率${Math.round(c.successRate * 100)}%` +
          (c.via ? `  上承${c.via}` : "")
      );
    });
  } else {
    console.log(`  （无建议）${r.note}`);
  }
  if (r.note && r.pick) console.log(`  备注：${r.note}`);
}

// 场景 1：刚砍完木头，身上有木头，附近还有树
show("场景1｜刚砍完橡木，背包有木头，附近有树", {
  current: "collect:block=oak_log",
  inventory: { oak_log: 12 },
  blocks: { oak_log: 5 },
  health: 20,
  connected: true,
});

// 场景 2：刚合成木板，背包里有木板
show("场景2｜刚合成木板，背包有木板", {
  current: "craft:item=oak_planks",
  inventory: { oak_log: 4, oak_planks: 8 },
  blocks: { oak_log: 3 },
  health: 20,
  connected: true,
});

// 场景 3：血量低，应该只推保命
show("场景3｜血量只剩 6，旁边什么都没有", {
  current: "collect:block=oak_log",
  inventory: { oak_log: 12 },
  blocks: { oak_log: 5 },
  health: 6,
  connected: true,
});

// 场景 4：没当前节点，从头给个起点
show("场景4｜不知道该干嘛，让它自己挑个开头", {
  inventory: { oak_log: 0 },
  blocks: { oak_log: 8 },
  health: 20,
  connected: true,
});

console.log("\n" + "─".repeat(60));
console.log("跑完。以上全部是纯 JS 计算，没有加载任何模型权重。");
