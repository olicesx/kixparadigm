'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { hasOtherPresetOwner, installPreset, installVisionBridge, mergeVisionBridgePatch, uninstall, copyTree, ensureDefaultSkillsShelf, ensureDefaultShelf, presetResolutionRoot, missingBarePackages, renderPresetPatchBlock, upsertPresetBlock, stripPatchedHostConfigKeys } = require('./install-lib.js')

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
  const previousPrefix = process.env.KIX_DSH_PREFIX
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousPrefix === undefined) delete process.env.KIX_DSH_PREFIX
    else process.env.KIX_DSH_PREFIX = previousPrefix
    fs.rmSync(home, { recursive: true, force: true })
  })
  process.env.DSH_HOME = home
  process.env.KIX_DSH_PREFIX = home

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
    const second = ensureDefaultSkillsShelf(dest, silentLog)
    assert.ok(second, 'second call re-syncs instead of early-returning')
    assert.equal(second.added.length + second.updated.length, 0, 'second call changes nothing when source is unchanged')
  } finally {
    fs.rmSync(dest, { recursive: true, force: true })
  }
})

test('ensureDefaultShelf materializes agents too (货架内 ../../agents 链接可达)', () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-agents-'))
  try {
    assert.equal(fs.existsSync(path.join(dest, 'agents', 'kixparadigm.agent.md')), false)
    const extra = ensureDefaultShelf('agents', dest, silentLog)
    assert.ok(extra, 'agents shelf materialized')
    assert.equal(fs.existsSync(path.join(dest, 'agents', 'kixparadigm.agent.md')), true)
    const secondAgents = ensureDefaultShelf('agents', dest, silentLog)
    assert.ok(secondAgents, 'second call re-syncs instead of early-returning')
    assert.equal(secondAgents.added.length + secondAgents.updated.length, 0, 'second call changes nothing when source is unchanged')
  } finally {
    fs.rmSync(dest, { recursive: true, force: true })
  }
})

test('ensureDefaultShelf 目标侧残留同名指针文件时先清后建（Windows 检出形态）', () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-stale-'))
  try {
    fs.writeFileSync(path.join(dest, 'agents'), '../preset-classic/agents')
    const extra = ensureDefaultShelf('agents', dest, silentLog)
    assert.ok(extra, 'stale pointer file replaced by a real tree')
    assert.equal(fs.lstatSync(path.join(dest, 'agents')).isDirectory(), true)
    assert.equal(fs.existsSync(path.join(dest, 'agents', 'kixparadigm.agent.md')), true)
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
    fs.mkdirSync(path.join(src, 'preset', 'memories'), { recursive: true })
    fs.writeFileSync(path.join(src, 'preset', 'memories', 'keep.md'), 'keep\n')
    copyTree(path.join(src, 'preset'), dst, silentLog)
    assert.equal(fs.lstatSync(path.join(dst, 'skills')).isDirectory(), true)
    assert.equal(fs.readFileSync(path.join(dst, 'skills', 'handoff', 'SKILL.md'), 'utf8'), 'name: handoff\n')
    // 指针目录是镜像：源侧删除的残留必须在目标侧一起清掉（单源在运行时成立）。
    fs.writeFileSync(path.join(dst, 'skills', 'stale.md'), 'stale\n')
    fs.mkdirSync(path.join(dst, 'skills', 'staleDir'), { recursive: true })
    fs.writeFileSync(path.join(dst, 'skills', 'staleDir', 'x.md'), 'x\n')
    // 普通目录里的用户文件绝不能被裁剪（kix-mem 经验库就写在安装副本 memories/ 下）。
    fs.mkdirSync(path.join(dst, 'memories'), { recursive: true })
    fs.writeFileSync(path.join(dst, 'memories', 'user-note.md'), 'mine\n')
    const r = copyTree(path.join(src, 'preset'), dst, silentLog)
    assert.equal(fs.existsSync(path.join(dst, 'skills', 'stale.md')), false, 'stale file pruned from mirror')
    assert.equal(fs.existsSync(path.join(dst, 'skills', 'staleDir')), false, 'stale dir pruned from mirror')
    assert.equal(fs.existsSync(path.join(dst, 'memories', 'user-note.md')), true, 'plain directory is never pruned')
    assert.ok(r.pruned.some((p) => p.includes('stale')), 'prune reported separately from target-only')
    assert.ok(r.pruned.every((p) => !p.startsWith('..')), 'pruned paths are preset-root relative, not ../dst')
    assert.equal(r.targetOnly.some((p) => p.startsWith('skills/')), false, 'mirror contents are not reported as target-only')
    assert.ok(r.targetOnly.includes('memories/user-note.md'), 'plain-directory extras stay in targetOnly')
    assert.equal(r.targetOnly.some((p) => p.includes('stale')), false, 'pruned entries are not reported as kept')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('ensureDefaultShelf 源侧删除的文件在目标货架被裁剪（货架自身即镜像）', () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-shelf-prune-'))
  try {
    const first = ensureDefaultShelf('agents', dest, silentLog)
    assert.ok(first && first.added.length > 0, 'agents shelf materialized')
    // 模拟上游删除：目标货架放一个源侧不存在的残留
    fs.writeFileSync(path.join(dest, 'agents', 'ghost.agent.md'), 'ghost\n')
    const second = ensureDefaultShelf('agents', dest, silentLog)
    assert.equal(fs.existsSync(path.join(dest, 'agents', 'ghost.agent.md')), false, 'stale shelf file pruned')
    assert.ok(second.pruned.some((p) => p.includes('ghost')), 'prune reported')
  } finally {
    fs.rmSync(dest, { recursive: true, force: true })
  }
})

test('uninstall removes every variant directory of the zh package', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-uninstall-variants-'))
  const previousHome = process.env.DSH_HOME
  const previousPrefix = process.env.KIX_DSH_PREFIX
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousPrefix === undefined) delete process.env.KIX_DSH_PREFIX
    else process.env.KIX_DSH_PREFIX = previousPrefix
    fs.rmSync(home, { recursive: true, force: true })
  })
  process.env.DSH_HOME = home
  process.env.KIX_DSH_PREFIX = home

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

function withInstallEnv(t, home, prefix) {
  const previousHome = process.env.DSH_HOME
  const previousPrefix = process.env.KIX_DSH_PREFIX
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousPrefix === undefined) delete process.env.KIX_DSH_PREFIX
    else process.env.KIX_DSH_PREFIX = previousPrefix
  })
  process.env.DSH_HOME = home
  process.env.KIX_DSH_PREFIX = prefix
}

function writeWebProfile(home) {
  const profile = path.join(home, 'profiles', 'web')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
  }))
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), DEFAULT_PATCH)
  return path.join(profile, 'cordis.patch.yml')
}

test('installPreset does not declare or patch a runtime without the preset registry', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-noreg-'))
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-noreg-prefix-'))
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(prefix, { recursive: true, force: true })
  })
  const decoy = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js')
  fs.mkdirSync(path.dirname(decoy), { recursive: true })
  fs.writeFileSync(decoy, 'leave-me\n')
  writeWebProfile(home)
  withInstallEnv(t, home, prefix)

  const installed = installPreset(silentLog)

  assert.equal(installed.kixRuntime.reason, 'no-registry')
  assert.equal(installed.kixRuntime.declared, false)
  assert.equal(fs.readFileSync(decoy, 'utf8'), 'leave-me\n')
  // 无 registry 时不链接：preset 目录保持纯副本。
  assert.equal(fs.existsSync(path.join(home, '.agent-presets', 'kixparadigm', 'node_modules')), false)
  assert.doesNotMatch(fs.readFileSync(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), /BEGIN kix-presets/)
})

test('installPreset does not declare when the cap patch cannot apply', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-badcap-'))
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-badcap-prefix-'))
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(prefix, { recursive: true, force: true })
  })
  const registry = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh-agent-preset-registry', 'package.json')
  const dshPkg = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const index = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js')
  fs.mkdirSync(path.dirname(registry), { recursive: true })
  fs.writeFileSync(registry, '{"name":"@deepseek-ai/dsh-agent-preset-registry"}\n')
  fs.mkdirSync(path.dirname(dshPkg), { recursive: true })
  fs.writeFileSync(dshPkg, '{"name":"@deepseek-ai/dsh"}\n')
  fs.mkdirSync(path.dirname(index), { recursive: true })
  fs.writeFileSync(path.join(path.dirname(index), '..', 'package.json'), '{"name":"@deepseek-ai/dsh-compaction-basic"}\n')
  fs.writeFileSync(index, 'not-the-engine\n')
  const patch = writeWebProfile(home)
  withInstallEnv(t, home, prefix)

  assert.throws(() => installPreset(silentLog), /压缩上限补丁失败/)
  assert.equal(fs.readFileSync(index, 'utf8'), 'not-the-engine\n')
  assert.doesNotMatch(fs.readFileSync(patch, 'utf8'), /BEGIN kix-presets/)
})

test('cap patch refuses a PATH dsh whose install has no preset registry', { skip: process.platform === 'win32' ? 'which-based PATH resolution is POSIX-only' : false }, (t) => {
  // 前提必须自造，不能靠「本机 PATH 上的 dsh 恰好是 0.1.5」。宿主升级到 0.2.0
  // 后 PATH dsh 自带 registry，旧用例（读 /usr/local/lib/dsh-0.1.5-rc.1 并断言
  // 拒绝）会从真回归退化成假红。这里搭一个无 registry 的临时安装 + PATH shim，
  // 把「拒绝」钉在用例自己造的现场上。
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-pathdsh-'))
  const bin = path.join(prefix, 'bin')
  const dshPkg = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
  const decoy = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js')
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dshPkg, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dshPkg, 'package.json'), '{"name":"@deepseek-ai/dsh"}\n')
  fs.writeFileSync(path.join(dshPkg, 'lib', 'bin.js'), '// fake launcher for PATH resolution\n')
  // `which` skips non-executable candidates: without the exec bit the shim is
  // invisible and the real PATH dsh wins again (the exact stale-premise trap).
  fs.chmodSync(path.join(dshPkg, 'lib', 'bin.js'), 0o755)
  fs.mkdirSync(path.dirname(decoy), { recursive: true })
  fs.writeFileSync(decoy, 'leave-me\n')
  fs.mkdirSync(bin, { recursive: true })
  fs.symlinkSync(path.join(dshPkg, 'lib', 'bin.js'), path.join(bin, 'dsh'))

  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` }
  delete env.DSH_COMPACTION_PKG
  delete env.KIX_DSH_PREFIX
  delete env.DSH_RUNTIME
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'context-budget', 'kix-compaction-cap-patch.mjs'), '--check'],
    { env, encoding: 'utf8' },
  )

  assert.notEqual(result.status, 0)
  assert.match(`${result.stderr}\n${result.stdout}`, /refusing to patch/)
  assert.equal(fs.readFileSync(decoy, 'utf8'), 'leave-me\n')
})

test('preset declarations carry the preset.yml description (0.2.0 roster source)', (t) => {
  // DSH >= 0.1.7 declares presets from the profile patch and never reads
  // preset.yml; without config.description the picker renders "No description."
  // (用户可见回归 2026-09-29). preset.yml stays the single source.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-desc-'))
  const previousHome = process.env.DSH_HOME
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  process.env.DSH_HOME = home
  for (const id of ['kixparadigm', 'kixparadigm-classic']) {
    const dir = path.join(home, '.agent-presets', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), '[]\n')
    fs.writeFileSync(path.join(dir, 'preset.yml'), `name: ${id}\ndescription: 描述 ${id}\n`)
  }

  const block = renderPresetPatchBlock()

  assert.match(block, /description: "描述 kixparadigm"/)
  assert.match(block, /description: "描述 kixparadigm-classic"/)
  // YAML 标量必须整体引号化：描述里的 `——`/`（）` 走 JSON string 是合法双引号标量
  assert.doesNotMatch(block, /description: 描述/)
})

test('a variant without preset.yml omits description instead of writing an empty one', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-nodesc-'))
  const previousHome = process.env.DSH_HOME
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  process.env.DSH_HOME = home
  for (const id of ['kixparadigm', 'kixparadigm-classic']) {
    const dir = path.join(home, '.agent-presets', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), '[]\n')
  }

  const block = renderPresetPatchBlock()

  assert.doesNotMatch(block, /description:/)
  assert.match(block, /id: kixparadigm-classic/)
})

test('upsertPresetBlock preserves foreign rows the settings layer left inside the markers', () => {
  // 出生证明（2026-09-29 实测）：dsh-settings 的一次性导入 + 配置编辑器会把用户行
  // 追加在尾注释之前，即 BEGIN..END 之间。整段替换会连它们一起删掉——本机被吞掉的
  // 是 llm-pi-ai providers / ui-theme / llm-deepseek / subagent-model-selection
  // 约 200 行，宿主重启后模型列表清空。此用例锁死「只换自有 insert 块，外来行移出标记区」。
  const block = [
    '# BEGIN kix-presets kixparadigm,kixparadigm-classic',
    '# DSH >= 0.1.7 does not scan .agent-presets/.',
    '- insert:',
    '    - id: preset-kixparadigm',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '# END kix-presets kixparadigm,kixparadigm-classic',
  ].join('\n')
  const before = [
    '- id: mcp-github',
    '  name: mcp-github',
    '# BEGIN kix-presets kixparadigm,kixparadigm-classic',
    '# DSH >= 0.1.7 does not scan .agent-presets/.',
    '- insert:',
    '    - id: preset-kixparadigm',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      zai-vision:',
    '        baseURL: https://example.invalid',
    '- id: subagent-model-selection',
    '  enabled: true',
    '# END kix-presets kixparadigm,kixparadigm-classic',
    '- id: tail-row',
  ].join('\n') + '\n'

  const first = upsertPresetBlock(before, block)

  assert.match(first.text, /id: llm-pi-ai/)
  assert.match(first.text, /zai-vision/)
  assert.match(first.text, /id: subagent-model-selection/)
  assert.match(first.text, /id: tail-row/)
  assert.match(first.text, /id: mcp-github/)
  const end = first.text.indexOf('# END kix-presets')
  assert.ok(first.text.indexOf('id: llm-pi-ai') > end, '外来行必须移出标记区，下一次 upsert 才不会再吃它们')
  assert.equal(upsertPresetBlock(first.text, block).changed, false, '第二次 upsert 必须幂等')
})

test('installPreset declares after the isolated 0.1.7 runtime is adapted', (t) => {
  const prefix = '/tmp/kix-dsh017'
  const registry = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh-agent-preset-registry', 'package.json')
  if (!fs.existsSync(registry)) {
    t.skip('isolated 0.1.7 runtime is not installed')
    return
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-adapted-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const patch = writeWebProfile(home)
  withInstallEnv(t, home, prefix)
  const live = '/usr/local/lib/dsh-0.1.5-rc.1/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'
  const before = fs.readFileSync(live)

  const installed = installPreset(silentLog)

  assert.equal(installed.kixRuntime.declared, true)
  assert.match(fs.readFileSync(patch, 'utf8'), /BEGIN kix-presets/)
  assert.match(fs.readFileSync(patch, 'utf8'), /cordis:include/)
  // 端到端：写进 profile 的声明必须带 description（GUI roster 的唯一来源）
  assert.match(fs.readFileSync(patch, 'utf8'), /description: "激励面/)
  assert.match(fs.readFileSync(patch, 'utf8'), /description: "经典模式/)
  const capped = fs.readFileSync(path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js'), 'utf8')
  assert.match(capped, /kix-cap-patch/)
  const session = spawnSync(process.execPath, ['scripts/patch-dsh-runtime.js', '--check', '--runtime', path.join(prefix, 'node_modules', '@deepseek-ai')], { encoding: 'utf8' })
  assert.equal(session.status, 0)
  assert.deepEqual(fs.readFileSync(live), before)
})

test('installPreset adapts a master workspace from the dsh package itself', (t) => {
  const dshPkg = '/tmp/kix-dsh-src/apps/cli'
  if (!fs.existsSync(path.join(dshPkg, 'package.json'))) {
    t.skip('master workspace build is not present')
    return
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-master-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const patch = writeWebProfile(home)
  withInstallEnv(t, home, dshPkg)
  const live = '/usr/local/lib/dsh-0.1.5-rc.1/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'
  const before = fs.readFileSync(live)
  const built = '/tmp/kix-dsh-src/packages/compaction/compaction-basic/lib/index.js'

  const installed = installPreset(silentLog)

  assert.equal(installed.kixRuntime.declared, true)
  assert.equal(installed.kixRuntime.prefix, dshPkg)
  assert.match(fs.readFileSync(patch, 'utf8'), /BEGIN kix-presets/)
  assert.match(fs.readFileSync(built, 'utf8'), /kix-cap-patch/)
  // preset 目录在 DSH_HOME，裸包名要靠这条链接才解析得到。
  assert.equal(installed.kixRuntime.resolutionRoot, path.join(dshPkg, 'node_modules'))
  // 断言「从 preset 目录解析」与「从 dsh 包解析」等价——这正是 cordis:include
  // 改掉 baseUrl 后丢掉的那条路径。pnpm 真实目录名与包名不同，故不比字面量。
  const fromPreset = require.resolve('@deepseek-ai/dsh-persona/package.json', {
    paths: [path.join(home, '.agent-presets', 'kixparadigm')],
  })
  const fromRuntime = require.resolve('@deepseek-ai/dsh-persona/package.json', { paths: [dshPkg] })
  assert.equal(fromPreset, fromRuntime)
  const session = spawnSync(process.execPath, ['scripts/patch-dsh-runtime.js', '--check', '--dsh', dshPkg], { encoding: 'utf8' })
  assert.equal(session.status, 0, session.stderr)
  assert.match(session.stdout, /dsh-session-format-v1-to-v2|applied\s+v1-migration/)
  assert.deepEqual(fs.readFileSync(live), before)
})

test('installPreset links preset resolution for a flat npm install', (t) => {
  const prefix = ['/tmp/kix-dsh020', '/tmp/kix-dsh017'].find((p) =>
    fs.existsSync(path.join(p, 'node_modules', '@deepseek-ai', 'dsh-persona', 'package.json')))
  if (!prefix) {
    t.skip('no flat npm dsh install is present')
    return
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-flat-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  writeWebProfile(home)
  withInstallEnv(t, home, prefix)

  const installed = installPreset(silentLog)

  assert.equal(installed.kixRuntime.declared, true)
  assert.equal(installed.kixRuntime.resolutionRoot, path.join(prefix, 'node_modules'))
  for (const id of ['kixparadigm', 'kixparadigm-classic']) {
    const link = path.join(home, '.agent-presets', id, 'node_modules')
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, `${id} 应有解析链接`)
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(prefix, 'node_modules')))
  }
  // 从 preset 目录真的解析得到裸包名——这正是 cordis:include 改 baseUrl 后失败的那一步。
  assert.equal(require.resolve('@deepseek-ai/dsh-persona/package.json', {
    paths: [path.join(home, '.agent-presets', 'kixparadigm')],
  }).startsWith(fs.realpathSync(path.join(prefix, 'node_modules'))), true)
  // 重跑把链接当自家条目，不当目标侧残留。
  const again = installPreset(silentLog)
  assert.equal(again.kixRuntime.declared, true)
  assert.equal(fs.lstatSync(path.join(home, '.agent-presets', 'kixparadigm', 'node_modules')).isSymbolicLink(), true)
  // 覆盖判据必须覆盖 preset 引用的**全部**裸包，不能只验 persona（后者恰好是根探针包）。
  assert.deepEqual(installed.kixRuntime.resolutionMissing, [], '解析根应覆盖 preset 引用的全部裸包')
})

test('stripPatchedHostConfigKeys 只裁宿主不认的那两个键，且不碰 kix 自己插件里的同名键', () => {
  // 出生证明（2026-09-29 桌面发行版实测）：dsh-compaction-basic 的 validateKeys 在构造器里
  // 跑 `unknown key` → throw，而该行属于 preset 组成 → 整份 preset 挂不上。0.2.0-rc.2 的
  // 键集合里没有 maxThresholdTokens / maxRetainTokens（本包 cap 补丁才加的两个字段）。
  const src = [
    '- id: compaction-basic',
    "  name: '@deepseek-ai/dsh-compaction-basic'",
    '  config:',
    '    thresholdRatio: 0.8',
    '    maxThresholdTokens: 200000',
    '    retainRatio: 0.044',
    '    maxRetainTokens: 64000',
    '    modelPolicies: []',
    '- id: kix-budget',
    '  name: ./plugins/kix-budget.js',
    '  config:',
    '    maxThresholdTokens: 123456',
  ].join('\n') + '\n'

  const out = stripPatchedHostConfigKeys(src)

  assert.deepEqual(out.dropped, ['dsh-compaction-basic.maxThresholdTokens', 'dsh-compaction-basic.maxRetainTokens'])
  assert.doesNotMatch(out.text, /^\s*maxThresholdTokens: 200000$/m)
  assert.doesNotMatch(out.text, /^\s*maxRetainTokens: 64000$/m)
  // ratio 是宿主原生键，必须原样保留（标定值不能被顺手抹掉）。
  assert.match(out.text, /thresholdRatio: 0\.8/)
  assert.match(out.text, /retainRatio: 0\.044/)
  assert.match(out.text, /modelPolicies: \[\]/)
  // kix 自己插件的同名键不属于宿主 schema，不能误删。
  assert.match(out.text, /maxThresholdTokens: 123456/)
  // 幂等：再跑一次是恒等变换，否则每次安装都会判成「已更新」。
  const again = stripPatchedHostConfigKeys(out.text)
  assert.deepEqual(again.dropped, [])
  assert.equal(again.text, out.text)
})

test('installPreset 在只读宿主（桌面发行版）上裁键，并保留仓库源文件不动', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kixparadigm-sealed-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  // sealed 判据 = $DSH_HOME/dsh-runtimes/<id>/runtime.json 的 desktopVersion。
  const runtimeDir = path.join(home, 'dsh-runtimes', 'dsh-primary-runtime')
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(path.join(runtimeDir, 'runtime.json'), JSON.stringify({ desktopVersion: '0.2.0-rc.2' }))
  writeWebProfile(home)
  const previousHome = process.env.DSH_HOME
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  process.env.DSH_HOME = home

  const installed = installPreset(silentLog)

  assert.equal(installed.kixRuntime.sealed, true)
  assert.equal(installed.kixRuntime.declared, true)
  for (const file of [
    path.join(home, '.agent-presets', 'kixparadigm', 'agent.cordis.yml'),
    path.join(home, 'profiles', 'kix-presets', 'kixparadigm', 'agent.cordis.yml'),
  ]) {
    assert.equal(fs.existsSync(file), true, `${file} 应存在`)
    const text = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /^\s*maxThresholdTokens:/m, `${file} 必须已裁掉 maxThresholdTokens`)
    assert.doesNotMatch(text, /^\s*maxRetainTokens:/m, `${file} 必须已裁掉 maxRetainTokens`)
  }
  // 仓库事实源不得被改写（安装器只写安装副本）。
  assert.match(fs.readFileSync(path.join('dsh', 'preset', 'agent.cordis.yml'), 'utf8'), /^\s*maxThresholdTokens: 200000$/m)
  // 重跑幂等：裁键走内容比较，不该每次都判成「已更新」。
  const again = installPreset(silentLog)
  for (const row of (Array.isArray(again) ? again : [again])) {
    assert.ok(!row.updated.includes('agent.cordis.yml'),
      `${row.variant.id} 的 agent.cordis.yml 不该被判成已更新（裁键必须按内容比较）`)
  }
})

test('presetResolutionRoot 取能解析最多裸包的那层，不被内嵌 persona 骗到', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-resroot-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const scope = path.join(root, 'node_modules', '@deepseek-ai')
  const write = (rel, name) => {
    const p = path.join(scope, rel, 'package.json')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, `{"name":"${name}"}\n`)
  }
  write('dsh', '@deepseek-ai/dsh')
  // 诱饵：npm 因版本冲突把 persona 嵌进 dsh 包内——只看 persona 会选中这一层。
  write(path.join('dsh', 'node_modules', '@deepseek-ai', 'dsh-persona'), '@deepseek-ai/dsh-persona')
  for (const name of ['dsh-persona', 'dsh-tool-web', 'dsh-agent-tool-presentation']) {
    write(name, `@deepseek-ai/${name}`)
  }
  const want = new Set(['dsh-persona', 'dsh-tool-web', 'dsh-agent-tool-presentation'])
  const picked = presetResolutionRoot({ dshDir: path.join(scope, 'dsh') }, want)
  assert.equal(picked.root, path.join(root, 'node_modules'))
  assert.deepEqual(picked.missing, [])
  // 旧判据会选中内嵌那层，并从那里缺 2 个包——这正是「声明照写、registry 再报 never started」的根因。
  assert.deepEqual(missingBarePackages(path.join(scope, 'dsh', 'node_modules'), want), ['dsh-tool-web', 'dsh-agent-tool-presentation'])
})

test('presetResolutionRoot 无任何 dsh-persona 时返回 null（触发中止而非写坏声明）', (t) => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-resroot-none-'))
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }))
  fs.mkdirSync(path.join(bare, 'node_modules'), { recursive: true })
  // stopAt 把向上查找截在临时树内：否则「用户家目录里装过一份 dsh」的机器会在家目录那层
  // 命中 @deepseek-ai/dsh-persona，这条判据在任何这样的机器上恒失败（本机实测 0.1.0-rc.6）。
  assert.equal(presetResolutionRoot({ dshDir: bare }, new Set(['dsh-persona']), bare), null)
})
