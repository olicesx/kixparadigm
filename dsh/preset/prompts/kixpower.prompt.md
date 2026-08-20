---
description: "⚡ [v5.7] 智能入口（无尾缀）。根据输入自动路由：模糊/新项目→new / 继续·恢复·context·sprint N→continue / 已有代码路径→import / PR·审查→review。空白则检测工作区状态后推荐。"
agent: "kixpower-orchestrator"
---

> **DSH 适配注记**：本流程从 VS Code Copilot 导入，在 DeepSeek Harness 中执行。文档中的工具名/机制按 preset 根 `DSH-ADAPTATION.md` 映射（run_in_terminal→pwsh、read_file→read、grep_search→grep、replace_string_in_file→edit、create_file→write、vscode_askQuestions→ask_user_question、runSubagent→subagent（prompt 注入 agents/*.agent.md 角色 body）、mcp_github_*→gh CLI、codegraphy_*→grep/read）。`{{input}}` 即用户输入。`/kixpower-*` 已注册为 DSH 原生命令（kix-commands 插件）：用户敲 `/` 可见候选，触发后本文件正文经剥离 frontmatter 注入为 user 消息，模型按流程执行。

执行 **智能路由**：解析输入并派发到对应专用模式。

专用流程：[new](./kixpower-new.prompt.md) / [import](./kixpower-import.prompt.md) / [continue](./kixpower-continue.prompt.md) / [review](./kixpower-review.prompt.md)。命中后读取并执行对应文件，不凭摘要补全。

## 输入

用户输入：`{{input}}`

## 意图识别规则（按优先级，命中即停）

| 输入特征 | 路由到 | 说明 |
|---|---|---|
| 含 PR 编号 / "review" / "审查" / "PR" | **模式 4**（/kixpower-review） | PR 分层审查 |
| 含 "恢复上下文" / "context" / "我从哪开始" | **模式 2+3**（/kixpower-continue） | 读取状态并直接接力 |
| 含 "继续" / "接力" / "sprint N" | **模式 2+3**（/kixpower-continue） | Sprint 接力 |
| 含已有代码路径 / "导入" / "import" | **模式 0**（/kixpower-import） | 已有代码导入 |
| 其它（含项目名 / 技术栈 / 空白） | **模式 A / 模式 1**（/kixpower-new） | 默认：全新项目快速启动 |

## 执行步骤

1. **识别意图**（按上表），命中专用模式则读取上方对应 Prompt，**直接按其完整流程执行**。
2. **空白输入** → 先检测当前工作区状态再推荐：
   - 已有 `PROJECT_BRIEF.md` + `docs/sprint-N/` → 推荐**模式 2+3**（继续最近 Sprint）
   - 已有代码但无 `PROJECT_BRIEF.md` → 推荐**模式 0**（导入）
   - 空工作区 → 默认**模式 A**（全新启动），走完整访谈
3. **恢复上下文**不得输出复制粘贴提示词；读取并执行 [continue](./kixpower-continue.prompt.md) 的状态判定与接力流程。

## 默认路径（模式 A 快速启动）

无明确意图且工作区为空时，按 `/kixpower-new` 的完整流程执行：
访谈需求 → 生成 `PROJECT_BRIEF.md`（14 章节）→ 创建 docs 结构 → 6 角色结构化脑暴（至少 2 次分歧）→ 生成 Sprint 1 计划（task DAG + task_sizing 派生 commit_budget）→ 输出操作指引。

详细阶段 0→N 流程同 /kixpower-new。
