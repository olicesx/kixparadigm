#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { decodeSession } = require('./audit-delegation-history.cjs')
const { extractPersona } = require('../dsh/preset/plugins/consistency-lib.cjs')

const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_LARGE_RESULT_BYTES = 16 * 1024
const ALLOWED_CARRIERS = new Set(['choice-pressure', 'incentive', 'mechanism', 'audit', 'memory'])
const DIRECT_DATA_TOOLS = new Set(['bash', 'browser', 'glob', 'grep', 'probe', 'read', 'web_search'])
const SOURCE_EDIT_TOOLS = new Set(['edit', 'write'])
const OBSERVER_TOOLS = new Set(['subagent_cross', 'subagent_qa', 'subagent_reviewer'])
const OBSERVER_LABEL_RE = /audit|counter|evidence|observe|review|verify|审查|复核|观察|验收|反例|取证/i

const PRESSURE_REGISTRY = [
  {
    id: 'evidence-triangulation',
    marker: '三通道：',
    carriers: ['choice-pressure', 'mechanism', 'memory'],
    support: [
      'dsh/preset/plugins/kix-route.js',
      'dsh/preset/plugins/kix-settle.js',
      'dsh/preset/memories/incentive-lessons.md',
    ],
    observability: 'Sample review settlements and cross-vendor/replayable evidence use; semantic claim importance stays model-judged.',
    retirement: 'Remove or narrow after two matched review samples show no decision change or only ritual dispatch.',
  },
  {
    id: 'phase-separation',
    marker: '阶段二相性：',
    carriers: ['choice-pressure', 'mechanism'],
    support: [
      'dsh/preset/plugins/kix-orchestration.js',
      'dsh/preset/plugins/kix-settle.js',
    ],
    observability: 'Review epochs mechanically freeze declared artifacts and invalidate stale evidence; new-risk semantics remain model-judged.',
    retirement: 'Keep while stale-review or observer-write incidents are prevented; delete redundant wording after two clean audits with equivalent plugin guidance.',
  },
  {
    id: 'rule-debt-placement',
    marker: '规则是负债：',
    carriers: ['incentive', 'audit', 'memory'],
    support: [
      'scripts/audit-selection-pressure-history.cjs',
      'dsh/preset/memories/incentive-lessons.md',
    ],
    observability: 'CI requires every resident pressure to declare carriers, support, observability, and retirement.',
    retirement: 'The registry itself must be removed if two prompt changes bypass it without catching a real unsupported promise.',
  },
  {
    id: 'requirement-triage',
    marker: '需求三检（信号命中才做）',
    carriers: ['choice-pressure', 'mechanism'],
    support: [
      'dsh/preset/plugins/kix-discipline.js',
      'dsh/preset/plugins/kix-signal.js',
    ],
    observability: 'Spec persistence and first-edit reminders are mechanical; signal meaning stays model-judged.',
    retirement: 'Remove duplicate reminders after two matched edits show no unique recovery value.',
  },
  {
    id: 'minimal-code-path',
    marker: '写码前：',
    carriers: ['choice-pressure', 'mechanism', 'memory'],
    support: [
      'dsh/preset/plugins/kix-discipline.js',
      'dsh/preset/memories/ai-agent-practices.md',
    ],
    observability: 'Validation reminders and replayable tests are observable; root-cause and necessity judgments are semantic.',
    retirement: 'Narrow any clause that produces two ritual checks without changing implementation or evidence quality.',
  },
  {
    id: 'attribute-routing',
    marker: '属性路由：',
    carriers: ['choice-pressure', 'audit'],
    support: [
      'scripts/audit-selection-pressure-history.cjs',
      'dsh/preset/plugins/kix-focus.js',
    ],
    observability: 'Audit reports multi-file source edits without capability search as candidates; goal ambiguity and verification criticality remain semantic.',
    retirement: 'Remove a routing signal after two matched task samples show zero decision value or systematic false positives.',
  },
  {
    id: 'member-selection',
    marker: '成员档（',
    carriers: ['choice-pressure', 'mechanism', 'audit'],
    support: [
      'dsh/preset/plugins/kix-focus.js',
      'scripts/audit-delegation-history.cjs',
      'scripts/audit-selection-pressure-history.cjs',
    ],
    observability: 'Member visibility and activation are mechanical; audits report edited sessions without an independent-observer candidate.',
    retirement: 'Keep the menu only while real tasks use it; never replace semantic member choice with role quotas.',
  },
  {
    id: 'blind-risk-calibration',
    marker: '盲抽样校准：',
    carriers: ['choice-pressure', 'mechanism', 'audit', 'memory'],
    support: [
      'dsh/preset/plugins/kix-settle.js',
      'scripts/audit-selection-pressure-history.cjs',
      'dsh/preset/memories/incentive-lessons.md',
    ],
    observability: 'kix-settle deterministically samples terminal-evidence small-edit root sessions without a fresh observer; the audit reports the broader candidate pool without calling it low risk.',
    retirement: 'Delete after two matched samples yield no unique risk-classification change, or when interruption cost exceeds independently verified counterexample value.',
  },
  {
    id: 'pull-knowledge',
    marker: '卡住时 skill',
    carriers: ['choice-pressure', 'mechanism', 'memory'],
    support: [
      'dsh/preset/plugins/kix-focus.js',
      'dsh/preset/plugins/kix-mem.js',
      'dsh/preset/memories/orchestration-lessons.md',
    ],
    observability: 'Skill and experience retrieval calls are observable; being stuck is deliberately not classified by a plugin.',
    retirement: 'Remove a pointer after two relevant crises show zero retrieval and no quality loss.',
  },
  {
    id: 'execution-carrier',
    marker: '执行载体先于拆步：',
    carriers: ['choice-pressure', 'audit', 'memory'],
    support: [
      'scripts/audit-selection-pressure-history.cjs',
      'dsh/preset/memories/orchestration-lessons.md',
    ],
    observability: 'Audit reports inline program wrappers, large direct results, and native call clusters without turning counts into quotas.',
    retirement: 'Delete or narrow after two matched behavior probes show no net context, round-trip, or control-flow benefit.',
  },
]

function parseToolArgs(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return {} }
}

function extractPressureBullets(persona) {
  const bullets = []
  let inPressureSection = false
  for (const line of String(persona || '').split(/\r?\n/)) {
    if (/^##\s+(思考锚点|选择压)/.test(line)) {
      inPressureSection = true
      continue
    }
    if (/^##\s+/.test(line)) {
      inPressureSection = false
      continue
    }
    if (inPressureSection && line.startsWith('- ')) bullets.push(line)
  }
  return bullets
}

function validatePressureRegistry(root = REPO_ROOT) {
  const failures = []
  const personaResult = extractPersona(root, 'dsh/preset/agent.cordis.yml')
  if (personaResult.error) return { failures: [personaResult.error], bullets: [], registry: PRESSURE_REGISTRY }

  const bullets = extractPressureBullets(personaResult.persona)
  const matchedIds = new Set()
  for (const bullet of bullets) {
    const matches = PRESSURE_REGISTRY.filter((entry) => bullet.includes(entry.marker))
    if (matches.length !== 1) {
      failures.push(`resident pressure must match exactly one registry entry: ${bullet}`)
      continue
    }
    matchedIds.add(matches[0].id)
  }

  for (const entry of PRESSURE_REGISTRY) {
    if (!matchedIds.has(entry.id)) failures.push(`registry entry not present in resident persona: ${entry.id}`)
    if (!Array.isArray(entry.carriers) || entry.carriers.length === 0) {
      failures.push(`${entry.id}: carriers must be non-empty`)
    } else {
      for (const carrier of entry.carriers) {
        if (!ALLOWED_CARRIERS.has(carrier)) failures.push(`${entry.id}: unknown carrier ${carrier}`)
      }
    }
    if (!entry.observability) failures.push(`${entry.id}: observability is required`)
    if (!entry.retirement) failures.push(`${entry.id}: retirement is required`)
    if (!Array.isArray(entry.support) || entry.support.length === 0) {
      failures.push(`${entry.id}: support paths are required`)
    } else {
      for (const rel of entry.support) {
        if (!fs.existsSync(path.join(root, rel))) failures.push(`${entry.id}: missing support path ${rel}`)
      }
    }
  }

  return { failures, bullets, registry: PRESSURE_REGISTRY }
}

function detectInlineProgram(command) {
  const text = String(command || '')
  const patterns = [
    /(?:^|[\n;()]|&&|\|\||\|)\s*node(?:\.exe)?\s+(?:--eval|-e|--print|-p)\b/im,
    /(?:^|[\n;()]|&&|\|\||\|)\s*node(?:\.exe)?\s+[^\n;|]*?\s+(?:--eval|-e|--print|-p)\b/im,
    /(?:^|[\n;()]|&&|\|\||\|)\s*(?:node|python\d*|ruby)\s+<<[-~]?\s*['"]?[A-Za-z_][A-Za-z0-9_]*/im,
    /(?:^|[\n;()]|&&|\|\||\|)\s*python\d*\s+(?:-c|--command)\b/im,
    /(?:^|[\n;()]|&&|\|\||\|)\s*python\d*\s+-\s*(?:$|\n)/im,
  ]
  return patterns.some((pattern) => pattern.test(text))
}

function resultBytes(event) {
  const content = event && event.data && event.data.message && event.data.message.content
  return Buffer.byteLength(JSON.stringify(content ?? null), 'utf8')
}

function callResultId(event) {
  return event && event.data && event.data.message && event.data.message.source
    ? event.data.message.source.callId
    : null
}

function analyzeSessionEvents(events, options = {}) {
  const largeResultBytes = options.largeResultBytes || DEFAULT_LARGE_RESULT_BYTES
  const header = events.find((event) => event && event.type === 'session') || {}
  const calls = []
  const callsById = new Map()

  for (const event of events) {
    if (!event || event.type !== 'tool/call' || !event.data) continue
    const call = {
      id: event.data.callId || null,
      name: String(event.data.name || ''),
      turn: Number(event.data.turn || 0),
      step: Number(event.data.step || 0),
      args: parseToolArgs(event.data.arguments),
      bytes: 0,
    }
    calls.push(call)
    if (call.id) callsById.set(call.id, call)
  }

  for (const event of events) {
    if (!event || event.type !== 'tool/result') continue
    const call = callsById.get(callResultId(event))
    if (call) call.bytes += resultBytes(event)
  }

  const editedFiles = new Set()
  let capabilitySearchCalls = 0
  let observerCalls = 0
  let runCodeCalls = 0
  const inlineProgramWrappers = []
  const largeDirectResults = []
  const stepGroups = new Map()

  for (const call of calls) {
    if (SOURCE_EDIT_TOOLS.has(call.name)) {
      const filePath = call.args.file_path || call.args.path
      if (filePath) editedFiles.add(String(filePath))
    }
    if (call.name === 'kix_capability_search') capabilitySearchCalls += 1
    if (call.name === 'run_code') runCodeCalls += 1
    if (OBSERVER_TOOLS.has(call.name)) {
      observerCalls += 1
    } else if (call.name.startsWith('subagent')) {
      const label = String(call.args.description || '')
      if (OBSERVER_LABEL_RE.test(label)) observerCalls += 1
    }
    if (call.name === 'bash' && detectInlineProgram(call.args.command)) {
      inlineProgramWrappers.push({
        turn: call.turn,
        step: call.step,
        description: call.args.description || null,
        commandPreview: String(call.args.command || '').slice(0, 240),
      })
    }
    if (DIRECT_DATA_TOOLS.has(call.name)) {
      const key = `${call.turn}:${call.step}`
      const group = stepGroups.get(key) || []
      group.push(call)
      stepGroups.set(key, group)
      if (call.bytes >= largeResultBytes) {
        largeDirectResults.push({
          turn: call.turn,
          step: call.step,
          name: call.name,
          bytes: call.bytes,
          description: call.args.description || null,
        })
      }
    }
  }

  const nativeClusters = []
  for (const [key, group] of stepGroups) {
    if (group.length < 3) continue
    nativeClusters.push({
      key,
      calls: group.length,
      bytes: group.reduce((sum, call) => sum + call.bytes, 0),
      tools: group.map((call) => call.name),
    })
  }

  return {
    sessionId: header.id || null,
    createdAt: header.createdAt || null,
    delegationDepth: Number(header.delegationDepth || 0),
    agentPreset: header.agentPreset || null,
    totalToolCalls: calls.length,
    runCodeCalls,
    capabilitySearchCalls,
    observerCalls,
    editedFiles: [...editedFiles],
    routingCandidate: editedFiles.size >= 3 && capabilitySearchCalls === 0,
    observationCandidate: editedFiles.size >= 3 && observerCalls === 0,
    calibrationCandidate: Number(header.delegationDepth || 0) === 0 &&
      !header.parentSession && header.origin !== 'subagent' &&
      editedFiles.size > 0 && editedFiles.size <= 2 && observerCalls === 0,
    inlineProgramWrappers,
    largeDirectResults,
    nativeClusters,
  }
}

function parseJsonLines(text) {
  const events = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* ignore incomplete appended frames */ }
  }
  return events
}

function resolveSessionsRoot(explicit) {
  if (explicit) return path.resolve(explicit)
  const bases = [
    path.join(os.homedir(), '.dsh', 'sessions'),
    path.join(os.homedir() === '/root' ? '/mnt/c/Users/37112' : os.homedir(), '.dsh', 'sessions'),
  ]
  const projectName = path.basename(process.cwd()).toLowerCase()
  for (const base of bases) {
    if (!fs.existsSync(base)) continue
    const matches = fs.readdirSync(base)
      .filter((name) => name.toLowerCase().includes(projectName))
      .map((name) => path.join(base, name))
      .filter((candidate) => {
        try { return fs.statSync(candidate).isDirectory() } catch { return false }
      })
    if (matches.length > 0) return matches[0]
  }
  return null
}

function scanSessions(root, options = {}) {
  const limit = options.limit || 0
  const largeResultBytes = options.largeResultBytes || DEFAULT_LARGE_RESULT_BYTES
  const files = fs.readdirSync(root)
    .map((name) => path.join(root, name, 'session.jsonl.zstd'))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  const selected = limit > 0 ? files.slice(0, limit) : files
  const sessions = []
  for (const { file } of selected) {
    const text = decodeSession(file)
    if (!text) continue
    const summary = analyzeSessionEvents(parseJsonLines(text), { largeResultBytes })
    if (summary.delegationDepth !== 0) continue
    if (options.preset && summary.agentPreset !== options.preset) continue
    sessions.push(summary)
  }
  return sessions
}

function aggregateSessions(sessions) {
  return {
    sessions: sessions.length,
    toolCalls: sessions.reduce((sum, session) => sum + session.totalToolCalls, 0),
    runCodeCalls: sessions.reduce((sum, session) => sum + session.runCodeCalls, 0),
    routingCandidates: sessions.filter((session) => session.routingCandidate),
    observationCandidates: sessions.filter((session) => session.observationCandidate),
    calibrationCandidates: sessions.filter((session) => session.calibrationCandidate),
    inlineProgramWrappers: sessions.flatMap((session) => session.inlineProgramWrappers.map((item) => ({ sessionId: session.sessionId, ...item }))),
    largeDirectResults: sessions.flatMap((session) => session.largeDirectResults.map((item) => ({ sessionId: session.sessionId, ...item }))),
    nativeClusters: sessions.flatMap((session) => session.nativeClusters.map((item) => ({ sessionId: session.sessionId, ...item }))),
  }
}

function printRegistry(report) {
  console.log(`pressure registry: ${report.registry.length} entries / ${report.bullets.length} resident bullets`)
  for (const entry of report.registry) {
    console.log(`  ${entry.id.padEnd(24)} ${entry.carriers.join('+')}`)
  }
}

function printHistory(root, aggregate, largeResultBytes) {
  console.log(`\nsessions root: ${root}`)
  console.log(`main sessions: ${aggregate.sessions}; tool calls: ${aggregate.toolCalls}; run_code: ${aggregate.runCodeCalls}`)
  console.log(`routing candidates: ${aggregate.routingCandidates.length}`)
  console.log(`observation candidates: ${aggregate.observationCandidates.length}`)
  console.log(`blind-calibration candidates: ${aggregate.calibrationCandidates.length}`)
  console.log(`inline program wrappers: ${aggregate.inlineProgramWrappers.length}`)
  console.log(`large direct results >= ${largeResultBytes} bytes: ${aggregate.largeDirectResults.length}`)
  console.log(`native clusters >= 3 calls in one step: ${aggregate.nativeClusters.length}`)
  console.log('candidates are review leads, not failures, quotas, or routing gates')

  const sections = [
    ['inline wrappers', aggregate.inlineProgramWrappers],
    ['large direct results', aggregate.largeDirectResults],
    ['routing candidates', aggregate.routingCandidates.map((session) => ({ sessionId: session.sessionId, editedFiles: session.editedFiles.length }))],
    ['observation candidates', aggregate.observationCandidates.map((session) => ({ sessionId: session.sessionId, editedFiles: session.editedFiles.length }))],
    ['blind-calibration candidates', aggregate.calibrationCandidates.map((session) => ({ sessionId: session.sessionId, editedFiles: session.editedFiles.length }))],
  ]
  for (const [title, items] of sections) {
    if (items.length === 0) continue
    console.log(`\n${title} (first 10):`)
    for (const item of items.slice(0, 10)) console.log(`  ${JSON.stringify(item)}`)
  }
}

function parseCli(argv) {
  const options = {
    check: argv.includes('--check'),
    json: argv.includes('--json'),
    explicitRoot: argv.find((arg) => !arg.startsWith('--')) || null,
    largeResultBytes: DEFAULT_LARGE_RESULT_BYTES,
    limit: 0,
    preset: null,
  }
  for (const arg of argv) {
    if (arg.startsWith('--large-result-bytes=')) options.largeResultBytes = Number(arg.split('=')[1])
    if (arg.startsWith('--limit=')) options.limit = Number(arg.split('=')[1])
    if (arg.startsWith('--preset=')) options.preset = arg.split('=').slice(1).join('=')
  }
  return options
}

function main() {
  const options = parseCli(process.argv.slice(2))
  const registryReport = validatePressureRegistry(REPO_ROOT)
  if (registryReport.failures.length > 0) {
    for (const failure of registryReport.failures) console.error(`FAIL ${failure}`)
    process.exitCode = 1
    return
  }

  if (options.check) {
    if (options.json) console.log(JSON.stringify(registryReport, null, 2))
    else printRegistry(registryReport)
    return
  }

  const root = resolveSessionsRoot(options.explicitRoot)
  if (!root || !fs.existsSync(root)) {
    console.error('sessions root not found; pass it explicitly or use --check')
    process.exitCode = 1
    return
  }
  const sessions = scanSessions(root, options)
  const aggregate = aggregateSessions(sessions)
  if (options.json) {
    console.log(JSON.stringify({ registry: registryReport.registry, root, ...aggregate }, null, 2))
  } else {
    printRegistry(registryReport)
    printHistory(root, aggregate, options.largeResultBytes)
  }
}

if (require.main === module) main()

module.exports = {
  DEFAULT_LARGE_RESULT_BYTES,
  PRESSURE_REGISTRY,
  aggregateSessions,
  analyzeSessionEvents,
  detectInlineProgram,
  extractPressureBullets,
  parseJsonLines,
  validatePressureRegistry,
}
