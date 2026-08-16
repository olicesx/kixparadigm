# kix-bundle × DeepSeek Harness — DSH 侧部署说明

> 本目录是 kix 范式在 DeepSeek Harness 中的**DSH 侧唯一事实源**。

## 一键导入（npm，推荐给使用者）

```bash
npm i -g kixparadigm     # 自动装 preset + vision-bridge + 检查 settings.yaml
```

安装器源码见 `scripts/install-lib.js`；日常维护仍用下方同步脚本。

```
kix-bundle/
├── (根目录 = VS Code Copilot 分发，原样保留)
└── dsh/
    ├── README-DSH.md        ← 本文件（DSH 安装/同步说明）
    └── preset/              ← → ~/.dsh/.agent-presets/kixparadigm/ 的镜像（唯一事实源）
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
- `DSH-ADAPTATION.md` — **权威机制映射**（Copilot 工具名 → DSH、门禁等价物、团队分派、
  跨厂商、vision、PTC §9）；kix 原始文档冲突时以此为准
- `skills/`（17 个）— kixparadigm / kixpower / handoff / write-a-skill /
  improve-codebase-architecture + 12 个通用方法论（tdd/teach/grill-me/…）
- `agents/`（6 个）— kixpower 团队角色（subagent 分派时的 prompt 模板）
- `prompts/`（5 个）— /kixpower-* 流程（kix-commands 插件注入用）
- `instructions/` — 核心指令原件（persona 已内置同源内容）
- `memories/`（4 个）— 方法论记忆：ai-agent-practices / ai-test-pruning / kix-review-patterns / dsh-capability-map.md（kix×DSH 任务先查）；Copilot 语境记忆（vscode-copilot-customization / tech-patterns / kixpower-v39-legacy-notes）已移出（2026-08-17，规则是负债）
- `plugins/` — kix-guards.js（机械门禁监听器）+ kix-cost.js（成本纪律）+ kix-route.js（跨厂商路由）+ kix-commands.js（原生命令注册）+ kix-stalled.js（opt-in）+ 测试

## 验证

```powershell
npm test                                        # 一致性守护 + 全插件回归（zh）
node scripts\check-dsh-consistency.cjs          # persona 预算 / 文档计数 / zh-en 插件一致性
node --test dsh\vision-bridge\test.js           # vision-bridge 纯逻辑回归 6 用例
node scripts\run-plugin-tests.cjs               # 全部插件测试（自动发现 *.test.js，逐文件直跑：
                                                #   guards 219 / commands 6 / cost 28 / route 68 /
                                                #   discipline 68 / orchestration 77 / focus 102 组断言；
                                                #   单文件仍可 node .\dsh\preset\plugins\<name>.test.js 直跑）
```

preset 挂载校验（roster `standingKeyFor`）在 DSH 会话内用 cordis 工具集执行。
