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
  pickModel,
  decideTierAction,
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

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})


