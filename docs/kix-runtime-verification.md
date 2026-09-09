# kix 运行时修复与插件验收记录

> 后续任务：多模态模型的视觉桥豁免见 [kix-vision-exemption.md](kix-vision-exemption.md)。本文记录其之前那轮运行时修复，结论与边界不因后续改动而扩大。

日期：2026-09-08（UTC；本地时间 2026-09-09）。当前状态：源码修复、变体同步、安装和前轮全套回归已完成；本次接续已补原服务重启后的 GUI、插件状态、命令与真实工具运行时验收。没有发现需继续修改源码的故障。外部供应商推理、故障注入及完整 Web 会话执行记账 E2E 不在已通过范围内，具体边界见下文。

## 本轮实际修复

| 范围 | 真实问题 | 修复与验证 |
|---|---|---|
| discipline | 非零/超时/未知返回、后台 spawn 误计成功；测试后修改仍沿用旧证据 | 共享 canonical 终态谓词；job 与编辑代次关联；失败编辑不记账；红绿回归覆盖 |
| discipline | timeout/env/nice 等包装漏记；JS 语法检查缺位 | 保守前缀归一；JS 与 TS 分桶；`node --check` 只支持 JS 语法，不充当 TS 检查 |
| settle | 无执行结果的 run_code 汇总清账；旧观察结果仍当 fresh | 仅消费可见实际执行结果；观察 start/end 绑定编辑代次，无 start 或跨代结果不算 fresh |
| orchestration | ignored 契约变化未进入观察新鲜度检查 | 可选重复 `artifact_input`，按内容核对明确依据；缺失/新增/删除/变化、未知及非法相对路径有回归；不扫描其他任务共享 spec |
| signal | `/kixsig-check` 返回字符串，被宿主 CommandResult 契约拒绝 | 返回规范 success/error，读取调用会话状态 |
| stalled | 默认读取宿主 `/`，扫描 `/docs`，未跟随实际工作区 | 工具与命令按 invoking agent/session 的 cwd 解析，显式 root 优先 |
| browser | 模块全局 page/browser/queue/dialog 被不同会话共享，子代理 close 可关闭主线程页面 | apply×owner 隔离；CDP 新建自有 tab，close 不关借用页；真实 launch/CDP 两 owner smoke 已过 |
| focus | restrict 重试缺 timer 注入、句柄接口不符、effect 注册时清掉定时器 | 自持 unref 定时器和 disposer；暂态失败重试/成功停止/卸载回收用真 Cordis 验证 |
| guards | HOME/USERPROFILE 缺失时漏认 home 下控制平面绝对路径 | 标准 `os.homedir()` 兜底；无 HOME 下正反例通过，既有 advisory 不升级成 deny |
| budget | effect 注册时执行清理，未返回卸载函数 | 两个变体簇分别修 cleanup，默认禁用策略不改变 |
| 认知与技能 | 局部清单替代目标、旧证据外推总体通过、固定双人/多数与默认原则冲突 | 默认 persona 延续目标与约束、按受影响范围重判；共享技能和当前 review prompt 按证据缺口选观察，无新全局权限流程 |

没有修改 DSH 上游 checkout 或 GUI bundle，没有发布、提交或对外评论。默认/classic/en/null 的机械插件修复按实际 identity group 同步；settle 仅在 default/null，budget 两簇的故意差异保留。

## 已完成证据

- 初始 `npm test`：exit 0（bash-14）；现有绿测试未覆盖已复现的真实接口缺陷。
- 各故障先获得红测/真实调用反例，再修复。主要红绿日志在 `/tmp/kix-evidence/`；QA 的独立 Cordis 探针在 `/tmp/kix-plugin-audit-414342/`。
- 独立最终复核发现 epoch 未拷贝 `invalidInputs` 和镜像 EOF 换行丢失，均已修复并再次独立确认关闭。
- `npm run test:pressures`：24/24 通过。
- `npm run test:consistency`：CONSISTENCY OK；所有实际 identity group 逐字节一致，默认 persona 3323 chars / 约1675 tokens，未超预算。
- 最终 `npm test`：exit 0（bash-16）；最后插件测试批次 38 tests / 37 pass / 1 skip / 0 fail。skip 是 opt-in 真浏览器 smoke；该 smoke 由 dev 另行实际执行成功。
- 安装：`node scripts/install-lib.js install --preset-only` 更新 default/classic；现有 PowerShell sync 更新 null；`node en/scripts/install-lib.js install --preset-only` 更新英文 classic。
- 安装后 76 个关键文件与各自源文件逐字节一致：default 20、classic 18、null 20、classic-en 18。
- 安装前备份：`/tmp/kix-runtime-backup-fcsjJ1/.agent-presets`。保留供回滚，不自动删除。

## 重启前运行态事实

目标 GUI：`http://127.0.0.1:33236`，既有服务 `dsh-web.service`，旧主进程 PID 125666，命令 `/usr/local/bin/dsh web --no-open --port 33236`。

实际 RPC：POST `/api/pluginInventory/list` 与 `/api/commands/list` 是 typert 通道；旧 `/api/command.list` 的 404 是路由过时，不是插件加载失败。

- live inventory：193 entries；14 个 kix 插件全部 enabled/active；budget disabled；vision-bridge active；无 enabled-but-inactive。
- 当前主线程与独立 QA 均直接复现 signal 命令返回格式错误、stalled 默认 root 为 `/`。
- 有明确过期 Sprint 的 fixture：`/tmp/kix-stalled-runtime-check/docs/sprint-1/progress.md`。显式 root 可检出 1 个，缺省命令却是 0 个。
- 复制安装后创建的新会话 `session-1a244cf0-b526-4000-b215-0862df1fe957` 仍复现旧错误，证明文件同步不等于进程已使用新代码。
- 重启前 session.list 仅本主会话 running；其他任务未运行。

## 接续中断原因与本次运行态验收

原服务已成功从 PID 125666 重启为 PID 455789。失败的是一次性辅助服务 `kix-runtime-restart-125666.service`：脚本 `/tmp/kix-runtime-restart.cjs:33` 仅等待 `/` 返回 HTML，随后就在第 41 行请求 `session.create`。结果文件显示 16:22:26 UTC 收到非 JSON 的 `not found`，JSON 解析失败，自动续接也未排入；systemd 日志中的 DSH 完整启动公告在 16:22:31 UTC。当前同一 RPC 路径正常，符合网页已可达而 API 尚未就绪的启动时序问题。

本次接续直接完成剩余验收，没有再次重启。旧辅助服务为 transient、`Restart=no`、退出码 1，已经停止；保留失败结果 `/tmp/kix-runtime-live-result.json`，不覆写为成功，也不重新运行该重启脚本。若将来另行安排自动重启，应以所需 RPC 的有效响应判定就绪，而非仅看网页 HTTP 200。本次没有为复现启动竞态再次中断用户会话。

本次新增物证 `/tmp/kix-runtime-resume-result.json` 记录：

- 原 `http://127.0.0.1:33236/` 打开及刷新均 HTTP 200，标题为 DeepSeek Harness；DOM 和截图确认工作区、会话列表及输入框正常。截图 `/tmp/kix-runtime-after-restart.png` 已实际读取，验收浏览器已关闭。
- 同一服务 inventory 193 项；14 个启用的 kix 插件全部 active；budget 仍禁用；vision-bridge active。
- 独立 fixture 新会话 `session-4348acd8-b860-4509-a49d-de222262d9a5`：`/kixsig-check` success，`/kixst-check` 缺省 root 检出 `stalled: 1`，`/kix-discipline status` success。
- `agentPreset.read` HTTP 200，完整响应包含“旧方案和 finding 清单不替代验收”。原始响应 `/tmp/kix-runtime-resume-preset-rpc.json` 为 75325 字节，已解析完整文件确认；普通工具输出及 read 单行会截断，截断不能当成 API 故障。
- 本次 `npm run test:consistency` 为 `CONSISTENCY OK`，`git diff --check` exit 0。收到回合末 discipline 提醒后，另行完整执行当前工作区 `npm test`，后台任务 `bash-1` 已读取到 completed、exit code 0；安装器、一致性与语法检查、选择压、视觉桥及插件测试链均通过，末批 38 tests / 37 pass / 1 skip / 0 fail。skip 为 opt-in 真浏览器 smoke，其独立真实执行证据见前文。新日志：`/tmp/dsh-subprocess-IThopk/dsh-subprocess-455789-3-40adf98daa40-stdout.log`。
- 回合末提醒的触发来源：本次通过 write 保存 `/tmp/kix-runtime-resume-result.json`，而 discipline 的路径分类在未命中测试、已知工件或文档规则时默认返回 source（`dsh/preset/plugins/kix-discipline.js:410`）；临时验收 JSON 因而被计为实现编辑。此前本回合只运行一致性检查，按设计不能冒充测试。本次已补充实际测试成功终态；该提醒不表示测试曾失败，也不证明所有 JSON 都应豁免。此处记录分类局限，没有修改验证规则。

独立 QA 的最终运行在全新 Node 进程 PID 458869 加载安装版 discipline，并挂载真实 Cordis、DSH ToolRuntime、bash-local/subprocess-local、worker-thread run_code、jobs-local/tool-jobs 和 fs-local/tool-fs。9 个场景通过：前台非零/零、编辑后废弃旧 green、run_code 子调用非零/零/纯摘要、后台零/非零/跨编辑旧 job。额外断言确认首次 job_output 仍为 running 时 `turnTests=0`，完成后才按终态和编辑代次记账。

独立报告：`/tmp/kix-runtime-resume-qa.md`。可重放入口：`node /tmp/kix-runtime-resume-qa/tests/runtime.test.mjs`；原始结果：`/tmp/kix-runtime-resume-qa/work/results.json`。主线程已读取探针与执行事件，确认 pre/post 由真实工具注册器生成、子调用有实际 parent 元数据、子进程真实退出。**边界：agent/session、命令传输、systemPrompt/shellEnv 是轻量夹具，turn-stopping 由探针触发；这支持已安装工具链的集成行为，不等于 PID 455789 下完整 Web 会话 E2E。**

本次独立安装核对以显式来源映射重新枚举 75 个文件：default 20、classic 18、null 19、classic-en 18，全部逐字节一致，包含源侧生产插件、persona、存在的 review prompt/reviewer 和声明的共享技能。清单及 SHA-256：`/tmp/kix-runtime-resume-qa/work/install-results.json`；可重放：`node /tmp/kix-runtime-resume-qa/tests/install.test.mjs`。这不是重放前轮记录的 76 文件清单，不按总数宣称二者范围相同。null 源和同步声明都没有共享 skills 指针，安装缺少该货架不计为本次映射漂移，也不把 null 技能能力算作已验收。

## 逐插件证据矩阵

除 budget 外，下列插件均有本次同服务 active 证据；行为证据按实际覆盖分别列出。

| 插件 | 已具备的行为证据 | 当前保留边界 |
|---|---|---|
| guards | 无 HOME 正反例、真实 Cordis waterfall、原规则回归 | 不对真实用户配置执行破坏性写入作测试 |
| discipline | canonical 结果、后台/编辑代次、包装命令、JS/TS 回归；本次安装版真实工具链 9 场景及 live status | 会话外壳为夹具，未声称完整 Web 会话记账 E2E |
| orchestration | epoch 完整事件链、真实 Git/ignored 输入正反例、独立 reviewer 复核 | 不宣称追踪未声明的所有外部变化 |
| consistency | 实际拦下镜像字节漂移；本次全量一致性再次通过 | 祖先扫描的测试夹具需隔离，QA 已清掉前轮污染 |
| cost | 源码契约与单测；当前工具面/成员接线存在 | 未主动制造全部深度/effort 运行态组合 |
| route | 规则单测、真实 capability 代理与当前工具接线 | 未注入真实供应商故障；不按 cross 名字声称厂商独立 |
| commands | 模板同步；本次新会话三个 slash 命令实际 success | 未穷举每个命令的所有参数组合 |
| focus | 真 Cordis 暂态失败重试、成功停止、卸载回收；本次 capability 查询成功 | 不向用户生产模型提供方注入故障 |
| stalled | 显式 root 正例、会话 cwd 回归；本次新会话缺省 root 检出 1 个停滞 Sprint | 检验的是受控过期 fixture |
| signal | CommandResult 和调用会话状态回归；本次新会话 slash success | 不把命令返回成功外推为所有语义决策正确 |
| probe | 真 Python 执行、退出码、超时和内存字段测试；本次真实解析检查成功 | 不把任意 probe 成功当所有主张已验证 |
| settle | 父子生命周期、终态、旧 job/旧 observer、纯汇总反例 | 报告收到不等于语义已经正确；未映射证据仍须模型判断 |
| mem | 前轮 experience 列表/读取、遍历拒绝；本次实际读取经验成功 | 不修改或清除用户既有记忆 |
| browser | 两 owner 真 launch/CDP、自有与借用 tab、关闭隔离；本次原 GUI 打开/刷新/截图/关闭 | owner 未主动 close 的自有浏览器保留到卸载；显式借用页被别人关闭会失效 |
| budget | 正确 effect 生命周期和阈值相关单测；本次确认 disabled | 不冒称已启用或 live 触发 |
| vision-bridge | 本次宿主 active、前轮桥接回归 6 断言 | 未做真实外部视觉供应商推理，不能称该通道完整 E2E |

## 交付边界

本次完成运行时修复任务的接续验收，没有修改 DSH 上游、重建无关 GUI、发布 npm、提交或对外评论。临时故障记录与可重放 QA 工件保留在 `/tmp`，它们会受系统清理影响；长期结论以本文为入口。

候选认知文本和提醒的通用净收益仍未完成跨任务对照验证，见 [研究方案](kix-general-evolution.md)。本结论的一个明确反证条件是：在完整 Web 会话中，相同编辑→失败测试链路仍清除了待验证提醒；该完整会话链路未实测，当前依据是安装版真实工具集成与独立 live 命令两条证据。
