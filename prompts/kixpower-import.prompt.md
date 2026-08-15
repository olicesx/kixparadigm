---
description: "📦 [v5.7] 已有代码项目导入：探索→Producer→Dev→L2→QA→L4→Producer 收尾。用法：/kixpower-import 或 /kixpower-import 项目路径"
agent: "kixpower-orchestrator"
---

执行 **模式 0：已有代码项目导入**。

开始规划前，Orchestrator 先确保 `docs/` 存在，再把 `1` 写入 `docs/.kixpower-current-sprint`，作为 handoff 与 blast-radius 的单一 active Sprint 来源。

> **并行优先**：阶段 1 的独立只读工具并行调用；终端命令合并为一次调用，不并发启动多个终端。详见 orchestrator 的「并行机会速查」。

## 输入

用户输入：`{{input}}`

解析规则：
- 空白 → 用当前工作区
- 含路径 → 切到该路径探索

## 执行流程（必须按顺序）

### 阶段 1：自动探索代码库（orchestrator 自己做，不调子 agent）

并行执行（用 `run_in_terminal` + 读文件工具）：

```bash
# 1. 确认技术栈
ls package.json pyproject.toml Cargo.toml go.mod composer.json 2>$null
# 2. 看根目录结构
Get-ChildItem -Directory | Select-Object Name
# 3. 看 README
Get-Content README.md -TotalCount 50 -ErrorAction SilentlyContinue
# 4. 看 src/api/app 关键目录
Get-ChildItem src, api, app -ErrorAction SilentlyContinue | Select-Object Name
# 5. 看 docker 配置
ls docker-compose.yml Dockerfile .env.example Makefile justfile 2>$null
# 6. 看测试目录
ls tests/ __tests__/ *.test.* e2e/ 2>$null
```

### 阶段 2：生成项目分析报告（结构化输出给用户）

```
项目名: [从 package.json / 目录名推断]
技术栈:
  前端: [框架 + 语言]
  后端: [框架 + 语言]
  数据库: [从依赖或配置推断]
  构建工具: [Vite/Webpack/esbuild/cargo/go]
  包管理器: [npm/pnpm/yarn/pip/cargo/go]
代码量估算: [源文件数 + 目录数]
已有配置: [列出存在的配置文件]
已有测试: [是/否，框架名]
缺少什么: [无 README / 无 CI / 无测试等]
```

### 阶段 3：1-2 个确认问题

只用问 1-2 个问题（不要全部抛出）：
- 项目主要目标是什么？（一句话）
- 有没有特别想先做的 Sprint 主题？（如安全加固 / 性能 / 新功能）
- **内容语言**（zh/en/bilingual/repo，默认 repo；或 orchestrator 自动从仓库推断）

**自动推断**：若用户未指定，orchestrator 扫描已有 README / 注释 / commit 中英文比例，写入 PROJECT_BRIEF.md frontmatter：
```yaml
content_language: <inferred>
content_language_source: inferred
```

### 阶段 4：Producer（runSubagent kixpower-producer）

prompt 要点（**已有代码特化**）：
- 不创建代码，只生成 `PROJECT_BRIEF.md`（基于现有代码反推 14 章节，frontmatter 必须含 `content_language`）
- 执行 `Cross-Sprint Drift 检测`：因为代码已存在，需识别"已有但未文档化"的决策
- 收集 `runtime-context.md`（**重要**：已有代码的 env vars / DB schema / 上游 API shape 是关键，避免 Dev 基于过时文档改代码）
- 扫描现有 Issue / TODO / FIXME → 整理为 Sprint 1 候选
- 生成 `plan.md`（含 task DAG；每个节点声明 `target_rules`，含 mechanical_links）
- 在 plan.md 定义仓库已有命令对应的 `verifiable_gates`（local/ci/manual），不猜不存在的命令
- 生成 `progress.md`（完整 frontmatter）

### 阶段 5~9：与 [kixpower-new.prompt.md](./kixpower-new.prompt.md) 相同

- Observe → Dev（含 runtime snapshot 补全）→ Observe + L2 → QA → L4（先运行 canonical Memory lifecycle validator）→ Producer 收尾 → 交付总结

详见 `/kixpower-new` 的阶段 2-8，**完全相同**。

## 已有代码特化注意事项

### 风险登记（Producer 必做）

已有代码项目常见风险：
- 文档与代码不一致（docs 说 X，代码是 Y）→ 记入 runtime-context.md 的「漂移登记」
- 历史包袱（如 cache/mod.rs 2700 行）→ 记入 PROJECT_BRIEF.md 第 9 章风险登记
- 测试覆盖度未知 → Producer 估测，Sprint 1 优先补测试基建

### Dev 启动特殊要求

- 读 runtime-context.md 的「漂移登记」**全部条目**后再动手
- 任何"代码与文档冲突"的情况 → 以代码为准，docs 更新记入 lessons-learned.md
- 不要"顺手重构"（YAGNI），只改 plan.md 范围内的事

### QA 特化

- 首次 Sprint 优先做"现有代码体检"（跑全量 clippy/test，看基准）
- 把"已有但未门禁的测试"补到 verifiable_gates.ci_gate

## 失败处理

同 `/kixpower-new`。

## 替代关系

无对应老 prompt（新增）。如已有项目用 `/kixpower-new` 会因访谈"创建目录"而出错，必须用本 prompt。
