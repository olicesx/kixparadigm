// kix-route 单元测试 — 纯逻辑层（__internals）+ 假 ctx listener 级集成。
// 契约对齐：llm.listProviders() 返回 {id, name}（id=路由键，name=显示名，
// dsh-llm prepareRoutes 实证）——mock 必须用真实形状，禁止伪造 {provider} 字段
// （B1 教训：旧 mock 伪造字段使 39 个断言对虚构契约全绿）。
// 运行：node plugins/kix-route.test.js

'use strict'

const path = require('node:path')

const {
  SENTINEL_PREFIX,
  vendorOf,
  registeredProviders,
  orderedModels,
  crossProviderOrder,
  sentinelTierOf,
  resolveCrossRoute,
  resolveVisionRoute,
  resolveThinkerRoute,
  resolveFallbackRoute,
  pickModel,
  decideTierAction,
  quotaFailureOf,
  availabilityFailureOf,
  hardQuotaFailure,
  hardProviderFailure,
  createProviderHealthCache,
  quotaIncidentOf,
  availabilityIncidentOf,
  quotaFeedbackText,
  availabilityFeedbackText,
  providerCircuitFailText,
  DEFAULT_PROVIDER_CIRCUIT_TTL_MS,
  DEFAULT_CROSS_PROVIDER_FAILOVERS,
  crossFailText,
  visionFailText,
  thinkerFailText,
} = require('./kix-route.js').__internals

let passed = 0
let failed = 0
function check(name, cond) {
  if (cond) {
    passed++
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.error(`FAIL  ${name}`)
  }
}

// ── mock llm：目录 + 可解析集合都可注入；listProviders 用真实 {id, name} 形状 ──
function mockLlm({ providers = [], models = {}, resolvable = new Set(), modalities = {}, counter } = {}) {
  return {
    listProviders: () => providers.map((p) => ({ id: p, name: `Display ${p}` })),
    listModels: async (provider) => { if (counter) counter.listModels++; return (models[provider] ?? []).map((id) => ({ id })) },
    resolveModelInfo: async (provider, model) => {
      if (counter) counter.resolve++
      if (!resolvable.has(`${provider}/${model}`)) throw new Error('UNKNOWN_MODEL')
      return { provider, id: model, inputModalities: modalities[`${provider}/${model}`] }
    },
  }
}

// ── listener 级：假 ctx 捕获 agent/request handler，驱动完整插件行为 ────────
async function withListener(mod, services, fn) {
  let handler
  const warns = []
  const ctx = {
    on: (ev, h) => { if (ev === 'agent/request') handler = h },
    get: (n) => services[n],
    logger: { warn: (m) => warns.push(String(m)) },
  }
  mod.apply(ctx)
  if (typeof handler !== 'function') throw new Error('agent/request listener not captured')
  return fn({ call: (payload, seed) => handler(payload, () => Promise.resolve(seed)), services, warns })
}

async function withRuntime(mod, services, config, fn) {
  const listeners = Object.create(null)
  const listenerOptions = Object.create(null)
  const warns = []
  const ctx = {
    on: (event, handler, options) => {
      const list = (listeners[event] ||= [])
      const prepend = options === true || options?.prepend === true
      if (prepend) list.unshift(handler)
      else list.push(handler)
      ;(listenerOptions[event] ||= []).push(options)
    },
    get: (name) => services[name],
    logger: { warn: (message) => warns.push(String(message)) },
  }
  mod.apply(ctx, config)
  const emit = async (event, ...args) => {
    for (const handler of listeners[event] || []) await handler(...args)
  }
  const waterfall = async (event, payload, terminal = () => Promise.resolve(undefined)) => {
    const chain = listeners[event] || []
    let next = terminal
    for (let index = chain.length - 1; index >= 0; index--) {
      const handler = chain[index]
      const downstream = next
      next = () => handler(payload, downstream)
    }
    return next()
  }
  const call = async (payload, seed) => {
    const handler = (listeners['agent/request'] || [])[0]
    if (typeof handler !== 'function') throw new Error('agent/request listener not captured')
    return handler(payload, () => Promise.resolve(seed))
  }
  return fn({ emit, waterfall, call, listeners, listenerOptions, services, warns })
}

async function main() {
  const routeMod = require('./kix-route.js')

  // ── vendorOf / sentinelTierOf ───────────────────────────────────────────
  check('zai-coding-cn → zhipu', vendorOf('zai-coding-cn') === 'zhipu')
  check('zai-vision → zhipu', vendorOf('zai-vision') === 'zhipu')
  check('zhipu-open（别名前缀）→ zhipu', vendorOf('zhipu-open') === 'zhipu')
  check('zai（裸名）→ zhipu', vendorOf('zai') === 'zhipu')
  check('deepseek-official → deepseek', vendorOf('deepseek-official') === 'deepseek')
  check('deepseek-partner → deepseek（同族）', vendorOf('deepseek-partner') === 'deepseek')
  check('未知 provider 取首段', vendorOf('other-org') === 'other')
  check('空串 → 空厂商', vendorOf('') === '')
  check('哨兵 cross/vision/thinker 识别', sentinelTierOf('kix-route:cross') === 'cross' && sentinelTierOf('kix-route:vision') === 'vision' && sentinelTierOf('kix-route:thinker') === 'thinker')
  check('未知档位/普通模型 → undefined', sentinelTierOf('kix-route:other') === undefined && sentinelTierOf('glm-5.3') === undefined)
  check('前缀常量正确', SENTINEL_PREFIX === 'kix-route:')

  // ── B1 回归：registeredProviders 读 id（路由键），显示名绝不入库 ─────────
  {
    const llm = mockLlm({ providers: ['zai-vision', 'deepseek-official'] })
    const got = registeredProviders(llm)
    check('B1 回归：取 id 为路由键', JSON.stringify(got) === JSON.stringify(['zai-vision', 'deepseek-official']))
    const weird = { listProviders: () => [{ id: 'real-key', name: 'Display 智谱' }, { name: 'only-display' }, { provider: 'legacy-shape' }] }
    const got2 = registeredProviders(weird)
    check('B1 回归：显示名被排除 / legacy provider 字段兜底', JSON.stringify(got2) === JSON.stringify(['real-key', 'legacy-shape']))
    check('B1 回归：listProviders 抛错 → 抛 probe 错误（非静默 []，审查修复）', (() => {
      try {
        registeredProviders({ listProviders: () => { throw new Error('boom') } })
        return false // 应抛
      } catch (e) {
        return e.probe === true && /探测已注册 provider 失败/.test(e.message)
      }
    })())
  }

  // ── orderedModels ───────────────────────────────────────────────────────
  check(
    '偏好排序：glm-5.3 在 glm-4.7 前',
    JSON.stringify(orderedModels('zai-coding-cn', ['glm-4.7', 'glm-5.3'])) === JSON.stringify(['glm-5.3', 'glm-4.7']),
  )
  check(
    '目录中不在偏好表的模型追加在后',
    JSON.stringify(orderedModels('zai-coding-cn', ['glm-x9', 'glm-4.7'])) === JSON.stringify(['glm-4.7', 'glm-x9']),
  )

  // ── crossProviderOrder ──────────────────────────────────────────────────
  {
    const llm = mockLlm({ providers: ['zai-coding-cn', 'deepseek-official'] })
    check(
      '父=zhipu → deepseek 在前且无 zai',
      JSON.stringify(crossProviderOrder(llm, 'zai-coding-cn')) === JSON.stringify(['deepseek-official']),
    )
    check(
      '父=deepseek → zai 在前且无 deepseek',
      JSON.stringify(crossProviderOrder(llm, 'deepseek-official')) === JSON.stringify(['zai-coding-cn']),
    )
    check(
      '父=未知厂商 → 通用序全保留',
      JSON.stringify(crossProviderOrder(llm, 'anthropic-official')) === JSON.stringify(['deepseek-official', 'zai-coding-cn']),
    )
    check(
      '父=grok → zai 在前且 deepseek 仍在 tail',
      JSON.stringify(crossProviderOrder(llm, 'grok')) === JSON.stringify(['zai-coding-cn', 'deepseek-official']),
    )
    check(
      '父=xai → 与 grok 同序',
      JSON.stringify(crossProviderOrder(llm, 'xai')) === JSON.stringify(['zai-coding-cn', 'deepseek-official']),
    )
  }

  // ── resolveCrossRoute ───────────────────────────────────────────────────
  {
    const llm = mockLlm({
      providers: ['zai-coding-cn', 'deepseek-official'],
      models: { 'deepseek-official': ['deepseek-v4-flash'], 'zai-coding-cn': ['glm-5.3'] },
      resolvable: new Set(['deepseek-official/deepseek-v4-flash', 'zai-coding-cn/glm-5.3']),
    })
    const hit = await resolveCrossRoute(llm, 'zai-coding-cn', undefined)
    check('cross：父=zhipu → deepseek-v4-flash', hit !== undefined && hit.provider === 'deepseek-official' && hit.model === 'deepseek-v4-flash')
  }
  {
    const llm = mockLlm({
      providers: ['grok', 'zai-coding-cn', 'deepseek-official'],
      models: { grok: ['grok-4.6'], 'zai-coding-cn': ['glm-5.3'], 'deepseek-official': ['deepseek-v4-flash'] },
      resolvable: new Set(['grok/grok-4.6', 'zai-coding-cn/glm-5.3', 'deepseek-official/deepseek-v4-flash']),
    })
    const hit = await resolveCrossRoute(llm, 'grok', undefined)
    check('cross：父=grok → 首选 zai glm-5.3', hit !== undefined && hit.provider === 'zai-coding-cn' && hit.model === 'glm-5.3')
    const afterQuota = await resolveCrossRoute(llm, 'grok', undefined, undefined, (provider) => provider !== 'zai-coding-cn')
    check('cross：父=grok 且 zai 熔断 → 落到 deepseek', afterQuota?.provider === 'deepseek-official')
  }
  {
    const llm = mockLlm({
      providers: ['deepseek-official', 'zai-coding-cn'],
      models: { 'zai-coding-cn': ['glm-4.7', 'glm-5.2'], 'deepseek-official': ['deepseek-v4-flash'] },
      resolvable: new Set(['zai-coding-cn/glm-5.2', 'zai-coding-cn/glm-4.7', 'deepseek-official/deepseek-v4-flash']),
    })
    const hit = await resolveCrossRoute(llm, 'deepseek-official', undefined)
    check('cross：父=deepseek → zai 偏好序首个可用（glm-5.2）', hit !== undefined && hit.model === 'glm-5.2')
  }
  {
    const llm = mockLlm({
      providers: ['deepseek-official', 'zai-coding-cn'],
      models: { 'zai-coding-cn': ['glm-5.3', 'glm-4.7'] },
      resolvable: new Set(['zai-coding-cn/glm-4.7']),
    })
    check('cross：首选不可用回退 glm-4.7', (await resolveCrossRoute(llm, 'deepseek-official', undefined))?.model === 'glm-4.7')
  }
  {
    const llm = mockLlm({ providers: ['zai-coding-cn'], models: { 'zai-coding-cn': ['glm-5.3'] }, resolvable: new Set(['zai-coding-cn/glm-5.3']) })
    check('cross：单厂商部署 → undefined', (await resolveCrossRoute(llm, 'zai-coding-cn', undefined)) === undefined)
  }
  {
    // v8：偏好表里的未注册 provider 必须被跳过，不能把目录探测失败放大成
    // 「cross 探测失败」。父厂商 acme 未出现在偏好表 → generic 首候选
    // deepseek-official 未注册（listModels 会抛错），应直接落到已注册 acme2。
    const llm = {
      listProviders: () => [{ id: 'acme-official', name: 'Acme' }, { id: 'acme2', name: 'Acme2' }],
      listModels: async (provider) => {
        if (provider === 'deepseek-official' || provider === 'zai-coding-cn') throw new Error('provider not registered')
        return [{ id: provider + '-m1' }]
      },
      resolveModelInfo: async (provider, model) => ({ provider, id: model, inputModalities: ['text'] }),
    }
    const hit = await resolveCrossRoute(llm, 'acme-official', undefined)
    check('v8 cross：未注册偏好候选跳过 → 已注册异厂商兜底', hit !== undefined && hit.provider === 'acme2')
  }
  {
    const llm = mockLlm({
      providers: ['zai-coding-cn', 'acme-llm'],
      models: { 'zai-coding-cn': ['glm-5.3'], 'acme-llm': ['acme-x1'] },
      resolvable: new Set(['zai-coding-cn/glm-5.3', 'acme-llm/acme-x1']),
    })
    const hit = await resolveCrossRoute(llm, 'zai-coding-cn', undefined)
    check('cross：无 deepseek 但有第三方异厂商 → acme-x1', hit !== undefined && hit.provider === 'acme-llm' && hit.model === 'acme-x1')
  }

  // ── resolveVisionRoute（B1 主案发地：显示名 ≠ 路由键）─────────────────
  {
    const llm = mockLlm({
      providers: ['deepseek-official', 'zai-vision'],
      models: { 'zai-vision': ['glm-4.6v', 'glm-4.5v'], 'deepseek-official': ['deepseek-v4-flash'] },
      resolvable: new Set(['zai-vision/glm-4.6v', 'zai-vision/glm-4.5v', 'deepseek-official/deepseek-v4-flash']),
      modalities: { 'zai-vision/glm-4.6v': ['text', 'image'], 'zai-vision/glm-4.5v': ['text'], 'deepseek-official/deepseek-v4-flash': ['text'] },
    })
    const hit = await resolveVisionRoute(llm, undefined)
    check('B1 主回归：vision 经 id 找到 zai-vision → glm-4.6v', hit !== undefined && hit.provider === 'zai-vision' && hit.model === 'glm-4.6v')
  }
  {
    const llm = mockLlm({ providers: ['zai-vision'], models: { 'zai-vision': ['glm-4.6v'] }, resolvable: new Set(['zai-vision/glm-4.6v']), modalities: {} })
    check('vision：inputModalities 未声明 → undefined', (await resolveVisionRoute(llm, undefined)) === undefined)
  }
  {
    const llm = mockLlm({
      providers: ['acme-llm'],
      models: { 'acme-llm': ['acme-eye'] },
      resolvable: new Set(['acme-llm/acme-eye']),
      modalities: { 'acme-llm/acme-eye': ['text', 'image'] },
    })
    check('vision：zai-vision 缺席 → 其他 provider image 模型兜底', (await resolveVisionRoute(llm, undefined))?.model === 'acme-eye')
  }
  {
    const llm = mockLlm({
      providers: ['zai-coding-cn'],
      models: { 'zai-coding-cn': ['glm-5.3'] },
      resolvable: new Set(['zai-coding-cn/glm-5.3']),
      modalities: { 'zai-coding-cn/glm-5.3': ['text'] },
    })
    check('vision：全目录无 image 模型 → undefined', (await resolveVisionRoute(llm, undefined)) === undefined)
  }

  // ── resolveThinkerRoute（B1 次案发地：deepseek-official 的显示名是 "DeepSeek"）──
  {
    const llm = mockLlm({
      providers: ['deepseek-official', 'zai-coding-cn'],
      models: { 'deepseek-official': ['deepseek-v4-flash'], 'zai-coding-cn': ['glm-5.3'] },
      resolvable: new Set(['deepseek-official/deepseek-v4-flash', 'zai-coding-cn/glm-5.3']),
    })
    const hit = await resolveThinkerRoute(llm, undefined)
    check('B1 主回归：thinker 经 id 识别 deepseek-official', hit !== undefined && hit.provider === 'deepseek-official' && hit.model === 'deepseek-v4-flash')
  }
  {
    const llm = mockLlm({
      providers: ['zai-coding-cn', 'deepseek-partner'],
      models: { 'deepseek-partner': ['ds-x1'], 'zai-coding-cn': ['glm-5.3'] },
      resolvable: new Set(['deepseek-partner/ds-x1', 'zai-coding-cn/glm-5.3']),
    })
    const hit = await resolveThinkerRoute(llm, undefined)
    check('thinker：无 official 但有 deepseek-* → 同族兜底', hit !== undefined && hit.provider === 'deepseek-partner' && hit.model === 'ds-x1')
  }
  {
    const llm = mockLlm({ providers: ['zai-coding-cn'], models: { 'zai-coding-cn': ['glm-5.3'] }, resolvable: new Set(['zai-coding-cn/glm-5.3']) })
    check('thinker：deepseek 全缺席 → undefined（降级默认路由）', (await resolveThinkerRoute(llm, undefined)) === undefined)
  }

  // ── pickModel ───────────────────────────────────────────────────────────
  {
    const llm = mockLlm({ providers: ['zai-coding-cn'], models: { 'zai-coding-cn': ['glm-5.3', 'glm-4.7'] }, resolvable: new Set(['zai-coding-cn/glm-4.7']) })
    check('pickModel：跳过不可解析，取 glm-4.7', (await pickModel(llm, 'zai-coding-cn', {}))?.model === 'glm-4.7')
  }
  {
    const broken = { listModels: async () => { throw new Error('boom') }, resolveModelInfo: async () => { throw new Error('x') } }
    check('pickModel：listModels 抛错 → 抛 probe 错误（审查修复，非静默 undefined）', (async () => {
      try {
        await pickModel(broken, 'p', {})
        return false
      } catch (e) {
        return e.probe === true && /探测 p 模型目录失败/.test(e.message)
      }
    })())
  }
  {
    // n1 契约防御：listModels 返回非数组（目录破坏）按空目录处理，不裸抛 TypeError
    const weird = { listModels: async () => 'not-an-array', resolveModelInfo: async () => ({}) }
    check('pickModel：非数组 listModels → undefined（不裸抛）', (await pickModel(weird, 'p', {})) === undefined)
  }
  {
    const llm = mockLlm({ providers: ['p'], models: { p: ['m1', 'm2'] }, resolvable: new Set(['p/m1', 'p/m2']) })
    const ac = new AbortController(); ac.abort()
    check('pickModel：signal 已中止 → 立即 undefined（不烧探测）', (await pickModel(llm, 'p', { signal: ac.signal })) === undefined)
  }

  // ── decideTierAction：边界动作判定 ───────────────────────────────────────
  {
    const hit = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    const a = decideTierAction('cross', hit, undefined, 'FAIL')
    check('action：命中 → use 且不标记降级', a.kind === 'use' && a.hit === hit && a.degraded !== true)
    const b = decideTierAction('cross', undefined, { provider: 'zai-coding-cn', model: 'glm-5.3' }, 'FAIL-TEXT')
    check('action：cross 单厂商 → fail（有默认路由也不降级）', b.kind === 'fail' && b.message === 'FAIL-TEXT')
    const c = decideTierAction('vision', undefined, { provider: 'zai-coding-cn', model: 'glm-5.3' }, 'FAIL-V')
    check('action：vision 无视觉模型 → fail', c.kind === 'fail' && c.message === 'FAIL-V')
    const def = { provider: 'zai-coding-cn', model: 'glm-5.3' }
    const d = decideTierAction('thinker', undefined, def, 'FAIL-T')
    check('action：thinker 未命中 + 默认路由 → 降级 use', d.kind === 'use' && d.hit === def && d.degraded === true)
    const e = decideTierAction('thinker', undefined, undefined, 'FAIL-T2')
    check('action：thinker 无默认路由 → fail', e.kind === 'fail' && e.message === 'FAIL-T2')
  }

  // ── 失败文案完整性 ──────────────────────────────────────────────────────
  {
    const msg = crossFailText('zai-coding-cn', ['zai-coding-cn'])
    check('crossFailText：主厂商 + 清单 + 出路', msg.includes('zhipu') && msg.includes('zai-coding-cn') && msg.includes('subagent') && msg.includes('settings.yaml'))
    // 空清单分支：必须渲染「无/none」占位符并列出建议（防止模板丢内容变成空洞文案）
    const msgEmpty = crossFailText('', [])
    check('crossFailText：空清单渲染占位符 + 配置出路', (msgEmpty.includes('无') || msgEmpty.includes('none')) && msgEmpty.includes('settings.yaml'))
    const vmsg = visionFailText(['zai-coding-cn'])
    check('visionFailText：清单 + 配置建议', vmsg.includes('zai-coding-cn') && vmsg.includes('image') && vmsg.includes('settings.yaml'))
    // thinker 文案必须点名 agentDefaultModel 与 settings.yaml（可行动指引）
    const tmsg = thinkerFailText()
    check('thinkerFailText：点名 agentDefaultModel + settings.yaml', tmsg.includes('agentDefaultModel') && tmsg.includes('settings.yaml'))
  }

  // ══ listener 级集成（假 ctx 捕获 handler，覆盖此前零覆盖的不变量）═══════
  const dualLlm = () => mockLlm({
    providers: ['zai-coding-cn', 'deepseek-official'],
    models: { 'zai-coding-cn': ['glm-5.3'], 'deepseek-official': ['deepseek-v4-flash'] },
    resolvable: new Set(['zai-coding-cn/glm-5.3', 'deepseek-official/deepseek-v4-flash']),
    modalities: { 'zai-coding-cn/glm-5.3': ['text'], 'deepseek-official/deepseek-v4-flash': ['text'] },
  })
  const soloLlm = () => mockLlm({
    providers: ['zai-coding-cn'],
    models: { 'zai-coding-cn': ['glm-5.3'] },
    resolvable: new Set(['zai-coding-cn/glm-5.3']),
    modalities: { 'zai-coding-cn/glm-5.3': ['text'] },
  })
  const child = (maxTokens) => ({ agent: { options: { subagentDepth: 1, ...(maxTokens !== undefined ? { maxTokens } : {}) } }, signal: undefined })

  await withListener(routeMod, { llm: dualLlm() }, async ({ call }) => {
    const out = await call(child(65536), { provider: 'zai-coding-cn', model: 'kix-route:cross', maxTokens: 65536 })
    check('L1 cross 改写 deepseek + effort high', out.provider === 'deepseek-official' && out.model === 'deepseek-v4-flash' && out.reasoningEffort === 'high')
  })
  await withListener(routeMod, { llm: soloLlm() }, async ({ call }) => {
    let msg = 'no-throw'
    try { await call(child(65536), { provider: 'zai-coding-cn', model: 'kix-route:cross' }) } catch (e) { msg = String(e.message) }
    check('L2 单厂商 cross → throw 带指引', msg.includes('subagent_cross') && msg.includes('zai-coding-cn') && msg.includes('subagent') && msg.includes('settings.yaml'))
  })
  await withListener(routeMod, { llm: soloLlm() }, async ({ call }) => {
    let threw = false
    try { await call(child(), { provider: 'zai-coding-cn', model: 'kix-route:vision' }) } catch (e) { threw = String(e.message).includes('subagent_vision') }
    check('L3 vision 无 image → throw', threw)
  })
  await withListener(routeMod, { llm: soloLlm(), agentDefaultModel: { currentSelection: () => ({ provider: 'zai-coding-cn', model: 'glm-5.3' }) } }, async ({ call, warns }) => {
    const p = child(131072) // 同一 agent 对象：WeakMap 按 agent 缓存，两次调用必须同一 payload
    const out1 = await call(p, { provider: 'zai-coding-cn', model: 'kix-route:thinker' })
    const out2 = await call(p, { provider: 'zai-coding-cn', model: 'kix-route:thinker' })
    check('L4 thinker 降级 + 告警恰好一次', out1.model === 'glm-5.3' && out2.model === 'glm-5.3' && warns.length === 1)
  })
  await withListener(routeMod, { llm: dualLlm() }, async ({ call, services }) => {
    const counter = { listModels: 0, resolve: 0 }
    // 替换带计数的 llm（同目录）
    const counted = mockLlm({
      providers: ['zai-coding-cn', 'deepseek-official'],
      models: { 'zai-coding-cn': ['glm-5.3'], 'deepseek-official': ['deepseek-v4-flash'] },
      resolvable: new Set(['zai-coding-cn/glm-5.3', 'deepseek-official/deepseek-v4-flash']),
      modalities: { 'zai-coding-cn/glm-5.3': ['text'], 'deepseek-official/deepseek-v4-flash': ['text'] },
      counter,
    })
    services.llm = counted
    const p = child(65536) // 同一 agent 对象：缓存断言要求两次请求命中同一缓存槽
    await call(p, { provider: 'zai-coding-cn', model: 'kix-route:cross' })
    const after1 = counter.listModels
    await call(p, { provider: 'zai-coding-cn', model: 'kix-route:cross' })
    check('L5 成功解析缓存（二次零探测）', after1 > 0 && counter.listModels === after1)
  })
  await withListener(routeMod, { llm: soloLlm() }, async ({ call, services }) => {
    const p = child(65536) // 同一 agent：throw 后中途注册 provider，同一缓存槽必须重解析成功
    let threw = false
    try { await call(p, { provider: 'zai-coding-cn', model: 'kix-route:cross' }) } catch { threw = true }
    const dual = dualLlm()
    services.llm.listProviders = dual.listProviders
    services.llm.listModels = dual.listModels
    services.llm.resolveModelInfo = dual.resolveModelInfo
    const out = await call(p, { provider: 'zai-coding-cn', model: 'kix-route:cross' })
    check('L6 失败不缓存（中途注册即生效）', threw && out.provider === 'deepseek-official')
  })
  await withListener(routeMod, { llm: dualLlm() }, async ({ call }) => {
    const seed = { provider: 'zai-coding-cn', model: 'kix-route:cross' }
    const out = await call({ agent: { options: { subagentDepth: 0 } }, signal: undefined }, seed)
    check('L7 主会话不改写（原引用返回）', out === seed)
  })
  await withListener(routeMod, { llm: dualLlm() }, async ({ call }) => {
    const seed = { provider: 'zai-coding-cn', model: 'glm-4.7', maxTokens: 8192 }
    const out = await call(child(8192), seed)
    check('L8 非哨兵原样返回', out === seed)
  })
  await withListener(routeMod, {}, async ({ call }) => {
    let msg = 'no-throw'
    try { await call(child(), { provider: 'x', model: 'kix-route:cross' }) } catch (e) { msg = String(e.message) }
    check('L9 llm 缺失 → throw', msg.includes('llm'))
  })
  await withListener(routeMod, { llm: { listProviders: () => { throw new Error('directory down') } } }, async ({ call, warns }) => {
    let msg = 'no-throw'
    try { await call(child(), { provider: 'zai-coding-cn', model: 'kix-route:cross' }) } catch (e) { msg = String(e.message) }
    check('L11 探测失败 → 文案「探测失败，请重试」（审查修复，非「本部署无能力」）',
      msg.includes('探测失败') && msg.includes('请稍后重试') && !msg.includes('本部署无跨厂商正交验证能力'))
    check('L11b 底层错误已记录 warn', warns.some((w) => w.includes('探测已注册 provider 失败') && w.includes('directory down')))
  })

  // L10 组合顺序无关：kix-cost × kix-route 两种嵌套结果一致
  {
    const costMod = require('./kix-cost.js')
    const capture = (mod, services) => {
      let handler
      mod.apply({ on: (ev, h) => { if (ev === 'agent/request') handler = h }, get: (n) => services[n], logger: { warn: () => {} } })
      return handler
    }
    for (const [label, routeFile, costFile] of [['zh', path.join(__dirname, 'kix-route.js'), path.join(__dirname, 'kix-cost.js')]]) {
      void label
      const services = { llm: dualLlm() }
      const costH = capture(costMod, services)
      const routeH = capture(require(routeFile), services)
      const seed = () => Promise.resolve({ provider: 'zai-coding-cn', model: 'kix-route:cross', maxTokens: 65536 })
      const pa = child(65536)
      const outA = await costH(pa, () => routeH(pa, seed))
      const pb = child(65536)
      const outB = await routeH(pb, () => costH(pb, seed))
      check('L10a cost×route 双顺序同结果（deepseek+high）',
        JSON.stringify(outA) === JSON.stringify(outB) && outA.provider === 'deepseek-official' && outA.reasoningEffort === 'high')
      // 单厂商 throw 双顺序保持（cost 不吞 route 的错误）
      const solo = { llm: soloLlm() }
      const costH2 = capture(costMod, solo)
      const routeH2 = capture(require(routeFile), solo)
      let ta = false; let tb = false
      try { await costH2(child(65536), () => routeH2(child(65536), seed)) } catch { ta = true }
      try { await routeH2(child(65536), () => costH2(child(65536), seed)) } catch { tb = true }
      check('L10b 单厂商 throw 双顺序保持', ta && tb)
      // kix-cost 哨兵守卫：lite 探测不碰哨兵子代理
      const seedSent = { provider: 'zai-coding-cn', model: 'kix-route:cross', maxTokens: 65536 }
      const outSent = await costH(child(65536), () => Promise.resolve(seedSent))
      check('L10c kix-cost 哨兵守卫（原引用穿透）', outSent === seedSent)
      // n2 前缀漂移拦截：kix-cost 守卫前缀必须与 kix-route 哨兵前缀同值
      check('L10d kix-cost/kix-route 哨兵前缀一致（n2 拦截）', costMod.__internals.KIX_ROUTE_SENTINEL_PREFIX === SENTINEL_PREFIX)
    }
  }

  // L11 偏好表配置化（2026-08-17，外部审查 5.6「硬编码」技术债最小配置化）
  {
    const { mergePreferences, orderedModels, crossProviderOrder, resolveCrossRoute } = require('./kix-route.js').__internals
    // 不传 config = 默认表原样（行为零变化）
    const def = mergePreferences(undefined)
    check('L11a 不传 config → 默认偏好表原样',
      def.modelPreference['zai-coding-cn'][0] === 'glm-5.3' && def.crossProviderOrder.zhipu[0] === 'deepseek-official')
    // 浅合并：只覆盖传的键
    const merged = mergePreferences({ modelPreference: { 'zai-coding-cn': ['glm-5.5'] } })
    check('L11b modelPreference 子集覆盖，其余键保留',
      merged.modelPreference['zai-coding-cn'][0] === 'glm-5.5' && merged.modelPreference['deepseek-official'][0] === 'deepseek-v4-flash')
    // prefs 注入 orderedModels：新偏好生效
    check('L11c prefs 注入 orderedModels（新偏好在前）',
      JSON.stringify(orderedModels('zai-coding-cn', ['glm-5.3', 'glm-5.5'], merged)[0]) === '"glm-5.5"')
    // prefs 注入 crossProviderOrder：自定义 cross 顺序生效
    const prefs2 = mergePreferences({ crossProviderOrder: { zhipu: ['other-org'] }, genericCrossOrder: ['other-org', 'deepseek-official'] })
    const llmOther = mockLlm({ providers: ['other-org', 'deepseek-official'], models: { 'other-org': ['m1'], 'deepseek-official': ['deepseek-v4-flash'] }, resolvable: new Set(['other-org/m1', 'deepseek-official/deepseek-v4-flash']) })
    const order = crossProviderOrder(llmOther, 'zai-coding-cn', prefs2)
    check('L11d prefs 注入 crossProviderOrder（自定义顺序在前）', order[0] === 'other-org')
    const hit = await resolveCrossRoute(llmOther, 'zai-coding-cn', undefined, prefs2)
    check('L11e prefs 注入 resolveCrossRoute（路由到自定义 provider）', hit !== undefined && hit.provider === 'other-org')
    // 默认（无 prefs）：行为与旧版一致
    const hitDef = await resolveCrossRoute(llmOther, 'zai-coding-cn', undefined, undefined)
    check('L11f 无 prefs = 旧默认行为（deepseek 优先）', hitDef !== undefined && hitDef.provider === 'deepseek-official')
    // listener 级：apply(ctx, config) 传 config 后 cross 路由用新偏好
    const services = {
      llm: mockLlm({ providers: ['zai-coding-cn', 'other-org', 'deepseek-official'], models: { 'other-org': ['m1'], 'deepseek-official': ['deepseek-v4-flash'] }, resolvable: new Set(['other-org/m1', 'deepseek-official/deepseek-v4-flash']) }),
    }
    await withListener(routeMod, services, async ({ call }) => {
      const out = await call(child(65536), { provider: 'zai-coding-cn', model: 'kix-route:cross', maxTokens: 65536 })
      check('L11g 无 config 的 apply = 默认 deepseek', out.provider === 'deepseek-official')
    })
    // 带 config 的 apply（重新捕获 handler）
    {
      let handler
      const ctx = {
        on: (ev, h) => { if (ev === 'agent/request') handler = h },
        get: (n) => services[n],
        logger: { warn: () => {} },
      }
      routeMod.apply(ctx, { crossProviderOrder: { zhipu: ['other-org'] } })
      const out = await handler(child(65536), () => Promise.resolve({ provider: 'zai-coding-cn', model: 'kix-route:cross', maxTokens: 65536 }))
      check('L11h config 覆盖 apply → cross 路由 other-org', out.provider === 'other-org' && out.model === 'm1')
    }
  }

  // ── Q1-Q10：QUOTA/402 provider 熔断、TTL、父代理反馈与新 child 改路由 ──
  {
    const byCode = quotaFailureOf({ failure: { code: 'QUOTA', message: 'Insufficient Balance' } })
    const byStatus = quotaFailureOf({ cause: { status: 402, message: 'payment required' } })
    check('Q1 QUOTA 或嵌套 HTTP 402 精确识别', byCode?.code === 'QUOTA' && byStatus?.status === 402)
    check('Q2 429/网络/仅消息文本不误判为 QUOTA',
      quotaFailureOf({ code: 'RATE_LIMIT', status: 429 }) === undefined &&
      quotaFailureOf({ code: 'NETWORK', message: 'Insufficient Balance' }) === undefined)
    check('Q2b provider 可用性精确分类，内容/上下文错误不跨厂商',
      availabilityFailureOf({ code: 'RATE_LIMIT', status: 429 })?.code === 'RATE_LIMIT' &&
      availabilityFailureOf({ cause: { code: 'AUTH', status: 401 } })?.code === 'AUTH' &&
      availabilityFailureOf({ code: 'TIMEOUT' })?.code === 'TIMEOUT' &&
      availabilityFailureOf({ code: 'CONTEXT_WINDOW_EXCEEDED', status: 400 }) === undefined &&
      availabilityFailureOf({ code: 'INVALID_REQUEST', status: 400 }) === undefined)
    check('Q2c AUTH/402 硬熔断，TIMEOUT 暂态熔断',
      hardProviderFailure({ code: 'AUTH' }) && hardProviderFailure({ status: 402 }) &&
      !hardProviderFailure({ code: 'TIMEOUT' }) && DEFAULT_CROSS_PROVIDER_FAILOVERS === 2)
  }
  {
    let now = 1000
    const health = createProviderHealthCache(DEFAULT_PROVIDER_CIRCUIT_TTL_MS, () => now)
    const hard = health.markQuota('deepseek-official', { code: 'QUOTA', status: 402, message: 'Insufficient Balance' })
    now += DEFAULT_PROVIDER_CIRCUIT_TTL_MS * 100
    const hardStillOpen = !health.isHealthy('deepseek-official')
    const soft = health.markQuota('su2api', { code: 'QUOTA', message: 'temporary quota' })
    now += DEFAULT_PROVIDER_CIRCUIT_TTL_MS
    check('Q3 HTTP 402/余额不足硬熔断；其他 QUOTA 保留 TTL 半开',
      hard.hard === true && hardStillOpen && soft.hard === false && health.isHealthy('su2api') &&
      hardQuotaFailure({ status: 402 }) && hardQuotaFailure({ message: 'Insufficient Balance' }))
  }
  {
    const agent = {
      id: 'child-quota',
      options: { subagentDepth: 1, provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      session: { header: { origin: 'subagent', delegationDepth: 1 }, requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) },
    }
    const incident = quotaIncidentOf({ agent, turn: 1, step: 1, provider: 'deepseek-official', failure: { code: 'QUOTA', status: 402, message: 'Insufficient Balance' } })
    check('Q4 仅真实 request-error 的 child 首轮首步生成熔断 incident', incident?.provider === 'deepseek-official' &&
      quotaIncidentOf({ agent, turn: 1, step: 2, provider: 'deepseek-official', failure: { code: 'QUOTA' } }) === undefined &&
      quotaIncidentOf({ agent: { ...agent, options: { subagentDepth: 0 }, session: { header: {}, requestContext: agent.session.requestContext } }, turn: 1, step: 1, provider: 'deepseek-official', failure: { code: 'QUOTA' } }) === undefined)
    const entry = { hard: true, openedAt: 0, until: Number.POSITIVE_INFINITY }
    const text = quotaFeedbackText(incident, entry)
    const textWithHop = quotaFeedbackText(incident, entry, ['zai-coding-cn', 'deepseek-official', 'su2api'])
    check('Q5b 健康下一跳点名且不含已熔断 provider',
      textWithHop.includes('健康路由仍可用：zai-coding-cn, su2api') && !textWithHop.includes('健康路由仍可用：zai-coding-cn, deepseek-official') && text.includes('当前没有已识别的健康备用路由'))
    check('Q5 父代理反馈包含零证据、禁止复用且不机械补派',
      text.includes('deepseek-official/deepseek-v4-flash') && text.includes('零证据') &&
      text.includes('不要等待或复用') && text.includes('不要为补票机械重派') && text.includes('未解决信息缺口'))
  }
  {
    const llm = mockLlm({
      providers: ['deepseek-official', 'zai-coding-cn', 'su2api'],
      models: { 'deepseek-official': ['deepseek-v4-flash'], 'zai-coding-cn': ['glm-5.3'], su2api: ['gpt-5.6-luna', 'gpt-5.6-sol'] },
      resolvable: new Set(['deepseek-official/deepseek-v4-flash', 'zai-coding-cn/glm-5.3', 'su2api/gpt-5.6-luna', 'su2api/gpt-5.6-sol']),
    })
    const hit = await resolveFallbackRoute(llm, undefined, undefined, (provider) => provider !== 'deepseek-official')
    const crossHit = await resolveCrossRoute(llm, 'zai-coding-cn', undefined, undefined, (provider) => provider !== 'deepseek-official')
    check('Q6 普通 fallback 跳过熔断并按偏好选择 su2api/sol', hit?.provider === 'su2api' && hit?.model === 'gpt-5.6-sol')
    check('Q7 cross 保持异厂商约束并跳过熔断 DeepSeek', crossHit?.provider === 'su2api')
  }
  {
    const llm = mockLlm({
      providers: ['deepseek-official', 'su2api'],
      models: { 'deepseek-official': ['deepseek-v4-flash'], su2api: ['gpt-5.6-luna', 'gpt-5.6-sol'] },
      resolvable: new Set(['deepseek-official/deepseek-v4-flash', 'su2api/gpt-5.6-luna', 'su2api/gpt-5.6-sol']),
    })
    const realNow = Date.now
    let fakeNow = 1000
    Date.now = () => fakeNow
    try {
      const runtimeAgents = new Map()
      const agents = { get: (id) => runtimeAgents.get(String(id)) }
      await withRuntime(routeMod, { llm, agents }, { providerCircuitTtlMs: 200 }, async ({ emit, waterfall, call, listenerOptions, warns }) => {
        const steers = []
        const parent = { id: 'parent-1', steer: (message) => steers.push(message) }
        const failedChild = {
          id: 'child-402',
          options: { subagentDepth: 1, provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          session: { header: { origin: 'subagent', delegationDepth: 1, parentSession: 'parent-1' }, requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) },
        }
        runtimeAgents.set(parent.id, parent)
        runtimeAgents.set(failedChild.id, failedChild)
        await emit('subagent/start', { runId: 'run-child-402', id: 'child-402' })
        const failure = { agent: failedChild, turn: 1, step: 1, provider: 'deepseek-official', failure: { code: 'QUOTA', status: 402, message: 'Insufficient Balance' } }
        let retryCalls = 0
        const firstAction = await waterfall('agent/request-error', failure, async () => { retryCalls++; return { kind: 'retry' } })
        fakeNow += 120
        const secondAction = await waterfall('agent/request-error', failure, async () => { retryCalls++; return { kind: 'retry' } })
        // 跨过第一次 deadline（200ms），但仍处于第二次 QUOTA 刷新的 deadline 内。
        fakeNow += 120
        const notice = steers[0]?.content?.[0]?.text || ''
        check('Q8 request-error prepend 首次 402 即硬熔断、阻止旧 child retry、恰好 steer 一次且不命令重派',
          listenerOptions['agent/request-error']?.[0] === true && firstAction === undefined && secondAction === undefined && retryCalls === 0 &&
          steers.length === 1 && steers[0]?.source?.plugin === 'kix-route' && notice.includes('零证据') &&
          notice.includes('不要为补票机械重派') && !notice.includes('立即用一个新的') &&
          notice.includes('健康路由仍可用：su2api'))
        const fresh = { agent: { id: 'child-retry', options: { subagentDepth: 1 } }, signal: undefined }
        const rerouted = await call(fresh, { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 8192 })
        check('Q9 协调线程仅在信息缺口仍存在时另派 child，健康路由会跳过硬熔断 provider', rerouted.provider === 'su2api' && rerouted.model === 'gpt-5.6-sol' && warns.some((w) => w.includes('改路由')))
      })
    } finally {
      Date.now = realNow
    }
  }
  {
    const llm = mockLlm({ providers: ['deepseek-official'], models: { 'deepseek-official': ['deepseek-v4-flash'] }, resolvable: new Set(['deepseek-official/deepseek-v4-flash']) })
    const runtimeAgents = new Map()
    const agents = { get: (id) => runtimeAgents.get(String(id)) }
    await withRuntime(routeMod, { llm, agents }, undefined, async ({ emit, waterfall, call }) => {
      const steers = []
      const parent = { id: 'parent-rate-limit', steer: (message) => steers.push(message) }
      const failedChild = {
        id: 'child-rate-limit',
        options: { subagentDepth: 1 },
        session: { header: { origin: 'subagent', delegationDepth: 1, parentSession: parent.id }, requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) },
      }
      runtimeAgents.set(parent.id, parent)
      runtimeAgents.set(failedChild.id, failedChild)
      await emit('subagent/start', { runId: 'run-rate-limit', id: 'child-rate-limit' })
      let downstream = 0
      const action = await waterfall('agent/request-error', { agent: failedChild, turn: 1, step: 1, provider: 'deepseek-official', failure: { code: 'RATE_LIMIT', status: 429 } }, async () => { downstream++; return { kind: 'retry' } })
      const seed = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
      const out = await call({ agent: { options: { subagentDepth: 1 } }, signal: undefined }, seed)
      check('Q10 非 QUOTA 下传既有 retry、不 steer、不熔断、不改路由', steers.length === 0 && downstream === 1 && action?.kind === 'retry' && out === seed)
    })
  }
  {
    let now = 0
    const health = createProviderHealthCache(DEFAULT_PROVIDER_CIRCUIT_TTL_MS, () => now)
    health.markQuota('deepseek-official', { code: 'QUOTA' })
    now += 4 * 60 * 1000
    health.markQuota('deepseek-official', { code: 'QUOTA' })
    now += 2 * 60 * 1000
    const refreshedStillOpen = !health.isHealthy('deepseek-official')
    now += 3 * 60 * 1000
    check('Q11 并行/重复 QUOTA 刷新 provider TTL，旧 deadline 不会误半开', refreshedStillOpen && health.isHealthy('deepseek-official'))
  }
  {
    const llm = mockLlm({
      providers: ['zai-coding-cn', 'deepseek-official', 'su2api'],
      models: { 'zai-coding-cn': ['glm-5.3'], 'deepseek-official': ['deepseek-v4-flash'], su2api: ['gpt-5.6-sol'] },
      resolvable: new Set(['zai-coding-cn/glm-5.3', 'deepseek-official/deepseek-v4-flash', 'su2api/gpt-5.6-sol']),
    })
    const runtimeAgents = new Map()
    const agents = { get: (id) => runtimeAgents.get(String(id)) }
    await withRuntime(routeMod, { llm, agents }, { providerCircuitTtlMs: 5 }, async ({ emit, waterfall, call }) => {
      const cachedAgent = { agent: { id: 'cached-cross', options: { subagentDepth: 1, maxTokens: 65536 } }, signal: undefined }
      const seed = { provider: 'zai-coding-cn', model: 'kix-route:cross', maxTokens: 65536 }
      const before = await call(cachedAgent, seed)
      const parent = { id: 'parallel-parent', steer() {} }
      const failedChild = {
        id: 'parallel-402',
        options: { subagentDepth: 1 },
        session: { header: { origin: 'subagent', delegationDepth: 1, parentSession: parent.id }, requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) },
      }
      runtimeAgents.set(parent.id, parent)
      runtimeAgents.set(failedChild.id, failedChild)
      await emit('subagent/start', { runId: 'run-parallel-402', id: 'parallel-402' })
      await waterfall('agent/request-error', { agent: failedChild, turn: 1, step: 1, provider: 'deepseek-official', failure: { code: 'QUOTA', status: 402 } })
      const during = await call(cachedAgent, seed)
      await new Promise((resolve) => setTimeout(resolve, 10))
      const after = await call(cachedAgent, seed)
      check('Q12 已缓存 agent 遇 402 硬熔断后持续失效，不因短 TTL 自动撞回余额不足 provider',
        before.provider === 'deepseek-official' && during.provider === 'su2api' && after.provider === 'su2api')
    })
  }
  {
    const llm = mockLlm({
      providers: ['zai-coding-cn', 'deepseek-official', 'su2api', 'other-org'],
      models: {
        'zai-coding-cn': ['glm-5.3'],
        'deepseek-official': ['deepseek-v4-flash'],
        su2api: ['gpt-5.6-sol'],
        'other-org': ['other-v1'],
      },
      resolvable: new Set([
        'zai-coding-cn/glm-5.3',
        'deepseek-official/deepseek-v4-flash',
        'su2api/gpt-5.6-sol',
        'other-org/other-v1',
      ]),
    })
    const runtimeAgents = new Map()
    const agents = { get: (id) => runtimeAgents.get(String(id)) }
    await withRuntime(routeMod, { llm, agents }, undefined, async ({ emit, waterfall, call, warns }) => {
      const steers = []
      const parent = { id: 'cross-failover-parent', steer: (message) => steers.push(message) }
      let current
      const crossAgent = {
        id: 'cross-failover-child',
        options: { subagentDepth: 1, maxTokens: 65536 },
        session: {
          header: { origin: 'subagent', delegationDepth: 1, parentSession: parent.id },
          requestContext: () => current,
        },
      }
      runtimeAgents.set(parent.id, parent)
      runtimeAgents.set(crossAgent.id, crossAgent)
      await emit('subagent/start', { runId: 'run-cross-failover', id: crossAgent.id })
      const payload = { agent: crossAgent, signal: undefined }
      const seed = { provider: 'zai-coding-cn', model: 'kix-route:cross', maxTokens: 65536 }

      current = await call(payload, seed)
      const first = current
      const action1 = await waterfall('agent/request-error', {
        agent: crossAgent, turn: 1, step: 1, provider: first.provider,
        failure: { code: 'QUOTA', status: 402, message: 'Insufficient Balance' },
      })
      current = await call(payload, seed)
      const second = current
      const action2 = await waterfall('agent/request-error', {
        agent: crossAgent, turn: 1, step: 1, provider: second.provider,
        failure: { code: 'AUTH', status: 401, message: 'invalid key' },
      })
      current = await call(payload, seed)
      const third = current
      let downstream = 0
      const action3 = await waterfall('agent/request-error', {
        agent: crossAgent, turn: 1, step: 1, provider: third.provider,
        failure: { code: 'TIMEOUT', message: 'provider timed out' },
      }, async () => { downstream++; return { kind: 'retry' } })
      const notice = steers[0]?.content?.[0]?.text || ''

      check('Q13 cross 同一 child 可用性失败自动换 2 次且 provider 不重复',
        first.provider === 'deepseek-official' && second.provider === 'su2api' && third.provider === 'other-org' &&
        action1?.kind === 'retry' && action2?.kind === 'retry' && action3 === undefined && downstream === 0 &&
        new Set([first.provider, second.provider, third.provider]).size === 3)
      check('Q14 cross 达上限才零证据 steer 一次，日志记录两次自动 failover',
        steers.length === 1 && notice.includes('零证据') && notice.includes('2/2') &&
        warns.filter((w) => w.includes('自动 failover')).length === 2)
    })
  }
  {
    const llm = mockLlm({
      providers: ['zai-coding-cn', 'deepseek-official', 'su2api'],
      models: { 'zai-coding-cn': ['glm-5.3'], 'deepseek-official': ['deepseek-v4-flash'], su2api: ['gpt-5.6-sol'] },
      resolvable: new Set(['zai-coding-cn/glm-5.3', 'deepseek-official/deepseek-v4-flash', 'su2api/gpt-5.6-sol']),
    })
    const runtimeAgents = new Map()
    const agents = { get: (id) => runtimeAgents.get(String(id)) }
    await withRuntime(routeMod, { llm, agents }, { crossProviderFailovers: 0 }, async ({ waterfall, call }) => {
      const crossAgent = { id: 'cross-no-failover', options: { subagentDepth: 1 }, session: { header: { origin: 'subagent', delegationDepth: 1 } } }
      const payload = { agent: crossAgent, signal: undefined }
      const seed = { provider: 'zai-coding-cn', model: 'kix-route:cross' }
      const first = await call(payload, seed)
      const disabled = await waterfall('agent/request-error', {
        agent: crossAgent, turn: 1, step: 1, provider: first.provider,
        failure: { code: 'QUOTA', status: 402, message: 'Insufficient Balance' },
      })
      check('Q15 crossProviderFailovers=0 禁用自动换厂商', disabled === undefined)
    })
  }
  {
    const llm = mockLlm({
      providers: ['zai-coding-cn', 'deepseek-official', 'su2api'],
      models: { 'zai-coding-cn': ['glm-5.3'], 'deepseek-official': ['deepseek-v4-flash'], su2api: ['gpt-5.6-sol'] },
      resolvable: new Set(['zai-coding-cn/glm-5.3', 'deepseek-official/deepseek-v4-flash', 'su2api/gpt-5.6-sol']),
    })
    await withRuntime(routeMod, { llm, agents: { get: () => undefined } }, undefined, async ({ waterfall, call }) => {
      const crossAgent = { id: 'cross-context-error', options: { subagentDepth: 1 }, session: { header: { origin: 'subagent', delegationDepth: 1 } } }
      const payload = { agent: crossAgent, signal: undefined }
      const seed = { provider: 'zai-coding-cn', model: 'kix-route:cross' }
      const first = await call(payload, seed)
      let downstream = 0
      const action = await waterfall('agent/request-error', {
        agent: crossAgent, turn: 1, step: 1, provider: first.provider,
        failure: { code: 'CONTEXT_WINDOW_EXCEEDED', status: 400, message: 'too long' },
      }, async () => { downstream++; return { kind: 'retry' } })
      const again = await call(payload, seed)
      check('Q16 cross 上下文/请求错误不换 provider，交还宿主策略',
        downstream === 1 && action?.kind === 'retry' && again.provider === first.provider)
    })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})


