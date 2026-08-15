# Kixpower 通用协作约定

共享规则，避免三份 `.agent.md` 重复维护。角色特化规则保留在各 agent body 中。

## 🔴 阶段二相性原则（v5.7 元规则 — 指导所有规则设计与修改）

> 核心洞察（用户提出）：**解决问题需要发散性/创造性思维，验证阶段需要摒除发散性**。两者是不兼容的认知模式，混合则互相污染（ToT 模块化设计：生成器/评估器独立——非论文消融实证，勿作实证引用；迭代自我反馈实证见 Self-Refine）。

| 阶段 | 认知模式 | 规则密度 | 论文依据 |
|---|---|---|---|
| **创造**（Producer 规划 / Dev 实现 / 脑暴） | 发散、创造性 | **最小**（目标 + 工具 + 边界） | Sutton Bitter Lesson / Chain of Thought (Wei'22) |
| **验证**（review / QA / L2 / Observe） | 收敛、机械 | 结构化补足盲点 | ToT 评估阶段 / Self-Refine / Constitutional AI (Bai'22) |

**三条硬约束**（新增/修改任何规则时 MUST 遵守）：
1. **不泄漏**：创造阶段不混入验证的机械性（不规定"怎么实现/怎么思考"）；验证阶段不要求创造的发散（机械收敛，按外部标准）
2. **补足非限制**：规则补足 AI 盲点（给工具/视角/独立 grader），不限制发挥（规定怎么思考）。固定打勾表是限制，盲点图谱+反方辩护+review-of-review 是补足
3. **规则是负债**：每条规则有维护成本 + 压制涌现能力的风险（Sutton 2019 转述：长期看内建人类知识会平台化并抑制进步——原文无此逐字句，勿当直接引语）。每次任务回收实践证据，但单次经验只作 candidate；须经后续匹配任务的局部试验和可观测结果验证后才能晋升。无新信息不写长期记忆或规则，老规则按反证与使用价值修剪

> 论文可靠性分级与来源见 [AUDIT.md](../kixparadigm/AUDIT.md) §1（复查时读，不自动加载）
## 工具使用规范

| 工具 | 用途 |
|---|---|
| `read`/`search` | 先理解代码与文档，再动手 |
| `edit` | 精确替换优先。可编辑范围由各 agent body 硬约束定义 |
| `execute` | 构建、测试、git、`gh` CLI |
| `web` | 库文档、API 用法 |
| `todo` | 跟踪多步骤任务 |
| GitHub MCP | 提 Issue/合并 PR 优先用 MCP，其次 `gh` CLI |
| CodeGraphy MCP | 代码关系图查询：模块边界、依赖追踪、影响面分析。详见下节 |

### 源码编辑纪律

- **源码编辑首选平台提供的精确编辑工具**（有 `replace_string_in_file` 时优先；当前仅有 `apply_patch` 时使用最小补丁）；**禁止用终端 inline 脚本编辑源码**（PowerShell / `python -c` / here-string），转义极易出错致文件损坏（有多次 `git checkout` 恢复案例）。
- 例外：无正则元字符的单行字符串替换可 inline（`(Get-Content) -replace 'x' | Set-Content`）；涉及正则 / 多行 / heredoc 必须用 `replace_string_in_file`。
- 多行脚本操作 → 先写脚本文件再执行，不 inline。
- **改后引用完整性**：删除/改名方法后，全量 grep 引用（**含 _test.go**）逐一处理，或显式声明未处理项。只改定义不查调用者 = 埋悬空引用。

## 🔴 输出裁剪（防上下文膨胀）

### 终端

- `run_in_terminal` >200 行预期 → 追加 `\| Select-Object -Last 100`
- 日志 → `Get-Content -Tail 50`，不读全文
- 目录 → `Get-ChildItem \| Select-Object Name`，不加 `-Recurse`

### 文件读取

- `read_file` 指定行范围，不读整个文件
- 快速定位用 `grep_search` 替代全文读
- 大文件(>500行) → 先读前 50 行再分段

### 子 agent 调用

- prompt ≤ 5K tokens
- 大量上下文先写入 `docs/`，prompt 只写"读 xxx 文件"
- 子 agent 返回 → 摘要 3 行写入 progress.md

## 模型上下文窗口约定（v3.7，MUST）

> 所有 token 阈值按**百分比**定义，避免硬编码绝对值。orchestrator 启动时确定 `model_context_window`，写入 PROJECT_BRIEF.md frontmatter。
### 并行度约定（v5.0，DAG 派生，可配置）

> 不设经验默认并行数。优先使用当前 DAG 的最大反链宽度；DAG 缺失时回退项目历史均值，再无历史才冷启动为 3。
> 用户可在 PROJECT_BRIEF.md frontmatter 设置项目上限：

```yaml
max_parallelism: 6              # 可选的项目上限，1-8
max_parallelism_source: user
```

**实际上限公式**：`min(user_setting_or_8, dag.ω_or_history_or_3, 8)`
- 8 是 API-safe 软帽（Claude/OpenAI Pro tier 通常支持 5-10 concurrent）
- dag.ω 是当前 Sprint task DAG 的最大反链宽度（Producer 计算后写入 plan.md）
- 用户 setting 优先，但不会超过 8

**选择指引**：
| 场景 | 建议值 | 理由 |
|---|---|---|
| 无用户配置 | `min(dag.ω, 8)` | 当前任务结构决定；缺 DAG 时历史均值→3 |
| API Free tier | 2-3 | rate limit 紧 |
| API Enterprise | 6-8 | rate limit 宽松 |
| 单 model 实例 | 2 | 避免自我争抢 |
| 强耦合任务（γ > 0.6） | 1（退化为 sequential） | 并行无收益 |
### 窗口确定优先级

1. 用户 slash command 显式指定（如 `/kixpower-new --ctx 200K`）
2. PROJECT_BRIEF.md frontmatter 的 `model_context_window` 字段
3. 默认 1M（2026 主流：Claude Sonnet 4.5+ / GPT-4o+ 都是 1M）

### frontmatter 字段

```yaml
model_context_window: 1000000    # tokens（默认 1M）
model_context_window_source: user | default
```

### 水位线（百分比 + 召回率依据）

> 来源：NeedleInAHaystack 召回率研究（Kamradt 方法论延伸 + kixpower 经验值；「2026 版本」为内部命名，非独立论文）

| 水位 | 占窗口比 | 1M 模型示例 | 200K 模型示例 | 动作 | 召回率 |
|---|---|---|---|---|---|
| 安全 | < 60% | < 600K | < 120K | 正常推进 | ~100% |
| 警觉 | 60-75% | 600-750K | 120-150K | prompt 精简，不内嵌文件内容 | 95-100% |
| 危险 | 75-88% | 750-880K | 150-175K | 停止调下一个子 agent，做 handoff | 85-95% |
| 临界（硬熔断） | > 88% | > 880K | > 175K | 立即 handoff | < 85%（不可靠） |

### 硬熔断（按百分比计算）

| Guardrail | 公式 | 1M 示例 | 200K 示例 |
|---|---|---|---|
| `max_tokens_per_session` | `window × 0.88` | 880K | 175K |
| `max_tokens_per_subagent_run` | `window × 0.25` | 250K | 50K |

### orchestrator 启动时计算并缓存

```python
window = read_project_brief("model_context_window") or 1_000_000
thresholds = {
    "safe":      int(window * 0.60),
    "watch":     int(window * 0.75),
    "danger":    int(window * 0.88),
    "per_run":   int(window * 0.25),
}
# 分派 prompt 时不传绝对值，传百分比（"当前 ~65% 窗口"）
```

### 模型检测（可选，未来增强）

当前不自动检测模型，靠用户告知或默认。未来可：
- 读 VS Code Copilot 设置的 `github.copilot.advanced.models`
- 或检测 API 响应头中的 `x-model-context-window`

## 内容语言约定（v3.6，MUST）

> 所有 agent 输出（注释 / commit / 过程文档）必须遵守本约定。orchestrator 启动时询问一次，写入 PROJECT_BRIEF.md frontmatter 的 `content_language` 字段，全程生效。

### 4 种合法值

| 值 | 含义 | 适用场景 |
|---|---|---|
| `zh` | 中文 | 中文团队 / 国内项目 |
| `en` | 英文 | 国际项目 / 开源 |
| `bilingual` | 中英双文（同一段落中英并列，中文在上） | 跨语言团队 / 国际化项目 |
| `repo` | 遵守仓库现有风格（默认） | 已有代码项目 / 不确定时 |

### 应用范围

| 输出类型 | 应用规则 |
|---|---|
| **代码注释**（`//` / `#` / `<!-- -->`） | 按 content_language 写 |
| **commit message** | 按 content_language 写（前缀 `feat:`/`fix:`/`docs:` 等保持英文） |
| **PR 标题/body** | 按 content_language 写 |
| **GitHub Issue** | 按 content_language 写 |
| **过程文档**（PROJECT_BRIEF.md / plan.md / progress.md / qa-signoff.md / runtime-context.md / hill-climbing.md / drift-check.md / lessons-learned.md / harness-backlog.md） | 按 content_language 写 |
| **Trace Log YAML 字段值** | 按 content_language 写（field name 仍英文，因为是 schema） |
| **kixpower 编排文件**（agent.md / TEAM_CONVENTIONS.md / hooks） | **永远中文**（编排元配置，不随项目变） |
| **源码标识符**（变量名/函数名/类型名） | **永远英文**（编程语言通用约定） |

### 结构化区 vs 叙述区（v5.1 token 套利，谨慎）

> 来源：Cross-Lingual Token Arbitrage (arXiv 2606.03618) — 中文在 cl100k_base/o200k_base 下 token 开销约为英文 2.41×。kixpower **只对「机器反复读的结构化区」**套利，**绝不**对「人读的叙述区」强推英文——后者会伤害中文团队可读性，是 v3/v4 过拟合同款（优化指标伤害真实目标）。

**两类分区**（在 content_language 决定后，结构化区单独适用更省 token 的规则）：

| 分区 | 范例 | 语言规则 |
|---|---|---|
| **结构化区**（机器读） | YAML frontmatter 的枚举值（`status: in-progress`）、状态标签（`[x]`/`❌ Blocked`/`PASS`/`CONDITIONAL`）、gate 名、schema 字段名、Tri-Block 标签 `[CONTEXT]/[TASK]/[CONSTRAINTS]` | **永远英文**，即便 content_language=zh |
| **叙述区**（人读） | progress.md 正文说明、Trace Log 叙述、qa-signoff 结论段落、角色对话、脑暴记录 | 按 content_language（zh 项目就用中文） |

**红线**：
- 不得为省 token 把叙述性结论翻成英文（如 QA 的"建议"段、lessons-learned 的教训描述）
- 结构化区英文化是**默认已实现**（schema 字段名本就英文），本规则只是显式声明：即便 zh 项目，`status`/`result`/`topology_used` 等**值**也用英文枚举，不要写 `status: 进行中`
- 争议时**可读性优先于 token**（content_language 是项目级用户选择，高于 token 优化）

### 决策优先级（orchestrator 启动时）

```
1. 若用户在 slash command 显式指定（如 /kixpower-new --lang en）→ 用指定值
2. 否则询问用户（一次问，4 选项 + 默认 repo）
3. 若用户选 repo 或未指定 → orchestrator 扫描仓库推断：
   a. 读已有 PROJECT_BRIEF.md / README.md 前 50 行
   b. 中文字符占比 > 30% → zh
   c. 英文字符占比 > 70% → en
   d. 否则 → repo（保守，让 agent 自己判断每次输出）
4. 推断结果写入 PROJECT_BRIEF.md frontmatter：
   content_language: zh | en | bilingual | repo
   content_language_source: user | inferred | default
```

### 持久化与传递

- **持久化**：`PROJECT_BRIEF.md` frontmatter（跨会话、跨 agent 共享）
- **传递**：orchestrator 在分派 Producer/Dev/QA 的 prompt 末尾追加一行：
  ```
  内容语言：zh（来源：PROJECT_BRIEF.md frontmatter）
  ```
- **冲突解决**：若 user 在新会话说「这次用英文」，临时覆盖（但更新 PROJECT_BRIEF.md）

### `repo` 模式的实时判断

agent 每次输出前**看上下文**：
- 改的文件已有注释是中文 → 新注释写中文
- 改的文件已有注释是英文 → 新注释写英文
- commit 看 `git log --oneline -10` 中英文比例
- 文档看相邻段落语言

`repo` 不是「随便写」，而是**保持局部一致性**。**代码风格同理**（v5.3）：命名/错误处理/测试模式/模块惯用模式以相邻既有代码为基线——Dev 实现前读 `target_rules` 内代表性既有文件（详见 `kixpower-dev.agent.md` 工作流程）。**禁止自动挖掘 style_profile**：编码风格是人为指定输入（同 content_language），非机器派生值（防 v4.x commit_budget 同款过度工程）。来源：Codified Context (arXiv 2602.20478) + Evaluating AGENTS.md (arXiv 2602.11988「非标准实践显式规范有效，自动 overview 无效」）。

### bilingual 模式的格式

```markdown
<!-- zh -->
这是中文段落。

<!-- en -->
This is the English paragraph.
```

或同段内：`这是中文。This is English.`（不推荐，难维护）

**优先用前后两段**（中在上、英在下），不要中英混杂在同一句。

## 🔴 证据门禁（claim-evidence gate，v2，2026-07-30 / v2: 2026-07-31）

> 跨角色 MUST。来源：PR #26 review 误报复盘——reviewer 凭印象断言 ClickHouse 时区语义标 🟡 major，未查官方文档/未读 migration DDL，finding 完全不成立，迫使作者补测试反驳。该反模式不限于 review，任何"判断/断言"产出环节都会发生。

**适用**：所有产出「技术语义断言」或把已观察行为定性为 bug / 安全问题的环节——review finding、QA bug 报告、Producer 技术选型、Dev API/库用法。

**触发**：判断的成立依赖外部技术语义（库 API 行为、框架契约、存储/协议解析规则、语言语义），或需要判断某个真实行为是否违反项目契约 / 威胁模型时。

**四步硬约束**（标定严重级别 / 下结论前）：
1. **取证**：权威源优先级 = 版本对应官方文档（`fetch_webpage` / `mcp_context7_get-library-docs`）> 源码契约行号（读实际文件，如 migration DDL / 类型定义；**不只看 diff 外观**）> 既有测试的既成行为。
2. **引用**：产出物附证据（文档 URL + 关键句，或 `文件:行号`）。
3. **无法证实则降级**：禁止标 blocking/major 或作确定结论；没有反向证据时降为「需确认」疑问，已有反向证据证伪时才撤回。
4. **盲点意识（v5.5，补足范式）**：模型在深度/读写副作用/语言语义/自信偏差/广度优先上有系统性盲点（基于 LLM 注意力机制 + PR#2984 实证）。**目标是补足盲点，不限制发挥**——以下是盲区方向提醒，不是检查清单。完整盲点图谱见 [`kixpower-review.prompt.md`](../../../AppData/Roaming/Code/User/prompts/kixpower-review.prompt.md) §AI 盲点图谱。

   PR#2984 盲点示例：① 深度不足（看调用链漏读 `check()` early return）② 读写混淆（验不 dereference 漏 `f.selected=""` 写副作用）③ 语言语义（建议抽 helper 漏 Go 静态绑定）。

   补足工具（选哪个由模型判断，不规定每类 finding 必须覆盖哪个维度）：`read_file` 读被调用方实现 / 反方辩护测试三问 / review-of-review 独立子 agent。**模型的推理是主力，图谱只补足已知盲区。**

**反方辩护测试（v5.4）**：对每条 major+ finding 和"建议"类 finding，发布前自问：① 作者最可能的技术反驳点？② 我验证的最深层属性是什么，还是停在表面？③ "建议"类——目标语言分派/类型/并发模型下成立吗？答不出 → 降级或补验证。

**规范性结论分层（PR#24 复盘）**：分别验证 ① 机制事实；② 被违反的适用项目契约 / 威胁模型 / 设计意图；③ 实际影响与严重度。实测只能直接证明①，不能替代②。② 的证据可来自仓库与 PR 文档、公开 API / 类型 / schema、代码注释、既有测试、调用方依赖的稳定行为或可验证的安全不变量；没有独立契约文档不等于没有契约。② 无证据，或任一独立 reviewer 基于代码 / 文档提出 intentional / explicit opt-in 反证且尚未解决时，禁止标 blocking/major；先读项目权威契约，仍不明确则降为「需作者确认」的疑问。

**红线**：代码外观事实（「字符串无时区后缀」）≠ 语义断言（「按服务器时区解析」）；机制事实（「socket 可连接」）≠ 契约结论（「违反隔离承诺」）。后两者必须分别取证。**禁止凭记忆中的技术行为下高严重级别判断。** 单维验证（如只验终止性不验副作用）同样违反本门禁。

**Trace 记录（v5.4）**：claim 被后续证据（作者反驳 / 上游测试 / 运行时）推翻时，在 progress.md Trace Log 记 `result: claim_evidence_failure`（见 orchestrator agent.md §Observe / §L4）。L4 Hill Climbing 统计该信号 → 强化盲点意识（补足盲点，非增加检查表）+ 触发 review-of-review 子 agent。PR#2984 首例：2 条 finding 被推翻（M1 部分 + M2 技术）+ 1 条"已验证"声明被推翻（"两 bug 正确修复"）。

**元教训（2026-07-30，实施本门禁时自身重犯）**：用 `grep_search` 搜 `.copilot` 返回 empty（该工具对 workspace 外目录失效），**未换工具交叉验证**就断言「TEAM_CONVENTIONS.md 不存在」，据此创建重复文件并臆造「20 处悬空引用」危机——实际该文件（871 行）一直在 `skills/kixpower/TEAM_CONVENTIONS.md`，所有引用有效。→ 对「文件不存在 / 行为是 X」这类关键前提，必须换工具或换路径二次验证，单一来源 empty 不构成"不存在"的证据。

## 输出格式（通用骨架）

每次完成任务后：

1. **对话简报**（3-6 行）— 改了什么文件 / 通过了几个用例 / 新增了哪些 Issue 编号
2. **落盘到 docs/**：
   - 涉及本 Sprint 进度的信息 → 写入 `docs/sprint-*/progress.md` 的对应区块
   - 规划/脑暴/计划/签署 → 写入 `docs/{brainstorm,sprint-*,qa}/` 对应文件
3. **状态标记**：
   - 任务完成 `[x]`，进行中 `[~]`，阻塞 `❌ Blocked: <原因>`
   - 阻塞必须包含：现象、已尝试、需要的决策点

## 协作原则（跨角色）

1. **上下文落盘**：关键决策、变更文件、Issue 编号、阻塞项**必须**写入 `docs/`，下一个 agent 才能无状态接管
2. **不越权**：每个 agent 只做本职，发现别人的问题 → 记录到 progress.md 对应区块或提 Issue，**不替别人改**
3. **范围外需求**：记录到 progress.md 的"Sprint+1 候选"区块，不擅自扩展本 Sprint
4. **阻塞优先**：遇到 `❌ Blocked` 未解决，**不得进入下一阶段**

## 代码质量纪律（通用）

> 来源：Hermès 编排规范萃取（2026-08）。kixparadigm 已有「最小测试/测行为」，「有界设计」是补缺。

- **有界设计**：池/队列/缓存必须有界并注明上限与依据（如"256 槽 ≈ 372KB 封顶"）。无界 = 内存漂移埋点；上限标注让超界可被审查而非事后合理化。
- **已知上限标注**：全局锁、O(n²) 扫描、启发式等简化，注释标明天花板与升级路径——不装作没有。

## git / Issue 流程（通用）

- **提交规范**：`feat:` / `fix:` / `docs:` / `test:` / `chore:` 前缀，body 关联任务编号或 Issue 编号
- **提 Issue**：标题简短；body 含【复现步骤 / 预期 / 实际 / 环境 / 严重级别】
- **合并 PR**：由 Producer 负责合并；合并前确认 progress.md 无 `❌ Blocked`，且 QA 报告非 FAIL
- **Sprint 收尾**：合并主分支后，更新 `PROJECT_BRIEF.md` 第 7（已完成）、8（下一步）节

## 部署与运维纪律（通用）

> 来源：Hermès 编排规范萃取（2026-08）。kixparadigm 验证 gate 仅有「部署后长稳」一行，本节补全操作纪律。

- **备份先行**：任何替换前保留可回滚副本。流程：备份 → 替换 → 校验（哈希/PID/版本）→ 恢复服务。
- **零停机优先**：热重载（reload）优先于重启——不中断在线连接；架构保证（会话不中断）不可破坏。
- **运行中服务生命周期保护**：未经明确同意，禁止重启/关闭/删除运行中的服务（会中断在线用户）。
- **配置修改后等确认**：改完配置必须等用户确认再生效或再动下一步。
- **部署后验证（三重确认）**：进程身份（PID/版本/哈希）+ 流量走预期路径（日志/dialer 字段）+ 资源在预期区间（内存/句柄）。
- **长稳复测**：部署后数小时至数天稳态观察，对比部署前基线，确认无泄漏、无漂移。
- **凭证纪律**：密码/token 不进命令历史与文档；用 askpass/环境变量注入。

## 🔴 GitHub API 调用纪律（v1，2026-07-31 实证）

> 来源：PR#2980 review 重复发布事故（5 条重复 + 4 条乱码 + 1 条 issue comment 致歉，无法清理）。所有 kixpower 角色（特别是模式 4 orchestrator 自做审查、QA 提 Issue、Producer 合并 PR）统一适用。

### POST 非幂等：重试前必须 GET

- **GitHub API 的 POST（reviews / comments / issues / PR）是非幂等的**：每次成功调用都创建新资源。重试一次就多一份垃圾，作者被迫阅读重复内容
- **重试前必须 GET 确认**：例如 `gh api repos/<owner>/<repo>/pulls/<N>/reviews --jq '.[].id'` 列出已有 ID，对比本次会话已发布的 ID 清单，再决定是否再 POST
- **会话内维护"已发布资源 ID 清单"**：每 POST 成功一条，立即记下返回的 ID（如 review id=4821082201），下次重试前比对

### PowerShell + gh api 输出截断 ≠ 失败

- **现象**：长命令 `gh api --method POST ... --input "$env:TEMP\payload.json"` 在 pwsh 终端的回显会被截断，残留片段（如 `d" -Raw -Encoding utf8`）看似命令未执行
- **误判反模式**：把"回显不完整"当成"未执行" → 重复 POST（PR#2980 事故根因）
- **正确判断**：`run_in_terminal` sync 模式下，**exit code 0 + 无 stderr error 输出 = 已成功**。回显完整性是显示层问题，与命令执行状态无关
- **诊断步骤**：怀疑未执行时，**先 GET 查状态**（`gh api .../reviews`）再决定，不要直接重 POST

### GitHub body 的可靠用法（UTF-8）

- **优先 typed GitHub tool**：review/comment/issue/PR body 直接走结构化参数；复杂 PR review 使用 pending review → 行内评论 → submit_pending
- **gh CLI 仅作降级**：禁止 `gh api -F body="$var"` 传多行字符串；必须 `$payload = @{...} | ConvertTo-Json` → UTF-8 文件 → `gh api --input`
- `ConvertTo-Json` 可保留 Unicode；乱码通常来自控制台 code page 或错误的文件编码。payload 必须直接写 UTF-8 文件并用 `--input` 发送，不经过终端字符串往返
- review/Issue/PR body 保留仓库内容语言与规范要求的 `✅`/`🔴`/`📋`；发布前可读回 payload 文件验证字符未损坏

### 同一 GitHub review 的内容去重

- blocking/major 的行内评论是 finding 的唯一详实正文；review body 只保留结论、计数和行内索引
- 无 diff 锚点、minor/nit 或 PR 级 finding 才在 review body 详述一次
- 发布前对照 pending review 的行内正文与汇总：同一 finding 的证据、触发条件或影响不得同时出现在两处

### GitHub review 不可删除（设计约束，无救济）

- **已提交 review（state=COMMENTED/APPROVED/REQUEST_CHANGES）不能用 DELETE**：DELETE 只对 PENDING review 有效
- **PUT 编辑 body 对外部贡献者 404**：`author_association=NONE` 即使是 review 作者本人也无权 PUT（PR#2980 实证）
- **结论**：重复发布后**无法清理**，只能发 issue comment 说明并致歉。**预防远比补救重要**

### 应用清单（POST 类操作前必跑，所有角色）

发布 GitHub 资源（review / comment / issue / PR）前：

0. **用户确认 gate（MUST）**：所有内容准备好后、POST 前，必须调用 `vscode_askQuestions` 让用户确认（摘要 + 发布/预览/取消三选项）。详见各模式 prompt 的「步骤 0」小节
1. **自问"这是第几次 POST？上次成功了吗？"** → 不确定就先 GET（`gh api .../<resource>` 查状态）
2. **body 含 Unicode** → 优先 typed tool；gh 降级时用 UTF-8 JSON + `--input`，不做 ASCII 降级
3. **复杂 review** → pending review 内聚行内评论与汇总；行内存详实正文、汇总存索引，禁止逐条创建独立 review或在汇总复述行内 finding
4. **exit code 0 即成功，不重试**，无论终端回显是否完整
5. **POST 成功后立即记录返回的 ID** 到 progress.md 的 Trace Log 或会话笔记

## 文档目录约定

```
PROJECT_BRIEF.md          ← 团队共享真相源，14 章节
docs/
├── brainstorm/           ← 脑暴产出（Producer 维护）
├── sprint-N/
│   ├── plan.md           ← 本 Sprint 范围 + 验收标准 + 不做什么（Producer 写）
│   ├── progress.md       ← 任务状态 + 阻塞 + Issue 链接（所有角色更新）
│   └── done.md           ← Sprint 完成报告（Producer 收尾写）
└── qa/
    └── qa-signoff-N.md   ← QA 签署报告（QA 写）
```

## plan.md 结构化 Schema（DAG-based，MUST）

> 来源：AdaptOrch（arxiv 2602.16873）— Task Dependency DAG 是拓扑路由的输入。
> 论文证据：固定 topology 损失 12-23% 性能；DAG-aware routing 拿回这部分。

所有 `docs/sprint-N/plan.md` **必须**包含 task DAG 段（在任务列表之后）：

### Task DAG Schema

```yaml
task_dag:
  nodes:
    - id: A1
      desc: "集成测试 fixture"
      depends_on: []           # 无依赖
      coupling: none           # none|weak|strong|critical
      estimated_tokens: medium # low|medium|high
      target_rules: { globs: [tests/integration/**, docker-compose.yml] }
    - id: B3
      desc: "Outbox worker"
      depends_on: [A1]         # 等 A1 完成
      coupling: strong         # A1 的 fixture 是 B3 的输入
      estimated_tokens: high
      target_rules: { globs: [src/cache/outbox.rs, src/api/accounting.rs] }
    - id: B5
      desc: "网关预留费 Lua"
      depends_on: [A1]
      coupling: weak           # 共享 redis 基建但不强依赖
      estimated_tokens: high
      target_rules: { globs: [src/cache/mod.rs] }
    - id: C1
      desc: "凭据 Stored 类型"
      depends_on: []
      coupling: none
      estimated_tokens: medium
      target_rules: { globs: [src/domain/account.rs] }
  # DAG 结构属性（orchestrator 路由用）
  properties:
    max_antichain_width: 2     # ω: 最大并行宽度
    critical_path_depth: 3     # δ: 关键路径长度
    coupling_density: 0.35     # γ: 平均耦合强度
    recommended_topology: hybrid  # orchestrator 据此选拓扑
```

### 耦合强度定义（AdaptOrch Definition 2）

| coupling 值 | 含义 | c(u,v) |
|---|---|---|
| `none` | 输出完全独立 | 0.0 |
| `weak` | 共享上下文有帮助但非必需 | 0.3 |
| `strong` | u 的输出是 v 的直接输入 | 0.7 |
| `critical` | 需要语义连贯 | 1.0 |

## Task Sizing & Commit Budget 派生（v4.0，MUST）

> 来源：sync_watcher Sprint 1 实证 — Producer 拍脑袋定 `commit_budget: 4`，实际用满 5/5 仍不够（orchestrator 临时解锁到 5），事后 hill-climbing.md 把 budget 改写成 5 来"合理化"，反而声称"零 over_budget ✅"。
> **根因**：`commit_budget` 被当成**输入常量**（Hard Guardrail），实际应该是 **task 分析的派生值**。真正的硬约束是上下文窗口（已有 `max_tokens_per_session`）和爆炸半径（防 30 错 commits/单 run 的失控），不是 commit 数本身。

### 设计原则

| 类型 | 应该是 | 理由 |
|---|---|---|
| 上下文窗口（`max_tokens_per_session`） | **硬约束**（已合理） | 物理限制，token 是真实资源 |
| 故障重试阈值（`no_progress` / `tool_failure`） | **硬约束**（已合理） | 稳定性，有论文依据 |
| commit 数（`commit_budget`） | **派生值**（本次改造） | task_size 的函数，不是常量 |
| 硬上限（`hard_cap=10`） | **硬约束**（保留） | 防「30 错 commits/单 run」失控，9 Ways 行业报告证据（2026.05） |

### 派生公式

Producer 在生成 plan.md 时**必须**计算并写入 `task_sizing.derived_commit_budget`：

```
# 输入：从 task_dag 自动统计（v5.0：全部用 DAG 结构量 ω/δ/γ，不再用扁平 task_count 比例）
task_count            = len(nodes)                              # k（仅参考，不进公式）
strong_coupling_count = count(coupling ∈ {strong, critical})    # γ 的离散化输入
dag_layers            = critical_path_depth                     # δ（DAG 层数 = 关键路径深度）
dag_width             = max_antichain_width                     # ω（DAG 最大反链宽度 = 同层可并行数）

# 派生（v5.0：base 改由 δ 驱动，去掉隐藏比例 /3）
#   理由：commit 是「可独立回滚的变更单元」。每个 DAG 层至少 1 commit
#   （同层并行 task 互无依赖可合并），故 base = δ 而非 task_count/3。
#   旧式 ceil(k/3) 是扁平计数比例，与 DAG 结构无关，且对 k=7 恰好得 5
#   ——与被批的旧硬编码常数 5 巧合相等（因果倒置铁证）。
base            = dag_layers                   # δ：每层 1 commit（层内并行可合并）
coupling_bonus  = strong_coupling_count        # 强耦合不合并 commit（边界清晰利于回滚）
bug_reserve     = historical_bug_per_sprint    # 来自 harness-backlog 跨 Sprint bug 统计；
                                               # 无历史数据时 = 1（冷启动兜底，须随 Sprint 累积收敛）

derived_commit_budget = base + coupling_bonus + bug_reserve

# 阈值（v5.0：warn_threshold 去掉隐藏 +4，纯 δ 比例）
hard_cap        = 10                            # 绝对不能超（9 Ways 行业报告防线，真硬约束）
warn_threshold  = dag_layers * 3 + bug_reserve  # 超此值视为 task 拆分过细
```

### 写入与 hook 协作

Producer 把 `derived_commit_budget` 写入 plan.md 的 `task_sizing` 段，并同步到 progress.md 的 `blast_radius.commit_budget`（blast-radius-check.ps1 读此字段；缺失时回退默认 3）。超 `hard_cap=10` → 拒绝生成 plan，拆 Sprint。原 `commit≤5` Guardrail 已取消，`hard_cap=10` 保留为防失控硬上限。

### 拓扑路由规则（orchestrator 用）

按顺序命中即停，判据互斥：

```
命中强制串行条件          → sequential
γ ≥ 0.6 AND k > 5        → hierarchical
ω ≥ 3 AND γ < 0.3        → parallel
ω ≥ 2 AND γ < 0.6        → hybrid
else                     → sequential
```

### 何时强制 sequential（即使 DAG 显示可并行）

- 涉及同一文件的多个任务（避免 merge 冲突）
- 涉及加密/认证的敏感改动（隔离 + 审计）
- plan.md 明确标注 `force_sequential: true` 的任务

### Hybrid 拓扑分层（层内并行 + 层间串行）

用 Kahn 拓扑排序分层：in-degree=0 的节点为第一层，移除其出边后新的 in-degree=0 节点为下一层，重复直到全部分配。同层内若两 task 强耦合（共享直接输入）或 target_rules.globs 重叠 → 拆到不同层。Producer 在 plan.md 的 `task_dag.properties.layers` 输出分层结果，orchestrator 按 layer 并行 runSubagent（受 max_parallelism 约束）、layer 间串行。

### target_rules：规则化范围声明（v3.3，替代 target_files 清单）

> 来源：EvoClaw 论文 + 示例项目 Sprint 1 实测 — 102 个变更文件中 97.1% 未被 plan.md target_files 覆盖，证明「文件清单」模型不适合大型项目。
> 升级为**规则/通配符模型**：Producer 声明**规则**（glob + module + language），orchestrator/QA/Dev 按规则匹配，不再维护全文件清单。

#### v3.3 Schema（替代 v3.1 的 target_files）

```yaml
- id: B5
  desc: "网关预留费 Lua"
  # === v3.3 规则化范围 ===
  target_rules:
    # 1. glob 模式（支持 ** 跨目录，* 单层）
    globs:
      - "src/cache/**"                # cache 模块全部
      - "src/api/{payment,gateway}.rs"  # 花括号展开
      - "src/main.rs"                 # 单文件
    # 2. 模块前缀（按目录归类的语义）
    modules:
      - cache                         # 等价 src/cache/**
      - api/payment                   # 等价 src/api/payment.rs + src/api/payment/**
    # 3. 语言维度（决定 L2 跑哪个 gate）
    languages: [rust]
    # 4. 关联规则（机械扩张自动覆盖，无需手列）
    mechanical_links:
      - type: callers                 # 谁调用了本 task 改的 pub fn
        of: [src/cache/mod.rs]        # CodeGraphy 自动查
      - type: same_trait              # 同 trait 的其他 impl
        trait: BalanceOps
```

#### 匹配优先级（orchestrator/QA/fidelity 脚本统一用）

```
file_in_scope(file, task) =
    match_glob(file, task.target_rules.globs) OR
    match_module(file, task.target_rules.modules) OR
    match_mechanical(file, task.target_rules.mechanical_links) OR
    match_whitelist(file)  # 全局白名单（见下）
```

#### glob 语法（POSIX-ish，PowerShell 兼容）

| 模式 | 含义 | 示例 |
|---|---|---|
| `**` | 跨目录递归 | `src/**` 匹配 src 下所有 |
| `*` | 单层通配 | `src/*.rs` 匹配 src/a.rs 不匹配 src/sub/b.rs |
| `{a,b}` | 花括号展开 | `src/api/{payment,gateway}.rs` |
| `[a-z]` | 字符集 | `src/[a-c]*.rs` |
| `?` | 单字符 | `src/auth?.rs` |

#### 模块映射约定（modules 字段）

`modules: [cache]` 等价于以下任一前缀匹配（取最先命中的）：
- `src/cache/**`
- `frontend/src/features/cache/**`
- `tests/cache/**`

Producer 写 `modules` 时只需语义名，匹配器自动按项目结构展开。**Producer 不需要知道具体路径**，降低认知负担。

#### 语言维度（驱动 L2 补充 gate）

`languages: [rust]` 告诉 orchestrator：「这个 task 改了 Rust 代码，可选择 cargo 系列补充 gate」。多语言项目（如 示例项目 = Rust + TypeScript）：

```yaml
languages: [rust, typescript]  # L2 会跑 cargo + tsc + eslint
```

该维度不能删减 plan 中 required `local_gate`；L2→QA 前必须执行完整 required manifest。

#### mechanical_links（自动覆盖机械扩张）

替代 v3.1 的「机械关联手列」。Producer 只声明规则，CodeGraphy 实际查询：

| type | 含义 | 查询 |
|---|---|---|
| `callers` | 谁调用了本 task 改的符号 | `codegraphy_list_edges to=<file>` 反向 |
| `callees` | 本 task 调用了谁 | `codegraphy_list_edges from=<file>` 正向 |
| `same_trait` | 同 trait 其他 impl | `codegraphy_list_symbols trait=<name>` |
| `same_struct` | 同 struct 构造点 | `codegraphy_list_symbols struct=<name>` |

**L2 Observe 时**：orchestrator 实际跑 CodeGraphy 查询，把结果合入 in_scope（动态生成，不污染 plan.md）。

### Goal Drift 白名单（v3.3 升级，使用 rules 匹配）

Observe 步骤 3 的 20% 阈值判断，**全部用 rules 匹配**：

```yaml
# 全局白名单（所有 task 共享，写在 plan.md 顶部或 TEAM_CONVENTIONS）
drift_whitelist:
  - pattern: "tests/**"              # 测试文件
  - pattern: "**/*_test.{rs,go,py}"
  - pattern: "**/*.spec.{ts,tsx,js}"
  - pattern: "docs/**"               # 文档
  - pattern: "**/{README,CHANGELOG,LICENSE}*"
  - pattern: "**/*.lock"             # 锁文件
  - pattern: "{target,node_modules,dist,build}/**"  # 生成物
  - pattern: ".github/**"            # CI 配置
  # 机械修复特征（diff 内容判断，非文件名）
  - diff_pattern: "^(diff --git|index|@@|[-+]\s*$)"  # 纯空格/换行改动
```

**白名单匹配逻辑**：
```
is_whitelisted(file) =
    match_any_glob(file, drift_whitelist.patterns) OR
    match_diff_pattern(file, drift_whitelist.diff_patterns)
```

**真·out_of_scope 计算**（v3.3）：
```
changed = git diff --name-only
in_scope = changed ∩ (task.target_rules ∪ mechanical_links 查询结果)
whitelisted = changed ∩ drift_whitelist
true_out_of_scope = changed - in_scope - whitelisted
if len(true_out_of_scope) / len(changed) > 0.2:
    trigger goal_drift  # 但要 orchestrator 二次确认
```

**触发 goal_drift 后**：orchestrator 重新读 plan.md 确认是否真越界（如 Dev 改了完全无关模块才真 drift；机械扩张/测试新增不算）。

## progress.md 结构化 Schema（MUST）

来源：Two Practical Orchestration Loops 论文 — "memory 不应藏在 prompt 里，要有显式 schema 和 read/write 函数"。

所有 `docs/sprint-N/progress.md` **必须**以 YAML frontmatter 开头，让 orchestrator 可以一行解析状态而不用 LLM 解读全文。

### Frontmatter Schema

```yaml
---
sprint: 1                              # Sprint 编号（整数）
status: in-progress                    # planning | in-progress | blocked | done
last_updated: 2026-07-28               # ISO 日期，每次更新必改
completed_tasks: 20                    # 已完成任务数（对应 plan.md 总数）
total_tasks: 20                        # plan.md 任务总数
blocked_tasks: 0                       # ❌ Blocked 任务数
open_issues: {P0: 0, P1: 2, P2: 5}     # 按 P0/P1/P2 分级的开放 Issue 数
artifacts_changed_since_last_observe:  # 上次 Observe 后变更的源码文件
  - src/auth.rs
  - src/credit.rs
observe_fingerprint: <git-sha>         # 每次 Dev 分派前的 HEAD；orchestrator 用于 no-progress 检测
sprint_baseline_sha: <git-sha>         # 首次 Dev 前的 HEAD；L2 覆盖整个 Sprint commit 范围
dev_self_tests_passed:                 # Dev 提交前自测记录，不代表权威 L2
  - backend_unit_tests
l2_verification_passed:                # 仅 Orchestrator 可写；权威 L2 通过的完整 gate ID 集合
  - backend_unit_tests
  - backend_clippy
  - backend_format
  - frontend_typecheck
l2_verified_sha: <git-sha>             # 必须为完整 40 位 SHA；上述集合对应的 HEAD
l2_gate_manifest_sha256: <sha256>      # plan 中全部 required local_gate 规范化 manifest 的 SHA-256
l2_stash_refs: []                       # L2 完成时 git stash 引用快照；QA handoff/closeout 必须保持不变
qa_started_sha: <git-sha>              # QA 启动时必须等于 l2_verified_sha 与 HEAD
qa_verified_sha: <git-sha>             # QA 最终 PASS/CONDITIONAL 证据对应的完整 HEAD
qa_gate_manifest_sha256: <sha256>      # QA 签署时复核的同一 local_gate manifest
qa_test_changes: []                    # QA 新增/修改可执行测试后必须触发 L2 reverify
ci_pending: false                      # CONDITIONAL 只能因 CI gate pending
qa_session_marker: docs/.kixpower-qa-session.json # Orchestrator 创建/清理，记录 QA 启动时 L2/stash 快照
topology_used: hybrid                  # 本 Sprint 实际用的拓扑（用于 L4 分析）
# === Blast Radius 配置（hook 读取）===
blast_radius:
  commit_budget: 7                     # 从 plan.md task_sizing.derived_commit_budget 同步过来（hook 实际读这个）。hook 用 HEAD reflog 统计最近窗口内仓库全部 commit（不按可伪造 author/date 过滤），且拦截 reflog expire/delete、git gc/prune、敏感 config（core.hooksPath/editor/pager/sshCommand、gc.reflogExpire、credential.helper、alias.*）与 `-c` 内联同名键，防止清零计数或注入 hook。HEAD/@ 主分支 push 时拒绝超限。缺省回退 3（冷启动兜底）。硬上限 10。
  branch_required: true                # 必须在 feature branch
  block_force_push: true               # 阻止 git push --force
  block_destructive_sql: true          # 阻止 DROP/TRUNCATE/DELETE without WHERE
---
```

### 状态机（status 字段合法迁移）

```
planning → in-progress → done
              ↓
            blocked → in-progress（解除后）
```

- `blocked` 必须配合 `blocked_tasks > 0`
- `done` 必须满足 `completed_tasks == total_tasks AND blocked_tasks == 0`

### L2 → QA revision 信任链（MUST）

`verifiable_gates` 是计划中的唯一门禁来源。每个 required gate 必须有唯一 `id`、
显式 `type`、`cmd`、`expect`；历史计划可由兼容解析器把 `owner: L2` + `command` 映射为
`local_gate`，但同 ID 的命令冲突必须拒绝，不能按出现顺序猜测。

Orchestrator 在 L2 完成时必须：

1. 解析计划中**全部** required `local_gate`，按 `id` 排序后规范化
  `{id,type,cmd,expect,required}`，计算 `l2_gate_manifest_sha256`；
2. 只有全部 required gate 在同一 revision 通过，才能写入完整的
  `l2_verification_passed`、`l2_verified_sha`（完整 40 位 SHA）和 manifest digest，
  并同时记录当前 `git stash list --format=%H` 为 `l2_stash_refs` 基线；
3. 代码、测试、fixture、构建配置、gate 命令或计划 gate manifest 任一变化，旧 L2 整体失效，
  不能只重跑失败项后把旧结果拼回新的最终集合；最终交接前必须在新 revision 重跑全部 required
  local gate；
4. 没有 required local gate 的 docs-only Sprint 必须显式写
  `l2_verification_status: not-applicable`，并仍绑定当前 HEAD 和空 manifest digest。

QA handoff 必须满足：

```text
required_local_gate_ids == l2_verification_passed
l2_gate_manifest_sha256 == hash(current_plan_manifest)
qa_started_sha == l2_verified_sha == HEAD
l2_stash_refs == git stash refs captured at L2 completion
```

QA 可以新增或修改测试，但这类变更必须先运行受影响 focused test，随后把结果标为
`REVERIFY_REQUIRED` 并返回 Orchestrator；不能直接签署 PASS。Orchestrator 必须在最终 revision
重跑全部 required local gate、刷新 L2 字段，再重新交 QA。QA 最终报告只有在
`qa_verified_sha == l2_verified_sha == HEAD` 且 `qa_test_changes` 为空时才能是 PASS 或仅 CI
pending 的 CONDITIONAL。若 `qa_test_changes` 非空，结果状态必须为 `REVERIFY_REQUIRED`，
禁止把测试变更伪装成 PASS。QA 结果状态机合法值：`PASS | CONDITIONAL | REVERIFY_REQUIRED | FAIL`。
`CONDITIONAL` 必须同时有 `ci_pending: true`，不能用未分类阻塞项进入 L4。
QA handoff 同时创建 ignored 的 `docs/.kixpower-qa-session.json`，记录启动时 L2 SHA 与 stash 引用；
handoff 先比较 `l2_stash_refs` 与当前 stash 集合，L2 后新增/删除/替换 stash 一律拒绝并要求重跑 L2；
QA 期间 stash/reset/clean/删除命令由 Hook 拒绝，closeout 比较 session 快照。成功收尾后由
Orchestrator 清除该 marker；QA 不得直接编辑或删除它。
QA 通过 GitHub 远程文件工具写入测试、fixture 或 QA 文档时，PostToolUse freshness 必须同样写入
`REVERIFY_REQUIRED` marker；远程分支变更不能被本地 HEAD/stash 快照当作未发生。
历史缺少这些字段的报告保持 legacy/unbound，不得补写成新鲜证据。
历史 Sprint 若需要继续执行：把缺少 `l2_verified_sha`、manifest、`l2_stash_refs` 或 QA freshness
字段视为 L2/QA 未完成，重新运行当前 revision 的全量 L2→QA 链；不得把旧报告手工补字段当作
新鲜证据。已完成且不再接力的历史 Sprint 保留原证据，不回写。

### Partition 产物（仅 parallel/hybrid 拓扑用，v5.7）

> 来源：AdaptOrch §4.4.1 + 9 Ways 报告 + S-Bus (arXiv 2605.17076, 并发 agent race condition)。多个 Dev 并行时**必须**分区写 progress.md，防数据丢失。

新并行流程不让多个 worktree 编辑同一个 canonical `progress.md`。每个 Dev 在自己的
`docs/sprint-N/partitions/<partition_id>.md` 写独立产物；历史 progress 中的 `## Partitions`
区块仍可读取，但只作为 legacy adapter，不能继续生成。

```markdown
## Partitions（legacy read-only）

### Partition v1（子任务 A1）
- worktree: ../.kixpower-wt/sprint-N-v1
- artifacts: [src/auth.rs, src/bootstrap.rs]
- result: ok | blocked | failed | pending
- completed_at: 2026-07-28T14:30:00Z
- summary: "完成 A1+A2+A3，新增 TestApp fixture"

### Partition v2（子任务 B5）
- worktree: ../.kixpower-wt/sprint-N-v2
- artifacts: [src/cache/mod.rs]
- result: ok
- summary: "BALANCE_RESERVE_SCRIPT Lua 原子化 + 8 个 redis_integration 测试"

### Partition v3（子任务 C1）
- worktree: ../.kixpower-wt/sprint-N-v3
- result: pending   # 还没返回
```

新 partition 文件至少包含：

```yaml
---
partition_id: v1
task_ids: [A1]
base_sha: <40位SHA>
plan_snapshot_sha: <40位SHA>
plan_manifest_sha256: <64位SHA>
result: pending                 # ok | blocked | failed | pending
completed_tasks_delta: 0
artifacts: []
executable_changes: true
---
```

**写入规则**：
- 每个 Dev 只写自己的 partition 文件，禁止写其他 partition 或 canonical progress 数值；
- Orchestrator 必须核对 `base_sha`、`plan_snapshot_sha`、plan digest、task ID 唯一性和 worktree 登记，
  再把成功 partition 汇总到 canonical progress.md；
- synthesis 重试不得重复累计 `completed_tasks_delta`；所有 partition 合并完成并刷新最终 HEAD 后，
  才能进入全量 L2；
- 根工作树在创建 planning snapshot 前必须干净（规划文件之外的用户改动不自动 stash/reset）。

### 使用约定

- **串行 Dev** 可更新 progress 执行字段；并行 Dev 只能更新自己的 partition 文件；QA 不更新 Sprint 执行状态。
- **orchestrator Observe 阶段**：按阶段信号判断真实进展，不要求 QA/L4/closeout 增长 `completed_tasks`。
- **正文部分**保留自由 markdown，但任务列表用 `[x]`/`[~]`/`[ ]`/`❌ Blocked` 标记，与 frontmatter 数值一致

### Observe 阶段信号矩阵（MUST）

| stage | 合法成功信号 | 不要求 |
|---|---|---|
| `producer_planning` | plan/progress/drift/runtime artifact 或 planning 状态迁移 | completed task 增长 |
| `dev` | task 状态/实现 artifact 增长，或合法 blocker | QA/L4 文档 |
| `l2_retry` | gate 状态改善或修复 diff | completed task 增长 |
| `qa` | signoff、gate evidence、Issue 或测试 artifact | Sprint task 增长 |
| `l4` | hill-climbing 报告；`novel_evidence: false` 也有效 | 源码变化 |
| `producer_closeout` | done、Brief 状态和最终 progress 一致 | 源码变化 |
| `review_readonly` | 结构化 claim 产物 | 工作区写入 |

只有 Dev 报完成但同时没有该阶段合法 artifact、task/gate delta 或 blocker，才记
`silent_failure`。每条 Trace 应记录实际采用的 `stage_signal`。

### 传递前 Trajectory Reduction（v5.1，AgentDiet 机制）

> 来源：AgentDiet (arXiv 2509.23586, FSE 2026) — 多轮 agent 的 trajectory 普遍含 useless/redundant/expired 三类浪费，推理时移除可大幅降 token 且不损性能。kixpower 落实其**分类机制**（不照搬其 39.9%-59.7% 经验数字——那是 SWE-Bench benchmark 值，非 kixpower 目标常数）。

**触发时机**：orchestrator 在 `/kixpower-continue` 阶段 1 读完 progress.md 后、分派子 agent 前；或 progress.md 正文超过 200 行时。

**三分类清理规则**（只动正文 Trace Log 区块，**绝不改 frontmatter 数值字段**——frontmatter 是结构化真相源）：

| 分类 | 识别特征 | 处理 |
|---|---|---|
| **expired**（过期） | 已 `[x]` 完成且无后续 task 依赖它的任务详情、已 merge 的 PR 讨论记录 | 压成一行结论：`[x] T3 完成（auth 模块），已 merge #12` |
| **redundant**（冗余） | 同一任务的多次状态更新、重复的失败堆栈、相同错误的不同复述 | 只留最新一条，前述合并为 `（前 N 次尝试见 git log）` |
| **useless**（无用） | 探索性失败的废弃方案、被推翻的假设、与最终方案无关的调试记录 | 删除，仅当含可复用教训时摘 1 行到 `<PROJECT_ROOT>/.kixpower/memory/repo/lessons-learned.md` |

**保留红线**（这三类即使符合上表也**不可清理**）：
- `❌ Blocked` 记录（阻塞项是活跃状态）
- verifiable_gates 的失败证据（QA 依赖）
- 最近 1 个 turn 的完整 Trace（Observe 对比基线）

**守卫**：清理后正文行数若反而增加，回滚（AgentDiet 原则：reduction 不得反向膨胀）。frontmatter 的 `last_updated` 不因清理而改（清理不是业务变更）。

## Agent Memory Read/Write 合约（MUST）

> **边界声明**：角色 Hook 约束 agent 的直接编辑/命令意图，防误操作与常见绕过；它不是 OS 沙箱。QA 执行仓库测试、浏览器或 notebook 时会运行项目代码，若代码不受信任，必须改在容器/低权限账户/隔离 worktree 中运行，不能依赖正则 Hook 抵御恶意代码。

来源：Two Practical Orchestration Loops 第 2.3 节 Step 4 —
> "For each agent, specify two small functions:
>  - `read(memory) -> context`
>  - `write(memory, result) -> memory`"

每个 agent 启动时**只读合约规定的文件**，结束时**只写合约规定的字段**。禁止"顺手读全文"或"自由写其他字段"。

### Repo memory root（v5.7）

- canonical root：`<PROJECT_ROOT>/.kixpower/memory/repo/`；其中 `harness-backlog.md`、
  `lessons-learned.md` 和项目身份文件属于当前项目的唯一可写真相源；
- `/memories/repo/` 只作为旧版本/宿主环境的 legacy adapter。启动时若发现旧文件，读取并记录
  `legacy_ref`，但不与 canonical root 双写；迁移只能追加 provenance，不能覆盖旧证据；
- legacy backlog 中没有 `status` 的条目按 `candidate` 读取；没有后续 `trial/pass` 证据不得晋升
  `validated`；历史自由文本不得因为一次 Sprint 成功而自动成为规则；
- 所有角色 prompt 使用 `<PROJECT_ROOT>/.kixpower/memory/repo`，不要把用户级绝对路径写成项目真相源。

### Producer（Remy）

| 操作 | 目标 |
|---|---|
| **read** | `PROJECT_BRIEF.md`（如有）、`<PROJECT_ROOT>/.kixpower/memory/repo/*.md`、用户输入 |
| **write** | `PROJECT_BRIEF.md`（14 章）、`docs/**`（plan/progress/runtime-context/drift-check/done/brainstorm/QA 协调文档）、`README.md`、`.github/**`、`.gitignore`、`<PROJECT_ROOT>/.kixpower/memory/repo/harness-backlog.md` 应用记录 |

### Dev（Nova/Sage/Milo）

| 操作 | 目标 |
|---|---|
| **read** | `PROJECT_BRIEF.md`、`docs/sprint-N/plan.md`、`<PROJECT_ROOT>/.kixpower/memory/repo/lessons-learned.md`、`docs/sprint-N/progress.md` frontmatter + 当前任务行 |
| **write** | 源码（plan.md target_rules 范围内）、`docs/sprint-N/runtime-context.md`、`docs/sprint-N/progress.md`：**串行模式**写任务计数/任务行/`dev_self_tests_passed`；**并行模式只写自己的 partition 文件**（不碰 frontmatter，由 orchestrator synthesis 阶段统一合并）、`<PROJECT_ROOT>/.kixpower/memory/repo/lessons-learned.md`（仅失败时追加）；Dev/Producer Hook 禁写 L2/QA 权威字段，且禁止通过终端或远程文件工具改写 progress.md |
| **禁止写** | `PROJECT_BRIEF.md`、`plan.md` 规划内容（只写执行状态）、`qa-signoff-*.md`、其他 Dev 的 Partition 区块 |

### QA（Ivy）

| 操作 | 目标 |
|---|---|
| **read** | `PROJECT_BRIEF.md`、`docs/sprint-N/plan.md`（含 verifiable_gates）、`docs/sprint-N/progress.md` 全文、`<PROJECT_ROOT>/.kixpower/memory/repo/lessons-learned.md` |
| **write** | `docs/qa/qa-signoff-N.md`、测试文件（`*_test.go`/`*.test.*`/`*.spec.*`/`*.stories.*`/`tests/**`/`e2e/**`/`cypress/**`）、`<PROJECT_ROOT>/.kixpower/memory/repo/lessons-learned.md`（仅失败时追加） |
| **禁止写** | 业务源码、`PROJECT_BRIEF.md`、`progress.md` 执行状态 |

### Reviewer（只读）

| 操作 | 目标 |
|---|---|
| **read** | PR diff、目标实现、项目契约、review draft |
| **write** | 无 |
| **禁止** | 编辑、提交、发布、调用其他 agent；只从 `kixpower-review` 入口接收带 `review_worktree` 与 `review_head_sha` 绑定的 review handoff |

### Orchestrator

| 操作 | 目标 |
|---|---|
| **read** | 所有 docs/ + `<PROJECT_ROOT>/.kixpower/memory/repo/`（用于决策） |
| **write** | `docs/sprint-N/progress.md` 的 Trace Log、`observe_fingerprint`、`sprint_baseline_sha`、`l2_verification_passed`、`l2_verified_sha`、`l2_gate_manifest_sha256`、`l2_stash_refs`、QA/L4 阶段状态；`docs/sprint-N/hill-climbing.md`、`docs/reviews/*.md`、`<PROJECT_ROOT>/.kixpower/memory/repo/{harness-backlog,lessons-learned}.md`；并行 synthesis 时统一合并 Partition 数值 |
| **禁止写** | 业务源码、`plan.md`；需要重规划时必须调用 Producer |

### 合约违规检测

orchestrator Observe 阶段附带检查：
- Dev 写了 `PROJECT_BRIEF.md` → 越权违规，触发 goal_drift
- QA 改了业务源码 → 越权违规（hook 已硬拦，双保险）
- Dev 读 `*.jsonl` transcript → 上下文膨胀违规，记入 trace

## CodeGraphy MCP 使用规范

CodeGraphy 是工作区级代码关系图工具。MCP server 配置在 `.vscode/mcp.json`，所有 agent 共享。**只在"需要时"用，不是每次都用**。

### 何时使用（必用场景）

| 场景 | 用什么工具 |
|---|---|
| 模块边界 / 包依赖 / 循环依赖分析 | `codegraphy_list_edges`、`codegraphy_list_relationships` |
| 改一个文件前评估影响面（找出谁依赖它） | `codegraphy_list_edges`（filter `to=<目标文件>`） |
| 多跳可达性："这个改动会沿着 import 链传到哪里" | `codegraphy_find_paths`（from→to） |
| 找符号定义、跨文件引用证据 | `codegraphy_list_symbols` |
| Producer 评估"重构涉及多少文件"、QA 评估回归范围 | `codegraphy_status` + `codegraphy_list_nodes` |

### 何时不使用

- 单文件内局部改动、明确知道改哪几行 → 不用
- 纯文档/配置/构建脚本改动 → 不用
- 已经有 progress.md / plan.md 明确列出文件清单 → 不用
- 一次性脚本、临时验证 → 不用

### 初始化协议（首次或缓存失效时）

1. **先 status**：`codegraphy_status`（参数 `path` 留空 = 当前工作区）。返回 `cache=missing/stale` 才需要 index。
2. **按需 index**：`codegraphy_index`（耗时几秒到几十秒，取决于工作区大小）。**禁止每次都 index**——索引未失效时直接查询即可。
3. **失败兜底**：若 MCP 工具调用报错（如 server 未启动、缓存损坏），**不要反复重试**——降级为 `grep_search` / `read_file`，并在 progress.md 记一条 "CodeGraphy 不可用：\<原因\>"，继续主干任务。

### 调用约定

- 路径参数 `path` 一律传**绝对路径**或留空（= 工作区根），不传相对路径。
- 大查询用 `limit` / `offset` 分页（默认 500），不一次性拉全图。
- 查询结果**不复制全文进 progress.md**——只写"X 个文件依赖 Y / 影响面 = N 文件"摘要。

## harness-backlog eval schema（v4.1，MUST for 新建项）

> 来源：LangChain "Better Harness: A Recipe for Harness Hill-Climbing with Evals"（2026 H2）— 核心思想「evals are training data for harness」。
> **kixpower 适配**：不引入 LLM-as-judge（与 Hard Guardrails 确定性优先原则冲突），而是把 harness-backlog 每个改进项从「自然语言描述」升级为「结构化 eval」，让 Producer 在新 Sprint 启动时可以**回归验证**「这个改进是否真被应用且生效」。
> **闭环对比**：
> - v3-v4.0：trace 分析 → 写 backlog → 期望 Producer 应用（**单边**，无法验证）
> - v4.1：trace 分析 → 写 backlog（含 eval）→ Producer 应用 → 下次 trace 不再命中 eval.regression_signal（**双边闭环**）
> - 实践学习增强：Reflexion / ExpeL 支持从反馈与跨任务经验中学习；Xiong et al. 2025 同时证明错误经验传播与错配回放风险。因此 Trace 是证据，不是规则；单次任务只能生成 candidate。

### 实践学习状态机（三态）

| status | 含义 | 消费方式 |
|---|---|---|
| `candidate` | 单次或单源实践形成的待验证假设 | 仅当 `eval.trigger` 匹配后续任务时，作为该任务的 scoped trial；不得当默认规则 |
| `validated` | 后续匹配任务的 trial 满足 `pass_criteria`，且无未解决反证 | 仅在 trigger 匹配时作为 repo 级既定实践应用 |
| `archived` | 被证伪、被取代或因长期不相关而移出活跃上下文 | 不自动应用；`archive_reason` 必须区分 `rejected` / `superseded` / `stale` |

迁移规则：L4 新发现 → `candidate`；candidate 在后续匹配任务中试验，trial 结果 `pass` → `validated`，`fail` / 反证 → 修正后仍为 candidate 或归档为 rejected；validated 每次匹配应用仍监测 regression / 反证，命中 → 降回 candidate。未匹配 trigger 不构成真值证据，只可按条目自己的上下文成本阈值归档为 stale；后续任务再次独立产生同类 signal 时，L4 恢复该 stale 项为 candidate 并追加新 origin，禁止创建重复项。repo 中 validated 的经验不得自动改写用户级 Kix 编排；全局晋升需要跨仓库证据或用户明确授权。

### Eval Schema（追加到 backlog 每个改进项末尾）

```yaml
- id: P1-X
  type: plan-template | dev-workflow | qa-workflow | review-workflow | scope | tooling
  status: candidate                     # candidate | validated | archived
  problem: "..."
  improvement: "..."
  source: "Sprint N 哪个 trace entry / 事件"
  evidence:
    - task: "Sprint N"
      kind: origin                      # origin | trial | counterexample
      result: observed                  # observed | pending | pass | fail
  archive_reason: null                  # rejected | superseded | stale
  # === v4.1 新增（所有进入 canonical lifecycle validator 的记录必填；未迁移自由文本仅作 legacy adapter）===
  eval:
    task_kinds: [sprint]               # sprint | review | any
    trigger: "什么场景下应该被触发"
    pass_criteria: "应用后应该看到什么行为（可观测）"
    regression_signal: "什么 trace entry / 事件 意味着改进未生效或回归"
    applies_to_sprints: ">=2"          # 从哪个 Sprint 起应该通过（字符串表达式）
    check_timing: "pre-sprint | post-sprint | both"   # Producer 何时检查
    # === v5.0 反过拟合新增（规则一致性 + 规则退役，详见 SKILL.md 方法4/5）===
    overlaps_with: []                  # 与既有项语义重叠的 ID；Producer 应用时去重避免重复检查
    supersedes: []                     # 本项取代的旧项 ID；旧项自动归档（方法4-B）
    unmatched_runs: 0                  # trigger 未匹配的运行数；只表示相关性，不表示真假
    archive_after_unmatched: null      # 可选上下文成本阈值；无全局默认常数
```

### 字段语义

| 字段 | 含义 | 示例 |
|---|---|---|
| `trigger` | 触发场景描述 | "plan.md §2 基线非绿时 Dev 启动行为" |
| `task_kinds` | 哪类任务可消费该经验 | `sprint` / `review` / `any`；避免 Sprint 经验错配到 review，反之亦然 |
| `pass_criteria` | 可观测的通过标准（不是主观判断） | "Dev 不 Blocked，progress.md 出现 §2.1 处理记录" |
| `regression_signal` | 失败信号（trace entry 模式 / 文件缺失 / 指标阈值） | "trace 含 'Dev Blocked: 基线非绿'" |
| `applies_to_sprints` | 生效起点（向后兼容老项） | ">=2" 意为 Sprint 2+ 应该通过 |
| `check_timing` | Producer 何时跑回归检查 | pre-sprint = 启动前查上一 Sprint trace；post-sprint = 收尾时查本次 trace |
| `overlaps_with` | **v5.0** 与既有项语义重叠的 ID 列表 | `[H2]` 表示与 H2 重叠，应用时去重避免重复检查 |
| `supersedes` | **v5.0** 本项取代的旧项 ID | `[H2]` 表示取代 H2，H2 自动归档 |
| `status` | 实践成熟度，不等同于严重度 | candidate 只可试验；validated 才可作为 repo 默认；archived 不加载 |
| canonical status 枚举 | validator 接受的唯一 lifecycle 状态 | `candidate` / `validated` / `archived`；`applied` 仅允许出现在旧版应用历史叙述中，不得写入 `- id:` 记录 |
| `evidence` | 跨任务证据链 | origin 记录来源；trial 记录后续任务的 pending/pass/fail；counterexample 记录反证 |
| `unmatched_runs` | 后续任务未匹配 trigger 的次数 | 仅用于上下文成本管理，不能作为已证伪或已根治的证据 |
| `archive_after_unmatched` | 可选 stale 归档阈值 | 由条目成本/风险决定；归档理由必须是 stale，可在未来匹配时恢复 |

### Producer 回归检查流程（启动新 Sprint 时，追加到现有 drift check 之后）

```
先按 overlaps_with / supersedes 合并语义重叠项，禁止同一 trigger 重复 trial 或重复应用
对 harness-backlog.md 的每个非 archived 项:
  if task_kinds 包含 sprint|any 且 eval.trigger 匹配本 Sprint:
    if status == candidate:
      只在本 Sprint plan.md 中作为 scoped trial 应用
      evidence += {task: Sprint N, kind: trial, result: pending}
    else if status == validated:
      作为 repo 级既定实践应用
      在 plan.md 记录 item ID 与 regression_signal，供 L4 持续监测
  else:
    eval.unmatched_runs += 1
    if archive_after_unmatched 已配置且达到阈值:
      status = archived; archive_reason = stale         # 仅偿还上下文负债，不声称经验为假

L4 收尾时评估本 Sprint 的 pending trial:
  if 找不到 trial 确实应用到 plan / 执行链的证据:
    trial.result 保持 pending; status = candidate       # 无效试验不能验证或证伪经验
  else if pass_criteria 有可观测证据且 regression_signal 未命中:
    trial.result = pass; status = validated
    对 supersedes 列出的每个旧项:
      旧项.status = archived; 旧项.archive_reason = superseded
  else if regression_signal 命中或出现反证:
    trial.result = fail; status = candidate              # 修正 improvement 后可再试
    若独立证据直接证伪 improvement:
      status = archived; archive_reason = rejected

L4 同时检查本 Sprint 已应用的 validated 项:
  if regression_signal 命中或出现反证:
    status = candidate
    evidence += {task: Sprint N, kind: counterexample, result: fail}

L4 创建新 candidate 前搜索 archived stale 项:
  if 同类 trigger / signal 已有 stale 项:
    恢复旧项为 candidate; archive_reason = null; 追加 origin evidence
  else:
    创建新 candidate
```

### 收尾时（Sprint done.md 生成前，新增 eval 汇总段）

Producer 在生成 done.md 时，追加「evals 回归结果」段：

```markdown
## Evals 回归结果（v4.1）

| 项 ID | eval.trigger | 本 Sprint trial 结果 | 学习状态 |
|---|---|---|---|
| P1-A | 基线非绿处理流程 | pass（附 gate/trace 证据） | validated |
| P1-B | 扩张留痕强制 | fail（再次 goal_drift） | candidate，待修正 |
```

### 向后兼容

- **已有 backlog 项**：无 `status` 时一律保守迁移为 `candidate`；只有补出后续任务的 `kind: trial, result: pass` 证据才能晋升。旧 `retire_after_silent` / `positive_hits` 字段可读但不再作为新项 schema
- **新建 backlog 项**（v4.1 起）：必填 `status: candidate`、evidence origin 与 eval 字段，L4 不得直接写 validated
- **可选追溯**：已有项可在 Sprint 间隙补 eval 字段（推荐 P1 级优先补）

### 与 v4.0 的关系

- v4.0（task_sizing 派生 commit_budget）和 v4.1（eval backlog）完全正交
- v4.0 是输入参数的派生，v4.1 是输出验证的闭环
- 两者可独立采用，但组合后形成完整的「派生 → 执行 → 验证 → 改进」闭环

## hook 脚本编写与测试规范（kixpower 特定）

> kixpower 的 hooks（`blast-radius-check` / `validate-handoff` / `validate-qa-signoff` / `block-source-edit` / `block-source-edit-qa` / `block-dev-authority-edit` / `auto-update-progress`）与 scripts（`verification-fidelity-check` 等）解析 `plan.md` / `progress.md` frontmatter。以下为已踩过的坑（**均有真实回归案例**），Dev 写 hook、QA 测 hook 时必须遵守。

### hook 测试方法：用 cmd 重定向，不用 pwsh 管道

- **pwsh 管道** `Get-Content file.json | & pwsh -File hook` 传**对象**（string 数组），子进程 `$Input` 枚举行对象而非字节流 → JSON 首字符可能被污染，`ConvertFrom-Json` 失败、hook **静默退出**。
- **cmd 重定向** `cmd /c "pwsh -File hook < file.json"` 传**字节流**，子进程 `$Input | Out-String` / `[Console]::In.ReadToEnd()` 正确读取 → **这是 VS Code hook 的实际调用方式**。
- **测试 hook 必须用 cmd 重定向**（或 `[Console]::In.ReadToEnd()`），禁止用 pwsh 管道。
- 案例：`blast-radius-check.ps1` 在 pwsh 管道测试下静默退出（JSON 解析失败 position 0），被误判为"hook 失效"；实际 VS Code 字节流 stdin 下一直正常——是**测试框架错了**，不是 hook 错了。

### YAML frontmatter 正则：多字段不紧邻 + inline 数组

hook 用正则解析 frontmatter 字段时：
- **字段不紧邻**：`(\w+):\s*\n\s+(next_field):` 要求两字段**紧邻**，但实际中间常隔其他字段。正解：`(\w+):[\s\S]*?(next_field):`（`[\s\S]*?` 非贪婪匹配含换行）。
- **inline 数组**：`key: [a, b, c]` 不能用多行列表正则 `key:\s*\n((?:\s*-\s*.+\n?)+)` 匹配。正解：`key:\s*\[([^\]]+)\]` 后按 `,` 分割。
- 案例：`task_sizing.derived_commit_budget` 中间隔 4 字段 → v4.0 fallback 静默失效一直回退默认值；`branch_required` 等 4 字段紧邻正则全部失效（v4.1 回归）；`target_files` inline 数组被旧多行正则误判 ungated（HIGH_RISK 61.5%，实际 0%）。

### PSScriptAnalyzer unapproved verb

自定义 PowerShell 函数名必须用 approved verb（`Write-/Get-/New-/Set-/Remove-` 等），否则 lint 报错。`Log-Info`/`Ensure-Dir` 会报 → 改 `Show-Info`/`New-DirIfMissing`。历史命名可能有缓存误报，确认文件实际内容即可。

