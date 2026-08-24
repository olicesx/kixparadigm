'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const SCRIPT = path.join(ROOT, 'scripts', 'sync-dsh-preset.ps1')
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'

function runPowerShell(args) {
  return spawnSync(POWERSHELL, ['-NoProfile', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

test('sync expands repository directory pointers into materialized targets', (t) => {
  const probe = runPowerShell(['-Command', '$PSVersionTable.PSVersion.ToString()'])
  if (probe.error && probe.error.code === 'ENOENT') {
    t.skip(`${POWERSHELL} is unavailable`)
    return
  }
  assert.equal(probe.status, 0, probe.stderr || probe.stdout)

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-sync-preset-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))

  const target = path.join(temp, '.agent-presets', 'kixparadigm')
  fs.mkdirSync(path.join(target, 'skills'), { recursive: true })
  fs.writeFileSync(path.join(target, 'skills', 'existing.txt'), 'existing\n', 'utf8')

  const common = [
    '-PresetRoot', target,
    '-PresetId', 'kixparadigm',
    '-SourceDir', path.join('dsh', 'preset'),
  ]
  const sync = runPowerShell(['-File', SCRIPT, '-Force', ...common])
  assert.equal(sync.status, 0, sync.stderr || sync.stdout)
  assert.equal(fs.existsSync(path.join(target, 'skills', 'skills')), false)
  assert.equal(fs.existsSync(path.join(target, 'skills', 'kixparadigm', 'SKILL.md')), true)
  assert.equal(fs.readFileSync(path.join(target, 'skills', 'existing.txt'), 'utf8'), 'existing\n')

  const dryRun = runPowerShell(['-File', SCRIPT, '-DryRun', ...common])
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout)
  assert.match(dryRun.stdout, /added 0 \/ updated 0/)
})

test('sync preserves ordinary files whose content names a directory', (t) => {
  const probe = runPowerShell(['-Command', '$PSVersionTable.PSVersion.ToString()'])
  if (probe.error && probe.error.code === 'ENOENT') {
    t.skip(`${POWERSHELL} is unavailable`)
    return
  }
  assert.equal(probe.status, 0, probe.stderr || probe.stdout)

  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-sync-bundle-'))
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-sync-target-'))
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }))
  t.after(() => fs.rmSync(target, { recursive: true, force: true }))

  fs.mkdirSync(path.join(bundle, 'src'), { recursive: true })
  fs.mkdirSync(path.join(bundle, 'linked'), { recursive: true })
  fs.writeFileSync(path.join(bundle, 'src', 'ordinary.txt'), '../linked\n', 'utf8')
  fs.writeFileSync(path.join(bundle, 'linked', 'file.txt'), 'linked\n', 'utf8')

  const sync = runPowerShell([
    '-File', SCRIPT,
    '-Force',
    '-BundleRoot', bundle,
    '-SourceDir', 'src',
    '-PresetRoot', target,
  ])
  assert.equal(sync.status, 0, sync.stderr || sync.stdout)
  assert.equal(fs.readFileSync(path.join(target, 'ordinary.txt'), 'utf8'), '../linked\n')
  assert.equal(fs.existsSync(path.join(target, 'ordinary.txt', 'file.txt')), false)
})

test('sync expands an explicitly declared native directory symlink', (t) => {
  if (process.platform === 'win32') {
    t.skip('native symlink fixture requires no Windows developer-mode privilege')
    return
  }

  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-sync-symlink-'))
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-sync-symlink-target-'))
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }))
  t.after(() => fs.rmSync(target, { recursive: true, force: true }))

  fs.mkdirSync(path.join(bundle, 'src'), { recursive: true })
  fs.mkdirSync(path.join(bundle, 'linked'), { recursive: true })
  fs.writeFileSync(path.join(bundle, 'linked', 'file.txt'), 'linked\n', 'utf8')
  fs.symlinkSync('../linked', path.join(bundle, 'src', 'alias'), 'dir')

  const sync = runPowerShell([
    '-File', SCRIPT,
    '-Force',
    '-BundleRoot', bundle,
    '-SourceDir', 'src',
    '-PresetRoot', target,
    '-DirectoryPointers', path.join('src', 'alias'),
  ])
  assert.equal(sync.status, 0, sync.stderr || sync.stdout)
  assert.equal(fs.readFileSync(path.join(target, 'alias', 'file.txt'), 'utf8'), 'linked\n')
})

test('sync rejects a case-variant sibling as outside the bundle on POSIX', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows paths are case-insensitive')
    return
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-sync-case-'))
  const bundle = path.join(temp, 'bundle')
  const sibling = path.join(temp, 'BUNDLE')
  const target = path.join(temp, 'target')
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))

  fs.mkdirSync(path.join(bundle, 'src'), { recursive: true })
  fs.mkdirSync(sibling, { recursive: true })
  fs.writeFileSync(path.join(bundle, 'src', 'alias'), '../../BUNDLE\n', 'utf8')
  fs.writeFileSync(path.join(sibling, 'file.txt'), 'outside\n', 'utf8')

  const sync = runPowerShell([
    '-File', SCRIPT,
    '-Force',
    '-BundleRoot', bundle,
    '-SourceDir', 'src',
    '-PresetRoot', target,
    '-DirectoryPointers', path.join('src', 'alias'),
  ])
  assert.notEqual(sync.status, 0)
  assert.match(sync.stderr, /outside the bundle/)
  assert.equal(fs.existsSync(path.join(target, 'alias', 'file.txt')), false)
})

test('sync fails closed for missing or out-of-source declared pointers', (t) => {
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-sync-declared-'))
  const missingTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-sync-missing-target-'))
  const outsideTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-sync-outside-target-'))
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }))
  t.after(() => fs.rmSync(missingTarget, { recursive: true, force: true }))
  t.after(() => fs.rmSync(outsideTarget, { recursive: true, force: true }))

  fs.mkdirSync(path.join(bundle, 'src'), { recursive: true })
  fs.mkdirSync(path.join(bundle, 'other'), { recursive: true })
  fs.mkdirSync(path.join(bundle, 'linked'), { recursive: true })
  fs.writeFileSync(path.join(bundle, 'src', 'file.txt'), 'source\n', 'utf8')
  fs.writeFileSync(path.join(bundle, 'other', 'alias'), '../linked\n', 'utf8')
  fs.writeFileSync(path.join(bundle, 'linked', 'file.txt'), 'linked\n', 'utf8')

  const missing = runPowerShell([
    '-File', SCRIPT,
    '-Force',
    '-BundleRoot', bundle,
    '-SourceDir', 'src',
    '-PresetRoot', missingTarget,
    '-DirectoryPointers', path.join('src', 'missing'),
  ])
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /does not exist/)
  assert.equal(fs.existsSync(path.join(missingTarget, 'file.txt')), false)

  const outside = runPowerShell([
    '-File', SCRIPT,
    '-Force',
    '-BundleRoot', bundle,
    '-SourceDir', 'src',
    '-PresetRoot', outsideTarget,
    '-DirectoryPointers', path.join('other', 'alias'),
  ])
  assert.notEqual(outside.status, 0)
  assert.match(outside.stderr, /outside the selected source/)
  assert.equal(fs.existsSync(path.join(outsideTarget, 'file.txt')), false)
})
