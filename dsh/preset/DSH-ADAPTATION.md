# DSH 适配层 — kix 范式 × DeepSeek Harness

> 本文件是 kix 范式在 DeepSeek Harness（DSH）中的**权威机制映射**。kix 原始文档（skills/、agents/、prompts/、memories/）
> 保留 Copilot 语境作为知识源；凡本文件与原始文档冲突，**以本文件为准**。
> 为什么需要本文件：kix 从 VS Code Copilot 导入，其工具名、模型路由、机械门禁机制与 DSH 不同。

---

## 1. 工具名映射（VS Code → DSH）

模型在执行 kix 流程时，把文档中的 Copilot 工具名翻译为以下 DSH 工具：

| kix 文档中的名称 | DSH 实际工具 | 说明 |
|---|---|---|
| `run_in_terminal` / `get_terminal_output` | `pwsh` | 一次调用返回 stdout/stderr；后台任务用 `run_in_background: true` + `job_output`/`job_kill` |
| `read_file` | `read` | 支持 offset/limit 分页 |
| `grep_search` | `grep` | ripgrep 语法 |
| `replace_string_in_file` / `apply_patch` | `edit` | 字面替换，要求唯一匹配 |
| `create_file` / `create_or_update_file` | `write` | 全量覆盖 |
| `vscode_askQuestions` | `ask_user_question` | 人类确认点/需求三检 |
| `runSubagent` | `subagent`（后台）/ `subagent_fork`（继承会话） | **无 agentName 参数**：把对应 `agents/*.agent.md` 的角色 body 作为 prompt 注入（见 §3） |
| `explore_subagent` | `subagent` | 只读探索子代理（prompt 注明只读） |
| `manage_todo_list` | `todo_write` | 整表替换 |
| `fetch_webpage` / `mcp_context7_*` | `mcp__context7__resolve-library-id` + `mcp__context7__query-docs`；一般网页取证用 `web_search` | Context7 MCP 已注册（web profile，2026-08-15）；查库/框架实时文档优先用它（训练数据可能过期），普通网页仍走 `web_search` |
| `mcp_github_*` | `mcp__github__*`（MCP 已注册）；`gh` CLI（经 pwsh）兜底 | GitHub MCP 已注册（web profile，token 走 `GITHUB_TOKEN`）；CLI 仍是可用兜底 |
| `mcp_playwright_*` | `mcp__playwright__browser_*` | Playwright MCP 已注册（web profile，headless）；浏览器自动化用快照/截图，截图落盘后用 `subagent_vision` 读图 |
| `codegraphy_*` | `grep` / `read` | DSH 无 CodeGraphy MCP；依赖/影响面分析降级为 grep + 读文件 |
| `run_notebook_cell` | 无对应 | DSH 无 notebook 执行；用 pwsh 等价 |
| `run_code`（Copilot notebook 语境） | `run_code`（DSH Code Mode，见 §9） | 语义不同：Copilot 是 notebook cell 执行；DSH 的 `run_code` 是 TypeScript 程序化工具组合（SDK 子分派，both 呈现下与 native 直呼并存） |

**hooks/*.ps1 中的工具名是 hook 输入 schema 字段（`tool_name` 等），不要按上表翻译**——它们是 Copilot PreToolUse 输入格式，仅在手动调用 hook 时使用。

## 2. 机械门禁（Copilot hooks → DSH 原生 hook 机制）

**DSH 有完整的 hook 等价物**（已实测验证），比 Copilot 更结构化。kixpower 的 hooks/*.ps1 逻辑可**移植为 DSH 监听器**（需要时），而非只当手动脚本：

| Copilot 机制 | DSH 等价物（已实测） | 说明 |
|---|---|---|
| PreToolUse hooks（拦截/放行） | `tools/pre-execute` 事件（waterfall） | 返回 allow/deny；**实测可拦截工具调用**（deny 生效）。v1.2.11 起确认类门禁降为软约束，不再调用 `ctx.userQuestions.ask()`；硬 deny 仅保留可机械判定且不可逆的破坏操作。注册方式：`ctx.on('tools/pre-execute', ...)` 或 `tools.guard()` |
| PostToolUse hooks（后处理/阻断） | `tools/post-execute` 事件（waterfall） | accept/replace/enrich/block；**实测生效**。可替代 auto-update-progress 等 |
| 工具调用环绕（超时/重试/度量） | `tools/execute` 事件（waterfall） | around-dispatch |
| 工具结果观察 | `tools/result` 事件（emit） | 只读观察最终结果 |
| tools 白名单 | `tools.restrict()` / `tools.guard()` | per-scope allow/deny 过滤，比 Copilot `tools` 字段更精确（按 agent 挂不同门禁） |
| 文件写入拦截 | `fs/write-intent` / `fs/edit-intent` 事件 | 可替代 block-source-edit（拦截 write/edit 工具） |
| `chat.useCustomAgentHooks` | 无开关——监听器按 scope 挂载即生效（scope-filtered：agent-scoped 监听器只收到该 agent 的调用） | 天然支持"不同角色不同 hook"（producer 禁写源码、QA 禁写业务代码…） |

**hooks/*.ps1 的现状（2026-08-16 更新）**：9 个 Copilot hooks 中，
- ✅ **blast-radius-check.ps1** → `plugins/kix-guards.js`（pre-execute，5 大门禁/210 断言；v8 自审修复 + v9：发布/评论/普通 push 等确认类门禁降为软约束，不再提问）
- ✅ **validate-handoff.ps1**（核心通用部分：sprint marker/plan/progress/blocker/QA 完成度）→ `plugins/kix-orchestration.js`（pre-execute + subagent/end + producer_closeout + sleep 提醒，69 断言，v8 QA 完成声明负向语义防误报）
- ⚠️ **validate-handoff 深度部分**（worktree 登记 / plan_snapshot_sha / l2_gate_manifest_sha256 / stash 基线 / reverify marker）**不移植**——绑定 Copilot 的 runSubagent+agentName 分派格式，DSH 是 prompt 注入，过度移植 = 负债（见 PLUGINIZATION-ROADMAP.md §5 P2 决策）
- ⚠️ **block-source-edit / block-dev-authority-edit / block-source-edit-qa** → 角色边界，DSH subagent 无角色标记，保留为 prompt 硬约束（kix-guards v3 已决策不接）
- ❌ **validate-qa-signoff / qa-freshness / cleanup-qa-session / auto-update-progress** → DSH 无对应编排流程（L2 manifest/QA session 是 Copilot 特有），不移植
要把剩余 hooks 变成自动拦截，用 `tools/pre-execute`/`post-execute` 事件监听器重写对应逻辑（JS 版）并挂到 preset 的 agent 层——这是"DSH 原生机械门禁"的正确形态。
autoApprove 全开 → 对应 DSH 权限预设（本部署 `danger-full-access`）。v1.2.11：发布/评论/合并/破坏默认不做，用户明确指示即直接执行；`ask_user_question` 只用于真正缺失的决策信息。

**VS Code 侧机制差异（2026-08-16 审计，见 `kix-vscode-mechanism-audit.md`）**：本文件把 Copilot hooks 移植为 DSH 监听器，但 **VS Code 侧的 hook 载荷/工具名与 ps1 假设不同**——真实运行时（copilot-agent 1.0.70+）preToolUse 载荷是 `toolCalls:[{id,name,args}]`（args 为 JSON 字符串）、postToolUse 是 `toolName`/`toolArgs`；工具名是 `powershell`/`bash`/`edit`/`create`/`view`/`grep`/`glob`/`ask_user`/`task`/`web_fetch`，GitHub MCP 工具名为 `GitHub-*`。**DSH 侧不继承这些失真**（DSH 自己的 `exec.arguments` 对象 + `pwsh`/`bash` 工具名是另一套契约，kix-guards v3 已按 DSH 实测修正）；若部署的 MCP 服务器命名不是 `mcp__<server>__` 形态，可在 kix-guards 行 config 传 `githubToolPrefix` 对齐（v1.2.10 起可配置，默认 `mcp__github__`）。

**机制融合（2026-08-16，见 `DSH-FUSION-MATRIX.md`）**：VS Code 的有用机制在 DSH 里的**原生等价物**排查结论——`subagent/end`（返回侧校验，已落地 kix-orchestration v2）、`approval/request`（本部署 policy=never 下不派发 = 死代码，不接）、`agent/request-error`（无实例证据，观察候选）、`agent/pre-step`/`agent/session-start`（低优先）、`notification`/`preCompact`/`tools/result`（负债判定不接）。融合原则：先查 DSH 部署事实，不把 VS Code 机制列表照单全收。

**纪律 gate 插件（kix-discipline，2026-08-16 新增）**：需求三检/验证 gate 从 prompt 说教改为机制强制（见 `PLUGINIZATION-ROADMAP.md` P0）：
- `tools/pre-execute`：实现编辑（edit/write）前查需求三检契约（spec）在档；无 spec + 首次实现编辑 → `remind`（默认，放行+注入提醒一次）/ `ask`（聊天内提问）/ `block`（deny）。测试文件永远放行
- `kix_discipline_spec` 工具：模型记录契约（goal/xy/assumptions/path/acceptance 五字段，对应 kix 需求三检①XY ②前提 ③路径），写工作区 `kix-discipline/spec.md`（跨会话可查）
- `agent/turn-stopping`：回合结束有实现编辑但无测试运行 → 注入「交付前验证三问」提醒（remindOnce）
- `/kix-discipline` 命令：status/report/on|off
- 强度默认 `remind`（限制越少越好；字面明确低风险可逆任务可忽略提醒直接执行）；`ask`/`block` 需在 agent.cordis.yml 该行 config 显式配置
- 边界：按 agent scope 挂载，不覆盖子代理会话；与 kix-guards 同款（见 §9 已知限制①）

**极简+渐进披露插件（kix-focus，2026-08-16 新增，三层递进 P4）**：把模型每轮可见工具面从 ~85 个（~108KB schema，估算 ~30.8K token）裁到常驻核心集，量化 **-81.6%**（`scripts/quantify-focus.cjs` 可复跑）：
- **Phase 1 裁剪**：`tools.restrict({ allow })` —— allow 只列**全局工具**（RESTRICT_ALLOW ~11 个：edit/write/pwsh/read/grep/glob/ask_user_question/todo_write/skill/web_search）；subagent 五档与 kix_capability_* 是 **scope 注册工具，自动可见，不列入 allow**（DSH restrict 契约：scope-local 名列入会 fail）。MCP（GitHub/Playwright/Context7/Semgrep）、workflow/goal/ralph/job_*/cordis_* 按需。`tools/change` 事件重试（MCP 可能晚于插件注册）。restrict 只影响模型可见面，scope 工具与门禁插件不受影响
- **Phase 2 渐进披露**：`kix_capability_search`（用**全局视图** `schemas(undefined)` 列出被裁剪工具，返回分组元数据不含全 schema）+ `kix_capability_call`（`get(name, undefined)` 全局存在性检查 + 经 `ctx.tools.execute` 代理执行，走完整 pre-execute→guards→execute→post-execute 管线，门禁依然拦截；**传播 `rootCallId`**（嵌套执行树归属），带 agent 调用非 model-direct 不会被 UNKNOWN_TOOL 拒绝）
- **感知设计（2026-08-16 修订）**：**不挂 pre-execute deny**——restrict 已保证被裁剪工具对模型不可见（直呼=UNKNOWN_TOOL 到不了 pre-execute），且 capability_call 内部子调用必须放行（否则代理永远失败）；引导由 call 返回与 persona 触发句承担
- **Phase 3 PTC 协同**：保持 `tool-presentation mode: both`；kix 红线「验证/观察用 native 直呼（证据可回放）」不变；capability_call 亦可被 run_code SDK 子分派调用（子分派过门禁）
- 配置：`enableRestrict: false` 关闭裁剪（仅保留 search/call）；`extraResidentTools` 追加常驻
- 与 kix-guards 交互：capability_call/search 已入 KNOWN_SAFE_TOOLS 白名单（防未来正则误伤）；被代理工具的每次子调用仍过 kix-guards 门禁

## 3. 团队编排（runSubagent agentName → DSH subagent + prompt 注入）

kix 的分派格式 `runSubagent agentName: "kixpower-producer"` 在 DSH 中翻译为：

```
subagent（run_in_background 按需）:
  prompt: <agents/kixpower-producer.agent.md 的角色 body> + [CONTEXT]/[TASK]/[CONSTRAINTS] 任务段
```

- 角色 body 从 preset 的 `agents/*.agent.md` 读取（它们是子代理 prompt 模板，不是 DSH 注册的 agent）
- `kixpower-reviewer` 是只读审查角色：prompt 中注入其硬约束（只读、不调 agent、输出结构化 YAML）
- **跨厂商验证的 DSH 现状（已启用）**：preset 注册了三个子代理工具行，主模型**自主选择**：
  | 工具 | LLM 路由 | 用途 |
  |---|---|---|
  | `subagent` | 继承主模型（deepseek-official） | 普通分派 / 同厂商观察 |
  | `subagent_cross` | `kix-route:cross` 哨兵 → 运行时自动取反厂商（父 GLM→deepseek 系 / 父 DeepSeek→zai 系） | **跨厂商正交观察者**（三通道观察、最高置信 claim、平台/库语义断言） |
  | `subagent_vision` | `kix-route:vision` 哨兵 → 运行时自动路由到首个声明 image 输入的模型（zai-vision 偏好） | **识图补充**（主模型无视觉；图片路径 + 问题 → child 调 read_image 看图；无 image 模型时启动报错） |
  - 机制：`agentOptions.provider/model` 在 `resolveChildAgentOptions` 中覆盖父模型路由（已实证）；工具行级配置，模型按需选工具即实现"主模型自主选择子 agent 模型"。**「自动选择」的落点（v5.9 起 kix-route 自动路由）**：cross/vision/thinker 工具行只钉 `kix-route:<tier>` 哨兵模型名，`plugins/kix-route.js` 在子代理首次请求的 agent/request waterfall 里按 llm 实时目录解析——cross = 父厂商取反、vision = 首个声明 image 输入的模型、thinker = deepseek 系首选。**边界语义（v5.9.1，角色核心能力缺失报错 / 角色仍成立降级）**：cross 在单厂商部署（无任何异厂商 provider）、vision 在全目录无 image 模型时**启动即报错**——错误信息附已注册清单与改用建议（subagent 同厂商复核 + 注明局限 / 配置对应 provider），随 run 失败带回父模型，绝不静默同厂商降级（假独立性比失败更糟）；thinker 无 deepseek 时降级环境默认路由（大预算深思考角色仍成立）+ 一次性告警；解析失败不缓存（中途注册的 provider 下一请求生效）；插件缺失时哨兵直达适配器响亮失败（UNKNOWN_MODEL）。此前「必须钉精确对」是声明层约束（agentOptions 自定义键会被 zod 剥离），waterfall 层可整体改写（kix-cost lite 回退同机制已实证）。候选池 = settings.yaml `llm-pi-ai:` 清单 + pi-ai 内置目录；模型线升级只改 settings
  - 模型路由：`settings.yaml` 的 `llm-pi-ai:` 段配置多 provider profile（pi-ai 适配器内置 `zai-coding-cn`（智谱 GLM-5.3/5.2/5.1/5-turbo，1M 窗口）、`deepseek`、`kimi-coding`、`moonshotai`、`qwen-token-plan` 等目录路由；OpenAI 兼容网关可整体自声明）
  - 已激活 provider：`deepseek-official` + `zai-coding-cn` + `zai-vision`（自定义 profile：`api/coding/paas/v4` 订阅端点，models 列表声明 `glm-4.6v`/`glm-4.6v-flash`/`glm-4.5v`，均声明 image 输入）；`glm-5.3` 可解析（2026-08-15 起 profile 声明，1M 窗口；pi-ai 内置目录尚无该模型，reasoning 档位未声明则按非推理处理，需要档位时在 settings 该条目加 `reasoningEfforts`）、`glm-5.2` 可解析（reasoning: off/low/medium/high/max）；`glm-4.6v` 订阅内实测可用（2026-08-15 识图通过），`glm-5v-turbo` 当前订阅未开放（429 code 1311）
  - 再加其他厂商：`settings.yaml` `llm-pi-ai.providers` 追加 profile + 在 preset 加对应 subagent 工具行即可
  - **UI 发图无缝层（profile 插件 dsh-vision-bridge，2026-08-15 启用，不属于 preset）**：
    `~/.dsh/profiles/web/cordis.patch.yml` insert；源码 `~/.dsh/profiles/web/plugins/dsh-vision-bridge/`
    （**2026-08 加固后 junction 直指该源码，整链收进 DSH_HOME，不再依赖 npm 全局目录**；
    全局副本 `%APPDATA%\npm\node_modules\dsh-vision-bridge\` 降级为冗余备份）。
    服务端注册 `POST /api/dsh-vision-bridge/describe`（`inject: ['webServer']` 注入 host 服务，
    patch 层 `ctx.get` 拿不到 webServer，必须 inject）。**v2 提交时转换模式**：client 注册
    `conversation.input.dock` slot（id `vision-bridge`），**包装 `props.inputActions.submit`**
    （SessionInputShell 的 action face，monkey-patch 一次，`__visionWrapped` 防重复）——
    粘贴图片不动作，点发送时先调 describe 再提交：描述写入 draft（`setDraft`）＋图片移除
    （`removeImage`，hero 模式无 session.id，必须用 inputActions 而非
    `conversation.input.shell(session.id)`）→ 描述以 `📷 [图片自动识别]` 前缀进入会话；
    转换失败/超时（100s）提示且不提交，图片保留可重试。模式 keep（模型支持图片）原样提交。
    模型侧：persona 已声明该前缀为插件自动产物，直接基于描述回答；细节不足时请用户
    给图片路径用 `subagent_vision` 细看。重装 preset 不影响本插件（profile 层）。
    **2026-08 加固（实测）**：① exports 补 `./package.json` 声明——缺失时 client-modules
    注册表 `require.resolve('<name>/package.json')` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，
    客户端半永远不进 `__DSH_BOOT__`（实测根因）；② junction 改指 profile 内源码；③ 自检自愈
    `kix-bundle/scripts/ensure-vision-bridge.ps1` + `verify-vision-bridge-resolution.cjs`；
    ④ 文件修复后**必须重启 dsh web** 客户端半才注册；重启后 `client.js` 另补
    `exports.inject = ['slots']`（v1 原文件未声明即用 `ctx.slots`，浏览器端启动风险）。
    **⑤ v2 已实现部署（2026-08，用户确认）**：`client.js` 重写为提交时转换——包装
    `inputActions.submit`（`__visionWrapped`/`stateRef`/无 session.id），describe 后
    描述入 draft + chips 移除再提交；keep 原样；失败/超时提示不提交；>8MB 快速失败。
    client 变更经 no-cache 直出，刷新页面即生效。**双路径 E2E 实测通过**（会话视图 +
    hero 新界面，describe 200 ×2，消息带 `📷 [图片自动识别]` 前缀进入会话、模型正常回复）。
    边界：Enter 走 ComposerKeyboard 不触发；旧页面报"不支持图片"= 页面早于修复加载，
    硬刷新（Ctrl+F5）即恢复。
  - 零配置基线：**异质 prompt 视角**（不同角色/不同关注维度）始终可用

### §3.1 子代理结果回传通道（2026-08-17 WSL2 实测固化）

后台（continuable）子代理有两条回传通道，机制事实来自 dsh-subagent 源码（`notifySettlement`/`deliverReport`）+ dae 审查会话实测：

| 通道 | 触发方 | 语义 | 成本 |
|---|---|---|---|
| `report` 工具 | 子代理运行中主动调 | 只入父级**后续**回合（不结束子代理回合、不改变生命周期）；运行中中继 | 每调一条注入 |
| 结算通知 `subagent-settled` | 运行时（Activation 结算） | **无条件**投递：end_turn / token 上限 / 模型失败 / 取消 / 拆卸都通知；带终止原因 + 最终 assistant 消息全文 | 每子代理恰好一条 |

- **唤醒机制**：父级 idle → `followup` 自动开新回合；运行中 → `steer` 注入当前回合。⇒ 父级**收回合等待零丢失风险**（实测：主回合结束后 report/settled 各自唤醒短回合完成整合）。
- **双通道冗余（实测坑）**：子代理「`report` 全文 + 最终消息再放全文」→ 父级为同一结果付两次注入 + 两次唤醒回合。dsh-subagent README 明文 *"A child that both reports and settles costs the parent both"*。范式约定（persona 已载）：**单通道交付**——默认最终消息即完整报告，勿再 `report` 同文。
- **sleep 等待反模式（实测坑）**：8 次 `sleep 45~240s` 占住回合等子代理 = 纯浪费延迟（sleep 步思考≈0 但回合被钉住）。正确形态：独立工作做完 → 简短状态 → 结束回合等唤醒。kix-orchestration v4 对「bash 裸 sleep + description 提及 subagent/子代理」做一次性机械提醒（0% 误报纪律：测试退避/等锁的 sleep 不命中）。

### §3.2 编曲模型与成员菜单（2026-08-17，四轮碰撞收敛）

CEO「挑成员」在 DSH 的最终落点：**主模型 = 编曲者，成员 = activatable 档**。固定 producer→dev→qa 流水线是 kixpower sprint 工作流约定（重路径），不是范式不变量——S7（CEO 直做）/S8/S9（只借 dev）已实践自由组合并验证；本节把它显式化（规则是负债：拆掉一条没人遵守的固定规则是还债）。

| 成员档 | 人名句柄 | 契约（蒸馏自 agents/*.agent.md，单一权威仍在文件） | 激活 |
|---|---|---|---|
| `subagent_dev` | Nova/Sage/Milo 三合一 | 按 plan 编码、target_rules 内写、不越权、不替 QA 签署；每任务自跑 deterministic gate | `kix_tool_activate { tool: subagent_dev }` |
| `subagent_qa` | Ivy | 不写业务源码、证据门禁、signoff 工件（PASS/CONDITIONAL/FAIL/REVERIFY_REQUIRED 证据绑定） | `kix_tool_activate { tool: subagent_qa }` |
| `subagent_reviewer` | 无名 | 只读 + 反方辩护三层（L1 反驳预演 / L2 深度下钻 / L3 语言模型压测）+ rebuttal 输出 | `kix_tool_activate { tool: subagent_reviewer }` |

**三项不建行决策**：producer 不建行（S7 已证 CEO 自规划通常够；真需要 Remy 级规划，主线程读一次 `agents/kixpower-producer.agent.md`）；orchestrator 不建行（协调留在主线程——DSH 主 agent 有全套编排工具，物化协调子代理 = 雇个协调员协调自己；636 行 orchestrator.agent.md 是 Copilot 时代残留，不建行不蒸馏）；dev 三人合一档（Nova/Sage/Milo 内部切换本就发生在同一 agent body）。

**四条不变量地板**（自由组合不侵蚀，见 persona「编曲模型」节）：① 观察独立性（二相性）——组合的是"手"，"眼"不能自证；② 协调留在主线程；③ 视角来自 prompt 不做角色化——人名是契约句柄不是人设，轻路径观察位仍用无名视角 prompt（双层菜单）；④ 门禁地板与组合无关（发布/合并/破坏性仍走人类确认，kix-guards/kix-discipline 照常，团队产出仍是 claim）。

**漂移解药（不加新门禁）**：组合决策说出来（本单用了谁、为什么）+ `kix_discipline_spec` mode 字段留痕（成员组合 + 一句理由，2026-08-17 新增，可选字段）+ 「规则是负债」回收纪律观测组合分布（过度组合 / 默认独奏均回收）。中途组合错位 → 重路由一次并说出来。

## 4. DSH 原生特性利用（范式增强点）

kix 的原始编排假设只有 runSubagent；DSH 提供更结构化的原生能力，范式应优先使用：

| DSH 原生能力 | kix 对应需求 | 用法 |
|---|---|---|
| `workflow`（多阶段多子代理编排） | kixpower Producer→Dev→QA 全流程 | 每个阶段 = workflow phase；多任务并行 = `pipeline`/`parallel`；适合完整 Sprint 编排 |
| `goal`（持久同会话目标 + 自动续跑） | Sprint 目标 / 长任务 | `create_goal` 持久化目标，跨轮自动推进 |
| `plan mode`（只规划不执行） | 写码前决策链 / 需求三检后的规划 | 需要先规划再实现时进入 plan mode |
| `job`（后台任务） | 长测试/构建 | `pwsh run_in_background: true` + `job_output` |
| `ralph`（fresh-agent 迭代） | 还债测试 / 零基重写 | 用户明确要求时使用 |
| `subagent_fork`（继承会话） | 需要上文连续性的子代理 | 比 spawn 更省上下文 |
| `todo_write` | 多任务跟踪 | 每任务一行 |
| `ask_user_question` | 发布确认点 | 发布/合并/破坏性操作前必用 |

## 5. 模型上下文窗口（Copilot 语境 → DSH）

- kix 的"窗口 × 百分比"阈值（safe 60% / watch 75% / danger 88%）保留为**原则**；DSH 的实际测量是上下文 token 计（compaction 自动触发，阈值由 harness 管理）
- `PROJECT_BRIEF.md` 的 `model_context_window` frontmatter 可保留（作为团队约定），但**以 DSH 实际上下文为准**
- "不读 transcript/*.jsonl" 纪律在 DSH 同样适用（会话日志在 `$DSH_HOME/sessions/`）

## 6. 记忆与技能迁移（来自 VS Code Copilot 配置，2026-08-14 扫描）

从 `~/.copilot/` 与 Copilot memory-tool 完整扫描后迁移：

**技能（17 个，preset `skills/`）**：kixparadigm / kixpower / handoff / write-a-skill / improve-codebase-architecture（原 5 个）+ **新增 12 个通用方法论**：tdd / teach / grill-me / grill-with-docs / diagnose / prototype / triage / to-issues / to-prd / zoom-out / migrate-to-shoehorn / caveman。
**不迁移**（领域/项目专属，遵循"规则是负债"）：rpgmaker-mv-debug-menu / unity-bepinex-debug-menu / unity-il2cpp-debug-menu / scaffold-exercises / setup-matt-pocock-skills / setup-pre-commit / git-guardrails（Copilot hooks 设定，已被 kix-guards 替代）。

**记忆（4 个，preset `memories/`）**：ai-agent-practices.md（跨项目实践）、ai-test-pruning.md（测试缩减方法论）、kix-review-patterns.md（审查方法论，私有项目 PR 实证）+ **dsh-capability-map.md**（DSH 机制事实地图，kix×DSH 任务先查；2026-08-15 补入 preset）。Copilot 语境记忆（vscode-copilot-customization / tech-patterns / kixpower-v39-legacy-notes）已移出 preset（2026-08-17，规则是负债），保留在根 `memories/` 供 Copilot 分发版。
**不迁移**（领域专属，内部系统与运维记忆 5 个：机器配置 / 内部业务公式 / 数据库链路模式等，名字从略）。

### §6.1 迁移完整性审计（2026-08-16，用户"迁移是否失真"质疑驱动）

对 `~/.copilot/`（VS Code Copilot 原始配置）、`%APPDATA%\Code\User\prompts\`、`~/.claude/` 与 `dsh/preset/` 做全量对比：

| 层面 | 对比方法 | 结论 |
|---|---|---|
| agents（6 角色） | 内容级 diff（去空白 + 中文词） | ✅ **DSH 是超集**（orchestrator 等均 0 独有词；DSH 追加了适配注记） |
| skills（23 vs 17） | 目录对比 | ⚠️ 7 个未迁移，其中 6 个领域专属（Unity/RPGMaker/脚手架），`git-guardrails` 已被 kix-guards 替代（见上） |
| kixparadigm SKILL.md | 章节对比（含 84KB .bak-20260804 旧版） | ✅ DSH 是超集（bak 独有词为措辞差异；DSH 还多「实践回收」子节） |
| kixpower 脚本/tests/templates | 目录对比 | ✅ 完全一致（templates DSH 还多 `kixpower-workflow.template.md`） |
| prompts（5 个） | 大小 + 内容 diff（VS Code 用户级目录） | ✅ DSH 是超集（4 个 0 独有词；review 独有 2 通用词非机制） |
| instructions | 大小对比 | ✅ 一致（DSH 8,017B vs Copilot 7,604B，差异为适配注记） |
| hooks 自动化（9 个） | 功能映射 | ❌→✅ **真实失真已补**：blast-radius→kix-guards；validate-handoff 核心→kix-orchestration（2026-08-16）；其余按 kix 哲学决策不移植（见 §2） |
| `~/.claude/` | 目录扫描 | 无 kix 资产（skills 为空 learned 目录；homunculus 空） |

**结论**：文件层面迁移完整（DSH 是超集）；唯一的真实失真是 **hooks 自动化的丢失**——Copilot 侧 9 个 PreToolUse/PostToolUse hooks 自动触发，迁移后 8 个变"仅 prompt 约束"。已由 `kix-orchestration` 插件补上核心通用部分（见 §2 hooks 现状），其余为 Copilot 特有流程（worktree/SHA/manifest 深度校验）或角色边界（prompt 硬约束），按"规则是负债"有意不移植。

## 7. 已知限制（诚实声明）

1. ~~跨厂商模型不可用~~ → **已启用**：`subagent_cross` 工具行（zai-coding-cn/GLM-5.3）已注册，主模型自主选择；新增厂商 = settings 加 profile + preset 加工具行（见 §3）
2. **hooks/*.ps1 不自动触发**——但 DSH 有完整等价机制，且 **preset 已内置 `plugins/kix-guards.js`（v9，v1.2.11；确认类门禁降为软约束）**（`tools/pre-execute` 监听器，blast-radius 核心门禁的 JS 移植）：破坏性 SQL（语句级；终端 DB 客户端按命令位 + SQL payload 判定，`SELECT 'DROP'` 字符串不误拦）/ git 写保护（force push 完整检测 -f/+refs/--mirror，修复 v1 静默失效）/ main 分支保护（commit/push）+ commit 时真实分支检查 / **commit budget**（v7：reflog %gs 口径只数 commit 类条目——reset/merge/pull/checkout/rebase 不计、amend 只进 hard cap 口径；hard cap 10 / progress.md → plan.md task_sizing → plan.md max_commits 兜底链 / 冷启动 3 必 warn；marker 指向已完结 sprint 时回退最大编号并在 deny 消息标注）/ **MCP GitHub 远程写保护**（main/master deny、无 branch deny；mutation 为软约束，v9 起直接放行，是否发布/评论由 persona 与 review 流程判断）/ **发布/评论软约束（v9）**：reset --hard/clean -f/branch -D/stash drop/checkout --/restore/普通 push/GitHub mutation 默认不做，用户明确指示即直接执行，不再逐次提问；ask_user_question 只用于真正缺失的决策信息/ 控制平面保护（v8 只拦明确写意图，grep/cat/ls 只读放行）/ 未知执行工具拦截 / run_code 代码体检查，单元回归 **210 组断言通过**（v9：确认类操作软约束回归；v7/v8 回归保留）。sandbox 栈仍是常驻机械层
3. **slash command（/kixpower-*）已注册为 DSH 原生命令**（P1-8，2026-08-15）：`plugins/kix-commands.js` 注册 5 命令（kixpower-new/import/continue/review/kixpower），敲 `/` 见候选、触发后 handler 读 `prompts/*.prompt.md` 剥离 frontmatter 注入 user 消息（与 /plan 同语义，零 token）。「无 UI 注册」过期文案已于 2026-08-15 全量修复（persona §DSH 适配、kixpower/SKILL.md 适配注记），不再残留
4. **CodeGraphy / GitHub MCP 无对应**——降级 grep/read + gh CLI
5. **memory 不自动注入**——按需读取

## 8. 决策树：什么时候用哪个编排

```
简单任务（字面明确/低风险/可逆）  → 三通道自编排直接做（subagent 并发观察）
中等任务（多文件/有副作用）       → 三通道 + ask_user_question 确认点
复杂任务（跨模块/大改动/全流程）  → CEO 团队编排：
   ├─ 单会话内分派：subagent（producer→dev→qa 串行，观察并发）
   ├─ 结构化多阶段：workflow（phases/pipeline/parallel）
   └─ 长目标自动推进：goal（create_goal + 续跑）
发布/合并/破坏性操作             → ask_user_question 确认（机械门禁由 sandbox 承担）
```

## 9. PTC / Code Mode 融入（2026-08 决策，ADR 性质）

**决策**：kixparadigm 预设启用 `tool-presentation: mode: both`——native 工具 schema 与
Code Mode SDK（`run_code` + 生成式 `tools.*` TypeScript 绑定）并存，模型自主选择形态。

**为什么是 `both` 而不是 `code`（纯 PTC）**：

| 维度 | `code`（纯 PTC） | `both`（已采用） |
|---|---|---|
| 工具直呼 | 只有 `run_code` 可直呼，其余在 pre-execute 前解析为 `UNKNOWN_TOOL` | native schema 照常可执行 |
| 三通道"观察" | 中间值不可重建、仅 print/return 回流 → 验证证据链退化 | 验证/单步用 native，证据可回放、门禁逐条可见 |
| 门禁 | SDK 子分派走完整管线（拦截有效），但模型直呼路径提前塌缩 | 两条路径都走完整管线 |
| 适用面 | 只适合机械化执行器 | 模型自主：简单/验证→native，批量/多步→run_code |

**形态选择规则（persona 已内置，最小规则）**：
- 用 `run_code`：机械多步序列（读→查→汇总）、批处理式改动（改 N 个文件）、
  并发只读探测（`Promise.all`）、需 try/catch 容错的流程——一次程序省 N 轮往返。
- 保持 native 直呼：单步操作、验证/观察动作（证据需可回放）、需审批的破坏性操作。
- **红线**：`run_code` 中间值只存在于执行局部、每次运行状态全新、仅 print/return 回流——
  需要证据链的动作（三通道"观察"）不得压进程序只吐摘要。

**配套改动**：
- `plugins/kix-guards.js`：`run_code` 加入 `KNOWN_SAFE_TOOLS`（否则被"未知执行工具"
  门禁 deny；程序内每个子分派仍逐个过 pre-execute）。
- **2026-08-15 P0 修复（实证驱动）**：三通道实测发现 kix-guards 全部文本门禁
  静默失效——DSH pre-execute 派发的 exec 参数在 `exec.arguments` 字段
  （dsh-tools `createExecution` 构造 `{...base, arguments}`），原代码读
  `exec.args` 恒为 undefined。已修复 + 新增 run_code 代码体受限能力检查
  （deny `import(node:)`/`child_process`/`fetch(`/`WebSocket(`/`process.`）：
  run_code 是通用 Node 运行时（实测 fetch/process/动态 import 可用），
  `tools.*` 是自愿通道，代码体可零痕迹绕过子分派门禁，内容检查闭合此洞。
  回归测试：`plugins/kix-guards.test.js`（210 组断言，node 直接运行）。
- **已知限制（2026-08-15 声明）**：① kix-guards 按 agent scope 挂载，**不覆盖
  子代理会话**（三通道观察者/团队子代理无此机械层，sandbox 是其唯一边界）；
  ② 程序内子分派命中 approval `ask` 的语义未定义（fail-safe 建议：视为结构化
  拒绝，提示走 native 审批路径）；③ "子分派逐个过 pre-execute"断言已由
  单元测试覆盖决策逻辑，但端到端挂载验证需新会话（本会话不重读插件）。
- 运行时前提：web-app bundle 已组装 `dsh-code-runtime-worker-thread`（`code-runtime` 行），
  code 模式挂载不会失败；未组装运行时的部署会在挂载时指名 `tool-presentation` 拒绝。
- 生效范围：**仅对新会话生效**（preset 组装在 agent 发布时安装，运行中不重读）；
  已运行会话保持开始时的呈现。验证方法：新建会话，工具目录出现 `run_code` 且
  直接调用 read/edit 等仍可执行（both 语义），即挂载成功。

## 10. 还债测试记录（2026-08-15，规则是负债）

**触发**：kix 范式 × DSH 插件思想融合度审计（自检）发现 persona「DSH 适配」节携带
大量机制细节，违反范式自身「常驻层只放认知、机制细节按需」的分层。

**动作**：persona「DSH 适配」节由全量机制手册压缩为**触发句 + § 指针**——每项机制
只保留「何时触发 + 用哪个工具」一句话，细节一律指向本文件对应章节：

| 压缩项 | 压缩前 | 压缩后 | 细节权威下落 |
|---|---|---|---|
| 工具名翻译 | 全表（10+ 映射） | 一句话 + §1 指针 | §1 全表 |
| 分派格式 | 完整翻译示例 | 一句话 + §3 指针 | §3 |
| 跨厂商模型 | 工具行/路由/权衡全述 | 触发句（subagent_cross） | §3 |
| 识图 | 端点/备选模型/门禁全述 | 触发句（subagent_vision） | §3 |
| UI 发图 | 插件机制/前缀语义全述 | 触发句（📷 前缀 + 细看路径） | §3 |
| 机械门禁 | hook 等价物清单 | 触发句（kix-guards 已挂载） | §2 |
| PTC | 形态 + 4 条纪律全述 | 红线 3 条（native 验证/print/不吞 deny） | §9 |

**保留常驻的理由**（不降为按需）：触发句全是「决策路由」——模型在每轮任务开始时
需要知道「有视觉子代理可用、有跨厂商观察者可用、验证动作必须 native」；这些是
kix 三通道/盲点补足在 DSH 上的行为红线，不是操作手册。

**同批修复的漂移**（双源不一致）：
- persona「slash command 无 UI 注册」→ 已注册（P1-8 落地后未同步）
- `skills/kixpower/SKILL.md` 适配注记「无 UI 注册」→ 已注册
- `skills/kixparadigm/SKILL.md`「位于 VS Code 用户 prompts 目录（VSCODE_USER_PROMPTS_FOLDER）」
  → 本 preset `prompts/` 目录
- 方法论记忆计数 5 → 6（补入 `memories/dsh-capability-map.md`）
- `kix-commands.js` 头部注释「对照…现状」→ 标注 P1-8 落地前

**归一（bundle ↔ preset 单一事实源）**：本 preset 内容回灌为
`kix-bundle/dsh/preset/`（DSH 唯一事实源），`scripts/sync-dsh-preset.ps1` 单向同步到
`~/.dsh/.agent-presets/kixparadigm/`；补入此前缺失的 `kixpower-workflow.template.md`
（P2-10 验证 gate 模板）与 `kix-commands.test.js`。根目录 Copilot 分发版与
`dsh/preset/` DSH 版刻意分离，互不覆盖（见 `dsh/README-DSH.md`）。
