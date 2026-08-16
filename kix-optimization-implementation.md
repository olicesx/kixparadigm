# KIX Token 优化 —— 落地实施记录（2026-08-15，v5：en 版 preset 同步）

> 决策人：AI agent（本会话），依据 `kix-task-log-analysis.md` 的实测日志分析。
> 状态：**已全部落地 + 已挂载校验 + 单元测试全绿 + 关键路径已实测**。行为性改动在「新会话」生效（预设组合在会话创建时加载）。

---

## 〇、v6：WSL2 实测驱动补强（2026-08-17 第六轮，v1.2.5）

> 依据：v1.2.3 在 WSL2 的 dae 审查实测（session-92459753，106 步 / 3 子代理 / 思考 39.1k）。
> 总评：范式六机制全部按设计触发，成本纪律兑现（思考 ↓84%、轮询 ↓93%、工具面 24 个/6.4k）。
> 本轮修三个实测偏离点，全部有会话日志证据：

| # | 实测偏离 | 根因 | 落地 |
|---|---|---|---|
| 1 | 3 个观察者全 deepseek（视角异质 ✓ / 模型异质 ✗），`subagent_cross` 未用；事后靠物证（复现测试+内核源码）补偿但无留痕要求 | persona「最高置信用 cross」是结论侧形容词，spawn 决策时刻无从命中 | persona 三通道节 +1 行：两轴异质不可互替；外部语义密集任务观察者组 ≥1 cross；发布 HIGH 前每条 ≥1 独立通道（cross 或物证）并在交叉验证说明注明 |
| 2 | 8 次 `sleep 45~240s` 占住回合等子代理（15.8 分钟；轮询已 ↓93% 但模型找到 sleep 这个更便宜的洞） | 「禁止轮询空转」只堵 LLM 循环，没写「独立工作做完后怎么办」；模型不敢收回合（不确定会不会被唤醒） | persona 成本纪律节补「结束回合」规则（带机制事实：结算/报告投递无条件唤醒新回合，零丢失）；kix-orchestration **v4** 机械检测「bash 裸 sleep + description 提及 subagent/子代理」→ 一次性 remind（独立槽位/标志，不烧 handoff remind；0% 误报：测试退避 sleep 不命中） |
| 3 | 双通道重复投递：3 个子代理均「`report` 全文 + 最终消息再放全文」，父级 3 个纯确认额外回合 | dsh-subagent 设计：report 是运行中中继、settled 无条件带最终消息全文，README 明文 "both costs the parent both" | persona 成本纪律节补「单通道交付」：默认最终消息=完整报告勿再 report 同文；子代理继承完整 persona（实测 35.3k vs 34.1k 字符），一处改双侧生效 |

**机制事实固化**：`DSH-ADAPTATION.md` 新增 §3.1（两条回传通道语义表 / 唤醒机制 / 双通道冗余 / sleep 反模式），来源 dsh-subagent 源码 + 实测。

**验证**：kix-orchestration 55/55（+7 v4 断言，含实测样本回放、0% 误报、一次性、槽位独立性）；en 副本同步后 55/55；`npm test` 全绿。

**明确不做**：① cross 缺席的机械提醒（prompt 关键词匹配模糊，等下一轮实测证明 persona 层失效再议——规则是负债）；② settled/report 文本重叠的机械去重（模糊文本比对违反 0% 误报纪律，persona 已从源头消除）。

---

## 〇、v5：en（kixparadigm-en）同步（2026-08-15 第五轮）

`en/` 是完整英文 preset（`kixparadigm-en`，已安装），v5.8 成本纪律机制全部同步：

| en 位置 | 同步内容 |
|---|---|
| `en/preset/agent.cordis.yml` | persona 新增英文「Cost Discipline」节（与 zh 全等）；`tool-subagent-lite`（glm-4.7 + 机械 persona + toolFilter + 8K 帽）、`tool-subagent-thinker`（128K 帽）；`tool-subagent`/`zhipu`/`fork` 加预算帽；`kix-cost` 挂载行（英文注释） |
| `en/preset/plugins/kix-cost.js` + `kix-cost.test.js` | 复制（代码语言中立，与 en 现有插件风格一致）；**en 副本单元测试 24/24 通过** |
| `en/preset/DSH-ADAPTATION.md`（英文权威映射） | §1 新增子代理分档行；§3 扩展为「Delegation, cost tiers & vision」（自动选型、effort 归一化、预算帽、↓83% 数据） |
| `en/preset/skills/kixpower/SKILL.md` | 新增 v5.8 成本纪律表（⑭-⑱），与 zh 副本全等 |
| `en/preset/TRANSLATION-STATUS.md` | plugins 行更新（kix-cost.js） |
| 同步 | 全部复制到 `~/.dsh/.agent-presets/kixparadigm-en/`；diff 均 0；**挂载校验 `mounted OK: kixparadigm-en`**；zh `kixparadigm` 复校验 OK |

zh 侧同步：`skills/kixpower/SKILL.md` 四个副本（root / dsh/preset / en/preset / 两个安装目录）统一加入 v5.8 表。

---

## 〇、v4：默认档 medium → high（2026-08-15 第四轮，用户裁决）

用户裁决：**默认档应该是 high**。已全链路对齐：

| 位置 | 变更 |
|---|---|
| `~/.dsh/settings.yaml` | `reasoningEffort: high`（用户已在 UI 调为 high，注释同步更新；主会话新会话默认 high） |
| `plugins/kix-cost.js` | `CHILD_EFFORT: 'medium' → 'high'`（普通 deepseek 子代理归一化注入 high；thinker → max 不变；语义从「降档」改为「归一化 + 预算帽」——适配器默认本就是 high/256K，真正防线是 64K 预算帽） |
| `plugins/kix-cost.test.js` | 期望值更新 + 新增 7b 分支（回退且环境默认无 effort → 注入 high），**24/24 通过** |
| `agent.cordis.yml` | persona 机制事实 / 角色分档 / lite 行注释 / kix-cost 行注释全部同步 high |

**最终档位矩阵**：lite（glm-4.7 精简机械，思考 ≈0）→ subagent（deepseek **high**，64K 帽）→ subagent_thinker（deepseek **max**，128K 帽）→ subagent_cross（kix-route 自动取反厂商，64K 帽；v5.9 起替代原 subagent_zhipu 钉值行）。

**收益语义调整**：思考侧节省从「high→medium」变为「预算帽 64K vs 适配器 256K 的跑飞截断 + lite 机械档零思考」；每步固定开销 ↓83% 与轮询/重复/重试规则不变。

**验证**：单元测试 24/24；挂载校验 `mounted OK`；三文件 diff = 0。

---

## 〇、v3：机械档自动选型（2026-08-15 第三轮，回应「大家的环境不一样」）

### 问题
`subagent_lite` 若硬编码 `zai-coding-cn/glm-4.7`，preset 分发到其他部署（无 zai provider / 无该模型 / 不同 API key）会直接失效。DSH 机制约束：子代理路由必须是精确 (provider, model) 对，没有「auto」路由。

### 方案（`kix-effort` → 升级更名 `kix-cost`）
`plugins/kix-cost.js` 在 `agent/request` waterfall 上做两件事：

**A. 机械档自动选型**：轻量子代理（预算帽 ≤8K）首次请求时探测首选路由可用性
（`llm.listProviders()` 查 provider 注册 + `llm.resolveModelInfo()` 查模型可解析）；
- 可用 → 保留首选路由（本环境：zai/glm-4.7，思考由 GLM 适配器自管）；
- 不可用（其他环境）→ **自动回退环境默认路由**（`agentDefaultModel.currentSelection()`，
  任何部署都有），并继续走档位注入（回退后通常是 deepseek → medium）。
- 探测按子代理缓存（WeakMap，无泄漏），每子代理只探测一次；llm 服务缺失时保留首选路由不探测。

**B. 思考强度分层**（不变）：无显式 effort 的 deepseek 子代理，预算帽 ≥98K（`subagent_thinker`）
→ max，其余（64K 帽）→ medium；GLM 行适配器自管；主会话/显式 effort 不干预。

### 收益（自动选型后的跨环境语义）
| 环境 | lite 档实际路由 | 思考 | 每步固定开销 |
|---|---|---|---|
| 有 zai/glm-4.7（本环境） | zai/glm-4.7 | GLM 适配器自管（实测 ≈0 思考） | ~5.9k（↓83%） |
| 无 zai（其他部署） | 环境默认路由（通常 deepseek） | medium（kix-cost 注入） | ~5.9k（↓83%，精简组合普适） |

其他部署还可直接改 `agent.cordis.yml` 中 lite 行的 `agentOptions.provider/model` 指向自家廉价模型——探测机制自动适配。

### 验证
- **单元测试 `node plugins/kix-cost.test.js`：23/23 通过**（档位注入 medium/max、子代理判别、
  lite 可用保留 / 不可用回退、显式 effort 不干预、llm 缺失降级、probeRoute 纯函数含异常吞没）；
- 组合挂载校验：`mounted OK: kixparadigm`（kix-cost 行激活）；
- 工作区 ↔ 已安装 preset：diff = 0；旧 `kix-effort.js` 已删除，引用全部更新。

---

## 一、决策清单（做了什么，为什么）

| # | 措施 | 落点 | 依据（日志/论文） | 生效范围 |
|---|---|---|---|---|
| 1 | 全局默认 effort `max/high → medium` | `~/.dsh/settings.yaml` | 主会话思考占完成侧 92%，17 个重度会话占 78%；固定高强度非最优（Snell 2408.03314） | **新会话**的主会话（旧会话 selection 已锁定，不受影响） |
| 2 | **`kix-cost` 插件（A 自动选型 + B 档位注入）**：无显式 effort 的 deepseek 子代理，预算帽 ≥98K → `max`，否则 → `medium`；lite 首选路由不可用 → 回退环境默认路由 | `dsh/preset/plugins/kix-cost.js` + `agent.cordis.yml` 一行 | 机制根源：`AgentOptions` 无 effort 字段 → deepseek 适配器默认 high/256K（日志 adapterDefaults 实证）；跨环境分发不能硬编码模型 | 新会话的 `subagent` / `subagent_thinker` / `subagent_fork` / `subagent_lite` 子代理 |
| 3 | **`subagent_lite` 行 = DSH 精简模式 + 自动选型**：机械 persona（~60 token，shadow 17k 人格）+ toolFilter（read/grep/glob/pwsh，1.6k 替代 17.2k）+ 8K 帽 + 首选 zai/glm-4.7（不可用自动回退） | `agent.cordis.yml` | 实测：普通子代理每步固定开销 34.3k → lite ≈5.9k（↓83%） | 新会话（工具列表出现 `subagent_lite`） |
| 4 | **`subagent_thinker` 行**：deepseek-v4-flash + 128K 帽（kix-cost 据此注入 max） | `agent.cordis.yml` | 「该用 max 的任务仍用 max」的显式出口 | 新会话（工具列表出现 `subagent_thinker`） |
| 5 | **per-role 预算帽**：subagent/zhipu/fork 64K，thinker 128K，lite 8K | 各工具行 `agentOptions.maxTokens` | s1 budget forcing + 适配器默认 256K 失控上限 | 新会话 |
| 6 | **persona 成本纪律 8 条**：四档分派、[EFFORT]/[BUDGET] 标注、观察者门控、禁轮询空转、outputSchema 结构化回流、跨会话结论复用、同会话去重、机械判定标准 | `agent.cordis.yml` persona | 日志：91 步轮询烧 40.9k 思考；PR29 重审 3 次 ≈547k；11 子代理 fan-out；读图三连 | 新会话起每次思考生效 |

## 二、关键机制结论（源码 + 日志验证）

1. **主会话 effort 锁定于会话创建时**的 settings 值（api-proxy `selectionFor` 读 logged request header）；改 settings 不影响已开会话。
2. **子代理 effort 来自 deepseek 适配器默认（high/256K）**：`resolveChildAgentOptions` 只传 provider/model/maxTokens；日志 `request/header.adapterDefaults = {reasoningEffort:true, maxTokens:true}` 实证默认值。`kix-cost` 在 `agent/request` waterfall 注入（waterfall 看到的是 prepareCall 之前的配置，注入生效）。
3. **判别器**：子代理 options 带 `subagentDepth ≥ 1`；预算帽（maxTokens）兼作档位判别器（≥98K → max）与机械档判别器（≤8K → 自动选型）。
4. **每步固定开销实测**：普通子代理 34.3k（系统 17.1k + 工具 17.2k）；workflow 子代理 22.4k（系统 4.4k + 工具 18.0k）；lite 行投影 ≈5.9k（系统 ~4.4k + 工具 1.6k）。
5. **边界**：`workflow` 子代理走部署自带 `cordis` preset，**kix-cost 不覆盖**；workflow 内建议用 `agent(prompt, {provider, model})` 指定模型控制成本（历史仅 4 次 workflow 用量，影响小）。

## 三、验证结果（已实测）

| 验证项 | 结果 |
|---|---|
| 组合挂载校验（roster `standingKeyFor`，真实组合插件子树） | ✅ 三次均 `mounted OK: kixparadigm`（lite 精简组合、thinker 行、kix-cost、预算帽、persona 全部激活） |
| **单元测试 `node plugins/kix-cost.test.js`** | ✅ **23/23 通过**（含自动选型可用/不可用/llm 缺失三分支） |
| lite 档路由端到端（workflow agent → zai glm） | ✅ glm-4.5-air 与 glm-4.7 均实测可用 |
| **机械任务实测（workflow agent → glm-4.7，读 preset.yml 并报告）** | ✅ 任务完成：1 次 read 调用、**reasoning 0 token**、输出 ~200 token |
| 工具裁剪精确值（从真实 request/header 计算） | ✅ 82→4 个：17,191 → 1,637 token（↓90.5%） |
| 工作区 ↔ 已安装 preset 同步 | ✅ 全部文件 diff = 0；旧 kix-effort.js 已清除 |

**对照基线**（优化前，日志实测）：普通 deepseek 子代理每步固定开销 34.3k；思考默认 high（单会话最高 105.8k）；主会话机械步骤（grep+pwsh）单步思考最高 17.4k。

## 四、收益量化（实测数据推导）

| 场景 | 优化前（实测/日志） | 优化后（投影/实测） | 节省 |
|---|---|---|---|
| 机械任务子代理，10 步 | 每步 34.3k 固定开销 + 思考默认 high | lite 行：每步 ~5.9k + glm-4.7 思考 ≈0 | **每步 ↓83% 输入**，思考侧 ≈全省 |
| 普通子代理（验证类），10 步 | 思考 high（13.9k–105.8k/会话）+ 无上限 | 思考 medium + 64K 帽 | 思考预计 ↓40–70%（e1/s1 锚点）+ 跑飞截断 |
| 主会话（新会话） | effort max | effort medium（重活可 UI 调高） | 思考预计 ↓30–50% |
| 轮询空转 | 91 步轮询 40.9k 思考/会话 | persona 禁轮询规则 | 每重度会话 ↓15–20% 完成侧 + 大量输入侧 |
| 重复任务 | PR29 ×3 = 547k 思考 | 结论复用规则 | 按重复率线性下降 |

注：输入侧有 provider 自动上下文缓存折扣（命中价 ~1/10），实际账单节省小于裸 token 差，但方向一致且量级显著。

## 五、新会话验证流程（1 分钟）

新开一个会话后：
1. **工具列表**应出现 `subagent` / `subagent_lite` / `subagent_thinker` / `subagent_cross` / `subagent_vision` / `subagent_fork`（v5.9 起无 `subagent_zhipu` 行，跨厂商由 `subagent_cross` 哨兵路由承担）。
2. spawn 一个普通子代理做小任务，查其会话日志 `request/header`：
   - 普通行 → `reasoningEffort: medium`（不再是适配器默认 high）；
   - `subagent_thinker` → `reasoningEffort: max`；
   - `subagent_lite` → 系统提示 ~4.4k、工具 4 个、`reasoningEffort` 无（GLM 自管）；
   - 无 zai 环境：lite 子代理首请求后 `request/header` 路由为默认 provider/model（回退生效）。
3. 主会话自身 effort 仍为会话创建时的 settings 值（新会话 = medium；重活可临时在 UI 模型选择器调高）。

## 六、自检记录（2026-08-15，实地测试前最后一道门）

| # | 检查项 | 结果 |
|---|---|---|
| 1 | settings.yaml `reasoningEffort: medium`（含注释） | ✅ |
| 2 | 工作区 ↔ 安装目录三文件 diff（agent.cordis.yml / kix-cost.js / kix-cost.test.js） | ✅ 均 0 |
| 3 | 旧 kix-effort.js 双目录已删除；全 preset 无 kix-effort 残留引用（含 md/yml/js） | ✅ |
| 4 | 安装目录含 subagent_lite / subagent_thinker / kix-cost 行（20 处命中） | ✅ |
| 5 | 单元测试 `node plugins/kix-cost.test.js` | ✅ 23/23（两次复跑） |
| 6 | 插件终稿人工复核（档位注入、lite 探测/回退/缓存、异常吞没、llm 缺失降级） | ✅ 无逻辑缺陷 |
| 7 | 组合挂载校验（roster `standingKeyFor`，终态） | ✅ `mounted OK: kixparadigm` |
| 8 | 探针插件已 stop + undefine（无残留动态插件） | ✅ |
| 9 | 测量工具链已固化 `tools/log-audit/`（8 脚本 + README） | ✅ |

**已知边界（设计内，非缺陷）**：① workflow 子代理走部署自带 `cordis` preset，kix-cost 不覆盖（workflow 内用 `agent(prompt, {provider, model})` 控制）；② 探测只验证「provider/模型注册」，不验证 API key 有效性；③ 行为性改动全部在**新会话**生效（预设组合会话创建时加载），本会话（旧组合）不受影响。

**实地测试步骤**：新开会话 → 正常使用（建议跑一个含子代理分派/验证的真实任务）→ 期间可 spawn 一次 `subagent_lite` 与 `subagent_thinker` 看效果 → 跑 `tools/log-audit/` 重新度量 → 与基线对比（见 README §优化前后对比步骤）。

## 七、改动文件清单

| 文件 | 改动 |
|---|---|
| `~/.dsh/settings.yaml` | `reasoningEffort: medium` + 注释 |
| `dsh/preset/agent.cordis.yml`（= `~/.dsh/.agent-presets/kixparadigm/agent.cordis.yml`） | persona 新增「成本纪律」节；新增 `tool-subagent-lite`（glm-4.7 首选 + persona + toolFilter + 自动回退）与 `tool-subagent-thinker`（128K 帽）行；`tool-subagent`/`tool-subagent-zhipu`/`tool-subagent-fork` 加 maxTokens 帽；`kix-cost` 挂载行 |
| `dsh/preset/plugins/kix-cost.js`（= `~/.dsh/.agent-presets/kixparadigm/plugins/kix-cost.js`） | 新增（替代 kix-effort.js）：agent/request 自动选型 + 档位注入插件（CommonJS，`__internals` 供测试） |
| `dsh/preset/plugins/kix-cost.test.js`（= 安装目录同路径） | 新增：单元测试 23 例（`node plugins/kix-cost.test.js`） |
| `tools/log-audit/*`（8 脚本 + README） | 新增：会话日志测量工具链（解码/汇总/深挖/开销/工具裁剪），优化前后对比用 |
| `kix-task-log-analysis.md` / `kix-subagent-token-optimization.md` | 前两轮分析报告（本记录的前置依据） |
