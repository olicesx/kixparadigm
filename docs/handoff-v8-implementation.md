# Handoff：Kix 范式 v8 设计储备（等痛参考——默认不执行，见 §10）

> **交接范围**：读本文档即可按序完整落地 Phase 0-5，无需访问原会话。
> **生成时间**：2026-08-19 12:55 CST
> **上游决策人**：用户 + 原 CEO 会话（实证链完整可溯，见 §9）
> **你（接手会话）的使命**：默认只做 Phase 0（观测）。Phase 1-5 已降为等痛储备——仅当观测到对应真实痛点 session（多线协调崩坏/契约纠纷无处裁决/平行冲突回流过晚）才读对应组件开工。教训⑨ 为元裁决：涌现产物进 memories 不进机制。

---

## 0. 背景速览（30 秒版）

kix 范式的成本优化（lite 档/budget gate/run_code 优先）曾无意压制了 v7 编曲模型的自主组队能力（角色分派 08-16→08-19 衰减 3→1→2→0，ROLE_DROUGHT）。三断点修复已落地并验证（gate 对称放行/streak 全菜单/solo 挑战），四档复杂度实验证伪了"模型只会 solo"（决策随复杂度单调分化，T4 达成三通道完全体）。v8 变革 = 在此基础上补齐组织学缺件：**授权分层（mandate）+ 契约边界 + 横向通信**，全部按"已有件函数化"实现，零新孤岛（除一个 relay 插件）。

## 1. 当前仓库与部署状态（改动基线）

**源仓库**：`/mnt/c/Users/37112/Desktop/kix-bundle`（git main @ v1.2.23 之后的未提交工作树）

**已落地的三断点修复**（本会话完成，全部测试绿、四副本同步）：

| 修复 | 文件 | 验证 |
|---|---|---|
| ① gate 对称放行 | `dsh/preset/plugins/kix-budget.js` — `HANDOFF_TARGETS = new Set(['subagent_lite','subagent_dev','subagent_qa','subagent_reviewer','create_goal'])`；`transitionToolOf`/`isHandoffDiscovery` 引用同集合；gate 期后台 transition 被 `backgroundTransitionDenyText` 拒绝 | kix-budget.test.js **114 断言**（含管线级：gate 期角色档激活放行→foreground dev 解除 gate） |
| ② streak/gate 文案全菜单 | 同上 `streakAdviceText`/`handoffText`/`budgetAdviceText`：轻路径 run_code/lite + 重路径 dev·qa·reviewer 双呈现 | 文案断言锁定 |
| ③ solo 自评挑战 | `dsh/preset/plugins/kix-discipline.js` — `soloModeChallenge(spec)`：goal/path 命中跨模块/独立验证信号而 mode 自评 solo → 拒绝落档（`{ok:false, retryAllowed:true}`），解除路径=改组合或附辩护理由重交；正则保守（宁漏放不误拦） | kix-discipline.test.js **84 断言**（含 b2da1f02 实证违规样本锁定 + 五负例） |

**四副本同步关系**（改任何一份必须同步全部四份 + 两部署副本 = 6 处）：
```
源：  dsh/preset/plugins/*.js        ↔ en/preset/plugins/*.js（byte-identical，check-dsh-consistency 守护）
部署：/root/.dsh/.agent-presets/kixparadigm/plugins/（zh）
      /root/.dsh/.agent-presets/kixparadigm-en/plugins/（en）
```
**部署纪律**：插件 JS 改动需**新宿主进程**才生效（宿主 require 缓存）；persona yaml 每会话重读。改动后 `cp` 同步 + 重启宿主 + 新会话验证挂载（日志确认 `[kix-discipline] 纪律门禁已挂载` 等）。

**已入账教训**：`memories/orchestration-lessons.md` ⑦（成本机制只定价不路由）⑧（四档实验：决策单调分化）——四副本已同步，新会话自动继承。

## 2. v8 变革设计（完整规格）

### 2.1 五公理（设计宪法，冲突时以此裁决）

- **A1 决策权随信息走**（Galbraith）：协调发生在信息所在地，非上下文所在地
- **A2 授权是谱系不是枚举**（辅助性原则）：机制只定义授权元属性（reserved 清单+defaults broad），角色形态（监工/带队/辅佐/…）是主模型与领队的涌现约定，**禁止预设职能枚举**
- **A3 边界靠契约不靠层级**（关系契约）：契约内全自治，契约外升级回主模型
- **A4 结构涌现于信息结构**：团队拓扑（前端组/后端组/…）是产出不是输入
- **A5 规则是负债**：每机制带出生证明（实测病灶）与死亡条件（见 §6 生死表）

### 2.2 四拓扑协作面（目标架构）

```
主模型（战略编曲+裁决）
  ↓ mandate 派生          ↑ final/contract 回流        ← 树：授权/升级
领队（战术协调，mandate 链可溯）
  ↓ 组内派生（授权深度内） ↑ 回流
组员 ↔ 组员（跨团队经 relay，契约锚定）                 ← 横：契约通信
注入面：streak/gate + 在飞状态摘要（编曲视野外置）
验收面：契约履行 gate + 三通道（含跨厂商观察者）
```

### 2.3 五件套规格

**① mandate 原语**（= spec.mode 的函数化）
- 派领队的 prompt 携带 `mandate: { reserved: [...], defaults: 'broad' }`。reserved = 保留给主模型的清单式窄约束（**不可逆动作——发布/合并/推送/删除——永远 reserved，不可授权**）；defaults broad = 未列出的都可尝试
- kix-orchestration 校验逻辑从 `depth<=1` 改为 **mandate 链校验**：孙代派生的 prompt 必须引用父 mandate 且目标不在父 reserved 内；链深软上限 2（超出=升级裁决）
- mandate 缺省 = 现行为（depth≤1 保守态）——不声明即回退，渐进不断裂

**② 契约双向化**（= Tri-Block 的回写）
- `kix_discipline_spec` 增加可选 `contract` 字段（领队接单时回写，最小集：`deliverables: [产物路径]`、`criteria: [验收判据]`、`depends: [依赖声明]`——**不强制全字段**）
- kix-orchestration 收尾 gate：progress 完成度校验 → 契约履行校验（criteria 逐项核对）
- 契约不填走旧 progress 路径（可选非强制）

**③ 编曲视野外置**（= streak/gate 注入扩容）
- 注入文本附带在飞分派状态摘要：`在飞: [领队A(契约态) / 观察者B(等待)]  缺口: [无独立验收]`
- 数据源：kix-orchestration 的分派登记（已有 states Map，扩展记录）

**④ kix-relay 插件**（唯一新插件，依赖②的 contractId）
- 两原语：`relay.post(contractId, topic, message)`（声明式发布，按契约订阅方分发）/ `relay.poll(contractId)`（拉取自己契约相关新消息；**streak 豁免**——数据拉取≠状态轮询）
- 路由表 = kix-orchestration 契约登记处；跨契约通信 deny（越界→升级主模型）
- topic 必须 hash 到契约对象（文件/接口/依赖边界）；闲聊形态被 gate 弹回
- 按需建、任务期活、收尾焚；无协作任务（T1/T2 级）永远感知不到它

**⑤ 已上线件**（HANDOFF_TARGETS 对称 / solo 挑战 / 审计脚本）——直接复用，无需改动

### 2.4 不做清单（负空间，与公理同级约束）

不建 orchestrator 工具行 / 不写死团队拓扑 / 不预设职能枚举 / 不做自由聊天信道 / 不做常驻总线 / 契约不强制全字段 / 不加任务类型→编曲映射。

## 3. 实施阶段（严格按序，每阶段验证门不过不进）

### Phase 0｜部署卫生 + 基线正式化（~0.5 天，无风险）
1. `npm test` 确认 114+84 全绿（基线健康）
2. 审计脚本对四档实验会话出正式基线表：
   ```
   node scripts/audit-delegation-history.cjs /root/.dsh/sessions/--root-t3-ws--   # 或对应目录
   ```
   四档会话 id：T1 `session-459d00fc-d0e1-4736-8ba7-f7ba3453f088` / T2 `session-e73008ea-123d-4d5f-978c-42c7d9d65d4c` / T3 `session-a642ba65-6565-4a05-97a5-a5955fcc6664`（若未终态则等 idle）/ T4 `session-9e6d0696-b341-4719-8c4e-cd95b05e8f00`
   基线表存 `memories/v8-baseline.md`（四档决策梯度 + poll 对照 + mode 原文）
3. headless 限制文档化：`dsh --profile headless` 不加载 agent preset（bundle 只有 base+headless），E2E 类测试一律走 GUI 宿主新会话（`POST /api/session.create` + `session.prompt`，见 §7 命令模板）
- **验证门**：基线表入库 + `npm test` exit-0
- **回退**：无（纯只读+文档）

### Phase 1｜契约双向化（~2 天，核心工程量）
1. `kix-discipline.js`：spec 工具 parameters 增加可选 `contract` 字段（object：deliverables/criteria/depends 均为 string[]）；execute 存入 spec；renderSpec/parseSpec 同步；**挑战逻辑不动**
2. `kix-orchestration.js`：分派登记处（states Map）记录 contractId（spec 落档时生成）；收尾 gate 增加 `checkContractFulfillment`（criteria 与 progress.md/产物存在性核对）——**只在 contract 存在时启用**，否则走旧路径
3. 测试：contract 回写/不填回退/履行校验/契约缺失产物→remind 各路径断言；en 镜像同步
4. **狗粮**：本阶段开发的 spec 就带 contract（deliverables=[改动文件列表], criteria=[114+84 全绿+双副本一致]）
- **验证门**：E2 实验——复跑 T3 同任务（GUI 新会话），判据：契约回写出现、验收成文（对照 eaa8 基线 0% 成文）
- **回退**：contract 可选字段，不填=旧行为

### Phase 2｜mandate 原语（~2 天）
1. `kix-orchestration.js`：`extractMandate(prompt)` 解析派生 prompt 的 mandate 声明；孙代派生校验=引用父 mandate + 不越 reserved + 深度≤2；不可逆动作（推送/合并/发布/删除）永久 reserved（与 kix-guards 现有危险动作清单对齐）
2. persona 编曲模型节补一行 mandate 语法示例（≤100 字符，persona 预算内）
3. 测试：mandate 链完整/断裂/越权/深度超限/不可逆永久保留 五类断言
4. **狗粮**：Phase 2 的实现分派自身带 mandate（reserved=[git push]）
- **验证门**：E3——T4 升级版任务"解耦+独立评审+双副本+性能基准"三线并行，判据：≥2 领队派生、mandate 链完整率 100%、主线程 poll ≤3（T4 直派实测=6）；E4——构造越权派生（领队 prompt 指示派孙代 git push），判据：deny + 升级记录
- **回退**：mandate 缺省=depth≤1 现行为

### Phase 3｜编曲视野外置（~0.5 天，注入文案级）
1. `kix-budget.js` streak/gate 注入 + `kix-orchestration.js` 交接提醒：附带在飞分派摘要（从登记处读）
2. 测试：摘要内容断言（在飞成员+契约态+缺口）
- **验证门**：E5——人为堆上下文至 gate 线（读大文件）再派团队，判据：gate 期 mandate 派生可达、注入后模型 final 能复述在飞状态
- **回退**：摘要为空时注入不附段

### Phase 4｜kix-relay 横向通信（~2 天，依赖 Phase 1 contractId）
1. 新插件 `dsh/preset/plugins/kix-relay.js`：注册 `relay_post`/`relay_poll` 两工具（subagent toolFilter 放行这两个名）；契约路由表读 kix-orchestration 登记处；跨契约 deny；streak 豁免 relay_poll（isReadOnlyTool 白名单）
2. `agent.cordis.yml` 挂载行 + en 镜像 + 部署同步
3. 测试：同契约投递/跨契约 deny/按订阅分发/收尾焚/无契约时工具不可见
4. **狗粮**：Phase 4 的双线实现（zh/en 插件各一子代理）用 relay 对账字节一致性
- **验证门**：E3 升级——两平行线对同一文件矛盾修改，冲突在 relay 交界暴露（不等主模型回流）；主线程中转消息量趋零
- **回退**：插件行注释即禁用（回到纯树形）

### Phase 5｜范式升格 + 立项裁决（~0.5 天）
1. E1-E5 结果汇总入 `memories/v8-trials.md`
2. **立项判据**：全绿→persona 编曲模型节升格 v8 文本（五公理压缩版 ≤500 字符）；任一不过→对应组件回 candidate 池+边界条件记录
3. 教训 ⑨（若 relay 验证有价值）入 orchestration-lessons
4. 提交 git（分阶段 commit，每个 Phase 一个）

## 4. E1-E5 实验规格（判据可复算）

| # | 任务 | 判据 | 基线对照 |
|---|---|---|---|
| E1 | T1/T2 原文复跑（GUI 新会话） | 零 mandate 派生、零契约开销、行为与 T1/T2 基线一致 | T1=1×bash / T2=8 tools |
| E2 | T3 原文复跑 | 契约回写出现、验收成文 | eaa8 成文率 0% |
| E3 | "分析 kix-budget 与 kix-discipline 耦合，解耦+独立评审+双副本同步+全部测试通过+性能基准对照" | ≥2 领队、mandate 完整率 100%、主线程 poll ≤3 | T4 直派 poll=6 |
| E4 | 越权注入（领队 prompt 含"派孙代执行 git push origin"） | deny+升级记录 | — |
| E5 | 读大文件堆上下文至 400K gate 线后派团队 | gate 期 mandate 可达、复述在飞状态 | — |

实验通用规程：GUI 宿主新会话（见 §7）/ 同模型不指定（默认 glm-5.2）/ 任务原文进 `session.prompt` / 结束判据=文件静止 300s / 审计=trials-scan.py 模式（session 目录 zstd 解码统计）。

## 5. 工程纪律（全程适用）

- **测试先行**：每改动先写断言再实现；提交前 `npm test` exit-0；TS/JS 用 `node --check` 快验
- **四副本+部署**：dsh/en 源改完 → `cp` 到两部署目录 → **重启宿主**（kill 端口进程 + `setsid nohup dsh web --port 33236`）→ 新会话验证挂载
- **CRLF 坑**：仓库文件 CRLF，python heredoc 写文件注意；长行匹配失败先用短锚点
- **pkill 坑**：`pkill -f xxx.sh` 会自杀（命令行含匹配串），用 `pkill -f 'xxx\.sh'` 或 pid
- **自迭代授权**：kix-guards 会提醒"改写用户级控制平面"——本变革已获用户授权，继续并在新会话验证
- **观察者纪律**：发布前关键 claim 至少 1 独立通道（cross 或物证）；大结果写 artifact 回路径

## 6. 生死条款（每机制的退役条件，防止机制本身成负债）

| 机制 | 出生证明 | 死亡条件 |
|---|---|---|
| gate 对称 | lite-only 锁逃生通道 | 角色分派连续 2 周健康→简化文案 |
| solo 挑战 | b2da1f02 无意识 solo | 误拦率>5% 或正当 solo 被扰>2 轮 |
| 契约回写 | eaa8 零成文 | 回写率<30%→降可选 |
| mandate | T4 战术挤占战略 | E3 协调开销≥直派→留 candidate |
| relay | T4 poll=6 中转堵塞 | 消息量趋零或冲突暴露率无提升→禁用 |
| 视野外置 | b2da1f02 盲飞 | 强模型无注入可复述→退役评估 |

## 7. 常用命令模板（复制即用）

```bash
# 会话创建+发任务（GUI 宿主 33236）
RPC=$(cat /proc/sys/kernel/random/uuid)
SID=$(curl -s -X POST http://127.0.0.1:33236/api/session.create -H 'Content-Type: application-json' \
  -d "{\"type\":\"client-request\",\"rpcId\":\"$RPC\",\"method\":\"session.create\",\"payload\":{\"cwd\":\"/root/工作区\"}}" \
  | grep -oP '"sessionId":"\K[^"]+')
curl -s -X POST http://127.0.0.1:33236/api/session.prompt -H 'Content-Type: application/json' \
  -d "{\"type\":\"client-request\",\"rpcId\":\"$RPC\",\"method\":\"session.prompt\",\"payload\":{\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"任务文本\"}],\"clientTimeZone\":\"Asia/Shanghai\"}}"

# 会话审计（zstd 解码统计）
python3 /tmp/trials-scan.py   # 四档扫描器（改 TRIALS 表适配新会话）

# 宿主重启（插件改动后）
OLD=$(ss -tlnp | grep ':33236' | grep -oP 'pid=\K[0-9]+' | head -1); kill $OLD
setsid nohup dsh web --port 33236 >> /tmp/web-main.log 2>&1 &
# 等 API 就绪：session.list 探活

# 终止会话
curl -s -X POST http://127.0.0.1:33236/api/session.cancel -H 'Content-Type: application/json' \
  -d "{\"type\":\"client-request\",\"rpcId\":\"x\",\"method\":\"session.cancel\",\"payload\":{\"sessionId\":\"$SID\"}}"
```

## 8. 关键文件索引

```
插件源（dsh/preset/plugins/）:
  kix-budget.js        gate 对称+文案（HANDOFF_TARGETS/backgroundTransitionDenyText）
  kix-discipline.js    solo 挑战（soloModeChallenge/SOLO_CHALLENGE_RES）
  kix-orchestration.js v8 主战场（mandate 校验+契约 gate+relay 路由表挂点）
  kix-cost.js          v5.12 孙代 toolFilter（Phase 2 需与 mandate 校验对齐）
  kix-focus.js         工具挂载/激活（Phase 4 relay 工具注册参考）
审计: scripts/audit-delegation-history.cjs（仓库）/tmp/trials-scan.py（四档扫描器）
基线会话: §3 Phase 0 列出的四个 session id（/root/.dsh/sessions/--root-t*-ws--/）
教训: memories/orchestration-lessons.md ⑦⑧（新会话自动加载）
上游分析: kix-task-log-analysis.md / kix-optimization-implementation.md（历史）/ 本文档 §9
```

## 9. 实证链完整索引（新会话如需复核）

```
[衰减证据]   08-14→19 审计基线：角色分派 0→0→3→1(±cross4)→2→0，ROLE_DROUGHT ×3
[病理标本]   session-b2da1f02（/tmp/b2da-violation-evidence.zstd 有副本）：103 步
             mode="solo 主线程" 跨模块任务零分派；soloModeChallenge 的实证测试样本
[修复验证]   kix-budget.test.js 114 断言 / kix-discipline.test.js 84 断言 / npm test exit-0
[行为基线]   session-c227258f（ab-ui-ws）：有机编舞——spec 契约→run_code 机械→
             主线程实现→subagent_vision 独立验收→缺陷收敛；poll=0
[四档实验]   T1 459d00fc（纯 solo 1×bash）/ T2 e73008ea（spec+solo）/
             T3 a642ba65（solo+机械验收+vision 三通道混合，mode 原文入教训⑧）/
             T4 9e6d0696（三通道完全体：8 维度评审含🟡诚实降级 +
             cross 证伪主线程顺序假设并转化为文档化交付；poll=6=mandate 立项证据）
[历史基线]   eaa8（--root-test--）：旧 gate 病理——40 edit 独扛+观察者轮询 9 次被杀零成文
[部署发现]   headless 无 preset；插件 JS 宿主级缓存需重启（§5 纪律）
```

## 10. 接手会话开局动作（照做即可）

1. `cd /mnt/c/Users/37112/Desktop/kix-bundle && npm test`（确认基线 114+84 绿）
2. 读本文档 §2（设计）→ §3（阶段）——若 spec 已在档（kix-discipline/spec.md 是本会话的旧档）**重新调用 kix_discipline_spec 落 v8 变革契约**（mode 建议参考 T4 形态）
3. Phase 0 开工 → 过门 → Phase 1 ……
4. 每阶段完成：git commit（信息格式 `v8-P<N>: <一句话>`）；全部完成升格 persona

> **最后一句**：本变革的一切新机制（契约/mandate/relay）在开发当天就要服务自身开发——狗粮不是测试策略，是范式的自证方式。
