'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const {
  PRESSURE_REGISTRY,
  aggregateSessions,
  analyzeSessionEvents,
  detectInlineProgram,
  extractPressureBullets,
  validatePressureRegistry,
} = require('./audit-selection-pressure-history.cjs')

const ROOT = path.resolve(__dirname, '..')

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
