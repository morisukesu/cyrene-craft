"use strict";

/**
 * 端到端联调：真的把机器人子进程拉起来，走一遍行协议。
 *
 * 这一步验证的是「宿主 <-> 子进程」这条链路，不连真实服务器：
 *   1. 子进程能不能启动、能不能报 ready
 *   2. 请求能不能配对、响应能不能回来
 *   3. 各种命令在未连接服务器时是不是给出清晰错误而不是崩掉
 *   4. ping 命令能不能真的跑通（用一个肯定没开服务的端口验证失败路径）
 *   5. 子进程能不能干净退出
 *
 * 跑法：node tools\e2e.cjs
 * 依赖：本机已装 minecraft-bot 插件（提供 mineflayer 运行时）
 */

const path = require("node:path");
const fs = require("node:fs");
const { spawn, execFile } = require("node:child_process");

const root = path.resolve(__dirname, "..");

/** minecraft-bot 插件自带的运行时 */
const RUNTIME_NODE_MODULES = path.join(
  process.env.APPDATA || "",
  "Cyrene",
  "plugins",
  "minecraft-bot",
  "runtime",
  "bot-runtime",
  "node_modules",
);

const results = [];
const ok = (name, extra) => results.push({ name, pass: true, extra });
const fail = (name, err) => results.push({ name, pass: false, err });

/** 等 ms 毫秒 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
  });
}

async function main() {
  // 前置：运行时存在
  const mineflayerPkg = path.join(RUNTIME_NODE_MODULES, "mineflayer", "package.json");
  if (!fs.existsSync(mineflayerPkg)) {
    console.log("");
    console.log("跳过：找不到 minecraft-bot 的运行时 →", RUNTIME_NODE_MODULES);
    console.log("这说明本机没装 minecraft-bot 插件，e2e 需要它提供的 mineflayer。");
    process.exit(0);
  }

  const version = JSON.parse(fs.readFileSync(mineflayerPkg, "utf8")).version;
  console.log(`使用 mineflayer ${version} @ ${RUNTIME_NODE_MODULES}`);

  const dataDir = path.join(root, ".e2e-data");
  fs.mkdirSync(dataDir, { recursive: true });

  const child = spawn(process.execPath, [path.join(root, "src", "bot-runtime.cjs")], {
    env: {
      ...process.env,
      CYRENE_CRAFT_NODE_MODULES: RUNTIME_NODE_MODULES,
      CYRENE_CRAFT_DATA: dataDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const messages = [];
  const stderrLines = [];
  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        messages.push({ __bad: line.slice(0, 200) });
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrLines.push(String(chunk).trim());
  });

  /** 发一条请求并等它的响应 */
  const request = (id, cmd, args, timeoutMs = 10_000) =>
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
          reject(new Error(`等待 ${cmd} 响应超时`));
        }
      }, 50);

      child.stdin.write(JSON.stringify({ id, cmd, args: args || {} }) + "\n");
    });

  // 1. 等 ready
  try {
    await sleep(1500);
    const ready = messages.find((m) => m.kind === "ready");
    if (!ready) throw new Error("没收到 ready 握手");
    if (ready.mineflayerVersion !== version) {
      throw new Error(`版本不符：握手报 ${ready.mineflayerVersion}，实际 ${version}`);
    }
    ok(`子进程启动并握手（pid ${ready.pid}，mineflayer ${ready.mineflayerVersion}）`);
  } catch (e) {
    fail("子进程启动并握手", e);
    await killTree(child.pid);
    return report();
  }

  // 2. 未连接时 status
  try {
    const res = await request(1, "status");
    if (!res.ok) throw new Error("status 应成功");
    if (res.data.online !== false) throw new Error("未连接时 online 应为 false");
    if (res.data.state !== "disconnected") throw new Error(`预期 disconnected，实际 ${res.data.state}`);
    ok("未连接时 status 正常返回");
  } catch (e) {
    fail("未连接时 status 正常返回", e);
  }

  // 3. 未连接时读类命令应该明确报错
  for (const [cmd, args, id] of [
    ["inventory", {}, 2],
    ["players", {}, 3],
    ["context", {}, 4],
  ]) {
    try {
      const res = await request(id, cmd, args);
      if (res.ok) throw new Error(`${cmd} 未连接时不该成功`);
      if (!/连接|connect/i.test(res.error || "")) {
        throw new Error(`${cmd} 的错误信息没提示连接：${res.error}`);
      }
      ok(`未连接时 ${cmd} 明确报错`);
    } catch (e) {
      fail(`未连接时 ${cmd} 明确报错`, e);
    }
  }

  // 4. ping 失败路径：连一个肯定没服务的端口
  try {
    const res = await request(5, "ping", { host: "127.0.0.1", port: 1, timeoutMs: 2000 }, 15_000);
    if (!res.ok) throw new Error("ping 命令本身应该成功返回");
    if (res.data.ok !== false) throw new Error("连不上的端口，ping 结果应该是 ok:false");
    if (!res.data.error) throw new Error("ping 失败应该给原因");
    ok(`ping 失败路径可读（${res.data.error}）`);
  } catch (e) {
    fail("ping 失败路径可读", e);
  }

  // 5. 未知命令
  try {
    const res = await request(6, "no_such_command", {});
    if (res.ok) throw new Error("未知命令不该成功");
    if (!/未知命令/.test(res.error || "")) throw new Error(`错误信息不对：${res.error}`);
    ok("未知命令被正确拒绝");
  } catch (e) {
    fail("未知命令被正确拒绝", e);
  }

  // 6. say 未连接
  try {
    const res = await request(7, "say", { message: "测试" });
    if (res.ok) throw new Error("未连接时 say 不该成功");
    ok("未连接时 say 明确报错");
  } catch (e) {
    fail("未连接时 say 明确报错", e);
  }

  // 7. stop 总是可用（哪怕没在动）
  try {
    const res = await request(8, "stop", {});
    if (!res.ok) throw new Error(`stop 失败：${res.error}`);
    ok("stop 在闲置状态下也安全");
  } catch (e) {
    fail("stop 在闲置状态下也安全", e);
  }

  // 8. 无坏行
  const badLines = messages.filter((m) => m.__bad);
  if (badLines.length) {
    fail("行协议没有坏消息", new Error(`有 ${badLines.length} 条无法解析：${badLines[0].__bad}`));
  } else {
    ok("行协议没有坏消息");
  }

  // 9. 没有未捕获异常刷屏
  const crashy = stderrLines.filter((l) => /未捕获异常|unhandledRejection/i.test(l));
  if (crashy.length) {
    fail("子进程没有未捕获异常", new Error(crashy.slice(0, 2).join(" | ")));
  } else {
    ok("子进程没有未捕获异常");
  }

  // 10. 干净退出
  try {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    // 关掉子进程的 stdin：它收到 end 事件后应该自己干净退出
    child.stdin.end();
    const timer = setTimeout(() => resolve("timeout"), 5000);
    const code = await Promise.race([exited, timer]);
    if (code === "timeout") throw new Error("关掉 stdin 后 5 秒没有退出");
    ok(`关闭 stdin 后干净退出（code ${code}）`);
  } catch (e) {
    fail("关闭 stdin 后干净退出", e);
  } finally {
    await killTree(child.pid);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* 删不掉不影响结果 */
    }
  }

  report();
}

function report() {
  console.log("");
  console.log("═".repeat(60));
  for (const r of results) {
    console.log(`${r.pass ? "  ✔" : "  ✘"} ${r.name}`);
    if (!r.pass) console.log(`       ${r.err && r.err.message ? r.err.message : r.err}`);
  }
  console.log("═".repeat(60));

  const passed = results.filter((r) => r.pass).length;
  console.log(`通过 ${passed} / ${results.length}`);

  if (passed !== results.length) {
    console.log("有失败项。");
    process.exit(1);
  }
  console.log("链路联调全部通过。");
  process.exit(0);
}

main().catch((e) => {
  console.error("e2e 自身崩了：", e);
  process.exit(1);
});
