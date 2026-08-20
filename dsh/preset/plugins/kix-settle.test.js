// kix-settle 回归测试（P0，2026-08-20 补齐投递端后建立）
//
// 单元级验证：加载 kix-settle.js，mock DSH post-execute / agent/turn-stopping
// 派发，覆盖：
//   - 监听器注册：post-execute 观察 + turn-stopping 投递各一个
//   - post-execute 记账：edit/write 计数、probe/run_code/执行类 bash 记为证据
//   - turn-stopping 投递：有编辑 + 末次编辑后无执行 → steer 单发；
//     有执行证据 → 不提醒；无编辑 → 不提醒；reminded 单发不重复
//   - 工作区外文件不计入编辑
// 运行：node plugins/kix-settle.test.js

const path = require('node:path')
const assert = require('node:assert')
const os = require('node:os')
const fs = require('node:fs')

// ── mock ctx ───────────────────────────────────────────────────────────────
const listeners = {}
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
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

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
}

main()
