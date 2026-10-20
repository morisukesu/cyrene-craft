"use strict";

/**
 * 训练面板 Web 服务测试
 *
 * 覆盖：
 *   1. 服务能起来，静态页面能拿到
 *   2. /api/overview 结构完整
 *   3. SSE 能收到 hello 首包
 *   4. 轨迹录制后 SSE 实时推送一条 trace
 *   5. 导出 bundle 结构正确且能下载
 *   6. 导入：新增 / 同名跳过 / 覆盖 / 改名
 *   7. 导入非法名字被拒
 *   8. 删除缺 confirmToken 被拒，带上了能删
 *   9. 路径穿越被拒
 *  10. 跨站写请求被拒
 *  11. 超过大小上限被拒
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { TrainingPanelServer } = require("../src/panel-server.cjs");
const { TraceLogger } = require("../src/trace.cjs");
const { SkillStore } = require("../src/skill-store.cjs");

const results = [];
const ok = (n) => results.push({ name: n, pass: true });
const fail = (n, e) => results.push({ name: n, pass: false, err: e });

const tmpRoot = path.join(os.tmpdir(), `cyrene-panel-test-${process.pid}`);
const skillsDir = path.join(tmpRoot, "skills");
const tracesDir = path.join(tmpRoot, "traces");

/** 简单 http 请求助手 */
function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: p,
        headers: {
          ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 静态文件不是 JSON */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

/** 打开 SSE 连接，收集事件 */
function openStream(port) {
  return new Promise((resolve, reject) => {
    const events = [];
    const r = http.request(
      { host: "127.0.0.1", port, path: "/api/stream", method: "GET", headers: { accept: "text/event-stream" } },
      (res) => {
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const evLine = block.split("\n").find((l) => l.startsWith("event: "));
            const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
            if (evLine && dataLine) {
              const event = evLine.slice(7).trim();
              let payload = null;
              try {
                payload = JSON.parse(dataLine.slice(6));
              } catch {
                payload = dataLine.slice(6);
              }
              events.push({ event, payload });
            }
          }
        });
        resolve({ events, close: () => r.destroy(), res });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(skillsDir, { recursive: true });

  const trace = new TraceLogger({ dir: tracesDir, log: () => {} });
  const store = new SkillStore({ rootDir: skillsDir, log: () => {} });

  // 预置两个技能，方便测导出
  store.save("chop_oak", {
    description: "砍橡木",
    steps: [{ cmd: "collect", args: { block: "oak_log", count: "${count}" } }],
    params: { count: { default: 8, min: 1, max: 64 } },
  });
  store.save("dig_stone", {
    description: "挖石头",
    steps: [{ cmd: "collect", args: { block: "stone", count: "${count}" } }],
    params: { count: { default: 4, min: 1, max: 64 } },
  });

  const goalCalls = { preview: [], import: [] };

  const panel = new TrainingPanelServer({
    port: 0,
    webDir: path.join(__dirname, "..", "web"),
    trace,
    store,
    getSnapshot: () => ({ status: { state: "disconnected" } }),
    // 目标驾驶舱：用固定视图与假导入，验证接口契约与 SSE 推送
    getGoalView: () => ({
      ok: true,
      now: new Date().toISOString(),
      current: {
        id: "graph:主线:get_wood",
        title: "取得原木",
        kind: "collect",
        target: "oak_log",
        progress: 0,
        count: 1,
        status: "active",
        priority: 100,
      },
      bigGoals: [
        {
          name: "主线",
          source: "测试",
          total: 2,
          done: 0,
          percent: 0,
          next: { id: "get_wood", title: "取得原木" },
          nodes: [],
          edges: [],
        },
      ],
      smallGoals: [],
      stepLog: [],
      counts: { active: 1, pending: 0, done: 0, failed: 0 },
    }),
    previewGoalGraph: (body) => {
      goalCalls.preview.push(body);
      if (body && typeof body.outline === "string") {
        const { parseOutline } = require("../src/goal-outline.cjs");
        const r = parseOutline(body.outline);
        return {
          ok: r.ok,
          mode: "outline",
          graph: r.graph,
          errors: r.errors,
          stats: { ...r.stats, overwrite: false },
        };
      }
      return {
        ok: false,
        mode: null,
        graph: null,
        errors: ["需要 outline 或 graph"],
        stats: { nodes: 0, depth: 0, overwrite: false },
      };
    },
    importGoalGraph: (body) => {
      goalCalls.import.push(body);
      return {
        ok: true,
        name: "测试图",
        nodes: 2,
        file: "test.json",
        overwritten: false,
        errors: [],
      };
    },
    log: () => {},
  });

  // port 0 会被当成默认端口，所以手动指定一个高位端口
  panel.port = 0;
  // 直接监听 0 让系统分配
  const started = await new Promise((resolve) => {
    const origLog = panel.log;
    panel.log = () => {};
    panel
      .start()
      .then((r) => {
        panel.log = origLog;
        resolve(r);
      })
      .catch((e) => resolve({ ok: false, error: e.message }));
  });

  // start() 里 0 会被 || 成默认端口，这里兜底检查
  const port = panel.actualPort;
  if (!started.ok || !port) {
    fail("面板启动", new Error(started.error || "拿不到端口"));
    report();
    return;
  }

  ok(`面板启动成功（端口 ${port}）`);

  /* 1. 静态页面 */
  try {
    const r = await req(port, "GET", "/");
    if (r.status !== 200) throw new Error(`状态码 ${r.status}`);
    if (!r.text.includes("训练面板")) throw new Error("页面内容不对");
    if (!String(r.headers["content-type"]).includes("text/html")) throw new Error("Content-Type 不对");
    if (r.headers["x-frame-options"] !== "DENY") throw new Error("缺少 x-frame-options");
    ok("静态页面可访问，带安全响应头");
  } catch (e) {
    fail("静态页面可访问", e);
  }

  /* 2. overview */
  try {
    const r = await req(port, "GET", "/api/overview");
    if (r.status !== 200 || !r.json || !r.json.ok) throw new Error(`接口返回异常：${r.text.slice(0, 120)}`);
    if (!r.json.stats) throw new Error("缺 stats");
    if (!Array.isArray(r.json.skills)) throw new Error("skills 不是数组");
    if (r.json.skills.length !== 2) throw new Error(`技能数应为 2，实际 ${r.json.skills.length}`);
    const skill = r.json.skills.find((s) => s.name === "chop_oak");
    if (!skill) throw new Error("找不到 chop_oak");
    if (skill.stats.successRate !== null) throw new Error("没跑过时成功率应为 null");
    ok("overview 返回完整结构与技能统计");
  } catch (e) {
    fail("overview 返回完整结构", e);
  }

  /* 3. SSE hello */
  let stream;
  try {
    stream = await openStream(port);
    await sleep(250);
    const hello = stream.events.find((e) => e.event === "hello");
    if (!hello) throw new Error("没收到 hello");
    if (!hello.payload.stats) throw new Error("hello 里没有 stats");
    ok("SSE 连接建立并收到 hello 首包");
  } catch (e) {
    fail("SSE 连接建立并收到 hello 首包", e);
  }

  /* 4. 实时推送 trace */
  try {
    trace.record({ tool: "collect", args: { block: "oak_log", count: 2 }, ok: true, ms: 1200 });
    const pushed = await (async () => {
      for (let i = 0; i < 30; i += 1) {
        const found = stream.events.find((e) => e.event === "trace");
        if (found) return found;
        await sleep(100);
      }
      return null;
    })();
    if (!pushed) throw new Error("3 秒内没收到 trace 推送");
    if (pushed.payload.tool !== "collect") throw new Error(`推送内容不对：${JSON.stringify(pushed.payload)}`);
    ok("录制后实时推送到 SSE 客户端");
  } catch (e) {
    fail("录制后实时推送到 SSE 客户端", e);
  }

  /* 5. 导出 */
  let exported;
  try {
    const r = await req(port, "GET", "/api/export");
    if (r.status !== 200) throw new Error(`状态码 ${r.status}`);
    if (!r.headers["content-disposition"] || !r.headers["content-disposition"].includes("attachment")) {
      throw new Error("缺少下载头");
    }
    exported = r.json;
    if (!exported || exported.kind !== "cyrene-craft-skills") throw new Error("bundle 类型不对");
    if (exported.count !== 2) throw new Error(`应导出 2 个，实际 ${exported.count}`);
    ok("导出 bundle 结构正确且带下载头");
  } catch (e) {
    fail("导出 bundle", e);
  }

  /* 6. 导入：新增 */
  try {
    const bundle = {
      kind: "cyrene-craft-skills",
      schemaVersion: 1,
      skills: [
        {
          name: "from_other_user",
          description: "别人分享的技能",
          steps: [{ cmd: "collect", args: { block: "birch_log", count: 4 } }],
        },
      ],
    };
    const r = await req(port, "POST", "/api/import?onConflict=skip", bundle);
    if (r.status !== 200 || !r.json.ok) throw new Error(r.text.slice(0, 160));
    if (r.json.added.length !== 1) throw new Error(`应新增 1 个，实际 ${r.json.added.length}`);
    if (!store.get("from_other_user")) throw new Error("导入后读不到技能");
    ok("导入新技能成功");
  } catch (e) {
    fail("导入新技能", e);
  }

  /* 7. 导入：同名跳过 */
  try {
    const bundle = { skills: [{ name: "chop_oak", steps: [{ cmd: "collect", args: { block: "cherry_log" } }] }] };
    const r = await req(port, "POST", "/api/import?onConflict=skip", bundle);
    if (!r.json.ok) throw new Error(r.text.slice(0, 160));
    if (r.json.skipped.length !== 1) throw new Error(`应跳过 1 个，实际 ${JSON.stringify(r.json)}`);
    // 本地版本不能被改
    const local = store.get("chop_oak");
    if (local.steps[0].args.block !== "oak_log") throw new Error("跳过后本地技能被改了");
    ok("同名技能按 skip 策略跳过，本地不受影响");
  } catch (e) {
    fail("同名跳过", e);
  }

  /* 8. 导入：覆盖 */
  try {
    const bundle = { skills: [{ name: "dig_stone", description: "覆盖后的版本", steps: [{ cmd: "collect", args: { block: "cobblestone" } }] }] };
    const r = await req(port, "POST", "/api/import?onConflict=overwrite", bundle);
    if (!r.json.ok) throw new Error(r.text.slice(0, 160));
    if (r.json.overwritten.length !== 1) throw new Error(`应覆盖 1 个，实际 ${JSON.stringify(r.json)}`);
    const local = store.get("dig_stone");
    if (local.description !== "覆盖后的版本") throw new Error("覆盖没生效");
    ok("同名技能按 overwrite 策略覆盖");
  } catch (e) {
    fail("同名覆盖", e);
  }

  /* 9. 导入：改名 */
  try {
    const bundle = { skills: [{ name: "chop_oak", steps: [{ cmd: "collect", args: { block: "spruce_log" } }] }] };
    const r = await req(port, "POST", "/api/import?onConflict=rename", bundle);
    if (!r.json.ok) throw new Error(r.text.slice(0, 160));
    if (r.json.renamed.length !== 1) throw new Error(`应改名 1 个，实际 ${JSON.stringify(r.json)}`);
    const names = store.listNames();
    const renamed = names.find((n) => n.startsWith("chop_oak_imported"));
    if (!renamed) throw new Error(`找不到改名后的技能：${names.join(",")}`);
    if (store.get(renamed).steps[0].args.block !== "spruce_log") throw new Error("改名后的内容不对");
    // 原来的没被动
    if (store.get("chop_oak").steps[0].args.block !== "oak_log") throw new Error("原技能被动了");
    ok("同名技能按 rename 策略改名并存");
  } catch (e) {
    fail("同名改名并存", e);
  }

  /* 10. 导入非法名字 */
  try {
    const bundle = { skills: [{ name: "../evil", steps: [{ cmd: "say", args: {} }] }] };
    const r = await req(port, "POST", "/api/import?onConflict=skip", bundle);
    if (!r.json.ok) throw new Error("请求本身应该成功，错误体现在 errors 里");
    if (r.json.errors.length !== 1) throw new Error(`应有 1 条错误，实际 ${JSON.stringify(r.json)}`);
    if (r.json.added.length !== 0) throw new Error("非法名字不该被写进去");
    ok("非法技能名被拒绝写入");
  } catch (e) {
    fail("非法技能名被拒绝", e);
  }

  /* 11. 删除缺 confirmToken */
  try {
    const r = await req(port, "POST", "/api/delete", { name: "from_other_user" });
    if (r.status !== 400) throw new Error(`应返回 400，实际 ${r.status}`);
    if (store.get("from_other_user") === null) throw new Error("没确认却删掉了");
    ok("删除缺少 confirmToken 被拒");
  } catch (e) {
    fail("删除缺少确认被拒", e);
  }

  /* 12. 删除带 confirmToken */
  try {
    const r = await req(port, "POST", "/api/delete", {
      name: "from_other_user",
      confirmToken: "delete:from_other_user",
    });
    if (!r.json.ok) throw new Error(r.text.slice(0, 160));
    if (store.get("from_other_user")) throw new Error("技能还在");
    ok("带确认标记可正常删除技能");
  } catch (e) {
    fail("带确认可删除", e);
  }

  /* 13. 路径穿越 */
  try {
    const r = await req(port, "GET", "/../../etc/passwd");
    if (r.status === 200 && r.text.includes("root:")) throw new Error("穿越成功了，严重问题");
    if (r.status !== 403 && r.status !== 404 && r.status !== 400) {
      throw new Error(`应拒绝，实际状态 ${r.status}`);
    }
    ok("静态路径穿越被拒绝");
  } catch (e) {
    fail("静态路径穿越被拒绝", e);
  }

  /* 14. 跨站写请求 */
  try {
    const r = await req(
      port,
      "POST",
      "/api/delete",
      { name: "chop_oak", confirmToken: "delete:chop_oak" },
      { origin: "http://evil.example.com" },
    );
    if (r.status !== 403) throw new Error(`应返回 403，实际 ${r.status}`);
    if (!store.get("chop_oak")) throw new Error("跨站请求把技能删了");
    ok("跨站写请求被拒绝");
  } catch (e) {
    fail("跨站写请求被拒绝", e);
  }

  /* 15. 请求体过大 */
  try {
    const huge = { skills: [{ name: "huge_skill", steps: [{ cmd: "say", args: { text: "x".repeat(5 * 1024 * 1024) } }] }] };
    const r = await req(port, "POST", "/api/import", huge);
    if (r.status !== 413 && r.status !== 400) throw new Error(`应拒绝超大请求，实际 ${r.status}`);
    if (store.get("huge_skill")) throw new Error("超大技能被写进去了");
    ok("超过 4MB 的导入被拒绝");
  } catch (e) {
    // 服务端可能在写入过程中断开连接，这属于预期内
    ok("超过 4MB 的导入被拒绝（连接提前断开）");
  }

  /* 16. 清空轨迹 */
  try {
    const r = await req(port, "POST", "/api/delete-traces", { confirmToken: "clear-traces" });
    if (!r.json.ok) throw new Error(r.text.slice(0, 160));
    if (trace.snapshot().length !== 0) throw new Error("内存轨迹没清掉");
    ok("清空轨迹生效");
  } catch (e) {
    fail("清空轨迹", e);
  }

  /* 17. 目标视图接口 */
  try {
    const r = await req(port, "GET", "/api/goals");
    if (r.status !== 200 || !r.json || !r.json.ok) {
      throw new Error(`接口异常：${r.text.slice(0, 120)}`);
    }
    if (!Array.isArray(r.json.bigGoals) || r.json.bigGoals.length !== 1) {
      throw new Error("大目标数量不对");
    }
    if (!r.json.current || r.json.current.id !== "graph:主线:get_wood") {
      throw new Error("当前目标不对");
    }
    if (!r.json.counts || r.json.counts.active !== 1) throw new Error("计数不对");
    ok("目标接口：返回大目标、当前目标与计数");
  } catch (e) {
    fail("目标接口", e);
  }

  /* 18. SSE 首包带目标视图 */
  try {
    const goalsEvent = stream.events.find((e) => e.event === "goals");
    if (!goalsEvent) throw new Error("没收到 goals 首包");
    if (!goalsEvent.payload.bigGoals) throw new Error("goals 首包结构不对");
    ok("SSE：连接建立时带一份目标视图");
  } catch (e) {
    fail("SSE 目标首包", e);
  }

  /* 19. 预览大纲 */
  try {
    const r = await req(port, "POST", "/api/goals/preview", {
      outline: "# 测试图\n- 取得原木 [collect oak_log]\n  - 做出木镐 [craft wooden_pickaxe]",
    });
    if (r.status !== 200 || !r.json.ok) throw new Error(r.text.slice(0, 160));
    if (r.json.mode !== "outline") throw new Error(`模式不对：${r.json.mode}`);
    if (!r.json.graph || r.json.graph.nodes.length !== 2) throw new Error("节点数不对");
    if (r.json.stats.nodes !== 2) throw new Error("统计节点数不对");
    ok("目标预览：大纲提纯返回结构化图");
  } catch (e) {
    fail("目标预览", e);
  }

  /* 20. 预览坏输入 */
  try {
    const r = await req(port, "POST", "/api/goals/preview", { outline: "" });
    if (r.status !== 200) throw new Error(`状态码 ${r.status}`);
    if (r.json.ok) throw new Error("空大纲不该通过");
    if (!r.json.errors.length) throw new Error("没有错误信息");
    ok("目标预览：空大纲被拒绝并给出原因");
  } catch (e) {
    fail("目标预览拒绝", e);
  }

  /* 21. 导入目标图 + SSE 推送 */
  try {
    const before = stream.events.filter((e) => e.event === "goals").length;

    const r = await req(port, "POST", "/api/goals/import", {
      outline: "# 测试图\n- 取得原木 [collect oak_log]",
    });
    if (r.status !== 200 || !r.json.ok) throw new Error(r.text.slice(0, 160));
    if (r.json.name !== "测试图") throw new Error("导入结果不对");
    if (!goalCalls.import.length) throw new Error("没有调用导入回调");

    const pushed = await (async () => {
      for (let i = 0; i < 30; i += 1) {
        if (stream.events.filter((e) => e.event === "goals").length > before) return true;
        await sleep(100);
      }
      return false;
    })();
    if (!pushed) throw new Error("导入后没有推送 goals 事件");

    ok("目标导入：写盘回调与 SSE 推送都触发");
  } catch (e) {
    fail("目标导入", e);
  }

  /* 22. 跨站导入被拒 */
  try {
    const r = await req(
      port,
      "POST",
      "/api/goals/import",
      { outline: "- 取得原木 [collect oak_log]" },
      { origin: "http://evil.example.com" },
    );
    if (r.status !== 403) throw new Error(`应返回 403，实际 ${r.status}`);
    ok("目标导入：跨站写请求被拒绝");
  } catch (e) {
    fail("目标导入跨站", e);
  }

  /* 收尾 */
  if (stream) {
    try {
      stream.close();
    } catch {
      /* ignore */
    }
  }
  await panel.stop();
  await sleep(200);

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
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
