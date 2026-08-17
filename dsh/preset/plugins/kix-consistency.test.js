// kix-consistency 回归测试（2026-08-17，P5）
//
// 单元级验证：加载 kix-consistency.js，mock DSH pre-execute / post-execute 派发，覆盖：
//   - 纯逻辑（__internals）：isRepoRoot / classifyWrite / pickChecks
//   - lib 判定：estimateTokens / checkFilesEqual / checkPluginPair（临时文件夹具）
//   - pre-execute 写时拦截：remind（放行+待注入）/ block（deny）/ 非 preset 路径放行 /
//     非源仓库放行
//   - post-execute：remind 注入 + remindOnce 每类别一次
// 运行：node plugins/kix-consistency.test.js

const path = require('node:path')
const assert = require('node:assert')
const os = require('node:os')
const fs = require('node:fs')

// ── mock ctx（sandboxPolicy.workspaceRoot 动态指向当前夹具）───────────────
const listeners = {}
let workspaceRootMock = null
const configMock = { intensity: 'remind' }
const ctx = {
  config: configMock,
  logger: { info() {}, warn() {}, error() {} },
  get(name) {
    if (name === 'sandboxPolicy') {
      return {
        workspaceRoot: workspaceRootMock,
        resolve(req) {
          const cwd = req && req.session && req.session.header && req.session.header.cwd
          return { workspaceRoot: cwd || workspaceRootMock }
        },
      }
    }
    return undefined
  },
  on(event, cb) {
    ;(listeners[event] ||= []).push(cb)
  },
  effect() {},
}
ctx.tools = { register() { return () => {} } }
ctx.commands = { register() { return () => {} } }

// ── 加载被测试插件 ────────────────────────────────────────────────────────
const plugin = require(path.join(__dirname, 'kix-consistency.js'))
assert.strictEqual(plugin.name, 'kix-consistency')
plugin.apply(ctx, configMock)
const preExecute = listeners['tools/pre-execute']
const postExecute = listeners['tools/post-execute']
assert.ok(Array.isArray(preExecute) && preExecute.length === 1, 'pre-execute 监听器已注册')
assert.ok(Array.isArray(postExecute) && postExecute.length === 1, 'post-execute 监听器已注册')

const I = plugin.__internals
const lib = require(path.join(__dirname, 'consistency-lib.cjs'))

// ── block 强度独立实例（同 kix-orchestration.test.js：apply 快照 intensity）─
const blockListeners = {}
const ctxBlock = {
  config: { intensity: 'block' },
  logger: { info() {}, warn() {}, error() {} },
  get(name) {
    if (name === 'sandboxPolicy') {
      return {
        workspaceRoot: workspaceRootMock,
        resolve(req) {
          const cwd = req && req.session && req.session.header && req.session.header.cwd
          return { workspaceRoot: cwd || workspaceRootMock }
        },
      }
    }
    return undefined
  },
  on(event, cb) {
    ;(blockListeners[event] ||= []).push(cb)
  },
  effect() {},
  tools: { register() { return () => {} } },
  commands: { register() { return () => {} } },
}
plugin.apply(ctxBlock, { intensity: 'block' })

// ── 夹具（统一登记，文件末尾统一删除——不泄漏 /tmp 目录）─────────────────
const created = []
function mkdtemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  created.push(dir)
  return dir
}
function makeRepoRoot() {
  const root = mkdtemp('kix-cons-test-repo-')
  const write = (rel, content) => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content, 'utf8')
  }
  // 源仓库指纹三件套（内容最小化；persona 检查在单独用例中造合法块）
  write('dsh/preset/agent.cordis.yml', 'text: |-\n  x\n')
  write('en/preset/agent.cordis.yml', 'text: |-\n  x\n')
  write('scripts/check-dsh-consistency.cjs', '#!/usr/bin/env node\n')
  return root
}

let passed = 0
let failed = 0
async function ok(label, cond) {
  const okk = await cond
  if (okk) { passed++ } else { failed++ }
  console.log(`${okk ? 'PASS' : 'FAIL'}  ${label}`)
}
function section(title) { console.log('\n── ' + title + ' ──') }

// ── mock exec 构造 ────────────────────────────────────────────────────────
let callSeq = 0
function makeExec(tool, relPath, callId) {
  return {
    name: tool,
    callId: callId !== undefined ? callId : 'c' + (++callSeq),
    arguments: { file_path: relPath },
  }
}
function makePostExec(callId) {
  return { name: 'write', callId }
}

// ══════════════════════════════════════════════════════════════════════════
;(async () => {
  section('__internals: isRepoRoot')
  const repo = makeRepoRoot()
  await ok('指纹齐全 → true', I.isRepoRoot(repo))
  const noEn = makeRepoRoot()
  fs.rmSync(path.join(noEn, 'en/preset/agent.cordis.yml'))
  await ok('缺 en/preset → false', I.isRepoRoot(noEn) === false)
  await ok('null → false', I.isRepoRoot(null) === false)
  await ok('undefined → false', I.isRepoRoot(undefined) === false)
  const plain = mkdtemp('kix-cons-test-plain-')
  await ok('普通工作区 → false', I.isRepoRoot(plain) === false)

  section('__internals: classifyWrite')
  await ok('zh agent.cordis.yml → persona', I.classifyWrite('dsh/preset/agent.cordis.yml') === 'persona')
  await ok('en agent.cordis.yml → persona', I.classifyWrite('en/preset/agent.cordis.yml') === 'persona')
  await ok('zh 插件源码 → plugins', I.classifyWrite('dsh/preset/plugins/kix-x.js') === 'plugins')
  await ok('en 插件测试 → plugins', I.classifyWrite('en/preset/plugins/kix-x.test.js') === 'plugins')
  await ok('memories → memories', I.classifyWrite('dsh/preset/memories/ai-agent-practices.md') === 'memories')
  await ok('README.md → readme', I.classifyWrite('README.md') === 'readme')
  await ok('README.en.md → readme', I.classifyWrite('README.en.md') === 'readme')
  await ok('package.json → package', I.classifyWrite('package.json') === 'package')
  await ok('vision-bridge → vision', I.classifyWrite('dsh/vision-bridge/index.js') === 'vision')
  await ok('额外身份副本（VS Code 根）→ plugins', I.classifyWrite('plugins/kix-guards.js') === 'plugins')
  await ok('普通源码 → null', I.classifyWrite('src/main.js') === null)
  await ok('windows 反斜杠路径 → plugins', I.classifyWrite('dsh\\preset\\plugins\\kix-x.js') === 'plugins')
  await ok('空 → null', I.classifyWrite('') === null)

  section('__internals: pickChecks')
  const srcChecks = I.pickChecks(repo, 'dsh/preset/plugins/kix-x.js')
  await ok('写插件源码 → pair + 语法 2 检查', srcChecks.length === 2)
  const extraChecks = I.pickChecks(repo, 'plugins/kix-guards.js')
  await ok('写额外身份副本 → pair + 语法 2 检查', extraChecks.length === 2)
  const testChecks = I.pickChecks(repo, 'dsh/preset/plugins/kix-x.test.js')
  await ok('写插件测试 → 仅 pair 1 检查', testChecks.length === 1)
  const personaChecks = I.pickChecks(repo, 'dsh/preset/agent.cordis.yml')
  await ok('写 persona → 1 检查', personaChecks.length === 1)
  await ok('非 preset → 0 检查', I.pickChecks(repo, 'src/main.js').length === 0)

  section('lib: estimateTokens / checkFilesEqual / checkPluginPair')
  await ok('estimateTokens 空 → 0', lib.estimateTokens('') === 0)
  await ok('estimateTokens 英文词 > 0', lib.estimateTokens('hello world foo bar') > 0)
  await ok('estimateTokens 中文 > 0', lib.estimateTokens('规则是负债的自我应用') > 0)
  const pairRoot = mkdtemp('kix-cons-test-pair-')
  fs.mkdirSync(path.join(pairRoot, 'dsh/preset/plugins'), { recursive: true })
  fs.mkdirSync(path.join(pairRoot, 'en/preset/plugins'), { recursive: true })
  fs.writeFileSync(path.join(pairRoot, 'dsh/preset/plugins/a.js'), 'A', 'utf8')
  fs.writeFileSync(path.join(pairRoot, 'en/preset/plugins/a.js'), 'A', 'utf8')
  const same = lib.checkFilesEqual({ root: pairRoot, a: 'dsh/preset/plugins/a.js', b: 'en/preset/plugins/a.js', label: 'a.js' })
  await ok('字节一致 → 无 failure', same.failures.length === 0)
  fs.writeFileSync(path.join(pairRoot, 'en/preset/plugins/a.js'), 'B', 'utf8')
  const diff = lib.checkFilesEqual({ root: pairRoot, a: 'dsh/preset/plugins/a.js', b: 'en/preset/plugins/a.js', label: 'a.js' })
  await ok('字节不一致 → failure', diff.failures.length === 1)
  const pair1 = lib.checkPluginPair({ root: pairRoot, name: 'a.js' })
  await ok('插件对不一致 → failure', pair1.failures.length === 1)
  fs.writeFileSync(path.join(pairRoot, 'en/preset/plugins/a.js'), 'A', 'utf8')
  const pair2 = lib.checkPluginPair({ root: pairRoot, name: 'a.js' })
  await ok('插件对一致且双侧无 test → note 跳过', pair2.failures.length === 0 && pair2.notes.some((n) => n.includes('skipped')))
  fs.writeFileSync(path.join(pairRoot, 'dsh/preset/plugins/a.test.js'), 'T', 'utf8')
  const pair3 = lib.checkPluginPair({ root: pairRoot, name: 'a.js' })
  await ok('test 单侧存在 → failure（en 缺 test）', pair3.failures.length === 1)

  section('lib: checkIdenticalSet（该相同的数份必须相同）')
  const nRoot = mkdtemp('kix-cons-test-nset-')
  fs.mkdirSync(path.join(nRoot, 'dsh/preset/plugins'), { recursive: true })
  fs.mkdirSync(path.join(nRoot, 'en/preset/plugins'), { recursive: true })
  fs.mkdirSync(path.join(nRoot, 'plugins'), { recursive: true })
  fs.writeFileSync(path.join(nRoot, 'dsh/preset/plugins/kix-guards.js'), 'G', 'utf8')
  fs.writeFileSync(path.join(nRoot, 'en/preset/plugins/kix-guards.js'), 'G', 'utf8')
  fs.writeFileSync(path.join(nRoot, 'plugins/kix-guards.js'), 'G', 'utf8')
  const n3 = lib.checkIdenticalSet({
    root: nRoot,
    paths: ['dsh/preset/plugins/kix-guards.js', 'en/preset/plugins/kix-guards.js', 'plugins/kix-guards.js'],
    label: 'plugins/kix-guards.js',
  })
  await ok('3 份相同 → 无 failure', n3.failures.length === 0 && n3.notes.some((n) => n.includes('3 copies')))
  fs.writeFileSync(path.join(nRoot, 'plugins/kix-guards.js'), 'DRIFT', 'utf8')
  const n3d = lib.checkPluginPair({ root: nRoot, name: 'kix-guards.js' })
  await ok('第 3 份漂移 → failure（不只查 zh/en）', n3d.failures.some((f) => f.includes('3 copies') && f.includes('plugins/kix-guards.js')))
  const n1 = lib.checkIdenticalSet({ root: nRoot, paths: ['dsh/preset/plugins/kix-guards.js'], label: 'solo' })
  await ok('少于 2 份 → failure', n1.failures.length === 1)
  const nMiss = lib.checkIdenticalSet({
    root: nRoot,
    paths: ['dsh/preset/plugins/kix-guards.js', 'en/preset/plugins/kix-guards.js', 'plugins/missing.js'],
    label: 'miss',
  })
  await ok('第 N 份缺失 → missing', nMiss.failures.some((f) => f.includes('plugins/missing.js missing')))
  await ok('pluginIdentityPaths 含额外副本', lib.pluginIdentityPaths('kix-guards.js').includes('plugins/kix-guards.js'))
  await ok('无额外声明的插件仍是 2 份', lib.pluginIdentityPaths('kix-x.js').length === 2)

  section('pre-execute: remind 触发（写 preset 区域，en 未同步）')
  const repo2 = makeRepoRoot()
  workspaceRootMock = repo2
  // 写 dsh/preset/plugins/foo.js（en 侧缺失 → checkPluginPair failure）
  const e1 = makeExec('write', 'dsh/preset/plugins/foo.js')
  const pre1 = await preExecute[0](e1, () => 'NEXT')
  // DSH pre-execute 放行语义：调用 next() 放行（mock next 返回 'NEXT'）
  await ok('remind 不 deny（走 next 放行）', pre1 === 'NEXT')
  const post1 = await postExecute[0](makePostExec(e1.callId), {}, () => 'NEXT')
  await ok('post-execute 注入提醒 1 条', post1 && Array.isArray(post1.additionalContexts) && post1.additionalContexts.length === 1)
  // 同类别第二次：remindOnce 不重复注入
  const e2 = makeExec('write', 'dsh/preset/plugins/bar.js')
  await preExecute[0](e2, () => 'NEXT')
  const post2 = await postExecute[0](makePostExec(e2.callId), {}, () => 'NEXT')
  await ok('同类别第二次不注入（remindOnce）', post2 === 'NEXT')

  section('pre-execute: 非 preset 路径 / 非源仓库 / 非写工具放行')
  const e3 = makeExec('write', 'src/main.js')
  await preExecute[0](e3, () => 'NEXT')
  const post3 = await postExecute[0](makePostExec(e3.callId), {}, () => 'NEXT')
  await ok('非 preset 路径 → 无注入', post3 === 'NEXT')
  workspaceRootMock = mkdtemp('kix-cons-test-nonrepo-')
  const e4 = makeExec('write', 'dsh/preset/plugins/foo.js')
  await preExecute[0](e4, () => 'NEXT')
  const post4 = await postExecute[0](makePostExec(e4.callId), {}, () => 'NEXT')
  await ok('非源仓库 → 无注入', post4 === 'NEXT')
  const e5 = makeExec('read', 'dsh/preset/plugins/foo.js')
  const pre5 = await preExecute[0](e5, () => 'NEXT')
  await ok('非写工具（read）→ 放行无副作用', pre5 === 'NEXT')

  section('pre-execute: block 强度 → deny')
  workspaceRootMock = makeRepoRoot()
  const e6 = makeExec('write', 'dsh/preset/plugins/foo.js')
  const pre6 = await blockListeners['tools/pre-execute'][0](e6, () => 'NEXT')
  await ok('block 强度 → deny 且带原因', pre6 && pre6.kind === 'deny' && typeof pre6.reason === 'string')

  // ── PR#10 审查修复回归（.cjs 路由 / 未覆盖分支 / 并发投递）──────────────
  section('__internals: .cjs 路由与未覆盖分支（PR#10）')
  await ok('classifyWrite zh .cjs 共享库 → plugins', I.classifyWrite('dsh/preset/plugins/consistency-lib.cjs') === 'plugins')
  await ok('classifyWrite en .cjs 共享库 → plugins', I.classifyWrite('en/preset/plugins/consistency-lib.cjs') === 'plugins')
  await ok('pickChecks .cjs → pair + 语法 2 检查', I.pickChecks(repo, 'dsh/preset/plugins/consistency-lib.cjs').length === 2)
  await ok('pickChecks README.md → 1 检查', I.pickChecks(repo, 'README.md').length === 1)
  await ok('pickChecks package.json → 1 检查', I.pickChecks(repo, 'package.json').length === 1)
  await ok('pickChecks vision-bridge → 2 检查', I.pickChecks(repo, 'dsh/vision-bridge/index.js').length === 2)
  await ok('classifyWrite 额外身份副本 → plugins', I.classifyWrite('plugins/kix-guards.test.js') === 'plugins')

  section('pre/post: 并发多类别写（Map 挂起不互相覆盖）')
  const repo3 = makeRepoRoot()
  workspaceRootMock = repo3
  const mkConc = (tool, rel, callId, agentId) => ({
    name: tool, callId,
    arguments: { file_path: rel },
    agent: { id: agentId },
  })
  // 同一 agent 一次块内并发两写（不同类别）：两条 pre 都挂起，post 各自按 callId 消费
  const wA = mkConc('write', 'dsh/preset/plugins/foo.js', 'conc-a', 'cons-conc1')
  const wB = mkConc('write', 'README.md', 'conc-b', 'cons-conc1')
  await preExecute[0](wA, () => 'NEXT')
  await preExecute[0](wB, () => 'NEXT')
  const postA = await postExecute[0]({ name: 'write', callId: 'conc-a', agent: { id: 'cons-conc1' } }, {}, () => 'NEXT')
  const postB = await postExecute[0]({ name: 'write', callId: 'conc-b', agent: { id: 'cons-conc1' } }, {}, () => 'NEXT')
  await ok('并发双类别：两条提醒都投递（callId 各自消费）',
    !!(postA && postA.additionalContexts && postA.additionalContexts.length === 1) &&
    !!(postB && postB.additionalContexts && postB.additionalContexts.length === 1))
  // 并发同类别双写：首条投递消耗类别，第二条静默丢弃（remindOnce 不被并发击穿）
  const wC = mkConc('write', 'dsh/preset/plugins/bar.js', 'conc-c', 'cons-conc2')
  const wD = mkConc('write', 'en/preset/plugins/bar.js', 'conc-d', 'cons-conc2')
  await preExecute[0](wC, () => 'NEXT')
  await preExecute[0](wD, () => 'NEXT')
  const postC = await postExecute[0]({ name: 'write', callId: 'conc-c', agent: { id: 'cons-conc2' } }, {}, () => 'NEXT')
  const postD = await postExecute[0]({ name: 'write', callId: 'conc-d', agent: { id: 'cons-conc2' } }, {}, () => 'NEXT')
  await ok('并发同类别：仅首条投递（remindOnce 保持）',
    !!(postC && postC.additionalContexts && postC.additionalContexts.length === 1) && postD === 'NEXT')

  section('审查修复：消息身份 + 路径归一（session restore / 绝对路径绕过）')
  const msg = I.makeUserMessage('kix-consistency: test')
  await ok('makeUserMessage 带非空 id（session restore 契约）',
    typeof msg.id === 'string' && msg.id.length > 0 && msg.role === 'user')
  await ok('两次 makeUserMessage id 不重复', I.makeUserMessage('a').id !== I.makeUserMessage('b').id)
  const repo4 = makeRepoRoot()
  await ok('toRepoRel 绝对路径 → 仓库相对', I.toRepoRel(repo4, path.join(repo4, 'dsh/preset/plugins/foo.js')) === 'dsh/preset/plugins/foo.js')
  await ok('toRepoRel ./ 前缀 → 仓库相对', I.toRepoRel(repo4, './dsh/preset/plugins/foo.js') === 'dsh/preset/plugins/foo.js')
  await ok('toRepoRel 仓库外绝对路径不伪造成相对', I.toRepoRel(repo4, path.join(os.tmpdir(), 'elsewhere.js')) !== 'dsh/preset/plugins/foo.js')
  workspaceRootMock = repo4
  const absExec = {
    name: 'write',
    callId: 'abs-path',
    arguments: { file_path: path.join(repo4, 'dsh', 'preset', 'plugins', 'foo.js') },
    agent: { id: 'cons-abs' },
  }
  await preExecute[0](absExec, () => 'NEXT')
  const absPost = await postExecute[0]({ name: 'write', callId: 'abs-path', agent: { id: 'cons-abs' } }, {}, () => 'NEXT')
  await ok('绝对路径写入仍触发守护', !!(absPost && absPost.additionalContexts && absPost.additionalContexts.length === 1))
  await ok('注入提醒带非空 id',
    typeof absPost.additionalContexts[0].id === 'string' && absPost.additionalContexts[0].id.length > 0)
  const dotExec = {
    name: 'write',
    callId: 'dot-path',
    arguments: { file_path: './README.md' },
    agent: { id: 'cons-dot' },
  }
  await preExecute[0](dotExec, () => 'NEXT')
  const dotPost = await postExecute[0]({ name: 'write', callId: 'dot-path', agent: { id: 'cons-dot' } }, {}, () => 'NEXT')
  await ok('./ 相对路径写入仍触发守护', !!(dotPost && dotPost.additionalContexts && dotPost.additionalContexts.length === 1))

  section('审查修复：会话 cwd 优先于 sandboxPolicy 回退根（WSL2 E2E 实锤）')
  const fallbackCwd = mkdtemp('kix-cons-fallback-cwd-')
  const sessionRepo = makeRepoRoot()
  workspaceRootMock = fallbackCwd // 模拟 dsh 从 /root 启动：回退根无源仓库指纹
  const sessExec = {
    name: 'write',
    callId: 'sess-cwd',
    arguments: { file_path: 'dsh/preset/plugins/foo.js' },
    agent: { id: 'cons-sess-cwd', session: { header: { cwd: sessionRepo } } },
  }
  await preExecute[0](sessExec, () => 'NEXT')
  const sessPost = await postExecute[0]({ name: 'write', callId: 'sess-cwd', agent: sessExec.agent }, {}, () => 'NEXT')
  await ok('会话 cwd 是源仓库、回退根不是 → 仍触发守护',
    !!(sessPost && sessPost.additionalContexts && sessPost.additionalContexts.length === 1))
  await ok('会话 cwd 路径下的提醒带非空 id',
    typeof sessPost.additionalContexts[0].id === 'string' && sessPost.additionalContexts[0].id.length > 0)

  // ── 收尾：清理夹具 ─────────────────────────────────────────────────────
  for (const dir of created) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
