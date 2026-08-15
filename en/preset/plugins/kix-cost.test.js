// kix-cost 回归测试（v5.8，2026-08-21）
//
// 单元级验证：加载 kix-cost.js，mock cordis ctx（on/effect/get）与 llm 服务，
// 覆盖：档位注入（medium/max/非 deepseek 跳过）、子代理判别、lite 自动选型
// （可用 → 保留；不可用 → 回退默认路由）、显式 effort 不干预。
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
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  on(event, cb) {
    ;(listeners[event] ||= []).push(cb)
  },
  get(name) {
    return services[name]
  },
}

// ── 加载被测试插件 ────────────────────────────────────────────────────────
const plugin = require(path.join(__dirname, 'kix-cost.js'))
assert.strictEqual(plugin.name, 'kix-cost')
plugin.apply(ctx)
const onRequest = listeners['agent/request']
assert.ok(Array.isArray(onRequest) && onRequest.length === 1, 'agent/request 监听器已注册')

const { decideEffort, isSubagentChild, isLiteTier, probeRoute } = plugin.__internals

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

// ── 派发模拟 ───────────────────────────────────────────────────────────────
async function dispatch(payload, seed) {
  return onRequest[0](payload, async () => seed)
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

  // 5. zhipu 子代理（zai 64K）：不注入
  r = await dispatch({ agent: { options: { provider: 'zai-coding-cn', model: 'glm-5.3', maxTokens: 65536, subagentDepth: 1 } }, signal: new AbortController().signal }, { provider: 'zai-coding-cn', model: 'glm-5.3', maxTokens: 65536 })
  check('zhipu 子代理 → 不注入 effort', r.reasoningEffort === undefined && r.provider === 'zai-coding-cn')

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

  // 9. probeRoute 纯函数
  check('probeRoute: 可用路由 → true', await probeRoute(llm, 'zai-coding-cn', 'glm-4.7', undefined) === true)
  check('probeRoute: 未知模型 → false', await probeRoute(llm, 'zai-coding-cn', 'glm-9.9', undefined) === false)
  check('probeRoute: 未注册 provider → false', await probeRoute(llm, 'openrouter', 'x', undefined) === false)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
