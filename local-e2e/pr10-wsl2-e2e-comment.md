## WSL2 dsh web 合并前实测（@33236）

部署：WSL2 Ubuntu root，`dsh web --port 33236` 从 `/root` setsid 启动；preset 同步到 `~/.dsh/.agent-presets/kixparadigm`；夹具 `/root/kix-p5-e2e`（源仓库指纹齐全）。

### 已坐实
- **P5b plan 契约门禁**：写缺预算/清单的 `docs/sprint-1/plan.md` → 注入「plan.md 缺少 commit 预算来源（task_sizing.derived_commit_budget 或 blast_radius.max_commits）」「plan.md 缺少任务清单」。
- **P5a 一致性守护**：覆盖已存在的 zh-only `dsh/preset/plugins/kix-e2e-new.js` → 注入 `kix-consistency: en/preset/plugins/kix-e2e-new.js missing`。
- **session restore**：刷新后会话完整恢复，consistency 注入卡片仍在（消息带非空 `id`）。
- 非 preset 路径 `scratch.txt` 不误报。

### 实测发现并已修进本 PR
1. `makeUserMessage` 缺 `id`（阻塞，会破坏 restore）+ 绝对路径/`./` 绕过分类 — `65376f1`
2. **整插件静默失效**：误用 `sandboxPolicy.workspaceRoot`（部署回退 = `process.cwd()`=/root）做指纹根，任意非启动目录工作区 `isRepoRoot` 失败后零开销放行。plan 门禁不受影响（只看 file_path）。改为会话 `header.cwd` → `sandboxPolicy.resolve({session})` → 回退根 — `7b52f04`

单测：kix-consistency **44 → 54** / kix-orchestration **96**；zh `npm test` 全绿。CI 过且实测闭环后即可合。
