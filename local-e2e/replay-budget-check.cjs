#!/usr/bin/env node
// replay-budget-check.cjs — v6 回放：真实 gate/prune/handoff 账本（零 LLM 成本）
//
// 输入：解压后的 session.jsonl（真实 kixpower 整改会话，336 步 / 100.8M 重读）
// 做三件事：
//   1. 用 kix-budget.__internals 的真实判定逻辑回放整条轨迹：
//      - streak advisory 会在哪些步触发
//      - step/context gate 会在哪些步触发，及是否出现真实拒绝/交接调用
//   2. 只读步占比统计（⑳ 的实证：orchestrator 本体在做机械活）
//   3. 反事实投影：动态预算（默认绝对帽 150K）下 Σ min(ctx,budget) vs 实测 Σctx
// 用法：node replay-budget-check.cjs <session.jsonl> [contextWindow]
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const I = require(path.join(__dirname, '..', 'dsh', 'preset', 'plugins', 'kix-budget.js')).__internals

const file = process.argv[2]
const window_ = Number(process.argv[3]) || 1000000
if (!file) { console.error('usage: node replay-budget-check.cjs <session.jsonl> [contextWindow]'); process.exit(1) }

const budget = I.resolveBudgetTokens(window_, I.DEFAULTS)
const pruneLine = Math.floor(budget * I.DEFAULTS.pruneRatio)

let seq = 0
let streak = 0
let advisedStreak = false
let advisedBudget = false
let turn = 0
let turnStep = 0
let ctxNow = 0
let handoffRequired = false
let handoffSatisfied = false
let realGateDenies = 0
let transitionCalls = 0
let pruneEvents = 0
const transitionByCall = new Map()
const events = []
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue
  let r
  try { r = JSON.parse(line) } catch { continue }
  seq = r.seq ?? seq
  const d = r.data || {}
  if (r.type === 'turn/start') { turn = d.turn ?? turn; turnStep = 0; streak = 0; advisedStreak = false; advisedBudget = false; handoffSatisfied = false; events.push({ kind: 'turn', turn }) }
  else if (r.type === 'step/start') {
    turnStep = Number(d.step) || turnStep
    if (!handoffRequired && !handoffSatisfied && turnStep > I.DEFAULTS.turnStepLimit) { handoffRequired = true; events.push({ kind: 'STEP-GATE', seq, turn, step: turnStep }) }
  }
  else if (r.type === 'compaction/prune') { pruneEvents++; events.push({ kind: 'PRUNE', seq, turn, step: turnStep }) }
  else if (r.type === 'tool/call') {
    let args
    try { args = typeof d.arguments === 'string' ? JSON.parse(d.arguments || '{}') : (d.arguments || {}) } catch { args = {} }
    const ro = I.isReadOnlyTool(d.name, args)
    streak = ro ? streak + 1 : 0
    const transition = I.transitionToolOf({ name: d.name, arguments: args })
    if (transition) {
      transitionCalls++
      if (d.callId) transitionByCall.set(String(d.callId), transition)
    }
    events.push({ kind: 'call', seq, name: d.name, ro, streak, transition, cmd: (args.command || '').slice(0, 80) })
    if (!advisedStreak && streak >= I.DEFAULTS.streakReadOnly) {
      advisedStreak = true
      events.push({ kind: 'STREAK-ADV', seq, turn, streak })
    }
  } else if (r.type === 'tool/result') {
    const raw = JSON.stringify(d)
    const normalized = raw.replace(/\\/g, '')
    const callId = d.message && d.message.source && d.message.source.callId
    const transition = callId && transitionByCall.get(String(callId))
    if (raw.includes('Error: kix-budget gate')) { realGateDenies++; events.push({ kind: 'GATE-DENY', seq, turn, step: turnStep }) }
    if (transition && normalized.includes('\"ok\":true') && !normalized.includes('\"ok\":false') && !normalized.includes('\"isError\":true') && handoffRequired) { handoffRequired = false; handoffSatisfied = true; events.push({ kind: 'HANDOFF-OK', seq, turn, step: turnStep }) }
    if (callId) transitionByCall.delete(String(callId))
  } else if (r.type === 'assistant/message' && d.usage) {
    ctxNow = I.usageContextTokens(d.usage)
    events.push({ kind: 'ctx', seq, turn, ctx: ctxNow })
    if (!advisedBudget && ctxNow >= budget) {
      advisedBudget = true
      events.push({ kind: 'BUDGET-GATE', seq, turn, ctx: ctxNow }); handoffRequired = true
    }
  }
}

// 统计与投影
const calls = events.filter((e) => e.kind === 'call')
const readOnly = calls.filter((e) => e.ro)
const ctxs = events.filter((e) => e.kind === 'ctx').map((e) => e.ctx)
const totalCtx = ctxs.reduce((a, b) => a + b, 0)
const cappedCtx = ctxs.map((c) => Math.min(c, budget)).reduce((a, b) => a + b, 0)
const above = ctxs.filter((c) => c >= budget).length
const abovePrune = ctxs.filter((c) => c >= pruneLine).length
const advs = events.filter((e) => e.kind === 'STREAK-ADV')
const gates = events.filter((e) => e.kind === 'STEP-GATE' || e.kind === 'BUDGET-GATE' || e.kind === 'GATE-DENY')
const handoffs = events.filter((e) => e.kind === 'HANDOFF-OK')

console.log(`== replay: ${path.basename(file)} ==`)
console.log(`window=${window_.toLocaleString()}  budget=min(35%×W,150K)=${budget.toLocaleString()}  prune-line=${pruneLine.toLocaleString()}`)
console.log(`tool calls: ${calls.length}  read-only(allowlist): ${readOnly.length} (${Math.round(100 * readOnly.length / Math.max(calls.length, 1))}%)`)
console.log(`ctx samples: ${ctxs.length}  peak=${Math.max(...ctxs).toLocaleString()}  avg=${Math.round(totalCtx / Math.max(ctxs.length, 1)).toLocaleString()}`)
console.log(`steps ≥ budget(${budget.toLocaleString()}): ${above}   steps ≥ prune-line: ${abovePrune}`)
console.log(`streak advisories=${advs.length}  gate events=${gates.length} (real denies=${realGateDenies})  transitions=${transitionCalls}  handoff-ok=${handoffs.length}  prune-events=${pruneEvents}`)
for (const a of advs) console.log(`  [${a.kind}] turn ${a.turn} @seq ${a.seq}${a.ctx ? ' ctx=' + a.ctx.toLocaleString() : ' streak=' + a.streak}`)
console.log(`reprocessed actual:  ${totalCtx.toLocaleString()} tokens`)
console.log(`reprocessed @dynamic budget cap: ${cappedCtx.toLocaleString()} tokens  (↓${Math.round(100 * (1 - cappedCtx / totalCtx))}%)`)
const replayPass = gates.length > 0 && realGateDenies > 0 && transitionCalls > 0 && handoffs.length > 0 && pruneEvents > 0
console.log(replayPass ? 'REPLAY-ACCEPT: gate + deny + handoff + prune exercised' : 'REPLAY-REJECT')
if (!replayPass) process.exit(1)
