'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { resolveRuntime } = require('./dsh-runtime-resolve.js')

function writePackage(dir, name) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }))
}

function linkPackage(parentDir, name, target) {
  const link = path.join(parentDir, 'node_modules', '@deepseek-ai', name)
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link)
}

test('resolves a flat npm scope from the install root', () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-resolve-flat-'))
  try {
    const scope = path.join(prefix, 'node_modules', '@deepseek-ai')
    writePackage(path.join(scope, 'dsh'), '@deepseek-ai/dsh')
    writePackage(path.join(scope, 'dsh-agent-preset-registry'), '@deepseek-ai/dsh-agent-preset-registry')
    writePackage(path.join(scope, 'dsh-compaction-basic'), '@deepseek-ai/dsh-compaction-basic')
    const runtime = resolveRuntime({ explicit: prefix })
    assert.equal(runtime.registry, path.join(scope, 'dsh-agent-preset-registry'))
    assert.equal(runtime.compaction, path.join(scope, 'dsh-compaction-basic'))
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true })
  }
})

test('resolves registry and session migrations nested under the importing package', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-resolve-nested-'))
  try {
    const cli = path.join(root, 'apps', 'cli')
    const web = path.join(root, 'packages', 'web-app')
    const registry = path.join(root, 'packages', 'registry')
    const compaction = path.join(root, 'packages', 'compaction')
    const jsonl = path.join(root, 'packages', 'jsonl')
    const catalog = path.join(root, 'packages', 'catalog')
    const v1 = path.join(root, 'packages', 'v1')
    writePackage(cli, '@deepseek-ai/dsh')
    writePackage(web, '@deepseek-ai/dsh-web-app')
    writePackage(registry, '@deepseek-ai/dsh-agent-preset-registry')
    writePackage(compaction, '@deepseek-ai/dsh-compaction-basic')
    writePackage(jsonl, '@deepseek-ai/dsh-session-persistence-jsonl')
    writePackage(catalog, '@deepseek-ai/dsh-session-format-catalog')
    writePackage(v1, '@deepseek-ai/dsh-session-format-v1-to-v2')
    linkPackage(cli, 'dsh-web-app', web)
    linkPackage(cli, 'dsh-compaction-basic', compaction)
    linkPackage(cli, 'dsh-session-persistence-jsonl', jsonl)
    linkPackage(web, 'dsh-agent-preset-registry', registry)
    linkPackage(jsonl, 'dsh-session-format-catalog', catalog)
    linkPackage(catalog, 'dsh-session-format-v1-to-v2', v1)
    const bin = path.join(cli, 'lib', 'bin.js')
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, '')

    const runtime = resolveRuntime({ explicit: bin })

    assert.equal(runtime.dshDir, cli)
    assert.equal(runtime.registry, registry)
    assert.equal(runtime.compaction, compaction)
    assert.equal(runtime.packages['dsh-session-format-v1-to-v2'], v1)
    assert.equal(fs.existsSync(path.join(cli, 'node_modules', '@deepseek-ai', 'dsh-agent-preset-registry')), false)
    assert.equal(fs.existsSync(path.join(cli, 'node_modules', '@deepseek-ai', 'dsh-session-format-v1-to-v2')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the live 0.1.5 package resolves no preset registry', (t) => {
  const live = '/usr/local/lib/dsh-0.1.5-rc.1/node_modules/@deepseek-ai/dsh'
  if (!fs.existsSync(path.join(live, 'package.json'))) {
    t.skip('live 0.1.5 runtime is not installed')
    return
  }
  const runtime = resolveRuntime({ explicit: live })
  assert.equal(runtime.registry, null)
  assert.ok(runtime.packages['dsh-session'])
})

test('a built master workspace resolves packages from the dsh package, not a synthetic scope', (t) => {
  const cli = '/tmp/kix-dsh-src/apps/cli'
  if (!fs.existsSync(path.join(cli, 'package.json'))) {
    t.skip('master workspace build is not present')
    return
  }
  const runtime = resolveRuntime({ explicit: cli })
  assert.equal(runtime.registry, fs.realpathSync('/tmp/kix-dsh-src/packages/preset/agent-preset-registry'))
  assert.equal(runtime.compaction, fs.realpathSync('/tmp/kix-dsh-src/packages/compaction/compaction-basic'))
  assert.equal(runtime.packages['dsh-session-format-v1-to-v2'], fs.realpathSync('/tmp/kix-dsh-src/packages/session/session-format-v1-to-v2'))
  assert.equal(fs.existsSync(path.join(cli, 'node_modules', '@deepseek-ai', 'dsh-agent-preset-registry')), false)
})
