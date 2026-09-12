# context-budget — 上下文预算工具链

压缩阈值/保留预算的落地、验证与诊断工具。策略与证据见
[`docs/kix-context-management.md`](../../docs/kix-context-management.md)。

## 目标策略

```
T = min(maxThresholdTokens 200K, 0.8 × W)    压缩触发阈值
R = min(maxRetainTokens   64K, 0.044 × W)    压缩时逐字保留的尾部
不变量：R ≤ 0.4 × (T − F)，F ≈ 23K（system prompt + 工具 schema 的固定前缀）
```

`maxThresholdTokens` / `maxRetainTokens` 是 `kix-compaction-cap-patch.mjs` 给
`@deepseek-ai/dsh-compaction-basic` 加的两个绝对上限字段——上游只支持比例，
表达不了"任何窗口都不超过 N"。

## 文件

| 文件 | 作用 |
|---|---|
| `kix-compaction-cap-patch.mjs` | 给已安装的引擎加两个绝对字段。幂等；`--check` / `--apply` / `--revert` |
| `kix-compaction-cap-patch.test.mjs` | 9 条真码断言：上限生效、比例兜底、per-model 覆盖、旧配置兼容、非法值拒绝、loader schema 保留字段 |
| `kix-apply-abs-cap.sh` | 落地编排：dry run / `--self-test` / `--dropin` / `--restart`（备份→写入→校验→重启→回滚） |
| `kix-apply-abs-cap.py` | 单个预设的 entry 级替换变换（中/英两套 block，按路径选） |
| `kix-apply-abs-cap.block` | 中文规范块（完整 entry，写入预设的单一事实源） |
| `kix-apply-abs-cap.en.block` | 英文规范块（`en/preset-classic-en`、`*-classic-en` 用） |
| `kix-apply-abs-cap.verify.mjs` | 校验器：block 或四个预设 → 对 32K–4M 全窗口断言 `T = min(200K, 0.8W)` |
| `kix-adaptation-sweep.mjs` | 未知模型的窗口扫描：比例编码 A vs 绝对上限 B 的适配矩阵 |
| `kix-context-audit.py` | 会话日志审计：压缩效率、静默失效、累计重读量 |

## 用法

```bash
# 装补丁（dsh 升级覆盖 node_modules 后需重跑；drop-in 会在每次启动自愈）
node scripts/context-budget/kix-compaction-cap-patch.mjs --check
node scripts/context-budget/kix-compaction-cap-patch.mjs --apply

# 真码断言（需要本机装了该 bundle；缺了会 SKIP 而不是失败）
node scripts/context-budget/kix-compaction-cap-patch.test.mjs

# 落地编排：先干跑，再自检，最后真落地
scripts/context-budget/kix-apply-abs-cap.sh
scripts/context-budget/kix-apply-abs-cap.sh --self-test
scripts/context-budget/kix-apply-abs-cap.sh --dropin
scripts/context-budget/kix-apply-abs-cap.sh --restart     # 会重启 dsh-web

# 校验当前落地态 + 未知模型适配矩阵
node scripts/context-budget/kix-apply-abs-cap.verify.mjs
node scripts/context-budget/kix-adaptation-sweep.mjs

# 会话上下文审计
python3 scripts/context-budget/kix-context-audit.py                    # 最新会话
python3 scripts/context-budget/kix-context-audit.py <session-dir|log>
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_COMPACTION_PKG` | `/usr/local/lib/dsh-0.1.5-rc.1/node_modules/@deepseek-ai/dsh-compaction-basic` | 引擎安装位置 |
| `DSH_PRESET_ROOT` | `$HOME/.dsh/.agent-presets` | 预设根 |
| `DSH_SESSIONS_DIR` | `$HOME/.dsh/sessions` | 会话日志根（`--restart` 找静默信号用） |
| `DSH_PRESETS` | `kixparadigm kixparadigm-classic kixparadigm-classic-en kixparadigm-null` | 参与变换的预设 id |
| `DSH_WEB_SERVICE` / `DSH_WEB_PORT` | `dsh-web` / `33236` | 重启与健康检查目标 |
| `KIX_CAP_LOG` | `$HOME/kix-apply-cap.log` | `--restart` 的 worker 日志 |

脚本按**同目录**解析所有同伴文件，所以同一份字节在仓库布局（`scripts/context-budget/`）
和平铺部署目录（如 `/root/`）都能跑。

## 依赖方向

预设的**权威源在仓库**（`dsh/preset*`、`en/preset-classic-en`），
`scripts/sync-dsh-preset.ps1` 负责 repo → `DSH_HOME`。因此改动顺序是：
先改规范块 → `kix-apply-abs-cap.py` 写入两边 → `verify.mjs` 断言两边取值一致。

`--restart` 的 drop-in（`/etc/systemd/system/<service>.service.d/kix-cap-patch.conf`）
在每次启动跑一次 `--apply`，前置 `-` 保证打补丁失败也不会阻塞服务启动。
