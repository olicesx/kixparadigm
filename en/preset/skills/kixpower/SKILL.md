---
name: kixpower
user-invocable: false
description: "Kixpower — AI 多智能体协作编排（v5.7）。采用 DAG 动态拓扑与跨 Sprint 演进。4 个 slash command 触发：/kixpower-new（新项目）/kixpower-import（导入）/kixpower-continue（继续）/kixpower-review（PR 审查）。本文件为路由入口，完整规则见 TEAM_CONVENTIONS.md / USAGE_MANUAL.md。"
---

> **DSH 适配注记**：本文件从 VS Code Copilot 导入。工具名/机制映射（runSubagent→subagent、run_in_terminal→pwsh、vscode_askQuestions→ask_user_question、hooks 不自动触发（已由 kix-guards 原生替代）、跨厂商模型字符串不适用（用 `subagent_cross` 工具行）、slash command 已注册为 DSH 原生命令）见 preset 根 `DSH-ADAPTATION.md`，冲突时以该文件为准。
>
> **2026-08-16 插件化改造注记**：本文件的编排纪律已插件化——机械门禁 `kix-guards`、纪律 gate `kix-discipline`、**编排交接门禁 `kix-orchestration`**（subagent 交接前校验 sprint marker/plan/progress/blocker/QA 完成度，对应 Copilot 侧 validate-handoff.ps1 的有界移植）、成本分层 `kix-cost`、路由 `kix-route`。本文件保留编排认知与方法（路由索引/流程模板/团队手册），与插件冲突时以插件行为准。改造总览见 preset 根 `PLUGINIZATION-ROADMAP.md`。

# Kixpower — Skill 入口（路由索引）

本文件仅作**路由入口**，承接各文档中「详见 SKILL.md」的引用。完整内容见对应文档。

## 快速触发（4 个 slash command）

| 命令 | 模式 | 详细流程 |
|---|---|---|
| `/kixpower-new` | 1 全新项目 | [kixpower-new.prompt.md](../../prompts/kixpower-new.prompt.md) |
| `/kixpower-import` | 0 已有代码 | [kixpower-import.prompt.md](../../prompts/kixpower-import.prompt.md) |
| `/kixpower-continue` | 2+3 继续恢复 | [kixpower-continue.prompt.md](../../prompts/kixpower-continue.prompt.md) |
| `/kixpower-review` | 4 PR 审查 | [kixpower-review.prompt.md](../../prompts/kixpower-review.prompt.md) |

## 完整文档

- [README.md](./README.md) — 快速开始 + 版本表
- [USAGE_MANUAL.md](./USAGE_MANUAL.md) — 完整使用手册
- [TEAM_CONVENTIONS.md](./TEAM_CONVENTIONS.md) — 通用规则（target_rules / plan.md schema / eval schema / 模型窗口约定）

## v5.7 阶段二相性（元规则 — 指导所有规则设计与修剪，最高优先级）

> 这是 kixpower 的**最高元规则**，指导所有现有和未来规则的设计、分类与修剪。详见 [TEAM_CONVENTIONS.md](./TEAM_CONVENTIONS.md) §阶段二相性原则。

| 原则 | 含义 |
|---|---|
| 创造/验证分离 | 创造阶段最小规则（发散），验证阶段结构化补足（收敛），不互相泄漏认知模式 |
| 补足非限制 | 规则补足 AI 盲点（给工具/视角），不限制发挥（规定怎么思考） |
| 规则是负债 | 每条规则有维护成本+压制涌现风险，定期修剪；新增前问"模型提升后还有价值吗" |

> 论文可靠性分级与来源见 [AUDIT.md](../kixparadigm/AUDIT.md) §1-§2（复查时读，不自动加载）

## v5.0 反过拟合 5 法（承接 README/USAGE_MANUAL「详见 SKILL.md」）

| # | 方法 | 落地段 |
|---|---|---|
| ① | 参数实例化（commit_budget 由 δ 派生 / max_parallelism 由 dag.ω 实时决定） | [TEAM_CONVENTIONS.md](./TEAM_CONVENTIONS.md) §Task Sizing & Commit Budget 派生 + §并行度约定 |
| ② | fidelity 跨 Sprint 累积（趋势 + dead-path 度量） | [scripts/verification-fidelity-check.ps1](./scripts/verification-fidelity-check.ps1) v5.0 累积度量段 |
| ③ | 任务可行性前置 gate（liveness 普适化） | [kixpower-producer.agent.md](../../agents/kixpower-producer.agent.md) §task 可行性前置 gate |
| ④ | 规则一致性评分（新增前 Jaccard 重叠检测） | [kixpower-orchestrator.agent.md](../../agents/kixpower-orchestrator.agent.md) §v5.0 Guardrail 一致性矩阵 |
| ⑤ | 实践学习生命周期（candidate → scoped trial → validated / archived） | [TEAM_CONVENTIONS.md](./TEAM_CONVENTIONS.md) §harness-backlog eval schema（即方法 4/5） |

## v5.1 token 优化 4 法

| # | 方法 | 落地段 |
|---|---|---|
| ⑥ | orchestrator 瘦身（SWEzze 最小充分子序列：去重 + 路由表 + L3 压缩） | [kixpower-orchestrator.agent.md](../../agents/kixpower-orchestrator.agent.md) §执行模式（路由决策） |
| ⑦ | trajectory reduction（AgentDiet 三分类：expired/redundant/useless） | [TEAM_CONVENTIONS.md](./TEAM_CONVENTIONS.md) §progress.md Trajectory Reduction |
| ⑧ | Tri-Block 标签（Cross-Lingual `[CONTEXT]/[TASK]/[CONSTRAINTS]`） | [kixpower-orchestrator.agent.md](../../agents/kixpower-orchestrator.agent.md) §子 agent 调用模板 |
| ⑨ | 结构化区 token 套利（叙述区守 content_language 可读性） | [TEAM_CONVENTIONS.md](./TEAM_CONVENTIONS.md) §结构化区 vs 叙述区 |

## v5.5 补足 AI 盲点（范式）

> 范式：**补足 AI 的系统性盲点，不限制她的发挥**。机械性只用在"动作"（强制读文件/调子 agent），不用在"思考"（固定打勾表）——后者会让模型从"理解"退化为"打勾"，限制泛化能力。

| # | 方法 | 性质 | 落地段 |
|---|---|---|---|
| ⑩ | 反方辩护测试（三问，触发元认知） | 思维引导（赋能） | [review.prompt.md](../../prompts/kixpower-review.prompt.md) §阶段2 + [TEAM_CONVENTIONS.md](./TEAM_CONVENTIONS.md) §证据门禁 |
| ⑪ | AI 盲点图谱（5 类盲区方向 + 补足工具，**非检查表**） | 盲区提醒（赋能） | [review.prompt.md](../../prompts/kixpower-review.prompt.md) §AI 盲点图谱 + [TEAM_CONVENTIONS.md](./TEAM_CONVENTIONS.md) §证据门禁 |
| ⑫ | review-of-review 子 agent（独立 grader，利用多 agent 注意力独立性） | 独立推理（赋能） | [review.prompt.md](../../prompts/kixpower-review.prompt.md) §阶段2.5 |
| ⑬ | claim_evidence_failure trace（L4 闭环度量） | 观测（赋能） | [kixpower-orchestrator.agent.md](../../agents/kixpower-orchestrator.agent.md) §Observe trace schema + §L4 模式识别 |

## v5.8 成本纪律（2026-08-15 日志实测驱动）

> 常驻规则在 `agent.cordis.yml` persona「成本纪律」节（两 edition 均有）；本表是路由索引。
> 机制落地：`plugins/kix-cost.js`（lite 自动选型 + 思考强度归一化）+ 四档子代理工具行 + per-role 预算帽。

| # | 方法 | 落地段 |
|---|---|---|
| ⑭ | 机械档精简组合（`subagent_lite`：机械 persona ~60 token + 只读 4 工具 + 8K 帽；每步固定开销 34.3k → ~5.9k，↓83%） | agent.cordis.yml `tool-subagent-lite` 行 |
| ⑮ | lite 首选路由（zai/glm-4.7）首次请求自动探测，不可用回退环境默认路由（跨环境分发不挂） | `plugins/kix-cost.js` |
| ⑯ | 思考强度归一化：`subagent_thinker`（≥98K 帽）→ max；其余 deepseek 子代理 → high（适配器默认 high/256K，64K 帽是跑飞防线） | `plugins/kix-cost.js`（agent/request waterfall） |
| ⑰ | per-role 预算帽：subagent/cross/fork 64K、thinker 128K、lite 8K | 各工具行 `agentOptions.maxTokens` |
| ⑱ | 禁轮询空转 / 观察者门控（1→分歧+1，并发≤3）/ [EFFORT]+[BUDGET] 标注 / outputSchema 回流 / 跨会话结论复用 / 同会话去重 | persona「成本纪律」节（agent.cordis.yml） |
| ⑲ | 等待步骤零思考：job_output/list_agents 等待是检查点不是思考点；后台任务运行期间做其他独立工作（实测：单次 job_output 等待烧 12,998 思考） | persona「成本纪律」节（agent.cordis.yml） |
| ⑳ | review 流程阶段 2 取证分工：orchestrator 判断 + `subagent_lite` 并行机械取证（只读/检索/核对/枚举走 lite，禁止 orchestrator 逐文件通读 diff） | `prompts/kixpower-review.prompt.md` 阶段 2 |

## v5.9 主会话预算（2026-08-17 会话账本实测驱动）

> 48 会话 / 173M 重读 token 账本定位：80% 燃烧 = 主会话上下文 O(N²) 累积（466K 马拉松重读 100.8M，占 58%），v5.8 只优化了子代理每步固定开销。机制：`plugins/kix-budget.js` + compaction 阈值下调；常驻规则一句话在 persona「成本纪律」节。

| # | 方法 | 落地段 |
|---|---|---|
| ㉑ | 主会话预算：运行时读取模型窗口与 `agent/pre-step.step`，上下文同时感知 usage/tokenMeter；动态预算按窗口分档（≤128K→0.85、≤400K→0.65、≤1M→0.40、>1M→0.35；150K 仅无窗口回退），主会话第 41 步或上下文超线后由 `tools/pre-execute` 拒绝普通工具，必须完成 lite/goal 交接；运行时与会话深度都不可得时强动作 fail-open | `plugins/kix-budget.js` + agent.cordis.yml |
| ㉒ | 机械取证提示：连续 8 步只读仍提供一次 advisory；真正强制边界是主会话 step 41 gate，常见 git 写命令不再误判为只读 | `plugins/kix-budget.js` |
| ㉓ | 工具结果急剪：宿主 pruner 字符阈值默认 2K，单结果超线在下一步边界 head/tail 替换；总上下文过半仍是兜底触发 | `plugins/kix-budget.js` + tool-result-pruner |
| ㉔ | 激活抖动纪律：`deactivate` 入队并在 `turn-stopping` 统一 dispose，待卸载期间再次激活复用 fiber | `plugins/kix-focus.js` + 回归/E2E |
| ㉕ | 马拉松交接：step/context gate 强制主线程调用 `subagent_lite` 或 `create_goal`，goal round / `/kixpower-continue` 负责跨回合恢复 | `plugins/kix-budget.js` + goal/continue |

## v5.10 子代理编排面与激活抖动（2026-08-17 子代理账本实测驱动）

> 107 个子代理会话 / 2,432 次调用 / 162.5M 重读 token——与主会话同量级的另一半燃烧。首步固定开销中位 23.4K（system 38.8K chars + tools 34.3K chars）；**system 里 ~25K chars 是 run_code 的 TypeScript 工具镜像**（每个工具 schema 付两次钱）；40/107 个子代理尝试过再分派（50 次）——每个孙代再付一次全额固定开销；`change` 请求头（工具面中途变更）后 cacheRead 归零、整个上下文全价重读。

| # | 方法 | 落地段 |
|---|---|---|
| ㉖ | 子代理编排面裁剪：恒注册编排名静态 `toolFilter.deny`（subagent×2、agent 控制、exit_plan_mode、ask_user_question——账本 0 使用；deny 名同时从 tools 数组与 system 内 TS 镜像消失）。run_code 为 Code Mode 保留传输名不可 restrict（WSL2 实弹实锤）且是正当执行通道——保留；条件挂载名（dev/qa/workflow 等）由 kix-cost child guard 语义兜底。文件/执行/检索/jobs/skill/report/MCP 全保留——裁的是子代理不该有的编排面，不是能力 | agent.cordis.yml 各 tool-subagent 行 + `plugins/kix-cost.js`（tools.guard） |
| ㉗ | 延迟卸载：kix_tool_deactivate 入队、回合边界统一 dispose——消灭 `change` 头缓存重置；期间再激活则复用 fiber 不重复挂载 | `plugins/kix-focus.js`（pendingDefers + agent/turn-stopping flush） |
| ㉘ | 子代理预算覆盖：child 会话继承宿主 compaction 与 kix-budget 结果急剪；主会话 advisory/step-context gate 保持 main-only，child 不继承主线程交接锁 | v6 runtime scope + E2E |

## v5.11 复杂度感知子代理 effort（2026-08-18）

> v5.8 的 effort 分层只看预算帽（≥98K → max、其余 high），不感知任务内容——机械 child 照付 high 思考、深任务落普通档被 high 封顶。v5.11 在子代理**首个被接受的 pre-step** 用零 token 分类器读初始 prompt 叶子文本定复杂度档：纯机械判定不耗模型 token，**每子代理只分类一次**（首步定档后缓存复用，后续请求/pre-step 不改写，请求头全程稳定——v5.10 教训：中途 `change` 头清零前缀缓存）。

| # | 方法 | 落地段 |
|---|---|---|
| ㉙ | 复杂度感知 effort：琐碎机械 → DeepSeek 思考 off（**仅高置信才判**，保守取向——深活误判 trivial 关思考的代价远大于机械活没省下思考，超长文本一律不判 trivial）；常规 → 保留既有 high（v5.8 默认不变）；深任务且预算帽 >8K → 升 max；lite（≤8K 帽）**永不静默变 thinker**（升档必须显式换 thinker 档位）。非 deepseek 经运行时 `llm.resolveModelInfo` 能力门控同档适配——trivial 能力含 off 选 off、否则含 low 选 low；deep 帽 >8K 且能力含 max 选 max；能力表缺失/未知与常规档不注入（适配器默认不变，绝不发能力表外 effort）。深作信号**否定感知**（v5.11.1）：命中点前短窗口内否定词且无句读隔断 → 该深作命中不计入（`不要分析`/英文否定不产生深作命中）；同组靠后的主动命中仍计数（「不要分析，只排查」→ 排查 主动）；机械信号检测保持原样（保守取向——机械误命中只是没省思考，不会关错）。显式 `complexity:`/`复杂度：` 标记优先于信号推断；显式 effort/档位/maxTokens 恒权威——分类器只填空不覆盖（不改 selected tool/路由/maxTokens） | `plugins/kix-cost.js`（agent/pre-step 零 token 预分类 + agent/request 注入） |
