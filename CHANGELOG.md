# Changelog

## v1.2.13（2026-08-17）部署复验整改

- **交接 gate 机械注入**：`kix-focus` 编曲成员（qa/dev/reviewer）capability_call 分派自动携带 `current_sprint: N`（工作区 marker `docs/.kixpower-current-sprint` 驱动，`sprintInjected` 返回）+ `kix-orchestration` v10.1 Tri-Block `[CONTEXT]` `Sprint N` 容错解析（双保险，直呼路径也兜底）
- **lite 档 Linux 可用**：`ACTIVATABLE_TOOLS` 快照 toolFilter 平台条件化（v1.2.12 只修了 agent.cordis.yml 行，capability_call 自动激活路径仍报 unknown global tool "pwsh"，部署 E2E 实锤）
- **kix-guards v10.1**：commit-on-main 整链修复——`DANGEROUS_GIT` 补 `commit`。此前纯 `git commit` 不触发 isGitWrite、分支/预算检查永不执行，main 直接 commit 静默放行（部署 E2E 实锤）
- 单测：kix-focus **102** / kix-orchestration **77** / kix-guards **219** 组全绿；WSL2 部署 E2E 三复验全过（lite / commit 拦截 / persona 规则 + 机械注入实证）

## v1.2.12（2026-08-17）iterate-verify-release（PR #6）

- subagent-lite toolFilter.allow 平台条件化（win32→pwsh、其余→bash）——原硬编码 pwsh 使 Linux 部署 tools.restrict() 报 unknown global tool、lite 档不可用（WSL2 E2E 实证）
- kix-guards v10：repoRootFromText 补 `cd <repo> && git commit`（无 -C）命令位提取——会话 cwd ≠ 仓库根时 commit 检查此前静默跳过，单元回归 142→213 组
- persona：Sprint 子代理分派契约行补 `current_sprint: N`，使 kix-orchestration 交接门禁真正触发
- jobs 常驻化 + 细分档位/goal 首次使用自动激活（capability_call 代理即挂载，kix_tool_activate 保留为显式预激活）
- kix-focus symlink 部署跨平台解析修复：候选根链 argv[1]→realpath→插件文件，WSL2 E2E 两轮实测闭环

## v1.2.11 软约束整改（DSH 版）

- 发布/评论/合并/破坏默认不做；用户明确指示（如「评论到PR」）即已决策，直接执行，kix-guards 不再逐次提问。提问只留给真正缺失的决策信息

## v1.2.10 整改（DSH 版）

- 按 KIX 自审修复「0% 误报」反例——QA 完成声明排除负向表述；控制平面门禁只拦写意图（`grep/cat/ls ~/.dsh` 放行）；终端 SQL 改为 DB 客户端命令位 + SQL payload 语句级判定；GitHub MCP 前缀可配置；跨厂商路由跳过未注册偏好候选；中英包卸载不再互相删除共享 vision-bridge；`engines` 对齐 `process.getBuiltinModule` 最低版本
- 常驻 persona 二次还债压至约 1.8K token（CN，原 3.1K）
- 新增 persona 预算/文档计数/双语插件一致性守护与 CI；vision-bridge 补纯逻辑回归并修复完整代码围栏剥离

## 更早

- v1.2.9：编曲模型（activatable 成员档 + Sprint 流程）、kix-discipline 插件化、kix-route modelPreference 配置化
- v1.2.8 及以前：见 git log
