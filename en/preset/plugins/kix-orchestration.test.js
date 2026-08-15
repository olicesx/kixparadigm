// kix-orchestration 回归测试（2026-08-16）
//
// 单元级验证：加载 kix-orchestration.js，mock DSH pre-execute / post-execute 派发，
// 覆盖：
//   - 纯逻辑（__internals）：extractHandoffMeta / parseProgressState / checkHandoff
//   - pre-execute 交接门禁：remind（放行+待注入）/ block（deny）/
//     无交接元数据放行 / 非 subagent 工具放行
//   - post-execute：remind 注入
// 运行：node plugins/kix-orchestration.test.js

const path = require('node:path')
const assert = require('node:assert')
const os = require('node:os')
const fs = require('node:fs')

// ── mock ctx ───────────────────────────────────────────────────────────────
const listeners = {}
let userQuestionsMock = null
const configMock = { intensity: 'remind' }
const ctx = {
  config: configMock,
  logger: { info() {}, warn() {}, error() {} },
  get(name) {
    if (name === 'userQuestions') return userQuestionsMock
    if (name === 'sandboxPolicy') return { workspaceRoot: os.tmpdir() }
    return undefined
  },
  on(event, cb) {
    ;(listeners[event] ||= []).push(cb)
  },
  effect() {},
}
const registeredTools = []
const registeredCommands = []
ctx.tools = { register(def) { registeredTools.push(def); return () => {} } }
ctx.commands = { register(def) { registeredCommands.push(def); return () => {} } }

// ── 加载被测试插件 ────────────────────────────────────────────────────────
const plugin = require(path.join(__dirname, 'kix-orchestration.js'))
assert.strictEqual(plugin.name, 'kix-orchestration')
plugin.apply(ctx, configMock)
const preExecute = listeners['tools/pre-execute']
const postExecute = listeners['tools/post-execute']
assert.ok(Array.isArray(preExecute) && preExecute.length === 1, 'pre-execute 监听器已注册')
assert.ok(Array.isArray(postExecute) && postExecute.length === 1, 'post-execute 监听器已注册')
assert.ok(registeredCommands.some((c) => c.name === 'kix-orchestration'), '/kix-orchestration 命令已注册')

const I = plugin.__internals

// ── 夹具：构造一个最小可交接的 sprint 工作区 ──────────────────────────────
function makeWorkspace({ blocked = false, completed, total, withMarker = true, markerValue = 1, withPlan = true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-orch-test-'))
  const docs = path.join(root, 'docs')
  const sprintDir = path.join(docs, 'sprint-1')
  fs.mkdirSync(sprintDir, { recursive: true })
  if (withMarker) fs.writeFileSync(path.join(docs, '.kixpower-current-sprint'), String(markerValue), 'utf8')
  if (withPlan) {
    fs.writeFileSync(path.join(sprintDir, 'plan.md'), '---\ntask_dag:\n  - id: t1\nverifiable_gates: []\n---\n', 'utf8')
  }
  const fm = [
    '---',
    'status: ' + (blocked ? 'blocked' : 'in-progress'),
    'blocked_tasks: ' + (blocked ? 1 : 0),
  ]
  if (completed !== undefined) fm.push('completed_tasks: ' + completed)
  if (total !== undefined) fm.push('total_tasks: ' + total)
  fm.push('---', '', '# progress')
  fs.writeFileSync(path.join(sprintDir, 'progress.md'), fm.join('\n'), 'utf8')
  return root
}

let passed = 0
let failed = 0
function ok(label, cond) {
  if (cond) { passed++ } else { failed++ }
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
}
function section(title) { console.log('\n── ' + title + ' ──') }

// ── 1. 纯逻辑：extractHandoffMeta ─────────────────────────────────────────
section('extractHandoffMeta')
ok('提取 current_sprint', (() => {
  const m = I.extractHandoffMeta('[CONTEXT]\ncurrent_sprint: 3\n[TASK]')
  return m.sprint === 3
})())
ok('提取 handoff_mode review', (() => {
  const m = I.extractHandoffMeta('handoff_mode: review\nreview_readonly: true')
  return m.mode === 'review'
})())
ok('提取 handoff_stage 兜底', (() => {
  const m = I.extractHandoffMeta('handoff_stage: producer_closeout')
  return m.mode === 'producer_closeout'
})())
ok('提取 partition_id', (() => {
  const m = I.extractHandoffMeta('partition_id: p1')
  return m.partition === 'p1'
})())
ok('无元数据 → sprint=0', (() => {
  const m = I.extractHandoffMeta('普通观察任务，无交接字段')
  return m.sprint === 0 && m.mode === null
})())

// ── 2. 纯逻辑：parseProgressState ─────────────────────────────────────────
section('parseProgressState')
ok('正常状态非 blocked', (() => {
  const s = I.parseProgressState('---\nstatus: in-progress\nblocked_tasks: 0\ncompleted_tasks: 5\ntotal_tasks: 5\n---\n')
  return s.blocked === false && s.completed === 5 && s.total === 5
})())
ok('status blocked → blocked', (() => {
  return I.parseProgressState('---\nstatus: blocked\n---\n').blocked === true
})())
ok('blocked_tasks>0 → blocked', (() => {
  return I.parseProgressState('---\nblocked_tasks: 2\n---\n').blocked === true
})())
ok('❌ Blocked 条目 → blocked', (() => {
  return I.parseProgressState('---\n---\n\n- ❌ Blocked: 依赖缺失').blocked === true
})())

// ── 3. 纯逻辑：checkHandoff ───────────────────────────────────────────────
section('checkHandoff')
ok('无交接元数据 → ok', (() => {
  return I.checkHandoff({ prompt: '观察任务', workspaceRoot: os.tmpdir() }).ok === true
})())
ok('正常交接（marker+plan+progress）→ ok', (() => {
  const root = makeWorkspace({ completed: 3, total: 3 })
  return I.checkHandoff({ prompt: '[CONTEXT]\ncurrent_sprint: 1', workspaceRoot: root }).ok === true
})())
ok('marker 缺失 → 拒绝', (() => {
  const root = makeWorkspace({ withMarker: false })
  const r = I.checkHandoff({ prompt: 'current_sprint: 1', workspaceRoot: root })
  return r.ok === false && r.reasons.some((x) => x.includes('marker'))
})())
ok('marker 不一致 → 拒绝', (() => {
  const root = makeWorkspace({ markerValue: 2 })
  const r = I.checkHandoff({ prompt: 'current_sprint: 1', workspaceRoot: root })
  return r.ok === false && r.reasons.some((x) => x.includes('不一致'))
})())
ok('plan/progress 缺失 → 拒绝', (() => {
  const root = makeWorkspace({ withPlan: false })
  fs.rmSync(path.join(root, 'docs', 'sprint-1', 'progress.md'))
  const r = I.checkHandoff({ prompt: 'current_sprint: 1', workspaceRoot: root })
  return r.ok === false && r.reasons.some((x) => x.includes('plan.md'))
})())
ok('blocked → 拒绝', (() => {
  const root = makeWorkspace({ blocked: true })
  const r = I.checkHandoff({ prompt: 'current_sprint: 1', workspaceRoot: root })
  return r.ok === false && r.reasons.some((x) => x.includes('阻塞'))
})())
ok('切 QA 未完成 → 拒绝', (() => {
  const root = makeWorkspace({ completed: 2, total: 3 })
  const r = I.checkHandoff({ prompt: 'handoff_mode: qa\ncurrent_sprint: 1', workspaceRoot: root })
  return r.ok === false && r.reasons.some((x) => x.includes('不能交接 QA'))
})())
ok('切 QA 已完成 → ok', (() => {
  const root = makeWorkspace({ completed: 3, total: 3 })
  return I.checkHandoff({ prompt: 'handoff_mode: qa\ncurrent_sprint: 1', workspaceRoot: root }).ok === true
})())

// ── 4. pre-execute 门禁 ───────────────────────────────────────────────────
section('pre-execute 交接门禁')
const sessionHeader = { cwd: os.tmpdir() }
function dispatchPre(name, args, agentId) {
  const exec = { name, arguments: args, token: 't', callId: 'c', agent: { id: agentId || 'orch-t', session: { header: sessionHeader } } }
  return preExecute[0](exec, () => Promise.resolve({ kind: 'allow' }))
}
ok('非 subagent 工具 → 放行', (async () => {
  const d = await dispatchPre('edit', { file_path: 'x.ts' })
  return d.kind === 'allow'
})())
ok('subagent 无交接元数据 → 放行', (async () => {
  const d = await dispatchPre('subagent', { prompt: '观察任务' })
  return d.kind === 'allow'
})())
ok('remind：交接未满足 → allow（待注入）', (async () => {
  const root = makeWorkspace({ withMarker: false })
  const d = await dispatchPre('subagent', { prompt: 'current_sprint: 1' }, 'orch-a')
  // workspaceRoot 来自 sandboxPolicy（os.tmpdir），marker 缺失 → 不 ok → remind 放行
  return d.kind === 'allow'
})())
ok('block：交接未满足 → deny', (async () => {
  const prev = configMock.intensity
  configMock.intensity = 'block'
  const d = await dispatchPre('subagent', { prompt: 'current_sprint: 99' }, 'orch-b')
  configMock.intensity = prev
  return d.kind === 'deny'
})())

// ── 5. post-execute：remind 注入 ──────────────────────────────────────────
section('post-execute')
ok('pendingRemind → additionalContexts 注入', (async () => {
  await dispatchPre('subagent', { prompt: 'current_sprint: 5' }, 'orch-c')
  const exec = { name: 'subagent', arguments: { prompt: 'x' }, token: 't', callId: 'c', agent: { id: 'orch-c', session: { header: sessionHeader } } }
  const d = await postExecute[0](exec, { isError: false }, () => Promise.resolve({ kind: 'accept' }))
  return d.kind === 'accept' && Array.isArray(d.additionalContexts) && d.additionalContexts.length === 1
})())
ok('无 pendingRemind → accept 无注入', (async () => {
  const exec = { name: 'subagent', arguments: { prompt: 'x' }, token: 't', callId: 'c', agent: { id: 'orch-d', session: { header: sessionHeader } } }
  const d = await postExecute[0](exec, { isError: false }, () => Promise.resolve({ kind: 'accept' }))
  return d.kind === 'accept' && (d.additionalContexts === undefined || d.additionalContexts.length === 0)
})())

// ── 6. 命令 ───────────────────────────────────────────────────────────────
section('/kix-orchestration 命令')
ok('status 输出', (() => {
  const cmd = registeredCommands.find((c) => c.name === 'kix-orchestration')
  const r = cmd.handler({ agent: { id: 'orch-e', session: { header: sessionHeader } }, rawInput: 'status' })
  return r.kind === 'success' && r.text.includes('intensity: remind')
})())
ok('off 后 gate 静默', (async () => {
  const cmd = registeredCommands.find((c) => c.name === 'kix-orchestration')
  cmd.handler({ agent: { id: 'orch-f', session: { header: sessionHeader } }, rawInput: 'off' })
  const d = await dispatchPre('subagent', { prompt: 'current_sprint: 7' }, 'orch-f')
  cmd.handler({ agent: { id: 'orch-f', session: { header: sessionHeader } }, rawInput: 'on' })
  return d.kind === 'allow'
})())

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────')
console.log(`kix-orchestration: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
