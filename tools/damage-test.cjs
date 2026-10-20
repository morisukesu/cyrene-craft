"use strict";

/**
 * 伤害来源分类测试
 *
 * 起因：砍树时从树顶摔下来，摔落伤害被当成「被攻击」，唤醒一轮对话
 * 把正在跑的技能打断了。修复思路是把伤害按来源分类，只有实体伤害
 * 才允许触发唤醒。
 *
 * 这里验证分类器本身，不连服务器。
 *
 * 用法：node tools/damage-test.cjs
 */

const path = require("node:path");

const { createDamageTracker, DAMAGE_TYPES } = require("../src/bot-runtime.cjs");

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, e) => results.push({ name, pass: false, err: e });

/** 造一个最小的 bot 替身 */
function makeBot(over = {}) {
  return {
    entity: {
      position: { x: 0, y: 64, z: 0, distanceTo: () => 0 },
      velocity: { x: 0, y: 0, z: 0 },
    },
    entities: {},
    ...over,
  };
}

/** 按名字查注册表下标，造一个 damage_event 包 */
function packetFor(typeName) {
  const id = DAMAGE_TYPES.indexOf(typeName);
  if (id < 0) throw new Error(`注册表里没有 ${typeName}`);
  return { entityId: 1, sourceTypeId: id, sourceCauseId: 0, sourceDirectId: 0, sourcePosition: null };
}

(async () => {
  /* 1. 注册表完整性 */
  try {
    if (DAMAGE_TYPES.length < 40) throw new Error(`伤害类型数量异常：${DAMAGE_TYPES.length}`);
    if (new Set(DAMAGE_TYPES).size !== DAMAGE_TYPES.length) throw new Error("注册表里有重复项");
    // 几个关键类型的下标必须对得上
    const checks = [
      ["fall", 10],
      ["starve", 8],
      ["drown", 7],
      ["mob_attack", 25],
      ["player_attack", 27],
      ["arrow", 28],
      ["lava", 3],
      ["cactus", 9],
    ];
    for (const [name, want] of checks) {
      const got = DAMAGE_TYPES.indexOf(name);
      if (got !== want) throw new Error(`${name} 下标应是 ${want}，实际 ${got}`);
    }
    ok(`注册表完整（${DAMAGE_TYPES.length} 项，关键下标全部对上）`);
  } catch (e) {
    fail("注册表完整性", e);
  }

  /* 2. 摔落 → 环境伤害，不冒充攻击 */
  try {
    const t = createDamageTracker();
    t.notePacket(packetFor("fall"));
    const r = t.resolve(3, makeBot());
    if (r.kind !== "environment") throw new Error(`摔落应判 environment，实际 ${r.kind}`);
    if (r.reason !== "fall") throw new Error(`reason 应是 fall，实际 ${r.reason}`);
    if (r.attacker) throw new Error("摔落不该有攻击者");
    ok("摔落判为环境伤害（不触发唤醒）");
  } catch (e) {
    fail("摔落分类", e);
  }

  /* 3. 僵尸近战 → 实体伤害，带攻击者 */
  try {
    const t = createDamageTracker();
    const bot = makeBot({
      entities: {
        7: { id: 7, name: "zombie", type: "mob", position: { distanceTo: () => 2.4 } },
      },
    });
    const pkt = packetFor("mob_attack");
    pkt.sourceCauseId = 7;
    t.notePacket(pkt);

    const r = t.resolve(4, bot);
    if (r.kind !== "entity") throw new Error(`僵尸攻击应判 entity，实际 ${r.kind}`);
    if (!r.attacker) throw new Error("应识别出攻击者");
    if (r.attacker.name !== "zombie") throw new Error(`攻击者应是 zombie，实际 ${r.attacker.name}`);
    if (r.attacker.distance !== 2.4) throw new Error(`距离应是 2.4，实际 ${r.attacker.distance}`);
    ok("僵尸攻击判为实体伤害，并带出攻击者与距离");
  } catch (e) {
    fail("实体伤害分类", e);
  }

  /* 4. 玩家攻击也是实体伤害 */
  try {
    const t = createDamageTracker();
    const bot = makeBot({
      entities: { 3: { id: 3, name: "mori", username: "mori", type: "player", position: { distanceTo: () => 1.1 } } },
    });
    const pkt = packetFor("player_attack");
    pkt.sourceCauseId = 3;
    t.notePacket(pkt);

    const r = t.resolve(6, bot);
    if (r.kind !== "entity") throw new Error(`玩家攻击应判 entity，实际 ${r.kind}`);
    if (r.attacker.name !== "mori") throw new Error(`攻击者应是 mori，实际 ${r.attacker.name}`);
    ok("玩家攻击判为实体伤害，攻击者识别正确");
  } catch (e) {
    fail("玩家攻击分类", e);
  }

  /* 5. 各类环境伤害都不算攻击 */
  try {
    const env = ["starve", "drown", "lava", "in_fire", "on_fire", "cactus", "in_wall", "freeze", "lightning_bolt", "explosion"];
    for (const name of env) {
      const t = createDamageTracker();
      t.notePacket(packetFor(name));
      const r = t.resolve(2, makeBot());
      if (r.kind === "entity") throw new Error(`${name} 不该判成实体伤害`);
    }
    ok(`环境伤害全部不判攻击（${env.length} 种）`);
  } catch (e) {
    fail("环境伤害分类", e);
  }

  /* 6. 没有伤害包时：正在下落 → 推断摔落 */
  try {
    const t = createDamageTracker();
    const bot = makeBot({ entity: { position: { x: 0, y: 70, z: 0, distanceTo: () => 0 }, velocity: { x: 0, y: -1.4, z: 0 } } });
    const r = t.resolve(3, bot);
    if (r.kind !== "environment") throw new Error(`下落时应推断 environment，实际 ${r.kind}`);
    if (r.reason !== "fall") throw new Error(`推断的 reason 应是 fall，实际 ${r.reason}`);
    if (!r.inferred) throw new Error("应标记 inferred=true");
    ok("无伤害包 + 正在下落 → 推断为摔落，并标记 inferred");
  } catch (e) {
    fail("下落兜底推断", e);
  }

  /* 7. 没有伤害包但旁边有敌对生物 → 别漏判 */
  try {
    const t = createDamageTracker();
    const bot = makeBot({
      entities: {
        9: { id: 9, name: "skeleton", type: "mob", health: 20, position: { distanceTo: () => 5.2 } },
      },
    });
    const r = t.resolve(3, bot);
    if (r.kind !== "entity") throw new Error(`旁边有骷髅应判 entity，实际 ${r.kind}`);
    if (!r.attacker || r.attacker.name !== "skeleton") throw new Error("应指出是骷髅");
    ok("无伤害包但 8 格内有敌对生物 → 按实体伤害处理，不漏判");
  } catch (e) {
    fail("近敌兜底", e);
  }

  /* 8. 远处的怪不算 */
  try {
    const t = createDamageTracker();
    const bot = makeBot({
      entities: {
        9: { id: 9, name: "zombie", type: "mob", health: 20, position: { distanceTo: () => 20 } },
      },
    });
    const r = t.resolve(3, bot);
    if (r.kind === "entity") throw new Error("20 格外的怪不该判成攻击者");
    ok("20 格外的怪不会被误判为攻击者");
  } catch (e) {
    fail("远距离不误判", e);
  }

  /* 9. 死亡/已死的怪不算 */
  try {
    const t = createDamageTracker();
    const bot = makeBot({
      entities: {
        9: { id: 9, name: "zombie", type: "mob", health: 0, position: { distanceTo: () => 1 } },
      },
    });
    const r = t.resolve(3, bot);
    if (r.kind === "entity") throw new Error("已经死掉的怪不该算攻击者");
    ok("已死亡的怪不会被误判为攻击者");
  } catch (e) {
    fail("死怪不误判", e);
  }

  /* 10. 什么信息都没有 → unknown，不冒充攻击 */
  try {
    const t = createDamageTracker();
    const r = t.resolve(3, makeBot());
    if (r.kind !== "unknown") throw new Error(`无信息时应是 unknown，实际 ${r.kind}`);
    ok("无任何线索时判 unknown，不冒充攻击");
  } catch (e) {
    fail("无信息兜底", e);
  }

  /* 11. 过期的伤害包不能用 */
  try {
    const t = createDamageTracker({ ttlMs: 50 });
    t.notePacket(packetFor("fall"));
    await new Promise((r) => setTimeout(r, 120));
    const r = t.resolve(3, makeBot());
    if (r.reason === "fall") throw new Error("过期包不该再被使用");
    if (r.kind !== "unknown") throw new Error(`过期后应回到 unknown，实际 ${r.kind}`);
    ok("过期伤害包不会被拿去对账（避免张冠李戴）");
  } catch (e) {
    fail("过期包处理", e);
  }

  /* 12. 缓冲不会无限增长 */
  try {
    const t = createDamageTracker();
    for (let i = 0; i < 50; i += 1) t.notePacket(packetFor("fall"));
    if (t.size() > 8) throw new Error(`缓冲应封顶 8，实际 ${t.size()}`);
    ok("伤害包缓冲有上限（8 条），不会无限涨");
  } catch (e) {
    fail("缓冲上限", e);
  }

  /* 13. reset 能清空（重连时用） */
  try {
    const t = createDamageTracker();
    t.notePacket(packetFor("fall"));
    t.reset();
    if (t.size() !== 0) throw new Error("reset 后应为空");
    ok("reset 可清空缓冲");
  } catch (e) {
    fail("reset", e);
  }

  /* ---- 报告 ---- */
  console.log("");
  console.log("═".repeat(60));
  for (const r of results) {
    console.log(`${r.pass ? "  ✔" : "  ✘"} ${r.name}`);
    if (!r.pass) console.log(`       ${r.err && r.err.message ? r.err.message : r.err}`);
  }
  console.log("═".repeat(60));
  const passed = results.filter((r) => r.pass).length;
  console.log(`通过 ${passed} / ${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
})();
