// kix-route — 子代理路由层：哨兵模型名 → 运行时可用路由自动解析（2026-08-21）
//
// 解决的问题：工具行钉死 (provider, model) 与「按可用模型自动配置」冲突。
//   钉死的三个代价：主模型换厂商后跨厂商观察者退化成同厂商（正交验证失效，
//   实例：agent-default-model 与 subagent_cross 同钉 glm-5.3）；模型线升级
//   要手工同步 settings 清单 + preset 钉值；分发到不同部署时钉值未必存在。
//
// 机制（源码实证）：
//   - 工具行 agentOptions 的自定义键会被 dsh-tool-subagent 的 zod 剥离，
//     但 model 是自由字符串 → 用哨兵模型名做档位标记：`kix-route:<tier>`。
//   - `agent/request` waterfall 里 resolved 配置可整体改写（kix-cost 的 lite
//     回退已实证 provider/model 可改；dsh-agent 的 installModelSelection 同款）。
//   - resolveChildAgentOptions 里 requested 展开在 parent 之后 → 行里只钉
//     model 哨兵时，resolved.provider = 父模型厂商，正好作为取反输入。
//   - read_image 路线门禁读 session.requestHeader()?.config（waterfall 之后
//     的真实路由）→ vision 哨兵改写后门禁看到的是真实视觉模型 ✓。
//   - 本插件缺失/未挂载时哨兵名直达适配器 → UNKNOWN_MODEL 响亮失败，
//     绝不静默退化成同厂商（cross 语义宁断不假）。
//
// 档位解析规则（候选全部来自 llm.listProviders()/listModels() 实时目录）：
//   - cross：父厂商取反（zhipu→deepseek 系 / deepseek→zai 系 / 其他厂商
//     → 已注册的任一异厂商），偏好顺序见 CROSS_PROVIDER_ORDER / MODEL_PREFERENCE；
//     无异厂商可用 → 回退环境默认路由（agentDefaultModel），仍不可用 → 保持
//     哨兵响亮失败；回退发生时 logger.warn 一次性告警（每 agent 缓存）。
//   - vision：第一个 inputModalities 声明 image 的模型（zai-vision 优先，
//     其余 provider 兜底）；找不到 → 环境默认（read_image 会按门禁拒）。
//   - thinker：deepseek-official 首选（同族深度思考档）；不可用 → 环境默认。
//
// 与 kix-cost 的关系（顺序无关，双向成立）：
//   - kix-cost 见到 `kix-route:` 哨兵直接跳过（lite 探测/effort 注入都不碰）；
//   - 本插件改写到 deepseek-official 且无显式 effort 时，自行调用 kix-cost
//     导出的 decideEffort 注入（与 kix-cost 规则同源：require('./kix-cost.js')，
//     不复制规则）。两种 waterfall 顺序下结果一致。
//
// 挂载方式：preset agent.cordis.yml（紧随 kix-cost 行之后）：
//   - id: kix-route
//     name: ./plugins/kix-route.js
//
// 纯逻辑导出：module.exports.__internals 供单元测试（kix-route.test.js）。

'use strict'

const SENTINEL_PREFIX = 'kix-route:'

// 厂商判定：provider id 前缀归一（zai-coding-cn/zai-vision → zhipu）。
function vendorOf(provider) {
  if (typeof provider !== 'string' || provider === '') return ''
  if (provider === 'zai-coding-cn' || provider === 'zai-vision') return 'zhipu'
  return provider.split('-')[0]
}

// 跨厂商取反的 provider 偏好顺序（按父厂商）；数组外的是通用兜底顺序。
const CROSS_PROVIDER_ORDER = {
  zhipu: ['deepseek-official'],
  deepseek: ['zai-coding-cn'],
}
const GENERIC_CROSS_ORDER = ['deepseek-official', 'zai-coding-cn']

// 各 provider 内部模型偏好（新的在前）；目录里不在表中的模型排在表后（目录序）。
const MODEL_PREFERENCE = {
  'deepseek-official': ['deepseek-v4-flash'],
  'zai-coding-cn': ['glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-4.5-air'],
  'zai-vision': ['glm-4.6v', 'glm-4.6v-flash', 'glm-4.5v'],
}

/** 已注册 provider id 列表（listProviders 条目的 provider 或 name 字段）。 */
function registeredProviders(llm) {
  try {
    return (llm.listProviders() ?? [])
      .map((p) => (p && typeof p === 'object' ? p.provider ?? p.name : undefined))
      .filter((id) => typeof id === 'string' && id !== '')
  } catch {
    return []
  }
}

/** provider 内模型排序：偏好表 ∩ 目录 在前，其余按目录序追加。 */
function orderedModels(provider, listedIds) {
  const pref = MODEL_PREFERENCE[provider] ?? []
  const listed = new Set(listedIds)
  const head = pref.filter((id) => listed.has(id))
  const tail = listedIds.filter((id) => !pref.includes(id))
  return [...head, ...tail]
}

/**
 * 在一个 provider 内选第一个可用模型；wantImage 时要求显式声明 image 输入
 * （与 read_image 门禁同严格度：undefined 视为不支持）。
 */
async function pickModel(llm, provider, { wantImage = false, signal } = {}) {
  let listed
  try {
    listed = await llm.listModels(provider)
  } catch {
    return undefined
  }
  const ids = orderedModels(provider, (listed ?? []).map((m) => m && m.id).filter((id) => typeof id === 'string'))
  for (const id of ids) {
    try {
      const info = await llm.resolveModelInfo(provider, id, signal)
      if (wantImage && !(info.inputModalities ?? []).includes('image')) continue
      return { provider, model: id }
    } catch {
      // 该模型不可解析 → 试下一个
    }
  }
  return undefined
}

/** 取反候选 provider 顺序：偏好表在前（剔除父厂商），其余已注册异厂商按目录序追加。 */
function crossProviderOrder(llm, parentProvider) {
  const parentVendor = vendorOf(parentProvider)
  const registered = registeredProviders(llm)
  const head = (CROSS_PROVIDER_ORDER[parentVendor] ?? GENERIC_CROSS_ORDER).filter(
    (p) => vendorOf(p) !== parentVendor,
  )
  const tail = registered.filter((p) => vendorOf(p) !== parentVendor && !head.includes(p))
  return [...head, ...tail]
}

/** cross：父厂商取反，第一个可用异厂商模型。 */
async function resolveCrossRoute(llm, parentProvider, signal) {
  for (const provider of crossProviderOrder(llm, parentProvider)) {
    const hit = await pickModel(llm, provider, { signal })
    if (hit !== undefined) return hit
  }
  return undefined
}

/** vision：zai-vision 优先，其后任何 provider 中第一个声明 image 输入的模型。 */
async function resolveVisionRoute(llm, signal) {
  const order = ['zai-vision', ...registeredProviders(llm).filter((p) => p !== 'zai-vision')]
  for (const provider of order) {
    const hit = await pickModel(llm, provider, { wantImage: true, signal })
    if (hit !== undefined) return hit
  }
  return undefined
}

/** thinker：deepseek-official 首选（同族深度思考），目录内其余 deepseek 模型兜底。 */
async function resolveThinkerRoute(llm, signal) {
  if (registeredProviders(llm).includes('deepseek-official')) {
    const hit = await pickModel(llm, 'deepseek-official', { signal })
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 从 resolved 配置解析哨兵档位；非哨兵返回 undefined。 */
function sentinelTierOf(model) {
  if (typeof model !== 'string' || !model.startsWith(SENTINEL_PREFIX)) return undefined
  const tier = model.slice(SENTINEL_PREFIX.length)
  return tier === 'cross' || tier === 'vision' || tier === 'thinker' ? tier : undefined
}

// ── 插件本体 ────────────────────────────────────────────────────────────────

module.exports = {
  name: 'kix-route',
  apply(ctx) {
    // 每 agent 缓存一次解析结果（稳定优先：目录中途变化不追新）；degraded 标记防重复告警。
    const routes = new WeakMap()

    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      if (resolved === undefined) return resolved
      const tier = sentinelTierOf(resolved.model)
      if (tier === undefined) return resolved
      const agent = payload.agent
      if (agent === undefined) return resolved // 无 agent 上下文无从缓存，保持原样（将响亮失败）
      const opts = agent.options ?? {}
      if ((opts.subagentDepth ?? 0) < 1) return resolved // 哨兵只该出现在子代理；主会话异常路由不碰

      let cached = routes.get(agent)
      if (cached === undefined) {
        cached = { hit: undefined, degraded: false }
        routes.set(agent, cached)
      }
      const llm = ctx.get('llm')
      const defaults = ctx.get('agentDefaultModel')
      const defaultRoute = (() => {
        if (defaults === undefined) return undefined
        try {
          const sel = defaults.currentSelection()
          return sel !== undefined && sel.provider && sel.model ? { provider: sel.provider, model: sel.model } : undefined
        } catch {
          return undefined
        }
      })()

      let hit = cached.hit
      if (hit === undefined) {
        if (llm !== undefined) {
          if (tier === 'cross') hit = await resolveCrossRoute(llm, resolved.provider, payload.signal)
          else if (tier === 'vision') hit = await resolveVisionRoute(llm, payload.signal)
          else hit = await resolveThinkerRoute(llm, payload.signal)
        }
        // 档位解析失败 → 环境默认路由兜底（cross 语义降级，一次性告警）
        if (hit === undefined && defaultRoute !== undefined) {
          hit = defaultRoute
          if (!cached.degraded) {
            cached.degraded = true
            ctx.logger.warn(
              `kix-route: tier "${tier}" 无可用候选，回退环境默认路由 ${defaultRoute.provider}/${defaultRoute.model}（cross 档此时为同厂商降级，正交验证失效）`,
            )
          }
        }
        if (hit !== undefined) cached.hit = hit
      }

      if (hit === undefined) return resolved // 连默认路由都没有 → 保持哨兵，UNKNOWN_MODEL 响亮失败

      let config = { ...resolved, provider: hit.provider, model: hit.model }
      // 顺序无关的 effort 注入：改写到 deepseek 且无显式 effort → 与 kix-cost 同源规则
      if (config.reasoningEffort === undefined) {
        const decideEffort = require('./kix-cost.js').__internals?.decideEffort
        if (typeof decideEffort === 'function') {
          const effort = decideEffort(hit.provider, opts.maxTokens ?? resolved.maxTokens)
          if (effort !== undefined) config = { ...config, reasoningEffort: effort }
        }
      }
      return config
    })
  },
}

module.exports.__internals = {
  SENTINEL_PREFIX,
  vendorOf,
  registeredProviders,
  orderedModels,
  pickModel,
  crossProviderOrder,
  resolveCrossRoute,
  resolveVisionRoute,
  resolveThinkerRoute,
  sentinelTierOf,
}
