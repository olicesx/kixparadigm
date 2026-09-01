// kix-settle 回归测试（settlement authority + blind calibration，2026-09-01）
//
// 覆盖：
//   - 源码/测试编辑跨 worktree 记账；文档/运行产物不触发实现结算
//   - foreground/background terminal success 与 edit generation 新鲜度
//   - subagent/end=completed + closing message 才算 fresh
//   - commit-blind 仅根 authority 生效；元引用不算独立 verdict 行
//   - 已验证小改动面稳定低频抽样；反例强更新、零 finding 弱更新文案
'use strict'

const assert = require('node:assert')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const listeners = {}
const runtimeAgents = new Map()
let sessionQueryMock = null
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get(name) {
    if (name === 'sessionQuery') return sessionQueryMock
    if (name === 'agents') return { get: (id) => runtimeAgents.get(String(id)) }
    return undefined
  },
  on(event, cb) { (listeners[event] ||= []).push(cb) },
}

const plugin = require('./kix-settle.js')
const I = plugin.__internals
plugin.apply(ctx)

assert.strictEqual(listeners['tools/post-execute'].length, 1, 'post-execute 监听器')
assert.strictEqual(listeners['agent/turn-stopping'].length, 1, 'turn-stopping 监听器')
assert.strictEqual(listeners['subagent/start'].length, 1, 'subagent/start 监听器')
assert.strictEqual(listeners['subagent/end'].length, 1, 'subagent/end 监听器')
assert.ok(I && typeof I.terminalJobOutcome === 'function', '__internals 导出终态判定')

const postExecute = listeners['tools/post-execute'][0]
const turnStopping = listeners['agent/turn-stopping'][0]
const subagentStart = listeners['subagent/start'][0]
const subagentEnd = listeners['subagent/end'][0]
const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-settle-session-'))
const steered = []

function mkAgent(id, overrides = {}) {
  return {
    id,
    options: overrides.options || {},
    session: { id: 'session-' + id, header: { cwd: sessionRoot, ...(overrides.header || {}) } },
    steer(msg) { steered.push(msg) },
  }
}

function sampledAgent(label = 'calibration') {
  for (let i = 0; i < 10_000; i++) {
    const agent = mkAgent(label + '-' + i)
    if (I.stableCalibrationSample(agent.session.id)) return agent
  }
  throw new Error('unable to find deterministic calibration sample')
}

function unsampledAgent(label = 'ordinary') {
  for (let i = 0; i < 10_000; i++) {
    const agent = mkAgent(label + '-' + i)
    if (!I.stableCalibrationSample(agent.session.id)) return agent
  }
  throw new Error('unable to find deterministic non-sample')
}

function emitSubagentEnd(parent, info) {
  const event = { runId: 'run-' + info.id, provider: 'spawn', local: true, ...info }
  const child = { id: info.id, session: { id: info.id, header: { parentSession: parent.session.id } } }
  runtimeAgents.set(parent.session.id, parent)
  runtimeAgents.set(child.id, child)
  subagentStart({ runId: event.runId, provider: event.provider, id: event.id, local: event.local })
  runtimeAgents.delete(child.id)
  subagentEnd(event)
}

function sourceEdit(agent, file = path.join(sessionRoot, 'src', 'x.js')) {
  return postExecute({ name: 'edit', arguments: { file_path: file }, callId: 'edit', agent }, { isError: false }, () => Promise.resolve({ kind: 'accept' }))
}

function post(agent, name, args, value, isError = false) {
  return postExecute(
    { name, arguments: args || {}, callId: name + '-call', agent },
    { isError, value },
    () => Promise.resolve({ kind: 'accept' }),
  )
}

function foreground(exitCode = 0, extra = {}) {
  return { kind: 'foreground', exitCode, timedOut: false, aborted: false, ...extra }
}

function background(jobId) { return { kind: 'background', jobId } }
function job(id, status, detail) { return { text: '', job: { id, status, detail } } }

function surface(text) {
  return { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }] }
}

async function stop(agent, text = 'Implementation complete') {
  sessionQueryMock = { readSurface: async () => surface(text) }
  await turnStopping({ agent, turn: 1, signal: undefined })
}

let passed = 0
let failed = 0
async function ok(label, fn) {
  try {
    const value = await fn()
    assert.ok(value)
    passed++
    console.log('PASS  ' + label)
  } catch (error) {
    failed++
    console.error('FAIL  ' + label + ': ' + error.message)
  }
}
function section(title) { console.log('\n── ' + title + ' ──') }

;(async () => {
section('pure lifecycle predicates')
await ok('foreground 仅 exitCode=0 且无 timeout/denial 成功', () =>
  I.foregroundExecutionSucceeded({ isError: false, value: foreground(0) }) &&
  !I.foregroundExecutionSucceeded({ isError: false, value: foreground(1) }) &&
  !I.foregroundExecutionSucceeded({ isError: false, value: foreground(0, { timedOut: true }) }) &&
  !I.foregroundExecutionSucceeded({ isError: false, value: foreground(0, { sandbox: { denied: true } }) }))
await ok('background 只提取 jobId，不伪装 terminal', () =>
  I.backgroundJobId({ isError: false, value: background('j1') }) === 'j1' &&
  I.foregroundExecutionSucceeded({ isError: false, value: background('j1') }) === false)
await ok('job completed exit0 成功，nonzero/failed/killed 失败，running 未终态', () => {
  const yes = I.terminalJobOutcome({ isError: false, value: job('j1', 'completed', 'exit code: 0') })
  const nonzero = I.terminalJobOutcome({ isError: false, value: job('j2', 'completed', 'exit code: 2') })
  const failedJob = I.terminalJobOutcome({ isError: false, value: job('j3', 'failed', 'boom') })
  const running = I.terminalJobOutcome({ isError: false, value: job('j4', 'running') })
  return yes.success && !nonzero.success && !failedJob.success && running === undefined
})
await ok('subagent 仅 completed + closing message 成功', () =>
  I.subagentCompleted({ stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'evidence' }] }) &&
  !I.subagentCompleted({ stopReason: 'max-tokens', lastAssistantMessage: [{ type: 'text', text: 'partial' }] }) &&
  !I.subagentCompleted({ stopReason: 'completed', lastAssistantMessage: undefined }))
await ok('settlement authority 只接受根会话', () =>
  I.settlementAuthority(mkAgent('root')) &&
  I.settlementAuthority({ options: {} }) &&
  !I.settlementAuthority(mkAgent('depth-child', { options: { subagentDepth: 1 } })) &&
  !I.settlementAuthority(mkAgent('parent-child', { header: { parentSession: 'root' } })) &&
  !I.settlementAuthority(mkAgent('origin-child', { header: { origin: 'subagent' } })) &&
  !I.settlementAuthority(mkAgent('delegated-child', { header: { delegationDepth: 2 } })))
await ok('verdict 只认前部独立结论行，不认元引用或代码块', () =>
  I.looksLikeVerdict('Review summary\n\n**✅ APPROVE — 0 blocking**') &&
  I.looksLikeVerdict('结论：可以合并：0 blocking') &&
  I.looksLikeVerdict('🔴 CHANGES REQUESTED - 2 major') &&
  !I.looksLikeVerdict('The regex /APPROVE/ is discussed here, not issued as a verdict.') &&
  !I.looksLikeVerdict('APPROVE 不是新增证据') &&
  !I.looksLikeVerdict('## COMMENT') &&
  !I.looksLikeVerdict('```text\nAPPROVE\n```'))
await ok('probe 读取真实 snake_case 结果，run_code 允许无 exit code', () =>
  I.directExecutionSucceeded('probe', { isError: false, value: { ok: true, exit_code: 0 } }) &&
  !I.directExecutionSucceeded('probe', { isError: false, value: { ok: true, exit_code: 2 } }) &&
  !I.directExecutionSucceeded('probe', { isError: false, value: { ok: true, timed_out: true, exit_code: null } }) &&
  !I.directExecutionSucceeded('probe', { isError: false, value: { ok: true } }) &&
  I.directExecutionSucceeded('run_code', { isError: false, value: { answer: 42 } }))
await ok('盲抽样按 session id 稳定且参数非法时关闭', () => {
  const sampled = sampledAgent('stable')
  return I.stableCalibrationSample(sampled.session.id) &&
    I.stableCalibrationSample(sampled.session.id) &&
    !I.stableCalibrationSample('', 16) &&
    !I.stableCalibrationSample(sampled.session.id, 0)
})

section('cross-worktree edit and foreground verification')
await ok('workspace 外源码编辑仍记账', async () => {
  const agent = mkAgent('outside-edit')
  steered.length = 0
  await sourceEdit(agent, path.join(os.tmpdir(), 'other-worktree', 'x.go'))
  await stop(agent)
  return steered.length === 1 && steered[0].content[0].text.includes('源码/测试编辑')
})
await ok('文档编辑不要求执行结算', async () => {
  const agent = mkAgent('docs-edit')
  steered.length = 0
  await sourceEdit(agent, path.join(sessionRoot, 'README.md'))
  await stop(agent)
  return steered.length === 0
})
await ok('失败的 edit/write 调用不伪装已发生 mutation', async () => {
  const agent = mkAgent('failed-edit')
  steered.length = 0
  await post(agent, 'edit', { file_path: path.join(sessionRoot, 'src', 'failed.js') }, undefined, true)
  await stop(agent)
  return steered.length === 0
})
await ok('Go test foreground exit0 清账', async () => {
  const agent = mkAgent('go-green')
  steered.length = 0
  await sourceEdit(agent)
  await post(agent, 'bash', { command: 'go test ./...' }, foreground(0))
  await stop(agent)
  return steered.length === 0
})
await ok('Go test foreground nonzero 不清账', async () => {
  const agent = mkAgent('go-red')
  steered.length = 0
  await sourceEdit(agent)
  await post(agent, 'bash', { command: 'go test ./...' }, foreground(1))
  await stop(agent)
  return steered.length === 1 && steered[0].content[0].text.includes('没有成功终态')
})
await ok('go build/vet/mod verify 属于结算验证，不冒充 red-green test', async () => {
  const agent = mkAgent('go-verify')
  steered.length = 0
  await sourceEdit(agent)
  await post(agent, 'bash', { command: 'go vet ./... && go build ./... && go mod verify' }, foreground(0))
  await stop(agent)
  return steered.length === 0
})
await ok('普通 git status 不清账', async () => {
  const agent = mkAgent('git-status')
  steered.length = 0
  await sourceEdit(agent)
  await post(agent, 'bash', { command: 'git status --short' }, foreground(0))
  await stop(agent)
  return steered.length === 1
})
await ok('probe exit_code=0 清账，非零与 timeout 不清账', async () => {
  const green = mkAgent('probe-green')
  steered.length = 0
  await sourceEdit(green)
  await post(green, 'probe', { code: 'print(1)' }, { ok: true, exit_code: 0 })
  await stop(green)
  if (steered.length !== 0) return false
  const red = mkAgent('probe-red')
  await sourceEdit(red)
  await post(red, 'probe', { code: 'raise Exception()' }, { ok: true, exit_code: 1 })
  await stop(red)
  if (steered.length !== 1) return false
  steered.length = 0
  const timeout = mkAgent('probe-timeout')
  await sourceEdit(timeout)
  await post(timeout, 'probe', { code: 'while True: pass' }, { ok: true, timed_out: true, exit_code: null })
  await stop(timeout)
  return steered.length === 1
})

section('background terminal accounting')
await ok('background start/运行中不算证据，提示该等未等', async () => {
  const agent = mkAgent('job-pending')
  steered.length = 0
  await sourceEdit(agent)
  await post(agent, 'bash', { command: 'go test ./...' }, background('job-pending'))
  await post(agent, 'job_output', { job_id: 'job-pending' }, job('job-pending', 'running'))
  await stop(agent)
  return steered.length === 1 && steered[0].content[0].text.includes('仍未终态')
})
await ok('同 revision background completed exit0 清账', async () => {
  const agent = mkAgent('job-green')
  steered.length = 0
  await sourceEdit(agent)
  await post(agent, 'bash', { command: 'go test ./...' }, background('job-green'))
  await post(agent, 'job_output', { job_id: 'job-green' }, job('job-green', 'completed', 'exit code: 0'))
  await stop(agent)
  return steered.length === 0
})
await ok('background completed nonzero 不清账', async () => {
  const agent = mkAgent('job-red')
  steered.length = 0
  await sourceEdit(agent)
  await post(agent, 'bash', { command: 'go test ./...' }, background('job-red'))
  await post(agent, 'job_output', { job_id: 'job-red' }, job('job-red', 'completed', 'exit code: 1'))
  await stop(agent)
  return steered.length === 1 && steered[0].content[0].text.includes('没有成功终态')
})
await ok('旧 revision job 成功不能清掉新编辑', async () => {
  const agent = mkAgent('job-stale')
  steered.length = 0
  await sourceEdit(agent, path.join(sessionRoot, 'src', 'a.go'))
  await post(agent, 'bash', { command: 'go test ./...' }, background('job-stale'))
  await sourceEdit(agent, path.join(sessionRoot, 'src', 'b.go'))
  await post(agent, 'job_output', { job_id: 'job-stale' }, job('job-stale', 'completed', 'exit code: 0'))
  await stop(agent)
  return steered.length === 1 && steered[0].content[0].text.includes('没有成功终态')
})

section('settlement authority and blind calibration')
await ok('evidence child 的 verdict 不递归触发 commit-blind', async () => {
  const child = mkAgent('evidence-child', { options: { subagentDepth: 1 }, header: { parentSession: 'root' } })
  steered.length = 0
  await stop(child, 'APPROVE')
  return steered.length === 0
})
await ok('evidence child 编辑后无验证仍触发实现结算', async () => {
  const child = mkAgent('editing-child', { options: { subagentDepth: 1 }, header: { parentSession: 'root' } })
  steered.length = 0
  await sourceEdit(child)
  await stop(child, 'APPROVE')
  return steered.length === 1 && steered[0].content[0].text.includes('源码/测试编辑')
})
await ok('root 元引用 verdict 词不误触发', async () => {
  const agent = mkAgent('root-meta-quote')
  steered.length = 0
  await stop(agent, 'The regex /APPROVE/ and the phrase 可以合并 are examples, not a verdict.')
  return steered.length === 0
})
await ok('命中样本的已验证小改动面触发一次盲抽样', async () => {
  const agent = sampledAgent('sampled-green')
  steered.length = 0
  await sourceEdit(agent)
  await post(agent, 'probe', { code: 'print(1)' }, { exitCode: 0 })
  await stop(agent)
  await stop(agent)
  const text = steered[0] && steered[0].content[0].text
  return steered.length === 1 && text.includes('低频盲抽样') &&
    text.includes('未找到仅是弱证据') && text.includes('finding 数量不计价')
})
await ok('未命中样本或已有 fresh observer 不追加盲抽样', async () => {
  const ordinary = unsampledAgent('unsampled-green')
  steered.length = 0
  await sourceEdit(ordinary)
  await post(ordinary, 'probe', { code: 'print(1)' }, { exitCode: 0 })
  await stop(ordinary)
  if (steered.length !== 0) return false
  const observed = sampledAgent('sampled-observed')
  await sourceEdit(observed)
  await post(observed, 'probe', { code: 'print(1)' }, { exitCode: 0 })
  emitSubagentEnd(observed, { id: 'sample-observer', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'evidence' }] })
  await stop(observed)
  return steered.length === 0
})

section('observer terminal accounting and stopping pressure')
await ok('subagent spawn 成功但未 end → 不算 fresh', async () => {
  const agent = mkAgent('spawn-only')
  steered.length = 0
  await post(agent, 'subagent_cross', { prompt: 'review' }, { kind: 'continuable', subagentId: 'child-spawn' })
  await stop(agent, 'APPROVE')
  return steered.length === 1 && steered[0].content[0].text.includes('没有成功的 fresh 观察者')
})
await ok('失败/无 closing message child 不算 fresh', async () => {
  const failedAgent = mkAgent('child-failed')
  steered.length = 0
  emitSubagentEnd(failedAgent, { id: 'c-fail', stopReason: 'error', lastAssistantMessage: [{ type: 'text', text: 'partial' }] })
  await stop(failedAgent, 'APPROVE')
  if (steered.length !== 1) return false
  const emptyAgent = mkAgent('child-empty')
  steered.length = 0
  emitSubagentEnd(emptyAgent, { id: 'c-empty', stopReason: 'completed', lastAssistantMessage: undefined })
  await stop(emptyAgent, 'APPROVE')
  return steered.length === 1
})
await ok('任意成功 fresh child 已足够结算，不因 provider 工具名补票', async () => {
  const agent = mkAgent('child-green')
  steered.length = 0
  emitSubagentEnd(agent, { id: 'c-green', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'evidence-backed review' }] })
  await stop(agent, 'APPROVE')
  return steered.length === 0
})
await ok('可复算物证已存在时不机械要求 fresh observer', async () => {
  const agent = mkAgent('physical-green')
  steered.length = 0
  await post(agent, 'bash', { command: 'go test ./...' }, foreground(0))
  await stop(agent, 'APPROVE')
  return steered.length === 0
})
await ok('非 verdict 文本不触发 commit-blind', async () => {
  const agent = mkAgent('no-verdict')
  steered.length = 0
  await stop(agent, 'Still investigating the implementation')
  return steered.length === 0
})
await ok('commit-blind 同会话只提醒一次', async () => {
  const agent = mkAgent('blind-once')
  steered.length = 0
  await stop(agent, 'APPROVE')
  await stop(agent, 'APPROVE')
  return steered.length === 1
})
await ok('readSurface 抛错静默', async () => {
  const agent = mkAgent('surface-error')
  steered.length = 0
  sessionQueryMock = { readSurface: async () => { throw new Error('boom') } }
  await turnStopping({ agent, turn: 1, signal: undefined })
  return steered.length === 0
})

console.log(`\n${passed} passed, ${failed} failed`)
fs.rmSync(sessionRoot, { recursive: true, force: true })
if (failed > 0) process.exit(1)
})().catch((error) => {
  console.error(error)
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  process.exit(1)
})
