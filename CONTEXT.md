# 上下文日志 · cyrene-craft

> 最后更新：2026-10-20 15:52　·　版本 v1.0.0
> 本文件由 `tools/context-log.cjs` 整份覆写，不追加。

## 当前状态

采集零收益判定修复完成并经实机验证：空手 collect stone 现在会进轨迹记 ok:false，selfCheck 自动编出 mine_stone_with_wooden_pickaxe 并存入技能库。目标仍停在「做出石镐」，背包 1 块圆石，还差 2 块。

## 本轮完成

- index.cjs 工具包装器改用 judgeOutcome 判定，complete:false 不再被记成成功
- bot-runtime.doSequence 每步认 complete:false，把 reason 带进 error 并记 ok:false
- index.cjs sequence 有失败步骤时抛错，让包装器把失败写进轨迹
- skill-test 新增「零收益采集经 judgeOutcome 后能编成教训」断言
- 实机跑通完整链路：空手采集失败 → 装备木镐 → 采集成功 → 自检编出技能
- mine_stone_with_wooden_pickaxe 已保存进技能库，技能总数 6 个

## 验证证据

- smoke 13/13、skill 22/22、collect 11/11、brain-loop 43/43、autoplay 31/31、trace 12/12
- 实机轨迹：空手 collect stone 记 ok=false，原因「空手挖 stone 没有掉落（需要可用工具）」
- 实机轨迹：act equip wooden_pickaxe 记 ok=true
- 实机轨迹：collect stone tool=wooden_pickaxe 记 ok=true
- selfCheck 输出「发现：lesson：mine_stone_with_wooden_pickaxe」
- lessons 输出「最近经验：1 条｜mine_stone_with_wooden_pickaxe：stone + wooden_pickaxe（已保存）」
- skill list：6 个技能，含 mine_stone_with_wooden_pickaxe
- 安装目录 index.cjs 与 src/bot-runtime.cjs 哈希 MATCH

## 代码同步状态

⚠ 1 个文件不一致：CONTEXT.md

**需要重新同步**：改完记得跑一次同步命令。

## 代码规模

- src/ 36 个模块　·　tools/ 45 个脚本

## 下一步

1. 再采 2 块圆石，凑够 3 块后 craft stone_pickaxe
2. 修 goal 读取：progress.json 报「没有任何节点」，目标图进度只显示 3/19
3. 实跑一次 mine_stone_with_wooden_pickaxe，观察教训技能的真实成功率

## 备注

采集判定要过四层：doCollect 返回 complete:false → doSequence 认它 → sequence 抛错 → 包装器 judgeOutcome 记失败。少任何一层，零收益都会被记成成功，教训编译器就永远看不见。

---

## 复现命令

```bash
cd "E:\Cyrene work\cyrene-craft\cyrene-craft"

# ---- 离线测试（不连服务器，秒级） ----
node tools/smoke.cjs            # 契约冒烟     13 项
node tools/e2e.cjs              # 链路联调     12 项
node tools/instinct-test.cjs    # 本能层单元   14 项
node tools/trace-test.cjs       # 轨迹录制     11 项
node tools/skill-test.cjs       # 技能层       17 项
node tools/insight-test.cjs     # L2 归因      18 项
node tools/intent-test.cjs      # 意图层       11 项
node tools/panel-test.cjs       # 训练面板     17 项
node tools/graph-test.cjs       # 类脑决策层   33 项
node tools/brain-loop-test.cjs  # 执行环       43 项
node tools/brain3d-test.cjs     # 3D 脑图      25 项
node tools/brain-panel-test.cjs # 脑图接口     23 项
node tools/brain-geometry-test.cjs # 3D坐标分区  22 项
node tools/reflex-test.cjs      # 反射层       30 项
node tools/channel-reflex-test.cjs # 反射接线     6 项
node tools/tradition-test.cjs   # 流派提纯     24 项
node tools/muscle-test.cjs      # 肌肉记忆     13 项
node tools/autoplay-test.cjs    # 自主驱动     25 项
node tools/goal-test.cjs        # 目标层       31 项
node tools/goal-plan-test.cjs   # 目标规划     15 项
node tools/goal-graph-test.cjs  # 目标图       13 项
node tools/terrain-test.cjs     # 地形感知     10 项
node tools/route-memory-test.cjs # 路线记忆     9 项
node tools/route-tradition-test.cjs # 路线流派   4 项

# ---- 真连测试（会真的进服务器） ----
node tools/instinct-live.cjs 127.0.0.1 63839 Cyrene     # 本能层真连 10 项
node tools/live-connect.cjs 127.0.0.1 63839 Cyrene      # 世界读写真连 13 项
node tools/skill-live.cjs 127.0.0.1 63839 Cyrene        # 技能层实测 12 项
node tools/skill-closed-loop.cjs 127.0.0.1 63839 Cyrene # 完整闭环 12 项
node tools/autoplay-live.cjs 127.0.0.1 63839 CyreneAuto # 自主驱动真连（只读）
node tools/terrain-live.cjs 127.0.0.1 63839 CyreneAuto # 地形真连（采 1 个）

# ---- 工具 ----
node tools/ping-check.cjs 127.0.0.1 63839   # 探一次服务器
node tools/panel-serve.cjs                   # 独立起训练面板 16051
node tools/context-log.cjs --status "..."    # 覆写本文件
```
