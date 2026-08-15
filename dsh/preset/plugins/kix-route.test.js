// kix-route 单元测试 — 纯逻辑层（__internals），不依赖 Cordis 运行时。
// 运行：node plugins/kix-route.test.js

'use strict'

const {
  SENTINEL_PREFIX,
  vendorOf,
  orderedModels,
  crossProviderOrder,
  sentinelTierOf,
  resolveCrossRoute,
  resolveVisionRoute,
  resolveThinkerRoute,
  pickModel,
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

// ── mock llm：目录 + 可解析集合都可注入 ──────────────────────────────────
function mockLlm({ providers = [], models = {}, resolvable = new Set(), modalities = {} } = {}) {
  return {
    listProviders: () => providers.map((p) => ({ provider: p })),
    listModels: async (provider) =>
      (models[provider] ?? []).map((id) => ({ id })),
    resolveModelInfo: async (provider, model) => {
      if (!resolvable.has(`${provider}/${model}`)) throw new Error('UNKNOWN_MODEL')
      return { provider, id: model, inputModalities: modalities[`${provider}/${model}`] }
    },
  }
}

async function main() {
  // ── vendorOf / sentinelTierOf ───────────────────────────────────────────
  check('zai-coding-cn → zhipu', vendorOf('zai-coding-cn') === 'zhipu')
  check('zai-vision → zhipu', vendorOf('zai-vision') === 'zhipu')
  check('deepseek-official → deepseek', vendorOf('deepseek-official') === 'deepseek')
  check('未知 provider 取首段', vendorOf('other-org') === 'other')
  check('空串 → 空厂商', vendorOf('') === '')
  check('哨兵 cross 识别', sentinelTierOf('kix-route:cross') === 'cross')
  check('哨兵 vision 识别', sentinelTierOf('kix-route:vision') === 'vision')
  check('哨兵 thinker 识别', sentinelTierOf('kix-route:thinker') === 'thinker')
  check('未知档位 → undefined', sentinelTierOf('kix-route:other') === undefined)
  check('普通模型 → undefined', sentinelTierOf('glm-5.3') === undefined)
  check('前缀常量正确', SENTINEL_PREFIX === 'kix-route:')

  // ── orderedModels：偏好表在前，目录新模型按目录序追加 ───────────────────
  check(
    '偏好排序：glm-5.3 在 glm-4.7 前',
    JSON.stringify(orderedModels('zai-coding-cn', ['glm-4.7', 'glm-5.3'])) === JSON.stringify(['glm-5.3', 'glm-4.7']),
  )
  check(
    '目录中不在偏好表的模型追加在后',
    JSON.stringify(orderedModels('zai-coding-cn', ['glm-x9', 'glm-4.7'])) === JSON.stringify(['glm-4.7', 'glm-x9']),
  )

  // ── crossProviderOrder：取反 + 偏好序 ───────────────────────────────────
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
    // 主 GLM → 取反 deepseek-v4-flash
    const llm = mockLlm({
      providers: ['zai-coding-cn', 'deepseek-official'],
      models: { 'deepseek-official': ['deepseek-v4-flash'], 'zai-coding-cn': ['glm-5.3'] },
      resolvable: new Set(['deepseek-official/deepseek-v4-flash', 'zai-coding-cn/glm-5.3']),
    })
    const hit = await resolveCrossRoute(llm, 'zai-coding-cn', undefined)
    check('cross：父=zhipu → deepseek-v4-flash', hit !== undefined && hit.provider === 'deepseek-official' && hit.model === 'deepseek-v4-flash')
  }
  {
    // 主 DeepSeek → 取反 zai 首选模型（偏好表第一个可用的）
    const llm = mockLlm({
      providers: ['deepseek-official', 'zai-coding-cn'],
      models: { 'zai-coding-cn': ['glm-4.7', 'glm-5.2'], 'deepseek-official': ['deepseek-v4-flash'] },
      resolvable: new Set(['zai-coding-cn/glm-5.2', 'zai-coding-cn/glm-4.7', 'deepseek-official/deepseek-v4-flash']),
    })
    const hit = await resolveCrossRoute(llm, 'deepseek-official', undefined)
    check('cross：父=deepseek → zai 偏好序首个可用（glm-5.2）', hit !== undefined && hit.model === 'glm-5.2')
  }
  {
    // 首选模型不可解析 → 目录内下一个
    const llm = mockLlm({
      providers: ['deepseek-official', 'zai-coding-cn'],
      models: { 'zai-coding-cn': ['glm-5.3', 'glm-4.7'] },
      resolvable: new Set(['zai-coding-cn/glm-4.7']),
    })
    const hit = await resolveCrossRoute(llm, 'deepseek-official', undefined)
    check('cross：首选不可用回退 glm-4.7', hit !== undefined && hit.model === 'glm-4.7')
  }
  {
    // 无任何异厂商 → undefined（插件层回退环境默认）
    const llm = mockLlm({
      providers: ['zai-coding-cn'],
      models: { 'zai-coding-cn': ['glm-5.3'] },
      resolvable: new Set(['zai-coding-cn/glm-5.3']),
    })
    check('cross：无异厂商可用 → undefined', (await resolveCrossRoute(llm, 'zai-coding-cn', undefined)) === undefined)
  }

  // ── resolveVisionRoute：image 声明过滤（undefined = 不支持，与门禁同严格度）──
  {
    const llm = mockLlm({
      providers: ['deepseek-official', 'zai-vision'],
      models: { 'zai-vision': ['glm-4.6v', 'glm-4.5v'], 'deepseek-official': ['deepseek-v4-flash'] },
      resolvable: new Set(['zai-vision/glm-4.6v', 'zai-vision/glm-4.5v', 'deepseek-official/deepseek-v4-flash']),
      modalities: {
        'zai-vision/glm-4.6v': ['text', 'image'],
        'zai-vision/glm-4.5v': ['text'],
        'deepseek-official/deepseek-v4-flash': ['text'],
      },
    })
    const hit = await resolveVisionRoute(llm, undefined)
    check('vision：跳过无 image 声明的模型，命中 glm-4.6v', hit !== undefined && hit.model === 'glm-4.6v')
  }
  {
    // modalities 未声明（undefined）→ 不算视觉模型
    const llm = mockLlm({
      providers: ['zai-vision'],
      models: { 'zai-vision': ['glm-4.6v'] },
      resolvable: new Set(['zai-vision/glm-4.6v']),
      modalities: {},
    })
    check('vision：inputModalities 未声明 → undefined', (await resolveVisionRoute(llm, undefined)) === undefined)
  }

  // ── resolveThinkerRoute ─────────────────────────────────────────────────
  {
    const llm = mockLlm({
      providers: ['deepseek-official'],
      models: { 'deepseek-official': ['deepseek-v4-flash'] },
      resolvable: new Set(['deepseek-official/deepseek-v4-flash']),
    })
    const hit = await resolveThinkerRoute(llm, undefined)
    check('thinker：deepseek-official/deepseek-v4-flash', hit !== undefined && hit.model === 'deepseek-v4-flash')
  }
  {
    const llm = mockLlm({ providers: ['zai-coding-cn'], models: { 'zai-coding-cn': ['glm-5.3'] }, resolvable: new Set(['zai-coding-cn/glm-5.3']) })
    check('thinker：deepseek 不可用 → undefined（回退环境默认）', (await resolveThinkerRoute(llm, undefined)) === undefined)
  }

  // ── pickModel：单 provider 内逐模型探测 ────────────────────────────────
  {
    const llm = mockLlm({
      providers: ['zai-coding-cn'],
      models: { 'zai-coding-cn': ['glm-5.3', 'glm-4.7'] },
      resolvable: new Set(['zai-coding-cn/glm-4.7']),
    })
    const hit = await pickModel(llm, 'zai-coding-cn', {})
    check('pickModel：跳过不可解析，取 glm-4.7', hit !== undefined && hit.model === 'glm-4.7')
  }
  {
    const broken = { listModels: async () => { throw new Error('boom') }, resolveModelInfo: async () => { throw new Error('x') } }
    check('pickModel：listModels 抛错 → undefined', (await pickModel(broken, 'p', {})) === undefined)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
