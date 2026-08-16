'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { hasOtherPresetOwner, installVisionBridge, mergeVisionBridgePatch, uninstall } = require('./install-lib.js')

const DEFAULT_PATCH = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
].join('\n')

const LEGACY_BROKEN_PATCH = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '[]',
  '',
  '# bridge entry written by kixparadigm 1.2.8',
  '- insert:',
  '    - id: dsh-vision-bridge',
  '      name: dsh-vision-bridge',
  '',
].join('\n')

function bridgeIdCount(text) {
  return [...text.matchAll(/^\s*- id: dsh-vision-bridge\s*$/gm)].length
}

const silentLog = {
  info() {},
  ok() {},
  warn() {},
  step() {},
}

test('replaces DSH default [] root with one block-style patch list', () => {
  const result = mergeVisionBridgePatch(DEFAULT_PATCH)

  assert.equal(result.changed, true)
  assert.match(result.text, /^# Your patch layer/m)
  assert.doesNotMatch(result.text, /^\[\]\s*$/m)
  assert.match(result.text, /^- insert:\s*$/m)
  assert.equal(bridgeIdCount(result.text), 1)
})

test('repairs the legacy [] plus appended bridge document produced by 1.2.8', () => {
  const result = mergeVisionBridgePatch(LEGACY_BROKEN_PATCH)

  assert.equal(result.changed, true)
  assert.doesNotMatch(result.text, /^\[\]\s*$/m)
  assert.equal(bridgeIdCount(result.text), 1)
})

test('appends to an existing block-style top-level patch list', () => {
  const original = '- id: existing-plugin\n  name: example\n'
  const result = mergeVisionBridgePatch(original)

  assert.equal(result.changed, true)
  assert.ok(result.text.startsWith(original))
  assert.equal(bridgeIdCount(result.text), 1)
})

test('is idempotent when the bridge entry already exists in a valid list', () => {
  const installed = mergeVisionBridgePatch(DEFAULT_PATCH).text
  const result = mergeVisionBridgePatch(installed)

  assert.equal(result.changed, false)
  assert.equal(result.text, installed)
  assert.equal(bridgeIdCount(result.text), 1)
})

test('preserves CRLF line endings while replacing the default root', () => {
  const result = mergeVisionBridgePatch(DEFAULT_PATCH.replaceAll('\n', '\r\n'))

  assert.equal(result.changed, true)
  assert.doesNotMatch(result.text, /(?<!\r)\n/)
  assert.equal(bridgeIdCount(result.text), 1)
})

test('rejects a non-array YAML root without returning modified text', () => {
  const original = 'enabled: true\n'

  assert.throws(
    () => mergeVisionBridgePatch(original),
    /top-level YAML array/,
  )
  assert.equal(original, 'enabled: true\n')
})

test('rejects multi-document YAML instead of appending another root', () => {
  const original = '---\n- id: existing-plugin\n  name: example\n'

  assert.throws(
    () => mergeVisionBridgePatch(original),
    /top-level YAML array/,
  )
})

test('installVisionBridge writes a valid, idempotent patch in a real profile directory', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-installer-'))
  const profile = path.join(home, 'profiles', 'web')
  const patch = path.join(profile, 'cordis.patch.yml')
  const previousHome = process.env.DSH_HOME
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(patch, DEFAULT_PATCH, 'utf8')
  process.env.DSH_HOME = home

  installVisionBridge(silentLog)
  installVisionBridge(silentLog)

  const installed = fs.readFileSync(patch, 'utf8')
  assert.doesNotMatch(installed, /^\[\]\s*$/m)
  assert.equal(bridgeIdCount(installed), 1)
  assert.ok(fs.existsSync(path.join(profile, 'plugins', 'dsh-vision-bridge', 'package.json')))
  assert.equal(fs.lstatSync(path.join(profile, 'node_modules', 'dsh-vision-bridge')).isSymbolicLink(), true)
})

test('installVisionBridge rejects an invalid patch before creating plugin files or links', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-installer-invalid-'))
  const profile = path.join(home, 'profiles', 'web')
  const patch = path.join(profile, 'cordis.patch.yml')
  const previousHome = process.env.DSH_HOME
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(patch, 'enabled: true\n', 'utf8')
  process.env.DSH_HOME = home

  assert.throws(() => installVisionBridge(silentLog), /top-level YAML array/)
  assert.equal(fs.readFileSync(patch, 'utf8'), 'enabled: true\n')
  assert.equal(fs.existsSync(path.join(profile, 'plugins', 'dsh-vision-bridge')), false)
  assert.equal(fs.existsSync(path.join(profile, 'node_modules', 'dsh-vision-bridge')), false)
})

test('hasOtherPresetOwner detects the other kix preset edition', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-owner-'))
  try {
    assert.equal(hasOtherPresetOwner(home, 'kixparadigm'), false)
    fs.mkdirSync(path.join(home, '.agent-presets', 'kixparadigm-en'), { recursive: true })
    fs.writeFileSync(path.join(home, '.agent-presets', 'kixparadigm-en', 'agent.cordis.yml'), '[]\n')
    assert.equal(hasOtherPresetOwner(home, 'kixparadigm'), true)
    assert.equal(hasOtherPresetOwner(home, 'kixparadigm-en'), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('uninstall keeps the shared vision-bridge when the other kix preset is installed', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-shared-uninstall-'))
  const profile = path.join(home, 'profiles', 'web')
  const previousHome = process.env.DSH_HOME
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  fs.mkdirSync(profile, { recursive: true })
  process.env.DSH_HOME = home
  installVisionBridge(silentLog)

  const current = path.join(home, '.agent-presets', 'kixparadigm', 'agent.cordis.yml')
  const other = path.join(home, '.agent-presets', 'kixparadigm-en', 'agent.cordis.yml')
  fs.mkdirSync(path.dirname(current), { recursive: true })
  fs.writeFileSync(current, '[]\n')
  fs.mkdirSync(path.dirname(other), { recursive: true })
  fs.writeFileSync(other, '[]\n')

  uninstall(silentLog)

  assert.equal(fs.existsSync(current), false)
  assert.equal(fs.existsSync(other), true)
  assert.equal(fs.existsSync(path.join(profile, 'plugins', 'dsh-vision-bridge', 'package.json')), true)
  assert.equal(fs.existsSync(path.join(profile, 'node_modules', 'dsh-vision-bridge')), true)
  assert.equal(bridgeIdCount(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')), 1)
})

test('uninstall restores [] when the bridge was the only patch entry', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-uninstaller-'))
  const profile = path.join(home, 'profiles', 'web')
  const patch = path.join(profile, 'cordis.patch.yml')
  const previousHome = process.env.DSH_HOME
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(patch, DEFAULT_PATCH, 'utf8')
  process.env.DSH_HOME = home

  installVisionBridge(silentLog)
  uninstall(silentLog)

  const remaining = fs.readFileSync(patch, 'utf8')
  const semantic = remaining.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  assert.deepEqual(semantic, ['[]'])
  assert.equal(fs.existsSync(path.join(profile, 'plugins', 'dsh-vision-bridge')), false)
  assert.equal(fs.existsSync(path.join(profile, 'node_modules', 'dsh-vision-bridge')), false)
})
