---
description: "🚀 [v5.7] 全新项目启动：访谈→Producer→Dev→L2→QA→L4→Producer 收尾。用法：/kixpower-new 或 /kixpower-new 项目名 技术栈"
agent: "kixpower-orchestrator"
---

> **DSH 适配注记**：本流程从 VS Code Copilot 导入，在 DeepSeek Harness 中执行。文档中的工具名/机制按 preset 根 `DSH-ADAPTATION.md` 映射（run_in_terminal→pwsh、read_file→read、grep_search→grep、replace_string_in_file→edit、create_file→write、vscode_askQuestions→ask_user_question、runSubagent→subagent（prompt 注入 agents/*.agent.md 角色 body）、mcp_github_*→gh CLI、codegraphy_*→grep/read）。`{{input}}` 即用户输入。`/kixpower-*` 已注册为 DSH 原生命令（kix-commands 插件）：用户敲 `/` 可见候选，触发后本文件正文经剥离 frontmatter 注入为 user 消息，模型按流程执行。

执行 **模式 1：全新项目初始化**。

开始规划前，Orchestrator 先创建 `docs/` 目录，再把 `1` 写入 `docs/.kixpower-current-sprint`，作为 handoff 与 blast-radius 的单一 active Sprint 来源。

## 输入

用户输入：`{{input}}`

解析规则：
- 空白 → 走完整访谈（一次问 1-2 个问题）
- 含项目名 → 用提供的名字，访谈其他项
- 含技术栈 + 功能 → 跳过基础访谈
- 含 `--lang zh|en|bilingual|repo` → 跳过语言询问，直接用指定值

## 执行流程（必须按顺序，全程自动推进）

### 阶段 0：信息收集
通过问答收集（如未提供）：
1. 项目名（一句话）
2. 技术栈（前端/后端/DB/构建工具）
3. 3-5 个核心功能
4. 项目根目录（绝对路径）
5. **内容语言**（zh / en / bilingual / repo，默认 repo；说明：影响代码注释/commit/过程文档语言；详见 orchestrator MUST 规则 11）

### 阶段 0.5：写入 content_language 到 PROJECT_BRIEF.md frontmatter

Producer 创建 PROJECT_BRIEF.md 时**必须**包含：
```yaml
---
content_language: <用户选择或推断值>
content_language_source: user | inferred | default
---
```

后续 Producer/Dev/QA 的所有 prompt 末尾都追加：
`内容语言：{value}（来源：PROJECT_BRIEF.md frontmatter）`

### 阶段 1：Producer（runSubagent kixpower-producer）
prompt 要点：
- 生成 `PROJECT_BRIEF.md`（14 章节）
- 创建 `docs/{brainstorm,sprint-1,qa}/` 目录
- 执行 6 角色结构化脑暴（至少 2 次分歧）
- 生成 `docs/sprint-1/plan.md`，**必须含 task DAG**（每个节点声明 `target_rules`，含 mechanical_links）
- 在 plan.md 定义项目特化 `verifiable_gates`（local/ci/manual），必须在 Dev 启动前完成
- 生成 `docs/sprint-1/progress.md`（含完整 YAML frontmatter：blast_radius / topology_used / sprint_baseline_sha / observe_fingerprint / dev_self_tests_passed / l2_verification_passed / l2_verified_sha / l2_stash_refs 占位）
- 生成 `docs/sprint-1/runtime-context.md`（Producer 先做初步收集，Dev 启动时补全）

### 阶段 2：Observe
- 跑 `git status --short` 验证 artifacts 真的生成
- 读 progress.md frontmatter 确认 status=planning→in-progress

### 阶段 3：Dev（runSubagent kixpower-dev）
prompt 要点：
- 读 PROJECT_BRIEF.md + plan.md + `<PROJECT_ROOT>/.kixpower/memory/repo/lessons-learned.md`（旧宿主 memory 仅作 legacy adapter）
- 补全 `docs/sprint-1/runtime-context.md`（按 templates/runtime-context-snapshot.md 模板）
- 按拓扑自适应执行（orchestrator 已在 plan.md 的 task_dag.properties.recommended_topology 指定）
- **每任务完成立即跑 fmt/clippy**（不等批次结束）

### 阶段 4：Observe + L2 Verification Loop
- Observe 4 步（含 Goal Drift 白名单检测）
- orchestrator 自跑 local_gate（cargo test/clippy/fmt + tsc/lint）
- 失败 → rubric-retry Dev（≤ 2 次，独立预算 `l2_verification_retry_cap`）
- 通过 → 写 progress.md 的 `l2_verification_passed`

### 阶段 5：QA（runSubagent kixpower-qa）
prompt 必须携带 `current_sprint: 1`、`qa_started_sha: <当前完整 HEAD>` 和 `l2_gate_manifest_sha256: <当前 manifest digest>`
prompt 要点：
- 读 plan.md 的 verifiable_gates（QA 只跑 ci_gate + manual_gate，**不重跑 local_gate**）
- 跑 ci_gate（docker-required；本机跑不了 → 标 CONDITIONAL-with-CI-pending）
- manual playthrough
- 生成 `docs/qa/qa-signoff-1.md`
- 签署规则：local✅ + ci✅ + manual✅ = PASS；local✅ + ci pending + manual✅ = CONDITIONAL

### 阶段 6：L4 Hill Climbing（orchestrator 自执行，不再调子 agent）
- 先运行 `scripts/validate-memory-backlog.ps1 -ProjectRoot <ROOT>`；失败不得收尾
- 聚合 progress.md 的 Trace Log
- 比较预期 / 结果证据 / 反证，评估 pending trial；无新信息时只记录 `novel_evidence: false`
- 模式识别（silent_failure / goal_drift / l2_failed / over_budget 计数）只生成 candidate 资格
- 生成 `docs/sprint-1/hill-climbing.md`
- 有可复用新证据时写入 `<PROJECT_ROOT>/.kixpower/memory/repo/harness-backlog.md`，初始必须 `status: candidate`；不得直接晋升为规则

### 阶段 7：Producer 收尾
- 调 `kixpower-producer`（prompt 携带 `stage: producer_closeout`、`current_sprint: 1`）写 `docs/sprint-1/done.md`
- 更新 PROJECT_BRIEF.md 第 7、8 节，并确认 progress 状态与 QA/L4 结论一致

### 阶段 8：交付总结（输出给用户）
```
✅ Sprint 1 完成
- 任务：N/M 完成
- L2 Verification: 全过 / N 次重试
- QA 签署: PASS / CONDITIONAL（注明 ci_gate pending 项）
- L4 实践学习: candidate C / validated V / archived A
- 关键文件: [列出 3-5 个]
下一步: [建议]
```

## 硬约束（不可协商）

- 全程走 v5.0 编排，不用老 SKILL.md 流程
- 每个 stage 间串行；Dev 内部按拓扑自适应决定并行/串行
- Hard Guardrails 全开（max_subagent_calls=10 / max_tokens_per_session=窗口×0.88 / blast_radius 全套）
- 受 `blast-radius-check.ps1` hook 拦截：commit_budget 由 task_sizing 派生（v5.0 公式 `dag_layers + strong_coupling_count + bug_reserve`，详见 TEAM_CONVENTIONS.md §Task Sizing），hard_cap=10 绝对上限 / 必须在 feature branch / 禁 force push / 禁 destructive SQL

## 失败处理

- 子 agent 失败 → 重试 1 次（stage 间）；L2 内独立 2 次重试
- 仍失败 → Inner/Outer Dual Loop（最多 2 次策略重置）→ 才交回用户
- Token 接近 窗口×0.88（默认 1M 模型=880K）→ 立即 handoff（提示用户开新对话读 harness-backlog）

## 替代关系

替代 `/bootstrap-team-project`（老版本走 SKILL.md 模式 A，不含 task DAG / L2 / L4 / drift check）。
