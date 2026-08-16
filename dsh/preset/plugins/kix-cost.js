// kix-cost — 子代理成本层：机械档自动选型 + 思考强度分层（v5.8，2026-08-15）
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
//
// 不干预的路径：
//   - 主会话：options 无 subagentDepth 标记 → 跳过；且其请求配置已带显式 effort；
//   - kix-route 哨兵子代理（model 形如 kix-route:<tier>，即 cross/vision/
//     thinker 档）：路由与 effort 由 kix-route 全权处理（deepseek 改写后复用
//     本文件的 decideEffort，规则同源不复制）；
//   - zai-coding-cn / zai-vision 子代理（lite 可用时 / 回退后的 cross 等）：
//     GLM 思考由适配器管理，不注入 effort；
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

/** 是否为子代理（resolveChildAgentOptions 给 options 打 subagentDepth ≥ 1）。 */
function isSubagentChild(opts) {
  return (opts?.subagentDepth ?? 0) >= 1
}

/** 是否为轻量子代理（预算帽 ≤ 8K → 机械档，需自动选型）。 */
function isLiteTier(opts) {
  return (opts?.maxTokens ?? 0) <= LITE_MAXTOKENS
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
  apply(ctx) {
    // 探测结果缓存：agent -> {ok:true} | {ok:false, fallbackRoute?}（WeakMap
    // 无泄漏；fallbackRoute 含 provider/model/reasoningEffort，后续轮次直接应用）
    const probes = new WeakMap()

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

      // B. 思考强度分层（deepseek 子代理；含回退后仍为 deepseek 的情况）
      if (config.reasoningEffort === undefined) {
        const effort = decideEffort(config.provider, config.maxTokens)
        if (effort !== undefined) config = { ...config, reasoningEffort: effort }
      }
      return config
    })
  },
}

module.exports.__internals = { KIX_ROUTE_SENTINEL_PREFIX, decideEffort, isSubagentChild, isLiteTier, probeRoute }
