# DSH Capability Map — DeepSeek Harness 机制事实地图

> **定位**：机制事实层索引（对照 `DSH-ADAPTATION.md` 的工具名映射，本文件是能力面全景）。**不是规则**——不写「kix 应集成 X」这类结论，只记机制事实 + 标注过的判断。后续任何 kix×DSH 任务（改 preset、注册命令、集成矩阵、写 guards）先查本文件，避免重翻 172 个包。
>
> **来源**：DSH 安装包内 `node_modules/@deepseek-ai/dsh-*` 共 172 包的 README（优先 zh）。
> **方法**：12 组并行梳理（8 组 DeepSeek + 4 组 GLM 跨厂商），组级机制无跨厂商分歧。
> **更新条件**：DSH 版本升级或机制被实际任务验证/推翻时复核。

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

## §2 与 kix 的相性结论（三档判断）

### 档一：地基级契合——kix 纪律的机械底座已就位，直接依赖零改造
1. **事件溯源 + model-visible ⟺ logged** → kix 三通道「观察独立可回放」从自觉变可审计。
2. **工具门禁链**（pre-execute/guard/execute/post-execute/result）→ kix「机械门禁常驻、规则是负债」的架构化形态；kix-guards 参考 hooks 可重写为原生监听器（DSH-ADAPTATION §机械门禁已预留）。
3. **沙箱三档 fail-closed + 诚实降级报告**（Windows partial）→ 与 kix 反自信偏差同构，连自己边界都标注 partial。
4. **委派边界权限固定**（快照+钉 never+日志可重建+单调深度）→ kix「子 agent 只能在继承范围行动、升权确定性拒绝」的原生实现。
5. **统一升权语义**（严格更宽+justification+一次性授权+同轮次仅一次重试）→ kix「破坏性操作前 ask_user_question」的机械对偶。
6. **goal 双层校验 + disarm 纪律**（续行绝不持久化、blocked 机械下限与语义分离）→ 与 kix goal 工具纪律逐条同构。
7. **PTC/Code Mode**（SDK 确定性生成、中间值只存执行局部、通告面=可调用面、KV cache 前缀稳定）→ kix PTC 纪律的宿主实现，纪律文档无需改。

### 档二：可操作集成（动作项，按 §3 优先级）
8. **用户命令平面**：kix 的 /kixpower-* 命令注册为 DSH 原生命令 → 触发零 token 不消耗模型轮次。
9. **跨厂商矩阵进 settings**：llm-pi-ai 挂任意 OpenAI 兼容网关 + resolveModelInfo 能力元数据 → kix「prompt ≤5K tokens」可机械校验。
10. **结构化输出即验证**：structured_output 工具 + tools/result 观察器 + 单调防护 → kix 验证 gate 从约定升级为机械强制。
11. **workflow 编排 kix 团队**：agent/pipeline/parallel/phase 与 producer/dev/qa Tri-Block 兼容；fatal 逸出纪律与「失败团队产出不算 claim」一致；边界=无 token 预算词汇、无恢复，长目标仍用 goal。

### 档三：张力与边界（慎用/不用）
12. **ralph**：完成/阻塞是 worker 自报非独立评估（官方明示）→ 与 kix 三通道验证冲突；只配做**创造阶段**工具（探索/候选生成），禁止用于验证/收敛阶段；跨 Round 有界交接与「单次经验只作 candidate」兼容。
13. **MCP client**：与 kix 递减复用哲学排在末端；外部工具面=KV cache 前缀失效+盲点不可控；要用则锁定工具集合稳定。
14. **UI/slot 系统**：范式不是产品；唯一有意义场景=子代理状态/验证 gate 可视化面板（可选增强）。
15. **遥测/schedule/HMR**：低相关或不集成（HMR 只服务 kix 自身开发节奏）。
16. **动态插件（cordis 工具集）**：默认不装（安全=shell 级+token 税+持久性矛盾）；kix 自研（改 preset/guards）时临时切 cordis preset 做原型，试成落盘为静态资产。

## §3 行动清单（2026-08-15 落地执行后状态）

| 优先级 | 动作 | 状态（落地后） | 落地产物/证据 |
|---|---|---|---|
| P0 | 档一 1-7 直接依赖 | ✅ 已就绪（档一 2 已接线补全，见下） | 随用随查 §2；2026-08-15 档一 2「工具门禁链」完整接线为 kix-guards v2 |
| P0 | 档一 2 工具门禁链完整接线（kix-guards v3，2026-08-15） | ✅ 代码/测试/挂载已验；⚠️ 真实拦截 E2E 待重启后复验 v3 | 源仓库 `dsh/preset/plugins/kix-guards.js`（v3）：在原有 5 道门禁上补全 blast-radius 未接部分——commit budget（reflog 计数，hard cap 10 / progress.md 预算 / 冷启动 3）、feature branch 检查（真实读分支）、force push 完整检测（**修复 v1 静默失效**：`\b--force\b` 前无词边界永不匹配）、MCP GitHub 远程写保护（main/master deny / 无 branch deny / mutation ask）、终端数据库客户端保守拦截、UPDATE without WHERE、人类确认点 ask（reset --hard/clean -f/branch -D/stash drop/checkout --/restore/普通 push，DSH `{kind:'ask'}` → approval 服务，无 agent 自动降级 deny）。**独立审查（2fed9f16，对照 blast-radius ps1 + dsh-tools 契约）发现 3 漏拦 + 7 误伤，v3 已全部修复**：git 子命令解析式检测（`git -C/-c/git.exe` 不再绕过整个门禁）、isDestructiveSql 语句级+剥注释+大小写（`DELETE FROM a; SELECT...WHERE`、`UPDATE public.users SET`、`/* WHERE 1 */`、大写 SQL 不漏拦）且限定 SQL 上下文（grep/echo 不误伤）、force/main 检测限定真实子命令（commit message 含 "push +5"/"main.rs" 不误伤）、`--force/--mirror` 补 `(?<![\w-])`（`abc--force` 不误伤）、移除 rebase 兜底硬 deny（`rebase -i`/`pull --rebase` 放行，与 ps1 一致）、targetsControlPlane 限定用户级根（项目 settings.yaml 不误伤）、SQL 工具入白名单（门禁 4 死代码消除）、run_code 补 fs 直写检查。单元回归 **128 组全过**（含全部审查反例）；安装脚本 `install-kix-p1.ps1` 已纳入同步（幂等）。**如实声明**：当前 DSH 进程的 kixparadigm standing generation 是 v1 时代组装的，运行中不重读磁盘 → v2/v3 新增门禁须**重启 DSH 进程**后新会话复验（§5 项 6 挂账）。另修复 P0 工程缺口：源仓库此前无 kix-guards 副本（重装 preset 即丢门禁），现已纳入 `plugins/` + README 恢复清单第 5 项。**保持不接**（规则是负债 + 0% 误报）：角色边界（Producer/Orchestrator 源码黑名单，exec.agent 无角色标记）、预算一致性软警告与 progress/plan 开关（建议类不进机械层）、档二 10 tools/result 观察器（workflow schema 已是机械强制，重复机制=负债）、SQL 文件引用检查（psql -f，文本纪律覆盖） |
| P1 | 8：/kixpower-* 注册为 DSH 原生命令 | ✅ 已落地（安装 + E2E 已验） | 插件源 `dsh/preset/plugins/kix-commands.js`；安装脚本 `skills/kixpower/scripts/install-kix-p1.ps1`（用户 shell 运行，复制插件 + 幂等追加 agent.cordis.yml 挂载行，已实测幂等）。**模型无法直接写** `~/.dsh/.agent-presets/`：kix-guards CONTROL PLANE 门禁实测拦截（design intent，防 prompt injection 篡改用户级配置；不绕过）——2026-08-15 由用户显式委托执行安装脚本。E2E：`standingKeyFor('kixparadigm')` 挂载校验通过；新会话敲 `/` 见 5 个候选；触发 `/kixpower-new` 返回「已注入（4614 字符）」且模型按流程执行（访谈开始） |
| P1 | 9：跨厂商矩阵进 settings + 能力元数据校验 | ✅ 已启用（2026-08-15 前已配置；跨厂商观察者 v5.9 起为 kix-route 自动取反路由（手工钉值同步已废除））+ 文档化 | settings.yaml 已有 `zai-coding-cn`（GLM-5.3 路由，models 清单含 glm-5.3/5.2/5.1/5-turbo 等）+ `zai-vision`（GLM-4.6V 完整 profile）；能力元数据校验 = `resolveModelInfo`（contextWindow/maxTokens/reasoning 档位），见 §3.1 |
| P2 | 10：验证 gate schema 化 | ✅ 已落地（workflow 入口） | `skills/kixpower/templates/kixpower-workflow.template.md`：QA 用 `agent(prompt, {schema})` 机械强制验证报告结构（verdict/evidence/blockers），subagent 工具无 schema 参数 → workflow 是唯一机械验证入口 |
| P2 | 11：团队编排 workflow script 化 | ✅ 已落地 | 同上模板：Producer→Dev(pipeline)→QA(schema 强制)→汇总；含失败纪律/边界/陷阱 |
| P3 | 12：cordis preset 做 kix 自研原型 | ✅ 方案已定（零配置） | 用 DSH 出厂 `cordis` agent preset 开新会话即得 cordis_* 工具集（config/agent-presets/cordis，随安装目录存在，无需改任何配置）；详见 §3.2 |
| 边界 | 13/14/16 纪律写入 kixparadigm 技能（ralph 限发散等） | ⛔ 保持禁止 | 须经真实任务验证后晋升（§5），未改规则层 |
| 更新 | kix-guards v5（2026-08-15，用户决策）：ask 级门禁改聊天内提问 | ✅ 代码/测试已验（164 组断言）；⚠️ 真实拦截 E2E 待重启后新会话复验 | `dsh/preset/plugins/kix-guards.js` v5：人类确认点（reset --hard/clean -f/branch -D/stash drop/checkout --/restore/普通 push/GitHub mutation）从 `{kind:'ask'}` → approval 服务弹窗改为 `ctx.userQuestions.ask()`（ask_user_question 底层服务）聊天内提问，用户答「允许执行/拒绝」；审批策略 danger-full-access 恢复 approval: never（web cordis.patch.yml，2026-08-15）——全自动零弹窗；降级路径（无 userQuestions/无 agent/子代理 DELEGATED_CALLER/提问中止）→ fail-safe deny |
| 更新 | kix-guards v7→v9（v8 = v1.2.10 自审整改；v9 = v1.2.11 发布/评论等确认类门禁降为软约束） | ✅ 代码/测试已验（当前 210 组断言，含事故回归用例）；已部署 kixparadigm + kixparadigm-en 双安装（hash 校验一致，含根 plugins/ 副本同步治 drift）；⚠️ 真实拦截 E2E 待重启 DSH 后新会话复验 | `dsh/preset/plugins/kix-guards.js` v7 commit budget 三重修复：① reflog 计数改 %gs 口径只数 commit 类条目（reset/merge/pull/checkout/rebase 不计——不惩罚推荐的历史修整工作流；amend 只进 hard cap 口径、不进 budget 口径）；② marker 指向的 sprint 已有 done.md → warn 并回退最大编号目录，最大编号也已完结 → staleAll 标注进 deny 消息；③ 预算兜底链 progress.commit_budget > plan.task_sizing.derived_commit_budget > plan.blast_radius.max_commits > 冷启动 3（落冷启动必 warn），且显式 commit_budget=3 不再被「值等于默认」判断误覆盖（v6 潜伏优先级 bug）；deny 消息注明预算来源与 sprint 目录，移除误导性「按 DAG 重算」措辞。仓库侧配套：dae 开 sprint-10（hotfix 记账，commit_budget=8）+ marker=10 |

### §3.1 能力元数据校验（P1-9 剩余文档化）

- `resolveModelInfo()`（llm 服务）向拥有精确 provider/model 路由的适配器查询一次：返回 contextWindow / defaultMaxTokens / reasoning 档位。catalog 只是建议非白名单——未列出模型 id 原样透传。
- kix 用法：分派子代理前可用它校验「prompt ≤ 5K tokens」假设（对照 contextWindow 而非猜）；compaction 阈值由 harness 管，不重复测量。
- 新增厂商两步法（DSH-ADAPTATION §3 已写）：settings.yaml `llm-pi-ai.providers` 加 profile（apiKeyEnv 引用密钥，绝不写明文）+ preset agent.cordis.yml 加对应 subagent 工具行（agentOptions.provider/model 覆盖路由，已实证）。

### §3.2 cordis preset 原型切换（P3-12）

- **零配置路径**：DSH 出厂自带 `cordis` agent preset（安装目录 `config/agent-presets/cordis/`），新建会话时选择它即获得 `cordis_*` 五工具 + 组合编写技能。**不修改 kixparadigm preset**（默认组合保持无 cordis 工具 = 安全面最小）。
- 用途：kix 自研（改 preset/guards/新 gate 原型）时开 cordis 会话：`cordis_define` → `cordis_run`（浏览器半需页面有人点允许）→ 看效果 → `cordis_undefine`；试成落盘为静态资产。
- 信任：官方文件头明写 TRUST = shell 访问级；vm 非安全边界。用完即关会话。
- 自研 kix 时亦可临时 patch 到 kixparadigm（需用户手动改 agent.cordis.yml，见 P1-8 同款门禁约束）。

## §4 证据与方法（可信度标注）

- **12 组分工**：①agent 循环/session ②子代理编排/goal/ralph ③工具层 ④压缩/保留 ⑤沙箱安全 ⑥持久化/存储/凭据/设置 ⑦LLM/提示词 ⑧Web/宿主 ⑨基建 ⑩UI 全套 ⑪Web 通信细节 ⑫动态插件（前一任务）。
- **跨厂商**：②④⑥⑧由 GLM(zai-coding) 读，其余 DeepSeek 读；组级机制无跨厂商分歧 → 高置信。
- **已知缺口**：dsh-web-frontend 无 README（纯 vite 构建产物，据 package.json）；个别 README 超长行截断但机制已覆盖；所有机制均来自 README 声明，未经运行时实测。
- **命名陷阱备忘**：`dsh-web` 是 web 搜索/抓取能力包，**不是 GUI**；GUI 链是 web-app→web-frontend→client-web→client-*→host-*。

## §5 待验证项（晋升候选，未经真实任务验证前不得写为规则）

1. ~~「kix 的 slash command 注册为 DSH 原生命令」的收益假设~~ → **P1-8 已落地并 E2E 坐实**（2026-08-15）：插件源 + 安装脚本 + 单元回归（6 组断言）+ GLM 独立审查（✅ 可安装，0 blocking）+ `standingKeyFor` 挂载校验通过 + **实机 E2E**：新会话敲 `/` 见 5 个 kixpower 候选；触发 `/kixpower-new` 返回「已注入 kixpower-new 流程（4614 字符）」且模型下一轮按流程执行（阶段 0 访谈开始）。
2. 「结构化输出 schema 化能替代 kix 验证 agent 的自觉纪律」——需在真实验证任务中对比误报率（P2-10 模板已就绪，待首个真实 workflow 用例验证）。
3. 「ralph 限发散阶段」——需一次真实发散/收敛任务对照实验。
4. 「workflow 脚本化 kix 团队 vs 手动 subagent 分派」的产出质量差异——需同一任务双路径对比（P2-11 模板已就绪）。
5. 档一 1-7 的「直接依赖零改造」声明——每项在首个匹配任务中验证后即视为坐实。
6. **kix-guards v3 新增门禁的真实拦截**（2026-08-15 挂账）：128 组单元测试（含独立审查 3 漏拦 + 7 误伤反例）+ 挂载校验已过，但当前进程 standing generation 为 v1 时代组装（运行中不重读）——**需用户重启 DSH 进程**（Ctrl+C → `dsh web`）后，新会话实测 v3 分支：psql 客户端 deny、git -C push --force deny、git push origin feature ask、MCP GitHub 写 main deny、UPDATE 语句级 deny。重启前 P0 行保持 ⚠️ 状态。**v4 更新（2026-08-15）**：GitHub 门禁误拦修复（只读 get_/list_/search_ 放行、mutation 按工具名精确匹配），单元回归扩至 **142 组全过**；挂载校验复验 OK（standingKeyFor）。E2E 实测项仍待重启后新会话进行。

## §6 动态 Cordis 插件实测机制事实（2026-08-15 kixst stalled 原型，E2E 坐实）

> 来源：kixst-5 插件 9 个 Package 迭代 + GUI 实机敲命令验证。**不是规则**，机制事实层。

### 6.1 `harness.defineTool` 注册动态工具的精确契约（4 次失败迭代得出）

- `parameters` 是**属性映射 DSL**（`{ root: { type:'string', description } }`），不是 JSON Schema 包装 `{type:'object',properties}`——传包装报 "parameters must be a ParameterSchemaSpec object"
- 隐式 `root` 参数开放：`additionalProperties` 必须 true 或省略（否则 "the implicit parameter root is open"）
- `output` **必填**且须为 `{ schema, render, presentationMeta? }`（schema 用 ValueSchemaSpec，如 `{type:'json'}`；render 返回 ContentBlock[]，如 `[{type:'text', text}]`）
- `execute` 放在 `defineTool` options 内（不是 registerTool 时附加）；`harness.registerTool(ctx, tool)` 只接受 `defineTool` 产物（"must use a tool returned by harness.defineTool"）
- 动态注册的工具**不出现**在 `cordis_inspect_query Tool.listTools` 结果里（Inspect 只反映静态工具）；验证靠真实调用或 GUI

### 6.2 插件上下文异步与写文件（关键陷阱）

- **命令 handler 内的 `await fs.*` 链路可靠**（commands runtime 会 await handler 的 Promise）——/kixst-enable 写 PROJECT_BRIEF.md、/kixst-check 扫描均 E2E 通过
- **apply 里 fire-and-forget 的裸 Promise 异步链不可靠**：apply 返回后脱离插件生命周期，扫描/写报告静默无输出（console.error 仅进宿主 stdout，无文件落点）——诊断成本极高，应避免
- 插件写文件需显式 `sandboxPolicy.resolve({mode:'workspace-write'})` 传入 `writeText` 第 5 参（省略时默认策略可能拒写）；命令 handler 上下文 + 显式策略 = 可靠写路径
- `ctx.get('sandboxPolicy')` 在插件上下文可用；`workspaceRoot` 有值（与 sandboxPolicy 服务契约一致）

### 6.3 原生命令注册契约（对照 kix-commands.js 静态插件，动态插件同构）

- `ctx.commands.register({ name(小写无斜杠), description, input:{hint}, handler({agent, rawInput}) → CommandResult })`
- CommandResult = `{kind:'success', text?} | {kind:'error', text}`；handler 同步/异步均可，结果由 UI 直接渲染（GUI 命令卡片，零 token 不进模型）
- `command/run`+`command/done` 日志事件对（recordInput 默认 true 记录 rawInput）
- 动态插件注册的命令在 GUI 输入框敲 `/` 候选可见（E2E 实测：/kixst-enable 候选出现并执行）

### 6.4 L3 档 A 落地形态（kixst，2026-08-15）

- **减法后形态（当前）**：只保留 `/kixst-check [root]` 命令（零 token、只读、无状态）+
  `kix_stalled_check` 模型工具。阈值固定 24h（参数化待真实项目定夺）。pkg-15 E2E 通过。
- **减法决定（2026-08-15，范式「规则是负债」）**：原三命令形态（enable/disable +
  frontmatter 持久化 + 惰性定时器 + steer 提醒）无真实项目证据即常驻/写入，属过拟合雏形；
  已全部移除，**代码保留在 pkg-14 原型历史与本文件下述记录**，真实项目证明需要后按需恢复。
- 曾实现并 E2E 验证（保留作恢复参考）：三命令 + frontmatter `l3_stalled_check: {enabled, threshold_h}`
  写/删落盘验证通过；惰性定时器（enabledRoots 空不启动，间隔=min(threshold)/4，下限 60s）；
  tick 检测 stalled 集合**新增**时经 enable 缓存 agent 的 `agent.steer` 注入一条 user 消息（去抖）；
  会话级 opt-in（重启需重新 enable）。E2E 证据：GUI 敲三命令全部成功、frontmatter 落盘验证、
  判定正确（123h 判停滞 / 1h 正常 / done 不误报）。
- **token 预算对照（2026-08-15）**：命令通道绝对零 token（command/run+done 为 log-only，
  契约明文 never model surface，结果只在 UI 渲染）；工具通道紧凑（3 sprint ≈ 0.2K tokens，
  最坏 100 sprint ≈ 2-3K，DSH toolResultPruner 对超限输出自动裁剪兜底）；曾有的定时提醒
  （steer 注入触发模型轮次）是唯一常驻成本点，已随减法移除——恢复定时形态时必须重估此维度。
- **融入 workflow**：`skills/kixpower/templates/kixpower-workflow.template.md`「Preflight：stalled
  门禁」节——机械检测走 /kixst-check（零 token），恢复决策走用户 /kixpower-continue；
  Producer prompt 加模型侧双保险（脚本层无法机械检测，workflow 无 fs/命令能力）。
