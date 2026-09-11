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
//   - `agent/request-error` prepend 监听 child 首轮首步 provider 可用性失败：在
//     dsh-llm-retry 前熔断失败 provider。cross child 默认最多原地 failover 2 次
//     （同一 child 下一请求重过 agent/request，依次换健康异厂商）；达到上限或
//     无备用才按零证据终止并通知父线程。非 cross 保留原终止行为。HTTP 402 /
//     AUTH 进程内硬熔断；QUOTA/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT 保留 TTL 半开。
//
// 档位解析（候选与顺序全部来自运行时：llm.listProviders()/listModels() 目录 +
// 本行 config 声明的部署偏好；2026-09-10 起插件内**零**模型/厂商 id 字面量）：
//   - cross：父厂商取反（vendorOf 由 provider id 前缀推导），顺序 = config 的
//     crossProviderOrder（按父厂商）/ genericCrossOrder，未配置 = 已注册异厂商目录序；
//   - vision：第一个声明 inputModalities 含 image 的模型，provider 顺序 =
//     config 的 visionProviderHint 在前，未配置 = 目录序；
//   - thinker：deepseek 同族 provider（族由前缀推导），config 的
//     thinkerProviderHint 在前，未配置 = 同族目录序。
// 各档位具体选中哪个 provider/model 是**部署事实**，写在 preset 的 kix-route
// config 里；插件只负责「怎么挑」（能力判定 + 目录探测 + 熔断跳过）。
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

const { randomUUID } = require('node:crypto')

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

// 跨厂商取反的 provider 偏好顺序（按父厂商）；数组外的是通用兜底目录序。
// **插件级默认已清空**（2026-09-10）：跨厂商取反的**语义**由 vendorOf（provider
// id 前缀推导）保证，取舍哪个异厂商是部署事实 → 由 preset config 的
// crossProviderOrder / genericCrossOrder / fallbackProviderOrder 声明。
// 历史（插件内置默认，含具体 provider 名，已移除）：
//   父=grok 走 generic，首选 deepseek-official → 402；grok/xai 显式取反到
//   zai-coding-cn（已注册才进 head）。这些事实仍成立，但现由 preset 配置承载。
// 未配置时行为：已注册异厂商按目录序（单厂商部署 → 无候选，由调用方降级）。
const CROSS_PROVIDER_ORDER = {}
const GENERIC_CROSS_ORDER = []
const FALLBACK_PROVIDER_ORDER = []

// 档位 provider 提示（可选）：vision 想先试的 provider、thinker 想先试的 provider。
// 未配置时 = 已注册目录序（能力判定仍走目录：vision 要求模型显式声明 image 输入）。
const VISION_PROVIDER_HINT = []
const THINKER_PROVIDER_HINT = []
// thinker 的同族判据（provider id 前缀，与 vendorOf 同一归一规则；不是模型名清单）
const THINKER_VENDOR = 'deepseek'
const DEFAULT_PROVIDER_CIRCUIT_TTL_MS = 5 * 60 * 1000
const DEFAULT_CROSS_PROVIDER_FAILOVERS = 2
const PROVIDER_AVAILABILITY_CODES = new Set(['QUOTA', 'AUTH', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'NO_ADAPTER'])

// 各 provider 内部模型偏好：**插件级默认表已清空**（2026-09-10）。
// 原表钉着具体模型名（glm-5.3 / glm-4.7 / gpt-5.6-sol …），这在他人部署里
// 要么指到不存在的模型、要么随厂商改线腐烂（本仓已踩：zai 线 glm-4.7 在
// 本机 catalog 不存在 → 机械档不可用）。改为**可获取的方式**：
//   · 默认序 = 部署自己声明的目录序（settings.yaml 的 llm-* models 书写顺序，
//     经 llm.listModels 读回）——「哪个模型好」是部署事实，不该由插件猜；
//   · 需要覆盖时由 preset config 的 modelPreference 显式给出（浅合并，见下）。
// 插件逻辑里不再出现任何模型 id 字面量。
const MODEL_PREFERENCE = {}

// ── 偏好表配置化（2026-08-17 起；2026-09-10 起默认表清空）──────────────────
// provider 顺序与模型顺序均可由插件 config 覆盖（agent.cordis.yml 该行 config
// 传 crossProviderOrder / genericCrossOrder / fallbackProviderOrder /
// modelPreference 的任意子集，浅合并到默认值）。
// 未配置时：模型序 = 目录序；provider 序 = 已注册目录序（跨厂商仍保证异厂商，
// 因为 vendorOf 由 provider id 前缀推导，不是名单）。
// 运行时可变副本：模块级纯函数读默认值；apply 内合并 config 后经闭包传入
// 解析路径（orderedModels/crossProviderOrder 经 options 注入，测试可覆盖）。
function mergePreferences(config) {
  const cfg = config || {}
  return {
    crossProviderOrder: { ...CROSS_PROVIDER_ORDER, ...(cfg.crossProviderOrder || {}) },
    genericCrossOrder: Array.isArray(cfg.genericCrossOrder) ? [...cfg.genericCrossOrder] : [...GENERIC_CROSS_ORDER],
    fallbackProviderOrder: Array.isArray(cfg.fallbackProviderOrder) ? [...cfg.fallbackProviderOrder] : [...FALLBACK_PROVIDER_ORDER],
    modelPreference: { ...MODEL_PREFERENCE, ...(cfg.modelPreference || {}) },
    visionProviderHint: Array.isArray(cfg.visionProviderHint) ? [...cfg.visionProviderHint] : [...VISION_PROVIDER_HINT],
    thinkerProviderHint: Array.isArray(cfg.thinkerProviderHint) ? [...cfg.thinkerProviderHint] : [...THINKER_PROVIDER_HINT],
  }
}

function quotaFailureOf(error) {
  const queue = [error]
  const seen = new Set()
  while (queue.length > 0) {
    const value = queue.shift()
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) continue
    seen.add(value)
    const code = typeof value.code === 'string' ? value.code.toUpperCase() : undefined
    const status = typeof value.status === 'number' ? value.status : Number(value.status)
    if (code === 'QUOTA' || status === 402) {
      return {
        code: code || 'QUOTA',
        status: status === 402 ? 402 : undefined,
        message: typeof value.message === 'string' ? value.message : 'Insufficient Balance',
      }
    }
    for (const key of ['failure', 'error', 'cause', 'info', 'details']) {
      if (value[key] !== undefined) queue.push(value[key])
    }
  }
  return undefined
}

function availabilityFailureOf(error) {
  const queue = [error]
  const seen = new Set()
  while (queue.length > 0) {
    const value = queue.shift()
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) continue
    seen.add(value)
    const code = typeof value.code === 'string' ? value.code.toUpperCase() : ''
    const status = typeof value.status === 'number' ? value.status : Number(value.status)
    const statusUnavailable = status === 401 || status === 402 || status === 403 || status === 408 || status === 429 || status >= 500
    if (PROVIDER_AVAILABILITY_CODES.has(code) || statusUnavailable) {
      return {
        code: code || (status === 402 ? 'QUOTA' : status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'TRANSPORT'),
        status: Number.isFinite(status) ? status : undefined,
        message: typeof value.message === 'string' ? value.message : 'provider unavailable',
      }
    }
    for (const key of ['failure', 'error', 'cause', 'info', 'details']) {
      if (value[key] !== undefined) queue.push(value[key])
    }
  }
  return undefined
}

function hardQuotaFailure(failure) {
  const f = failure || {}
  return f.status === 402 || /insufficient\s+balance|payment\s+required/i.test(String(f.message || ''))
}

function hardProviderFailure(failure) {
  const f = failure || {}
  return hardQuotaFailure(f) || f.code === 'AUTH' || f.status === 401 || f.status === 403
}

function createProviderHealthCache(ttlMs = DEFAULT_PROVIDER_CIRCUIT_TTL_MS, now = Date.now) {
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : DEFAULT_PROVIDER_CIRCUIT_TTL_MS
  const entries = new Map()
  function active(provider) {
    const entry = entries.get(provider)
    if (entry === undefined) return undefined
    if (entry.until > now()) return entry
    entries.delete(provider)
    return undefined
  }
  return {
    ttlMs: ttl,
    markFailure(provider, failure) {
      const at = now()
      const hard = hardProviderFailure(failure)
      const entry = { provider, failure, hard, openedAt: at, until: hard ? Number.POSITIVE_INFINITY : at + ttl }
      entries.set(provider, entry)
      return entry
    },
    markQuota(provider, failure) {
      return this.markFailure(provider, failure)
    },
    isHealthy(provider) {
      return typeof provider !== 'string' || provider === '' || active(provider) === undefined
    },
    state(provider) {
      return active(provider)
    },
    openProviders() {
      return [...entries.keys()].filter((provider) => active(provider) !== undefined)
    },
  }
}

function failureIncidentOf(payload, classifyFailure) {
  const agent = payload && payload.agent
  if (!agent || payload.turn !== 1 || payload.step !== 1) return undefined
  const header = agent.session && agent.session.header
  const depth = agent.options && agent.options.subagentDepth != null
    ? agent.options.subagentDepth
    : header && header.delegationDepth
  if (!(depth >= 1) && (!header || header.origin !== 'subagent')) return undefined
  const failure = classifyFailure(payload.failure ?? payload.error)
  if (failure === undefined) return undefined
  let request
  try {
    request = agent.session && typeof agent.session.requestContext === 'function'
      ? agent.session.requestContext()
      : undefined
    if (request === undefined && agent.session && typeof agent.session.requestHeader === 'function') {
      request = agent.session.requestHeader()?.config
    }
  } catch {
    request = undefined
  }
  const provider = payload.provider || request && request.provider || agent.options && agent.options.provider
  if (typeof provider !== 'string' || provider === '') return undefined
  return {
    agent,
    childId: agent.id || agent.session && agent.session.id || 'unknown',
    provider,
    model: request && request.model || agent.options && agent.options.model || 'unknown',
    failure,
  }
}

function quotaIncidentOf(payload) {
  return failureIncidentOf(payload, quotaFailureOf)
}

function availabilityIncidentOf(payload) {
  return failureIncidentOf(payload, availabilityFailureOf)
}

function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'kix-route', form: 'notice', summary: text.slice(0, 100) },
  }
}

function quotaFeedbackText(incident, entry, healthyProviders) {
  const circuit = entry.hard
    ? '本进程内保持熔断，恢复额度后重启/重载 DSH 才半开'
    : '已熔断 ' + Math.max(1, Math.ceil((entry.until - entry.openedAt) / 1000)) + ' 秒'
  const hops = Array.isArray(healthyProviders)
    ? healthyProviders.filter((p) => typeof p === 'string' && p !== '' && p !== incident.provider)
    : []
  const hopLine = hops.length > 0
    ? '健康路由仍可用：' + hops.join(', ') + '。若异质视角仍是未解决信息缺口，按其中之一启动新 child（不是补票同一失败 child）。'
    : '当前没有已识别的健康备用路由。'
  return [
    '[kix-route/provider-quota]',
    '子代理 ' + incident.childId + ' 的首轮模型请求在 ' + incident.provider + '/' + incident.model + ' 失败：' + incident.failure.code + (incident.failure.status ? '/HTTP ' + incident.failure.status : '') + '（' + incident.failure.message + '）。',
    '本次 child 产出按零证据记账；provider ' + incident.provider + ' ' + circuit + '。不要等待或复用失败 child，也不要为补票机械重派。',
    hopLine,
    '只有该异质视角仍是当前 claim 的未解决信息缺口时，才由协调线程按健康路由启动新 child；否则继续现有证据链。',
  ].join(' ')
}

function availabilityFeedbackText(incident, entry, healthyProviders, failovers, maxFailovers) {
  if (incident.failure.code === 'QUOTA' || incident.failure.status === 402) {
    return quotaFeedbackText(incident, entry, healthyProviders) + ' cross 自动 failover 已用 ' + failovers + '/' + maxFailovers + ' 次。'
  }
  const circuit = entry.hard
    ? '本进程内保持熔断，修复认证后重启/重载 DSH 才半开'
    : '已熔断 ' + Math.max(1, Math.ceil((entry.until - entry.openedAt) / 1000)) + ' 秒'
  return [
    '[kix-route/provider-unavailable]',
    '子代理 ' + incident.childId + ' 在 ' + incident.provider + '/' + incident.model + ' 失败：' + incident.failure.code + (incident.failure.status ? '/HTTP ' + incident.failure.status : '') + '（' + incident.failure.message + '）。',
    'provider ' + incident.provider + ' ' + circuit + '；cross 自动 failover 已用 ' + failovers + '/' + maxFailovers + ' 次。',
    '当前 child 未产出可用结果，按零证据记账；不要复用失败 provider。',
  ].join(' ')
}

function lifecycleParentAgent(ctx, info) {
  const agents = ctx.get && ctx.get('agents')
  if (!agents || typeof agents.get !== 'function' || !info || !info.id) return undefined
  const child = agents.get(String(info.id))
  const parentId = child && child.session && child.session.header && child.session.header.parentSession
  return parentId ? agents.get(parentId) : undefined
}

function providerCircuitFailText(provider, health, registered) {
  const open = health.openProviders()
  const list = registered.length > 0 ? registered.join(', ') : '无'
  const hard = open.some((name) => health.state(name)?.hard)
  const recovery = hard
    ? '恢复额度后重启/重载 DSH，再按仍未解决的信息缺口决定是否派发。'
    : '等待暂态熔断半开，或配置健康 provider 后按信息缺口派发。'
  return 'kix-route: provider ' + provider + ' 因 QUOTA/402 处于熔断状态，且当前没有可用备用路由（已注册：' + list + '；熔断：' + (open.join(', ') || '无') + '）。' + recovery
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

/**
 * 配置偏好对**真实目录**的自查（零成本、只读，不改行为）——2026-09-10 加，
 * 成因：本仓曾把 zai-coding-cn/glm-4.7 钉进 subagent_lite 的 agentOptions，
 * 而该模型在本机 catalog 里根本不存在 → 机械档整个不可用，且没有任何提示，
 * 直到第一次真的派发才报 UNKNOWN_MODEL。
 * 这里把「配置里写了但目录里没有」的 id 一次列全并 warn：下次厂商改线/换机器，
 * 挂载时就能看见，而不是等某档位静默失效。
 * 契约：任何探测异常都只返回空数组（绝不因自查失败影响路由——自查是提示，
 * 不是前置依赖）。
 * @param {object} llm - ctx 的 llm 服务（无则跳过）。
 * @param {object} prefs - mergePreferences 产物。
 * @returns {Promise<string[]>} 形如 'zai-coding-cn/glm-4.7（目录无此模型）' 的条目。
 */
async function auditPreferenceIds(llm, prefs) {
  const findings = []
  if (llm === undefined || prefs === undefined) return findings
  try {
    const registered = registeredProviders(llm)
    // 1) provider 级名单：未注册 / 无任何可解析模型
    const providerLists = [
      ['crossProviderOrder', Object.values(prefs.crossProviderOrder || {}).flat()],
      ['genericCrossOrder', prefs.genericCrossOrder || []],
      ['fallbackProviderOrder', prefs.fallbackProviderOrder || []],
      ['visionProviderHint', prefs.visionProviderHint || []],
      ['thinkerProviderHint', prefs.thinkerProviderHint || []],
    ]
    for (const [key, list] of providerLists) {
      for (const provider of new Set(list)) {
        if (!registered.includes(provider)) findings.push(`${key}: provider "${provider}" 未注册`)
      }
    }
    // 2) modelPreference：逐个模型对目录核实（只在 provider 已注册时才问目录）
    for (const [provider, ids] of Object.entries(prefs.modelPreference || {})) {
      if (!registered.includes(provider)) { findings.push(`modelPreference: provider "${provider}" 未注册`); continue }
      let listed
      try {
        listed = await llm.listModels(provider)
      } catch {
        continue // 目录不可达：不是配置错误，跳过（路由层有自己的探测失败语义）
      }
      const known = new Set((Array.isArray(listed) ? listed : []).map((m) => (m && m.id) || m))
      for (const id of ids) {
        if (!known.has(id)) findings.push(`modelPreference: ${provider}/${id}（目录无此模型）`)
      }
    }
  } catch {
    return findings // 自查永不影响路由
  }
  return findings
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
async function resolveCrossRoute(llm, parentProvider, signal, prefs, isHealthy = () => true) {
  for (const provider of crossProviderOrder(llm, parentProvider, prefs)) {
    if (!isHealthy(provider)) continue
    const hit = await pickModel(llm, provider, { signal, prefs })
    if (hit !== undefined) return hit
  }
  return undefined
}

/** vision：优先配置的 provider 提示（默认无，= 目录序），其后任何健康 provider 中第一个声明 image 输入的模型。 */
async function resolveVisionRoute(llm, signal, prefs, isHealthy = () => true) {
  const registered = registeredProviders(llm)
  const hint = (prefs && prefs.visionProviderHint) || VISION_PROVIDER_HINT
  const order = [...hint.filter((p) => registered.includes(p)), ...registered.filter((p) => !hint.includes(p))]
  for (const provider of order) {
    if (!isHealthy(provider)) continue
    const hit = await pickModel(llm, provider, { wantImage: true, signal, prefs })
    if (hit !== undefined) return hit
  }
  return undefined
}

/** thinker：优先配置的 provider 提示（默认无），候选仍是目录里的 **deepseek 同族**
 * （族由 vendorOf 前缀推导；无同族 → undefined，由 decideTierAction 降级环境默认路由）。 */
async function resolveThinkerRoute(llm, signal, prefs, isHealthy = () => true) {
  const registered = registeredProviders(llm)
  const hint = (prefs && prefs.thinkerProviderHint) || THINKER_PROVIDER_HINT
  const family = registered.filter((p) => vendorOf(p) === THINKER_VENDOR)
  const order = [...hint.filter((p) => family.includes(p)), ...family.filter((p) => !hint.includes(p))]
  for (const provider of order) {
    if (!isHealthy(provider)) continue
    const hit = await pickModel(llm, provider, { signal, prefs })
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 普通子代理或 thinker 降级：配置偏好在前，其余已注册健康 provider 按目录序。 */
async function resolveFallbackRoute(llm, signal, prefs, isHealthy = () => true) {
  const registered = registeredProviders(llm)
  const preferred = prefs && prefs.fallbackProviderOrder ? prefs.fallbackProviderOrder : FALLBACK_PROVIDER_ORDER
  const head = preferred.filter((provider) => registered.includes(provider))
  const order = [...head, ...registered.filter((provider) => !head.includes(provider))]
  for (const provider of order) {
    if (!isHealthy(provider)) continue
    const hit = await pickModel(llm, provider, { signal, prefs })
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
  return `kix-route: subagent_vision 需要声明 image 输入的模型，当前目录均未声明（已注册 provider：${list}）。本部署无识图能力：请在 settings.yaml 给任一 provider 的 models 条目加 input: [ text, image ]，或请用户改用文字描述 / 给出图片路径外的人工处理方案。`
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
    const parents = new Map()
    const notified = new WeakSet()
    const prefs = mergePreferences(config)
    // 配置偏好 vs 真实目录：挂载后自查一次（只读；发现死 id 只 warn，不改行为）。
    // 逐层防御：ctx.get / ctx.logger / 审计本身任何一步抛错都必须被吞掉——
    // 这个钩子挂在 agent/request 上，漏一个异常就会把整条请求链打断，而它的
    // 全部价值只是「早一点提醒」，绝不能换来「请求失败」。
    const auditOnce = (() => {
      let done = false
      return async () => {
        if (done) return
        done = true
        let llm
        try {
          llm = ctx.get('llm')
        } catch { return }
        try {
          const findings = await auditPreferenceIds(llm, prefs)
          if (findings.length) {
            try {
              ctx.logger.warn(`kix-route: 配置偏好含目录中不存在的条目（不影响运行，仅失去该偏好）：${findings.join('; ')}`)
            } catch { /* logger 缺失/抛错同样吞掉：提示失败不能升级成请求失败 */ }
          }
        } catch { /* 自查永不影响路由 */ }
      }
    })()
    const health = createProviderHealthCache(config && config.providerCircuitTtlMs)
    const requestedFailovers = Number(config && config.crossProviderFailovers)
    const maxCrossProviderFailovers = Number.isFinite(requestedFailovers)
      ? Math.max(0, Math.min(10, Math.floor(requestedFailovers)))
      : DEFAULT_CROSS_PROVIDER_FAILOVERS

    // Lifecycle callbacks receive only `info`; recover the runtime parent from the
    // published local child's durable lineage while the child is still registered.
    ctx.on('subagent/start', (info) => {
      const parent = lifecycleParentAgent(ctx, info)
      if (info && info.id && parent) parents.set(String(info.id), parent)
    })
    ctx.on('subagent/end', (info) => {
      if (info && info.id) parents.delete(String(info.id))
    })
    // prepend=true：先于 dsh-llm-retry 观察 provider 可用性失败。cross child
    // 最多换 maxCrossProviderFailovers 家（同一 child 原地 retry）；非 cross 仅沿用
    // 旧 QUOTA 终止语义，其他错误完整下传宿主 retry policy。
    ctx.on('agent/request-error', async (payload, next) => {
      try {
        const incident = availabilityIncidentOf(payload)
        if (incident === undefined) return next()
        const routeState = routes.get(incident.agent)
        const isCross = routeState && routeState.tier === 'cross'
        const isQuota = incident.failure.code === 'QUOTA' || incident.failure.status === 402
        if (!isCross && !isQuota) return next()

        const entry = health.markFailure(incident.provider, incident.failure)
        if (routeState) {
          routeState.failedProviders.add(incident.provider)
          routeState.hit = undefined
          routeState.degraded = false
        }

        if (isCross && routeState.failovers < maxCrossProviderFailovers) {
          let nextHit
          try {
            const llm = ctx.get('llm')
            if (llm) {
              nextHit = await resolveCrossRoute(
                llm,
                routeState.parentProvider,
                payload.signal,
                prefs,
                health.isHealthy,
              )
            }
          } catch (error) {
            ctx.logger?.warn?.('kix-route: cross failover 路由探测失败：' + (error && error.message ? error.message : String(error)))
          }
          if (nextHit !== undefined) {
            routeState.hit = nextHit
            routeState.failovers++
            ctx.logger?.warn?.(
              'kix-route: cross child ' + incident.childId + ' 的 ' + incident.provider + '/' + incident.model + ' 因 ' + incident.failure.code +
              ' 失败，自动 failover ' + routeState.failovers + '/' + maxCrossProviderFailovers + ' → ' + nextHit.provider + '/' + nextHit.model,
            )
            return { kind: 'retry' }
          }
        }

        // 无备用或达到上限：当前 child 零证据终止，父代理通知按 child 去重。
        if (!notified.has(incident.agent)) {
          notified.add(incident.agent)
          ctx.logger?.warn?.(
            'kix-route: provider ' + incident.provider + ' 首轮 ' + incident.failure.code + '，cross failover ' +
            (routeState ? routeState.failovers : 0) + '/' + maxCrossProviderFailovers + ' 后终止（child ' + incident.childId + '）',
          )
          let parent = parents.get(String(incident.childId))
          if (parent === undefined) {
            const parentId = incident.agent.session && incident.agent.session.header && incident.agent.session.header.parentSession
            const agents = ctx.get('agents')
            if (parentId && agents && typeof agents.get === 'function') parent = agents.get(parentId)
          }
          if (parent && typeof parent.steer === 'function') {
            let healthy = []
            try {
              const llm = ctx.get('llm')
              if (llm) {
                healthy = registeredProviders(llm).filter((p) => health.isHealthy(p) && p !== incident.provider)
              }
            } catch { /* circuit and terminal evidence do not depend on the hop list */ }
            parent.steer(makeUserMessage(availabilityFeedbackText(
              incident,
              entry,
              healthy,
              routeState ? routeState.failovers : 0,
              maxCrossProviderFailovers,
            )))
          } else {
            ctx.logger?.warn?.('kix-route: provider 已熔断，但父代理不可用，无法即时投递终止提醒（child ' + incident.childId + '）')
          }
        }
        return undefined
      } catch (error) {
        ctx.logger?.warn?.('kix-route: 处理 provider failover 失败：' + (error && error.message ? error.message : String(error)))
        return next()
      }
    }, true)

    ctx.on('agent/request', async (payload, next) => {
      void auditOnce() // 首次请求时对目录自查一次配置偏好（只 warn，不阻塞/不改路由）
      const resolved = await next()
      if (resolved === undefined) return resolved
      const agent = payload.agent
      if (agent === undefined) return resolved
      const opts = agent.options ?? {}
      if ((opts.subagentDepth ?? 0) < 1) return resolved
      const requestedTier = sentinelTierOf(resolved.model)
      let cached = routes.get(agent)
      const tier = requestedTier || cached && cached.tier
      if (tier === undefined && health.isHealthy(resolved.provider)) return resolved

      const llm = ctx.get('llm')
      if (llm === undefined) {
        const target = tier === undefined ? String(resolved.provider || 'unknown') : SENTINEL_PREFIX + tier
        throw new Error('kix-route: llm 服务不可用，无法解析 ' + target + ' 子代理路由（检查宿主 llm 插件是否加载）')
      }

      if (cached === undefined) {
        cached = {
          hit: undefined,
          degraded: false,
          tier,
          parentProvider: tier === 'cross' ? resolved.provider : undefined,
          failovers: 0,
          failedProviders: new Set(),
        }
        routes.set(agent, cached)
      } else {
        if (requestedTier !== undefined) cached.tier = requestedTier
        if (cached.tier === 'cross' && cached.parentProvider === undefined) cached.parentProvider = resolved.provider
        if (cached.hit !== undefined && !health.isHealthy(cached.hit.provider)) {
          // 其他并行 child 或本 child 上一 attempt 可熔断已缓存 provider。
          cached.hit = undefined
          cached.degraded = false
        }
      }

      let hit = cached.hit
      if (hit === undefined) {
        const routeKind = tier || 'fallback'
        try {
          if (tier === 'cross') hit = await resolveCrossRoute(llm, cached.parentProvider || resolved.provider, payload.signal, prefs, health.isHealthy)
          else if (tier === 'vision') hit = await resolveVisionRoute(llm, payload.signal, prefs, health.isHealthy)
          else if (tier === 'thinker') hit = await resolveThinkerRoute(llm, payload.signal, prefs, health.isHealthy)
          else hit = await resolveFallbackRoute(llm, payload.signal, prefs, health.isHealthy)
        } catch (e) {
          if (e && e.probe === true) {
            const msg = e && e.message ? e.message : String(e)
            ctx.logger?.warn?.('kix-route: ' + routeKind + ' 路由探测失败（非能力缺失）：' + msg)
            throw new Error('kix-route: ' + routeKind + ' 路由探测失败（模型目录/服务暂不可达），请稍后重试。底层错误：' + msg)
          }
          throw e
        }

        if (tier === undefined) {
          if (hit === undefined) throw new Error(providerCircuitFailText(resolved.provider, health, registeredProviders(llm)))
          ctx.logger?.warn?.('kix-route: provider ' + resolved.provider + ' 处于可用性熔断，子代理改路由到 ' + hit.provider + '/' + hit.model)
        } else {
          let defaultRoute
          if (hit === undefined && tier === 'thinker') {
            const defaults = ctx.get('agentDefaultModel')
            if (defaults !== undefined) {
              try {
                const sel = defaults.currentSelection()
                if (sel !== undefined && sel.provider && sel.model && health.isHealthy(sel.provider)) {
                  defaultRoute = { provider: sel.provider, model: sel.model }
                }
              } catch {
                defaultRoute = undefined
              }
            }
            if (defaultRoute === undefined) {
              defaultRoute = await resolveFallbackRoute(llm, payload.signal, prefs, health.isHealthy)
            }
          }

          const failText = tier === 'cross'
            ? crossFailText(cached.parentProvider || resolved.provider, registeredProviders(llm))
            : tier === 'vision'
              ? visionFailText(registeredProviders(llm))
              : thinkerFailText()
          const action = decideTierAction(tier, hit, defaultRoute, failText)
          if (action.kind === 'fail') throw new Error(action.message)
          hit = action.hit
          if (action.degraded === true && !cached.degraded) {
            cached.degraded = true
            ctx.logger?.warn?.(
              'kix-route: tier "thinker" 未解析到健康 deepseek 路由，降级 ' + hit.provider + '/' + hit.model + '（角色仍成立：大预算深思考；适配器自管 effort）',
            )
          }
        }
        // 熔断窗口内的 fallback 不跨请求缓存：TTL 到期后的下一请求必须重新
        // 探测原优先路由（半开）。无熔断时仍保持原有 per-agent 稳定缓存。
        if (health.openProviders().length === 0) cached.hit = hit
      }

      let requestConfig = { ...resolved, provider: hit.provider, model: hit.model }
      if (requestConfig.reasoningEffort === undefined && typeof decideEffortShared === 'function') {
        const effort = decideEffortShared(hit.provider, opts.maxTokens ?? resolved.maxTokens)
        if (effort !== undefined) requestConfig = { ...requestConfig, reasoningEffort: effort }
      }
      return requestConfig
    })
  },
}

module.exports.__internals = {
  SENTINEL_PREFIX,
  FALLBACK_PROVIDER_ORDER,
  DEFAULT_PROVIDER_CIRCUIT_TTL_MS,
  DEFAULT_CROSS_PROVIDER_FAILOVERS,
  PROVIDER_AVAILABILITY_CODES,
  vendorOf,
  registeredProviders,
  orderedModels,
  pickModel,
  crossProviderOrder,
  resolveCrossRoute,
  resolveVisionRoute,
  resolveThinkerRoute,
  resolveFallbackRoute,
  mergePreferences,
  auditPreferenceIds,
  sentinelTierOf,
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
  crossFailText,
  visionFailText,
  thinkerFailText,
}
