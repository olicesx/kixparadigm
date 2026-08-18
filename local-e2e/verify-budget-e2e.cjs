#!/usr/bin/env node
// Explicit-ledger live kix-budget verifier. Never guesses among stale session directories.
// v2 (2026-08-18): ①纯 node 多帧 zstd 解压（DSH 每事件一帧级联流，免外部 CLI）；
// ②谓词 A 增加等价证据通道——真实 deny（isError:true + gate 文本）与 form:'gate' steer
//   同为「结构化 gate 注入」的证据（机制契约：回合内完成交接则 turn-stopping steer 按
//   设计不触发，真实 deny 是该形态下的正确证据）；
// ③谓词 C 只计 isError:true 结果中的插件错误文本——源码文件读取回显中的同形字符串
//   不再误计（结构性误报修复，不弱化：真实持久化错误仍被捕获）。
'use strict'
const fs = require('node:fs')
const z = require('node:zlib')
const argv = process.argv.slice(2)
const ledger = argv.find((x) => x.endsWith('.jsonl.zstd'))
if (!ledger) { console.error('usage: node verify-budget-e2e.cjs /path/session.jsonl.zstd [minSteps] [expectedMarkers] [--expect-focus]'); process.exit(2) }
const numeric = argv.filter((x) => /^\d+$/.test(x)).map(Number)
const minSteps = numeric[0] || 20
const expectedMarkers = numeric[1] || 0
const expectFocus = argv.includes("--expect-focus")

// 多帧 zstd 解压（魔数 0x28 B5 2F FD；贪心逐帧，边界失败扩展重试防压缩数据内偶现魔数）
const b = fs.readFileSync(ledger)
const magics = []
for (let i = 0; i + 3 < b.length; i++) {
  if (b[i] === 0x28 && b[i + 1] === 0xb5 && b[i + 2] === 0x2f && b[i + 3] === 0xfd) magics.push(i)
}
let jsonl = ''
if (!magics.length || magics[0] !== 0) {
  jsonl = z.zstdDecompressSync(b).toString('utf8')
} else {
  const parts = []
  let start = 0
  let mi = 1
  while (start < b.length) {
    const end = mi < magics.length ? magics[mi] : b.length
    try {
      parts.push(z.zstdDecompressSync(b.subarray(start, end)))
      start = end
      mi++
    } catch (e) {
      if (mi < magics.length) { mi++ } else { throw e }
    }
  }
  jsonl = Buffer.concat(parts).toString('utf8')
}

let turnEnds = 0, steps = 0, currentCtx = 0, total = 0
let advisoryStreak = 0, advisoryBudget = 0, gateSources = 0, gateMessages = 0, realDenies = 0
let goalChanges = 0, continueSignals = 0, budgetErrors = 0, lastAssistant = ""
let pruneEvents = 0, replacements = 0, pairedReplacements = 0
let autoActivated = 0, deferred = 0
const pruneContexts = []
const resultCallBySeq = new Map()
const pendingPruneCalls = new Set()
function textOf(value) {
  const out = []
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    if (typeof node.text === 'string') out.push(node.text)
    if (node.content) visit(node.content)
    if (node.message) visit(node.message)
    if (node.data) visit(node.data)
  }
  visit(value)
  return out.join('\n')
}
for (const line of jsonl.split('\n')) {
  if (!line.trim()) continue
  let r; try { r = JSON.parse(line) } catch { continue }
  const d = r.data || {}
  if (r.type === 'turn/end') turnEnds++
  if (r.type === 'step/end') steps++
  if (r.type === 'assistant/message' && d.usage) { currentCtx = (d.usage.inputTokens || 0) + (d.usage.cacheReadTokens || 0) + (d.usage.cacheWriteTokens || 0); total += currentCtx; const c = d.message && d.message.content; if (Array.isArray(c)) lastAssistant = c.filter((blk) => blk.type === 'text').map((blk) => blk.text).join('\n') }
  if (r.type === 'compaction/prune') {
    pruneEvents++
    pruneContexts.push(currentCtx)
    const start = d.shadowedRange && Number(d.shadowedRange.start)
    const originalCallId = Number.isFinite(start) ? resultCallBySeq.get(start) : undefined
    if (originalCallId) pendingPruneCalls.add(originalCallId)
  }
  const op = r.surfaceOp || d.surfaceOp
  if (r.type === 'tool/result') {
    const callId = d.message && d.message.source && d.message.source.callId
    if (callId) resultCallBySeq.set(Number(r.seq), String(callId))
    if (op && (op === 'replace' || op.op === 'replace')) {
      replacements++
      if (callId && pendingPruneCalls.has(String(callId))) { pairedReplacements++; pendingPruneCalls.delete(String(callId)) }
    }
  }
  const isErrorResult = r.type === 'tool/result' && line.includes('"isError":true')
  if (r.type === 'user/message' || r.type === 'tool/result') {
    const txt = textOf(r)
    if (txt.includes('kix-budget: 主线程已连续')) advisoryStreak++
    if (txt.includes('kix-budget: 上下文已达')) advisoryBudget++
    if (txt.includes('kix-budget gate:') && /当前工具调用已拒绝|下一步只能/.test(txt)) gateMessages++
    // 真实 deny：错误结果 + gate 拒绝文本（非源码回显——回显不是 isError）
    if (isErrorResult && txt.includes('kix-budget gate:') && txt.includes('当前工具调用已拒绝')) realDenies++
    // 持久化插件错误：仅错误结果计数（文件读取回显中的同形字符串不计）
    if (isErrorResult && /kix-budget: (pre-step processing skipped|post-execute processing skipped|handoff steer skipped)/.test(txt)) budgetErrors++
  }
  if (r.type === 'tool/result' && line.includes('autoActivated')) autoActivated++
  if (r.type === 'tool/result' && line.includes('deferred')) deferred++
  if (r.type === 'goal/change' && d.operation === 'create') goalChanges++
  if ((r.type === 'command/run' || r.type === 'command/done') && line.includes('kixpower-continue')) continueSignals++
  if (r.type === 'tool/result' && /kix-budget: 主线程已连续/.test(line)) advisoryStreak = advisoryStreak || 1
  if (r.type === 'tool/result' && /kix-budget: 上下文已达/.test(line)) advisoryBudget = advisoryBudget || 1
  const source = d.source || (d.message && d.message.source) || r.source
  if (source && source.plugin === 'kix-budget' && source.form === 'gate') gateSources++
}
const markers = (lastAssistant.match(/MARKER-\d{2}/g) || [])
console.log(`ledger=${ledger}`)
console.log(`turnEnds=${turnEnds} steps=${steps} ctxSamples=${total ? "yes" : "no"} totalReprocessed=${total.toLocaleString()}`)
console.log(`advisories: streak=${advisoryStreak} budget=${advisoryBudget} gates=${gateSources}/${gateMessages} realDenies=${realDenies} pruneEvents=${pruneEvents} replacements=${replacements} paired=${pairedReplacements} pruneCtx=${pruneContexts.length ? Math.min(...pruneContexts) + '-' + Math.max(...pruneContexts) : 0} focus=${autoActivated}/${deferred} goals=${goalChanges} continue=${continueSignals} budgetErrors=${budgetErrors}`)
console.log(`task completion: markers=${markers.length}/${expectedMarkers || "not-required"}`)
const okA = (gateSources > 0 && gateMessages > 0) || realDenies > 0
const okB = pruneEvents > 0 && pairedReplacements >= pruneEvents
const okC = budgetErrors === 0
const okD = steps >= minSteps
const okE = markers.length >= expectedMarkers
const okF = !expectFocus || (autoActivated > 0 && deferred > 0 && goalChanges > 0 && turnEnds > 1)
console.log(`A structured gate injected (steer or real deny): ${okA ? "PASS" : "FAIL"}`)
console.log(`B replacement evidence (attribution-neutral): ${okB ? "PASS" : "FAIL"}`)
console.log(`C no persisted processing errors: ${okC ? "PASS" : "FAIL"}`)
console.log(`D enough steps: ${okD ? "PASS" : "FAIL"}`)
console.log(`E expected markers: ${okE ? "PASS" : "FAIL"}`)
console.log(`F focus/goal evidence: ${okF ? "PASS" : "FAIL"}`)
const pass = okA && okB && okC && okD && okE && okF
console.log(pass ? "LIVE-E2E-ACCEPT" : "LIVE-E2E-REJECT")
process.exit(pass ? 0 : 1)
