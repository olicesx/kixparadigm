---
name: repo-ops
description: Fast, structured git operations for local repositories — one-screen overview (branch, changes, diff stat, recent commits) plus battle-tested command templates for status/diff/log. Use at task start to see where a repo stands, before making changes, and before reporting what changed.
argument-hint: "Path to the git repository (optional)"
---

# repo-ops

本地 git 仓库的结构化操作。核心抓手是 `git-overview.mjs`：一次调用拿到仓库全貌，不用连敲四五条 git 命令再人肉解析。

## 何时使用

- 任务开始：先看仓库在哪、什么分支、有没有未提交改动（**改任何代码前必跑**）
- 交付前：确认改了哪些文件、diff 规模是否合理
- 用户问"这个仓库什么状态 / 上次提交是什么"

## 一屏快照（首选）

```pwsh
node skills/repo-ops/scripts/git-overview.mjs [--path <dir>] [--log N] [--json]
```

输出：当前分支 + HEAD、upstream 领先/落后、变更表（staged/unstaged 分开）、`git diff --stat`、最近 N 条提交。

- 默认 `--path` 为当前工作目录；不在 git 仓库内会明确报错（退出码 1）
- `--json` 输出结构化 JSON，适合 `run_code` 程序化消费
- 仓库巨大时 diff stat 可能较慢（git 原生速度，可接受）

## 高频命令模板

| 需求 | 命令 |
|---|---|
| 未提交改动（含 staged） | `git diff HEAD` / 只 stat：`git diff --stat HEAD` |
| 只看已暂存 | `git diff --cached` |
| 具体文件 | `git diff HEAD -- <file>` |
| 最近提交 | `git log --oneline -15`（看日期：`git log --pretty='%h %ad %s' --date=short -15`） |
| 某次提交内容 | `git show <sha>`（只看 stat：`git show --stat <sha>`） |
| 工作树干净与否 | `git status --porcelain`（`??` = untracked） |
| 分支全览 | `git branch -avv` |

## 门禁（MUST）

- `commit` / `push` / `rebase` / `reset` / `checkout -b 覆盖` / `clean -f` 等**写操作**：先跑快照确认改动面，再按会话既有审批流程执行，禁止静默改写历史
- 新会话接任务第一步永远是 `git-overview`，不是猜仓库状态

## 实现说明（维护者）

脚本用 `child_process` 同步调 git，纯只读（rev-parse/log/status/diff），不写任何仓库状态；porcelain 输出解析为 `{staged, unstaged, untracked}` 三组。

**porcelain 前导空格是语义**（` M file` = 未暂存修改）：对 git 输出**禁止 `trim()`**，只能去尾部换行（曾因此把 ` M a.txt` 错解析成 staged `.txt`）。
