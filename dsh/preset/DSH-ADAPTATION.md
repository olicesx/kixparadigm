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
| PreToolUse hooks（拦截/放行） | `tools/pre-execute` 事件（waterfall） | 返回 allow/deny/ask；**实测可拦截工具调用**（deny 生效）。注册方式：`ctx.on('tools/pre-execute', ...)` 或 `tools.guard()` |
| PostToolUse hooks（后处理/阻断） | `tools/post-execute` 事件（waterfall） | accept/replace/enrich/block；**实测生效**。可替代 auto-update-progress 等 |
| 工具调用环绕（超时/重试/度量） | `tools/execute` 事件（waterfall） | around-dispatch |
| 工具结果观察 | `tools/result` 事件（emit） | 只读观察最终结果 |
| tools 白名单 | `tools.restrict()` / `tools.guard()` | per-scope allow/deny 过滤，比 Copilot `tools` 字段更精确（按 agent 挂不同门禁） |
| 文件写入拦截 | `fs/write-intent` / `fs/edit-intent` 事件 | 可替代 block-source-edit（拦截 write/edit 工具） |
| `chat.useCustomAgentHooks` | 无开关——监听器按 scope 挂载即生效（scope-filtered：agent-scoped 监听器只收到该 agent 的调用） | 天然支持"不同角色不同 hook"（producer 禁写源码、QA 禁写业务代码…） |

**hooks/*.ps1 的现状**：保留为参考实现 + 手动机械检查（经 `pwsh` 调用，输入 JSON 按 hook 文档构造）。要把它们变成自动拦截，用上面的事件监听器重写对应逻辑（JS 版）并挂到 preset 的 agent 层——这是"DSH 原生机械门禁"的正确形态。
autoApprove 全开 → 对应 DSH 权限预设（本部署 `danger-full-access`）；`ask_user_question` 仍是发布/合并/破坏性操作前的确认闸。

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
  | `subagent_zhipu` | zai-coding-cn → GLM-5.3（1M 窗口） | **跨厂商正交观察者**（三通道观察、最高置信 claim、平台/库语义断言） |
  | `subagent_vision` | zai-vision → GLM-4.6V（视觉，Coding Plan 订阅） | **识图补充**（主模型无视觉；图片路径 + 问题 → child 调 read_image 看图） |
  - 机制：`agentOptions.provider/model` 在 `resolveChildAgentOptions` 中覆盖父模型路由（已实证）；工具行级配置，模型按需选工具即实现"主模型自主选择子 agent 模型"。**「自动选择」的边界（2026-08-15 实证）**：子代理路由必须是精确 (provider, model) 对——`agentOptions` 省略 model 会继承父模型（deepseek-v4-flash → UNKNOWN_MODEL），DSH 无「auto」模型；工具行钉值 = settings.yaml `zai-coding-cn.models` 的当前最新可用模型（现为 glm-5.3），模型线升级时同步 settings 清单 + 钉值
  - 模型路由：`settings.yaml` 的 `llm-pi-ai:` 段配置多 provider profile（pi-ai 适配器内置 `zai-coding-cn`（智谱 GLM-5.3/5.2/5.1/5-turbo，1M 窗口）、`deepseek`、`kimi-coding`、`moonshotai`、`qwen-token-plan` 等目录路由；OpenAI 兼容网关可整体自声明）
  - 已激活 provider：`deepseek-official` + `zai-coding-cn` + `zai-vision`（自定义 profile：`api/coding/paas/v4` 订阅端点，models 列表声明 `glm-4.6v`/`glm-4.6v-flash`/`glm-4.5v`，均声明 image 输入）；`glm-5.3` 可解析（2026-08-15 起 profile 声明，1M 窗口；pi-ai 内置目录尚无该模型，reasoning 档位未声明则按非推理处理，需要档位时在 settings 该条目加 `reasoningEfforts`）、`glm-5.2` 可解析（reasoning: off/low/medium/high/max）；`glm-4.6v` 订阅内实测可用（2026-08-17 识图通过），`glm-5v-turbo` 当前订阅未开放（429 code 1311）
  - 再加其他厂商：`settings.yaml` `llm-pi-ai.providers` 追加 profile + 在 preset 加对应 subagent 工具行即可
  - **UI 发图无缝层（profile 插件 dsh-vision-bridge，2026-08-17 启用，不属于 preset）**：
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

**记忆（6 个，preset `memories/`）**：原 3 个 + **新增 2 个通用**：kix-review-patterns.md（审查方法论，私有项目 PR 实证）、tech-patterns.md（Windows/Unity/开发工具模式）+ **dsh-capability-map.md**（DSH 机制事实地图，kix×DSH 任务先查；2026-08-22 补入 preset）。
**不迁移**（领域专属，内部系统与运维记忆 5 个：机器配置 / 内部业务公式 / 数据库链路模式等，名字从略）。

## 7. 已知限制（诚实声明）

1. ~~跨厂商模型不可用~~ → **已启用**：`subagent_zhipu` 工具行（zai-coding-cn/GLM-5.3）已注册，主模型自主选择；新增厂商 = settings 加 profile + preset 加工具行（见 §3）
2. **hooks/*.ps1 不自动触发**——但 DSH 有完整等价机制，且 **preset 已内置 `plugins/kix-guards.js`（v4，2026-08-15 GitHub 只读工具误拦修复）**（`tools/pre-execute` 监听器，blast-radius 核心门禁的 JS 移植）：破坏性 SQL（含 UPDATE without WHERE）/ 终端数据库客户端保守拦截 / git 写保护（force push 完整检测 -f/+refs/--mirror，修复 v1 静默失效）/ main 分支保护（commit/push）+ commit 时真实分支检查 / **commit budget**（reflog 计数，hard cap 10 / progress.md 预算 / 冷启动 3）/ **MCP GitHub 远程写保护**（main/master deny、无 branch deny、mutation ask；v4 起只读 get_/list_/search_ 工具直接放行，mutation 按工具名精确匹配）/ **人类确认点 ask**（reset --hard/clean -f/branch -D/stash drop/checkout --/restore/普通 push → approval 服务）/ 控制平面保护 / 未知执行工具拦截 / run_code 代码体检查，单元回归 142 组断言通过（源仓库 `plugins/kix-guards.test.js`；v3 修复 3 漏拦 + 7 误伤反例全过，v4 +14 组 GitHub 只读/mutation 断言）。sandbox + approval 栈仍是常驻机械层
3. **slash command（/kixpower-*）已注册为 DSH 原生命令**（P1-8，2026-08-21）：`plugins/kix-commands.js` 注册 5 命令（kixpower-new/import/continue/review/kixpower），敲 `/` 见候选、触发后 handler 读 `prompts/*.prompt.md` 剥离 frontmatter 注入 user 消息（与 /plan 同语义，零 token）。「无 UI 注册」过期文案已于 2026-08-22 全量修复（persona §DSH 适配、kixpower/SKILL.md 适配注记），不再残留
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
  回归测试：`plugins/kix-guards.test.js`（17 用例，node 直接运行）。
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

## 10. 还债测试记录（2026-08-22，规则是负债）

**触发**：kix 范式 × DSH 插件思想融合度审计（自检）发现 persona「DSH 适配」节携带
大量机制细节，违反范式自身「常驻层只放认知、机制细节按需」的分层。

**动作**：persona「DSH 适配」节由全量机制手册压缩为**触发句 + § 指针**——每项机制
只保留「何时触发 + 用哪个工具」一句话，细节一律指向本文件对应章节：

| 压缩项 | 压缩前 | 压缩后 | 细节权威下落 |
|---|---|---|---|
| 工具名翻译 | 全表（10+ 映射） | 一句话 + §1 指针 | §1 全表 |
| 分派格式 | 完整翻译示例 | 一句话 + §3 指针 | §3 |
| 跨厂商模型 | 工具行/路由/权衡全述 | 触发句（subagent_zhipu） | §3 |
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
