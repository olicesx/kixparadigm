// kix-settle — 结算信号（v5 settlement authority + blind calibration，2026-09-01）
//
// 出生证明：
//   EXP1/2/3 的共同结构——报告可以正确而实现错位；每次我们让裁决变真
//   （battery/盲审计/verify 脚本），缺陷几分钟内被抓；三轮在 prompt 里给
//   反证「定价」零效果。结论：激励活在结算层，不活在劝说层。
//   本插件只在交付时（agent/turn-stopping）单发 advisory；不阻断、不替模型
//   判断风险，也不规定验证方式。
//
// 三条触发（互斥，各自每会话单发）：
//   ① 实现结算：源码/测试编辑跨 worktree 记账；只有当前 edit generation 的
//      foreground exitCode=0 或 background job terminal success 才清账。spawn、
//      running、nonzero、旧 revision job 都不算。后台仍运行时提示“该等未等”。
//   ② 高置信提交：仅根 settlement authority 生效。无编辑、无可复算执行证据、
//      终稿前部存在独立 verdict 行时，只有 subagent/end=completed 且有 closing
//      message 才算 fresh。evidence child 不递归结算自己的报告；元引用不算 verdict。
//   ③ 低风险盲抽样：根会话当前 revision 有终态执行证据、改动面小且无 fresh
//      observer 时稳定低频抽样；有效反例强更新风险分类，零 finding 只算弱证据。
//
// 退役条件：
//   ① 实现结算：trace 数据显示采纳本提醒后未验证交付率趋零 → 通道已内化。
//   ② 高置信提交：真实审查里 fresh 召回稳定且误报 > 真报 → 收紧或删除本路。
//   ③ 盲抽样：两轮匹配样本没有改变风险分类，或打断成本超过独有反例收益 → 删除。
'use strict'
const { createHash, randomUUID } = require('node:crypto')
const disciplineInternals = require('./kix-discipline.js').__internals

const DIRECT_EXECUTION_TOOLS = new Set(['probe', 'run_code'])
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'killed'])
const FAILED_JOB_STATUSES = new Set(['failed', 'killed'])
const CALIBRATION_SAMPLE_DENOMINATOR = 16
const MAX_VERDICT_SCAN_LINES = 12

// 只接受终稿前部的独立结论行。全文关键词匹配会把规范讨论、正则引用和 evidence
// child 的原始报告误判为裁决；本缺陷已在 2026-09-01 两次 fresh 观察中实弹触发。
const VERDICT_RES = [
  /^(?:(?:✅|🔴|🟡)\s*)?(?:LGTM|APPROVE(?:D)?|REQUEST[- ]CHANGES|CHANGES[- ]REQUESTED)(?:\s*(?:[-—:：|·]\s*).*)?$/i,
  /^(?:(?:✅|🔴|🟡)\s*)?(?:可以合并|建议合并|不建议合并|请求修改)(?:\s*(?:[-—:：|·]\s*).*)?$/,
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
    '若环境限制确实无法执行，只在存在实质残余不确定性时用一句「本判断在 X 成立时失效；未验证 Y」说明，不补事前模板或完整清单。'
}

function pendingVerificationText(n) {
  return 'kix-settle: 本会话有 ' + n + ' 处源码/测试编辑，相关后台验证仍未终态。' +
    '该等未等：先收集 job_output 的 completed/failed 结果再交付；等待期间可做不修改被验证 artifact 的独立工作。'
}

function commitBlindText() {
  return 'kix-settle: 根会话终稿包含独立审查结论行，但本会话没有成功的 fresh 观察者。' +
    '拉取式记忆对高置信提交时刻失明；fresh 评审人（无先验结论）覆盖缺陷空间，原审者复审自己最差。' +
    '消费对抗 finding 时复核严重度（对抗侧易过升，承诺侧易偏松）；APPROVE 不是票，失败 child 是零证据。'
}

function calibrationText(n) {
  return 'kix-settle: 本会话当前 revision 已有成功终态执行证据，仅触及 ' + n + ' 个源码/测试文件且没有 fresh 观察者，命中低频盲抽样。' +
    '把它只当风险分类校准：让无先验观察者寻找一个能翻转完成判断的可达反例；找到反例就重估“低风险”分类，' +
    '未找到仅是弱证据，不自动降低后续验证强度；finding 数量不计价。'
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
  const lines = String(text || '').split(/\r?\n/)
  let fenced = false
  let visible = 0
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    let line = raw.trim()
    if (!line) continue
    visible += 1
    if (visible > MAX_VERDICT_SCAN_LINES) return false
    line = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s*/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/\*\*/g, '')
      .trim()
    line = line.replace(/^(?:review|verdict|decision|结论|审查结论)\s*[:：]\s*/i, '')
    if (VERDICT_RES.some((re) => re.test(line))) return true
  }
  return false
}

function settlementAuthority(agent) {
  // DSH stamps live and persisted child lineage independently. Unknown/legacy agents stay root
  // authority so a missing optional header cannot silently disable settlement for main sessions.
  const depth = Number(agent && agent.options && agent.options.subagentDepth)
  if (Number.isFinite(depth) && depth >= 1) return false
  const header = agent && agent.session && agent.session.header
  if (!header) return true
  if (header.parentSession || header.origin === 'subagent') return false
  const delegationDepth = Number(header.delegationDepth)
  return !(Number.isFinite(delegationDepth) && delegationDepth >= 1)
}

function stableCalibrationSample(sessionId, denominator = CALIBRATION_SAMPLE_DENOMINATOR) {
  const d = Number(denominator)
  if (!sessionId || !Number.isInteger(d) || d < 1) return false
  const bucket = createHash('sha256').update(String(sessionId)).digest().readUInt32BE(0)
  return bucket % d === 0
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
  if (value && typeof value === 'object') {
    if (value.error || value.ok === false || value.success === false) return false
    if (value.timedOut === true || value.timed_out === true || value.aborted === true) return false
    const exitCode = typeof value.exitCode === 'number' ? value.exitCode : value.exit_code
    if (typeof exitCode === 'number' || exitCode === null) return exitCode === 0
  }
  // run_code may legitimately return structured data without an exit code. probe always owns
  // exit_code; an unknown probe shape must not clear the verification account.
  return tool === 'run_code'
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
          calibrationReminded: false,
          mutationPaths: new Set(),
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
              st.mutationPaths.add(fp)
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

    // ── 交付结算：实现证据对所有 agent 生效；终局独立性只在根 authority 结算。
    // v5 运行态反例：evidence child 因引用 verdict 词表被再次 steer，父线程只能看到
    // 增量自检而丢失原始报告。root-only + 独立结论行同时修复递归和元引用误报。
    ctx.on('agent/turn-stopping', async (payload) => {
      try {
        const agent = payload && payload.agent
        if (!agent) return
        const st = stateFor(agent)
        if (!st) return
        const authority = settlementAuthority(agent)
        const sessionId = agent && agent.session && agent.session.id
        // ① 实现结算：后台验证尚在运行时明确“该等未等”；无 pending 且无成功
        // terminal 验证时按零结算。它覆盖 child，因为 evidence producer 也可能改源码。
        if (st.edits > 0 && !st.executedSinceLastEdit && !st.reminded) {
          st.reminded = true
          const currentJobPending = [...st.pendingVerificationJobs.values()].some((generation) => generation === st.editGeneration)
          const notice = currentJobPending ? pendingVerificationText(st.edits) : settleText(st.edits)
          agent.steer(makeUserMessage(notice))
        }
        // ③ 小改动面盲抽样：稳定散列使样本可重放，不把随机波动当行为证据。
        // 已被实现结算提醒过的会话不连续加压；零 finding 不会自动调整路由。
        if (authority && st.edits > 0 && st.executedSinceLastEdit && !st.reminded &&
            !st.freshObserverSeen && !st.calibrationReminded && st.mutationPaths.size > 0 &&
            st.mutationPaths.size <= 2 && stableCalibrationSample(sessionId)) {
          st.calibrationReminded = true
          agent.steer(makeUserMessage(calibrationText(st.mutationPaths.size)))
        }
        // ② 高置信提交：仅根 authority；没有编辑、fresh observer 或可复算物证时提醒。
        if (authority && st.edits === 0 && !st.freshObserverSeen && st.execs === 0 && !st.commitBlindReminded) {
          const sessionQuery = ctx.get && ctx.get('sessionQuery')
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
  settlementAuthority,
  stableCalibrationSample,
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
  calibrationText,
  VERDICT_RES,
  DIRECT_EXECUTION_TOOLS,
  TERMINAL_JOB_STATUSES,
  CALIBRATION_SAMPLE_DENOMINATOR,
}
