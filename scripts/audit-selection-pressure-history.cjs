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
    proof: { file: 'dsh/preset/plugins/kix-route.js', contains: '(p) => vendorOf(p) !== parentVendor && registered.includes(p),' },
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
    proof: { file: 'dsh/preset/plugins/kix-orchestration.js', contains: 'function epochBlocksMutation(exec, epoch) {' },
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
    proof: { file: 'scripts/audit-selection-pressure-history.cjs', contains: "const ALLOWED_CARRIERS = new Set(['choice-pressure', 'incentive', 'mechanism', 'audit', 'memory'])" },
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
    proof: { file: 'dsh/preset/plugins/kix-discipline.js', contains: '该编辑前未记录需求三检契约' },
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
    proof: { file: 'dsh/preset/plugins/kix-discipline.js', contains: 'if (hadEdits && !hadTests) {' },
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
    proof: { file: 'scripts/audit-selection-pressure-history.cjs', contains: 'routingCandidate: editedFiles.size >= 3 && capabilitySearchCalls === 0,' },
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
    marker: '成员优先：',
    proof: { file: 'scripts/audit-delegation-history.cjs', contains: 'const drought = s.memberCalls + s.crossCalls === 0 && s.sourceEdits >= 3 && heavyMain > 0' },
    carriers: ['choice-pressure', 'mechanism', 'audit'],
    support: [
      'dsh/preset/agent.cordis.yml',
      'dsh/preset/plugins/kix-focus.js',
      'scripts/audit-delegation-history.cjs',
      'scripts/audit-selection-pressure-history.cjs',
    ],
    observability: 'Reviewer/dev/qa visibility is mechanical; delegation audit exposes role drought while lens count and role fit remain semantic.',
    retirement: 'Keep the menu only while real tasks use it; never replace semantic member choice with role quotas. The floor-Ⅳ gate clause (publish/destructive default-off; explicit user instruction settles it) retires only when kix-guards soft-constraint semantics are confirmed as the sole mechanical carrier, independent of menu usage.',
  },
  {
    id: 'blind-risk-calibration',
    marker: '盲抽样校准：',
    proof: { file: 'dsh/preset/plugins/kix-settle.js', contains: 'st.mutationPaths.size <= 2 && stableCalibrationSample(sessionId)' },
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
    proof: { file: 'dsh/preset/plugins/kix-mem.js', contains: "name: 'experience'," },
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
    id: 'dispatch-dependency-weight',
    marker: '分派先判依赖与肥瘦：',
    proof: { file: 'scripts/audit-selection-pressure-history.cjs', contains: 'nativeClusters.push({' },
    carriers: ['choice-pressure', 'memory'],
    support: [
      'scripts/audit-selection-pressure-history.cjs',
      'dsh/preset/memories/orchestration-lessons.md',
    ],
    observability: 'Audit reports native call clusters and large direct results as dispatch candidates; dependency shape and task weight stay model-judged.',
    retirement: 'Delete or narrow after two matched dispatch probes show no wall-clock or context benefit over serial dispatch.',
  },
  {
    id: 'execution-carrier',
    marker: '执行载体先于拆步：',
    proof: { file: 'scripts/audit-selection-pressure-history.cjs', contains: 'function detectInlineProgram(command) {' },
    carriers: ['choice-pressure', 'audit', 'memory'],
    support: [
      'scripts/audit-selection-pressure-history.cjs',
      'dsh/preset/memories/orchestration-lessons.md',
    ],
    observability: 'Audit reports inline program wrappers, large direct results, and native call clusters without turning counts into quotas.',
    retirement: 'Delete or narrow after two matched behavior probes show no net context, round-trip, or control-flow benefit.',
  },
]

// 死亡/退役条款的可结算计数：条款写在 persona/plugin 注释里，但没有人统计过
// 「这条通道一个月真实会话里被用过几次」——于是条款永远无法被结算。本表只做
// 拉取式计数（--deaths），不判死、不加阈值、不挂常驻。
const DEATH_SIGNALS = [
  {
    id: 'browser',
    tools: ['browser', 'kix_browser'],
    clause: 'agent.cordis.yml browser 行：连续一个月真实会话中 browser 使用 <2 次 → 注释本行回退',
  },
  {
    id: 'workflow',
    tools: ['workflow'],
    clause: 'agent.cordis.yml workflow 行：连续一个月真实会话零使用 → 恢复 disabled',
  },
  {
    id: 'kix_stalled_check',
    tools: ['kix_stalled_check'],
    clause: 'plugins/kix-stalled.js：两轮无真实 stalled 命中可注释回退',
  },
  {
    id: 'skill',
    tools: ['skill'],
    clause: 'pull-knowledge：两轮相关危机零检索且质量不降 → 删指针',
  },
  {
    id: 'experience',
    tools: ['experience'],
    clause: 'plugins/kix-mem.js：模型长期不调用且质量不降 → 删除',
  },
  {
    id: 'probe',
    tools: ['probe'],
    clause: 'plugins/kix-probe.js：采纳率趋零且质量不降 → 本插件退役',
  },
  {
    id: 'run_code',
    tools: ['run_code'],
    clause: 'execution-carrier：run_code 载体用量（条款未给阈值，仅作对照）',
  },
]

function parseToolArgs(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return {} }
}

// 审计面契约（显式）：只有这两节里的 "- " 行才算常驻行为承诺、才进 registry 与
// 预算视野。preamble 里的承诺（效用准则 / expose one falsifier / Preserve safety…）
// 不在扫描面内——所以反向断言必须把它挡在门外：任何落在两节之外的 bullet 一律
// failure（见 findUnscopedBullets），否则把承诺挪到 preamble 就会静默漏审。
const PRESSURE_SECTION_TITLES = ['思考锚点', '选择压']
const PRESSURE_SECTION_RE = new RegExp(`^##\\s+(?:${PRESSURE_SECTION_TITLES.join('|')})`)

function extractPressureBullets(persona) {
  const bullets = []
  let inPressureSection = false
  for (const line of String(persona || '').split(/\r?\n/)) {
    if (PRESSURE_SECTION_RE.test(line)) {
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

// 反向断言：两节之外的 bullet 是未审计、未预算的行为承诺，点名 persona 行号。
function findUnscopedBullets(persona) {
  const unscoped = []
  let inPressureSection = false
  String(persona || '').split(/\r?\n/).forEach((line, index) => {
    if (PRESSURE_SECTION_RE.test(line)) {
      inPressureSection = true
      return
    }
    if (/^##\s+/.test(line)) {
      inPressureSection = false
      return
    }
    // 列 0 的 `- ` 之外，缩进 bullet 与编号列表同样可能承载承诺：
    // 只认 `startsWith('- ')` 会让「缩进一级」成为静默漏审通道。
    if (!inPressureSection && /^\s*(?:[-*]\s+|\d+[.)]\s+)\S/.test(line)) {
      unscoped.push({ line: index + 1, text: line })
    }
  })
  return unscoped
}

// 载体证明：条目必须指向 support 里的真实文件，并命中承载该承诺的代码/正则/handler。
// 只查 existsSync 的话，伪造条目指向任意 0 字节文件也能通过——这正是本函数要堵的洞。
// 命中行是纯注释（// 或 * 开头）也判失败：复述承诺的注释不是承载层。
/** PRESSURE_REGISTRY 声明块在文件中的字符区间（用于排除自指命中）。 */
function registryDeclRange(text) {
  const start = text.indexOf('const PRESSURE_REGISTRY = [')
  if (start === -1) return null
  // 换行无关：Windows 检出是 CRLF，写死 `\n]\n` 会定位失败（CI windows-latest 实测）。
  const m = /^\]\r?$/m.exec(text.slice(start))
  return m ? [start, start + m.index + m[0].length] : null
}

function validateCarrierProof(entry, root) {
  const failures = []
  const proof = entry.proof
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    failures.push(`${entry.id}: proof is required (proof.file + proof.contains)`)
    return failures
  }
  const file = typeof proof.file === 'string' ? proof.file.trim() : ''
  const contains = typeof proof.contains === 'string' ? proof.contains : ''
  if (!file) failures.push(`${entry.id}: proof.file is required`)
  if (!contains) failures.push(`${entry.id}: proof.contains is required`)
  if (!file || !contains) return failures
  if (!Array.isArray(entry.support) || !entry.support.includes(file)) {
    failures.push(`${entry.id}: proof.file ${file} is not listed in support`)
  }
  const abs = path.join(root, file)
  if (!fs.existsSync(abs)) {
    failures.push(`${entry.id}: proof file missing ${file}`)
    return failures
  }
  let text
  try {
    text = fs.readFileSync(abs, 'utf8')
  } catch (error) {
    failures.push(`${entry.id}: proof file unreadable ${file} (${error.message})`)
    return failures
  }
  // 自指陷阱：本文件里的 registry 声明行也含 proof.contains 字面量，若把它算作
  // 命中，则删掉真实载体代码后校验依然全绿（空转）。先排除声明块再搜。
  const decl = registryDeclRange(text)
  const at = text.indexOf(contains)
  if (at === -1) {
    failures.push(`${entry.id}: proof substring not found in ${file}: ${JSON.stringify(contains.slice(0, 80))}`)
    return failures
  }
  let cursor = at
  let codeHit = false
  while (cursor !== -1) {
    const inDecl = decl && cursor >= decl[0] && cursor < decl[1]
    const lineStart = text.lastIndexOf('\n', cursor) + 1
    const lineEnd = text.indexOf('\n', cursor)
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim()
    if (!inDecl && !/^(?:\/\/|\/\*|\*|#|<!--)/.test(line)) {
      codeHit = true
      break
    }
    cursor = text.indexOf(contains, cursor + 1)
  }
  if (!codeHit) {
    failures.push(`${entry.id}: proof substring only matches comment lines or the registry declaration in ${file}: ${JSON.stringify(contains.slice(0, 80))}`)
  }
  return failures
}

function validatePressureRegistry(root = REPO_ROOT, registry = PRESSURE_REGISTRY) {
  const failures = []
  const personaResult = extractPersona(root, 'dsh/preset/agent.cordis.yml')
  if (personaResult.error) return { failures: [personaResult.error], bullets: [], registry }

  const bullets = extractPressureBullets(personaResult.persona)
  for (const bullet of findUnscopedBullets(personaResult.persona)) {
    failures.push(
      `persona bullet outside audited pressure sections (${PRESSURE_SECTION_TITLES.join('/')}) ` +
      `at persona line ${bullet.line}: ${bullet.text.slice(0, 80)}`,
    )
  }
  const matchedIds = new Set()
  for (const bullet of bullets) {
    const matches = registry.filter((entry) => bullet.includes(entry.marker))
    if (matches.length !== 1) {
      failures.push(`resident pressure must match exactly one registry entry: ${bullet}`)
      continue
    }
    matchedIds.add(matches[0].id)
  }

  for (const entry of registry) {
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
    failures.push(...validateCarrierProof(entry, root))
  }

  return { failures, bullets, registry }
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

// 会话根候选：KIX_SESSION_ROOTS（path.delimiter 分隔）优先；否则 homedir 的
// .dsh/sessions + WSL 下各 Windows 用户家目录的 .dsh/sessions。**不写死用户名**——
// 本脚本随 npm 包发布，个人路径不得进发布物。
function defaultSessionRoots() {
  const fromEnv = String(process.env.KIX_SESSION_ROOTS || '')
    .split(path.delimiter)
    .filter(Boolean)
  if (fromEnv.length) return fromEnv.map((entry) => path.resolve(entry))
  const roots = [path.join(os.homedir(), '.dsh', 'sessions')]
  try {
    for (const user of fs.readdirSync('/mnt/c/Users')) {
      roots.push(path.join('/mnt/c/Users', user, '.dsh', 'sessions'))
    }
  } catch {
    /* 非 WSL 或不可读：只用 homedir */
  }
  return roots
}

function resolveSessionsRoot(explicit) {
  if (explicit) return path.resolve(explicit)
  const bases = defaultSessionRoots()
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

const SESSION_FILE_NAME = 'session.jsonl.zstd'
const DEATH_MAX_DEPTH = 4

// --deaths 的根：两个会话库位置（WSL 挂载的 Windows home + 本机 ~），显式传参优先。
function resolveDeathRoots(explicit) {
  if (explicit) {
    const resolved = path.resolve(explicit)
    return fs.existsSync(resolved) ? [resolved] : []
  }
  const bases = defaultSessionRoots()
  const roots = []
  for (const base of bases) {
    if (!fs.existsSync(base)) continue
    let real = base
    try { real = fs.realpathSync(base) } catch { real = path.resolve(base) }
    if (!roots.includes(real)) roots.push(real)
  }
  return roots
}

function collectSessionFiles(root, options = {}) {
  const maxDepth = options.maxDepth || DEATH_MAX_DEPTH
  const files = []
  const walk = (dir, depth) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || entry.name !== SESSION_FILE_NAME) continue
      let mtime = 0
      try { mtime = fs.statSync(full).mtimeMs } catch { /* 无 mtime 仍计文件 */ }
      files.push({ file: full, mtime })
    }
  }
  walk(root, 0)
  return files
}

function parseSessionHeader(text) {
  const end = text.indexOf('\n')
  const line = end === -1 ? text : text.slice(0, end)
  try {
    const header = JSON.parse(line)
    return header && header.type === 'session' ? header : {}
  } catch {
    return {}
  }
}

// 会话库可达 800MB+：先按行做子串预筛，只对命中行 JSON.parse。
function scanToolCalls(text) {
  const calls = []
  let start = 0
  while (start < text.length) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    const hit = text.indexOf('tool/call', start)
    if (hit !== -1 && hit < end) {
      try {
        const event = JSON.parse(text.slice(start, end))
        if (event && event.type === 'tool/call' && event.data) calls.push(event)
      } catch { /* 跨帧断裂行：忽略 */ }
    }
    start = end + 1
  }
  return calls
}

// 纯函数：单会话的工具用量 + 每个工具的首末出现时间。
function analyzeDeathUsage(events) {
  const list = Array.isArray(events) ? events : []
  const header = list.find((event) => event && event.type === 'session') || {}
  const toolUsage = Object.create(null)
  let toolCalls = 0
  for (const event of list) {
    if (!event || event.type !== 'tool/call' || !event.data) continue
    const name = String(event.data.name || '')
    if (!name) continue
    toolCalls += 1
    const usage = toolUsage[name] || { count: 0, firstSeen: null, lastSeen: null }
    usage.count += 1
    const time = Number(event.time || 0)
    if (time > 0) {
      if (usage.firstSeen === null || time < usage.firstSeen) usage.firstSeen = time
      if (usage.lastSeen === null || time > usage.lastSeen) usage.lastSeen = time
    }
    toolUsage[name] = usage
  }
  return {
    sessionId: header.id || null,
    createdAt: Number(header.createdAt || 0) || null,
    toolCalls,
    toolUsage,
  }
}

// 纯聚合：把每会话用量折进 DEATH_SIGNALS（含多别名合并），零命中保持 0。
function countDeathSignals(records, meta = {}) {
  const signals = DEATH_SIGNALS.map((signal) => ({
    id: signal.id,
    tools: [...signal.tools],
    clause: signal.clause,
    calls: 0,
    sessions: 0,
    firstSeen: null,
    lastSeen: null,
  }))
  const byTool = new Map()
  for (const signal of signals) for (const tool of signal.tools) byTool.set(tool, signal)
  const unknown = new Map()
  for (const record of records || []) {
    const usage = (record && record.toolUsage) || {}
    for (const name of Object.keys(usage)) {
      const entry = usage[name]
      if (!entry || !entry.count) continue
      const signal = byTool.get(name)
      if (!signal) {
        unknown.set(name, (unknown.get(name) || 0) + entry.count)
        continue
      }
      signal.calls += entry.count
      signal.sessions += 1
      if (entry.firstSeen && (signal.firstSeen === null || entry.firstSeen < signal.firstSeen)) signal.firstSeen = entry.firstSeen
      if (entry.lastSeen && (signal.lastSeen === null || entry.lastSeen > signal.lastSeen)) signal.lastSeen = entry.lastSeen
    }
  }
  return {
    roots: meta.roots || [],
    rootsScanned: Number(meta.rootsScanned || 0),
    filesScanned: Number(meta.filesScanned || 0),
    sessionsScanned: (records || []).length,
    decodeFailures: Number(meta.decodeFailures || 0),
    skippedNonRoot: Number(meta.skippedNonRoot || 0),
    signals,
    unknownTools: [...unknown.entries()]
      .map(([name, calls]) => ({ name, calls }))
      .sort((a, b) => b.calls - a.calls),
  }
}

// IO：只读解码 + depth-0 过滤；decodeSession 复用现有 helper（unzstd → zlib 兜底）。
function scanDeathSessions(roots, options = {}) {
  const collected = []
  for (const root of roots) collected.push(...collectSessionFiles(root, options))
  collected.sort((a, b) => b.mtime - a.mtime)
  const limit = options.limit || 0
  const selected = limit > 0 ? collected.slice(0, limit) : collected
  const records = []
  let decodeFailures = 0
  let skippedNonRoot = 0
  for (const { file } of selected) {
    const text = decodeSession(file)
    if (!text) {
      decodeFailures += 1
      continue
    }
    const header = parseSessionHeader(text)
    const depth = Number(header.delegationDepth || 0)
    if (depth !== 0 || header.parentSession || header.origin === 'subagent') {
      skippedNonRoot += 1
      continue
    }
    if (options.preset && header.agentPreset !== options.preset) continue
    records.push(analyzeDeathUsage([header, ...scanToolCalls(text)]))
  }
  return { records, filesScanned: selected.length, decodeFailures, skippedNonRoot }
}

function formatSeenDate(ms) {
  if (!ms) return '—'
  try { return new Date(ms).toISOString().slice(0, 10) } catch { return '—' }
}

function printDeathTable(report) {
  console.log('deaths mode — depth-0 session tool usage (read-only; no resident hook, not run by default)')
  for (const root of report.roots) console.log(`  root: ${root}`)
  console.log(`session roots scanned: ${report.rootsScanned}; session files: ${report.filesScanned}; depth-0 sessions: ${report.sessionsScanned}; decode failures: ${report.decodeFailures}; non-root sessions skipped: ${report.skippedNonRoot}`)
  console.log('')
  console.log('signal               calls  sessions  first-seen   last-seen    tools')
  for (const signal of report.signals) {
    console.log(
      `${signal.id.padEnd(20)} ${String(signal.calls).padStart(5)}  ${String(signal.sessions).padStart(8)}  ` +
      `${formatSeenDate(signal.firstSeen).padEnd(12)}${formatSeenDate(signal.lastSeen).padEnd(13)}${signal.tools.join(',')}`,
    )
  }
  console.log('')
  console.log('counts are type=tool/call events in depth-0 sessions only; zero is a retirement candidate, not an automatic decision —')
  console.log('every clause also requires the quality evidence named in its retirement text.')
  for (const signal of report.signals) console.log(`  ${signal.id}: ${signal.clause}`)
  if (report.unknownTools.length > 0) {
    console.log('')
    console.log('other tools seen (context only):')
    for (const tool of report.unknownTools.slice(0, 10)) console.log(`  ${tool.name}: ${tool.calls}`)
  }
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
    console.log(`  ${entry.id.padEnd(24)} ${entry.carriers.join('+')} → ${entry.proof ? entry.proof.file : 'NO PROOF'}`)
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
    deaths: argv.includes('--deaths'),
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

function runDeathsMode(options) {
  const roots = resolveDeathRoots(options.explicitRoot)
  if (roots.length === 0) {
    console.error('deaths: no session roots found; pass one explicitly (e.g. --deaths /root/.dsh/sessions)')
    process.exitCode = 1
    return
  }
  const scan = scanDeathSessions(roots, options)
  const report = countDeathSignals(scan.records, {
    roots,
    rootsScanned: roots.length,
    filesScanned: scan.filesScanned,
    decodeFailures: scan.decodeFailures,
    skippedNonRoot: scan.skippedNonRoot,
  })
  if (options.json) console.log(JSON.stringify(report, null, 2))
  else printDeathTable(report)
}

function main() {
  const options = parseCli(process.argv.slice(2))
  // --deaths 是只读度量模式，独立于 registry 门禁（registry 坏掉时仍能量）。
  if (options.deaths) {
    runDeathsMode(options)
    return
  }

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
  DEATH_SIGNALS,
  PRESSURE_REGISTRY,
  PRESSURE_SECTION_TITLES,
  aggregateSessions,
  analyzeDeathUsage,
  analyzeSessionEvents,
  collectSessionFiles,
  countDeathSignals,
  detectInlineProgram,
  extractPressureBullets,
  findUnscopedBullets,
  parseJsonLines,
  printDeathTable,
  resolveDeathRoots,
  scanDeathSessions,
  validateCarrierProof,
  validatePressureRegistry,
}
