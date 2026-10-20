"use strict";

/**
 * 本能层单元测试。
 *
 * 不连服务器，用一个假 bot 模拟 mineflayer 的接口，逐条验证判断逻辑：
 *   - 血低 + 有怪 -> 触发逃跑
 *   - 血高 -> 不触发
 *   - 饿了 -> 选最划算的食物
 *   - 没有食物 -> 不报错
 *   - 头部被堵 -> 挖开
 *   - 逃跑方向会撞到玩家 -> 换方向 / 原地不动
 *   - 冷却机制：同一动作不会每 tick 都触发
 *
 * 跑法：node tools/instinct-test.cjs
 */

const path = require("node:path");
const assert = require("node:assert");

const { Instincts, FOOD_VALUE } = require(path.resolve(__dirname, "..", "src", "instincts.cjs"));

/* ---------------------------- 假 bot ---------------------------- */

function makeVec(x, y, z) {
  return {
    x,
    y,
    z,
    offset(dx, dy, dz) {
      return makeVec(x + dx, y + dy, z + dz);
    },
    distanceTo(other) {
      return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
    },
    clone() {
      return makeVec(x, y, z);
    },
    equals(o) {
      return this.x === o.x && this.y === o.y && this.z === o.z;
    },
    toString() {
      return `(${x}, ${y}, ${z})`;
    },
  };
}

/**
 * 造一个假 bot。blocks 是一个 key -> block 的字典，key 是 "x,y,z"。
 */
function makeBot(opts = {}) {
  const me = makeVec(opts.x ?? 0, opts.y ?? 64, opts.z ?? 0);
  const blocks = opts.blocks || {};
  const controlStates = {};
  const calls = { dig: [], equip: [], consume: [], attack: [], look: [], goto: [], place: [] };

  const bot = {
    entity: { position: me },
    health: opts.health ?? 20,
    food: opts.food ?? 20,
    oxygenLevel: opts.oxygen ?? 300,
    username: "Cyrene",
    players: opts.players || {},
    entities: opts.entities || {},
    inventory: {
      items: () => opts.inventory || [],
      emptySlotCount: () => 20,
    },
    heldItem: null,

    blockAt(pos) {
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      return blocks[key] || { name: "air", boundingBox: "empty", light: 15, position: pos };
    },

    findBlock({ matching, maxDistance }) {
      for (const key of Object.keys(blocks)) {
        const b = blocks[key];
        if (matching && !matching(b)) continue;
        const [x, y, z] = key.split(",").map(Number);
        const p = makeVec(x, y, z);
        if (me.distanceTo(p) <= maxDistance) return b;
      }
      return null;
    },

    setControlState(name, value) {
      controlStates[name] = value;
    },
    clearControlStates() {
      for (const k of Object.keys(controlStates)) controlStates[k] = false;
    },

    async dig(block) {
      calls.dig.push(block && block.name);
    },
    async equip(item, dest) {
      calls.equip.push({ item: item && item.name, dest });
      bot.heldItem = item;
    },
    async consume() {
      calls.consume.push(true);
    },
    async attack(e) {
      calls.attack.push(e && e.name);
    },
    async look(yaw) {
      calls.look.push(yaw);
    },
    async lookAt(v) {
      calls.look.push(v);
    },
    async placeBlock(ref, face) {
      calls.place.push({ ref: ref && ref.name, face });
    },
    async toss() {},

    // 没有 pathfinder：走降级路径，不依赖 mineflayer-pathfinder
    pathfinder: null,

    // 测试用
    __calls: calls,
    __controls: controlStates,
    __me: me,
  };

  return bot;
}

/** 造一个敌对生物 */
function makeMob(name, x, y, z, health = 20) {
  return { id: Math.floor(Math.random() * 1e6), name, position: makeVec(x, y, z), health };
}

/* ---------------------------- 测试 ---------------------------- */

const results = [];
const ok = (n) => results.push({ name: n, pass: true });
const fail = (n, e) => results.push({ name: n, pass: false, err: e });

async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(name, e);
  }
}

/** 让 Instincts 只跑一次 tick，绕过定时器 */
function makeInst(bot, cfg = {}) {
  const events = [];
  const inst = new Instincts({
    bot,
    emit: (event, data) => events.push({ event, data }),
    getTask: () => cfg.task || null,
    log: () => {},
    config: { tickMs: 999999, ...cfg },
  });
  inst.__events = events;
  return inst;
}

async function main() {
  /* ---- 1. 血低且有怪：逃跑 ---- */
  await test("血低 + 有敌对生物 -> 触发逃跑", async () => {
    const zombie = makeMob("zombie", 3, 64, 0);
    const bot = makeBot({
      health: 6,
      entities: { [zombie.id]: zombie },
      blocks: { "0,63,0": { name: "stone", boundingBox: "block", light: 15, position: makeVec(0, 63, 0) } },
    });
    bot.entities[bot.entity.id || -1] = bot.entity;

    const inst = makeInst(bot);
    await inst.tick();

    assert.strictEqual(inst.lastAction, "flee", `预期 flee，实际 ${inst.lastAction}`);
    const ev = inst.__events.find((e) => e.data && e.data.kind === "flee");
    assert.ok(ev, "应该广播 flee 事件");
    assert.ok(bot.__controls.forward === true || bot.__calls.look.length > 0, "应该开始移动");
  });

  /* ---- 2. 血高：不逃 ---- */
  await test("血满 + 有敌对生物 -> 不逃跑", async () => {
    const zombie = makeMob("zombie", 3, 64, 0);
    const bot = makeBot({ health: 20, entities: { [zombie.id]: zombie } });
    const inst = makeInst(bot);
    await inst.tick();
    assert.notStrictEqual(inst.lastAction, "flee", "满血不该逃");
  });

  /* ---- 3. 没有敌对生物：不逃 ---- */
  await test("血低但没有敌对生物 -> 不逃跑", async () => {
    const cow = makeMob("cow", 3, 64, 0);
    const bot = makeBot({ health: 5, entities: { [cow.id]: cow } });
    const inst = makeInst(bot);
    await inst.tick();
    assert.notStrictEqual(inst.lastAction, "flee", "没有威胁不该逃");
  });

  /* ---- 4. 饿了自动吃最划算的 ---- */
  await test("饥饿低于阈值 -> 吃最划算的食物", async () => {
    const bot = makeBot({
      food: 8,
      inventory: [
        { name: "apple", count: 3, type: 1 },
        { name: "cooked_beef", count: 1, type: 2 },
        { name: "bread", count: 2, type: 3 },
      ],
    });
    const inst = makeInst(bot);
    await inst.tick();

    assert.strictEqual(inst.lastAction, "eat", `预期 eat，实际 ${inst.lastAction}`);
    const equipped = bot.__calls.equip[0];
    assert.strictEqual(equipped.item, "cooked_beef", `应该吃熟的牛排，实际吃了 ${equipped.item}`);
    assert.ok(bot.__calls.consume.length > 0, "应该调用 consume");
  });

  /* ---- 5. 不饿的时候不吃 ---- */
  await test("饥饿充足 -> 不吃东西", async () => {
    const bot = makeBot({ food: 20, inventory: [{ name: "cooked_beef", count: 1, type: 1 }] });
    const inst = makeInst(bot);
    await inst.tick();
    assert.notStrictEqual(inst.lastAction, "eat");
  });

  /* ---- 6. 饿了但没食物：不报错 ---- */
  await test("饥饿低但背包没食物 -> 不崩，不进食", async () => {
    const bot = makeBot({ food: 5, inventory: [] });
    const inst = makeInst(bot);
    await inst.tick();
    assert.notStrictEqual(inst.lastAction, "eat", "没食物不该说吃了");
  });

  /* ---- 7. 头部被堵：挖开 ---- */
  await test("头部被方块堵住 -> 挖开", async () => {
    const bot = makeBot({
      y: 64,
      blocks: {
        "0,65,0": { name: "dirt", boundingBox: "block", light: 0, position: makeVec(0, 65, 0) },
      },
    });
    const inst = makeInst(bot);
    await inst.tick();
    assert.strictEqual(inst.lastAction, "suffocate", `预期 suffocate，实际 ${inst.lastAction}`);
    assert.ok(bot.__calls.dig.includes("dirt"), "应该挖掉那格泥土");
  });

  /* ---- 8. 逃跑方向不撞玩家 ---- */
  await test("逃跑方向会撞到玩家 -> 换一个方向", async () => {
    const zombie = makeMob("zombie", 3, 64, 0);
    // 玩家站在正西方（逃跑的反方向），占住了最直接的退路
    const playerEntity = { position: makeVec(-10, 64, 0) };
    const bot = makeBot({
      health: 5,
      entities: { [zombie.id]: zombie },
      players: { mori: { username: "mori", entity: playerEntity } },
    });

    const inst = makeInst(bot);
    const dir = inst.__pickFleeDirection ? null : null; // 私有方法，改从行为观察

    await inst.tick();
    assert.strictEqual(inst.lastAction, "flee", "还是应该逃跑");
    // 观察 look 的偏航角，不该正好朝着玩家
    const yaw = bot.__calls.look[0];
    if (typeof yaw === "number") {
      // 正西方向的 yaw 是 atan2(-(-1), -0) = atan2(1,0) = PI/2
      assert.ok(Math.abs(Math.abs(yaw) - Math.PI / 2) > 0.15, `偏航角 ${yaw} 太接近玩家方向`);
    }
  });

  /* ---- 9. 冷却：连续 tick 不重复逃 ---- */
  await test("同一动作有冷却 -> 连续两次 tick 只逃一次", async () => {
    const zombie = makeMob("zombie", 3, 64, 0);
    const bot = makeBot({ health: 5, entities: { [zombie.id]: zombie } });
    const inst = makeInst(bot);

    await inst.tick();
    const firstAt = inst.lastActionAt;
    await inst.tick();
    assert.strictEqual(inst.lastActionAt, firstAt, "冷却期内不该再次触发");
  });

  /* ---- 10. 跑任务时不做捡东西这类小事 ---- */
  await test("正在跑任务 -> 跳过捡东西", async () => {
    const item = { id: 999, name: "item", position: makeVec(2, 64, 0) };
    const bot = makeBot({
      entities: { [item.id]: item },
      blocks: { "0,63,0": { name: "stone", boundingBox: "block", light: 15, position: makeVec(0, 63, 0) } },
    });
    const inst = makeInst(bot, { task: "正在挖矿" });
    await inst.tick();
    assert.notStrictEqual(inst.lastAction, "pickup", "跑任务时不该捡东西");
  });

  /* ---- 11. 闲置时会捡 ---- */
  await test("闲着 + 附近有掉落物 -> 走过去捡", async () => {
    const item = { id: 999, name: "item", position: makeVec(2, 64, 0) };
    const bot = makeBot({
      entities: { [item.id]: item },
      blocks: { "0,63,0": { name: "stone", boundingBox: "block", light: 15, position: makeVec(0, 63, 0) } },
    });
    const inst = makeInst(bot);
    await inst.tick();
    assert.strictEqual(inst.lastAction, "pickup", `预期 pickup，实际 ${inst.lastAction}`);
  });

  /* ---- 12. 跑任务时保命动作仍然执行 ---- */
  await test("跑任务时保命动作仍然执行（头部被堵）", async () => {
    const bot = makeBot({
      y: 64,
      blocks: { "0,65,0": { name: "sand", boundingBox: "block", light: 0, position: makeVec(0, 65, 0) } },
    });
    const inst = makeInst(bot, { task: "正在建造" });
    await inst.tick();
    assert.strictEqual(inst.lastAction, "suffocate", "保命动作不该因为任务被跳过");
  });

  /* ---- 13. 食物价值表完整性 ---- */
  await test("食物价值表里每项都是正数", async () => {
    for (const [name, value] of FOOD_VALUE) {
      assert.ok(Number.isFinite(value) && value > 0, `${name} 的价值不对：${value}`);
    }
  });

  /* ---- 14. stop 之后不再跑 ---- */
  await test("stop() 之后定时器清空", async () => {
    const bot = makeBot({});
    const inst = new Instincts({ bot, config: { tickMs: 100 } });
    inst.start();
    assert.ok(inst.timer, "start 后应该有定时器");
    inst.stop();
    assert.strictEqual(inst.timer, null, "stop 后定时器应该清空");
  });

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
  console.log("本能层全部通过。");
  process.exit(0);
}

main().catch((e) => {
  console.error("测试自身崩了：", e);
  process.exit(1);
});
