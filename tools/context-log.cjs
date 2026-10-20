"use strict";

/**
 * 上下文日志生成器 —— 每完成一个任务，整份覆写 CONTEXT.md
 *
 * 为什么是「覆写」而不是「追加」：
 *   追加式日志会越来越长，最后没人读，模型读它更烧 token。
 *   覆写式只保留最新状态，每一份都完整可用，历史交给 git（如果以后开仓库）或 zip 快照。
 *
 * 用法：
 *   node tools/context-log.cjs                     # 用默认值生成
 *   node tools/context-log.cjs --task "本能层验证" --done "10/10 通过" --next "技能层"
 *   node tools/context-log.cjs --json "path.json"  # 从 JSON 读完整字段
 *
 * 设计纪律：
 *   - 只跑本地文件操作，不网络请求、不 spawn 子进程
 *   - 生成结果必须短：控制在 6KB 内，因为它要进下一轮对话的上下文
 *   - 事实优先：所有状态字段都来自真实检查，不接受「大概」「应该」
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const OUT_FILE = path.join(root, "CONTEXT.md");
const MAX_BYTES = 6 * 1024;

/** 解析 --key value 形式的参数 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/* ---------------------------- 采集真实状态 ---------------------------- */

/** 读 manifest 拿版本号 */
function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

/** 统计源码与工具文件，作为「代码规模」的事实 */
function countFiles() {
  const src = path.join(root, "src");
  const tools = path.join(root, "tools");
  const list = (dir) => {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith(".cjs")).length;
    } catch {
      return 0;
    }
  };
  return { src: list(src), tools: list(tools) };
}

/**
 * 不参与同步比对的目录：测试产物、依赖、版本库
 * 这些不是「插件代码」，混进来会让同步状态永远显示不一致。
 */
const IGNORE_DIRS = new Set([".closed-loop-data", "node_modules", ".git"]);

/** 检查源码与安装目录是否一致（返回差异文件名列表） */
function compareInstalled() {
  const installed = path.join(
    process.env.APPDATA || "",
    "Cyrene",
    "plugins",
    "cyrene-craft",
  );

  if (!fs.existsSync(installed)) return { installed: false, diffs: [], missing: [] };

  const walk = (dir, base = "") => {
    const out = [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name)) continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(full, rel));
      else out.push(rel);
    }
    return out;
  };

  const files = walk(root);
  const diffs = [];
  const missing = [];

  for (const rel of files) {
    const srcFile = path.join(root, rel);
    const dstFile = path.join(installed, rel.split("/").join(path.sep));
    if (!fs.existsSync(dstFile)) {
      missing.push(rel);
      continue;
    }
    try {
      const a = fs.readFileSync(srcFile);
      const b = fs.readFileSync(dstFile);
      if (!a.equals(b)) diffs.push(rel);
    } catch {
      diffs.push(rel);
    }
  }

  return { installed: true, diffs, missing };
}

/* ---------------------------- 组装日志 ---------------------------- */

function buildMarkdown(input) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const files = countFiles();
  const sync = compareInstalled();

  const lines = [];
  lines.push("# 上下文日志 · cyrene-craft");
  lines.push("");
  lines.push(`> 最后更新：${stamp}　·　版本 v${readVersion()}`);
  lines.push("> 本文件由 `tools/context-log.cjs` 整份覆写，不追加。");
  lines.push("");

  lines.push("## 当前状态");
  lines.push("");
  lines.push(input.status || "（未填写）");
  lines.push("");

  lines.push("## 本轮完成");
  lines.push("");
  if (Array.isArray(input.done) && input.done.length) {
    for (const item of input.done) lines.push(`- ${item}`);
  } else {
    lines.push("- （无）");
  }
  lines.push("");

  lines.push("## 验证证据");
  lines.push("");
  if (Array.isArray(input.verify) && input.verify.length) {
    for (const item of input.verify) lines.push(`- ${item}`);
  } else {
    lines.push("- （本轮没有跑验证）");
  }
  lines.push("");

  lines.push("## 代码同步状态");
  lines.push("");
  if (!sync.installed) {
    lines.push("⚠ 安装目录不存在，插件还没装。");
  } else if (!sync.diffs.length && !sync.missing.length) {
    lines.push("✔ 源码与安装目录完全一致。");
  } else {
    if (sync.missing.length) lines.push(`⚠ 安装目录缺 ${sync.missing.length} 个文件：${sync.missing.slice(0, 5).join("、")}`);
    if (sync.diffs.length) lines.push(`⚠ ${sync.diffs.length} 个文件不一致：${sync.diffs.slice(0, 5).join("、")}`);
    lines.push("");
    lines.push("**需要重新同步**：改完记得跑一次同步命令。");
  }
  lines.push("");

  lines.push("## 代码规模");
  lines.push("");
  lines.push(`- src/ ${files.src} 个模块　·　tools/ ${files.tools} 个脚本`);
  lines.push("");

  lines.push("## 下一步");
  lines.push("");
  if (Array.isArray(input.next) && input.next.length) {
    input.next.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
  } else {
    lines.push("1. （未指定）");
  }
  lines.push("");

  if (input.notes) {
    lines.push("## 备注");
    lines.push("");
    lines.push(input.notes);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## 复现命令");
  lines.push("");
  lines.push("```bash");
  lines.push('cd "E:\\Cyrene work\\cyrene-craft\\cyrene-craft"');
  lines.push("");
  lines.push("# ---- 离线测试（不连服务器，秒级） ----");
  lines.push("node tools/smoke.cjs            # 契约冒烟     13 项");
  lines.push("node tools/e2e.cjs              # 链路联调     12 项");
  lines.push("node tools/instinct-test.cjs    # 本能层单元   14 项");
  lines.push("node tools/trace-test.cjs       # 轨迹录制     11 项");
  lines.push("node tools/skill-test.cjs       # 技能层       17 项");
  lines.push("node tools/insight-test.cjs     # L2 归因      18 项");
  lines.push("node tools/intent-test.cjs      # 意图层       11 项");
  lines.push("node tools/panel-test.cjs       # 训练面板     17 项");
  lines.push("node tools/graph-test.cjs       # 类脑决策层   33 项");
  lines.push("node tools/brain-loop-test.cjs  # 执行环       43 项");
  lines.push("node tools/brain3d-test.cjs     # 3D 脑图      25 项");
  lines.push("node tools/brain-panel-test.cjs # 脑图接口     23 项");
  lines.push("node tools/brain-geometry-test.cjs # 3D坐标分区  22 项");
  lines.push("node tools/reflex-test.cjs      # 反射层       30 项");
  lines.push("node tools/channel-reflex-test.cjs # 反射接线     6 项");
  lines.push("node tools/tradition-test.cjs   # 流派提纯     24 项");
  lines.push("node tools/muscle-test.cjs      # 肌肉记忆     13 项");
  lines.push("node tools/autoplay-test.cjs    # 自主驱动     25 项");
  lines.push("node tools/goal-test.cjs        # 目标层       31 项");
  lines.push("node tools/goal-plan-test.cjs   # 目标规划     15 项");
  lines.push("node tools/goal-graph-test.cjs  # 目标图       13 项");
  lines.push("node tools/terrain-test.cjs     # 地形感知     10 项");
  lines.push("node tools/route-memory-test.cjs # 路线记忆     9 项");
  lines.push("node tools/route-tradition-test.cjs # 路线流派   4 项");
  lines.push("");
  lines.push("# ---- 真连测试（会真的进服务器） ----");
  lines.push("node tools/instinct-live.cjs 127.0.0.1 63839 Cyrene     # 本能层真连 10 项");
  lines.push("node tools/live-connect.cjs 127.0.0.1 63839 Cyrene      # 世界读写真连 13 项");
  lines.push("node tools/skill-live.cjs 127.0.0.1 63839 Cyrene        # 技能层实测 12 项");
  lines.push("node tools/skill-closed-loop.cjs 127.0.0.1 63839 Cyrene # 完整闭环 12 项");
  lines.push("node tools/autoplay-live.cjs 127.0.0.1 63839 CyreneAuto # 自主驱动真连（只读）");
  lines.push("node tools/terrain-live.cjs 127.0.0.1 63839 CyreneAuto # 地形真连（采 1 个）");
  lines.push("");
  lines.push("# ---- 工具 ----");
  lines.push("node tools/ping-check.cjs 127.0.0.1 63839   # 探一次服务器");
  lines.push("node tools/panel-serve.cjs                   # 独立起训练面板 16051");
  lines.push("node tools/context-log.cjs --status \"...\"    # 覆写本文件");
  lines.push("```");
  lines.push("");

  let text = lines.join("\n");

  // 超长就截断备注区，保住核心字段
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    text = text.slice(0, MAX_BYTES - 200) + "\n\n（内容超长已截断，请精简备注）\n";
  }

  return text;
}

/* ---------------------------- 主流程 ---------------------------- */

let input = {};

if (typeof args.json === "string") {
  try {
    input = JSON.parse(fs.readFileSync(path.resolve(args.json), "utf8"));
  } catch (e) {
    console.error(`读 JSON 失败：${e.message}`);
    process.exit(1);
  }
}

// 命令行参数覆盖 JSON
if (typeof args.task === "string") input.status = args.task;
if (typeof args.status === "string") input.status = args.status;
if (typeof args.done === "string") input.done = args.done.split("|").map((s) => s.trim()).filter(Boolean);
if (typeof args.verify === "string") input.verify = args.verify.split("|").map((s) => s.trim()).filter(Boolean);
if (typeof args.next === "string") input.next = args.next.split("|").map((s) => s.trim()).filter(Boolean);
if (typeof args.notes === "string") input.notes = args.notes;

const markdown = buildMarkdown(input);
fs.writeFileSync(OUT_FILE, markdown, "utf8");

const size = Buffer.byteLength(markdown, "utf8");
console.log(`已覆写 ${path.relative(root, OUT_FILE)}（${size} 字节）`);
