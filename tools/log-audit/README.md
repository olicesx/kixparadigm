# log-audit — KIX 会话日志测量工具链

解码 DSH `session.jsonl.zstd`（多帧 zstd + JSONL）并量化 token 开销。用于：
优化前基线（`kix-task-log-analysis.md`）与优化后实地测试（新会话）的对比度量。

## 用法（Node 18+，无需依赖）

```bash
# 1) 全量清单：85+ 会话 → inventory.json（主会话/子代理血缘、思考/回答 token、工具、spawn）
node inventory.js "$HOME/.dsh/sessions" inventory.json

# 2) 汇总表：主会话表 / 子代理表 / 总量 / TOP token 会话 / spawn 预览
node summary.js inventory.json

# 3) 聚合统计：思考占比、per-project、子代理模型分布、重度会话占比
node aggregate.js inventory.json

# 4) 单会话深挖：每步 token、轮询(list_agents/job_output)统计、spawn 步骤
node deepdive.js <session.jsonl.zstd>

# 5) 单会话固定开销：request/header 的系统提示 + 工具目录 token 数
node overhead.js <session.jsonl.zstd>

# 6) 工具裁剪模拟：算 toolFilter 后工具目录的 token 数
node toolsize.js <session.jsonl.zstd> read grep glob pwsh

# 7) 事件类型/形态探查
node analyze.js <session.jsonl.zstd> types|shapes|summary|headers
```

## 口径说明

- 思考 token = `reasoning-chunks` 行内 token 字符串计数（近似）；回答 token = `text-chunks` 同口径。
- **完成侧可精确度量；输入侧（每次请求重发的上下文）不在日志中**，实际账单通常远大于完成侧。
- `request/header` 含 system/tools 原始内容与 `adapterDefaults`（如 deepseek 默认 effort=high/maxTokens=256000），是机制验证的关键事件。

## 优化前后对比步骤（实地测试后）

1. 用户在**新会话**（kix-cost 已挂载）正常使用后，重跑 `inventory.js + aggregate.js + summary.js`；
2. 对比字段：
   - 子代理 `request/header` 的 `reasoningEffort`（应出现 medium / max / 无）；
   - 子代理思考 token 总量与均值（基线：428k 总量，单会话最高 105.8k）；
   - lite 子代理的系统提示（~4.4k vs 17.1k）与工具数（4 vs 82）；
   - 主会话每步固定开销与思考量（基线：34.3k/步、思考占完成侧 92%）。
