---
description: "🔄 [v5.7] 继续/恢复 Sprint：单次解析 current_sprint→验证 L2 manifest/SHA/QA freshness→从正确阶段接力。用法：/kixpower-continue、/kixpower-continue 2 或 --new"
agent: "kixpower-orchestrator"
---

> **DSH 适配注记**：本流程从 VS Code Copilot 导入，在 DeepSeek Harness 中执行。文档中的工具名/机制按 preset 根 `DSH-ADAPTATION.md` 映射（run_in_terminal→pwsh、read_file→read、grep_search→grep、replace_string_in_file→edit、create_file→write、vscode_askQuestions→ask_user_question、runSubagent→subagent（prompt 注入 agents/*.agent.md 角色 body）、mcp_github_*→gh CLI、codegraphy_*→grep/read）。`{{input}}` 即用户输入。`/kixpower-*` 已注册为 DSH 原生命令（kix-commands 插件）：用户敲 `/` 可见候选，触发后本文件正文经剥离 frontmatter 注入为 user 消息，模型按流程执行。

执行 **模式 2+3 合并：继续/恢复 Sprint**。

合并原因：模式 2（继续）和模式 3（恢复）流程高度重叠，统一为"读上下文→判断阶段→接力"。

## 输入

用户输入：`{{input}}`

解析规则：
- 空白 → 自动找最新的 `docs/sprint-N/`（按 N 数字最大）
- 含数字 N → 用该 Sprint 编号
- 含 `--new` / “新 Sprint” → 仅当 latest 已有 done.md 时令 `N=latest+1`，从 Producer 规划开始；否则继续 latest

启动时只解析一次 `current_sprint=N`，把 N 写入 `docs/.kixpower-current-sprint`，并断言目录编号与 progress.md frontmatter 的 `sprint` 相等；不一致即 Blocked，禁止各阶段自行重新推断。

## 执行流程

### 阶段 1：读上下文（orchestrator 自己做）

并行读取：
1. `PROJECT_BRIEF.md`（特别是第 7、8 节 Sprint 状态 **+ frontmatter 的 `content_language`**）
2. `docs/sprint-N/progress.md`（**完整 frontmatter + Trace Log**）
3. `docs/sprint-N/plan.md`（含 task DAG + verifiable_gates）
4. `docs/sprint-N/runtime-context.md`（若存在）
5. `<PROJECT_ROOT>/.kixpower/memory/repo/lessons-learned.md`（Reflexion 记忆；旧项目读取宿主 legacy adapter）
6. `<PROJECT_ROOT>/.kixpower/memory/repo/harness-backlog.md`（**L4 实践项生命周期**）
7. `docs/sprint-(N-1)/hill-climbing.md`（上一 Sprint 的 L4 报告，若存在）

**content_language 处理**：
- 若 PROJECT_BRIEF.md frontmatter 有 `content_language` → 全程沿用
- 若无（老项目）→ orchestrator 推断后调用 Producer 迁移 PROJECT_BRIEF.md frontmatter，并告知用户「已根据仓库风格推断 content_language=X」
- 若用户本会话说「这次用英文」→ 本次分派临时覆盖；如需持久化则调用 Producer 更新 PROJECT_BRIEF.md

### 阶段 2：状态判定（决定从哪个阶段接力）

读 progress.md frontmatter 的 `status` 字段：

| status | 含义 | 接力点 |
|---|---|---|
| `planning` | Producer 还没写完 plan.md | 重启 Producer |
| `in-progress` + `completed_tasks < total_tasks` | Dev 进行中 | 重启 Dev 继续剩余任务 |
| `in-progress` + `completed_tasks == total_tasks` + `l2_verification_passed` 为空 | Dev 完成但 L2 没跑 | 跑 L2 Verification Loop |
| `in-progress`/`done` + `l2_verification_passed` 非空但 `l2_verified_sha != HEAD` 或有非文档工作树变更 | L2 已失效 | 调 Dev 提交未验证变更（Dev 负责 commit），再重跑 L2 Verification Loop 刷新 gate ID + SHA |
| `in-progress` + L2 完整且 `l2_verified_sha == HEAD` + 无非文档工作树变更 + stash 与 `l2_stash_refs` 一致 + 无 qa-signoff | 等 QA | 调 QA，并在 prompt 携带 `qa_started_sha: <当前完整 HEAD>` |
| `blocked` | 有 `❌ Blocked` | 触发 Inner/Outer Dual Loop |
| `done` + L2 为空/不完整/`l2_verified_sha != HEAD` | 任务已完成但权威 L2 无效 | 跑 L2 Verification Loop |
| `done` + L2 非空但有非文档工作树变更 | L2 已失效 | 调 Dev 提交未验证变更，再重跑 L2 Verification Loop |
| `done` + L2 完整且 `l2_verified_sha == HEAD` + 无非文档工作树变更 + 无 qa-signoff | 任务与 L2 已完成但 QA 未执行 | 调 QA |
| `done` + qa-signoff 为 PASS/仅 CI pending 的 CONDITIONAL + 无 hill-climbing.md | QA 可接受，L4 未执行 | 跑 L4 Hill Climbing |
| `qa-signoff` 为 `REVERIFY_REQUIRED` | QA 改动了测试或 fixture，L2 证据失效 | 返回 Orchestrator，全量重跑 required local_gate 后重新 QA |
| `done` + qa-signoff + 有 hill-climbing.md + 无 done.md | QA/L4 已完成但无完成报告 | Producer 写 done.md + 更新 PROJECT_BRIEF.md 第 7、8 节 |

“L2 完整”必须同时满足：`l2_verification_passed` 的 gate ID 集合覆盖 plan 中全部 `local_gate`、`l2_verified_sha` 等于当前 HEAD、`l2_stash_refs` 与当前 `git stash` 集合一致、`git status --porcelain` 不含 docs/、PROJECT_BRIEF.md 与 canonical Memory 文档之外的变更；仅列表非空不算完成。

### 阶段 3：Cross-Sprint Drift 检测（Producer 视角）

若接力点是 Producer（status=planning）或本 Sprint 是 N+1（接续上一完成的 N），必做 drift check：

- **Context Drift**：对比 runtime-context.md 与当前实际（env vars 变了？文档漂移登记解决了吗？）
- **Error Propagation**：lessons-learned.md 上一 Sprint 条目，本 Sprint 是否已避免？
- **Tech Debt**：progress.md 的「Sprint+1 候选」累积了多少？
- **Verification Fidelity**：上一 Sprint 的 verifiable_gates 是否真覆盖所有改动？跑 `git log --since="last sprint"` 看是否有未门禁 commit。

输出 `docs/sprint-N/drift-check.md`。

### 阶段 4：消费 harness-backlog 实践项（强制，不依赖 Producer 自觉）

读项目内 canonical harness-backlog.md 的非 archived `sprint|any` 项，先按 `overlaps_with` / `supersedes` 去重：
- **orchestrator 在分派 Producer 的 prompt 中强制塞入**（不靠 Producer 自觉读）：
  ```
  🔴 必读：<PROJECT_ROOT>/.kixpower/memory/repo/harness-backlog.md 的实践学习状态
  - validated + task kind/trigger 匹配：应用到本 Sprint plan.md，并记录 item ID / regression_signal 供 L4 监测
  - candidate + task kind/trigger 匹配：仅作为 scoped trial，并写 trial ID + 可观测 eval
  - archived 或 trigger 不匹配：不应用；not triggered 不算 eval pass
  ```
- trial 创建后追加 `evidence: {kind: trial, result: pending}`；L4 收尾根据真实 gate / trace 改为 pass 或 fail
- 禁止清空全部待应用项；只有 archived 项移出活跃区

### 阶段 5：接力执行（按阶段 2 判定结果）

| 接力点 | 动作 |
|---|---|
| Producer | runSubagent kixpower-producer（含 drift check 输入） |
| Dev 继续 | runSubagent kixpower-dev，prompt 含 `current_sprint: N`，并注明"已完成 X/Y 任务，从任务 Z 继续" |
| L2 | orchestrator 自跑 local_gate + rubric-retry ≤ 2 |
| QA | runSubagent kixpower-qa，prompt 含 `current_sprint: N`、`qa_started_sha: <完整 HEAD>` 与 `l2_gate_manifest_sha256` |
| L4 | orchestrator 自分析 Trace → 评估 trial；新经验只写 candidate |
| 收尾 | Producer 写 done.md + 更新 PROJECT_BRIEF.md 第 7、8 节；prompt 必须携带 `stage: producer_closeout` 与 `current_sprint: N` |

### 阶段 6：输出状态通知（不等待确认）

```
📋 Sprint N 状态摘要
- status: [planning/in-progress/blocked/done]
- 任务: X/Y 完成
- L2: [未跑/已过 N 个 gate]
- QA: [未跑/PASS/CONDITIONAL/FAIL]
- 阻塞: [无 / 列出 ❌ Blocked]
- 上次 Trace: [最近一次 turn 的 result]
- harness-backlog: [candidate C（其中 trial T）/ validated V / archived A]
接力到: [阶段名]
```

用户显式调用 `/kixpower-continue` 已构成启动确认。输出摘要后自动接力；只有发布、合并、破坏性操作再次请求确认。

## 硬约束

- 不重新生成已存在的 PROJECT_BRIEF.md / plan.md（除非 Producer 触发 drift check 重写）
- 不重跑已 `l2_verification_passed` 的 gates（仅当完整 required gate 集合、manifest digest、
  `l2_verified_sha == HEAD`、stash 基线一致且无非文档工作树变更；任一变化立即失效）。QA 修改测试后必须标记
  `REVERIFY_REQUIRED`，由 Orchestrator 在最终 HEAD 重跑全部 required local_gate；重新 QA 成功后
  才能清除 `docs/.kixpower-qa-reverify.json` 运行时 marker。
- Hard Guardrails 全开
- 受 blast-radius hook 拦截

## Token 节约

读上下文阶段**禁止**：
- 读 `*.jsonl` transcript
- 读 progress.md 全文（只读 frontmatter + Trace Log 区块）
- 读 PROJECT_BRIEF.md 全文（只读第 7、8 节 + 摘要）

## 失败处理

- 接力点判断失败（progress.md frontmatter 不全/损坏）→ 询问用户当前阶段
- drift check 发现严重漂移（如代码已大改但 PROJECT_BRIEF.md 没更新）→ 标 `❌ Blocked: drift too large`，交回用户决策

## 替代关系

- 替代 `/recover-context`（老版本只输出"冷启动提示词"让用户复制粘贴，v3.1 直接接力执行）
- 替代 `/plan-sprint` 的"继续 Sprint"部分（老版本没 drift check / harness-backlog 应用）
- 如需创建全新 Sprint N+1（不接力），走 `/kixpower-new` 或新开 `/kixpower-continue`（`/plan-sprint` 已废弃）
