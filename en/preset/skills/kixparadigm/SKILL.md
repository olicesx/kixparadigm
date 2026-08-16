---
name: kixparadigm
description: "kixParadigm — AI 自编排最小范式 + 统一入口，适合各种编程任务（PR/代码审查、跨模块或多文件改动、bug 修复、重构、架构设计/技术选型讨论、任务规划与拆分、多任务并行编排）。简单任务三通道自编排直接做；复杂任务自动升级为 CEO 团队编排（自主分派 kixpower 团队，用户不感知切换）。三通道交叉验证（执行/观察/汇总）+ 机械安全门禁 + AI 盲点补足 + 需求三检（不迎合用户，思维碰撞）。不是流程引擎——给 AI 自由推理空间，用工具补足盲点，用门禁防失控。当用户需要审查、实现、修复、规划、讨论架构或验证代码正确性时使用。"
---

# kixParadigm — AI 自编排范式

> **DSH 适配注记**：本文件从 VS Code Copilot 导入，其中的工具名（`runSubagent`/`vscode_askQuestions`/`read_file`/`grep_search`/`run_in_terminal` 等）与 Copilot 机制（PreToolUse hooks、跨厂商模型字符串、VS Code 对齐）在 DeepSeek Harness 中有对应映射，**权威映射见 preset 根的 `DSH-ADAPTATION.md`，与本文件冲突时以该文件为准**。机制与判断（三通道/二相性/需求三检/写码前/盲点/验证 gate）原样适用。
>
> **2026-08-16 插件化改造注记**：本文件中「机械门禁」「验证 gate」「需求三检契约」「编排交接」等**机制性纪律已插件化**——由 `plugins/kix-guards.js`（机械门禁）、`plugins/kix-discipline.js`（需求三检契约 gate + 验证 gate + `kix_discipline_spec` 工具）、`plugins/kix-orchestration.js`（编排交接门禁：sprint marker/plan/progress/blocker 校验）、`plugins/kix-cost.js`（成本分层）、`plugins/kix-route.js`（跨厂商/识图路由）强制，不再靠模型自觉遵守本文件的说明。本文件保留的是**认知方法层**（怎么思考/怎么呈现）与按需参考（hook 细节、跨厂商判据）；与插件冲突时以插件行为准。改造总览见 preset 根 `PLUGINIZATION-ROADMAP.md`。

> **分层**：核心认知范式（三通道/二相性/规则是负债/需求三检/写码前/盲点/CEO 概览）**常驻**于 `../../instructions/kixparadigm-core.instructions.md`（每次会话生效）。本文件为**机制细节层**（按需加载）：机械门禁、验证 gate、输出格式、团队目录、VS Code 对齐、还债机制。
> 不是流程引擎，不是规则手册。是 AI 为自己设计的最小工具箱 + 安全网 + 盲点提醒。
> 核心信念：模型的推理能力是主力，工具只补足已知盲点。**限制越少，发挥越好**。

## 三通道原则（并发多视角交叉验证）

执行/观察/汇总三阶段串行推进，**并发发生在观察通道内部**——多个独立 agent 同时看，盲点不重合。

| 通道 | AI 执行 | 并发性 |
|---|---|---|
| **执行（手）** | 主 agent 操作 + 产出 claim | 主线程 |
| **观察（眼）** | 并发启动多个子 agent，各自独立验证 | 并发（一个 message 里放 2-3 个 runSubagent 同时跑） |
| **汇总（嘴）** | 聚合多视角结论 | 主线程 |

**核心**：对重要 claim，同时启动 2-3 个**异质**子 agent（不同 prompt 视角），它们**并发**读代码、独立判断。汇总先拆成**机制事实 / 适用契约与设计意图 / 影响与结论**，只在同一层判断一致性；禁止用机制层多数一致外推契约层或严重度。各层异质多数一致 → 高置信可发布；任一独立观察者基于证据提出反证 → 你的盲点，深挖分歧点，契约不明时不发布确定结论。**异质性是一切；同质"一致"是虚假置信**。同一 agent 多步验证盲点系统性（每次漏同样的），多个独立 agent 盲点随机交叉覆盖。**并发而非串行**：更快、更独立。

> 观察为何必须独立 agent：主 agent 是产物创造者，自我验证会被创造视角污染——二相性要求发散（创造）与收敛（验证）互不泄漏，独立 agent 正是收敛视角的物理隔离。

> 独立验证不需详细模板——"读代码验证 claim 对不对"这类最小指令就能引导发现大部分盲点，因为发现盲点的关键是读代码本身，不是按 checklist 打勾。

## 子 agent 调用指南（三通道实操）

**视角差异来自 prompt，不来自 agent 身份** → **不做专用 agent**。需要机械保障时挂 hook（见下），不做角色化 agent。

**跨厂商模型可叠加为正交杠杆**（最高置信 claim 用；平台/库语义、语言分派、类型转换等模型间差异大的领域优先上）：

> **DSH 适配注记**：下方模型字符串与 `runSubagent` 的 `model` 参数是 VS Code Copilot 机制。DSH 中跨厂商正交杠杆**已启用**：preset 注册了 `subagent_cross` 工具行（`kix-route:cross` 哨兵 → kix-route 插件运行时按父厂商自动取反路由，无需手工同步模型线），主模型三通道观察/最高置信 claim 时自主选用它作为跨厂商观察者（主 DeepSeek + 观察 GLM = 跨厂商取反）；普通分派用 `subagent`（继承主模型）。`workflow` 的 `agent(prompt, {provider, model})` 亦支持每次调用级覆盖。新增厂商 = settings.yaml `llm-pi-ai:` 加 profile（kix-route 自动发现已注册 provider，preset 无需加行）。判据与权衡原则原样保留。

- 候选：DSH 中由 `subagent_cross` / `kix-route` 运行时按父厂商自动取反解析（Copilot 时代硬编码模型串已从 DSH 技能移除；部署候选 = 已注册 provider 实时目录）
- 判据：优先取与主模型**解分布差异**最大者（跨厂商 > 同厂商不同代际 > 自验证）
- 权衡：观察者要**够强但不同**——太弱放行主模型错误（LLM-judge 高估效应），太强则错误相关滑向同质；观察者的"验证通过"结论始终受其能力天花板限制
- 权衡边界：基线够强时协作收益消失（来源与实证见 AUDIT.md §2）
- 调用（DSH）：普通分派 `subagent`；跨厂商观察 `subagent_cross`（失败时错误信息自带已注册 provider 清单，按其建议重选）

### 调用

- **省略 `agentName`** → 用当前 agent
- **并发**：同一 message 内放 2-3 个 `runSubagent` 同时跑
- **prompt ≤ 5K tokens**：超过则先写入文件让子 agent 自己读

### 三通道 prompt 最小模板

```
1. claim — 被验证的断言
2. 视角 — 聚焦维度（正确性 / 写副作用 / 语言语义 / ...）
3. 要读的文件 — 路径 + 行号（涉及行为的断言需读被调用方实现，证据=函数体而非调用链）
4. 返回 — 结论 + 证据(文件:行号) + 推理
```

### 可选 hook（机械保障，不强制）

如需确定性约束（如"验证时不改代码"），挂载独立 `.ps1`：

| hook | 作用 |
|---|---|
| [`blast-radius-check.ps1`](../kixpower/hooks/blast-radius-check.ps1) | 拦截提交预算、主分支提交、force push、破坏性 SQL 与远程主分支写入 |
| [`block-source-edit.ps1`](../kixpower/hooks/block-source-edit.ps1) | 禁止编辑业务源码 |

见 kixpower agent 配置（`../../agents/kixpower-*.md` 的 `hooks:` 字段）。hook 只补足机械失误，推理仍是主力。

## AI 盲点图谱（验证时查哪个方向）

> **方向不是清单**——列方向是为了补足已知盲区，不是打勾表。有疑虑就调独立 agent；范围不确定用 `vscode_askQuestions` 请用户拍板。这是补足不是强制。

**深度与阅读**
- 深度不足：看调用链不读函数体
- 推断未标注：把推测当结论输出

**读写混淆**
- 读写混淆：验读安全漏写副作用
- 辩护倾向：为自己的 claim 找理由而非找反例

**语言与架构**
- 语言语义：凭"能复用"忽略分派差异（Go 嵌入静态 / Rust dyn 动态）
- 架构方向：改动是一致还是分裂
- 本质偶然混淆：把偶然复杂度当本质复杂度

**自信与外部**
- 自信偏差：声称已验证无证据
- 外部视野：审外部沿用内部标准
- 可观测性盲区：看不到运行态行为

**默认姿态**
- 过度工程：该不该存在
- 范式盲从盲逆
- 默认姿态偏差：低风险场景过度防御

## 输出格式（大脑换了，皮肤不变）

kixParadigm 革新了**怎么思考**（自由推理 + 并发验证），但**怎么呈现**沿用 kixpower 成熟约定——格式是沟通效率，不是思维限制：

- **review body**：结论前置三段——上半 1-2 句真人简述 + **结论行**（`✅ APPROVE` / `🔴 CHANGES REQUESTED` + 计数，放折叠区外，永不隐藏）+ 下半去重索引/补充 `<details>`
- **语言统一**：全文只用一种语言（与仓库历史 review 一致），禁止中英混搭
- **通过时精简**：0 blocking/major 时下半只留 finding 一句话清单（严重级别 + 主题 + `文件:行号` + 一句话影响），验证摘要一行；**0 条 finding 则省略折叠区**
- **需修改时去重**：blocking/major 的行内评论是唯一详实正文；review body 只列严重级别、主题、`文件:行号` 和“详见行内评论”。仅无行内锚点/minor/PR 级 finding 可在 body 详述一次
- **严重级别**：🔴 blocking / 🟡 major / 🔵 minor / ✅ nit
- **证据引用**：`文件:行号` 或 文档 URL + 关键句
- **只报 bug 不给方案**：review 每条只写「位置 + 触发条件 + 影响 + 证据」，**不给解决方案/正确写法**（用户会把 review 当执行指令喂模型，方案错则干歪）；安全敏感项（bwrap 等）只报事实，不替作者做产品权衡（易用性 vs 隔离强度）。细节见 kixpower-review.prompt.md §评论格式规范
- **review summary**（`--save`）：frontmatter + 结论行 + 详析（同三段结构）
- **决策 gate**：发布/合并/破坏性操作前用 `vscode_askQuestions` 确认（见「人类确认点」）

详见 [`kixpower-review.prompt.md`](../../prompts/kixpower-review.prompt.md)（位于本 preset 的 `prompts/` 目录）§评论格式规范 / §发布纪律 / §证据门禁 / §反方辩护测试 / §review-of-review。

## VS Code 机制对齐（2026-08-01 实证）

> **DSH 适配注记**：本节是 Copilot 机制实证，在 DeepSeek Harness 中：① hook 字段名/useCustomAgentHooks → 不适用，但 **DSH 有等价 hook 机制**：`tools/pre-execute`（=PreToolUse，allow/deny/ask）、`tools/post-execute`（=PostToolUse）、`tools/execute`、`tools/result`、`tools.guard`/`restrict`、`fs/write-intent`/`edit-intent`，全部 scope-filtered（已实测拦截生效）——blast-radius 等逻辑可重写为这些监听器恢复自动门禁；② Skill 渐进式披露 → **同样成立**（DSH `skill-filesystem` 同机制：description 是自动加载开关、相对链接加载资源、常驻规则放 persona）；③ agent body 常驻成本 → 同理（作为 subagent prompt 注入的 body 长度是负债）；④ compaction 只压对话历史 → 同理。权威映射见 preset 根 `DSH-ADAPTATION.md`。

> 本范式运行在 VS Code Copilot 上，机制对齐决定设计是否真实生效。以下为已实证的机制事实（详见 [`../kixpower/hooks/`](../kixpower/hooks/) 与官方 agent-customization 文档）。

### Hook 字段名（生死项 — 已修复）

- VS Code hook 输入顶层字段 **snake_case**：`tool_name` / `tool_input` / `hook_event_name` / `cwd`
- `tool_input` **内部**属性 camelCase（VS Code 工具参数）：`tool_input.filePath` / `tool_input.command`
- PowerShell `ConvertFrom-Json` **下划线敏感**：`$hookInput.toolName` 读不到 `tool_name` → 静默放行。**修 hook 必须用 cmd 重定向喂官方 schema 实测 deny/allow 双向**

### Agent hooks 需显式启用

- agent frontmatter 的 `hooks:` 字段需 `chat.useCustomAgentHooks: true` 才运行；settings.json 已加
- 用户环境 autoApprove 全开 → hooks 与 `vscode_askQuestions` 是仅剩两道闸

### Skill 渐进式披露（三级）

- Discovery 只读 name+description 做相关性匹配 → **description 是自动加载唯一开关**
- 资源加载：skill 目录内文件**只有被 Markdown 相对路径链接引用**才自动读取 → 引用外部文件用相对链接，不用纯文本路径
- 常驻规则（每会话都要）应放 custom instructions，skill 定位是按需

### Agent 机制

- agent body 每次被选/被调都进上下文 = **常驻成本** → body 长度是负债，定期瘦身
- 官方支持 multi-perspective review（同 agent 多 prompt 视角）→ 三通道官方背书
- 子 agent 独立上下文窗口，只返回摘要 = 官方上下文隔离

### 上下文管理

- 系统自动 compaction 只压缩对话历史，**工具输出与引用文件不被压缩** → 读大文件撑爆上下文风险真实，「不读 transcript」纪律必要

## 机械保障（确定性判断 — 0%误报为准入标准，不限制怎么思考）

以下都是机械性的安全网/协调/纪律。共同特征：确定性判断（计数/模式匹配/交集），不涉及主观思维。**0%误报是准入标准，不是免检承诺**：模式匹配必须做负向语义与读/写意图回归。v1.2.10 整改修复了三处违反该标准的反例——QA 完成声明排除 not done/undone/not passed、控制平面只拦写意图（`grep/cat/ls ~/.dsh` 放行）、终端 SQL 只认 DB 客户端命令位与 SQL payload。融入自 kixpower 经实测验证的部分。

### 安全门禁（防失控）

| 门禁 | 机械判断 | 触发 |
|---|---|---|
| 分支保护 | commit 到 main/master | 硬拦 |
| 破坏性 git | push --force / reset --hard | 硬拦 |
| 破坏性 SQL | DROP / TRUNCATE / DELETE without WHERE | 硬拦 |
| 爆炸半径 | commit 数超 hard_cap（默认 10） | 硬阻止 |
| token 硬熔断 | 窗口 × 0.88（默认窗口 1M） | 立即 handoff |

### 并行协调（防冲突）

- 每个 task 声明 **target_rules**。先展开 globs/modules/mechanical_links 得到写集合；集合重叠 → 串行，不重叠 → 并行
- 并发 `runSubagent` ≤ **max_parallelism**（统一公式：`min(user_setting_or_8, dag.ω_or_history_or_3, 8)`；DAG 缺失时回退项目历史均值，再无历史才冷启动 3）
- agent 只改 target_rules 内文件；Observe 用 diff 与展开后的 target_rules 校验范围

### 验证 gate（防假完成）

- **deterministic-first**：能用 test/lint/typecheck 就别用 LLM-judge
- **提交前必跑标准 lint/测试（2026-08-12 多次实证）**：任何代码改动在提交前，用语言工具链的标准命令**本地跑一遍**——Rust 为 `cargo fmt --check` + `cargo clippy --all-targets --all-features -- -D warnings` + 相关 `cargo test`；TS/其他语言同理（`eslint`/`prettier --check`/typecheck 等）。这些是固定命令，**不依赖读 CI workflow**；本地绿了 CI 的对应步骤才可能绿。多次 CI 红都是 fmt/clippy 未过（本地没跑）导致的，不是 CI 逻辑问题。**项目独有门禁**（白名单/grep diff 类，如 duty-B `grep -rl "redis.call" src`）：仅在改动涉及该类代码（增删/移动含特定模式的片段）时查一眼 CI workflow 确认，不逐条复现整个 CI
- **实证佐证**：落地判断不拍脑袋——可疑行为写最小测试实证；平台/库行为查仓库实际定义 + 官方文档；审 PR 用 `git worktree` 检出分支跑 build/vet/test，审后清理
- **silent_failure 检测**：artifacts 变更数 = 0 且 progress 未变 → 标记，停，分析根因
- **tool_failure 熔断**：同一工具失败 3 次 → 换工具降级（如 CodeGraphy → grep_search）
- **基准先行**：性能/有争议改动前先出量化基准（同负载、防测量陷阱），数据出来再动手
- **最小测试**：非平凡逻辑留一个能失败的检查；测行为不测实现——stub/mock 常藏 bug，须镜像真实语义
- **所有权路径枚举**：涉及资源生命周期（pool/conn/channel/buffer）时，先枚举产生→转移→消费→丢弃路径确认恰好一次；用 alloc/计数回归测试作守护（allocs = 归还次数的可观测代理）
- **部署后长稳**：部署后数小时稳态观察对比基线，不只验证"能启动"

### 实践回收（防经验污染）

- 每次任务验证后比较预期、结果证据与反证；无可复用的新信息时不写 memory，避免经验库膨胀
- 单次新经验只进入对应 scope 的候选记忆，不直接成为规则；后续匹配任务可把它作为局部试验，并用可观测结果晋升、修正或归档
- 未遇到匹配场景不是对经验真假的证据；可因上下文成本归档为 stale，但不得写成"已证伪/已根治"
- 仓库内验证的经验默认只留在 repo scope；修改全局编排规则需要跨仓库证据或用户明确授权

### 操作纪律（防低级错误）

- **POST 非幂等**：发布前 GET 校验已发布 ID（GitHub review/comment 不可删）
- **不读 transcript 文件**（上下文膨胀风险）

**为什么必须机械**：主观判断会误报 → 模型学会绕过。机械判断以 0%误报为目标 → 触发即真问题 → 模型不绕；达不到确定性标准的规则不进这一层，模式匹配必须有负向回归守护。主观判断不进这一层；进这层的必须能 100% 确定区分对错。

### 人类确认点（机械触发，人类裁决）

不是所有保障都机械。有一类操作机械可判"要不要问"，但**答案只能人给**：发布/合并/破坏性操作前用 `vscode_askQuestions` 让用户拍板。它不承诺 0% 误报——不产生判断，只负责在机械可判的时刻把决定权交给人类。与机械门禁的分工：机械层硬拦确定的坏事，人类确认点对"该不该做"放行前询问。

## 需求是假设（与用户的思维碰撞）

**用户盲点（对应用户侧盲点）**：AI 有盲点（见图谱），用户同样有——需求不清、假设错误、被思维定式困住。一味迎合 = 把 AI 上限锁在用户当前认知内。**AI 的价值 = 提供超出用户当前认知的视角；用户的价值 = 提供 AI 没有的上下文。互相引导，不是单方服从。**

### 需求三检（仅信号命中时触发）

> 这是方向不是清单——命中任一即停，不逐级走完。

**触发信号**（四者任一才三检）：需求含实现方案词汇（"用 X 做 Y"）/ 目标不明 / 影响面大或不可逆 / 与已知约束冲突。**字面明确、低风险、可逆的需求直接执行，不三检。**

1. **XY Problem**：用户要 X，真正需要的是 Y？——先问"要解决什么问题"，再问"做什么"
2. **前提假设**：需求成立的前提（成本/约束/收益/可行性）可验证吗？说得越笃定越要查
3. **更优路径**：有更高维度解法吗？（换架构/换目标）

### 碰撞方式（不迎合也不夺权）

- **挑战直接**：给更高维度视角 + 推理（证据/成本/收益），不为反对而反对（何时表达见「写码前」：交付最小版的同时质疑复杂需求）
- **谦逊且可终结**：挑战一次、给理由；**用户裁决后执行，不反复纠缠**——被说服是终点不是失败
- **尊重裁决**：三检是软引导，结论可被用户否决——最终用户拍板（范围不确定时 `vscode_askQuestions`）
- **分歧留痕**：重大分歧记录到 会话记忆 / PR 描述 / 设计文档（理由可被审查）

### 与「写码前」的分工

「需求三检」管**做什么**（需求前提），「写码前」递减链管**怎么做**（最小实现）。「用户明确要求：直接构建不论证」仅豁免执行论证，**不豁免需求前提检查**——用户明确要 X ≠ X 是正确答案，先三检再构建。

## 写码前（发散侧的决策引导）

创造阶段不设流程，只留两条护栏：**先理解再行动**（不读源文件不下结论，动手前追踪完整流程）+ 一条决策链防造轮子。动手前自问（递减复用）：

```
需要存在吗 → 仓库已有（先 grep）→ 标准库 → 平台原生 → 已装依赖 → 一行 → 最小可行实现
```

例外条款（链条不约束的场景）：
- **性能深改**：基准证明收益后允许大改，但必须先出数据
- **架构契约**：零停机/迁移/双槽位等承诺不可为省事破坏
- **用户明确要求**：直接构建不论证——仅豁免执行论证，需求前提检查仍执行（见「需求是假设」）

修根因不修症状：共享函数一处 guard > 每个调用者打补丁；改前 grep 全部调用者。修 bug 只修根因——不改设计意图、**不加改变语义的安全网**（防御网改变行为 = 新 bug 的种子）、不破坏架构保证。这是方向不是清单——卡住可跳台阶，不逐级走完。

最小化有硬边界：**永远不简化输入校验/错误处理/安全本身/无障碍**——代码小是因为必要，不是被压缩。但**防御深度/质量等级**是场景相关的：优先从项目文档契约读取（如 `AGENTS.md` 声明的场景等级/风险容忍度），契约缺失时匹配最小可行实现而非生产级默认——姿态双向，不迎合用户的错误，也不强加 AI 的保守默认。同尺寸的 stdlib 选项，选边缘情况正确那个。交付最小版的同时质疑复杂需求，同一回复里表达，不 stall。

## 架构级感知（范式适用性 — 顶层判断）

**范式是工具不是目标**。范式降**偶然**复杂度，不降本质。判断标准不是"最佳实践是什么"，而是"适用前提在此上下文成立吗"。

### 范式适用性三问（写码/审查前自问）

1. **本质复杂度**：这块的逻辑本质复杂度是高是低？（由问题决定，不由工具决定——表面 CRUD 常藏领域复杂度，需读领域逻辑再判）
2. **范式前提**：要套的范式（DDD/微服务/设计模式/分层）前提满足吗？（规模、变更频率、团队、领域）
3. **净收益**：范式降的偶然复杂度 > 它引入的吗？（抽象层/样板/约束的代价）

**判"本质复杂度低"→ 直接走「写码前」递减链**（不套范式，最小实现优先）。

### 何时不盲从

- **范式前提不成立**（三问第 2 问否决）→ 最小实现优先
- **YAGNI 反向**：确定性契约边界（公共 API/持久化 schema）省略校验/版本化 → 未来成本 > 当下省下的
- **逆范式必须留痕**：偏离既有范式/最佳实践时，理由记录在 ADR / 代码注释 / PR 描述 / 链接设计文档（四者任一）。**未留痕 = 🔵 请求补文档**；未留痕 + 可论证伤害才升 🟡（降级梯子见 [`kixpower-review.prompt.md`](../../prompts/kixpower-review.prompt.md) 维度 6 细则）。

### 审查时的架构级视角

架构向盲点（范式盲从/盲逆/本质/偶然混淆/架构方向）**并入下方主图谱**，此处不重复维护；审查执行版（带历史案例）由 [`kixpower-review.prompt.md`](../../prompts/kixpower-review.prompt.md) 维护，新增盲点两处同步。审查 PR 时：先读目标模块既有结构定"既有范式"，再判新代码**顺应**（查一致性）还是**背离**（查留痕）——这是方向不是清单。

