# kixparadigm — Agent Preset（kix 范式导入）

> 从桌面 `kix-bundle`（VS Code Copilot 定制包）完整导入 DeepSeek Harness 的 agent preset。
> 本目录 = kix 全家桶的 Harness 落地：认知层常驻 persona + skills + 团队角色 + kixpower 流程 + 方法论记忆。
> **DSH 适配权威文档：`DSH-ADAPTATION.md`**（工具名映射 / 机械门禁 / 团队编排 / 原生特性 / 已知限制）。

## 目录结构

```
kixparadigm/                      ← 本 preset
├── agent.cordis.yml              ← 组成（persona 常驻认知层 + 全部能力行 + 已启用插件）
├── preset.yml                    ← 展示元数据
├── DSH-ADAPTATION.md             ← 权威 DSH 适配层（工具映射/门禁/编排/限制）
├── PLUGINIZATION-ROADMAP.md      ← 插件化改造路线图（2026-08-16）
├── plugins/
│   ├── kix-guards.js             ← 机械门禁（tools/pre-execute 自动拦截，blast-radius 移植）
│   ├── kix-discipline.js         ← 纪律机制化（需求三检契约 gate + 验证 gate，2026-08-16）
│   ├── kix-orchestration.js      ← 编排交接门禁（sprint marker/plan/progress/blocker 校验，2026-08-16）
│   ├── kix-focus.js              ← 极简+渐进披露（restrict 裁剪 + capability_search/call，2026-08-16）
│   ├── kix-browser.js            ← 原生浏览器自动化（17 action，CDP attach/launch 兜底，按需激活零常驻税，2026-08-18）
│   ├── kix-cost.js               ← 成本分层（子代理思考强度归一化 + lite 自动选型）
│   ├── kix-route.js              ← 子代理路由（cross/vision/thinker 哨兵解析）
│   ├── kix-commands.js           ← /kixpower-* 原生命令
│   └── kix-stalled.js            ← 停滞检测（opt-in）
├── instructions/
│   └── kixparadigm-core.instructions.md   ← 常驻认知层原件
├── skills/                       ← 挂到本 preset 的 skill 目录
│   ├── kixparadigm/              ← 认知范式机制细节（SKILL.md + AUDIT.md）
│   ├── kixpower/                 ← 多智能体编排 v5.7（SKILL + README + USAGE_MANUAL
│   │                                + TEAM_CONVENTIONS + hooks + scripts + templates + tests）
│   ├── handoff/                  ← 会话交接
│   ├── write-a-skill/            ← 创建新技能
│   ├── improve-codebase-architecture/ ← 架构改进机会发现
│   ├── pwsh-reliable/            ← Windows 命令可靠性（native 参数/引号/退出码/WSL/清理，2026-08-17 吸收）
│   ├── tdd / teach / grill-me / grill-with-docs / diagnose / prototype
│   ├── triage / to-issues / to-prd / zoom-out / migrate-to-shoehorn / caveman
├── agents/                       ← 角色定义（子代理分派模板）
│   ├── kixparadigm.agent.md      ← 范式主入口
│   └── kixpower-{orchestrator,producer,dev,qa,reviewer}.agent.md
├── prompts/                      ← kixpower 流程（/kixpower-* 等价物）
└── memories/                     ← 方法论记忆（目录清单为准；Copilot 语境记忆已移出）
```

## VS Code Copilot → DeepSeek Harness 映射

| kix bundle 原机制 | 本 preset 落地 |
|---|---|
| `~/.copilot/instructions/…`（常驻） | persona 文本（每次会话生效） |
| `~/.copilot/skills/<名>/SKILL.md` | `skills/` 目录（`skill-filesystem` customSkillDirs 挂载） |
| `~/.copilot/agents/*.agent.md` | `agents/` 参考（`subagent`/`subagent_fork` 分派时按角色构造 prompt） |
| `~/.copilot/prompts/*.prompt.md`（/kixpower-* slash command） | `prompts/` 参考（模型按意图读取对应流程文件执行） |
| memory-tool user memories | `memories/` 参考（persona 指引按需读取） |
| VS Code PreToolUse hooks（blast-radius 等 .ps1） | hooks/*.ps1 随技能保留，经 `pwsh` 手动调用；常驻机械层 = `plugins/kix-guards.js`（pre-execute 门禁，v5：需确认的门禁在聊天内提问）+ 本 harness 的 sandbox 栈 |
| `runSubagent` | `subagent` / `subagent_fork` |
| `vscode_askQuestions` | `ask_user_question` |
| `read_file`/`grep_search`/`replace_string_in_file`/`run_in_terminal` | `read`/`grep`/`edit`/`pwsh` |

## 使用

1. 在 GUI 选择此 preset 开新会话（kixparadigm 模式）。
2. 认知层自动生效；机制细节按需加载 `kixparadigm` / `kixpower` 技能。
3. 复杂任务（跨模块/大改动）自动升级 CEO 团队编排：producer 规划 / dev 实现 / qa 验证。
4. 说 `/kixpower-new` / `/kixpower-import` / `/kixpower-continue` / `/kixpower-review` 或对应自然语言意图 → 模型读取 `prompts/` 对应流程执行。
5. 发布/合并/破坏性操作前会经 `ask_user_question` 请你确认。

> 提示：本 preset 内所有技能/流程文件均可在会话中直接阅读；`kixpower` 的
> TEAM_CONVENTIONS.md 是团队协作规则的权威源（target_rules / plan.md schema /
> eval schema / 模型窗口约定），USAGE_MANUAL.md 是完整使用手册。
>
> PTC/Code Mode：工具以 `both` 形态呈现（native 直呼 + `run_code` 程序化组合），
> 模型自主选择；决策与机制见 `DSH-ADAPTATION.md` §9。
