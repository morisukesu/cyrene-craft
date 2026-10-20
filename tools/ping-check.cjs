"use strict";

/**
 * 手动验证 ping：直接用插件的 bot-runtime 探一个真实地址。
 *
 * 用法：node tools/ping-check.cjs [host] [port]
 * 默认 127.0.0.1 63839
 */

const path = require("node:path");
const fs = require("node:fs");
const { spawn, execFile } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const host = process.argv[2] || "127.0.0.1";
const port = Number(process.argv[3]) || 63839;

const RUNTIME_NODE_MODULES = path.join(
  process.env.APPDATA || "",
  "Cyrene",
  "plugins",
  "minecraft-bot",
  "runtime",
  "bot-runtime",
  "node_modules",
);

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
  });
}

(async () => {
  if (!fs.existsSync(path.join(RUNTIME_NODE_MODULES, "mineflayer"))) {
    console.log("找不到 mineflayer 运行时");
    process.exit(1);
  }

  const child = spawn(process.execPath, [path.join(root, "src", "bot-runtime.cjs")], {
    env: {
      ...process.env,
      CYRENE_CRAFT_NODE_MODULES: RUNTIME_NODE_MODULES,
      CYRENE_CRAFT_DATA: path.join(root, ".ping-data"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const messages = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        /* 忽略坏行 */
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stderr.write("[runtime] " + d));

  // 等 ready
  await new Promise((r) => setTimeout(r, 1200));

  // 发 ping
  child.stdin.write(JSON.stringify({ id: 1, cmd: "ping", args: { host, port, timeoutMs: 8000 } }) + "\n");

  // 等结果
  const started = Date.now();
  const result = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const found = messages.find((m) => m.id === 1);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > 12_000) {
        clearInterval(timer);
        resolve(null);
      }
    }, 100);
  });

  console.log("");
  console.log(`探测 ${host}:${port}`);
  console.log("─".repeat(50));
  if (!result) {
    console.log("超时，没拿到响应");
  } else if (!result.ok) {
    console.log("命令失败：" + result.error);
  } else {
    console.log(JSON.stringify(result.data, null, 2));
  }
  console.log("─".repeat(50));

  child.stdin.end();
  await new Promise((r) => setTimeout(r, 500));
  await killTree(child.pid);
  try {
    fs.rmSync(path.join(root, ".ping-data"), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(0);
})();
