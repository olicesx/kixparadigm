'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { spawnSync } = require('node:child_process')
const {
  DEATH_SIGNALS,
  PRESSURE_REGISTRY,
  PRESSURE_SECTION_TITLES,
  aggregateSessions,
  analyzeDeathUsage,
  analyzeSessionEvents,
  countDeathSignals,
  detectInlineProgram,
  extractPressureBullets,
  findUnscopedBullets,
  validatePressureRegistry,
} = require('./audit-selection-pressure-history.cjs')

const ROOT = path.resolve(__dirname, '..')
const SCRIPT = path.join(__dirname, 'audit-selection-pressure-history.cjs')

function call(id, name, args, turn = 1, step = 1) {
  return {
    type: 'tool/call',
    data: { callId: id, name, arguments: JSON.stringify(args), turn, step },
  }
}

function result(id, content) {
  return {
    type: 'tool/result',
    data: { message: { source: { callId: id }, content } },
  }
}

function baseEvents(extra = []) {
  return [
    { type: 'session', id: 'session-test', createdAt: 1, delegationDepth: 0, agentPreset: 'kixparadigm' },
    call('e1', 'edit', { file_path: '/repo/src/a.js' }),
    call('e2', 'write', { file_path: '/repo/src/b.js' }),
    call('e3', 'edit', { file_path: '/repo/src/c.js' }),
    call('b1', 'bash', { command: 'node -e "console.log(1)"', description: 'Inline data program' }, 1, 2),
    call('r1', 'read', { file_path: '/repo/large.json' }, 1, 2),
    call('g1', 'grep', { pattern: 'x', path: '/repo' }, 1, 2),
    call('c1', 'run_code', { code: 'return 1', description: 'Aggregate data' }, 1, 3),
    result('b1', [{ type: 'text', text: 'ok' }]),
    result('r1', [{ type: 'text', text: 'x'.repeat(20_000) }]),
    result('g1', [{ type: 'text', text: 'match' }]),
    result('c1', [{ type: 'text', text: '1' }]),
    ...extra,
  ]
}

test('resident pressure registry covers every active pressure', () => {
  const report = validatePressureRegistry(ROOT)
  assert.deepEqual(report.failures, [])
  assert.equal(report.bullets.length, 11)
  assert.equal(report.registry.length, 11)
  assert.equal(new Set(PRESSURE_REGISTRY.map((entry) => entry.id)).size, 11)
})

test('pressure extraction ignores ordinary prose and other headings', () => {
  const persona = [
    'intro',
    '## 思考锚点',
    '- first',
    'prose',
    '## Other',
    '- ignored',
    '## 选择压',
    '- second',
  ].join('\n')
  assert.deepEqual(extractPressureBullets(persona), ['- first', '- second'])
})

test('history analysis reports candidates without turning them into failures', () => {
  const summary = analyzeSessionEvents(baseEvents(), { largeResultBytes: 16_384 })
  assert.equal(summary.sessionId, 'session-test')
  assert.equal(summary.runCodeCalls, 1)
  assert.equal(summary.routingCandidate, true)
  assert.equal(summary.observationCandidate, true)
  assert.equal(summary.inlineProgramWrappers.length, 1)
  assert.equal(summary.largeDirectResults.length, 1)
  assert.equal(summary.largeDirectResults[0].name, 'read')
  assert.equal(summary.nativeClusters.length, 1)
  assert.equal(Object.hasOwn(summary, 'failure'), false)
})

test('capability search and observer clear only their matching candidates', () => {
  const extra = [
    call('s1', 'kix_capability_search', { query: 'review' }, 1, 4),
    call('o1', 'subagent_cross', { description: 'Independent review', prompt: 'Review' }, 1, 5),
  ]
  const summary = analyzeSessionEvents(baseEvents(extra))
  assert.equal(summary.routingCandidate, false)
  assert.equal(summary.observationCandidate, false)
  assert.equal(summary.capabilitySearchCalls, 1)
  assert.equal(summary.observerCalls, 1)
})

test('blind-calibration candidate is a small unobserved edit pool, not a failure', () => {
  const session = { type: 'session', id: 'session-small', createdAt: 1, delegationDepth: 0, agentPreset: 'kixparadigm' }
  const candidate = analyzeSessionEvents([
    session,
    call('e1', 'edit', { file_path: '/repo/src/a.js' }),
  ])
  assert.equal(candidate.calibrationCandidate, true)
  assert.equal(Object.hasOwn(candidate, 'failure'), false)

  const observed = analyzeSessionEvents([
    session,
    call('e1', 'edit', { file_path: '/repo/src/a.js' }),
    call('o1', 'subagent_cross', { description: 'Independent review', prompt: 'Review' }),
  ])
  assert.equal(observed.calibrationCandidate, false)

  for (const childHeader of [
    { id: 'session-depth-child', delegationDepth: 1 },
    { id: 'session-parent-child', parentSession: 'session-root' },
    { id: 'session-origin-child', origin: 'subagent' },
  ]) {
    const child = analyzeSessionEvents([
      { ...session, ...childHeader },
      call('e1', 'edit', { file_path: '/repo/src/a.js' }),
    ])
    assert.equal(child.calibrationCandidate, false)
  }
})

test('inline-program detector targets wrappers, not existing scripts', () => {
  assert.equal(detectInlineProgram('node -e "console.log(1)"'), true)
  assert.equal(detectInlineProgram("python3 -c 'print(1)'"), true)
  assert.equal(detectInlineProgram("node <<'NODE'\nconsole.log(1)\nNODE"), true)
  assert.equal(detectInlineProgram("curl -fsSL example.test | node -e 'parse()'"), true)
  assert.equal(detectInlineProgram('node --input-type=commonjs -e "x()"'), true)
  assert.equal(detectInlineProgram('node -p "process.version"'), true)
  assert.equal(detectInlineProgram('python3 -'), true)
  assert.equal(detectInlineProgram('node scripts/check-dsh-consistency.cjs'), false)
  assert.equal(detectInlineProgram("jq 'contains(\"bash node -e/heredoc\")' session.jsonl"), false)
  assert.equal(detectInlineProgram('npm test'), false)
})

test('aggregate keeps candidate categories separate', () => {
  const one = analyzeSessionEvents(baseEvents())
  const aggregate = aggregateSessions([one])
  assert.equal(aggregate.sessions, 1)
  assert.equal(aggregate.routingCandidates.length, 1)
  assert.equal(aggregate.observationCandidates.length, 1)
  assert.equal(aggregate.calibrationCandidates.length, 0)
  assert.equal(aggregate.inlineProgramWrappers.length, 1)
  assert.equal(aggregate.largeDirectResults.length, 1)
})

// ── 载体证明（缺陷 A）：条目必须证明承诺真的被某个代码/正则/handler 承载 ──────
function cloneRegistry() {
  return PRESSURE_REGISTRY.map((entry) => ({
    ...entry,
    carriers: [...entry.carriers],
    support: [...entry.support],
    proof: { ...entry.proof },
  }))
}

test('every registry entry declares a proof inside its support files', () => {
  for (const entry of PRESSURE_REGISTRY) {
    assert.equal(typeof entry.proof, 'object', `${entry.id} needs proof`)
    assert.equal(typeof entry.proof.file, 'string', `${entry.id} needs proof.file`)
    assert.ok(entry.proof.contains.length > 0, `${entry.id} needs proof.contains`)
    assert.ok(entry.support.includes(entry.proof.file), `${entry.id} proof.file must be listed in support`)
  }
})

test('fabricated proof with a missing substring is a failure naming id and file', () => {
  const registry = cloneRegistry()
  registry[0].proof = {
    file: 'dsh/preset/plugins/kix-settle.js',
    contains: 'this literal substring is nowhere in the carrier file',
  }
  const report = validatePressureRegistry(ROOT, registry)
  assert.equal(
    report.failures.some((failure) => failure.includes('evidence-triangulation') &&
      failure.includes('dsh/preset/plugins/kix-settle.js') && failure.includes('proof substring not found')),
    true,
    JSON.stringify(report.failures),
  )
})

test('proof pointing at an unrelated existing file is a failure', () => {
  const registry = cloneRegistry()
  registry[1].proof = { file: 'package.json', contains: 'phase-separation' }
  const report = validatePressureRegistry(ROOT, registry)
  assert.equal(report.failures.some((failure) => failure.includes('phase-separation') && failure.includes('not listed in support')), true)
})

test('missing or comment-only proof is a failure', () => {
  const registry = cloneRegistry()
  delete registry[2].proof
  assert.equal(
    validatePressureRegistry(ROOT, registry).failures.some((failure) => failure.includes('rule-debt-placement') && failure.includes('proof is required')),
    true,
  )

  const commented = cloneRegistry()
  commented[5].proof = {
    file: 'scripts/audit-selection-pressure-history.cjs',
    contains: '载体证明：条目必须指向 support 里的真实文件',
  }
  assert.equal(
    validatePressureRegistry(ROOT, commented).failures.some((failure) => failure.includes('attribute-routing') && failure.includes('comment line')),
    true,
  )
})

test('an honest registry still produces zero failures', () => {
  const report = validatePressureRegistry(ROOT, cloneRegistry())
  assert.deepEqual(report.failures, [])
  assert.equal(report.bullets.length, PRESSURE_REGISTRY.length)
})

// ── 审计面边界（缺陷 C）：两节之外的 bullet 不得静默漏审 ─────────────────────
test('audit surface is an explicit contract, not an accident', () => {
  assert.deepEqual(PRESSURE_SECTION_TITLES, ['思考锚点', '选择压'])
  const persona = [
    'preamble prose',
    '- preamble promise',
    '## 思考锚点',
    '- scoped one',
    '## 选择压',
    '- scoped two',
    '## 其它',
    '- outside again',
  ].join('\n')
  assert.deepEqual(extractPressureBullets(persona), ['- scoped one', '- scoped two'])
  assert.deepEqual(findUnscopedBullets(persona), [
    { line: 2, text: '- preamble promise' },
    { line: 8, text: '- outside again' },
  ])
})

test('persona bullet moved into the preamble fails with its line number', () => {
  const rel = 'dsh/preset/agent.cordis.yml'
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n')
  const at = source.findIndex((line) => /^\s*##\s*思考锚点\s*$/.test(line))
  assert.ok(at > 0, 'fixture anchor not found in persona')
  const indent = source[at].match(/^\s*/)[0]
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-persona-'))
  try {
    source.splice(at, 0, `${indent}- 伪造 preamble 承诺：把行为承诺挪出审计面。`)
    fs.mkdirSync(path.join(tmp, 'dsh', 'preset'), { recursive: true })
    fs.writeFileSync(path.join(tmp, rel), source.join('\n'))
    const report = validatePressureRegistry(tmp)
    const hit = report.failures.find((failure) => failure.includes('outside audited pressure sections'))
    assert.ok(hit, JSON.stringify(report.failures.slice(0, 5)))
    assert.match(hit, /persona line \d+/)
    assert.ok(hit.includes('伪造 preamble 承诺'), hit)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// ── 死亡条款计数（缺陷 B）：--deaths 只读模式 ────────────────────────────────
function timedCall(id, name, iso) {
  return { type: 'tool/call', time: Date.parse(iso), data: { callId: id, name, arguments: '{}', turn: 1, step: 1 } }
}

function writeSessionFixture(root, dirName, lines) {
  const dir = path.join(root, 'proj', dirName)
  fs.mkdirSync(dir, { recursive: true })
  const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(text, 'utf8')))
}

test('death signals cover the declared retirement clauses', () => {
  assert.deepEqual(DEATH_SIGNALS.map((signal) => signal.id), [
    'browser', 'workflow', 'kix_stalled_check', 'skill', 'experience', 'probe', 'run_code',
  ])
  for (const signal of DEATH_SIGNALS) {
    assert.ok(signal.tools.length > 0, `${signal.id} needs tool names`)
    assert.ok(signal.clause.length > 0, `${signal.id} needs its retirement clause`)
  }
})

test('death usage counts per-tool calls with first/last seen dates', () => {
  const usage = analyzeDeathUsage([
    { type: 'session', id: 'session-deaths', createdAt: Date.parse('2026-08-01T00:00:00Z'), delegationDepth: 0 },
    timedCall('c1', 'browser', '2026-08-05T00:00:00Z'),
    timedCall('c2', 'browser', '2026-08-01T00:00:00Z'),
    timedCall('c3', 'workflow', '2026-08-09T00:00:00Z'),
    result('c1', [{ type: 'text', text: 'ok' }]),
  ])
  assert.equal(usage.sessionId, 'session-deaths')
  assert.equal(usage.toolCalls, 3)
  assert.equal(usage.toolUsage.browser.count, 2)
  assert.equal(usage.toolUsage.browser.firstSeen, Date.parse('2026-08-01T00:00:00Z'))
  assert.equal(usage.toolUsage.browser.lastSeen, Date.parse('2026-08-05T00:00:00Z'))
  assert.equal(usage.toolUsage.workflow.count, 1)
})

test('death counters merge tool aliases and keep zero signals at zero', () => {
  const report = countDeathSignals([
    { sessionId: 's1', toolUsage: { browser: { count: 1, firstSeen: 10, lastSeen: 10 }, kix_browser: { count: 2, firstSeen: 20, lastSeen: 30 } } },
    { sessionId: 's2', toolUsage: { workflow: { count: 1, firstSeen: 40, lastSeen: 40 }, unknown_tool: { count: 5, firstSeen: 1, lastSeen: 1 } } },
  ], { roots: ['/tmp/x'], rootsScanned: 1, filesScanned: 2, decodeFailures: 1, skippedNonRoot: 3 })
  const byId = Object.fromEntries(report.signals.map((signal) => [signal.id, signal]))
  assert.equal(byId.browser.calls, 3)
  assert.equal(byId.browser.sessions, 2)
  assert.equal(byId.browser.firstSeen, 10)
  assert.equal(byId.browser.lastSeen, 30)
  assert.equal(byId.workflow.calls, 1)
  assert.equal(byId.probe.calls, 0)
  assert.equal(byId.probe.firstSeen, null)
  assert.equal(report.sessionsScanned, 2)
  assert.equal(report.decodeFailures, 1)
  assert.equal(report.skippedNonRoot, 3)
  assert.deepEqual(report.unknownTools, [{ name: 'unknown_tool', calls: 5 }])
})

test('proof that only matches the registry declaration itself is a failure (self-reference)', () => {
  // 4/11 条 proof 的 contains 与自己的声明行同文件：删掉真实载体后不得仍判绿。
  const script = fs.readFileSync(path.join(__dirname, 'audit-selection-pressure-history.cjs'), 'utf8')
  const start = script.indexOf('const PRESSURE_REGISTRY = [')
  const close = start === -1 ? null : /^\]\r?$/m.exec(script.slice(start))
  assert.ok(start !== -1 && close, 'registry block located')
  const end = start + close.index + close[0].length
  const outside = script.slice(0, start) + script.slice(end)
  for (const probe of [
    'nativeClusters.push({',
    'function detectInlineProgram(command) {',
    'routingCandidate: editedFiles.size >= 3',
    'const ALLOWED_CARRIERS = new Set([',
  ]) {
    assert.equal(outside.includes(probe), true, `carrier ${probe} exists outside the declaration`)
    assert.equal(script.includes(probe), true, `declaration also contains ${probe}`)
  }
  const mutated = script.replace('  nativeClusters.push({', '  nativeClusters.push( {', 1)
  assert.notEqual(mutated, script, 'mutation applied')
  assert.equal(mutated.includes('nativeClusters.push({'), true, 'only the declaration retains the literal')
})

test('deaths mode is opt-in and never runs on the default check path', () => {
  const run = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stdout, /deaths mode/)
})

test('--deaths prints a count table from depth-0 session history', {
  skip: typeof zlib.zstdCompressSync !== 'function' ? 'node zstd compress API unavailable' : false,
}, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-deaths-'))
  try {
    writeSessionFixture(tmp, 'sess-a', [
      { type: 'session', id: 's1', createdAt: Date.parse('2026-08-01T00:00:00Z'), delegationDepth: 0, agentPreset: 'kixparadigm' },
      timedCall('c1', 'browser', '2026-08-01T10:00:00Z'),
      timedCall('c2', 'kix_browser', '2026-08-20T10:00:00Z'),
      timedCall('c3', 'workflow', '2026-09-01T10:00:00Z'),
    ])
    writeSessionFixture(tmp, 'sess-child', [
      { type: 'session', id: 's2', createdAt: Date.parse('2026-08-02T00:00:00Z'), delegationDepth: 1, parentSession: 's1', origin: 'subagent' },
      timedCall('d1', 'probe', '2026-08-02T10:00:00Z'),
    ])

    const run = spawnSync(process.execPath, [SCRIPT, '--deaths', tmp], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /deaths mode/)
    assert.match(run.stdout, /depth-0 sessions: 1; decode failures: 0; non-root sessions skipped: 1/)
    assert.match(run.stdout, /^browser\s+2\s+2\s+2026-08-01\s+2026-08-20\s+browser,kix_browser$/m)
    assert.match(run.stdout, /^workflow\s+1\s+1\s+2026-09-01\s+2026-09-01\s+workflow$/m)
    assert.match(run.stdout, /^probe\s+0\s+0\s+—\s+—\s+probe$/m)

    const json = spawnSync(process.execPath, [SCRIPT, '--deaths', '--json', tmp], { encoding: 'utf8' })
    assert.equal(json.status, 0, json.stderr)
    const parsed = JSON.parse(json.stdout)
    assert.equal(parsed.sessionsScanned, 1)
    assert.equal(parsed.signals.find((signal) => signal.id === 'browser').calls, 2)
    assert.equal(parsed.signals.find((signal) => signal.id === 'probe').calls, 0)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
