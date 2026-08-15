// kix-route — subagent routing layer: sentinel model name -> live available route (2026-08-21)
//
// Problem solved: pinning exact (provider, model) pairs in tool rows conflicts
//   with "configure by whatever models are actually available".
//   Three costs of pinning: the cross-vendor observer degrades to same-vendor
//   when the main model switches vendor (orthogonal verification silently
//   void — live instance: agent-default-model and subagent_cross both glm-5.3);
//   model-line upgrades need manual settings+preset sync; pinned values may not
//   exist on other deployments this preset is distributed to.
//
// Mechanism (source-verified):
//   - Custom keys in a tool row's agentOptions are STRIPPED by dsh-tool-subagent's
//     zod schema, but `model` is a free string -> use a sentinel model name as
//     the tier marker: `kix-route:<tier>`.
//   - The `agent/request` waterfall allows rewriting the whole resolved config
//     (kix-cost's lite fallback already rewrites provider/model; dsh-agent's own
//     installModelSelection uses the same seam).
//   - In resolveChildAgentOptions the requested spread comes AFTER the parent's,
//     so when a row pins only the model sentinel, resolved.provider equals the
//     parent's vendor — exactly the inversion input.
//   - The read_image route gate reads session.requestHeader()?.config (the
//     POST-waterfall real route) -> after rewrite the gate sees the real vision
//     model. OK.
//   - If this plugin is missing, the sentinel reaches the adapter verbatim ->
//     UNKNOWN_MODEL fails LOUD; never silently degrades to same-vendor (the
//     cross guarantee breaks rather than lies).
//
// Tier resolution (candidates come entirely from the live llm.listProviders()/
// listModels() catalogs):
//   - cross: inverted from the parent's vendor (zhipu -> deepseek family /
//     deepseek -> zai family / any other vendor -> any registered different
//     vendor), preference order in CROSS_PROVIDER_ORDER / MODEL_PREFERENCE;
//     when no different-vendor route resolves -> fall back to the environment
//     default route (agentDefaultModel); if even that is absent, keep the
//     sentinel and fail loud. Fallbacks log a one-time warning (per-agent cache).
//   - vision: the first model whose inputModalities declares image (zai-vision
//     first, then any other provider); none found -> environment default (the
//     read_image gate will then refuse image reads).
//   - thinker: deepseek-official preferred (same-family deep thinking); when
//     unavailable -> environment default.
//
// Relationship with kix-cost (order-independent, holds in BOTH waterfall orders):
//   - kix-cost skips any child carrying a `kix-route:` sentinel (neither its
//     lite probe nor its effort injection touches them);
//   - when this plugin rewrites to deepseek-official with no explicit effort,
//     it calls kix-cost's exported decideEffort itself (required from
//     './kix-cost.js' — the rule is shared, not duplicated).
//
// Mount (preset agent.cordis.yml, right after the kix-cost row):
//   - id: kix-route
//     name: ./plugins/kix-route.js
//
// Pure logic exported via module.exports.__internals for kix-route.test.js.
'use strict'

const SENTINEL_PREFIX = 'kix-route:'

// Vendor classification: normalize provider id prefixes (zai-coding-cn/zai-vision -> zhipu).
function vendorOf(provider) {
  if (typeof provider !== 'string' || provider === '') return ''
  if (provider === 'zai-coding-cn' || provider === 'zai-vision') return 'zhipu'
  return provider.split('-')[0]
}

// Preferred inverted-vendor provider order (by parent vendor); outside entries form the generic fallback order.
const CROSS_PROVIDER_ORDER = {
  zhipu: ['deepseek-official'],
  deepseek: ['zai-coding-cn'],
}
const GENERIC_CROSS_ORDER = ['deepseek-official', 'zai-coding-cn']

// Per-provider model preference (newest first); catalog models not listed go after, in catalog order.
const MODEL_PREFERENCE = {
  'deepseek-official': ['deepseek-v4-flash'],
  'zai-coding-cn': ['glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-4.5-air'],
  'zai-vision': ['glm-4.6v', 'glm-4.6v-flash', 'glm-4.5v'],
}

/** Registered provider ids (the provider or name field of listProviders entries). */
function registeredProviders(llm) {
  try {
    return (llm.listProviders() ?? [])
      .map((p) => (p && typeof p === 'object' ? p.provider ?? p.name : undefined))
      .filter((id) => typeof id === 'string' && id !== '')
  } catch {
    return []
  }
}

/** Model order inside one provider: preference-list intersection first, then remaining catalog order. */
function orderedModels(provider, listedIds) {
  const pref = MODEL_PREFERENCE[provider] ?? []
  const listed = new Set(listedIds)
  const head = pref.filter((id) => listed.has(id))
  const tail = listedIds.filter((id) => !pref.includes(id))
  return [...head, ...tail]
}

/**
 * Pick the first usable model inside one provider; with wantImage, require an
 * explicit image input declaration (as strict as the read_image gate: undefined counts as no).
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
      // model unresolvable -> try the next
    }
  }
  return undefined
}

/** Inverted candidate provider order: preference list first (parent vendor excluded), then remaining registered foreign vendors in catalog order. */
function crossProviderOrder(llm, parentProvider) {
  const parentVendor = vendorOf(parentProvider)
  const registered = registeredProviders(llm)
  const head = (CROSS_PROVIDER_ORDER[parentVendor] ?? GENERIC_CROSS_ORDER).filter(
    (p) => vendorOf(p) !== parentVendor,
  )
  const tail = registered.filter((p) => vendorOf(p) !== parentVendor && !head.includes(p))
  return [...head, ...tail]
}

/** cross: first usable model from a vendor different from the parent's. */
async function resolveCrossRoute(llm, parentProvider, signal) {
  for (const provider of crossProviderOrder(llm, parentProvider)) {
    const hit = await pickModel(llm, provider, { signal })
    if (hit !== undefined) return hit
  }
  return undefined
}

/** vision: zai-vision first, then the first image-declaring model on any provider. */
async function resolveVisionRoute(llm, signal) {
  const order = ['zai-vision', ...registeredProviders(llm).filter((p) => p !== 'zai-vision')]
  for (const provider of order) {
    const hit = await pickModel(llm, provider, { wantImage: true, signal })
    if (hit !== undefined) return hit
  }
  return undefined
}

/** thinker: deepseek-official preferred (same-family deep thinking), other catalog deepseek models as backup. */
async function resolveThinkerRoute(llm, signal) {
  if (registeredProviders(llm).includes('deepseek-official')) {
    const hit = await pickModel(llm, 'deepseek-official', { signal })
    if (hit !== undefined) return hit
  }
  return undefined
}

/** Extract the sentinel tier from a resolved config; undefined when not a sentinel. */
function sentinelTierOf(model) {
  if (typeof model !== 'string' || !model.startsWith(SENTINEL_PREFIX)) return undefined
  const tier = model.slice(SENTINEL_PREFIX.length)
  return tier === 'cross' || tier === 'vision' || tier === 'thinker' ? tier : undefined
}

// ── plugin body ─────────────────────────────────────────────────────────────

module.exports = {
  name: 'kix-route',
  apply(ctx) {
    // Resolve once per agent (stability over liveness: mid-session catalog changes are not chased); the degraded flag avoids repeat warnings.
    const routes = new WeakMap()

    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      if (resolved === undefined) return resolved
      const tier = sentinelTierOf(resolved.model)
      if (tier === undefined) return resolved
      const agent = payload.agent
      if (agent === undefined) return resolved // no agent context to cache on; leave as-is (will fail loud)
      const opts = agent.options ?? {}
      if ((opts.subagentDepth ?? 0) < 1) return resolved // sentinels belong to subagents only; never touch main-session routing

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
        // tier resolution failed -> environment default route (cross semantics degraded, one-time warning)
        if (hit === undefined && defaultRoute !== undefined) {
          hit = defaultRoute
          if (!cached.degraded) {
            cached.degraded = true
            ctx.logger.warn(
              `kix-route: tier "${tier}" has no usable candidate; falling back to environment default ${defaultRoute.provider}/${defaultRoute.model} (cross is now same-vendor degraded: orthogonal verification is void)`,
            )
          }
        }
        if (hit !== undefined) cached.hit = hit
      }

      if (hit === undefined) return resolved // not even a default route -> keep the sentinel and fail loud with UNKNOWN_MODEL

      let config = { ...resolved, provider: hit.provider, model: hit.model }
      // order-independent effort injection: rewritten to deepseek with no explicit effort -> same rule as kix-cost
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
