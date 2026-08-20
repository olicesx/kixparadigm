# Changelog

## v1.3.5（2026-08-20）web_search 恢复常驻 + 工具描述压缩

- **web_search 三分法回滚（默认 preset）**：曾尝试把 `web_search` 从常驻挪到 `ACTIVATABLE_TOOLS` 渐进披露。评估否决——低频工具断 KV 缓存一次的成本（cacheRead:input 实测 127:1，长会话全价重读）远超省下的 ~660 tok/步常驻税；且 `tool-web` 是 preset 行注册的 scope-local 工具，`restrict` deny 裁不到（旧测试把 web_search 塞进全局视图断言 deny 含它 = 假绿）。本版：`agent.cordis.yml` 的 `tool-web` 恢复常驻；`ACTIVATABLE_TOOLS.web_search` 删除；`kix-focus` deny 清单不再假装能裁它；capability 目录 search 组改回「常驻可直接调用」。
- **工具 schema 文案压缩（常驻税）**：缩短 `kix_capability_call` / `kix_tool_activate` / `kix_tool_deactivate` / `kix_discipline_spec` / `probe` / `experience` 的 description（保留行为锚点与何时用/何时不用；砍机制复述）。job 组 hint 改为「list 确认存在 → output 读结果 → kill 停止」。
- **测试**：`kix-focus.test.js` 改断言——`web_search` 不在 ACTIVATABLE、restrict deny 不含它、常驻性由 cordis 行决定。四副本 identical（default / classic / null / en-classic）。
- **npm 经典模式**：1.3.4 已修好 variants 安装面，本版保持 `kixparadigm` + `kixparadigm-classic`；en 仍为 `kixparadigm-classic-en`。

## v1.3.4（2026-08-20）persona 预算口径修正 + 经典模式随 npm 安装（1.3.1–1.3.4 首次进 registry）

- **发版收口**：npm 上一次是 `kixparadigm@1.3.0` / `kixparadigm-en@1.2.23`。1.3.0 tarball **含** `dsh/preset-classic/`，但安装器只认单一 `presetDir`，postinstall 只把默认激励面拷到 `~/.dsh/.agent-presets/kixparadigm/`——用户反馈「发布的包没有经典模式」= 安装面漏装，不是打包漏文件。本版 `package.json#kixparadigm.variants` 声明 `kixparadigm` + `kixparadigm-classic`，安装器逐变体拷贝；en 包安装 id 对齐 `kixparadigm-classic-en`。`npm i -g kixparadigm` 后模式列表应同时出现两者。en 包从 1.2.23 跳到 1.3.4（中间 1.3.0–1.3.3 未单独发 en）。
- **背景**：kix-consistency 运行时报警「dsh/preset persona 5510 chars > 4500」。归因（git 考古 + 逐块测量）：**测量口径失真，非真实膨胀**——v1.3.0 激励面转正后，`dsh/preset` 含 disabled 经典 persona 遗产块 4160 chars（死文本，不注入会话），旧 `extractPersona`「首个 text 块到锚点」口径把它计入「常驻预算」，而真实活跃层（persona-incentive）仅 **1274 chars / 225 estTok**（预算 4500/2600 的 28%/9%）。四根实测：classic 4131/2271 ✅、null 190（无预算挂载）、en 9137/1651 ✅——**瘦身成果一直都在，被冤枉的是尺子**。
- **修复①（测量口径）**：`extractPersona` 重写为「活跃常驻层」语义——只计 agent-instructions 锚点前**非 disabled** 条目的 text 块（6 空格缩进内容，不含条目脚手架）；条目级 `disabled: true` 按精确 2 空格缩进锚定，text 内容行内出现同字样不误判；锚点缺失仍报错（结构损坏不放行）；disabled 块全部存在时 persona='' 测量真值。
- **修复②（预算单源）**：新 `PERSONA_BUDGETS` 常量进 lib（zh 4500/2600、en 9500/2600）——曾双源漂移：`runAllZh` 硬编码 **6000/3400**、运行时插件本地常量 **4500/2600**，同一检查两套阈值（CI 放行、运行时报警的分裂根源），这正是本库使命要消灭的双源形态，阈值自己却逃逸了单源。`runAllZh`/`runAllEn`/kix-consistency.js 三处消费点全部改饮 `lib.PERSONA_BUDGETS`。
- **单测**：kix-consistency.test.js **122/122**（111 基线 + 8 新增：disabled 遗产块不计 / text 行内字样不误判 / 超预算仍拦（口径修正≠放松）/ 锚点缺失报错 / PERSONA_BUDGETS 导出 / 插件无本地字面量 / runAllZh 无 6000 硬编码）。三文件（consistency-lib.cjs / kix-consistency.js / kix-consistency.test.js）× 4 源副本 identical。
- **一并收编**：kix-budget 劝告文案去通道点名（只定价不路由，与 v7 编曲保育同构）已同步 default+null（L3 配对一致）。`preset-null` 仍是消融对照，**不**随 npm 安装（只进 tarball 的 `dsh/` 树，variants 不声明）。
- **上轮勘误**：曾报「CLI 不查 persona 预算（文档-实现漂移）」——误：CLI 经 `runAllZh` 查了，真实问题是阈值双源（本条修复②）。grep 单点证据导致的错误结论，已修正归因。

## v1.3.3（2026-08-20）run_code 三块受控能力放开（kix-guards v16）

- **背景（用户指示，接 run_code 能力面讨论）**：v13 一刀切拦截全部 require/import/fetch/fs 直写，组合层被迫绕道 bash 文本解析（格式脆弱）或逐工具往返（丢上下文经济性）。本次放开三块**低风险、可静态判定**的面，其余拦截不变：
  ① **纯函数内置模块白名单**——`node:path`/`node:util`/`node:crypto`（含无前缀形与 `path/posix`、`util/types` 子路径），加载调用+安全成员链放行；链内出现 `constructor`/`process`/`fetch(`/`eval(`/`WebSocket` 守卫 trim 到仅加载调用（`path.constructor("…")()` 代码生成仍拦）。
  ② **fs 只读元数据**——允许 `require/import('node:fs'|'node:fs/promises')`；stat/readdir/readFile/realpath/access 等只读面放行；写 API（writeFile/rm/mkdir/rename/open/…Sync 全系名单）按**调用模式**拦截——FWRITE_RE 在 fs 已加载时对**剥离数据面后的语法面**匹配（字符串提及零误伤），deny 引导改用 write/edit 工具。fs span 仅覆盖加载调用不延伸链，`require('node:fs').writeFileSync(…)` 直链写保留 v15 拦截语义。
  ③ **fetch 字面量 URL 域名白名单**——`cfg.netAllowlist`（默认 `api.github.com,github.com`，支持 `*.suffix` 通配）；**仅引号字符串字面量**，模板 URL（`${}` 表达式不可静态判定、blank 会隐藏实参代码——自查发现的绕过路径）、变量/拼接 URL、相对 URL 一律不 blank → 命中黑名单 fail-closed deny；第二参含 `process`/`constructor`/`eval(` 同样不豁免。轮询+聚合场景（等 CI 状态）放开。
- **实现机制**：`collectAllowedSpans` 在原文做字符级精确 span 匹配（起点在字符串/注释/模板 raw 内 = 数据面跳过；`.`/`?.` 前缀 = 属性调用 `a.fetch(` 不豁免）→ `runCodeSurface` 先 `executableJsSurface` 等长剥离（偏移稳定）再 span 等长空白化 → 黑名单照常匹配残留面。非白名单内容不进 spans → 原文保留 → 拦截（fail-closed 不变量）。v13 全部歧义规则（regex/division/tagged-template/U+2028）原样保留。
- **不变量**：v15 deny 集除三块白名单外逐例保留（263 基线仅 1 例语义翻转：`import("fs")` 裸加载无写调用 deny→allow，按 v16 语义注明）；child_process/process/eval/Function/constructor/WebSocket/未知模块照旧 deny。
- **已知局限（如实声明，API 塑形层非安全边界，真机械层是 sandbox）**：`globalThis['re'+'quire']` 拼接混淆不拦（v15 同级覆盖）；fs 别名（`const w=fs.writeFile; w(…)`）不拦（v15 同级）；fetch Host 头注入属 SSRF 上游防护——白名单域名本身是信任边界。
- **单测**：286 组全绿（263 基线 + 23 新增：纯模块 6 / fs 只读与写拦 7 / fetch 白名单与 fail-closed 9 / hostAllowed 纯函数 1 / cfg.netAllowlist 配置实例 1）。8 副本 identical（源 + dsh/preset-classic + dsh/preset-null + en/preset-classic-en + 宿主 kixparadigm{,-classic,-null,-classic-en}），每副本独立跑测全绿；sync-dsh-preset.ps1 DryRun 幂等（相同 41/更新 0）。kixincentive/kixincentive4f 的 guards 为独立演化版（md5 异源），不在一致性契约内未动。
- **生效条件（挂账）**：宿主按 preset 名缓存插件快照——**须重启 DSH 进程后新会话复验**：①三块放行真实可用（run_code 真机 fetch/import）②等价面 5 拦 3 放不回归 ③cfg.netAllowlist 经 agent.cordis.yml 配置链生效。
- **退役条件**：若实测出现经三块开口的真实破坏事故（fs 写绕过 / 白名单域 SSRF 被利用），回退 v15 一刀切并在源文件头记录第二轮出生证明。

## v1.3.2（2026-08-20）kix-settle 投递端补齐 + 插件面全开（用户裁决）

- **插件全开裁决（用户，2026-08-20）**：默认 preset 全部 6 个未挂载插件恢复启用——kix-discipline / kix-orchestration / kix-consistency / kix-commands / kix-signal（移除 `disabled: true`）+ kix-stalled（注释态转启用）。**依据（诚实分级）**：①常驻认知层缩减（persona 激励面）有 EXP1 实测（½ 成本），但**插件层关闭无对照实验**——v2 冻结锚点（49f820…）中这 5 个插件本就是 disabled，是实验配置继承而非 v1.3.0 新决策；②"关了更好"从未双臂归因（⑨ 纪律），用户裁决：缩减只属于常驻层，插件全开。kix-stalled 为 candidate 状态（1 次夹具 E2E），按全开裁决启用，晋级/退役条件不变。prompts/ 目录（5 个 kixpower 流程文件，~64KB）从 classic 复制到默认+null，kix-commands 五个 `/kixpower-*` 命令完整可用。
- **kix-settle 只观察不投递的半成品修复（会话实弹审计发现）**：初版（v1.3.0，2026-08-19）只实现了 post-execute 状态记账（edits/execs/executedSinceLastEdit），注释声称的"交付时（agent/turn-stopping）单发按零结算 steer 提醒"从未落地——`makeUserMessage`/`settleText` 定义后零调用、`reminded` 字段预留未读、`apply()` 内无 `agent/turn-stopping` 处理器。本次补齐投递端：回合收尾时若存在工作区编辑且最后一次编辑后无任何新进程执行（probe/run_code/python/pytest 均算清账）→ `agent.steer()` 单发一次 advisory 提醒（reminded 置位，每会话一次）；防御包裹保证投递绝不阻断回合。语义与 kix-discipline 的 green gate 互补但更宽。
- **修复路径**：参照 kix-discipline 既有投递模式（`agent/turn-stopping` + `agent.steer(makeUserMessage(...))`）——宿主事件与投递 API 均有同族实证，非发明新机制。
- **单测**：新建 `kix-settle.test.js`（10 断言）——监听器注册（post-execute + turn-stopping）、记账（edit/write 计数、工作区外不计、probe/run_code/执行类 bash 清账）、投递（有编辑无执行→steer 单发且含按零结算语义、有执行→不提醒、无编辑→不提醒）、reminded 单发不重复。宿主副本（`/root/.dsh/.agent-presets/kixparadigm`）同测全绿。
- **同步**：源仓库 `dsh/preset/` + `dsh/preset-null/`（消融变体同修）+ 宿主安装副本两处（kixparadigm / kixparadigm-null）四副本 identical；kix4 冒烟 27/27 全绿（含 kix-probe/kix-mem 既有断言与三件套构成 parity）。
- **真实会话行为实测（2026-08-20，宿主重启后）**：构造「1 处工作区编辑 + 末次编辑后无执行 + 回合收尾」场景——宿主在 `agent/turn-stopping` 注入唯一一条 `source.plugin=kix-settle, form=notice` user 消息，文本与 `settleText()` 逐字一致；会话记录全量核对恰 1 条（reminded 单发成立）。同时实证宿主插件快照缓存：磁盘同步后必须重启宿主（PID 139078→144237）才加载修复版。
- **生效条件**：宿主按 preset 名缓存插件快照（v1.3.0 已知宿主缺陷）——磁盘修复对运行中进程不生效，**重启宿主或换 preset 名后 settle 投递才真正上线**（本条即重启后实测闭环）。

## v1.3.1（2026-08-20）kix-guards v15：预算线结算 steer（v14 死亡证明）

- **哲学自检驱动**（`kix-discipline/philosophy-selfcheck-v131.md` F1 裁决）：commit 预算线从硬 DENY 降为**结算 steer**——超预算不拦 commit（可逆、本地），post 成功后注入一次对账提醒（v12 控制平面同款 pending 机制，每会话一次）：①迭代节奏真实变快（CI 修复链）→ 同步 commit_budget 到 progress.md；②预算合理而提交超速 → 收敛粒度或拆分 Sprint。硬帽 fuse（`COMMIT_HARD_CAP`=10 次/小时，含 amend，不可配）保留硬 DENY——失控 thrash 不响应 steer，由 fuse 熔断（41-step gate / token 预算 hard gate 同族）。
- **删除 v14 `detectFailureDrivenBonus`**（出生/死亡证明见插件头注释）：commit message regex 分类推断「失败驱动」意图无出生证明（无「预算线拦断合法修复链」事故记录）；文本启发式意图分类与 v1.2.15 判死删除的 shell 命令机械提取同类负债（`chore:`/`test:` 常规提交误计为失败驱动、`.ci-failed` 等标记文件无创建者=死代码、零单测）；病根是定价错误——预算线 DENY 拦可逆 commit 只为强迫记账，把会计问题定价成失控问题，v14 是误定价逼出的代偿。
- **`COMMIT_BUDGET_DEFAULT` 6→3 回退**：v14 的提升无实测数据支撑；steer 化后错误默认的代价只是一次提醒，不再是拦断。near-miss 结构化日志（commits/budget/source）为测度点，攒 sprint 数据后校准默认值与 fuse 阈值。退役条件：实测出现「steer 无响应且 fuse 前已造成不可逆破坏」→ 预算线回硬 DENY 并记第二轮出生证明。
- **en 版本锚同步**：`en/scripts/check-consistency.cjs` 期望版本 1.3.0→1.3.1（自检 H2 修复；kix-guards 四份镜像失步 H1 随本条同步一并消除）。
- **单测**：kix-guards 新增 v15 组——超预算放行+结算提醒注入（含 commits/budget/来源断言）、remindOnce 无二次提醒、fuse 硬帽回归、`budgetSteerMessage` 纯函数；常数断言回退 3。
- **kix-guards v15.1（源仓库豁免覆盖变体目录）**：`isSourceRepoPresetPath` 正则 `/preset(?:\/|$)/` → `/preset[-\w]*(?:\/|$)/`——`dsh/preset-null/`、`dsh/preset-classic/`、`en/preset-classic-en/` 源路径编辑不再被裸 `agent.cordis.yml` 兜底分支误 remind（出生证明：本日会话实弹编辑 preset-null yml 触发误报）。安装面检查先于豁免执行，安装副本路径仍拦；新增 5 断言含 Windows 反斜杠变体与安装面反例。
- **browser 常驻裁决（用户，2026-08-20）**：默认/null preset 的 kix-browser 行保持常驻。依据：常驻路径 live E2E 闭环通过（open(200)/snapshot 真实 DOM/type 过滤生效/Ctrl+a+Delete 恢复/screenshot 落盘；CDP 不可达时 launch 兜底正常）+ 浏览器验证工作流高频 + 1KB schema 税接受（EXP3 ⑦ 常驻工具不被仪式性滥用）。出生证明从「宿主 effect bug 绕行」改写为本裁决（原证明已随 bug 修复失效）；死亡条款：连续一个月真实使用 <2 次 → 注释回退渐进披露。en-classic 保持注释态渐进披露（与 zh-classic 冻结锚一致）。
- **persona 悬空声明裁剪（F2，默认 preset）**：v1.3.0 重排后 persona 教了四个未挂载机制（kix_discipline_spec 工具 / 门禁已挂载 kix-discipline·orchestration / /kixpower-* 命令 / kix-budget hard gate），本会话工具面逐一证伪。修正：需求三检契约改为「工作区 kix-discipline/spec.md 目录即约定」（不依赖未挂载插件）；门禁清单只列实际挂载的 kix-guards（含 v15 语义）；预算句改诚实表述「本部署未启用，自觉提前交接」；/kixpower-* 指派句删除；头部插件清单按实际挂载/关闭状态重写。
- **发布卫生（F3）**：删除 `dsh/preset-classic/plugins/kix-guards.js.backup`（54.7kB，原会进 npm tarball）与 `en/package.json.backup`；`git rm` 四个跟踪杂物（placeholder/temp_zstd/test_fix/tmp_test_temp.txt）；.gitignore 增 `*.backup`、`tmp_*.txt` 等防复发段。
- **安装器多变体（用户反馈「发布的包没有经典模式」）**：`PRESET_VARIANTS` 循环安装全部变体（旧 `presetId`/`presetDir` 向后兼容）；en 包 `kixparadigm` 段升级为 variants 且 id 对齐 `kixparadigm-classic-en`（v1.3.0 重命名漏改：配置仍写 `kixparadigm-en`）；`KNOWN_PRESET_IDS` 补 `kixparadigm-classic-en` 与 `kixparadigm-null`——缺前者时 zh 卸载会把仅剩 en 在装的场景误判无 owner 而删共享 vision-bridge。随 **v1.3.4** 首次进入 npm（本条代码在 1.3.1 提交，1.3.1–1.3.3 未单独 publish）。


## v1.3.0（2026-08-20）实验驱动发版：契约优先 + 激励面机制三件套 + 成本分层模型

四轮受控实验（EXP1 真实 SWE 三臂 / EXP2 歧义任务定价市场 / EXP3 无歧义任务结构工具 / EXP1-R+R2 同模型归因双臂，共 100+ runs、预注册判据、跨厂商盲审计、机械复核全绿）的结论直接转化为机制。

### 核心结论（全部物理结算，证据锚定实验工件）

1. **契约清晰度 >> 机制 >> 劝说文本**：歧义契约下 16/16 全员同错（EXP2）；无歧义契约下基线激励面 24/24 全过隐藏陷阱（EXP3）；反证定价写进 persona 三轮零行为效果（EXP2/EXP3，市场价格 persona 退役）。
2. **环境掩盖型盲点可被机制修复（同模型双臂归因闭合）**：v2 激励面精确复现 EXP1 的 `import flox` 模块级残留（stub 计数=1），三件套 preset 同模型同任务下 flox=0 且显式处理 flox→dask 传递链（EXP1-R2 臂 A vs 臂 B）。
3. **成本分层模型**：激励面小认知层（常驻 persona 小 ~70%）相对经典锚点式 ≈½ 成本（EXP1 实测 22.2 vs 42.6 min，同质量 97 vs 98）；隐含契约任务机制深验证 ≈2.3× 墙钟——**选择器是任务属性不是信仰**。
4. **模型只用有用的工具**（no-op note 安慰剂 48 run 零调用）；probe 采纳时先探测后修复（步骤 11–15 扫契约边缘 vs 首修复在 16）、零成本溢价。

### 新增机制（kixparadigm 主 preset）

- **S3 contract 字段**（kix-signal spec-draft 模板）：行为契约显式化——必须不变/必须改变/必须成立/契约歧义与解读假设（有歧义先问，无法问则显式声明解读）。直击第一杠杆：EXP2 的共同失败模式全部始于契约两可解读。中英双侧同步。

### 新增 preset：`dsh/presets4/` + `dsh/presets4-null/`（激励面机制三件套，实验血统转正）

- **kix-probe**（EXP3 冻结版+免费测度）：中性裸执行器，fresh 进程跑 Python 片段返回 stdout/stderr/exit_code + `duration_ms`；`measure=true` 附 tracemalloc 峰值（「不测量就看不见」——三轮存活缺陷的共同类）。退出码经 wrapper 精确传播；60s 超时。
- **kix-settle**（结算信号）：工作区 edit/write 计数 + 执行清账观察（probe/run_code/python 命令）。「无执行证据的结论按零结算」。**注意**：注入通道因宿主缺陷暂缓（见下），当前形态只观察计数。
- **kix-mem**（无助时刻经验救援库，用户实证发现）：`experience{list,get}` 拉取式工具 + `memories/incentive-lessons.md` 危机索引格式（头部求助索引 + 文末追加）。零常驻上下文成本。
- **kix-budget L3 验证补贴**：probe/run_code 重置 streak——马拉松交接建议永不惩罚探测行为。
- **kixincentive4-null**：消融变体（同插件面、persona 只剩身份行+硬约束），用于回答「效用文本本身有无贡献」。
- 原则：无强制采纳、无菜单注入、persona 不推销工具；每插件头部带出生证明（哪轮实验哪组数据）与退役条件。

### 修复与宿主 bug 记录（待报 dsh 上游）

- **kix-settle 链返回值缺陷（已修）**：post-execute handler 返回 undefined（不透传 `next()`/result）在 deepseek-v4-flash 适配器下破坏 tool-result 拼装（`reading 'kind'`，11 次判别实验锁定）；luna 适配器宽容故 EXP3 未暴露。修复=完整逻辑+链透传+防御包裹，30/30 单测。
- **宿主 preset 插件快照缓存（绕行）**：按 preset 名缓存，磁盘修复不生效——改插件必须换 preset 名或重启宿主。实验期以 `kixincentive4f`（同字节新名）绕行。**操作纪律入 README。**
- 派生 preset 依赖修复：kixincentive4-null 补齐缺失插件文件（composition 引用与 plugins/ 目录不一致会导致 mount 失败）。

### 文档与同步

- `dsh/presets4/memories/incentive-lessons.md`：九条实验锚定教训（新增第⑨条：机制归因闭合 + 代价模型 + 归因方法本身）。
- 三侧同步（仓库 / WSL2 / Windows zh+en）；实验冻结资产不动（kixincentive v2 sha 49f820… 为 EXP1-R2 归因锚点）。
- **不做的**：k4 不设默认（归因虽闭合但 n=1，与 kixparadigm 并行提供）；定价 persona 全系退役不迁移。

### 模式身份重排（发版后即时修正，随 v1.3.0 一并发布）

- **命名与默认**：激励面三件套 preset 升级为默认模式并继承名字 `kixparadigm`（`dsh/preset/`）；原锚点式经典版改名 `kixparadigm-classic`（en 侧 `kixparadigm-classic-en`）；消融变体 `kixparadigm-null`。
- **成本归属勘误**：初版 CHANGELOG 中「契约清晰用 kixparadigm（½成本）」主语错误——½ 成本属于激励面小认知层（EXP1：incentive 22.2 min vs 经典 42.6 min，persona 1,323 vs 4,514 字符 ≈ 小 70%），经典版是该对比中的高价组。已全部修正。
- **重排依据**：同模型双臂归因（EXP1-R2）显示激励面三件套是唯一修复环境掩盖型盲点的版本；经典版的不可替代面收窄为多通道验证文化与团队编排纪律。
- **遗留**：压缩后 classic 与新默认版的成本差未单独重测；`kixincentive`（v2 冻结）与 `kixincentive4f`（宿主缓存过渡别名）保留在 WSL2 侧，重启宿主后 4f 可删。

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

