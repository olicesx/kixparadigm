# Laya 轨迹守卫 × kix 范式 — 原生集成设计

> 输入：`laya-dsh-handoff.md` + 本仓库插件源码 + **实测**（缓存模型 + `LocalLLaMA/typed-decisions` 真实数据集）。
> 结论先行：轨迹守卫在 kix 里的原生身份不是"一条新规则"，而是**结算层的一个概率型 evidence child**——
> 它落在 `kix-settle` / `kix-orchestration` 已有的「交付时单发 advisory」通道里。
>
> 关键发现：**该模型输出词表与 kix 的结算通道几乎一一对应**（`observe` 就是盲抽样、`human_review` 就是拉
> fresh observer）。这是"适配"的实质，不是巧合。

---

## 1. 训练契约（已用真实数据集验证，非文档转述）

从 HF 拉取 `LocalLLaMA/typed-decisions` 的 `agent_trace_observability` test split（100 例）实测：
`state` + `questions` **就是 `POST /v1/systemone` 的请求体**（数据集卡原话），可直接 replay。

### state 的真实 schema（100/100 一致，310–449 字符）

```json
{
  "agent": { "autonomy": "unsupervised | checkpointed | dry_run", "model": "internal-agent-vN" },
  "constraints": ["…1–3 条自然语言约束…"],
  "task": "…自然语言任务…",
  "trace_summary": {
    "constraint_violations": 0..1,
    "duration_s": 27..899,
    "irreversible_actions": 0..1,
    "steps": 3..12,
    "tool_errors": 0..3
  }
}
```

**state 是结构化的、纯元数据**——数据集卡原文："It stays structured where the artefact genuinely is
structured, as in invoices and **agent traces**." ⇒ 不要喂对话全文，喂这五个标量 + task + constraints。

### questions（5 题，须原文复用）

| qid | 类型 | 选项 / 表 | 与 kix 的对应 |
|---|---|---|---|
| `action` | choice | continue / **observe** / **human_review** / stop | **直接命中 kix 结算词汇**（见 §4） |
| `needs_review` | noul | true / false | 是否值得拉独立观察者 |
| `outcome` | choice | success / partial / failure / harmful | 轨迹结局 |
| `risk` | score(4) | Benign / Low / Moderate / High | 风险分级 |
| `urgency` | score(4) | 无压力 / 常规 / 本周 / 当天 | 审查优先级 |

`action` / `needs_review` / `outcome` / `risk` 的 criteria 逐条见 `presets/agent_trace_observability.json`。
**必须原文复用**——checkpoint 是在这套 instructions/criteria 上微调的；我实测换掉措辞会退化。

### 分布内 vs 分布外（一手来源 + 实测）

| | 证据 |
|---|---|
| `agent_trace_observability` **分布内** | typed-decisions 0.766（其自身训练 split）；教师自一致天花板 0.735；`urgency` 单题天花板仅 **0.560**（最弱，只作参考） |
| base 模型**近随机** | 模型卡："0.362 / 0.352 vs 0.318 random … **not a zero-shot decision engine**" |
| kix 元判定（三检/路由/审查分级）**分布外** | 训练场景是四工作流（客服/发票/安全事件/轨迹观测），无 AI 编排元判定 |
| **我的实测（决定性）** | 缓存 multilingual 跑**真实 schema + 真实题面** 全 100 例：`needs_review` acc **0.49**（基线 0.45）、`action` acc **0.06**（预测 `stop` 89/100，多数基线 0.36）、`risk` 0.22（0.34）、`urgency` 0.30（0.37） |

⇒ 两条硬结论：**① 必须用 typed-decisions checkpoint，base 完全不可用；② 任何情况下都不能让它进闸门。**
（我第一版用自造题面测到 `needs_review` noul=0.02 却 conf=0.978 —— 高置信错分是该模型的真实失败形态。）

---

## 2. 两个实测硬约束（决定架构）

### 2.1 state 静默右截断，库不报警

`laya/common.py:build_sequence`：`st = st[-room:] if truncate_left else st[:room]`，默认
`truncate_left=False` ⇒ **砍尾**；返回值里没有 truncated 标志。`usage.input_tokens` 是 batch 内
各题序列之和（实测 5 题 827），**不能**用来判断单题是否溢出。

⇒ state 由调用方限长；服务层自算并回报 `truncated: true`（交接文档 §7 已列）。

### 2.2 turn-stopping 是阻塞的，延迟按实测预留

`dsh-agent-loop/lib/index.js:967`：`await this.dispatch.serial("agent/turn-stopping", …)`。

| 项 | 本机实测（RTX 4060 Laptop，multilingual GPU，预热后，真实 335 字符 state × 5 题） |
|---|---|
| 冷加载 | **14.8 s**（⇒ 常驻预热是硬要求） |
| 5 题延迟 | **mean 121.6 ms / p95 125.5 ms** |
| 交接文档短 state 5 题 | ~31 ms（口径/题面不同，**按本机实测预留预算**） |

⇒ 调用点必须带超时预算（建议 400ms）+ 熔断 + 冷启动首调用跳过。

---

## 3. 适配面：哪个插件、哪个挂载点

kix 插件本就是 `session/event` 观察 + `agent/turn-stopping` 单发 advisory 的形态，
所以"很多插件适配"的实质是：**守卫是一个新的证据生产者，而不是一套新机制**。

| 插件 | 现有信号 | 守卫的原生角色 | 分布内 | 优先级 |
|---|---|---|---|---|
| `kix-settle.js` `agent/turn-stopping` (L262) | 确定性记账：edit 代际 / 是否执行验证 / fresh observer / 盲抽样 | **主位**：把"这条轨迹该不该拉独立观察"从硬编码启发式变成连续概率 | ✅ | **P0** |
| `kix-orchestration.js` `subagent/end` (L1324) | 交接证据链校验 | 对 child 报告轨迹做 needs_review 预筛 | ✅ | P1 |
| `kix-route.js` | 属性路由（≥3 文件/外部副作用） | 分派肥瘦/风险预筛 | ❌ | P3 shadow |
| `kix-discipline.js` | spec 契约 gate + 三检 | 三检触发预筛 | ❌ | P3 shadow |
| `kix-guards.js` | 硬 deny（0% 误报目标） | **排除** —— 红线①，概率模型永不进 | — | 排除 |
| `kix-budget.js` `session/event` (L412) | 轨迹记账（turn/step/tool/usage） | **不是挂载点，是数据源** | — | 复用 |

**为什么 kix-settle 是主位**：它的盲抽样分支（`mutationPaths.size <= 2` + 稳定散列抽样）本质就是
"低风险交付 → 低频拉无先验观察者"，与 `needs_review` 同构，只是现在是硬编码启发式。
守卫的增量不在"有没有验证"（确定性计数已知），而在计数看不见的整体形态：抖动/重试/约束违背/不可逆动作。

### 去重（必须显式设计，否则双份齐射）

kix 有先例代价（kix-signal 的 S1 与宿主 repeat-tool-reminder 重叠被判退）。因此：

- 守卫走**独立插件文件**（`kix-laya.js`），自己的 once-per-session 预算；
- 与 settle 同代（`editGeneration`）**互斥**：settle 已提醒则守卫本代静默，反之亦然；
- 守卫只在**携带增量信息**时出声（`needs_review` 与确定性计数相悖，或 `action ∈ {observe, human_review}`）。

---

## 4. 核心转译：模型的输出词表 = kix 的结算词汇

这是"原生融入"的关键——不需要发明映射语义：

| Laya `action` | kix 现有通道 |
|---|---|
| `continue` | 不出声（kix-settle 不触发） |
| `observe` | **`kix-settle` 盲抽样**（题面原文："Keep running, but flag the trace for later sampling"） |
| `human_review` | 建议拉 fresh observer / 主线程复核 |
| `stop` | ⚠️ kix **无 halt**；最多升级为向用户提问。训练集仅 **2/100** 例，且红线①禁止拦截 ⇒ 只记录，不执行 |

`needs_review` 是二值桥（`kix-settle` 现成 advisory 的判据）；`risk` / `urgency` 作为分级参考。
**红线②**：`human_review`/`observe` **不得**写 `freshObserverSeen`、不得 block、不得 auto-spawn——
一旦置位就变成"用概率模型结算"。

---

## 5. 架构：三层，模型进程独立

```
┌ L0  常驻推理进程（Python，独立于 DSH）───────────────────────┐
│  ~/laya-env + typed-decisions(1024)；加载一次 14.8s          │
│  暴露 /health /decide /preset/{name}；自带 truncated 计算     │
│  不嵌权重进插件 = 显存/崩溃/热升级三重隔离（交接文档 §7 共识） │
└──────────────────────────────────────────────────────────────┘
        ▲  loopback HTTP（127.0.0.1）
┌ L1  判定 SDK（preset 内 JS，无模型）─────────────────────────┐
│  kix-laya.cjs：client + 400ms 超时 + 熔断 + no-op 降级        │
│  presets/*.json：题面定义（**原文复用数据集**，带 version）    │
│  shadow JSONL：**镜像数据集行 schema**，可训练/可校准         │
└──────────────────────────────────────────────────────────────┘
        ▲
┌ L2  kix 挂载点 ──────────────────────────────────────────────┐
│  P0 kix-settle(agent/turn-stopping)   P1 kix-orchestration    │
│  P3(仅 shadow) kix-route / kix-discipline                     │
└──────────────────────────────────────────────────────────────┘
```

- **transport**：loopback REST（非 stdio）——交接文档 §7 已定此契约，可用 curl 单独复现，daemon
  独立于 DSH 进程生命周期，跨 DSH 重启保持预热。
- **MCP 不做内部通道**：MCP 工具是模型可见的，占 schema/token；守卫是插件内部证据通道。
  MCP 只在需要"模型手动探查判定"时另开调试面。
- **独立进程**：kix「规则是负债」要求整通道可退役；权重嵌进插件会让显存变成预算与 crash 半径。

### state 构造 = kix 已有信号的再投影（不新增埋点）

| 数据集字段 | DSH / kix 来源 |
|---|---|
| `agent.autonomy` | 分派档位（solo/观察者/dev/qa 组合、是否 checkpoint） |
| `agent.model` | 真实路由（kix-route 已解析的 provider/model） |
| `constraints[]` | kix spec 契约「必须不变」+ 用户目标（`kix-discipline` spec.md） |
| `task` | 会话目标（最近 user message / goal） |
| `trace_summary.steps` | `kix-budget` 步计数（`session/event` + `agent/pre-step`，L412） |
| `trace_summary.tool_errors` | `tool/result` 非成功计数 |
| `trace_summary.irreversible_actions` | `kix-guards` 命中的危险操作（force push / 危险 SQL / 控制面） |
| `trace_summary.constraint_violations` | 违约束动作（spec 契约违背 / 越界编辑） |
| `trace_summary.duration_s` | 会话时长 |

**⚠️ 不要往里加 kix 特有字段**（fresh_observer、verdict_line、edit_generation…）：训练 state 里没有，
加进去就是把输入推出分布。要加，就走**新 preset + bump version + 重新校准**，并单独验证。

---

## 6. 红线合规自检

| 红线（交接文档 §7） | 本设计如何满足 |
|---|---|
| ① 不进确定性拦截路径 | 只挂 `agent/turn-stopping` / `subagent/end` 的 advisory；**绝不挂 `tools/pre-execute` deny**。`kix-guards` 一行不动，`action=stop` 也不执行。 |
| ② 契约层结论只给参考值，终审留主线程 | 不写 `freshObserverSeen`、不 block、不 auto-spawn。输出只报原始概率分布 + confidence，由主线程解读。 |
| ③ claim 筛选权不代筛 | 只对"这条轨迹要不要人看"作答，不筛 finding、不判 finding 数量。 |
| shadow 先行 | M2 阶段零 steer、零注入，只落 JSONL。 |
| 独立可退役 | 单独 `kix-laya.js`；SDK 只被本文件 require；删除即回退，settle 不受影响。 |

---

## 7. 里程碑与死亡条款

| 阶段 | 内容 | 出口判据 |
|---|---|---|
| M0 | 拉 `typed-decisions`（808MB，走 §6 代理通路）；固化 `presets/agent_trace_observability.json`（原文复用） | `load(subfolder="typed-decisions")` 成功；preset 与数据集 questions 逐字节等价 |
| M1 | 常驻服务 `laya-serve.py`：`/health` `/decide` + `truncated` | curl 单次 <400ms；冷启动后 /health 稳定 |
| M2 | `kix-laya.js` shadow-only，挂 `agent/turn-stopping`，只写 JSONL | 真实会话产出 ≥N 条记录，零 steer、零交付延迟超预算 |
| M3 | 评估：本地 ECE + `action/needs_review` 与真实结算事件（未验证交付/fresh observer 缺失）的相关性 | 有可复算的相关系数 |
| M4 | 用 shadow 数据拟合温度（按 题型×选项数 分桶）；官方路径 ECE 0.466→0.081 | ECE 显著下降 |
| M5 | 放开 advisory（仍不 gate） | 采纳率/误报率对照 |

**死亡条款**（kix「两轮无实证收益 → 删」）：M3/M4 两轮 shadow 数据后，若守卫的风险分类**不优于**
`kix-settle` 现有确定性计数（edit 无验证、fresh observer 缺失、mutationPaths 大小），
则删掉整个 `kix-laya` 通道——它只是一个更贵的、会高置信出错的复读机。
shadow JSONL 从第一天按**可训练数据**标准采集（镜像数据集行 schema + 人工复核标签），退役也不浪费。

---

## 8. 未决 / 需你定

1. **常驻 GPU daemon** 是否可接受（~1.4GB 显存；DSH 主模型走远端 API，本地 GPU 空闲）。
2. transport 最终形态：loopback REST（本设计默认）还是 stdio JSON-RPC。
3. shadow 的样本量与时长口径（多少会话/多少条判定算"一轮"）。
4. 是否先落地 M1+M2 骨架（服务 + SDK + shadow 挂载，不含任何 steer）。

**残余不确定性（可证伪）**：训练 state 是**合成**的简化轨迹（5 个标量 + task + constraints），
真实 kix 会话的信号面更丰富。若 typed-decisions 在真实 kix 轨迹上显著低于 0.766（例如出现输入分布
漂移：真实 task 更长、约束更抽象），则 §5 的"只喂训练 schema"策略需要扩展为附加 kix 字段并重新微调。
**未验证**：typed-decisions checkpoint 我尚未下载实测（本设计基于模型卡 0.766、数据集卡天花板
0.735、以及 base 模型实测近随机三条独立证据推断其可用性）。

---

## 附录 A：本轮实测结果（2026-09-21）

### A1. 官方基准 `agent_trace_observability` test split（100 例，逐题 argmax 命中率）

| question | **typed-decisions** | base multilingual | 多数基线 |
|---|---|---|---|
| `action` | **0.700** | 0.06 | 0.360 |
| `needs_review` | **0.840** | 0.49 | 0.550 |
| `outcome` | 0.650 | — | 0.500 |
| `risk` | **0.830** | 0.22 | 0.340 |
| `urgency` | 0.650 | 0.30 | 0.370 |

- 延迟 mean **65.0 ms** / p95 64.6 ms（5 题 batch，335 字符 state）；首次 build 加载 148 s（此后走缓存）。
- **base 完全不可用已实锤**：`action` 0.06（89/100 预测 `stop`），比多数基线还差。必须用 typed-decisions。

### A2. 真实语料 shadow（1060 个 kix 会话 / 3 个 root；1024 个 preset=kixparadigm）

抽取自 `~/.dsh/sessions/*/session.jsonl.zstd`（全库 1603 会话 / 1.3 GB）。

输出分布（未塌缩，置信度未饱和）：

| 维度 | 分布 |
|---|---|
| `action` | continue 431 / observe 355 / human_review 274 / **stop 0** |
| `outcome` | success 631 / partial 429 / **failure 0 / harmful 0** |
| `needs_review` | ≥0.5 仅 **13.5%**（官方测试集真值率 45%）；mean 0.426 |
| confidence | mean **0.581**（未饱和 —— 好信号） |
| `risk` / `urgency` | mean 0.84 / 0.86（0–3 分制，偏低） |

与 kix 已有确定性信号的交叉（这是"M3 出口判据"的首次实测）：

| 分层 | n | 守卫标 `needs_review` 比例 |
|---|---|---|
| `irreversible_actions > 0` | 44 | **77.3%** ← 强 |
| 未验证交付（edits>0 且之后无验证） | 47 | 29.8% |
| 其他 | 1013 | 12.7% |
| 已触发过 kix-settle advisory | 169 | 27.8%（基线 13.5%，**2×**） |
| root 会话 | 204 | 22.5% |
| subagent 会话 | 856 | 11.3% |

**读法**：守卫与不可逆动作、与 kix-settle 自身触发**独立同向**（后者是它没见过的信号）；但它只捞到 30% 的未验证交付 ⇒ **不能替代确定性计数，只能做增量**。两个明确缺陷：从不预测 `failure/harmful`；`needs_review` 率远低于训练分布。

**分布漂移消融**（把 steps/duration 截到训练范围 3–12 / 27–899 s）：`action` 一致率 90.3%、`needs_review` 一致率 92.6% ⇒ 漂移影响**温和**（我们中位 24 步 vs 训练 3–12 步）。

### A3. 后训练（RLCD）配方 — 取自官方 notebook

`notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb`：

- 数据形态：`(state, questions, **soft gold 分布**)` —— 硬标签不够，reward 直接用分布
- EPOCHS **4**；MICRO_BATCH 8；GRAD_ACCUM 4；GROUP_SIZE 4（GRPO baseline）
- LR encoder **2.5e-5** / head **1.0e-4**，AdamW + cosine，wd 0.01
- 探索噪声 σ **0.4→0.1**；reward `proper_reward(w_sph=0.75, w_rps=1.0)` + 权重 1.0 的 soft CE
- 训练后按 qtype 用 LBFGS 拟合温度
- 官方成本：**1200 例 → 2×T4 上 4 epochs 仅 4–6 分钟**

**本机 4060 Laptop 8GB 实测**：MICRO=4 即把显存顶到 **7.9/8.1 GB**，**16 分钟未跑完 1 个 epoch** ⇒ 本地单卡训练不划算，走 Kaggle 免费算力。

**真正的瓶颈不是算力，是软标签。** 我们的 1060 条轨迹没有 gold 分布；官方做法是用教师模型对同一 state 采 3 次（temp 0.7）取均值。按此估算：1060 state × 3 = **~3.2k 次教师调用**（每次约 1.1k token ≈ 3.5M token），成本远低于一次编码会话。

**后训练的价值定位（重要）**：教师是谁，天花板就是谁。RLCD 微调得到的是**蒸馏**——一个 421M、65ms、零边际成本的常驻近似体，而不是比教师更准的判断力。这恰恰是它相对"每次交付调一次大模型判官"的唯一优势：**能对每一次交付都跑**。

---

## 附录 B：是否需要自己微调？（决策判据）

### B1. 反事实敏感性实验（60 个真实 kix state，逐字段扰动）

先把每个 state 抹成干净基线（violations=0, irreversible=0, errors=0, steps=6, unsupervised），再单项扰动：

| 扰动 | P(review) | Δ | `action=human_review` | risk |
|---|---|---|---|---|
| baseline(clean) | 0.360 | — | 0.0% | 0.74 |
| constraint_violation=1 | 0.491 | +0.131 | 90.0% | 1.13 |
| irreversible_action=1 | 0.490 | +0.130 | 60.0% | 1.47 |
| tool_errors=3 | 0.503 | +0.143 | 71.7% | 0.92 |
| steps=200 | 0.361 | +0.001 | 0.0% | 0.73 |
| steps=1655 | 0.355 | −0.006 | 0.0% | 0.72 |
| autonomy=dry_run | 0.342 | −0.018 | 0.0% | 0.52 |
| ALL_BAD | 0.742 | +0.381 | 98.3% | 2.35 |

**结论**：判定逻辑在 kix schema 上**单调且方向正确**，ALL_BAD/clean 分离度 dP=0.381、d_risk=1.62。
⇒ ① **主输出用 `action` 而非 `needs_review`**（前者 0%→90% 灵敏，后者只 +0.13）。
⇒ ② **步骤数被完全忽略**（6→1655 无变化）⇒ 我们最大的分布漂移（中位 24 步 vs 训练 3–12）**无害**。
⇒ ③ **模型不使用它没在训练里学到要用的字段**——即使 `steps` 是训练字段。这是关键警告：往 state 里塞 kix 专属字段，模型大概率视而不见。

### B2. 决定规则：问题的定义权在哪

`typed-decisions` 是**专才（specialist）**，不是通才——数据集卡明写：

| | 训练方式 | 能否回答没见过的题 |
|---|---|---|
| specialist | 按工作流拟合，**标签空间在训练时固定** | **不能** |
| generalist | 任意 schema、零样本 | 能 |

所以判据不是"准不准"，而是**你接不接受这 5 个问题的定义**：

| 选择 | 代价 | 结论 |
|---|---|---|
| **接受**这 5 题（"是否需要人类审查" + risk/urgency），只想要它适配我们的数据分布 | 温度校准：约 200–400 条标注拟合 (题型×选项数) 分桶 | **不需要微调**，现有 checkpoint 够用 |
| **不接受**，要判定 kix 自己的结算关切（验证缺口 / 独立性缺失 / 契约违背） | 定义新题 + 教师标注 600–1200 条 + RLCD 微调（Kaggle 4–6 min） | **必须自己微调** |

**为什么"改题"必然要求微调**：专才的标签空间训练时固定；换题面 = 换工作流 = 未见过的问题。
**为什么"加字段"救不了**：B1 的 `steps` 证据表明，模型不会使用训练中没学会要用的字段。kix 的验证缺口
（edits 之后有没有可重放执行）**根本不在训练 schema 里**，塞进 `tool_errors` 之类的现有字段是误用。

### B3. 共同前置：标注（两条路都要）

无论选哪条，都需要一批**带标签的真实会话**：校准要它、微调要它、评估"够不够用"也只能靠它。
建议先定义 2–3 个 kix 结算问题，标 300 条真实会话，然后测：

- 若零样本 typed-decisions 与教师判官差距小 → 只做温度校准；
- 若差距大 → 用这批标注做 RLCD 微调。

---

## 附录 C：第二档"跨工作流路由"实测 —— **不成立**

`typed-decisions` 在**四个**工作流上微调过。第二档的假设是：同一份权重，靠状态机在四个已训练判定点之间切换，
就能白嫖出更多 kix 能力。实测否掉了它。

### C1. 各自主场能力（官方 test split，逐题 argmax）

| 工作流 | 题面命中率（多数基线） |
|---|---|
| agent_trace_observability | action .70 (.36) / needs_review **.84** (.55) / outcome .65 (.50) / risk **.83** (.34) / urgency .65 (.37) |
| invoice_processing | matches_order **.94** (.54) / duplicate .92 (.89) / discrepancy_severity .85 (.47) / disposition .80 (.45) / urgency .52 (.51) ⚠ |
| security_incidents | true_positive **.87** (.73) / credential_compromise .81 (.55) / severity .78 (.49) / disposition .73 (.74) ⚠ / urgency .66 (.50) |
| customer_service | category .94 (.38) / churn_risk .81 (.47) / needs_human .77 (.67) / urgency .73 (.42) / action .58 (.52) ⚠ |

**主场没问题，但强的是"题"不是"流"**：`matches_order` / `true_positive` / `needs_review` 强，
`urgency`（发票）、`disposition`（安全）几乎等于甚至低于多数基线。

### C2. 把 kix 信号塑形成各工作流的 state（受控，ground truth 已知）

**B1 `invoice_processing` ← kix 契约符合性**（order=spec 契约，invoice=实际改动，delivery=验证证据）

| 用例 | matches_order | discrepancy_severity | disposition |
|---|---|---|---|
| MATCH + verified | 0.700 ✓ | 0.72 | approve ✓ |
| MATCH + unverified | 0.602 ✓ | 1.39 | manual_review |
| MISMATCH + verified | 0.462 ✓ | 1.64 | approve ✗ |
| MISMATCH + unverified | **0.559 ✗** | 1.43 | approve ✗ |

即使差异极端（PO 总价 100 vs invoice 640，收到数量 0），仍有一个 mismatch 被判"对得上"；
`disposition` 4 例只对 1 例。**调用点不可用。**

**B2 `security_incidents` ← kix 危险操作告警真伪**

| 用例 | true_positive | severity | disposition |
|---|---|---|---|
| TRUE_POSITIVE（force push 保护分支/无审批） | 0.607 | **2.99** | investigate |
| FALSE_POSITIVE（force push 自己的 feature 分支） | 0.533 | **1.44** | investigate |

`true_positive` 只差 **0.07** 且双双 ≥0.5 ⇒ **二值判定不分离**；`disposition` 不分离。
**但 `severity` 干净分离（2.99 vs 1.44）—— 唯一明确通过的迁移。**

**B3 `customer_service` ← kix 需求清晰度**

| 用例 | action | needs_human | category |
|---|---|---|---|
| CLEAR（精确改名指令） | answer_directly ✓ | 0.495 | technical ✓ |
| AMBIGUOUS（"让它更好"） | escalate_to_human ✓ | **0.417 ↓** | technical ✓ |

`action` 方向对，但 `needs_human` 反向（模糊需求反而更不需要人）⇒ **内部自相矛盾，不可用。**

### C3. 结论

| 题 | 主场 | kix 形状 | 判定 |
|---|---|---|---|
| `severity`（安全） | .78 | 2.99 vs 1.44 | ✅ 可用 |
| `discrepancy_severity`（发票） | .85 | 方向对、噪声大 | ⚠️ 仅参考 |
| `matches_order`（发票） | **.94** | 4 例错 1，margin 0.10 | ❌ 不可用 |
| `true_positive`（安全） | **.87** | 差 0.07、不分离 | ❌ 不可用 |
| `disposition`（两者） | .80 / .73 | 不分离 | ❌ 不可用 |
| `needs_human`（客服） | .77 | 方向相反 | ❌ 不可用 |
| `action`（客服） | .58 | 方向对但自相矛盾 | ❌ 不可用 |

**主场 0.94 / 0.87 的题，一换到 kix 形状就掉到"错 1/4"和"完全不分离"。** 这与附录 B1 的
`steps` 证据（模型不使用训练里没学会要用的字段）是同一条规律：**专才对 state 形状敏感，re-shaping 的代价
落在判定决策上。**

⇒ **第二档不成立，除非配微调（那就回到第三档）。** 唯一可白嫖的是 `severity` 这类"影响面"题。
（方法学caveat：受控用例仅 8 个、由我手工构造，证据是方向性的而非结论性的；但"主场强 → kix 形状弱"的
一致性和 Part A 的基线方向吻合。）

---

## 附录 D：标注与训练脚手架（已建，端到端跑通）

代码在 [`laya-guard/`](../laya-guard/README.md)。五个阶段：`state_builder.py` → `label.py emit` →
教师 → `label.py ingest` → `build_dataset.py` → `validate.py`（5 道 gate）。

### D1. 为什么必须自己造标注：零样本下限（n=1060，kix 原生题面）

把**预训练** `typed-decisions` 直接跑在我们的 kix 题面上：

| 题 | 熵 | argmax | 占比 |
|---|---|---|---|
| needs_observer | 0.69 | false | 78% |
| evidential_support | 1.37 | replayable_validated | 65% |
| risk | 1.33 | 2 | 86% |
| scope_drift | 0.68 | false | 68% |
| claim_overreach | 0.67 | false | 89% |

**关键：它对 kix 信号完全无感。**

| 分层 | P(needs_observer=true) |
|---|---|
| edits>0 且改动后未重跑 | **0.458** |
| edits>0 且改动后重跑过 | **0.464** |
| irreversible>0 | 0.463 |
| 无独立观察者 | 0.464 |

四层全部落在 0.46——**gap 0.006，等于零**，而且它还在 65% 的情况下宣称 `replayable_validated`，
哪怕改动后一次都没重跑。附录 C 的"state 形状敏感"在这里到达极端：**换题面 + 换 state = 完全不工作。**

⇒ 这是微调必须做的量化理由，也是微调必须超过的下限。

### D2. state_builder 的一个实测 bug（已修）

`guard_denials` 原本用朴素关键词 `denied|blocked|refused|forbidden|not permitted` 匹配 tool result，
命中 **627/1060 (59%)**。抽样核查发现几乎全是误报：读到源码里的 `errors.New("forbidden resolver")`、
注释 "blocked on a full queue"、DNS 的 `REFUSED`、以及 DSH 提示词本身。
改为「**必须 isError 且命中沙箱/权限标记**」后：**627 → 1**。

### D3. 端到端演示（12 条分层样本，3 样本/条）

```
state_builder → 1060 states (state_version 1.0.0)
  → emit 6 prompts, 6 教师 → ingest 12 labeled (60 decisions)
  → build kix_settlement.parquet (train 9 / test 3)
  → validate: 5/5 gates PASS
```

| gate | 结果 |
|---|---|
| structural | 0 题面失败；序列长度 305/519/868（max_len 1024） |
| distribution | 5 题无退化；熵 0.50–1.16 |
| agreement | argmax 一致率 86–94%；到共识的 TV 0.046–0.102 |
| coverage | 6 个分层全部非空 |
| **trainer_load** | **12 cases → 60 items，0 丢弃**，回放官方训练器取数路径 |

**教师确实在用信号**（这是脚手架要证明的事）：

| 状态 | 改动后重跑次数 | evidential_support argmax | risk 均值 |
|---|---|---|---|
| 4 条 | 0 | no_evidence | — |
| 1 条 | 7 | partially_validated | — |
| 3 条 | 15 / 26 / 45 | **replayable_validated** | — |
| irreversible>0 (n=4) | — | — | **2.41** |
| irreversible=0 (n=8) | — | — | **1.07** |

### D4. 未决 finding：`needs_observer` 在演示样本上不区分验证状态

演示样本里 P(needs_observer)：改动后未重跑 **0.715** vs 重跑过 **0.721**，**gap −0.005**。

**归因（重要）**：样本有混淆——重跑过的那几条恰好也是大改动、含不可逆动作的会话
（edits 43/46/32/34，irreversible 3/0/1/3）。所以教师把 `needs_observer` 读成了
"这件事是否重大"，而不是"证据是否不足"。**这未必是缺陷**（守卫本来就要一个整体的
"该不该看"判断，风险与证据由模型自己合成），但也**可能在代表性样本上仍不分离**。

**这条正是脚手架存在的意义**：gate 2/3 全绿也发现不了它，只有对照分层才暴露。

**下一步判据**：300 条代表性样本上重测 `needs_observer` 的分层 gap。
- 若仍 ≈ 0 → 题面需改写（把"证据是否足够支撑采信"从"事情是否重大"里剥出来）；
- 若是样本混淆所致 → 保留题面。
