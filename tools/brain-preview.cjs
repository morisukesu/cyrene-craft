"use strict";

/**
 * 脑图预览启动器
 *
 * 用一份构造好的样本轨迹起面板，方便在浏览器里直接看脑图长什么样，
 * 不用真连服务器。数据落临时目录，不污染真实 plugin-data。
 *
 *   node tools/brain-preview.cjs          # 默认 16052
 *   node tools/brain-preview.cjs 18000    # 换端口
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { TrainingPanelServer } = require(path.join(__dirname, "..", "src", "panel-server.cjs"));
const { TraceLogger } = require(path.join(__dirname, "..", "src", "trace.cjs"));
const { SkillStore } = require(path.join(__dirname, "..", "src", "skill-store.cjs"));

const port = Number(process.argv[2]) || 16052;

const tmp = path.join(os.tmpdir(), "cyrene-brain-preview");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const trace = new TraceLogger({ dir: path.join(tmp, "traces"), log: (m) => console.log(m), enabled: true });
const store = new SkillStore({ rootDir: path.join(tmp, "skills"), log: () => {} });

// 造一段有分量的经历：采集 → 合成 → 建造，附带侦查与本能否
const push = (tool, args, ok = true, ms = 500, origin = "llm") =>
  trace.record({ tool, args, ok, ms, origin });

// 「找树 → 砍 → 合成 → 盖」重复多次，让边权足够厚
for (let i = 0; i < 8; i++) {
  push("scan", { block: "oak_log" }, true, 90);
  push("move", { player: "Mori" }, true, 320);
  push("collect", { block: "oak_log", count: 4 }, true, 4200);
  push("craft", { item: "oak_planks" }, true, 780);
  push("build", { block: "oak_planks" }, true, 1500);
}

// 另一条支线：砍完直接做木棍
for (let i = 0; i < 4; i++) {
  push("collect", { block: "oak_log", count: 2 }, true, 3900);
  push("craft", { item: "stick" }, true, 620);
}

// 侦查与本能
push("status", {}, true, 40);
push("entities", {}, true, 60);
push("instincts", {}, true, 30);

// 挖矿：成功几次后遇到没镐的失败
for (let i = 0; i < 3; i++) {
  push("dig", { x: 12 + i, y: 58, z: -4 }, true, 2100);
}
push("dig", { x: 30, y: 40, z: 8 }, false, 180);

const server = new TrainingPanelServer({
  port,
  webDir: path.join(__dirname, "..", "web"),
  trace,
  store,
  getSnapshot: () => ({ status: { connected: true, health: 20, oxygen: 300 } }),
  log: (m) => console.log(m),
});

server.start().then((r) => {
  if (!r.ok) {
    console.error("启动失败：", r.error);
    process.exit(1);
  }
  console.log("");
  console.log("  脑图预览已启动");
  console.log(`  脑图：  http://127.0.0.1:${r.port}/brain.html`);
  console.log(`  面板：  http://127.0.0.1:${r.port}/`);
  console.log(`  接口：  http://127.0.0.1:${r.port}/api/brain`);
  console.log("");
  console.log(`  样本轨迹 ${trace.snapshot().length} 条，数据在临时目录，关掉即弃。`);
  console.log("  Ctrl+C 结束。");
  console.log("");
});

const shutdown = async () => {
  console.log("\n正在关闭…");
  await server.stop();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
