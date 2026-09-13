'use strict'

/**
 * Regression suite for scripts/patch-dsh-runtime.js.
 *
 * These tests assert the *installed* DSH runtime carries the session-history
 * availability patch. A DSH upgrade replaces node_modules and makes them fail —
 * that failure is the point: it is the signal to run
 * `node scripts/patch-dsh-runtime.js` again before trusting old sessions.
 *
 * Everything that needs an installed runtime is skipped when none is found, so
 * the file stays green on machines that only consume this repository.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { HUNKS, LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES, inspectHunk, locateRuntime } = require('./patch-dsh-runtime.js')

const PLUGIN_TYPE = 'web/glm-search-mcp-request'

function resolveScope() {
  try {
    return locateRuntime(undefined)
  } catch {
    return undefined
  }
}

const SCOPE = resolveScope()
const noRuntime = SCOPE === undefined ? 'no DSH runtime installed on this machine' : false

const load = (pkg) => import(pathToFileURL(path.join(SCOPE, pkg, 'lib', 'index.js')).href)

/** A minimal, structurally valid released-v0 artifact carrying one probe event at seq 4. */
function v0Artifact(event) {
  return {
    header: { type: 'session', version: 0, id: 'kix-probe', createdAt: 1, delegationDepth: 0, cwd: '/root' },
    events: [
      { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'danger-full-access' } },
      { type: 'sandbox/mode', seq: 1, time: 2, data: { mode: 'danger-full-access' } },
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } },
      { type: 'step/start', seq: 3, time: 4, data: { turn: 1, step: 1 } },
      { seq: 4, time: 5, ...event },
      { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'stop' } } },
    ],
  }
}

const PLUGIN_EVENT = { type: PLUGIN_TYPE, data: { endpoint: 'mcp', toolName: 'web_search_prime', params: {} } }

const DESCRIPTOR_V2 = {
  version: 2,
  mode: 'continuable',
  provider: 'spawn',
  label: 'probe',
  agentProvider: 'zai-coding-cn',
  agentModel: 'glm-4.7',
  persona: 'probe persona',
  toolFilter: { allow: ['read'] },
}

const spliced = (form) => ({
  type: 'agent/inbox/spliced',
  data: {
    target: 'next-step',
    start: 0,
    inserted: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'probe' }], source: { kind: 'plugin', plugin: 'kix-budget', form, summary: 'probe' } }],
  },
})

/** Drive DSH's own v0 -> v1 -> v2 -> v3 chain over one synthetic artifact. */
async function migrate(event) {
  const { sessionFormatCatalog } = await load('dsh-session-format-catalog')
  const { header, events } = v0Artifact(event)
  const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'transformed' })
  for (const row of events) restore.decodeRow(row)
  return restore.finish()
}

test('hunk table is well formed', () => {
  const ids = new Set()
  for (const hunk of HUNKS) {
    assert.equal(typeof hunk.id, 'string')
    assert.equal(ids.has(hunk.id), false, `duplicate hunk id ${hunk.id}`)
    ids.add(hunk.id)
    assert.equal(hunk.edits.length > 0, true, `${hunk.id} has no edits`)
    for (const edit of hunk.edits) {
      assert.notEqual(edit.find, edit.replace, `${hunk.id} has a no-op edit`)
      assert.equal(edit.find.length > 0, true)
    }
  }
  assert.equal(LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES.includes(PLUGIN_TYPE), true)
})

test('every hunk is applied to the installed runtime', { skip: noRuntime }, () => {
  for (const hunk of HUNKS) {
    const status = inspectHunk(SCOPE, hunk)
    assert.equal(
      status.state,
      'applied',
      `${hunk.id} is ${status.state}${status.detail === undefined ? '' : `: ${status.detail}`} — run: node scripts/patch-dsh-runtime.js`,
    )
  }
})

test('the plugin allowlist does not drift between the packages that declare it', { skip: noRuntime }, () => {
  const read = (pkg) => fs.readFileSync(path.join(SCOPE, pkg, 'lib', 'index.js'), 'utf8')
  const declared = (pkg) => {
    const match = read(pkg).match(/const LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES = new Set\(\[([^\]]*)\]\)/)
    assert.notEqual(match, null, `${pkg} does not declare the allowlist`)
    return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1])
  }

  const declaring = ['dsh-session-format-v0-to-v1', 'dsh-session-persistence']
  for (const pkg of declaring) assert.deepEqual(declared(pkg), LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES)

  // The later migrations import the single exported set rather than restating it.
  for (const pkg of ['dsh-session-format-v1-to-v2', 'dsh-session-format-v2-to-v3']) {
    const source = read(pkg)
    assert.equal(source.includes('LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES'), true, `${pkg} does not reference the allowlist`)
    assert.equal(source.split(`"${PLUGIN_TYPE}"`).length - 1, 0, `${pkg} restates the allowlist literal`)
  }
})

test('v0 migration admits the plugin audit event and stamps the ignorable marker', { skip: noRuntime }, async () => {
  const artifact = await migrate(PLUGIN_EVENT)
  const admitted = artifact.events.filter((event) => event.type === PLUGIN_TYPE)
  assert.equal(admitted.length, 1)
  assert.equal(admitted[0].ignorable, true, 'the migration must re-emit the admitted plugin event as ignorable')
})

test('v0 migration still refuses an unknown required event type', { skip: noRuntime }, async () => {
  await assert.rejects(
    () => migrate({ type: 'future/required-event', data: {} }),
    (error) => /unknown historical event type/.test(error.message) && /future\/required-event/.test(error.message),
  )
})

test('v0 migration still refuses a near-miss plugin type', { skip: noRuntime }, async () => {
  await assert.rejects(
    () => migrate({ ...PLUGIN_EVENT, type: `${PLUGIN_TYPE}-v2` }),
    (error) => /unknown historical event type/.test(error.message),
  )
})

test('v0 migration carries a retired descriptor v2 through unclassified', { skip: noRuntime }, async () => {
  const artifact = await migrate({ type: 'subagent/descriptor', data: DESCRIPTOR_V2 })
  const descriptor = artifact.events.filter((event) => event.type === 'subagent/descriptor')
  assert.equal(descriptor.length, 1)
  assert.equal(descriptor[0].data.version, 2, 'the retired descriptor stays inert rather than being restamped')
})

test('v0 migration still refuses an unknown descriptor version', { skip: noRuntime }, async () => {
  await assert.rejects(
    () => migrate({ type: 'subagent/descriptor', data: { ...DESCRIPTOR_V2, version: 4 } }),
    /unsupported descriptor version 4/,
  )
})

test('v0 migration keeps retired inbox provenance forms and refuses unknown ones', { skip: noRuntime }, async () => {
  const artifact = await migrate(spliced('gate'))
  const event = artifact.events.find((candidate) => candidate.type === 'agent/inbox/spliced')
  assert.equal(event.data.inserted[0].source.form, 'gate')

  await assert.rejects(() => migrate(spliced('mystery')), /form must be one of/)
})

test('Session.append persists the ignorable envelope marker', { skip: noRuntime }, async () => {
  const { Session, SessionId } = await load('dsh-session')
  const session = new Session(SessionId('kix-probe'), [], { version: 3, id: 'kix-probe', createdAt: 1, isSeeded: false, delegationDepth: 0 }, 'snapshot')
  assert.equal(session.append(PLUGIN_TYPE, { endpoint: 'mcp' }, { ignorable: true }).ignorable, true)
  assert.equal(session.append(PLUGIN_TYPE, { endpoint: 'mcp' }).ignorable, undefined)
})

test('current-generation reads admit the plugin event and refuse an unknown one', { skip: noRuntime }, async () => {
  const { validateStoredEvents } = await load('dsh-session-persistence')
  const location = { kind: 'jsonl', path: 'probe' }
  validateStoredEvents({ id: 'kix-probe' }, [{ type: PLUGIN_TYPE, seq: 0, time: 1, data: { endpoint: 'mcp' } }], location)
  assert.throws(
    () => validateStoredEvents({ id: 'kix-probe' }, [{ type: 'future/required-event', seq: 0, time: 1, data: {} }], location),
    /unknown to this harness/,
  )
})
