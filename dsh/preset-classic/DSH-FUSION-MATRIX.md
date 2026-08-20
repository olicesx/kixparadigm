# DSH × VS Code 机制对比矩阵 — 排查 DSH 遗漏的 VS Code 有用等效机制（2026-08-16）

> **定位**：不是把 VS Code hook 语义搬进 DSH（机械迁移），而是**两边对比**，找出「VS Code 实际非常有用的机制」在 DSH 里的**原生等价物**，再按 kix 哲学（规则是负债 / 0% 误报 / 分层 / 限制越少越好 / 补足非限制）决定是否融合。
> **方法**：DSH 侧事实来自本机安装包源码 + `cordis_inspect_query` 事件目录（`tools/*`、`agent/*`、`subagent/*`、`approval/request`、`fs/*-intent`）；VS Code 侧事实来自 [官方 hooks-reference](https://docs.github.com/en/copilot/reference/hooks-reference)（2026-08 抓取）与本机 copilot-agent 会话日志。
> **触发**：用户反馈「DSH 同款插件还是少考虑一些基本情况」。上一轮审计（kix-vscode-mechanism-audit.md）证明 VS Code 侧载荷失真；本轮回答「DSH 自己有哪些原生能力没用上」。

---

## 0. 结论先行

DSH 的事件面比 VS Code hooks 更完整、更结构化。**kix 插件目前只接了 5 类事件**（`tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping`、`agent/request`、`tools/change`），而 VS Code 里**被验证非常有用**的等效机制，DSH 原生有 6 个等价事件 **kix 一个都没接**：

| # | VS Code 有用机制 | DSH 原生等价（已查证契约） | kix 现状 | 融合判定 |
|---|---|---|---|---|
| 1 | `permissionRequest`（CLI only：权限服务前程序化 allow/deny 短路） | **`approval/request`** waterfall（`ApprovalOutcome`；可短路默认审批流） | ❌ 未接 | ⛔ **不接（机制事实：本部署死代码）**——`dsh-user-approval/lib/index.js` `decide()` 在 `effectivePolicy()==='never'` 时**直接 return `'rejected'`，不派发 waterfall**（danger-full-access 预设 = approval never）；v1.2.11 起确认类门禁已降为软约束，不再走 `ctx.userQuestions.ask()`；只有 policy=ask 的部署 waterfall 才活，届时按 §1 设计再启用 |
| 2 | `subagentStart/subagentStop`（agentName matcher；subagentStop 可 block 强制续跑 + modifiedResponse 改写返回） | **`subagent/start` + `subagent/end`** emit（`SubagentRunInfo`/`SubagentRunEndInfo` 含 `lastAssistantMessage`）+ **`tools/post-execute` 对 subagent 工具的 result 改写/block** | ❌ 未接（kix-orchestration 只做 pre-execute 校验，不观察子代理返回） | ✅ **已融合（2026-08-16 v2 返回侧校验 + v3 收尾证据链）**：kix-orchestration 增加 `subagent/end` 监听（QA 返回声明 vs progress 一致性 → steer 提醒）+ `producer_closeout` gate（spec 验收标准在档 / 任务全完成 / 测试变更要求重验，替代 Copilot 的 qa-signoff 深度校验中可机械的部分），48 断言回归通过 |
| 3 | `errorOccurred`（recoverable 语义） | **`agent/request-error`** waterfall（可返回 `{kind:'retry'}` 接管失败恢复）+ **`agent/error`** emit | ❌ 未接（kix-cost 只在 `agent/request` 做路由探测回退，不做运行时失败恢复） | 🔶 **观察候选，暂不融合**——`agent/request-error` 的 `{kind:'retry'}` 复用 harness 重试策略（同配置重试）；"换厂商重试"需同时改写 `agent.request`，机制较重。按 kix 哲学（规则是负债）：无真实失败恢复证据前不预建；若出现「模型调用失败后恢复不当」实例再按 §3 设计融合 |
| 4 | `postToolUse` 的 `additionalContext` 注入（kix 的 qa-freshness/auto-update-progress 语义） | **`tools/post-execute` 的 `additionalContexts`** | ⚠️ 部分（kix-orchestration/kix-discipline 已用） | ✅ 已接（无需新增） |
| 5 | `postToolUseFailure`（失败后注入恢复指引） | **`tools/post-execute` 对失败结果**（thrown tools 也达此 waterfall） | ⚠️ 部分（kix-discipline 只在成功路径识别测试） | 🔶 可选（失败注入提醒；与 #3 同理，无实例证据不预建） |
| 6 | `userPromptTransformed`（改写模型收到的 prompt） | **`agent/pre-step`** waterfall（`PreStepDecision`：reject 或替换 messages） | ❌ 未接 | 🔶 低优先（kix 哲学：不干预模型思考；仅"补足非限制"场景需要） |
| 7 | `sessionStart` 注入 initialPrompt 上下文 | **`agent/session-start`** emit + `system-prompt/assemble` waterfall | ❌ 未接 | 🔶 低优先（persona 已承担常驻认知层） |
| 8 | `preCompact`（压缩前钩子） | DSH 有 `dsh-compaction`，但事件目录未见 host 事件 | ❌ 未接 | ⛔ 不接（kix 纪律：不干预 harness 上下文管理） |
| 9 | `notification`（fire-and-forget 通知注入） | DSH 有 `session/event`/`agent/status` emit | ❌ 未接 | ⛔ 不接（kix 纪律：通知噪音违反"限制越少越好"） |
| 10 | matcher 过滤（按 toolName 过滤 hook 触发） | **scope-filtered dispatch + `tools.restrict`/`tools.guard`** | ✅ 已用（kix-focus） | ✅ 已接（且比 matcher 更精确） |
| 11 | `agentName:` 参数（runSubagent 原生加载 YAML agent：persona/tools/hooks，CEO 零成本换成员；2026-08-17 判研补录） | spawn 工具行 **`persona` 字段**（per-child shadowing；lite 行已用）+ 三跳指令链（persona「DSH 适配」→ prompt 适配注记 → DSH-ADAPTATION §3 → 模型自读 `agents/*.agent.md` 组 prompt） | ⚠️ 半落地：6 个角色文件全量迁移；但 kixpower 团队分派路径**零实地证据**（WSL2 实测 CEO 按属性路由正确选择 ad-hoc 三通道，未走角色路径） | ✅ **已机制化（2026-08-17 编曲模型收敛，行 11 触发条件的前半落地）**：qa/dev/reviewer 三个 activatable 档照抄 lite 先例（spawn 行 `persona` 字段承载契约快照，`kix_tool_activate` 按需激活，人名=契约句柄；单一权威仍在 `agents/*.agent.md`）。范围收敛为**重路径成员菜单**：轻路径观察位维持无名视角 prompt（「视角来自 prompt 不做角色化」不变量，不机制化）。producer/orchestrator 不建行（S7 已证 CEO 自规划够 / 协调留主线程）。注入链实地证据（`/kixpower-*` 全流程）仍按 v6 补记验收——档位激活≠流程跑通，两件事分开记账 |

**本轮结论**：6 个 DSH 原生有而 kix 未接的 VS Code 等效机制中，**真正应融合的只有 #2（subagent/end 返回侧校验 + producer_closeout 收尾证据链，已落地 v2/v3）**；#1 是死代码（policy=never 不派发）、#3/#5 缺实例证据（规则是负债，不预建）、#6/#7 低优先（不干预模型/会话）。**这就是"用 DSH 最佳实践融合"与"机械搬运"的区别**：先查 DSH 部署事实，不把 VS Code 的机制列表照单全收。

---

## 7. 外部审查 5.6 三项的处置（2026-08-17）

| 5.6 发现 | 判定 | 处置 |
|---|---|---|
| **kix-cost lite fallback 多轮 bug** | ✅ 属实（源码复核：只缓存 `'fallback'` 标签不缓存回退路由，第二轮回到不可用首选路由） | **已修复**：缓存 `fallbackRoute` 本身（provider/model/effort），后续轮次直接应用；环境默认也不可得时保持首选路由让适配器响亮报错。+4 多轮回归断言（28 全过） |
| **capability_call 无分组白名单**（"知道名字即可代理"） | ⚠️ 属实但为**设计权衡**，评估后**不做** | 决策记录写进 kix-focus.js 源码注释：① 执行面防线已闭环（restrict 后直呼 UNKNOWN_TOOL，capability_call 是唯一通路且走完整 pre-execute 门禁）② 会话级白名单会误拦长尾动态工具（>0% 误报）③ discovery≠authorization 的正解在门禁层（已有），不在目录层。规则是负债：无已知盲点不加预防性规则 |
| **search 不返回参数名** | ✅ 属实（`projectToolMeta` 存在但未接入 execute——死代码技术债） | **已修复**：query 命中时各组附带 `matchedTools` 元数据（name/description 截断/参数名，每组上限 5；空 query 目录浏览模式不投影控制 token）。+5 断言（66 全过） |
| （附带）**route 模型偏好硬编码** | ✅ 属实（升级模型要改插件代码） | **最小配置化**：`mergePreferences(config)` 浅合并默认表，agent.cordis.yml 该行 config 可传 `crossProviderOrder/genericCrossOrder/modelPreference` 任意子集；不传 = 行为零变化（默认表原样）。+8 断言（67 全过）；zai 表顺手补 `glm-5.5` 候选位 |

---

## 1. `approval/request` ← VS Code `permissionRequest`

### VS Code 侧（权威文档）
`permissionRequest`（CLI only）在**权限服务运行之前**触发（早于规则引擎/会话审批/autoApprove/用户提问）。hook 输出 `behavior:"allow"|"deny"` 可短路正常权限流。用途：CLI 管道模式、CI 等无交互场景程序化放行/拒绝工具调用。

### DSH 侧（源码契约，已查证）
```
Event 'approval/request'  (mode: waterfall)
  signature: (this: Scoped<ApprovalService>, req: ApprovalRequest,
              next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>
  description: "Ask composed answerers for one decision. Return an outcome to
               claim the request or call next(); failure yields the fail-closed default."
  req: { agent, tool identity, reason, signal }
```

即：**任何走审批栈的请求都会先过 `approval/request` waterfall**，监听器可返回 outcome 认领（短路），或 `next()` 交给默认审批流。这与 VS Code `permissionRequest` 的"权限服务前短路"是**同构机制**。

### kix 现状
- v1.2.11 起 `kix-guards.js` 的发布/评论/普通 push 等确认类门禁为软约束，不进入 approval 栈。
- deny 在 `tools/pre-execute` 直接返回 `{kind:'deny'}`——也**不经过 approval 栈**。
- **没有任何插件监听 `approval/request`**。

### 遗漏了什么（融合价值）
DSH 的 `approval/request` 是「审批栈的统一入口」。不接它意味着：
1. **无法在权限层做程序化决策**：例如「danger-full-access 预设下，某些工具本应被 sandbox 拒，但审批栈先放行了」——监听 `approval/request` 可以按 `req` 的工具身份/agent 短路 `deny`，作为 pre-execute 之外的**第二道机械层**（分层：pre-execute 拦显式工具调用，approval/request 拦一切走审批的请求）。
2. **审批审计不完整**：approval/request 是审批事件的权威源头，不监听则无法记录"哪些请求被程序化放行"。

### 融合设计（按 kix 哲学：确定性 0% 误报）—— **条件启用：仅 policy=ask 部署**
> **本部署判定（2026-08-16，源码查证）**：`dsh-user-approval/lib/index.js` 的 `decide()`：
> ```
> if (this.effectivePolicy(session) === "never") return "rejected";   // ← 不派发 waterfall
> const answer = ... waterfall(scopeTarget(this, req.agent), "approval/request", req, ...)
> ```
> 本部署 danger-full-access = approval never → `approval/request` **永远不会被派发**，接监听器 = 死代码（负债）。kix 的确认类门禁已降为软约束（v1.2.11，不依赖 approval 栈）。
> **若未来某部署切 policy=ask**：kix-guards 增加 `approval/request` 监听器，仅对机械可判定的确定性请求短路（如审批请求的 tool 是 `mcp__github__*` 写 main → 返回 `'rejected'`）；无法确定性判定的一律 `next()`。**不**把现有聊天内提问改回 approval 栈。强度默认 `next`：只有显式配置的 deny 清单才短路。

---

## 2. `subagent/start` + `subagent/end` + post-execute 改写 ← VS Code `subagentStart/subagentStop`

### VS Code 侧（权威文档）
`subagentStop` 在子代理完成后、结果返回父代理前触发；输出 `{ decision:"block", reason }` 可强制子代理再跑一轮，`modifiedResponse` 可改写返回父代理的文本。`subagentStart` 可按 `agentName` matcher 前置 additionalContext。**内置 general-purpose agent 不发，explore/task 等 YAML agents 与自定义 agents 发**。

### DSH 侧（源码契约，已查证）
```
Event 'subagent/start'  (emit):  info: SubagentRunInfo   { runId, provider, id, local }
Event 'subagent/end'    (emit):  info: SubagentRunEndInfo{ runId, provider, id, local, stopReason, lastAssistantMessage, ... }
```
且 `tools/post-execute` 对 subagent 工具的 dispatch result 可 `{kind:'accept', additionalContexts}` / `{kind:'block', feedback}` —— 即 **子代理工具调用完成后，可以观察并改写/注入**。

### kix 现状
`kix-orchestration.js` 只在 `tools/pre-execute` 校验**分派前**条件（sprint marker/plan/progress/blocker/QA 完成度），**不监听 `subagent/end`**——即「子代理已经跑完并返回，但没有机械校验它返回了什么」。
- QA 子代理返回「✅ 全部通过」但 progress.md 未同步 → 目前无机制兜底（pre-execute 只查分派前状态）。
- validate-qa-signoff.ps1 的 Copilot 版是在 `runSubagent` PreToolUse 校验；DSH 版没有"返回侧"校验。

### 遗漏了什么（融合价值）
「交接门禁的返回侧」：kix 三通道/QA 完成度是 kixpower 的核心纪律，Copilot 侧靠 `validate-qa-signoff` 在分派前查，DSH 侧也应该有**分派后**观察——`subagent/end` 给出 `lastAssistantMessage`（子代理最终返回），可机械校验「QA 子代理返回了 verdict 结构但 progress.md 没更新 completed==total → 注入提醒（remindOnce）」。

### 融合设计（按 kix 哲学：补足非限制、默认 remind）—— **已落地（2026-08-16 v2/v3）**
- **v2 subagent/end**：kix-orchestration 增加 `subagent/end` 监听（emit 模式，scoped 到 parent agent）：从 `info.lastAssistantMessage`（ContentBlock[]）提取纯文本 → `checkQaReturn` 机械判定「含完成声明 ∧ progress.md 的 completed≠total」→ 通过 `agent.steer()` 注入提醒（remindOnce，`returnReminded` 状态）。0% 误报：无完成声明 / 进度已同步 / 无法读进度（fail-open）都不提醒。
- **v3 producer_closeout 收尾证据链**：Copilot 侧 validate-qa-signoff（qa-signoff 文件 / L2 SHA 绑定 HEAD / gate manifest digest / reverify marker / stash 基线 / 签署后变更拦截）**绑定 Copilot 特有流程的部分不移植**（负债判定）；用 DSH 原生机制补「防假完成」三件事：① spec 契约「验收标准」在档（`kix-discipline/spec.md`，复用 kix-discipline 的契约）② progress.md completed==total（复用 parseProgressState）③ 测试文件自 `l2_verified_sha` 后有变更 → 要求全量重验（`git diff --name-only` 机械检测，替代 reverify marker，不引入 marker 文件）。强度与交接 gate 同档（默认 remind）；读失败 fail-open（提醒层不拦）。
- **不移植** Copilot 的 worktree/SHA 数学/stash 基线深度校验（DSH 无此流程，过度移植 = 负债）；不 block 子代理（block 是 pre-execute 门禁的职责，提醒层只 steer）。
- 回归：`node plugins/kix-orchestration.test.js` 48 断言全过（v2 8 项 + v3 10 项）。

---

## 3. `agent/request-error` ← VS Code `errorOccurred`（recoverable）

### VS Code 侧（权威文档）
`errorOccurred` 输入含 `errorContext: model_call|tool_execution|system|user_input` 与 `recoverable: boolean`。CLI 用它做错误恢复/审计。

### DSH 侧（源码契约，已查证）
```
Event 'agent/request-error'  (mode: waterfall)
  signature: (this: Scoped<Agent>, payload: { agent, turn, step, provider,
              failure: LlmFailure, retryPolicy: ResolvedRetryPolicy | undefined, signal },
              next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>
  RequestErrorAction = { kind:'retry' } | undefined
  description: "Handle one failed model-request attempt before the loop retries
               or closes its step. A listener returns {kind:'retry'} without
               calling next() when it owns recovery..."
```

### kix 现状
`kix-cost.js` 在 `agent/request` 做**路由**（lite 档首选/回退），但**失败恢复**（`agent/request-error`）未接——模型调用失败时，kix 没有自己的恢复策略（依赖 harness 默认 retryPolicy）。

### 遗漏了什么（融合价值）
「跨厂商路由的失败恢复」：kix 核心信念之一是跨厂商模型验证 + 路由回退。`agent/request-error` 是「主模型调用失败 → 按 kix 策略换厂商重试」的原生落点。例如：deepseek 主路由超时/失败 → 返回 `{kind:'retry'}` 前先把 `agent.request` 的下次配置切到 zai 系（配合 kix-route 的哨兵机制）。

### 融合设计（按 kix 哲学：确定性、默认保守）
- kix-cost（或 kix-route）增加 `agent/request-error` 监听：失败 provider 属于某厂商 → 注入「下次请求换厂商」的配置改写（复用 kix-route 已实证的 waterfall 改写机制）；无法判断的 `next()`。
- **fail-safe**：监听器自身抛错必须 `next()` 或返回 undefined（不吞默认重试）。

---

## 4. 已接入机制的核对（不重复建设）

| DSH 事件 | 已接插件 | 备注 |
|---|---|---|
| `tools/pre-execute` | kix-guards / kix-orchestration / kix-discipline | 主门禁面 ✓ |
| `tools/post-execute` | kix-orchestration / kix-discipline | additionalContexts 注入 ✓ |
| `agent/turn-stopping` | kix-discipline | 回合结束验证提醒 ✓ |
| `agent/request` | kix-route / kix-cost | 路由/成本 ✓ |
| `tools/change` | kix-focus | restrict 重试 ✓ |
| `tools/result` | ❌ | kix 决策：只读观察，重复机制（workflow schema 已强制验证）不接 ✓（capability map §3 P2 决策） |
| `fs/write-intent`/`fs/edit-intent` | ❌ | kix 决策：write/edit 工具已被 pre-execute 拦；fs 层意图是宿主 sandbox 职责（沙箱三档 fail-closed 已兜底），不重复 ✓ |

---

## 5. 融合优先级（按 kix 哲学排序）

| 优先级 | 融合项 | 理由（规则是负债 / 0% 误报 / 补足非限制） |
|---|---|---|
| **已落地** | `subagent/end`（kix-orchestration v2）：QA 返回侧一致性校验 | 补「交接门禁返回侧」真实缺口；默认 steer 提醒（remindOnce）不 block；0% 误报（无完成声明/进度已同步/读失败都不提醒）；38 断言回归通过 |
| ⛔ 不接 | `approval/request`（kix-guards）：程序化 deny 短路审批栈 | **死代码判定**：policy=never（danger-full-access）下 `decide()` 直接 rejected、不派发 waterfall（源码 `dsh-user-approval/lib/index.js:188`）；kix ask 已走 userQuestions 聊天提问。policy=ask 部署时再按 §1 设计启用 |
| 🔶 观察 | `agent/request-error`（kix-cost/route）：失败换厂商重试 | `{kind:'retry'}` 复用 harness 重试策略；"换厂商"需同时改写 agent.request，机制较重。无真实失败恢复证据前不预建（2 轮无拦截 → 降级，PLUGINIZATION-ROADMAP §7 同款） |
| 🔶 观察 | **并发纪律机制化**（max_parallelism / DAG ω / Partition / Synthesis） | VS Code 古早版（kixpower-bundle，v3.9）的并发策略全家族已完整存活于 DSH preset 的 **prompt 层**（orchestrator agent.md 8 场景表 + TEAM_CONVENTIONS 拓扑路由，2026-08-17 机制级对照确认）。当前为模型自律，无机械强制。若出现「并行纪律未遵守」实例（如超 ω 拆批缺失、Partition 互写），评估方向：subagent 并发计数挂 `subagent/start`+`subagent/end` emit（0% 误报可机械：在飞 run 数 > min(user,ω,8) → 提醒）；其余（拓扑选择/Synthesis CS）是认知判断，永久留 prompt 层。无实例不预建 |
| 🔶 可选 | `postToolUseFailure` 等价（kix-discipline 失败注入提醒） | 与 request-error 同理，缺实例证据 |
| 🔶 低优先 | `agent/pre-step` / `agent/session-start` | 干预模型思考/会话注入，违反"限制越少越好"，除非用户明确要求 |
| ⛔ 不接 | `notification` / `preCompact` / `tools/result` | 噪音 / 干预 harness / 重复机制（负债判定） |

**实施原则**（kix 哲学）：每个融合监听器**默认不干预**（`next()` / remindOnce / steer 提醒），只有确定性 0% 误报的判定才短路；每个新 gate 需单元回归；2 轮内无真实拦截记录 → 降级 opt-in 或删除（PLUGINIZATION-ROADMAP §7 同款）。

---

## 6. 证据索引

- DSH 事件目录：本会话 `cordis_inspect_query Event.listEvents`（tools/pre-execute、tools/post-execute、tools/execute、tools/result、agent/pre-step、agent/request、agent/request-error、agent/turn-stopping、agent/session-start、agent/error、approval/request、subagent/start、subagent/end、fs/write-intent、fs/edit-intent、workflow/*）
- DSH 类型契约：`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts`（PreStepDecision / RequestErrorAction / SessionStartSource）、`@deepseek-ai/dsh-subagent/lib/types/types.d.ts`（SubagentRunInfo / SubagentRunEndInfo）、`@deepseek-ai/dsh-tools/lib/types/index.d.ts`（PreToolDecision / PostToolDecision / ToolExecutionResult）、`@deepseek-ai/dsh-fs/lib/types/types.d.ts`（FsWriteIntent）
- VS Code 权威：GitHub [hooks-reference](https://docs.github.com/en/copilot/reference/hooks-reference)（permissionRequest / subagentStart / subagentStop / errorOccurred / postToolUse / 事件表）
- kix 现状：`dsh/preset/plugins/*.js`（grep `ctx.on('` 得 5 类事件）
- 上一轮审计：`kix-vscode-mechanism-audit.md`
