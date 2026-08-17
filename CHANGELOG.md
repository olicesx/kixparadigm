# Changelog

## v1.2.15（待发版）kix-consistency 泛化：自感知边界 + N 份身份组

- **该相同的数份必须相同（N ≥ 2）**：`checkIdenticalSet` 一次比 N 份（缺一份 / 任一份与锚点字节不同都失败）；身份组不再写死 zh/en 一对——按自感知 preset 根展开，加语言 / 加 preset 自然进组
- **边界即 preset 根**：preset 根 = 同时含 `agent.cordis.yml` + `preset.yml` 的目录（DSH 布局双标记压假阳性），深度 ≤2 扫描（跳过 `.*` / node_modules）。任意仓库发现 ≥2 个 preset 根才引导；单 preset / 普通项目零开销放行——触发不再按 kixparadigm 指纹硬编码，自定义布局（如 `pkgs/zh` + `pkgs/en`）同样被发现。**非 preset 根路径天然出组（CI 与写时都不比）——边界是自感知推论，不设任何逐路径豁免规则**
- **契约层自声明**：persona 预算 / memories 计数 / README 表述 / 版本对 / vision-bridge 对只对自带 `scripts/check-dsh-consistency.cjs` 的仓库开（仓库自己携带契约入口 = 自声明适用 kix 全量契约），外仓不硬套本仓常量——防过拟合；`presetRoots` 配置可显式声明身份组根覆盖扫描
- **kix-guards v13 控制平面 = 安装面（少即是多）**：v3 的裸 `agent.cordis.yml` 兜底分支删除——它误伤源仓库（v11 硬编码豁免、v13 谓词注入两轮补丁皆是给它打的），而「源 vs 安装副本」本是「该相同的数份」的领域：源/外仓 preset 写归 kix-consistency（身份组 + parity hint + 契约层）管，guards 只管安装面（`~/.dsh` / `.agent-presets`）。无豁免、无谓词、无逐路径规则——上一版（PR 内）的谓词注入机制整体移除。诚实边界：cwd 在安装目录内的相对路径写不提醒（那本就是 v12 已放行的显式自迭代）。单测 kix-guards **239 → 243**
- **parity hint（未描述形态靠提醒感知）**：根内非 plugins 路径（skills/agents/instructions/prompts/memories（无契约时）/persona（无契约时）等）写时发一次启发提醒——不断言失败，只把「其它根对应份是否需要同步/翻译」交给模型判断（翻译关系机械校验必误报，zh/en 结构本就不镜像）；remindOnce 每会话一次限噪；block/ask 强度不作用于 hint（无失败可拦）
- **shell 写入通道**：pwsh/bash 命令提及 preset 根内路径（cp/Set-Content/重定向/sed -i 等）——pre 登记命令中的根内路径（写前磁盘未变，检查无意义），post-execute（磁盘已变）复验身份组，漂移注入提醒，非 plugins 目标走 parity hint；此前 shell 写完全绕过（实证：漂移与 skills 双 SILENT）；提取启发式认正/反斜杠，cap 8 目标限噪
- 单测：kix-consistency **54 → 107**（外仓自定义布局 / 边界外路径 / 单根零开销 / 契约分层 / N 份漂移与缺失 / parity hint 与 remindOnce / edit 工具 / pwsh+bash shell 通道与无假阳性 / block+ask 强度免疫 / N=3 根点名 / 双 agent 独立 / 深路径与扩展名形态 / 类别隔离 / 提取器单测）；WSL2 安装副本外仓夹具实测（kix-foreign-multi / single / plain / vscode）

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
