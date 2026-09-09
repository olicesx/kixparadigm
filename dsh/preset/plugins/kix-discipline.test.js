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
// 夹具收尾（2026-09-09）：本文件自建的 mkdtemp 目录统一登记并在结束时清理，
// 不泄漏 /tmp，也不触碰其他任务创建的目录。
const createdTmpDirs = [sessionRoot]
function cleanupTmpDirs() {
  for (const dir of createdTmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ }
  }
  createdTmpDirs.length = 0
}
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

// ── 真实工具 canonical 返回形状（ToolExecutionResult，2026-09-09 缺陷修复）──
// post-execute 收到的是 { isError, value } 包装；bash/pwsh 的 value 是
// { kind:'foreground', exitCode, timedOut, aborted, sandbox? } 或
// { kind:'background', jobId }；job_output 的 value 是 { text, job:{status,detail} }。
// 旧测试用裸 { isError:false } 当成功 stub，正是「非零 exitCode 仍记 green」的盲区。
function fg(exitCode = 0, extra = {}) {
  return {
    isError: false,
    value: {
      kind: 'foreground', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 120000,
      stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, ...extra,
    },
  }
}
function bg(jobId) { return { isError: false, value: { kind: 'background', jobId } } }
function jobRes(id, status, detail) {
  return {
    isError: false,
    value: {
      text: '',
      job: { id, kind: 'bash', label: 'job', status, ...(detail === undefined ? {} : { detail }), startedAt: 1 },
    },
  }
}
const GREEN_RE = /测试未通过|未运行/
const LINT_RE = /语法检查/
function turnTexts() { return steered.map((m) => (m.content && m.content[0] && m.content[0].text) || '') }

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
await ok('isVerificationCommand: Go test/vet/build/mod verify',
  I.isVerificationCommand('go test ./...') && I.isVerificationCommand('go vet ./...') &&
  I.isVerificationCommand('go build ./...') && I.isVerificationCommand('go mod verify'))
await ok('isVerificationCommand: JS lint/typecheck/build',
  I.isVerificationCommand('npm run lint') && I.isVerificationCommand('pnpm typecheck') && I.isVerificationCommand('yarn build'))
await ok('isVerificationCommand: direct Node test/check scripts',
  I.isVerificationCommand('node dsh/preset/plugins/kix-route.test.js') &&
  I.isVerificationCommand('node scripts/check-dsh-consistency.cjs'))
await ok('isVerificationCommand 否定: git status/echo',
  !I.isVerificationCommand('git status --short') && !I.isVerificationCommand('echo verify'))
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
await ok('classifyMutationPath: DSH settings.yaml 是 artifact',
  I.classifyMutationPath('/root/.dsh/settings.yaml') === 'artifact' &&
  I.classifyMutationPath('.dsh/settings.yml') === 'artifact' &&
  I.classifyMutationPath('C:\\Users\\x\\.dsh\\settings.yaml') === 'artifact')
await ok('classifyMutationPath: preset 插件源码仍是 source',
  I.classifyMutationPath('/root/.dsh/.agent-presets/kixparadigm/plugins/kix-focus.js') === 'source')
await ok('isTestCommand 否定: node heredoc 不算测试',
  !I.isTestCommand("node --input-type=module <<'JS'\nconsole.log(1)\nJS") &&
  !I.isVerificationCommand('echo test'))
await ok('isMutationTool: edit', I.isMutationTool('edit'))
await ok('isMutationTool: write', I.isMutationTool('write'))
await ok('isMutationTool 否定: read', !I.isMutationTool('read'))
await ok('lintIdsForPath: rust 两族', I.lintIdsForPath('src/main.rs').join(',') === 'rust-fmt,rust-clippy')
await ok('lintIdsForPath: js/ts 分桶（TS 与 JS 语法证据不再共用一桶）',
  I.lintIdsForPath('src/a.ts').join(',') === 'ts' && I.lintIdsForPath('src/a.tsx').join(',') === 'ts' &&
  I.lintIdsForPath('src/a.mts').join(',') === 'ts' && I.lintIdsForPath('src/a.cts').join(',') === 'ts' &&
  I.lintIdsForPath('src/a.js').join(',') === 'js' && I.lintIdsForPath('src/a.jsx').join(',') === 'js' &&
  I.lintIdsForPath('src/a.mjs').join(',') === 'js' && I.lintIdsForPath('src/a.cjs').join(',') === 'js')
await ok('lintIdsForPath: 文档/artifact 空', I.lintIdsForPath('README.md').length === 0 && I.lintIdsForPath('/root/.dsh/settings.yaml').length === 0)
await ok('lintIdsForPath: rust 测试文件仍要 lint', I.lintIdsForPath('tests/foo.rs').join(',') === 'rust-fmt,rust-clippy')
await ok('lintIdsForCommand: fmt/clippy 分族', I.lintIdsForCommand('cargo fmt --check').join(',') === 'rust-fmt' && I.lintIdsForCommand('cargo clippy -D warnings').join(',') === 'rust-clippy')
await ok('lintIdsForCommand: cargo test / npm test 不算 lint', I.lintIdsForCommand('cargo test').length === 0 && I.lintIdsForCommand('npm test').length === 0)
await ok('lintIdsForCommand: eslint 算 js+ts（两桶都认 lint 工具链）',
  I.lintIdsForCommand('npx eslint src').includes('js') && I.lintIdsForCommand('npx eslint src').includes('ts'))
await ok('lintIdsForCommand: tsc/typecheck 只补 ts 桶（node --check 不补）',
  I.lintIdsForCommand('npx tsc --noEmit').includes('ts') &&
  I.lintIdsForCommand('npm run typecheck').includes('ts') &&
  !I.lintIdsForCommand('node --check src/a.js').includes('ts'))
// 2026-09-09：本仓实际可跑的 JS 语法 gate 是 node --check（无 eslint 工具链）。
// 只认确切 node --check/-c + *.js/.cjs/.mjs；.ts 不是它的证据，node --test 不是 lint。
await ok('lintIdsForCommand: node --check/-c 的 js/cjs/mjs 算 js 语法证据',
  I.lintIdsForCommand('node --check src/a.js').join(',') === 'js' &&
  I.lintIdsForCommand('node -c src/a.cjs').join(',') === 'js' &&
  I.lintIdsForCommand('node --check dsh/preset/plugins/a.mjs').join(',') === 'js' &&
  I.lintIdsForCommand('npm run build && node --check src/a.js').join(',') === 'js')
await ok('lintIdsForCommand: node --check 的 .ts/非 js 不算，node --test 不算',
  I.lintIdsForCommand('node --check src/a.ts').length === 0 &&
  I.lintIdsForCommand('node --check src/a.py').length === 0 &&
  I.lintIdsForCommand('node --test src/a.test.js').length === 0 &&
  I.lintIdsForCommand('node -e "console.log(1)"').length === 0 &&
  I.lintIdsForCommand('node --check').length === 0)
// 2026-09-09：命令包装前缀（timeout/env/VAR=/nice）不得让真实测试/lint 漏记；
// 未知复杂 shell 形态保守不记；echo/printf/grep 引用测试命令不得造成假 green。
await ok('前缀归一：timeout/env/VAR=/nice 后仍识别测试命令',
  I.isTestCommand('timeout 120 node --test x.test.js') &&
  I.isTestCommand('timeout -k 5 120 node --test x.test.js') &&
  I.isTestCommand('timeout --preserve-status 60 npm test') &&
  I.isTestCommand('env FOO=1 node --test x.test.js') &&
  I.isTestCommand('env -i FOO=1 BAR=2 node --test x.test.js') &&
  I.isTestCommand('FOO=1 node --test x.test.js') &&
  I.isTestCommand('FOO=1 BAR=2 node --test x.test.js') &&
  I.isTestCommand('nice -n 10 node --test x.test.js') &&
  I.isTestCommand('nice -10 node --test x.test.js') &&
  I.isTestCommand('timeout 60 env FOO=1 nice -n 5 node --test x.test.js') &&
  I.isTestCommand('cd dsh/preset/plugins && timeout 120 node --test kix-browser.test.js') &&
  I.isTestCommand('timeout 120 npm test') && I.isTestCommand('timeout 60 pytest -q') &&
  I.isTestCommand('timeout 60 cargo test'))
await ok('前缀归一：verification/lint/git commit 同样受益',
  I.isVerificationCommand('timeout 60 go test ./...') &&
  I.isVerificationCommand('FOO=1 npm run lint') &&
  I.isVerificationCommand('nice -n 5 tsc --noEmit') &&
  I.lintIdsForCommand('timeout 60 npx eslint src/a.js').includes('js') &&
  I.lintIdsForCommand('FOO=1 node --check src/a.js').join(',') === 'js' &&
  I.lintIdsForCommand('env X=1 node --check src/a.cjs').join(',') === 'js' &&
  I.isGitCommitCommand('FOO=1 git commit -m x') &&
  I.isGitCommitCommand('timeout 60 git commit -m x'))
await ok('前缀归一保守：未知/复杂 shell 形态不记，echo/printf/grep 引用不假 green',
  !I.isTestCommand('echo node --test x.test.js') &&
  !I.isTestCommand("printf 'node --test x.test.js\\n'") &&
  !I.isTestCommand('grep -rn "node --test" .') &&
  !I.isTestCommand('bash -c "node --test x.test.js"') &&
  !I.isTestCommand('xargs node --test') &&
  !I.isTestCommand('sudo node --test x.test.js') &&
  !I.isTestCommand('timeout abc node --test x.test.js') &&
  !I.isTestCommand('timeout node --test x.test.js') &&
  !I.isTestCommand('FOO=1 echo node --test x.test.js') &&
  !I.isVerificationCommand('echo go test ./...') &&
  I.lintIdsForCommand('echo "node --check a.js"').length === 0 &&
  I.lintIdsForCommand('grep node --check a.js').length === 0 &&
  I.lintIdsForCommand("printf 'node --check a.js'").length === 0 &&
  !I.isGitCommitCommand('echo git commit -m x') &&
  !I.isGitCommitCommand('grep "git commit" file'))
await ok('前缀归一：纯函数可单测（normalizeCommandText 导出）',
  typeof I.normalizeCommandText === 'function' &&
  I.normalizeCommandText('timeout 120 node --test x.js') === 'node --test x.js' &&
  I.normalizeCommandText('a && FOO=1 npm test') === 'a && npm test' &&
  I.normalizeCommandText('echo node --test x.js') === 'echo node --test x.js')
await ok('isGitCommitCommand: 普通 commit', I.isGitCommitCommand('git commit -m x') && I.isGitCommitCommand('git -C /tmp commit -m x'))
await ok('isGitCommitCommand 否定: commit-tree/echo/status', !I.isGitCommitCommand('git commit-tree HEAD') && !I.isGitCommitCommand('echo git commit') && !I.isGitCommitCommand('git status'))
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
createdTmpDirs.push(tmpRoot)
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
await ok('spec 工具落盘失败不得 ok:true', (async () => {
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-disc-nosave-'))
  const notDir = path.join(blocked, 'not-a-dir')
  fs.writeFileSync(notDir, 'x')
  const specTool = registeredTools.find((t) => t.name === 'kix_discipline_spec')
  const r = await specTool.execute(fullSpec, {
    name: 'kix_discipline_spec',
    arguments: fullSpec,
    token: 't',
    callId: 'nosave',
    agent: { id: 'g-nosave', session: { header: { cwd: notDir } } },
  })
  fs.rmSync(blocked, { recursive: true, force: true })
  return r && r.ok === false && r.saved === false && typeof r.error === 'string'
})())
await ok('ctx.fs 写失败回退 node:fs 仍落盘', (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-disc-fs-fallback-'))
  const mockIo = {
    async readText() { return undefined },
    async writeText() { throw new Error('sandbox deny') },
  }
  const st = I.makeState({ sessionKey: 's-fallback', workspaceRoot: root, io: mockIo })
  const saved = await st.saveSpec(fullSpec)
  const onDisk = fs.existsSync(path.join(root, I.SPEC_DIRNAME, I.SPEC_FILENAME))
  fs.rmSync(root, { recursive: true, force: true })
  return saved === true && onDisk
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
// 真实工具生命周期：pre（放行）+ post（落盘）都派发。lint need 由落盘编辑记账。
// edit 的 canonical value 是 { path, before, after }（dsh-tool-fs）。
async function editLanded(agentId, filePath) {
  await dispatchPreAs('edit', { file_path: filePath }, agentId)
  return dispatchPostAs('edit', { file_path: filePath }, { isError: false, value: { path: filePath, before: '', after: '' } }, agentId)
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
await ok('测试运行成功（foreground exitCode 0）→ green 记录（turnTests=1）', (async () => {
  const agentId = 'green-record'
  await editLanded(agentId, 'src/green-record.c')
  const d = await dispatchPostAs('bash', { command: 'pnpm test' }, fg(0), agentId)
  const status = await registeredCommands.find((c) => c.name === 'kix-discipline').handler({
    agent: { id: agentId, session: { header: sessionHeader } }, rawInput: 'status',
  })
  return d.kind === 'accept' && /turnTests: 1/.test(status.text)
})())
await ok('测试运行失败（isError / 非零 exitCode）→ 不记录 green', (async () => {
  const errored = 'green-error'
  await editLanded(errored, 'src/green-error.c')
  await dispatchPostAs('bash', { command: 'pnpm test' }, { isError: true, error: { name: 'HarnessError', code: 'X', message: 'boom' }, content: [] }, errored)
  const nonzero = 'green-nonzero'
  await editLanded(nonzero, 'src/green-nonzero.c')
  await dispatchPostAs('bash', { command: 'pnpm test' }, fg(1), nonzero)
  const statusOf = async (id) => (await registeredCommands.find((c) => c.name === 'kix-discipline').handler({
    agent: { id, session: { header: sessionHeader } }, rawInput: 'status',
  })).text
  return /turnTests: 0/.test(await statusOf(errored)) && /turnTests: 0/.test(await statusOf(nonzero))
})())
await ok('pendingRemind 注入 additionalContexts', (async () => {
  // 新会话触发 red remind（pre → 置 pendingRemind），再 post → 注入
  await dispatchPreAs('edit', { file_path: 'src/d.ts' }, 'g6')
  const d = await dispatchPostAs('edit', { file_path: 'src/d.ts' }, { isError: false }, 'g6')
  return d.kind === 'accept' && Array.isArray(d.additionalContexts) && d.additionalContexts.length === 1
})())

// ── 4b. canonical 执行证据（2026-09-09 缺陷修复回归）──────────────────────
// 旧实现 discipline:644 `const ok = result && !result.isError` 把非零 bash
// exitCode 与后台 spawn 都记为 green/lint 证据。以下按真实 canonical 形状
// （foreground exitCode / background jobId / job_output 终态）钉死判定。
section('canonical 执行证据')
await ok('非零 exitCode 的测试命令不计 green', (async () => {
  await editLanded('ev-exit1', 'src/ev1.c')
  await dispatchPostAs('bash', { command: 'npm test' }, fg(1), 'ev-exit1')
  await dispatchTurnAs('ev-exit1')
  return turnTexts().some((t) => GREEN_RE.test(t))
})())
await ok('exitCode 0 的测试命令计 green（无 green 提醒）', (async () => {
  await editLanded('ev-exit0', 'src/ev2.c')
  await dispatchPostAs('bash', { command: 'npm test' }, fg(0), 'ev-exit0')
  await dispatchTurnAs('ev-exit0')
  return !turnTexts().some((t) => GREEN_RE.test(t))
})())
await ok('timedOut / aborted / sandbox.denied 不计 green', (async () => {
  const cases = [
    ['ev-timeout', { timedOut: true }],
    ['ev-aborted', { aborted: true }],
    ['ev-denied', { sandbox: { mode: 'workspace-write', denied: true } }],
  ]
  for (const [id, extra] of cases) {
    await editLanded(id, 'src/' + id + '.c')
    await dispatchPostAs('bash', { command: 'npm test' }, fg(0, extra), id)
    await dispatchTurnAs(id)
    if (!turnTexts().some((t) => GREEN_RE.test(t))) return false
  }
  return true
})())
await ok('包装 value（{ok:true,result:{…}}）仍按 canonical 形状判定', (async () => {
  await editLanded('ev-wrapped-red', 'src/evw1.c')
  await dispatchPostAs('bash', { command: 'npm test' }, { isError: false, value: { ok: true, result: fg(1).value } }, 'ev-wrapped-red')
  await dispatchTurnAs('ev-wrapped-red')
  if (!turnTexts().some((t) => GREEN_RE.test(t))) return false
  await editLanded('ev-wrapped-green', 'src/evw2.c')
  await dispatchPostAs('bash', { command: 'npm test' }, { isError: false, value: { ok: true, result: fg(0).value } }, 'ev-wrapped-green')
  await dispatchTurnAs('ev-wrapped-green')
  return !turnTexts().some((t) => GREEN_RE.test(t))
})())
await ok('未知结果形状（无 canonical value）不计 green', (async () => {
  await editLanded('ev-unknown', 'src/ev3.c')
  await dispatchPostAs('bash', { command: 'npm test' }, { isError: false }, 'ev-unknown')
  await dispatchTurnAs('ev-unknown')
  return turnTexts().some((t) => GREEN_RE.test(t))
})())
await ok('后台启动（jobId）本身不计 green', (async () => {
  await editLanded('ev-bg-start', 'src/ev4.c')
  await dispatchPostAs('bash', { command: 'go test ./...' }, bg('ev-job-1'), 'ev-bg-start')
  await dispatchTurnAs('ev-bg-start')
  return turnTexts().some((t) => GREEN_RE.test(t))
})())
await ok('后台 job 终态 completed exit code 0 计 green', (async () => {
  await editLanded('ev-bg-green', 'src/ev5.c')
  await dispatchPostAs('bash', { command: 'go test ./...' }, bg('ev-job-2'), 'ev-bg-green')
  await dispatchPostAs('job_output', { job_id: 'ev-job-2' }, jobRes('ev-job-2', 'completed', 'exit code: 0'), 'ev-bg-green')
  await dispatchTurnAs('ev-bg-green')
  return !turnTexts().some((t) => GREEN_RE.test(t))
})())
await ok('后台 job failed/killed/非零/running/未知状态不计 green', (async () => {
  const cases = [
    ['failed', 'boom'],
    ['killed', 'signal: SIGKILL'],
    ['completed', 'exit code: 2'],
    ['running', undefined],
    ['stopping', undefined],
  ]
  for (let i = 0; i < cases.length; i++) {
    const id = 'ev-bg-bad-' + i
    const jobId = 'ev-job-bad-' + i
    await editLanded(id, 'src/' + id + '.c')
    await dispatchPostAs('bash', { command: 'go test ./...' }, bg(jobId), id)
    await dispatchPostAs('job_output', { job_id: jobId }, jobRes(jobId, cases[i][0], cases[i][1]), id)
    await dispatchTurnAs(id)
    if (!turnTexts().some((t) => GREEN_RE.test(t))) return false
  }
  return true
})())
await ok('旧 job 在新编辑后完成不计 green（generation 过期）', (async () => {
  await editLanded('ev-stale-job', 'src/ev6.c')
  await dispatchPostAs('bash', { command: 'go test ./...' }, bg('ev-job-3'), 'ev-stale-job')
  await editLanded('ev-stale-job', 'src/ev7.c')
  await dispatchPostAs('job_output', { job_id: 'ev-job-3' }, jobRes('ev-job-3', 'completed', 'exit code: 0'), 'ev-stale-job')
  await dispatchTurnAs('ev-stale-job')
  return turnTexts().some((t) => GREEN_RE.test(t))
})())
await ok('测试成功后再编辑 → green 证据过期', (async () => {
  await editLanded('ev-stale-green', 'src/ev8.c')
  await dispatchPostAs('bash', { command: 'npm test' }, fg(0), 'ev-stale-green')
  await editLanded('ev-stale-green', 'src/ev9.c')
  await dispatchTurnAs('ev-stale-green')
  return turnTexts().some((t) => GREEN_RE.test(t))
})())
await ok('lint 非零 exitCode 不计 lint ran', (async () => {
  await editLanded('ev-lint-red', 'src/ev10.ts')
  await dispatchPostAs('bash', { command: 'npx eslint src/ev10.ts' }, fg(1), 'ev-lint-red')
  await dispatchTurnAs('ev-lint-red')
  return turnTexts().some((t) => LINT_RE.test(t))
})())
await ok('lint exitCode 0 计 lint ran', (async () => {
  await editLanded('ev-lint-green', 'src/ev11.ts')
  await dispatchPostAs('bash', { command: 'npx eslint src/ev11.ts' }, fg(0), 'ev-lint-green')
  await dispatchTurnAs('ev-lint-green')
  return !turnTexts().some((t) => LINT_RE.test(t))
})())
await ok('lint 后再编辑 → lint 证据过期', (async () => {
  await editLanded('ev-lint-stale', 'src/ev12.ts')
  await dispatchPostAs('bash', { command: 'npx eslint src/ev12.ts' }, fg(0), 'ev-lint-stale')
  await editLanded('ev-lint-stale', 'src/ev13.ts')
  await dispatchTurnAs('ev-lint-stale')
  return turnTexts().some((t) => LINT_RE.test(t))
})())
await ok('后台 lint job 终态 exit code 0 计 lint ran', (async () => {
  await editLanded('ev-lint-bg', 'src/ev14.ts')
  await dispatchPostAs('bash', { command: 'npm run lint' }, bg('ev-job-4'), 'ev-lint-bg')
  await dispatchPostAs('job_output', { job_id: 'ev-job-4' }, jobRes('ev-job-4', 'completed', 'exit code: 0'), 'ev-lint-bg')
  await dispatchTurnAs('ev-lint-bg')
  return !turnTexts().some((t) => LINT_RE.test(t))
})())
await ok('未登记的 job 终态不计 green（不猜来源）', (async () => {
  await editLanded('ev-unregistered', 'src/ev16.c')
  await dispatchPostAs('job_output', { job_id: 'ev-job-unknown' }, jobRes('ev-job-unknown', 'completed', 'exit code: 0'), 'ev-unregistered')
  await dispatchTurnAs('ev-unregistered')
  return turnTexts().some((t) => GREEN_RE.test(t))
})())
await ok('构建/检查命令不伪装成测试（go build/vet 不计 green）', (async () => {
  await editLanded('ev-build', 'src/ev15.c')
  await dispatchPostAs('bash', { command: 'go build ./... && go vet ./...' }, fg(0), 'ev-build')
  await dispatchTurnAs('ev-build')
  return turnTexts().some((t) => GREEN_RE.test(t))
})())
await ok('node --check 成功计 JS 语法证据（本仓实际 gate）', (async () => {
  await editLanded('ev-check-js', 'src/ev17.js')
  await dispatchPostAs('bash', { command: 'node --check src/ev17.js' }, fg(0), 'ev-check-js')
  await dispatchTurnAs('ev-check-js')
  return !turnTexts().some((t) => LINT_RE.test(t))
})())
await ok('node -c 成功同样计 JS 语法证据', (async () => {
  await editLanded('ev-check-cjs', 'src/ev18.cjs')
  await dispatchPostAs('bash', { command: 'node -c src/ev18.cjs' }, fg(0), 'ev-check-cjs')
  await dispatchTurnAs('ev-check-cjs')
  return !turnTexts().some((t) => LINT_RE.test(t))
})())
await ok('node --check 非零 exitCode 不计 JS 语法证据', (async () => {
  await editLanded('ev-check-red', 'src/ev19.js')
  await dispatchPostAs('bash', { command: 'node --check src/ev19.js' }, fg(1), 'ev-check-red')
  await dispatchTurnAs('ev-check-red')
  return turnTexts().some((t) => LINT_RE.test(t))
})())
await ok('node --check .ts 不是 JS 语法证据（不冒充 typecheck）', (async () => {
  await editLanded('ev-check-ts', 'src/ev20.ts')
  await dispatchPostAs('bash', { command: 'node --check src/ev20.ts' }, fg(0), 'ev-check-ts')
  await dispatchTurnAs('ev-check-ts')
  return turnTexts().some((t) => LINT_RE.test(t))
})())
await ok('node --check 先检查后编辑 → 过期不计', (async () => {
  await dispatchPostAs('bash', { command: 'node --check src/ev21.js' }, fg(0), 'ev-check-stale')
  await editLanded('ev-check-stale', 'src/ev21.js')
  await dispatchTurnAs('ev-check-stale')
  return turnTexts().some((t) => LINT_RE.test(t))
})())
// 2026-09-09：包装前缀下的真实测试必须计 green（旧实现漏记：`timeout 120 node --test`）
await ok('timeout 前缀的真实测试命令计 green（不再漏记）', (async () => {
  await editLanded('ev-timeout-prefix', 'src/ev28.c')
  await dispatchPostAs('bash', { command: 'timeout 120 node --test src/ev28.test.c' }, fg(0), 'ev-timeout-prefix')
  await dispatchTurnAs('ev-timeout-prefix')
  return !turnTexts().some((t) => GREEN_RE.test(t))
})())
await ok('env/VAR= 前缀的真实测试命令计 green', (async () => {
  await editLanded('ev-env-prefix', 'src/ev29.c')
  await dispatchPostAs('bash', { command: 'FOO=1 node --test src/ev29.test.c' }, fg(0), 'ev-env-prefix')
  await dispatchTurnAs('ev-env-prefix')
  return !turnTexts().some((t) => GREEN_RE.test(t))
})())
await ok('echo 引用测试命令不构成 green（假 green 反例）', (async () => {
  await editLanded('ev-echo-fake', 'src/ev30.c')
  await dispatchPostAs('bash', { command: 'echo node --test src/ev30.test.c' }, fg(0), 'ev-echo-fake')
  await dispatchTurnAs('ev-echo-fake')
  return turnTexts().some((t) => GREEN_RE.test(t))
})())
// TS 与 JS 语法证据分桶：node --check *.js 不能补 .ts 的类型/语法检查缺口
await ok('*.ts 编辑 + node --check x.js 不清 lint 缺口', (async () => {
  await editLanded('ev-ts-js-check', 'src/ev31.ts')
  await dispatchPostAs('bash', { command: 'node --check src/other.js' }, fg(0), 'ev-ts-js-check')
  await dispatchTurnAs('ev-ts-js-check')
  return turnTexts().some((t) => LINT_RE.test(t))
})())
await ok('*.ts 编辑 + npx tsc --noEmit 清 lint 缺口（TS 有对应检查）', (async () => {
  await editLanded('ev-ts-tsc', 'src/ev32.ts')
  await dispatchPostAs('bash', { command: 'npx tsc --noEmit' }, fg(0), 'ev-ts-tsc')
  await dispatchTurnAs('ev-ts-tsc')
  return !turnTexts().some((t) => LINT_RE.test(t))
})())
await ok('*.js 编辑 + node --check x.js 仍清 JS 语法缺口（对照）', (async () => {
  await editLanded('ev-js-check-ok', 'src/ev33.js')
  await dispatchPostAs('bash', { command: 'node --check src/ev33.js' }, fg(0), 'ev-js-check-ok')
  await dispatchTurnAs('ev-js-check-ok')
  return !turnTexts().some((t) => LINT_RE.test(t))
})())

// ── 4c. 编辑记账只在落盘成功后（2026-09-09 缺陷修复）────────────────────────
// 旧实现 pre-execute 即 `turnEdits++`：被沙箱拒绝/失败的 source edit 也算
// 「本回合有实现编辑」，并让 green/lint 证据过期。记账改为 post 成功后才发生。
section('编辑记账只在落盘成功')
await ok('失败的 source edit 不计本回合实现编辑（无 green/lint 提醒）', (async () => {
  await dispatchPreAs('edit', { file_path: 'src/failed-edit.js' }, 'ev-failed-edit')
  await dispatchPostAs('edit', { file_path: 'src/failed-edit.js' }, { isError: true, error: { name: 'HarnessError', code: 'E', message: 'sandbox deny' }, content: [] }, 'ev-failed-edit')
  await dispatchTurnAs('ev-failed-edit')
  return turnTexts().length === 0
})())
await ok('仅 pre 的 source edit（被 deny，无 post 派发）不计', (async () => {
  await dispatchPreAs('edit', { file_path: 'src/denied-edit.js' }, 'ev-denied-edit')
  await dispatchTurnAs('ev-denied-edit')
  return turnTexts().length === 0
})())
await ok('失败的 source edit 不让 green 证据过期', (async () => {
  await editLanded('ev-failed-after-green', 'src/ev22.c')
  await dispatchPostAs('bash', { command: 'npm test' }, fg(0), 'ev-failed-after-green')
  await dispatchPostAs('edit', { file_path: 'src/ev23.c' }, { isError: true, error: { name: 'HarnessError', code: 'E', message: 'denied' }, content: [] }, 'ev-failed-after-green')
  await dispatchTurnAs('ev-failed-after-green')
  return turnTexts().length === 0
})())
await ok('失败的 source edit 不让 lint 证据过期', (async () => {
  await editLanded('ev-failed-after-lint', 'src/ev24.ts')
  await dispatchPostAs('bash', { command: 'npm test' }, fg(0), 'ev-failed-after-lint')
  await dispatchPostAs('bash', { command: 'npx eslint src/ev24.ts' }, fg(0), 'ev-failed-after-lint')
  await dispatchPostAs('edit', { file_path: 'src/ev25.ts' }, { isError: true, error: { name: 'HarnessError', code: 'E', message: 'denied' }, content: [] }, 'ev-failed-after-lint')
  await dispatchTurnAs('ev-failed-after-lint')
  return turnTexts().length === 0
})())
await ok('成功 edit 仍让旧 green 证据过期（对照）', (async () => {
  await editLanded('ev-ok-after-green', 'src/ev26.c')
  await dispatchPostAs('bash', { command: 'npm test' }, fg(0), 'ev-ok-after-green')
  await editLanded('ev-ok-after-green', 'src/ev27.c')
  await dispatchTurnAs('ev-ok-after-green')
  return turnTexts().some((t) => GREEN_RE.test(t))
})())

// ── 5. turn-stopping：green 提醒 ──────────────────────────────────────────
section('turn-stopping')
await ok('有实现 edit 无测试 → steer 提醒', (async () => {
  await editLanded('g7', 'src/e.ts')
  await dispatchTurnAs('g7')
  return steered.length === 2 && turnTexts().some((t) => /测试未通过/.test(t)) && turnTexts().some((t) => /语法检查/.test(t))
})())
await ok('有实现 edit 且有测试+lint → 不提醒', (async () => {
  await editLanded('g8', 'src/f.ts')
  await dispatchPostAs('bash', { command: 'npm test' }, fg(0), 'g8')
  await dispatchPostAs('bash', { command: 'npx eslint src/f.ts' }, fg(0), 'g8')
  await dispatchTurnAs('g8')
  return steered.length === 0
})())
await ok('无实现 edit → 不提醒', (async () => {
  await dispatchTurnAs('no-edit')
  return steered.length === 0
})())
await ok('remindOnce：同会话第二次不重复提醒', (async () => {
  await editLanded('g9', 'src/g.ts')
  await dispatchTurnAs('g9')
  const first = steered.length
  await editLanded('g9', 'src/h.ts')
  await dispatchTurnAs('g9')
  return first === 2 && steered.length === 0
})())
await ok('双重计数回归：pre-execute 测试命令不计数，被拦/失败测试不构成 green（审查修复）', (async () => {
  // 测试命令经 pre-execute(不再 +1) → 无 post-execute 成功 → turnTests=0
  await dispatchPreAs('bash', { command: 'npm test' }, 'dup-test')
  await editLanded('dup-test', 'src/dup.ts')
  // 被拦:post-execute isError → 不计数
  await dispatchPostAs('bash', { command: 'npm test' }, { isError: true, error: { name: 'HarnessError', code: 'X', message: 'blocked' }, content: [] }, 'dup-test')
  await dispatchTurnAs('dup-test')
  return steered.length === 2 // green + lint；测试未成功运行必须提醒
})())
await ok('双重计数回归：成功测试仍计 1 次（非 2）', (async () => {
  await editLanded('ok-test', 'src/ok.ts')
  await dispatchPostAs('bash', { command: 'npm test' }, fg(0), 'ok-test')
  await dispatchPostAs('bash', { command: 'npx eslint src/ok.ts' }, fg(0), 'ok-test')
  await dispatchTurnAs('ok-test')
  return steered.length === 0 // 成功测试+lint=不提醒
})())
section('language lint gate')
await ok('rust 只跑 cargo test → 仍提醒 fmt/clippy', (async () => {
  await editLanded('lint-rs-test', 'src/main.rs')
  await dispatchPostAs('bash', { command: 'cargo test' }, fg(0), 'lint-rs-test')
  await dispatchTurnAs('lint-rs-test')
  return steered.length === 1 && turnTexts().some((t) => /rust-fmt/.test(t) && /rust-clippy/.test(t) && /cargo test/.test(t))
})())
await ok('rust 只跑 fmt → 仍提醒 clippy', (async () => {
  await editLanded('lint-rs-fmt', 'src/lib.rs')
  await dispatchPostAs('bash', { command: 'cargo fmt --check' }, fg(0), 'lint-rs-fmt')
  await dispatchPostAs('bash', { command: 'cargo test' }, fg(0), 'lint-rs-fmt')
  await dispatchTurnAs('lint-rs-fmt')
  return steered.length === 1 && turnTexts().some((t) => /rust-clippy/.test(t) && !/rust-fmt/.test(t))
})())
await ok('rust fmt+clippy+test → 不提醒', (async () => {
  await editLanded('lint-rs-ok', 'src/ok.rs')
  await dispatchPostAs('bash', { command: 'cargo fmt --check && cargo clippy -D warnings && cargo test' }, fg(0), 'lint-rs-ok')
  await dispatchTurnAs('lint-rs-ok')
  return steered.length === 0
})())
await ok('git commit 漏 lint → allow + 注入提醒（不 deny）', (async () => {
  await editLanded('lint-commit', 'src/c.rs')
  const pre = await dispatchPreAs('bash', { command: 'git commit -m x' }, 'lint-commit')
  const post = await dispatchPostAs('bash', { command: 'git commit -m x' }, fg(0), 'lint-commit')
  const texts = ((post && post.additionalContexts) || []).map((m) => (m.content && m.content[0] && m.content[0].text) || '')
  return pre.kind === 'allow' && post.kind === 'accept' && texts.some((t) => /语法检查/.test(t))
})())
await ok('git commit 已跑 lint → 不注入', (async () => {
  await editLanded('lint-commit-ok', 'src/d.rs')
  await dispatchPostAs('bash', { command: 'cargo fmt --check' }, fg(0), 'lint-commit-ok')
  await dispatchPostAs('bash', { command: 'cargo clippy -D warnings' }, fg(0), 'lint-commit-ok')
  const pre = await dispatchPreAs('bash', { command: 'git commit -m x' }, 'lint-commit-ok')
  const post = await dispatchPostAs('bash', { command: 'git commit -m x' }, fg(0), 'lint-commit-ok')
  const extras = (post && post.additionalContexts) || []
  return pre.kind === 'allow' && extras.length === 0
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
  await editLanded('dv4', 'src/deflect.ts')
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
cleanupTmpDirs()
console.log('\n──────────────────────────────')
console.log(`kix-discipline: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); cleanupTmpDirs(); process.exit(1) })
