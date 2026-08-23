// kix-settle — 结算信号（L1+L4 合并落地；v3 同源置信降档，2026-08-23）
//
// 出生证明：
//   EXP1/2/3 的共同结构——报告可以正确而实现错位；每次我们让裁决变真
//   （battery/盲审计/verify 脚本），缺陷几分钟内被抓；三轮在 prompt 里给
//   反证「定价」零效果。结论：激励活在结算层，不活在劝说层。
//   本插件只做一件事：交付时（agent/turn-stopping）按零结算框架单发
//   advisory 提醒。不阻断、不规定验证方式。
//
// 两条触发（互补，各自每会话单发）：
//   ① 实现结算（v1）：有工作区编辑且最后一次编辑后无任何新进程执行。
//      任何执行证据（probe/run_code/python/pytest）都算清账。与
//      kix-discipline 的 green gate 互补但更宽。
//   ② 高置信提交（v2，PR#33；v3，ZCode P4）：无工作区编辑、终稿像
//      审查结论时，按成功观察通道分级结算：无 fresh observer → 提醒补独立
//      复核；只有同源 fresh observer → 提醒按单模型置信表述；成功的
//      subagent_cross → 跨厂商清账。失败调用不记账。启发式只匹配结论姿态。
//      出生证明：kix-route 单厂商 cross 会响亮失败并建议同源复核，但 v2 把
//      subagent/reviewer 与 cross 同记为 independent，造成权重级独立性虚高。
//      退役条件：宿主提供实际 resolved provider 元数据后，改为按真实厂商结算。
//
// 退役条件：
//   ① 实现结算：trace 数据显示采纳本提醒后未验证交付率趋零 → 通道已内化。
//   ② 高置信提交：后续真实审查任务里独立观察者召回率趋近 4/4 fresh 覆盖，
//      且误报（非结论姿态被提醒）> 真报 → 收紧启发式或删除本路。
'use strict'
const { randomUUID } = require('node:crypto')

const EXEC_RE = /\b(python|python3|pytest|pip\s+install|node|probe\b)/i

const FRESH_OBSERVERS = new Set([
  'subagent',
  'subagent_cross',
  'subagent_reviewer',
])
const VENDOR_INDEPENDENT_OBSERVERS = new Set(['subagent_cross'])

// 审查结论姿态：终稿在交付审查判定，不是过程叙述。
// 刻意收窄——「看起来不错」「暂无问题」等软赞不触发（避免过程中途误报）。
const VERDICT_RES = [
  /\bLGTM\b/i,
  /\bAPPROVE(?:D)?\b/,
  /\brequest[- ]changes\b/i,
  /\bCOMMENT\b/,
  /可以合并/,
  /建议合并/,
  /不建议合并/,
  /请求修改/,
]

function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'kix-settle', form: 'notice', summary: text.slice(0, 100) },
  }
}

function settleText(n) {
  return 'kix-settle: 本会话有 ' + n + ' 处工作区编辑，最后一次编辑后没有任何新进程执行（python/pytest/probe）。' +
    '无执行证据的结论按零结算——交付时每个关键判断只按可重放证据计价。' +
    '若环境限制确实无法执行，请在交付说明中显式声明未验证点及其影响。已验证过则忽略本提醒。'
}

function commitBlindText() {
  return 'kix-settle: 本回合终稿像审查结论（LGTM / APPROVE / request-changes / 可以合并），' +
    '但本会话未派过任何成功的 fresh 观察者。拉取式记忆对高置信提交时刻失明——自信时不会去查库。' +
    '独立性是验证杠杆：fresh 评审人（无先验结论）覆盖缺陷空间，原审者复审自己最差。' +
    '消费对抗 finding 时复核严重度（对抗侧易过升，承诺侧易偏松）。已派过则忽略。'
}

function singleVendorText() {
  return 'kix-settle: 本回合终稿像审查结论，已有成功的 fresh 观察者，' +
    '但没有成功的跨厂商观察通道。同源复核能去相关上下文与 prompt 视角，不能消除权重级共享盲点。' +
    '请将结论按「单模型置信」表述；blocking/major 判断至少补一条可重放的非模型证据' +
    '（测试/构建输出、官方契约原文或 sandbox 实测）。已按此降档则忽略。'
}

function lastAssistantText(surface) {
  if (!surface || !Array.isArray(surface.events)) return undefined
  for (let i = surface.events.length - 1; i >= 0; i--) {
    const ev = surface.events[i]
    if (ev && ev.type === 'assistant/message' && ev.data && ev.data.message) {
      const content = ev.data.message.content
      if (Array.isArray(content)) {
        const text = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
        if (text) return text
      }
      return undefined
    }
  }
  return undefined
}

function looksLikeVerdict(text) {
  const t = String(text || '')
  if (!t) return false
  return VERDICT_RES.some((re) => re.test(t))
}

function resolvedToolName(exec) {
  const name = String((exec && exec.name) || '').toLowerCase()
  if (name === 'kix_capability_call') {
    const args = (exec && exec.arguments) || {}
    return String(args.tool || '').toLowerCase()
  }
  return name
}

function observerLevel(name) {
  const normalized = String(name || '').toLowerCase()
  if (VENDOR_INDEPENDENT_OBSERVERS.has(normalized)) return 'vendor-independent'
  if (FRESH_OBSERVERS.has(normalized)) return 'fresh'
  return undefined
}

function observerResultSucceeded(exec, result) {
  if (!result || result.isError === true) return false
  if (String(exec && exec.name || '').toLowerCase() !== 'kix_capability_call') return true
  const value = result.value
  if (!value || typeof value !== 'object' || value.ok !== true) return false
  const nested = value.result
  return Boolean(nested && typeof nested === 'object' && nested.isError === false)
}

module.exports = {
  name: 'kix-settle',
  inject: ['tools'],
  apply(ctx) {
    const states = new Map()

    function stateFor(agent) {
      const sid = agent && agent.session && agent.session.id
      if (!sid) return undefined
      if (!states.has(sid)) {
        states.set(sid, {
          edits: 0,
          executedSinceLastEdit: false,
          execs: 0,
          reminded: false,
          freshObserverSeen: false,
          vendorIndependentObserverSeen: false,
          commitBlindReminded: false,
        })
      }
      return states.get(sid)
    }

    function cwdOf(agent) {
      try {
        const c = agent && agent.session && agent.session.header && agent.session.header.cwd
        return typeof c === 'string' && c.length ? c : undefined
      } catch (_) { return undefined }
    }

    ctx.on('tools/post-execute', async (exec, result, next) => {
      // 防御包裹：任何状态下绝不让本插件的观察逻辑抛异常——
      // 宿主会把事件链异常转成工具执行失败（flash 适配器实测）。
      try {
        const agent = exec && exec.agent
        const st = stateFor(agent)
        if (st) {
          const name = String(exec.name || '').toLowerCase()
          const args = exec.arguments || {}
          if (name === 'edit' || name === 'write') {
            const fp = String(args.file_path || args.path || '')
            const cwd = cwdOf(agent)
            if (fp && (!cwd || fp.startsWith(cwd))) {
              st.edits += 1
              st.executedSinceLastEdit = false
            }
          } else if (name === 'probe' || name === 'run_code') {
            st.execs += 1
            st.executedSinceLastEdit = true
          } else if (name === 'bash' || name === 'pwsh' || name === 'shell') {
            const cmd = String(args.command || args.cmd || '')
            if (EXEC_RE.test(cmd)) {
              st.execs += 1
              st.executedSinceLastEdit = true
            }
          }
          const observer = observerLevel(resolvedToolName(exec))
          if (observer && observerResultSucceeded(exec, result)) {
            st.freshObserverSeen = true
            if (observer === 'vendor-independent') st.vendorIndependentObserverSeen = true
          }
        }
      } catch (_) { /* observation must never break execution */ }
      return typeof next === 'function' ? next() : result
    })

    // ── 交付结算：回合收尾时投递按零结算 steer（2026-08-20 补齐；v2 2026-08-21）
    // 出生证明补遗：初版（2026-08-19）只实现了 post-execute 状态记账，注释声称的
    // "交付时（agent/turn-stopping）单发一条 steer 提醒" 从未落地——makeUserMessage/
    // settleText 定义后零调用，reminded 字段预留未读。v1.3.2 补齐投递端。
    // v2：PR#33 实证——审查 LGTM 无工作区编辑，v1 条件打不中；拉取式记忆对
    // 高置信提交时刻失明。v3 按 fresh / vendor-independent 两级布尔证据位结算；
    // 布尔位同时吸收 capability proxy 内外层重复 post 事件。readSurface 失败静默跳过。
    ctx.on('agent/turn-stopping', async (payload) => {
      try {
        const agent = payload && payload.agent
        if (!agent) return
        const st = stateFor(agent)
        if (!st) return
        // ① 实现结算：有编辑 + 最后一次编辑后无执行 + 本会话未提醒过。
        if (st.edits > 0 && !st.executedSinceLastEdit && !st.reminded) {
          st.reminded = true
          agent.steer(makeUserMessage(settleText(st.edits)))
        }
        // ② 高置信提交：无编辑 + 无成功跨厂商观察 + 终稿像审查结论。
        // 有编辑走 ①，不在审查结论路上叠提醒（实现任务不是审查交付）。
        if (st.edits === 0 && !st.vendorIndependentObserverSeen && !st.commitBlindReminded) {
          const sessionQuery = ctx.get && ctx.get('sessionQuery')
          const sessionId = agent && agent.session && agent.session.id
          if (sessionQuery && sessionId) {
            try {
              const surface = await sessionQuery.readSurface(sessionId)
              const text = lastAssistantText(surface)
              if (looksLikeVerdict(text)) {
                st.commitBlindReminded = true
                const notice = st.freshObserverSeen ? singleVendorText() : commitBlindText()
                agent.steer(makeUserMessage(notice))
              }
            } catch (_) { /* 表面读取失败静默：本路是可选项 */ }
          }
        }
      } catch (_) { /* steer must never break the turn */ }
    })
  },
}

module.exports.__internals = {
  looksLikeVerdict,
  lastAssistantText,
  resolvedToolName,
  observerLevel,
  observerResultSucceeded,
  settleText,
  commitBlindText,
  singleVendorText,
  VERDICT_RES,
  FRESH_OBSERVERS,
  VENDOR_INDEPENDENT_OBSERVERS,
}
