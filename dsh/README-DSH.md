# kix-bundle × DeepSeek Harness — DSH 侧部署说明

> 本目录是 kix 范式在 DeepSeek Harness 中的**DSH 侧唯一事实源**。

## 一键导入（npm，推荐给使用者）

```bash
npm i -g kixparadigm     # 自动装默认模式 + 经典模式 + vision-bridge
```

v1.3.4 起安装器按 `package.json#kixparadigm.variants` 逐变体拷贝：

- `dsh/preset/` → `~/.dsh/.agent-presets/kixparadigm/`（默认激励面）
- `dsh/preset-classic/` → `~/.dsh/.agent-presets/kixparadigm-classic/`（经典模式）

`dsh/preset-null/` 是消融对照，不随 npm 安装。重启 `dsh web` 后在模式列表选择。安装器源码见 `scripts/install-lib.js`；日常维护仍用下方同步脚本。

```
kix-bundle/
├── (根目录 = VS Code Copilot 分发，原样保留)
└── dsh/
    ├── README-DSH.md        ← 本文件（DSH 安装/同步说明）
    ├── preset/              ← → ~/.dsh/.agent-presets/kixparadigm/（默认）
    ├── preset-classic/      ← → ~/.dsh/.agent-presets/kixparadigm-classic/（经典）
    └── preset-null/         ← 消融对照（不随 npm 安装）
```

## 唯一事实源声明（2026-08-15 归一）

- **`dsh/preset/` 是 DSH preset 的唯一事实源**。`~/.dsh/.agent-presets/kixparadigm/`
  只是它的安装副本；两处内容由 `scripts/sync-dsh-preset.ps1` 单向同步。
- 维护 preset = **改 `dsh/preset/` 里的文件**，然后跑同步脚本；不要在 `~/.dsh/` 里手改
  （改了也会被下次同步覆盖）。
- 根目录的 `skills/`、`agents/`、`prompts/`、`memories/` 是 **Copilot 分发版**
  （未带 DSH 适配注记），与 `dsh/preset/` 内的 DSH 版刻意不同——不要互相覆盖。

## 首次安装 / 重装

```powershell
# 全新安装或整体重装（覆盖目标）：
pwsh -File .\scripts\sync-dsh-preset.ps1 -Force
```

重装后需恢复的**预设外**改动（preset 装不进去，属 host/profile 层）：

1. **`~/.dsh/settings.yaml`**：`llm-pi-ai.providers` 需含 `zai-vision` profile
   （GLM-4.6V 视觉偏好，`api/coding/paas/v4` 订阅端点）与 `zai-coding-cn`（GLM 跨厂商候选）。
   v5.9 起路由由 kix-route 自动解析：cross/thinker 不依赖钉值（有任一异厂商
   provider 即可），vision 缺 `zai-vision` 时自动找其他声明 image 输入的模型。
2. **vision-bridge（UI 无缝发图）**：`~/.dsh/profiles/web/` 的 profile 插件，
   与 preset 无关。恢复：`pwsh -File .\scripts\ensure-vision-bridge.ps1`（幂等自检自愈，
   见根 README「无缝发图插件 dsh-vision-bridge」）。

## 日常同步

```powershell
.\scripts\sync-dsh-preset.ps1 -DryRun   # 预览差异
.\scripts\sync-dsh-preset.ps1           # 交互确认
.\scripts\sync-dsh-preset.ps1 -Force    # 全量同步
```

同步后**重启 DSH 进程**（Ctrl+C → `dsh web`）再开新会话，preset 才会重新组装。

## preset 内资产清单（dsh/preset/）

- `agent.cordis.yml` — 常驻认知层 persona + 工具/技能/门禁/命令/工作流组成
- `preset.yml` — roster 显示元数据（name/description）
- `skills/` — 目录指针 → `../preset-classic/skills`（kixparadigm / kixpower 等按需技能）
- `prompts/` — /kixpower-* 流程（kix-commands 插件注入用）
- `memories/` — 方法论记忆（目录清单为准；含 incentive-lessons）
- `plugins/` — kix-guards / kix-cost / kix-route / kix-commands / kix-stalled（默认启用、candidate keep）+ kix-webhook（默认 disabled，外部事件桥）+ 测试
- `patches/kix-webhook.reference.yml` — webhook 部署参考行（profile 侧 insert + 凭据 + 自测命令）

默认档根**不部署** `DSH-ADAPTATION.md`、`DSH-FUSION-MATRIX.md`、`instructions/`；`skills/` 与 `agents/` 在仓库里是指向 classic 的指针，安装时物化为真目录（保证货架内 `../../agents/*.agent.md` 等相对链接可达）。权威机制映射在 [`preset-classic/DSH-ADAPTATION.md`](preset-classic/DSH-ADAPTATION.md) 与 [`preset-classic/DSH-FUSION-MATRIX.md`](preset-classic/DSH-FUSION-MATRIX.md)。

## 验证

```powershell
npm test                                        # 一致性守护 + 全插件回归（zh）
node scripts\check-dsh-consistency.cjs          # persona 预算 / distribution mirrors / zh-en 插件一致性
node --test dsh\vision-bridge\test.js           # vision-bridge 纯逻辑回归
(cd dsh\preset\plugins; node --test)           # 全部插件测试（Node 20+ 自动发现；
                                                #   单文件仍可 node .\dsh\preset\plugins\<name>.test.js 直跑）
```

preset 挂载校验（roster `standingKeyFor`）在 DSH 会话内用 cordis 工具集执行。

## DSH 0.1.2 原生能力对接（2026-09-09 实测）

本机安装 `0.1.1-rc.2`；npm latest = `0.1.2-rc.1`、alpha = `0.1.5-alpha.1`。隔离 DSH_HOME + 0.1.2-rc.1 实测：kix 预设零改动即可加载并跑通（system prompt 含 kixParadigm/三通道/需求三检，9 个 kix 机制工具全部注册）。三处对接：

| 能力 | 状态 | 落点 |
|---|---|---|
| `web_fetch`（宿主提供方 `dsh-web-fetch-http`） | 已落地 | 本预设 `tool-web.config.fetch: true`；0.1.1 无提供方时调用报错、不影响启动 |
| 子代理原生模型选型（`modelSelectionSettings`） | 已验证，未默认开 | 见下：需宿主设置命名空间 + 白名单，属部署决策 |
| webhook → kix 会话 | 已落地（默认 disabled） | `plugins/kix-webhook.js` + `patches/kix-webhook.reference.yml` |

### 子代理原生模型选型（为什么没有默认打开）

DSH 0.1.2 给 `dsh-tool-subagent` 加了 `modelSelectionSettings`（0.1.1 无此字段）：置 true 后，工具 schema 多出 `provider`/`model`/`reasoning_effort` 三个参数，子调用可显式选型；白名单来自宿主设置命名空间 `subagent-model-selection`（`enabled` + `allowedModels[]` 精确 provider/model 对），并把策略作为 `subagent/model-selection-policy` 投影事件记进会话。

**未默认开的两条机械理由**：①该行要求宿主已挂 `@deepseek-ai/dsh-tool-subagent/model-selection-settings`，缺失时**挂载即抛错**（不是降级），会让整个 preset 装不上；②白名单只认已注册 provider，本机 `zai-coding-cn` / `grok` 由部署 `settings.yaml` 提供，写死在预设里等于把预设绑到某台机器的模型目录。

**打开步骤**（部署侧，两处）：profile patch 里加 `@deepseek-ai/dsh-tool-subagent/model-selection-settings` 行；`$DSH_HOME/settings.yaml` 写：

```yaml
subagent-model-selection:
  enabled: true
  allowedModels:
    - provider: zai-coding-cn
      model: glm-5.3
    - provider: grok
      model: grok-4.5
```

然后把 `agent.cordis.yml` 的 `tool-subagent` 行加 `modelSelectionSettings: true`。**实测边界**（2026-09-09，隔离环境）：kix 预设 + 上述配置 → schema 出现三个参数、策略事件写入、`list_subagent_models` 返回白名单路由；`subagent` 工具本身被 kix-focus 的 `tools.restrict()` 裁剪（`unknown global tool "subagent"`），所以端到端调用要在未被 restrict 的档位（如 `subagent_lite`，或临时关掉 focus 裁剪）上验。**它替代不了 kix 分档**：`subagent_lite` 的独立 persona + toolFilter 裁剪（省固定开销）与模型选型是两件事。

### webhook → kix 会话（规则层常驻加载、config 默认关）

`ctx.webhookRuntime`（0.1.2 新增，唯一内置动作 = 在 Web Workspace 建 root Session）+ `@deepseek-ai/dsh-webhook-github`（HMAC 校验、202 不等规则）都不在默认组合里，属部署面。本仓提供规则层 `plugins/kix-webhook.js`（事件匹配 / 机器人忽略 / `maxSessions` fuse / prompt 插值）与参考行 `patches/kix-webhook.reference.yml`。预设里该行**不设 disabled**、以 `config.enabled: false` 常驻加载（未启用时 apply 直接返回，无注入无监听）。

两条实测结论（2026-09-09，隔离环境）：
- **profile 的 patch 覆盖不到 preset 组成里的行**。探针：`- id: kix-webhook` + config 写进 profile patch（预设侧 `enabled:false`）→ 插件仍以 `enabled:false` 加载；把同样内容写进预设文件 → 立即生效（规则注册、签名 POST 202 → 新建 `webhook-*` 会话，preset=kixparadigm，system prompt 含 kixParadigm/三通道）。所以开关要改预设文件，不能只改 profile patch——参考文件 §2 已按此写。
- **预设是 lazy mount**：首次有会话挂载它时插件才加载。冷启动后、任何会话之前到来的投递只回 202、不起会话（要「开机即接事件」就先挂一个会话）。

0.1.1 及更早无 `webhookRuntime`：`inject` 保持 pending，同样零副作用。外部可达性（公网入口）未验证，参考文件里写清了。

### 常驻承诺与死亡条款的结算工具（只读，非门禁）

```bash
node scripts/audit-selection-pressure-history.cjs --check     # registry 门禁：每条常驻承诺的承载物内容必须命中
node scripts/audit-selection-pressure-history.cjs --deaths    # 死亡条款计数：7 通道 depth-0 调用数 + 首末日期
node scripts/audit-selection-pressure-history.cjs --deaths --limit=200 --json
```

- `--deaths` 默认扫 `$KIX_SESSION_ROOTS`（`path.delimiter` 分隔）或 `~/.dsh/sessions` + WSL 下各 Windows 用户家目录的 `.dsh/sessions`；跨项目、无时间窗，**零调用只标候选不自动判死**——「连续一个月」仍需按 `first-seen`/`last-seen` 人工判断。
- 会话库可能很大（实测 800MB+ / 1.4k 文件），全量扫描约 1–2 分钟；用 `--limit=N` 抽样或传显式根缩小范围。
