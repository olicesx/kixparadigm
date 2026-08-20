# kixpower v3.9 旧包知识萃取（2026-07-28 快照）

> 来源：桌面 `kixpower-bundle/`（v3.9，2026-07-28）与工作区 kix-bundle（v5.7，2026-08）
> 逐文件 diff 后萃取的**独有增量**。大多数核心机制已被新版继承（见 `skills/kixpower/README.md`
> 版本表 + `skills/kixparadigm/AUDIT.md` 论文清单），本文件只记录两类内容：
> ① 旧包独有、仍有效、现行文档未收录的知识；② 已证伪、**不可直接复用**的旧值对照。

## 1. 论文证据点补全（AUDIT.md §4 缺失的数据点）

| 数据点 | 来源 | 用途 |
|---|---|---|
| 拓扑自适应 vs 固定 hierarchical：**+12-23% 准确率**（SWE-bench） | AdaptOrch 2602.16873 | 拓扑路由收益依据 |
| **L2 Verification 去掉 → -5.5pp**（ablation） | AdaptOrch | L2 gate 必要性量化 |
| **单 agent ~4x / 多 agent ~15x** 标准会话 token 消耗 | AdaptOrch 实测 | per-run 预算依据（窗口 25%） |
| **EvoClaw：isolated 80% → continuous 38%（-42pp）** | End of SE 2606.05608 | Cross-Sprint Drift 检测必要性 |
| **固定 hierarchical 仅 14% 任务最优；hybrid 62%、parallel 24%** | AdaptOrch SWE-bench | 拓扑默认应选 hybrid（49.7% 任务） |

## 2. L3 事件驱动循环（旧版完整设计 → 新版降级 degraded-local）

### 2.1 设计要点（概念仍有效，部署细节以新版模板为准）

- 触发场景：`pull_request`（opened/synchronize/reopened）→ `/kixpower-review <N>`；
  `push` main → `/kixpower-continue`；`cron '0 */6 * * *'` → 恢复 stalled Sprint
  （progress.md `last_updated` 超 24h 判定）
- 价值定位：把「用户记得跑」变成「系统自动跑」，理想情况 3 次主动操作/Sprint → 0 次
- 部署：runner 无法访问本地 `~/.copilot`，kixpower 配置必须 commit 到仓库
  `.github/kixpower/{agents,skills,hooks,scripts,templates}`；Secrets 配 `GH_TOKEN`
  （至少 `repo` + `workflow` 权限）
- 每个 job **必须设 `timeout-minutes` 防 token 失控**：PR review 15 / Sprint continue 30 /
  stalled recovery 10
- 失败处理：job 失败 → 写 `docs/sprint-N/blocked-by-ci.md` 等人工；不在 main 直接 commit；
  L3 不工作即回退本地 `/kixpower-*`（L1+L2 完整可用）——L3 是增量增强，不是必需

### 2.2 演进教训（跨项目适用）

> **2026-08-15 落地进展**：档 A（stalled 检测）已在 DSH 落地为 kixst 动态插件——命令形态
> `/kixst-check|enable|disable` + frontmatter 持久化 + 惰性定时器 + workflow preflight 融入，
> E2E 验证通过（详见 `dsh-capability-map.md` §6）。L3 从「GitHub Actions 上不可行的设计」
> 变成「DSH 上可选启用的本地能力」。

- 旧版把「从 GitHub Actions 调 Copilot CLI/API」写成**已实现 v3.4**，实际从未验证可用
  （CLI 在 runner 上受限、API endpoint 是猜测、适配层三选一是占位）
- 新版 v5.7 显式降级为 `degraded-local`：workflow 只做能力报告（result `NOT_TRIGGERED`），
  不调用 Copilot、不改 Sprint 文件、不创建 Issue/Review；升级 `enabled` 需项目级 adapter
  合同（版本固定 / 权限最小化 / 无用户确认不发布 Review / dry-run 证明副作用清单）
- 教训：**未验证的集成不能以「已实现」姿态文档化**；功能状态必须显式标注
  （enabled / degraded-local / unsupported），只承诺验证过的副作用。与
  `ai-agent-practices.md` 证据门禁同源——那里管审查断言，这里管文档承诺

## 3. 已证伪 / 反过拟合对照（旧包内容，不可直接复用）

| 旧值 (v3.9) | 问题 | 现行 (v5.x) |
|---|---|---|
| max_parallelism=5（论文均值 ω=3.4 + Anthropic 5 parallel） | 论文 benchmark 均值静态化为全局常数（因果倒置） | 由 dag.ω 实时派生，`min(user, dag.ω, 8)`，冷启动回退项目历史均值/3 |
| commit budget 固定 5 次/会话 | 派生值当输入常量，被用满后临时解锁 | `δ(dag_layers) + strong_coupling + bug_reserve` 派生，hard cap 10 |
| token 硬上限 850K / per-run 200K | 硬编码绝对值，不随模型窗口伸缩 | 窗口百分比：会话 88% / per-run 25%（v3.7 起） |
| L3「已实现」 | 未验证承诺 | `degraded-local` 状态合同（见 §2.2） |
| synthesis `γ_step=0.2` × cap 5 | 凑数关系（0.2×5=1.0），无实证 | v5.0 已标注待改 `f(CS_history)` + 连续 2 轮无改善动态终止 |

> 复用旧包/旧版本文档时先查此表：命中「问题」列的取值方式，就是记忆
> `ai-agent-practices.md`「因果倒置检测」与「引用论文的过拟合陷阱」的实操案例。

## 4. 仍有效的旧版细节（现行文档仅部分保留）

- **工具并行化 token 估算方法**（v3.8）：8 场景（模式 0 探索 / L2 gates / Observe /
  runtime-context / Drift check / PR 审查多维度 / L4 模式识别 / QA Issue 提交）从串行改并行，
  每 Sprint 节省 ~37K tokens（约 4% 窗口）。估算口径：串行 N 轮往返 tokens vs 并行 1 轮
- **引导式访谈 UX**：初始化信息收集**一次只问 1-2 个问题**，不全部抛出；模式 0（已有代码）
  则自动并行探索、不提问，先出结构化分析报告再确认
