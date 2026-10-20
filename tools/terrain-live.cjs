"use strict";

/**
 * 地形感知真连验证
 *
 * 进服务器后：
 *   1. 读一次地形，确认高度矩阵回来了
 *   2. 扫一个最近的目标方块
 *   3. 跑一次 collect，观察它是否走接近面、是否带回 terrainKey / strategy
 *
 * 用独立角色名，不打扰正在跑的插件；只采一个方块就停。
 *
 * 用法：
 *   node tools/terrain-live.cjs 127.0.0.1 56418 CyreneAuto
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { BotBridge } = require("../src/bridge.cjs");
const { resolveRuntime } = require("../src/runtime-resolve.cjs");

const host = process.argv[2] || "127.0.0.1";
const port = Number(process.argv[3]) || 25565;
const username = process.argv[4] || "CyreneAuto";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-live-"));
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

  try {
    await bridge.start();
    await bridge.connect({ host, port, username });

    for (let i = 0; i < 30 && bridge.status().state !== "connected"; i += 1) {
      await sleep(500);
    }
    if (bridge.status().state !== "connected") {
      throw new Error(`连接超时：${bridge.status().lastError || bridge.status().state}`);
    }
    console.log(`已连接 ${host}:${port}，角色 ${bridge.status().username}`);

    // 1. 地形
    const terrain = await bridge.request("terrain", { radius: 16 });
    const size = Array.isArray(terrain.heights) ? terrain.heights.length : 0;
    console.log(`地形：${size}×${size}，高度 ${terrain.minY}..${terrain.maxY}`);
    if (!size) throw new Error("地形高度矩阵为空");

    // 2. 找目标
    const scan = await bridge.request("scan", { block: "oak_log", radius: 32, limit: 3 });
    const blocks = Array.isArray(scan.blocks) ? scan.blocks : [];
    console.log(`目标：${blocks.length} 个 oak_log${blocks[0] ? `，最近 ${blocks[0].distance} 格` : ""}`);
    if (!blocks.length) {
      console.log("附近没有 oak_log，跳过 collect 验证");
      return;
    }

    // 3. 采一个，观察接近策略
    console.log("开始 collect（只采 1 个，maxStalls=1）…");
    const result = await bridge.request(
      "collect",
      {
        block: "oak_log",
        count: 1,
        radius: 16,
        maxStalls: 1,
        timeoutMs: 30000,
      },
      "collect",
    );

    console.log("");
    console.log(`结果：ok=${result.ok} complete=${result.complete} mined=${result.mined}`);
    console.log(`停止原因：${result.reason || "无"}`);
    console.log(`地形指纹：${result.terrainKey || "（未触发接近）"}`);
    console.log(`接近策略：${result.strategy || "（未触发接近）"}`);
    console.log(`接近点：${result.approach ? JSON.stringify(result.approach) : "（无）"}`);
    console.log(`接近失败原因：${result.approachReason || "无"}`);
    if (Array.isArray(result.tried) && result.tried.length) {
      console.log("尝试明细：");
      for (const t of result.tried) {
        console.log(`  ${t.kind}: ${t.error ? `失败（${t.error}）` : `距离 ${t.dist}`}`);
      }
    }

    if (result.complete) {
      console.log("");
      console.log("✔ 采集成功，地形感知链路可用");
    } else if (result.terrainKey) {
      console.log("");
      console.log("△ 采集未完成，但已经读地形并尝试接近（看 reason 判断下一刀）");
    } else {
      console.log("");
      console.log("△ 采集未完成，且没有触发接近策略（目标可能在可达范围内直接失败）");
    }
  } finally {
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
