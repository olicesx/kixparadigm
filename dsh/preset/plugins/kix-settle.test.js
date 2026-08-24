// kix-settle 回归测试（terminal lifecycle + revision freshness，2026-08-24）
//
// 覆盖：
//   - 源码/测试编辑跨 worktree 记账；文档/运行产物不触发实现结算
//   - bash/Go foreground 只按 exitCode=0 的 terminal 结果记账
//   - background job 启动/运行不算证据；同 edit generation 的 completed 才清账
//   - subagent spawn 不算 fresh；subagent/end=completed 且有 closing message 才算
//   - 不以工具名推断 provider 独立性，不因已有成功 fresh observer 机械追加观察
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

function mkAgent(id) {
  return {
    id,
    session: { id: 'session-' + id, header: { cwd: sessionRoot } },
    steer(msg) { steered.push(msg) },
  }
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
await ok('probe exit0 清账，exit1 不清账', async () => {
  const green = mkAgent('probe-green')
  steered.length = 0
  await sourceEdit(green)
  await post(green, 'probe', { code: 'print(1)' }, { exitCode: 0 })
  await stop(green)
  if (steered.length !== 0) return false
  const red = mkAgent('probe-red')
  await sourceEdit(red)
  await post(red, 'probe', { code: 'raise Exception()' }, { exitCode: 1 })
  await stop(red)
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

section('observer terminal accounting and stopping pressure')
await ok('subagent spawn 成功但未 end → 不算 fresh', async () => {
  const agent = mkAgent('spawn-only')
  steered.length = 0
  await post(agent, 'subagent_cross', { prompt: 'review' }, { kind: 'continuable', subagentId: 'child-spawn' })
  await stop(agent, 'APPROVE')
  return steered.length === 1 && steered[0].content[0].text.includes('未派过任何成功')
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
