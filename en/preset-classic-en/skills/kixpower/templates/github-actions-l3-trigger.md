# Kixpower L3 Event-Driven — capability/status template

> 当前状态：`degraded-local`。本模板只验证 GitHub Actions 能收到事件并报告能力，**不会调用
> Copilot、不会修改 Sprint 文件、不会创建 Issue/Review，也不会把 workflow 成功误报为 Kix 已执行**。
> 只有经过项目维护者提供并实测的 adapter，才能把状态升级为 `enabled`。

## 能力状态

| 状态 | 含义 | 允许的副作用 |
|---|---|---|
| `enabled` | 项目提供了版本固定、可审计且手工 smoke 通过的 Kix adapter | 由 adapter 自己声明并承担，不能由本模板推断 |
| `degraded-local` | GitHub 事件可观察，但 Kix 只能在本地 VS Code 中运行 | 只写 Actions summary |
| `unsupported` | 事件或 runner 不满足只读检查前提 | 只写失败 summary |

## 推荐的只读状态 workflow

将以下内容保存为项目自己的 `.github/workflows/kixpower-l3-status.yml`。它覆盖 PR、main push、
定时恢复和手动触发，但所有事件都只做 capability report。

```yaml
name: Kixpower L3 Status

on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches: [main, master]
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: read

jobs:
  status:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Report degraded-local capability
        shell: bash
        run: |
          {
            echo '## Kixpower L3'
            echo
            echo '- status: `degraded-local`'
            echo '- result: `NOT_TRIGGERED`'
            echo '- reason: no trusted Kix adapter is installed in this runner'
            echo '- next step: run `/kixpower-review` or `/kixpower-continue` in VS Code'
          } >> "$GITHUB_STEP_SUMMARY"
```

## Adapter 升级合同

要把项目 workflow 从 `degraded-local` 升级为 `enabled`，必须先在项目仓库内提供 adapter，并在
`workflow_dispatch` 下记录一次成功 smoke：

- adapter 来源、版本和 commit 已固定；
- adapter 的输入、输出、权限和 timeout 已文档化；
- PR workflow 不执行来自不可信 PR head 的写权限控制平面；
- dry-run 能证明不会在无用户确认时发布 Review、Issue、commit、push 或修改 Sprint 状态；
- 成功结果必须同时包含 `adapter_id`、`adapter_revision`、`run_id` 和实际副作用清单；
- adapter 失败时输出 `degraded-local`/`unsupported`，不能输出 `enabled`。

本模板不猜测 Copilot REST endpoint、不假设 runner 已安装 Copilot CLI，也不假设 GitHub Actions
会自动重试 agent 操作。没有这些可验证前提时，唯一正确结果是 `NOT_TRIGGERED`。

## 安全边界

- 不把用户级 `~/.copilot` 当作 runner 可访问配置；项目若要自动化，必须显式提交经过审计的项目级 adapter。
- 默认不授予 `contents: write`、Issue 写或 Review 写权限。
- 不从 `pull_request` 的不可信 head 执行带控制平面写权限的脚本。
- L3 不是 L1/L2 的替代品；本地 `/kixpower-*` 仍是当前实际编排入口。
