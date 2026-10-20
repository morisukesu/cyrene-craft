# 环境复现对照表

这份文档记录的是：**whale-craft 依赖的每一个 DSH 能力，在 Cyrene 里能不能复现、怎么复现、复现不了怎么办。**

判断依据全部来自实际读取 Cyrene 插件 API 文档、`plugins/minecraft-bot` 源码与 `plugins/system-status` 示例，不靠印象。

---

## 结论摘要

| 结论 | 数量 | 说明 |
|---|---|---|
| ✅ 完全等价 | 13 项 | 换 API 名字就能用 |
| ✅ 功能等价（实现方式不同） | 2 项 | 看门狗、账户凭据 |
| ⚠️ 降级可用 | 2 项 | 会话隔离、图片渲染 |
| ❌ 无法复现 | 1 项 | 宿主 preset 改写 |

**最关键的一条硬差异**：Cyrene 的工具 `execute(args)` 拿不到会话上下文（DSH 里是 `exec.agent.id`）。这直接决定了本插件必须是全局单实例，而不是「每对话一个机器人」。

---

## 逐项对照

### 工具与实例

| DSH 能力 | whale-craft 用法 | Cyrene 复现 | 结论 |
|---|---|---|---|
| `ctx.tools.register(spec)` | 注册 33 个 `mc_*` 工具 | `ctx.registerTool(spec)`，id 改为 `cyrene-craft_*` | ✅ 等价 |
| `exec.agent.id` 拿会话 id | 每会话一个 `McBot` 实例 | **Cyrene 的 `execute(args)` 没有第二个参数**，拿不到 agent | ⚠️ **降级：全局单实例** |
| `defineTool` 来自 `@deepseek-ai/dsh-tools` | 工具定义层 | `ctx.registerTool` 直接吃普通对象，不需要这层 | ✅ 更简单 |
| `Config` / schemastery 配置 schema | 插件配置声明 | Cyrene 用 `ctx.storage` 存 JSON + 设置窗口自己收集 | ✅ 等价（方式不同） |

**关于会话隔离的实测**：`api-spec.md` 里工具签名明确写的是 `async execute(args)`，只有一个参数；`minecraft-bot` 插件的 33 个工具也全部是 `async execute(args)`。没有 `exec`，没有 `agent`，没有 `conversationId`。这是 API 层面的缺失，不是用法问题。

---

### 事件与唤醒

| DSH 能力 | whale-craft 用法 | Cyrene 复现 | 结论 |
|---|---|---|---|
| job 结算 + followup 唤醒 | `mc_watch` 后台任务结算后叫醒 AI | **channel adapter 的 `onMessage` 可以由插件主动调用**，注入一条入站消息 → 宿主跑一轮 Agent | ✅ 功能等价 |
| `mc_events` 事件队列 | AI 主动拉取 | `bridge` 里保留环形队列 + `cyrene-craft_events` 工具 + Provider 注入未读摘要 | ✅ 等价 |
| 看门狗打断正在进行的工具调用 | `interruptWait` 打断 `mc_events` 等待 | Cyrene 没有打断机制；改为「事件进队列，下一轮自然可见」+ 可选主动唤醒 | ✅ 等价（弱一点） |

**唤醒的实现细节**：`minecraft-bot` 的 `channel.js` 里 `onMessage` 是宿主设置给 adapter 的回调。adapter 自己持有一个引用，只要在需要时构造 `{channel, chatType, messageId, senderId, text, at}` 调一次，宿主就会当成一条正常的外部消息处理。

代价是每唤醒一次就是一轮完整 LLM 调用，所以做了三层限制：默认关闭、全局冷却 90 秒、同类事件独立冷却。

---

### 文件与数据

| DSH 能力 | whale-craft 用法 | Cyrene 复现 | 结论 |
|---|---|---|---|
| `$DSH_HOME/whale_craft/` 插件家目录 | 配置、账户、日志 | `plugin-data/cyrene-craft/`（从 `%APPDATA%/Cyrene/plugin-data/` 推断） | ✅ 等价 |
| 会话工作区路径 | `.whale-craft/` 记忆树 | `ctx.deps.workspace.getBinding(convId)` 拿只读绑定，退化到数据目录 | ✅ 等价 |
| 宿主 webServer 挂载 | `mc_kit_express` 文件分享（web 模式） | **Cyrene 没有 webServer 注入**，自己起 `http.createServer` 监听 127.0.0.1 | ✅ 等价（只剩桌面模式） |
| 账户密码存宿主配置 | `accounts.json` + 宿主凭据管理 | `ctx.deps.secrets.get/set/delete` + 元数据单独存 JSON | ✅ 等价，且更安全 |

---

### 提示词

| DSH 能力 | whale-craft 用法 | Cyrene 复现 | 结论 |
|---|---|---|---|
| `RULES.md` / 版本提示注入 | 进服时注入行事准则 | `ctx.registerPromptProvider` 每轮注入，内容读自记忆树 | ✅ 等价 |
| 提示词去重与版本标记 | `wsconfig.mjs` 版本号比对 | storage 存版本标记 + Provider 每轮返回 | ✅ 等价 |
| `AGENTS.md` 自动注入 | 固定注入工作区指令 | Cyrene 没有 AGENTS.md 机制，改为 `RULES.md` 放在记忆树里 | ⚠️ 变通 |

**Provider 的纪律**：只写事实（坐标、血量、背包），绝不写指令性内容。这一条是插件 API 文档明确要求的，也写进了 `src/prompt.cjs` 的文件头注释。

---

### 机制缺失

| DSH 能力 | whale-craft 用法 | Cyrene 情况 | 结论 |
|---|---|---|---|
| `disableShellInComposition` | 改写宿主 preset，MC 模式下禁用 shell | **Cyrene 没有「模式」概念，也没有 preset 改写 API** | ❌ 不移植 |
| `patchPersonaInComposition` | 按模式替换人格 | 同上 | ❌ 不移植 |
| `patchToolGroupsIntoComposition` | 按模式限制工具面 | 同上 | ❌ 不移植 |

这三项对应的原本目的是「MC 模式下只暴露游戏工具，避免模型分心」。Cyrene 里改为：

- 所有 33 个工具的 `description` 都写清「什么场景该用」，靠描述引导而不是硬限制
- 敏感操作（`cyrene-craft_command`）单独用 `risk: "input-control"` 标出来

---

### 原生实现

| 能力 | whale-craft | cyrene-craft | 结论 |
|---|---|---|---|
| PNG 编码 | 自带 `src/png.mjs`（纯 JS） | `src/png.cjs`（纯 JS，zlib + CRC32） | ✅ 等价 |
| 地图渲染 | `mc_map` / `mc_height` 字符图 | 同名工具 + `cyrene-craft_image` 出 PNG | ✅ 等价 |
| 局域网公告 | `dgram` 多播 224.0.2.60:4445 | `src/lan.cjs` 同实现 | ✅ 等价 |
| STATUS ping | 手写 Minecraft 协议 | `bot-runtime.cjs` 内 `doPing` 同实现 | ✅ 等价 |
| SVG → PNG | 可选依赖 `sharp` | **不引 sharp**；`cyrene-craft_image` 直接画像素，不走 SVG | ✅ 绕开了 |
| 子进程隔离 | mineflayer 跑在子进程 | `ELECTRON_RUN_AS_NODE` + JSON 行协议 | ✅ 等价 |

---

## 为什么运行时不能打包

实测数据：

```
minecraft-bot/runtime/bot-runtime/node_modules
  → 1808 个文件 / 98.4 MB
```

Cyrene 插件 zip 限制：

```
≤ 50 MiB、≤ 2000 条目、解压后 ≤ 200 MiB
```

即使只打包 mineflayer 本体（不含 minecraft-data），`minecraft-data` 的方块数据单个文件就有 1.7 MB。塞不进。

所以采用三级解析：

1. 自己装的（`plugin-data/cyrene-craft/runtime/bot-runtime/node_modules`）
2. 复用 `minecraft-bot` 的（本机实测存在，mineflayer 4.39.0 全套可用）
3. 都没有 → `ELECTRON_RUN_AS_NODE` 跑 `npm install --prefix` 自动装到 1

第 2 条是主力路径。用户只要装了 `minecraft-bot`，零下载就能用。

---

## 打包后的体积

插件本体（不含运行时）：

```
index.cjs        60 KB
ui.html          22 KB
src/*.cjs        ~110 KB
tools/*.cjs      22 KB
README/DESIGN/COMPAT
────────────────────
合计            ~220 KB
```

远在限制之内。

---

## 未验证的部分（诚实清单）

| 项 | 状态 | 怎么验证 |
|---|---|---|
| `ELECTRON_RUN_AS_NODE` 在 Cyrene 里能否跑通 | **未实测** | 真装进 Cyrene 后连一次服务器；失败时 `cyrene-craft_diag` 会给原因 |
| `onMessage` 主动调用能否唤醒 AI | **未实测** | 打开唤醒，进游戏打一句「昔涟」 |
| 弹窗 `open()` 是否正常显示 | **未实测** | 点插件卡片的「打开」 |
| 真实服务器连接 | **未实测** | 需要你提供服务器地址；`cyrene-craft_ping` 可以先用假地址验证失败路径 |

已实测通过的部分：

- 13 项契约冒烟（manifest / 33 工具 / schema / IPC / unregister 幂等）
- 12 项链路联调（子进程启动、行协议配对、错误路径、干净退出）
- mineflayer / mineflayer-pathfinder / vec3 三个包在目标运行时目录里可正常 `require`
