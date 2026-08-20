---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS - not the current workspace.

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

## Token 预算纪律（MUST）

### 触发条件

| 条件 | 动作 |
|---|---|
| 用户显式要求或上下文明显过大 | 立即执行 handoff |
| AI 主动检测到上下文接近上限 | 执行 handoff |

### 交接文档编写规则

1. **自包含但极简**：只含决策、文件路径、阻塞项、待办。代码细节用文件名+行号引用
2. **禁止引用完整 transcript 文件**：不得写入 "如需详细信息请读完整 transcript" 或类似指引，那会导致新对话直接读大文件撑爆上下文
3. **优先引用已有文档**：PROJECT_BRIEF.md、plan.md、progress.md 已记录的信息不在 handoff 中复述，用相对路径引用
4. **一行摘要**：文档开头必须有一行 `# {项目名} Handoff — {日期}` + **一句**当前状态描述

### 输出大小控制

- handoff 文档正文 ≤ 200 行
- 使用表格/列表结构，不用段落叙述
- 敏感信息标记 `<REDACTED>` 而非删除
- 项目结构树用代码块，只展示关键目录（max 3 层深度）
