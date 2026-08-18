// kix-cost 回归测试（v5.11，2026-08-18；能力门控跨厂商适配；v5.11.1，2026-08-19 否定感知信号）
//
// 单元级验证：加载 kix-cost.js，mock cordis ctx（on/effect/get）与 llm 服务，
// 覆盖：档位注入（medium/max/非 deepseek 跳过）、子代理判别、lite 自动选型
// （可用 → 保留；不可用 → 回退默认路由）、显式 effort 不干预；v5.11 复杂度
// 分类器（trivial/standard/deep + 显式 marker，中英双语正则与全角冒号/等号
// marker）与 pre-step 画像 → 请求注入（机械→off / 深作→max / standard→原
// 行为 / 无画像旧行为 / lite 永不 max / 画像首接受步定格 / 拒绝步不采样）；
// v5.11 能力门控（effortIdsOf 纯逻辑、adaptiveEffort 直测 ZAI 支持/不支持
// 档位、mock ZAI glm-5.2 能力表集成：trivial→off / deep→max / 每 agent/model
// 只解析一次 / 无 reasoning.efforts 配置原样 / 探测抛错缓存 []）；v5.11.1
// 否定感知信号（hasActiveSignal 直测中英否定词、句读断开不外溢、同组后续
// 主动命中仍计数；live WSL2 实弹机械 child 提示词与否定分析+机械读取/记录
// → trivial，主动分析保持 standard，否定强信号不升 deep）。
// 运行：node plugins/kix-cost.test.js
//
// 注意：本测试模拟的是"监听器被 DSH 调用"后的决策逻辑；
// 运行时"监听器确实被挂载"的端到端验证需在新会话执行
// （新会话 1 分钟验证流程见 kix-optimization-implementation.md §五）。

const path = require('node:path')
const assert = require('node:assert')

// ── mock ctx ────────────────────────────────────────────────────────────────
const listeners = {}
const services = {}
const guards = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  on(event, cb) {
    ;(listeners[event] ||= []).push(cb)
  },
  get(name) {
    return services[name]
  },
  tools: {
    guard(fn) { guards.push(fn); return () => {} },
  },
}

// ── 加载被测试插件 ────────────────────────────────────────────────────────
services.tools = { guard: (fn) => guards.push(fn), restrict: () => () => {} }
const plugin = require(path.join(__dirname, 'kix-cost.js'))
assert.strictEqual(plugin.name, 'kix-cost')
plugin.apply(ctx)
const onRequest = listeners['agent/request']
assert.ok(Array.isArray(onRequest) && onRequest.length === 1, 'agent/request 监听器已注册')

const { decideEffort, effortIdsOf, isSubagentChild, isLiteTier, probeRoute, isChildOrchestrationCall, leafTextOf, classifyComplexity, adaptiveEffort, hasActiveSignal } = plugin.__internals
assert.ok(guards.length === 1, 'tools.guard 已注册（v5.10 child guard）')
const onPreStep = listeners['agent/pre-step']
assert.ok(Array.isArray(onPreStep) && onPreStep.length === 1, 'agent/pre-step 监听器已注册（v5.11 复杂度画像）')

// ── mock llm / agentDefaultModel ────────────────────────────────────────────
const zaiProviders = [{ provider: 'zai-coding-cn' }, { provider: 'deepseek-official' }]
const llm = {
  listProviders: () => zaiProviders,
  resolveModelInfo: async (provider, model) => {
    if (provider === 'zai-coding-cn' && model === 'glm-4.7') return {}
    if (provider === 'deepseek-official' && model === 'deepseek-v4-flash') return {}
    throw new Error('unknown model: ' + provider + '/' + model)
  },
}
const defaults = { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }) }
services.llm = llm
services.agentDefaultModel = defaults

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++; console.log('  ✓ ' + label) }
  else { failed++; console.log('  ✗ ' + label) }
}

// ── 纯逻辑 ────────────────────────────────────────────────────────────────
console.log('== 纯判定 ==')
check('decideEffort: deepseek 64K → high', decideEffort('deepseek-official', 65536) === 'high')
check('decideEffort: deepseek 128K → max', decideEffort('deepseek-official', 131072) === 'max')
check('decideEffort: deepseek 98K 阈值 → max', decideEffort('deepseek-official', 98304) === 'max')
check('decideEffort: zai → undefined（适配器自管）', decideEffort('zai-coding-cn', 8192) === undefined)
check('decideEffort: deepseek 无预算 → high', decideEffort('deepseek-official', undefined) === 'high')
check('isSubagentChild: depth 1 → true', isSubagentChild({ subagentDepth: 1 }) === true)
check('isSubagentChild: depth 0 → false', isSubagentChild({ subagentDepth: 0 }) === false)
check('isSubagentChild: 主会话无字段 → false', isSubagentChild({}) === false)
check('isLiteTier: 8K → true', isLiteTier({ maxTokens: 8192 }) === true)
check('isLiteTier: 64K → false', isLiteTier({ maxTokens: 65536 }) === false)
check('isLiteTier: 无预算 → true（默认机械档）', isLiteTier({}) === true)

// ── v5.10 child guard（编排留主线程）────────────────────────────────────────
console.log('== child guard ==')
const childOpts = { subagentDepth: 1, maxTokens: 65536 }
const mainOpts = { subagentDepth: 0 }
check('child 调 subagent → 拒绝', isChildOrchestrationCall('subagent', childOpts) === true)
check('child 调 subagent_cross → 拒绝', isChildOrchestrationCall('subagent_cross', childOpts) === true)
check('child 调 subagent_dev（条件挂载名）→ 拒绝', isChildOrchestrationCall('subagent_dev', childOpts) === true)
check('child 调 workflow → 拒绝', isChildOrchestrationCall('workflow', childOpts) === true)
check('child 调 read → 放行', isChildOrchestrationCall('read', childOpts) === false)
check('child 调 bash → 放行', isChildOrchestrationCall('bash', childOpts) === false)
check('child 调 report → 放行（结算通道）', isChildOrchestrationCall('report', childOpts) === false)
check('child 调 kix_capability_call → 放行（MCP 逃逸口）', isChildOrchestrationCall('kix_capability_call', childOpts) === false)
check('主会话调 subagent → 放行（编排职责所在）', isChildOrchestrationCall('subagent', mainOpts) === false)
check('guard 谓词注册且只 deny child 编排调用', (() => {
  const g = guards[0]
  return g({ name: 'subagent', agent: { options: childOpts } }) !== undefined
    && g({ name: 'subagent', agent: { options: mainOpts } }) === undefined
    && g({ name: 'read', agent: { options: childOpts } }) === undefined
    && g({ name: 'subagent', agent: undefined }) === undefined
})())

// ── 派发模拟 ───────────────────────────────────────────────────────────────
async function dispatch(payload, seed) {
  return onRequest[0](payload, async () => seed)
}

// v5.11：模拟 pre-step（真实监听器先 await next() 再旁路采样；next 返回
// PreStepDecision，默认 enter = 被接受）。msg 构造叶子文本块。
const msg = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
async function prestep(agent, messages, decision) {
  return onPreStep[0]({ agent, messages, turn: 1, step: 1, signal: undefined }, async () => decision ?? { kind: 'enter', messages })
}

async function main() {
  console.log('== 派发 ==')

  // 1. 主会话：无 subagentDepth → 不干预（即使无显式 effort）
  let r = await dispatch({ agent: { options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, signal: new AbortController().signal }, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  check('主会话无 effort → 原样返回（不注入）', r.reasoningEffort === undefined)

  // 2. 普通子代理（deepseek 64K）：注入 high（默认档）
  r = await dispatch({ agent: { options: { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 65536, subagentDepth: 1 } }, signal: new AbortController().signal }, { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 65536 })
  check('普通子代理 → reasoningEffort high', r.reasoningEffort === 'high')

  // 3. thinker 子代理（deepseek 128K）：注入 max
  r = await dispatch({ agent: { options: { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 131072, subagentDepth: 1 } }, signal: new AbortController().signal }, { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 131072 })
  check('thinker 子代理 → reasoningEffort max', r.reasoningEffort === 'max')

  // 4. 显式 effort 存在 → 不干预
  r = await dispatch({ agent: { options: { provider: 'deepseek-official', model: 'deepseek-v4-flash', subagentDepth: 1 } }, signal: new AbortController().signal }, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' })
  check('显式 effort max → 原样保留', r.reasoningEffort === 'max')

  // 5. cross 子代理（zai 64K）：不注入
  r = await dispatch({ agent: { options: { provider: 'zai-coding-cn', model: 'glm-5.3', maxTokens: 65536, subagentDepth: 1 } }, signal: new AbortController().signal }, { provider: 'zai-coding-cn', model: 'glm-5.3', maxTokens: 65536 })
  check('cross 子代理 → 不注入 effort', r.reasoningEffort === undefined && r.provider === 'zai-coding-cn')

  // 6. lite 子代理（zai 8K），路由可用 → 保留 + 不注入
  const liteOkAgent = { options: { provider: 'zai-coding-cn', model: 'glm-4.7', maxTokens: 8192, subagentDepth: 1 } }
  r = await dispatch({ agent: liteOkAgent, signal: new AbortController().signal }, { provider: 'zai-coding-cn', model: 'glm-4.7', maxTokens: 8192 })
  check('lite 路由可用 → 保留 zai/glm-4.7', r.provider === 'zai-coding-cn' && r.model === 'glm-4.7' && r.reasoningEffort === undefined)

  // 7. lite 子代理（zai 8K），路由不可用 → 回退默认路由 + 默认档 effort
  const liteBadAgent = { options: { provider: 'zai-coding-cn', model: 'glm-4.7', maxTokens: 8192, subagentDepth: 1 } }
  const badLlm = {
    listProviders: () => [{ provider: 'deepseek-official' }], // 无 zai
    resolveModelInfo: async () => { throw new Error('no adapter') },
  }
  services.llm = badLlm
  r = await dispatch({ agent: liteBadAgent, signal: new AbortController().signal }, { provider: 'zai-coding-cn', model: 'glm-4.7', maxTokens: 8192 })
  check('lite 路由不可用 → 回退 deepseek-official/deepseek-v4-flash', r.provider === 'deepseek-official' && r.model === 'deepseek-v4-flash')
  check('lite 回退后 → reasoningEffort high（环境默认 high）', r.reasoningEffort === 'high')

  // 7b. lite 回退且环境默认无 effort → 档位注入 high（用新 agent 对象避开探测缓存）
  const defaultsNoEffort = { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) }
  services.agentDefaultModel = defaultsNoEffort
  r = await dispatch({ agent: { options: { provider: 'zai-coding-cn', model: 'glm-4.7', maxTokens: 8192, subagentDepth: 1 } }, signal: new AbortController().signal }, { provider: 'zai-coding-cn', model: 'glm-4.7', maxTokens: 8192 })
  check('lite 回退后（默认无 effort）→ 注入 high', r.reasoningEffort === 'high')
  services.agentDefaultModel = defaults
  services.llm = llm

  // 8. lite 子代理，llm 服务缺失 → 保留配置（不探测不回退）
  services.llm = undefined
  r = await dispatch({ agent: liteBadAgent, signal: new AbortController().signal }, { provider: 'zai-coding-cn', model: 'glm-4.7', maxTokens: 8192 })
  check('llm 缺失 → 保留首选路由', r.provider === 'zai-coding-cn' && r.model === 'glm-4.7')
  services.llm = llm

  // 8b. 2026-08-17 修复回归（外部审查 5.6 发现 + 源码复核确认）：lite 回退后
  // 同一子代理的第二轮请求必须保持回退路由。旧实现只缓存 'fallback' 标签，
  // 第二轮跳过探测块 → config=resolved 回到不可用的 zai/glm-4.7 → 请求失败。
  const liteMultiAgent = { options: { provider: 'zai-coding-cn', model: 'glm-4.7', maxTokens: 8192, subagentDepth: 1 } }
  const badLlm2 = {
    listProviders: () => [{ provider: 'deepseek-official' }], // 无 zai → 首选路由不可用
    resolveModelInfo: async (p, m) => {
      if (p === 'deepseek-official' && m === 'deepseek-v4-flash') return {}
      throw new Error('unknown model')
    },
  }
  services.llm = badLlm2
  services.agentDefaultModel = { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) }
  const seedRoute = { provider: 'zai-coding-cn', model: 'glm-4.7', maxTokens: 8192 }
  r = await dispatch({ agent: liteMultiAgent, signal: new AbortController().signal }, seedRoute)
  check('lite 多轮①首轮回退 → deepseek-official', r.provider === 'deepseek-official' && r.model === 'deepseek-v4-flash')
  // 关键断言：第二轮（同 agent、同 seed 首选路由）必须仍应用回退路由
  r = await dispatch({ agent: liteMultiAgent, signal: new AbortController().signal }, seedRoute)
  check('lite 多轮②第二轮保持回退路由（旧 bug：回到不可用 zai/glm-4.7）', r.provider === 'deepseek-official' && r.model === 'deepseek-v4-flash')
  r = await dispatch({ agent: liteMultiAgent, signal: new AbortController().signal }, seedRoute)
  check('lite 多轮③第三轮保持回退路由', r.provider === 'deepseek-official' && r.model === 'deepseek-v4-flash')
  // 首选路由可用场景的多轮：缓存 {ok:true} → 第二轮不改写
  const liteOkMulti = { options: { provider: 'zai-coding-cn', model: 'glm-4.7', maxTokens: 8192, subagentDepth: 1 } }
  services.llm = llm
  const okSeed = { provider: 'zai-coding-cn', model: 'glm-4.7', maxTokens: 8192 }
  r = await dispatch({ agent: liteOkMulti, signal: new AbortController().signal }, okSeed)
  const r2 = await dispatch({ agent: liteOkMulti, signal: new AbortController().signal }, okSeed)
  check('lite 可用多轮 → 两轮均保留首选路由', r.provider === 'zai-coding-cn' && r2.provider === 'zai-coding-cn')
  services.agentDefaultModel = defaults
  services.llm = llm

  // 9. probeRoute 纯函数
  check('probeRoute: 可用路由 → true', await probeRoute(llm, 'zai-coding-cn', 'glm-4.7', undefined) === true)
  check('probeRoute: 未知模型 → false', await probeRoute(llm, 'zai-coding-cn', 'glm-9.9', undefined) === false)
  check('probeRoute: 未注册 provider → false', await probeRoute(llm, 'openrouter', 'x', undefined) === false)

  // ── v5.11 复杂度分类器（纯逻辑）──────────────────────────────────────────
  console.log('== v5.11 分类器 ==')
  check('分类: 机械短活 → trivial', classifyComplexity('Fix the typo in the README title: kixparadgm → kixparadigm').profile === 'trivial')
  check('分类: 深作（根因+设计）→ deep', classifyComplexity('Investigate the root cause of the flaky test and design a durable fix').profile === 'deep')
  check('分类: 一般任务 → standard（保守）', classifyComplexity('Summarize the changes in this pull request').profile === 'standard')
  check('分类: 空白 → standard', classifyComplexity('   ').profile === 'standard')
  check('分类: 单个弱深作信号 → standard（保守）', classifyComplexity('Analyze this function').profile === 'standard')
  check('分类: 两个弱深作信号 → deep', classifyComplexity('Analyze the module and review the error handling').profile === 'deep')
  check('分类: 长机械描述（>480 字符）→ standard（保守）', classifyComplexity('Fix the typo. ' + 'padding '.repeat(120)).profile === 'standard')
  check('分类: 显式 marker deep 覆盖机械表象 → deep（source=marker）', (() => {
    const c = classifyComplexity('Fix the typo. complexity: deep')
    return c.profile === 'deep' && c.source === 'marker'
  })())
  check('分类: 显式 marker trivial 覆盖深作表象 → trivial', classifyComplexity('Investigate the root cause. complexity:trivial').profile === 'trivial')
  check('分类: 显式 marker standard 覆盖深作表象 → standard', classifyComplexity('Investigate the root cause. complexity = standard').profile === 'standard')
  check('分类: 结果只含派生结论（不存原文）', Object.keys(classifyComplexity('Fix the typo in the README title')).sort().join(',') === 'profile,source')
  // 普通核对活（verify/check）：不命中任何机械/深作正则 → standard（保守）
  check('分类: verify/check 普通核对 → standard', classifyComplexity('Verify the fix works and check the output log').profile === 'standard')
  check('分类(中): 检查/核对普通活 → standard', classifyComplexity('检查配置文件是否加载正确，并核对输出').profile === 'standard')
  // 中文分类（v5.11：深作/机械信号正则中英双语，分组与英文逐条对应）
  check('分类(中): 机械短活（错别字）→ trivial', classifyComplexity('修正 README 标题里的错别字：kixparadgm → kixparadigm').profile === 'trivial')
  check('分类(中): 机械短活（重命名）→ trivial', classifyComplexity('把变量 foo 重命名为 bar').profile === 'trivial')
  check('分类(中): 机械短活（统计）→ trivial', classifyComplexity('统计这个目录下有多少个测试文件').profile === 'trivial')
  check('分类(中): 强深作（根本原因）→ deep', classifyComplexity('排查这个偶发测试失败的根本原因，并给出修复建议').profile === 'deep')
  check('分类(中): 强深作（端到端）→ deep', classifyComplexity('设计并实现一套端到端的鉴权方案').profile === 'deep')
  check('分类(中): 两个弱深作信号（分析+评审）→ deep', classifyComplexity('分析这个模块的实现，并评审错误处理是否妥当').profile === 'deep')
  check('分类(中): 单个弱深作信号 → standard（保守）', classifyComplexity('分析一下这个函数的时间复杂度').profile === 'standard')
  check('分类(中): 优化/性能同条弱信号只计 1 次 → standard（与英文 optimize|performance 对齐）', classifyComplexity('优化这个函数的性能').profile === 'standard')
  check('分类(中): 长机械描述（>480 字符）→ standard（保守）', classifyComplexity('修正错别字。' + '填充 '.repeat(240)).profile === 'standard')
  check('分类(中): marker 全角冒号 覆盖机械表象 → deep（source=marker）', (() => {
    const c = classifyComplexity('修正错别字。复杂度：deep')
    return c.profile === 'deep' && c.source === 'marker'
  })())
  check('分类(中): marker 全角等号 覆盖深作表象 → trivial', classifyComplexity('排查根本原因。复杂度＝trivial').profile === 'trivial')
  check('分类(中): marker 半角冒号 → standard', classifyComplexity('排查根本原因。复杂度:standard').profile === 'standard')
  // v5.11 补充：账本实测高置信短读取/收集活 → trivial；泛化 检查/验证 不入列
  check('分类(中): 读取文件+核对标记 → trivial', classifyComplexity('读取文件 package.json 并核对标记').profile === 'trivial')
  check('分类(中): 收集标记 → trivial', classifyComplexity('收集标记：找出所有 TODO 标记并记录标记清单').profile === 'trivial')
  check('分类: 独立 cat → trivial', classifyComplexity('cat the version field from package.json').profile === 'trivial')
  check('分类(中): cat 紧贴中文 → trivial（\\b 对 CJK 无词界干扰）', classifyComplexity('用 cat 查看 src/version.ts').profile === 'trivial')
  check('分类: category 不误命中 \\bcat\\b → standard', classifyComplexity('Categorize the modules in this repo').profile === 'standard')
  check('分类(中): 泛化验证/检查 → standard（保守，不入机械列）', classifyComplexity('验证所有测试都能通过，并检查清单完整').profile === 'standard')
  check('分类(中): 机械表象 + 深作信号（架构）→ deep（信号优先级不变）', classifyComplexity('读取文件并分析整个系统的架构').profile === 'deep')
  check('叶文本: 嵌套 content 块递归到叶子', (() => {
    const t = leafTextOf([{ role: 'user', content: [{ type: 'text', text: 'Fix the typo' }, { type: 'tool-result', content: [{ type: 'text', text: 'ctx' }] }] }])
    return t.includes('Fix the typo') && t.includes('ctx')
  })())

  // ── v5.11.1 否定感知信号（live WSL2 实弹回归）──────────────────────────
  console.log('== v5.11.1 否定感知 ==')
  check('否定: 中文否定吞掉的命中不计数（不要分析）', hasActiveSignal(/分析|排查|诊断|调查/, '不要分析') === false)
  check('否定: 同组后续主动命中仍计数（不要分析，只排查）', hasActiveSignal(/分析|排查|诊断|调查/, '不要分析，只排查这一处') === true)
  check('否定: 中文否定词逐一生效（无需/不必/不用/请勿/禁止/不需要/无须）', hasActiveSignal(/分析/, '无需分析') === false
    && hasActiveSignal(/分析/, '不必分析') === false
    && hasActiveSignal(/分析/, '不用分析') === false
    && hasActiveSignal(/分析/, '请勿分析') === false
    && hasActiveSignal(/分析/, '禁止分析') === false
    && hasActiveSignal(/分析/, '不需要分析') === false
    && hasActiveSignal(/分析/, '无须分析') === false)
  check("否定: 英文 do not / don't / no need to / without", hasActiveSignal(/analy[sz]e/i, 'Do not analyze the dump') === false
    && hasActiveSignal(/investigat\w*/i, "don't investigate it") === false
    && hasActiveSignal(/diagnos\w*/i, 'no need to diagnose') === false
    && hasActiveSignal(/investigat\w*/i, 'without investigating') === false)
  check('否定: 英文单词内 not 不误吞（notify diagnostics 仍主动）', hasActiveSignal(/diagnos\w*/i, 'notify diagnostics') === true)
  check('否定: 无否定 → 主动命中', hasActiveSignal(/分析/, '分析一下这个函数') === true)
  check('分类(实弹): 否定分析的机械 child 提示词 → trivial', classifyComplexity('执行一个短机械核对：用 bash 执行 cat /root/kix-budget-e2e/big01.txt，记录输出末行，然后只回复 COMPLEXITY-TRIVIAL-DONE。不要分析、不要改文件。').profile === 'trivial')
  check('分类(中): 否定分析 + 机械读取/记录 → trivial', classifyComplexity('读取文件 /var/log/app.log 的末行，记录标记。不要分析、不要排查。').profile === 'trivial')
  check('分类(中): 主动分析（无否定）→ standard', classifyComplexity('分析一下这个函数').profile === 'standard')
  check('分类(中): 否定不跨句读外溢（不要重命名了，直接分析根因 → deep）', classifyComplexity('不要重命名了，直接分析根因').profile === 'deep')
  check('分类(中): 否定强深作信号不升 deep（无需深入分析，统计行数 → trivial）', classifyComplexity('无需深入分析这个文件，只要统计行数').profile === 'trivial')

  // ── v5.11 自适应 effort（纯逻辑）─────────────────────────────────────────
  console.log('== v5.11 自适应 ==')
  check('自适应: 无 profile → decideEffort 原行为（high）', adaptiveEffort(undefined, 'deepseek-official', 65536) === 'high')
  check('自适应: 无 profile → decideEffort 原行为（max）', adaptiveEffort(undefined, 'deepseek-official', 131072) === 'max')
  check('自适应: trivial → off', adaptiveEffort({ profile: 'trivial' }, 'deepseek-official', 65536) === 'off')
  check('自适应: standard → 保持 decideEffort（high）', adaptiveEffort({ profile: 'standard' }, 'deepseek-official', 65536) === 'high')
  check('自适应: deep + 普通行 64K → 升 max', adaptiveEffort({ profile: 'deep' }, 'deepseek-official', 65536) === 'max')
  check('自适应: deep + thinker 128K → 仍 max', adaptiveEffort({ profile: 'deep' }, 'deepseek-official', 131072) === 'max')
  check('自适应: deep + lite 8K → high（lite 永不 max）', adaptiveEffort({ profile: 'deep' }, 'deepseek-official', 8192) === 'high')
  check('自适应: deep + 无预算 → high（保守）', adaptiveEffort({ profile: 'deep' }, 'deepseek-official', undefined) === 'high')
  check('自适应: 非 deepseek → undefined（不变）', adaptiveEffort({ profile: 'trivial' }, 'zai-coding-cn', 65536) === undefined)

  // ── v5.11 能力门控：effortIdsOf（纯逻辑）────────────────────────────────
  console.log('== v5.11 能力门控（effortIdsOf）==')
  check('effortIdsOf: 取 reasoning.efforts 的 id 字符串（保序）', effortIdsOf({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } }).join(',') === 'off,low,high,max')
  check('effortIdsOf: 只收字符串 id（过滤数字/无 id/null）', effortIdsOf({ reasoning: { efforts: [{ id: 'high', label: 'High' }, { id: 42 }, { label: 'x' }, null, undefined] } }).join(',') === 'high')
  check('effortIdsOf: 裸字符串条目也收', effortIdsOf({ reasoning: { efforts: ['off', { id: 'low' }] } }).join(',') === 'off,low')
  check('effortIdsOf: 无 reasoning → []', effortIdsOf({}).length === 0)
  check('effortIdsOf: 无 efforts → []', effortIdsOf({ reasoning: {} }).length === 0)
  check('effortIdsOf: efforts 非数组 → []', effortIdsOf({ reasoning: { efforts: 'off' } }).length === 0)
  check('effortIdsOf: modelInfo 为 undefined → []', effortIdsOf(undefined).length === 0)

  // ── v5.11 能力门控：adaptiveEffort 直测（非 deepseek + 能力数组）─────────
  console.log('== v5.11 能力门控（adaptiveEffort 直测）==')
  const zaiCaps = ['off', 'low', 'medium', 'high', 'max']
  check('门控直测: zai trivial + 含 off → off', adaptiveEffort({ profile: 'trivial' }, 'zai-coding-cn', 65536, zaiCaps) === 'off')
  check('门控直测: zai trivial + 无 off 含 low → low', adaptiveEffort({ profile: 'trivial' }, 'zai-coding-cn', 65536, ['low', 'high', 'max']) === 'low')
  check('门控直测: zai trivial + 无 off 无 low → undefined', adaptiveEffort({ profile: 'trivial' }, 'zai-coding-cn', 65536, ['medium', 'high', 'max']) === undefined)
  check('门控直测: zai trivial + 空能力数组 → undefined', adaptiveEffort({ profile: 'trivial' }, 'zai-coding-cn', 65536, []) === undefined)
  check('门控直测: zai deep + 64K 含 max → max', adaptiveEffort({ profile: 'deep' }, 'zai-coding-cn', 65536, zaiCaps) === 'max')
  check('门控直测: zai deep + 8K 含 max → undefined（≤8192 不升 max）', adaptiveEffort({ profile: 'deep' }, 'zai-coding-cn', 8192, zaiCaps) === undefined)
  check('门控直测: zai deep + 64K 无 max → undefined', adaptiveEffort({ profile: 'deep' }, 'zai-coding-cn', 65536, ['off', 'low', 'high']) === undefined)
  check('门控直测: zai deep + 无预算含 max → undefined（保守）', adaptiveEffort({ profile: 'deep' }, 'zai-coding-cn', undefined, zaiCaps) === undefined)
  check('门控直测: zai standard + 能力数组 → undefined', adaptiveEffort({ profile: 'standard' }, 'zai-coding-cn', 65536, zaiCaps) === undefined)
  check('门控直测: zai 无 profile + 能力数组 → undefined', adaptiveEffort(undefined, 'zai-coding-cn', 65536, zaiCaps) === undefined)
  check('门控直测: deepseek 不看能力数组（trivial 仍 off）', adaptiveEffort({ profile: 'trivial' }, 'deepseek-official', 65536, []) === 'off')
  check('门控直测: deepseek 不看能力数组（standard 仍 high）', adaptiveEffort({ profile: 'standard' }, 'deepseek-official', 65536, []) === 'high')
  check('门控直测: deepseek 不看能力数组（无 profile 仍 max）', adaptiveEffort(undefined, 'deepseek-official', 131072, []) === 'max')

  // ── v5.11 pre-step 画像 → 请求注入（集成）────────────────────────────────
  console.log('== v5.11 pre-step → 请求 ==')
  const dsSeed = (maxTokens) => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens })
  const dsAgent = (maxTokens) => ({ options: { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens, subagentDepth: 1 } })
  const ac = () => new AbortController().signal

  // 机械活：trivial → off（工具/路由/maxTokens 均不动）
  const mechAgent = dsAgent(65536)
  let d = await prestep(mechAgent, [msg('Fix the typo in the README title: kixparadgm → kixparadigm')])
  check('pre-step: 决策原样透传（enter）', d.kind === 'enter')
  r = await dispatch({ agent: mechAgent, signal: ac() }, dsSeed(65536))
  check('机械活子代理 → off', r.reasoningEffort === 'off')
  check('机械活子代理 → provider/model/maxTokens 不变', r.provider === 'deepseek-official' && r.model === 'deepseek-v4-flash' && r.maxTokens === 65536)

  // 画像只算一次：后续 pre-step（深作后续消息）不改写
  await prestep(mechAgent, [msg('Investigate the root cause and design a comprehensive fix')], { kind: 'enter', messages: [] })
  r = await dispatch({ agent: mechAgent, signal: ac() }, dsSeed(65536))
  check('画像首接受步定格：后续 pre-step 不改写（仍 off）', r.reasoningEffort === 'off')

  // 深活：普通行 → max
  const deepAgent = dsAgent(65536)
  await prestep(deepAgent, [msg('Investigate the root cause of the flaky test and design a durable fix')])
  r = await dispatch({ agent: deepAgent, signal: ac() }, dsSeed(65536))
  check('深活普通行（64K）→ max', r.reasoningEffort === 'max')

  // 深活但 lite 行：回退 deepseek 后仍不升 max（lite 永不 max）
  services.llm = badLlm2
  services.agentDefaultModel = { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) }
  const liteDeepAgent = { options: { provider: 'zai-coding-cn', model: 'glm-4.7', maxTokens: 8192, subagentDepth: 1 } }
  await prestep(liteDeepAgent, [msg('Investigate the root cause and design a comprehensive fix')])
  r = await dispatch({ agent: liteDeepAgent, signal: ac() }, { provider: 'zai-coding-cn', model: 'glm-4.7', maxTokens: 8192 })
  check('深活 lite 行回退 deepseek → high（lite 永不 max）', r.provider === 'deepseek-official' && r.reasoningEffort === 'high')
  services.llm = llm
  services.agentDefaultModel = defaults

  // 一般任务：standard → 保持原行为 high
  const stdAgent = dsAgent(65536)
  await prestep(stdAgent, [msg('Summarize the changes in this pull request')])
  r = await dispatch({ agent: stdAgent, signal: ac() }, dsSeed(65536))
  check('一般任务子代理 → high（standard 保持 decideEffort）', r.reasoningEffort === 'high')

  // 显式 marker：机械表象标 deep → max
  const markAgent = dsAgent(65536)
  await prestep(markAgent, [msg('Fix the typo. complexity: deep')])
  r = await dispatch({ agent: markAgent, signal: ac() }, dsSeed(65536))
  check('显式 marker deep → max', r.reasoningEffort === 'max')

  // 中文 prompt 端到端（v5.11 双语正则）：机械 → off / 深作普通行 → max /
  // marker 全角冒号深作 → max
  const zhMechAgent = dsAgent(65536)
  await prestep(zhMechAgent, [msg('修正 README 标题里的错别字：kixparadgm → kixparadigm')])
  r = await dispatch({ agent: zhMechAgent, signal: ac() }, dsSeed(65536))
  check('中文机械活子代理 → off', r.reasoningEffort === 'off')

  const zhDeepAgent = dsAgent(65536)
  await prestep(zhDeepAgent, [msg('排查这个偶发测试失败的根本原因，并设计一个可靠的修复方案')])
  r = await dispatch({ agent: zhDeepAgent, signal: ac() }, dsSeed(65536))
  check('中文深作普通行（64K）→ max', r.reasoningEffort === 'max')

  const zhMarkAgent = dsAgent(65536)
  await prestep(zhMarkAgent, [msg('把变量 foo 重命名为 bar。复杂度：deep')])
  r = await dispatch({ agent: zhMarkAgent, signal: ac() }, dsSeed(65536))
  check('中文 marker deep（机械表象）→ max', r.reasoningEffort === 'max')

  // 账本式机械 E2E 提示词（读取/收集标记类）→ trivial → off
  const ledgerAgent = dsAgent(65536)
  await prestep(ledgerAgent, [msg('读取文件 package.json 的内容，并核对标记是否齐全')])
  r = await dispatch({ agent: ledgerAgent, signal: ac() }, dsSeed(65536))
  check('账本机械活（读取文件+核对标记）→ off', r.reasoningEffort === 'off')

  // 无画像（未跑 pre-step）→ 旧行为
  r = await dispatch({ agent: dsAgent(65536), signal: ac() }, dsSeed(65536))
  check('无画像子代理 → 旧行为 high', r.reasoningEffort === 'high')
  r = await dispatch({ agent: dsAgent(131072), signal: ac() }, dsSeed(131072))
  check('无画像 thinker 子代理 → 旧行为 max', r.reasoningEffort === 'max')

  // 拒绝步不落画像；被接受后补落
  const rejAgent = dsAgent(65536)
  d = await prestep(rejAgent, [msg('Investigate the root cause and design a durable fix')], { kind: 'reject', reason: 'guard' })
  check('pre-step: 拒绝决策原样透传', d.kind === 'reject')
  r = await dispatch({ agent: rejAgent, signal: ac() }, dsSeed(65536))
  check('拒绝步 → 无画像 → 旧行为 high', r.reasoningEffort === 'high')
  await prestep(rejAgent, [msg('Investigate the root cause and design a durable fix')])
  r = await dispatch({ agent: rejAgent, signal: ac() }, dsSeed(65536))
  check('后续接受步 → 画像生效（max）', r.reasoningEffort === 'max')

  // 非 deepseek：有画像也不注入
  const zaiDeepAgent = { options: { provider: 'zai-coding-cn', model: 'glm-5.3', maxTokens: 65536, subagentDepth: 1 } }
  await prestep(zaiDeepAgent, [msg('Investigate the root cause and design a durable fix')])
  r = await dispatch({ agent: zaiDeepAgent, signal: ac() }, { provider: 'zai-coding-cn', model: 'glm-5.3', maxTokens: 65536 })
  check('非 deepseek 子代理：有深作画像 → 仍不注入', r.reasoningEffort === undefined && r.provider === 'zai-coding-cn')

  // 主会话 pre-step → 不落画像（保持不干预）
  const mainMsgAgent = { options: { provider: 'deepseek-official', model: 'deepseek-v4-flash', subagentDepth: 0 } }
  await prestep(mainMsgAgent, [msg('Fix the typo in the README title')])
  r = await dispatch({ agent: mainMsgAgent, signal: ac() }, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  check('主会话 pre-step → 不画像不注入', r.reasoningEffort === undefined)

  // 哨兵路由：有画像也不碰（kix-route 全权）
  const sentAgent = dsAgent(65536)
  await prestep(sentAgent, [msg('Investigate the root cause and design a durable fix')])
  r = await dispatch({ agent: sentAgent, signal: ac() }, { provider: 'zai-coding-cn', model: 'kix-route:thinker', maxTokens: 65536 })
  check('哨兵路由 + 画像 → 原样返回（kix-route 全权）', r.reasoningEffort === undefined && r.model === 'kix-route:thinker')

  // 显式 effort + 画像 → 不干预
  const explAgent = dsAgent(65536)
  await prestep(explAgent, [msg('Investigate the root cause and design a durable fix')])
  r = await dispatch({ agent: explAgent, signal: ac() }, { ...dsSeed(65536), reasoningEffort: 'low' })
  check('显式 effort + 画像 → 原样保留 low', r.reasoningEffort === 'low')

  // ── v5.11 能力门控集成（mock ZAI glm-5.2 能力表）────────────────────────
  // 64K 预算（非 lite）→ 隔离 A 段 lite 探测，只考察能力门控本身；
  // capCalls 按 provider/model 计数，验证「每 agent/model 只解析一次」。
  console.log('== v5.11 能力门控（集成）==')
  const capCalls = {}
  const capLlm = {
    listProviders: () => [{ provider: 'zai-coding-cn' }, { provider: 'deepseek-official' }],
    resolveModelInfo: async (provider, model) => {
      capCalls[provider + '/' + model] = (capCalls[provider + '/' + model] || 0) + 1
      if (provider === 'zai-coding-cn' && model === 'glm-5.2') {
        return { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } }
      }
      if (provider === 'zai-coding-cn' && model === 'glm-5.2-plain') return {} // 无 reasoning.efforts
      if (provider === 'zai-coding-cn' && model === 'glm-5.2-boom') throw new Error('probe boom')
      return {}
    },
  }
  services.llm = capLlm
  const capAgent = (model, maxTokens) => ({ options: { provider: 'zai-coding-cn', model, maxTokens, subagentDepth: 1 } })
  const capSeed = (model, maxTokens) => ({ provider: 'zai-coding-cn', model, maxTokens })
  const capCount = (model) => capCalls['zai-coding-cn/' + model] || 0

  // trivial → off（能力含 off；路由/预算不动）
  const capTrivialAgent = capAgent('glm-5.2', 65536)
  await prestep(capTrivialAgent, [msg('Fix the typo in the README title')])
  r = await dispatch({ agent: capTrivialAgent, signal: ac() }, capSeed('glm-5.2', 65536))
  check('门控集成: zai glm-5.2 机械活 → 注入 off', r.reasoningEffort === 'off')
  check('门控集成: 注入 off 不动 provider/model/maxTokens', r.provider === 'zai-coding-cn' && r.model === 'glm-5.2' && r.maxTokens === 65536)
  check('门控集成: 首轮解析能力表恰好一次', capCount('glm-5.2') === 1)
  // 同 agent 同 model 第二轮：effortCaps 缓存命中，不再探测，结论不变
  r = await dispatch({ agent: capTrivialAgent, signal: ac() }, capSeed('glm-5.2', 65536))
  check('门控集成: 二轮缓存命中（计数仍 1，仍 off）', r.reasoningEffort === 'off' && capCount('glm-5.2') === 1)

  // deep → max（能力含 max 且 64K > 8192）；新 agent 同 model 各自解析一次
  const capDeepAgent = capAgent('glm-5.2', 65536)
  await prestep(capDeepAgent, [msg('Investigate the root cause of the flaky test and design a durable fix')])
  r = await dispatch({ agent: capDeepAgent, signal: ac() }, capSeed('glm-5.2', 65536))
  check('门控集成: zai glm-5.2 深作普通行 → 注入 max', r.reasoningEffort === 'max')
  check('门控集成: 每 agent 各解析一次（计数 2）', capCount('glm-5.2') === 2)

  // standard：不探测（计数不动）、不注入
  const capStdAgent = capAgent('glm-5.2', 65536)
  await prestep(capStdAgent, [msg('Summarize the changes in this pull request')])
  r = await dispatch({ agent: capStdAgent, signal: ac() }, capSeed('glm-5.2', 65536))
  check('门控集成: standard → 不探测不注入', r.reasoningEffort === undefined && capCount('glm-5.2') === 2)

  // 能力表无 reasoning.efforts：配置原样（不注入），且空结果同样缓存
  const capPlainAgent = capAgent('glm-5.2-plain', 65536)
  await prestep(capPlainAgent, [msg('Fix the typo in the README title')])
  r = await dispatch({ agent: capPlainAgent, signal: ac() }, capSeed('glm-5.2-plain', 65536))
  check('门控集成: 无 reasoning.efforts → 配置原样不注入', r.reasoningEffort === undefined && r.provider === 'zai-coding-cn' && r.model === 'glm-5.2-plain')
  r = await dispatch({ agent: capPlainAgent, signal: ac() }, capSeed('glm-5.2-plain', 65536))
  check('门控集成: 空能力表缓存（计数仍 1，不重探）', r.reasoningEffort === undefined && capCount('glm-5.2-plain') === 1)

  // 探测抛错 → 缓存 []：不注入，且不再重试
  const capBoomAgent = capAgent('glm-5.2-boom', 65536)
  await prestep(capBoomAgent, [msg('Fix the typo in the README title')])
  r = await dispatch({ agent: capBoomAgent, signal: ac() }, capSeed('glm-5.2-boom', 65536))
  check('门控集成: resolveModelInfo 抛错 → 不注入（适配器自管）', r.reasoningEffort === undefined)
  r = await dispatch({ agent: capBoomAgent, signal: ac() }, capSeed('glm-5.2-boom', 65536))
  check('门控集成: 抛错同样缓存 []（计数仍 1，不重试）', r.reasoningEffort === undefined && capCount('glm-5.2-boom') === 1)

  services.llm = llm

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
