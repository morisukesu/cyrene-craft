"use strict";

/**
 * 反射层接线测试（离线）
 *
 * 不打真实服务器：用假 bridge 模拟「玩家在游戏里说话」，
 * 验证 channel 的前置拦截走的是和线上同一条代码路径。
 *
 * 覆盖：
 *   1. 命中并执行成功 → 不投递模型，回复玩家
 *   2. 开关关闭 → 回到原来的点名逻辑
 *   3. 执行失败 → 强制投递给模型接手
 *   4. 安全门禁拒绝 → 不执行
 *   5. 否定句 → 不命中
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SkillStore } = require("../src/skill-store.cjs");
const { SkillRunner } = require("../src/skill-runner.cjs");
const { MinecraftChannelAdapter } = require("../src/channel.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpRoot = path.join(os.tmpdir(), `cyrene-channel-reflex-${process.pid}`);

/** 假 bridge：记录所有出站请求，允许手动触发入站聊天 */
function makeBridge(opts = {}) {
  let chatHandler = null;
  const requests = [];

  return {
    requests,
    onChat(cb) {
      chatHandler = cb;
      return () => {
        chatHandler = null;
      };
    },
    onEvent() {
      return () => {};
    },
    status() {
      return {
        username: "Cyrene",
        state: opts.connected === false ? "disconnected" : "connected",
        host: "127.0.0.1",
        port: 63839,
        health: 20,
        food: 20,
      };
    },
    request(cmd, args, kind) {
      requests.push({ cmd, args, kind });

      if (cmd === "sequence") {
        const failed = opts.sequenceFailed ? 1 : 0;
        return Promise.resolve({
          total: 1,
          done: failed ? 0 : 1,
          failed,
          results: [
            {
              index: 0,
              ok: !failed,
              cmd: "collect",
              error: failed ? "附近没有橡木" : undefined,
            },
          ],
        });
      }

      return Promise.resolve({ ok: true });
    },
    fire(player, message) {
      if (chatHandler) chatHandler(player, message, { at: Date.now() });
    },
  };
}

/** 造一个已经练熟的采集技能 */
function seedChopSkill(store) {
  return store.save("chop_oak", {
    description: "采集 橡木",
    intent: "Mine oak_log",
    steps: [{ cmd: "collect", args: { block: "oak_log", count: 3 } }],
    stats: { runs: 10, success: 10, fail: 0, durations: [1200], lastRunAt: null },
    safety: { idempotent: false, whitelist: true, maxDurationMs: 30000 },
  });
}

/** 启动 channel，收集投递给模型的消息 */
async function startChannel(bridge, store, settings) {
  const runner = new SkillRunner({
    store,
    request: (cmd, args, kind) => bridge.request(cmd, args, kind),
    log: () => {},
  });

  const channel = new MinecraftChannelAdapter({
    bridge,
    getSettings: () => settings,
    getSkillStore: () => store,
    skillRunner: runner,
    trace: null,
    log: () => {},
  });

  const delivered = [];
  channel.onMessage = async (msg) => {
    delivered.push(msg);
  };

  await channel.start();
  return { channel, delivered };
}

(async () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  const skillsDir = path.join(tmpRoot, "skills");
  const store = new SkillStore({ rootDir: skillsDir, log: () => {} });
  seedChopSkill(store);

  /* 1. 命中并执行成功：不惊动模型 */
  try {
    const bridge = makeBridge();
    const settings = { reflexEnabled: true, mentions: ["昔涟"], respondToAll: false, reflexMinConfidence: 0.72 };
    const { delivered } = await startChannel(bridge, store, settings);

    bridge.fire("Mori", "砍点木头");
    await sleep(80);

    const seq = bridge.requests.find((r) => r.cmd === "sequence");
    const say = bridge.requests.find((r) => r.cmd === "say");

    if (delivered.length !== 0) throw new Error(`不应投递模型，实际 ${delivered.length} 条`);
    if (!seq) throw new Error(`没有执行技能，出站请求：${JSON.stringify(bridge.requests)}`);
    if (!say) throw new Error("执行成功后没有回复玩家");
    ok("命中并执行成功：不投递模型，直接执行并回复");
  } catch (e) {
    fail("命中并执行成功", e);
  }

  /* 2. 开关关闭：回到点名逻辑 */
  try {
    const bridge = makeBridge();
    const settings = { reflexEnabled: false, mentions: ["昔涟"], respondToAll: false, reflexMinConfidence: 0.72 };
    const { delivered } = await startChannel(bridge, store, settings);

    bridge.fire("Mori", "昔涟，砍点木头");
    await sleep(80);

    const seq = bridge.requests.find((r) => r.cmd === "sequence");
    if (delivered.length !== 1) throw new Error(`应投递 1 条，实际 ${delivered.length}`);
    if (seq) throw new Error("开关关闭时不应执行技能");
    ok("开关关闭：点名消息照常投递模型，不执行技能");
  } catch (e) {
    fail("开关关闭", e);
  }

  /* 3. 执行失败：强制投递模型接手 */
  try {
    const bridge = makeBridge({ sequenceFailed: true });
    const settings = { reflexEnabled: true, mentions: ["昔涟"], respondToAll: false, reflexMinConfidence: 0.72 };
    const { delivered } = await startChannel(bridge, store, settings);

    bridge.fire("Mori", "砍点木头");
    await sleep(80);

    const seq = bridge.requests.find((r) => r.cmd === "sequence");
    if (!seq) throw new Error("应尝试执行技能");
    if (delivered.length !== 1) throw new Error(`失败时应投递模型，实际 ${delivered.length} 条`);
    ok("执行失败：强制投递给模型，不让玩家干等");
  } catch (e) {
    fail("执行失败回落", e);
  }

  /* 4. 安全门禁：含 say 的技能不自动执行 */
  try {
    const unsafeStore = new SkillStore({ rootDir: path.join(tmpRoot, "unsafe-skills"), log: () => {} });
    unsafeStore.save("chat_skill", {
      description: "说句话",
      steps: [{ cmd: "say", args: { message: "hi" } }],
      triggers: { version: 2, words: ["砍", "木头"], regex: [], context: {} },
      stats: { runs: 10, success: 10, fail: 0, durations: [], lastRunAt: null },
      safety: { idempotent: false, whitelist: true, maxDurationMs: 30000 },
    });

    const bridge = makeBridge();
    const settings = { reflexEnabled: true, mentions: ["昔涟"], respondToAll: false, reflexMinConfidence: 0.72 };
    const { delivered } = await startChannel(bridge, unsafeStore, settings);

    bridge.fire("Mori", "砍点木头");
    await sleep(80);

    const seq = bridge.requests.find((r) => r.cmd === "sequence");
    if (seq) throw new Error("含 say 的技能不应自动执行");
    if (delivered.length !== 0) throw new Error("没点名时不应投递模型");
    ok("安全门禁：含 say 的技能不自动执行");
  } catch (e) {
    fail("安全门禁", e);
  }

  /* 5. 否定句不命中 */
  try {
    const bridge = makeBridge();
    const settings = { reflexEnabled: true, mentions: ["昔涟"], respondToAll: false, reflexMinConfidence: 0.72 };
    const { delivered } = await startChannel(bridge, store, settings);

    bridge.fire("Mori", "不要砍树");
    await sleep(80);

    const seq = bridge.requests.find((r) => r.cmd === "sequence");
    if (seq) throw new Error("否定句不应执行技能");
    if (delivered.length !== 0) throw new Error("没点名时不应投递模型");
    ok("否定句：不要砍树 → 不命中、不执行");
  } catch (e) {
    fail("否定句", e);
  }

  /* 6. 未连接时上下文门禁 */
  try {
    const gatedStore = new SkillStore({ rootDir: path.join(tmpRoot, "gated-skills"), log: () => {} });
    gatedStore.save("chop_gated", {
      description: "采集 橡木",
      intent: "Mine oak_log",
      steps: [{ cmd: "collect", args: { block: "oak_log", count: 3 } }],
      triggers: { version: 2, words: ["砍", "木头"], regex: [], context: { requireConnected: true } },
      stats: { runs: 10, success: 10, fail: 0, durations: [], lastRunAt: null },
      safety: { idempotent: false, whitelist: true, maxDurationMs: 30000 },
    });

    const bridge = makeBridge({ connected: false });
    const settings = { reflexEnabled: true, mentions: ["昔涟"], respondToAll: false, reflexMinConfidence: 0.72 };
    const { delivered } = await startChannel(bridge, gatedStore, settings);

    bridge.fire("Mori", "砍点木头");
    await sleep(80);

    const seq = bridge.requests.find((r) => r.cmd === "sequence");
    if (seq) throw new Error("未连接时不应执行要求连接的门禁技能");
    if (delivered.length !== 0) throw new Error("没点名时不应投递模型");
    ok("上下文门禁：未连接时 requireConnected 技能不执行");
  } catch (e) {
    fail("上下文门禁接线", e);
  }

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
