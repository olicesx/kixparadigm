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

## DSH 0.2.0-rc.1 适配（2026-09-29 实测，preset 声明与模块解析根）

0.2.0-rc.1 把 agent preset 的**声明与解析契约**又改了一次：`.agent-presets/` 目录不再被扫描，
preset 由 profile 的 `cordis.patch.yml` 里一行 `@deepseek-ai/dsh-agent-preset` 声明，再用
`cordis:include` 指向 `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`。

| # | 变更 | 影响面 | 修法 |
|---|---|---|---|
| 1 | preset 必须声明才可见 | 目录扫描失效 | 安装器按 profile bundle 判定：含 `dsh-web-app` / `dsh-agent-preset-registry` 才写声明，headless 跳过 |
| 2 | `cordis:include` 把模块解析基准改到 preset 目录 | preset 内每条 `@deepseek-ai/*` 导入失败，registry 报整棵 `never started`（同目录相对 `./plugins/*.js` 正常） | 安装器在 preset 目录建 `node_modules` 符号链接，指向 `presetResolutionRoot()` 选出的那层；一层都选不出就抛错，不写声明 |
| 3 | `settings.yaml` 启动时导入 profile 并改名 `.imported` | doctor 在 0.2.0 上误报「未配置」 | doctor 同时检查根文件、`.imported` 与各 profile 的 `cordis.patch.yml`（**剔除 YAML 注释行**后再匹配 provider 名，否则安装器自己写的 bridge 注释会让门禁恒真） |

根的选法不是「第一个含 `dsh-persona` 的 `node_modules`」：npm 可能因版本冲突把 persona 嵌进
`@deepseek-ai/dsh/node_modules/`，那一层解析不到 preset 真正需要的其余 20+ 个包，选中它等于把
`never started` 原样搬回来。现行判据是**「解析不到的裸包名最少的那层胜出，同分取最近祖先」**，
必查集合由各 variant 的 `agent.cordis.yml` 里的 `@deepseek-ai/*` 字面量推导（不扫插件目录，
那里有测试夹具的假包名 `@deepseek-ai/definitely-not-installed-xyz`）。仍有缺包时**只告警不中止**
——缺的可能是该 DSH 版本本就没有的可选件，中止会让整个安装不可用；doctor 会把缺包名单列为失败项。

根因形态：上游把自带 preset 放在包内 `node_modules/@deepseek-ai/dsh-web-app/presets/`，裸包名天然可解析；
kix 的 preset 在 `$DSH_HOME` 下（树外）。差异来自**位置**，不是声明格式。

**三处 0.2.0 契约随 v1.3.18 收口**（2026-09-29 实测）：

| 契约 | 0.2.0 事实 | kix 落点 |
|---|---|---|
| roster 描述 | preset 由 profile patch 声明，registry **不再读 `preset.yml`**；描述只认 `config.description`（缺失时客户端渲染 `No description.`） | 安装器 `renderPresetPatchBlock()` 从各变体安装目录的 `preset.yml` 读 description 写进声明（单一事实源仍是 `preset.yml`） |
| `tools/change` 时序 | `layers.effect` 在 append 后**同步** emit `tools/change` | `kix-focus` 必须在 `restrict()` **之前**预登记 `denied`（否则同步重入看到 fresh 恒非空 → 无限递归，6330 帧栈爆 `RangeError`）；抛错回滚，失败名字留给定时重试 |
| `settings.yaml` 一次性导入 | boot 时把该文件**整份**导入当前 profile（`configEditor.update` 走 YAML AST 追加），行落在**尾注释之前 = kix 标记区内部**；导入后文件改名 `.imported` 不再被读 | 安装器只重写自有 `- insert:` 块：标记区内的顶层用户行原样移出（`splitMarkerRegion`），卸载路径同源；检测到即告警。**整段替换会吞掉用户配置**——2026-09-29 实测吞掉 `llm-pi-ai` 四 provider / `llm-deepseek` / `ui-theme` / `subagent-model-selection` 约 200 行，重启后模型列表清空；恢复 = `.imported` 复制回 `settings.yaml` 再重启 |

**配置恢复路径（runbook）**：`$DSH_HOME/settings.yaml` 被导入后改名 `settings.yaml.imported`，此后宿主只认 profile patch 里的行。若这些行被误删（例如安装器旧版整段替换），把 `.imported` 复制回 `settings.yaml` 并重启即可——boot 时的一次性导入会按 section id 逐条 upsert 回 profile patch（隔离 0.2.0 实例实测：8 个 section 全量还原，含 `llm-pi-ai` 四 provider、`llm-deepseek`、`ui-theme`、`subagent-model-selection`）。

**实测证据**（隔离 `DSH_HOME=/tmp/kix-dsh020-home` + `KIX_DSH_PREFIX=/tmp/kix-dsh020`，npm 平铺安装的 0.2.0-rc.1）：

- 修前 `agentPresets/list`：kix 两份各 26 行 `never started`，宿主 standard/ptc/minimal/cordis 四份干净。
- 加解析链接后同一接口：六份**全部无 `broken`**（该接口内部会跑 registry 的 `diagnostic()`）。
- 该实例上一轮真实模型回复：preset `kixparadigm`，system 9825 token / tools 6838 token，回复 `pong`，`toolMs=0`。
- 补丁锚点：压缩上限 1 处 + 会话 8 条 hunk 在 0.2.0-rc.1 上**全部 applied**，无 anchor miss；会话格式仍为 **V4**，未新增 v4 hunk。
- 正在运行的 0.1.5（`/usr/local/lib/dsh-0.1.5-rc.1`、`/root/.dsh`）全程未被修改。

回归门禁：`npm run test:installer`（已把 `scripts/dsh-runtime-resolve.test.js` 接进来）覆盖
`installPreset links preset resolution for a flat npm install`（断言从 preset 目录解析与从 dsh 包解析**等价**，
且 `resolutionMissing` 为空）与 `presetResolutionRoot 取能解析最多裸包的那层，不被内嵌 persona 骗到`。

en 包（`kixparadigm-en`）单独发布时 `__dirname/../..` 不指向本仓 `scripts/`，故
`dsh-runtime-resolve.js` / `patch-dsh-runtime.js` / `context-budget/kix-compaction-cap-patch.mjs`
必须随包同行，并由一致性门禁锁成字节相同；否则 0.2.0 上直接 `找不到压缩/会话补丁脚本` 拒绝安装。

## DSH 0.1.5-rc.1 适配（2026-09-11 实测，两处破坏性变更）

0.1.2-rc.1 下零改动可跑的 preset，在 0.1.5-rc.1 上**完全挂不上**：preset 挂载抛错 →
会话建不出来 → GUI composer 永久停在 inert（「选择一个工作区开始」），表现为「kix 范式无法使用」。
两个独立根因：

| # | 变更 | 影响面 | 修法 |
|---|---|---|---|
| 1 | `@deepseek-ai/dsh-persona` 配置从 `text`（必填）改为 `prefix`（必填）+ `suffix`，prompt section 拆成 `DEPLOYMENT_PERSONA_PREFIX` / `_SUFFIX` | 四份 preset 的每个 persona 行；挂载报 `invalid config: $.prefix missing required value` | persona 行改用 YAML 锚点，同时给出 `text` 与 `prefix`（同源，不复制文本）。schemastery 不拒绝未知键，故两版都能挂 |
| 2 | 子代理 `toolFilter.deny` 含 `subagent` → **每次派发 throw** | 四份 preset 共 32 处 tier deny 名单 | 移除 `subagent`。嵌套派发仍由 `kix-cost` 的 `tools.guard` + harness `maxDepth` 拒绝 |

**根因 2 的机制**：`dsh-subagent` 的 `applyChildComposition` 调
`childCtx.get("agentPresets")?.composeFrom(childCtx, parent.ctx)`，把父 preset 的组成挂进
**子代理自己的 layer**；`tools.view(scope).restrictableNames` 只含 inherited（全局 + 祖先，**不含
own layer**），所以 own-layer 的 `subagent` 不在可 restrict 名单里，
`restrict({deny:['subagent']})` 抛 `names unknown global tool "subagent"`。0.1.2 与 0.1.5 的
`view()` / `restrict()` 实现逐字节一致，这是两版共同的真缺陷——此前只在线上的安装副本手改过，
仓库没回填，重装即复发。

**实测证据**（隔离 `DSH_HOME` + `0.1.5-rc.1`，装入仓库产物）：

- preset 挂载成功，无报错；persona 文本进入会话 `system/message`
- 7 个 `kix_*` 工具注册（capability_search / capability_call / discipline_spec / signal_status / stalled_check / tool_activate / tool_deactivate）
- `kix_capability_search` 诊断：`restrict.applied=true`、`denyCount=52`、`error=null`；可见面 0 个 `mcp__` 工具
- 子代理派发 `subagent_lite` 成功：`echo kix-subagent-ok` 原样返回，exit 0，`autoActivated=true`
- 同一 preset 在 `0.1.2-rc.1` 隔离实例上同样列出 7 个 kix 工具（改动向后兼容）

## 会话历史可用性补丁（`scripts/patch-dsh-runtime.js`，2026-09-11）

**DSH 升级会替换整个 `node_modules`；装在安装副本里的补丁会被静默绕过。** 2026-09-10 手工打过的
5 处补丁（`dsh-session` / `dsh-session-persistence` / `dsh-api-session-controller` / `dsh-workspace`，
只存在于 `/usr/local/lib/dsh-0.1.2-rc.1/node_modules/...`）在 0.1.5 升级后全部失效——这就是
「历史会话打不开」的来源。因此本仓把补丁做成**幂等脚本**，升级后重跑一次：

```bash
node scripts/patch-dsh-runtime.js --check   # 自检：缺哪条 / 锚点是否漂移（缺失退出码 1）
node scripts/patch-dsh-runtime.js           # 应用缺失条目（幂等，逐条锚点唯一性断言）
systemctl restart dsh-web                   # Node 已缓存模块，必须重启才生效
```

`npm test` 内置 `test:runtime-patch`（11 断言）：**升级后没重跑补丁，它会失败**——那是信号不是噪音。

### 七条 hunk 修什么

| hunk | 包 | 作用 |
|---|---|---|
| `session-append-ignorable` | `dsh-session` | `Session.append(type, data, { ignorable: true })` 真正写进事件信封（旧实现只读 surface 字段，标记被丢弃） |
| `persistence-admit-legacy-plugin-events` | `dsh-session-persistence` | 当前格式（v3）读取路径接受白名单插件审计事件 |
| `v0/v1/v2-migration-admit-legacy-plugin-events` | `dsh-session-format-v0-to-v1` `-v1-to-v2` `-v2-to-v3` | 迁移链把白名单事件当 opaque/log-only 行带过，并在 v1 阶段补 `ignorable: true` |
| `v0-descriptor-v2-admission` | `dsh-session-format-v0-to-v1` | `subagent/descriptor` v2 不再让整个日志不可读（0.1.2 与 0.1.5 都把非 v3 描述符 fold 成 `undefined`，即 inert；未知版本仍拒绝） |
| `v0-retired-inbox-forms` | `dsh-session-format-v0-to-v1` | 早期 kix 注入写的 `form: gate/debug`（与 notice 同形、无消费者）按 notice 规则校验；未知 form 仍拒绝 |

三处「旧词汇」白名单刻意**fail-closed**：只有实测存在的值被放行，未知值仍旧拒绝
（`web/glm-search-mcp-request` / descriptor `version: 2` / form `gate`、`debug`）。

### 为什么必须打（实测）

- 0.1.5 之前，v0 日志由 0.1.2 原生读取，**没有任何格式迁移层**；0.1.5 新增
  `dsh-session-format-*` 迁移链，对「不是已发布 v0 清单内」的事件一律拒绝，v0 阶段
  连 `ignorable` 标记也不放行（注释原文 *"even when ignorable"*）。
- 本机 `~/.dsh/sessions` 实测：补丁前 **1603 个 v0 会话里 1112 个读不了**
  （descriptor v2 1099、插件审计事件 151（其中 81 个同时命中 descriptor）、退役 inbox form 13）；
  其中 0.1.5 升级后新产生的会话也会继续踩插件审计事件那条（`append` 丢标记 → v3 读取拒绝）。
- 补丁后同一套扫描（DSH 自己的 `sessionFormatCatalog.createRestore(...)` 走完整
  v0→v1→v2→v3 链）：**1603/1603 全部还原，0 失败**；8 个 v3 文件按当前格式直读。
- 正/负样本在 `scripts/patch-dsh-runtime.test.js`：合成 v0 工件既验证放行，也验证
  未知类型/未知描述符版本/未知 form 仍旧拒绝（防「一刀切放开」）。

### 恢复方式

脚本首次改写某文件前会留 `<file>.kix-orig` 备份（本例还额外留了一份 `.orig-1.5`）；要回退到
原版 0.1.5，把备份复制回 `lib/index.js` 再重启即可（或重装 `dsh-0.1.5-rc.1`）。
`--check` 同时是升级后的准入检查。

```bash
for b in /usr/local/lib/dsh-0.1.5-rc.1/node_modules/@deepseek-ai/*/lib/index.js.kix-orig; do cp "$b" "${b%.kix-orig}"; done
systemctl restart dsh-web
```

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
