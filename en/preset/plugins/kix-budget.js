// kix-budget — 主会话预算与交接 gate（v6.0，2026-08-17 WSL2 DSH 实弹驱动）
//
// 定位：v5.8 之前的成本纪律全部作用于子代理（lite 档/预算帽/思考归一化，
// 每步固定开销 34.3k→5.9k），但 48 会话 / 173M 重读 token 的账本显示燃烧
// 大头在主会话本身：
//   - ㉑ 上下文 O(N²) 累积：kixpower 整改会话 336 步、上下文 1.2K→466K
//     单调爬升，累计重读 100.8M（占全部账本 58%）。compaction 阈值
//     0.8×窗口 在 1M 窗口 = 800K，实测从未触发。
//   - ㉒ orchestrator 本体做机械活：马拉松 turn 157 个 bash 全是 grep/sed
//     逐文件核对——正是规则 ⑳ 禁止但无机制强制的模式。
//   - ㉓ 工具结果堆积：812K 字符结果永久驻留表面（top10 全部顶到 16K
//     截断帽）；toolResultPruner 只在 compaction 阈值后才跑 = 从不跑。
//
// 机制（事件感知 + 主会话交接 gate + 宿主结果剪裁）：
//   - session/event：从 assistant/message.usage 记录每会话最新上下文
//     （inputTokens+cacheReadTokens）；turn/start 重置回合内计数；tool/result
//     置脏标记（下一步边界才测量，O(surface) 不空转）。
//   - agent/pre-step（waterfall）：读取真实 turn/step，超过 40 步或动态预算就标记交接；新结果按宿主 pruner 字符阈值剪裁
//     调 toolResultPruner.pruneSession —— 单结果超阈值立即剪，过半预算仍作为兜底
//     （㉓）。原始事件由宿主 session surface 保留，插件不自行写文件。
//   - tools/pre-execute：主会话 handoffRequired 时拒绝普通工具，只放行 lite/goal 交接；tools/post-execute 保留 streak 提醒
//     与动态预算 gate；agent/turn-stopping 对未完成交接发出可回放 steer。

//   - agent/turn-stopping：纯散文回合也会收到一次 gate steer，交接完成后状态解除。

//   - 预算 = budgetRatioTiers 按窗口分档取比例（v1.2.21 完全动态化：有效窗口不套默认帽）；
//     无窗口/无效窗口回退 absoluteCapTokens（默认 150K）；窗口经
//     llm.resolveModelInfo 解析并按 provider/model 缓存；解析失败不缓存，下一次继续感知。
//
// 参数从实测派生（反过拟合①，不做论文默认值）：
//   - absoluteCapTokens=150K：无窗口时的回退值 + 用户可选硬顶（显式配置才截断
//     分档值，默认值不再截断有效窗口的分档结果）；数值与主线程原始契约和
//     WSL2 gate 验收线一致；luna 会话 ~200K/步即进入燃烧区；deepseek 马拉松
//     150K 后还有 290 步。
//   - streakReadOnly=8：正常回合只读步 ≤3-4；马拉松出现 10-20+ 连读。
//   - resultThresholdChars：从宿主 pruner.config.thresholdChars 读取，默认 2K；
//   - turnStepLimit=40：第 41 步进入交接 gate。
//
// 边界诚实声明：
//   - 主会话 gate 是 deny 级；child 只保留各自 scope 的预算/剪裁观察，不继承主会话交接锁。
//   - 交接成功状态按回合/水位隔离，避免同一阈值在同一回合重锁。
//   - 事件按 agent scope 过滤，子代理会话天然不在覆盖面（kix-discipline
//     同款边界）；子代理预算由各工具行 maxTokens 兜底（v5.8 ⑰）。
//   - 600K 断崖已随默认帽废止消失（v1.2.21 完全动态化）；absoluteCapTokens
//     现为可选配置：仅无窗口回退或用户显式配置硬顶时生效。
//   - 本插件必须挂在 compaction 组 realm 内（isolate: toolResultPruner）：
//     ctx.get('toolResultPruner') 只在同 realm 可见（compaction-basic 同款
//     约束）；tokenMeter/llm 留在宿主面，realm 内照常解析。
//
// 挂载：preset agent.cordis.yml compaction 组内一行：
//   - id: kix-budget
//     name: ./plugins/kix-budget.js
// 测试：node plugins/kix-budget.test.js（纯逻辑经 __internals 验证）。

'use strict'

const { randomUUID } = require('node:crypto')
const lib = require('./consistency-lib.cjs')

// ── 常量（实测派生，见文件头）─────────────────────────────────────────────
const DEFAULTS = {
  enabled: true,
  budgetRatio: 0.35,
  absoluteCapTokens: 150000, // 无窗口回退值 + 用户可选硬顶（显式配置才截断分档值）
  streakReadOnly: 8,
  turnStepLimit: 40,
  resultThresholdChars: 2048,
  pruneRatio: 0.5,
  hardHandoff: true,
  // 预算比例分档（budgetRatioTiers，v1.2.21 完全动态化）：按上下文窗口动态取比例
  //   - W ≤ 128K（131072）→ 0.85；W ≤ 400K（409600）→ 0.65；
  //     W ≤ 1M（1048576）→ 0.40；W > 1M → 0.35；无窗口 → 回退 absoluteCapTokens
  //   - 斜率语义：小窗尽量用满（handoff 固定开销占比高）、比例随窗口递减、超长档防线性外推
  // 兼容性：若 cfg.budgetRatio 显式存在，则整条曲线走该值（老配置不破坏）
}

// 只读命令动词表（保守 allowlist：node/python/bash 等可任意写盘的解释器
// 一律不算只读——马拉松里的 python3 heredoc 全在写文件）
const READONLY_VERBS = new Set([
  'grep', 'rg', 'sed', 'awk', 'cat', 'head', 'tail', 'ls', 'find', 'wc',
  'diff', 'file', 'stat', 'du', 'df', 'pwd', 'which', 'type', 'echo',
  'printf', 'git', 'jq', 'sort', 'uniq', 'cut', 'tr', 'nl', 'tree',
  'md5sum', 'sha256sum', 'true', 'test', 'cd',
])
// 变异标记（在动词表之前先否决：重定向/git 写子命令/安装/写文件解释器）
const MUTATION_RE = new RegExp(
  '>>?' +
    '|\\bsed\\s+(-[a-z]*i|--in-place)\\b' +
    '|\\bgit\\s+(add|commit|push|pull|fetch|checkout|reset|rebase|merge|stash|clean|restore|switch|apply|clone|worktree|config|branch|tag|notes|remote|update-ref|reflog|submodule)\\b' +
    '|\\b(rm|mv|cp|mkdir|touch|chmod|chown|tee|truncate|split|patch|dd)\\b' +
    '|\\b(npm|pnpm|yarn|bun)\\s+(i|install|ci|create|publish|link|exec)\\b' +
    '|\\bpip\\d?\\s+install\\b|\\bcargo\\s+(build|run|install|publish)\\b|\\bmake\\b' +
    '|\\b(node|deno|python\\d?|pwsh|powershell|bash|sh|zsh|docker|kubectl|helm|terraform|ansible)\\b',
)

// ── 纯判定函数（模块级：单元测试经 __internals 直接验证）─────────────────

function isReadOnlyCommand(cmd) {
  let s = String(cmd || '')
    .replace(/\s2>\/dev\/null/g, '')
    .replace(/\s>\/dev\/null/g, '')
    .trim()
  if (!s) return false
  if (MUTATION_RE.test(s)) return false
  const segs = s.split(/&&|\|\||;|\|/).map((x) => x.trim()).filter(Boolean)
  if (!segs.length) return false
  return segs.every((seg) => {
    const m = seg.match(/^(cd\s+\S+|[A-Za-z][\w.-]*)/)
    if (!m) return false
    const verb = m[0].startsWith('cd ') ? 'cd' : m[0]
    return READONLY_VERBS.has(verb)
  })
}

function isReadOnlyTool(name, args) {
  const tool = String(name || '').toLowerCase()
  if (tool === 'read' || tool === 'grep' || tool === 'glob') return true
  if (tool === 'bash' || tool === 'pwsh' || tool === 'shell') {
    return isReadOnlyCommand(args && (args.command || args.cmd))
  }
  return false
}

function resolveBudgetTokens(contextWindow, cfg) {
  const c = cfg || DEFAULTS
  const cap = Number(c.absoluteCapTokens) || DEFAULTS.absoluteCapTokens
  // 兼容性：若 cfg.budgetRatio 显式存在且不等于默认值，则使用该值（老配置不破坏）
  if (c && c !== DEFAULTS && typeof c.budgetRatio === 'number' && c.budgetRatio !== DEFAULTS.budgetRatio) {
    const ratio = c.budgetRatio
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return cap
    return Math.floor(contextWindow * ratio) // 显式配置不截断（用户可设置更高预算）
  }
  // v1.2.21 完全动态化：有效窗口走纯分档，不再套默认帽；absoluteCapTokens
  // 仅作无窗口回退；显式配置的非默认 absoluteCapTokens 作为用户可选硬顶
  const explicitCap =
    c !== DEFAULTS && c.absoluteCapTokens !== DEFAULTS.absoluteCapTokens &&
    Number.isFinite(c.absoluteCapTokens) && c.absoluteCapTokens > 0
      ? cap
      : Infinity
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return cap
  // 预算比例分档（按上下文窗口动态取比例）
  //   - W ≤ 131072（128K）：0.85（小窗口 handoff 固定开销占比高，尽量用满）
  //   - 131072 < W ≤ 409600（400K）：0.65（中档回落）
  //   - 409600 < W ≤ 1048576（1M）：0.40（大档利用率回升）
  //   - W > 1M：0.35（超长档防线性外推）
  let ratio
  if (contextWindow <= 131072) {
    ratio = 0.85
  } else if (contextWindow <= 409600) {
    ratio = 0.65
  } else if (contextWindow <= 1048576) {
    ratio = 0.40
  } else {
    ratio = 0.35
  }
  return Math.min(Math.floor(contextWindow * ratio), explicitCap)
}

function usageContextTokens(usage) {
  if (!usage) return 0
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  return n(usage.inputTokens) + n(usage.cacheReadTokens) + n(usage.cacheWriteTokens)
}

function routedTargetOf(session) {
  try {
    const hdr = typeof session.requestHeader === 'function' ? session.requestHeader() : session.requestHeader
    const config = hdr && hdr.config
    if (config && config.provider && config.model) return { provider: config.provider, model: config.model }
  } catch { /* 形状不符按无路由处理 */ }
  return undefined
}

function isMainAgent(agent) {
  let depth = agent && agent.options ? Number(agent.options.subagentDepth) : undefined
  const header = agent && agent.session && agent.session.header
  if (!Number.isFinite(depth) && header) {
    const headerDepth = Number(header.delegationDepth)
    depth = Number.isFinite(headerDepth) ? headerDepth : 0
  }
  return Number.isFinite(depth) && depth < 1
}

function resultTextChars(data) {
  const blocks = data && data.message && data.message.content
  if (!Array.isArray(blocks)) return 0
  let total = 0
  for (const block of blocks) {
    if (!block || !Array.isArray(block.content)) continue
    for (const part of block.content) {
      if (part && part.type === 'text') total += Array.from(String(part.text || '')).length
    }
  }
  return total
}

function prunerThreshold(pruner, cfg) {
  const configured = pruner && pruner.config && Number(pruner.config.thresholdChars)
  return Number.isFinite(configured) && configured > 0
    ? configured
    : Number(cfg.resultThresholdChars) || DEFAULTS.resultThresholdChars
}

function transitionToolOf(exec) {
  const name = String(exec && exec.name || '')
  if (name === 'subagent_lite' || name === 'create_goal') return name
  if (name !== 'kix_capability_call') return undefined
  let args = exec && (exec.arguments ?? exec.args)
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { args = undefined }
  }
  const target = args && typeof args === 'object' ? String(args.tool || '') : ''
  if (target === 'subagent_lite' || target === 'create_goal') return target
  const raw = JSON.stringify(exec)
  if (raw.includes('subagent_lite')) return 'subagent_lite'
  if (raw.includes('create_goal')) return 'create_goal'
  return undefined
}

function isHandoffDiscovery(exec) {
  const name = String(exec && exec.name || '')
  if (name === 'kix_capability_search') return true
  if (name !== 'kix_tool_activate') return false
  let args = exec && (exec.arguments ?? exec.args)
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { args = undefined }
  }
  const target = args && typeof args === 'object' ? String(args.tool || '') : ''
  return target === 'subagent_lite' || target === 'goal'
}

function handoffText(st) {
  const trigger = st.handoffReason === 'context'
    ? `上下文已达到动态预算 ${Math.round(st.handoffBudget / 1000)}K tokens`
    : `当前回合已达到 ${st.handoffStep} 步`
  return `kix-budget gate: 主会话 ${trigger}。机械/长任务交接是强制边界：下一步只能调用 subagent_lite 或 create_goal（可先用 capability_search 发现参数），不要继续主线程逐项取证；判断留在主线程。交接成功后 gate 自动解除。`
}

function handoffDenyText(st) {
  return `${handoffText(st)} 当前工具调用已拒绝，原因：必须先完成可回放的 lite/goal 交接。`
}

function satisfyHandoff(st) {
  st.handoffRequired = false
  st.handoffSteered = false
  st.handoffSatisfied = true
  st.handoffReason = ''
  st.handoffStep = 0
  st.handoffBudget = 0
}

function makeUserMessage(text, form = 'notice') {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'kix-budget', form, summary: text.slice(0, 100) },
  }
}

function streakAdviceText(n) {
  return `kix-budget: 主线程已连续 ${n} 步只读检索/核对（实测：orchestrator 逐文件通读是最大燃烧源，⑳）。剩余机械取证请改派 subagent_lite（并行 ≤2，让其落盘只回结论），判断与编排留在主线程。本回合不再重复提醒。`
}

function budgetAdviceText(ctxTokens, budgetTokens) {
  const k = (n) => Math.round(n / 1000)
  return `kix-budget: 上下文已达 ${k(ctxTokens)}K tokens（本会话动态预算 ${k(budgetTokens)}K；窗口由运行时模型目录解析）。① 后续大块输出落盘、只回文件路径+结论 ② 未完机械步骤改派 subagent_lite ③ 本回合收尾，长任务用 goal 续跑或 /kixpower-continue。本回合不再重复提醒。`
}

// ── 插件 ───────────────────────────────────────────────────────────────────

module.exports = {
  name: 'kix-budget',
  apply(ctx, config) {
    const cfg = Object.assign({}, DEFAULTS, config || {})
    if (cfg.enabled === false) return

    const states = new Map()
    const transitionByCall = new Map()
    function stateFor(sessionId) {
      const key = String(sessionId || 'anonymous')
      let st = states.get(key)
      if (!st) {
        st = { streak: 0, advisedStreak: false, advisedBudget: false, lastCtx: 0, dirty: false, oversizeResult: false, oversizeGeneration: 0, dirtyGeneration: 0, turnSteps: 0, handoffRequired: false, handoffSteered: false, handoffSatisfied: false, handoffReason: '', handoffStep: 0, handoffBudget: 0 }
        states.set(key, st)
      }
      return st
    }

    // 预算解析（provider/model → contextWindow，缓存；失败回退绝对帽）
    const windowCache = new Map()
    async function budgetFor(agent) {
      const llm = ctx.get('llm')
      const target = agent && agent.session ? routedTargetOf(agent.session) : undefined
      if (!llm || !target) return resolveBudgetTokens(undefined, cfg)
      const key = target.provider + '/' + target.model
      if (windowCache.has(key)) return resolveBudgetTokens(windowCache.get(key), cfg)
      try {
        const info = await llm.resolveModelInfo(target.provider, target.model)
        const win = Number(info && info.context && info.context.contextWindow)
        if (Number.isFinite(win) && win > 0) windowCache.set(key, win)
      } catch {
        return resolveBudgetTokens(undefined, cfg)
      }
      return resolveBudgetTokens(windowCache.has(key) ? windowCache.get(key) : undefined, cfg)
    }

    function contextTokensFor(session, st) {
      let tokens = Number(st.lastCtx) || 0
      try {
        const meter = ctx.get('tokenMeter')
        const measured = meter && meter.measure(session)
        const total = Number(measured && measured.totalTokens)
        if (Number.isFinite(total) && total > 0) tokens = total
      } catch { /* usage fallback remains authoritative when meter is unavailable */ }
      return tokens
    }

    // ── session/event：低开销记账（usage / 回合边界 / 结果落舱脏标记）─────
    ctx.on('session/event', (session, event) => {
      if (!event || !session) return
      const st = stateFor(session.id)
      if (event.type === 'turn/start') {
        const prefix = String(session.id) + ':'
        for (const key of transitionByCall.keys()) {
          if (key.startsWith(prefix)) transitionByCall.delete(key)
        }
        st.streak = 0
        st.turnSteps = 0
        st.advisedStreak = false
        st.advisedBudget = false
        st.handoffSteered = false
        st.handoffSatisfied = false
        return
      }
      const d = event.data || {}
      if (event.type === 'assistant/message' && d.usage) {
        st.lastCtx = usageContextTokens(d.usage)
        return
      }
      if (event.type === 'tool/call') {
        const transition = transitionToolOf({ name: d.name, arguments: d.arguments })
        if (transition && d.callId) transitionByCall.set(String(session.id) + ':' + String(d.callId), transition)
        return
      }
      if (event.type === 'tool/result') {
        st.dirty = true
        st.dirtyGeneration += 1
        st.oversizeGeneration += 1
        const threshold = prunerThreshold(ctx.get('toolResultPruner'), cfg)
        if (resultTextChars(d) > threshold) st.oversizeResult = true
        const callId = d.message && d.message.source && d.message.source.callId
        const transition = callId && transitionByCall.get(String(session.id) + ':' + String(callId))
        if (transition) {
          const normalized = JSON.stringify(d).replace(/\\/g, '')
          const failed = normalized.includes('\"isError\":true') || normalized.includes('\"ok\":false')
          if (st.handoffRequired && !failed && normalized.includes('\"ok\":true')) satisfyHandoff(st)
          transitionByCall.delete(String(session.id) + ':' + String(callId))
        }
      }
    })
    ctx.effect(() => { states.clear(); transitionByCall.clear() })

    // ── agent/pre-step：步计数、动态预算边界与结果急剪 ────────────────────
    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        const agent = payload && payload.agent
        const session = agent && agent.session
        const st = session ? stateFor(session.id) : undefined
        if (st) {
          const step = Number(payload && payload.step)
          if (isMainAgent(agent) && Number.isFinite(step)) {
            st.turnSteps = Math.max(st.turnSteps, step)
            const limit = Number(cfg.turnStepLimit) || DEFAULTS.turnStepLimit
            if (cfg.hardHandoff !== false && step > limit && !st.handoffRequired && !st.handoffSatisfied) {
              st.handoffRequired = true
              st.handoffReason = 'steps'
              st.handoffStep = step
              st.handoffBudget = 0
            }
            const contextTokens = contextTokensFor(session, st)
            if (!st.handoffRequired && !st.handoffSatisfied && contextTokens > 0) {
              const budget = await budgetFor(agent)
              if (contextTokens >= budget) {
                st.handoffRequired = true
                st.handoffReason = 'context'
                st.handoffStep = step
                st.handoffBudget = budget
              }
            }
          }

          const oversizeGeneration = st.oversizeGeneration
          const oversize = st.oversizeResult
          st.oversizeResult = false
          const dirtyGeneration = st.dirtyGeneration
          const dirty = st.dirty
          st.dirty = false
          if (dirty) {
            const meter = ctx.get('tokenMeter')
            const pruner = ctx.get('toolResultPruner')
            let shouldPrune = oversize
            let totalTokens = 0
            if (meter) {
              const measurement = meter.measure(session)
              totalTokens = Number(measurement && measurement.totalTokens) || 0
              const budget = await budgetFor(agent)
              shouldPrune = shouldPrune || totalTokens >= Math.floor(budget * (Number(cfg.pruneRatio) || DEFAULTS.pruneRatio))
            }
            if (shouldPrune && pruner) {
              const res = pruner.pruneSession(session)
              const pruned = res && (res.pruned || res.landed)
              const prunedCount = Array.isArray(pruned) ? pruned.length : 0
              const savedChars = res && (res.charsRemoved || res.savedCodePoints || 0)
              if (prunedCount > 0) {
                ctx.logger.info(`kix-budget: eager prune landed ${prunedCount} nodes (~${savedChars} chars) at ${totalTokens} tokens${oversize ? ' (oversize-result)' : ''}`)
              }
            }
          }
          if (st.dirtyGeneration !== dirtyGeneration) st.dirty = true
          if (st.oversizeGeneration !== oversizeGeneration) st.oversizeResult = true
        }
      } catch (e) {
        ctx.logger.warn(`kix-budget: pre-step processing skipped: ${e && e.message}`)
      }
      return next()
    })

    // ── tools/pre-execute：主会话交接硬门禁（㉑/㉕）────────────────────
    ctx.on('tools/pre-execute', async (exec, next) => {
      const agent = exec && exec.agent
      const session = agent && agent.session
      if (!session || !isMainAgent(agent) || cfg.hardHandoff === false) return next()
      const st = stateFor(session.id)
      if (!st.handoffRequired) return next()
      if (transitionToolOf(exec) || isHandoffDiscovery(exec)) return next()
      return { kind: 'deny', reason: handoffDenyText(st) }
    })

    // ── tools/post-execute：交接完成、streak 提醒与动态预算送达 ───────────
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const agent = exec && exec.agent
      const session = agent && agent.session
      if (!session) return next()
      const st = stateFor(session.id)
      const args = exec && (exec.arguments ?? exec.args)
      if (isReadOnlyTool(exec && exec.name, args)) st.streak += 1
      else st.streak = 0

      const transition = transitionToolOf(exec)
      const outcome = await next()
      const resultJson = result === undefined ? '' : JSON.stringify(result)
      const outcomeJson = outcome === undefined ? '' : JSON.stringify(outcome)
      const resultNormalized = resultJson.replace(/\\/g, '')
      const outcomeNormalized = outcomeJson.replace(/\\/g, '')
      const failed = Boolean(result && result.isError) || Boolean(outcome && outcome.isError) || resultNormalized.includes('\"isError\":true') || resultNormalized.includes('\"ok\":false') || outcomeNormalized.includes('\"isError\":true') || outcomeNormalized.includes('\"ok\":false')
      if (st.handoffRequired && transition && !failed) satisfyHandoff(st)
      try {
        const contextTokens = contextTokensFor(session, st)
        if (isMainAgent(agent) && !st.handoffRequired && !st.handoffSatisfied && contextTokens > 0) {
          const budget = await budgetFor(agent)
          if (contextTokens >= budget) {
            st.handoffRequired = true
            st.handoffReason = 'context'
            st.handoffStep = st.turnSteps
            st.handoffBudget = budget
            st.advisedBudget = true
            return lib.appendContexts(outcome, [makeUserMessage(handoffText(st), 'gate')])
          }
        }
        const limit = Number(cfg.streakReadOnly) || DEFAULTS.streakReadOnly
        if (isMainAgent(agent) && !st.handoffRequired && !st.advisedStreak && st.streak >= limit) {
          st.advisedStreak = true
          return lib.appendContexts(outcome, [makeUserMessage(streakAdviceText(st.streak))])
        }
      } catch (e) {
        ctx.logger.warn(`kix-budget: post-execute processing skipped: ${e && e.message}`)
      }
      return outcome
    })

    // ── agent/turn-stopping：硬交接 steer，确保边界可回放 ────────────────
    ctx.on('agent/turn-stopping', async (payload) => {
      const agent = payload && payload.agent
      const session = agent && agent.session
      if (!session || !isMainAgent(agent)) return
      const st = stateFor(session.id)
      try {
        const contextTokens = contextTokensFor(session, st)
        const budget = await budgetFor(agent)
        if (cfg.hardHandoff !== false && !st.handoffRequired && !st.handoffSatisfied) {
          const limit = Number(cfg.turnStepLimit) || DEFAULTS.turnStepLimit
          if (st.turnSteps > limit) {
            st.handoffRequired = true
            st.handoffReason = 'steps'
            st.handoffStep = st.turnSteps
            st.handoffBudget = budget
          } else if (contextTokens >= budget) {
            st.handoffRequired = true
            st.handoffReason = 'context'
            st.handoffStep = st.turnSteps
            st.handoffBudget = budget
          }
        }
        if (st.handoffRequired && !st.handoffSteered && typeof agent.steer === 'function') {
          st.handoffSteered = true
          agent.steer(makeUserMessage(handoffText(st), 'gate'))
        }
      } catch (e) {
        ctx.logger.warn(`kix-budget: handoff steer skipped: ${e && e.message}`)
      }
    })
  },
  __internals: {
    DEFAULTS,
    isReadOnlyCommand,
    isReadOnlyTool,
    resolveBudgetTokens,
    usageContextTokens,
    routedTargetOf,
    isMainAgent,
    resultTextChars,
    prunerThreshold,
    transitionToolOf,
    isHandoffDiscovery,
    handoffText,
    handoffDenyText,
    streakAdviceText,
    budgetAdviceText,
  },
}
