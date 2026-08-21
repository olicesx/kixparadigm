# kixparadigm

> **AI 自编排最小范式（认知层常驻）× 多智能体编排 × 编码 Agent 预设** — 一个仓库装下 kix 全家桶，`npm` 一键导入 DeepSeek Harness，脚本导入 VS Code Copilot。

[![CI](https://github.com/olicesx/kixparadigm/actions/workflows/ci.yml/badge.svg)](https://github.com/olicesx/kixparadigm/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/kixparadigm)](https://www.npmjs.com/package/kixparadigm)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> **🌍 English:** [README.en.md](README.en.md) · **中文:** 本文件
>
> 本文档实践仓库自身的范式：**常驻最小、渐进披露、易变数字不双源维护** —— 版本史在 [CHANGELOG.md](CHANGELOG.md)，机制映射在 [dsh/preset/DSH-ADAPTATION.md](dsh/preset/DSH-ADAPTATION.md)，细节不在此重复。

## 为什么

kix 范式原是 VS Code Copilot 定制包。研究 DeepSeek Harness（DSH）后发现两者**机制天然适配**：常驻认知 = preset persona、门禁 hooks = `tools/pre-execute` 插件、团队 Agent = subagent 分派、slash 命令 = DSH 原生命令、识图补足 = vision-bridge。完整映射见 [DSH-ADAPTATION.md](dsh/preset/DSH-ADAPTATION.md) 与 [DSH-FUSION-MATRIX.md](dsh/preset/DSH-FUSION-MATRIX.md)。

适配带来一个现实转变：范式从「一个人本机的 Copilot 定制」变成「一条命令可复现的公开资产」——这是本仓库开源的契机。

## 快速开始（DSH，推荐）

```bash
npm i -g kixparadigm     # 同时安装默认模式 kixparadigm + 经典模式 kixparadigm-classic + vision-bridge；重启 dsh web 后在模式列表选择
npx kixparadigm install  # 不全局安装
npm i -g kixparadigm-en  # 英文经典模式 kixparadigm-classic-en（独立包）
```

> v1.3.4 起 `npm i -g kixparadigm` 会把两个变体都装进 `~/.dsh/.agent-presets/`。消融对照 `kixparadigm-null` 不随 npm 安装。
>
> **先选对模式**：默认 `kixparadigm` 是激励面（压缩思考锚点 + 效用准则 + 按需技能货架；无仪式流水线、无 agents 目录）。`kixparadigm-classic` 是全文编曲配套（思考锚点全文 + kixpower 说明书 + agents/instructions）。复杂协作 / 研究范式仍可用 classic；默认档不再把核心哲学砍掉。选择器是任务属性，不是「半价 = 没有脑子」。

自定义 DSH 目录（`DSH_HOME`）、`--preset-only`、运维命令（`doctor` / `uninstall` / `copilot`）见 [dsh/README-DSH.md](dsh/README-DSH.md)。

## 快速开始（VS Code Copilot）

```bash
# Windows
.\install.ps1
# macOS / Linux
chmod +x install.sh && ./install.sh
```

详见 [INSTALL.md](INSTALL.md)。装完 `/kixpower-new` 开始。

## 这是什么：两层 + 插件地板

下表是范式能力面。**默认激励面注入压缩思考锚点 + 效用准则**；编曲说明书与 agents 模板在 `kixparadigm-classic`。技能货架两边都按需加载。

| 层 | 组件 | 一句话 |
|----|------|--------|
| **认知层**（怎么思考） | 默认：压缩锚点+激励面；classic：全文 | 三通道交叉验证、阶段二相性、规则是负债、需求三检（不迎合用户）、写码前决策链 |
| **执行层**（怎么执行） | kixpower（说明书随 classic；成员档两边可激活） | 编曲模型：主模型自由挑成员（dev/qa/reviewer）+ Sprint 流程、DAG 拓扑、4 层 loop、四条不变量地板 |
| 机械门禁 | `kix-guards` · `kix-consistency` | commit 预算、feature branch、force push、危险 SQL、控制面保护（硬 deny 仅不可逆破坏）；preset 一致性写时拦截（防 zh/en 漂移） |
| 交接纪律 | `kix-orchestration` · `kix-discipline` | subagent 交接证据链校验；spec 契约 gate + 验证 gate |
| 聚焦 | `kix-focus` | 工具面 85→18 常驻裁剪 + 按需目录与代理执行——渐进披露的运行时形态 |
| 浏览器 | `kix-browser`（按需激活） | 原生 `browser{action}` 17 动作（open/snapshot/click/type/press/select/hover/导航/等待/截图/上传/多标签/弹窗）——playwright-core 直驱、CDP attach 接管真实浏览器（登录态保留）、会话跨调用持久；零常驻 schema 税（capability_call 首用自动挂载）；替代 MCP 五跳链路 |
| 成本路由 | `kix-cost` · `kix-route` | 子代理思考强度归一化；哨兵模型名 → 运行时可用路由 |
| 补足 | `kix-commands` · `dsh-vision-bridge` · `kix-stalled`（opt-in） | `/kixpower-*` 原生命令；无视觉主模型识图；停滞 Sprint 检测 |

默认激励面提供压缩思考锚点 + 效用准则 + 按需技能 + probe/settle/experience。classic 另提供全文编曲说明书、agents 模板与 instructions。清单以各目录为准。各插件机制与版本演进见 [DSH-ADAPTATION.md](dsh/preset/DSH-ADAPTATION.md) 与 [CHANGELOG.md](CHANGELOG.md)。

## 仓库结构

```
kixparadigm/
├── dsh/preset/        ← DSH preset 唯一事实源：persona/技能/角色/插件源码+测试/适配文档
├── en/                ← 英文版（独立 npm 包 kixparadigm-en，与中文包同步发版）
├── skills/ agents/ prompts/ memories/ instructions/   ← VS Code Copilot 分发版（7 技能子集）
├── bin/ scripts/      ← CLI 与安装/验证/一致性守护脚本
└── install.ps1 / install.sh / INSTALL.md / CHANGELOG.md
```

> **唯一事实源约定**：`dsh/preset/` 是事实源，`~/.dsh/.agent-presets/kixparadigm/` 只是安装副本（维护 = 改 preset 后跑 `scripts/sync-dsh-preset.ps1 -Force`）；根目录 `skills/` 等是 Copilot 分发版，与 DSH 版刻意不同，不互相覆盖。

## 开发与验证

```bash
npm test                                    # 一致性守护 + 全插件回归（计数由测试输出自报，不在本文档维护）
node scripts/check-dsh-consistency.cjs      # persona 预算/分发镜像/双语一致性守护
kixparadigm doctor                          # 安装状态自检
```

## License

[MIT](LICENSE) © 2026 kixparadigm contributors
