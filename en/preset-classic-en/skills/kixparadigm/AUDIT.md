# kixparadigm & kixpower — 来源与实证审计文档

> **用途**：复查技能（还债测试 / 自检 / 验证规则依据）时读取。**不作为 skill 自动加载**。
> 行为规则见各技能文件；本文件只记录"为什么"——论文来源、实证、案例复盘、版本演进。
> 结构：每个条目标注 `[来源]`（外部引用）或 `[实证]`（项目内验证），并注明原落地位置，便于复查时核对规则是否仍有依据。

## 1. 论文可靠性分级（原 kixpower SKILL + TEAM_CONVENTIONS）

- ✅ **已独立验证经典**（可作硬约束依据）：Sutton "Bitter Lesson" (2019) / Tree of Thoughts (Yao NeurIPS'23) / Self-Refine (Madaan NeurIPS'23) / Constitutional AI (Bai Anthropic'22) / Chain of Thought (Wei NeurIPS'22) / AgentDiet (arXiv 2509.23586, FSE 2026)
- ⚠️ **kixpower 内部引用未独立验证**（算法可能有效，但论文依据存疑，**不作硬约束依据**）：AdaptOrch (arxiv 2602.16873) / EvoClaw (arxiv 2603.13428) / swyx Loopcraft (2026.06) / LangChain The Art of Loop Engineering (2026.06) / 9 Ways AI Coding Agents Break in Production（2026.05 行业报告）/ Cross-Lingual (2606.03618) / Codified Context (2602.20478) / Evaluating AGENTS.md (2602.11988) / arXiv:2512.02304 / arXiv:2506.07962 (ICML'25) / ICLR'26 diversity / Xiong et al. (2505.16067) / S-Bus (2605.17076)
- 落地处标注：现有引用 AdaptOrch/EvoClaw 的规则（Task Sizing 派生公式、Hybrid 拓扑算法、verification-fidelity-check.ps1 等）算法经实测可保留，"论文依据"理解为"经验启发"而非"权威证明"

## 2. 核心依据（按规则落地处）

| 规则/机制 | 来源/实证 | 落地位置 |
|---|---|---|
| 阶段二相性（创造/验证分离） | [来源] ToT 模块化设计（生成器/评估器独立，非消融实证）+ Self-Refine 迭代反馈 + Sutton Bitter Lesson；核心洞察由用户提出（2026-07-31） | TEAM_CONVENTIONS §阶段二相性；kixpower SKILL §v5.7 |
| 补足非限制 | [来源] Self-Refine 独立反馈 | 同上 |
| 规则是负债 | [来源] Sutton Bitter Lesson 2019（原文无"内建人类知识会平台化"逐字句，勿当直接引语） | 同上 |
| 需求是假设 | [来源] Brooks 1986（需求规格是最难环节）；需求工程/SEI（用户常不知自己要什么，需主动 elicitation）；Radical Candor（类比迁移：挑战+关怀+谦逊，非管理框架原文） | kixparadigm SKILL「需求是假设」 |
| 本质/偶然复杂度 | [来源] Brooks 1986（推论：本质复杂度低时套范式是负债）；YAGNI 边界（过度简化与过度设计同错） | kixparadigm SKILL「架构级感知」；review prompt 维度 6 |
| 并行度由 DAG 派生 | [来源] AdaptOrch（拓扑方差 ≥ 模型方差 20x；固定 topology 损失 12-23%）；[实证] dae Sprint1 δ 派生公式信息增量 | TEAM_CONVENTIONS §并行度 |
| 水位线阈值 | [来源] NeedleInAHaystack 召回率研究（Kamradt 方法论延伸 + kixpower 经验值；「2026 版本」为内部命名非独立论文） | TEAM_CONVENTIONS §水位线；USAGE_MANUAL §7 |
| 结构化区 token 套利 | [来源] Cross-Lingual Token Arbitrage (2606.03618) — 中文 token 开销约 2.41×（cl100k/o200k） | TEAM_CONVENTIONS §结构化区 |
| target_rules 范围模型 | [来源] EvoClaw 论文 + [实证] 示例项目 Sprint 1（102 变更文件 97.1% 未门禁 → 规则化后 4.9%） | TEAM_CONVENTIONS；USAGE_MANUAL |
| 显式 memory 文件 | [来源] Two Practical Orchestration Loops 论文（"memory 不应藏在 prompt 里"） | TEAM_CONVENTIONS |
| 4 层 Loop / 拓扑自适应 | [来源] LangChain "The Art of Loop Engineering" (2026.06) + AdaptOrch；SWE-bench 42.8%→52.6% | USAGE_MANUAL §2/§3 |
| Trajectory reduction | [来源] AgentDiet (2509.23586, FSE'26) 三分类 expired/redundant/useless | TEAM_CONVENTIONS |
| Hill-climbing harness | [来源] LangChain "Better Harness: A Recipe for Harness Hill-Climbing" | TEAM_CONVENTIONS |
| 并发上限与争用 | [来源] AdaptOrch §4.4.1 + 9 Ways 报告 + S-Bus (2605.17076) | TEAM_CONVENTIONS |
| Loop Engineering 概念 | [来源] Boris Cherny（Claude Code 作者）「I don't prompt Claude anymore. I have loops that are running.」 | USAGE_MANUAL §2.1 |
| 跨厂商验证收益 | [实证] cross-family > intra-family > self（NYU arXiv:2512.02304）；同厂商错误相关、强模型跨厂商收敛（ICML'25 2506.07962） | kixparadigm SKILL「跨厂商模型」 |
| 异质多数收益平台化 | [来源] ICLR'26 "Understanding Agent Scaling... via Diversity"（1→20 收益仅 +0.4~1.6%；2 异质 ≈ 16 同质） | kixparadigm SKILL「三通道」 |
| 权威反证边界 | [来源] Nature MI 2026-07「Capable models can outgrow collaboration」（单 agent 基线是协作增益最强预测器，验证配置 94%） | kixparadigm SKILL「跨厂商模型」 |

## 3. 历史案例与复盘

### 3.1 证据门禁反模式 A — 印象式技术断言（PR#26，2026-07-30）
reviewer 凭"印象中的库行为"下 high-severity finding：断言"ClickHouse naive datetime 按服务器时区解析"标 🟡 major；实际列是显式 `DateTime64(3,'UTC')`（读 migrations.rs），finding 不成立。→ 落地为「证据门禁：外部语义须取证（官方文档/源码契约行号），无法证实降 comment」。

### 3.2 证据门禁反模式 B — 单维验证虚假自信（PR#2984，2026-08）
reviewer 取了证但挑错验证维度：验证"调用链存在/Unwrap 终止性"，漏"被调用方 check() early return / 写副作用 f.selected='' / Go 嵌入静态绑定跳过 override"。4 条 finding 被作者推翻 2 条 + 1 条"已验证"声明被推翻。比 A 更隐蔽（有取证动作更易自我麻痹）。→ 落地为「反方辩护测试」「盲点图谱」「review-of-review」。

### 3.3 GitHub API 重复发布事故（PR#2980，2026-07-31）
把"回显不完整"当成"未执行" → 重复 POST（5 条重复 + 4 条乱码 + 1 条 issue comment 致歉，无法清理）。→ 落地为「GitHub API 调用纪律：GET 校验、exit 0 即成功、UTF-8 body、记录 ID、不重试」。

### 3.4 发布机制实证（PR#44，2026-08-08）
REST 无「向 pending review 加行内评论」端点；创建时用 comments[] 一次性带；多语言 payload 用 Python；GBK 显示伪象。

### 3.5 bwrap 沙箱语义（PR#23，2026-08-06）
`--perms` 只影响下一个操作；`--dir` 对已存在路径是 no-op；单 uid 命名空间下 0755 vs 0700 无可读性差异。→ 审查沙箱 args 时用实测 stat 而非参数顺序断言。

### 3.6 MCP 发布路径差异（PR#27，2026-08-12）
MCP `pull_request_review_write` create 不支持 comments[]；必须 pending + add_comment + submit 三步；create 带 event 提交后行内评论丢失且 PATCH review body 404 无法修补。→ 落地为发布前一次性规划 + pending 三步。

### 3.7 流程路由缺陷（PR#27 全权委托，2026-08-12）
元决策（任务分级/技能加载/发布确认）无机械触发：15 文件/3 crate 的 PR 被判"简单任务"，未加载 review 模板，跳过发布确认 gate，观察者同模型（同质）。→ 落地为「流程路由信号」（属性驱动非类型映射）+「全权委托不豁免确认 gate」。

### 3.8 环境版本误用（2026-08-12）
用 PowerShell 5.1 跑契约测试产生假 FAIL（GBK 读 UTF-8 无 BOM 脚本中文断言乱码 + native stderr NativeCommandError）。→ 落地为「环境默认：pwsh 7.x」。

### 3.9 hooks 测试/解析案例（kixpower 实证）
- pwsh 管道 vs cmd 重定向：`cmd /c "pwsh -File hook < file"` 传字节流，测试 hook 必须用 cmd 重定向
- YAML frontmatter 正则：字段非紧邻用 `[\s\S]*?`；inline 数组 `[a,b,c]` 与多行列表都要支持（task_sizing fallback 静默失效案例）
- blast-radius-check.ps1 在 pwsh 管道测试下静默退出（JSON 解析失败 position 0）→ 实际 cmd 重定向正常

### 3.10 dae 任务可行性（2026-08）
A2 优化 gate-OFF 死路径、A3/A5/B1/B2 全为 no-op（已最优/无目标/死代码）→ 落地为 Producer task 可行性前置 gate（G1 liveness / G2 heat / G3 bench / G4 memprofile）。另有 L11 buffer 别名 invariant（daedns sendStreamDNS 的 req/respBuf 共享 poolBuf）→ Dev 必须加同步消费注释。

## 4. 论文清单（原 USAGE_MANUAL 第 11 节）

| 论文 | 时间 | 核心洞见 | 落地到 |
|---|---|---|---|
| LangChain "The Art of Loop Engineering" | 2026.06 | 4 层 loop stacking | L1/L2/L3/L4 架构 |
| AdaptOrch (2602.16873) | 2026.02 | 拓扑方差 ≥ 模型方差 20x | 拓扑自适应 |
| The End of SE (2606.05608) | 2026.06 | EvoClaw: isolated 规则模型 | 规则模型 |
| arxiv 2511.08475 | 2025.11 | Role-Based Cooperation 最高频 | Producer/Dev/QA 分工 |
| NeedleInAHaystack | 2025-26 | 长上下文召回率 | 水位线 |
| Two Practical Orchestration Loops | 2026 | memory 显式文件 | harness-backlog |
| AgentDiet (2509.23586, FSE'26) | 2026 | trajectory 三分类 | progress reduction |
| LangChain Better Harness | 2026 | harness hill-climbing | L4 |
| 9 Ways Agents Break in Production | 2026.05 | scaffold 失败 6/9 | blast radius / runtime snapshot / deterministic-first |
| Andrew Ng 三 loop 模型 | 2026.07 | L1 coding / L2 dev feedback / L3 external | 4 层 loop 对齐 |
| Data Science Dojo Loop Engineering Guide | 2026.06 | 6 项必选 guardrails | Hard Guardrails 表 |
| Microsoft Magentic-One | 2024 | Inner/Outer Dual Loop | Dual Loop 章节 |
| NeurIPS 2023 Reflexion | 2023 | Episodic memory 失败学习 | lessons-learned.md |
| Codified Context (2602.20478) | 2026 | Hot Memory constitution | Dev 风格基线 |
| Evaluating AGENTS.md (2602.11988) | 2026 | 非标准实践显式规范有效 | 风格感知 |
| Style2Code (2505.19442) / InlineCoder (2601.00376) | 2026 | 代码风格适配 | Dev 风格基线 |

## 5. 版本演进（原 USAGE_MANUAL §版本历史）

| 版本 | 日期 | 内容 |
|---|---|---|
| v1.0 | 2026-07-28 | 初版基础 loop 工程 |
| v2.0 | 2026-07-28 | 复核修正论文偏离 |
| v3.0 | 2026-07-28 | 新论文对齐（L2/L4/DAG/Blast/Runtime/Deterministic） |
| v3.1 | 2026-07-28 | 模拟测试发现的优化项（fmt 必跑/clippy 关联/drift 白名单） |
| v3.2 | 2026-07-28 | L4 改进项自动应用 + EvoClaw fidelity 量化脚本 |
| v3.3 | 2026-07-28 | 规则化范围模型（target_rules） |
| v3.4 | 2026-07-28 | 模式 4 PR 审查（7 维度 + `--approve`） |
| v3.5 | 2026-07-28 | AdaptOrch 执行层完整化（max_parallelism 硬上限） |
| v3.6 | 2026-07-28 | 内容语言约定 |
| v3.7 | 2026-07-28 | Token 阈值按模型窗口百分比 |
| v3.8 | 2026-07-28 | orchestrator 工具并行化 |
| v3.9 | 2026-07-28 | max_parallelism 3→5 |
| v5.7 | 2026-08-07 | L2/QA revision manifest 与 session freshness |
| 论文截止 | 2026.07 | — |

## 6. VS Code 机制实证（2026-08-01）

- hook 输入顶层字段 **snake_case**（`tool_name`/`tool_input`/`hook_event_name`/`cwd`）；`tool_input` 内部 camelCase；PowerShell `ConvertFrom-Json` 下划线敏感（`$hookInput.toolName` 读不到 `tool_name` → 静默放行）
- agent hooks 需 `chat.useCustomAgentHooks: true`
- skill 渐进式披露：资源文件只有被 Markdown 相对链接引用才自动读取；常驻规则放 custom instructions
- agent body 每次进上下文 = 常驻成本（body 长度是负债）
- 系统 compaction 只压对话历史，工具输出与引用文件不压缩

## 复查指引

- **何时读本文件**：还债测试（零基重写/负向测试）、技能自检、审计规则是否仍有依据、核对某条规则的来源可信度
- **不作为自动加载**：本文件是审计证据链，不是行为引导；行为规则在技能文件内已自足
