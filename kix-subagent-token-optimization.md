# KIX 子代理思考强度与 Token 开销优化 —— 论文研究 + 落地方案

> 研究对象：kixparadigm preset（kixpower v5.7，DSH 部署）
> 问题：① 所有 subagent 共享同一个思考强度；② 整体 token 开销偏高。
> 结论先行：论文共识是**固定高强度不是最优解**——正确做法是「难度感知的预算分配 + 级联路由 + 质量门控 + 缓存复用」。按 P0（纯配置，立即可做）→ P1（范式层规则）→ P2（机制扩展）三步落地，预计在不掉质量的前提下把子代理 token 开销压掉一半以上。

---

## 1. 现状诊断（基于你的实际配置实测）

### 1.1 「所有 subagent 同一个思考强度」的机制根源

`~/.dsh/settings.yaml`（第 7–10 行）：

```yaml
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: max        # ← 全局默认 = max
```

DSH 的模型选择链是：

1. `agent-default-model` 保存全局默认选择（provider / model / `reasoningEffort`），所有没有显式选择的 Agent 都吃到它（`dsh-agent-default-model` 的 `AgentDefaultModelSettings` 含 `reasoningEffort?: string`）。
2. 子代理工具行的 `agentOptions` **只有 `provider` / `model` / `maxTokens` 三个字段**（`dsh-agent` 的 `AgentOptions` 接口），**没有 effort 字段**。
3. `resolveChildAgentOptions`（`dsh-subagent`）的规则是：子代理继承父代理的 provider/model/maxTokens，再叠加工具行请求值——所以**所有子代理的 thinking effort 都落回全局默认 `max`**。
4. 你的 preset 里 `subagent` / `subagent_fork` 未钉模型（继承 deepseek-v4-flash + max），`subagent_zhipu` 只钉了模型没钉 effort（仍走全局默认的语义）。

**一句话根因：思考强度是「全局唯一旋钮」+「子代理继承」的组合，导致整支团队（含机械读文件的例行子代理）都在 max 档思考。**

### 1.2 token 开销的四大来源

| # | 来源 | 对应机制 |
|---|---|---|
| ① | **思考强度**：所有子代理 max 档思考 | 1.1 的全局默认 |
| ② | **fan-out 数量**：三通道交叉验证「并发 2–3 个异质子 agent」，最高置信 claim 再加跨厂商叠加 → 每个 claim 2–4 次完整回合 | persona §三通道 + CEO 编排 |
| ③ | **上下文重复**：每个子代理都是独立会话，系统提示 + 工具目录 + 任务上下文各自完整加载一遍，无跨会话复用 | DSH 子代理模型 |
| ④ | **无预算约束**：没有 per-role 的 token 上限、没有难度分级、没有质量门控 | 范式层缺 gate |

你已有的 ⑥–⑨ token 优化（orchestrator 瘦身 / trajectory reduction / Tri-Block / 结构化区套利）解决的是 **prompt 与轨迹**层面；缺的是 **「思考强度分层」** 与 **「调用数量门控」** 两个维度。

---

## 2. 权威论文研究

### 2.1 测试时计算的规模法则：固定高强度不是最优

- **[Scaling LLM Test-Time Compute Optimally can be More Effective than Scaling Model Parameters (Snell et al., 2408.03314)](https://ar5iv.labs.arxiv.org/html/2408.03314)** — 测试时计算（推理 token）与参数量遵循同一规模法则：**固定分配（uniform）很快到收益平台，最优分配是按任务难度自适应**。对所有任务一视同仁地砸 max 思考，是典型的次优分配。
- **[s1: Simple test-time scaling (Muennighoff et al., 2501.19393)](https://arxiv.org/pdf/2501.19393)** — 提出 **budget forcing**：直接给模型显式 token 预算，思考长度可被精确控制；预算 ×24 可线性换准确率。结论：**「预算」是一个工程旋钮，应该按任务难度设置，而不是让每个调用都无上限地想**。

### 2.2 难度感知 / 不确定性驱动的自适应强度（本问题最直接的一族）

- **[e1: Learning Adaptive Control of Reasoning Effort (2510.27042)](https://huggingface.co/papers/2510.27042)** — 用 RL 教会模型**自己决定何时用力、用多少力**（带成本惩罚的目标），在几乎不掉准确率的前提下大幅削减 token。这是「自适应 effort」的标杆工作。
- **[AdaCtrl: Difficulty-Aware Budgeting (TMLR 2026)](https://mlanthology.org/tmlr/2026/huang2026tmlr-adactrl/)** — 按难度感知分配推理预算。
- **[Coda: Difficulty-Aware Compute Allocation for Adaptive Reasoning (2603.08659)](https://ar5iv.labs.arxiv.org/html/2603.08659)** — 把计算量随题目难度重分配，验证了「真正自适应」而非盲目增加推理。
- **[DiffAdapt: Difficulty-Adaptive Reasoning for Token-Efficient LLM Inference](https://www.semanticscholar.org/paper/DiffAdapt%3A-Difficulty-Adaptive-Reasoning-for-LLM-Liu-Hu/77d2ab404c83a4da827ee5e55ed1049e3d3d85c6/figure/9)** — 同一方向，面向 token 效率。
- **[Ares: Adaptive Reasoning Effort Selection for Efficient LLM Agents (2603.07915)](https://huggingface.co/papers/2603.07915)** — 直接把自适应 effort 用到 **LLM Agent** 场景（与你的问题同构）。
- **[Uncertainty-Aware Budget Allocation for Adaptive Test-Time Reasoning (2605.26849)](https://www.semanticscholar.org/paper/Uncertainty-Aware-Budget-Allocation-for-Adaptive-Nguyen-Gupta/9a498e4c70b676beaa1c8a0703b3b729b1fd9ad0)** — 用模型自身的不确定性信号（一致性 / 自评）决定预算，先便宜后加码。
- **[Adaptive Thinking: LLMs Know When to Think in Latent Space (ICLR 2026)](https://iclr.cc/virtual/2026/poster/10011708)** — 模型学习「什么时候该想」，支持提前退出。
- **[How Well do LLMs Compress Their Own Chain-of-Thought? A Token Complexity Approach (2503.01141)](https://ar5iv.labs.arxiv.org/html/2503.01141v2)** — 提出 token complexity：同一模型对简单任务天然可以更短思考；CoT 可压缩性是可度量的。

> 共识：**「难度 → 预算」映射** + **不确定性作为升级信号**，是当前自适应推理的标准范式；e1/Ares 证明它可以直接作用在 Agent 工作流上。

### 2.3 模型路由与级联（省钱而不掉质量）

- **[FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance (2305.05176)](https://ar5iv.labs.arxiv.org/html/2305.05176)** — 级联（cascade）：**先便宜模型，不自信再升级贵模型**，成本最多降 **98%** 且质量持平甚至更高。这是「模型分层」的奠基工作。
- **[Budgeted Multi-Agent Routing: Adaptive Role Assignment and Communication Compression (IEEE)](https://ieeexplore.ieee.org/document/11441200)** — 预算约束下的多智能体角色分派 + 通信压缩。
- **[RouteGoT: Node-Adaptive Routing for Cost-Efficient Graph of Thoughts (2603.05818)](https://ar5iv.labs.arxiv.org/html/2603.05818)** — 推理图上**逐节点**选择执行档位，与你的 DAG 动态拓扑直接呼应。

### 2.4 多智能体系统本身的成本（fan-out 数量门控）

- **[AgentSlimming: Towards Efficient and Cost-Aware Multi-Agent Systems (ACL 2026)](https://aclanthology.org/2026.acl-long.1387/)** — 在保持质量下**剪掉冗余 agent**，成本感知的系统性方法。
- **[Agent Capsules: Quality-Gated Granularity Control for Multi-Agent Pipelines (2605.00410)](https://arxiv-org.ezproxy.obspm.fr/html/2605.00410v1)** — 核心思想：**质量门控决定执行粒度**——同一流水线可以跑「单 agent 模式 / 复合策略 / 细粒度逐 agent 分派」四种模式之一，质量不过才升级粒度。这是「观察者数量自适应」的直接理论依据。
- **[Dynamic LLM-Agent Network / DyLAN (2310.02170)](https://ar5iv.labs.arxiv.org/html/2310.02170)** — 每层协作后**按贡献剪枝**弱 agent，动态决定下一层谁继续。
- **[More Agents Is All You Need (2402.05120)](https://ar5iv.labs.arxiv.org/html/2402.05120)** — 采样-投票的收益**随 agent 数量饱和**（4–8 个之后基本不涨）。反过来说：**你的「并发 2–3 观察者」已是收益甜蜜点，但不应再往上加**；同质 agent 堆数量是纯浪费。
- **[Cut the Crap: An Economical Communication Pipeline for Multi-Agent Systems (2410.02506)](https://ar5iv.labs.arxiv.org/html/2410.02506)** — 精简 agent 间通信（去重、压缩、只传必要信息）。
- **[Slipstream: Semantic Quantization for Efficient Multi-Agent Coordination](https://zenodo.org/records/18708495)**、[**When LLMs Develop Languages: Symbolic Communication (ICML 2026)**](https://icml.cc/virtual/2026/poster/61557) — 把 agent 间消息压缩成结构化/符号化表示，跨 agent 上下文省 token 的另一个维度。

### 2.5 基础设施：上下文缓存

- **[CacheGen: KV Cache Compression and Streaming for Fast LLM Serving (SIGCOMM 2024)](https://dl.acm.org/doi/10.1145/3651890.3672274)** — KV 缓存压缩与复用。
- 工程实践：DeepSeek 官方 API 与智谱 API 都提供**自动上下文缓存**（命中部分按折扣价计费）。你的 DSH 部署（pi-ai）已内置缓存能力字段：`cacheControlFormat: "anthropic"`、`prompt_cache_retention: "24h"`、`supportsLongCacheRetention`（见 dsh 安装内 `@earendil-works/pi-ai` 的 `OpenAICompletionsCompat`）。**子代理共享同一系统提示与工具目录前缀，天然是缓存命中的理想形态**。

---

## 3. 解决方案（映射到 KIX / DSH）

### P0 — 纯配置，立即可做（不动代码，今天就能生效）

**P0.1 全局 effort 降档**：`settings.yaml` 的 `reasoningEffort: max` → `medium`（或 `low`）。

- 依据：2.1 规模法则——max 是无预算的固定高分配；KIX 的核心能力在 persona / 三通道 / 机制规则里，medium 思考足够承载，max 只应作为「显式升级」。
- 说明：当前 DSH 机制下 effort 是全局默认，主 agent 与子代理共用；先降档止损，再靠 P0.2 的模型分层把「高强度」变成显式选择。

**P0.2 角色分档工具行（直接回答「所有 subagent 一个强度」）**：在 `agent.cordis.yml` 的 delegation group 里按角色拆出多档子代理：

| 工具行 | 模型 | 用途 | 依据 |
|---|---|---|---|
| `subagent_lite`（新增） | `zai-coding-cn/glm-4.5-air`（131K 窗口，快/便宜） | 机械读码、格式检查、简单检索、低风险 claim 观察 | FrugalGPT 级联的第一档 |
| `subagent`（现有） | 继承主模型 | 常规分派 | — |
| `subagent_thinker`（新增，或复用 `subagent_zhipu`） | `zai-coding-cn/glm-5.3` | 跨厂商高置信验证、高风险/高难度 claim | 级联的升级档 |
| `subagent_vision`（现有） | `zai-vision/glm-4.6v` | 识图 | — |

配套在 persona §三通道 + §CEO 编排里写一条**选档规则**：「默认 lite，命中高风险信号（外部语义/安全/并发/平台行为/跨模块契约）才升级 thinker」——这是 FrugalGPT 级联思想 + 你已有的流程路由信号四属性，零新概念。

**P0.3 per-role maxTokens 预算帽（budget forcing 工程化）**：各工具行 `agentOptions.maxTokens` 分角色设上限（如 `lite: 8192`、`thinker: 32768`、`vision: 4096`）。依据 s1：显式预算可精确控制思考长度，防跑飞。

**P0.4 观察者数量门控**：把「并发 2–3 个异质子 agent」改成**「先 1 个独立观察者；与主 claim 分歧才加第 2 个；高风险 claim 直接 2 个」**。依据 Agent Capsules（质量门控决定粒度）+ More Agents（饱和曲线）：低风险 claim 的 2–3 观察者是纯冗余，按此规则典型场景 fan-out 直接减半。

### P1 — 范式层规则（改 prompt/文档，仍不动 harness）

**P1.1 难度预估显式化进分派 prompt**：orchestrator 分派前给每个子代理标注 `[EFFORT: low|medium|high]` + `[BUDGET: ≤N tokens]`，子代理自限思考与输出长度。这是 e1/Coda/UAB 思路的「prompt 化」版本（模型侧无 RL 也能用）。注意 KIX 元规则「补足非限制」：这是给预算工具，不是规定思考方式，符合范式。

**P1.2 子代理输出 schema 化**：用 `outputSchema` 要求子代理返回结构化结果（`{结论, 证据文件:行, 置信度, 分歧点}`），替代长文叙述。省两类 token：子代理输出的思考性叙述 + 父线程重新阅读的上下文占用。

**P1.3 结果 memoization**：同一 `(文件, claim)` 的验证结论写入 progress.md（与 ⑦ trajectory reduction 配套），重复 claim 不再重派观察者。对三通道的高频「读代码验证」收益最大。

**P1.4 粒度门控进流程路由信号**：现有信号四属性（规模/副作用/验证关键/不确定）增加「验证关键度」等级 → 决定观察者数量与档位（单通道直做 / lite 单观察者 / thinker 双观察者）。

### P2 — 机制扩展（需要改 harness 本身，建议作为 feature 提给 DSH 或本地补丁）

**P2.1 AgentOptions / workflow opts 支持 `reasoningEffort`**：这是「所有 subagent 一个思考强度」的机制根源（§1.1）。改 `dsh-agent` 的 `AgentOptions` 增加 `reasoningEffort?`，让子代理工具行和 `workflow.agent(prompt, {provider, model, effort})` 都能逐调用指定档位，真正实现**按角色/按任务动态强度**——与 Ares（agent 场景自适应 effort）对齐。改完后 P0.1 可以回退主 agent 到 high/max，只让例行子代理保持 low。

**P2.2 上下文缓存落地**：把系统提示 + 工具目录 + 常用文件摘要固定为 prompt 前缀（变化内容放尾部），最大化 DeepSeek/GLM 自动缓存命中（命中价约为 1/10）；pi-ai 已支持 `prompt_cache_retention` 等字段，确认 provider 侧开启即可。

**P2.3 token 度量进 fidelity 机制**：你的 `verification-fidelity-check.ps1` 已是跨 Sprint 累积度量，扩展一个「per-role token 趋势」面板（DSH 会话遥测里有 usage），用数据决定档位调整——符合「实践学习生命周期」（candidate → trial → validated）的范式。

---

## 4. 预期收益（论文锚点）

| 手段 | 论文依据 | 量级 |
|---|---|---|
| 级联分层（lite→thinker） | FrugalGPT | 成本 ↓~98%（同质量） |
| 预算帽（budget forcing） | s1 | 思考长度精确可控，防跑飞 |
| 难度感知 effort | e1 / Coda / AdaCtrl / Ares | 显著降 token、准确率基本持平 |
| 质量门控粒度 | Agent Capsules / DyLAN | 多 agent 流水线成本 ↓30–50% |
| 观察者数量封顶 | More Agents Is All You Need | 4–8 个后收益饱和，2–3 个已够 |
| 上下文缓存 | CacheGen + provider 缓存 | 重复前缀命中价 ~1/10 |

组合预期：**P0 四项落地后，子代理 token 开销（思考 + fan-out）可压掉一半以上，且观察质量不降**（因为省掉的是低风险场景的 max 思考与冗余观察者，而不是高风险验证）。

---

## 5. 建议执行顺序

1. **本周**：P0.1（全局 medium）+ P0.2（lite/thinker 分档行）+ P0.3（预算帽）→ 先降本止损，观察 2–3 个 Sprint。
2. **下周**：P0.4（观察者门控）+ P1.1/P1.2（effort 标注 + schema 输出）→ 用 fidelity 机制对照质量趋势，若质量不降继续推进。
3. **之后**：P1.3/P1.4 → 视需要向 DSH 提 P2.1 的 effort-per-child feature（这是治本项）。
4. 全程用 P2.3 的 per-role token 度量驱动决策，不用拍脑袋。

---

## 附：关键文件索引

- 全局 effort 旋钮：`~/.dsh/settings.yaml` L7–10（`agent-default-model.reasoningEffort`）
- 子代理工具行：`dsh/preset/agent.cordis.yml` L254–349（delegation group，agentOptions 只有 provider/model/maxTokens）
- 三通道 fan-out 规则：`dsh/preset/agent.cordis.yml` persona §三通道交叉验证 + §CEO 团队编排
- 机制证据（DSH 源码）：`dsh-agent` `AgentOptions`（provider/model/maxTokens 三字段）；`dsh-subagent` `resolveChildAgentOptions`（子代理继承父路由）；`dsh-agent-default-model`（全局 reasoningEffort）；pi-ai `OpenAICompletionsCompat`（缓存能力字段）
