"use strict";

/**
 * 轨迹录制（L0 表层）单元测试
 *
 * 验证七件事：
 *   1. 记录能正确落盘
 *   2. 参数被压缩（超长字符串不写内容）
 *   3. episode 按时间间隔正确切分
 *   4. 只挑成功且非 skill 发起的轨迹用于编译
 *   5. 文件超限会滚动归档
 *   6. 归档数量受限
 *   7. 磁盘不可写时不抛错（旁路纪律）
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { TraceLogger, EPISODE_GAP_MS, MAX_ARCHIVES } = require("../src/trace.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

const tmpRoot = path.join(os.tmpdir(), `cyrene-trace-test-${process.pid}`);
const traceDir = path.join(tmpRoot, "traces");

/** 等异步写盘落完 */
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

function makeLogger() {
  return new TraceLogger({ dir: traceDir, log: () => {}, enabled: true });
}

function readCurrent() {
  const file = path.join(traceDir, "current.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

(async () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  /* 1. 落盘 */
  try {
    const trace = makeLogger();
    trace.record({ tool: "collect", args: { block: "oak_log", count: 8 }, ok: true, ms: 1234 });
    await settle();

    const rows = readCurrent();
    if (rows.length !== 1) throw new Error(`期望 1 条记录，实际 ${rows.length}`);
    const row = rows[0];
    if (row.tool !== "collect") throw new Error(`tool 错了：${row.tool}`);
    if (row.ok !== true) throw new Error("ok 应该是 true");
    if (row.ms !== 1234) throw new Error(`ms 错了：${row.ms}`);
    if (row.origin !== "llm") throw new Error(`默认 origin 应该是 llm，实际 ${row.origin}`);
    if (!row.ts) throw new Error("缺少 ts");
    ok("记录正确落盘（含 ts / tool / ok / ms / origin）");
  } catch (e) {
    fail("记录正确落盘", e);
  }

  /* 1b. origin 三档：autopilot 必须原样保留 */
  try {
    const trace = makeLogger();
    trace.record({ tool: "collect", args: { block: "oak_log" }, ok: false, ms: 900, origin: "autopilot" });
    trace.record({ tool: "craft", args: { item: "oak_planks" }, ok: true, ms: 10, origin: "skill" });
    await settle();

    const rows = readCurrent();
    // 文件是累积的，前面测试也写过 collect / craft，要取最后一条才是这次写的
    const auto = rows.filter((r) => r.tool === "collect").pop();
    const skill = rows.filter((r) => r.tool === "craft").pop();

    // autopilot 被降级成 llm 的话，执行环的失败会混进模型轨迹里，
    // 以后想区分「谁做的」就分不出来了
    if (auto.origin !== "autopilot") throw new Error(`autopilot 被改写成 ${auto.origin}`);
    if (skill.origin !== "skill") throw new Error(`skill 被改写成 ${skill.origin}`);
    if (auto.ok !== false) throw new Error("失败标记丢了");

    ok("origin 三档分明：llm / skill / autopilot");
  } catch (e) {
    fail("origin 三档分明", e);
  }

  /* 2. 参数压缩 */
  try {
    const trace = makeLogger();
    const huge = "x".repeat(2000);
    trace.record({
      tool: "fs",
      args: { path: "a.md", content: huge, nested: { deep: { deeper: { deepest: "y" } } } },
      ok: true,
      ms: 10,
    });
    await settle();

    const row = readCurrent().find((r) => r.tool === "fs");
    if (!row) throw new Error("没有找到 fs 记录");
    if (typeof row.args.content !== "string") throw new Error("content 应该是字符串占位");
    if (!row.args.content.includes("chars")) throw new Error(`超长字符串应被压成占位，实际：${row.args.content}`);
    if (row.args.content.includes("xxxx")) throw new Error("超长内容不应被写入");
    ok("超长参数被压缩，不写原始内容");
  } catch (e) {
    fail("超长参数被压缩", e);
  }

  /* 3. episode 切分 */
  try {
    const trace = makeLogger();
    trace.clearRecent();

    // 手工塞时间戳：三段，每段内部间隔小，段间间隔大
    const base = Date.now();
    const push = (offset, tool) =>
      trace.recent.push({ ts: base + offset, tool, args: {}, ok: true, ms: 1, origin: "llm" });

    push(0, "scan");
    push(1000, "move");
    push(2000, "collect"); // 第一段终点

    const seg2 = 2000 + EPISODE_GAP_MS + 1;
    push(seg2, "scan");
    push(seg2 + 2000, "collect"); // 第二段终点

    // 第三段：必须与第二段终点相隔 > GAP，否则会被并进同一段
    push(seg2 + 2000 + EPISODE_GAP_MS + 1, "say");

    const eps = trace.episodes(20);
    if (eps.length !== 3) throw new Error(`期望 3 段，实际 ${eps.length}`);
    // 最新的 episode 排在后，第一段（最早）在最前
    if (eps[0].length !== 3) throw new Error(`第一段应有 3 条，实际 ${eps[0].length}`);
    if (eps[2].length !== 1) throw new Error(`第三段应有 1 条，实际 ${eps[2].length}`);
    ok("episode 按 15 秒间隔正确切分");
  } catch (e) {
    fail("episode 按 15 秒间隔正确切分", e);
  }

  /* 4. 编译候选筛选 */
  try {
    const trace = makeLogger();
    trace.clearRecent();

    const base = Date.now();
    const push = (offset, tool, okFlag, origin) =>
      trace.recent.push({ ts: base + offset, tool, args: {}, ok: okFlag, ms: 1, origin });

    // 段1：成功，llm 发起 → 候选
    push(0, "scan", true, "llm");
    push(500, "collect", true, "llm");
    // 段2：失败 → 跳过
    push(EPISODE_GAP_MS * 3, "collect", false, "llm");
    // 段3：成功但由 skill 发起 → 跳过，避免自我循环
    push(EPISODE_GAP_MS * 6, "skill", true, "skill");
    push(EPISODE_GAP_MS * 6 + 500, "collect", true, "skill");
    // 段4：成功，llm 发起 → 最新候选
    push(EPISODE_GAP_MS * 9, "scan", true, "llm");
    push(EPISODE_GAP_MS * 9 + 500, "collect", true, "llm");

    const ep = trace.latestCompilableEpisode(2);
    if (!ep) throw new Error("应该找到可编译 episode");
    if (ep[0].tool !== "scan") throw new Error(`应取最新一段，实际起点是 ${ep[0].tool}`);
    if (ep.some((r) => r.origin === "skill")) throw new Error("不应选中 skill 发起的轨迹");
    ok("只挑成功且非 skill 发起的最近 episode");
  } catch (e) {
    fail("只挑成功且非 skill 发起的最近 episode", e);
  }

  /* 5. 文件滚动 */
  try {
    fs.rmSync(traceDir, { recursive: true, force: true });
    // 把上限压到 2KB，用小数据就能触发滚动
    const trace = new TraceLogger({ dir: traceDir, log: () => {}, enabled: true, maxFileBytes: 2048 });
    const big = "z".repeat(400);
    for (let i = 0; i < 30; i += 1) {
      trace.record({ tool: `t${i}`, args: { pad: big }, ok: true, ms: 1 });
      await settle(15);
    }
    await settle(300);

    const archives = fs.readdirSync(traceDir).filter((f) => f.startsWith("archive-"));
    if (!archives.length) throw new Error("没有产生归档文件");
    ok(`文件超限触发滚动（产生 ${archives.length} 个归档）`);
  } catch (e) {
    fail("文件超限触发滚动", e);
  }

  /* 6. 归档数量受限 */
  try {
    const archives = fs.readdirSync(traceDir).filter((f) => f.startsWith("archive-"));
    if (archives.length > MAX_ARCHIVES) {
      throw new Error(`归档数 ${archives.length} 超过上限 ${MAX_ARCHIVES}`);
    }
    ok(`归档数量不超过 ${MAX_ARCHIVES} 个`);
  } catch (e) {
    fail("归档数量受限", e);
  }

  /* 7. 磁盘不可写时不抛错 */
  try {
    // 让目录路径指向一个「父级是普通文件」的位置，create 必然失败
    const blocker = path.join(tmpRoot, "blocker-file");
    fs.writeFileSync(blocker, "not a dir");
    const badDir = path.join(blocker, "traces");

    const errors = [];
    const trace = new TraceLogger({ dir: badDir, log: (m) => errors.push(m), enabled: true });

    let threw = false;
    try {
      trace.record({ tool: "collect", args: {}, ok: true, ms: 1 });
      await settle(150);
    } catch {
      threw = true;
    }
    if (threw) throw new Error("轨迹录制不应向调用方抛错");
    // 应当在内部记下失败，而不是静默吞掉所有信息
    if (!errors.length) throw new Error("写入失败时应有日志记录");
    ok("目录不可用时静默失败，不抛错");
  } catch (e) {
    fail("目录不可用时静默失败", e);
  }

  /* 8. 关闭开关后不记录 */
  try {
    const trace = new TraceLogger({ dir: traceDir, log: () => {}, enabled: false });
    trace.record({ tool: "collect", args: {}, ok: true, ms: 1 });
    await settle(80);
    if (trace.snapshot().length !== 0) throw new Error("关闭后仍记录了");
    ok("enabled=false 时完全不记录");
  } catch (e) {
    fail("enabled=false 时完全不记录", e);
  }

  /* sequence 展开成实际动作：否则编译器只能看到一层包装 */
  try {
    const trace = makeLogger();
    trace.clearRecent();
    trace.record({
      tool: "sequence",
      args: { steps: [{ cmd: "collect", args: { block: "oak_log", count: 4, radius: 16 } }] },
      ok: true,
      ms: 4500,
      origin: "llm",
    });
    await settle(80);

    const rows = trace.snapshot();
    if (rows.length !== 1) throw new Error(`一个动作应记 1 条，实际 ${rows.length}`);
    if (rows[0].tool !== "collect") throw new Error(`工具名应是 collect，实际 ${rows[0].tool}`);
    if (rows[0].args.block !== "oak_log") throw new Error("参数丢了");
    if (rows[0].ms !== 4500) throw new Error(`单动作应保留耗时，实际 ${rows[0].ms}`);
    ok("sequence 展开成实际动作（记 collect，不再记包装层）");
  } catch (e) {
    fail("sequence 展开成实际动作", e);
  }

  /* 多步 sequence：逐步成条，且不编造单步耗时 */
  try {
    const trace = makeLogger();
    trace.clearRecent();
    trace.record({
      tool: "sequence",
      args: {
        steps: [
          { cmd: "dig", args: { x: 1, y: 2, z: 3 } },
          { cmd: "dig", args: { x: 1, y: 2, z: 4 } },
          { cmd: "act", args: { action: "equip", item: "iron_pickaxe" } },
        ],
      },
      ok: true,
      ms: 900,
      origin: "llm",
    });
    await settle(80);

    const rows = trace.snapshot();
    if (rows.length !== 3) throw new Error(`三步应记 3 条，实际 ${rows.length}`);
    if (rows.map((r) => r.tool).join(",") !== "dig,dig,act") {
      throw new Error(`动作顺序不对：${rows.map((r) => r.tool).join(",")}`);
    }
    if (rows.some((r) => r.ms !== 0)) throw new Error("多步无法分摊耗时，不该编数字");
    ok("多步 sequence 逐步成条，耗时留空不编造");
  } catch (e) {
    fail("多步 sequence 展开", e);
  }

  /* 嵌套 sequence 也要摊平，且不无限递归 */
  try {
    const trace = makeLogger();
    trace.clearRecent();
    trace.record({
      tool: "sequence",
      args: {
        steps: [
          {
            cmd: "sequence",
            args: { steps: [{ cmd: "collect", args: { block: "oak_log", count: 1 } }] },
          },
        ],
      },
      ok: true,
      ms: 100,
    });
    await settle(80);

    const rows = trace.snapshot();
    if (rows.length !== 1) throw new Error(`嵌套一层应摊平为 1 条，实际 ${rows.length}`);
    if (rows[0].tool !== "collect") throw new Error(`应摊到 collect，实际 ${rows[0].tool}`);
    ok("嵌套 sequence 递归摊平到最内层动作");
  } catch (e) {
    fail("嵌套 sequence 摊平", e);
  }

  /* 清理 */
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
