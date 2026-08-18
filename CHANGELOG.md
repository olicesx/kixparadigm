# Changelog


## v1.2.23（2026-08-18）kix-browser 原生浏览器自动化（按需激活）+ E2E 方法论沉淀

- **kix-browser 插件**：原生 `browser{action}` 单工具 17 动作（open/snapshot/text/click/type/press/select/hover/back/forward/reload/wait/screenshot/upload/tabs/dialog/close）——playwright-core 直驱替代 MCP 五跳链路（本宿主 MCP 解析层损坏实证：navigate/click ToolNotFound）。CDP attach 优先（`KIX_BROWSER_CDP` 接管真实浏览器，登录态保留）+ launch headless 兜底；会话跨调用持久（插件态句柄 + 串行队列）；URL 门禁（仅 http/https/about:blank）；弹窗默认驳回 + `dialog{auto}` 策略 + lastDialog 回报；playwright-core 懒 require（缺装不阻塞装载，错误带跨平台安装指引）。
- **渐进披露合规**：yml 挂载行默认注释（零常驻 schema 税）——kix-focus `ACTIVATABLE_TOOLS.browser`（新增 `pkgPath` 本地解析路径）+ browser-native 目录组，`kix_capability_call` 首用自动挂载、下一轮直呼、`kix_tool_deactivate` 卸载。源码定谳：**restrict 裁不掉本层自有注册**（dsh-tools：restriction 只过滤继承面）——preset 层插件渐进披露必须走 ACTIVATABLE 路径。
- **故意排除**（范式红线/低频）：页内任意 JS evaluate（blast-radius 红线，需要时 pwsh 直驱脚本=代码级可审查）；网络拦截/cookie/PDF/拖拽（脚本路径）。
- **质量链**：kix-browser 单测 12/12（zh/en）；E2E 真浏览器 11 步全绿（含 click 真实跳转→导航闭环→file:// 拒绝）；kix-focus 111/111（含 pkgPath 激活路径集成断言）；枚举防线先拦住一次描述漂移后同步；全插件套件 0 fail；CONSISTENCY OK；zh/en 字节镜像。
- **E2E 方法论（memories 沉淀）**：编排对照 ⑥/§5.4/① 三条量化证据——**微小子任务扇出/包链反而更慢更贵**（载体固定开销需子任务时长摊薄；稳赢项=主线程步数与 cache）；**部署卫生铁律**：E2E 对照结论仅在 preset 同步部署（diff=0）后有效（旧部署伪影 4×墙钟差实证）；wsl.exe 驱动纪律：`$(...)` 赋值与嵌套引号必坑，探针一律脚本文件经 `/mnt/c` 执行。
- **坑实录入档**：`$$eval` 字符串函数体在该版 playwright-core 返回 undefined（必须真实函数引用）；重构 open 分支误置会话门禁后被自己拦死（单测盲区=只测校验路径，E2E 补成功路径断言）。
- **仓库卫生**：`.kix-tmp/`（本地 E2E 脚本，含机器绝对路径）入 .gitignore；README 三份（zh/en/preset）补 kix-browser 行。

## v1.2.22（2026-08-18）编排纪律自迭代 + workspace/distribution 收敛

- **宽冻结回收为 exact claim**：后台观察者在飞时只冻结 `(claim, evidence cursor/measurement)`；同文件的正交 claim 与主线程综合可继续。发布依赖的最后验证改 foreground，final 前关键观察者必须结算。
- **交接与回流语义修正**：41-step gate 仅由 foreground `subagent_lite` 或 `create_goal` 完成交接，background spawn 不解锁；小结果 final-only，只有大结果落 artifact 并回路径/结论/状态。`run_code`/native 取舍压成 task-shape 一行常驻锚，删除重复候选规则。
- **门禁降噪**：正常动态窗口 + usage/tokenMeter 路径只由 token 预算 hard gate，step 41 降为计量缺失 fallback；handoff 成败改读完整 JSON envelope，报告正文引用 {"ok":false} 不再误锁。
- **工具能力恢复**：run_code 受限能力检查改为 executable-surface 扫描；字符串/注释/非 tagged template raw 可承载补丁文本，regex/division/tagged-template 歧义保留原文 fail-closed，真实 Node/network/fs/codegen 能力继续拒绝。depth-1 child 仅恢复 lite，maxDepth=2 + 静态/动态 toolFilter + proxy-target guard 拒绝 depth≥2/regular/cross/goal/workflow。
- **Escalation 调用纪律**：宿主成对校验保持不变；首次调用省略 sandbox_permissions/justification，仅真实 denial 后成对重试，approval disabled 时永不设置。
- **workspace 与 discipline 正确性**：discipline/orchestration 统一复用 session-cwd-first resolver；discipline 按 source/test/documentation/artifact 分类，只对 source 做 spec/green gate；`loadSpec()` 仅在 in-flight 期间共享 Promise，完成后释放并保持 save-after-load cache 一致。
- **验证链修复**：`kix-discipline.test.js` 异步断言由 Promise 假绿改为真实 await，并修正 pre/post/turn agent identity；补 cwd precedence、mutation classifier、foreground handoff 与 mirror-tree 回归。
- **分发单源**：`dsh/preset/plugins` 成为 commands/guards 唯一实现；Copilot installers 按 `SKILL.md` 动态发现全部 skills、只导入精选 memories；在 plugin 目录执行零参数 Node `--test`（Node 20+）动态发现插件测试；consistency 守 vision bridge 整树与 install-lib 实现镜像，删除 README/memory 易变计数契约。
- **反方门禁审查**：修复 `git --work-tree <path> commit` / `--exec-path` 等长 option 吞掉子命令的绕过，以及任意短 flag 错吞下一 token；改为 shell segment + leading command + Git option arity 解析。`verify-guards.js` 改为带 expected 的语义矩阵，可明确报告已安装 preset 与 canonical source 漂移。

## v1.2.21（2026-08-18）预算完全动态化 + 分档上调 + persona 压缩

- **budgetRatioTiers 完全动态化**：resolveBudgetTokens 改为按运行时窗口分档取比例（≤128K→0.85、≤400K→0.65、≤1M→0.40、>1M→0.35），废止 150K 默认帽——absoluteCapTokens 150K 仅作无窗口回退与用户可选硬顶；窗口不可得时不再强动作。相对 1.2.20（npm）的三档 0.35/0.30/0.25+150K 硬帽，小窗口模型交接点 45.9K→111.4K（128K 窗口）、400K 窗口 120K→260K。
- **预算分档上调**：≤128K 档 0.35→0.85、≤400K 档 0.30→0.65（用户裁决）——小窗口 handoff 固定开销占比高，尽量用满窗口、减少过早交接；斜率语义「比例随窗口递减」。
- **persona 压缩**（-884 chars zh / -1288 en，双份同步）：删除与 gate 注入/宿主工具 schema/技能目录重复的机制复述 7 行/份（预算细节/effort 分类器/工具面清单/子代理面/资源行/pwsh 括号/三检字段枚举），保留全部行为锚点——还清「机制细节由插件强制，常驻层只放思考锚点」原则债。
- **编排纪律新记忆**：memories 4→5（orchestration-lessons：顺序依赖链单元化/无依赖才并行/gate 触发仅整链交接或 create_goal）。
- **kix-focus**：subagent_lite 档位守卫（maxTokens ≤8192 反锁拦截）。
- **脱敏**：local-e2e 四脚本用户名硬编码改为脚本位置推导（$(dirname "$0")）。
- **一致性**：kix-consistency 门禁同步 5 记忆断言；zh/en 镜像 hash 一致；双包 73/73 测试绿。

## v1.2.20（2026-08-18）定版段

- **版本更新**：提升至 1.2.20，双包（zh/en）版本对齐，check-consistency 同步
- **预算分档**：resolveBudgetTokens 实现分档（0.35/0.30/0.25）上下文比例逻辑
- **镜像一致**：kix-guards、kix-guards.test、kix-budget、kix-budget.test 中英双包镜像 hash 一致

## v1.2.21 前置（2026-08-18）WSL2 rc.7 升级实测

- **升级**：WSL2 dsh `0.1.0-rc.6 → 0.1.0-rc.7`，preset 同步 + web 重启 + `DEPLOY-CHECK-ACCEPT`（28 PASS）一次通过。
- **真实任务三连（33236 API：session.create/session.prompt，preset 自动加载）**：8×3K ENDMARK 全对、3×10K BIGMARK 全对、强制全文 cat 触发㉓急剪（prune=1 + 配对 replacement=1，ctx 19.7K）；全程零持久化错误，streak 提醒注入且模型正确响应。
- **rc.7 适配裁决：零适配**——`toolResultPruner` 服务名未变；默认 `thresholdChars` 2048→8192 由插件的 config 动态感知设计自动消化（3K 不剪/10K 剪两侧行为均正确）；tool/result 形状兼容；RPC 面不变。
- **验收器**：B/C/D/E/F PASS；A/FOCUS 为谓词范围错配（小会话按设计触不到 41 步/150K/goal 生命周期）。
- **41 步 gate 实弹（session-1d549821，rc.7 首测）**：45 小文件逐步 cat + 3 大文件任务跨 41 步——**DENY 精确命中 turn=1 step=41**（realDenies=1，verifier A PASS），模型按 gate 指示经 subagent_lite 交接后继续，48/48 标记全收、零持久化错误；B FAIL 为模型自发优化（gate 后大文件改 tail 读，180 字符低于阈值，不剪正确）——㉓ 实弹证据由前轮账本（prune=1+配对 replacement）覆盖，两账本互补全谓词。
- **浏览器直连 E2E**：零依赖 CDP（Node24 WebSocket + DevTools Protocol + Edge headless，本会话 Playwright MCP 桥故障的绕行）；真实用户链路全通：点「新建会话」→ 键入任务 → 点「发送消息」→ session-92df18f1 执行（b1/b2/b3.txt BROWSEMARK 全对、cat 回读、零错误）。报告 `tmp-analyze/rc7-e2e-report.md`。

## v1.2.21 前置（2026-08-18）交付前整体自检（kix-budget v6 变更集）

- **e2e 实弹（最强证据）**：自检会话本身作为被测对象——kix-budget 在生产环境两次实弹触发（连续 8 步只读 streak steer → 第 41 步 deny 普通工具 → subagent_lite 交接 → gate 解除 → 再触发再交接，完整双循环）；活账本（110 步 / 6 回合）replay `REPLAY-ACCEPT`、verifier 六谓词全 PASS `LIVE-E2E-ACCEPT`（2 真实 deny、37 prune 全配对 replacement、0 持久化错误）。
- **verifier v2 根因修复**（`local-e2e/verify-budget-e2e.cjs`）：①纯 node 多帧 zstd 解压（DSH 每事件一帧级联流，单帧解压只出 203 字节假象——曾误导子代理产出「空账本」结论；免外部 CLI，Windows 无 zstd 可跑）②谓词 A 增加真实 deny 等价通道（`isError:true` + gate 文本；机制契约：回合内完成交接则 turn-stopping steer 按设计不触发）③谓词 C 只计 `isError:true` 结果——修复源码文件读取回显被误计为插件错误的结构性误报（8→0）。
- **测试证据链补齐**（观察者 4 GAP 全关）：git tag/remote/update-ref 写操作反例 + `--list`/`-v` 保守否决文档化断言；`{ landed }` 返回形态用例；缺 `config.thresholdChars` 回退默认 2K 用例；75K prune 线标签纠偏（pruneRatio 0.5×150K）。
- **缺陷修复**：en 包 `npm test` 链漏挂 `kix-budget.test.js`（本轮加测试时只改了 zh 链）——补挂后双包 67/67 全绿且结果完全一致。
- **自检结论（三通道）**：哲学冲突 2 项 FINDING 均被裁决反证（`agent.cordis.yml:91` persona 明文契约 + `hardHandoff:false` 逃生口 + 双循环解除实测 + 触发区 41 步/150K 远超正常回合）；能力不降（gate 只路由不改可用面，白名单为文档化交接契约）；token 效率主张 A/D/effort 证据充分、B/C 补齐至充分。zh/en 全套件 + CONSISTENCY OK；Windows 安装副本与源逐字节一致。
- **过程缺陷如实记录**：子代理两次误报（「空账本」= 单帧解压陷阱；「测试文件损坏」= 其自身编辑事故，主线程从安装副本恢复重建）——印证「子代理产出需物证裁决」纪律；lite 权限门禁拒跑全套件为按设计行为。

## v1.2.21 前置（2026-08-18）kix-budget v6 主会话闭环

- **㉑/㉕ 运行时交接 gate**：`agent/pre-step.step` 与运行时模型窗口驱动主会话状态；第 41 步或动态预算超线后，`tools/pre-execute` 拒绝普通工具，只放行 `subagent_lite`/`create_goal`；只在目标工具真实成功（含嵌套结果）后解除 gate。
- **㉓ 结果剪裁**：单结果按宿主 `toolResultPruner.config.thresholdChars`（默认 2K）在下一步边界剪裁，兼容宿主 { pruned, charsRemoved } 返回形态；保留 compaction/prune 与 tool/result replacement 账本证据。
- **㉒ 分类修正**：git `config/branch/tag/remote/update-ref` 等写操作不再被只读 allowlist 误判；模型窗口解析失败或返回空窗口均不缓存，允许下一步重试；usage 缺失时改由 tokenMeter 感知上下文。
- **验收**：Windows zh/en kix-budget 60 项全绿；WSL2 全局版本锚定 `dsh@0.1.0-rc.6` + `kixparadigm@1.2.19`/`-en@1.2.19`，当前安装副本默认配置实测 53 步 gate、40 次 paired replacement/prune，账本通过 `LIVE-E2E-ACCEPT`；F3/F4 延迟卸载账本通过 `FOCUS-E2E-ACCEPT`。
- **WSL 复验（调度纪律 trial #2）**：预检抓到 WSL 侧 `kixparadigm-en` preset 副本滞后（kix-budget.js 停在旧版：源更新后只重装了 zh 未重装 en），且 `check-deploy.sh` parity 段只比对 zh 副本、漏 en——已修为两 preset 各对自身源 cmp（parity PASS 行 2→4），重装 en 后两 preset 全 20 插件文件 wholesale hash MATCH。全套重跑五绿：DEPLOY-CHECK-ACCEPT / LIVE-E2E-ACCEPT / FOCUS-E2E-ACCEPT / GATE-CLEAR-E2E-ACCEPT / CHILD-E2E-ACCEPT。33236 API 新鲜端到端复现：发现 glm-4.7 把 child 报告放进 reasoning 块的行为方差（报告未送达 parent，E 谓词正确拒绝——不弱化），夹具第 4 步加硬为 run_code console.log 确定性打印 + 正文重述后一次通过（`--root-kix-child-trial2--/422007af-*` 五项全 PASS）。
- **F5 child E2E 闭环（verify-child-e2e v2）**：实测确认 lite child（`subagent_lite` 派发，5-6 工具只读面 + run_code）的工具面裁剪在 **SDK tools 表层面强制**——child 的 run_code 内 `tools.subagent`/`tools.kix_capability_call` 访问即 `TypeError`（"is not a function"），不存在「发出 tool/call(name∈denied) → 门禁拒绝」的记账通道（v1 谓词假设了该通道，结构性不可达成）。v2 C 谓词对齐机制现实：要求两条越权路径（subagent 直呼 + kix_capability_call 代理）的主动探测（run_code arguments 引用）与对应 `tools.X is not a function` 证据同时在场，强度不低于 v1。33236 服务 API（`session.create`/`session.prompt`）驱动真实 lite child 账本，五项全 PASS：`CHILD-E2E-ACCEPT`（ledger `--root-kix-child-lite-e2e--/a3df3195-*`）。附带发现：headless profile 不加载 agent preset（无 kix 面）；完整 `subagent` 派发的 child 是 25 工具 Claude-Code 风格面（含编排工具、无 run_code）——A 谓词的 denied 集只适用于 lite 档。

## v1.2.19（2026-08-18）v5.11/v6 运行时闭环

- **㉙ 复杂度感知 effort**：子代理首个 pre-step 使用零 token 分类器区分琐碎、常规和深任务，结合模型能力门控选择 effort；显式 effort、档位、maxTokens 仍保持权威，lite 不静默升档。
- **㉑-㉕ kix-budget**：运行时窗口、`tokenMeter`、step 计数和 session event 驱动 gate、handoff、急剪与结果 replacement；主/child 边界按运行时深度和 session header 感知。
- **㉖ run_code 文案勘误**：run_code 是保留传输名，继续存在于 child 工具面；deny 编排工具的镜像段才从子代理可见面移除。
- **E2E 验证器**：预算、focus 延迟卸载和 child deny 均只接受结构化 ledger 证据；无真实 child deny tool-call 的夹具保持拒绝。
## v1.2.15（2026-08-17）kix-consistency 泛化：自感知边界 + N 份身份组

- **该相同的数份必须相同（N ≥ 2）**：`checkIdenticalSet` 一次比 N 份（缺一份 / 任一份与锚点字节不同都失败）；身份组不再写死 zh/en 一对——按自感知 preset 根展开，加语言 / 加 preset 自然进组
- **边界即 preset 根**：preset 根 = 同时含 `agent.cordis.yml` + `preset.yml` 的目录（DSH 布局双标记压假阳性），深度 ≤2 扫描（跳过 `.*` / node_modules）。任意仓库发现 ≥2 个 preset 根才引导；单 preset / 普通项目零开销放行——触发不再按 kixparadigm 指纹硬编码，自定义布局（如 `pkgs/zh` + `pkgs/en`）同样被发现。**非 preset 根路径天然出组（CI 与写时都不比）——边界是自感知推论，不设任何逐路径豁免规则**
- **契约层自声明**：persona 预算 / memories 计数 / README 表述 / 版本对 / vision-bridge 对只对自带 `scripts/check-dsh-consistency.cjs` 的仓库开（仓库自己携带契约入口 = 自声明适用 kix 全量契约），外仓不硬套本仓常量——防过拟合；`presetRoots` 配置可显式声明身份组根覆盖扫描
- **kix-guards v13 控制平面 = 安装面（少即是多）**：v3 的裸 `agent.cordis.yml` 兜底分支删除——它误伤源仓库（v11 硬编码豁免、v13 谓词注入两轮补丁皆是给它打的），而「源 vs 安装副本」本是「该相同的数份」的领域：源/外仓 preset 写归 kix-consistency（身份组 + parity hint + 契约层）管，guards 只管安装面（`~/.dsh` / `.agent-presets`）。无豁免、无谓词、无逐路径规则——上一版（PR 内）的谓词注入机制整体移除。诚实边界：cwd 在安装目录内的相对路径写不提醒（那本就是 v12 已放行的显式自迭代）。单测 kix-guards **239 → 243**
- **parity hint（未描述形态靠提醒感知）**：根内非 plugins 路径（skills/agents/instructions/prompts/memories（无契约时）/persona（无契约时）等）写时发一次启发提醒——不断言失败，只把「其它根对应份是否需要同步/翻译」交给模型判断（翻译关系机械校验必误报，zh/en 结构本就不镜像）；remindOnce 每会话一次限噪；block/ask 强度不作用于 hint（无失败可拦）
- **shell 写入不做机械提取（评审否决）**：曾实装 pwsh/bash 命令路径提取通道（pre 登记 / post 复验），WSL2 实弹暴露连字符字符类 bug 后按「规则是负债」复审——命令文本启发式提取覆盖差（间接写不触发）、误提取风险真实、细节 bug 靠实弹才暴露，**整体删除**。shell 通道的同步感知交给软启发（write/edit 的 parity hint 已立起「其它根对应份」维度，模型在 shell 任务同样带着意识）+ CI 全量兜底。该机制从加到删的完整闭环是范式自我应用的记录
- **首派发兜底（WSL2 实弹实锤修复）**：live 会话**首次**工具派发可能解析不出会话 cwd（agent 无 session）——首写提醒永久丢失、第二写才靠状态自愈触发（复现探针 variant B/C 实证）。修复：工作区根不可解析时，从写入目标绝对路径反推「含 ≥2 preset 根」的最近祖先（同一 `discoverPresetRoots` 判定，不猜 cwd），找到即固化进会话状态。同时漂移消息去重（曾三连 missing）、pre-write 对不存在目标跳过语法检查（missing 噪音）
- **post-execute 注入合并（WSL2 实弹实锤修复，系统性）**：4 个插件 8 个注入点裸返回 accept-decision **短路瀑布**——先挂载的注入器饿死后挂载的监听器（实证：kix-discipline 首编辑注入后，kix-consistency 的 post 永远收不到同一调用，首写 hint 丢失；第二写 discipline 无待注入才放行）。修复：`consistency-lib.appendContexts`——注入点先 `await next()` 拿下游 decision 再合并自己的 contexts；非 accept 下游（block 等更强决定）原样放行。kix-guards / kix-discipline / kix-orchestration / kix-consistency 全部注入点统一走合并。单测 kix-consistency **107 → 118**（堆叠监听器首写双投递回归 + appendContexts 纯函数）
- 单测：kix-consistency **54 → 111**（外仓自定义布局 / 边界外路径 / 单根零开销 / 契约分层 / N 份漂移与缺失 / parity hint 与 remindOnce / edit 工具 / shell 零开销边界（无机械提取）/ block+ask 强度免疫 / N=3 根点名 / 双 agent 独立 / 深路径与扩展名形态 / 类别隔离 / 堆叠监听器双投递 / 首派发兜底）；kix-guards **239 → 243**；WSL2 安装副本外仓夹具实测 + 5 轮真会话实弹（3 个 mock 全漏 bug 修复后全过 + 会话恢复验证）

## v1.2.14（2026-08-17）插件化续：P5 两项机制化

- **kix-consistency 新插件**：一致性守护写时拦截——`check-dsh-consistency.cjs` 拆核为 `consistency-lib.cjs` 纯函数核心（CI 脚本与插件共用单一事实源，防「CI 一套、运行时一套」双源漂移）；写 `dsh/preset/`、`en/preset/`、README*、package.json*、vision-bridge 相关文件时按路径跑相关子检查（persona 预算 / 插件对同步 / memories 计数 / README 表述 / 版本对 / 单文件语法），失败 remind（默认）/ ask / block 可配；仅源仓库指纹工作区触发，其余零开销放行；remindOnce 每会话每类别一次
- **kix-orchestration v11**：plan.md 契约写前校验——写 `docs/sprint-N/plan.md` 时校验预算链字段（`task_sizing.derived_commit_budget` / `blast_radius.max_commits`，缺则预算静默落冷启动 3——sprint-9 事故形态）+ 任务清单存在性；只对 write 全量写入校验（edit 拿不到完整新内容，0 误报纪律不猜）；默认 remind
- 单测：kix-consistency **36** / kix-orchestration **77 → 89** 组全绿；zh/en 双包 `npm test` 全绿
- **PR#10 审查修复（三通道交叉验证）**：①kix-consistency 插件源码路由补 `.cjs`（`consistency-lib.cjs` 共享库此前不受写时守护，与 CI 动态清单口径不一致）；②挂起提醒 `pendingRemind` 单槽改 `Map<callId>`——并发多类别写入互不覆盖（投递成功才消耗的契约在并发下成立）；③kix-orchestration v11 plan 门禁补 `st.enabled` 门控（`/kix-orchestration off` 后 block/ask 不再拦）；④plan 路径正则补左边界（`mydocs/sprint-1/plan.md` 误命中）+ 任务清单接受 `*`/`+` bullet；⑤en 侧 DSH-ADAPTATION 补 P5 kix-consistency 缺失段落（PR body 声称 zh/en 同步，en 实缺）+ 断言计数修正（en 侧 69 基数漂移）；⑥补观察者点名测试缺口：Windows 反斜杠路径触发、plan 提醒不烧 sleep 槽（PR 明示 claim 此前无测试）。单测 kix-consistency **36 → 44** / kix-orchestration **89 → 96**，行为修复断言在旧代码上实证失败（区分度验证）
- **PR#10 合并前阻塞修复**：`makeUserMessage` 补非空 `id`（与 kix-discipline / kix-orchestration / kix-focus 同契约）——无 id 的 `additionalContexts` 会写入 `user/message`，DSH session restore 报 `lacks an identified message`，任意一致性提醒都可能使会话重启后无法恢复；`toRepoRel` 把绝对路径 / `./` 相对路径 / Windows 盘符路径归一成仓库相对路径后再分类，堵住「路径写法绕过守护」。单测 kix-consistency **44 → 52**
- **PR#10 WSL2 E2E 实锤**：`kix-consistency` 误把 `sandboxPolicy.workspaceRoot`（部署回退 = `process.cwd()`）当会话工作区——dsh 从 `/root` 启动时指纹检查永远失败，整插件在任意非启动目录工作区静默失效（plan 门禁不受影响，因它只看 file_path）。改为会话 `header.cwd` → `sandboxPolicy.resolve({session})` → 回退根。单测 kix-consistency **52 → 54**
- **kix-guards v11 源仓库豁免**：`targetsControlPlane` 见任意 `agent.cordis.yml` 就 deny，把源仓库事实源（`dsh/preset/`、`en/preset/`）当成安装副本误伤——维护者无法在本仓改挂载注释/计数。安装面（`~/.dsh` / `.agent-presets`）仍优先命中，`dsh/preset/../../.dsh/...` 不能绕过
- **kix-guards v12 控制平面软门禁**：安装副本写从硬 deny 降为 remind（放行 + 注入一次带 id 的提醒）。kix 自迭代 / 用户已授权改 `~/.dsh` 时不再挡正事；源仓库事实源继续豁免不提醒。force push / main / 破坏性 SQL 仍硬 deny

## v1.2.13（2026-08-17）部署复验整改

- **交接 gate 机械注入**：`kix-focus` 编曲成员（qa/dev/reviewer）capability_call 分派自动携带 `current_sprint: N`（工作区 marker `docs/.kixpower-current-sprint` 驱动，`sprintInjected` 返回）+ `kix-orchestration` v10.1 Tri-Block `[CONTEXT]` `Sprint N` 容错解析（双保险，直呼路径也兜底）
- **lite 档 Linux 可用**：`ACTIVATABLE_TOOLS` 快照 toolFilter 平台条件化（v1.2.12 只修了 agent.cordis.yml 行，capability_call 自动激活路径仍报 unknown global tool "pwsh"，部署 E2E 实锤）
- **kix-guards v10.1**：commit-on-main 整链修复——`DANGEROUS_GIT` 补 `commit`。此前纯 `git commit` 不触发 isGitWrite、分支/预算检查永不执行，main 直接 commit 静默放行（部署 E2E 实锤）
- 单测：kix-focus **102** / kix-orchestration **77** / kix-guards **219** 组全绿；WSL2 部署 E2E 三复验全过（lite / commit 拦截 / persona 规则 + 机械注入实证）

## v1.2.12（2026-08-17）iterate-verify-release（PR #6）

- subagent-lite toolFilter.allow 平台条件化（win32→pwsh、其余→bash）——原硬编码 pwsh 使 Linux 部署 tools.restrict() 报 unknown global tool、lite 档不可用（WSL2 E2E 实证）
- kix-guards v10：repoRootFromText 补 `cd <repo> && git commit`（无 -C）命令位提取——会话 cwd ≠ 仓库根时 commit 检查此前静默跳过，单元回归 142→213 组
- persona：Sprint 子代理分派契约行补 `current_sprint: N`，使 kix-orchestration 交接门禁真正触发
- jobs 常驻化 + 细分档位/goal 首次使用自动激活（capability_call 代理即挂载，kix_tool_activate 保留为显式预激活）
- kix-focus symlink 部署跨平台解析修复：候选根链 argv[1]→realpath→插件文件，WSL2 E2E 两轮实测闭环

## v1.2.11 软约束整改（DSH 版）

- 发布/评论/合并/破坏默认不做；用户明确指示（如「评论到PR」）即已决策，直接执行，kix-guards 不再逐次提问。提问只留给真正缺失的决策信息

## v1.2.10 整改（DSH 版）

- 按 KIX 自审修复「0% 误报」反例——QA 完成声明排除负向表述；控制平面门禁只拦写意图（`grep/cat/ls ~/.dsh` 放行）；终端 SQL 改为 DB 客户端命令位 + SQL payload 语句级判定；GitHub MCP 前缀可配置；跨厂商路由跳过未注册偏好候选；中英包卸载不再互相删除共享 vision-bridge；`engines` 对齐 `process.getBuiltinModule` 最低版本
- 常驻 persona 二次还债压至约 1.8K token（CN，原 3.1K）
- 新增 persona 预算/文档计数/双语插件一致性守护与 CI；vision-bridge 补纯逻辑回归并修复完整代码围栏剥离

## 更早

- v1.2.9：编曲模型（activatable 成员档 + Sprint 流程）、kix-discipline 插件化、kix-route modelPreference 配置化
- v1.2.8 及以前：见 git log

