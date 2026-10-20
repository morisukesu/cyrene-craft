"use strict";

/**
 * 冒烟测试：用假 ctx 跑一遍 register，验证插件契约。
 *
 * 这不是走形式——Cyrene 插件最常翻车的地方就在这里：
 *   - 工具 id 没带插件前缀 → 启用直接失败
 *   - inputSchema 缺失或结构不对 → 模型调不起来
 *   - unregister 不幂等 → 刷新插件时崩
 *
 * 跑法：node tools/smoke.cjs
 */

const path = require("node:path");
const assert = require("node:assert");

const PLUGIN_ID = "cyrene-craft";
const root = path.resolve(__dirname, "..");

/* ---------------------------- 假 ctx ---------------------------- */

function createMockContext() {
  const state = {
    tools: [],
    ipcs: new Map(),
    providers: [],
    channels: [],
    disposers: [],
    storage: new Map(),
    logs: [],
    disposed: false,
  };

  const ctx = {
    log(msg) {
      state.logs.push(String(msg));
    },
    get signal() {
      return state.abortController ? state.abortController.signal : new AbortController().signal;
    },
    registerTool(spec) {
      if (state.disposed) throw new Error("停止阶段不能再注册工具");
      state.tools.push(spec);
    },
    unregisterTool(id) {
      state.tools = state.tools.filter((t) => t.id !== id);
    },
    registerPromptProvider(spec) {
      state.providers.push(spec);
    },
    unregisterPromptProvider(id) {
      state.providers = state.providers.filter((p) => p.id !== id);
    },
    registerIpc(channel, handler) {
      state.ipcs.set(channel, handler);
    },
    registerChannelAdapter(adapter) {
      state.channels.push(adapter);
    },
    onDispose(fn) {
      state.disposers.push(fn);
    },
    events: {
      on() {
        return () => {};
      },
      async emit() {},
    },
    storage: {
      get(key) {
        return state.storage.get(key);
      },
      set(key, value) {
        state.storage.set(key, value);
      },
    },
    deps: {},
  };

  return { ctx, state };
}

/* ---------------------------- 断言 ---------------------------- */

const TOOL_ID_RE = new RegExp(`^${PLUGIN_ID}_[a-z0-9_]+$`);

function checkManifest() {
  const manifest = require(path.join(root, "manifest.json"));

  assert.strictEqual(manifest.apiVersion, 1, "apiVersion 必须是 1");
  assert.strictEqual(manifest.id, PLUGIN_ID, `id 必须是 ${PLUGIN_ID}`);
  assert.match(manifest.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, "id 必须是全小写连字符");

  // 严格三段式 SemVer
  assert.match(manifest.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "version 必须是严格 SemVer");

  for (const field of ["name", "description", "author", "entry"]) {
    assert.ok(manifest[field] && typeof manifest[field] === "string", `manifest.${field} 必须是非空字符串`);
  }

  assert.ok(!manifest.entry.includes("/") && !manifest.entry.includes("\\"), "entry 不能含子目录");
  assert.ok(!manifest.entry.includes(".."), "entry 不能含 ..");
  assert.match(manifest.entry, /\.(cjs|js|mjs)$/, "entry 扩展名必须是 .cjs/.js/.mjs");

  const allowedDeps = ["channels", "llm", "secrets", "workspace", "conversations", "scheduler", "speech-input"];
  const deps = Array.isArray(manifest.deps) ? manifest.deps : [];
  for (const dep of deps) {
    assert.ok(allowedDeps.includes(dep), `deps 里有不认识的项：${dep}`);
  }

  // entry 必须真实存在
  const fs = require("node:fs");
  assert.ok(fs.existsSync(path.join(root, manifest.entry)), `entry 文件不存在：${manifest.entry}`);

  if (manifest.icon) {
    assert.ok(fs.existsSync(path.join(root, manifest.icon)), `icon 文件不存在：${manifest.icon}`);
  }

  return manifest;
}

function checkTools(tools) {
  assert.ok(tools.length > 0, "至少要注册一个工具");

  const seen = new Set();
  for (const tool of tools) {
    assert.ok(tool.id, "工具必须有 id");
    assert.match(tool.id, TOOL_ID_RE, `工具 id 不符合 ${PLUGIN_ID}_xxx 规范：${tool.id}`);
    assert.ok(!seen.has(tool.id), `工具 id 重复：${tool.id}`);
    seen.add(tool.id);

    assert.ok(tool.name && typeof tool.name === "string", `${tool.id} 缺少 name`);
    assert.ok(tool.description && tool.description.length > 10, `${tool.id} 的 description 太短，模型不会用`);

    assert.ok(["safe", "network", "fs-write", "input-control", "medium", "high"].includes(tool.risk), `${tool.id} 的 risk 非法：${tool.risk}`);
    assert.ok(["read", "write"].includes(tool.effectKind), `${tool.id} 的 effectKind 非法：${tool.effectKind}`);

    assert.ok(tool.inputSchema && typeof tool.inputSchema === "object", `${tool.id} 缺 inputSchema`);
    assert.strictEqual(tool.inputSchema.type, "object", `${tool.id} 的 inputSchema.type 必须是 object`);
    assert.ok(tool.inputSchema.properties && typeof tool.inputSchema.properties === "object", `${tool.id} 缺 inputSchema.properties`);
    assert.ok(Array.isArray(tool.inputSchema.required), `${tool.id} 的 required 必须是数组（没参数也要给空数组）`);

    // required 里出现的字段必须在 properties 里
    for (const key of tool.inputSchema.required) {
      assert.ok(key in tool.inputSchema.properties, `${tool.id}: required 里的 ${key} 不在 properties 中`);
    }

    assert.strictEqual(typeof tool.execute, "function", `${tool.id} 缺 execute`);
  }

  return seen;
}

function checkPromptProvider(providers) {
  for (const p of providers) {
    assert.ok(p.id, "prompt provider 必须有 id");
    assert.match(p.id, /^[a-zA-Z0-9._-]+$/, `prompt provider id 不合法：${p.id}`);
    assert.strictEqual(typeof p.provide, "function", `prompt provider ${p.id} 缺 provide`);

    if (p.modes) {
      const allowed = ["chat", "work", "learn", "code"];
      for (const m of p.modes) assert.ok(allowed.includes(m), `prompt provider ${p.id} 的 mode 非法：${m}`);
    }
  }
}

function checkChannelAdapter(channels) {
  for (const a of channels) {
    assert.ok(a.id, "渠道适配器必须有 id");
    const id = String(a.id);
    assert.match(id, /^[a-zA-Z0-9._-]+$/, `渠道 id 不合法：${id}`);

    // 不要和 minecraft-bot 插件抢同一个 id
    assert.notStrictEqual(id, "minecraft", "渠道 id 不能叫 minecraft（会和 minecraft-bot 插件冲突）");

    assert.ok(a.displayName, `渠道 ${id} 缺 displayName`);
    assert.ok(a.capability && typeof a.capability === "object", `渠道 ${id} 缺 capability`);
    assert.strictEqual(typeof a.start, "function", `渠道 ${id} 缺 start`);
    assert.strictEqual(typeof a.stop, "function", `渠道 ${id} 缺 stop`);
    assert.strictEqual(typeof a.send, "function", `渠道 ${id} 缺 send`);
    assert.strictEqual(typeof a.getStatus, "function", `渠道 ${id} 缺 getStatus`);

    // capability 必须是完整的九项
    for (const key of ["text", "image", "audio", "file", "video", "markdown", "card", "sticker"]) {
      assert.ok(key in a.capability, `渠道 ${id} 的 capability 缺 ${key}`);
    }
    assert.ok(Number.isFinite(a.capability.maxTextLength), `渠道 ${id} 的 capability 缺 maxTextLength`);
  }
}

function checkIpc(ipcs) {
  assert.ok(ipcs.size > 0, "至少注册一个 IPC");
  for (const channel of ipcs.keys()) {
    assert.match(channel, /^[a-zA-Z0-9._-]{1,64}$/, `IPC 通道名不合法：${channel}`);
    assert.strictEqual(typeof ipcs.get(channel), "function", `IPC ${channel} 的 handler 必须是函数`);
  }
}

/* ---------------------------- 主流程 ---------------------------- */

async function main() {
  const results = [];
  const ok = (name) => results.push({ name, pass: true });
  const fail = (name, err) => results.push({ name, pass: false, err });

  // 0. 语法检查（每个文件都 check 一遍）
  {
    const { execFileSync } = require("node:child_process");
    const fs = require("node:fs");

    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "runtime") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(cjs|js|mjs)$/.test(entry.name)) files.push(full);
      }
    };
    walk(root);

    let bad = 0;
    for (const file of files) {
      try {
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
      } catch (e) {
        bad += 1;
        fail(`语法检查 ${path.relative(root, file)}`, new Error(String(e.stderr || e.message).slice(0, 400)));
      }
    }
    if (bad === 0) ok(`语法检查（${files.length} 个文件）`);
  }

  // 1. manifest
  let manifest;
  try {
    manifest = checkManifest();
    ok("manifest 字段与约束");
  } catch (e) {
    fail("manifest 字段与约束", e);
  }

  // 2. 加载插件并 register
  let plugin;
  try {
    plugin = require(path.join(root, manifest ? manifest.entry : "index.cjs"));
    assert.strictEqual(typeof plugin.register, "function", "插件必须导出 register()");
    assert.strictEqual(typeof plugin.unregister, "function", "插件必须导出 unregister()");
    assert.strictEqual(typeof plugin.open, "function", "插件应该导出 open()（有设置窗口）");
    ok("入口契约（register / unregister / open）");
  } catch (e) {
    fail("入口契约（register / unregister / open）", e);
    return report(results);
  }

  const { ctx, state } = createMockContext();

  try {
    await plugin.register(ctx);
    ok("register() 执行不抛错");
  } catch (e) {
    fail("register() 执行不抛错", e);
    return report(results);
  }

  // 3. 工具
  try {
    const ids = checkTools(state.tools);
    ok(`工具契约（${ids.size} 个）`);
  } catch (e) {
    fail("工具契约", e);
  }

  // 4. prompt provider
  try {
    checkPromptProvider(state.providers);
    ok(`提示词 Provider（${state.providers.length} 个）`);
  } catch (e) {
    fail("提示词 Provider", e);
  }

  // 5. channel adapter
  try {
    checkChannelAdapter(state.channels);
    ok(`渠道适配器（${state.channels.length} 个）`);
  } catch (e) {
    fail("渠道适配器", e);
  }

  // 6. IPC
  try {
    checkIpc(state.ipcs);
    ok(`IPC 通道（${state.ipcs.size} 个）`);
  } catch (e) {
    fail("IPC 通道", e);
  }

  // 7. 只读工具在未连接时的行为（不能崩，只能给出可读提示）
  try {
    const statusTool = state.tools.find((t) => t.id === `${PLUGIN_ID}_status`);
    const output = await statusTool.execute({});
    assert.strictEqual(typeof output, "string", "status 应返回字符串");
    assert.ok(output.length > 0, "status 不应返回空字符串");
    ok("未连接时只读工具正常降级");
  } catch (e) {
    fail("未连接时只读工具正常降级", e);
  }

  // 8. 需要连接的工具应该明确报错，而不是静默失败
  try {
    const invTool = state.tools.find((t) => t.id === `${PLUGIN_ID}_inventory`);
    let threw = false;
    try {
      await invTool.execute({});
    } catch (err) {
      threw = true;
      assert.match(String(err.message), /连|连接|connect/i, "错误信息应该提示需要先连接");
    }
    assert.ok(threw, "未连接时 inventory 应该抛错");
    ok("未连接时写操作工具明确报错");
  } catch (e) {
    fail("未连接时写操作工具明确报错", e);
  }

  // 9. IPC snapshot 能拿到结构完整的数据
  try {
    const snap = await state.ipcs.get("snapshot")();
    assert.ok(snap && typeof snap === "object", "snapshot 应返回对象");
    assert.ok(snap.version, "snapshot 应带 version");
    assert.ok(snap.status, "snapshot 应带 status");
    assert.ok(snap.settings, "snapshot 应带 settings");
    assert.ok(Array.isArray(snap.accounts), "snapshot.accounts 应是数组");
    ok("IPC snapshot 结构完整");
  } catch (e) {
    fail("IPC snapshot 结构完整", e);
  }

  // 10. settings 能写入并读回
  try {
    await state.ipcs.get("settings")({ wakeEnabled: true, lowHealthThreshold: 8 });
    const snap = await state.ipcs.get("snapshot")();
    assert.strictEqual(snap.settings.wakeEnabled, true, "设置没有写进去");
    assert.strictEqual(snap.settings.lowHealthThreshold, 8, "数字设置没有写进去");
    ok("IPC settings 读写往返");
  } catch (e) {
    fail("IPC settings 读写往返", e);
  }

  // 11. unregister 幂等
  try {
    await plugin.unregister();
    await plugin.unregister();
    await plugin.unregister();
    ok("unregister() 可重复调用");
  } catch (e) {
    fail("unregister() 可重复调用", e);
  }

  report(results);
}

function report(results) {
  const passed = results.filter((r) => r.pass);
  const failed = results.filter((r) => !r.pass);

  console.log("");
  console.log("═".repeat(60));
  for (const r of results) {
    console.log(`${r.pass ? "  ✔" : "  ✘"} ${r.name}`);
    if (!r.pass) console.log(`       ${r.err && r.err.message ? r.err.message : r.err}`);
  }
  console.log("═".repeat(60));
  console.log(`通过 ${passed.length} / ${results.length}`);

  if (failed.length) {
    console.log("");
    console.log("有失败项，修完再打包。");
    process.exit(1);
  }

  console.log("全部通过，可以打包。");
}

main().catch((e) => {
  console.error("冒烟测试自身崩了：", e);
  process.exit(1);
});
