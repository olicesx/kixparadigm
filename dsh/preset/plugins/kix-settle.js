// kix-settle — 结算信号（L1+L4 合并落地，2026-08-19；v2 高置信提交，2026-08-21）
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
//   ② 高置信提交（v2，PR#33 审查实验）：无工作区编辑、终稿像审查结论
//      （LGTM / APPROVE / request-changes / 可以合并），且本会话未派过
//      独立观察者。拉取式记忆对「高置信提交时刻」失明——全程无迷茫就
//      不查库；修法是换信道，不是往索引加条目。清账 = 派过独立观察
//      （subagent / subagent_cross / subagent_reviewer，含 kix_capability_call
//      代理这些工具）。启发式只匹配结论姿态，进行中/提问不触发。
//
// 退役条件：
//   ① 实现结算：trace 数据显示采纳本提醒后未验证交付率趋零 → 通道已内化。
//   ② 高置信提交：后续真实审查任务里独立观察者召回率趋近 4/4 fresh 覆盖，
//      且误报（非结论姿态被提醒）> 真报 → 收紧启发式或删除本路。
'use strict'
const { randomUUID } = require('node:crypto')

const EXEC_RE = /\b(python|python3|pytest|pip\s+install|node|probe\b)/i

const INDEPENDENT_OBSERVERS = new Set([
  'subagent',
  'subagent_cross',
  'subagent_reviewer',
])

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
    '但本会话未派过独立观察者。拉取式记忆对高置信提交时刻失明——自信时不会去查库。' +
    '独立性是验证杠杆：fresh 评审人（无先验结论）覆盖缺陷空间，原审者复审自己最差。' +
    '消费对抗 finding 时复核严重度（对抗侧易过升，承诺侧易偏松）。已派过则忽略。'
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

function isIndependentObserver(name) {
  return INDEPENDENT_OBSERVERS.has(String(name || '').toLowerCase())
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
          independentObservers: 0,
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
          if (isIndependentObserver(resolvedToolName(exec))) {
            st.independentObservers += 1
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
    // 高置信提交时刻失明。新增第二路：无编辑 + 终稿像审查结论 + 未派独立
    // 观察者 → advisory（每会话一次）。readSurface 缺失/失败静默跳过。
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
        // ② 高置信提交：无编辑 + 未派独立观察 + 终稿像审查结论。
        // 有编辑走 ①，不在审查结论路上叠提醒（实现任务不是审查交付）。
        if (st.edits === 0 && st.independentObservers === 0 && !st.commitBlindReminded) {
          const sessionQuery = ctx.get && ctx.get('sessionQuery')
          const sessionId = agent && agent.session && agent.session.id
          if (sessionQuery && sessionId) {
            try {
              const surface = await sessionQuery.readSurface(sessionId)
              const text = lastAssistantText(surface)
              if (looksLikeVerdict(text)) {
                st.commitBlindReminded = true
                agent.steer(makeUserMessage(commitBlindText()))
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
  isIndependentObserver,
  settleText,
  commitBlindText,
  VERDICT_RES,
  INDEPENDENT_OBSERVERS,
}
