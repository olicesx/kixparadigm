// kix-settle — 结算信号（L1+L4 合并落地，2026-08-19）
//
// 出生证明：
//   EXP1/2/3 的共同结构——报告可以正确而实现错位；每次我们让裁决变真
//   （battery/盲审计/verify 脚本），缺陷几分钟内被抓；三轮在 prompt 里给
//   反证「定价」零效果。结论：激励活在结算层，不活在劝说层。
//   本插件只做一件事：交付时（agent/turn-stopping）若存在工作区编辑且
//   最后一次编辑后无任何新进程执行，单发一条按零结算框架的 steer 提醒。
//   单发（每会话一次）、advisory、不阻断、不规定验证方式——与
//   kix-discipline 的 green gate（kixincentive 中 disabled）语义互补但
//   更宽：任何执行证据（probe/run_code/python/pytest）都算清账。
// 退役条件：trace 数据显示采纳本提醒后未验证交付率趋零 → 通道已内化。
'use strict'
const { randomUUID } = require('node:crypto')

const EXEC_RE = /\b(python|python3|pytest|pip\s+install|node|probe\b)/i

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

module.exports = {
  name: 'kix-settle',
  inject: ['tools'],
  apply(ctx) {
    const states = new Map()

    function stateFor(agent) {
      const sid = agent && agent.session && agent.session.id
      if (!sid) return undefined
      if (!states.has(sid)) {
        states.set(sid, { edits: 0, executedSinceLastEdit: false, execs: 0, reminded: false })
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
        }
      } catch (_) { /* observation must never break execution */ }
      return typeof next === 'function' ? next() : result
    })

    // ── 交付结算：回合收尾时投递按零结算 steer（2026-08-20 补齐）────────────
    // 出生证明补遗：初版（2026-08-19）只实现了 post-execute 状态记账，注释声称的
    // "交付时（agent/turn-stopping）单发一条 steer 提醒" 从未落地——makeUserMessage/
    // settleText 定义后零调用，reminded 字段预留未读。本次补齐投递端：
    // 回合停止时若存在工作区编辑且最后一次编辑后无任何新进程执行 → 单发一次
    // advisory 提醒（每会话一次，reminded 置位）。语义与 kix-discipline 的
    // green gate 互补但更宽：任何执行证据（probe/run_code/python/pytest）都算清账。
    ctx.on('agent/turn-stopping', async (payload) => {
      try {
        const agent = payload && payload.agent
        if (!agent) return
        const st = stateFor(agent)
        if (!st) return
        // 结算触发条件：有编辑 + 最后一次编辑后无执行 + 本会话未提醒过。
        if (st.edits > 0 && !st.executedSinceLastEdit && !st.reminded) {
          st.reminded = true
          agent.steer(makeUserMessage(settleText(st.edits)))
        }
      } catch (_) { /* steer must never break the turn */ }
    })
  },
}
