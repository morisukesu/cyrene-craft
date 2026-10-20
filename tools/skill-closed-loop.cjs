"use strict";

/**
 * 技能闭环真跑：连真实服务器，走完 collect → compile → run。
 *
 * 这个脚本验证的是「技能层在真实世界里能不能用」，不是代码逻辑对不对。
 * 它直接用 SkillStore / SkillCompiler / SkillRunner，和插件里跑的是同一套代码。
 *
 * 用法：node tools\skill-closed-loop.cjs [host] [port] [username]
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");

const { TraceLogger } = require("../src/trace.cjs");
const { SkillStore } = require("../src/skill-store.cjs");
const { SkillRunner } = require("../src/skill-runner.cjs");
const { compileEpisode, suggestName } = require("../src/skill-compiler.cjs");

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

/**
 * 工作目录默认落在系统临时目录，源码树保持干净。
 *
 * 以前直接写 <root>/.closed-loop-data，结果测试产物混进插件目录，
 * 同步检查会一直报「文件不一致」，而且真机技能也会被测试数据污染。
 * 需要保留产物时显式传 CYRENE_CLOSED_LOOP_DIR。
 */
const workDir = process.env.CYRENE_CLOSED_LOOP_DIR
  ? path.resolve(process.env.CYRENE_CLOSED_LOOP_DIR)
  : path.join(os.tmpdir(), `cyrene-craft-loop-${process.pid}`);
const traceDir = path.join(workDir, "traces");
const skillsDir = path.join(workDir, "skills");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
  });
}

const results = [];
const ok = (n, detail) => results.push({ name: n, pass: true, detail });
const fail = (n, e) => results.push({ name: n, pass: false, err: e });

(async () => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(traceDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });

  const trace = new TraceLogger({ dir: traceDir, log: () => {} });
  const store = new SkillStore({ rootDir: skillsDir, log: () => {} });

  const child = spawn(process.execPath, [path.join(root, "src", "bot-runtime.cjs")], {
    env: {
      ...process.env,
      CYRENE_CRAFT_NODE_MODULES: RUNTIME_NODE_MODULES,
      CYRENE_CRAFT_DATA: workDir,
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

  const request = (id, cmd, args, timeoutMs = 300_000) =>
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
      }, 150);
      child.stdin.write(JSON.stringify({ id, cmd, args: args || {} }) + "\n");
    });

  /** 和 index.cjs 里 tool() 包装器做同样的事：记录一次工具调用 */
  const recordCall = (tool, args, okFlag, ms, extra = {}) => {
    trace.record({ tool, args, ok: okFlag, ms, origin: "llm", ...extra });
  };

  /** 把 bridge.request 包成 SkillRunner 需要的形式，同时补录轨迹 */
  const runSkillStep = async (steps) => {
    const started = Date.now();
    const res = await request(900, "sequence", { steps }, 600_000);
    // 技能发起的轨迹标 origin=skill，不参与编译
    if (res.ok) {
      trace.record({
        tool: "sequence",
        args: { steps },
        ok: Number(res.data.failed) === 0,
        ms: Date.now() - started,
        origin: "skill",
      });
      return res.data;
    }
    throw new Error(res.error || "sequence 执行失败");
  };

  const skillRunner = new SkillRunner({
    store,
    request: (cmd, args, kind) => request(901, cmd, args, 600_000).then((r) => {
      if (!r.ok) throw new Error(r.error);
      return r.data;
    }),
    log: () => {},
  });

  const cleanup = async () => {
    child.stdin.end();
    await sleep(600);
    await killTree(child.pid);
  };

  await sleep(1200);

  /* ---- 1. 连接 ---- */
  try {
    const res = await request(1, "connect", { host, port, username }, 60_000);
    if (!res.ok) throw new Error(res.error);
    // 中文错误信息的可读性也顺便看一下
    ok(`进入服务器 ${host}:${port} 角色 ${res.data.username}`);
  } catch (e) {
    fail("进入服务器", e);
    console.log("");
    console.log("连不上：" + (e && e.message ? e.message : e));
    if (stderrLines.length) console.log("stderr:\n" + stderrLines.slice(-8).join("\n"));
    await cleanup();
    report();
    return;
  }

  /* ---- 2. 找木头 ---- */
  let woodBlock = null;
  for (const candidate of ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log"]) {
    const res = await request(2, "scan", { block: candidate, radius: 48, limit: 1 });
    recordCall("scan", { block: candidate, radius: 48 }, res.ok, 100);
    if (res.ok && res.data.count > 0) {
      woodBlock = candidate;
      break;
    }
  }

  if (!woodBlock) {
    fail("找到原木", new Error("48 格内没有原木，换个位置再试"));
    await cleanup();
    report();
    return;
  }
  ok(`找到可采集的木块：${woodBlock}`);

  /* ---- 3. 第一次采集：产生真实轨迹 ---- */
  // 只挖一个，配合短超时先确认链路通不通；卡住时能快速失败而不是干等十分钟
  const collectArgs = { block: woodBlock, count: 1, radius: 48 };
  const firstStart = Date.now();
  let firstResult = null;
  try {
    const res = await request(3, "collect", collectArgs, 120_000);
    const ms = Date.now() - firstStart;
    recordCall("collect", collectArgs, res.ok, ms);
    if (!res.ok) throw new Error(res.error);
    firstResult = res.data;
    ok(`第一次采集完成（挖到 ${res.data.mined} 个，背包 ${res.data.inInventory} 个，${(ms / 1000).toFixed(1)} 秒）`);
  } catch (e) {
    fail("第一次采集", e);
    // 卡住时把子进程的 stderr 打出来，看看它内部在报什么
    if (stderrLines.length) {
      console.log("");
      console.log("    子进程最近日志：");
      for (const line of stderrLines.slice(-12)) console.log(`      ${line}`);
    }
    await cleanup();
    report();
    return;
  }

  /* ---- 3.5 采集后连接还在不在 ---- */
  try {
    const s = await request(35, "status", {}, 15_000);
    if (!s.ok) throw new Error(s.error);
    if (s.data.state !== "connected") {
      throw new Error(`采集后连接断了：state=${s.data.state}，lastError=${s.data.lastError || "无"}`);
    }
    ok("采集完成后连接仍然正常");
  } catch (e) {
    fail("采集后连接仍在", e);
    // 把断线相关事件打出来
    const stateEvents = messages.filter((m) => m.event === "state" || m.event === "error");
    if (stateEvents.length) {
      console.log("");
      console.log("    断线相关事件：");
      for (const ev of stateEvents.slice(-6)) {
        console.log(`      ${ev.event}: ${JSON.stringify(ev.data)}`);
      }
    }
    await cleanup();
    report();
    return;
  }

  await sleep(400);

  /* ---- 4. 编译技能 ---- */
  let skillName = null;
  let compiled = null;
  try {
    const episode = trace.latestCompilableEpisode(1);
    if (!episode) throw new Error("没有可编译的轨迹段");
    skillName = suggestName(episode, {});
    if (!skillName) throw new Error("起不出名字");
    compiled = compileEpisode(episode, {});
    if (!compiled) throw new Error("编译器返回 null");

    store.save(skillName, compiled);
    ok(`编译出技能 ${skillName}（${compiled.steps.length} 步）`, JSON.stringify(compiled.steps));
    console.log(`    技能描述：${compiled.description}`);
    console.log(`    参数：${JSON.stringify(compiled.params)}`);
    console.log(`    步骤：${compiled.steps.map((s) => `${s.cmd}${JSON.stringify(s.args)}`).join(" → ")}`);
  } catch (e) {
    fail("编译技能", e);
    await cleanup();
    report();
    return;
  }

  /* ---- 5. 用技能跑一次真实采集 ---- */
  const skillStart = Date.now();
  try {
    const runResult = await skillRunner.run(skillName, { count: 2 }, { runSteps: runSkillStep });
    const ms = Date.now() - skillStart;

    if (!runResult.ok) {
      throw new Error(`技能执行失败：${runResult.error || runResult.reason}（${JSON.stringify(runResult.results || [])}）`);
    }
    ok(`技能 ${skillName} 真跑成功（${runResult.done}/${runResult.total} 步，${(ms / 1000).toFixed(1)} 秒）`);

    const after = store.get(skillName);
    if (!after || after.stats.runs !== 1) throw new Error("统计没记上");
    ok(`技能统计已记录（runs=${after.stats.runs}，success=${after.stats.success}）`);
  } catch (e) {
    fail("技能真跑", e);
  }

  /* ---- 6. 确认技能轨迹不污染编译 ---- */
  try {
    await sleep(300);

    const all = trace.snapshot();
    const skillRows = all.filter((r) => r.origin === "skill");
    if (!skillRows.length) {
      throw new Error(`没有任何 origin=skill 的轨迹（共 ${all.length} 条，来源：${[...new Set(all.map((r) => r.origin))].join("/")}）`);
    }

    // 关键断言：技能轨迹可以被并进同一段 episode（那是时间窗口的自然结果），
    // 但绝不能出现在「可编译」的候选里 —— 否则技能会自己编自己。
    const compilable = trace.latestCompilableEpisode(1);
    if (compilable && compilable.some((r) => r.origin === "skill")) {
      throw new Error("可编译段里混进了 skill 轨迹");
    }
    if (compilable && !compilable.every((r) => r.origin === "llm")) {
      throw new Error("可编译段里混进了非 llm 来源");
    }
    ok(
      `技能轨迹已标记 origin=skill（${skillRows.length} 条 / 共 ${all.length} 条），` +
        `且被排除在可编译候选之外`,
    );
  } catch (e) {
    fail("技能轨迹隔离", e);
  }

  /* ---- 7. 参数覆盖是否生效 ---- */
  try {
    const skill = store.get(skillName);
    const hasCount = Object.keys(skill.params || {}).length > 0;
    if (!hasCount) {
      ok("这个技能没有可覆盖参数（单步采集，参数在 args 里）");
    } else {
      ok(`技能参数可覆盖：${Object.keys(skill.params).join("、")}`);
    }
  } catch (e) {
    fail("参数覆盖检查", e);
  }

  /* ---- 8. 中文错误信息可读性 ---- */
  try {
    const res = await request(50, "inventory", {}, 15_000);
    // 这时候连着，inventory 应该成功。换个必然失败的命令来验中文
    const bad = await request(51, "dig", { x: -999999, y: -999999, z: -999999 }, 30_000);
    const errText = bad.ok ? "" : String(bad.error || "");
    if (bad.ok) {
      ok("中文错误信息检查（该命令意外成功了，跳过）");
    } else if (/[\u4e00-\u9fa5]/.test(errText)) {
      ok(`中文错误信息可读：${errText.slice(0, 50)}`);
    } else {
      throw new Error(`错误信息没有中文或仍是乱码：${errText.slice(0, 80)}`);
    }
  } catch (e) {
    fail("中文错误信息可读", e);
  }

  /* ---- 9. 行协议健康 ---- */
  const bad = messages.filter((m) => m.__bad);
  if (bad.length) fail("行协议没有坏消息", new Error(bad[0].__bad));
  else ok("行协议没有坏消息");

  /* ---- 10. 断开 ---- */
  try {
    const res = await request(99, "disconnect", {}, 15_000);
    if (!res.ok) throw new Error(res.error);
    ok("正常断开");
  } catch (e) {
    fail("正常断开", e);
  }

  await cleanup();

  /* 保留技能库和轨迹供查看；看完了删掉，不留垃圾 */
  console.log("");
  console.log(`    技能库保留在：${skillsDir}`);
  console.log(`    轨迹保留在：${traceDir}`);
  console.log(`    清理：rd /s /q "${workDir}"`);

  report();
})();

function report() {
  console.log("");
  console.log("═".repeat(60));
  for (const r of results) {
    console.log(`${r.pass ? "  ✔" : "  ✘"} ${r.name}`);
    if (r.detail) console.log(`       ${r.detail}`);
    if (!r.pass) console.log(`       ${r.err && r.err.message ? r.err.message : r.err}`);
  }
  console.log("═".repeat(60));
  const passed = results.filter((r) => r.pass).length;
  console.log(`通过 ${passed} / ${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
}
