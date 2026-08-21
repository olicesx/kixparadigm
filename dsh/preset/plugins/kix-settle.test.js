// kix-settle 回归测试（P0，2026-08-20 补齐投递端；v2 2026-08-21 高置信提交）
//
// 单元级验证：加载 kix-settle.js，mock DSH post-execute / agent/turn-stopping
// 派发，覆盖：
//   - 监听器注册：post-execute 观察 + turn-stopping 投递各一个
//   - post-execute 记账：edit/write 计数、probe/run_code/执行类 bash 记为证据
//   - turn-stopping 投递：有编辑 + 末次编辑后无执行 → steer 单发；
//     有执行证据 → 不提醒；无编辑 → 不提醒；reminded 单发不重复
//   - 工作区外文件不计入编辑
//   - v2 高置信提交：无编辑 + 终稿像审查结论 + 无独立观察者 → commit-blind
//     steer；派过 subagent/cross/reviewer（含 capability_call 代理）清账；
//     非结论姿态不触发；两路 reminded 各自单发
// 运行：node plugins/kix-settle.test.js

const path = require('node:path')
const assert = require('node:assert')
const os = require('node:os')
const fs = require('node:fs')

// ── mock ctx ───────────────────────────────────────────────────────────────
const listeners = {}
let sessionQueryMock = null
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get(name) { if (name === 'sessionQuery') return sessionQueryMock; return undefined },
  on(event, cb) { ;(listeners[event] ||= []).push(cb) },
  effect() {},
}

// ── 加载被测试插件 ────────────────────────────────────────────────────────
const plugin = require(path.join(__dirname, 'kix-settle.js'))
assert.strictEqual(plugin.name, 'kix-settle')
plugin.apply(ctx)
const postExecute = listeners['tools/post-execute']
const turnStopping = listeners['agent/turn-stopping']
assert.ok(Array.isArray(postExecute) && postExecute.length === 1, 'post-execute 监听器已注册')
assert.ok(Array.isArray(turnStopping) && turnStopping.length === 1, 'turn-stopping 监听器已注册（投递端补齐）')

const I = plugin.__internals
assert.ok(I && typeof I.looksLikeVerdict === 'function', '__internals 导出判定函数')

// ── 模拟 DSH 派发 ─────────────────────────────────────────────────────────
let steered = []
const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-settle-session-'))
const sessionHeader = { cwd: sessionRoot }

function mkAgent(agentId) {
  return { id: agentId, session: { id: 'session-' + agentId, header: sessionHeader }, steer(msg) { steered.push(msg) } }
}

function dispatchPostAs(name, args, result, agentId = 'a1') {
  const exec = { name, arguments: args, token: 't', callId: 'c', agent: mkAgent(agentId) }
  return postExecute[0](exec, result || { isError: false }, () => Promise.resolve({ kind: 'accept' }))
}
function dispatchPost(name, args, result) { return dispatchPostAs(name, args, result) }

async function dispatchTurnAs(agentId = 'a1') {
  steered = []
  return turnStopping[0]({ agent: mkAgent(agentId), turn: 1, signal: undefined })
}

function assistantSurface(text) {
  return {
    events: [{
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text }] } },
    }],
  }
}

function dispatchTurnFor(agentId, surface) {
  sessionQueryMock = surface ? { readSurface: async () => surface } : null
  steered = []
  return turnStopping[0]({ agent: mkAgent(agentId), turn: 1, signal: undefined })
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
// ── 1. post-execute 记账 ──────────────────────────────────────────────────
section('post-execute 记账')
await ok('edit 计入编辑且清除执行证据', (async () => {
  await dispatchPost('edit', { file_path: path.join(sessionRoot, 'a.py') })
  await dispatchTurnAs()
  return steered.length === 1
})())

// ── 2. turn-stopping 投递 ─────────────────────────────────────────────────
section('turn-stopping 投递')
await ok('有编辑 + 无执行证据 → steer 单发', (async () => {
  await dispatchPostAs('edit', { file_path: path.join(sessionRoot, 'b.py') }, undefined, 'a2')
  await dispatchTurnAs('a2')
  return steered.length === 1 && steered[0].role === 'user' && /kix-settle/.test(steered[0].content[0].text)
})())
await ok('steer 含按零结算语义', (async () => {
  await dispatchPostAs('edit', { file_path: path.join(sessionRoot, 'c.py') }, undefined, 'a3')
  await dispatchTurnAs('a3')
  return steered.length === 1 && /无执行证据的结论按零结算/.test(steered[0].content[0].text)
})())
await ok('编辑后 probe → 不提醒（执行证据清账）', (async () => {
  await dispatchPostAs('edit', { file_path: path.join(sessionRoot, 'd.py') }, undefined, 'a4')
  await dispatchPostAs('probe', { code: 'print(1)' }, undefined, 'a4')
  await dispatchTurnAs('a4')
  return steered.length === 0
})())
await ok('编辑后 run_code → 不提醒', (async () => {
  await dispatchPostAs('edit', { file_path: path.join(sessionRoot, 'e.py') }, undefined, 'a5')
  await dispatchPostAs('run_code', { code: 'return 1', description: 'x' }, undefined, 'a5')
  await dispatchTurnAs('a5')
  return steered.length === 0
})())
await ok('编辑后执行类 bash → 不提醒', (async () => {
  await dispatchPostAs('edit', { file_path: path.join(sessionRoot, 'f.py') }, undefined, 'a6')
  await dispatchPostAs('bash', { command: 'python -c "print(1)"' }, undefined, 'a6')
  await dispatchTurnAs('a6')
  return steered.length === 0
})())
await ok('无编辑 → 不提醒', (async () => {
  await dispatchTurnAs('a7')
  return steered.length === 0
})())
await ok('write 也算编辑', (async () => {
  await dispatchPostAs('write', { file_path: path.join(sessionRoot, 'g.py'), content: 'x' }, undefined, 'a8')
  await dispatchTurnAs('a8')
  return steered.length === 1
})())
await ok('工作区外文件不计入编辑', (async () => {
  await dispatchPostAs('edit', { file_path: path.join(os.tmpdir(), 'outside.py') }, undefined, 'a9')
  await dispatchTurnAs('a9')
  return steered.length === 0
})())

// ── 3. 单发语义 ───────────────────────────────────────────────────────────
section('reminded 单发')
await ok('同会话第二次满足条件不重复提醒', (async () => {
  await dispatchPostAs('edit', { file_path: path.join(sessionRoot, 'h.py') }, undefined, 'a10')
  await dispatchTurnAs('a10')
  const first = steered.length
  await dispatchPostAs('edit', { file_path: path.join(sessionRoot, 'i.py') }, undefined, 'a10')
  await dispatchTurnAs('a10')
  return first === 1 && steered.length === 0
})())

// ── 4. v2 纯判定 ──────────────────────────────────────────────────────────
section('v2 纯判定 __internals')
await ok('LGTM 命中结论姿态', I.looksLikeVerdict('**LGTM**，附 4 条 minor note'))
await ok('APPROVE 命中', I.looksLikeVerdict('Verdict: APPROVE'))
await ok('request-changes 命中', I.looksLikeVerdict('判定：request-changes'))
await ok('可以合并命中', I.looksLikeVerdict('结论：可以合并，附注意事项'))
await ok('进行中不命中', !I.looksLikeVerdict('正在读 diff，下一步跑测试'))
await ok('软赞不命中', !I.looksLikeVerdict('看起来不错，暂无问题'))
await ok('空文本不命中', !I.looksLikeVerdict(''))
await ok('capability_call 代理 reviewer 解析为目标名', I.resolvedToolName({ name: 'kix_capability_call', arguments: { tool: 'subagent_reviewer' } }) === 'subagent_reviewer')
await ok('直呼 subagent_cross 原名', I.resolvedToolName({ name: 'subagent_cross' }) === 'subagent_cross')
await ok('reviewer 算独立观察者', I.isIndependentObserver('subagent_reviewer'))
await ok('lite 不算独立观察者（取证档不是对抗采样）', !I.isIndependentObserver('subagent_lite'))
await ok('lastAssistantText 取最近一条', I.lastAssistantText(assistantSurface('LGTM')) === 'LGTM')

// ── 5. v2 高置信提交投递 ──────────────────────────────────────────────────
section('v2 高置信提交')
await ok('无编辑 + LGTM 终稿 + 无观察者 → commit-blind steer', (async () => {
  await dispatchTurnFor('b1', assistantSurface('**LGTM**，4 条 minor'))
  return steered.length === 1 && /高置信提交时刻失明/.test(steered[0].content[0].text)
})())
await ok('无编辑 + 进行中终稿 → 不提醒', (async () => {
  await dispatchTurnFor('b2', assistantSurface('正在读 runtime.rs 兜底链'))
  return steered.length === 0
})())
await ok('无编辑 + 无 sessionQuery → 静默跳过', (async () => {
  sessionQueryMock = null
  steered = []
  await turnStopping[0]({ agent: mkAgent('b3'), turn: 1, signal: undefined })
  return steered.length === 0
})())
await ok('派过 subagent_cross → 不提醒（独立性清账）', (async () => {
  await dispatchPostAs('subagent_cross', { prompt: '独立读 fallback 链' }, undefined, 'b4')
  await dispatchTurnFor('b4', assistantSurface('LGTM'))
  return steered.length === 0
})())
await ok('capability_call 代理 subagent_reviewer → 不提醒', (async () => {
  await dispatchPostAs('kix_capability_call', { tool: 'subagent_reviewer', arguments: { prompt: '反方' } }, undefined, 'b5')
  await dispatchTurnFor('b5', assistantSurface('request-changes'))
  return steered.length === 0
})())
await ok('直呼 subagent_lite 不清账（不是对抗观察）', (async () => {
  await dispatchPostAs('subagent_lite', { prompt: '读文件' }, undefined, 'b6')
  await dispatchTurnFor('b6', assistantSurface('可以合并'))
  return steered.length === 1 && /独立观察者/.test(steered[0].content[0].text)
})())
await ok('有编辑的实现任务不走审查结论路', (async () => {
  await dispatchPostAs('edit', { file_path: path.join(sessionRoot, 'j.py') }, undefined, 'b7')
  await dispatchPostAs('probe', { code: 'print(1)' }, undefined, 'b7')
  await dispatchTurnFor('b7', assistantSurface('LGTM'))
  return steered.length === 0
})())
await ok('commit-blind 同会话不重复', (async () => {
  await dispatchTurnFor('b8', assistantSurface('APPROVE'))
  const first = steered.length
  await dispatchTurnFor('b8', assistantSurface('APPROVE'))
  return first === 1 && steered.length === 0
})())
await ok('readSurface 抛错静默', (async () => {
  sessionQueryMock = { readSurface: async () => { throw new Error('boom') } }
  steered = []
  await turnStopping[0]({ agent: mkAgent('b9'), turn: 1, signal: undefined })
  return steered.length === 0
})())

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
}

main()
