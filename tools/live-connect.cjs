"use strict";

/**
 * 真连测试：把插件真正连进一个服务器，走一遍关键命令。
 *
 * 这是最终验证——它会真的让一个机器人进服。
 * 用法：node tools\live-connect.cjs [host] [port] [username]
 * 默认 127.0.0.1 63839 Cyrene
 */

const path = require("node:path");
const fs = require("node:fs");
const { spawn, execFile } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const host = process.argv[2] || "127.0.0.1";
const port = Number(process.argv[3]) || 63839;
const username = process.argv[4] || "Cyrene";

const RUNTIME_NODE_MODULES = path.join(
  process.env.APPDATA || "",
  "Cyrene",
  "plugins",
  "minecraft-bot",
  "runtime",
  "bot-runtime",
  "node_modules",
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
  });
}

const results = [];
const ok = (n) => results.push({ name: n, pass: true });
const fail = (n, e) => results.push({ name: n, pass: false, err: e });

(async () => {
  const child = spawn(process.execPath, [path.join(root, "src", "bot-runtime.cjs")], {
    env: {
      ...process.env,
      CYRENE_CRAFT_NODE_MODULES: RUNTIME_NODE_MODULES,
      CYRENE_CRAFT_DATA: path.join(root, ".live-data"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const messages = [];
  const stderrLines = [];

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
        messages.push({ __bad: line.slice(0, 200) });
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    const text = String(d).trim();
    if (text) stderrLines.push(text);
  });

  const request = (id, cmd, args, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const found = messages.find((m) => m.id === id);
        if (found) {
          clearInterval(timer);
          resolve(found);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`等待 ${cmd} 超时（${timeoutMs}ms）`));
        }
      }, 100);
      child.stdin.write(JSON.stringify({ id, cmd, args: args || {} }) + "\n");
    });

  await sleep(1200);

  // 1. 连接
  let status = null;
  try {
    const res = await request(1, "connect", { host, port, username }, 60_000);
    if (!res.ok) throw new Error(res.error);
    status = res.data;
    if (!status.online) throw new Error("连上了但 online 是 false");
    ok(`进入服务器 ${host}:${port} 角色 ${status.username}`);
    console.log(`    坐标 (${Math.round(status.position.x)}, ${Math.round(status.position.y)}, ${Math.round(status.position.z)})`);
    console.log(`    血量 ${status.health}/20 饥饿 ${status.food}/20 维度 ${status.dimension}`);
  } catch (e) {
    fail("进入服务器", e);
    console.log("");
    console.log("连不上，错误：" + (e && e.message ? e.message : e));
    if (stderrLines.length) console.log("runtime stderr:\n" + stderrLines.slice(-10).join("\n"));
    await killTree(child.pid);
    report();
    return;
  }

  // 2. status
  try {
    const res = await request(2, "status");
    if (!res.ok) throw new Error(res.error);
    if (res.data.state !== "connected") throw new Error(`状态是 ${res.data.state}`);
    ok("status 报告已连接");
  } catch (e) {
    fail("status 报告已连接", e);
  }

  // 3. inventory
  try {
    const res = await request(3, "inventory");
    if (!res.ok) throw new Error(res.error);
    ok(`读背包（${res.data.count} 种物品）`);
  } catch (e) {
    fail("读背包", e);
  }

  // 4. players
  try {
    const res = await request(4, "players");
    if (!res.ok) throw new Error(res.error);
    ok(`读在线玩家（${res.data.count} 人）`);
  } catch (e) {
    fail("读在线玩家", e);
  }

  // 5. context
  try {
    const res = await request(5, "context", { survival: true });
    if (!res.ok) throw new Error(res.error);
    ok(`读环境（脚下方块 ${res.data.blockBelow}，光照 ${res.data.light}）`);
  } catch (e) {
    fail("读环境", e);
  }

  // 6. entities
  try {
    const res = await request(6, "entities", { radius: 16 });
    if (!res.ok) throw new Error(res.error);
    ok(`读附近实体（${res.data.count} 个）`);
  } catch (e) {
    fail("读附近实体", e);
  }

  // 7. map（字符地图）
  try {
    const res = await request(7, "map", { radius: 8 });
    if (!res.ok) throw new Error(res.error);
    const rows = res.data.grid.length;
    if (rows !== 17) throw new Error(`地图行数不对：${rows}`);
    ok(`画字符地图（${rows}×${res.data.grid[0].length}）`);
    console.log("    地图预览（#=石 .空 T树 *叶 ~水 +土）：");
    for (const row of res.data.grid.slice(0, 7)) console.log("      " + row);
  } catch (e) {
    fail("画字符地图", e);
  }

  // 8. scan（找脚下附近的方块）
  try {
    const res = await request(8, "scan", { block: "stone", radius: 16, limit: 3 });
    if (!res.ok) throw new Error(res.error);
    ok(`搜索方块 stone（找到 ${res.data.count} 个）`);
  } catch (e) {
    fail("搜索方块 stone", e);
  }

  // 9. 说话
  try {
    const res = await request(9, "say", { message: "昔涟上线测试♪" });
    if (!res.ok) throw new Error(res.error);
    ok("在游戏里说话");
  } catch (e) {
    fail("在游戏里说话", e);
  }

  // 10. 等待几秒看事件（聊天/系统消息）
  await sleep(1500);
  const chatEvents = messages.filter((m) => m.event === "chat");
  const systemEvents = messages.filter((m) => m.event === "system");
  ok(`收到推送事件（聊天 ${chatEvents.length} 条，系统 ${systemEvents.length} 条）`);

  // 11. 有坏行吗
  const bad = messages.filter((m) => m.__bad);
  if (bad.length) fail("行协议没有坏消息", new Error(bad[0].__bad));
  else ok("行协议没有坏消息");

  // 12. 有没有未捕获异常
  const crashy = stderrLines.filter((l) => /未捕获异常|unhandledRejection/i.test(l));
  if (crashy.length) fail("运行期间没有未捕获异常", new Error(crashy.slice(0, 2).join(" | ")));
  else ok("运行期间没有未捕获异常");

  // 13. 断开
  try {
    const res = await request(10, "disconnect", {}, 15_000);
    if (!res.ok) throw new Error(res.error);
    ok("正常断开");
  } catch (e) {
    fail("正常断开", e);
  }

  await sleep(500);
  child.stdin.end();
  await sleep(800);
  await killTree(child.pid);

  try {
    fs.rmSync(path.join(root, ".live-data"), { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  report();
})();

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
