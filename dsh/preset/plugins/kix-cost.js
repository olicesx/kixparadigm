// kix-cost — 子代理成本层：机械档自动选型 + 思考强度分层 + 复杂度感知 effort（v5.11，2026-08-18；能力门控跨厂商适配；v5.11.1，2026-08-19 否定感知信号）
//
// 解决的问题（源码 + 日志双重实测确认的机制）：
//   A. 子代理思考强度失控：deepseek 子代理经 resolveChildAgentOptions 创建，
//      options 只有 provider/model/maxTokens（AgentOptions 无 effort 字段），
//      请求配置无 reasoningEffort → 落 deepseek 适配器默认。日志实测
//      request/header.adapterDefaults = {reasoningEffort:true, maxTokens:true}，
//      默认值 reasoningEffort=high、maxTokens=256000 —— 子代理无预算上限的
//      思考来源（实测单会话思考最高 105.8k token）。
//      → 对无显式 effort 的 deepseek 子代理按预算帽归一化注入：
//        maxTokens ≥ 98304（subagent_thinker 行）→ reasoningEffort: max
//        （该用 max 的任务仍可用 max）；其余（subagent/subagent_fork，64K 帽）
//        → reasoningEffort: high（默认档，与全局默认一致；预算帽 64K 才是
//        真正的跑飞防线——适配器默认上限是 256K）。
//   B. 机械档（subagent_lite）硬编码模型不适配他人环境：本 preset 会分发到
//      不同部署，zai-coding-cn/glm-4.7 未必存在、未必配置。
//      → 对轻量子代理（预算帽 ≤ 8K）在「首次请求」探测首选路由是否可用
//        （llm.listProviders + llm.resolveModelInfo）；不可用 → 回退到环境
//        默认路由（agentDefaultModel.currentSelection()，任何部署都有），
//        并继续走档位注入（回退后通常是 deepseek → high）。
//        探测结果按 agent 缓存（WeakMap，无泄漏），每子代理只探测一次。
//   C.（v5.10，2026-08-17）子代理再分派：账本实测 40/107 个子代理尝试过
//      spawn 孙代（50 次调用）——每个孙代再付一次全额固定开销，且违反
//      「编排留主线程」地板。→ tools.guard 对 child 发起的 subagent*/workflow
//      调用 deny（yml 静态 toolFilter.deny 管恒注册名的 schema 面收窄，
//      本 guard 兜底条件挂载名 + 语义层）。
//   D.（v5.11，2026-08-18）复杂度感知 effort：预算帽只看「配了多大」，不看
//      「活有多重」——机械小活仍按默认档烧思考。→ agent/pre-step 在子代理
//      首个**被接受**的 pre-step 上对初始 prompt 的叶子文本做零 token 分类
//      （trivial/standard/deep，保守取向；显式 `complexity:`/`复杂度：`
//      标记优先，冒号/等号半全角均可；深作/机械信号正则中英双语），profile 每 agent 只算一次（后续请求/pre-step 不改写
//      ——请求头/前缀缓存稳定）。agent/request 注入时按 profile 微调（无显式
//      reasoningEffort、非哨兵路由两个前置由既有早退保证）：
//      · deepseek（逐字原行为）：trivial → 'off'；deep → 普通行（>8192 帽
//        且原本 high）升 'max'，lite 行（≤8192 帽）永不升 max；standard /
//        无 profile → decideEffort 原行为。
//      · 非 deepseek（v5.11 能力门控跨厂商适配，不是一刀切跳过 GLM）：经
//        llm.resolveModelInfo(provider, model) 读该精确路由的能力表
//        reasoning.efforts[{id}]（DSH LLM 能力 seam，按已装 dsh-llm 类型，
//        绝不内置 provider/model → 能力 硬编码表），每 agent/model 解析一次、
//        WeakMap 只缓存自有 effort id 字符串（探测抛错/无 reasoning.efforts
//        同样缓存 → 首轮之后零探测，请求头不因探测反复而漂移）：trivial →
//        能力含 'off' 选 'off'，否则含 'low' 选 'low'，否则留适配器默认；
//        deep → 能力含 'max' 且 maxTokens > 8192 选 'max'，否则留适配器
//        默认；standard / 无 profile → 留适配器默认。绝不发送能力表外的
//        effort。红线：不存储 prompt/消息本体（只存派生 {profile, source}），
//        不改 selected tool、不改 provider/model 路由、不改 maxTokens。
//   E.（v5.11.1，2026-08-19）否定感知信号检测：live WSL2 实弹发现机械 child
//        提示词「…只回复 COMPLEXITY-TRIVIAL-DONE。不要分析、不要改文件。」的
//        「不要分析」被弱信号 /分析/ 照常计入 → deepWeakHits=1 顶翻机械
//        trivial 门槛（要求 0）→ standard。修复：深作强/弱信号改经
//        hasActiveSignal 逐个检查命中——命中点前短窗口（12 字符）内出现否定词
//        （中：不要/无需/无须/不必/不用/不需要/勿/禁止；英：do not/don't/not/
//        no need to/without）且否定词与命中点之间无句读断开 → 该命中视为被
//        否定；同一正则只要存在一个主动命中仍算数（「不要分析，只排查」的
//        排查 仍主动）。机械信号检测保持 .test 原样（保守取向：机械误命中
//        只是没省思考，不会关错）。
//
// 不干预的路径：
//   - 主会话：options 无 subagentDepth 标记 → 跳过；且其请求配置已带显式 effort；
//   - kix-route 哨兵子代理（model 形如 kix-route:<tier>，即 cross/vision/
//     thinker 档）：路由与 effort 由 kix-route 全权处理（deepseek 改写后复用
//     本文件的 decideEffort，规则同源不复制）；
//   - 能力表不可得的非 deepseek 路由（探测抛错 / 无 reasoning.efforts /
//     llm 服务缺失 / config 路由不完整）：GLM 思考由适配器管理，不注入
//     effort（能力表支持 off/low/max 时的注入见上文 D，standard / 无 profile
//     同样不注入）；
//   - 会话级已显式选择 effort 的任何 agent：已存在 reasoningEffort → 跳过。
//
// 挂载方式：preset agent.cordis.yml 一行：
//   - id: kix-cost
//     name: ./plugins/kix-cost.js
// （与 kix-guards 同形态：CommonJS，loader 只读 name/inject/apply。）
//
// 纯逻辑导出：module.exports.__internals 供单元测试（kix-cost.test.js）。

'use strict'

const HEAVY_MAXTOKENS = 98304   // thinker 行预算帽阈值（≥ → max）
const LITE_MAXTOKENS = 8192     // lite 行预算帽（≤ → 机械档，需自动选型探测）
const HEAVY_EFFORT = 'max'
const CHILD_EFFORT = 'high'
const TRIVIAL_EFFORT = 'off'     // v5.11：高置信机械活 → 关思考（deepseek 直发；非 deepseek 需能力表含 off）
const LOW_EFFORT = 'low'         // v5.11：非 deepseek 能力门控次选降档（能力表无 off 时用 low）
// kix-route 哨兵前缀（与 kix-route.js 的 SENTINEL_PREFIX 同值；不 require 引入
// 是为了避免 cost→route 的运行时依赖方向。kix-route.test.js 断言两处一致，
// 前缀一旦变更测试当场翻红）。
const KIX_ROUTE_SENTINEL_PREFIX = 'kix-route:'

// ── 纯判定函数（模块级：单元测试经 __internals 直接验证）───────────────

/** deepseek 子代理按预算帽决定 effort；非 deepseek 返回 undefined（适配器自管）。 */
function decideEffort(provider, maxTokens) {
  if (provider !== 'deepseek-official') return undefined
  return (maxTokens ?? 0) >= HEAVY_MAXTOKENS ? HEAVY_EFFORT : CHILD_EFFORT
}

/**
 * v5.11 能力门控：从 llm.resolveModelInfo 的能力表提取 reasoning.efforts 的
 * id 字符串数组（条目形如 {id:'off',...}，裸字符串条目也收）。缺
 * reasoning.efforts / 非数组 / modelInfo 为空 → []（等价「无能力」，调用方
 * 照缓存 → 适配器自管）。
 */
function effortIdsOf(modelInfo) {
  const efforts = modelInfo && modelInfo.reasoning && modelInfo.reasoning.efforts
  if (!Array.isArray(efforts)) return []
  const ids = []
  for (const item of efforts) {
    if (typeof item === 'string') ids.push(item)
    else if (item !== null && typeof item === 'object' && typeof item.id === 'string') ids.push(item.id)
  }
  return ids
}

/** 是否为子代理（resolveChildAgentOptions 给 options 打 subagentDepth ≥ 1）。 */
function isSubagentChild(opts) {
  return (opts?.subagentDepth ?? 0) >= 1
}

/** 是否为轻量子代理（预算帽 ≤ 8K → 机械档，需自动选型）。 */
function isLiteTier(opts) {
  return (opts?.maxTokens ?? 0) <= LITE_MAXTOKENS
}

// ── v5.11 复杂度感知 effort：零 token 分类器（纯函数，无 LLM 调用）──────────
//
// 输入：子代理初始 prompt 的叶子文本（agent/pre-step 首个被接受步的 claimed
// messages 递归取叶子 text）。输出只含派生结论 {profile, source}——原文/消息
// 对象绝不落入任何缓存（「不存储 prompt/live messages」红线）。
//
// 保守取向：误判代价不对称——深活误判 trivial 关掉思考，代价远大于机械活
// 没省下思考。因此优先级：显式 `complexity:` 标记 > 深作信号（任一强信号或
// ≥2 弱信号 → deep）> 机械信号（机械命中 + 零深作信号 + 非空且 ≤480 字符 →
// trivial），其余一律 standard。超长文本一律不判 trivial（保守上限）。

// 显式标记：英文 `complexity:` 与中文 `复杂度：`，半角/全角冒号与等号均可；
// 档位值仍为英文 trivial|standard|deep（中文 prompt 照样能携带英文档位词）。
const COMPLEXITY_MARKER_RE = /(?:complexity|复杂度)\s*[:=＝：]\s*["']?\s*(trivial|standard|deep)\b/i
const TRIVIAL_MAX_CHARS = 480

// 强深作信号：任一命中即 deep（根因/架构/端到端/全面/深潜/设计并实现/安全
// 审计/多文件多阶段——这些词几乎不出现在机械活里）。中文条目与英文逐条
// 对应（第 i 条中文 = 第 i 条英文的等义表达），保证计数语义跨语言一致。
const DEEP_STRONG_RES = [
  /root\s*cause/i,
  /architect(?:ure|ural)?\b/i,
  /end[\s-]?to[\s-]?end/i,
  /comprehensive|exhaustive|thorough/i,
  /\bdeep(?:ly)?\s+(?:analy[sz]e|dive|investigat\w*)/i,
  /design\s+(?:and|&)\s+(?:implement|build|propose)/i,
  /security\s+audit/i,
  /multi[\s-]?(?:file|step|phase|part)/i,
  // 中文强信号（与上面逐条对应）
  /根本原因|根因/,
  /架构/,
  /端到端/,
  /全面|彻底|详尽/,
  /深入(?:分析|调查|排查|挖掘)|深挖/,
  /设计(?:并|与|和)(?:实现|构建|提出)/,
  /安全审计/,
  /多(?:文件|步|阶段|部分)/,
]
// 弱深作信号：单独出现不足以判定（"analyze this" 可能很小），≥2 个才 deep。
// 中文条目同样逐条对应英文分组（如 优化|性能 同属一条——英文 optimize/
// performance 也同属一条，"优化性能" 只计 1 个弱命中，不误升 deep）。
const DEEP_WEAK_RES = [
  /analy[sz]e|investigat\w*|diagnos\w*/i,
  /refactor/i,
  /migrat\w*/i,
  /optimi[sz]e|performance/i,
  /trade[\s-]?offs?/i,
  /benchmark|strateg\w*|roadmap/i,
  /\breview\b/i,
  /debug/i,
  // 中文弱信号（与上面逐条对应）
  /分析|排查|诊断|调查/,
  /重构/,
  /迁移/,
  /优化|性能/,
  /权衡|取舍/,
  /基准测试|策略|路线图/,
  /评审|审查|复盘/,
  /调试/,
]
// 机械信号：改 typo/重命名/格式化/计数/列举/替换类；命中且无任何深作信号
// 才可能 trivial。中文条目同样保守取向（如 检查/验证 不入列——对应英文
// verify/check 也不在任何机械正则里，普通核对活走 standard）。
// v5.11 补充（子代理账本实测的高置信短读取/收集活）：读取/收集/记录标记
// 类 + 独立词 cat（\b 边界，不吞 category 等词）；泛化 检查/验证 仍不入列，
// 只让账本里的机械 E2E 提示词命中 trivial→off，避免宽面误报。
const MECHANICAL_RES = [
  /fix\s+(?:the\s+)?typo|misspell\w*|spelling/i,
  /\brename\b/i,
  /prettier|indentation|whitespace|format(?:ting)?\s+(?:the\s+)?(?:code|file|document|line)/i,
  /\blint(?:er)?\s+(?:fix|errors?|issues?)/i,
  /\bgrep\b|\bsearch\s+for\s+(?:all\s+)?occurrences/i,
  /\bcount\b|\bhow\s+many\b|\bsum\b|\btotal\b/i,
  /list\s+(?:all\s+)?(?:the\s+)?(?:files?|items?|entries|dependencies|symbols?|todos?)/i,
  /replace\s+(?:all\s+)?(?:the\s+)?/i,
  /word\s+count|line\s+count|character\s+count/i,
  /convert\s+(?:the\s+)?case/i,
  /one[\s-]?(?:liner|line\s+answer|word)/i,
  // 中文机械信号（与上面逐条对应）
  /错别字|错字|笔误|拼写错误/,
  /重命名/,
  /prettier|缩进|空白符|格式化[一这那]?[段个]?(?:代码|文件|文档|行)/i,
  /\blint(?:er)?\s*(?:修复|错误|问题)/i,
  /\bgrep\b|(?:搜索|查找)[^。\n\r]{0,12}(?:出现|匹配)/,
  /统计|多少|总数|合计/,
  /(?:列出|列举)[^。\n\r]{0,12}(?:文件|条目|项|依赖|符号|待办|清单)/,
  /替换/,
  /字数|行数|字符数/,
  /转换大小写|大小写转换/,
  /一句话(?:回答|概括|总结|描述)?|一个词(?:回答|概括|总结|描述)?/,
  // v5.11 补充（账本实测短读取/收集活；cat 为独立词，\b 不吞 category）
  /读取文件|读取内容|收集标记|记录标记|核对标记/,
  /\bcat\b/i,
]

// v5.11.1 否定感知：否定语境里的深作信号不算数（否则「不要分析」这类机械
// child 提示词被弱信号顶翻 trivial 门槛）。窗口 = 命中点向前 12 字符；否定词
// 与命中点之间隔着句读（。．.；;，,、!！?？换行）即视为跨句——否定只约束
// 自己紧邻的信号，不外溢到后面靠自己的主动命中。中文否定词逐字对应英文
// 否定词（\b 词界防 notify/rotation 类词内误吞）。
const NEGATION_WINDOW = 12
const NEGATION_RES = [
  /不需要|不要|无需|无须|不必|不用|勿|禁止/,
  /\b(?:do\s+not|don['’]?t|not|no\s+need\s+to|without)\b/i,
]
const NEGATION_BREAK_RE = /[。．.；;，,、!！?？\n\r]/

/** 克隆全局版正则（自持 lastIndex，绝不污染调用方或共享状态）。 */
function globalOf(re) {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
}

/** 信号命中点（s[start] 起）是否被否定：窗口内否定词且与其之间无句读断开。 */
function isNegatedMatch(s, start) {
  const prefix = s.slice(Math.max(0, start - NEGATION_WINDOW), start)
  for (const re of NEGATION_RES) {
    const g = globalOf(re)
    let m
    while ((m = g.exec(prefix)) !== null) {
      if (!NEGATION_BREAK_RE.test(prefix.slice(m.index + m[0].length))) return true
    }
  }
  return false
}

/**
 * v5.11.1 否定感知信号检测（纯函数）：逐个检查 re 在 s 中的**每一次**命中，
 * 任一命中未被否定（主动命中）即 true；全部命中被否定或零命中 → false。
 * 同一正则组内靠后的主动命中仍计数——「不要分析，只排查」的 排查 是主动的。
 */
function hasActiveSignal(re, s) {
  if (typeof s !== 'string' || s.length === 0) return false
  const g = globalOf(re)
  let m
  while ((m = g.exec(s)) !== null) {
    if (m[0].length === 0) { g.lastIndex++; continue } // 防零宽命中死循环（防御性）
    if (!isNegatedMatch(s, m.index)) return true
  }
  return false
}

/** 递归收集消息内容块的叶子文本（只读遍历，不保留任何引用）。 */
function leafTextOf(messages) {
  let out = ''
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') { out += node + '\n'; return }
    if (typeof node !== 'object') return
    if (typeof node.text === 'string') { out += node.text + '\n'; return }
    if (Array.isArray(node.content)) { for (const child of node.content) walk(child) }
  }
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (msg === null || typeof msg !== 'object') continue
      if (typeof msg.content === 'string') out += msg.content + '\n'
      else walk(msg)
    }
  }
  return out
}

/**
 * 零 token 复杂度分类：显式 marker > 深作信号 > 机械信号 > standard（保守）。
 * 深作强/弱信号均经 hasActiveSignal 否定感知（被否定的命中不计数）；
 * 机械信号保持 .test 原样。返回 {profile: 'trivial'|'standard'|'deep',
 * source: 'marker'|'inferred'}。
 */
function classifyComplexity(text) {
  const s = typeof text === 'string' ? text : ''
  const marker = s.match(COMPLEXITY_MARKER_RE)
  if (marker) return { profile: marker[1].toLowerCase(), source: 'marker' }
  const deepStrong = DEEP_STRONG_RES.some((re) => hasActiveSignal(re, s))
  const deepWeakHits = DEEP_WEAK_RES.filter((re) => hasActiveSignal(re, s)).length
  if (deepStrong || deepWeakHits >= 2) return { profile: 'deep', source: 'inferred' }
  const trimmed = s.trim()
  if (
    trimmed.length > 0 && trimmed.length <= TRIVIAL_MAX_CHARS
    && MECHANICAL_RES.some((re) => re.test(s)) && deepWeakHits === 0
  ) {
    return { profile: 'trivial', source: 'inferred' }
  }
  return { profile: 'standard', source: 'inferred' }
}

/**
 * v5.11 复杂度感知 effort（「无显式 reasoningEffort + 非哨兵路由」两个前置由
 * agent/request 监听器的既有早退保证）：
 *   · deepseek（逐字原行为，不看能力表）：trivial → 'off'；deep → 普通行
 *     （>8192 帽且原本 high）升 'max'，lite 行（≤8192 帽）永不升 max；
 *     standard / 无 profile → decideEffort 原行为（off/high/max）。
 *   · 非 deepseek（v5.11 能力门控，仅当 supportedEfforts 为数组才适配——
 *     即调用方已按 agent/model 解析过能力表）：trivial → 能力含 'off' 选
 *     'off'，否则含 'low' 选 'low'，否则 undefined；deep → maxTokens > 8192
 *     且能力含 'max' 才选 'max'，否则 undefined；standard / 无 profile /
 *     无能力数组（未探测 / 探测失败缓存 []）→ undefined（适配器自管，行为
 *     不变）。绝不返回能力表外的 effort。
 */
function adaptiveEffort(entry, provider, maxTokens, supportedEfforts) {
  if (provider !== 'deepseek-official') {
    if (!Array.isArray(supportedEfforts)) return undefined
    const profile = entry && entry.profile
    if (profile === 'trivial') {
      if (supportedEfforts.includes(TRIVIAL_EFFORT)) return TRIVIAL_EFFORT
      if (supportedEfforts.includes(LOW_EFFORT)) return LOW_EFFORT
      return undefined
    }
    if (profile === 'deep' && (maxTokens ?? 0) > LITE_MAXTOKENS && supportedEfforts.includes(HEAVY_EFFORT)) {
      return HEAVY_EFFORT
    }
    return undefined
  }
  const base = decideEffort(provider, maxTokens)
  const profile = entry && entry.profile
  if (profile === 'trivial') return TRIVIAL_EFFORT
  if (profile === 'deep' && base === CHILD_EFFORT && (maxTokens ?? 0) > LITE_MAXTOKENS) {
    return HEAVY_EFFORT
  }
  return base
}

// v5.10（2026-08-17 子代理账本实测）：40/107 个子代理尝试过再分派（50 次
// subagent/subagent_cross 调用）——「编排留主线程」（kix 地板②）此前只有
// persona 说教。静态 toolFilter.deny 覆盖恒注册名；本 guard 兜底**条件挂载**
// 的名字（subagent_dev/qa/reviewer/lite/thinker/vision/fork、workflow——主
// 线程激活后对子代理可见）。判定纯机械（subagentDepth ≥ 1 + 名字模式），
// 0% 误报；kix_capability_call 从子代理代理调用细分档位时，内部 tools.execute
// 携同一 child agent → 同样被拦，代理结果诚实带回 deny 理由。
const CHILD_ORCHESTRATION_RE = /^(?:subagent(?:_|$)|workflow$)/
const CHILD_ORCHESTRATION_DENY_REASON =
  'kix-cost: 编排留主线程（kix 地板②）——子代理不得再分派子代理或起 workflow。需要编排/并行分派的部分写进你的 report 交主线程决策。'

/** 子代理发起的编排类调用（再分派/workflow）→ 应拒绝。 */
function isChildOrchestrationCall(name, opts) {
  const n = String(name || '')
  return isSubagentChild(opts) && CHILD_ORCHESTRATION_RE.test(n)
}

/**
 * 探测首选路由是否可用：provider 已注册适配器 + 模型可解析。
 * 任何异常（未知 provider/模型、探测失败）→ false（触发回退）。
 */
async function probeRoute(llm, provider, model, signal) {
  try {
    const providers = llm.listProviders()
    // listProviders 条目为 {id, name}：id 是路由键，name 是显示名（不可当键用）
    const known = providers.some((p) => (p.id ?? p.provider) === provider)
    if (!known) return false
    await llm.resolveModelInfo(provider, model, signal)
    return true
  } catch {
    return false
  }
}

// ── 插件本体 ────────────────────────────────────────────────────────────────

module.exports = {
  name: 'kix-cost',
  inject: ['tools'],
  apply(ctx) {
    // v5.10 child guard：tools.guard 是单调守卫（pre-execute 瀑布后、同步判定）。
    // 注册在 preset 层 = 对挂载下的所有 agent 生效；谓词只对 child 生效。
    // inject 声明 'tools'（Cordis：ctx 属性访问必须 inject；ctx.get 不需要），
    // 运行时再防御式探测（单元测试裸 mock 无 tools 服务 → 跳过 guard，
    // effort 分层照常——guard 是编排面收窄的兜底，不是前置依赖）。
    const toolsSvc = ctx.get('tools')
    if (toolsSvc !== undefined && typeof toolsSvc.guard === 'function') {
      toolsSvc.guard((exec) => {
        const name = exec && exec.name
        const opts = exec && exec.agent && exec.agent.options
        if (isChildOrchestrationCall(name, opts)) return CHILD_ORCHESTRATION_DENY_REASON
        return undefined
      })
    }

    // 探测结果缓存：agent -> {ok:true} | {ok:false, fallbackRoute?}（WeakMap
    // 无泄漏；fallbackRoute 含 provider/model/reasoningEffort，后续轮次直接应用）
    const probes = new WeakMap()

    // v5.11 复杂度 profile 缓存：agent -> {profile, source}（WeakMap 无泄漏；
    // 只存派生结论，原文/消息对象绝不入缓存）。每 agent 在首个**被接受**的
    // pre-step 上算一次——拒绝步的输入会被丢弃并在下一回合重新 claim，仍能
    // 采到初始 prompt；此后任何 pre-step/请求都不改写（请求头/前缀缓存稳定）。
    // 主会话（无 subagentDepth 标记）不画像 = 无 profile = 旧行为。
    const profiles = new WeakMap()

    // v5.11 能力门控缓存：agent -> Map<路由键, effort id 数组>（WeakMap 无
    // 泄漏；路由键 = provider + '\u0000' + model，值只存自有 effort id 字符串，
    // 绝不存 modelInfo 对象 / prompt）。每 agent/model 只调一次
    // resolveModelInfo——探测抛错 / 无 reasoning.efforts 同样缓存（[]），
    // 首轮之后零探测，请求头不因探测反复而漂移。
    const effortCaps = new WeakMap()
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        const agent = payload && payload.agent
        if (agent === undefined || profiles.has(agent)) return decision
        // 只有被接受的步才采样（kind === 'reject' = 该步输入被丢弃）
        if (decision === undefined || decision.kind === 'reject') return decision
        if (!isSubagentChild(agent.options ?? {})) return decision
        profiles.set(agent, classifyComplexity(leafTextOf(payload && payload.messages)))
      } catch {
        // 分类器永不影响步进流程；任何异常 = 无 profile = 旧 effort 行为
      }
      return decision
    })

    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      if (resolved === undefined) return resolved
      // 已有显式 effort（主会话 selection / 会话级选择 / 其他插件）→ 不干预
      if (resolved.reasoningEffort !== undefined) return resolved
      const agent = payload.agent
      if (agent === undefined) return resolved
      const opts = agent.options ?? {}
      // 只作用于子代理
      if (!isSubagentChild(opts)) return resolved
      // kix-route 哨兵子代理（model 形如 kix-route:<tier>）由 kix-route 全权
      // 解析路由并注入 effort（deepseek 改写后复用本文件导出的 decideEffort）。
      // 此处跳过，保证两个监听器在任意 waterfall 注册顺序下结果一致：
      // 本插件先见哨兵 → 跳过；后见改写结果 → effort 已存在同样跳过。
      if (typeof resolved.model === 'string' && resolved.model.startsWith(KIX_ROUTE_SENTINEL_PREFIX)) return resolved

      let config = resolved
      const llm = ctx.get('llm')

      // A. 机械档自动选型：首选路由不可用 → 回退环境默认路由。
      // 2026-08-17 修复（外部审查 5.6 发现 + 源码复核确认）：旧实现只缓存
      // 'ok'|'fallback' 标签不缓存回退路由——第二轮请求 probes.get(agent)
      // 已非 undefined，跳过整个探测块，config=resolved 回到不可用的首选
      // 路由（zai-coding-cn/glm-4.7），子代理第二轮请求即失败。修复：缓存
      // 回退路由本身，之后每轮直接应用（探测仍每子代理一次）。
      if (isLiteTier(opts) && llm !== undefined) {
        const cached = probes.get(agent)
        if (cached && cached.fallbackRoute) {
          // 已探测且需要回退：每轮应用缓存的回退路由（首轮由下方探测块写入）
          config = {
            ...config,
            provider: cached.fallbackRoute.provider,
            model: cached.fallbackRoute.model,
            ...(cached.fallbackRoute.reasoningEffort === undefined ? {} : { reasoningEffort: cached.fallbackRoute.reasoningEffort }),
          }
        } else if (cached === undefined) {
          let usable = false
          try {
            usable = await probeRoute(llm, config.provider, config.model, payload.signal)
          } catch {
            usable = false
          }
          if (usable) {
            probes.set(agent, { ok: true })
          } else {
            const defaults = ctx.get('agentDefaultModel')
            const sel = defaults !== undefined ? defaults.currentSelection() : undefined
            if (sel !== undefined && sel.provider && sel.model) {
              const fallbackRoute = {
                provider: sel.provider,
                model: sel.model,
                reasoningEffort: sel.reasoningEffort,
              }
              probes.set(agent, { ok: false, fallbackRoute })
              config = {
                ...config,
                provider: fallbackRoute.provider,
                model: fallbackRoute.model,
                ...(fallbackRoute.reasoningEffort === undefined ? {} : { reasoningEffort: fallbackRoute.reasoningEffort }),
              }
            } else {
              // 环境默认路由也不可得：只缓存探测结果，不改写（保持首选路由，
              // 由适配器响亮报错，不静默降级到未知路由）
              probes.set(agent, { ok: false })
            }
          }
        }
        // cached 为 {ok:true} → 首选路由可用，不改写
      }

      // B. 思考强度分层 + v5.11 复杂度感知。deepseek 子代理（含回退后仍为
      // deepseek 的情况）：无 profile / standard → decideEffort 逐字原行为；
      // trivial → off、deep → 普通行升 max（lite 行永不 max）。非 deepseek
      // 子代理（v5.11 能力门控）：仅 profile 为 trivial/deep 且 config 路由
      // 完整（provider/model 均字符串）时，按 agent/model 经 effortCaps 解析
      // 一次能力表（llm.resolveModelInfo；抛错 / 无 reasoning.efforts →
      // 缓存 [] = 无能力），再把 ids 交 adaptiveEffort 判档。只补
      // reasoningEffort，不动 provider/model/maxTokens。
      if (config.reasoningEffort === undefined) {
        const entry = profiles.get(agent)
        const profile = entry && entry.profile
        let supported
        if (
          (profile === 'trivial' || profile === 'deep')
          && config.provider !== 'deepseek-official'
          && typeof config.provider === 'string' && typeof config.model === 'string'
          && llm !== undefined
        ) {
          const key = config.provider + '\u0000' + config.model
          let byRoute = effortCaps.get(agent)
          if (byRoute === undefined) { byRoute = new Map(); effortCaps.set(agent, byRoute) }
          if (!byRoute.has(key)) {
            let ids = []
            try {
              ids = effortIdsOf(await llm.resolveModelInfo(config.provider, config.model, payload.signal))
            } catch {
              // 探测失败同样缓存 []：首轮之后零探测，行为回落适配器自管
              ids = []
            }
            byRoute.set(key, ids)
          }
          supported = byRoute.get(key)
        }
        const effort = adaptiveEffort(entry, config.provider, config.maxTokens, supported)
        if (effort !== undefined) config = { ...config, reasoningEffort: effort }
      }
      return config
    })
  },
}

module.exports.__internals = { KIX_ROUTE_SENTINEL_PREFIX, decideEffort, effortIdsOf, isSubagentChild, isLiteTier, probeRoute, isChildOrchestrationCall, CHILD_ORCHESTRATION_DENY_REASON, leafTextOf, classifyComplexity, adaptiveEffort, hasActiveSignal }
