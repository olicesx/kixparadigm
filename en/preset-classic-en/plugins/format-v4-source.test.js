// format-v4-source.test.js — 消息 source 必须是 v4 生产者自有 kind（回归守卫）
//
// 背景（2026-09-29 实弹事故）：
//   DSH 0.2.0-rc.1 会话格式 v4 在 inbox-splice 准入时硬拒绝已退役的
//   source:{kind:'plugin', plugin:'X'} —— 报错
//   "format v4 message requires a producer-owned source kind"，
//   任何 kix 插件 steer()/additionalContexts 注入都会炸掉整轮运行。
//   v3→v4 迁移器把它映射为 {kind:'plugin:X'}；插件必须直接产出该形状。
//
// 本测试两层：
//   ① 静态扫描：本目录插件源码零退役语法；所有 plugin: kind 形状合法。
//   ② 运行时准入（可解析到 DSH 安装时）：对每个生产者 kind 构造
//      agent/inbox/spliced 行跑真 assertV4RowAdmission，并用一个退役形状
//      对照组证明校验器确实在拒（防止静默跳过）。
'use strict'
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const DIR = __dirname
let passed = 0
function ok(name, cond) { assert.ok(cond, name); passed++; console.log('  PASS', name) }

// ① 静态扫描 —— 零退役语法，plugin: kind 全部形状合法
const names = fs.readdirSync(DIR).filter((f) => /\.(js|cjs)$/.test(f) && !f.endsWith('.test.js')).sort()
ok('插件目录非空', names.length > 0)
const kinds = new Set()
for (const name of names) {
  const text = fs.readFileSync(path.join(DIR, name), 'utf8')
  ok(`${name} 无退役 kind:'plugin' 包装`, !/kind: 'plugin',\s*plugin:/.test(text))
  for (const m of text.matchAll(/source: \{ kind: '(plugin:[^']*)'/g)) {
    ok(`${name} 生产者 kind 形状合法：${m[1]}`, /^plugin:[a-z0-9-]+$/.test(m[1]))
    kinds.add(m[1])
  }
}
ok('至少覆盖一个 plugin: 生产者 kind', kinds.size > 0)

// ② 运行时准入 —— 找到 DSH 安装里的 v3-to-v4 校验器（找不到则跳过本层）
let validator = null
try {
  const { resolveRuntime } = require(path.join(DIR, '..', '..', '..', 'scripts', 'dsh-runtime-resolve.js'))
  const rt = resolveRuntime()
  const scope = rt && rt.dshDir ? path.join(rt.dshDir, '..') : null
  const pkg = scope ? path.join(scope, 'dsh-session-format-v3-to-v4', 'lib', 'index.js') : null
  if (pkg && fs.existsSync(pkg)) validator = require(pkg)
} catch { /* 保持 null：跳过运行时层 */ }

if (validator && typeof validator.assertV4RowAdmission === 'function') {
  const rowFor = (message) => ({
    type: 'agent/inbox/spliced', seq: 1, time: Date.now(),
    data: { target: 'next-step', start: 0, inserted: [message] },
  })
  const msgFor = (kind) => ({
    id: 'regression-' + kind.replace(/[^a-z0-9-]/g, ''), role: 'user',
    content: [{ type: 'text', text: 'kix 回归：' + kind }],
    source: { kind, form: 'notice', summary: 'regression' },
  })
  for (const kind of [...kinds].sort()) {
    let admitted = true
    try { validator.assertV4RowAdmission(rowFor(msgFor(kind))) } catch { admitted = false }
    ok(`v4 准入接受 ${kind}`, admitted)
  }
  let rejected = false
  try {
    validator.assertV4RowAdmission(rowFor({ ...msgFor('plugin:kix-regression'), source: { kind: 'plugin', plugin: 'kix-regression' } }))
  } catch (e) { rejected = String(e.message).includes('producer-owned source kind') }
  ok('对照组：退役形状仍被 v4 拒绝（校验器在位）', rejected)
} else {
  console.log('  SKIP 运行时准入层（未解析到 DSH 安装；静态扫描层已通过）')
}

console.log(`format-v4-source: ${passed} 项全部通过`)
