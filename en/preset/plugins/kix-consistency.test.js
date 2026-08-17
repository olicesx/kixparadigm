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
  // 源仓库夹具（双标记 preset 根 + 契约入口；内容最小化；persona 检查单独造合法块）
  write('dsh/preset/agent.cordis.yml', 'text: |-\n  x\n')
  write('dsh/preset/preset.yml', 'id: zh\n')
  write('en/preset/agent.cordis.yml', 'text: |-\n  x\n')
  write('en/preset/preset.yml', 'id: en\n')
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
  section('__internals: 边界自感知（discoverPresetRoots / hasContractEntry）')
  const repo = makeRepoRoot()
  await ok('自感知发现 dsh/preset + en/preset',
    JSON.stringify(lib.discoverPresetRoots(repo)) === JSON.stringify(['dsh/preset', 'en/preset']))
  await ok('多 preset 工作区 → 引导', lib.isMultiPresetWorkspace(repo))
  const noEn = makeRepoRoot()
  fs.rmSync(path.join(noEn, 'en/preset/agent.cordis.yml'))
  await ok('单 preset 根 → 不引导（零开销）', lib.isMultiPresetWorkspace(noEn) === false)
  await ok('null → 无发现', lib.discoverPresetRoots(null).length === 0)
  await ok('undefined → 无发现', lib.discoverPresetRoots(undefined).length === 0)
  const plain = mkdtemp('kix-cons-test-plain-')
  await ok('普通工作区 → 无发现', lib.discoverPresetRoots(plain).length === 0)
  await ok('契约入口自声明 → true', I.hasContractEntry(repo))
  await ok('外仓无契约入口 → false', I.hasContractEntry(plain) === false)
  // 自定义布局外仓（非 dsh/en 命名）：深度 ≤2 扫描同样发现——泛化不绑本仓路径
  const foreignLayout = mkdtemp('kix-cons-test-layout-')
  for (const r of ['pkgs/zh', 'pkgs/en']) {
    fs.mkdirSync(path.join(foreignLayout, r), { recursive: true })
    fs.writeFileSync(path.join(foreignLayout, r, 'agent.cordis.yml'), 'x\n', 'utf8')
    fs.writeFileSync(path.join(foreignLayout, r, 'preset.yml'), 'id: x\n', 'utf8')
  }
  await ok('自定义布局（pkgs/zh + pkgs/en）自感知发现',
    JSON.stringify(lib.discoverPresetRoots(foreignLayout)) === JSON.stringify(['pkgs/en', 'pkgs/zh']))
  // 单标记不算 preset 根（压假阳性：agent.cordis.yml 单独出现不触发）
  const singleMarker = mkdtemp('kix-cons-test-marker-')
  fs.mkdirSync(path.join(singleMarker, 'dsh/preset'), { recursive: true })
  fs.writeFileSync(path.join(singleMarker, 'dsh/preset/agent.cordis.yml'), 'x\n', 'utf8')
  await ok('仅 agent.cordis.yml 单标记 → 不算 preset 根', lib.discoverPresetRoots(singleMarker).length === 0)

  section('__internals: classifyWrite（通用层 + 契约层）')
  const KIX = ['dsh/preset', 'en/preset']
  await ok('zh agent.cordis.yml → persona（契约层）', I.classifyWrite('dsh/preset/agent.cordis.yml', KIX, true) === 'persona')
  await ok('en agent.cordis.yml → persona（契约层）', I.classifyWrite('en/preset/agent.cordis.yml', KIX, true) === 'persona')
  await ok('无契约时 persona → parity hint（不硬套预算，给注意力不给结论）', I.classifyWrite('dsh/preset/agent.cordis.yml', KIX, false) === 'parity')
  await ok('zh 插件源码 → plugins（通用层）', I.classifyWrite('dsh/preset/plugins/kix-x.js', KIX, false) === 'plugins')
  await ok('en 插件测试 → plugins（通用层）', I.classifyWrite('en/preset/plugins/kix-x.test.js', KIX, false) === 'plugins')
  await ok('memories → memories（契约层）', I.classifyWrite('dsh/preset/memories/ai-agent-practices.md', KIX, true) === 'memories')
  await ok('无契约时 memories → parity hint', I.classifyWrite('dsh/preset/memories/x.md', KIX, false) === 'parity')
  await ok('skills → parity hint（翻译关系不字节校验，启发感知）', I.classifyWrite('dsh/preset/skills/kixpower/foo.md', KIX, true) === 'parity')
  await ok('agents → parity hint', I.classifyWrite('en/preset/agents/orchestrator.agent.md', KIX, false) === 'parity')
  await ok('外仓任意根内路径 → parity hint', I.classifyWrite('pkgs/zh/docs/readme-zh.md', ['pkgs/zh', 'pkgs/en'], false) === 'parity')
  await ok('README.md → readme（契约层）', I.classifyWrite('README.md', KIX, true) === 'readme')
  await ok('无契约时 README → null（外仓不硬套短语）', I.classifyWrite('README.md', KIX, false) === null)
  await ok('README.en.md → readme', I.classifyWrite('README.en.md', KIX, true) === 'readme')
  await ok('package.json → package', I.classifyWrite('package.json', KIX, true) === 'package')
  await ok('vision-bridge → vision', I.classifyWrite('dsh/vision-bridge/index.js', KIX, true) === 'vision')
  await ok('根 plugins/（非 preset 根）→ null（边界外）', I.classifyWrite('plugins/kix-guards.js', KIX, true) === null)
  await ok('普通源码 → null', I.classifyWrite('src/main.js', KIX, true) === null)
  await ok('windows 反斜杠路径 → plugins', I.classifyWrite('dsh\\preset\\plugins\\kix-x.js', KIX, true) === 'plugins')
  await ok('空 → null', I.classifyWrite('', KIX, true) === null)

  section('__internals: pickChecks')
  fs.mkdirSync(path.join(repo, 'dsh/preset/plugins'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'dsh/preset/plugins/kix-x.js'), 'X', 'utf8')
  const srcChecks = I.pickChecks(repo, 'dsh/preset/plugins/kix-x.js')
  await ok('写已存在插件源码 → pair + 语法 2 检查', srcChecks.length === 2)
  await ok('写全新插件（pre-write 缺失）→ 仅 pair 1 检查（语法跳过，不产 missing 噪音）',
    I.pickChecks(repo, 'dsh/preset/plugins/brand-new.js').length === 1)
  await ok('写根 plugins/（非 preset 根）→ 0 检查（边界外）', I.pickChecks(repo, 'plugins/kix-guards.js').length === 0)
  const testChecks = I.pickChecks(repo, 'dsh/preset/plugins/kix-x.test.js')
  await ok('写插件测试 → 仅 pair 1 检查', testChecks.length === 1)
  const personaChecks = I.pickChecks(repo, 'dsh/preset/agent.cordis.yml')
  await ok('写 persona → 1 检查（契约）', personaChecks.length === 1)
  await ok('非 preset → 0 检查', I.pickChecks(repo, 'src/main.js').length === 0)
  // 外仓（自定义布局、无契约脚本）：只有通用身份组检查
  const foreign = mkdtemp('kix-cons-test-foreign-')
  for (const r of ['pkgs/zh', 'pkgs/en']) {
    fs.mkdirSync(path.join(foreign, r + '/plugins'), { recursive: true })
    fs.writeFileSync(path.join(foreign, r, 'agent.cordis.yml'), 'x\n', 'utf8')
    fs.writeFileSync(path.join(foreign, r, 'preset.yml'), 'id: x\n', 'utf8')
  }
  fs.writeFileSync(path.join(foreign, 'pkgs/zh/plugins/m.js'), 'M', 'utf8')
  await ok('外仓写插件 → pair + 语法 2 检查（自感知根）', I.pickChecks(foreign, 'pkgs/zh/plugins/m.js').length === 2)
  await ok('外仓写 persona → 0 检查（无契约不硬套）', I.pickChecks(foreign, 'pkgs/zh/agent.cordis.yml').length === 0)
  await ok('外仓写 README → 0 检查', I.pickChecks(foreign, 'README.md').length === 0)
  // 单 preset 根外仓：完全零开销
  const solo = mkdtemp('kix-cons-test-solo-')
  fs.mkdirSync(path.join(solo, 'preset/plugins'), { recursive: true })
  fs.writeFileSync(path.join(solo, 'preset/agent.cordis.yml'), 'x\n', 'utf8')
  fs.writeFileSync(path.join(solo, 'preset/preset.yml'), 'id: x\n', 'utf8')
  await ok('单 preset 根 → pickChecks 0（不引导）', I.pickChecks(solo, 'preset/plugins/m.js').length === 0)

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
  const PAIR_ROOTS = ['dsh/preset', 'en/preset']
  const pair1 = lib.checkPluginPair({ root: pairRoot, name: 'a.js', presetRoots: PAIR_ROOTS })
  await ok('插件对不一致 → failure', pair1.failures.length === 1)
  fs.writeFileSync(path.join(pairRoot, 'en/preset/plugins/a.js'), 'A', 'utf8')
  const pair2 = lib.checkPluginPair({ root: pairRoot, name: 'a.js', presetRoots: PAIR_ROOTS })
  await ok('插件对一致且双侧无 test → note 跳过', pair2.failures.length === 0 && pair2.notes.some((n) => n.includes('skipped')))
  fs.writeFileSync(path.join(pairRoot, 'dsh/preset/plugins/a.test.js'), 'T', 'utf8')
  const pair3 = lib.checkPluginPair({ root: pairRoot, name: 'a.js', presetRoots: PAIR_ROOTS })
  await ok('test 单侧存在 → failure（en 缺 test）', pair3.failures.length === 1)

  section('lib: checkIdenticalSet（该相同的数份必须相同，N ≥ 2）')
  const nRoot = mkdtemp('kix-cons-test-nset-')
  const THREE = ['editions/one', 'editions/two', 'editions/three']
  for (const r of THREE) {
    fs.mkdirSync(path.join(nRoot, r, 'plugins'), { recursive: true })
    fs.writeFileSync(path.join(nRoot, r, 'plugins/core.js'), 'X', 'utf8')
  }
  const threePaths = THREE.map((r) => r + '/plugins/core.js')
  const n3 = lib.checkIdenticalSet({ root: nRoot, paths: threePaths, label: 'plugins/core.js' })
  await ok('3 份相同 → 无 failure', n3.failures.length === 0 && n3.notes.some((n) => n.includes('3 copies')))
  fs.writeFileSync(path.join(nRoot, 'editions/three/plugins/core.js'), 'DRIFT', 'utf8')
  const n3d = lib.checkPluginPair({ root: nRoot, name: 'core.js', presetRoots: THREE })
  await ok('第 3 份漂移 → failure（不只查前两份）', n3d.failures.some((f) => f.includes('3 copies') && f.includes('editions/three')))
  const n1 = lib.checkIdenticalSet({ root: nRoot, paths: ['editions/one/plugins/core.js'], label: 'solo' })
  await ok('少于 2 份 → failure', n1.failures.length === 1)
  const nMiss = lib.checkIdenticalSet({ root: nRoot, paths: threePaths.concat(['editions/four/plugins/core.js']), label: 'miss' })
  await ok('第 N 份缺失 → missing', nMiss.failures.some((f) => f.includes('editions/four/plugins/core.js missing')))
  await ok('pluginIdentityPaths 按自感知根展开', JSON.stringify(lib.pluginIdentityPaths('core.js', THREE)) === JSON.stringify(threePaths))
  await ok('未传 roots → 空数组（不猜）', lib.pluginIdentityPaths('core.js').length === 0)
  await ok('identityPathsFor 写哪份映射全组', JSON.stringify(lib.identityPathsFor('editions/two/plugins/core.js', THREE)) === JSON.stringify(threePaths))
  await ok('identityPathsFor 边界外 → 空', lib.identityPathsFor('src/main.js', THREE).length === 0)

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
  await ok('classifyWrite zh .cjs 共享库 → plugins', I.classifyWrite('dsh/preset/plugins/consistency-lib.cjs', KIX, true) === 'plugins')
  await ok('classifyWrite en .cjs 共享库 → plugins', I.classifyWrite('en/preset/plugins/consistency-lib.cjs', KIX, true) === 'plugins')
  await ok('pickChecks .cjs（缺失目标）→ 仅 pair 1 检查', I.pickChecks(repo, 'dsh/preset/plugins/consistency-lib.cjs').length === 1)
  await ok('pickChecks README.md → 1 检查', I.pickChecks(repo, 'README.md').length === 1)
  await ok('pickChecks package.json → 1 检查', I.pickChecks(repo, 'package.json').length === 1)
  await ok('pickChecks vision-bridge → 2 检查', I.pickChecks(repo, 'dsh/vision-bridge/index.js').length === 2)
  await ok('根 plugins/ classify → null（非 preset 根）', I.classifyWrite('plugins/kix-guards.test.js', KIX, true) === null)

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

  section('pre-execute: 外仓实测（自感知双根，无契约脚本，根 plugins/ 在边界外）')
  const repoF = mkdtemp('kix-cons-test-fwe2e-')
  for (const r of ['pkgs/zh', 'pkgs/en']) {
    fs.mkdirSync(path.join(repoF, r + '/plugins'), { recursive: true })
    fs.writeFileSync(path.join(repoF, r, 'agent.cordis.yml'), 'x\n', 'utf8')
    fs.writeFileSync(path.join(repoF, r, 'preset.yml'), 'id: x\n', 'utf8')
  }
  fs.writeFileSync(path.join(repoF, 'pkgs/zh/plugins/m.js'), 'M', 'utf8')
  fs.mkdirSync(path.join(repoF, 'plugins'), { recursive: true })
  fs.writeFileSync(path.join(repoF, 'plugins/kix-guards.js'), 'IMPORT-SOURCE', 'utf8')
  workspaceRootMock = repoF
  const fAgent = { id: 'cons-foreign' }
  const fExec = { name: 'write', callId: 'fw-1', arguments: { file_path: 'pkgs/zh/plugins/m.js' }, agent: fAgent }
  await preExecute[0](fExec, () => 'NEXT')
  const fPost = await postExecute[0]({ name: 'write', callId: 'fw-1', agent: fAgent }, {}, () => 'NEXT')
  await ok('外仓漂移写入 → 注入提醒（指向 pkgs/en 缺失份）',
    !!(fPost && fPost.additionalContexts && fPost.additionalContexts.length === 1 &&
      fPost.additionalContexts[0].content[0].text.includes('pkgs/en/plugins/m.js missing')))
  const f2 = { name: 'write', callId: 'fw-2', arguments: { file_path: 'pkgs/zh/agent.cordis.yml' }, agent: fAgent }
  await preExecute[0](f2, () => 'NEXT')
  const f2Post = await postExecute[0]({ name: 'write', callId: 'fw-2', agent: fAgent }, {}, () => 'NEXT')
  await ok('外仓 persona 写入 → parity hint（无契约不硬套预算，启发感知）',
    !!(f2Post && f2Post.additionalContexts && f2Post.additionalContexts.length === 1 &&
      f2Post.additionalContexts[0].content[0].text.includes('由你判断')))
  const f2b = { name: 'write', callId: 'fw-2b', arguments: { file_path: 'pkgs/zh/skills/new-skill.md' }, agent: fAgent }
  await preExecute[0](f2b, () => 'NEXT')
  const f2bPost = await postExecute[0]({ name: 'write', callId: 'fw-2b', agent: fAgent }, {}, () => 'NEXT')
  await ok('外仓未描述形态（skills）写入 → hint 已给过，remindOnce 静默', f2bPost === 'NEXT')
  const f3 = { name: 'write', callId: 'fw-3', arguments: { file_path: 'plugins/kix-guards.js' }, agent: fAgent }
  await preExecute[0](f3, () => 'NEXT')
  const f3Post = await postExecute[0]({ name: 'write', callId: 'fw-3', agent: fAgent }, {}, () => 'NEXT')
  await ok('根 plugins/ 写入 → 零开销放行（边界 = preset 根）', f3Post === 'NEXT')

  // ── 任务形态覆盖：edit 工具（非 write 的变更通道）───────────────────────
  section('任务形态：edit 工具')
  const repoE = makeRepoRoot()
  workspaceRootMock = repoE
  const eEd = { name: 'edit', callId: 'ed-1', arguments: { file_path: 'dsh/preset/plugins/ed.js' }, agent: { id: 'cons-ed' } }
  await preExecute[0](eEd, () => 'NEXT')
  const edPost = await postExecute[0]({ name: 'edit', callId: 'ed-1', agent: eEd.agent }, {}, () => 'NEXT')
  await ok('edit 工具写漂移插件 → 注入提醒', !!(edPost && edPost.additionalContexts && edPost.additionalContexts.length === 1))
  const eEd2 = { name: 'edit', callId: 'ed-2', arguments: { file_path: 'dsh/preset/skills/x.md' }, agent: { id: 'cons-ed2' } }
  await preExecute[0](eEd2, () => 'NEXT')
  const ed2Post = await postExecute[0]({ name: 'edit', callId: 'ed-2', agent: eEd2.agent }, {}, () => 'NEXT')
  await ok('edit 工具写根内非 plugins → parity hint', !!(ed2Post && ed2Post.additionalContexts && ed2Post.additionalContexts[0].content[0].text.includes('由你判断')))

  // ── 任务形态覆盖：shell 写入（pwsh / bash，无 file_path）────────────────
  section('任务形态：shell 写入（pwsh / bash）')
  const repoSh = makeRepoRoot()
  workspaceRootMock = repoSh
  fs.mkdirSync(path.join(repoSh, 'dsh/preset/plugins'), { recursive: true })
  fs.writeFileSync(path.join(repoSh, 'dsh/preset/plugins/sh.js'), 'S', 'utf8')
  const sh1 = { name: 'pwsh', callId: 'sh-1', arguments: { command: 'Copy-Item /tmp/x.js dsh\\preset\\plugins\\sh.js' }, agent: { id: 'cons-sh' } }
  await preExecute[0](sh1, () => 'NEXT')
  const sh1Post = await postExecute[0]({ name: 'pwsh', callId: 'sh-1', agent: sh1.agent }, {}, () => 'NEXT')
  await ok('pwsh 写漂移插件（反斜杠路径）→ post 检测注入提醒',
    !!(sh1Post && sh1Post.additionalContexts && sh1Post.additionalContexts[0].content[0].text.includes('shell 写入后检测到身份组漂移')))
  const sh2 = { name: 'pwsh', callId: 'sh-2', arguments: { command: 'Set-Content dsh/preset/skills/foo.md hi' }, agent: { id: 'cons-sh2' } }
  await preExecute[0](sh2, () => 'NEXT')
  const sh2Post = await postExecute[0]({ name: 'pwsh', callId: 'sh-2', agent: sh2.agent }, {}, () => 'NEXT')
  await ok('pwsh 写根内非 plugins → parity hint', !!(sh2Post && sh2Post.additionalContexts && sh2Post.additionalContexts[0].content[0].text.includes('由你判断')))
  const sh3 = { name: 'pwsh', callId: 'sh-3', arguments: { command: 'Get-ChildItem src/ && npm test' }, agent: { id: 'cons-sh3' } }
  await preExecute[0](sh3, () => 'NEXT')
  const sh3Post = await postExecute[0]({ name: 'pwsh', callId: 'sh-3', agent: sh3.agent }, {}, () => 'NEXT')
  await ok('pwsh 未提及 preset 根路径 → 零开销', sh3Post === 'NEXT')
  // bash + 一致写入（双侧都在且相同）→ 无假阳性
  const repoShB = makeRepoRoot()
  for (const r of ['dsh/preset', 'en/preset']) {
    fs.mkdirSync(path.join(repoShB, r + '/plugins'), { recursive: true })
    fs.writeFileSync(path.join(repoShB, r + '/plugins/ok.js'), 'OK', 'utf8')
  }
  workspaceRootMock = repoShB
  const sh4 = { name: 'bash', callId: 'sh-4', arguments: { command: 'sed -i s/a/b/ dsh/preset/plugins/ok.js' }, agent: { id: 'cons-sh4' } }
  await preExecute[0](sh4, () => 'NEXT')
  const sh4Post = await postExecute[0]({ name: 'bash', callId: 'sh-4', agent: sh4.agent }, {}, () => 'NEXT')
  await ok('bash 工具通道同样覆盖（一致写入 → 不误报）', sh4Post === 'NEXT')
  const sh5 = { name: 'bash', callId: 'sh-5', arguments: { command: 'cp /tmp/n.js en/preset/plugins/new.js' }, agent: { id: 'cons-sh5' } }
  await preExecute[0](sh5, () => 'NEXT')
  const sh5Post = await postExecute[0]({ name: 'bash', callId: 'sh-5', agent: sh5.agent }, {}, () => 'NEXT')
  await ok('bash 写漂移插件（en 有 zh 无）→ post 注入提醒', !!(sh5Post && sh5Post.additionalContexts && sh5Post.additionalContexts.length === 1))

  // ── 提取器单测 ─────────────────────────────────────────────────────────
  section('__internals: extractShellTargets')
  const ext1 = I.extractShellTargets('cp a dsh/preset/plugins/x.js && cat dsh/preset/skills/y.md', KIX)
  await ok('正斜杠命令提取 2 目标', ext1.length === 2 && ext1[0].rel === 'plugins/x.js' && ext1[1].rel === 'skills/y.md')
  await ok('连字符文件名完整提取（live 实弹回归：shell-live.js 曾截成 shell）',
    I.extractShellTargets('cp a dsh/preset/plugins/shell-live.js', KIX)[0].rel === 'plugins/shell-live.js')
  await ok('连字符 + 相对段混合', I.extractShellTargets('cp pkgs/zh/plugins/my-plugin.test.js b', ['pkgs/zh'])[0].rel === 'plugins/my-plugin.test.js')
  const ext2 = I.extractShellTargets('Copy-Item x dsh\\preset\\plugins\\x.ps1', KIX)
  await ok('反斜杠命令提取（rel 归一正斜杠）', ext2.length === 1 && ext2[0].rel === 'plugins/x.ps1')
  await ok('无关命令 → 空', I.extractShellTargets('npm install && npm test', KIX).length === 0)
  await ok('cap 8 目标', I.extractShellTargets(Array.from({ length: 20 }, (_, i) => `dsh/preset/plugins/f${i}.js`).join(' '), KIX).length === 8)

  // ── 强度免疫：parity hint 不受 block / ask 影响 ────────────────────────
  section('强度免疫：parity hint（无失败可拦）')
  const repoBlk = makeRepoRoot()
  workspaceRootMock = repoBlk
  const bp = { name: 'write', callId: 'blk-par', arguments: { file_path: 'dsh/preset/skills/x.md' }, agent: { id: 'cons-blk' } }
  const bPre = await blockListeners['tools/pre-execute'][0](bp, () => 'NEXT')
  await ok('block 强度下 parity 写入不被 deny', bPre === 'NEXT')
  const bPost = await blockListeners['tools/post-execute'][0]({ name: 'write', callId: 'blk-par', agent: bp.agent }, {}, () => 'NEXT')
  await ok('block 强度下 parity hint 照常注入', !!(bPost && bPost.additionalContexts && bPost.additionalContexts.length === 1))
  const askListeners = {}
  let askCalls = 0
  const ctxAsk = {
    config: { intensity: 'ask' },
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'sandboxPolicy') return { workspaceRoot: workspaceRootMock, resolve: () => ({ workspaceRoot: workspaceRootMock }) }
      if (name === 'userQuestions') return { ask: async () => { askCalls++; return { answers: [{ selected: ['继续写入'] }] } } }
      return undefined
    },
    on(e, c) { (askListeners[e] ||= []).push(c) },
    effect() {},
    tools: { register() { return () => {} } },
    commands: { register() { return () => {} } },
  }
  plugin.apply(ctxAsk, { intensity: 'ask' })
  const ap = { name: 'write', callId: 'ask-par', arguments: { file_path: 'en/preset/skills/y.md' }, agent: { id: 'cons-ask' } }
  const aPre = await askListeners['tools/pre-execute'][0](ap, () => 'NEXT')
  await ok('ask 强度下 parity 写入不打断提问', aPre === 'NEXT' && askCalls === 0)
  const aPost = await askListeners['tools/post-execute'][0]({ name: 'write', callId: 'ask-par', agent: ap.agent }, {}, () => 'NEXT')
  await ok('ask 强度下 parity hint 照常注入', !!(aPost && aPost.additionalContexts && aPost.additionalContexts.length === 1))

  // ── 多根 / 多 agent / 深路径 / 扩展名形态 ──────────────────────────────
  section('形态：N=3 根 hint 点名其余两根 / 双 agent 独立 / 深路径 / 扩展名')
  const n3repo = mkdtemp('kix-cons-test-n3hint-')
  for (const r of ['editions/a', 'editions/b', 'editions/c']) {
    fs.mkdirSync(path.join(n3repo, r), { recursive: true })
    fs.writeFileSync(path.join(n3repo, r, 'agent.cordis.yml'), 'x\n', 'utf8')
    fs.writeFileSync(path.join(n3repo, r, 'preset.yml'), 'id: x\n', 'utf8')
  }
  workspaceRootMock = n3repo
  const h3 = { name: 'write', callId: 'n3-1', arguments: { file_path: 'editions/a/skills/s.md' }, agent: { id: 'cons-n3' } }
  await preExecute[0](h3, () => 'NEXT')
  const h3Post = await postExecute[0]({ name: 'write', callId: 'n3-1', agent: h3.agent }, {}, () => 'NEXT')
  const h3Text = h3Post && h3Post.additionalContexts ? h3Post.additionalContexts[0].content[0].text : ''
  await ok('N=3 根 hint 点名其余两根', h3Text.includes('editions/b') && h3Text.includes('editions/c') && !h3Text.includes('editions/a）的对应份'))
  await ok('parity hint 消息带非空 id（restore 契约）', typeof (h3Post.additionalContexts[0].id) === 'string' && h3Post.additionalContexts[0].id.length > 0)
  const h3b = { name: 'write', callId: 'n3-2', arguments: { file_path: 'editions/b/skills/s.md' }, agent: { id: 'cons-n3-b' } }
  await preExecute[0](h3b, () => 'NEXT')
  const h3bPost = await postExecute[0]({ name: 'write', callId: 'n3-2', agent: h3b.agent }, {}, () => 'NEXT')
  await ok('另一 agent 有独立 remindOnce（同工作区双 hint）', !!(h3bPost && h3bPost.additionalContexts && h3bPost.additionalContexts.length === 1))
  await ok('反斜杠根内路径 → parity', I.classifyWrite('dsh\\preset\\skills\\x.md', KIX, true) === 'parity')
  await ok('深路径未知目录 → parity', I.classifyWrite('pkgs/zh/assets/x/y.json', ['pkgs/zh', 'pkgs/en'], false) === 'parity')
  await ok('.ps1 → parity', I.classifyWrite('dsh/preset/skills/kixpower/hooks/h.ps1', KIX, true) === 'parity')
  await ok('.yml → parity', I.classifyWrite('en/preset/prompts/p.yml', KIX, true) === 'parity')

  // ── 类别隔离：plugins 漂移提醒与 parity hint 同会话都可达 ──────────────
  section('类别隔离：plugins 提醒与 parity hint 互不消耗')
  const repoIso = makeRepoRoot()
  workspaceRootMock = repoIso
  const isoAgent = { id: 'cons-iso' }
  const isoA = { name: 'write', callId: 'iso-1', arguments: { file_path: 'dsh/preset/plugins/iso.js' }, agent: isoAgent }
  await preExecute[0](isoA, () => 'NEXT')
  const isoAPost = await postExecute[0]({ name: 'write', callId: 'iso-1', agent: isoAgent }, {}, () => 'NEXT')
  const isoB = { name: 'write', callId: 'iso-2', arguments: { file_path: 'dsh/preset/skills/iso.md' }, agent: isoAgent }
  await preExecute[0](isoB, () => 'NEXT')
  const isoBPost = await postExecute[0]({ name: 'write', callId: 'iso-2', agent: isoAgent }, {}, () => 'NEXT')
  await ok('plugins 漂移与 parity hint 同会话双投递（互不消耗）',
    !!(isoAPost && isoAPost.additionalContexts) && !!(isoBPost && isoBPost.additionalContexts))

  // ── 首派发兜底（live 实弹回归：WSL2 首写 hint 丢失根因）────────────────
  section('首派发兜底：agent 无 session / 工作区根不可解析时从写入目标反推')
  const plainFallback = mkdtemp('kix-cons-test-fallback-') // 模拟 dsh 从 /root 启动的回退根（无 preset 根）
  fs.writeFileSync(path.join(plainFallback, 'a.txt'), 'a', 'utf8')
  workspaceRootMock = plainFallback
  const healAgent = { id: 'cons-heal' } // 无 session：模拟 live 首派发解析不出 cwd
  const h1 = makeExec('write', path.join(repo, 'dsh', 'preset', 'skills', 'heal-skill.md'))
  // healAgent 无 session → 回退根无根 → 兜底从绝对路径反推
  await preExecute[0]({ ...h1, agent: healAgent }, () => 'NEXT')
  const h1Post = await postExecute[0]({ name: 'write', callId: h1.callId, agent: healAgent }, {}, () => 'NEXT')
  await ok('首派发（无 session、回退根无根）+ 绝对路径写根内文件 → parity hint 照发',
    !!(h1Post && h1Post.additionalContexts && h1Post.additionalContexts[0].content[0].text.includes('由你判断')))
  const repoHeal = makeRepoRoot()
  workspaceRootMock = plainFallback
  const h2 = makeExec('write', path.join(repoHeal, 'dsh', 'preset', 'plugins', 'heal-drift.js'))
  await preExecute[0]({ ...h2, agent: { id: 'cons-heal2' } }, () => 'NEXT')
  const h2Post = await postExecute[0]({ name: 'write', callId: h2.callId, agent: { id: 'cons-heal2' } }, {}, () => 'NEXT')
  await ok('首派发兜底 + 绝对路径写漂移插件 → drift 提醒照发（去重后无重复条目）',
    !!(h2Post && h2Post.additionalContexts &&
      h2Post.additionalContexts[0].content[0].text.includes('en/preset/plugins/heal-drift.js missing') &&
      !h2Post.additionalContexts[0].content[0].text.includes('missing dsh/preset/plugins/heal-drift.js missing')))
  workspaceRootMock = plainFallback
  const hPlain = makeExec('write', path.join(plainFallback, 'a.txt'))
  await preExecute[0]({ ...hPlain, agent: { id: 'cons-heal3' } }, () => 'NEXT')
  const hPlainPost = await postExecute[0]({ name: 'write', callId: hPlain.callId, agent: { id: 'cons-heal3' } }, {}, () => 'NEXT')
  await ok('兜底也找不到根（普通文件）→ 零开销放行', hPlainPost === 'NEXT')
  await ok('discoverRootsFromFile 单元：多根工作区祖先 → 命中',
    I.discoverRootsFromFile(path.join(repoHeal, 'dsh/preset/plugins/x.js')).workspaceRoot === repoHeal)
  await ok('discoverRootsFromFile：相对路径 → null（不猜）', I.discoverRootsFromFile('dsh/preset/x.js') === null)
  await ok('discoverRootsFromFile：普通目录 → null', I.discoverRootsFromFile(path.join(plainFallback, 'a.txt')) === null)

  // ── 堆叠监听器回归（WSL2 实弹实锤：post-execute 裸返回短路瀑布）─────────
  section('堆叠注入：kix-discipline + kix-consistency 同挂，首写双投递')
  {
    const discipline = require(path.join(__dirname, 'kix-discipline.js'))
    const stackL = {}
    const stackCtx = {
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      get(name) {
        if (name === 'sandboxPolicy') {
          return { workspaceRoot: workspaceRootMock, resolve: () => ({ workspaceRoot: workspaceRootMock }) }
        }
        return undefined
      },
      on(e, c) { (stackL[e] ||= []).push(c) },
      effect() {},
      tools: { register() { return () => {} } },
      commands: { register() { return () => {} } },
    }
    discipline.apply(stackCtx, {})   // yml 挂载顺序：discipline 在前
    plugin.apply(stackCtx, {})       // consistency 在后（被短路饿死的一方）
    const repoStack = makeRepoRoot()
    workspaceRootMock = repoStack
    const sAgent = { id: 'cons-stack' }
    const sExec = { name: 'write', callId: 'stack-1', arguments: { file_path: 'dsh/preset/skills/stacked.md' }, agent: sAgent }
    await stackL['tools/pre-execute'][0](sExec, () => 'NEXT')
    await stackL['tools/pre-execute'][1](sExec, () => 'NEXT')
    // 真瀑布语义：next() 链到下一监听器，终结返回 {kind:'accept'}
    const postChain = (i) => i >= stackL['tools/post-execute'].length
      ? Promise.resolve({ kind: 'accept' })
      : stackL['tools/post-execute'][i](sExec, {}, () => postChain(i + 1))
    const sPost = await postChain(0)
    const texts = sPost && Array.isArray(sPost.additionalContexts) ? sPost.additionalContexts.map((m) => m.content[0].text) : []
    await ok('首写双投递：discipline 与 consistency 都送达（不再短路）',
      texts.length === 2 && texts.some((t) => t.includes('kix-discipline')) && texts.some((t) => t.includes('由你判断')))
    await ok('合并 decision 保留 accept kind 与消息 id',
      sPost.kind === 'accept' && texts.length === 2 && sPost.additionalContexts.every((m) => typeof m.id === 'string' && m.id.length > 0))
    await ok('appendContexts 纯函数：非 accept 下游原样放行',
      JSON.stringify(lib.appendContexts({ kind: 'block', reason: 'x' }, [{ id: 'a' }])) === JSON.stringify({ kind: 'block', reason: 'x' }))
    await ok('appendContexts 纯函数：accept 下游合并',
      Array.isArray(lib.appendContexts({ kind: 'accept', additionalContexts: [{ id: 'a' }] }, [{ id: 'b' }]).additionalContexts) &&
      lib.appendContexts({ kind: 'accept', additionalContexts: [{ id: 'a' }] }, [{ id: 'b' }]).additionalContexts.length === 2)
  }

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
