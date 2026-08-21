// kix-discipline 回归测试（P0，2026-08-16）
//
// 单元级验证：加载 kix-discipline.js，mock DSH pre-execute / post-execute /
// agent/turn-stopping 派发，覆盖：
//   - 纯逻辑（__internals）：isTestCommand / classifyMutationPath / isMutationTool /
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
let sessionQueryMock = null
let configMock = { intensity: 'remind' }
const ctx = {
  config: configMock,
  logger: { info() {}, warn() {}, error() {} },
  get(name) {
    if (name === 'userQuestions') return userQuestionsMock
    if (name === 'sandboxPolicy') return { workspaceRoot: os.tmpdir() }
    if (name === 'sessionQuery') return sessionQueryMock
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

const blockListeners = {}
const ctxBlock = {
  logger: { info() {}, warn() {}, error() {} },
  get(name) {
    if (name === 'sandboxPolicy') return { workspaceRoot: os.tmpdir() }
    return undefined
  },
  on(event, cb) { ;(blockListeners[event] ||= []).push(cb) },
  effect() {},
  tools: { register() { return () => {} } },
  commands: { register() { return () => {} } },
}
plugin.apply(ctxBlock, { intensity: 'block' })

// ── 模拟 DSH 派发 ─────────────────────────────────────────────────────────
let steered = []
const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-discipline-session-'))
const sessionHeader = { cwd: sessionRoot }
function dispatchPre(name, args) {
  const exec = { name, arguments: args, token: 't', callId: 'c', agent: { id: 'test-agent', session: { header: sessionHeader } } }
  return preExecute[0](exec, () => Promise.resolve({ kind: 'allow' }))
}
function dispatchPostAs(name, args, result, agentId = 'test-agent', header = sessionHeader) {
  const exec = { name, arguments: args, token: 't', callId: 'c', agent: { id: agentId, session: { header } } }
  return postExecute[0](exec, result || { isError: false }, () => Promise.resolve({ kind: 'accept' }))
}
function dispatchPost(name, args, result) {
  return dispatchPostAs(name, args, result)
}
function dispatchTurnAs(agentId = 'test-agent', header = sessionHeader) {
  steered = []
  const agent = { id: agentId, session: { header }, steer(msg) { steered.push(msg) } }
  return turnStopping[0]({ agent, turn: 1, signal: undefined })
}
function dispatchTurn() { return dispatchTurnAs() }
// v2：带 session.id + 可控 sessionQuery 表面的 turn 派发（deflection 弹问测试）
function dispatchTurnFor(agentId, sessionId, surface) {
  sessionQueryMock = surface ? { readSurface: async () => surface } : null
  steered = []
  const agent = { id: agentId, session: { id: sessionId, header: sessionHeader }, steer(msg) { steered.push(msg) } }
  return turnStopping[0]({ agent, turn: 1, signal: undefined })
}

let passed = 0
let failed = 0
async function ok(label, cond) {
  let value = false
  try { value = Boolean(await cond) } catch (e) { console.error(e); value = false }
  if (value) { passed++ } else { failed++ }
  console.log(`${value ? 'PASS' : 'FAIL'}  ${label}`)
}
function section(title) { console.log('\n── ' + title + ' ──') }

async function main() {
// ── 1. 纯逻辑 ─────────────────────────────────────────────────────────────
section('纯逻辑 __internals')
await ok('isTestCommand: pnpm test', I.isTestCommand('pnpm test'))
await ok('isTestCommand: npm run test', I.isTestCommand('npm run test'))
await ok('isTestCommand: pytest -q', I.isTestCommand('pytest -q'))
await ok('isTestCommand: cargo test', I.isTestCommand('cargo test'))
await ok('isTestCommand: node --test', I.isTestCommand('node --test'))
await ok('isTestCommand 否定: git commit', !I.isTestCommand('git commit -m "test fix"'))
await ok('isTestCommand 否定: echo', !I.isTestCommand('echo test'))
await ok('isTestFile: src/a.test.ts', I.isTestFile('src/a.test.ts'))
await ok('isTestFile: tests/foo.py', I.isTestFile('tests/foo.py'))
await ok('isTestFile: __tests__/x.js', I.isTestFile('__tests__/x.js'))
await ok('isTestFile 否定: src/a.ts', !I.isTestFile('src/a.ts'))
await ok('isTestFile 否定: README.md', !I.isTestFile('README.md'))
await ok('classifyMutationPath: source', I.classifyMutationPath('src/a.ts') === 'source')
await ok('classifyMutationPath: test', I.classifyMutationPath('src/a.test.ts') === 'test')
await ok('classifyMutationPath: documentation', I.classifyMutationPath('README.md') === 'documentation')
await ok('classifyMutationPath: Windows absolute artifact', I.classifyMutationPath('C:\\repo\\tmp-analyze\\report.md') === 'artifact')
await ok('classifyMutationPath: sprint artifact', I.classifyMutationPath('/repo/docs/sprint-3/qa-signoff.md') === 'artifact')
await ok('classifyMutationPath: config remains source', I.classifyMutationPath('dsh/preset/agent.cordis.yml') === 'source')
await ok('isMutationTool: edit', I.isMutationTool('edit'))
await ok('isMutationTool: write', I.isMutationTool('write'))
await ok('isMutationTool 否定: read', !I.isMutationTool('read'))
await ok('specComplete: 空对象 false', !I.specComplete({}))
await ok('specComplete: 部分字段 false', !I.specComplete({ goal: 'x' }))
await ok('specComplete: 空白字段 false', !I.specComplete({ goal: ' ', xy: 'a', assumptions: 'b', path: 'c', acceptance: 'd' }))
const fullSpec = { goal: 'g', xy: 'x', assumptions: 'a', path: 'p', acceptance: 'c' }
await ok('specComplete: 五字段 true', I.specComplete(fullSpec))
const md = I.renderSpec({ ...fullSpec, recordedAt: '2026-01-01T00:00:00.000Z' })
await ok('renderSpec 含 Goal 标题', md.includes('## Goal'))
await ok('renderSpec 含 XY 标题', md.includes('## XY 检查'))
const parsed = I.parseSpec(md)
await ok('parseSpec 回读 goal', parsed && parsed.goal === 'g')
await ok('parseSpec 回读 acceptance', parsed && parsed.acceptance === 'c')
await ok('parseSpec 非本契约 → undefined', I.parseSpec('# other\ncontent') === undefined)
// 2026-08-17 mode 字段（编曲留痕：成员组合 + 一句理由）
await ok('renderSpec 含 mode 编曲留痕段', I.renderSpec({ ...fullSpec, mode: 'dev+qa：跨模块改动需独立验收' }).includes('## 执行模式（编曲留痕'))
await ok('renderSpec 无 mode → 占位可见（spec.md 留槽位）', (() => {
  const m = I.renderSpec(fullSpec)
  return m.includes('执行模式') && m.includes('（未记录')
})())
await ok('parseSpec 回读 mode', (() => {
  const p = I.parseSpec(I.renderSpec({ ...fullSpec, mode: 'solo：字面明确单文件修复' }))
  return p && p.mode === 'solo：字面明确单文件修复'
})())
await ok('parseSpec 占位不假值（未记录 ≠ mode 值）', (() => {
  const p = I.parseSpec(I.renderSpec(fullSpec))
  return p && p.mode === undefined
})())
await ok('specComplete 不要求 mode（可选项，五字段为准）', I.specComplete(fullSpec))
// 2026-08-21 contract 字段（行为契约：必须不变/改变/成立/歧义解读）
await ok('renderSpec 含 contract 行为契约段', I.renderSpec({ ...fullSpec, contract: '必须不变：公开 API 形状；必须改变：生成器执行时机；必须成立：docstring 与实现一致；歧义：preserve API ≠ 保全 list 返回' }).includes('## 行为契约（必须不变'))
await ok('renderSpec 无 contract → 占位可见（spec.md 留槽位）', (() => {
  const m = I.renderSpec(fullSpec)
  return m.includes('行为契约') && m.includes('（未记录——字面明确')
})())
await ok('parseSpec 回读 contract', (() => {
  const p = I.parseSpec(I.renderSpec({ ...fullSpec, contract: '必须不变：公开签名；必须改变：无；必须成立：隐藏陷阱过；歧义：无' }))
  return p && p.contract === '必须不变：公开签名；必须改变：无；必须成立：隐藏陷阱过；歧义：无'
})())
await ok('parseSpec 占位不假值（未记录 ≠ contract 值）', (() => {
  const p = I.parseSpec(I.renderSpec(fullSpec))
  return p && p.contract === undefined
})())
await ok('specComplete 不要求 contract（可选项，五字段为准）', I.specComplete({ ...fullSpec, contract: '' }))

// ── 2. makeState：spec 文件持久 ────────────────────────────────────────────
section('makeState spec 文件')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-disc-test-'))
await ok('saveSpec 写入 true（node:fs 默认 io）', (async () => {
  const st = I.makeState({ sessionKey: 's1', workspaceRoot: tmpRoot })
  return (await st.saveSpec(fullSpec)) === true
})())
await ok('spec 文件存在', fs.existsSync(path.join(tmpRoot, I.SPEC_DIRNAME, I.SPEC_FILENAME)))
await ok('重新加载可回读', (async () => {
  const st = I.makeState({ sessionKey: 's1', workspaceRoot: tmpRoot })
  const spec = await st.loadSpec()
  return spec !== undefined && spec.goal === 'g'
})())
await ok('saveSpec 返回 false（无工作区根）', (async () => {
  const st = I.makeState({ sessionKey: 's2' })
  return (await st.saveSpec(fullSpec)) === false
})())
await ok('ctx.fs io 注入路径（mock 读写器）', (async () => {
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
await ok('无 spec 首次 edit（remind）→ allow', (async () => {
  const d = await dispatchPreAs('edit', { file_path: 'src/a.ts', content: 'x' }, 'g1')
  return d.kind === 'allow'
})())
await ok('测试文件编辑 → allow 且不触发 remind', (async () => {
  // 新会话：先 write 测试文件（应 allow 且不置 remind 标志）
  const d = await dispatchPreAs('write', { file_path: 'src/a.test.ts', content: 'x' }, 'g2')
  return d.kind === 'allow'
})())
await ok('documentation/artifact 编辑不进入 green gate', (async () => {
  const cases = [
    ['doc-only', 'README.md'],
    ['artifact-only', 'C:\\repo\\tmp-analyze\\observer.md'],
  ]
  for (const [agentId, filePath] of cases) {
    const localSteered = []
    await dispatchPreAs('write', { file_path: filePath, content: 'x' }, agentId)
    await turnStopping[0]({
      agent: { id: agentId, session: { header: sessionHeader }, steer(msg) { localSteered.push(msg) } },
      turn: 1,
    })
    if (localSteered.length !== 0) return false
  }
  return true
})())
await ok('无 spec 首次实现 edit（block 强度）→ deny', (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-discipline-block-'))
  const exec = {
    name: 'edit',
    arguments: { file_path: 'src/b.ts' },
    token: 't',
    callId: 'block',
    agent: { id: 'g3', session: { header: { cwd: root } } },
  }
  const d = await blockListeners['tools/pre-execute'][0](exec, () => Promise.resolve({ kind: 'allow' }))
  fs.rmSync(root, { recursive: true, force: true })
  return d.kind === 'deny'
})())
await ok('有 spec 的 edit → allow', (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-discipline-spec-'))
  const header = { cwd: root }
  const agent = { id: 'g4', session: { header } }
  const specTool = registeredTools.find((t) => t.name === 'kix_discipline_spec')
  const r = await specTool.execute(fullSpec, { name: 'kix_discipline_spec', arguments: fullSpec, token: 't', callId: 'c', agent })
  const d = await preExecute[0]({ name: 'edit', arguments: { file_path: 'src/c.ts' }, token: 't', callId: 'edit', agent }, () => Promise.resolve({ kind: 'allow' }))
  fs.rmSync(root, { recursive: true, force: true })
  return r.ok === true && d.kind === 'allow'
})())
await ok('spec 工具以 session cwd 覆盖 sandbox fallback', (async () => {
  const cwdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-discipline-cwd-'))
  const exec = {
    name: 'kix_discipline_spec',
    arguments: fullSpec,
    token: 't',
    callId: 'cwd',
    agent: { id: 'cwd-priority', session: { header: { cwd: cwdRoot } } },
  }
  const specTool = registeredTools.find((t) => t.name === 'kix_discipline_spec')
  const r = await specTool.execute(fullSpec, exec)
  const expected = path.join(cwdRoot, 'kix-discipline', 'spec.md')
  const passed = r.ok === true && r.specFile === expected && fs.existsSync(expected)
  fs.rmSync(cwdRoot, { recursive: true, force: true })
  return passed
})())
await ok('spec 工具缺字段 → ok=false', (async () => {
  const exec = { name: 'kix_discipline_spec', arguments: { goal: 'only' }, token: 't', callId: 'c', agent: { id: 'g5', session: { header: sessionHeader } } }
  const specTool = registeredTools.find((t) => t.name === 'kix_discipline_spec')
  const r = await specTool.execute({ goal: 'only' }, exec)
  return r.ok === false
})())
await ok('spec 工具可选 contract 落档并可回读', (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-discipline-contract-'))
  const specTool = registeredTools.find((t) => t.name === 'kix_discipline_spec')
  const payload = { ...fullSpec, contract: '必须不变：公开签名；必须改变：生成器时机；必须成立：docstring；歧义：preserve API ≠ list 返回' }
  const r = await specTool.execute(payload, { name: 'kix_discipline_spec', arguments: payload, token: 't', callId: 'contract', agent: { id: 'g-contract', session: { header: { cwd: root } } } })
  const md = fs.readFileSync(path.join(root, 'kix-discipline', 'spec.md'), 'utf8')
  const parsed = I.parseSpec(md)
  const passed = r.ok === true && parsed && parsed.contract === payload.contract
  fs.rmSync(root, { recursive: true, force: true })
  return passed
})())
await ok('spec 工具无 contract 仍完整（不 deny）', (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-discipline-nocontract-'))
  const specTool = registeredTools.find((t) => t.name === 'kix_discipline_spec')
  const r = await specTool.execute(fullSpec, { name: 'kix_discipline_spec', arguments: fullSpec, token: 't', callId: 'nocontract', agent: { id: 'g-nocontract', session: { header: { cwd: root } } } })
  const md = fs.readFileSync(path.join(root, 'kix-discipline', 'spec.md'), 'utf8')
  const parsed = I.parseSpec(md)
  const passed = r.ok === true && parsed && parsed.contract === undefined
  fs.rmSync(root, { recursive: true, force: true })
  return passed
})())

// ── 4. post-execute：red remind 注入 + green 记录 ─────────────────────────
section('post-execute')
await ok('post-execute 无 pendingRemind → accept 无注入', (async () => {
  const d = await dispatchPost('read', { path: 'x' }, { isError: false })
  return d.kind === 'accept' && (d.additionalContexts === undefined || d.additionalContexts.length === 0)
})())
await ok('测试运行成功 → green 记录（turnTests=1）', (async () => {
  const d = await dispatchPost('bash', { command: 'pnpm test' }, { isError: false })
  return d.kind === 'accept'
})())
await ok('测试运行失败 → 不记录 green', (async () => {
  const d = await dispatchPost('bash', { command: 'pnpm test' }, { isError: true })
  return d.kind === 'accept'
})())
await ok('pendingRemind 注入 additionalContexts', (async () => {
  // 新会话触发 red remind（pre → 置 pendingRemind），再 post → 注入
  await dispatchPreAs('edit', { file_path: 'src/d.ts' }, 'g6')
  const d = await dispatchPostAs('edit', { file_path: 'src/d.ts' }, { isError: false }, 'g6')
  return d.kind === 'accept' && Array.isArray(d.additionalContexts) && d.additionalContexts.length === 1
})())

// ── 5. turn-stopping：green 提醒 ──────────────────────────────────────────
section('turn-stopping')
await ok('有实现 edit 无测试 → steer 提醒', (async () => {
  await dispatchPreAs('edit', { file_path: 'src/e.ts' }, 'g7')
  await dispatchTurnAs('g7')
  return steered.length === 1
})())
await ok('有实现 edit 且有测试 → 不提醒', (async () => {
  await dispatchPreAs('edit', { file_path: 'src/f.ts' }, 'g8')
  await dispatchPostAs('bash', { command: 'npm test' }, { isError: false }, 'g8')
  await dispatchTurnAs('g8')
  return steered.length === 0
})())
await ok('无实现 edit → 不提醒', (async () => {
  await dispatchTurnAs('no-edit')
  return steered.length === 0
})())
await ok('remindOnce：同会话第二次不重复提醒', (async () => {
  await dispatchPreAs('edit', { file_path: 'src/g.ts' }, 'g9')
  await dispatchTurnAs('g9')
  const first = steered.length
  await dispatchPreAs('edit', { file_path: 'src/h.ts' }, 'g9')
  await dispatchTurnAs('g9')
  return first === 1 && steered.length === 0
})())
await ok('双重计数回归：pre-execute 测试命令不计数，被拦/失败测试不构成 green（审查修复）', (async () => {
  // 测试命令经 pre-execute(不再 +1) → 无 post-execute 成功 → turnTests=0
  await dispatchPreAs('bash', { command: 'npm test' }, 'dup-test')
  await dispatchPreAs('edit', { file_path: 'src/dup.ts' }, 'dup-test')
  // 被拦:post-execute isError → 不计数
  await dispatchPostAs('bash', { command: 'npm test' }, { isError: true }, 'dup-test')
  await dispatchTurnAs('dup-test')
  return steered.length === 1 // 测试未成功运行 → 必须提醒(旧实现 turnTests≥1 静默)
})())
await ok('双重计数回归：成功测试仍计 1 次（非 2）', (async () => {
  await dispatchPreAs('edit', { file_path: 'src/ok.ts' }, 'ok-test')
  await dispatchPostAs('bash', { command: 'npm test' }, { isError: false }, 'ok-test')
  await dispatchTurnAs('ok-test')
  return steered.length === 0 // 成功测试=green 证据 → 不提醒(若计 2 次语义仍 0,此断言保底线)
})())

// ── 6. spec 加载竞态回归（审查修复）───────────────────────────────────────
section('spec 加载竞态')
await ok('竞态回归：eager 与门禁共享同一 in-flight promise，不假性无 spec', (async () => {
  let resolveRead
  const gate = new Promise((res) => { resolveRead = res })
  const mockIo = {
    readText: () => gate.then(() => I.renderSpec(fullSpec)),
  }
  const st = I.makeState({ sessionKey: 'race', workspaceRoot: tmpRoot, io: mockIo })
  // eager(fire-and-forget)与门禁几乎同时发起
  const eager = st.loadSpec().catch(() => undefined)
  const gateLoad = st.loadSpec()
  resolveRead()
  const [eagerSpec, gateSpec] = await Promise.all([eager, gateLoad])
  return gateSpec !== undefined && gateSpec.goal === 'g' && eagerSpec === gateSpec
})())
await ok('首次 load miss 后 saveSpec 可被后续 loadSpec 读取', (async () => {
  const writes = []
  const st = I.makeState({
    sessionKey: 'save-after-load',
    workspaceRoot: tmpRoot,
    io: {
      readText: async () => { throw new Error('missing') },
      writeText: async (filePath, content) => { writes.push([filePath, content]) },
    },
  })
  const before = await st.loadSpec()
  await st.saveSpec(fullSpec)
  const after = await st.loadSpec()
  return before === undefined && after && after.goal === fullSpec.goal && writes.length === 1
})())
await ok('disabled 后 gate 静默', (async () => {
  const cmd = registeredCommands.find((c) => c.name === 'kix-discipline')
  cmd.handler({ agent: { id: 'g10', session: { header: sessionHeader } }, rawInput: 'off' })
  const d = await dispatchPreAs('edit', { file_path: 'src/i.ts' }, 'g10')
  cmd.handler({ agent: { id: 'g10', session: { header: sessionHeader } }, rawInput: 'on' })
  return d.kind === 'allow'
})())

// ── 7. v2：拒绝/转交弹问（用户反馈 2026-08-16）─────────────────────────────
section('deflection 弹问（v2）')
await ok('isDeflection: 不处理', I.isDeflection('该问题不处理'))
await ok('isDeflection: 在别的地方处理', I.isDeflection('此改动在别的地方处理'))
await ok('isDeflection: 系统信息不足', I.isDeflection('系统信息不足，无法判断'))
await ok('isDeflection: 超出职责', I.isDeflection('这超出我的职责范围'))
await ok("isDeflection: won't handle", I.isDeflection("I won't handle this"))
await ok('isDeflection: handled elsewhere', I.isDeflection('this is handled elsewhere'))
await ok('isDeflection: insufficient information', I.isDeflection('insufficient system information to answer'))
await ok('isDeflection 否定: 已修复', !I.isDeflection('问题已修复并补充测试'))
await ok('isDeflection 否定: 已重试', !I.isDeflection('编译失败，已重试成功'))
await ok('lastAssistantText: 取最近 assistant 文本', I.lastAssistantText({
  events: [
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'u' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'x' }] } } },
  ],
}) === 'hello')
await ok('lastAssistantText: 非 assistant 结尾 → undefined', I.lastAssistantText({
  events: [{ type: 'tool/result', data: { message: { content: [] } } }],
}) === undefined)
await ok('lastAssistantText: 无 events → undefined', I.lastAssistantText({ events: [] }) === undefined)

await ok('弹问: 终稿「不处理」→ steer 弹问一次', (async () => {
  const surface = { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '该问题不处理' }] } } }] }
  await dispatchTurnFor('dv1', 'sv1', surface)
  return steered.length === 1 && steered[0].content && steered[0].content.some((b) => b.type === 'text' && b.text.includes('判定为'))
})())
await ok('弹问: 每会话一次（第二次同判不再弹）', (async () => {
  const surface = { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '不处理' }] } } }] }
  await dispatchTurnFor('dv2', 'sv2', surface)
  const first = steered.length
  await dispatchTurnFor('dv2', 'sv2', surface)
  return first === 1 && steered.length === 0
})())
await ok('弹问: 终稿正常（已修复）→ 不弹', (async () => {
  const surface = { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '问题已修复并补充测试' }] } } }] }
  await dispatchTurnFor('dv3', 'sv3', surface)
  return steered.length === 0
})())
await ok('弹问: 本回合有实现 edit → 不算拒绝，不弹', (async () => {
  await dispatchPreAs('edit', { file_path: 'src/deflect.ts' }, 'dv4')
  const surface = { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '该问题不处理' }] } } }] }
  await dispatchTurnFor('dv4', 'sv4', surface)
  // 可能触发 green 提醒（有 edit 无测试），但绝不含 deflection 弹问
  return steered.every((m) => !(m.content && m.content.some((b) => b.text && b.text.includes('判定为'))))
})())
await ok('弹问: 无 sessionQuery → 静默跳过', (async () => {
  sessionQueryMock = null
  steered = []
  await turnStopping[0]({ agent: { id: 'dv5', session: { header: sessionHeader }, steer(msg) { steered.push(msg) } }, turn: 1, signal: undefined })
  return steered.length === 0
})())

fs.rmSync(sessionRoot, { recursive: true, force: true })

// ── v7 编曲保育 ②：mode=solo 信号一致性挑战（2026-08-19，b2da1f02 实证）──
{
  const I = plugin.__internals
  await ok('挑战: 实证违规样本（跨模块+审计修复自评 solo）→ 拦截', I.soloModeChallenge({
    goal: '游戏 UI 存在大量对真实用户不可见/不可操作的细节问题；要的是：以真实用户交互审计全部界面并修复',
    path: '主线程写真实用户审计脚本 → vision 看截图取证 → 主线程修复 js/ui+css → 复审计',
    mode: 'solo 主线程（浏览器交互需主线程驱动）',
  }) !== undefined)
  await ok('挑战: 正当 solo（单文件小修）→ 放行', I.soloModeChallenge({
    goal: '修复 README 里的错别字', path: '直接 edit 单文件', mode: 'solo：字面明确单文件修复',
  }) === undefined)
  await ok('挑战: 带辩护理由的二次提交 → 放行', I.soloModeChallenge({
    goal: '跨模块审计并修复', path: '主线程统一处理',
    mode: 'solo：改动实际只涉及单文件且已有 green 测试覆盖，无需组队',
  }) === undefined)
  await ok('挑战: 组队 mode（dev+qa）→ 不拦', I.soloModeChallenge({
    goal: '跨模块修复', path: '多文件', mode: 'dev+qa：跨模块需独立验收',
  }) === undefined)
  await ok('挑战: 空 mode → 不拦（persona 路由提醒管辖）', I.soloModeChallenge({
    goal: '跨模块修复', path: '多文件', mode: '',
  }) === undefined)
  await ok('挑战: 措辞模糊无信号词 → 放行（保守取向）', I.soloModeChallenge({
    goal: '看看这个功能怎么回事', path: '先调研再说', mode: 'solo',
  }) === undefined)
  // 端到端：execute 路径返回 retryAllowed 的挑战错误
  const challengeSpec = {
    goal: '以真实用户交互审计全部界面并修复', xy: '要真实可用', assumptions: '可测',
    path: '主线程修复 js/ui+css 并复审计', acceptance: '审计 0 blocking', mode: 'solo 主线程',
  }
  const specToolChal = registeredTools.find((t) => t.name === 'kix_discipline_spec')
  const rr = specToolChal ? await specToolChal.execute(challengeSpec, { name: 'kix_discipline_spec', arguments: challengeSpec, token: 't', callId: 'cc', agent: { id: 's-chal', session: { header: { cwd: '/tmp' } } } }) : null
  await ok('挑战: execute 端到端返回 retryAllowed 错误（非静默落档）', rr && rr.ok === false && rr.retryAllowed === true && /solo 与任务信号不一致/.test(rr.error || ''))
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────')
console.log(`kix-discipline: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
