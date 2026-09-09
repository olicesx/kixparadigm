// kix-webhook — 把外部事件（GitHub webhook）变成一个 kix 会话（DSH 0.1.2+ 原生能力）
//
// 定位：DSH 0.1.2 起提供宿主 `ctx.webhookRuntime`（`register(rule)` / `dispatch(delivery)`，
// 唯一内置动作 = 在 Web Workspace 里创建普通 root Session）与 `@deepseek-ai/dsh-webhook-github`
// 适配器（校验 GitHub 原始 body 的 HMAC 签名，投递后返回 202 不等规则结算）。本插件是
// **规则层**：把一条已验证投递翻译成 `WebhookSessionRequest`，让 PR/issue 事件直接起一个
// 按 kix 范式组合的会话，而不是等主线程轮询。
//
// 分层（不要在本插件里做的事）：
//   - HTTP 入口/签名校验 = `dsh-webhook-github`（profile 侧 insert 行）
//   - 会话创建与编排 = `ctx.webhookRuntime`（宿主面）
//   - 规则（事件 → 会话请求、去重、并发闸）= 本插件
// 这三层都缺席时本插件静默不注册（inject 保持 pending），不报错、不产生副作用。
//
// 2026-09-09 实测（WSL2，DSH 0.1.2-rc.1，隔离 DSH_HOME）：
//   - 签名 POST /api/probe-webhook/github → 202 → 规则命中 → 新建 root Session
//     （agentPreset=kixparadigm，system prompt 含 kixParadigm/三通道/需求三检）
//   - 该会话真实执行：user/message(source.kind=webhook) → assistant/message "WEBHOOK-OK"
//   结论：链路成立；**外部可达性另算**——`dsh web` 默认只绑 127.0.0.1，GitHub 真投递
//   需要隧道或反代，属部署面，不在本插件职责内。
//
// 配置（**预设行**的 config，见 dsh/preset/patches/kix-webhook.reference.yml）：
//   enabled            总开关，默认 false（部署侧显式打开）
//   workspacePath      会话工作区绝对路径（必填；必须是已存在目录）
//   agentPreset        会话组合，默认 kixparadigm
//   permissionPreset   sandbox/approval 预置，默认 danger-full-access
//   events             触发的事件名（默认 pull_request.opened / issues.opened）
//   ignoreSenders      忽略的 sender.login（默认 github-actions[bot] / *[bot] 通配）
//   maxSessions        本进程内最多由 webhook 起的会话数，默认 1（失控 fuse）
//   promptTemplate     会话初始 prompt 模板，{{key}} 从投递上下文插值
//
// 启用必须改**预设文件**里的这一行（$DSH_HOME/.agent-presets/<preset>/agent.cordis.yml），
// 不是 profile 的 cordis.patch.yml：2026-09-09 配置面探针实测 profile patch 覆盖不到
// preset 组成内部的行（只覆盖 HTTP 入口那两行 insert）。详见 reference §2。
// 另：预设是 lazy mount，首次有会话挂载它时本插件才加载——冷启动后、任何会话之前的
// 投递只回 202、不起会话。
//
// 规则是负债：不做队列、不做重试、不做持久化去重（GitHub 自身按 delivery id 重投，
// 重复投递最多多起一个会话，由 maxSessions 兜底）。需要更强保证时在部署侧加。

'use strict'

const DEFAULT_AGENT_PRESET = 'kixparadigm'
const DEFAULT_PERMISSION_PRESET = 'danger-full-access'
const DEFAULT_EVENTS = ['pull_request.opened', 'issues.opened']
const DEFAULT_IGNORE_SENDERS = ['*[bot]']
const DEFAULT_MAX_SESSIONS = 1
const DEFAULT_PROMPT =
  '外部事件触发：{{event}}（{{repository}}）。请按 kix 范式处理这个事件，先给出你的处理计划。'

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isAbsolute(value) {
  if (!isNonEmptyString(value)) return false
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

// 通配匹配：只支持 '*' 前缀/后缀/全匹配（够用，不做正则——避免配置里注入模式）
function matchesPattern(value, pattern) {
  if (typeof value !== 'string' || typeof pattern !== 'string') return false
  if (pattern === '*') return true
  if (pattern.startsWith('*')) return value.endsWith(pattern.slice(1))
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1))
  return value === pattern
}

// 把 GitHub 投递压成插值上下文；payload 形状按事件不同，缺失字段一律空串
function contextOf(delivery) {
  const event = delivery && delivery.event ? delivery.event : {}
  const payload = event && event.payload && typeof event.payload === 'object' ? event.payload : {}
  const pr = payload.pull_request || {}
  const issue = payload.issue || {}
  const repo = payload.repository || {}
  const sender = payload.sender || {}
  return {
    event: isNonEmptyString(event.name) ? event.name : '',
    action: isNonEmptyString(payload.action) ? payload.action : '',
    repository: isNonEmptyString(repo.full_name) ? repo.full_name : '',
    sender: isNonEmptyString(sender.login) ? sender.login : '',
    number: String(pr.number ?? issue.number ?? payload.number ?? ''),
    title: isNonEmptyString(pr.title) ? pr.title : (isNonEmptyString(issue.title) ? issue.title : ''),
    url: isNonEmptyString(pr.html_url) ? pr.html_url : (isNonEmptyString(issue.html_url) ? issue.html_url : ''),
    delivery: isNonEmptyString(delivery && delivery.deliveryId) ? delivery.deliveryId : '',
  }
}

// 模板插值：未命中的 key 保留原样（暴露配置错误，不静默吞掉）
function renderTemplate(template, context) {
  return String(template).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(context, key) ? context[key] : whole)
}

function eventKey(delivery) {
  const event = delivery && delivery.event ? delivery.event : {}
  const payload = event && event.payload && typeof event.payload === 'object' ? event.payload : {}
  const name = isNonEmptyString(event.name) ? event.name : ''
  const action = isNonEmptyString(payload.action) ? payload.action : ''
  return action ? `${name}.${action}` : name
}

function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const events = Array.isArray(raw.events) && raw.events.length > 0
    ? raw.events.filter(isNonEmptyString)
    : DEFAULT_EVENTS.slice()
  const ignoreSenders = Array.isArray(raw.ignoreSenders)
    ? raw.ignoreSenders.filter(isNonEmptyString)
    : DEFAULT_IGNORE_SENDERS.slice()
  const maxSessions = Number.isSafeInteger(raw.maxSessions) && raw.maxSessions >= 0
    ? raw.maxSessions
    : DEFAULT_MAX_SESSIONS
  return {
    enabled: raw.enabled === true,
    workspacePath: isNonEmptyString(raw.workspacePath) ? raw.workspacePath : undefined,
    agentPreset: isNonEmptyString(raw.agentPreset) ? raw.agentPreset : DEFAULT_AGENT_PRESET,
    permissionPreset: isNonEmptyString(raw.permissionPreset) ? raw.permissionPreset : DEFAULT_PERMISSION_PRESET,
    events,
    ignoreSenders,
    maxSessions,
    promptTemplate: isNonEmptyString(raw.promptTemplate) ? raw.promptTemplate : DEFAULT_PROMPT,
  }
}

// 纯函数：投递 → 会话请求（null = 不动作）。测试直接打这个面。
function decide(delivery, cfg, state) {
  const config = normalizeConfig(cfg)
  const counters = state && typeof state === 'object' ? state : { started: 0 }
  if (!config.enabled) return null
  if (!isAbsolute(config.workspacePath)) return null
  if (typeof counters.started === 'number' && counters.started >= config.maxSessions) return null
  if (!delivery || typeof delivery !== 'object') return null
  const key = eventKey(delivery)
  if (!config.events.some((pattern) => matchesPattern(key, pattern))) return null
  const context = contextOf(delivery)
  if (context.sender && config.ignoreSenders.some((pattern) => matchesPattern(context.sender, pattern))) return null
  const prompt = renderTemplate(config.promptTemplate, context)
  if (!isNonEmptyString(prompt)) return null
  const title = context.number
    ? `${context.event}#${context.number} ${context.title || context.action || ''}`.trim()
    : `${context.event} ${context.action}`.trim()
  return {
    workspacePath: config.workspacePath,
    title: title || 'webhook',
    prompt,
    agentPreset: config.agentPreset,
    permissionPreset: config.permissionPreset,
  }
}

const name = 'kix-webhook'

function apply(ctx, config) {
  const normalized = normalizeConfig(config)
  if (!normalized.enabled) {
    ctx.logger.info('kix-webhook: disabled (set enabled: true in the PRESET row config — $DSH_HOME/.agent-presets/<preset>/agent.cordis.yml — not the profile patch; see dsh/preset/patches/kix-webhook.reference.yml §2)')
    return
  }
  if (!isAbsolute(normalized.workspacePath)) {
    ctx.logger.warn('kix-webhook: workspacePath must be an absolute existing directory; rule not registered')
    return
  }
  const state = { started: 0 }
  ctx.inject(['webhookRuntime'], (scope) => {
    scope.effect(() => {
      const dispose = scope.webhookRuntime.register({
        id: 'kix-webhook',
        kind: 'github',
        run(delivery) {
          const request = decide(delivery, normalized, state)
          if (request === null) {
            ctx.logger.debug(`kix-webhook: delivery ${delivery && delivery.deliveryId} ignored`)
            return null
          }
          state.started += 1
          ctx.logger.info(`kix-webhook: starting session "${request.title}" (${state.started}/${normalized.maxSessions})`)
          return request
        },
      })
      return () => { void dispose() }
    })
  })
}

module.exports = { name, apply, decide, renderTemplate, matchesPattern, normalizeConfig, contextOf, eventKey }
