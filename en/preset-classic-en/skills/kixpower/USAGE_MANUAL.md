# Kixpower Orchestration 使用手册

> **版本**：v5.7（2026-08-07，L2/QA revision 信任链、统一终端/共享写保护与 Hook/Memory/Fidelity 收口；继承 v5.1 token 优化）
> **适用场景**：VS Code + Copilot Chat 环境下的多智能体协作软件开发
> **v5.1 亮点（token 优化 4 法）**：⑥ orchestrator 瘦身（SWEzze 最小充分子序列：去重+路由表+L3压缩，orchestrator 757→628 行）⑦ trajectory reduction（AgentDiet 三分类：expired/redundant/useless）⑧ Tri-Block 标签（Cross-Lingual `[CONTEXT]/[TASK]/[CONSTRAINTS]`）⑨ 结构化区 token 套利（叙述区守 content_language 可读性）。**v5.0 亮点（反过拟合 5 法）**：① 参数实例化——commit_budget 由 DAG 的 δ(`dag_layers`)派生而非 `task_count/3` 比例，max_parallelism 由 `dag.ω` 实时决定而非论文均值 ω=3.4；② fidelity 跨 Sprint 累积（趋势 + dead-path 度量）；③ 任务可行性前置 gate（liveness 普适化，不再仅 perf Sprint）；④ 规则一致性评分（新增前 Jaccard 重叠检测）；⑤ 规则退役机制（eval 加 `retire_after_silent`/`positive_hits`，删除"永久生效"）。详见 [TEAM_CONVENTIONS.md](./TEAM_CONVENTIONS.md) 与 [SKILL.md](./SKILL.md)。
> **历史**：v4.0 把 commit_budget 从硬编码改为派生（但公式含隐藏比例 /3）；v4.1 加 eval schema（但规则只增不退）。v5.0 修正这两代过拟合——参数真正由 DAG 结构驱动，规则可随数据退役。反铁证：dae Sprint1(δ=4,strong=1) v4.x 得 5（=旧硬编码常数），v5.0 得 6，证明公式有信息增量。

---

## 目录

1. [快速开始](#1-快速开始)
2. [核心概念](#2-核心概念)
3. [4 层 Loop 架构](#3-4-层-loop-架构)
4. [角色分工](#4-角色分工)
5. [Sprint 完整流程](#5-sprint-完整流程)
6. [文件结构](#6-文件结构)
7. [Hard Guardrails 速查](#7-hard-guardrails-速查)
8. [故障应对](#8-故障应对)
9. [最佳实践](#9-最佳实践)
10. [常见问题](#10-常见问题)
11. [论文依据](#11-论文依据)

---

## 1. 快速开始

### 1.1 四种快捷 slash command（推荐）

VS Code Copilot Chat 中输入 `/` 会自动列出可用 prompt。本编排提供 4 个核心快捷命令：

| 命令 | 用途 | 用法 | 替代的老命令 |
|---|---|---|---|
| `/kixpower-new` | 全新项目从零启动 | `/kixpower-new` 或 `/kixpower-new todo-app React+Vite+Node` | `/bootstrap-team-project` |
| `/kixpower-import` | 已有代码项目导入 | `/kixpower-import` 或 `/kixpower-import c:\path\to\project` | （新增） |
| `/kixpower-continue` | 继续/恢复进行中的 Sprint | `/kixpower-continue` 或 `/kixpower-continue 2`（Sprint 编号） | `/recover-context` + 部分 `/plan-sprint` |
| `/kixpower-review` | 🔍 PR 审查 | `/kixpower-review` 或 `/kixpower-review 42` 或 `/kixpower-review --approve 42` | （新增） |

**Prompt 文件位置**：`../../prompts/kixpower-*.prompt.md`（本 preset 内）

每个 prompt 内部已对接 v5.7 编排（task DAG / target_rules / L2 gate manifest / L4 / drift check / harness-backlog / blast-radius hook / PR 审查 7 维度），无需手动指定。

### 1.2 四种启动场景对照

| 场景 | 触发方式 | 说明 |
|---|---|---|
| **全新项目** | `/kixpower-new` | 触发模式 1：访谈 → 规划 → 开发 → QA → L4 |
| **已有代码** | `/kixpower-import` | 触发模式 0：自动探索 → 分析报告 → 规划 → 开发 → QA → L4 |
| **继续 Sprint** | `/kixpower-continue` | 触发模式 2+3 合并：读上下文 → drift check → 接力执行 |
| **PR 审查** | `/kixpower-review` | 触发模式 4：7 维度分层审查 → 行内评论 → 可选 approve |

### 1.3 最小化启动示例

**方式 A：slash command（推荐）**
```
/kixpower-new todo-app React+TypeScript+Vite+Node.js+Express ① 任务CRUD ② 用户认证 ③ 标签分类
```

**方式 B：自然语言触发**
```
我要创建一个 todo-app 项目：
- 栈：React + TypeScript + Vite + Node.js + Express
- 功能：① 任务 CRUD ② 用户认证 ③ 标签分类
- 目录：c:\projects\todo-app
```

两种方式等价，但 slash command 保证走 v3.3 流程（避免老 SKILL.md 路径）。

orchestrator 会自动：
1. 调用 Producer 生成 PROJECT_BRIEF.md + Sprint 1 plan.md（含 task DAG）
2. 调用 Dev 实现（按拓扑自适应决定并行/串行）
3. L2 Verification Loop（orchestrator 自跑 local_gate）
4. 调用 QA 验收（ci_gate + manual playthrough）
5. L4 Hill Climbing（分析 Trace → 改进 harness）

### 1.4 已废弃的老命令（v5.0 已移除，功能融入 kixpower-*）

以下命令在 v5.0 已移除，**不再有对应 prompt 文件**，其功能已融入核心命令：

| 已废弃命令 | 原用途 | v5.0 替代 |
|---|---|---|
| `/bootstrap-team-project` | 快速初始化项目 | `/kixpower-new` |
| `/plan-sprint` | 创建 Sprint 计划 | `/kixpower-new`（首个）/ `/kixpower-continue`（后续 Sprint） |
| `/run-consilium` | 团队会诊（多角色审查） | 在 `@kixpower-producer` 对话中请求会诊，或 `/kixpower-review` 审查 |
| `/recover-context` | 上下文恢复 | `/kixpower-continue`（直接状态判定与接力） |
| `/sprint-done` | Sprint 完成报告 | `/kixpower-continue` 收尾阶段自动生成 |
| `/qa-signoff` | QA 签署 | 已含在 `/kixpower-new` / `/kixpower-continue` 流程内 |
| `/unlock` | 解锁特定场景 | 已废弃，按需在 agent 对话中处理 |

---

## 2. 核心概念

### 2.1 什么是 Loop Engineering？

> 来源：Boris Cherny（Claude Code 作者）：「I don't prompt Claude anymore. I have loops that are running.」

传统开发：你写 prompt → AI 执行 → 你检查 → 再 prompt
Loop Engineering：你设计 **目标 + 触发 + 守卫** → AI 自主循环直到完成

### 2.2 关键术语

| 术语 | 定义 |
|---|---|
| **Stage** | Producer / Dev / QA 三大阶段（stage 间串行） |
| **Turn** | 一次 `subagent`（DSH 无 agentName，prompt 注入角色 body） 调用（同一 stage 内可有多个 turn） |
| **Topology** | 任务执行拓扑：sequential / parallel / hybrid / hierarchical |
| **Observe** | orchestrator 在每次 turn 后的产出验证（4 步） |
| **L2 Gate** | deterministic 验证（test/clippy/typecheck），orchestrator 自跑 |
| **Trace** | 每次 turn 的结构化记录（YAML，写入 progress.md） |

### 2.3 为什么不用单层 loop？

论文证据（LangChain 2026 + AdaptOrch）：

| 配置 | SWE-bench Verified 准确率 |
|---|---|
| Single agent | 42.8% |
| Static topology | ~48% |
| Adaptive topology（我们的方案） | **52.6%**（+9.8pp） |

固定拓扑损失 12-23%；拓扑选择方差 ≥ 模型选择方差 **20x**（当模型趋同时）。

---

## 3. 4 层 Loop 架构

```
┌─────────────────────────────────────────────────┐
│  L4 Hill Climbing Loop（跨 Sprint）              │
│  Trace 分析 → harness 改进 → harness-backlog    │
├─────────────────────────────────────────────────┤
│  L3 Event-Driven Loop（当前 degraded-local）       │
├─────────────────────────────────────────────────┤
│  L2 Verification Loop（Sprint 内，Dev 后）        │
│  orchestrator 自跑 gates → rubric-retry ≤2 次    │
├─────────────────────────────────────────────────┤
│  L1 Agent Loop（基础）                            │
│  subagent → Dev/QA 执行                       │
└─────────────────────────────────────────────────┘
```

| Loop | 触发 | 输入 | 输出 |
|---|---|---|---|
| **L1** | 用户输入 / orchestrator 调度 | plan.md + context | 代码变更 + progress.md |
| **L2** | Dev 报告任务完成 | local_gate 命令清单 | gate 结果（pass/fail + feedback） |
| **L3** | GitHub Actions webhook / cron（只读状态模板） | 外部事件 | `NOT_TRIGGERED` + 本地命令提示 |
| **L4** | QA 签署完成 | Trace Log | harness-backlog.md 改进项 |

---

## 4. 角色分工

### 4.1 角色矩阵

| 角色 | Agent 文件 | 职责 | 可写范围 |
|---|---|---|---|
| **Orchestrator** | `kixpower-orchestrator.agent.md` | 编排、Observe、L2 跑 gate、L4 分析 | progress 状态/Trace/L2、hill-climbing、review draft、harness-backlog |
| **Producer (Remy)** | `kixpower-producer.agent.md` | 规划、brainstorm、Issue/PR、drift check、收尾 | PROJECT_BRIEF.md、docs/**、README.md、backlog 应用记录 |
| **Dev (Nova/Sage/Milo)** | `kixpower-dev.agent.md` | 编码、自测、runtime snapshot | plan 范围源码 + progress 任务/自测 + runtime-context + lessons-learned |
| **QA (Ivy)** | `kixpower-qa.agent.md` | ci_gate + manual playthrough、签署 | 测试文件 + qa-signoff.md + 失败 lessons-learned |
| **Reviewer** | `kixpower-reviewer.agent.md` | PR 独立只读复核 | 无写入、无子 agent |

### 4.2 Memory 合约（read/write 范围）

| 角色 | read | write | 禁止 |
|---|---|---|---|
| Producer | PROJECT_BRIEF.md、`<PROJECT_ROOT>/.kixpower/memory/repo/*`、用户输入 | PROJECT_BRIEF.md、docs/**、README.md、.github/**、.gitignore、canonical harness-backlog 应用记录 | 源码 |
| Dev | PROJECT_BRIEF.md、plan.md、canonical lessons-learned、progress 当前任务 | plan 范围源码、progress 任务计数/`dev_self_tests_passed`、runtime-context、失败 canonical lessons-learned | PROJECT_BRIEF.md、plan.md、qa-signoff、权威 L2 字段 |
| QA | PROJECT_BRIEF.md、plan.md、progress.md 全文、canonical lessons-learned | qa-signoff.md、测试文件、失败 canonical lessons-learned | 业务源码、plan.md、progress.md 执行状态 |
| Orchestrator | 所有 docs/ + canonical memory | progress Observe/L2/阶段状态、hill-climbing、review draft、canonical harness-backlog/lessons | 源码、plan.md（重规划交 Producer） |

### 4.3 子 agent 调用模板

orchestrator 用 `subagent`（DSH 无 agentName，prompt 注入角色 body） 工具，prompt ≤ 5K tokens。模板见 `kixpower-orchestrator.agent.md` 的「子 agent 调用模板」章节。

**Dev 模板示例**：
```
工具: subagent
agentName: "kixpower-dev"
prompt: |
  项目：@ [ROOT] / Sprint 1
  读：PROJECT_BRIEF.md + docs/sprint-1/plan.md + <PROJECT_ROOT>/.kixpower/memory/repo/lessons-learned.md
  做：按 plan.md 实现，逐项更新 progress.md（含 YAML frontmatter）
  硬约束：源码编辑用 edit，禁止 inline shell 脚本编辑
  简报：已实现功能、变更文件、已知问题
```

---

## 5. Sprint 完整流程

### 5.1 流程图

```
用户输入
    ↓
[Producer] 探索代码库 + drift check + 生成 plan.md(含 task DAG)
    ↓ Observe
[Dev] 按拓扑执行（parallel/sequential/hybrid/hierarchical）
    ↓ Observe + Goal Drift 检测
[L2 Verification] orchestrator 自跑 local_gate
    ↓ 若失败 → rubric-retry Dev（≤2 次）
[QA] ci_gate + manual playthrough + 签署
    ↓
[L4 Hill Climbing] 分析 Trace → 改进 harness → harness-backlog
    ↓
[Producer Finalizer] 写 done.md + 更新 PROJECT_BRIEF 第 7/8 节
  ↓
交付总结（用户）
```

### 5.2 推进条件

| 阶段迁移 | 硬条件 |
|---|---|
| Producer → Dev | plan.md + progress.md 已生成，无未决开放问题 |
| Dev → L2 | progress.md 任务全 `[x]`，无 `❌ Blocked`，Observe 通过 |
| L2 → QA | plan 中全部 required local_gate 同 revision 全过，manifest digest 与 `l2_verified_sha` 已记录 |
| QA → L4 | QA 签署 PASS 或仅 CI pending 的 CONDITIONAL，且 `qa_verified_sha == l2_verified_sha == HEAD`、stash 基线未漂移 |
| L4 → Producer 收尾 | harness 改进已写入 harness-backlog.md |
| Producer 收尾 → 交付 | done.md 已生成，PROJECT_BRIEF 第 7/8 节与最终状态一致 |

### 5.3 拓扑自适应路由

orchestrator 根据 plan.md 的 task DAG 属性执行 [TEAM_CONVENTIONS.md](./TEAM_CONVENTIONS.md)「拓扑路由规则」中的有序互斥决策树；本手册不复制阈值，避免形成第二权威来源。

| 拓扑 | 何时用（判据见 TEAM_CONVENTIONS 有序决策树） | token 成本 | 典型场景 |
|---|---|---|---|
| **parallel** | 权威决策树选 parallel | 3-4x | 4 个互不影响的 P0 bug |
| **sequential** | 权威决策树选 sequential，或命中强制串行条件 | 1x | 资金正确性链路 |
| **hybrid** | 权威决策树选 hybrid | 2x | 批次 A 并行 + 批次 B 串行 |
| **hierarchical** | 权威决策树选 hierarchical | 1.5x | 大型重构 |

---

## 6. 文件结构

### 6.1 Skill 目录

```
~/.copilot/skills/kixpower/
├── SKILL.md                           # Skill 入口（用户触发说明）
├── TEAM_CONVENTIONS.md                # 通用规则（所有 agent 共享）
├── hooks/
│   ├── auto-update-progress.ps1       # Dev 编辑后提醒更新 progress
│   ├── block-source-edit.ps1          # Producer 禁改源码
│   ├── block-source-edit-qa.ps1       # QA 禁改业务源码
│   ├── block-dev-authority-edit.ps1   # Dev/Producer 禁写 L2/QA 权威字段
│   ├── validate-handoff.ps1           # orchestrator handoff 校验
│   ├── validate-qa-signoff.ps1        # QA freshness/closeout 校验
│   ├── qa-freshness-check.ps1         # QA 测试变更 marker
│   ├── cleanup-qa-session.ps1         # 成功收尾清理 session marker
│   └── blast-radius-check.ps1         # 🔴 新：commit/SQL/force push 拦截
├── scripts/
│   ├── kixpower-contract.ps1          # 统一 schema/manifest/path helper
│   ├── validate-memory-backlog.ps1    # L4 lifecycle validator
│   ├── verification-fidelity-check.ps1 # 全 target_rules 覆盖率量化
│   ├── init-project.ps1
│   └── new-sprint.ps1
├── tests/
│   └── run-contract-regression.ps1    # Hook/contract 回归
└── templates/
    ├── runtime-context-snapshot.md    # 🔴 新：Dev 启动收集 runtime 状态
    └── github-actions-l3-trigger.md   # L3 degraded-local capability 模板
```

### 6.2 Agent 目录

```
~/.copilot/agents/
├── kixpower-orchestrator.agent.md      # 编排器（4 层 loop + Observe + L2 + L4）
├── kixpower-producer.agent.md          # Producer（+ drift check + harness-backlog 应用）
├── kixpower-dev.agent.md               # Dev（+ L2 自测 + runtime snapshot）
├── kixpower-qa.agent.md                # QA（+ verifiable gates + deterministic-first）
└── kixpower-reviewer.agent.md          # 独立只读 reviewer
```

### 6.3 项目目录（每个项目）

```
<project-root>/
├── PROJECT_BRIEF.md                   # 14 章节团队真相源
├── docs/
│   ├── brainstorm/                    # 脑暴产出（00-05）
│   ├── sprint-N/
│   │   ├── plan.md                    # 范围 + task DAG + verifiable_gates
│   │   ├── progress.md                # frontmatter + Trace Log + 任务表
│   │   ├── runtime-context.md         # 🔴 新：Dev 收集的 runtime snapshot
│   │   ├── hill-climbing.md           # 🔴 新：L4 输出（Sprint 结束生成）
│   │   ├── drift-check.md             # 🔴 新：Producer 启动时生成（Sprint N+1）
│   │   └── done.md                    # Sprint 完成报告
│   └── qa/
│       └── qa-signoff-N.md            # QA 签署报告
```

### 6.4 Memory 目录（项目 canonical + legacy adapter）

```
<PROJECT_ROOT>/.kixpower/memory/repo/  # canonical，随项目隔离
├── <project>.md                       # 项目身份 + 关键决策
├── lessons-learned.md                  # 🔴 Reflexion 记忆（失败模式累积）
└── harness-backlog.md                  # 🔴 L4 改进项（跨 Sprint 复利）

/memories/repo/                        # 旧宿主路径，仅作 legacy adapter，不双写
```

---

## 6.5 规则化范围模型（v3.3 新增）

> 来源：EvoClaw 论文 + 示例项目 Sprint 1 实测 97.1% 未门禁 → 升级为规则模型后降到 4.9%

### 为什么不用文件清单？

大型项目一个 Sprint 改 100+ 文件，Producer 手列 target_files 不现实（也猜不全）。v3.3 改为**规则声明**：

### target_rules schema

```yaml
- id: B5
  desc: "网关预留费 Lua"
  target_rules:
    globs:                              # glob 模式
      - "src/cache/**"                  # ** 跨目录递归
      - "src/api/{payment,gateway}.rs"  # 花括号展开
    modules: [cache, api/payment]       # 模块语义名，自动展开为路径
    languages: [rust]                   # L2 据此选 gate
    mechanical_links:                   # 机械关联，CodeGraphy 动态查询
      - type: callers
        of: [src/cache/mod.rs]
```

### glob 语法

| 模式 | 含义 | 示例 |
|---|---|---|
| `**` | 跨目录递归 | `src/**` 匹配 src 下所有 |
| `*` | 单层 | `src/*.rs` 不匹配 `src/sub/x.rs` |
| `{a,b}` | 花括号展开 | `src/api/{payment,gateway}.rs` |
| `?` | 单字符 | `src/auth?.rs` |

### Producer 用法

写 plan.md 时优先用 `modules`（语义名，无需知道路径），需要精确控制时用 `globs`，语言维度用 `languages`。

### L2 gate manifest（语言选择只作补充）

orchestrator 可按变更文件语言提前选择补充 gate，但**不得用增量选择替代计划中的 required gate**。
在 L2→QA 前，必须按 plan.md 全量执行 required `local_gate`，按 `{id,type,cmd,expect,required}`
生成 manifest digest，并把完整 gate ID 集合与当前 40 位 HEAD SHA 写入 progress：

```bash
required_local_gate_ids=$(读取 plan.md 全部 required local_gate)
run_all(required_local_gate_ids)
write(l2_verification_passed, l2_verified_sha, l2_gate_manifest_sha256, l2_stash_refs)
```

语言/target_rules 仍可决定额外 gate 或 Dev 自测范围；但最终证据不能拼接旧结果，也不能只跑失败项。

### EvoClaw fidelity 量化

每个 Sprint 结束后 Producer 跑：
```bash
pwsh skills/kixpower/scripts/verification-fidelity-check.ps1 -ProjectRoot <ROOT> -PrevSprint <N>
```
输出未门禁文件比例。>20% 未门禁 → HIGH_RISK → 下个 Sprint 强制补 target_rules。

### 实测数据（示例项目 Sprint 1）

| 指标 | v3.2（清单） | v3.3（规则） |
|---|---|---|
| 未门禁率 | 97.1% 🔴 | **4.9%** 🟢 |
| 状态 | HIGH_RISK | LOW_RISK |

---

## 6.6 PR 审查模式（v3.4 新增）

> 来源：用户需求 + 工业实践。Sprint 流程用于**自己写代码**，PR 审查用于**审查别人的代码**。

### 用法

```
/kixpower-review                # 让用户选一个 PR
/kixpower-review 42             # 审查 PR #42
/kixpower-review 42 --save      # 审查 + 把 review summary 提交到 head branch
/kixpower-review 42 --approve   # 审查 + 预选 APPROVE（仍走 post-gate 用户确认）
```

### 前置 gate

- 项目有 `.git`
- 有 git remote 且是 GitHub
- 发布渠道可用：`gh` CLI 已认证，或 MCP GitHub 写工具可用（`get_me` 返回身份）

### 7 维度分层审查

| # | 维度 | 检查项 | 评论位置 |
|---|---|---|---|
| 1 | Security | 凭据泄露、注入、权限、SSRF | 行内 |
| 2 | Correctness | 业务逻辑、边界、null、竞态 | 行内 |
| 3 | Performance | N+1、循环 IO、克隆、锁粒度 | 行内 |
| 4 | Style | 命名、复杂度、重复、YAGNI | 文件级 |
| 5 | Test Coverage | 测试覆盖、边界、回归风险 | 文件级 |
| 6 | Architecture | 模块边界、抽象泄漏 | PR 级 |
| 7 | Docs | API 文档、CHANGELOG、ADR | PR 级 |

### 严重级别

- 🔴 **blocking**：必须修才能合并
- 🟡 **major**：强烈建议修
- 🔵 **minor**：可选改进
- ✅ **nit**：极小问题

### 约束

- **只读实现**：不改源码、不 merge；`--save` 的 summary push 需单独确认
- **异质复核**：APPROVE、blocking/major 或其他重要 claim 必须按 [kixpower-review.prompt.md](../../prompts/kixpower-review.prompt.md) 调专用只读 reviewer 的两个独立视角复核
- **Token 控制**：大 PR（>500 文件）只审查 top 50 改动最多的文件
- **行内评论 ≤ 20 条**（防 spammy）

---

## 6.7 L3 GitHub Actions 能力状态（v5.7，degraded-local）

> 当前模板只报告 GitHub Actions 的事件可见性，不调用 Kix、不修改 Sprint、不发布 Review/Issue，
> 不把绿色 workflow 误报为编排成功。完整状态模板见 `templates/github-actions-l3-trigger.md`。

### 触发场景

| GitHub 事件 | 当前动作 | 说明 |
|---|---|---|
| `pull_request` 打开/更新 | capability report | `NOT_TRIGGERED`，本地运行 review |
| `push` 到 main | capability report | `NOT_TRIGGERED`，本地运行 continue |
| `schedule: cron '0 */6 * * *'` | capability report | `NOT_TRIGGERED`，本地恢复 stalled Sprint |

### 当前使用方式

1. 如需状态可见性，把 `github-actions-l3-trigger.md` 中的只读 workflow 放到项目 `.github/workflows/`。
2. 手动 `workflow_dispatch` 只能验证 `degraded-local` / `NOT_TRIGGERED` 报告。
3. 实际编排继续在 VS Code 本地运行 `/kixpower-review` 或 `/kixpower-continue`。
4. 只有项目提供版本固定、权限受控并通过 smoke 的 adapter 后，才可单独评估升级为 `enabled`。

### 价值对比

| 场景 | 本地（L1+L2） | GitHub Actions（L3 当前） |
|---|---|---|
| 主动开发 | `/kixpower-continue` | `NOT_TRIGGERED`，提示本地命令 |
| PR 审查 | `/kixpower-review` | `NOT_TRIGGERED`，提示本地命令 |
| 卡住恢复 | `/kixpower-continue` | `NOT_TRIGGERED`，提示本地命令 |

当前不减少人工干预；模板的价值是诚实暴露能力缺口，而不是制造自动化成功假象。

### 回退方案

L3 当前是**降级实验模板**，不是已实现的自动编排。没有可信 adapter 时回到本地 `/kixpower-*`。

---

## 7. Hard Guardrails 速查

### 7.1 全部硬熔断（任一触发立即停）

| Guardrail | 阈值 | 触发动作 | 论文依据 |
|---|---|---|---|
| max_subagent_calls_per_session | 10 次 | handoff | Dojo 6 项 guardrails |
| max_tokens_per_session | 窗口×0.88（1M=880K） | 立即 handoff | Dojo + NeedleInAHaystack 2026 |
| max_tokens_per_subagent_run | 窗口×0.25（1M=250K） | 中止该 run | Dojo per-run budget |
| no_progress_threshold | 连续 2 轮无变化 | 标记 silent_failure | Dojo |
| tool_failure_circuit_breaker | 同工具失败 3 次 | 降级 | Dojo |
| single_subagent_retry_cap | stage 间重试 1 次 | Blocked | Dojo |
| l2_verification_retry_cap | L2 内 rubric-retry 2 次 | 转 Dual Loop | LangChain L2 |
| blast_radius_commit_budget | task_sizing 派生（v5.0 公式 `dag_layers+strong_coupling_count+bug_reserve`，hard_cap=10） | hook 三级回退（progress.md→plan.md→默认 3） | 9 Ways blast radius |
| blast_radius_branch | 必须在 feature branch | hook 硬拦 | 9 Ways |
| blast_radius_force_push | 禁 git push --force | hook 硬拦 | 9 Ways |
| blast_radius_destructive_sql | 禁 DROP/TRUNCATE/DELETE without WHERE | hook 硬拦 | 9 Ways |
| blast_radius_mcp_github_main | 禁直接写 main/master | hook 硬拦 | 9 Ways |
| qa_revision_freshness | QA session/stash/reverify marker 与 L2/HEAD 不一致 | hook 硬拦 | v5.7 |
| dev_authority_boundary | Dev 写入 L2/QA 权威字段或通过终端改写 progress.md | hook 硬拦 | v5.7 |
| execution_tool_boundary | 未登记代码执行/脚本工具、不可验证的 notebook cell 执行 | hook 硬拦 | v5.7 |
| remote_qa_freshness | QA 通过远程文件工具改测试/fixture/签署文档 | freshness marker | v5.7 |
| unknown_subagent_target | subagent 目标缺失或未登记 | hook 硬拦 | v5.7 |

### 7.2 Observe 检查清单（每次 turn 后）

```
1. artifacts 真实变更？     git status --short
2. progress.md frontmatter 增长？  对比 completed_tasks
3. Goal Drift 检测（带白名单）     对比 git diff --name-only vs plan.md target_rules 展开结果
4. 写 Trace Log（YAML 结构化）
```

### 7.3 Token 水位线（v3.7 百分比阈值）

> 按模型上下文窗口百分比定义，不硬编码绝对值。orchestrator 启动时读 PROJECT_BRIEF.md 的 `model_context_window`（默认 1M）。

| 水位 | 占窗口 | 1M 模型 | 200K 模型 | 动作 |
|---|---|---|---|---|
| 安全 | < 60% | < 600K | < 120K | 正常推进 |
| 警觉 | 60-75% | 600-750K | 120-150K | prompt 精简，不内嵌文件内容 |
| 危险 | 75-88% | 750-880K | 150-175K | 停止调下一个子 agent，做 handoff |
| 临界 | > 88% | > 880K | > 175K | 立即 handoff（硬熔断） |

**依据**：NeedleInAHaystack 2026 召回率研究 — 1M 模型在 75% 前几乎无性能损失，88% 后进入不可靠区。

---

## 8. 故障应对

### 8.1 Inner/Outer Dual Loop（遇 Blocked 时）

orchestrator 遇 `❌ Blocked` **不立即交回用户**，按顺序尝试：

```
诊断 → 重路径评估（最多 2 次策略重置）：
  1. 拆分（task 太大 → 拆子任务）
  2. 降级（替代实现路径，如 integration → unit with mocks）
  3. 绕开（deferred-to-sprint-N+1，需用户确认）
  4. 换工具（CodeGraphy 失败 → grep）
→ 若 2 次后仍 Blocked → 交回用户
```

### 8.2 L2 Verification 失败处理

```
Dev 报告完成
  ↓
orchestrator 自跑 local_gate
  ↓ 失败？
rubric-retry Dev（带失败输出 + 期望）
  ↓ 失败 ≤ 2 次 → 继续重试
  ↓ 失败 > 2 次 → 转 Inner/Outer Dual Loop
```

### 8.3 Silent Failure 处理

```
Observe 检测 artifacts 变更为 0 但子 agent 报告"完成"
  ↓
标记 silent_failure
  ↓
不推进，触发 Dual Loop（优先"换工具"或"拆分"策略）
```

### 8.4 典型场景应对

| 场景 | 应对 |
|---|---|
| **本机无 Docker** | orchestrator 自动把 docker-required 测试标为 `ci_gate`，本机走 `local_gate` CONDITIONAL |
| **clippy 失败** | L2 捕获，rubric-retry Dev 修（最多 2 次），不推 QA |
| **Dev 改了范围外文件** | Observe 步骤 3 检测 goal_drift → Dual Loop「重置范围」 |
| **Token 接近上限** | 水位线预警 → handoff（写交接文档到临时目录） |
| **子 agent 超时** | 重试 1 次 + 补充上下文；仍失败 → Blocked 交回用户 |

---

## 9. 最佳实践

### 9.1 用户侧

**DO**：
- ✅ 启动前写清楚项目目标（一句话 + 3-5 功能点）
- ✅ 大型项目分多个 Sprint，不要一个 Sprint 干完所有事
- ✅ 接受 CONDITIONAL 签署（ci_gate 待 CI 是合法状态）
- ✅ Sprint 结束后读 `hill-climbing.md`，确认改进项合理

**DON'T**：
- ❌ 不要手动绕过 blast-radius hook（除非明确知道在做什么）
- ❌ 不要让 orchestrator 在 main 分支直接跑（会触发 hook）
- ❌ 不要一个 prompt 塞太多需求（拆 Sprint）
- ❌ 不要读 `*.jsonl` transcript 文件（会撑爆上下文）

### 9.2 Producer 侧

- plan.md 各节点的 `target_rules.mechanical_links` 声明机械关联查询
- 启动新 Sprint 前必做 drift check（读项目 canonical `.kixpower/memory/repo/harness-backlog.md`；旧宿主路径仅作 adapter）
- brainstorm 至少产生 2 次真正分歧

### 9.3 Dev 侧

- **每任务完成立即跑 fmt/clippy**（不要积压到 L2）
- Sprint 首次启动必生成 runtime-context.md
- 失败必追加 lessons-learned.md
- 源码编辑用平台精确编辑工具（优先 `edit`；不可用时用最小 `apply_patch`），禁 inline shell

### 9.4 QA 侧

- 不重跑 local_gate（Dev 已在 L2 跑过）
- 优先 deterministic check，LLM-as-judge 仅复杂语义
- 安全相关（凭据泄露）发现新问题必 FAIL，不可 CONDITIONAL

---

## 10. 常见问题

### Q1: orchestrator 一直循环不停止？

检查 Hard Guardrails：
- 是否触发 `max_subagent_calls=10`？
- 是否触发 `no_progress_threshold=2`（连续 2 轮无变化）？
- 是否触发 `max_tokens_per_session`（窗口×0.88，1M 模型=880K，v3.7 起按百分比动态计算）？

如果都没触发但循环，可能是 plan.md 任务粒度过粗 → 手动拆分任务。

### Q2: L2 总是失败怎么办？

- 检查 Dev 是否真的跑了 fmt/clippy（看 Dev 输出）
- 检查是否任务太大致使每次改动都引入新 lint
- 降级策略：把 clippy warnings 改为 allow（在代码加 `#[allow(...)]`），但记入 lessons-learned

### Q3: Goal drift 误报频繁？

- 检查 plan.md 的 target_rules 是否覆盖真实改动（含 mechanical_links）
- 白名单是否覆盖了测试文件 / 文档文件
- 如仍误报，调整阈值（Observe 步骤 3 的 20% 改 30%）

### Q4: 如何在新会话恢复上下文？

```
对话输入：「恢复 Sprint N 上下文」
```

orchestrator 会：
1. 读 PROJECT_BRIEF.md + progress.md + canonical lessons-learned.md
2. 读 canonical harness-backlog.md（应用待办改进项）
3. 输出状态摘要
4. 自动继续执行

### Q5: 多个项目如何隔离？

每个项目独立的 `<PROJECT_ROOT>/.kixpower/memory/repo/` 目录：
- `<PROJECT_ROOT>/.kixpower/memory/repo/<project>.md` + `lessons-learned.md` + `harness-backlog.md`
- `/memories/repo/` 仅作旧项目 legacy adapter，不双写。

切换项目时 orchestrator 自动读对应 repo memory。

### Q6: 如何关闭某个 hook？

编辑对应 `.agent.md` 的 `hooks` 段，注释掉不需要的 hook。但不建议关闭 `blast-radius-check.ps1`（生产事故防线）。

### Q7: 拓扑自适应选错了怎么办？

orchestrator 在分派前会输出选拓扑的 reasoning。如不满意：
- 要求 Producer 重新计算 DAG 并修改 plan.md，不由 Orchestrator/QA/Dev 手改规划
- 若安全或文件重叠要求串行，让 Producer 在 task 上加 `force_sequential: true`

### Q8: L4 Hill Climbing 改进项没人应用？

检查 Producer agent.md 是否有「应用 L4 改进项」职责（已加）。Producer 启动新 Sprint 时应读 canonical harness-backlog；无 status 的 legacy 条目按 candidate，不得直接应用为规则。

---

## 11. 论文依据与版本历史

论文清单、关键数据点、版本演进见 [AUDIT.md](../kixparadigm/AUDIT.md) §4-§5（复查时读，不自动加载）。

## 附录：快速命令速查

```bash
# 启动 Sprint
对话：「继续 Sprint N」 或 「创建项目 [name]」

# 手动触发 L4（如 orchestrator 没自动跑）
对话：「分析本 Sprint 的 Trace Log，生成 hill-climbing 报告」

# 查看当前状态
Get-Content docs/sprint-N/progress.md -TotalCount 25  # 读 frontmatter

# 查看改进 backlog
Get-Content .kixpower/memory/repo/harness-backlog.md

# 检查 blast radius 配置
Get-Content docs/sprint-N/progress.md | Select-String "blast_radius" -Context 0,5

# 验证 hook 工作（字节流 stdin；不要用 PowerShell 对象管道）
$testInput = @{ tool_name = "pwsh"; tool_input = @{ command = "git push --force"}; workspaceFolder = (Get-Location).Path } | ConvertTo-Json
$testInput | Set-Content "$env:TEMP\kix-hook-input.json" -Encoding utf8
cmd /c "pwsh -NoProfile -File `"$HOME/.copilot/skills/kixpower/hooks/blast-radius-check.ps1`" < `"$env:TEMP\kix-hook-input.json`""
```

---

**维护者**：Kixpower Orchestrator v5.7
**最后更新**：2026-08-07
**论文截止**：2026.07
