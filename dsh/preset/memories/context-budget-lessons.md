# 上下文预算：三约束与两个信号（2026-09-12 事故教训）

## 事故

`session-c3370a1e`（kixparadigm，glm-5.3，2026-09-12）：

- turn 20 的 **21 步里触发 41 次压缩**；全会话 46 次 start / 36 次 summary / **10 次 shrink 失败**。
- 成功压缩对 prompt 的**中位变化 +50 token**（等于没压），43 次连续释放 < 20K。
- 全会话累计 prompt **131,049,620** token（peak 449,513）。

## 根因

`thresholdRatio: 0.18`（1M → 180K）与继承的 `retainRatio: 0.16`（1M → 160K 保留）只留
**20K 可压区间**；再扣掉固定前缀（system+tools，实测 F≈23K），`selectCompactableRange`
每次只能 shadow ≈1.8K，压完仍在阈值上 → 每步重触发。引擎没有"无进展退避"。

## 三约束（现行落地，v4 = 200K 甜点档）

```
T = min(200K, 0.8 × W)      能力上限（甜点，三条独立约束的交点）
R = min(64K,  0.044 × W)    保留预算（含未枚举路由的安全余量）
不变量：R ≤ 0.4 × (T − F)   F ≈ 23K，保证可压头部够宽
```

**甜点依据（2026-09-12，11 条臂实测 + 文献）**：同负载 27 请求下 200K 上限 = 2.63M/2.80M
累计 prompt（两次采样），256K = 3.57M（+31%），400K = 4.68M（+72%）；三者的召回与压缩保真
**全部 PASS**，未观测到高上限的任何能力收益。同时：
- 成本随上限单调上升、能力持平 → 取下限；
- 不变量 R ≤ 0.4(T−F) 要求 T ≥ 183K（R=64K 时）；
- BABILong 有效利用 10–20% / 2026 市面 MRDA 可用 ~200K → T ≤ 200K。
三条独立约束交于 200K。1M 路由落地值：**T=200,000 / R=44,000 / 可压带 133K**。

**kix-budget 结论：保持 disabled。** 开启后每个 >2KB 结果到达即被剪成 1.5KB，成本降到
0.88M（5.3×），但内容密集任务需要读两遍才答对（12 次 vs 6 次）；且它的
`resultThresholdChars` 调不动（`prunerThreshold()` 优先取宿主 pruner 的 `thresholdChars`），
400K 交接 gate 在所有臂里从未触发（未验证）。若为成本，降上限比开它更干净。

编码现状（`agent.cordis.yml` 的 compaction-basic）：顶层 `thresholdRatio: 0.2` +
`retainRatio: 0.044`（W≤1M 时 T≤200,000）；未枚举路由回退顶层值（偏保守但安全）；
显式覆盖：astra 0.190477、gpt-5.6×3 0.5、grok-4.6/-latest 0.7629395、zai-vision×3 0.8。

**为什么不用显式上限字段**：本体 web 进程内存里是未打补丁的旧 schema，新字段会让
`resolveConfig` 抛 `unknown key` → 新会话挂载失败。`/root/kix-compaction-cap-patch.mjs`
已实现 `maxThresholdTokens` / `maxRetainTokens`（幂等、带备份、`--check/--revert`），
**dsh-web 重启后可升级为 `thresholdRatio: 0.8 + maxThresholdTokens: 400000 +
retainRatio: 0.16 + maxRetainTokens: 64000`**，那才是对 >1.25M 窗口也成立的真不变量。

## 两个可观测信号（用 /root/kix-context-audit.py）

1. **压缩效率**：单次释放 < 20K 连续 2 次 → retain 又在吃阈值，立即查配置并考虑交接。
2. **累计 prompt**：> 30M → 用 goal/continue 分会话交接，别让一个会话跑到压缩接管。

```bash
python3 /root/kix-context-audit.py                    # 最新会话
python3 /root/kix-context-audit.py <session-dir|log>  # 指定
```

## 标定与证据（别外推）

- 本机 2026-09-12 直连标定（8-needle + 序数检索）：deepseek-flash 与 glm-5.3 在
  **20K–400K 全部答对**，未测到拐点。所以 400K 上限是"用户要求 + 未测到反证"，不是能力拐点。
- 文献是任务依赖的：BABILong 推理型有效利用 10–20%；LongCodeBench 修复类 32K→256K 从
  29% 掉到 3%，理解类到 512K 才崩；2026 市面 MRCR v2 8-needle：DeepSeek V4 Pro @1M 41%，
  Gemini 3.1 Pro @1M 26.3%，只有 GPT-5.5 / Opus 4.6 到 ~500K。单 needle 分数会骗人。
- **证伪点**：本机 A/B 若显示 400K 与 200K 上限成功率无差异，则应下调到 200K 省成本；
  若显示 400K 明显更差，则当前上限偏高。

## 未知模型适配（2026-09-12 扫描实测）

未枚举的 `(provider, model)` **不会崩**：回退顶层策略并按该模型上报的 `contextWindow`
现算 T/R，且每个请求重新解析 → 会话中途换模型也自动跟随。但比例编码有两个盲区：

| 窗口 | 现状 A（比例 0.2/0.044） | 补丁版 B（绝对上限） |
|---|---|---|
| 32K | T=6,553，带 **−17,888**（不可用） | 带 1,773（仍不可用，F=23K 占 70%） |
| 64K | 带 −12,776 | 带 26K ✓ |
| 128K | 带 **−2,553**（压缩静默失效） | T=104,857，带 76K ✓ |
| 1M | T=200,000，带 133K ✓ | 同 ✓ |
| 1.25M | T=250,000（超甜点） | T=200,000 ✓ |
| 2M / 4M | T=400K / 800K（无上限） | T=200,000 ✓ |

**第三个盲点：W 本身。** 新模型若没在 settings 目录声明 `contextWindow`，会用适配器默认值
（deepseek 1e6、pi-ai 262144）——真实的 128K 模型会被当成 1M，T=200K 超过其真实窗口，
同样只剩溢出兜底。**加新模型必须两件事：① 目录里写对 `contextWindow`；② 窗口 <200K 或
>1.25M 时补一条 `modelPolicy`。** 重启后换成补丁版即可两件都免，`modelPolicies` 可清空。

**检测器**：`kix-context-audit.py` 现在会识别"压力越过隐含阈值、但裁剪与压缩都没发生"
这个静默失效签名（合成用例已验证会报警，两个真实会话无误报）。

## 危机教训（配置类改动的通用规则）

改任何 preset/插件配置前，先问：**运行中的进程内存里是不是旧版本？** 若是，则
① 新字段会让挂载失败，② 已加载的插件模块不会因文件改动而更新（Node ESM 缓存），
③ `ensureStanding` 只在 composition 的 mtime/size 变化时于**下一次新会话**重挂载。
结论：配置必须先用旧 schema 也认的写法落地，再在新进程里升级。
