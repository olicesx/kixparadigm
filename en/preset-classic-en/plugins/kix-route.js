// kix-route — 子代理路由层：哨兵模型名 → 运行时可用路由自动解析（2026-08-15；v8 v1.2.10）
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
//
// 档位解析（候选全部来自 llm.listProviders()/listModels() 实时目录）：
//   - cross：父厂商取反（zhipu→deepseek 系 / deepseek→zai 系 / 其他厂商
//     → 已注册的任一异厂商），偏好顺序见 CROSS_PROVIDER_ORDER / MODEL_PREFERENCE；
//   - vision：第一个 inputModalities 声明 image 的模型（zai-vision 优先，
//     其余 provider 兜底）；
//   - thinker：deepseek 系 provider（deepseek-official 首选）。
//
// 边界语义（单厂商 / 无 deepseek / 无视觉模型的部署，v5.9.1）——核心原则：
// 角色核心能力缺失 → 报错（信息带回父模型）；角色仍成立 → 降级 + 告警：
//   - cross 无异厂商（单厂商部署）→ **启动即报错**（throw，错误信息附已注册
//     provider 清单 + 改用建议，随 run 失败带回父模型）——绝不静默同厂商
//     降级：cross 的全部价值是厂商正交，假独立性比失败更糟；
//   - vision 无声明 image 的模型 → 同样启动即报错（附配置建议），不做
//     无视觉能力的降级（省掉 spawn→read_image 被门禁弹回的空跑）；
//   - thinker 无 deepseek → 降级环境默认路由 + 一次性告警（角色仍成立：
//     大预算深思考，GLM 适配器自管思考强度）；
//   - 解析失败不缓存：部署中途注册的新 provider 下一请求即生效；
//   - 插件缺失/未挂载时哨兵名直达适配器 → UNKNOWN_MODEL 响亮失败。
//
// 与 kix-cost 的关系（顺序无关，双向成立）：
// v8（v1.2.10）：cross 偏好表候选先按已注册 provider 过滤——未注册偏好候选
//   不再触发 listModels 探测错误，直接落到已注册异厂商；避免瞬时目录探测失败
//   被误报为「cross 能力缺失」。回归见 crossProviderOrder 测试。
//
//   - kix-cost 见到 `kix-route:` 哨兵直接跳过（lite 探测/effort 注入都不碰）；
//   - 本插件改写到 deepseek 且无显式 effort 时，自行调用 kix-cost 导出的
//     decideEffort 注入（require 带 try/catch 守卫：kix-cost.js 缺失时只跳过
//     effort 注入，路由解析不受影响）。两种 waterfall 顺序下结果一致。
//
// 挂载方式：preset agent.cordis.yml（紧随 kix-cost 行之后）：
//   - id: kix-route
//     name: ./plugins/kix-route.js
//
// 纯逻辑导出：module.exports.__internals 供单元测试（kix-route.test.js）。

'use strict'

// kix-cost 的 effort 规则同源复用（文件缺失/导出变化时静默跳过，不影响路由）。
let decideEffortShared
try {
  decideEffortShared = require('./kix-cost.js').__internals?.decideEffort
} catch {
  decideEffortShared = undefined
}

const SENTINEL_PREFIX = 'kix-route:'

// 厂商判定：provider id 前缀归一（zai-*/zhipu-* → zhipu，含 zai-coding-cn/zai-vision）。
function vendorOf(provider) {
  if (typeof provider !== 'string' || provider === '') return ''
  if (provider === 'zai' || provider === 'zhipu' || provider.startsWith('zai-') || provider.startsWith('zhipu-')) return 'zhipu'
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
  'zai-coding-cn': ['glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-5.5', 'glm-4.5-air'],
  'zai-vision': ['glm-4.6v', 'glm-4.6v-flash', 'glm-4.5v'],
}

// ── 2026-08-17（外部审查 5.6「硬编码偏好」技术债最小配置化）────────────────
// 上述三表是默认偏好；插件 config 可覆盖（agent.cordis.yml 该行 config 传
// crossProviderOrder / genericCrossOrder / modelPreference 的任意子集，浅合并
// 到默认表）。动机：模型线升级（如新增 glm-5.5）只改 preset config 或默认表
// 一处，不必改解析逻辑。行为默认零变化（不传 config = 旧表）。
// 运行时可变副本：模块级纯函数读默认表；apply 内合并 config 后经闭包传入
// 解析路径（orderedModels/crossProviderOrder 经 options 注入，测试可覆盖）。
function mergePreferences(config) {
  const cfg = config || {}
  return {
    crossProviderOrder: { ...CROSS_PROVIDER_ORDER, ...(cfg.crossProviderOrder || {}) },
    genericCrossOrder: cfg.genericCrossOrder || GENERIC_CROSS_ORDER,
    modelPreference: { ...MODEL_PREFERENCE, ...(cfg.modelPreference || {}) },
  }
}

/**
 * 已注册 provider 路由键列表。
 * 契约（dsh-llm prepareRoutes 实证）：listProviders() 返回 {id, name}，其中
 * id === 注册路由键（注册时强制校验），name 是显示名（如 "DeepSeek"）——
 * 显示名绝不能当路由键用（B1 修复：旧实现读 p.provider ?? p.name 拿到显示名，
 * 导致 vision 恒假报无识图、thinker 恒降级）。
 * 2026-08-16（审查修复，错误分类塌缩）：探测抛错 ≠ "无 provider"——抛带
 * probe 标记的错误，由路由层转为「探测失败，请重试」文案（绝不伪装成
 * 部署级永久事实"本部署无跨厂商正交验证能力"，后者会被父模型写入跨会话
 * 记忆，瞬时故障即被永久固化）。
 */
function probeError(message) {
  const e = new Error(message)
  e.probe = true
  return e
}

function registeredProviders(llm) {
  try {
    return (llm.listProviders() ?? [])
      .map((p) => (p && typeof p === 'object' ? p.id ?? p.provider : undefined))
      .filter((id) => typeof id === 'string' && id !== '')
  } catch (e) {
    throw probeError(`kix-route: 探测已注册 provider 失败（llm.listProviders 抛错：${e && e.message ? e.message : String(e)}）`)
  }
}

/** provider 内模型排序：偏好表 ∩ 目录 在前，其余按目录序追加。
 * prefs 可注入（mergePreferences 产物；默认读模块级 MODEL_PREFERENCE）。 */
function orderedModels(provider, listedIds, prefs) {
  const pref = (prefs && prefs.modelPreference ? prefs.modelPreference : MODEL_PREFERENCE)[provider] ?? []
  const listed = new Set(listedIds)
  const head = pref.filter((id) => listed.has(id))
  const tail = listedIds.filter((id) => !pref.includes(id))
  return [...head, ...tail]
}

/**
 * 在一个 provider 内选第一个可用模型；wantImage 时要求显式声明 image 输入
 * （与 read_image 门禁同严格度：undefined 视为不支持）。
 * 2026-08-16（审查修复）：listModels 探测失败抛 probe 错误（非 abort）；
 * resolveModelInfo 单个模型失败仍试下一个（正常降级），但目录整体不可达
 * 不再静默伪装成「无模型」。
 */
async function pickModel(llm, provider, { wantImage = false, signal, prefs } = {}) {
  let listed
  try {
    listed = await llm.listModels(provider)
  } catch (e) {
    if (signal?.aborted) return undefined // 取消不算探测失败
    throw probeError(`kix-route: 探测 ${provider} 模型目录失败（llm.listModels 抛错：${e && e.message ? e.message : String(e)}）`)
  }
  // 契约防御：非数组返回（目录破坏）按空目录处理，不让裸 TypeError 逃出 pickModel
  const entries = Array.isArray(listed) ? listed : []
  const ids = orderedModels(provider, entries.map((m) => m && m.id).filter((id) => typeof id === 'string'), prefs)
  for (const id of ids) {
    if (signal?.aborted) return undefined // 取消后不再浪费探测；中止语义由循环层 throwIfAborted 收口
    try {
      const info = await llm.resolveModelInfo(provider, id, signal)
      if (wantImage && !(info.inputModalities ?? []).includes('image')) continue
      return { provider, model: id }
    } catch {
      if (signal?.aborted) return undefined // abort 引发的解析失败不算「模型不可用」
      // 该模型不可解析 → 试下一个（单个模型失败是正常降级，非探测错误）
    }
  }
  return undefined
}

/** 取反候选 provider 顺序：偏好表在前（剔除父厂商），其余已注册异厂商按目录序追加。
 * prefs 可注入（mergePreferences 产物；默认读模块级表）。 */
function crossProviderOrder(llm, parentProvider, prefs) {
  const parentVendor = vendorOf(parentProvider)
  const registered = registeredProviders(llm)
  const table = prefs && prefs.crossProviderOrder ? prefs.crossProviderOrder : CROSS_PROVIDER_ORDER
  const generic = prefs && prefs.genericCrossOrder ? prefs.genericCrossOrder : GENERIC_CROSS_ORDER
  // v8：偏好表候选必须先已注册——旧实现会把未注册 provider 留在 head，
  // pickModel 对未注册 provider 的目录探测抛 probe 错误时，整个 cross 解析
  // 被误判为「探测失败」，而不是跳过该候选继续找已注册异厂商。
  const head = (table[parentVendor] ?? generic).filter(
    (p) => vendorOf(p) !== parentVendor && registered.includes(p),
  )
  const tail = registered.filter((p) => vendorOf(p) !== parentVendor && !head.includes(p))
  return [...head, ...tail]
}

/** cross：父厂商取反，第一个可用异厂商模型。 */
async function resolveCrossRoute(llm, parentProvider, signal, prefs) {
  for (const provider of crossProviderOrder(llm, parentProvider, prefs)) {
    const hit = await pickModel(llm, provider, { signal, prefs })
    if (hit !== undefined) return hit
  }
  return undefined
}

/** vision：zai-vision 优先（仅当已注册），其后任何 provider 中第一个声明 image 输入的模型。 */
async function resolveVisionRoute(llm, signal, prefs) {
  const registered = registeredProviders(llm)
  const order = registered.includes('zai-vision')
    ? ['zai-vision', ...registered.filter((p) => p !== 'zai-vision')]
    : registered
  for (const provider of order) {
    const hit = await pickModel(llm, provider, { wantImage: true, signal, prefs })
    if (hit !== undefined) return hit
  }
  return undefined
}

/** thinker：deepseek 系 provider（deepseek-official 首选，其余 deepseek-* 目录序兜底）。 */
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

/** 从 resolved 配置解析哨兵档位；非哨兵返回 undefined。 */
function sentinelTierOf(model) {
  if (typeof model !== 'string' || !model.startsWith(SENTINEL_PREFIX)) return undefined
  const tier = model.slice(SENTINEL_PREFIX.length)
  return tier === 'cross' || tier === 'vision' || tier === 'thinker' ? tier : undefined
}

/**
 * 档位未解析到候选时的动作判定（纯函数，单元测试入口）：
 *   - hit 已解析 → use；
 *   - thinker 未解析 + 环境默认存在 → use（degraded，角色仍成立）；
 *   - 其余（cross/vision 核心能力缺失，或 thinker 连默认都没有）→ fail
 *     （failText 由调用方构造，随 run 失败带回父模型）。
 */
function decideTierAction(tier, hit, defaultRoute, failText) {
  if (hit !== undefined) return { kind: 'use', hit }
  if (tier === 'thinker' && defaultRoute !== undefined) {
    return { kind: 'use', hit: defaultRoute, degraded: true }
  }
  return { kind: 'fail', message: failText }
}

/** cross 失败信息：附主厂商与已注册清单 + 两条出路（改用 subagent / 配置第二厂商）。 */
function crossFailText(parentProvider, registered) {
  const vendor = vendorOf(parentProvider) || '未知'
  const list = registered.length > 0 ? registered.join(', ') : '无'
  return `kix-route: subagent_cross 需要与主模型不同厂商的模型（主厂商 ${vendor}；已注册 provider：${list}）。本部署无跨厂商正交验证能力：请改用 subagent 做同厂商复核，并在结论中注明「单厂商部署，无独立第二通道」；或由用户在 settings.yaml 的 llm-pi-ai.providers 配置第二厂商后重试。`
}

/** vision 失败信息：附配置建议，避免 spawn 后才被 read_image 门禁弹回。 */
function visionFailText(registered) {
  const list = registered.length > 0 ? registered.join(', ') : '无'
  return `kix-route: subagent_vision 需要声明 image 输入的模型，当前目录均未声明（已注册 provider：${list}）。本部署无识图能力：请在 settings.yaml 配置视觉模型（如 zai-vision 的 glm-4.6v），或请用户改用文字描述 / 给出图片路径外的人工处理方案。`
}

/** thinker 彻底失败（无 deepseek 且无环境默认路由，极端边界）。 */
function thinkerFailText() {
  return 'kix-route: subagent_thinker 未解析到 deepseek 系路由，且环境默认路由不可用（agentDefaultModel 缺失）。请检查 settings.yaml 的 llm-pi-ai 配置。'
}

// ── 插件本体 ────────────────────────────────────────────────────────────────

module.exports = {
  name: 'kix-route',
  apply(ctx, config) {
    // 成功解析按 agent 缓存（稳定优先）；失败不缓存——中途注册的 provider 下一请求即生效。
    const routes = new WeakMap()
    // 2026-08-17：偏好表可经插件 config 覆盖（mergePreferences 浅合并默认表；
    // 不传 config = 行为零变化）。模型线升级只改 preset config，不动解析逻辑。
    const prefs = mergePreferences(config)

    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      if (resolved === undefined) return resolved
      const tier = sentinelTierOf(resolved.model)
      if (tier === undefined) return resolved
      const agent = payload.agent
      if (agent === undefined) return resolved // 无 agent 上下文无从处理，保持原样（将响亮失败）
      const opts = agent.options ?? {}
      if ((opts.subagentDepth ?? 0) < 1) return resolved // 哨兵只该出现在子代理；主会话异常路由不碰

      const llm = ctx.get('llm')
      if (llm === undefined) {
        throw new Error(`kix-route: llm 服务不可用，无法解析 ${SENTINEL_PREFIX}${tier} 哨兵路由（检查宿主 llm 插件是否加载）`)
      }

      let cached = routes.get(agent)
      if (cached === undefined) {
        cached = { hit: undefined, degraded: false }
        routes.set(agent, cached)
      }

      let hit = cached.hit
      if (hit === undefined) {
        try {
          if (tier === 'cross') hit = await resolveCrossRoute(llm, resolved.provider, payload.signal, prefs)
          else if (tier === 'vision') hit = await resolveVisionRoute(llm, payload.signal, prefs)
          else hit = await resolveThinkerRoute(llm, payload.signal)
        } catch (e) {
          // 2026-08-16（审查修复，错误分类塌缩）：probe 错误 = 目录/服务暂不可达，
          // 与「确实无匹配模型」区分——报「探测失败，请重试」并记录底层错误，
          // 绝不静默伪装成部署级能力缺失（后者会被父模型固化为跨会话记忆）。
          if (e && e.probe === true) {
            const msg = e && e.message ? e.message : String(e)
            ctx.logger.warn(`kix-route: ${tier} 路由探测失败（非能力缺失）：${msg}`)
            throw new Error(`kix-route: ${tier} 路由探测失败（模型目录/服务暂不可达），请稍后重试。底层错误：${msg}`)
          }
          throw e
        }

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
            `kix-route: tier "thinker" 未解析到 deepseek 路由，降级环境默认 ${hit.provider}/${hit.model}（角色仍成立：大预算深思考；适配器自管 effort）`,
          )
        }
        cached.hit = hit
      }

      let config = { ...resolved, provider: hit.provider, model: hit.model }
      // 顺序无关的 effort 注入：改写到 deepseek 且无显式 effort → 与 kix-cost 同源规则
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
  mergePreferences,
  sentinelTierOf,
  decideTierAction,
  crossFailText,
  visionFailText,
  thinkerFailText,
}
