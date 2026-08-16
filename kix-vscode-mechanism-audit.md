# VS Code Copilot 机制审计 — kix 门禁漏探查清单（2026-08-16）

> **定位**：kix 范式在 VS Code Copilot 上的机制描述必须以**代码事实 + 调用链 + 权威文档**为准。
> 本文件是 2026-08-16 对照三路证据的审计结果：① 本机真实会话日志（`~/.copilot/session-state/*/events.jsonl`，copilot-agent 运行时 1.0.70/1.0.73）——**调用链**；② [GitHub 官方 Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)——**权威文档**；③ github/awesome-copilot 官方 [tool-guardian 参考实现](https://github.com/github/awesome-copilot/blob/main/hooks/tool-guardian/README.md)——**代码事实**。
> **触发**：用户使用 DSH 同款插件（`dsh/preset/plugins/kix-guards.js`，自 blast-radius ps1 移植）时发现"还是少考虑一些基本情况"——追根是 **VS Code 侧机制探查不全**，移植继承了三处系统性失真。
> **不是规则**：机制事实层 + 修复清单。修复决策按范式（0% 误报 / 规则是负债）另行判定。

---

## TL;DR（三个致命失真）

| # | kix 现有假设（ps1 hooks / memory） | 真实运行时（本机 copilot-agent 会话日志实测） | 后果 |
|---|---|---|---|
| **A** | hook 输入顶层字段 snake_case：`tool_name` / `tool_input` | **camelCase**：preToolUse 是 `toolCalls:[{id,name,args}]` **数组**（args 为 JSON 字符串）；postToolUse 是 `toolName`/`toolArgs`（toolArgs 为 JSON 字符串） | **kix 全部 ps1 门禁对真实载荷静默失效**（实测 `git push --force origin main` → exit 0 放行） |
| **B** | 终端工具名 `run_in_terminal`/`create_and_run_task`；编辑工具 `replace_string_in_file`/`apply_patch`/`insert_edit_into_file`/`create_file`/`delete_file` 等 | 官方工具名表：`powershell`/`bash`/`edit`/`create`/`view`/`grep`/`glob`/`ask_user`/`task`/`web_fetch` | 即便字段名对了，**工具分类也匹配不上**（旧扩展名 vs 新运行时名） |
| **C** | GitHub MCP 工具名 `mcp_github_*`（ps1）/ `mcp__github__*`（DSH） | 真实运行时 GitHub 工具是 **`GitHub-*`**（如 `GitHub-create_or_update_file`、`GitHub-add_issue_comment`） | GitHub 远程写保护在 VS Code 侧从不触发 |

次要失真：hook 输出契约、退出码语义、事件表不完整（缺 `permissionRequest`/`subagentStart`/`subagentStop`/`postToolUseFailure`/`userPromptTransformed`/`errorOccurred`/`notification`）、matcher 机制、hooks 配置位置、PascalCase 事件名下工具名映射为 Claude 名。

---

## 1. 权威事实（官方 Hooks reference，2026-08 抓取）

### 1.1 双载荷格式（由配置的事件名大小写选择）— kix 只知其一

官方原文：*"Two payload formats are supported, selected by the event name used in the hook configuration: **camelCase format** — Configure the event name in camelCase (for example, `sessionStart`). Fields use camelCase. **VS Code compatible format** — Configure the event name in PascalCase (for example, `SessionStart`). Fields use snake_case to match the VS Code Copilot extension format."*

- **camelCase**（`preToolUse`）：`{ sessionId, timestamp, cwd, toolName, toolArgs }`
- **VS Code compatible**（`PreToolUse`）：`{ hook_event_name, session_id, timestamp(ISO), cwd, tool_name, tool_input }`，且 `tool_input` 是 *"Tool arguments (parsed from JSON string when possible)"* —— **即使是 snake_case 格式，tool_input 也可能是 JSON 字符串，需要解析**。

### 1.2 真实运行时（本机 copilot-agent）实测载荷 — 第三种形态

本机会话日志（producer `copilot-agent`，copilotVersion 1.0.70-0 / 1.0.73，运行时自述 "Copilot CLI runtime in VS Code"）实际派发的 hook 载荷：

```
preToolUse  input: { sessionId, cwd, toolCalls: [ { id, name, args } ] }   # args = JSON 字符串
postToolUse input: { sessionId, timestamp, cwd, toolName, toolArgs, toolResult }
postToolUseFailure: { sessionId, timestamp, cwd, toolName, toolArgs, error }
errorOccurred:      { sessionId, timestamp, cwd, error, errorContext, recoverable }
sessionStart:       { sessionId, timestamp, cwd, source, initialPrompt }
sessionEnd:         { sessionId, timestamp, cwd, reason }
userPromptSubmitted:{ sessionId, timestamp, cwd, prompt }
userPromptTransformed:{ sessionId, timestamp, cwd, prompt, transformedPrompt }
agentStop:          { sessionId, timestamp, cwd, transcriptPath, stopReason, stop_hook_active }
```

实测样例（2026-07-23 会话，路径已脱敏）：
```json
{"type":"hook.start","data":{"hookInvocationId":"849b15fb-...","hookType":"preToolUse","input":{
  "sessionId":"0f64cd63-...","cwd":"<workspace-path>",
  "toolCalls":[{"id":"call_66dec08f...","name":"powershell","args":"{\"command\":\"cd <repo> && git log ...\",\"description\":\"List unpushed commits\"}"}]}}}
```

**结论**：本机运行时的 preToolUse 是 **`toolCalls` 数组**（一次可含多个工具调用），`args` 为 JSON 字符串——既不是官方 camelCase 单值 `toolName`/`toolArgs`，更不是 kix 假设的 snake_case `tool_name`/`tool_input`。kix ps1 读 `$hookInput.tool_name` → 恒为空 → `Test-KixSuspiciousExecutionTool -ToolName ''` 抛绑定错误 → 脚本继续 → `exit 0` → **静默放行**（实机复现见 §3）。

### 1.3 官方工具名表（hook matching 用）— kix 匹配的是旧扩展名

官方 "Tool names for hook matching"：

| 工具 | 说明 |
|---|---|
| `ask_user` | 向用户提问 |
| `bash` | 执行 shell（Unix） |
| `create` | 创建新文件 |
| `edit` | 修改文件内容 |
| `glob` | 按模式找文件 |
| `grep` | 搜索文件内容 |
| `powershell` | 执行 shell（Windows） |
| `task` | 运行子代理 |
| `view` | 读文件 |
| `web_fetch` | 抓取网页 |

本机会话日志实测工具清单（execution_start + preToolUse toolCalls）：`powershell x852, view x178, grep x102, web_fetch x34, edit x12, ask_user x8, read_powershell x6, glob x6, sql x4, skill x4, create x4`。

而 kix ps1（`blast-radius-check.ps1` / `kixpower-contract.ps1` / block-source-edit 系列）匹配的工具名：
- 终端：`run_in_terminal`、`create_and_run_task` ← **运行时无此名**（是 `powershell`/`bash`）
- 编辑：`apply_patch`、`replace_string_in_file`、`insert_edit_into_file`、`edit_notebook_file`、`create_file`、`create_directory`、`delete_file`、`vscode_renameSymbol` ← **运行时无此名**（是 `edit`/`create`）
- 只读/安全：`read`、`search`、`read_file`、`grep_search`、`semantic_search`、`file_search`、`list_dir`、`view_image`、`get_errors`、`manage_todo_list`、`vscode_askQuestions`、`run_notebook_cell` ← **与运行时名全部不同**

**这解释了"用户发现还是会少考虑一些基本情况"的根本机制**：即便 hook 触发、字段名也对，`toolLeaf` 也永远匹配不上 `run_in_terminal`，门禁分支全部不进入。

### 1.4 PascalCase 事件名会把工具名映射为 Claude 名（Claude-format matchers）

官方："Payloads for PascalCase PreToolUse report `tool_name` as the **Claude tool name** (for example, `Bash`, not `bash`)"。映射表：

| 运行时工具 | Claude 名 |
|---|---|
| `bash`, `powershell` | `Bash` |
| `view` | `Read` |
| `create` | `Write` |
| `edit`, `str_replace_editor`, `apply_patch` | `Edit` |
| `grep`, `rg` | `Grep` |
| `glob` | `Glob` |
| `web_fetch` | `WebFetch` |
| `web_search` | `WebSearch` |
| `ask_user` | `AskUserQuestion` |
| `update_todo` | `TodoWrite` |
| `task` | `Agent` |

且 matcher 语义：`*`/`**`/空 = 所有工具；字面名或 `A|B` 分隔 = 任一相等；其他 = 锚定正则 `^(?:PATTERN)$` 对 Claude 名测试。**kix ps1 在 PascalCase 配置下收到的 `tool_name` 会是 `Bash`/`Edit` 等 Claude 名**，与 kix 匹配的 `run_in_terminal`/`replace_string_in_file` 完全对不上。

### 1.5 preToolUse 输出契约 — kix 的嵌套格式可能不被识别

官方 preToolUse decision 输出（stdout JSON，**顶层**字段）：

```json
{ "permissionDecision": "allow"|"deny"|"ask",
  "permissionDecisionReason": "string",
  "modifiedArgs": { ... } }
```

- `permissionDecisionReason` 在 `deny` 时必填。
- cloud agent 下 `ask` 视为 `deny`。
- **`modifiedArgs`**：可替换工具参数——kix 从未探查/使用（可用于强制 `--force-with-lease` 等改写）。
- kix ps1 输出的是嵌套 `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": ... } }`（Claude/旧 agent-customization 格式）。VS Code 扩展侧的 agent-customization 文档用的是 `hookSpecificOutput` 包装；**CLI/cloud agent 官方参考是顶层**。两者并存意味着：在 CLI 运行时下嵌套格式可能被忽略 → deny 变放行。需按目标运行时选对输出形态（见 §5 修复建议）。

### 1.6 退出码语义 — kix memory 的"2=阻断、其他=警告"对 preToolUse 是错的

官方 "Exit codes for command hooks"：

| 退出码 | 含义 |
|---|---|
| `0` | 成功。stdout 解析为 hook 输出 JSON（若有） |
| `2` | 默认警告（stderr 提示，继续）。**但对 `permissionRequest` 和 `preToolUse` 是 deny**——即使 stdout JSON 报 `permissionDecision:"allow"` 也拒绝 |
| 其他非零 | 记录 hook 失败，默认 **fail-open**（继续）。**例外：preToolUse 是 fail-closed**——任何非零退出（除超时）都 deny："Denied by preToolUse hook (hook errored)" |
| 超时 | 杀掉。**所有事件一律 fail-open**（包括 preToolUse 与策略级 hooks）——慢 hook 不得静默拦工具 |

kix memory 写的是 "退出码：0 成功，2 阻断错误，其他=非阻断警告" —— **对 preToolUse/permissionRequest 语境下是错的**（exit 2 = deny；其他非零 = fail-closed deny；只有超时 fail-open）。更危险的是 kix hook 崩溃时 `exit 0` → **静默放行**，比 deny 更糟。

### 1.7 事件表不完整 — kix memory 只列了 Claude 风格事件名

官方完整事件（camelCase）：`sessionStart` / `sessionEnd` / `userPromptSubmitted` / `userPromptTransformed` / `preToolUse` / `postToolUse` / `postToolUseFailure` / `errorOccurred` / `agentStop` / `subagentStart` / `subagentStop` / `preCompact` / `permissionRequest`（CLI only）/ `notification`（CLI only）。

本机会话日志实际派发过：`postToolUse x1190, preToolUse x1002, errorOccurred x114, userPromptSubmitted x94, sessionEnd x76, agentStop x56, postToolUseFailure x20, sessionStart x20, userPromptTransformed x6`。

kix memory（vscode-copilot-customization.md）列的事件是 "SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PreCompact / SubagentStart / SubagentStop / Stop" —— **这是 Claude Code 的事件名**（PascalCase 且无 sessionEnd/errorOccurred/postToolUseFailure/userPromptTransformed/permissionRequest/notification）。kix 完全没探查：
- **`permissionRequest`**（CLI only）：在权限服务（规则引擎/审批/autoApprove/用户提问）**之前**触发，可 `behavior:"allow"|"deny"` 短路 —— 正是 kix"autoApprove 全开、只剩 hooks 一道闸"场景下**更早、更贴合权限层**的程序化闸门；kix 未用。
- **`subagentStart`/`subagentStop`**：子代理生成/完成时触发，支持 `matcher` 按 `agentName` 过滤；`subagentStop` 可 `decision:"block"` 强制续跑、`modifiedResponse` 改写子代理返回。**kix 的 validate-handoff 语义（交接校验）本可挂 subagentStop + agentName matcher**，而不是在 PreToolUse 里解析 runSubagent 参数。
- **`postToolUseFailure`**：exit 2 时 stdout 作为 additionalContext 附加到失败信息 —— 可替代 qa-freshness 类"失败后注入提醒"。

### 1.8 matcher 过滤机制 — kix 未使用

配置级 hooks 支持 `matcher` 正则（锚定 `^(?:PATTERN)$`）：
- `preToolUse`/`postToolUse`/`permissionRequest` → 匹配 `toolName`
- `subagentStart` → 匹配 `agentName`
- `preCompact` → 匹配 `trigger`（"manual"/"auto"）
- `notification` → 匹配 `notification_type`

kix 的 agent frontmatter hooks 无 matcher（memory 已记录 frontmatter 不支持），但 **config-file hooks（`.github/hooks/*.json`、`~/.copilot/hooks/*.json`、settings.json inline、plugins）都支持** —— 用 matcher 可让 blast-radius 只在 `powershell|bash|edit|create` 上触发，免去 ps1 内 toolName 早期返回的脆弱逻辑。

### 1.9 hooks 配置位置 — kix 只用了 frontmatter 一处

官方加载源（policy → user → project → plugins 依序合并，同事件全部执行）：
1. **Policy 级**：`C:\ProgramData\GitHub\Copilot\policy.d\*.json`（或 HKLM 注册表；管理员专属，disableAllHooks 不能关）
2. **仓库级**：`.github/hooks/*.json`
3. **用户级**：`~/.copilot/hooks/*.json`（`COPILOT_HOME` 时为 `$COPILOT_HOME/hooks/`）
4. **inline hooks**：`.github/copilot/settings.json` / `settings.local.json` 顶层 `hooks` 字段；**交叉读取 `.claude/settings.json`**（kix memory 已记录这点 ✓）
5. **用户级 inline**：`~/.copilot/settings.json` 顶层 `hooks`
6. **插件**：插件内 `hooks.json`（或 `hooks/hooks.json`）

kix 安装只挂 `.agent.md` frontmatter hooks（Chat 扩展面），未利用用户级 `~/.copilot/hooks/` 全局文件（跨仓库、跨 agent 生效，且支持 matcher + 双格式）。cloud agent 面仅 `.github/hooks/*.json`、仅 bash/command 生效。

### 1.10 postToolUse / agentStop / subagentStop 输出

- **postToolUse** 输出：`{ modifiedResult: { resultType:"success", textResultForLlm }, additionalContext }`；`additionalContext` 追加到 `textResultForLlm` 后，多 hook 结果双换行连接、上限 10KB。kix 的 auto-update-progress / qa-freshness 语义对应此通道（但用的是嵌套 hookSpecificOutput + 旧工具名）。
- **agentStop / subagentStop**：`{ decision:"block"|"allow", reason, modifiedResponse? }`；`block` 用 reason 作下一轮 prompt 强制续跑；**8 次连续 block 后运行时强行结束**（防死循环）；`stop_hook_active` 字段指示本轮已被 block 过一次。kix 未用。

---

## 2. 缺口矩阵（kix 现状 × 权威事实）

| 项 | kix 现状 | 权威/实测事实 | 影响 | 修复 |
|---|---|---|---|---|
| 输入字段名 | `tool_name`/`tool_input`（snake_case 单值） | 本机运行时 camelCase `toolCalls` 数组 / `toolName`+`toolArgs`（args 为 JSON 字符串）；官方文档记录 camelCase 与 snake_case 双格式 | **门禁静默失效**（实机 exit 0） | ps1 增加多格式解析（§5） |
| tool 参数形态 | `tool_input.command` / `tool_input.filePath` 直读 | `args`/`toolArgs` 是 **JSON 字符串**需 `ConvertFrom-Json`；`toolCalls` 是数组 | 命令文本取不到 → 判定为空 | 解析 args 字符串后再取 command |
| 终端工具名 | `run_in_terminal`/`create_and_run_task` | `powershell`/`bash` | 终端门禁全不触发 | 加 `powershell`/`bash`（并保留旧名兼容） |
| 编辑工具名 | `replace_string_in_file`/`apply_patch`/`insert_edit_into_file`/`create_file`/`delete_file` | `edit`/`create` | 控制平面/源码保护不触发 | 加 `edit`/`create` |
| 只读安全名单 | 旧扩展名（`read`/`grep_search`/`manage_todo_list`…） | `view`/`grep`/`glob`/`ask_user`/`task`/`web_fetch`/`web_search` | 未知工具正则可能误伤新名 | 名单按官方工具名表更新 |
| GitHub 工具名 | `mcp_github_*`（ps1）/ `mcp__github__*`（DSH） | 真实运行时 **`GitHub-*`**（`GitHub-create_or_update_file` 等） | GitHub 远程写保护 VS Code 侧从不触发 | ps1 加 `GitHub-*` 前缀匹配；DSH 侧 `mcp__github__*` 保留（DSH 自己的命名） |
| 工具名 Claude 映射 | 无 | PascalCase 配置下 `tool_name` 报 Claude 名（`Bash`/`Edit`/…） | 分类再次全空 | 增加 Claude 名 → 运行时名归一 |
| 输出格式 | 嵌套 `hookSpecificOutput` | CLI/cloud 参考为**顶层** `permissionDecision` | deny 可能被忽略 | 双格式输出（按目标运行时）或改顶层 |
| 退出码 | "2=阻断、其他=警告" | preToolUse/permissionRequest：**2=deny、其他非零=fail-closed deny、超时=fail-open** | 崩溃时 exit 0 放行（比 deny 更糟） | ps1 崩溃路径 fail-closed（exit 2 + deny JSON），不 exit 0 |
| 事件表 | Claude 名（无 sessionEnd/errorOccurred/postToolUseFailure/userPromptTransformed/permissionRequest/notification） | 官方 14 事件；本机实测 9 种 | 未用 permissionRequest（权限层短路）、subagentStop（交接校验）、postToolUseFailure | 按官方事件名补文档；按需接线 |
| matcher | frontmatter 不支持 | config-file 支持按 toolName/agentName/trigger/notification_type 锚定正则 | 无 matcher → 每次工具调用都起进程 + 全量判定 | 用户级 `~/.copilot/hooks/` + matcher |
| hooks 位置 | 仅 `.agent.md` frontmatter | 6 类来源（policy/repo/user/inline/交叉 .claude/plugins） | 全局门禁缺失（跨仓库） | 增加用户级 `~/.copilot/hooks/` 全局注册 |
| modifiedArgs | 未用 | preToolUse 可替换工具参数 | 少一个"改写而非拦截"的手段 | 可选增强（如 push 自动改 `--force-with-lease`） |
| subagent 事件 | validate-handoff 在 PreToolUse 解析 runSubagent | 官方 subagentStart/subagentStop + agentName matcher + block/modifiedResponse | 交接校验时机错、且工具名对不上 | 交接门禁改挂 subagentStop + matcher(agentName) |

---

## 3. 实机复现（2026-08-16）

对 `skills/kixpower/hooks/blast-radius-check.ps1` 用真实载荷喂入（`pwsh -NoProfile -File`）：

```
# 1) 真实 preToolUse 载荷（toolCalls 数组）：
echo '{"sessionId":"s1","cwd":"C:\\repo","toolCalls":[{"id":"c1","name":"powershell","args":"{\"command\":\"git push --force origin main\"}"}]}' | pwsh ... blast-radius-check.ps1
→ Test-KixSuspiciousExecutionTool: Cannot bind argument to parameter 'ToolName' because it is an empty string.
→ exit 0   ← 静默放行（git push --force origin main 通过！）

# 2) 真实 postToolUse 载荷（toolName/toolArgs）：
→ 同上，exit 0（edit 控制平面路径也放行）

# 3) kix 假设的旧格式（tool_name/tool_input）：
echo '{"tool_name":"run_in_terminal","tool_input":{"command":"git push --force origin main"},"hook_event_name":"PreToolUse"}' | ...
→ {"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"BLAST RADIUS: git push --force ..."}}
→ exit 2   ← 仅旧格式正确拦截
```

**结论**：kix 门禁在真实运行时上从未生效（字段名错 → tool_name 空 → 崩溃 → exit 0 放行）。用户"少考虑一些基本情况"的体感，根因是**门禁从根上没接到真实调用链**，而非个别正则漏网。

---

## 4. 对 DSH 插件的传导影响

- `dsh/preset/plugins/kix-guards.js`（v6）从 blast-radius ps1 移植，**判定逻辑本身（git/SQL/GitHub/gh/control-plane）在 DSH 侧是有效的**——DSH 的 `tools/pre-execute` 载荷（`exec.arguments` 对象，`args.command` 直读）与 ps1 假设的形态一致，v3 已修复字段名。
- **继承的失真主要在"工具面枚举"**：DSH 侧 `TERMINAL_TOOLS={pwsh,bash}`、`EDIT_TOOLS={write,edit}`、`KNOWN_SAFE_TOOLS` 是 DSH 自己的工具名（正确）；但 GitHub 门禁只认 `mcp__github__*`，若用户部署的 MCP 服务器命名不同（如 `GitHub-*` 风格或自定义 server 名），门禁静默失效——建议按"前缀 + 语义"双匹配。
- **缺 DSH 等价物**：DSH 无 `permissionRequest`（DSH 权限层在 sandbox/approval 栈，kix-guards 的 ask 已降级为聊天内提问 ✓）；无 subagent 交接钩子（`kix-orchestration` 在 pre-execute 拦 subagent 工具调用，可保留）；`tools/post-execute` 未接（DSH 有该事件，qa-freshness/auto-update-progress 语义可挂）。
- 结论：DSH 插件的主要缺口不是判定逻辑，而是 **VS Code 侧探查不全导致的"工具名/事件/输出契约"知识缺失**在本文件中补全后，DSH 侧只需按需对齐（工具名前缀兼容 + post-execute 可选接线）。

---

## 5. 修复清单（按优先级）

### P0 — 让 VS Code 侧门禁真实生效
1. **`blast-radius-check.ps1` 多格式载荷解析**：
   - 输入兼容三形态：① 官方 snake_case（`tool_name`/`tool_input`，tool_input 可能是 JSON 字符串）；② 官方 camelCase（`toolName`/`toolArgs`）；③ 真实运行时 `toolCalls` 数组（遍历每项 `name`/`args`，args 解 JSON 取 `command`）。
   - 工具名归一：运行时名（`powershell`/`bash`/`edit`/`create`/`view`/`grep`/`glob`/`ask_user`/`task`/`web_fetch`/`web_search`）+ Claude 名（`Bash`/`Edit`/`Write`/`Read`/`Grep`/`Glob`/`AskUserQuestion`/`TodoWrite`/`Agent`/`WebFetch`/`WebSearch`）+ 旧扩展名兼容。
   - GitHub 匹配加 `GitHub-*` 前缀。
2. **输出契约**：改为顶层 `{permissionDecision, permissionDecisionReason}`（CLI/cloud 面），保留 hookSpecificOutput 双写兼容（若目标运行时仍是 Chat 扩展面）。崩溃路径 fail-closed：异常 catch → 输出 deny + `exit 2`，绝不 exit 0。
3. **`kixpower-contract.ps1`**：`Get-KixTerminalCommand`/`Get-KixPathValues` 增加 `toolCalls` 数组 + args 字符串解析分支；`Test-KixSuspiciousExecutionTool` 安全名单按官方工具名表更新。

### P1 — 全局化 + 事件补全
4. 增加**用户级 hooks** `~/.copilot/hooks/kix-guards.json`（跨仓库全局生效）+ `matcher: "powershell|bash|edit|create"`（只在实际判定工具上触发），frontmatter 逐 agent 挂载降级为可选。
5. 交接门禁改挂 **`subagentStop` + `matcher(agentName)`**（kixpower-producer/dev/qa/reviewer），替代 PreToolUse 里解析 runSubagent 参数（后者工具名已不对）。
6. 可选接线 `postToolUseFailure`（exit 2 + additionalContext）承接 qa-freshness 提醒；`permissionRequest`（CLI）作为 autoApprove 前的程序化闸门。

### P2 — 文档同步
7. `memories/vscode-copilot-customization.md`：事件表改官方 camelCase 名 + 补全；退出码语义修正；工具名表更新；补双载荷格式说明。
8. `skills/kixparadigm/SKILL.md`「VS Code 机制对齐」节：hook 字段名小节改写为"双格式 + 真实运行时 toolCalls"；工具名表更新。
9. `dsh/preset/DSH-ADAPTATION.md` §2：补"VS Code 侧工具名/载荷差异"注记，说明 DSH 插件不继承 VS Code 侧失真、仅工具面枚举需按部署 MCP 命名对齐。

---

## 6. 证据索引

- 权威文档：[GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)（事件表 / 双载荷格式 / preToolUse decision / 退出码 / matcher / 工具名表 / hooks 位置 / postToolUse·agentStop·subagentStop 输出）
- 参考实现：[github/awesome-copilot `hooks/tool-guardian`](https://github.com/github/awesome-copilot/blob/main/hooks/tool-guardian/README.md)（camelCase `toolName`/`toolInput` 读取 + preToolUse 拦截，同 kix-guards 定位）；官方 hooks 目录文档 `docs/README.hooks.md`（事件：`sessionStart/sessionEnd/userPromptSubmitted/preToolUse/postToolUse/errorOccurred`）
- 调用链实测：本机 `~/.copilot/session-state/*/events.jsonl`（hook.start/hook.end 载荷、tool.execution_start/complete、subagent.selected/deselected、session.permissions_changed、skill.invoked）
- 本机配置：`%APPDATA%\Code\User\settings.json`（`chat.useCustomAgentHooks:true`、`chat.tools.global.autoApprove:true`）、`~/.copilot/agents/*.agent.md`（frontmatter hooks 现状）、`~/.vscode/agent-plugins/github.com/github/awesome-copilot/`
- kix 现状源：`skills/kixpower/hooks/*.ps1`、`skills/kixpower/scripts/kixpower-contract.ps1`、`memories/vscode-copilot-customization.md`、`skills/kixparadigm/SKILL.md`、`dsh/preset/plugins/kix-guards.js`、`dsh/preset/DSH-ADAPTATION.md`
