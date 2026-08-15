// kix-route — subagent routing layer: sentinel model name -> live available route (2026-08-15)
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
//
// Tier resolution (candidates come entirely from the live llm.listProviders()/
// listModels() catalogs):
//   - cross: inverted from the parent's vendor (zhipu -> deepseek family /
//     deepseek -> zai family / any other vendor -> any registered different
//     vendor), preference order in CROSS_PROVIDER_ORDER / MODEL_PREFERENCE;
//   - vision: the first model whose inputModalities declares image (zai-vision
//     first, then any other provider);
//   - thinker: deepseek-family providers (deepseek-official preferred).
//
// Boundary semantics (single-vendor / no-deepseek / no-vision deployments,
// v5.9.1) — core principle: when the ROLE'S core capability is missing, fail
// with a message the parent model receives; when the role still stands,
// degrade with a warning:
//   - cross with no foreign vendor (single-vendor deployment) -> FAIL AT START
//     (throw; the error lists registered providers + what to do instead, and
//     reaches the parent via the failed run) — never silently degrade to
//     same-vendor: cross's entire value is vendor orthogonality; false
//     independence is worse than failure;
//   - vision with no image-declaring model -> same fail-at-start (with setup
//     advice); no vision-less degradation (skips the spawn -> read_image-gate
//     bounce round-trip entirely);
//   - thinker with no deepseek -> degrade to the environment default route +
//     one-time warning (the role still stands: big-budget deep thinking; the
//     GLM adapter manages effort itself);
//   - resolution failures are NOT cached: a provider registered mid-session
//     takes effect on the next request;
//   - if this plugin is missing, the sentinel reaches the adapter verbatim ->
//     UNKNOWN_MODEL fails LOUD.
//
// Relationship with kix-cost (order-independent, holds in BOTH waterfall orders):
//   - kix-cost skips any child carrying a `kix-route:` sentinel (neither its
//     lite probe nor its effort injection touches them);
//   - when this plugin rewrites to deepseek with no explicit effort, it calls
//     kix-cost's exported decideEffort itself (require guarded by try/catch:
//     a missing kix-cost.js only skips effort injection, routing is unaffected).
//
// Mount (preset agent.cordis.yml, right after the kix-cost row):
//   - id: kix-route
//     name: ./plugins/kix-route.js
//
// Pure logic exported via module.exports.__internals for kix-route.test.js.

'use strict'

// Reuse kix-cost's effort rule from the same source (missing file/changed
// export just skips injection; routing is unaffected).
let decideEffortShared
try {
  decideEffortShared = require('./kix-cost.js').__internals?.decideEffort
} catch {
  decideEffortShared = undefined
}

const SENTINEL_PREFIX = 'kix-route:'

// Vendor classification: normalize provider id prefixes (zai-*/zhipu-* -> zhipu, incl. zai-coding-cn/zai-vision).
function vendorOf(provider) {
  if (typeof provider !== 'string' || provider === '') return ''
  if (provider === 'zai' || provider === 'zhipu' || provider.startsWith('zai-') || provider.startsWith('zhipu-')) return 'zhipu'
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

/**
 * Registered provider ROUTE KEYS.
 * Contract (verified against dsh-llm prepareRoutes): listProviders() returns
 * {id, name} where id === the registration route key (enforced at registration
 * time) and name is a DISPLAY name (e.g. "DeepSeek") — a display name must
 * never be used for routing (the B1 fix: the old implementation read
 * p.provider ?? p.name, got display names, and broke vision/thinker entirely).
 */
function registeredProviders(llm) {
  try {
    return (llm.listProviders() ?? [])
      .map((p) => (p && typeof p === 'object' ? p.id ?? p.provider : undefined))
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
  // contract defense: a non-array return (broken catalog) counts as empty; never let a bare TypeError escape pickModel
  const entries = Array.isArray(listed) ? listed : []
  const ids = orderedModels(provider, entries.map((m) => m && m.id).filter((id) => typeof id === 'string'))
  for (const id of ids) {
    if (signal?.aborted) return undefined // stop probing once aborted; the loop layer's throwIfAborted owns the semantics
    try {
      const info = await llm.resolveModelInfo(provider, id, signal)
      if (wantImage && !(info.inputModalities ?? []).includes('image')) continue
      return { provider, model: id }
    } catch {
      if (signal?.aborted) return undefined // an abort-induced failure is not "model unavailable"
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

/** vision: zai-vision first (only when registered), then the first image-declaring model on any provider. */
async function resolveVisionRoute(llm, signal) {
  const registered = registeredProviders(llm)
  const order = registered.includes('zai-vision')
    ? ['zai-vision', ...registered.filter((p) => p !== 'zai-vision')]
    : registered
  for (const provider of order) {
    const hit = await pickModel(llm, provider, { wantImage: true, signal })
    if (hit !== undefined) return hit
  }
  return undefined
}

/** thinker: deepseek-family providers (deepseek-official preferred, other deepseek-* in catalog order as backup). */
async function resolveThinkerRoute(llm, signal) {
  const registered = registeredProviders(llm)
  const rest = registered.filter((p) => p !== 'deepseek-official' && vendorOf(p) === 'deepseek')
  const order = registered.includes('deepseek-official')
    ? ['deepseek-official', ...rest]
    : rest
  for (const provider of order) {
    const hit = await pickModel(llm, provider, { signal })
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

/**
 * Action when a tier resolved no candidate (pure function, unit-test entry):
 *   - hit resolved -> use;
 *   - thinker unresolved + environment default exists -> use (degraded, role stands);
 *   - everything else (cross/vision core capability missing, or thinker without
 *     even a default) -> fail (failText built by the caller; reaches the parent
 *     via the failed run).
 */
function decideTierAction(tier, hit, defaultRoute, failText) {
  if (hit !== undefined) return { kind: 'use', hit }
  if (tier === 'thinker' && defaultRoute !== undefined) {
    return { kind: 'use', hit: defaultRoute, degraded: true }
  }
  return { kind: 'fail', message: failText }
}

/** cross failure text: parent vendor + registered list + two ways out (subagent / configure a second vendor). */
function crossFailText(parentProvider, registered) {
  const vendor = vendorOf(parentProvider) || 'unknown'
  const list = registered.length > 0 ? registered.join(', ') : 'none'
  return `kix-route: subagent_cross needs a model from a vendor different from the main model's (parent vendor ${vendor}; registered providers: ${list}). This deployment has no cross-vendor orthogonal verification: use a plain subagent for same-vendor review and state "single-vendor deployment, no independent second channel" in the conclusion; or have the user configure a second vendor under llm-pi-ai.providers in settings.yaml and retry.`
}

/** vision failure text: setup advice, avoiding the spawn -> read_image-gate bounce. */
function visionFailText(registered) {
  const list = registered.length > 0 ? registered.join(', ') : 'none'
  return `kix-route: subagent_vision needs a model declaring image input; none in the current catalog declares it (registered providers: ${list}). This deployment has no vision capability: configure a vision model in settings.yaml (e.g. zai-vision glm-4.6v), or ask the user to describe the image in words / handle the path outside the agent.`
}

/** thinker hard failure (no deepseek AND no environment default — extreme boundary). */
function thinkerFailText() {
  return 'kix-route: subagent_thinker resolved no deepseek-family route and the environment default route is unavailable (agentDefaultModel missing). Check the llm-pi-ai configuration in settings.yaml.'
}

// ── plugin body ─────────────────────────────────────────────────────────────

module.exports = {
  name: 'kix-route',
  apply(ctx) {
    // Successful resolutions cached per agent (stability over liveness); failures
    // are NOT cached — a provider registered mid-session takes effect next request.
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

      const llm = ctx.get('llm')
      if (llm === undefined) {
        throw new Error(`kix-route: llm service unavailable; cannot resolve the ${SENTINEL_PREFIX}${tier} sentinel route (check whether the host llm plugin is loaded)`)
      }

      let cached = routes.get(agent)
      if (cached === undefined) {
        cached = { hit: undefined, degraded: false }
        routes.set(agent, cached)
      }

      let hit = cached.hit
      if (hit === undefined) {
        if (tier === 'cross') hit = await resolveCrossRoute(llm, resolved.provider, payload.signal)
        else if (tier === 'vision') hit = await resolveVisionRoute(llm, payload.signal)
        else hit = await resolveThinkerRoute(llm, payload.signal)

        let defaultRoute
        if (hit === undefined && tier === 'thinker') {
          const defaults = ctx.get('agentDefaultModel')
          if (defaults !== undefined) {
            try {
              const sel = defaults.currentSelection()
              if (sel !== undefined && sel.provider && sel.model) {
                defaultRoute = { provider: sel.provider, model: sel.model }
              }
            } catch {
              defaultRoute = undefined
            }
          }
        }

        const failText = tier === 'cross'
          ? crossFailText(resolved.provider, registeredProviders(llm))
          : tier === 'vision'
            ? visionFailText(registeredProviders(llm))
            : thinkerFailText()
        const action = decideTierAction(tier, hit, defaultRoute, failText)
        if (action.kind === 'fail') throw new Error(action.message)
        hit = action.hit
        if (action.degraded === true && !cached.degraded) {
          cached.degraded = true
          ctx.logger.warn(
            `kix-route: tier "thinker" resolved no deepseek route; degrading to environment default ${hit.provider}/${hit.model} (role still stands: big-budget deep thinking; adapter manages effort)`,
          )
        }
        cached.hit = hit
      }

      let config = { ...resolved, provider: hit.provider, model: hit.model }
      // order-independent effort injection: rewritten to deepseek with no explicit effort -> same rule as kix-cost
      if (config.reasoningEffort === undefined && typeof decideEffortShared === 'function') {
        const effort = decideEffortShared(hit.provider, opts.maxTokens ?? resolved.maxTokens)
        if (effort !== undefined) config = { ...config, reasoningEffort: effort }
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
  decideTierAction,
  crossFailText,
  visionFailText,
  thinkerFailText,
}
