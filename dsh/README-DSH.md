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
- `plugins/` — kix-guards / kix-cost / kix-route / kix-commands / kix-stalled（默认启用、candidate keep）+ 测试

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

### 常驻承诺与死亡条款的结算工具（只读，非门禁）

```bash
node scripts/audit-selection-pressure-history.cjs --check     # registry 门禁：每条常驻承诺的承载物内容必须命中
node scripts/audit-selection-pressure-history.cjs --deaths    # 死亡条款计数：7 通道 depth-0 调用数 + 首末日期
node scripts/audit-selection-pressure-history.cjs --deaths --limit=200 --json
```

- `--deaths` 默认扫 `$KIX_SESSION_ROOTS`（`path.delimiter` 分隔）或 `~/.dsh/sessions` + WSL 下各 Windows 用户家目录的 `.dsh/sessions`；跨项目、无时间窗，**零调用只标候选不自动判死**——「连续一个月」仍需按 `first-seen`/`last-seen` 人工判断。
- 会话库可能很大（实测 800MB+ / 1.4k 文件），全量扫描约 1–2 分钟；用 `--limit=N` 抽样或传显式根缩小范围。
