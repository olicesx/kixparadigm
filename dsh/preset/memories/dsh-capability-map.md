# DSH Capability Map — DeepSeek Harness 机制事实地图

> **定位**：机制事实层索引（对照 `DSH-ADAPTATION.md` 的工具名映射，本文件是能力面全景）。**不是规则**——不写「kix 应集成 X」这类结论，只记机制事实 + 标注过的判断。后续任何 kix×DSH 任务（改 preset、注册命令、集成矩阵、写 guards）先查本文件，避免重翻 172 个包。
>
> **来源**：DSH 安装包内 `node_modules/@deepseek-ai/dsh-*` 共 172 包的 README（优先 zh）。
> **方法**：12 组并行梳理（8 组 DeepSeek + 4 组 GLM 跨厂商），组级机制无跨厂商分歧。
> **更新条件**：DSH 版本升级或机制被实际任务验证/推翻时复核。已落地的状态史（各插件逐版验收记录）不在此维护——机制事实层与状态史分层，状态史看 CHANGELOG。

---

## §1 能力地图（12 域）

| 域 | 代表包 | 关键机制（供索引） |
|---|---|---|
| 事件溯源核心 | dsh-session / scope / projection / reference | 会话日志仅追加唯一真源，LLM 历史是派生 surface；压缩=表层遮蔽不删日志；"model-visible ⟺ logged"；scope 父链是统一隔离原语（明确非沙箱）；投影缓存"陈旧但不错"（stateVersion 失效锚点，fail-soft） |
| Agent 循环 | dsh-agent / agent-loop / presets / agent-instructions | 接口/唯一具体循环/插件三层分离，门禁沙箱权限恢复全在 `agent/*` + `tools/*` 事件流水线的插件层；preset=agent.cordis.yml 目录，roster 常驻挂载一次，会话按 scope 父链加入；AGENTS.md 基线 + 嵌套发现，`</system-reminder>` 字面转义 |
| 工具流水线 | dsh-tools / tool-fs / str-replace / ask-user / todo / web / skill / jobs / timeout-policy | 每次调用：pre-execute(allow/deny/ask) → 单调 guard → execute(超时/重试包装) → post-execute(可替换 content/附加上下文) → finalize → result；门禁拒绝不可被下游撤销；"工具不做策略、策略不入工具"；timeoutMs=协作承诺（signal 通知，终止留各能力本地）；KV cache 前缀稳定性是一等设计约束 |
| 沙箱安全 | dsh-sandbox* / fs-sandbox / fs-observation / shell* / approval / permission-presets | 三档 read-only/workspace-write/danger-full-access 跨 fs/bash/pwsh/terminal 共享单一 `ctx.sandboxPolicy` + 唯一 writableRoots；无 runner 一律 `SANDBOX_UNAVAILABLE` fail-closed 绝不降级；写前必读是机械门禁（FS_NOT_OBSERVED）；升权=严格更宽 + justification + 一次性授权（allowed-once，审计失败即 reject）；Windows ACL 如实报 enforcement:'partial' |
| 子代理编排 | dsh-subagent* / tool-subagent* / workflow* / tool-workflow / goal* / tool-ralph | 委派边界权限固定：快照父级沙箱覆盖 + 审批钉死 'never' + 带来源事件写入子级日志（策略可仅凭日志重建，冷恢复不重捕获）；delegationDepth 持久单调；可继续子级 inbox 唯一 FIFO；workflow=worker-thread 跑脚本扇出（fatal 错误总逸出不降级为 null，子 agent 失败返回 null 交脚本）；goal=事件溯源 + 写前 invariant + 严格回放双层校验，**续行启用绝不持久化**（session-start 即 disarm）；blocked 机械下限 3 轮与语义判断分离；ralph=fresh-agent 循环，完成/阻塞是 worker 自报（官方明示非独立评估），跨 Round 只有有界结构化交接 |
| 上下文管理 | compaction* / output-retention / spill* / checkpoint-policy | "表层替换、日志不可变"：compaction/pruner 只改模型可见表层（surfaceOp: replace），原始事件永留日志；四层预算：工具输出层(有界返回)→已落日志层(pruner 剪枝)→会话层(token 压力+工具配对平衡边界)→溢出兜底；崩溃一致性=可检测遗留状态（合成 closer 关开放轮次，TOOL_OUTCOME_UNKNOWN 要求验证而非盲重试）；/compact 命令零 token 不进模型历史 |
| 持久化查询 | persistence* / query-sqlite / storage* / schedule / telemetry* / credentials* / settings* | 事件溯源脊柱：调度提醒/FTS 索引/遥测投影/查询表层全是可丢弃可重建投影；崩溃恢复=追加合成 closer 替代截断；设置三层(schema默认→base→user，update 只写 user 层)；凭据四层(env>受管文件>.env×2)配置只存引用(`apiKeyEnv`)，按操作解析，0600 是审慎不是边界（README 原话）；原子写统一模式（临时文件+fsync+rename+防符号链接） |
| LLM 层 | dsh-llm / llm-deepseek / llm-pi-ai / llm-retry / mcp-client / persona / system-prompt / time-context | 注册表+策略外置（适配器注册时捕获重试策略，执行权归 llm-retry 在 agent 轮次边界重放）；resolveModelInfo 权威回答 contextWindow 等能力元数据，catalog 只是建议非白名单；system-prompt=段+order+scope 遮蔽+waterfall+complete 段+严格变量插值（插值失败宁可抛错）；动态配置每操作重读 thunk 免重启生效；MCP 工具名确定性 hash 64 字符 |
| Web/宿主 | host-webserver / apiproxy / client-web / client-runtime / hmr / commands / cmdline | 通信=HTTP POST 双向 + 两条只下行 WebSocket（任一断整代重建，无网络 SSE 回退）；四象限消息联合 rpcId 只回显；插件加载=__DSH_BOOT__ 启动图→bundle 只注册 factory 惰性物化→cordis fiber 治理；HMR=SSE rebuilt 帧串行队列，依赖方靠激活 epoch 级联；命令平面：/compact /export /goal /feedback 结果绝不进模型历史、零 token、recordInput 可选 |
| 用户命令平面 | dsh-commands / command-compact / command-goal / command-feedback / native-command | ctx.commands 注册表：小写名称+描述+可中止处理器；agent.ctx 下注册精确限定该 agent 遮蔽同名全局；command/run+done 日志事件对（无轮次包裹、检查点排空）；未知斜杠命令被适配器拒绝而非变成模型提示词；零 token 零前缀污染 |
| 动态插件 | tool-cordis / cordis-host-runner / cordis-client-runner / client-ui-cordis | cordis_define/run/stop/undefine/inspect 操作实时运行时；双半（host vm 沙箱 + 浏览器 UI）；纯内存不跨重启不落盘不自动转正式插件；**vm 不是安全边界**（官方：视同 bash 访问）；官方单独做成 cordis preset 且文件头明写 TRUST 声明；运行中包可注册工具/提示词/监听器 |
| 基建 | invariants / atomic-write / typert* / jobs* / code-runtime* / workspace / attachment / brand / api-gateway / api-remotes | Seam 三件套拆包（Service Definition/Provider/Consumer 政策插件）贯穿全部能力；fiber/effect 生命周期唯一权威，注册随 fiber 释放撤销；统一"模型代码=敌对对等方"信任模型（端口逐条验证、防符号链接预置、owner 隔离是安全边界）；invariant 配套把开发期不变量变运行时断言；Code Runtime=worker-thread 剥类型执行模型程序（vm 非沙箱，价值=不占事件循环+terminate+空 env） |

## 任务形态 → 机制映射（2026-08-17 实测固化，WSL2 E2E）

> 判别信息尽量放在**模型本来就会读的地方**（工具描述/目录：bash 的 run_in_background、subagent 的 continuable、workflow 的显式语义均已自带引导）。本表只补**防误用**与**组合形态**——做 DSH 相关任务先查这里，不用背。

| 任务形态 | 正确机制 | 判别要点（防误用） |
|---|---|---|
| 单个长测试/构建 | 后台 job：bash/pwsh `run_in_background: true`（参数描述自带引导）→ `job_output` 取、`job_kill` 停 | 返回 **job id**（如 bash-1） |
| 多个机械测试并行（无需分析） | **纯 shell 管道可表达 → bash 单命令**；需**工具调用组合/结构化逻辑/自验证** → `run_code` 一次往返（presentation mode:both） | 实测（2026-08-17）：纯统计 bash 更省 token（run_code 输入约 2×）、run_code 更省来回（1 次 vs 3 次）且一次写对率高（内嵌基线自校验）；**文件内容都不进上下文**是两者共同优点（优于逐次 tools.read 灌全文） |
| 多 agent 并发扇出+聚合（无依赖观察/取证，语义决策留主线程） | `run_code` 内 `Promise.all([tools.subagent(...), tools.subagent_cross(...)])`，`return` 只回聚合摘要 | 探针实证（2026-08-18）：run_code 工具面=全部常驻工具（26 个，含 subagent/cross/workflow）；3 路异质单步 7.5s 全过门禁；子调用结果不回模型上下文（Code Mode 契约，档一 PTC 条目）。**公平 E2E 修正（同日 WSL2 headless，preset diff=0）**：3 个微小子任务时扇出墙钟**反而更慢**（75.5s vs 串行 34.8s）、非 cache token 更贵（11.3K vs 2.7K）——载体固定开销需子任务时长摊薄，**微小探测任务直派串行更优**；扇出稳赢的是主线程步数（父 2 步 vs 4 步）与 cache 读。候选分级与回收条件见 `orchestration-lessons.md` ⑥ |
| 浏览器自动化（爬取/截图/E2E/批量表单/接管真实浏览器） | **原生插件 `browser{action}`**（kix-browser.js，2026-08-18 落地，同日扩到 17 action + 渐进披露合规）：open/snapshot/text/click/type/press/select/hover/back/forward/reload/wait/screenshot/upload/tabs/dialog/close；CDP attach 优先（KIX_BROWSER_CDP，接管真实浏览器登录态）+launch headless 兜底；会话跨调用持久；弹窗默认驳回+dialog{auto} 策略+lastDialog 回报。**渐进披露形态**：yml 挂载行默认注释（零常驻 schema 税）——kix-focus ACTIVATABLE_TOOLS.browser（pkgPath 本地解析）+ browser-native 目录组，capability_call 首用自动激活，kix_tool_deactivate 卸载；常驻=取消 yml 注释重启 | **已落地并 E2E 实证**：单测 12/12 + kix-focus 111/111（含 pkgPath 激活路径集成断言 + 枚举防线同步）；E2E 真浏览器 11 步全绿（open→wait→snapshot 元素提取→click 真实跳转→back/forward/reload 闭环→tabs→dialog→screenshot→file:// 拒绝→close）。**故意排除（范式红线/低频）**：页内任意 JS evaluate（blast-radius 红线，需要时 pwsh 直驱脚本=代码级可审查）；网络拦截/cookie/PDF/拖拽（脚本路径）。坑实录：①`$$eval` 传字符串函数体在该版 playwright-core 返回 undefined → 必须传真实函数引用；②重构时 open 执行分支误置于会话门禁后 → open 被自己拦死（E2E 抓出，单测盲区=只测校验路径不测成功路径）；③**restrict 裁不掉本层自有注册**（dsh-tools 源码定谳：restriction 只过滤继承面）——preset 层插件的渐进披露必须走 ACTIVATABLE pkgPath 路径，不走 restrict；④ACTIVATABLE 新增条目必须同步 activate/deactivate 工具 description（枚举防线会拦）；⑤playwright-core 懒 require+KIX_BROWSER_CORE 显式路径（npx 缓存可逐出）；⑥宿主重启后才装载/生效。playwright-core 安装位：宿主 home `npm install playwright-core --prefix ~/.dsh` 或 KIX_BROWSER_CORE 指路 |
| 多测试/多文件并行且需独立分析 | **subagent 并发派多个观察者**（默认，编曲模型引导）；重编排（多阶段/大批量）才显式 `workflow` | workflow 官方描述为「仅显式要求时用」——模型自发不用它做并行检查（实测：3×subagent 而非 workflow） |
| 后台子代理（continuable） | `subagent run_in_background: true` → `list_agents` / 结算通知唤醒 | 返回 **durable subagent id**（不是 job id）——**勿用 `job_output` 查**（实测误用报 unknown job） |
| 组合：后台 job + workflow | ① 先 `run_in_background` 启动长任务 → ② workflow（前台阻塞，不阻塞 job）→ ③ `job_output` 回收 | 顺序固定：先后台 → workflow → 回收；回收由完成通知驱动，勿轮询 |

### 机械卫生（2026-08-17 实测教训）

- **验证/探针类脚本输出写 `/tmp`（或 `/tmp/kix-verify/`），跑完即清理，勿写进工作区**——实测验证任务把 `verify-get-equivalence.test.mjs` 写进仓库根、污染 git status（已清理）；workflow/探针的临时目录同理（kix-orchestration 测试曾泄漏 /tmp/kix-orch-test-* 共 593 个目录，已修复为自动清理）。
- **subagent id ≠ job id**：`subagent run_in_background` 返回 durable agent id，用 `list_agents`/结算通知管理；`job_output` 查它会报 `unknown job`（实测 2 次，均自愈无害——收到 unknown job 后正确改等结算通知）。

## §2 与 kix 的相性结论（三档判断）

### 档一：地基级契合——kix 纪律的机械底座已就位，直接依赖零改造
1. **事件溯源 + model-visible ⟺ logged** → kix 三通道「观察独立可回放」从自觉变可审计。
2. **工具门禁链**（pre-execute/guard/execute/post-execute/result）→ kix「机械门禁常驻、规则是负债」的架构化形态；kix-guards 参考 hooks 可重写为原生监听器（DSH-ADAPTATION §机械门禁已预留）。
3. **沙箱三档 fail-closed + 诚实降级报告**（Windows partial）→ 与 kix 反自信偏差同构，连自己边界都标注 partial。
4. **委派边界权限固定**（快照+钉 never+日志可重建+单调深度）→ kix「子 agent 只能在继承范围行动、升权确定性拒绝」的原生实现。
5. **统一升权语义**（严格更宽+justification+一次性授权+同轮次仅一次重试）→ kix「破坏性操作前 ask_user_question」的机械对偶。
6. **goal 双层校验 + disarm 纪律**（续行绝不持久化、blocked 机械下限与语义分离）→ 与 kix goal 工具纪律逐条同构。
7. **PTC/Code Mode**（SDK 确定性生成、中间值只存执行局部、通告面=可调用面、KV cache 前缀稳定）→ kix PTC 纪律的宿主实现，纪律文档无需改。

### 档二：可操作集成（按需评估，状态看 CHANGELOG）
8. **用户命令平面**：kix 的 /kixpower-* 命令注册为 DSH 原生命令 → 触发零 token 不消耗模型轮次。（已落地：kix-commands.js）
9. **跨厂商矩阵进 settings**：llm-pi-ai 挂任意 OpenAI 兼容网关 + resolveModelInfo 能力元数据 → kix「prompt ≤5K tokens」可机械校验。（已落地：kix-route.js 自动取反路由，模型线升级只改 settings、preset 永不再钉模型）
10. **结构化输出即验证**：structured_output 工具 + tools/result 观察器 + 单调防护 → kix 验证 gate 从约定升级为机械强制。（部分落地：workflow schema 是唯一机械验证入口）
11. **workflow 编排 kix 团队**：agent/pipeline/parallel/phase 与 producer/dev/qa Tri-Block 兼容；fatal 逸出纪律与「失败团队产出不算 claim」一致；边界=无 token 预算词汇、无恢复，长目标仍用 goal。

### 档三：张力与边界（慎用/不用）
12. **ralph**：完成/阻塞是 worker 自报非独立评估（官方明示）→ 与 kix 三通道验证冲突；只配做**创造阶段**工具（探索/候选生成），禁止用于验证/收敛阶段；跨 Round 有界交接与「单次经验只作 candidate」兼容。
13. **MCP client**：与 kix 递减复用哲学排在末端；外部工具面=KV cache 前缀失效+盲点不可控；要用则锁定工具集合稳定。
14. **UI/slot 系统**：范式不是产品；唯一有意义场景=子代理状态/验证 gate 可视化面板（可选增强）。
15. **遥测/schedule/HMR**：低相关或不集成（HMR 只服务 kix 自身开发节奏）。
16. **动态插件（cordis 工具集）**：默认不装（安全=shell 级+token 税+持久性矛盾）；kix 自研（改 preset/guards）时临时切 cordis preset 做原型，试成落盘为静态资产。

### §2.1 能力元数据校验（档二-9 的机制细节）

- `resolveModelInfo()`（llm 服务）向拥有精确 provider/model 路由的适配器查询一次：返回 contextWindow / defaultMaxTokens / reasoning 档位。catalog 只是建议非白名单——未列出模型 id 原样透传。
- kix 用法：分派子代理前可用它校验「prompt ≤ 5K tokens」假设（对照 contextWindow 而非猜）；compaction 阈值由 harness 管，不重复测量。
- 新增厂商两步法（DSH-ADAPTATION §3 已写）：settings.yaml `llm-pi-ai.providers` 加 profile（apiKeyEnv 引用密钥，绝不写明文）+ preset agent.cordis.yml 加对应 subagent 工具行（agentOptions.provider/model 覆盖路由，已实证）。

### §2.2 cordis preset 原型切换（档三-16 的操作形态）

- **零配置路径**：DSH 出厂自带 `cordis` agent preset（安装目录 `config/agent-presets/cordis/`），新建会话时选择它即获得 `cordis_*` 五工具 + 组合编写技能。**不修改 kixparadigm preset**（默认组合保持无 cordis 工具 = 安全面最小）。
- 用途：kix 自研（改 preset/guards/新 gate 原型）时开 cordis 会话：`cordis_define` → `cordis_run`（浏览器半需页面有人点允许）→ 看效果 → `cordis_undefine`；试成落盘为静态资产。
- 信任：官方文件头明写 TRUST = shell 访问级；vm 非安全边界。用完即关会话。

## §3 证据与方法（可信度标注）

- **12 组分工**：①agent 循环/session ②子代理编排/goal/ralph ③工具层 ④压缩/保留 ⑤沙箱安全 ⑥持久化/存储/凭据/设置 ⑦LLM/提示词 ⑧Web/宿主 ⑨基建 ⑩UI 全套 ⑪Web 通信细节 ⑫动态插件（前一任务）。
- **跨厂商**：②④⑥⑧由 GLM(zai-coding) 读，其余 DeepSeek 读；组级机制无跨厂商分歧 → 高置信。
- **已知缺口**：dsh-web-frontend 无 README（纯 vite 构建产物，据 package.json）；个别 README 超长行截断但机制已覆盖；所有机制均来自 README 声明，未经运行时实测。
- **命名陷阱备忘**：`dsh-web` 是 web 搜索/抓取能力包，**不是 GUI**；GUI 链是 web-app→web-frontend→client-web→client-*→host-*。

## §4 动态 Cordis 插件实测机制事实（2026-08-15 kixst stalled 原型，E2E 坐实）

> 来源：kixst-5 插件 9 个 Package 迭代 + GUI 实机敲命令验证。**不是规则**，机制事实层。

### 4.1 `harness.defineTool` 注册动态工具的精确契约（4 次失败迭代得出）

- `parameters` 是**属性映射 DSL**（`{ root: { type:'string', description } }`），不是 JSON Schema 包装 `{type:'object',properties}`——传包装报 "parameters must be a ParameterSchemaSpec object"
- 隐式 `root` 参数开放：`additionalProperties` 必须 true 或省略（否则 "the implicit parameter root is open"）
- `output` **必填**且须为 `{ schema, render, presentationMeta? }`（schema 用 ValueSchemaSpec，如 `{type:'json'}`；render 返回 ContentBlock[]，如 `[{type:'text', text}]`）
- `execute` 放在 `defineTool` options 内（不是 registerTool 时附加）；`harness.registerTool(ctx, tool)` 只接受 `defineTool` 产物（"must use a tool returned by harness.defineTool"）
- 动态注册的工具**不出现**在 `cordis_inspect_query Tool.listTools` 结果里（Inspect 只反映静态工具）；验证靠真实调用或 GUI

### 4.2 插件上下文异步与写文件（关键陷阱）

- **命令 handler 内的 `await fs.*` 链路可靠**（commands runtime 会 await handler 的 Promise）——/kixst-enable 写 PROJECT_BRIEF.md、/kixst-check 扫描均 E2E 通过
- **apply 里 fire-and-forget 的裸 Promise 异步链不可靠**：apply 返回后脱离插件生命周期，扫描/写报告静默无输出（console.error 仅进宿主 stdout，无文件落点）——诊断成本极高，应避免
- 插件写文件需显式 `sandboxPolicy.resolve({mode:'workspace-write'})` 传入 `writeText` 第 5 参（省略时默认策略可能拒写）；命令 handler 上下文 + 显式策略 = 可靠写路径
- `ctx.get('sandboxPolicy')` 在插件上下文可用；`workspaceRoot` 有值（与 sandboxPolicy 服务契约一致）

### 4.3 原生命令注册契约（对照 kix-commands.js 静态插件，动态插件同构）

- `ctx.commands.register({ name(小写无斜杠), description, input:{hint}, handler({agent, rawInput}) → CommandResult })`
- CommandResult = `{kind:'success', text?} | {kind:'error', text}`；handler 同步/异步均可，结果由 UI 直接渲染（GUI 命令卡片，零 token 不进模型）
- `command/run`+`command/done` 日志事件对（recordInput 默认 true 记录 rawInput）
- 动态插件注册的命令在 GUI 输入框敲 `/` 候选可见（E2E 实测：/kixst-enable 候选出现并执行）

### 4.4 L3 档 A 落地形态（kixst，2026-08-15）

- **减法后形态（当前）**：只保留 `/kixst-check [root]` 命令（零 token、只读、无状态）+ `kix_stalled_check` 模型工具。阈值固定 24h（参数化待真实项目定夺）。pkg-15 E2E 通过。
- **减法决定（2026-08-15，范式「规则是负债」）**：原三命令形态（enable/disable + frontmatter 持久化 + 惰性定时器 + steer 提醒）无真实项目证据即常驻/写入，属过拟合雏形；已全部移除。曾实现并 E2E 验证的三命令+定时器形态保留作恢复参考（代码在原型历史）。

## §5 遗留事项（诚实清单，2026-08-15 挂账）

> 来源：当日会话实测报告 + 本文件作者对照安装目录 `node_modules/@deepseek-ai/dsh-*` 源码定位。
> 分类：① 上游 bug（报告对象=DeepSeek 官方）② 工具层怪癖（机制事实，避坑用）。都不是规则。

### 5.1 上游 bug：复合 callId + 活跃会话重放重复 key（pi-ai × conversation engine 交互）

- **现象**：复合 callId 场景下，**活跃会话**重放出现重复 key；磁盘重放是干净的（不触发）。
- **判定**：pi-ai（`dsh-llm-pi-ai`）与 conversation engine（`dsh-session` 系）的交互问题，非本仓库可修。
- **规避办法**：**等会话停止后再打开/重放**（stop 后的磁盘重放路径干净）。

### 5.2 工具层怪癖：`cordis_inspect_query` 带 input 查询一律报 `"input" must be an object`

- **现象**：`cordis_inspect_query` 只要带 `input` 就报 `"input" must be an object`（当日两个会话都踩到）。
- **代码级定位（高置信，对照安装目录源码）**：两层 schema 不一致——工具参数层把 `input` 声明为 `type: "json"`（编译成注解-only 节点，模型看不到类型提示）；方法校验层用方法自身 inputSchema（`{type:"object",...}`）校验 `input ?? {}` → 非 plain record 报 `"input" must be an object`。
- **规避**：明确要求模型把 `input` 传成**对象**（如 `{"service":"..."}` 而非 `'{"service":"..."}'`）；或先不传 input 走目录导航，再按需单查。
- **修复建议**：`dsh-tool-cordis` 的 `input` 参数应声明为 `type: "object"` + `additionalProperties: true`。属官方包，本地不 patch。

## 会话考古/萃取技术（2026-08-19 实战提炼：GUI 列表不可见但数据完好案）

- **会话存储结构**：`~/.dsh/sessions/--<workspace-path>--/<session-id>/session.jsonl.zstd`（zstd 压缩 JSONL，`zstdcat` 解读）；GUI 列表索引在 `~/.dsh/storages/workspace.json`（工作区→sessionIds+archived 名单）与 `session_projcache.json`（每会话 rows：sessionStats/title/tokenUsage/sessionListMetadata 等）
- **标题在 projcache 的 `title` row**，不在 JSONL 首行（首行是 session header：cwd/agentPreset/delegationDepth）
- **消息事件类型**：用户=`user/message`（content[].text）；助手=`assistant/message`（**data.message.content**[]，text 与 tool-call 同层）；流式块跳过；标题事件=`session/title`
- **诊断顺序**：会话文件完好（zstdcat 首尾行）→ projcache 有无该 id → workspace.json 是否收录/归档；三者全好而 GUI 不见 = 前端渲染问题（重启 web 服务即恢复，勿动 sessions 目录）
- **WSL 与 Windows 双 store**：`/root/.dsh/sessions` 与 `/mnt/c/Users/<u>/.dsh/sessions` 各自独立，考古两处都查
- **多副本同步纪律**（同日自省实证）：根 memories 与 preset memories 是**相异变体**（preset 带 DSH 适配头），禁 cp 覆盖式同步——只做追加式编辑；部署侧从对应 preset 单向 cp。根因注记（cross 审计修正）：事故根因是**有知识无机械保护**（明知变体分叉仍无条件 cp），非「没核对」——纪律必须落在可执行禁令，不靠核对自觉
