'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const plugin = require('./kix-stalled.js')

function harness(fallback) {
  const commands = []
  const tools = []
  plugin.apply({
    fs: {
      resolve: async (value, options) => path.resolve(options.cwd, value),
      listDir: async (target) => fs.readdir(target, { withFileTypes: true }),
      readText: async (target) => fs.readFile(target, 'utf8'),
    },
    commands: { register(def) { commands.push(def); return () => {} } },
    tools: { register(def) { tools.push(def); return () => {} } },
    get: (name) => name === 'sandboxPolicy' ? { workspaceRoot: fallback } : undefined,
    effect: () => {},
  })
  return { command: commands[0], tool: tools[0] }
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kix-stalled-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const docs = path.join(root, 'docs', 'sprint-1')
  await fs.mkdir(docs, { recursive: true })
  await fs.writeFile(path.join(docs, 'progress.md'), '---\nstatus: in-progress\nlast_updated: 2020-01-01T00:00:00Z\n---\n')
  return root
}

test('default tool root follows the invoking session rather than host root', async (t) => {
  const root = await fixture(t)
  const { tool } = harness(path.parse(root).root)
  const result = await tool.execute({}, { agent: { session: { header: { cwd: root } } } })
  assert.equal(result.project.root, root)
  assert.equal(result.stalledCount, 1)
})

test('default command root follows the invoking session', async (t) => {
  const root = await fixture(t)
  const { command } = harness(path.parse(root).root)
  const result = await command.handler({ agent: { session: { header: { cwd: root } } }, rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /STALLED.*sprint-1/)
})

test('explicit root wins and missing agent can use host fallback', async (t) => {
  const root = await fixture(t)
  const { tool, command } = harness(root)
  const other = { agent: { session: { header: { cwd: path.parse(root).root } } } }
  assert.equal((await tool.execute({ root }, other)).stalledCount, 1)
  assert.equal((await tool.execute({})).stalledCount, 1)
  assert.match((await command.handler({ ...other, rawInput: root })).text, /STALLED.*sprint-1/)
})

test('one shared plugin serves different session workspaces independently', async (t) => {
  const root = await fixture(t)
  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kix-stalled-empty-'))
  t.after(() => fs.rm(otherRoot, { recursive: true, force: true }))
  const { tool } = harness(path.parse(root).root)
  const a = await tool.execute({}, { agent: { session: { header: { cwd: root } } } })
  const b = await tool.execute({}, { agent: { session: { header: { cwd: otherRoot } } } })
  assert.equal(a.stalledCount, 1)
  assert.equal(b.project.root, otherRoot)
  assert.equal(b.stalledCount, 0)
})
