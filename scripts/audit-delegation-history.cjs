#!/usr/bin/env node
// audit-delegation-history — 编曲涌现审计（2026-08-19，v7 编曲保育配套度量）
//
// 回答一个问题：成本优化是否压制了自主组队（v7 编曲能力）？
// 方法：离线扫 DSH 会话库（session.jsonl.zstd，多帧 zstd + JSONL），
//   主会话只解析 type=tool/call 事件；子会话按 descriptor agentModel 分类
//   （cross / lite / regular），按天聚合。header/schema/prompt 内工具名不计。
//   同时按父会话真实工具名统计 member/reviewer/qa/dev/generic/cross 调用，避免
//   generic subagent 仅凭 "review" label 被误算成 kixpower 成员。
//   MEMBER_DROUGHT：有源编辑但 reviewer/dev/qa/cross 实际调用为 0。
//
// 用法：
//   node scripts/audit-delegation-history.cjs [sessionsRoot]
//   默认根：Windows ~/.dsh/sessions 下的 kix-bundle 目录（可传任意项目目录）
// 输出：stdout 表格 + MEMBER_DROUGHT 标记；--json 输出机器可读格式。
//
// 设计依据：kix-orchestration-lessons ⑥（度量涌现而非假设涌现）。
// 零运行时成本（不挂插件、不进 preset），纯事后审计——candidate 状态。

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')

// ── 参数 ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const asJson = args.includes('--json')
// 候选根：WSL 侧挂载的 Windows home 优先（真实历史库），本机 ~/.dsh 兜底
const candidates = [
  path.join(os.homedir() === '/root' ? '/mnt/c/Users/37112' : os.homedir(), '.dsh', 'sessions'),
  path.join(os.homedir(), '.dsh', 'sessions'),
]
const projectDir = '--C-Users-37112-Desktop-kix-bundle--'
const explicit = args.find((a) => !a.startsWith('--'))
let root = explicit
if (!root) {
  for (const c of candidates) {
    const p = path.join(c, projectDir)
    if (fs.existsSync(p)) { root = p; break }
  }
}

// ── 多帧 zstd 解码 ──────────────────────────────────────────────────────────
function decodeZstd(buf) {
  // session.jsonl.zstd 是逐行追加的多帧流；decompressSync 只解第一帧。
  // 按帧边界循环解压：zstd 帧头 magic 0x28B52FFD（小端 FD2FB528）。
  const chunks = []
  let off = 0
  while (off < buf.length) {
    // 跳过可能的 skippable 帧（0x184D2A5x）
    if (off + 4 <= buf.length && buf.readUInt32LE(off) >>> 20 === 0x184D2) {
      const frameSize = buf.readUInt32LE(off + 4)
      off += 8 + frameSize
      continue
    }
    let decoded = null
    try { decoded = zlib.zstdDecompressSync(buf.subarray(off)) } catch { break }
    if (!decoded || decoded.length === 0) break
    chunks.push(decoded)
    // 找下一帧：从当前偏移线性扫描 magic（解压成功说明至少有一帧，但
    // zstdDecompressSync 不告知消费的输入长度——按输出内容推进不可行，
    // 改用逐帧探测：解到无法再推进为止，用 magic 扫描定位下一帧起点）。
    let next = -1
    for (let i = off + 4; i <= buf.length - 4; i++) {
      if (buf.readUInt32LE(i) === 0xfd2fb528) { next = i; break }
      if (buf[i - 4] === 0x00 && buf[i - 3] === 0x00 && buf[i - 2] === 0x00 && buf[i - 1] === 0x00) {
        // 帧尾 padding 后的 magic 更常见——宽松继续
      }
    }
    if (next === -1) break
    off = next
  }
  // 退化路径：整缓冲一次解（服务单帧或 zlib 兼容流）
  if (chunks.length === 0) {
    try { chunks.push(zlib.zstdDecompressSync(buf)) } catch { return null }
  }
  return Buffer.concat(chunks)
}

// 更稳的方案：unzstd CLI（处理多帧流是它的本职）。优先 CLI，失败退化纯 JS。
function decodeSession(file) {
  try {
    const { execFileSync } = require('node:child_process')
    const out = execFileSync('unzstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024, timeout: 30000 })
    return out.toString('utf8')
  } catch {
    const buf = fs.readFileSync(file)
    const decoded = decodeZstd(buf)
    return decoded ? decoded.toString('utf8') : null
  }
}

// ── 解析 ────────────────────────────────────────────────────────────────────
function firstJsonLines(text, n) {
  const out = []
  for (const ln of text.split('\n')) {
    if (!ln.trim()) continue
    try { out.push(JSON.parse(ln)) } catch { /* 跨帧断裂行：忽略 */ }
    if (out.length >= n) break
  }
  return out
}

function classifyChild(lines) {
  let model = ''
  for (const event of lines.slice(0, 6)) {
    if (event && event.type === 'subagent/descriptor' && event.data) {
      model = String(event.data.agentModel || '')
      break
    }
  }
  if (model.includes('kix-route:cross') || model.includes('zhipu')) return 'cross'
  if (model.includes('lite') || model.includes('glm-4.7') || model.includes('glm-4.5-air')) return 'lite'
  return 'regular'
}

function toolCallEvents(text) {
  const calls = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event && event.type === 'tool/call' && typeof event.data?.name === 'string') calls.push(event.data)
    } catch { /* 跨帧断裂行：忽略 */ }
  }
  return calls
}

function toolCallNames(text) {
  return toolCallEvents(text).map((call) => call.name)
}

const SOURCE_PATH_RE = /\.(?:c|cc|cpp|h|hpp|cs|go|rs|py|rb|php|java|kt|kts|swift|js|cjs|mjs|jsx|ts|cts|mts|tsx|vue|svelte|css|scss|less|html|sql|sh|bash|zsh|ps1|psm1|yml|yaml|json|jsonc|toml|ini|conf)$/i

function toolArguments(call) {
  const raw = call && call.arguments
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string') return {}
  try { return JSON.parse(raw) } catch { return {} }
}

function recordToolCall(slot, call) {
  const name = typeof call === 'string' ? call : String(call?.name || '')
  if (name === 'run_code') slot.runCode += 1
  else if (name === 'workflow') slot.workflow += 1
  else if (name === 'kix_capability_call') slot.capability += 1
  else if (name === 'kix_tool_activate') slot.activate += 1
  else if (name === 'create_goal') slot.goal += 1
  else if (name === 'edit' || name === 'write') {
    const filePath = String(toolArguments(call).file_path || '')
    if (SOURCE_PATH_RE.test(filePath)) slot.sourceEdits += 1
  } else if (name.startsWith('subagent')) {
    slot.spawnCalls += 1
    if (name === 'subagent_reviewer') { slot.memberCalls += 1; slot.reviewerCalls += 1 }
    else if (name === 'subagent_qa') { slot.memberCalls += 1; slot.qaCalls += 1 }
    else if (name === 'subagent_dev') { slot.memberCalls += 1; slot.devCalls += 1 }
    else if (name === 'subagent_cross') slot.crossCalls += 1
    else if (name === 'subagent') slot.genericCalls += 1
  }
}

function main() {
  if (!fs.existsSync(root)) {
    console.error(`sessions root not found: ${root}`)
    process.exit(1)
  }
  const days = {}
  const dirs = fs.readdirSync(root).filter((d) => {
    try { return fs.statSync(path.join(root, d)).isDirectory() } catch { return false }
  })
  for (const d of dirs) {
    const file = path.join(root, d, 'session.jsonl.zstd')
    let mt
    try { mt = fs.statSync(file).mtime } catch { continue }
    const day = `${mt.getFullYear()}-${String(mt.getMonth() + 1).padStart(2, '0')}-${String(mt.getDate()).padStart(2, '0')}`
    const text = decodeSession(file)
    if (!text) continue
    const lines = text.split('\n').filter(Boolean)
    let hdr
    try { hdr = JSON.parse(lines[0]) } catch { continue }
    const slot = days[day] ?? (days[day] = {
      mainSessions: 0, childSessions: 0, spawnCalls: 0, runCode: 0,
      workflow: 0, capability: 0, activate: 0, goal: 0, sourceEdits: 0,
      memberCalls: 0, reviewerCalls: 0, qaCalls: 0, devCalls: 0,
      genericCalls: 0, crossCalls: 0,
      cross: 0, lite: 0, regular: 0,
    })
    if ('parentSession' in hdr) {
      slot.childSessions += 1
      slot[classifyChild(firstJsonLines(text, 6))] += 1
    } else {
      slot.mainSessions += 1
      for (const call of toolCallEvents(text)) recordToolCall(slot, call)
    }
  }

  const sorted = Object.entries(days).sort(([a], [b]) => a.localeCompare(b))
  if (asJson) {
    console.log(JSON.stringify({ root, days: Object.fromEntries(sorted) }, null, 2))
    return
  }
  console.log(`# delegation audit: ${root}`)
  console.log('day         main child spawn member rev qa dev generic xcall run_code  wf edits cross  drought')
  let droughtDays = 0
  for (const [day, s] of sorted) {
    const heavyMain = s.mainSessions
    const drought = s.memberCalls + s.crossCalls === 0 && s.sourceEdits >= 3 && heavyMain > 0
    if (drought) droughtDays += 1
    const flag = drought ? 'MEMBER_DROUGHT' : '-'
    console.log(
      `${day}  ${String(s.mainSessions).padStart(4)} ${String(s.childSessions).padStart(5)}`
      + ` ${String(s.spawnCalls).padStart(5)} ${String(s.memberCalls).padStart(6)}`
      + ` ${String(s.reviewerCalls).padStart(3)} ${String(s.qaCalls).padStart(2)}`
      + ` ${String(s.devCalls).padStart(3)} ${String(s.genericCalls).padStart(7)}`
      + ` ${String(s.crossCalls).padStart(5)} ${String(s.runCode).padStart(8)}`
      + ` ${String(s.workflow).padStart(3)} ${String(s.sourceEdits).padStart(5)}`
      + ` ${String(s.cross).padStart(5)}  ${flag}`,
    )
  }
  console.log(`\nmember-drought days: ${droughtDays}/${sorted.length}`)
  console.log('member-drought = 当日实际 reviewer/dev/qa/cross 工具调用为 0，且主线程源编辑 ≥3 次')
}

if (require.main === module) main()

module.exports = { decodeSession, firstJsonLines, classifyChild, toolCallEvents, toolCallNames, recordToolCall, SOURCE_PATH_RE }
