// kix-settle — 结算信号（v4 terminal lifecycle + revision freshness，2026-08-24）
//
// 出生证明：
//   EXP1/2/3 的共同结构——报告可以正确而实现错位；每次我们让裁决变真
//   （battery/盲审计/verify 脚本），缺陷几分钟内被抓；三轮在 prompt 里给
//   反证「定价」零效果。结论：激励活在结算层，不活在劝说层。
//   本插件只做一件事：交付时（agent/turn-stopping）按零结算框架单发
//   advisory 提醒。不阻断、不规定验证方式。
//
// 两条触发（互补，各自每会话单发）：
//   ① 实现结算：源码/测试编辑跨 worktree 记账；只有当前 edit generation 的
//      foreground exitCode=0 或 background job terminal success 才清账。spawn、
//      running、nonzero、旧 revision job 都不算。后台仍运行时提示“该等未等”。
//   ② 高置信提交：无编辑、无可复算执行证据、终稿像审查结论时，只有
//      subagent/end=completed 且有 closing message 才算 fresh。工具启动和失败
//      child 不记账；不再按 subagent_cross 工具名推断实际 provider，也不因
//      同 provider 机械追加观察者。观察面扩展仍由 claim 风险和信息缺口决定。
//
// 退役条件：
//   ① 实现结算：trace 数据显示采纳本提醒后未验证交付率趋零 → 通道已内化。
//   ② 高置信提交：后续真实审查任务里独立观察者召回率趋近 4/4 fresh 覆盖，
//      且误报（非结论姿态被提醒）> 真报 → 收紧启发式或删除本路。
'use strict'
const { randomUUID } = require('node:crypto')
const disciplineInternals = require('./kix-discipline.js').__internals

const DIRECT_EXECUTION_TOOLS = new Set(['probe', 'run_code'])
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'killed'])
const FAILED_JOB_STATUSES = new Set(['failed', 'killed'])

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
  return 'kix-settle: 本会话有 ' + n + ' 处源码/测试编辑，最后一次编辑后没有成功终态的验证命令。' +
    '后台启动、仍运行 job、失败 child 和工具 spawn 都不算执行证据；交付时只按可重放的 terminal 结果计价。' +
    '若环境限制确实无法执行，请在交付说明中显式声明未验证点及其影响。'
}

function pendingVerificationText(n) {
  return 'kix-settle: 本会话有 ' + n + ' 处源码/测试编辑，相关后台验证仍未终态。' +
    '该等未等：先收集 job_output 的 completed/failed 结果再交付；等待期间可做不修改被验证 artifact 的独立工作。'
}

function commitBlindText() {
  return 'kix-settle: 本回合终稿像审查结论（LGTM / APPROVE / request-changes / 可以合并），' +
    '但本会话未派过任何成功的 fresh 观察者。拉取式记忆对高置信提交时刻失明——自信时不会去查库。' +
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

function resultValue(result) {
  let value = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result
  if (value && value.ok === true && Object.prototype.hasOwnProperty.call(value, 'result')) value = value.result
  return value
}

function foregroundExecutionSucceeded(result) {
  if (!result || result.isError === true) return false
  const value = resultValue(result)
  if (!value || value.kind !== 'foreground') return false
  return value.exitCode === 0 && value.timedOut !== true && value.aborted !== true && value.sandbox?.denied !== true
}

function backgroundJobId(result) {
  if (!result || result.isError === true) return undefined
  const value = resultValue(result)
  return value && value.kind === 'background' && typeof value.jobId === 'string' ? value.jobId : undefined
}

function terminalJobOutcome(result) {
  if (!result || result.isError === true) return undefined
  const value = resultValue(result)
  const job = value && value.job
  if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) return undefined
  const detail = String(job.detail || '')
  const failed = FAILED_JOB_STATUSES.has(job.status) || /exit code:\s*[1-9]\d*/i.test(detail)
  return { id: String(job.id || ''), success: !failed && job.status === 'completed' }
}

function directExecutionSucceeded(tool, result) {
  if (!DIRECT_EXECUTION_TOOLS.has(tool) || !result || result.isError === true) return false
  const value = resultValue(result)
  if (value && typeof value.exitCode === 'number') return value.exitCode === 0
  return true
}

function assistantMessageText(message) {
  const content = Array.isArray(message) ? message : message && message.content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

function subagentCompleted(info) {
  return Boolean(info && info.stopReason === 'completed' && assistantMessageText(info.lastAssistantMessage).trim())
}

function lifecycleRunKey(info) {
  return info && (info.runId || info.id) ? String(info.runId || info.id) : undefined
}

function lifecycleParentAgent(ctx, info) {
  const agents = ctx.get && ctx.get('agents')
  if (!agents || typeof agents.get !== 'function' || !info || !info.id) return undefined
  const child = agents.get(String(info.id))
  const parentId = child && child.session && child.session.header && child.session.header.parentSession
  return parentId ? agents.get(parentId) : undefined
}

module.exports = {
  name: 'kix-settle',
  inject: ['tools'],
  apply(ctx) {
    const states = new Map()
    const lifecycleParents = new Map()

    function stateFor(agent) {
      const sid = agent && agent.session && agent.session.id
      if (!sid) return undefined
      if (!states.has(sid)) {
        states.set(sid, {
          edits: 0,
          editGeneration: 0,
          executedSinceLastEdit: false,
          execs: 0,
          reminded: false,
          freshObserverSeen: false,
          commitBlindReminded: false,
          pendingVerificationJobs: new Map(),
        })
      }
      return states.get(sid)
    }

    function recordExecution(st) {
      st.execs += 1
      st.executedSinceLastEdit = true
    }

    // child 启动不是证据；只有 subagent/end=completed 且存在 closing message 才记 fresh。
    // 生命周期事件只传 info，因此 start 时从 child lineage 捕获 parent，end 时按 runId 取回。
    // provider/model 不能从工具名推断，因此 settle 不再把 subagent_cross spawn 当跨厂商成功。
    ctx.on('subagent/start', (info) => {
      try {
        const key = lifecycleRunKey(info)
        const parent = lifecycleParentAgent(ctx, info)
        if (key && parent) lifecycleParents.set(key, parent)
      } catch (_) { /* observation must never break execution */ }
    })
    ctx.on('subagent/end', (info) => {
      try {
        const key = lifecycleRunKey(info)
        const parent = key && lifecycleParents.get(key)
        if (key) lifecycleParents.delete(key)
        if (!subagentCompleted(info)) return
        const st = stateFor(parent || lifecycleParentAgent(ctx, info))
        if (st) st.freshObserverSeen = true
      } catch (_) { /* observation must never break execution */ }
    })

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
            const kind = disciplineInternals.classifyMutationPath(fp)
            if (result && result.isError !== true && fp && (kind === 'source' || kind === 'test')) {
              st.edits += 1
              st.editGeneration += 1
              st.executedSinceLastEdit = false
            }
          } else if (directExecutionSucceeded(name, result)) {
            recordExecution(st)
          } else if (name === 'bash' || name === 'pwsh' || name === 'shell') {
            const cmd = String(args.command || args.cmd || '')
            if (disciplineInternals.isVerificationCommand(cmd)) {
              const jobId = backgroundJobId(result)
              if (jobId) st.pendingVerificationJobs.set(jobId, st.editGeneration)
              else if (foregroundExecutionSucceeded(result)) recordExecution(st)
            }
          } else if (name === 'job_output') {
            const outcome = terminalJobOutcome(result)
            if (outcome && st.pendingVerificationJobs.has(outcome.id)) {
              const generation = st.pendingVerificationJobs.get(outcome.id)
              st.pendingVerificationJobs.delete(outcome.id)
              if (outcome.success && generation === st.editGeneration) recordExecution(st)
            }
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
        // ① 实现结算：后台验证尚在运行时明确“该等未等”；无 pending 且无成功
        // terminal 验证时按零结算。两者共用一次提醒槽，避免回合收尾反复 steer。
        if (st.edits > 0 && !st.executedSinceLastEdit && !st.reminded) {
          st.reminded = true
          const currentJobPending = [...st.pendingVerificationJobs.values()].some((generation) => generation === st.editGeneration)
          const notice = currentJobPending ? pendingVerificationText(st.edits) : settleText(st.edits)
          agent.steer(makeUserMessage(notice))
        }
        // ② 高置信提交：没有编辑、没有成功 fresh observer，也没有可复算物证时才提醒。
        // 同 provider/cross 工具名不再作为机械门槛；模型可按风险自由扩展观察面。
        if (st.edits === 0 && !st.freshObserverSeen && st.execs === 0 && !st.commitBlindReminded) {
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
  resultValue,
  foregroundExecutionSucceeded,
  backgroundJobId,
  terminalJobOutcome,
  directExecutionSucceeded,
  assistantMessageText,
  subagentCompleted,
  settleText,
  pendingVerificationText,
  commitBlindText,
  VERDICT_RES,
  DIRECT_EXECUTION_TOOLS,
  TERMINAL_JOB_STATUSES,
}
