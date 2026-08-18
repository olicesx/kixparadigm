# Kixpower — AI 多智能体协作编排（v5.7）

> **v5.1 token 优化**：在 v5.0 基础上叠加 4 法（SWEzze 瘦身 / AgentDiet trajectory reduction / Cross-Lingual Tri-Block 标签 / 结构化区 token 套利），详见 SKILL.md。
> **v5.0 反过拟合**：v4.x 曾把论文标量结论（ω=3.4 均值、commit_budget /3）当全局常数，v5.0 改为按每个 Sprint 的 task DAG 实时派生（详见 SKILL.md）。

## 快速开始

VS Code Copilot Chat 输入 `/` 选择命令：

| 命令                   | 用途                    |
| ---------------------- | ----------------------- |
| `/kixpower-new`      | 全新项目启动            |
| `/kixpower-import`   | 已有代码项目导入        |
| `/kixpower-continue` | 继续/恢复 Sprint        |
| `/kixpower-review`   | 🔍 PR 审查（v3.4 新增） |

## 包含内容

### Skills（核心文件）

```
~/.copilot/skills/kixpower/
├── README.md                          # 本文件
├── SKILL.md                           # Skill 入口
├── TEAM_CONVENTIONS.md                # 通用规则（含 target_rules + revision/Partition 合同 + Hybrid 分层算法）
├── USAGE_MANUAL.md                    # 完整使用手册
├── hooks/
│   ├── auto-update-progress.ps1
│   ├── block-source-edit.ps1
│   ├── block-source-edit-qa.ps1
│   ├── block-dev-authority-edit.ps1   # Dev/Producer 禁写 L2/QA 权威字段
│   ├── validate-handoff.ps1
│   ├── validate-qa-signoff.ps1
│   ├── qa-freshness-check.ps1
│   ├── cleanup-qa-session.ps1
│   └── blast-radius-check.ps1         # 🔴 生产事故防线（commit/branch/SQL/force push/MCP）
├── scripts/
│   ├── kixpower-contract.ps1
│   ├── validate-memory-backlog.ps1
│   ├── init-project.ps1
│   ├── new-sprint.ps1
│   └── verification-fidelity-check.ps1 # 🔴 v5.7 全 target_rules 门禁覆盖率量化
├── tests/
│   └── run-contract-regression.ps1     # 🔴 无外部依赖的合同/Hook 回归
└── templates/
    ├── runtime-context-snapshot.md    # 🔴 Dev 启动收集 runtime 状态
    └── github-actions-l3-trigger.md   # 🟡 v5.7 L3 degraded-local capability 模板
```

### Agents（5 个）

```
~/.copilot/agents/
├── kixpower-orchestrator.agent.md     # 编排器（4 层 loop）
├── kixpower-producer.agent.md         # Producer（规划 + drift check）
├── kixpower-dev.agent.md              # Dev（编码 + L2 自测）
├── kixpower-qa.agent.md               # QA（verifiable gates）
└── kixpower-reviewer.agent.md         # PR 独立只读复核（无 agent/edit 工具）
```

### Prompts（5 个）

```
~/AppData/Roaming/Code/User/prompts/
├── kixpower.prompt.md                 # 智能路由入口
├── kixpower-new.prompt.md             # 全新项目
├── kixpower-import.prompt.md          # 已有代码导入
├── kixpower-continue.prompt.md        # 继续/恢复 Sprint
└── kixpower-review.prompt.md          # 🔍 v3.4 PR 审查
```

## 核心机制

### 4 层 Loop 架构

- **L1 Agent Loop**: `runSubagent` 调用 Dev/QA
- **L2 Verification Loop**: orchestrator 自跑 local_gate + rubric-retry ≤ 2 次
- **L3 Event-Driven Loop**: 当前只读 `degraded-local` capability report；无可信 adapter 时 `NOT_TRIGGERED`
- **L4 Hill Climbing Loop**: Trace 分析 → canonical `.kixpower/memory/repo/harness-backlog.md` 改进

### 核心 Hard Guardrails + v5.7 信任链合同门禁

- max_subagent_calls=10 / **max_tokens_per_session=窗口×0.88**（v3.7 改百分比，1M 模型=880K）/ **per-run=窗口×0.25**（1M=250K）
- no_progress=2 / tool_failure=3 / stage retry=1 / L2 retry=2
- blast_radius: **commit_hard_cap=10（v4.0，取代旧的 commit≤5 常量）** / commit_budget 由 task_sizing 派生 / feature branch / no force push / no destructive SQL / no MCP main write
- **max_parallelism=min(user_setting, dag.ω, 8)**（无 DAG 时回退项目历史，再无则 3）/ **synthesis_iteration_cap=5**（v3.5 终止兜底）

> **v5.0 commit_budget 派生**：`commit_budget = dag_layers + strong_coupling_count + historical_bug_per_sprint`，全部来自当前 DAG 与项目历史；无历史时 bug reserve=1。真正的硬上限是 `commit_hard_cap=10`。

### 拓扑自适应 + 并行完整化（v3.5）

plan.md 强制 task DAG，orchestrator 按 ω/γ/k 路由：

- parallel（24% 任务）/ sequential / hybrid（49.7%）/ hierarchical

**v3.5 并行执行层**（AdaptOrch 论文完整落地）：

- **git worktree 隔离**：每个并行 Dev 在独立 worktree（文件系统级隔离，防冲突）
- **Partition 分区写入**：每个 Dev 写独立 `docs/sprint-N/partitions/<id>.md`，Orchestrator synthesis 后单写 progress（防数据丢失）
- **Adaptive Synthesis Protocol**：并行完成后跑 Consistency Score（CS）+ γ 递增重路由
- **Hybrid 分层算法**：Kahn 拓扑排序变种，自动把 DAG 划分为层（层内并行、层间串行）
- **失败传播**：单点失败只重试该 partition；≥50% 失败才整批回退 sequential
- **拓扑降级**：parallel → sequential；hybrid → 减少 layer 内 parallelism

### 规则化范围模型（v3.3，替代清单）

- `target_rules`: glob + modules + languages + mechanical_links
- L2 依据 target_rules/languages 选补充 gate；最终交 QA 前必须跑全套 required local_gate manifest
- Goal Drift 白名单全部用 rules 匹配
- 实测：示例项目 Sprint 1 未门禁率 **97.1% → 4.9%**（EvoClaw 警告被消除）

### Memory 三件套

- `<PROJECT_ROOT>/.kixpower/memory/repo/<project>.md` — 项目身份（canonical）
- `<PROJECT_ROOT>/.kixpower/memory/repo/lessons-learned.md` — Reflexion 失败模式累积
- `<PROJECT_ROOT>/.kixpower/memory/repo/harness-backlog.md` — L4 改进项（跨 Sprint 复利，Producer 自动应用）
- `/memories/repo/` — 旧宿主路径，仅作 legacy adapter，不双写

### EvoClaw Cross-Sprint 演进

- Producer 启动新 Sprint 时强制做 drift check（context/error/debt/fidelity）
- `verification-fidelity-check.ps1` 量化门禁覆盖率，>20% 未门禁自动补 target_rules

### 内容语言约定（v3.6）

- 启动时询问：`zh` / `en` / `bilingual` / `repo`（默认 repo）
- 持久化：PROJECT_BRIEF.md frontmatter 的 `content_language` 字段
- 应用范围：代码注释 / commit / 过程文档 / Issue / qa-signoff
- **永远中文**：kixpower 编排文件（agent.md / TEAM_CONVENTIONS.md）
- **永远英文**：源码标识符（变量/函数/类型名）
- `repo` 模式：扫描仓库已有注释/commit/文档的中英文比例自动判断

## 版本

| 版本 | 日期       | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v3.1 | 2026-07-28 | Fork 自 ai-team v3.1，独立迭代起点（4 层 loop + 11 guardrails + DAG）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| v3.2 | 2026-07-28 | +L4 改进项自动应用 +EvoClaw fidelity 量化（verification-fidelity-check.ps1）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| v3.3 | 2026-07-28 | +规则化范围模型（target_rules: glob/modules/languages/mechanical_links）+ L2 智能选 gate + Goal Drift rules 匹配                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| v3.4 | 2026-07-28 | +模式 4 PR 审查（7 维度分层 + 行内评论 +`--approve`/`--save`）+ L3 设计模板                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| v3.5 | 2026-07-28 | +并行完整化（AdaptOrch 执行层）：worktree 隔离 / Partition 分区写入 / Adaptive Synthesis Protocol（CS 评分 + 终止保证）/ Hybrid 分层算法 / max_parallelism=3 / 失败传播策略                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| v3.6 | 2026-07-28 | +内容语言约定（zh/en/bilingual/repo 四选一，启动询问 + PROJECT_BRIEF.md frontmatter 持久化 + prompt 传递 + 仓库风格自动推断）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| v3.7 | 2026-07-28 | +Token 阈值改为按模型窗口百分比（NeedleInAHaystack 2026 召回率依据：安全<60% / 警觉 60-75% / 危险 75-88% / 临界>88% / per-run 25%），1M 模型硬上限从 850K 提升到 880K，per-run 从 200K 提升到 250K。orchestrator 启动读 PROJECT_BRIEF.md 的`model_context_window`（默认 1M）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| v3.8 | 2026-07-28 | +orchestrator 工具并行化（8 场景速查 + MUST 规则 13）：模式 0 探索 / L2 gates / Observe 步骤 / runtime-context 收集 / Drift check / PR 审查多维度 / L4 模式识别 / QA 多 Issue 提交，全部从串行改并行。每 Sprint 节省 ~37K tokens（~4% 窗口）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| v3.9 | 2026-07-28 | +max_parallelism 从 3 上调到 5（AdaptOrch ω=3.4 实证 + Anthropic C compiler 5 parallel + CoAgent 并行加速研究），可配置（PROJECT_BRIEF.md frontmatter），实际上限 = min(user, ω, 8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| v4.0 | 2026-07-28 | **commit_budget 从硬编码常量改为 task_sizing 派生值**（sync_watcher Sprint 1 实证：旧 5/5 被用满 + orchestrator 临时解锁到 5 + 事后改写为"零 over_budget"）。公式 `ceil(task_count/3) + strong_coupling_count + 1`，吸收原 P2-A 预留 bug fix commit。硬上限 `commit_hard_cap=10` 取代旧的 `commit≤5`。blast-radius-check.ps1 三级回退（progress.md → plan.md task_sizing → 默认 5）+ 一致性警告 + 软警告/硬阻止分级。TEAM_CONVENTIONS.md 新增 §Task Sizing & Commit Budget 派生段。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| v4.1 | 2026-07-28 | **harness-backlog eval schema**（LangChain "Better Harness" 2026 H2 适配，**不引入 LLM-as-judge** 与确定性优先原则冲突）：每个改进项从「自然语言描述」升级为含 `eval` 字段的结构化项（trigger / pass_criteria / regression_signal / applies_to_sprints / check_timing）。Producer 新 Sprint 启动时回归检查上一 Sprint trace 是否命中 regression_signal，命中则强制 plan.md 显式写「如何验证改进生效」。Sprint 1 的 6 个 backlog 项已追溯补 eval 示例。闭环从单边（写 → 期望应用）变双边（写 → 应用 → 回归验证）。**含回归发现的 2 个 bug 修复**：① blast-radius-check.ps1 的 branch_required/block_force_push/block_destructive_sql 正则失效（同 v4.0 task_sizing 正则 bug，统一改 `[\s\S]*?`）；② DROP TABLE/TRUNCATE 嵌套 if 漏拦。**额外修复 verification-fidelity-check.ps1 的 inline YAML 数组 target_files 提取 bug**（sync_watcher Sprint 1 实测：HIGH_RISK 61.5% → PASS 0%，root cause：旧正则只支持多行 `- item` 列表，不支持 `target_files: [a, b, c]`）。 |

> 注：v4.0 行的 `ceil(task_count/3)` 与"默认 5"是**历史描述**（记录当时状态）；v5.0 已改为 δ 驱动公式、默认 3，详见下表 v5.0 行与 SKILL.md。

| v5.0 | 2026-07-30 | **反过拟合 5 法**：① 参数实例化——commit_budget 由 DAG 的 δ(`dag_layers`)派生而非 `task_count/3` 比例，max_parallelism 由 `dag.ω` 实时决定而非论文均值 ω=3.4；② fidelity 跨 Sprint 累积（趋势 + dead-path 度量）；③ 任务可行性前置 gate（liveness 普适化，不再仅 perf Sprint）；④ 规则一致性评分（新增前 Jaccard 重叠检测）；⑤ 规则退役机制（eval 加 `retire_after_silent`/`positive_hits`，删除"永久生效"）。反铁证：dae Sprint1(δ=4,strong=1) v4.x 得 5，v5.0 得 6，证明公式有信息增量。详见 SKILL.md / TEAM_CONVENTIONS.md。 |
| v5.1 | 2026-07-30 | **token 优化 4 法**：⑥ orchestrator 瘦身（SWEzze 最小充分子序列：去重 + 路由表 + L3 压缩，757→628 行）；⑦ trajectory reduction（AgentDiet 三分类：expired/redundant/useless）；⑧ Tri-Block 标签（Cross-Lingual `[CONTEXT]/[TASK]/[CONSTRAINTS]`）；⑨ 结构化区 token 套利（叙述区守 content_language 可读性，不照搬 benchmark 数字）。详见 SKILL.md / TEAM_CONVENTIONS.md。 |
| v5.2 | 2026-07-30 | **audit 后修复**（仿真实证驱动）：① blast-radius-check.ps1 UPDATE without WHERE 拦截失效（旧 lookbehind `(?<!WHERE\s+1\|=1)` 的 `=1` 分支匹配 `SET x=1` 结尾误判为有 WHERE → 改 negative lookahead `(?!.*\bWHERE\b)`，9/9 仿真用例 PASS）；② kixpower-dev.agent.md 补 PreToolUse blast-radius-check（原仅 PostToolUse，Dev commit 拦截缺位）；③ kixpower-new.prompt.md commit_budget 公式同步 v5.0 δ 驱动；④ 补 SKILL.md 入口消除悬空引用；⑤ 文档对齐（默认值 5→3 / Schema 示例旧公式注释 / harness-backlog 重复段）。 |
| v5.3 | 2026-07-31 | **代码风格感知（ROI 复核后有机融入）**：复核「AI agent 代码库风格适配」论文（Codified Context arXiv 2602.20478 Hot Memory constitution / Evaluating AGENTS.md arXiv 2602.11988「非标准实践显式规范有效，自动 overview 无效」/ Style2Code arXiv 2505.19442 / InlineCoder arXiv 2601.00376）。**砍掉低 ROI 项**：① 自动 style_profile 挖掘（因果倒置：编码风格是人为输入非机器派生，同 v4.x commit_budget 过拟合）；② L2 style_consistency gate（LLM-as-judge 违确定性优先）。**保留高 ROI 项**：① Dev 工作流 step 1 加「写代码前读 target_rules 内代表性既有文件提取风格基线」；② TEAM_CONVENTIONS.md content_language repo 段扩展覆盖代码风格 + 显式声明禁自动挖掘；③ 审查模式维度 4 加「与目标文件既有代码风格一致性」+ 严重级别约束（纯风格默认 minor，违反编码约定才升 major）+ 纳入证据门禁；④ QA 核心职责 #3 加「写测试前读既有测试文件提取风格基线」（对称角色链补全）。**v5.3 audit（同日自审）**：① 砍掉初版"5-10 个文件"隐藏常数（无论文依据，违反反过拟合原则），改定性描述；② 补 QA 侧（写-审-测三链初版只改了写-审）；③ Dev step 1 精简——论文依据/禁止自动挖掘声明移除（集中保留在 TEAM_CONVENTIONS，Dev 只留执行指令 + 指向引用），过 v5.1 token 优化筛（执行 prompt 最小充分子序列，新内容须过既有版本筛）。论文核心机制（人填非自动）落地，非挪用标量。详见 SKILL.md。 |
| v5.6 | 2026-08-01 | **端到端复核**：统一 Prompt→Orchestrator 路由、Sprint/L2 SHA 状态、Observe commit 基线、角色写边界、Review 异质复核与 GitHub state；Hook 覆盖控制平面、路径规范化、Git/SQL/GitHub 共享副作用。 |
| v5.7 | 2026-08-07 | **信任链修正**：required local_gate 全量 manifest + SHA、L2 stash 基线与 Dev 权威字段保护、统一终端写入/别名/复合命令门禁、未知执行工具 fail-closed、GitHub 共享写确认、远程 QA freshness/reverify、reviewer revision 绑定、空 DAG 校验、commit budget reflog 计数、阶段 Observe 信号、独立 partition、SQL 文件/间接路径门禁、fidelity 全规则解析、L3 降级模板。 |
| v5.9 | 2026-08-17 | **主会话预算**（48 会话/173M 重读 token 账本实测驱动）：㉑ 上下文 advisory 线 min(35%×窗口,180K) + compaction thresholdRatio 0.8→0.45（1M 模型钉 0.18）；㉒ 主线程连续 8 步只读 streak 门禁（⑳ 机制化）；㉓ 工具结果急剪（pruneSession 提前到 50% 预算）；㉔ deactivate 延迟到回合末；㉕ 马拉松默认 goal/continue 分会话。落地 `plugins/kix-budget.js`（35 单测）+ persona 一句话索引。 |
| v5.10 | 2026-08-17 | **子代理编排面与激活抖动**（107 子代理/162.5M 重读账本实测）：㉖ 编排面裁剪（deny 名同时从 tools 数组与 system TS 镜像消失；run_code 为保留传输名不可 restrict、正当执行通道保留；静态 deny 恒注册名 + kix-cost child guard 兜底条件挂载名）㉗ kix_tool_deactivate 延迟到回合末（change 头缓存重置清零）㉘ 子代理会话吃 v5.9 预算/compaction 覆盖。落地 agent.cordis.yml 各 tool-subagent 行 + kix-cost/kix-focus。 |
| v5.11 | 2026-08-18 | **复杂度感知子代理 effort**：首 pre-step 零 token 分类器按初始 prompt 定复杂度档——琐碎机械（仅高置信）→ DeepSeek 思考 off；常规 → 保留既有 high；深任务（预算帽 >8K）→ 升 max；lite 永不静默变 thinker；非 deepseek 经 `llm.resolveModelInfo` 能力门控（trivial 含 off 选 off、否则 low；深任务 max——仅当能力表支持；未知/常规保持默认）；深作信号否定感知（v5.11.1：否定语境命中不计深作——`不要分析`/英文否定不算，同组后续主动命中仍计数）；显式 `complexity:` 标记/effort/档位/maxTokens 恒权威；每子代理只分类一次（防 `change` 头/前缀缓存抖动）。落地 `plugins/kix-cost.js`。 |
| v6.0 | 2026-08-18 | **主会话运行时闭环**：`agent/pre-step.step`/动态模型窗口驱动 150K budget gate；第 41 步或上下文超线由 `tools/pre-execute` 拒绝普通工具，成功 lite/goal 交接后解除；宿主 pruner 2K 单结果剪裁并保留 replacement 账本；WSL2 真实回放覆盖 gate deny、35 次 prune replacement、延迟激活/卸载与 goal 自动续轮。 |

**改造明细以本页版本表为唯一来源**；历史 v5.2 audit 修复与 v5.6/v5.7 信任链收口均保留在版本表中，不再维护易漂移的总数公式。

## 测试验证

### v3.5 综合模拟测试（示例项目 Sprint 1）

| 测试组           | 项目数       | PASS         | 说明                                   |
| ---------------- | ------------ | ------------ | -------------------------------------- |
| 文件完整性       | 3            | 3            | skill 14 + agents 4 + prompts 4        |
| Hook 独立性      | 4            | 4            | force push / SQL / MCP main / 正常命令 |
| L2 gate manifest | 3            | 3            | required gate 全量覆盖 + revision SHA              |
| Observe + 白名单 | 6            | 6            | target_rules + fidelity 4.9%           |
| 拓扑路由         | 6            | 6            | hybrid/parallel/sequential 全对        |
| 并行机制         | 13           | 13           | 含 git worktree 实测创建/清理          |
| fidelity glob    | 3            | 3            | 通配符匹配                             |
| L4 Trace 分析    | 4            | 4            | 7 traces, 0 silent, 0 drift            |
| PR 审查 gate     | 5            | 4            | gh CLI 待用户安装                      |
| **总计**   | **47** | **43** | **91.5%（架构层 100%）**         |

### 关键实测数据

| 指标            | v3.2（起点） | v3.5（当前）      | 改善     |
| --------------- | ------------ | ----------------- | -------- |
| 未门禁率        | 97.1% 🔴     | **4.9%** 🟢 | -92.2pp  |
| 并行完整度      | 30%          | **~90%**    | +60pp    |
| Hard Guardrails | 11           | **13 核心 + 合同门禁层** | v5.7 增加 revision/authority/freshness/共享写保护 |
| 工作模式        | 3            | **4**       | +PR 审查 |
| Loop 层实现     | 3/4          | **3/4 + L3 degraded-local** | L3 无可信 adapter，不计为已实现  |
| 综合论文适配度  | 93%          | **100%**    | 🎯       |

## 论文依据

论文清单、来源与实证见 [AUDIT.md](../kixparadigm/AUDIT.md)（复查时读，不自动加载）。完整说明见 [USAGE_MANUAL.md](USAGE_MANUAL.md)。
