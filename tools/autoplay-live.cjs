"use strict";

/**
 * 自主驱动真连验证
 *
 * 用独立角色名进服务器，确认「进服 → 不需要模型 → 自己走下一步」这条链路
 * 在真实 mineflayer 上成立。
 *
 * 为了不打扰正在跑的插件和玩家，这里只跑冷启动的只读动作：
 *   context → scan
 * 不挖、不放、不移动，验证完立刻断开。
 *
 * 用法：
 *   node tools/autoplay-live.cjs 127.0.0.1 56418 CyreneAuto
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { BotBridge } = require("../src/bridge.cjs");
const { TraceLogger } = require("../src/trace.cjs");
const { SkillStore } = require("../src/skill-store.cjs");
const { SkillRunner } = require("../src/skill-runner.cjs");
const { Muscle } = require("../src/muscle.cjs");
const { AutoPlayDriver } = require("../src/autoplay.cjs");
const { resolveRuntime } = require("../src/runtime-resolve.cjs");

const host = process.argv[2] || "127.0.0.1";
const port = Number(process.argv[3]) || 25565;
const username = process.argv[4] || "CyreneAuto";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoplay-live-"));
  const userDataDir = process.env.APPDATA
    ? path.join(process.env.APPDATA, "Cyrene")
    : root;

  const runtime = resolveRuntime({ dataDir: root, userDataDir });
  if (!runtime.ok) throw new Error(`没有可用运行时：${runtime.reason || "unknown"}`);

  const bridge = new BotBridge({
    runtimeEntry: path.join(__dirname, "..", "src", "bot-runtime.cjs"),
    nodeModulesDir: runtime.dir,
    dataDir: root,
    log: () => {},
  });

  const trace = new TraceLogger({
    dir: path.join(root, "traces"),
    log: () => {},
    enabled: true,
  });

  const store = new SkillStore({ rootDir: path.join(root, "skills"), log: () => {} });
  const skillRunner = new SkillRunner({
    store,
    request: (cmd, args, kind) => bridge.request(cmd, args, kind),
    log: () => {},
  });

  const muscle = new Muscle({
    file: path.join(root, "muscle.json"),
    log: () => {},
    config: { minIntervalMs: 0 },
  });

  const settings = {
    autoplayEnabled: true,
    autoplayTickMs: 800,
    autoplayMaxRuntimeMs: 30_000,
    autoplayMinHealth: 8,
    autoplayMinFood: 6,
    autoplayYieldMs: 0,
    autoplayNearPlayerPause: 0,
    autoplayIdleTicks: 3,
    autoplayMuscle: false,
    autoplayCompileAfter: 99,
    // 只读动作，验证完不留痕迹
    autoplayBootstrap: [
      { tool: "context", args: {} },
      { tool: "scan", args: { block: "oak_log", radius: 16 } },
    ],
  };

  const driver = new AutoPlayDriver({
    bridge,
    trace,
    getMuscle: () => muscle,
    getSettings: () => settings,
    getSkillStore: () => store,
    skillRunner,
    log: (msg) => console.log(msg),
  });

  try {
    console.log(`启动运行时：${runtime.label || runtime.dir}`);
    await bridge.start();
    await bridge.connect({ host, port, username });

    for (let i = 0; i < 30 && bridge.status().state !== "connected"; i += 1) {
      await sleep(500);
    }

    const status = bridge.status();
    if (status.state !== "connected") {
      throw new Error(`连接超时：${status.lastError || status.state}`);
    }

    console.log(
      `已连接 ${host}:${port}，角色 ${status.username}，位置 ${JSON.stringify(status.position)}`,
    );

    driver.start("真连验证");
    await sleep(6000);
    driver.stop("验证结束");

    const rows = trace.snapshot();
    const autoRows = rows.filter((r) => r && r.origin === "autoplay");

    console.log("");
    console.log(`轨迹 ${rows.length} 条，其中 origin=autoplay ${autoRows.length} 条`);
    for (const row of autoRows.slice(0, 8)) {
      console.log(`  ${row.tool} ok=${row.ok} ${row.ms}ms`);
    }

    if (!autoRows.length) throw new Error("没有产生 origin=autoplay 的轨迹");

    const allowed = new Set(["context", "scan"]);
    const unexpected = autoRows.filter((r) => !allowed.has(r.tool));
    if (unexpected.length) {
      throw new Error(`执行了预期外的动作：${unexpected.map((r) => r.tool).join(", ")}`);
    }

    console.log("");
    console.log("✔ 进服后无需模型，自主驱动自己执行了冷启动动作");
  } finally {
    driver.stop("cleanup");
    muscle.flush();
    try {
      await bridge.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await bridge.stop();
    } catch {
      /* ignore */
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`失败：${e && e.message ? e.message : e}`);
    process.exit(1);
  });
