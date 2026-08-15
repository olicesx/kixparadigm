// kix-discipline 回归测试（P0，2026-08-16）
//
// 单元级验证：加载 kix-discipline.js，mock DSH pre-execute / post-execute /
// agent/turn-stopping 派发，覆盖：
//   - 纯逻辑（__internals）：isTestCommand / isTestFile / isMutationTool /
//     specComplete / renderSpec / parseSpec / makeState
//   - pre-execute spec gate：remind（放行+待注入）/ ask（聊天提问）/
//     block（deny）/ 测试文件放行 / 有 spec 放行
//   - post-execute：red remind 注入 / 测试运行 green 记录
//   - turn-stopping：有实现 edit 无测试 → steer 提醒；有测试 → 不提醒
// 运行：node plugins/kix-discipline.test.js

const path = require('node:path')
const assert = require('node:assert')
const os = require('node:os')
const fs = require('node:fs')

// ── mock ctx ───────────────────────────────────────────────────────────────
const listeners = {}
let userQuestionsMock = null
let configMock = { intensity: 'remind' }
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
// tools / commands mock
const registeredTools = []
const registeredCommands = []
const toolsMock = {
  register(def) { registeredTools.push(def); return () => {} },
}
const commandsMock = {
  register(def) { registeredCommands.push(def); return () => {} },
}
ctx.tools = toolsMock
ctx.commands = commandsMock

// ── 加载被测试插件 ────────────────────────────────────────────────────────
const plugin = require(path.join(__dirname, 'kix-discipline.js'))
assert.strictEqual(plugin.name, 'kix-discipline')
plugin.apply(ctx, configMock)
const preExecute = listeners['tools/pre-execute']
const postExecute = listeners['tools/post-execute']
const turnStopping = listeners['agent/turn-stopping']
assert.ok(Array.isArray(preExecute) && preExecute.length === 1, 'pre-execute 监听器已注册')
assert.ok(Array.isArray(postExecute) && postExecute.length === 1, 'post-execute 监听器已注册')
assert.ok(Array.isArray(turnStopping) && turnStopping.length === 1, 'turn-stopping 监听器已注册')
assert.ok(registeredTools.some((t) => t.name === 'kix_discipline_spec'), 'kix_discipline_spec 工具已注册')
assert.ok(registeredCommands.some((c) => c.name === 'kix-discipline'), '/kix-discipline 命令已注册')

const I = plugin.__internals

// ── 模拟 DSH 派发 ─────────────────────────────────────────────────────────
let steered = []
const sessionHeader = { cwd: os.tmpdir() }
function dispatchPre(name, args) {
  const exec = { name, arguments: args, token: 't', callId: 'c', agent: { id: 'test-agent', session: { header: sessionHeader } } }
  return preExecute[0](exec, () => Promise.resolve({ kind: 'allow' }))
}
function dispatchPost(name, args, result) {
  const exec = { name, arguments: args, token: 't', callId: 'c', agent: { id: 'test-agent', session: { header: sessionHeader } } }
  return postExecute[0](exec, result || { isError: false }, () => Promise.resolve({ kind: 'accept' }))
}
function dispatchTurn() {
  steered = []
  const agent = { id: 'test-agent', session: { header: sessionHeader }, steer(msg) { steered.push(msg) } }
  return turnStopping[0]({ agent, turn: 1, signal: undefined })
}

let passed = 0
let failed = 0
function ok(label, cond) {
  if (cond) { passed++ } else { failed++ }
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
}
function section(title) { console.log('\n── ' + title + ' ──') }

// ── 1. 纯逻辑 ─────────────────────────────────────────────────────────────
section('纯逻辑 __internals')
ok('isTestCommand: pnpm test', I.isTestCommand('pnpm test'))
ok('isTestCommand: npm run test', I.isTestCommand('npm run test'))
ok('isTestCommand: pytest -q', I.isTestCommand('pytest -q'))
ok('isTestCommand: cargo test', I.isTestCommand('cargo test'))
ok('isTestCommand: node --test', I.isTestCommand('node --test'))
ok('isTestCommand 否定: git commit', !I.isTestCommand('git commit -m "test fix"'))
ok('isTestCommand 否定: echo', !I.isTestCommand('echo test'))
ok('isTestFile: src/a.test.ts', I.isTestFile('src/a.test.ts'))
ok('isTestFile: tests/foo.py', I.isTestFile('tests/foo.py'))
ok('isTestFile: __tests__/x.js', I.isTestFile('__tests__/x.js'))
ok('isTestFile 否定: src/a.ts', !I.isTestFile('src/a.ts'))
ok('isTestFile 否定: README.md', !I.isTestFile('README.md'))
ok('isMutationTool: edit', I.isMutationTool('edit'))
ok('isMutationTool: write', I.isMutationTool('write'))
ok('isMutationTool 否定: read', !I.isMutationTool('read'))
ok('specComplete: 空对象 false', !I.specComplete({}))
ok('specComplete: 部分字段 false', !I.specComplete({ goal: 'x' }))
ok('specComplete: 空白字段 false', !I.specComplete({ goal: ' ', xy: 'a', assumptions: 'b', path: 'c', acceptance: 'd' }))
const fullSpec = { goal: 'g', xy: 'x', assumptions: 'a', path: 'p', acceptance: 'c' }
ok('specComplete: 五字段 true', I.specComplete(fullSpec))
const md = I.renderSpec({ ...fullSpec, recordedAt: '2026-01-01T00:00:00.000Z' })
ok('renderSpec 含 Goal 标题', md.includes('## Goal'))
ok('renderSpec 含 XY 标题', md.includes('## XY 检查'))
const parsed = I.parseSpec(md)
ok('parseSpec 回读 goal', parsed && parsed.goal === 'g')
ok('parseSpec 回读 acceptance', parsed && parsed.acceptance === 'c')
ok('parseSpec 非本契约 → undefined', I.parseSpec('# other\ncontent') === undefined)

// ── 2. makeState：spec 文件持久 ────────────────────────────────────────────
section('makeState spec 文件')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-disc-test-'))
ok('saveSpec 写入 true（node:fs 默认 io）', (async () => {
  const st = I.makeState({ sessionKey: 's1', workspaceRoot: tmpRoot })
  return (await st.saveSpec(fullSpec)) === true
})())
ok('spec 文件存在', fs.existsSync(path.join(tmpRoot, I.SPEC_DIRNAME, I.SPEC_FILENAME)))
ok('重新加载可回读', (async () => {
  const st = I.makeState({ sessionKey: 's1', workspaceRoot: tmpRoot })
  const spec = await st.loadSpec()
  return spec !== undefined && spec.goal === 'g'
})())
ok('saveSpec 返回 false（无工作区根）', (async () => {
  const st = I.makeState({ sessionKey: 's2' })
  return (await st.saveSpec(fullSpec)) === false
})())
ok('ctx.fs io 注入路径（mock 读写器）', (async () => {
  const written = []
  const mockIo = {
    async readText() { return undefined },
    async writeText(p, c) { written.push(c); return undefined },
  }
  const st = I.makeState({ sessionKey: 's3', workspaceRoot: tmpRoot, io: mockIo })
  const saved = await st.saveSpec(fullSpec)
  return saved === true && written.length === 1 && written[0].includes('## Goal')
})())

// ── 3. pre-execute spec gate（remind 默认）────────────────────────────────
section('pre-execute gate（remind）')
// 每次用全新 agent id 隔离会话状态（remindOnce）
let dispatchPreAs = (name, args, agentId) => {
  const exec = { name, arguments: args, token: 't', callId: 'c', agent: { id: agentId, session: { header: sessionHeader } } }
  return preExecute[0](exec, () => Promise.resolve({ kind: 'allow' }))
}
ok('无 spec 首次 edit（remind）→ allow', (async () => {
  const d = await dispatchPreAs('edit', { file_path: 'src/a.ts', content: 'x' }, 'g1')
  return d.kind === 'allow'
})())
ok('测试文件编辑 → allow 且不触发 remind', (async () => {
  // 新会话：先 write 测试文件（应 allow 且不置 remind 标志）
  const d = await dispatchPreAs('write', { file_path: 'src/a.test.ts', content: 'x' }, 'g2')
  return d.kind === 'allow'
})())
ok('无 spec 首次实现 edit（block 强度）→ deny', (async () => {
  const prev = configMock.intensity
  configMock.intensity = 'block'
  const d = await dispatchPreAs('edit', { file_path: 'src/b.ts' }, 'g3')
  configMock.intensity = prev
  return d.kind === 'deny'
})())
ok('有 spec 的 edit → allow', (async () => {
  // 先记录 spec
  const exec = { name: 'kix_discipline_spec', arguments: fullSpec, token: 't', callId: 'c', agent: { id: 'g4', session: { header: sessionHeader } } }
  const specTool = registeredTools.find((t) => t.name === 'kix_discipline_spec')
  const r = await specTool.execute(fullSpec, exec)
  ok('spec 工具 ok=true', r.ok === true)
  const d = await dispatchPreAs('edit', { file_path: 'src/c.ts' }, 'g4')
  return d.kind === 'allow'
})())
ok('spec 工具缺字段 → ok=false', (async () => {
  const exec = { name: 'kix_discipline_spec', arguments: { goal: 'only' }, token: 't', callId: 'c', agent: { id: 'g5', session: { header: sessionHeader } } }
  const specTool = registeredTools.find((t) => t.name === 'kix_discipline_spec')
  const r = await specTool.execute({ goal: 'only' }, exec)
  return r.ok === false
})())

// ── 4. post-execute：red remind 注入 + green 记录 ─────────────────────────
section('post-execute')
ok('post-execute 无 pendingRemind → accept 无注入', (async () => {
  const d = await dispatchPost('read', { path: 'x' }, { isError: false })
  return d.kind === 'accept' && (d.additionalContexts === undefined || d.additionalContexts.length === 0)
})())
ok('测试运行成功 → green 记录（turnTests=1）', (async () => {
  const d = await dispatchPost('bash', { command: 'pnpm test' }, { isError: false })
  return d.kind === 'accept'
})())
ok('测试运行失败 → 不记录 green', (async () => {
  const d = await dispatchPost('bash', { command: 'pnpm test' }, { isError: true })
  return d.kind === 'accept'
})())
ok('pendingRemind 注入 additionalContexts', (async () => {
  // 新会话触发 red remind（pre → 置 pendingRemind），再 post → 注入
  await dispatchPreAs('edit', { file_path: 'src/d.ts' }, 'g6')
  const d = await dispatchPost('edit', { file_path: 'src/d.ts' }, { isError: false })
  return d.kind === 'accept' && Array.isArray(d.additionalContexts) && d.additionalContexts.length === 1
})())

// ── 5. turn-stopping：green 提醒 ──────────────────────────────────────────
section('turn-stopping')
ok('有实现 edit 无测试 → steer 提醒', (async () => {
  await dispatchPreAs('edit', { file_path: 'src/e.ts' }, 'g7')
  dispatchTurn()
  return steered.length === 1
})())
ok('有实现 edit 且有测试 → 不提醒', (async () => {
  await dispatchPreAs('edit', { file_path: 'src/f.ts' }, 'g8')
  await dispatchPost('bash', { command: 'npm test' }, { isError: false })
  dispatchTurn()
  return steered.length === 0
})())
ok('无实现 edit → 不提醒', (async () => {
  dispatchTurn()
  return steered.length === 0
})())
ok('remindOnce：同会话第二次不重复提醒', (async () => {
  await dispatchPreAs('edit', { file_path: 'src/g.ts' }, 'g9')
  dispatchTurn()
  const first = steered.length
  await dispatchPreAs('edit', { file_path: 'src/h.ts' }, 'g9')
  dispatchTurn()
  return first === 1 && steered.length === 0
})())
ok('disabled 后 gate 静默', (async () => {
  const cmd = registeredCommands.find((c) => c.name === 'kix-discipline')
  cmd.handler({ agent: { id: 'g10', session: { header: sessionHeader } }, rawInput: 'off' })
  const d = await dispatchPreAs('edit', { file_path: 'src/i.ts' }, 'g10')
  cmd.handler({ agent: { id: 'g10', session: { header: sessionHeader } }, rawInput: 'on' })
  return d.kind === 'allow'
})())

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────')
console.log(`kix-discipline: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
