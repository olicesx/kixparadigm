#!/usr/bin/env node
'use strict'
const { execFileSync } = require('node:child_process')
const ledger = process.argv[2]
if (!ledger) { console.error('usage: node verify-child-e2e.cjs /path/child-session.jsonl.zstd'); process.exit(2) }
// v2: C 谓词对齐机制现实——lite child 的工具面裁剪在 SDK tools 表层面强制：
// run_code 内访问 denied 工具是 TypeError（error result 记账），不存在
// "发出 tool/call(name∈denied) → 门禁拒绝" 的通道（child 面根本没有这些工具）。
// 证据形式 = 主动探测（run_code arguments 引用越权工具名）+ 对应 error result
// 含 "tools.<name> is not a function"。要求 subagent 直呼与 kix_capability_call
// 代理两条路径都被强制（强度不低于 v1 的 denyCalls>0 && (unknownDeny||guardDeny)）。
const jsonl = execFileSync('zstd', ['-dc', ledger], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
const denied = new Set(['exit_plan_mode', 'subagent', 'subagent_cross', 'interrupt_agent', 'send_message', 'list_agents', 'ask_user_question', 'kix_tool_activate', 'kix_tool_deactivate'])
const probeRefs = new Set()
const sdkDenyNames = new Set()
let header = null, firstCtx = 0, prunes = 0, lastText = ""
for (const line of jsonl.split('\n')) {
  if (!line.trim()) continue
  let r; try { r = JSON.parse(line) } catch { continue }
  const d = r.data || {}
  if (r.type === 'request/header' && !header) header = d.header || {}
  if (r.type === 'assistant/message') {
    if (!firstCtx && d.usage) firstCtx = (d.usage.inputTokens || 0) + (d.usage.cacheReadTokens || 0)
    const content = d.message && d.message.content
    if (Array.isArray(content)) lastText = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  }
  if (r.type === 'compaction/prune') prunes++
  if (r.type === 'tool/call') {
    const name = String(d.name || '')
    const args = typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments || {})
    if (name === 'run_code') {
      for (const probe of ['subagent', 'kix_capability_call']) {
        if (args.includes(probe)) probeRefs.add(probe)
      }
    }
  }
  if (r.type === 'tool/result') {
    // TypeError 证据在 run_code 的正常输出文本里（探测代码 try/catch 捕获后打印），
    // isError 标志为 false 是正确语义——强制发生在 SDK tools 表访问层。
    const raw = JSON.stringify(d.message || d)
    for (const m of raw.matchAll(/tools\.(\w+) is not a function/g)) {
      if (denied.has(m[1]) || m[1] === 'kix_capability_call') sdkDenyNames.add(m[1])
    }
  }
}
const tools = (header && header.tools || []).map((x) => x.name)
const system = (header && header.system) || ''
const deniedLeak = [...denied].filter((x) => tools.includes(x) || system.includes('Writing code for ' + x))
const markers = (lastText.match(/ENDMARK-\d{2}/g) || []).length
const okA = deniedLeak.length === 0
const okB = firstCtx > 0 && firstCtx < 16000
const okC = probeRefs.has('subagent') && probeRefs.has('kix_capability_call') && sdkDenyNames.has('subagent') && sdkDenyNames.has('kix_capability_call')
const okD = prunes > 0
const okE = markers >= 8
console.log(`ledger=${ledger}`)
console.log(`tools=${tools.length} firstCtx=${firstCtx} probes=[${[...probeRefs].join(',')}] sdkDeny=[${[...sdkDenyNames].join(',')}] prunes=${prunes} markers=${markers}`)
console.log(`A surface=${okA ? "PASS" : "FAIL"} B overhead=${okB ? "PASS" : "FAIL"} C sdk-deny=${okC ? "PASS" : "FAIL"} D prune=${okD ? "PASS" : "FAIL"} E task=${okE ? "PASS" : "FAIL"}`)
const pass = okA && okB && okC && okD && okE
console.log(pass ? "CHILD-E2E-ACCEPT" : "CHILD-E2E-REJECT")
process.exit(pass ? 0 : 1)
