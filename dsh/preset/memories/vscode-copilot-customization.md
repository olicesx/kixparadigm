# VS Code Copilot 自定义体系

## Hooks —— 和 Claude Code 高度对齐（几乎无缝迁移）
- 位置：`.github/hooks/*.json`（团队共享）/ `~/.claude/settings.json`（用户级）/ `.claude/settings.json`、`.claude/settings.local.json`（仓库级）。**VS Code 直接兼容 Claude 的 `.claude/settings.json` 路径**
- Events：SessionStart / UserPromptSubmit / **PreToolUse** / **PostToolUse** / PreCompact / SubagentStart / SubagentStop / Stop
- PreToolUse 拦截：stdout JSON `hookSpecificOutput.permissionDecision` = `allow`/`ask`/`deny`
- PostToolUse：`decision: block` 可阻断后续
- 退出码：0 成功，2 阻断错误，其他=非阻断警告
- 格式：`{hooks:{PreToolUse:[{type:"command",command:"./x.sh",timeout:15}]}}`，支持 windows/linux/osx、cwd/env
- 权威参考：自带 `agent-customization` 技能的 references/hooks.md

### tools 字段：白名单是陷阱，除非真的要限
- VS Code Copilot `.agent.md` 里 **`tools` 字段省略 = 所有可用工具**（built-in + MCP + 扩展 + runSubagent）
- 加 `tools: [read, edit, search, web, todo, execute]` 反而**砍掉 MCP 工具**（如 GitHub MCP 提 Issue/合并 PR）和扩展工具
- 想限制越权应该用 **PreToolUse hook 硬拦**（按 `toolArguments.filePath` 路径模式 deny），而不是 tools 白名单
- 只有在"确实只要只读 + 完全无副作用"的场景（如纯审查 agent）才适合用白名单

### Custom agent body 去重（DRY）
- 多个 agent 共用规则（工具规范、输出格式、协作流程）不要复制粘贴到每个 `.agent.md`
- 抽到独立的 `TEAM_CONVENTIONS.md`（放 skill 目录下），agent body 用一行 markdown link 引用
- 每个 agent body 只保留：① 角色定位 ② 独有职责 ③ 独有硬约束（可编辑文件白名单/黑名单）
- 坑：agent body 里的 link **不会自动加载**到 agent 上下文，必须保留最低限度的硬约束在 body 内（用 hook 兜底）

### Agent 在选择器里重复显示的诊断路径
- 现象：`@ai-team-dev`/`producer`/`qa` 在 picker 出现两次，但 `orchestrator` 不重复
- 根因：同时存在两个 agent 源
  - `~/.copilot/agents/*.agent.md`（用户改造版，4 个全有）
  - `~/.vscode/agent-plugins/<marketplace>/<org>/<repo>/ref_marketplace/plugins/<plugin>/agents/*.md`（市场插件原版，只 3 个，没 orchestrator）
- VS Code Copilot 对 `.agent.md` 和 `agents/*.md` 都识别 → 双重加载
- 诊断命令：
  ```powershell
  Get-ChildItem 'C:\Users\<user>' -Recurse -Force -Filter 'ai-team-*.agent.md' | select FullName
  Get-ChildItem 'C:\Users\<user>\.vscode\agent-plugins' -Recurse -Filter '*.md' | ? { $_.Name -match '^ai-team-' }
  ```
- 解决：**删除市场插件 agents/ 下的重复文件**（保留 skills/templates），备份为 `.md.bak.<ts>`（`.md.bak.xxx` 后缀不被 Copilot 加载，比纯 `.bak` 安全）
- 不要误删 `~/.copilot/agents/` 下的用户改造版（会丢失所有定制）
- **无 `toolName` 过滤的全局 PreToolUse hook = 流程杀手**：它会在每次工具调用都触发（read/edit/search/runSubagent 全部）。如果 hook 内部判断"某状态文件不存在就 deny"，会让 agent 自己创建该状态文件时也被拦截 → 死锁
- **阶段过渡/状态机判定不应放 hook**：hook 用于"确定性 shell 校验"（危险命令、白名单路径），阶段切换逻辑应放 agent body 作为 MUST 规则
- **若必须在 hook 里判阶段**：① 读 `toolName`，只在 `runSubagent` 时介入；② 读 `toolArguments.agentName`，只对目标子 agent 判定；③ 其他情况一律 `exit 0`
- **`command` 和 `windows` 字段勿重复**：平台覆盖字段只在命令不同时才填，相同命令重复会引入未定义优先级

## `.agent.md` frontmatter hooks（官方支持，但有约束）

- **VS Code Copilot 官方支持 `.agent.md` frontmatter 的 `hooks:` 字段**（查 agents.md 确认："Optional, inline hooks for this agent's lifecycle events"），不是非法配置
- **frontmatter hook 只支持字段**：`type`/`command`/`windows`/`linux`/`osx`/`cwd`/`env`/`timeout`。**不支持 `matcher`/`toolName`**，无法在调度层按工具过滤 → PreToolUse hook **每次工具调用（含只读 read/search）都启动脚本进程**
- **必须在脚本内做 toolName 早期返回**：`$editTools=@('replace_string_in_file','insert_edit_into_file','edit_notebook_file','create_file','create_or_update_file'); if($toolName -and ($editTools -notcontains $toolName)){exit 0}`。否则每次只读操作都跑完整路径正则 = 一堆 hook 通知/警告
- **路径匹配致命陷阱**：hook 收到的 `filePath` 是**绝对路径**（如 `c:/Users/.../src/utils/x.js`）。用 `^src/` 这类相对路径锚点**永远匹配不上** → 源码保护形同虚设（实测 block-source-edit.ps1 漏放所有源码）。正确做法：①从 `workspaceFolder` 提取相对路径 ②模式用 `(^|/)src/`（前导斜杠边界）③对 relPath 和 normalizedPath **双重匹配**兜底
- **PostToolUse 同理**：auto-update-progress.ps1 原本每次工具调用后都跑 `git status`，加 toolName 过滤后只在编辑后才检查
- **验证方式**：① 用 `[Parser]::ParseFile` 查语法 ②核心逻辑用独立 .ps1 测试脚本跑（内联多行命令含大量引号会被终端解析污染，输出幽灵字符串；管道 `echo json | pwsh -File` 也不稳）

## 其他 customization 基元
- agent instructions：`.github/copilot-instructions.md` / `AGENTS.md`（always-on）
- file instructions：`.github/instructions/*.instructions.md`（applyTo 或 description 触发）
- prompts：`.github/prompts/*.prompt.md`（斜杠命令，带参数）
- custom agents：`.github/agents/*.agent.md`（子代理/工具限制/上下文隔离，frontmatter 可内嵌 hooks）
- skills：`.github/skills/<名>/SKILL.md`（按需工作流，带脚本/模板资产）
- user 级：`{{VSCODE_USER_PROMPTS_FOLDER}}/`（prompts/instructions/agents，随 settings sync 漫游）

## 跨仓库迁移结论
- `mattpocock/skills` 这类 Claude Code 技能仓库在 VS Code Copilot 上**全量可落地**：
  - SKILL.md 格式通用 → 放 `.github/skills/` 或 `.copilot/skills/`
  - hooks 几乎直接复用（VS Code 连 .claude/settings.json 都读）
  - CONTEXT.md 领域语言 → 放仓库 + copilot-instructions.md 引用
  - issue/PR 流程 → GitHub MCP
- 曾误判"VS Code 无 hook 机制"——已修正（2026-06）
