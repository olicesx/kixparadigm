# kixparadigm

> **AI 自编排最小范式（认知层常驻）× 多智能体编排 × 编码 Agent 预设** — 一个仓库装下 kix 全家桶，`npm` 一键导入 DeepSeek Harness，脚本导入 VS Code Copilot。

[![License](https://img.shields.io/badge/license-MIT-green)]()
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)]()

> **🌍 English:** [README.en.md](README.en.md) · **中文:** 本文件

---

## 🧭 为什么会有这个仓库：kix × DSH 的适配研究

kix 范式最初是 **VS Code Copilot 定制包**：常驻认知指令、17 个技能、6 个团队 Agent、5 个 slash 命令、机械门禁 hooks、方法论记忆——一套在 Copilot 生态里打磨出来的 AI 自编排体系。

后来我们研究了 **DeepSeek Harness（DSH）**，发现两者是**天然适配**的——不是移植，而是"机制对上机制"：

| kix 机制 | DSH 原生载体 | 适配结论 |
|---|---|---|
| 常驻认知指令（怎么思考） | preset persona（每次会话自动生效） | ✅ 直接等价 |
| PreToolUse 机械门禁 hooks（blast-radius / 源码保护 / 危险 git） | **自研 `kix-guards` 插件**（`tools/pre-execute` 监听器）+ host sandbox/approval 栈 | ✅ 更强的门禁宿主 |
| `/kixpower-*` slash 命令 | **自研 `kix-commands` 插件**（DSH 原生命令，零 token 触发） | ✅ 命令即入口 |
| 团队 Agent（Producer/Dev/QA/Reviewer） | DSH subagent 分派（角色 prompt 模板） | ✅ 编排直接落地 |
| 技能体系（skills） | DSH skills（preset 内 customSkillDirs） | ✅ 原样挂载 |
| memory-tool 方法论记忆 | DSH memories/（persona 指引按需读取） | ✅ 原样挂载 |
| 跨厂商模型验证（kix 核心信念之一） | DSH llm-pi-ai providers + `subagent_vision` 视觉子代理 | ✅ 原生支持 |
| 无视觉主模型的识图补足 | **自研 `dsh-vision-bridge` 插件**（GLM-4.6V 自动转描述） | ✅ UI 无缝 |

研究结论记录在 [`dsh/preset/DSH-ADAPTATION.md`](dsh/preset/DSH-ADAPTATION.md)（权威机制映射）。这套适配带来了一个现实收益：**kix 范式从"一个人本机的 Copilot 定制"变成了"一条命令可复现的公开资产"**——这就是本仓库开源的契机：让任何 DSH 环境都能一键获得完整的 kix 认知层 + 执行层 + 门禁 + 识图补足。

---

## 🚀 快速开始（DSH，推荐）

### 方式一：npm 一键导入（`npm i -g` 自动完成全部安装）

```bash
npm i -g kixparadigm
```

安装过程自动完成：

1. **preset** → `~/.dsh/.agent-presets/kixparadigm/`（完整 preset：persona 认知层 + 17 技能 + 6 角色 + 5 命令 + 门禁/命令插件 + 6 记忆）
2. **vision-bridge** → `~/.dsh/profiles/web/plugins/dsh-vision-bridge/`（自动建 junction、登记 `cordis.patch.yml` 挂载条目）
3. **检查清单**：`settings.yaml` 缺 `zai-vision` / `zai-coding-cn` provider 时会提示（按 `DSH-ADAPTATION.md` 补齐）

然后**重启 dsh web**（Ctrl+C → `dsh web`），新会话模式列表里选择 **kixparadigm** 即可。

> 自定义 DSH 目录：`DSH_HOME=/path/to/dsh npm i -g kixparadigm`（默认 `~/.dsh`）
> 不想装 vision-bridge：`kixparadigm install --preset-only`

### 方式二：npx（不全局安装）

```bash
npx kixparadigm install
```

### 🌍 English edition

The resident cognition layer (persona / core instructions / glossary / main-entry agent) is fully translated — see the canonical terminology table in [`en/preset/instructions/glossary.md`](en/preset/instructions/glossary.md):

```bash
npm i -g kixparadigm-en     # installs the kixparadigm-en preset (mode picker: kixparadigm-en)
kixparadigm-en doctor       # self-check
```

Deep-mechanism docs (skills / prompts / memories / team roles) are still the Chinese originals while translation progresses — status tracked in [`en/preset/TRANSLATION-STATUS.md`](en/preset/TRANSLATION-STATUS.md). Source of the EN edition: the `en/` directory (npm package root) + `en/preset/` (EN preset source of truth).

### 常用运维命令

```bash
kixparadigm doctor        # 自检：preset/链接/挂载条目/插件单元回归
kixparadigm uninstall     # 卸载全部安装内容
kixparadigm copilot       # （可选）同时导入 VS Code Copilot 侧
```

---

## 🚀 快速开始（VS Code Copilot）

```bash
# Windows
.\install.ps1
# macOS / Linux
chmod +x install.sh && ./install.sh
```

详细说明见 [INSTALL.md](INSTALL.md)。装完重载窗口，`/` 输入 `/kixpower-new` / `/kixpower-import` / `/kixpower-continue` / `/kixpower-review`。

---

## 📦 这是什么：两层结构

kix 体系分两层，本仓库把两层 + 生态依赖一次性装齐：

| 层 | 组件 | 作用 |
|----|------|------|
| **认知层（怎么思考）** | `kixparadigm` | 常驻认知范式：三通道交叉验证、阶段二相性、规则是负债、需求三检（不迎合用户）、写码前决策链、AI 盲点补足。每个会话自动生效 |
| **执行层（怎么执行）** | `kixpower` | **编曲模型（v1.2.9）**：主模型自由挑成员+流程——dev/qa/reviewer 三个 activatable 成员档（人名=契约句柄）+ kixpower Sprint 流程（重路径）、DAG 拓扑、4 层 loop、可验证 gate；四条不变量地板（观察独立性/协调主线程/视角来自 prompt/门禁不变） |
| **生态辅助** | `handoff` / `write-a-skill` / `improve-codebase-architecture` 等 17 技能 | 会话交接、技能创建、架构改进、TDD/教学/排查等通用方法论 |
| **机械门禁** | `kix-guards` 插件 | commit budget、feature branch、force push、危险 SQL、控制面文件保护、人类确认点（218 组断言；v5 聊天内提问 + v4 GitHub 只读误拦修复；v6 gh CLI 写保护 + 重复尝试自动拒绝；v7 commit budget 三重修复——reflog %gs 口径只数 commit 类条目 / 过期 sprint 指针回退 / plan.md max_commits 兜底 + 冷启动 warn） |
| **纪律机制化** | `kix-discipline` 插件 | 需求三检契约 gate + 验证 gate：实现编辑前查 spec 契约、回合结束无测试提醒、`kix_discipline_spec` 契约工具（v1.2.9 新增可选 mode 字段=编曲留痕：成员组合+一句理由）、`/kix-discipline` 命令（68 组断言，2026-08-16 插件化改造 P0；拒绝/转交弹问 v2；mode 占位回读防假值 + 标题正则转义修复 2026-08-17） |
| **编排交接门禁** | `kix-orchestration` 插件 | subagent 交接前校验 sprint marker / plan+progress / blocker / QA 完成度；v2 QA 返回侧一致性校验（subagent/end）；v3 producer_closeout 收尾证据链；v4 sleep 空转等待子代理一次性提醒（**v4.1 平台无关**：命令语义双形态恒测，不按工具名门控；WSL2 实测阳性/阴性双通过，共 67 组断言） |
| **极简+渐进披露** | `kix-focus` 插件 | 三层递进：tools.restrict 把每轮工具面从 85 个（~108KB schema）裁到 ~18 个常驻核心集；`kix_capability_search` 按需查目录（v4 带参数名元数据 + 长尾兜底组：新装工具零配置即目录可达）+ `kix_capability_call` 代理执行（走完整门禁管线）；kix_tool_activate 按需激活编曲成员档（v1.2.9 枚举同步回归防线 + **symlink 部署跨平台解析修复**：候选根链 argv[1]→realpath→插件文件，WSL2 E2E 两轮实测闭环）；与 PTC/Code Mode 协同（73 组断言，2026-08-16 P4） |
| **成本纪律** | `kix-cost` 插件 | 子代理思考强度归一化（thinker→max、其余 deepseek→high）+ lite 档首选路由探测自动回退（28 组断言，v5.8；多轮回退路由缓存 bug 修复 2026-08-17） |
| **路由层** | `kix-route` 插件 | 哨兵模型名（`kix-route:cross/vision/thinker`）→ 运行时可用路由自动解析：跨厂商取反/识图模型/深思考档位；偏好表可配置（`modelPreference`/`crossProviderOrder` 经插件 config 覆盖，2026-08-17）（67 组断言，v5.9.1） |
| **原生命令** | `kix-commands` 插件 | `/kixpower-*` 五命令注册为 DSH 原生命令（零 token 触发，读 `prompts/` 注入流程） |
| **stalled 检测** | `kix-stalled` 插件（可选） | `/kixst-check` 命令 + `kix_stalled_check` 工具：只读检测停滞 Sprint（candidate，默认注释挂载 = opt-in，`scripts/install-kix-stalled.ps1` 启用） |
| **识图补足** | `dsh-vision-bridge` 插件 | 主模型无视觉时，粘贴/拖入图片自动转文本描述再提交（GLM-4.6V，服务端 HTTP + client dock） |

**关系一句话**：kixparadigm 给 AI「怎么思考」的自由度与盲点补足，kixpower 给「怎么执行」的结构化团队编排，门禁与识图插件把 DSH 变成 kix 的完整宿主。

---

## 📂 仓库结构

```
kixparadigm/
├── package.json                     ← npm 打包（postinstall 自动安装，bin 提供 CLI）
├── bin/kixparadigm.js               ← CLI：install / uninstall / doctor / copilot
├── scripts/
│   ├── install-lib.js               ← 跨平台安装器（preset + vision-bridge 挂载）
│   ├── sync-dsh-preset.ps1          ← 日常开发：镜像 dsh/preset → ~/.dsh（单向）
│   ├── ensure-vision-bridge.ps1     ← vision-bridge 自检/自愈
│   └── verify-*.js / .cjs           ← 门禁与加载链验证
│
├── dsh/                             ← DSH 侧（唯一事实源）
│   ├── preset/                      ← → ~/.dsh/.agent-presets/kixparadigm/ 的镜像
│   │   ├── agent.cordis.yml         ← 组成（persona 常驻认知层 + 全部能力行）
│   │   ├── preset.yml               ← roster 显示元数据
│   │   ├── DSH-ADAPTATION.md        ← 权威机制映射（工具名/门禁/编排/vision）
│   │   ├── PLUGINIZATION-ROADMAP.md ← 插件化改造路线图（2026-08-16）
│   │   ├── skills/  agents/  prompts/  instructions/  memories/
│   │   └── plugins/                 ← kix-guards + kix-discipline + kix-orchestration + kix-focus + kix-cost + kix-route + kix-commands + kix-stalled（opt-in）+ 测试
│   ├── vision-bridge/               ← dsh-vision-bridge 插件源码（client + server + package.json）
│   └── README-DSH.md                ← DSH 部署说明
│
├── skills/  agents/  prompts/  memories/  instructions/   ← VS Code Copilot 分发版（原样保留）
├── plugins/                         ← Copilot 侧 kix-guards 原件
├── install.ps1 / install.sh / INSTALL.md   ← Copilot 安装脚本
├── vision-bench/                    ← 识图链路基准资产（A/B 测速）
└── README.md  LICENSE  .gitignore
```

> **唯一事实源约定**：`dsh/preset/` 是 DSH preset 的事实源；`~/.dsh/.agent-presets/kixparadigm/` 只是安装副本。维护 preset = 改 `dsh/preset/` 再跑 `scripts/sync-dsh-preset.ps1 -Force`。根目录 `skills/` 等是 Copilot 分发版，与 DSH 版刻意不同，不要互相覆盖。

---

## 🧪 开发与验证

```bash
npm test                                  # 全插件回归：门禁 218 + 纪律 68 + 编排 67 + 聚焦 73 + 成本 28 + 路由 67 断言
node scripts/verify-guards.js             # 已安装 preset 与 bundle 门禁对照
node scripts/verify-vision-bridge-resolution.cjs  # vision-bridge 加载链全链路
pwsh -File .\scripts\sync-dsh-preset.ps1 -DryRun   # 预览 preset 差异
kixparadigm doctor                        # 安装状态自检
```

preset 挂载校验（roster `standingKeyFor`）在 DSH 会话内用 cordis 工具集执行。

## 📢 发布

```bash
npm login                      # 首次
npm test && npm pack --dry-run # 发布前自检
npm publish                    # 发布（npm i -g kixparadigm 即一键导入）
```

## 📄 License

[MIT](LICENSE) © 2026 kixparadigm contributors
