'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { hasOtherPresetOwner, installPreset, installVisionBridge, mergeVisionBridgePatch, uninstall, copyTree, ensureDefaultSkillsShelf } = require('./install-lib.js')

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
    fs.mkdirSync(path.join(home, '.agent-presets', 'kixparadigm-classic-en'), { recursive: true })
    fs.writeFileSync(path.join(home, '.agent-presets', 'kixparadigm-classic-en', 'agent.cordis.yml'), '[]\n')
    assert.equal(hasOtherPresetOwner(home, 'kixparadigm'), true, 'v1.3.0 重命名后的 en 安装 id 也算 owner（bridge 共享）')
    assert.equal(hasOtherPresetOwner(home, 'kixparadigm-classic-en'), false)
    fs.mkdirSync(path.join(home, '.agent-presets', 'kixparadigm-en'), { recursive: true })
    fs.writeFileSync(path.join(home, '.agent-presets', 'kixparadigm-en', 'agent.cordis.yml'), '[]\n')
    assert.equal(hasOtherPresetOwner(home, 'kixparadigm-classic-en'), true, '改名前老安装名仍兼容')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('hasOtherPresetOwner treats classic as owned by the zh package, not as another owner', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-owner-classic-'))
  try {
    const mark = (id) => {
      fs.mkdirSync(path.join(home, '.agent-presets', id), { recursive: true })
      fs.writeFileSync(path.join(home, '.agent-presets', id, 'agent.cordis.yml'), '[]\n')
    }
    mark('kixparadigm-classic')
    // 卸载 en 包时，主包 classic 在装 → bridge 保留
    assert.equal(hasOtherPresetOwner(home, 'kixparadigm-en'), true)
    // 卸载主包（default + classic 一起删），无其他 owner → bridge 删除
    assert.equal(hasOtherPresetOwner(home, ['kixparadigm', 'kixparadigm-classic']), false)
    mark('kixparadigm-en')
    assert.equal(hasOtherPresetOwner(home, ['kixparadigm', 'kixparadigm-classic']), true)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('installPreset installs every declared variant including kixparadigm-classic', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-variants-'))
  const previousHome = process.env.DSH_HOME
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  process.env.DSH_HOME = home

  installPreset(silentLog)

  for (const id of ['kixparadigm', 'kixparadigm-classic']) {
    assert.equal(fs.existsSync(path.join(home, '.agent-presets', id, 'agent.cordis.yml')), true, `${id} agent.cordis.yml`)
    assert.equal(fs.existsSync(path.join(home, '.agent-presets', id, 'preset.yml')), true, `${id} preset.yml`)
  }
  const classicName = fs.readFileSync(path.join(home, '.agent-presets', 'kixparadigm-classic', 'preset.yml'), 'utf8')
  assert.match(classicName, /^name:\s*kixparadigm-classic\s*$/m)
  const installedSkills = path.join(home, '.agent-presets', 'kixparadigm', 'skills', 'handoff', 'SKILL.md')
  assert.equal(fs.existsSync(installedSkills), true, 'default variant skills/handoff installed')
  assert.equal(fs.lstatSync(path.join(home, '.agent-presets', 'kixparadigm', 'skills')).isSymbolicLink(), false, 'installer materializes skills as a real tree')
})

test('ensureDefaultSkillsShelf materializes classic shelf when dest has none', () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-shelf-'))
  try {
    assert.equal(fs.existsSync(path.join(dest, 'skills', 'handoff', 'SKILL.md')), false)
    const extra = ensureDefaultSkillsShelf(dest, silentLog)
    assert.ok(extra, 'fallback copied files')
    assert.equal(fs.existsSync(path.join(dest, 'skills', 'handoff', 'SKILL.md')), true)
    assert.equal(ensureDefaultSkillsShelf(dest, silentLog), null, 'second call is a no-op')
  } finally {
    fs.rmSync(dest, { recursive: true, force: true })
  }
})

test('copyTree materializes a git-style symlink file (Windows core.symlinks=false)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-gitlink-'))
  try {
    const src = path.join(root, 'src')
    const dst = path.join(root, 'dst')
    const classic = path.join(src, 'classic', 'skills', 'handoff')
    fs.mkdirSync(classic, { recursive: true })
    fs.writeFileSync(path.join(classic, 'SKILL.md'), 'name: handoff\n')
    fs.mkdirSync(path.join(src, 'preset'), { recursive: true })
    fs.writeFileSync(path.join(src, 'preset', 'skills'), '../classic/skills')
    copyTree(path.join(src, 'preset'), dst, silentLog)
    assert.equal(fs.lstatSync(path.join(dst, 'skills')).isDirectory(), true)
    assert.equal(fs.readFileSync(path.join(dst, 'skills', 'handoff', 'SKILL.md'), 'utf8'), 'name: handoff\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('uninstall removes every variant directory of the zh package', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-uninstall-variants-'))
  const previousHome = process.env.DSH_HOME
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  process.env.DSH_HOME = home

  installPreset(silentLog)
  for (const id of ['kixparadigm', 'kixparadigm-classic']) {
    assert.equal(fs.existsSync(path.join(home, '.agent-presets', id, 'agent.cordis.yml')), true)
  }

  uninstall(silentLog)

  for (const id of ['kixparadigm', 'kixparadigm-classic']) {
    assert.equal(fs.existsSync(path.join(home, '.agent-presets', id)), false, `${id} should be removed`)
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
