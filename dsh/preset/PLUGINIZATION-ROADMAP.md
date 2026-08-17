# kix 插件化改造路线图 — 从「prompt 工程主导」到「插件化主导」

> 状态：路线图 v0.1（2026-08-16 起草）。权威性低于 DSH-ADAPTATION.md；本文回答的是
> **架构方向**：kix 的哪些规则该由机制保证（插件），哪些必须由模型判断（prompt）。
> 判定标准是 kix 自己的哲学，不是"能写成代码就写成代码"。

---

## 0. 为什么做这次改造

kix 核心信念：**模型的推理能力是主力，工具只补足已知盲点；限制越少，发挥越好；
规则是负债**。用这条信念审视现状，发现一个自我矛盾：

- kix 的**哲学**说"限制越少越好、规则是负债、补足非限制"；
- kix 的**实现**却是 755KB prompt 工程（persona 常驻 + 技能 + 角色 + 流程 + 记忆），
  大量"规则"以**模型自觉遵守**的方式存在，模型靠 prompt 说教自我约束。

现状盘点（2026-08-16 实测）：

| 资产 | 规模 | 形态 | 主导方式 |
|---|---|---|---|
| persona（agent.cordis.yml） | ~130 行 / ~17K token 常驻 | prompt 文本 | 模型自觉 |
| instructions/ | 7.6KB / 1 文件 | prompt 文本 | 模型自觉 |
| skills/ | 535KB / 62 文件（kixpower 384KB） | prompt 文本 | 模型自觉（按需加载） |
| agents/ | 75KB / 6 文件（orchestrator 44KB） | prompt 文本 | 模型自觉 |
| prompts/ | 58KB / 5 文件（review 33KB） | prompt 文本 | 命令注入 |
| memories/ | 79KB / 7 文件 | prompt 文本 | 模型自觉 |
| **小计 prompt 资产** | **~755KB** | | |
| plugins/（kix-guards/cost/route/commands/stalled） | 121KB / 9 文件 | **JS 插件** | **机制强制** |
| dsh-vision-bridge（profile 层） | — | JS 插件 | 机制强制 |

**问题**：mechanism 该管的（需求三检、验证 gate、交付证明）是 prompt 说教；
本该留给模型的判断（怎么思考、怎么编排）反而塞满了 17K 常驻 token。
生态插件（dsh-doublecheck / dsh-permission-rules / dsh-agent-teams）证明了：
这些纪律可以用 **hooks + 工具 + 持久状态** 强制，模型自觉是最后一道、也是最弱的一道防线。

---

## 1. 判定判据：kix 哲学 × 插件化的边界

不是"能机制化就机制化"。用 kix 自己的四条哲学做筛子：

| 判据 | 机制化（插件） | 保留 prompt | 删除/归档 |
|---|---|---|---|
| **规则是负债** | 机械、可枚举、确定性、重复执行成本低 | 认知启发式、方向性、需要判断 | 重复、过时、Copilot 语境残留、单次事故经验 |
| **补足非限制** | 补"动作"（强制读文件/调子代理/拦危险操作） | 补"思考"（视角、盲点提醒） | 限制"怎么思考"的强制规则 |
| **阶段二相性** | 验证（收敛）阶段的机械 gate | 创造（发散）阶段的自由度 | 泄漏到创造阶段的验证规则 |
| **限制越少越好** | 只拦已知的高危/高成本失误 | 只留必要的认知锚点 | 一切不必要的约束 |

**一句话判据**：这条规则靠模型自觉遵守的失败代价高、且可被机械枚举 → 插件化；
这条规则的价值在于给模型一个视角而不是一个结论 → 留 prompt 但精简；
这条规则是给"上一代模型"写的 → 删除。

---

## 2. 生态机制吸取（思想，不是代码）

以下插件的**机制思想**与 kix 哲学相符，吸收其结构，不照搬实现：

| 生态插件 | 机制思想 | kix 哲学对应 | 吸取点 |
|---|---|---|---|
| dsh-doublecheck | grill→spec 工具→red/green gate→adversary→report，纪律做成**门禁+工具+持久状态** | 需求三检、验证 gate、交付证明 | **核心吸取**：把"需求三检/验证 gate"从 prompt 说教改成 pre-execute 门禁 + spec 契约工具 + 证据日志 |
| dsh-permission-rules | 声明式 YAML 规则文件 + hot reload + dry-run + 审计 | 规则是负债（规则可维护、可试运行） | kix-guards 的硬编码断言可数据化；门禁可 dry-run 试运行 |
| dsh-agent-teams | 队长建队、依赖感知任务、持久成员状态、Web 面板 | CEO 团队编排 | 编排可工具化 + 状态持久化（kix 现在靠 prompt 分派、无持久团队状态） |
| dsh-collaboration | 专家名单 + team_call/team_status + roundtable + vision 桥 | 三通道观察、CEO 编排 | 预置角色名单 + 只读/执行工具分层（与 kix 的 producer/dev/qa 同构） |
| dsh-plans | planning-first preset + reviewer/criticizer 轮 + verifier checklist + goal 执行 | 写码前决策链、验证 gate | plan 契约化（PLAN_vN + checklist），执行前明确 handoff |
| dsh-orcana | zero-progress steering、证据新鲜度 gate | kix-stalled | stalled 检测的"证据新鲜度"维度可并入 kix-stalled |

**吸取原则**：只取"机制结构"，不取"具体规则内容"（dsh-doublecheck 的 grill 六维
不一定等于 kix 需求三检；dsh-agent-teams 的角色划分不一定等于 kix 的 producer/dev/qa）。
kix 保留自己的认知内容，换的是**承载方式**：从"模型记住并自觉"换成"机制强制 + 模型判断"。

---

## 3. 判定矩阵：现有 prompt 资产逐条归类

### 3.1 persona 常驻认知层（agent.cordis.yml ~130 行）

| 节 | 现状 | 判定 | 去向 |
|---|---|---|---|
| 三通道交叉验证 | prompt 说教 | **保留精简** | 认知方法，压缩到最小锚点（~5 行） |
| 阶段二相性 | prompt 说教 | **保留精简** | 认知方法，压缩到 2 行 |
| 规则是负债 | prompt 说教 | **保留精简** | 认知方法，压缩到 2 行 |
| 需求三检 | prompt 说教（信号触发） | **机制化** | pre-execute 门禁：edit/write 前查 spec 契约（吸取 dsh-doublecheck grill gate）；触发信号逻辑保留为 prompt 引导 |
| 写码前决策链 | prompt 说教 | **保留精简** | 认知方法（递减复用是思维习惯，不宜机制化——"禁止类型→动作静态映射"正是 kix 反过拟合） |
| 架构级感知 | prompt 说教 | **保留精简** | 认知方法 |
| AI 盲点图谱 | prompt 说教 | **保留精简** | 方向不是清单，正是"补思考"——留 prompt |
| 交付前验证三问 | prompt 说教 | **机制化（部分）** | "改了平台边界必跑测试"的 lint/测试前置可做成 post-execute 提醒或验证工具；三问本身留 prompt |
| 环境默认（pwsh 等） | prompt 说教 | **机制化** | 工具 schema/描述层即可表达；persona 只留一句"环境不确定先探测" |
| 流程路由信号 | prompt 说教 | **保留精简** | 属性驱动元决策是生成性认知——留 prompt，但压缩 |
| CEO 团队编排 | prompt 说教 | **保留精简 + 工具化** | 编排决策留 prompt；分派执行已有 subagent/workflow 原生工具，考虑轻量"团队状态"工具（吸取 dsh-agent-teams，可选 P2） |
| 成本纪律 | prompt 说教 + 插件 | **已插件化** | kix-cost + kix-route 已接管；persona 只留一句话索引 |
| DSH 适配 | prompt 说教 | **大幅删除** | 插件化后大部分映射自动消失；真正的边界语义（cross 单厂商、vision 无模型）由插件报错承载 |

**persona 目标**：~17K token → **≤4K token**（只留"怎么思考"的认知锚点 + 机制索引）。

### 3.2 instructions/kixparadigm-core.instructions.md（7.6KB）

与 persona 高度重复（三通道/二相性/规则是负债/需求三检/写码前/盲点全都在 persona 里又写了一遍）。
**判定：与 persona 合并去重**。保留核心指令作为"可加载的完整版"，persona 只放压缩锚点 + 指向。

### 3.3 skills/kixparadigm（34.6KB / 2 文件）

- 机制细节（机械门禁/验证 gate 完整版/输出格式）→ **机制化的部分移出**，剩余认知部分并入精简技能
- AUDIT.md 的论文可靠性分级 → 保留为按需参考（memories 化）

### 3.4 skills/kixpower（384KB / 25 文件）← 最大头

| 内容 | 判定 | 去向 |
|---|---|---|
| TEAM_CONVENTIONS.md（target_rules/plan.md schema/eval schema/窗口约定） | **部分机制化** | plan.md schema → 插件工具校验（write 前校验 plan 契约）；窗口约定已由 harness compaction 接管 |
| USAGE_MANUAL.md（完整使用手册） | **保留精简** | 按需加载的手册（真·reference，不进常驻） |
| hooks/*.ps1（blast-radius 等） | **已机制化** | kix-guards.js 已接管；ps1 降级为参考 |
| kixpower-workflow.template.md | **保留** | 流程模板（按需） |
| README.md / 版本表 / legacy notes | **归档** | 移出技能目录，进 docs/ |
| dsh-capability-map.md | **归档/精简** | 能力地图随插件化自动变化，改为插件清单 |

**kixpower 目标**：384KB → 保留 ~100KB 按需参考，机制部分全部移入插件。

### 3.5 agents/（75KB / 6 文件）

- orchestrator.agent.md（44KB）→ **大幅压缩**（SWEzze 瘦身原则已写在文档里，落地）；编排路由逻辑若机制化则更短
- producer/dev/qa/reviewer → 保留为**子代理角色 prompt**（按需注入，不进常驻），但压缩到必要最小
- kixparadigm.agent.md（2.3KB）→ 保留

### 3.6 prompts/（58KB / 5 文件）

- kixpower-review.prompt.md（33KB）→ **压缩**（反方辩护/盲点图谱等已常驻 persona；流程 prompt 只留流程骨架 + 指向）
- 其余 4 个 → 保留（命令注入，零常驻成本），瘦身至必要最小

### 3.7 memories/（79KB / 7 文件）

- ai-agent-practices.md（31KB）→ 保留为按需参考（真·方法论记忆）
- dsh-capability-map.md（27KB）→ 随插件化更新为插件/机制清单
- 其余 → 保留或归档（vscode-copilot-customization.md 等 Copilot 语境 → 归档）

---

## 4. 目标态：插件化的 kix 组成

```
agent.cordis.yml（preset）
├── persona            ≤4K token（认知锚点 + 机制索引，不再写纪律全文）
├── 原生工具行         不变（subagent 四档 / workflow / goal / fs / shell …）
├── kix-guards         已插件化 —— 增强：断言数据化（YAML 规则文件，可 dry-run）
├── kix-cost           已插件化 —— 不变
├── kix-route          已插件化 —— 不变
├── kix-commands       已插件化 —— 不变
├── kix-stalled        已插件化（opt-in）—— 增强：证据新鲜度维度
├── kix-discipline     ★新插件：需求三检/验证 gate 的机制化
│     ├── tools/pre-execute：edit/write 前查 spec 契约（无 spec + 模糊任务 → remind/ask/block）
│     ├── spec 工具：契约写入会话日志 + 工作区（doublecheck_spec 思想，kix 六维→三检内容）
│     ├── red/green gate：实现 edit 需失败测试在档；回合结束无通过测试 → 提醒注入
│     └── /kix-discipline 命令：status/report
└── skills/            ~150KB（认知技能精简版 + 真·reference 手册）
    agents/            ~40KB（角色 prompt 最小化）
    prompts/           ~40KB（流程骨架 + 指向）
    memories/          ~80KB（按需参考）
```

**净效果**：常驻 token 17K→4K；纪律类规则从"模型自觉"变为"机制强制"；
"怎么思考"的认知层保留但极度精简；Copilot 语境残留清除。

---

## 5. 分阶段实施计划

### P0 — 纪律机制化（✅ 已完成 v0.1，2026-08-16）
1. ✅ 写 `plugins/kix-discipline.js`（pre-execute spec gate + turn-stopping green gate + `kix_discipline_spec` 工具 + `/kix-discipline` 命令），挂 agent.cordis.yml
2. ✅ 单元测试 `kix-discipline.test.js`（43 断言全过；`npm test` 全绿：164+24+57+43）
3. ⏳ persona 压缩：需求三检/验证三问从"全文纪律"改为"一句话 + 指向 kix-discipline 机制"（P1 一起做）
4. ✅ 挂载验证：YAML 解析通过、安装副本已同步（sync-dsh-preset.ps1 -Force）
5. ⏳ 端到端验证：需重启 dsh web 后新会话实测（preset 组装在 agent 发布时安装）

### P1 — persona/指令瘦身（✅ 已完成，2026-08-16）
1. ✅ persona 7.3K 字符 → 3.3K（↓55%；估算 ~2K token）：需求三检/成本/DSH 适配从全文纪律压缩为"机制索引 + 触发句"，机制细节指向 kix-discipline/kix-cost 等插件
2. ✅ instructions 重写为"权威完整版 + 与 persona 关系声明"（去双源漂移；persona 是运行时权威）
3. ✅ kixparadigm SKILL.md 中已机制化内容标注为插件承载（见 skills/kixparadigm/SKILL.md 头部注记）
4. 验收：常驻 token 实测下降（token meter，重启后验证）；认知技能回归测试（AUDIT.md 相关断言）

### P2 — kixpower 瘦身 + 门禁数据化（✅ 完成，2026-08-16）
1. ✅ review prompt 修复 Copilot 残留（真实缺陷）：硬编码模型字符串 `GLM-5.2 (CodingPlan) (gcmp.zhipu)` / `DeepSeek-V4-Flash (gcmp.deepseek)`（DSH 不存在的路由值）→ `subagent_cross`/`subagent` 工具行；`vscode_askQuestions`→`ask_user_question`、`run_in_terminal`→`pwsh`；注记同步。每次 `/kixpower-review` 注入不再出现无效路由
2. ✅ 全部 6 个 agent 注记更新：hooks 块声明「不自动触发，由 kix-guards 插件强制」；`runSubagent→subagent/subagent_cross`；跨厂商不写死模型字符串；frontmatter 完整性校验通过
3. ✅ orchestrator Guardrails 表标注 DSH 承载列（blast_radius_* / commit budget 已由 kix-guards 强制，模型无需自行实现 hook）
4. ✅ DSH-ADAPTATION.md §2 补 kix-discipline 插件条目（权威映射文档同步）
5. **决策记录（规则是负债）：不做 orchestrator 44KB→15KB 盲目瘦身**——49 节/18K tokens 是真实执行机制（L2 流程/推进条件/拓扑/Observe/L4），非冗余；且按需加载（不进常驻 token），瘦身收益低于丢失机制的风险。orchestrator 已按需加载的架构本身（路由入口 + 机制细节，SWEzze 思想）已是最优形态
6. **决策记录（规则是负债）：kix-guards 门禁数据化不做 YAML 规则层**——kix-guards 是全局强制安全基线（5 大门禁/164 断言），硬编码保证一致性、防项目篡改；dsh-permission-rules 的 YAML 面向"项目级自定义规则"，kix 无此真实需求（无现有 rules.yaml 使用），预建 = 负债。若未来出现项目级门禁需求，再加可选覆盖层（基线 + 项目 .dsh/rules.yaml 追加，不替换）
7. ✅ memories/vscode-copilot-customization.md 标注归档（DSH 侧无执行价值的 Copilot hooks/.agent.md 知识源，保留供 Copilot 分发版参考，DSH 侧已声明忽略）
8. **P2 补缺（2026-08-16，用户"迁移是否失真"质疑驱动）**：✅ 新建 `plugins/kix-orchestration.js`（25 断言）——把 Copilot 侧 `validate-handoff.ps1` 的**核心通用部分**机制化（sprint marker 一致 / plan+progress 存在 / 无 blocker / QA 完成度），挂 agent.cordis.yml（CN+EN）。这是对"迁移失真"的回应：9 个 Copilot hooks 中 blast-radius→kix-guards、validate-handoff 核心→kix-orchestration，其余按 kix 哲学决策不移植（深度部分绑定 Copilot 分派格式 / 角色边界靠 prompt / DSH 无对应流程）——详见 DSH-ADAPTATION.md §2
9. ⏳ kix-stalled 增强（证据新鲜度 gate）——待 P0 端到端验证后按需
10. ✅ 验收：npm test 全绿（164+24+57+43+25）；review prompt 命令注入实测不再出现无效路由

### P3 — 可选：团队编排工具化（决策点）
- 评估 dsh-agent-teams / dsh-collaboration 的团队状态工具是否值得引入
- kix 哲学：团队是手段不是目标；若 subagent/workflow 原生编排已够，则不做
- **此阶段是"可做可不做"**，取决于 P0-P2 后的实际体感

### P4 — 极简 + 渐进披露 + PTC 三层递进（✅ 已实施，2026-08-16，`kix-focus` 插件，34 断言）

**动机（量化，2026-08-16 实测当前会话清单）**：kix 会话每轮向模型发送 **85 个工具 schema
（107,939 B JSON，估算 ~30.8K token）**。裁剪到常驻集后 ~19.9KB（估算 ~5.7K token），
**schema 降幅 81.6%**——与 dsh-mcp-lens 实测方向一致（1000 工具场景 -89%）。量化脚本：
`scripts/quantify-focus.cjs`（可复跑）。

**三层递进（DSH 原生机制承载）**：
- **Phase 1 — 常驻裁剪**：`tools.restrict` 把模型每轮可见工具裁到常驻核心集（RESTRICT_ALLOW
  只列**全局工具** ~11 个：edit/write/pwsh/read/grep/glob/ask_user_question/todo_write/skill/
  web_search；subagent 五档与 kix_capability_* 是 scope 注册、自动可见——**restrict 对
  scope-local 名会 fail，故不列入 allow**）；MCP（GitHub 26/Playwright 24/Context7/Semgrep）、
  workflow/goal/ralph/job_*/cordis_* 等按需。`tools/change` 事件重试（MCP 可能晚于插件注册）。
  restrict 只影响模型可见面，scope 内工具与门禁插件不受影响。
- **Phase 2 — 渐进披露**：`kix_capability_search`（按需目录，返回分组元数据：类别/用途/
  示例工具名，**不含全 schema**——每轮不占上下文；用**全局视图** `schemas(undefined)`
  列出被 restrict 的工具）+ `kix_capability_call`（代理执行，经 `ctx.tools.execute` 走
  完整 pre-execute→guards→execute→post-execute 管线，**门禁依然拦截**：已验证
  kix-guards 的 KNOWN_SAFE_TOOLS 含全部编排目标、GitHub 门禁对只读放行；带 agent 的
  调用非 model-direct，不会被 UNKNOWN_TOOL 拒绝；存在性检查用全局视图
  `get(name, undefined)`）。**感知设计（2026-08-16 修订）**：不挂 pre-execute deny——
  restrict 已保证被裁剪工具对模型不可见（模型直呼 = UNKNOWN_TOOL），且 capability_call
  内部子调用走 pre-execute 必须放行（否则代理永远失败）；引导由 capability_call 返回与
  persona 触发句承担。
- **Phase 3 — PTC 协同**：保持 `tool-presentation mode: both`（native 直呼验证 +
  run_code 机械多步）；kix 红线「验证/观察用 native 直呼（证据可回放）」不变；
  capability_call 亦可被 run_code SDK 子分派调用（子分派过门禁）。

**配置**：`enableRestrict: false` 可关闭裁剪（仅保留 search/call）；`extraResidentTools`
可追加常驻工具。双版挂载（CN/EN），全量断言绿色（7 插件，以 `npm test` 实测数为准）。

**诚实边界**：restrict 是"模型可见面"裁剪而非"可执行面"——代理调用仍能执行被裁剪工具
（这正是渐进披露语义：能力在，schema 不常驻）。MCP 工具 schema 大且低频 → 全部按需；
cordis_*/goal/ralph/workflow 重型编排 → 按需（kix 主路径是 subagent 三通道）。

**scope 工具精简决策（2026-08-15 二次实测修正 + 三次按需激活；2026-08-17 用户决策
A+B 修订）**：restrict 只裁剪全局工具，preset scope 注册的工具（workflow/goal/ralph/
job_*/subagent-control）自动可见、裁不掉；scope 工具也无法经 capability_call 代理
（全局视图查不到 scope-local 名）。方案演进：
- 2026-08-16 渐进面（方案 A）：**默认 disabled + 插件按需激活**（`kix_tool_activate`
  运行时 `ctx.plugin` 挂载对应包——`createRequire(process.argv[1])` 解析 dsh 依赖，
  部署内可移植；激活后下一轮直呼，`kix_tool_deactivate` 卸载，会话结束自动清理）。
  实测教训：tool-jobs 默认 disabled 时 `run_in_background` 连启动都报
  "background jobs unavailable: no job controller serves this agent"——persona 与
  组成矛盾。
- **2026-08-17（现状；用户拍板原则：简单机械、不影响思考的工具常驻，有认知负担的
  工具机制化自动激活）**：
  - **常驻**：tool-jobs（job_* 纯机械控制面：启动/回收/停止已跑任务，无决策负担）+
    tool-subagent-control + exit_plan_mode；
  - **首次使用自动激活**：subagent 细分档位（lite/thinker/vision/fork/reviewer/qa/dev）
    与 goal——`kix_capability_call { tool: subagent_qa, arguments: {...} }` 代理调用
    未挂载的可激活工具时自动 `ctx.plugin` 挂载并继续执行，激活由**机制**兜底、模型
    无需记住先激活；下一轮起可直呼；`kix_tool_activate` 保留为显式预激活；
  - **仍 disabled（动态激活不可用，取消 disabled 重启）**：tool-workflow（isolate
    realm 依赖；dsh 版已挂载直用）、tool-ralph（en 版）。
- kix-focus 目录对细分档位组标注「首次使用自动激活」。

**端到端验证（✅ 已完成，2026-08-15 真实运行实测，重启后新会话）**：

| 验证项 | 结果 |
|---|---|
| schema 降幅 | 85 工具 / 107,939 B → 常驻 ~19,893 B（-81.6%，`scripts/quantify-focus.cjs` 可复跑） |
| 新建会话 | ✅ 正常（schema 修复后无 type:null 挂载/请求错误，控制台 0 错误） |
| capability_search | ✅ 返回 github 分组（26 工具）+ 常驻/按需统计，模型正确归类 |
| capability_call 只读代理 | ✅ search_repositories 真实执行（IN/OUT payload 正确，rootCallId 传播，无 UNKNOWN_TOOL） |
| capability_call 写门禁 | ✅ create_issue → ASK 弹窗 → 拒绝 → `ok:false` 无副作用；push_files 缺 branch → 静态 DENY 无弹窗 |
| run_code 常驻 | ✅ 模型工具面可见（restrict 不裁剪保留 transport），最小程序 41+1=42 真实执行 |
| run_code 子分派 | ✅ SDK `tools.read` 可用；`tools["mcp__github__push_files"]` 被门禁拦截，错误与直呼逐字一致——**门禁无旁路** |
| native 并行 | ✅ edit/read/pwsh/kix_capability_* 直呼照常（per-agent presentation 与宿主默认 native 并存） |

---

### P5 — 一致性守护写时拦截 + plan 契约校验（✅ 已实施，2026-08-17）

**背景**：上一轮复核（2026-08-17）逐项过哲学筛后，7 项候选只有 2 项通过可立即落地（其余被「规则是负债」正确否决：静态文件映射=反过拟合、compaction 已机制化=重复负债、direct schema=三层覆盖已全）。

**P5a — kix-consistency 插件（一致性守护写时拦截）**：
- `scripts/check-dsh-consistency.cjs` 拆核为 `plugins/consistency-lib.cjs` 纯函数核心（root 参数化、返回 `{failures, notes}`、无 console 副作用）——**CI 脚本与插件共用单一事实源**，防「CI 一套、运行时一套」双源漂移（自己立的「消灭双源」范式不能自己违反）
- 插件 pre-execute：写身份组成员时按路径跑**相关子检查**（persona 预算 / **该相同的数份必须相同** / memories 计数 / README 表述 / 版本对 / 单文件语法）。身份组 = dsh + en + `EXTRA_IDENTICAL_COPIES`（加语言/加参考副本 = 表里加一行）
- 触发面：仅「源仓库指纹」工作区（dsh/preset + en/preset + scripts 入口齐全）；其余工作区零开销放行
- 强度：默认 remind（文档可回滚不 deny）；ask/block 可配；remindOnce 每会话每类别一次
- 插件名清单动态化：`pluginNames()` 读目录，新增插件自动纳入 CI 检查（不再维护硬编码清单）
- **v1.2.15 泛化（自感知边界）**：触发面从「kixparadigm 指纹」改为自感知——preset 根 = `agent.cordis.yml` + `preset.yml` 双标记目录（深度 ≤2 扫描），任意仓库 ≥2 根才引导，单 preset / 普通项目零开销；身份组 = 各根同名 plugins（N ≥ 2 一次比完）；**shell 写入通道**（pwsh/bash 命令提及根内路径）pre 登记、post 复验身份组；其余根内路径（skills/agents 等翻译关系）发 **parity hint**——不断言失败，「其它根对应份是否同步」交给模型判断（没说到的形态靠提醒感知，每会话一次）；VS Code 导入源（根 `plugins/`）不是 preset 根，天然出组；kix 全量契约（预算/计数/表述/版本对）由 `scripts/check-dsh-consistency.cjs` 入口自声明，外仓只引导身份组——规则是负债，只做启发引导

**P5b — kix-orchestration v11（plan.md 契约写前校验）**：
- 落地边界注释「task_dag / verifiable_gates 结构校验做轻量版（存在性）」：只校验 kix-guards 预算链**真正消费**的字段（`task_sizing.derived_commit_budget` / `blast_radius.max_commits`，缺则预算静默落冷启动 3——sprint-9 事故形态）+ 任务清单存在性
- 只对 write 全量写入校验（args.content 可拿完整新内容）；edit 拿不到完整新内容，0 误报纪律不猜
- 独立提醒槽位 + 独立一次性标志（不烧 handoff/sleep 槽）

**验收**：kix-consistency 36 断言 / kix-orchestration 77→89 全绿；zh/en 双包 npm test 全绿；CI（test + pack dry-run）4 平台通过。

---

## 6. 验收指标（改造完成的定义）

| 指标 | 改造前（2026-08-15） | 现状（2026-08-16，P0+P1+P2） | 目标 |
|---|---|---|---|
| persona 常驻字符/token | 7,268 字符 / ~4.4K token | **v1.2.10 二次还债：3,211 字符 / ~1.8K token（P1 最低 2.1K；v1.2.9 曾回涨至 5,447/3.1K，已压回并加预算守护）** | ≤4K token |
| 纪律类规则承载方式 | prompt 说教 | **机制强制**（kix-discipline 插件：spec gate + green gate + spec 工具） | 机制强制 |
| 插件数 | 5 个 JS 插件 | **7 个**（+kix-discipline + kix-orchestration） | ≥6 个 |
| 断言回归 | 164+24+57 全绿 | **v1.2.11：installer 12 + vision 6 + guards 210 + cost 28 + route 68 + commands 6 组 + discipline 68 + orchestration 69 + focus 73 全绿** | 全绿 + 新插件断言 |
| 认知层（怎么思考） | 保留 | 保留但精简（三通道/二相性/盲点/路由仍在 persona，未机制化） | 保留精简 |
| instructions 与 persona 关系 | 双源重复 | **权威完整版 + persona 是运行时权威（去漂移）** | 单一权威 |
| DSH 适配/成本细节 | persona 全文 | **压缩为触发句 + 插件索引** | 触发句 + 文档 |
| Copilot 残留（硬编码模型字符串/hooks 假声明） | review prompt + agents 全量 | **review prompt 修复（subagent_cross 替代）；6 agent 注记声明插件接管；orchestrator Guardrails 标 DSH 承载** | 清除无效路由/假声明 |
| prompt 资产总量 | ~755KB | ~755KB（persona 减 4KB；skills/agents 是真实按需机制，按规则是负债决策不盲删） | 维持（不再追求 ≤300KB 数字，改为"按需加载 + 无冗余"） |

---

## 7. 边界与红线（kix 哲学的反面约束）

1. **不把"怎么思考"机制化**：三通道/二相性/盲点图谱/流程路由是认知启发式，写成
   gate 会从"理解"退化为"打勾"——这是 kix 明令禁止的（v5.5 范式）。
2. **不照搬生态插件**：只取机制结构（门禁+工具+状态），不取规则内容；
   kix 的需求三检 ≠ doublecheck 的六维 grill。
3. **规则是负债的自我应用**：新插件本身也是负债——kix-discipline 若 2 轮内
   无真实拦截记录（remind/ask 从未触发），降级为 opt-in 或删除。
4. **不消灭 prompt**：认知层永远需要 prompt；目标是"该机制的机制化、该精简的精简"，
   不是"零 prompt"。
