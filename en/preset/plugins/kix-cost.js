// kix-cost — 子代理成本层：机械档自动选型 + 思考强度分层（v5.8，2026-08-21）
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
    const known = providers.some((p) => p.provider === provider || p.name === provider)
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
    // 探测结果缓存：agent -> 'ok' | 'fallback'（WeakMap 无泄漏）
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
      // kix-route sentinel children (model like kix-route:<tier>) are fully owned
      // by kix-route: it resolves their route AND injects effort (reusing this
      // file's exported decideEffort after rewriting to deepseek). Skip here so
      // the two listeners agree under ANY waterfall order: seen first, the
      // sentinel makes us skip; seen after the rewrite, effort already exists.
      if (typeof resolved.model === 'string' && resolved.model.startsWith('kix-route:')) return resolved

      let config = resolved
      const llm = ctx.get('llm')

      // A. 机械档自动选型：首选路由不可用 → 回退环境默认路由（每子代理一次）
      if (isLiteTier(opts) && llm !== undefined && probes.get(agent) === undefined) {
        let usable = false
        try {
          usable = await probeRoute(llm, config.provider, config.model, payload.signal)
        } catch {
          usable = false
        }
        probes.set(agent, usable ? 'ok' : 'fallback')
        if (!usable) {
          const defaults = ctx.get('agentDefaultModel')
          const sel = defaults !== undefined ? defaults.currentSelection() : undefined
          if (sel !== undefined && sel.provider && sel.model) {
            config = {
              ...config,
              provider: sel.provider,
              model: sel.model,
              ...(sel.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort }),
            }
          }
        }
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

module.exports.__internals = { decideEffort, isSubagentChild, isLiteTier, probeRoute }
