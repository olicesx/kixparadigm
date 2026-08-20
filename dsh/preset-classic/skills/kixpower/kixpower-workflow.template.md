# kixpower × DSH workflow 团队编排模板（P2-10 + P2-11 落地）

> 把 kixpower CEO 团队编排（Producer → Dev → QA）从「手动多次 subagent 分派」升级为
> **DSH `workflow` 工具的单次脚本编排**。同时落地验证 gate schema 化（P2-10）：
> QA 阶段用 `agent(prompt, { schema })` 机械强制验证报告结构，不再依赖自觉。
>
> 适用：跨模块/大改动的有界扇出任务。**长目标/跨轮次自动推进仍用 `goal`**；
> 一两个委派仍用普通 `subagent`（workflow 使用门禁在系统提示词里，勿滥用）。

## Preflight：stalled 门禁（L3 档 A，2026-08-15 融入，减法版）

> 启动编排前必须先确认 Sprint 未停滞——**检测机械、决策人做**：
> 机械检测用 `/kixst-check <项目根>`（零 token 原生命令，只读），
> 是否恢复由用户决定（`/kixpower-continue <N>`），检测器不越权。

1. 运行 `/kixst-check <项目根>`（或模型工具 `kix_stalled_check`）。
2. `stalled > 0` → 先 `/kixpower-continue <N>` 恢复该 Sprint，**再**进入本编排；
   带着 stalled 的 plan 进入实现阶段 = 在过期上下文上叠新工作。
3. `stalled == 0` → 进入正常流程。
4. 定时检测形态（enable/disable 命令 + 惰性定时器 + 提醒注入）已做减法
   （见 `memories/dsh-capability-map.md` §6.4）：无真实项目证据前不常驻、不自动提醒；
   需要时从原型历史恢复。
5. 脚本内无法机械检测（workflow 无 fs/命令能力，见「边界」）→ 脚本层用 Producer
   检查句双保险（见下），机械层由 `/kixst-check` 承担。

## 与手动分派的差异（为什么值得用）

| 维度 | 手动 subagent 分派 | workflow 脚本 |
|---|---|---|
| 编排 | 模型逐轮调用，上下文里累积分派簿记 | 脚本一次跑完，中间值不进模型上下文 |
| 失败纪律 | 依赖模型自觉处理失败 | **fatal 错误总逸出**（契约违反/超上限绝不降级为逐项 null）；子 agent 普通失败返回 null 交脚本处理 |
| 验证 gate | 提示词约定「请输出结构化报告」 | **`opts.schema` 机械强制**：不合法即拒绝，结果对象保证形状 |
| 进度 | 无 | `phase()` / `log()` 叙述 |
| 边界 | — | 无 token 预算词汇、无恢复（重启不能续跑）→ 只做有界扇出 |

## 模板脚本（复制即用）

```js
// kixpower 团队编排 — Producer → Dev → QA（Tri-Block 分派）
// 使用前：把 [CONTEXT]/[TASK]/[CONSTRAINTS] 三段按任务填好；
// 角色 body 从 preset agents/kixpower-*.agent.md 读取注入。

const CONTEXT = `项目根：<绝对路径>。先读 <docs/xxx> 了解背景（写文件，勿塞进 prompt）。`
const TASK = `<任务目标，一句话>`
const CONSTRAINTS = `内容语言：<zh|en>。源码编辑用 edit/write 工具。改后全量 grep 引用。`

// 0) Preflight 双保险（脚本层无法机械检测 stalled，见「Preflight」节；此处由 Producer 模型侧确认）
//    Producer 启动前：读 docs/sprint-N/progress.md frontmatter，若 status 进行中且
//    last_updated 超 24h → 在产出中标记 blocked_reason="stalled"，不继续规划。

// 1) Producer 规划（发散阶段，最小规则）
const plan = await agent(
  `[CONTEXT]\n${CONTEXT}\n[TASK]\n${TASK}\n[CONSTRAINTS]\n${CONSTRAINTS}\n\n` +
  `你是 kixpower-producer（角色 body 见 agents/kixpower-producer.agent.md 的职责要点）。` +
  `启动前先读 docs/sprint-N/progress.md frontmatter：若进行中且 last_updated 超 24h（stalled），` +
  `返回 { verdict: 'stalled' } 终止规划（用户应先 /kixpower-continue 恢复）。` +
  `产出：PROJECT_BRIEF.md 与 plan.md（含 task DAG），把实现拆成独立可并行的任务列表返回。`,
  { label: 'producer', phase: '规划' }
)

// 2) Dev 实现（发散阶段；plan 为 null 时短路，fatal 已由引擎逸出）
if (!plan) throw new Error('producer 失败，终止编排（不进入实现阶段）')
const devTasks = /* 从 plan 提取任务数组，或由 producer 输出结构化 schema 保证 */ []

const devResults = await pipeline(
  devTasks,
  (task, _item, i) => agent(
    `[CONTEXT]\n${CONTEXT}\n[TASK]\n${TASK}\n[CONSTRAINTS]\n${CONSTRAINTS}\n\n` +
    `你是 kixpower-dev（角色要点见 agents/kixpower-dev.agent.md）。子任务 #${i}：${task}。` +
    `完成实现；返回：改动文件清单 + 自测结果 + 遗留问题。`,
    { label: `dev-${i}`, phase: '实现' }
  )
)

// 3) QA 验证（收敛阶段，schema 机械强制 = 验证 gate 落点）
const qaSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'evidence'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'source', 'method'],
        properties: {
          claim: { type: 'string' },
          source: { type: 'string' },
          method: { type: 'string', enum: ['read', 'grep', 'run', 'other'] }
        }
      }
    },
    blockers: { type: 'array', items: { type: 'string' } }
  }
}

const qa = await agent(
  `[CONTEXT]\n${CONTEXT}\n[TASK]\n${TASK}\n[CONSTRAINTS]\n${CONSTRAINTS}\n\n` +
  `你是 kixpower-qa（角色要点见 agents/kixpower-qa.agent.md）。` +
  `独立验证 dev 产出（不信任实现者自述）：逐条读代码/跑测试取证。` +
  `verdict 只允许 pass / fail / unknown；evidence 每条必须给出 claim + 可回放 source + 取证 method。` +
  `不通过时列出 blockers。`,
  { label: 'qa', phase: '验证', schema: qaSchema }
)

// 4) 汇总（回主线程仍是 claim，发布前需三通道确认 + 必要时 ask_user_question）
return {
  producerPlan: plan,
  devResults: devResults.filter(Boolean),
  qa
}
```

## schema 强制验证的纪律（P2-10）

- `agent(prompt, { schema })` 是**唯一**机械验证入口（subagent 工具无 schema 参数）。
- schema 只允许 `type/properties/required/additionalProperties/items/enum/const/oneOf`（无 pattern/format/数值边界）。
- **验证 agent（QA）必须挂 schema**；生产者（Producer/Dev）可以不挂（发散阶段最小规则，阶段二相性）。
- schema 校验失败 = 子 agent 失败（返回 null），不是截断重试——验证输出不合法就是不合格，交脚本处理。
- 发布前三问仍适用：测试镜像真实链路吗 / 证据维度对吗 / 关键 claim 独立验证过吗（并发 2 个异质子 agent 读代码，最高置信叠加跨厂商模型）。

## 边界与陷阱（workflow 引擎已知限制，如实声明）

1. **无恢复**：workflow 重启不能续跑，只做有界扇出；长目标用 `goal`。
2. **无 token 预算词汇**：prompt 自行控制在 ≤5K tokens，大量上下文写文件让子 agent 读。
3. **无嵌套 workflow**、不支持 timer/fs/Node 全局（脚本里只有 agent/pipeline/parallel/phase/log）。
4. **`pipeline` 无跨阶段屏障**：逐项传递；需要全部结果一起用 `parallel`（有屏障）。
5. **子 agent 失败返回 null**：`.filter(Boolean)` 后必须显式处理缺失项（记入汇总，不静默）。
6. **worker-thread 隔离是「API 塑形非安全边界」**：脚本与子 agent 仍受 sandbox + 门禁约束；run_code 内分派同理。

## 与 /kixpower-* 流程的关系

- 本模板是**脚本化替代路径**，不替代 prompts/kixpower-*.prompt.md 的完整流程（访谈/文档/DAG/QA 门禁细节）。
- 适合：任务边界清晰、可枚举子任务、需要并行实现 + 机械验证的中型改动。
- 完整 Sprint 编排（访谈 → 脑暴 → DAG → 多轮 Dev/QA）仍走 kixpower 流程 + goal 续跑。
