#!/usr/bin/env node
'use strict'
const { execFileSync } = require('node:child_process')
const ledger = process.argv[2]
if (!ledger) { console.error('usage: node verify-focus-e2e.cjs /path/session.jsonl.zstd'); process.exit(2) }
const jsonl = execFileSync('zstd', ['-dc', ledger], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
const events = []
const results = new Map()
const headers = []
let firstTurnEndSeq = Infinity
let goalCreates = 0
let goalCompletes = 0
function argsOf(value) { if (typeof value !== 'string') return value || {}; try { return JSON.parse(value) } catch { return {} } }
function resultFor(call) { return call && results.get(String(call.callId)) }
for (const line of jsonl.split("\n")) {
  if (!line.trim()) continue
  let r; try { r = JSON.parse(line) } catch { continue }
  const d = r.data || {}
  if (r.type === "request/header") headers.push({ seq: r.seq, tools: (d.header && d.header.tools || []).map((x) => x.name) })
  if (r.type === "turn/end" && d.turn === 1) firstTurnEndSeq = Math.min(firstTurnEndSeq, Number(r.seq))
  if (r.type === "goal/change") { if (d.operation === "create") goalCreates++; if (d.operation === "complete") goalCompletes++ }
  if (r.type === "tool/call") {
    const call = { seq: Number(r.seq), turn: Number(d.turn), callId: d.callId, name: String(d.name || ""), args: argsOf(d.arguments) }
    events.push(call)
  }
  if (r.type === "tool/result") {
    const callId = d.message && d.message.source && d.message.source.callId
    if (callId) results.set(String(callId), { seq: Number(r.seq), turn: Number(d.turn), raw: JSON.stringify(d), error: JSON.stringify(d).includes("\"isError\":true") })
  }
}
const firstTurn = events.filter((x) => x.turn === 1)
const create = firstTurn.find((x) => x.name === "kix_capability_call" && x.args && x.args.tool === "create_goal")
const deactivate = firstTurn.find((x) => x.name === "kix_tool_deactivate" && x.args && x.args.tool === "goal")
const directGet = firstTurn.find((x) => x.name === "get_goal")
const update = firstTurn.find((x) => x.name === "update_goal" && x.args && x.args.action === "complete")
const createResult = resultFor(create)
const deactivateResult = resultFor(deactivate)
const getResult = resultFor(directGet)
const updateResult = resultFor(update)
const createOk = Boolean(createResult && !createResult.error && createResult.raw.includes("autoActivated") && createResult.raw.includes("create_goal"))
const deferredOk = Boolean(deactivateResult && !deactivateResult.error && deactivateResult.raw.includes("deferred") && deactivateResult.raw.includes("true"))
const sameTurnGetOk = Boolean(directGet && getResult && !getResult.error)
const updateOk = Boolean(update && updateResult && !updateResult.error)
const flushHeader = headers.filter((x) => x.seq > firstTurnEndSeq)[0]
const goalNames = new Set(["create_goal", "get_goal", "update_goal"])
const removedAfterFlush = Boolean(flushHeader && flushHeader.tools.every((x) => !goalNames.has(x)))
console.log("ledger=" + ledger)
console.log("create=" + createOk + " autoActivated=" + Boolean(createResult && createResult.raw.includes("autoActivated")) + " goalChanges=" + goalCreates)
console.log("deferred=" + deferredOk + " sameTurnGet=" + sameTurnGetOk + " updateComplete=" + updateOk)
console.log("flushHeader=" + (flushHeader ? flushHeader.seq : "missing") + " goalToolsRemoved=" + removedAfterFlush + " goalCompletes=" + goalCompletes)
const pass = createOk && deferredOk && sameTurnGetOk && updateOk && goalCreates > 0 && goalCompletes > 0 && removedAfterFlush
console.log(pass ? "FOCUS-E2E-ACCEPT" : "FOCUS-E2E-REJECT")
process.exit(pass ? 0 : 1)
