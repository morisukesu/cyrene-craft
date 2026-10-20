"use strict";

/**
 * 本能层真连验证：连进真实服务器，确认本能反射层真的挂上了、能调参数、能停能起。
 *
 * 这是 live-connect.cjs 的补充——那套只验证「读写世界」，不碰本能层。
 * 本脚本回答唯一一个问题：连上之后 instincts 到底有没有在跑。
 *
 * 用法：node tools\instinct-live.cjs [host] [port] [username]
 * 默认 127.0.0.1 63839 Cyrene
 */

const path = require("node:path");
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

/** 轮询等待一个条件成立，返回它的返回值；超时返回 null */
async function waitFor(fn, timeoutMs = 5000, stepMs = 200) {
  const started = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return null;
    await sleep(stepMs);
  }
}

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
      CYRENE_CRAFT_DATA: path.join(root, ".instinct-live-data"),
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

  const cleanup = async () => {
    child.stdin.end();
    await sleep(600);
    await killTree(child.pid);
    try {
      require("node:fs").rmSync(path.join(root, ".instinct-live-data"), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  await sleep(1200);

  // 1. 连接
  try {
    const res = await request(1, "connect", { host, port, username }, 60_000);
    if (!res.ok) throw new Error(res.error);
    if (!res.data.online) throw new Error("连上了但 online 是 false");
    ok(`进入服务器 ${host}:${port} 角色 ${res.data.username}`);
  } catch (e) {
    fail("进入服务器", e);
    console.log("");
    console.log("连不上：" + (e && e.message ? e.message : e));
    if (stderrLines.length) console.log("runtime stderr:\n" + stderrLines.slice(-10).join("\n"));
    await cleanup();
    report();
    return;
  }

  // 2. 等本能层 tick 至少跑一轮
  await sleep(1500);

  // 3. 核心断言：本能层在跑
  let snapshot = null;
  try {
    const res = await request(2, "instincts", {});
    if (!res.ok) throw new Error(res.error);
    snapshot = res.data;
    if (!snapshot || snapshot.running !== true) {
      throw new Error(`running 是 ${snapshot && snapshot.running}，本能层没挂上`);
    }
    ok("本能层已挂载并运行中");
    console.log(
      `    参数：enabled=${snapshot.enabled} lowHealth=${snapshot.lowHealth} ` +
        `hungryFood=${snapshot.hungryFood} tickMs=${snapshot.tickMs}`,
    );
    console.log(`    最近动作：${snapshot.lastAction || "（还没有触发过，正常）"}`);
  } catch (e) {
    fail("本能层已挂载并运行中", e);
  }

  // 4. 默认阈值与配置一致
  try {
    if (!snapshot) throw new Error("没有拿到 snapshot");
    if (snapshot.enabled !== true) throw new Error("enabled 默认应该是 true");
    if (Number(snapshot.lowHealth) !== 12) throw new Error(`lowHealth 是 ${snapshot.lowHealth}，期望 12`);
    if (Number(snapshot.hungryFood) !== 14) throw new Error(`hungryFood 是 ${snapshot.hungryFood}，期望 14`);
    if (Number(snapshot.tickMs) !== 800) throw new Error(`tickMs 是 ${snapshot.tickMs}，期望 800`);
    ok("默认参数与约定一致（12 / 14 / 800ms）");
  } catch (e) {
    fail("默认参数与约定一致", e);
  }

  // 5. 改参数会真的生效
  try {
    const res = await request(3, "instincts", { lowHealth: 8, tickMs: 1000 });
    if (!res.ok) throw new Error(res.error);
    if (Number(res.data.lowHealth) !== 8) throw new Error(`lowHealth 没改成 8，是 ${res.data.lowHealth}`);
    if (Number(res.data.tickMs) !== 1000) throw new Error(`tickMs 没改成 1000，是 ${res.data.tickMs}`);
    if (res.data.running !== true) throw new Error("改参数后本能层掉了");
    ok("改参数生效且本能层重新挂上");
  } catch (e) {
    fail("改参数生效且本能层重新挂上", e);
  }

  // 6. 关闭能真的停
  try {
    const res = await request(4, "instincts", { enabled: false });
    if (!res.ok) throw new Error(res.error);
    if (res.data.running !== false) throw new Error(`关闭后 running 还是 ${res.data.running}`);
    ok("关闭开关后本能层停止");
  } catch (e) {
    fail("关闭开关后本能层停止", e);
  }

  // 7. 重新打开能起回来
  try {
    const res = await request(5, "instincts", { enabled: true });
    if (!res.ok) throw new Error(res.error);
    if (res.data.running !== true) throw new Error("重新打开后没有恢复运行");
    ok("重新打开后本能层恢复运行");
  } catch (e) {
    fail("重新打开后本能层恢复运行", e);
  }

  // 8. 状态推送里应该带本能字段（给 prompt provider 用）
  // 推送节奏是 3 秒一次，所以要主动等，不能查完就走。
  try {
    const found = await waitFor(
      () => messages.find((m) => m.event === "status" && m.data && "instinctLastAction" in m.data),
      8000,
    );
    if (!found) throw new Error("8 秒内没有收到带 instinctLastAction 的 status 推送");
    if (!("instinctActionAgeMs" in found.data)) throw new Error("status 推送缺少 instinctActionAgeMs");
    if (!("instinctsRunning" in found.data)) throw new Error("status 推送缺少 instinctsRunning");
    ok("状态推送包含本能层字段");
  } catch (e) {
    fail("状态推送包含本能层字段", e);
  }

  // 9. 行协议健康
  const bad = messages.filter((m) => m.__bad);
  if (bad.length) fail("行协议没有坏消息", new Error(bad[0].__bad));
  else ok("行协议没有坏消息");

  // 10. 没有未捕获异常
  const crashy = stderrLines.filter((l) => /未捕获异常|unhandledRejection/i.test(l));
  if (crashy.length) fail("运行期间没有未捕获异常", new Error(crashy.slice(0, 2).join(" | ")));
  else ok("运行期间没有未捕获异常");

  // 11. 断开
  try {
    const res = await request(10, "disconnect", {}, 15_000);
    if (!res.ok) throw new Error(res.error);
    ok("正常断开");
  } catch (e) {
    fail("正常断开", e);
  }

  await cleanup();
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
