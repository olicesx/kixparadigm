---
description: "🔍 [v5.7] PR 审查模式：独立 worktree deterministic gate + 专用只读 reviewer 异质复核 + 发布确认。用法：/kixpower-review 或 /kixpower-review <PR编号>"
agent: "kixpower-orchestrator"
---

> **DSH 适配注记**：本流程从 VS Code Copilot 导入，在 DeepSeek Harness 中执行。工具名已按 preset 根 `DSH-ADAPTATION.md` 映射为 DSH 原生（run_in_terminal→`pwsh`、read_file→`read`、grep_search→`grep`、replace_string_in_file→`edit`、create_file→`write`、vscode_askQuestions→`ask_user_question`、runSubagent→`subagent`/`subagent_cross`（prompt 注入 agents/*.agent.md 角色 body）、mcp_github_*→`mcp__github__*` 或 gh CLI、codegraphy_*→`grep`/`read`）；**跨厂商复核不再写死模型字符串，用 `subagent_cross` 工具行（kix-route 自动取反厂商）**。`{{input}}` 即用户输入。`/kixpower-*` 已注册为 DSH 原生命令（kix-commands 插件）：用户敲 `/` 可见候选，触发后本文件正文经剥离 frontmatter 注入为 user 消息，模型按流程执行。

执行 **模式 4：PR 审查**。

## 输入

用户输入：`{{input}}`

解析规则：
- 空白 → 通过 `gh pr list` 让用户选一个 PR
- 含数字 N → 审查 PR #N
- 含 URL → 从 URL 提取 owner/repo/PR 编号

## 触发条件检查（前置 gate）

**执行前必须满足**：
1. 项目有 `.git` 目录
2. 项目有 git remote（`git remote -v` 输出非空）
3. remote 是 GitHub（URL 含 `github.com`）
4. 发布渠道可用：`gh` CLI 已认证（`gh auth status` 通过），或 MCP GitHub 写工具可用（`get_me` 返回身份）

**任一不满足**：
- 无 remote / 不是 GitHub → 提示用户去模式 1/2/3（无 PR 可审）
- 两条发布渠道均不可用 → 提示安装并认证 `gh`，或启用 GitHub MCP（`get_me` 可验证）

## 执行流程

### 阶段 1：PR 元信息收集（orchestrator 自己，不调子 agent）

```bash
# 通过 gh CLI 拉取（不依赖 git fetch）
gh pr view <N> --json number,title,author,baseRefName,headRefName,additions,deletions,changedFiles,body,labels
gh pr diff <N> --name-only           # 变更文件清单
gh pr diff <N>                       # 完整 diff（用于深度审查）
```

把这些信息写入临时草稿 `docs/reviews/pr-<N>-draft.md` 的 frontmatter：
```yaml
---
pr: <N>
title: "<title>"
author: <author>
base: <baseRefName>
head: <headRefName>
stats: { additions: A, deletions: D, files: F }
labels: [...]
review_date: 2026-07-28
reviewer: kixpower-orchestrator
---
```

### 阶段 1.5：独立 worktree + deterministic gate

不改用户当前工作树。在临时 worktree 检出 PR head，读取完整函数体并运行仓库可用的最小 gate：

1. `git fetch origin pull/<N>/head:refs/kixpower/review/<N>`，然后 `git worktree add <TEMP>/kixpower-pr-<N> refs/kixpower/review/<N>`。
2. 按仓库 manifest（Cargo.toml / package.json / go.mod 等）选择仓库原生 gate，并合并为一次终端调用：Go=`go test ./...` + `go vet ./...`；Rust=`cargo test --workspace` + `cargo clippy --workspace --all-targets -- -D warnings`；Node=仓库 package scripts 中已有的 test/lint/typecheck。禁止凭技术栈猜不存在的命令。
3. 记录命令、exit code 与关键失败摘要。环境依赖缺失时标 `not-run: <阻塞原因>`，不得声称已验证。
4. 审查完成后仅清理本流程创建且保持干净的临时 worktree；用户工作树和已有 worktree 一律不动。WSL 仓库必须用 WSL git 执行 worktree 操作，禁止 Windows git 操作 UNC 路径。

若 fork 权限、网络或平台限制导致无法检出，继续静态审查，但在结论中显式声明 deterministic gate 未执行及未审阅边界。

### 阶段 1.7：加载 review 实践项

读取项目 canonical `<PROJECT_ROOT>/.kixpower/memory/repo/harness-backlog.md` 中非 archived 的 `review|any` 项，先按 `overlaps_with` / `supersedes` 去重；宿主 `/memories/repo/` 仅作 legacy adapter：
- `validated` + trigger 匹配本 PR → 作为 repo 级审查实践应用，并在草稿记录 item ID / regression_signal 供阶段 2.7 监测
- `candidate` + trigger 匹配本 PR → 仅作为本次 review 的 scoped trial，在草稿记录 trial ID、`result: pending` 和可观测 eval
- task kind 不匹配 → 不处理；task kind 匹配但 trigger 不匹配 → 不应用并递增 `unmatched_runs`。仅当条目配置的 `archive_after_unmatched` 达到阈值时归档为 stale；不得把未触发写成 pass、已证伪或已根治

实践项只影响内部审查过程，不得出现在公开 review body。

### 阶段 2：分层审查（orchestrator 判断 + `subagent_lite` 并行机械取证；v5.8 成本分层）

基于 diff + worktree 中完整源码按 7 个维度逐项审查，每个维度产出 verdict + 评论清单。**禁止修改代码**，只生成评论。

**取证分工（v5.8，日志实测驱动：大 PR 逐文件内联读取 + high effort 思考，58 步烧 156k 思考仍未见底）**：
- **判断留在 orchestrator**（不派子代理）：维度 verdict、严重级别、契约对照、跨文件综合推理、反方辩护；
- **机械取证派 `subagent_lite`**（并行 ≤2；只读 read/grep/glob/pwsh 四工具 + 8K 帽 + 思考 ≈0，每步固定开销 34.3k → ~5.9k，↓83%）：通读 diff 文件、提取目标文件既有代码基线（维度 4 风格基线）、grep 符号定位、枚举测试覆盖与边界（维度 5）、逐文件核对清单；
- **判定标准**：只读/检索/核对/枚举 → lite；需判断/权衡/综合 → orchestrator。**禁止 orchestrator 逐文件通读 diff**（机械步骤全部走 lite）；
- **证据门禁不变**：lite 回流的是「取证素材」，orchestrator 仍须按下方证据门禁核验（引用 `文件:行号`、权威源），不得把 lite 输出直接当结论；lite 只读不写，不得用它执行任何有副作用的步骤。

#### 维度清单

| # | 维度 | 检查项 | 评论位置 |
|---|---|---|---|
| 1 | **Security** | 凭据泄露（API key/token/密码硬编码）、注入风险、权限提升、SSRF、缺失 auth check | 行内 |
| 2 | **Correctness** | 业务逻辑错误、边界条件、null 处理、并发竞态、错误传播 | 行内 |
| 3 | **Performance** | N+1 查询、循环内 IO、不必要的克隆、内存泄漏、锁粒度过大 | 行内 |
| 4 | **Style/Maintainability** | 命名、复杂度、重复代码、缺失注释（仅关键函数）、YAGNI 违规、**与目标文件既有代码风格一致性**（命名/错误处理/测试/模块模式——先读 PR 目标文件的既有非 diff 部分提取基线，同 Dev 工作流 step 1；v5.3） | 文件级 |
| 5 | **Test Coverage** | 新增代码是否有测试、边界场景、回归风险、mock 是否合理 | 文件级 |
| 6 | **Architecture** | 模块边界、依赖方向、抽象泄漏、与 PROJECT_BRIEF.md 决策一致性、**范式适用性**（见下） | PR 级 |
| 7 | **Docs** | API 文档、CHANGELOG、README、ADR（重大决策） | PR 级 |

**严重级别**（每条评论必须标）：
- 🔴 **blocking**：必须修才能合并（安全/正确性）
- 🟡 **major**：强烈建议修（性能/架构）
- 🔵 **minor**：可选改进（风格/文档）
- ✅ **nit**：极小问题（拼写、格式）

**严重度处置纪律**：🔴 必须修或**显式询问**是否降级——禁止自行判定"罕见/ROI 低"静默跳过。觉得严重度过高同样要明说并问。严重度处置权在人，不在 reviewer 默认。

**blocking/major 定性门禁**：必须同时有行为证据、被违反的适用项目契约 / 威胁模型 / 设计意图，以及实际影响。契约证据可来自仓库与 PR 文档、公开 API / 类型 / schema、代码注释、既有测试、调用方依赖的稳定行为或可验证的安全不变量；没有独立契约文档不等于没有契约。只证明行为真实或影响严重不够；契约不明，或任一独立 reviewer 基于代码 / 文档提出尚未解决的 intentional / explicit opt-in 反证时，只能降为需作者确认的 comment 级疑问。

**架构级感知（维度 6 细则，范式适用性）**：范式是工具不是目标（Brooks 1986：范式降偶然复杂度，不降本质复杂度）。先读目标模块既有结构，再判新代码**顺应**还是**背离**：
- **范式适用性三问**：① 本质复杂度（问题固有复杂度，由问题决定——表面 CRUD 常藏领域复杂度，需读领域逻辑再判）；② 范式前提（规模/变更频率/团队/领域满足吗）；③ 净收益（范式降的偶然复杂度 > 引入的吗）
- 顺应既有范式 → 查一致性（模块边界/依赖方向/抽象泄漏）
- 背离既有范式 → 查**留痕**：ADR / 代码注释 / **PR 描述 / 链接设计文档**（四者任一）
- **严重级别降级梯子**（对齐 v5.3 风格规则）：范式判断是主观判断，**默认 🔵 minor 或 comment 级疑问**。仅当同时满足 (a) 有模块结构证据 `文件:行号`、(b) 与 PROJECT_BRIEF.md 文档化决策冲突或爆炸半径大（小模块引入大范式），才升 🟡 major
- 未留痕 = 🔵（请求补文档）；未留痕 + 可论证伤害才升 🟡
- 范式 finding 也过证据门禁变体：附 既有结构 `文件:行号` + 留痕检索结果；"本质复杂度低/规模不匹配"无法取证 → 降级 🔵/comment
- 架构方向：此改动让系统更一致还是更分裂（Conway：架构反映沟通结构）

**风格一致性 finding 的严重级别约束（v5.3）**：纯风格分歧（命名/模式）默认 🔵 minor 或 ✅ nit；仅当违反 PROJECT_BRIEF.md 编码约定段（若有）才升 🟡。风格判断同样适用下方证据门禁——先读既有代码取证，禁止凭"通用最佳实践"印象下判断（与 Dev step 1 风格基线读取形成写-审闭环）。

#### 证据门禁（claim-evidence gate，v5.4）— 下 finding 前必须满足

> 反模式 A（PR#26）：**印象式技术断言**——凭"印象中的库行为"下 high-severity finding，不查权威源。
> 反模式 B（PR#2984）：**单维验证虚假自信**——取了证但挑错维度（验证表面/局部属性，漏深层/全局语义）。比 A 更隐蔽。
> 案例详情与复盘见 AUDIT.md §3.1-3.2。

任何 finding 若其成立**依赖某项外部技术语义**（库 API 行为、框架契约、存储/协议解析规则、语言语义等，如"X 按 Y 方式解析/执行"），在标定严重级别**之前**必须：

1. **取证**：从权威源核实该语义。优先级：版本对应的官方文档（`fetch_webpage` / `mcp_context7_get-library-docs`）> 源码契约行号（读实际文件，如 migration DDL、类型定义；不要只看 diff 外观）> 项目内既有测试的既成行为。
2. **引用**：在评论中附证据（文档 URL + 关键句，或 `文件:行号`）。
3. **无法证实则降级**：当场无法证实的语义类 finding，禁止标 blocking/major；没有反向证据时降为「需作者确认」的 comment 级疑问，已有反向证据证伪时才撤回。
4. **盲点意识（v5.5，补足范式）**：模型在以下方向有系统性盲点（基于 LLM 注意力机制 + PR#2984/PR#26 历史案例）。这些是**盲区提醒**，不是检查清单——你的推理空间不受限，发现表外盲点同样有价值。**目标是补足盲点，不限制发挥。**

**红线**：读到代码外观（如"字符串无时区后缀"）≠ 证实的语义（"按服务器时区解析"）。前者是事实，后者是需取证才能下的断言。禁止凭记忆中的技术行为标 blocking/major。

**规范性结论分层**：按 `TEAM_CONVENTIONS.md` §证据门禁分别记录机制、契约与影响，禁止跨层外推。

##### AI 盲点图谱（v5.5，补足用 — 非检查表）

> 与反方辩护测试（下方）+ review-of-review（阶段 2.5）配合：图谱识别盲区方向，反方辩护提供思考工具，专用只读 reviewer 提供独立视角。三者补足模型盲点，**不规定怎么思考**。

| 盲点 | 表现（历史案例） | 补足工具（选哪个由你判断） |
|---|---|---|
| **深度不足** | 看到调用链/签名就停，没读被调用方函数体（PR#2984：只看 `healthCheck→provider.HealthCheck` 调用链，漏读 `check()` 的 `if len(proxies)==0 return`） | `read_file` 读实现；反方辩护第2问"最深属性" |
| **读写混淆** | 验证了"读安全"（不 panic），漏了"写副作用"（PR#2984：验了 Unwrap 不 dereference，漏了 `findAliveProxy` 的 `f.selected=""`） | 追溯函数是否赋值外部变量；review-of-review 独立查 |
| **语言语义盲区** | 凭"能复用"推断，忽略分派/所有权/并发差异（PR#2984：建议抽 GroupBase helper，漏了 Go 嵌入静态绑定跳过 URLTest override） | 反方辩护第3问"语言分派语义" |
| **自信偏差** | 声称"已验证"但未产出工具证据（PR#2984：声称"两 bug 正确修复"但没读 check() 实现） | 要求附 `read_file`/grep 实际输出作证据 |
| **广度优先** | 覆盖能看到的表面，忽略需深挖的语义 | 盲点图谱提醒 + review-of-review 第二视角 |
| **范式盲从** | 只见"最佳实践"，不问适用前提（本质复杂度/规模/领域） | 范式适用性三问（见维度 6 细则） |
| **范式盲逆** | 偏离范式未留痕，把偷懒当架构决策 | 逆范式查 ADR/注释/PR 描述；未留痕 = 🔵，未留痕 + 可论证伤害才 🟡 |
| **本质/偶然混淆** | 把偶然复杂度当本质，或反之（表面 CRUD 常藏领域复杂度） | 读领域逻辑判固有复杂度，不凭代码外观 |
| **架构方向** | 只见 PR 内对错，不见系统走向 | 问：此改动让系统更一致还是更分裂（Conway） |
| **默认姿态偏差** | 低风险场景（本地工具/原型/个人脚本）的 PR 仍按生产级标准挑"防御深度不足"（缺重试/幂等/容错）→ 误报 finding；或反向把过度防御当"严谨"放过 | 判防御深度类 finding 前，先从 PR 上下文/项目契约（`AGENTS.md` 场景等级）确认质量等级；本地级场景不要求生产级容错 |
| **恰好一次不变量** | 资源/副作用需恰好一次（归还/关闭/转移/投递），验证只走主路径漏分支（hy2 GSO use-after-send；tuic 漏 3 个 drop 分支归还 → pool buffer 永久丢失） | 枚举全部产生/消费/丢弃点含错误与关闭分支，逐路径核对次数不变量；所有权转移后不可触碰 |
| **依赖链范围** | 审查/分析只覆盖工作区，漏 replace fork 或依赖仓库（hy2 panic 根因在 quic-go fork 的 `sendPacketsWithGSO`，不在 outbound 工作区；初查只搜了 udphop 层） | 先读 go.mod replace 声明锁定 fork 路径；grep/read 覆盖 fork 仓库；涉及 fork 的 finding 必须基于 fork 实际源码 |

**关键原则**：这些是盲区**方向**，不是检查**清单**。补足工具是赋能（给独立视角/工具锚点），不是约束（规定怎么想）。**模型的推理能力是主力，图谱只补足已知盲区**——发现图谱之外的盲点同样有价值。

##### 反方辩护测试（v5.4，发布 gate 前对所有 major+ finding + 所有"建议"类 finding 必跑）

对每条受测 finding，写答案到 review 草稿（不发布），三问：

1. **作者最可能的技术反驳点是什么？**（写 1-2 句具体技术论点；同时回答该行为是否可能 intentional / explicit opt-in，以及它违反哪条适用契约或威胁模型）
2. **我验证的最深层属性是什么？** 是停在表面调用链/签名，还是读到了函数体/被调用方实现？
3. **对"建议"类**：这个建议在目标语言的【方法分派 / 类型系统 / 并发模型 / 所有权模型】下成立吗？

**决策**：任一问答不出 / 答案揭示验证不足 → 该 finding 降级为 comment 级疑问，或补验证后再定级。reviewer 自己猜测「可能 intentional」只触发继续取证；任一独立 reviewer 基于代码 / 文档提出 intentional / explicit opt-in 反证时，必须先解析项目契约；仍不明确则询问作者，不得发布 major+。

### 阶段 2.5：异质 review-of-review（重要结论 MUST）

> Deterministic gate 验运行行为，review-of-review 验 finding 的证据维度；两者正交。来源与实证见 AUDIT.md §3.2。

**触发条件**（任一即 MUST 同时调用 `kixpower-dev` + `kixpower-qa` 两个独立视角）：
- 准备发布 `APPROVE`（包括 0 finding 的正面结论）
- finding 数 ≥ 3
- 含 blocking 或 major finding
- 含「建议抽象/helper/重构」类 finding
- 含「X 正确修复 Y」类正面断言（最易虚假自信）

**不触发**：只发布纯 minor/nit 的 COMMENT，finding < 3 且不含确定性正面断言。

**流程**：
1. 把 review body 草稿 + PR diff 写入 `docs/reviews/pr-<N>-draft.md`
2. 并行调用两个子 agent，二者都必须独立读取 PR diff 与相关实现，不读取彼此结论：Dev 验实现/语言语义，QA 验行为/边界/证据；两个调用分别使用下方指定的不同厂商模型，不可用时再按 kixParadigm 的跨厂商候选降级
3. orchestrator 按机制事实 / 项目契约与设计意图 / 影响与严重度三层汇总；只在同一层判断异质多数，禁止跨层投票。任一独立 reviewer 基于代码 / 文档提出反证就深挖分歧，未解决不得保留确定结论
4. 对每条 major+ 在草稿写入 `claim_gate: {mechanism, contract, impact}`，值仅允许 `confirmed | disputed | unknown`；三项全为 `confirmed` 才能进入阶段 3，反证未解决时对应项必须为 `disputed`
5. `APPROVE` 还要求两个独立 agent 均未发现 blocking/major；否则拒绝 approve
6. 复核通过后才进入阶段 3 发布 gate

**Dev 子 agent 调用模板**（Tri-Block；DSH：用 `subagent_cross` 自动取反厂商 = 异质第二视角，不写死模型字符串）：

```
工具: subagent_cross
prompt: |
  [CONTEXT]
  handoff_mode: review
  review_readonly: true
  review_origin: kixpower-review
  PR #<N>
  review_worktree: <path>
  review_head_sha: <PR head 的完整 40 位 SHA>
  不得读取其他 reviewer 结论
  [TASK]
  以实现/语言语义视角独立读取 diff、调用方和被调用方实现，验证 correctness/security；报告遗漏 finding 或对草稿 finding 的技术反证
  [CONSTRAINTS]
  只读，不修改文件，不发布评论
  只输出 YAML：claims: [{id, mechanism: {status, evidence}, contract: {status, evidence}, impact: {status, evidence}, rebuttal}]；status 仅允许 confirmed|disputed|unknown
```

**QA 子 agent 调用模板**（Tri-Block；DSH：用 `subagent` 继承主模型 = 同厂商视角，与 Dev 的跨厂商视角形成异质对）：

```
工具: subagent
prompt: |
  [CONTEXT]
  handoff_mode: review
  review_readonly: true
  review_origin: kixpower-review
  PR #<N> review 草稿：docs/reviews/pr-<N>-draft.md
  review_worktree: <path>（Orchestrator 已检出 PR head；从该目录读取完整 diff 与实现）
  review_head_sha: <PR head 的完整 40 位 SHA>
  规则：TEAM_CONVENTIONS §证据门禁（四步硬约束 + 规范性结论分层 + 反方辩护）
  [TASK]
  以运行行为/边界/测试真实性视角独立读取 worktree 中的 diff 与相关实现；可提出遗漏 finding 或技术反证。
  [CONSTRAINTS]
  只输出 YAML：claims: [{id, mechanism: {status, evidence}, contract: {status, evidence}, impact: {status, evidence}, rebuttal}]；status 仅允许 confirmed|disputed|unknown
  不改文件，不发布评论
  token 预算：≤15K
```

**反模式（禁止）**：把草稿结论直接喂给两个 agent 要求“确认”。两个 prompt 必须要求独立读代码和主动找反证，避免同质附和。

### 阶段 2.7：实践回收

- 先验证本次 pending trial 是否确实进入审查链路；未应用则保持 pending，不得判 pass / fail
- 有真实证据满足 pass_criteria 且无 regression → trial `pass`，对应项晋升 `validated`，并把其 `supersedes` 列出的旧项归档；反证 / regression → trial `fail`，保持 `candidate`，独立证据直接证伪才归档为 rejected
- 本次已应用的 validated 项若命中 regression / 反证，降回 candidate 并追加 counterexample
- 本次出现可复用的新流程证据时，先搜索 active 与 archived stale 同类项并合并 / 恢复；确无同类项才以 `status: candidate` + origin evidence + `task_kinds: [review]` 写入 repo harness-backlog；无新信息不写长期记忆
- review 模式不得自动修改用户级 Kix 编排；全局晋升需要跨仓库证据或用户明确授权

### 阶段 3：发布 GitHub pending review

#### 🔴 步骤 0：发布前用户确认 gate（MUST，不可跳过）

> 所有评论内容（行内 + PR 级汇总）准备完毕后、调用 GitHub 写工具**之前**，orchestrator 必须调用 `ask_user_question` 让用户确认。禁止"准备好就直接发布"。

> **全权委托语义（2026-08-12 实证）**：用户"全权委托/自由审阅"授权**执行**审查，**不豁免**本确认 gate；仅当用户显式声明豁免（如"跳过发布确认"）才可跳过。委托 ≠ 授权默认跳过安全 gate。

**确认 gate 调用规范**：

- 问题数量：1 个
- `header`: `post-gate`
- `question`: `即将向 PR #<N> 发布 <X> 条行内评论，并提交 <APPROVE|REQUEST_CHANGES|COMMENT> 汇总 review，是否继续？`
- `message`（markdown 上下文）：附上评论摘要表（严重级别 / 文件 / 一句话主题），让用户能在不展开全文的情况下判断
- `options`：
  - `发布 <APPROVE|REQUEST_CHANGES|COMMENT>`（recommended）—— 明确授权该 GitHub review state 后 POST
  - `我想先看完整内容` —— orchestrator 把每条评论完整 body 输出到 chat，用户阅读后再触发第二次确认
  - `取消发布` —— 不 POST，保留 `docs/reviews/pr-<N>-draft.md`，结束模式 4
- `allowFreeformInput`: true（用户可输入修改建议，orchestrator 据此调整后重新触发 gate）

**gate 通过后才进入步骤 1-7**。用户选择"取消"则保存草稿、不再 POST；选择"先看完整内容"则展示后必须再次 gate 确认才能 POST。

若带 `--save`，summary commit 完成后必须再问一个独立 `push-gate`：明确目标 PR head branch、commit SHA，并提供“推送 / 仅保留本地 / 取消”选项。评论发布确认不得替代 push 授权。

#### 🔴 发布纪律（POST 非幂等，2026-07-31 实证）

> 详细规则见 `TEAM_CONVENTIONS.md` 的「GitHub API 调用纪律」章节。此处为模式 4 强制 gate。

**不暴露方法论**：review body / summary 中禁止出现 三通道/kixParadigm/并发独立/多视角/交叉验证/主 agent/子 agent/盲点图谱/范式 等词。怎么思考是私事，呈现只讲技术问题。

**finding 内容单一来源**：
- 历史 review 已提出的 finding 不重复发布；发布前 GET 对比，重复的删，或声明「Items already raised in prior reviews (X, Y) are not repeated here」。
- 同一个 pending review 内，blocking/major 的行内评论是该 finding 的唯一详实正文。PR 汇总只能列 `严重级别 + 一句话主题 + 文件:行号 + 详见行内评论`，禁止复述证据、触发条件或影响。
- 没有可用 diff 锚点、因严重级别不发到行内、或属于 PR 级的 finding，才在汇总中详述一次。

**POST 前必跑清单**（用户确认通过后、每条 review/comment 发布前自检）：

1. **GET 校验**：发之前先 `gh api repos/<owner>/<repo>/pulls/<N>/reviews --jq '.[].id'` 看本次会话已发布的 review ID 列表，对比即将发布的，避免重复 POST
2. **exit code 0 即成功**：`pwsh` sync 模式下，**exit code 0 + 无 stderr error = 已成功**。PowerShell 长命令回显被截断（残留如 `d" -Raw -Encoding utf8`）**不是失败信号**，禁止据此重试
3. **UTF-8 body**：保留正文语言、`✅`/`🔴`/`📋` 和 em dash；优先通过 GitHub typed tool 的 body 字段发送，不做 ASCII 降级
4. **gh CLI 仅作降级**：typed tool 不可用时，多行 body 才写 UTF-8 JSON 并用 `--input`；禁止 `gh api -F body="$var"`
5. **记录已发布 ID**：每条 POST 成功后立即记下返回的 review/comment ID 到会话笔记
6. **不重试**：已发布 review 不可删除（DELETE 只对 PENDING 有效，外部贡献者 PUT 也 404），重复无法清理

#### 评论格式规范（结论前置 + 双段结构）

| 渠道 | 格式 |
|---|---|
| 行内评论（blocking/major） | **单段详实**（严重级别 + 证据 + 触发条件 + 影响；**只报 bug 不给解决方案**，见下方「约束」） |
| PR 级汇总评论 | **结论前置三段**：上半真人简述 + 结论行（不折叠）+ 下半去重索引/补充 `<details>` |
| review summary 文档（`--save`） | 同三段结构（见阶段 4） |

**结论行（永远不被折叠）**：真人简述之后、`<details>` 之前，一行明示审查结论与计数：
- `✅ APPROVE — 0 blocking / 0 major`
- `🔴 CHANGES REQUESTED — N blocking / M major`
- 若用户明确选择仅提交 COMMENT 而不做正式批准：`💬 COMMENT — 0 blocking / 0 major`，不得在 COMMENTED review 正文中写 `APPROVE`

**上半「真人简述」风格** = 结论 + 一句话原因，1-2 句，贴近真人 reviewer 口吻、不堆术语、不放严重级别标签：
- ✅ 好例：「这批主要是命名和注释的小问题，不影响功能。几处变量名跟返回类型对不上，有空顺手改下即可。」
- ❌ 坏例（这是下半详析的语气，不是上半）：「🟡 minor — Maintainability：经审查发现 7 处变量命名不符合 snake_case，详见下方证据矩阵……」

**语言一致性（全文统一，2026-07-31 实证）**：整条评论 / review summary 文档的正文**只使用一种语言**，与仓库历史 review 语言一致（历史全英文则全英文；历史全中文则全中文）。**禁止中英混搭**（如英文 finding 主题 + 中文结论描述、中文 summary + 英文正文）。发布前扫描全文确认无混搭。

**下半按结论分两档**：
- **通过类（0 blocking / 0 major）— 精简档**：`<details><summary>📋 需注意的事项</summary>` 内每条 finding 只保留 `严重级别 + 一句话主题 + 文件:行号 + 一句话影响`，末尾一行验证摘要（测试/lint 结果）；**0 条 finding 时省略 details 区**。
- **需修改类（有 blocking/major）— 去重档**：`<details><summary>📋 审查索引与补充</summary>` 内，已发到行内的 finding 只列 `严重级别 + 一句话主题 + 文件:行号 + 详见行内评论`；未发到行内的 finding 才保留完整格式。末尾追加一行验证摘要。

body 模板（通过类）：

    <上半：1-2 句真人简述>

    ✅ APPROVE — 0 blocking / 0 major

    <details>
    <summary>📋 需注意的事项</summary>

    - 🔵 minor — <一句话主题>（文件:行号）：<一句话影响>
    - ✅ nit — <一句话主题>（文件:行号）：<一句话说明>
    - 验证：<一行测试/lint 摘要>
    </details>

  body 模板（需修改类）：

    <上半：1-2 句真人简述>

    🔴 CHANGES REQUESTED — N blocking / M major

    <details>
    <summary>📋 审查索引与补充</summary>

    - 🔴 blocking — <一句话主题>（文件:行号；详见行内评论）
    - 🟡 major — <一句话主题>（文件:行号；详见行内评论）
    - 🔵 minor — <无行内锚点 finding 的完整但唯一正文>
    - 验证：<一行测试/lint 摘要>
    </details>

按以下单一事务发布，避免部分评论成功后重复 POST：

1. 先调用 `get_me` 确认当前 GitHub 身份与权限，再用 `pull_request_review_write(method=create)` 创建 pending review（暂不提交）。
2. 对 blocking/major 逐条调用 `add_comment_to_pending_review`，使用 `path/line/side` 精确定位。
3. 全部行内评论成功后，调用 `pull_request_review_write(method=submit_pending)` 提交去重汇总 body；event 与结论文本严格一致：有 blocking/major=`REQUEST_CHANGES`，0 blocking/major 且用户确认正式批准=`APPROVE`，用户明确只评论=`COMMENT`。
4. 任一行内评论失败时保留 pending review，不得创建第二个 review；修正后继续同一 pending review，或经用户确认删除 pending。

**约束**：
- 行内评论不超过 20 条（避免 spammy）—— 选最关键的
- **只报 bug，不给解决方案（2026-08-06 用户反馈）**：每条评论只写「位置 + 触发条件 + 影响 + 证据（实测/文件:行号）」，**禁止**写"建议/正确写法/应该/改为"类内容——用户会把 review 当执行指令喂给模型，方案错则模型干歪；修法是作者/用户决策
- **安全语义敏感项不替作者做产品决策**：bwrap 沙箱等安全权衡（易用性 vs 隔离强度）只报事实（如"workspace=/tmp 时外层 /tmp 隔离丢失"），不报"应拒绝还是放行"
- 同一文件的多个 minor 合并为一条文件级评论
- PR 级汇总评论必须采用结论前置三段结构；行内评论保持单段详实，汇总对已发到行内的 finding 只建索引，不复述正文

### 阶段 4：可选 — 提交 review summary 到仓库

如果用户在 `/kixpower-review` 时加了 `--save`：
- 把 `docs/reviews/pr-<N>-<date>.md` 提交到本地 PR head branch；是否 push 使用独立 `push-gate`，不复用评论发布确认
- 文档采用三段结构（结论行不折叠，与阶段 3 规范一致）：

文档骨架：

    ---
    <frontmatter：pr/title/author/base/head/stats/labels/review_date/reviewer>
    ---

    # PR #<N> Review — <title>

    ## 总评

    <上半：真人简述，1-2 句，结论 + 一句话原因，概括整个 PR 的审查结论与合并建议方向>

    ✅ APPROVE — 0 blocking / 0 major   （或 🔴 CHANGES REQUESTED — N blocking / M major）

    <details>
    <summary>📋 详细评审（通过类改为：📋 需注意的事项）</summary>

    <下半：详实档保留 7 维度评审矩阵 + 评论清单 + 合并建议；通过类只留 finding 一句话清单 + 验证摘要>

    </details>

**禁止**：未加 `--save` 时创建任何 commit。

### 阶段 5：输出审查简报（给用户）

```
📋 PR #<N> 审查完成

| 维度 | blocking | major | minor | nit |
|---|---|---|---|---|
| Security | X | - | - | - |
| Correctness | - | Y | - | - |
| ... | | | | |
| 合计 | X | Y | Z | W |

合并建议：
- [APPROVE]：0 blocking，0 major
- [REQUEST_CHANGES]：有 blocking 或 major（列出）
- [COMMENT]：只有 minor/nit 且用户未要求正式 approve

评论已发布到：https://github.com/<owner>/<repo>/pull/<N>
```

## 硬约束

- **只读实现**：不修改源码、不 merge；只有 `--save` 且阶段 3 用户确认 push 时可推送 review summary，`--approve` 只授权正式 review state，不授权改代码
- **子 agent 有限调用（v5.7）**：满足阶段 2.5 条件时调用专用 `kixpower-reviewer` 两次，使用异质 prompt/model；deterministic gate 与独立复核都通过后才可发布确定结论
- **Token 控制**：大 PR（>500 文件）只审查 top 50 改动最多的文件
- **遵循 blast-radius**：`--save` 提交 review.md 时受 `blast-radius-check.ps1` 约束（feature branch 才允许）

## `--approve` 模式（可选）

用户输入 `/kixpower-review --approve <N>`：
- 该 flag 仅预选阶段 3 的 `submit_pending(APPROVE)`；执行仍走同一 pending review 事务，不跳过 post-gate 用户确认
- 仅当 0 blocking、0 major、deterministic gate 明确通过，且两个独立 reviewer 均未发现 blocking/major 时，post-gate 才允许选择正式 APPROVE
- 任一条件不满足 → 拒绝 approve，改为 COMMENT/REQUEST_CHANGES 并列出原因
- 未带 flag 时，用户也可在 post-gate 明确选择正式 APPROVE；禁止用 `gh pr review --approve` 另建第二个 review（PR#2980 重复发布事故模式）

## 与模式 1/2/3 的关系

| 模式 | 流程 | 修改代码 | 调子 agent |
|---|---|---|---|
| 1 (new) / 2 (import) / 3 (continue) | Producer→Dev→L2→QA→L4 | ✅ | ✅ |
| **4 (review)** | 分层审查→异质复核→发 review | ❌ | 重要结论：专用 reviewer 两次 |

模式 4 是**独立流程**，不进 Sprint 循环。可与模式 3 共存（如：先 review 一个外部 PR，再继续自己 Sprint）。
