---
name: kixpower
user-invocable: false
description: "Kixpower — AI 多智能体协作编排（v5.7）。采用 DAG 动态拓扑与跨 Sprint 演进。4 个 slash command 触发：/kixpower-new（新项目）/kixpower-import（导入）/kixpower-continue（继续）/kixpower-review（PR 审查）。本文件为路由入口，完整规则见 TEAM_CONVENTIONS.md / USAGE_MANUAL.md。"
---

> **DSH 适配注记**：本文件从 VS Code Copilot 导入。工具名/机制映射（runSubagent→subagent、run_in_terminal→pwsh、vscode_askQuestions→ask_user_question、hooks 不自动触发（已由 kix-guards 原生替代）、跨厂商模型字符串不适用（用 `subagent_zhipu` 工具行）、slash command 已注册为 DSH 原生命令）见 preset 根 `DSH-ADAPTATION.md`，冲突时以该文件为准。

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
