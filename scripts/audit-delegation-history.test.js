'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  classifyChild,
  toolCallEvents,
  toolCallNames,
  recordToolCall,
} = require('./audit-delegation-history.cjs')

function slot() {
  return {
    spawnCalls: 0, runCode: 0, workflow: 0, capability: 0, activate: 0, goal: 0,
    sourceEdits: 0, memberCalls: 0, reviewerCalls: 0, qaCalls: 0, devCalls: 0,
    genericCalls: 0, crossCalls: 0,
  }
}

test('only type=tool/call events count as tool calls', () => {
  const text = [
    JSON.stringify({ type: 'request/header', data: { system: '{"name":"subagent_reviewer"}' } }),
    JSON.stringify({ type: 'tool/call', data: { name: 'subagent_dev', arguments: '{}' } }),
    JSON.stringify({ type: 'tool/result', data: { name: 'subagent_qa' } }),
    JSON.stringify({ type: 'tool/call', data: { name: 'bash', arguments: '{"name":"subagent_reviewer"}' } }),
    '{broken',
  ].join('\n')

  assert.deepEqual(toolCallNames(text), ['subagent_dev', 'bash'])
  assert.deepEqual(toolCallEvents(text).map((call) => call.name), ['subagent_dev', 'bash'])
})

test('member counters use actual tool names, not labels', () => {
  const out = slot()
  for (const name of ['subagent_reviewer', 'subagent_qa', 'subagent_dev', 'subagent', 'subagent_cross']) {
    recordToolCall(out, { name, arguments: '{}' })
  }
  assert.deepEqual({
    spawnCalls: out.spawnCalls,
    memberCalls: out.memberCalls,
    reviewerCalls: out.reviewerCalls,
    qaCalls: out.qaCalls,
    devCalls: out.devCalls,
    genericCalls: out.genericCalls,
    crossCalls: out.crossCalls,
  }, {
    spawnCalls: 5,
    memberCalls: 3,
    reviewerCalls: 1,
    qaCalls: 1,
    devCalls: 1,
    genericCalls: 1,
    crossCalls: 1,
  })
})

test('source edit count excludes docs-only writes', () => {
  const out = slot()
  recordToolCall(out, { name: 'write', arguments: JSON.stringify({ file_path: 'docs/decision.md' }) })
  recordToolCall(out, { name: 'edit', arguments: { file_path: 'src/index.ts' } })
  recordToolCall(out, { name: 'write', arguments: JSON.stringify({ file_path: 'agent.cordis.yml' }) })
  recordToolCall(out, { name: 'edit', arguments: '{}' })
  assert.equal(out.sourceEdits, 2)
})

test('child label cannot impersonate a role member', () => {
  const descriptor = [{
    type: 'subagent/descriptor',
    data: { agentModel: 'deepseek-v4', label: 'review device drivers for sprint' },
  }]
  assert.equal(classifyChild(descriptor), 'regular')
  assert.equal(classifyChild([{ type: 'subagent/descriptor', data: { agentModel: 'kix-route:cross' } }]), 'cross')
  assert.equal(classifyChild([{ type: 'subagent/descriptor', data: { agentModel: 'subagent-lite' } }]), 'lite')
})
