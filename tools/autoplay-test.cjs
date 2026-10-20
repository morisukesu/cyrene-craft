"use strict";

/**
 * 自主驱动（AutoPlayDriver）单元测试
 *
 * 覆盖：
 *   1. 开关关闭不启动
 *   2. 开关打开后启动
 *   3. 断线自停
 *   4. 正在执行任务时让路
 *   5. 低血让路
 *   6. 低饥饿让路
 *   7. 玩家说话后暂停
 *   8. 附近有玩家时暂停
 *   9. 冷启动第一步
 *  10. scan 结果进入方块提示
 *  11. 肌肉命中直接执行
 *  12. 肌肉失效时回落图
 *  13. 图里有轨迹时走图
 *  14. 单 tick 只执行一步
 *  15. 写 trace 带 origin=autoplay
 *  16. 达到运行预算停止
 *  17. 长时间无事可做停止
 *  18. 连续成功后固化技能
 *  19. 手动 once 不受开关限制
 *  20. 默认冷启动序列非空
 *  21. 失败冷却：失败动作不会被立刻重试
 *
 * 全部离线：假 bridge + 假 trace + 临时目录里的真 Muscle。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AutoPlayDriver, DEFAULT_BOOTSTRAP } = require("../src/autoplay.cjs");
const { Muscle } = require("../src/muscle.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

/* ------------------------------ 测试替身 ------------------------------ */

function makeBridge(initial = {}) {
  let status = {
    state: "connected",
    health: 20,
    food: 20,
    dimension: "overworld",
    time: { isDay: true },
    position: { x: 0, y: 64, z: 0 },
    inventory: [],
    players: [],
    currentTask: null,
    ...initial,
  };

  const calls = [];
  const handlers = new Map();

  return {
    calls,
    handlers,
    setStatus(patch) {
      status = { ...status, ...patch };
    },
    status() {
      return status;
    },
    isRunning() {
      return status.state !== "disconnected";
    },
    async request(tool, args) {
      calls.push({ tool, args });
      const handler = handlers.get(tool);
      if (handler) return handler(args);
      return { ok: true };
    },
  };
}

function makeTrace(rows = []) {
  const recorded = [];
  return {
    rows,
    recorded,
    snapshot: () => rows,
    record: (entry) => recorded.push(entry),
    latestCompilableEpisode: () =>
      rows.filter((r) => r && r.origin !== "skill" && r.origin !== "reflex").slice(-3),
  };
}

/** 背包数组 */
function inv(items) {
  return Object.entries(items).map(([name, count]) => ({ name, count }));
}

function makeStore() {
  return {
    saved: [],
    get: () => null,
    // 和 SkillStore 的真实签名一致：技能名单独传。
    // 如果假实现写成 save(skill)，真实实现里少传名字的 bug 会被这层盖住。
    save(name, skill) {
      if (typeof name !== "string" || !name) throw new Error("save 缺少技能名");
      const row = { name, ...skill };
      this.saved.push(row);
      return row;
    },
  };
}

function makeRunner(result = { ok: true, durationMs: 12 }) {
  return {
    calls: [],
    async run(name) {
      this.calls.push(name);
      return result;
    },
  };
}

function tempFile(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `autoplay-${tag}-`));
  return { dir, file: path.join(dir, "muscle.json") };
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 组一套 driver */
function setup(opts = {}) {
  const bridge = opts.bridge || makeBridge();
  const trace = opts.trace || makeTrace();
  const store = opts.store || makeStore();
  const runner = opts.runner || makeRunner();
  const { dir, file } = tempFile(opts.tag || "t");
  const muscle =
    opts.muscle === null
      ? null
      : new Muscle({
          file,
          // 测试里要能连续命中，关掉最短间隔；生产默认 3 秒
          config: { saveDebounceMs: 0, minIntervalMs: 0, minRuns: 1, minRate: 0, ttlMs: 60_000 },
          log: () => {},
        });

  const settings = {
    autoplayEnabled: true,
    autoplayTickMs: 50,
    autoplayMinHealth: 8,
    autoplayMinFood: 6,
    autoplayYieldMs: 8000,
    autoplayNearPlayerPause: 6,
    autoplayMaxRuntimeMs: 60_000,
    autoplayIdleTicks: 60,
    autoplayCompileAfter: 3,
    autoplayMuscle: true,
    autoplayBootstrap: [{ tool: "context", args: {} }],
    ...(opts.settings || {}),
  };

  const driver = new AutoPlayDriver({
    bridge,
    trace,
    getMuscle: () => muscle,
    getGoal: opts.getGoal ? () => opts.getGoal : () => null,
    getRouteMemory: opts.getRouteMemory ? () => opts.getRouteMemory : () => null,
    getSettings: () => settings,
    getSkillStore: () => store,
    skillRunner: runner,
    log: () => {},
  });

  return { driver, bridge, trace, store, runner, muscle, settings, dir, file };
}

function world(extra = {}) {
  return {
    dimension: "overworld",
    isDay: true,
    health: 20,
    food: 20,
    inventory: [],
    blocks: null,
    ...extra,
  };
}

/* ------------------------------ 主测试 ------------------------------ */

async function main() {
  /* 1. 开关关闭不启动 */
  {
    const { driver, dir } = setup({ settings: { autoplayEnabled: false } });
    const snap = driver.start("test");
    if (snap.running) throw new Error("开关关闭也启动了");
    if (driver.timer) throw new Error("开关关闭还留了定时器");
    driver.stop("end");
    cleanup(dir);
    ok("开关关闭：start 直接返回，不起定时器");
  }

  /* 2. 开关打开后启动 */
  {
    const { driver, dir } = setup();
    const snap = driver.start("test");
    if (!snap.running) throw new Error("开关打开却没启动");
    driver.stop("end");
    cleanup(dir);
    ok("启动：开关打开后 running=true，并带 tick 间隔");
  }

  /* 3. 断线自停 */
  {
    const { driver, bridge, dir } = setup();
    driver.start("test");
    bridge.setStatus({ state: "disconnected" });
    const r = await driver.tick();
    if (r && r.reason !== "连接断开") throw new Error(`原因不对：${JSON.stringify(r)}`);
    if (driver.running) throw new Error("断线后仍在运行");
    driver.stop("end");
    cleanup(dir);
    ok("断线自停：连接断开后 running=false");
  }

  /* 4. 正在执行任务时让路 */
  {
    const { driver, bridge, dir } = setup();
    driver.start("test");
    bridge.setStatus({ currentTask: "走向玩家 mori" });
    const r = await driver.tick();
    if (!r || !r.skipped) throw new Error(`没有跳过：${JSON.stringify(r)}`);
    if (bridge.calls.length) throw new Error("让路时仍然调用了 bridge");
    driver.stop("end");
    cleanup(dir);
    ok("让路：正在执行任务时不插嘴");
  }

  /* 5. 低血 */
  {
    const { driver, bridge, dir } = setup();
    driver.start("test");
    bridge.setStatus({ health: 4 });
    const r = await driver.tick();
    if (!r || !r.skipped) throw new Error("低血时仍然动了");
    driver.stop("end");
    cleanup(dir);
    ok("让路：血量低于阈值时交给本能层");
  }

  /* 6. 低饥饿 */
  {
    const { driver, bridge, dir } = setup();
    driver.start("test");
    bridge.setStatus({ food: 3 });
    const r = await driver.tick();
    if (!r || !r.skipped) throw new Error("低饥饿时仍然动了");
    driver.stop("end");
    cleanup(dir);
    ok("让路：饥饿低于阈值时交给本能层");
  }

  /* 7. 玩家说话后暂停 */
  {
    const { driver, dir } = setup();
    driver.start("test");
    driver.noteChat();
    const r = await driver.tick();
    if (!r || !r.skipped) throw new Error("刚说完话就动了");
    driver.stop("end");
    cleanup(dir);
    ok("让路：玩家说话后 yieldMs 内不动");
  }

  /* 8. 附近有玩家 */
  {
    const { driver, bridge, dir } = setup();
    driver.start("test");
    bridge.setStatus({
      players: [{ username: "mori", isSelf: false, position: { x: 2, y: 64, z: 0 } }],
    });
    const r = await driver.tick();
    if (!r || !r.skipped) throw new Error("玩家在旁边仍然动手");
    driver.stop("end");
    cleanup(dir);
    ok("让路：附近有玩家时不动手");
  }

  /* 9. 冷启动第一步 */
  {
    const { driver, bridge, dir } = setup();
    driver.start("test");
    const r = await driver.tick();
    if (!r || !r.ok) throw new Error(`冷启动没有执行成功：${JSON.stringify(r)}`);
    if (bridge.calls[0].tool !== "context") throw new Error(`第一步不是 context：${bridge.calls[0].tool}`);
    driver.stop("end");
    cleanup(dir);
    ok("冷启动：图里没边时先执行确定性动作");
  }

  /* 10. scan 结果进入方块提示 */
  {
    const bridge = makeBridge();
    bridge.handlers.set("scan", () => ({ block: "oak_log", count: 3, blocks: [] }));
    const { driver, dir } = setup({
      bridge,
      settings: { autoplayBootstrap: [{ tool: "scan", args: { block: "oak_log", radius: 16 } }] },
    });
    driver.start("test");
    await driver.tick();
    if (!driver.blockHint || driver.blockHint[0] !== "oak_log") {
      throw new Error(`方块提示没更新：${JSON.stringify(driver.blockHint)}`);
    }
    driver.stop("end");
    cleanup(dir);
    ok("scan 提示：扫描结果进入世界指纹");
  }

  /* 11. 肌肉命中直接执行 */
  {
    const { driver, bridge, muscle, dir } = setup();
    driver.start("test");
    for (let i = 0; i < 3; i++) {
      muscle.remember({ world: world(), current: "", tool: "collect", args: { block: "oak_log" }, ok: true });
    }

    const r = await driver.tick();
    if (!r || r.via !== "muscle") throw new Error(`没走肌肉：${JSON.stringify(r)}`);
    if (bridge.calls[0].tool !== "collect") throw new Error(`动作不对：${bridge.calls[0].tool}`);
    driver.stop("end");
    cleanup(dir);
    ok("肌肉直出：命中后直接执行缓存动作");
  }

  /* 12. 肌肉失效时回落图 */
  {
    const { driver, bridge, muscle, trace, dir } = setup();
    driver.start("test");
    muscle.remember({ world: world(), current: "", tool: "collect", args: { block: "oak_log" }, ok: false });

    trace.rows.push(
      { tool: "context", args: {}, ok: true, ms: 10, origin: "llm", at: Date.now() - 2000 },
      { tool: "scan", args: { block: "oak_log" }, ok: true, ms: 10, origin: "llm", at: Date.now() - 1000 },
    );

    const r = await driver.tick();
    if (!r || r.via === "muscle") throw new Error(`仍然走了肌肉：${JSON.stringify(r)}`);
    if (!bridge.calls.length) throw new Error("回落时什么都没做");
    driver.stop("end");
    cleanup(dir);
    ok("回落：肌肉成功率不足时改走图/冷启动");
  }

  /* 13. 图里有轨迹时走图 */
  {
    const { driver, trace, dir } = setup();
    driver.start("test");
    const now = Date.now();
    trace.rows.push(
      { tool: "context", args: {}, ok: true, ms: 10, origin: "llm", at: now - 3000 },
      { tool: "scan", args: { block: "oak_log" }, ok: true, ms: 10, origin: "llm", at: now - 2000 },
      { tool: "collect", args: { block: "oak_log", count: 4 }, ok: true, ms: 100, origin: "llm", at: now - 1000 },
    );
    const r = await driver.tick();
    if (!r || (r.via !== "graph" && r.via !== "bootstrap")) {
      throw new Error(`路径不对：${JSON.stringify(r)}`);
    }
    driver.stop("end");
    cleanup(dir);
    ok("图路径：有轨迹时由 skill-graph 给出下一步");
  }

  /* 14. 单 tick 只执行一步 */
  {
    const { driver, bridge, dir } = setup();
    driver.start("test");
    await driver.tick();
    if (bridge.calls.length !== 1) throw new Error(`一步里执行了 ${bridge.calls.length} 个动作`);
    driver.stop("end");
    cleanup(dir);
    ok("单步：一个 tick 只执行一个动作");
  }

  /* 15. trace origin=autoplay */
  {
    const { driver, trace, dir } = setup();
    driver.start("test");
    await driver.tick();
    const record = trace.recorded[trace.recorded.length - 1];
    if (!record || record.origin !== "autoplay") {
      throw new Error(`origin 不对：${JSON.stringify(record)}`);
    }
    driver.stop("end");
    cleanup(dir);
    ok("轨迹：自主执行写入 origin=autoplay");
  }

  /* 16. 达到运行预算停止 */
  {
    const { driver, dir } = setup({ settings: { autoplayMaxRuntimeMs: 0 } });
    driver.start("test");
    const r = await driver.tick();
    if (!r || r.reason !== "达到运行预算") throw new Error(`没有按预算停：${JSON.stringify(r)}`);
    if (driver.running) throw new Error("预算到点仍在运行");
    driver.stop("end");
    cleanup(dir);
    ok("预算：超过运行时长后自停");
  }

  /* 17. 长时间无事可做停止 */
  {
    const { driver, dir } = setup({
      // 关掉肌肉：这条测的是「没有下一步」时的收工，不希望 context 被反复直出
      settings: {
        autoplayBootstrap: [{ tool: "context", args: {} }],
        autoplayIdleTicks: 2,
        autoplayMuscle: false,
      },
    });
    driver.start("test");
    await driver.tick(); // 执行 context
    await driver.tick(); // idle 1
    await driver.tick(); // idle 2 -> stop
    if (driver.running) throw new Error("idle 到上限仍在运行");
    driver.stop("end");
    cleanup(dir);
    ok("空闲停止：连续无事可做就收工，不空转");
  }

  /* 18. 连续成功后固化技能 */
  {
    const trace = makeTrace([
      { tool: "collect", args: { block: "oak_log", count: 4 }, ok: true, ms: 100, origin: "llm" },
      { tool: "craft", args: { item: "oak_planks", count: 4 }, ok: true, ms: 100, origin: "llm" },
      { tool: "craft", args: { item: "stick", count: 4 }, ok: true, ms: 100, origin: "llm" },
    ]);
    const store = makeStore();
    const { driver, dir } = setup({ trace, store, settings: { autoplayCompileAfter: 1 } });
    driver.start("test");
    await driver.tick();
    if (!store.saved.length) throw new Error("没有固化技能");
    if (typeof store.saved[0].name !== "string" || !store.saved[0].name) {
      throw new Error("固化时没传技能名");
    }
    driver.stop("end");
    cleanup(dir);
    ok("技能固化：连续成功后编译并写入技能库");
  }

  /* 19. 手动 once 不受开关限制 */
  {
    const { driver, bridge, dir } = setup();
    driver.running = false;
    const r = await driver.once();
    if (!r || !r.ok) throw new Error(`once 没有执行：${JSON.stringify(r)}`);
    if (!bridge.calls.length) throw new Error("once 没有真的调用 bridge");
    cleanup(dir);
    ok("手动 once：不依赖定时器，直接跑一步");
  }

  /* 20. 默认冷启动序列非空 */
  {
    if (!Array.isArray(DEFAULT_BOOTSTRAP) || DEFAULT_BOOTSTRAP.length < 2) {
      throw new Error("默认冷启动序列太短，空图时会站着不动");
    }
    ok("默认冷启动：至少两步，空图也能动起来");
  }

  /* 21. 失败冷却：失败动作不会被冷启动立刻重试 */
  {
    const bridge = makeBridge();
    // complete:false 表示「跑完了但没做成」，这才是真实世界里的失败
    bridge.handlers.set("collect", () => ({
      ok: true,
      complete: false,
      reason: "找不到可到达的目标",
    }));

    const { driver, dir } = setup({
      bridge,
      settings: {
        autoplayBootstrap: [
          { tool: "collect", args: { block: "oak_log" } },
          { tool: "collect", args: { block: "oak_log" } },
        ],
        autoplayFailCooldownMs: 60_000,
        autoplayMuscle: false,
      },
    });

    driver.start("test");

    const first = await driver.tick();
    if (!first || first.ok) throw new Error("第一次失败没有被判成失败");
    if (!driver.snapshot().denied.includes("collect")) {
      throw new Error("失败后没有进冷却");
    }

    const second = await driver.tick();
    if (second && second.ok) throw new Error("第二次仍然执行了失败动作");

    const collectCalls = bridge.calls.filter((c) => c.tool === "collect").length;
    if (collectCalls !== 1) {
      throw new Error(`冷却期间又试了 collect：${collectCalls} 次`);
    }

    driver.stop("end");
    cleanup(dir);
    ok("失败冷却：失败动作进入冷却，冷启动不会立刻重试");
  }

  /* 22. 目标层接入：snapshot 带上当前目标 */
  {
    const { GoalTracker } = require("../src/goal.cjs");
    const goalTracker = new GoalTracker();

    const { driver, dir } = setup({
      getGoal: goalTracker,
      settings: {
        autoplayBootstrap: [{ tool: "context", args: {} }],
        autoplayMuscle: false,
      },
    });

    driver.start("test");
    await driver.tick();

    const snap = driver.snapshot();
    if (!snap.goal) throw new Error("snapshot 里没有目标状态");
    if (!snap.goal.current) throw new Error("没有生成当前目标");
    if (snap.goal.current.target !== "oak_log") {
      throw new Error(`目标不对：${snap.goal.current.target}`);
    }

    driver.stop("end");
    cleanup(dir);
    ok("目标层：snapshot 带上当前目标");
  }

  /* 23. 目标偏置：把相关动作顶到第一位 */
  {
    const { GoalTracker } = require("../src/goal.cjs");

    const goalTracker = new GoalTracker();
    // 直接塞一个 active 目标，这条测的是偏置而不是规则生成
    goalTracker.goals.push({
      id: "collect:oak_log",
      kind: "collect",
      target: "oak_log",
      count: 4,
      progress: 0,
      status: "active",
      priority: 40,
      source: "state",
      attempts: 0,
      failures: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      finishedAt: null,
      completedActions: [],
      blockedActions: [],
    });
    goalTracker.currentId = "collect:oak_log";

    // 从 sand 出发有两条边：oak_log 出现 2 次，dirt 出现 4 次。
    // 不偏置时 dirt 分数更高；木头目标应该把 oak_log 顶上来。
    const rows = [];
    let ts = Date.now() - 20_000;
    const push = (block) => {
      rows.push({ tool: "collect", args: { block }, ok: true, ms: 100, origin: "llm", ts, at: ts });
      ts += 1_000;
    };
    for (let i = 0; i < 2; i++) {
      push("sand");
      push("oak_log");
    }
    for (let i = 0; i < 4; i++) {
      push("sand");
      push("dirt");
    }

    const { driver, bridge, dir } = setup({
      trace: makeTrace(rows),
      getGoal: goalTracker,
      settings: {
        autoplayBootstrap: [{ tool: "collect", args: { block: "oak_log" } }],
        autoplayMuscle: false,
      },
    });

    driver.current = "collect:block=sand";
    driver.start("test");
    await driver.tick();

    const first = bridge.calls[0];
    if (!first || first.tool !== "collect" || first.args.block !== "oak_log") {
      throw new Error(`偏置没生效，第一步是：${JSON.stringify(first)}`);
    }

    driver.stop("end");
    cleanup(dir);
    ok("目标偏置：相关动作被顶到第一位");
  }

  /* 24. 目标规划：从零开始时先采集 */
  {
    const { GoalTracker } = require("../src/goal.cjs");

    const goalTracker = new GoalTracker();
    goalTracker.goals.push({
      id: "craft:wooden_pickaxe",
      kind: "craft",
      target: "wooden_pickaxe",
      count: 1,
      progress: 0,
      status: "active",
      priority: 70,
      source: "state",
      attempts: 0,
      failures: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      finishedAt: null,
      completedActions: [],
      blockedActions: [],
    });
    goalTracker.currentId = "craft:wooden_pickaxe";

    const { driver, bridge, dir } = setup({
      getGoal: goalTracker,
      settings: {
        autoplayBootstrap: [{ tool: "context", args: {} }],
        autoplayMuscle: false,
      },
    });

    driver.start("test");
    const r = await driver.tick();

    if (!r || r.via !== "goal") throw new Error(`没走目标规划：${JSON.stringify(r)}`);

    const first = bridge.calls.find((c) => c.tool === "collect");
    if (!first || first.args.block !== "oak_log") {
      throw new Error(`第一步不是采集：${JSON.stringify(bridge.calls)}`);
    }

    const snap = driver.snapshot();
    if (!snap.goal || !snap.goal.current || !snap.goal.current.plan) {
      throw new Error("规划没有写进目标快照");
    }
    if (!snap.goal.current.plan.steps.length) {
      throw new Error("计划是空的");
    }

    driver.stop("end");
    cleanup(dir);
    ok("目标规划：从零开始时先采集");
  }

  /* 25. 目标规划：没工作台时先做工作台 */
  {
    const { GoalTracker } = require("../src/goal.cjs");

    const goalTracker = new GoalTracker();
    goalTracker.goals.push({
      id: "craft:wooden_pickaxe",
      kind: "craft",
      target: "wooden_pickaxe",
      count: 1,
      progress: 0,
      status: "active",
      priority: 70,
      source: "state",
      attempts: 0,
      failures: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      finishedAt: null,
      completedActions: [],
      blockedActions: [],
    });
    goalTracker.currentId = "craft:wooden_pickaxe";

    // 有木板有棍子，但附近没有工作台
    const bridge = makeBridge({ inventory: inv({ oak_planks: 8, stick: 4 }) });
    bridge.handlers.set("craft", () => ({ ok: true, item: "crafting_table", crafted: 1 }));

    const { driver, dir } = setup({
      bridge,
      getGoal: goalTracker,
      settings: {
        autoplayBootstrap: [{ tool: "context", args: {} }],
        autoplayMuscle: false,
      },
    });

    driver.start("test");
    const r = await driver.tick();

    if (!r || r.via !== "goal") throw new Error(`没走目标规划：${JSON.stringify(r)}`);

    const first = bridge.calls.find((c) => c.tool === "craft");
    if (!first || first.args.item !== "crafting_table") {
      throw new Error(`第一步不是做工作台：${JSON.stringify(bridge.calls)}`);
    }

    const steps = driver.snapshot().goal.current.plan.steps;
    if (!steps.some((s) => s.startsWith("place:crafting_table"))) {
      throw new Error(`计划里没有放工作台：${JSON.stringify(steps)}`);
    }

    driver.stop("end");
    cleanup(dir);
    ok("目标规划：没工作台时先做并放下");
  }

  /* 26. 路线训练：垫高 / 绕行步骤也写进路线库 */
  {
    const saved = [];
    const routeMemory = {
      recall: () => null,
      isBlocked: () => false,
      remember: (payload) => saved.push(payload),
      rememberBlocked: () => {},
    };

    const bridge = makeBridge({ inventory: inv({ oak_planks: 8 }) });
    bridge.handlers.set("scan", () => ({ ok: true, blocks: [{ x: 10, y: 70, z: 10 }] }));
    bridge.handlers.set("terrain", () => ({
      ok: true,
      heights: Array.from({ length: 9 }, () => Array(9).fill(64)),
    }));

    const approachSteps = [
      { action: "move", args: { x: 9, y: 64, z: 10 } },
      { action: "pillar", args: { height: 4 } },
    ];
    bridge.handlers.set("collect", () => ({
      ok: true,
      complete: true,
      mined: 1,
      approach: { x: 10, y: 68, z: 10 },
      approachSteps,
      strategy: "pillar",
      terrainKey: "v1:9:test",
    }));

    const { driver, dir } = setup({
      bridge,
      getRouteMemory: routeMemory,
      settings: {
        autoplayBootstrap: [{ tool: "collect", args: { block: "oak_log", count: 1 } }],
        autoplayMuscle: false,
      },
    });

    for (let i = 0; i < 5 && !saved.length; i += 1) {
      await driver.once();
    }

    if (!saved.length) throw new Error("collect 成功后没有写路线库");
    if (!saved[0].steps.some((s) => s.action === "pillar")) {
      throw new Error(`垫高步骤丢了：${JSON.stringify(saved[0].steps)}`);
    }
    if (saved[0].approach.x !== 10 || saved[0].approach.y !== 68) {
      throw new Error(`接近点丢了：${JSON.stringify(saved[0].approach)}`);
    }

    driver.stop("end");
    cleanup(dir);
    ok("路线训练：垫高与绕行步骤完整写进路线库");
  }

  /* 27. 重启：冷启动游标回到开头 */
  {
    const { driver, dir } = setup();
    driver.start("test");
    driver.bootstrapIndex = 3;
    driver.stop("end");

    const snap = driver.start("again");
    if (snap.bootstrapIndex !== 0) {
      throw new Error(`重启没重置冷启动游标：${snap.bootstrapIndex}`);
    }

    driver.stop("end");
    cleanup(dir);
    ok("重启：冷启动游标回到开头");
  }

  /* 28. 自检：背包满足目标后，下一 tick 自动推进 */
  {
    const { GoalTracker } = require("../src/goal.cjs");
    const graph = {
      name: "g",
      nodes: [
        { id: "get_stone", kind: "collect", recipe: "cobblestone", priority: 10, requires: [] },
        { id: "craft_pick", kind: "craft", recipe: "stone_pickaxe", priority: 9, requires: ["get_stone"] },
      ],
    };
    const goalTracker = new GoalTracker({ graphs: [graph], rules: [], doneCooldownMs: 0 });
    const { driver, bridge, dir } = setup({ getGoal: goalTracker });

    goalTracker.refresh({ inventory: [] });
    bridge.setStatus({ inventory: inv({ cobblestone: 3 }) });

    driver.start("test");
    await driver.tick();

    if (goalTracker.current()?.graphNodeId !== "craft_pick") {
      throw new Error(`目标没有推进：${goalTracker.current()?.graphNodeId}`);
    }

    driver.stop("end");
    cleanup(dir);
    ok("自检：背包满足目标后下一 tick 推进");
  }

  /* 29. 类脑决策：collect 自动展开工具变体，最多 3 个 */
  {
    const rows = [
      { ts: Date.now() - 5000, tool: "move", args: {}, ok: true, ms: 100, origin: "llm" },
      {
        ts: Date.now() - 4800,
        tool: "collect",
        args: { block: "stone" },
        ok: true,
        ms: 300,
        origin: "llm",
      },
      { ts: Date.now() - 3000, tool: "move", args: {}, ok: true, ms: 100, origin: "llm" },
      {
        ts: Date.now() - 2800,
        tool: "collect",
        args: { block: "stone" },
        ok: true,
        ms: 300,
        origin: "llm",
      },
    ];
    const { driver, bridge, dir } = setup({
      trace: makeTrace(rows),
      settings: { autoplayMuscle: false, autoplayBootstrap: [{ tool: "context", args: {} }] },
    });
    bridge.setStatus({
      inventory: inv({
        wooden_pickaxe: 1,
        stone_pickaxe: 1,
        iron_pickaxe: 1,
      }),
    });

    driver.current = "move";
    // 门禁要知道附近真的有 stone；否则 collect 会被前置条件挡住。
    driver.blockInfo = [{ name: "stone", y: 64, reachable: true }];
    driver.start("test");
    await driver.tick();

    const call = bridge.calls.find((c) => c.tool === "collect");
    if (!call) throw new Error("没有执行 collect");
    if (!call.args.tool) throw new Error("collect 没带工具参数");
    // 背包里三把工具，展开是空手 + 品质最高的两把；最低那把不进候选。
    if (call.args.tool === "wooden_pickaxe") throw new Error("工具变体超过 3 个上限");

    driver.stop("end");
    cleanup(dir);
    ok("类脑决策：collect 展开工具变体");
  }

  /* 30. 经验沉淀：同一段失败→成功只编一次 */
  {
    const now = Date.now();
    const rows = [
      {
        ts: now - 3000,
        tool: "collect",
        args: { block: "stone" },
        ok: false,
        error: "空手没有掉落",
        origin: "autoplay",
      },
      {
        ts: now - 2800,
        tool: "act",
        args: { action: "equip", item: "wooden_pickaxe" },
        ok: true,
        origin: "autoplay",
      },
      {
        ts: now - 2600,
        tool: "collect",
        args: { block: "stone", tool: "wooden_pickaxe" },
        ok: true,
        detail: { gained: 3 },
        origin: "autoplay",
      },
    ];
    const { driver, store, dir } = setup({ trace: makeTrace(rows) });

    await driver.selfCheck({ apply: true });
    await driver.selfCheck({ apply: true });

    if (store.saved.length !== 1) {
      throw new Error(`重复沉淀：${store.saved.length} 次`);
    }

    cleanup(dir);
    ok("经验沉淀：同一段失败→成功只编一次");
  }

  /* 31. 自检：有工具后清掉旧的 collect 拉黑 */
  {
    const { GoalTracker } = require("../src/goal.cjs");
    const goalTracker = new GoalTracker();
    const goal = {
      id: "collect:cobblestone",
      kind: "collect",
      target: "cobblestone",
      count: 1,
      progress: 0,
      status: "active",
      priority: 40,
      source: "state",
      attempts: 1,
      failures: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      finishedAt: null,
      completedActions: [],
      blockedActions: ["collect:block=stone"],
    };
    goalTracker.goals.push(goal);
    goalTracker.currentId = goal.id;

    const { driver, bracket, bridge, dir } = (() => {
      const x = setup({ getGoal: goalTracker });
      return { ...x, bracket: null };
    })();
    bridge.setStatus({ inventory: inv({ wooden_pickaxe: 1 }) });

    const report = await driver.selfCheck({ apply: true });
    if (goal.blockedActions.length !== 0) {
      throw new Error(`拉黑没清：${goal.blockedActions.join(",")}`);
    }
    if (!report.findings.some((f) => f.kind === "unblocked")) {
      throw new Error("报告里没有 unblocked");
    }

    cleanup(dir);
    ok("自检：有工具后清掉旧的 collect 拉黑");
  }

  report();
}

/* ------------------------------ 报告 ------------------------------ */

main().catch((e) => {
  results.push({ name: "测试组执行", pass: false, err: e });
  report();
});

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
