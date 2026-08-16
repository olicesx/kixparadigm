// kix-orchestration 回归测试（2026-08-16；v8 v1.2.10 负向语义回归）
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
ok('fail-open 回归：marker 误建为目录 → 拒绝（审查修复，statSync.isFile）', (() => {
  const root = makeWorkspace({ withMarker: false })
  // 把 marker 建为目录（旧 existsSync 对目录返回 true → fail-open 通过）
  fs.mkdirSync(path.join(root, 'docs', '.kixpower-current-sprint'), { recursive: true })
  const r = I.checkHandoff({ prompt: 'current_sprint: 1', workspaceRoot: root })
  return r.ok === false && r.reasons.some((x) => x.includes('marker'))
})())
ok('fail-open 回归：progress.md 误建为目录 → 拒绝（审查修复）', (() => {
  const root = makeWorkspace({ withPlan: false })
  // 把 progress.md 建为目录（旧 existsSync 通过 → blocker/QA 校验跳过）
  fs.rmSync(path.join(root, 'docs', 'sprint-1', 'progress.md'))
  fs.mkdirSync(path.join(root, 'docs', 'sprint-1', 'progress.md'), { recursive: true })
  const r = I.checkHandoff({ prompt: 'current_sprint: 1', workspaceRoot: root })
  return r.ok === false && r.reasons.some((x) => x.includes('progress.md'))
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
ok('状态机泄漏回归：post-execute 不同 callId 不消费（审查修复，callId 绑定）', (async () => {
  // pre 用 callId c1 触发 pendingRemind → 无关工具(c2)的 post-execute 不得错位注入
  await dispatchPre('subagent', { prompt: 'current_sprint: 6' }, 'orch-c1')
  const other = { name: 'edit', arguments: { file_path: 'x.ts' }, token: 't', callId: 'c2', agent: { id: 'orch-c1', session: { header: sessionHeader } } }
  const d = await postExecute[0](other, { isError: false }, () => Promise.resolve({ kind: 'accept' }))
  return d.kind === 'accept' && (d.additionalContexts === undefined || d.additionalContexts.length === 0)
})())
ok('状态机泄漏回归：发起调用的 post-execute 仍注入且注入具体 reasons（审查修复）', (async () => {
  const exec = { name: 'subagent', arguments: { prompt: 'x' }, token: 't', callId: 'c1', agent: { id: 'orch-c1', session: { header: sessionHeader } } }
  const d = await postExecute[0](exec, { isError: false }, () => Promise.resolve({ kind: 'accept' }))
  return d.kind === 'accept' && Array.isArray(d.additionalContexts) && d.additionalContexts.length === 1
    && d.additionalContexts[0].content.some((c) => c.text.includes('marker')) // 具体 reasons 而非通用文案
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

// ── 7. v2：checkQaReturn 纯逻辑（DSH×VS Code 融合矩阵 #2）─────────────────
section('checkQaReturn（QA 返回侧一致性）')
ok('QA 完成声明 + 进度未同步 → 提醒', (() => {
  const r = I.checkQaReturn({
    text: '✅ QA 全部通过，verdict: pass',
    progressMd: '---\ncompleted_tasks: 2\ntotal_tasks: 3\n---\n',
  })
  return typeof r === 'string' && r.includes('completed=2/3')
})())
ok('QA 完成声明 + 进度已同步 → 不提醒', (() => {
  const r = I.checkQaReturn({
    text: 'QA passed, all done',
    progressMd: '---\ncompleted_tasks: 3\ntotal_tasks: 3\n---\n',
  })
  return r === undefined
})())
ok('无完成声明 → 不提醒（0% 误报）', (() => {
  const r = I.checkQaReturn({
    text: '发现 2 个问题：模块 A 边界未处理',
    progressMd: '---\ncompleted_tasks: 2\ntotal_tasks: 3\n---\n',
  })
  return r === undefined
})())

ok('负向表述 not done / undone / not passed → 不提醒（0% 误报回归）', (() => {
  const bad = [
    'QA did not complete; several tests failed and one item is not done yet.',
    'The QA run is undone; still pending.',
    'QA completed=false, not passed.',
    'No completion; passed nothing.',
    '未全部通过，仍有 2 项失败',
  ]
  return bad.every((text) => I.hasQaCompletion(text) === false &&
    I.checkQaReturn({ text, progressMd: '---\ncompleted_tasks: 2\ntotal_tasks: 3\n---\n' }) === undefined)
})())
ok('明确正向声明（QA passed / verdict:pass / 全部通过）→ 仍识别', (() => {
  const good = ['QA passed, all done', 'verdict: pass', '全部测试通过', 'QA PASS']
  return good.every((text) => I.hasQaCompletion(text) === true)
})())
ok('进度文件缺字段 → 不提醒（fail-open，提醒层非门禁层）', (() => {
  const r = I.checkQaReturn({
    text: '✅ done',
    progressMd: '---\nstatus: in-progress\n---\n',
  })
  return r === undefined
})())
ok('QA 文本空 → 不提醒', (() => {
  return I.checkQaReturn({ text: '', progressMd: '---\ncompleted_tasks: 2\ntotal_tasks: 3\n---\n' }) === undefined
})())

// ── 8. v2：subagent/end 监听器（emit 观察 + steer 注入）───────────────────
section('subagent/end 返回侧监听器')
const subagentEndListeners = listeners['subagent/end']
assert.ok(Array.isArray(subagentEndListeners) && subagentEndListeners.length === 1, 'subagent/end 监听器已注册')
ok('QA 返回完成声明 + 进度未同步 → steer 注入提醒', (() => {
  // 构造一个带 progress.md 未同步的 workspace
  const root = makeWorkspace({ completed: 2, total: 3, markerValue: 1 })
  const steered = []
  const fakeAgent = {
    id: 'orch-return-a',
    session: { header: { cwd: root } },
    steer(msg) { steered.push(msg) },
  }
  subagentEndListeners[0](
    { runId: 'r1', provider: 'kix-subagent', id: 'child-1', local: true, stopReason: 'end_turn',
      lastAssistantMessage: [{ type: 'text', text: '✅ QA 全部通过，可以交付' }] },
    fakeAgent,
  )
  return steered.length === 1 && steered[0].content.some((c) => c.text.includes('QA 子代理返回了完成声明'))
})())
ok('QA 返回完成声明 + 进度已同步 → 不注入', (() => {
  const root = makeWorkspace({ completed: 3, total: 3, markerValue: 1 })
  const steered = []
  const fakeAgent = {
    id: 'orch-return-b',
    session: { header: { cwd: root } },
    steer(msg) { steered.push(msg) },
  }
  subagentEndListeners[0](
    { runId: 'r2', provider: 'kix-subagent', id: 'child-2', local: true, stopReason: 'end_turn',
      lastAssistantMessage: [{ type: 'text', text: 'QA passed, all done' }] },
    fakeAgent,
  )
  return steered.length === 0
})())
ok('无 lastAssistantMessage → 不注入', (() => {
  const steered = []
  const fakeAgent = {
    id: 'orch-return-c',
    session: { header: { cwd: os.tmpdir() } },
    steer(msg) { steered.push(msg) },
  }
  subagentEndListeners[0]({ runId: 'r3', provider: 'kix-subagent', id: 'child-3', local: true, stopReason: 'error' }, fakeAgent)
  return steered.length === 0
})())
ok('returnReminded 每会话一次（remindOnce）', (() => {
  const root = makeWorkspace({ completed: 2, total: 3, markerValue: 1 })
  const steered = []
  const fakeAgent = {
    id: 'orch-return-d',
    session: { header: { cwd: root } },
    steer(msg) { steered.push(msg) },
  }
  const ev = {
    runId: 'r4', provider: 'kix-subagent', id: 'child-4', local: true, stopReason: 'end_turn',
    lastAssistantMessage: [{ type: 'text', text: '✅ done' }],
  }
  subagentEndListeners[0](ev, fakeAgent)
  subagentEndListeners[0](ev, fakeAgent)
  return steered.length === 1
})())

// ── 9. v3：checkCloseout 纯逻辑（QA 收尾证据链）───────────────────────────
section('checkCloseout（producer_closeout 收尾证据链）')
ok('非 closeout prompt → 通过', (() => {
  const r = I.checkCloseout({ prompt: 'current_sprint: 1', workspaceRoot: os.tmpdir() })
  return Array.isArray(r) && r.length === 0
})())
ok('closeout + spec 有 acceptance + 任务完成 + 无测试变更 → 通过', (() => {
  const r = I.checkCloseout({
    prompt: 'handoff_stage: producer_closeout',
    specMd: '# kix-discipline spec\n\n## 验收标准（可验证的完成定义）\ncargo test 全绿\n',
    progressMd: '---\ncompleted_tasks: 3\ntotal_tasks: 3\n---\n',
    testDiff: [],
  })
  return Array.isArray(r) && r.length === 0
})())
ok('closeout + 缺 acceptance → 提醒', (() => {
  const r = I.checkCloseout({
    prompt: 'handoff_stage: producer_closeout',
    specMd: '# kix-discipline spec\n\n## 验收标准（可验证的完成定义）\n（未填写）\n',
    progressMd: '---\ncompleted_tasks: 3\ntotal_tasks: 3\n---\n',
    testDiff: [],
  })
  return r.some((x) => x.includes('验收标准'))
})())
ok('closeout + 无 spec 文件 → 提醒', (() => {
  const r = I.checkCloseout({
    prompt: 'handoff_stage: producer_closeout',
    specMd: undefined,
    progressMd: '---\ncompleted_tasks: 3\ntotal_tasks: 3\n---\n',
    testDiff: [],
  })
  return r.some((x) => x.includes('验收标准'))
})())
ok('closeout + 任务未完成 → 提醒', (() => {
  const r = I.checkCloseout({
    prompt: 'handoff_stage: producer_closeout',
    specMd: '# kix-discipline spec\n\n## 验收标准（可验证的完成定义）\ncargo test 全绿\n',
    progressMd: '---\ncompleted_tasks: 2\ntotal_tasks: 3\n---\n',
    testDiff: [],
  })
  return r.some((x) => x.includes('completed=2/3'))
})())
ok('closeout + 测试文件有变更 → 提醒重验', (() => {
  const r = I.checkCloseout({
    prompt: 'handoff_stage: producer_closeout',
    specMd: '# kix-discipline spec\n\n## 验收标准（可验证的完成定义）\ncargo test 全绿\n',
    progressMd: '---\ncompleted_tasks: 3\ntotal_tasks: 3\n---\n',
    testDiff: ['src/tests/flow.rs'],
  })
  return r.some((x) => x.includes('测试文件自上次验证后有变更'))
})())
ok('progress 缺字段 → 提醒（fail-open 语义下仍提醒可读性）', (() => {
  const r = I.checkCloseout({
    prompt: 'handoff_stage: producer_closeout',
    specMd: '# kix-discipline spec\n\n## 验收标准（可验证的完成定义）\ncargo test 全绿\n',
    progressMd: undefined,
    testDiff: [],
  })
  return r.some((x) => x.includes('completed/total'))
})())
ok('baselineShaFromProgress 提取 l2_verified_sha', (() => {
  const sha = 'a'.repeat(40)
  const r = I.baselineShaFromProgress(`---\nl2_verified_sha: ${sha}\n---\n`)
  return r === sha
})())
ok('baselineShaFromProgress 无字段 → undefined', (() => {
  return I.baselineShaFromProgress('---\nstatus: in-progress\n---\n') === undefined
})())
ok('isCloseoutTestPath 测试文件命中', (() => {
  return I.isCloseoutTestPath('src/tests/flow.rs') && I.isCloseoutTestPath('a.test.ts') && !I.isCloseoutTestPath('src/main.rs')
})())

// ── 10. v4：sleep 空转等待子代理检测（WSL2 实测驱动，2026-08-17）─────────
section('v4 sleep 等待子代理检测')
ok('实测样本：sleep + subagent description → 命中', (() => {
  return I.isSleepWaitForSubagent({ command: 'sleep 45 && echo done', description: 'Wait for subagents to progress' })
})())
ok('实测样本：长 sleep + broad-scope subagent → 命中', (() => {
  return I.isSleepWaitForSubagent({ command: 'sleep 240 && echo done', description: 'Extended wait for broad-scope subagent C' })
})())
ok('测试退避 sleep（description 无 subagent）→ 不命中（0% 误报）', (() => {
  return !I.isSleepWaitForSubagent({ command: 'sleep 5', description: 'Retry backoff before re-running test' })
})())
ok('复合命令内 sleep + 子代理中文 description → 命中', (() => {
  return I.isSleepWaitForSubagent({ command: 'cd /root/dae && sleep 90; echo done', description: '等待子代理完成' })
})())
ok('非 sleep 命令（description 提及 subagent）→ 不命中', (() => {
  return !I.isSleepWaitForSubagent({ command: 'git status', description: 'Wait for subagent' })
})())
ok('pwsh 平台覆盖：Start-Sleep -Seconds + subagent description → 命中', (() => {
  return I.isSleepWaitForSubagent({ command: 'Start-Sleep -Seconds 120; Write-Host done', description: 'Wait for subagent C completion' })
})())
ok('pwsh 裸数字形态 start-sleep 60（大小写不敏感）→ 命中', (() => {
  return I.isSleepWaitForSubagent({ command: 'start-sleep 60', description: '等待子代理' })
})())
ok('pwsh 引号内文本不命中（Write-Output 提及 start-sleep）', (() => {
  return !I.isSleepWaitForSubagent({ command: "Write-Output 'start-sleep 5 then retry'", description: 'Wait for subagent' })
})())
ok('pwsh Start-Sleep 无 subagent description（重试退避）→ 不命中（0% 误报）', (() => {
  return !I.isSleepWaitForSubagent({ command: 'Start-Sleep -Seconds 3', description: 'Backoff before retry' })
})())
ok('pwsh 工具行走 pre-execute 检测（platform 对齐）', (async () => {
  await dispatchPre('pwsh', { command: 'Start-Sleep -Seconds 90', description: 'Wait for remaining subagents' }, 'orch-pwsh')
  const exec = { name: 'pwsh', arguments: { command: 'Start-Sleep -Seconds 90' }, token: 't', callId: 'c', agent: { id: 'orch-pwsh', session: { header: sessionHeader } } }
  const d = await postExecute[0](exec, { isError: false }, () => Promise.resolve({ kind: 'accept' }))
  return d.kind === 'accept' && Array.isArray(d.additionalContexts) && d.additionalContexts.length === 1
    && d.additionalContexts[0].content.some((c) => c.text.includes('sleep'))
})())
ok('v4.1 单位后缀：sleep 5m → 命中', (() => {
  return I.isSleepWaitForSubagent({ command: 'sleep 5m && echo done', description: 'Wait for subagent C' })
})())
ok('v4.1 单位后缀：sleep 30s / sleep 2h → 命中', (() => {
  return I.isSleepWaitForSubagent({ command: 'sleep 30s', description: 'wait subagent' })
    && I.isSleepWaitForSubagent({ command: 'sleep 2h', description: 'wait subagent' })
})())
ok('v4.1 小数秒 sleep 1.5 → 命中', (() => {
  return I.isSleepWaitForSubagent({ command: 'sleep 1.5', description: 'Wait for subagent' })
})())
ok('v4.1 跨形态：bash 工具载 Start-Sleep 命令 → 命中（不按工具名门控）', (async () => {
  await dispatchPre('bash', { command: 'Start-Sleep -Seconds 45', description: 'Wait for subagent B' }, 'orch-xform')
  const exec = { name: 'bash', arguments: { command: 'Start-Sleep -Seconds 45' }, token: 't', callId: 'c', agent: { id: 'orch-xform', session: { header: sessionHeader } } }
  const d = await postExecute[0](exec, { isError: false }, () => Promise.resolve({ kind: 'accept' }))
  return d.kind === 'accept' && Array.isArray(d.additionalContexts) && d.additionalContexts.length === 1
})())
ok('v4.1 任意终端工具（非 bash/pwsh 名）同走检测 → 命中', (async () => {
  await dispatchPre('zsh', { command: 'sleep 20', description: 'Wait for subagents' }, 'orch-zsh')
  const exec = { name: 'zsh', arguments: { command: 'sleep 20' }, token: 't', callId: 'c', agent: { id: 'orch-zsh', session: { header: sessionHeader } } }
  const d = await postExecute[0](exec, { isError: false }, () => Promise.resolve({ kind: 'accept' }))
  return d.kind === 'accept' && Array.isArray(d.additionalContexts) && d.additionalContexts.length === 1
})())
ok('v4.1 无 command 参数的工具 → 零开销短路不注入', (async () => {
  await dispatchPre('edit', { file_path: 'a.ts', content: 'x' }, 'orch-noCmd')
  const exec = { name: 'edit', arguments: { file_path: 'a.ts' }, token: 't', callId: 'c', agent: { id: 'orch-noCmd', session: { header: sessionHeader } } }
  const d = await postExecute[0](exec, { isError: false }, () => Promise.resolve({ kind: 'accept' }))
  return d.kind === 'accept' && (d.additionalContexts === undefined || d.additionalContexts.length === 0)
})())
ok('SUBAGENT_TOOLS 覆盖全部工具行（含 reviewer，2026-08-17 补；含编曲成员 qa/dev）', (() => {
  return I.SUBAGENT_TOOLS.has('subagent_reviewer') && I.SUBAGENT_TOOLS.has('subagent_cross') && I.SUBAGENT_TOOLS.has('subagent_lite') && I.SUBAGENT_TOOLS.has('subagent_qa') && I.SUBAGENT_TOOLS.has('subagent_dev')
})())
ok('pre→post 一次性注入提醒，第二次同模式不再注入', (async () => {
  await dispatchPre('bash', { command: 'sleep 60 && echo done', description: 'Wait for subagent C' }, 'orch-sleep')
  const exec = { name: 'bash', arguments: { command: 'sleep 60' }, token: 't', callId: 'c', agent: { id: 'orch-sleep', session: { header: sessionHeader } } }
  const d = await postExecute[0](exec, { isError: false }, () => Promise.resolve({ kind: 'accept' }))
  const injected = d.kind === 'accept' && Array.isArray(d.additionalContexts) && d.additionalContexts.length === 1
    && d.additionalContexts[0].content.some((c) => c.text.includes('sleep'))
  // 同会话第二次同模式调用 → sleepReminded 已置位，不再注入
  await dispatchPre('bash', { command: 'sleep 60', description: 'wait subagent again' }, 'orch-sleep')
  const d2 = await postExecute[0](exec, { isError: false }, () => Promise.resolve({ kind: 'accept' }))
  return injected && (d2.additionalContexts === undefined || d2.additionalContexts.length === 0)
})())
ok('sleep 提醒不烧 handoff remind 槽位（独立标志）', (async () => {
  // 先触发 sleep 提醒（burn 掉一次性），再触发 handoff remind → 仍应注入
  await dispatchPre('bash', { command: 'sleep 30', description: 'Wait for subagent B' }, 'orch-slot')
  const execBash = { name: 'bash', arguments: { command: 'sleep 30' }, token: 't', callId: 'c', agent: { id: 'orch-slot', session: { header: sessionHeader } } }
  await postExecute[0](execBash, { isError: false }, () => Promise.resolve({ kind: 'accept' }))
  await dispatchPre('subagent', { prompt: 'current_sprint: 8' }, 'orch-slot')
  const execSub = { name: 'subagent', arguments: { prompt: 'x' }, token: 't', callId: 'c', agent: { id: 'orch-slot', session: { header: sessionHeader } } }
  const d = await postExecute[0](execSub, { isError: false }, () => Promise.resolve({ kind: 'accept' }))
  return d.kind === 'accept' && Array.isArray(d.additionalContexts) && d.additionalContexts.length === 1
    && d.additionalContexts[0].content.some((c) => c.text.includes('marker')) // handoff reasons 而非 sleep 文案
})())

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────')
console.log(`kix-orchestration: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
