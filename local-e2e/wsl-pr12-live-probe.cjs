#!/usr/bin/env node
// Live-shape reproduction probe: installed plugin, two sequential write dispatches.
const path = require('node:path')
const plugin = require('/root/.dsh/.agent-presets/kixparadigm/plugins/kix-consistency.js')

function harness() {
  const L = {}
  const ctx = {
    config: {},
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'sandboxPolicy') {
        return { workspaceRoot: '/root', resolve: (req) => ({ workspaceRoot: (req && req.session && req.session.header && req.session.header.cwd) || '/root' }) }
      }
      return undefined
    },
    on(e, c) { (L[e] ||= []).push(c) },
    effect() {},
  }
  plugin.apply(ctx, {})
  return L
}

async function dispatchPair(L, agent, callId, filePath, content) {
  const pre = await L['tools/pre-execute'][0]({ name: 'write', callId, arguments: { file_path: filePath, content }, agent }, () => 'NEXT')
  const post = await L['tools/post-execute'][0]({ name: 'write', callId, agent }, {}, () => 'NEXT')
  const injected = post && post.additionalContexts ? post.additionalContexts.map((m) => m.content[0].text) : null
  console.log(`callId=${callId} pre=${pre} injected=${injected ? JSON.stringify(injected[0].slice(0, 90)) : 'NONE'}`)
}

;(async () => {
  console.log('--- variant A: agent WITH session.cwd from the first dispatch ---')
  const LA = harness()
  const agentA = { id: 'live-agent', session: { header: { cwd: '/root/kix-e2e-pr12' } } }
  await dispatchPair(LA, agentA, 'w1', '/root/kix-e2e-pr12/pkgs/zh/skills/probe-a.md', '# a\n')
  await dispatchPair(LA, agentA, 'w2', '/root/kix-e2e-pr12/pkgs/zh/plugins/probe-drift.js', 'x\n')

  console.log('--- variant B: first dispatch WITHOUT session (heal on second) ---')
  const LB = harness()
  await dispatchPair(LB, { id: 'live-agent' }, 'w1', '/root/kix-e2e-pr12/pkgs/zh/skills/probe-b.md', '# b\n')
  const agentB = { id: 'live-agent', session: { header: { cwd: '/root/kix-e2e-pr12' } } }
  await dispatchPair(LB, agentB, 'w2', '/root/kix-e2e-pr12/pkgs/zh/plugins/probe-drift2.js', 'x\n')

  console.log('--- variant C: no agent at all on first dispatch ---')
  const LC = harness()
  await dispatchPair(LC, undefined, 'w1', '/root/kix-e2e-pr12/pkgs/zh/skills/probe-c.md', '# c\n')
  const agentC = { id: 'live-agent-c', session: { header: { cwd: '/root/kix-e2e-pr12' } } }
  await dispatchPair(LC, agentC, 'w2', '/root/kix-e2e-pr12/pkgs/zh/plugins/probe-drift3.js', 'x\n')

  // cleanup probes
  const fs = require('node:fs')
  for (const p of ['pkgs/zh/skills/probe-a.md', 'pkgs/zh/skills/probe-b.md', 'pkgs/zh/skills/probe-c.md',
    'pkgs/zh/plugins/probe-drift.js', 'pkgs/zh/plugins/probe-drift2.js', 'pkgs/zh/plugins/probe-drift3.js']) {
    try { fs.rmSync(path.join('/root/kix-e2e-pr12', p)) } catch {}
  }
})()
