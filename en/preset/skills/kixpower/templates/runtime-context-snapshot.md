# Runtime Context Snapshot Template

> **来源**：9 Ways AI Coding Agents Break in Production (May 2026) — "Hidden runtime state" 失败模式
> 论文证据：AI agents "write code that compiles, runs locally, and breaks the first time it touches your Kubernetes cluster" because the cluster is full of state the model never sees.
>
> **用途**：Dev 改代码前**必须**先收集这些 runtime context，避免基于过时文档或本地假设改代码。

## Dev 启动时收集清单（Sprint 开始一次）

Dev 子 agent 启动后第一件事（读完 plan.md / lessons-learned 之后）：

```bash
# 在项目根目录执行（PowerShell 兼容）
# 输出追加到 docs/sprint-N/runtime-context.md
```

### 1. 环境变量实际值
```bash
# 列出 .env / .env.example 实际存在的 key（不输出 value，避免泄露）
Get-ChildItem .env*, docker-compose*.yml -ErrorAction SilentlyContinue |
  ForEach-Object { Write-Output "## $($_.Name)"; Select-String -Path $_.FullName -Pattern '^\s*[A-Z_]+=' | ForEach-Object { ($_ -split '=')[0].Trim() } }
```

### 2. 数据库 schema 实际结构（vs 文档）
```bash
# 检查是否有迁移目录，列出最新迁移
Get-ChildItem migrations/* -ErrorAction SilentlyContinue | Select-Object -Last 5 Name
# 或 ClickHouse DDL（示例项目 项目特化）
Get-ChildItem src/clickhouse/migrations.rs -ErrorAction SilentlyContinue
```

### 3. 上游 API 实际响应 schema（vs SDK 文档）
```bash
# 抓一份 curl/ping 输出（不要凭 SDK 文档猜）
# 例如：OpenAI / Anthropic 的 chat completions response shape
```

### 4. 当前运行进程的 health endpoint
```bash
# 如果服务在跑，访问 /health 或 /metrics
# 不要假设「服务大概在跑」，要确认
```

### 5. git 当前状态（branch / staged / untracked）
```bash
git status --short
git rev-parse --abbrev-ref HEAD
git log --oneline -5
```

### 6. 文档与代码的一致性 sanity check
- 读 README.md / docs/ 的"启动命令"
- 对比 package.json scripts / Cargo.toml [[bin]] / Makefile
- **若不一致**：以代码为准，记入 `runtime-context.md` 的「文档漂移」区块

## 输出文件：`docs/sprint-N/runtime-context.md`

```markdown
# Runtime Context Snapshot — Sprint N

> 生成时间：YYYY-MM-DD HH:MM
> 生成者：kixpower-dev (Sage)

## 1. 环境变量 keys（.env*）
- APP__REDIS__URL
- APP__CLICKHOUSE__URL
- APP__JWT__SECRET（不输出值）
- ...

## 2. 数据库 schema
- 最新迁移：20260728_add_quota_check.lua
- ClickHouse 表：accounts, api_keys, billing_ledger, ...
- **漂移**：docs/payment-api.md 说有 `reservations` 表，实际是 Redis stream（非 CH 表）→ 已记 lessons-learned

## 3. 上游 API 实际响应
- OpenAI chat.completions: { id, choices[], usage, ... }
- Anthropic /v1/messages: { id, content[], stop_reason, ... }
- **漂移**：无（SDK 与实际一致）

## 4. 当前运行状态
- 后端：未启动（端口 8080 free）
- Redis：localhost:6379 无响应（本机无 Docker）
- ClickHouse：localhost:8123 无响应

## 5. git 状态
- branch: feature/sprint-1-p0-hardening
- 未提交：0 个 staged，3 个 modified (auth.rs, credit.rs, api/payment.rs)
- 最近 commit: db0cb81 fix clippy warnings

## 6. 文档漂移登记
- [ ] docs/payment-api.md 与 src/api/payment.rs 不一致（字段名）
- [ ] README 启动命令缺 `migrate-clickhouse` 步骤
```

## 硬约束

- Dev **首次启动 Sprint 时必须生成** runtime-context.md，否则后续改动基于错误假设
- Dev **每次发现新的 runtime 漂移** → 追加到「漂移登记」区块 + lessons-learned.md
- Runtime context 只在 Sprint 开始时生成一次，**不要每次都生成**（防上下文膨胀）
- 敏感值（密钥/token）**绝不**写入文件，只记 key 名
