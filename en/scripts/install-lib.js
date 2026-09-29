#!/usr/bin/env node
'use strict'
// kixparadigm — 跨平台安装器（preset 同步 + vision-bridge 挂载 + 卸载/自检）
//
// 由 npm postinstall 自动调用（--quiet），也可手动执行：
//   kixparadigm install [--preset-only]   一键导入（preset + vision-bridge）
//   kixparadigm uninstall                 卸载本包安装的全部内容
//   kixparadigm doctor                    自检安装状态
//   kixparadigm copilot                   （可选）导入 VS Code Copilot 侧
//
// 目标目录遵循 DSH 约定：$DSH_HOME（默认 ~/.dsh）
//   preset        → $DSH_HOME/.agent-presets/kixparadigm/
//   vision-bridge → $DSH_HOME/profiles/web/plugins/dsh-vision-bridge/（junction 指向）

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')

const PKG_ROOT = path.join(__dirname, '..')
// 各语言包的安装目标由各自 package.json 的 "kixparadigm" 段声明：
//   { variants: [{ id, dir }, ...], bridgeDir } —— 缺省 = 中文主包行为
// 旧字段 presetId/presetDir 仍受支持（等价于单元素 variants）。
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'))
const CFG = PKG.kixparadigm || {}
const PRESET_ID = CFG.presetId || 'kixparadigm'
const PRESET_DIR = CFG.presetDir || 'dsh/preset'
const BRIDGE_DIR = CFG.bridgeDir || 'dsh/vision-bridge'
// 一个包可安装多个 preset 变体（默认模式 + 经典模式）。npm 1.3.0 只装了
// 第一个变体，导致用户反馈「发布的包没有经典模式」——变体必须逐一安装。
const PRESET_VARIANTS = (Array.isArray(CFG.variants) && CFG.variants.length
  ? CFG.variants
  : [{ id: PRESET_ID, dir: PRESET_DIR }])
  .map((v) => ({ id: String(v.id), dir: String(v.dir) }))
const BRIDGE_NAME = 'dsh-vision-bridge'
const PATCH_ID = 'dsh-vision-bridge'
const BRIDGE_PATCH_LINES = [
  '# ── dsh-vision-bridge（无缝识图，由 kixparadigm npm 包安装）──────────────',
  '# 主模型无视觉时：输入框粘贴/拖入图片 → 自动调 GLM-4.6V 转文本描述后提交。',
  '# 依赖 zai-vision provider 配置（settings.yaml 的 llm-pi-ai.providers.zai-vision）。',
  '- insert:',
  '    - id: dsh-vision-bridge',
  '      name: dsh-vision-bridge',
]

/**
 * Safely add the vision bridge to a DSH patch-list document.
 *
 * DSH initializes this file as the complete YAML value `[]`. Appending a
 * block-sequence item after that value creates a second YAML root and prevents
 * the profile from loading. Treat `[]` as an empty array to replace, repair the
 * exact legacy `[]` + block-list shape written by <=1.2.8, and only append to
 * a recognizable block-style top-level sequence.
 */
function mergeVisionBridgePatch(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const semantic = []
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]
    const trimmed = raw.trim()
    if (trimmed && !trimmed.startsWith('#')) semantic.push({ index, raw, trimmed })
  }

  const bridgePattern = new RegExp(`^\\s*- id:\\s*${PATCH_ID}\\s*$`, 'm')
  const hasBridge = bridgePattern.test(text)
  const renderBlock = () => BRIDGE_PATCH_LINES.join(newline)
  const appendBlock = (current) => {
    if (!current) return `${renderBlock()}${newline}`
    if (current.endsWith(`${newline}${newline}`)) return `${current}${renderBlock()}${newline}`
    if (current.endsWith(newline)) return `${current}${newline}${renderBlock()}${newline}`
    return `${current}${newline}${newline}${renderBlock()}${newline}`
  }
  const isBlockList = (entries) => {
    if (!entries.length || !/^-(?:\s|$)/.test(entries[0].raw)) return false
    return entries.every(({ raw, trimmed }) => {
      if (trimmed === '---' || trimmed === '...') return false
      return /^\s/.test(raw) || /^-(?:\s|$)/.test(raw)
    })
  }
  const invalidRoot = () => {
    throw new Error('cordis.patch.yml must contain one top-level YAML array; refusing to modify an unrecognized document')
  }

  if (semantic.length === 0) {
    return { text: appendBlock(text), changed: true }
  }

  if (semantic[0].trimmed === '[]') {
    if (semantic.length === 1) {
      const replacement = []
      if (semantic[0].index > 0 && lines[semantic[0].index - 1].trim() !== '') replacement.push('')
      replacement.push(...BRIDGE_PATCH_LINES)
      lines.splice(semantic[0].index, 1, ...replacement)
      const merged = lines.join(newline)
      return { text: merged.endsWith(newline) ? merged : `${merged}${newline}`, changed: true }
    }

    // Self-heal the exact malformed shape produced by the old byte-append:
    // one completed `[]` root followed by a block-style patch list.
    const legacyTail = semantic.slice(1)
    if (!isBlockList(legacyTail)) return invalidRoot()
    lines.splice(semantic[0].index, 1)
    const repaired = lines.join(newline)
    if (hasBridge) {
      return { text: repaired.endsWith(newline) ? repaired : `${repaired}${newline}`, changed: true }
    }
    return { text: appendBlock(repaired), changed: true }
  }

  if (!isBlockList(semantic)) return invalidRoot()
  if (hasBridge) return { text, changed: false }
  return { text: appendBlock(text), changed: true }
}

/** Keep cordis.patch.yml as a valid empty patch-list after removing our entry. */
function restoreEmptyPatchRoot(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const hasSemanticContent = text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim()
    return trimmed && !trimmed.startsWith('#')
  })
  if (hasSemanticContent) return text

  const comments = text.replace(/[\s\r\n]+$/, '')
  return comments ? `${comments}${newline}${newline}[]${newline}` : `[]${newline}`
}

const PRESET_PATCH_PROFILES = ['web', 'headless']
const PRESET_PATCH_BEGIN = `# BEGIN kix-presets ${PRESET_VARIANTS.map((v) => v.id).join(',')}`
const PRESET_PATCH_END = `# END kix-presets ${PRESET_VARIANTS.map((v) => v.id).join(',')}`
// preset 目录内的解析链接名：让裸包名 @deepseek-ai/* 从 preset 目录可见。
const PRESET_RESOLUTION_LINK = 'node_modules'

function loadRuntimeResolver() {
  const candidates = [
    path.join(__dirname, 'dsh-runtime-resolve.js'),
    path.join(__dirname, '..', '..', 'scripts', 'dsh-runtime-resolve.js'),
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  return found ? require(found).resolveRuntime : null
}

const resolveRuntime = loadRuntimeResolver()

function flatRuntime() {
  const fromEnv = process.env.KIX_DSH_PREFIX
  if (!fromEnv) return null
  const prefix = path.resolve(fromEnv)
  const dshDir = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
  if (!fs.existsSync(path.join(dshDir, 'package.json'))) return null
  const registry = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh-agent-preset-registry')
  const compaction = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic')
  return {
    dshDir,
    packages: {},
    registry: fs.existsSync(path.join(registry, 'package.json')) ? registry : null,
    compaction: fs.existsSync(path.join(compaction, 'package.json')) ? compaction : null,
    flatScope: path.join(prefix, 'node_modules', '@deepseek-ai'),
  }
}

function currentRuntime() {
  return resolveRuntime ? resolveRuntime() : flatRuntime()
}

function presetRegistryPackage() {
  const runtime = currentRuntime()
  return runtime && runtime.registry ? path.join(runtime.registry, 'package.json') : null
}

function findAdaptationScript(rel) {
  const candidates = [
    path.join(__dirname, rel),
    path.join(__dirname, '..', '..', 'scripts', rel),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

function ensureRuntimeAdapted(runtime, log) {
  const capScript = findAdaptationScript(path.join('context-budget', 'kix-compaction-cap-patch.mjs'))
  const sessionScript = findAdaptationScript('patch-dsh-runtime.js')
  if (!capScript || !sessionScript) {
    throw new Error(`找不到压缩/会话补丁脚本，拒绝把带 maxThresholdTokens 的 preset 声明写进 ${runtime.dshDir}。`)
  }
  if (!runtime.compaction) {
    throw new Error(`解析到 preset registry，但没有 dsh-compaction-basic：${runtime.dshDir}`)
  }
  const cap = spawnSync(process.execPath, [capScript, '--apply'], {
    env: { ...process.env, DSH_COMPACTION_PKG: runtime.compaction },
    encoding: 'utf8',
  })
  if (cap.status !== 0) {
    throw new Error(`压缩上限补丁失败 (${cap.status}): ${(cap.stderr || cap.stdout || '').trim()}`)
  }
  const sessionArgs = runtime.flatScope
    ? [sessionScript, '--runtime', runtime.flatScope]
    : [sessionScript, '--dsh', runtime.dshDir]
  const session = spawnSync(process.execPath, sessionArgs, { encoding: 'utf8' })
  if (session.status !== 0) {
    throw new Error(`会话补丁失败 (${session.status}): ${(session.stderr || session.stdout || '').trim()}`)
  }
  log.ok(`运行时补丁已落到 ${runtime.dshDir}`)
}

/**
 * node_modules 层：本运行时的 `@deepseek-ai/*` 从这里解析。
 *
 * 上游把 preset 放在这棵树里面，裸包名自然解析得到。`$DSH_HOME/.agent-presets/`
 * 在树外，而 `cordis:include` 会把模块解析基准改到 preset 目录，于是里面每条
 * `@deepseek-ai/*` 都导入失败，registry 把整棵树报成 "never started"；同一目录
 * 里的相对 `./plugins/*.js` 反而正常，因为那正是它相对解析的目录。
 * @returns `{ root, missing }`；`root` 为胜出的 node_modules，`missing` 是它解析不到的
 *   裸包名（空 = 全覆盖）。连 `dsh-persona` 都找不到任何一层时为 null。
 */
function presetResolutionRoot(runtime, names) {
  if (!runtime) return null
  const want = names && names.size ? names : new Set(['dsh-persona'])
  let dir = path.resolve(runtime.dshDir)
  let best = null
  // 「有几个裸包解析不到」最少的那层胜出，同分取最近的祖先。只查 dsh-persona
  // 会把「嵌在 dsh 包内的 persona 副本」当成解，而那层解析不到 preset 真正
  // 需要的其余包——声明照写、registry 再次整棵 never started（审查 P1 实锤）。
  for (let i = 0; i < 24; i++) {
    const nm = path.join(dir, 'node_modules')
    const missing = missingBarePackages(nm, want)
    if (missing.length === 0) return { root: nm, missing }
    if (!missing.includes('dsh-persona') && (best === null || missing.length < best.missing.length)) {
      best = { root: nm, missing }
    }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return best
}

/**
 * preset 在 `cordis:include` 重定基准后要解析的裸包名集合。
 *
 * 以 variant 的 `agent.cordis.yml` 为声明式事实源：插件目录里含测试夹具的假包名
 * （`@deepseek-ai/definitely-not-installed-xyz`），扫目录会误判。
 */
function presetBarePackages(variant) {
  const yml = path.join(dshHome(), '.agent-presets', variant.id, 'agent.cordis.yml')
  let text
  try { text = fs.readFileSync(yml, 'utf8') } catch { return new Set(['dsh-persona']) }
  const names = new Set()
  for (const m of text.matchAll(/@deepseek-ai\/([a-z0-9][a-z0-9-]*)/g)) names.add(m[1])
  if (names.size === 0) names.add('dsh-persona')
  return names
}

function missingBarePackages(root, names) {
  return [...names].filter((name) => !fs.existsSync(path.join(root, '@deepseek-ai', name, 'package.json')))
}

/** 把某份 preset 目录的模块解析指向本运行时的 node_modules 层。 */
function linkPresetResolution(dst, root, log) {
  const linkPath = path.join(dst, 'node_modules')
  const target = path.resolve(root)
  try {
    const st = fs.lstatSync(linkPath)
    if (!st.isSymbolicLink()) {
      throw new Error(`${linkPath} 是真实目录，拒绝替换；preset 内的 @deepseek-ai/* 会解析失败`)
    }
    let cur = null
    try { cur = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)) } catch { /* 重建 */ }
    if (cur === target) return
    fs.unlinkSync(linkPath)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  log.ok(`preset 解析链接: ${linkPath} -> ${target}`)
}

function adaptRuntimeForPreset(log) {
  const runtime = currentRuntime()
  if (!runtime) {
    log.warn('解析不到 dsh 运行时（KIX_DSH_PREFIX 未设，或指的不是安装根 / dsh 包目录 / lib/bin.js）。只保留目录副本；未写 profile 声明——0.1.7+ 不写声明 preset 不会出现在模式列表。')
    return { declared: false, reason: 'no-registry', prefix: null }
  }
  if (!runtime.registry) {
    log.info('当前 dsh 没有 dsh-agent-preset-registry（0.1.5）。只保留目录副本；profile 声明未写。要挂到 0.1.7/master，设置 KIX_DSH_PREFIX 为安装根、dsh 包目录或 lib/bin.js 后重跑 install。')
    return { declared: false, reason: 'no-registry', prefix: runtime.dshDir }
  }
  ensureRuntimeAdapted(runtime, log)
  // 声明只在 preset 真能加载时写：解析链接缺失时 registry 会整棵报 never started。
  const want = new Set()
  for (const variant of PRESET_VARIANTS) {
    for (const name of presetBarePackages(variant)) want.add(name)
  }
  const resolved = presetResolutionRoot(runtime, want)
  if (!resolved) {
    throw new Error(`在 ${runtime.dshDir} 之上找不到含 @deepseek-ai/* 的 node_modules，拒绝写出会 never started 的 preset 声明。`)
  }
  const root = resolved.root
  if (resolved.missing.length) {
    // 不中止：缺的包可能是该 DSH 版本本就没有的可选件，中止会让整个安装不可用。
    log.warn(`解析根 ${root} 里找不到 ${resolved.missing.length} 个 preset 引用的包：${resolved.missing.join(', ')}。这些插件在会话里会加载失败，其余照常。`)
  }
  for (const variant of PRESET_VARIANTS) {
    linkPresetResolution(path.join(dshHome(), '.agent-presets', variant.id), root, log)
  }
  const wrote = installPresetDeclarations(log)
  return {
    declared: wrote > 0,
    reason: wrote > 0 ? 'declared' : 'no-profile',
    prefix: runtime.dshDir,
    resolutionRoot: root,
    resolutionMissing: resolved.missing,
  }
}

/**
 * Roster description for one installed preset.
 *
 * DSH >= 0.1.7 declares presets from the profile patch and never reads
 * `preset.yml`, so the picker falls back to "No description." unless the
 * declaration carries one. `preset.yml` stays the single source: read it from
 * the copied preset directory and carry the value into the patch row.
 */
function presetDescription(presetDir) {
  let text
  try {
    text = fs.readFileSync(path.join(presetDir, 'preset.yml'), 'utf8')
  } catch {
    return null
  }
  const line = text.split(/\r?\n/).find((candidate) => /^description\s*:/.test(candidate.trim()))
  if (line === undefined) return null
  let value = line.trim().replace(/^description\s*:\s*/, '').trim()
  if (value.length === 0) return null
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  return value.length > 0 ? value : null
}

function renderPresetPatchBlock() {
  const rows = []
  for (const variant of PRESET_VARIANTS) {
    const presetDir = path.join(dshHome(), '.agent-presets', variant.id)
    const yml = path.join(presetDir, 'agent.cordis.yml')
    const description = presetDescription(presetDir)
    rows.push(
      `    - id: preset-${variant.id}`,
      `      name: '@deepseek-ai/dsh-agent-preset'`,
      '      config:',
      `        id: ${variant.id}`,
      `        name: ${variant.id}`,
      ...(description === null ? [] : [`        description: ${JSON.stringify(description)}`]),
      '        plugins:',
      `          - id: ${variant.id}-body`,
      '            name: cordis:include',
      '            config:',
      `              path: ${JSON.stringify(pathToFileURL(yml).href)}`,
    )
  }
  return [
    PRESET_PATCH_BEGIN,
    '# DSH >= 0.1.7 does not scan .agent-presets/. cordis:include points baseUrl',
    '# back at the copied preset directory so ./plugins and skills/ still resolve.',
    '- insert:',
    ...rows,
    PRESET_PATCH_END,
  ].join('\n')
}

/**
 * Split the text between the kix preset markers into our own insert block and
 * anything the host's settings layer left there.
 *
 * `dsh-settings` imports the removed `settings.yaml` into the active profile and
 * the configuration editor keeps appending those rows *before* the trailing
 * comment block — which lands them between BEGIN and END. Replacing the whole
 * marked region would delete them (2026-09-29: the imported `llm-pi-ai`
 * providers, `ui-theme`, `llm-deepseek` and `subagent-model-selection` rows,
 * ~200 lines, were swallowed; after the next host restart the model list was
 * empty). Only our own `- insert:` list is ours to rewrite; foreign rows are
 * preserved verbatim.
 *
 * @param {string} region text after the BEGIN marker and before the END marker
 * @returns {{ own: string[], foreign: string[] }} classified lines
 */
function splitMarkerRegion(region) {
  const own = []
  const foreign = []
  let inOwnInsert = false
  let seenForeign = false
  for (const line of region.split('\n')) {
    if (seenForeign) {
      foreign.push(line)
      continue
    }
    if (!inOwnInsert) {
      if (line.trim() === '' || /^\s*#/.test(line)) {
        own.push(line)
        continue
      }
      if (/^- insert:\s*$/.test(line)) {
        own.push(line)
        inOwnInsert = true
        continue
      }
      seenForeign = true
      foreign.push(line)
      continue
    }
    // Our insert list is a sequence of indented rows; the first column-0 line
    // that is neither blank nor a comment ends it and starts the foreign part.
    if (line.trim() === '' || /^\s/.test(line)) {
      own.push(line)
      continue
    }
    inOwnInsert = false
    seenForeign = true
    foreign.push(line)
  }
  return { own, foreign }
}

function upsertPresetBlock(text, block) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const rendered = `${block.replace(/\n/g, newline).trimEnd()}${newline}`
  const start = text.indexOf(PRESET_PATCH_BEGIN)
  const stop = text.indexOf(PRESET_PATCH_END)
  if (start !== -1 || stop !== -1) {
    if (start === -1 || stop < start) throw new Error('kix preset markers are missing or out of order')
    const after = stop + PRESET_PATCH_END.length
    const tail = text.slice(after).replace(/^\r?\n/, '')
    const { foreign } = splitMarkerRegion(text.slice(start + PRESET_PATCH_BEGIN.length, stop))
    // Foreign rows move outside the markers so the next upsert cannot see them
    // as part of our region. Their relative order is preserved.
    const foreignText = foreign.join('\n').replace(/\s+$/, '')
    const body = foreignText.length === 0 ? rendered : `${rendered}${foreignText}${newline}`
    const next = `${text.slice(0, start)}${body}${tail}`
    const foreignCount = foreign.filter((line) => /^- /.test(line)).length
    return { text: next.endsWith(newline) ? next : `${next}${newline}`, changed: next !== text, foreignCount }
  }
  if (text.trim() === '' || text.trim() === '[]') {
    return { text: rendered, changed: true, foreignCount: 0 }
  }
  const lines = text.split(/\r?\n/)
  const semantic = lines.filter((line) => {
    const trimmed = line.trim()
    return trimmed && !trimmed.startsWith('#')
  })
  if (semantic.length === 1 && semantic[0].trim() === '[]') {
    const index = lines.findIndex((line) => line.trim() === '[]')
    lines.splice(index, 1, ...rendered.trimEnd().split(/\r?\n/))
    const next = lines.join(newline)
    return { text: next.endsWith(newline) ? next : `${next}${newline}`, changed: true, foreignCount: 0 }
  }
  if (semantic.some((line) => line.trim() === '---' || line.trim() === '...')) {
    throw new Error('cordis.patch.yml must contain one top-level YAML array; refusing to modify an unrecognized document')
  }
  if (semantic.length > 0 && !semantic.every((line) => /^\s*-/.test(line) || /^\s/.test(line))) {
    throw new Error('cordis.patch.yml must contain one top-level YAML array; refusing to modify an unrecognized document')
  }
  const sep = text.endsWith(newline) ? newline : `${newline}${newline}`
  const next = `${text.trimEnd()}${sep}${rendered}`
  return { text: next.endsWith(newline) ? next : `${next}${newline}`, changed: true }
}

function installPresetDeclarations(log) {
  if (!presetRegistryPackage()) {
    log.info('未找到带 dsh-agent-preset-registry 的 dsh。只保留目录副本；profile 声明未写。')
    return 0
  }
  const block = renderPresetPatchBlock()
  let wrote = 0
  for (const name of PRESET_PATCH_PROFILES) {
    const dir = path.join(dshHome(), 'profiles', name)
    const manifestPath = path.join(dir, 'package.json')
    if (!fs.existsSync(manifestPath)) {
      log.warn(`profile ${name} 尚未初始化，跳过声明。先运行一次该 profile，再执行 kixparadigm install`)
      continue
    }
    const bundles = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))?.dsh?.profile?.bundles ?? []
    if (!bundles.includes('@deepseek-ai/dsh-web-app') && !bundles.includes('@deepseek-ai/dsh-agent-preset-registry')) {
      log.info(`profile ${name} 没有 agent preset registry，跳过声明`)
      continue
    }
    const patch = path.join(dir, 'cordis.patch.yml')
    const current = fs.existsSync(patch) ? fs.readFileSync(patch, 'utf8') : '[]\n'
    const merged = upsertPresetBlock(current, block)
    if (!fs.existsSync(patch) || merged.changed) fs.writeFileSync(patch, merged.text, 'utf8')
    if (merged.foreignCount > 0) {
      log.warn(`${patch} 的标记区里有 ${merged.foreignCount} 条非 kix 行（宿主设置层导入的配置），已原样移出标记区，未删除`)
    }
    log.ok(`preset 声明已写入 ${patch}`)
    wrote += 1
  }
  return wrote
}

function removePresetDeclarations(log) {
  const home = dshHome()
  for (const name of PRESET_PATCH_PROFILES) {
    const patch = path.join(home, 'profiles', name, 'cordis.patch.yml')
    if (!fs.existsSync(patch)) continue
    const text = fs.readFileSync(patch, 'utf8')
    const start = text.indexOf(PRESET_PATCH_BEGIN)
    const stop = text.indexOf(PRESET_PATCH_END)
    if (start === -1 || stop < start) continue
    const after = stop + PRESET_PATCH_END.length
    // 与 upsert 同源：标记区里可能有宿主设置层导入的用户行，卸载只移除 kix 声明，
    // 不替用户删配置（2026-09-29 吞掉 llm-pi-ai providers 的同型事故）。
    const { foreign } = splitMarkerRegion(text.slice(start + PRESET_PATCH_BEGIN.length, stop))
    const foreignText = foreign.join('\n').replace(/\s+$/, '')
    const kept = foreignText.length === 0 ? '' : `${foreignText}\n`
    const rest = `${text.slice(0, start)}${kept}${text.slice(after)}`.replace(/\n{3,}/g, '\n\n')
    fs.writeFileSync(patch, restoreEmptyPatchRoot(rest), 'utf8')
    log.ok(`已从 ${patch} 移除 preset 声明`)
  }
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * 中英双包共享同一个 vision-bridge 时，卸载其一不得删除共享组件。
 * 只要另一个已知 preset 仍安装在目标 DSH_HOME 中，就保留 bridge 目录、
 * node_modules 链接与 cordis.patch.yml 挂载条目。
 * removed 可以是单个 id 或本次卸载的 id 数组（多变体包一次卸全）。
 */
// v1.3.1：补 kixparadigm-classic-en（v1.3.0 重命名后 en 的真实安装 id）——
// 缺它时 zh 侧卸载会把仅剩 en-classic-en 在装的场景误判为「无其他 owner」
// 而删除共享 vision-bridge。保留旧名 kixparadigm-en 兼容改名前的老安装。
const KNOWN_PRESET_IDS = ['kixparadigm', 'kixparadigm-classic', 'kixparadigm-en', 'kixparadigm-classic-en', 'kixparadigm-null']
function hasOtherPresetOwner(home, removed) {
  const removedSet = new Set(Array.isArray(removed) ? removed : [removed])
  for (const id of KNOWN_PRESET_IDS) {
    if (removedSet.has(id)) continue
    if (fs.existsSync(path.join(home, '.agent-presets', id, 'agent.cordis.yml'))) return true
  }
  return false
}

function makeLog(quiet) {
  return {
    info(msg) { if (!quiet) console.log(`  ${msg}`) },
    ok(msg) { if (!quiet) console.log(`  ✔ ${msg}`) },
    warn(msg) { console.log(`  ⚠ ${msg}`) },
    step(msg) { if (!quiet) console.log(`\n==> ${msg}`) },
  }
}

/** If `p` is a directory, a symlink-to-dir, or a git symlink-file pointing at a
 *  directory, return the real directory path to walk; otherwise null. */
function resolveLinkedDir(p, entry) {
  try {
    if (entry && entry.isDirectory()) return p
    if (entry && entry.isSymbolicLink()) {
      const st = fs.statSync(p)
      return st.isDirectory() ? p : null
    }
    const st = fs.lstatSync(p)
    if (st.isDirectory()) return p
    if (st.isSymbolicLink()) {
      const rst = fs.statSync(p)
      return rst.isDirectory() ? p : null
    }
    if (!st.isFile() || st.size > 256) return null
    const body = fs.readFileSync(p, 'utf8').trim()
    if (!body || /[\n\0]/.test(body) || path.isAbsolute(body)) return null
    const target = path.resolve(path.dirname(p), body)
    return fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : null
  } catch {
    return null
  }
}

/** 复制文件并保留源 mtime——否则 copyFileSync 会刷新目标 mtime，使
 *  「size+mtime 相同即跳过」的幂等判断永远失效（每次安装都全量重写）。 */
function copyFileKeepingMtime(s, d) {
  fs.copyFileSync(s, d)
  try {
    const st = fs.statSync(s)
    fs.utimesSync(d, st.atime, st.mtime)
  } catch {
    /* 平台不支持 utimes 时退化为普通复制（仅多一次写入） */
  }
}

/** 镜像复制 src → dst：同名同尺寸同 mtime 跳过。
 *  目标独有文件默认只报告不删除；**例外**：指针条目（symlink/文本指针指向的目录）
 *  是镜像，其源侧已删除的残留会被裁剪（见 pruneMirror）。 */
function copyTree(src, dst, log, opts = {}) {
  const added = [], updated = [], same = [], targetOnly = [], pruned = []
  const walk = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, entry.name)
      const d = path.join(to, entry.name)
      // Dirent.isDirectory() is false for a symlink-to-dir. Follow it so
      // preset skills/ (repo-relative link to classic) installs as a real tree.
      // Windows git with core.symlinks=false checks the link out as a text
      // file whose contents are the relative target — treat that as a dir too.
      // 只有**指针条目**（symlink 目录 / git symlink 检出的文本指针）才是镜像：
      // 其内容必须与源一致，源侧删除后目标侧残留一并清掉。
      // 普通目录（memories/、plugins/ 等）**绝不裁剪**——安装副本里可能有
      // 运行期产物（kix-mem 的经验库就写在安装副本 memories/ 下）与部署脚本
      // 投放的文件；把它们当残留删除是数据丢失。
      const isPointerEntry = !entry.isDirectory()
      const followDir = resolveLinkedDir(s, entry)
      if (followDir) {
        fs.mkdirSync(d, { recursive: true })
        walk(followDir, d)
        if (isPointerEntry) pruneMirror(followDir, d)
      } else {
        if (!fs.existsSync(d)) {
          copyFileKeepingMtime(s, d)
          added.push(path.relative(src, s))
        } else {
          const a = fs.statSync(s), b = fs.statSync(d)
          // utimes 只有秒级精度，mtimeMs 的亚毫秒差会让幂等判断永远不成立。
          if (a.size === b.size && Math.round(a.mtimeMs / 1000) === Math.round(b.mtimeMs / 1000)) same.push(path.relative(src, s))
          else { copyFileKeepingMtime(s, d); updated.push(path.relative(src, s)) }
        }
      }
    }
  }
  const pruneMirror = (from, to) => {
    if (!fs.existsSync(to)) return
    for (const entry of fs.readdirSync(to, { withFileTypes: true })) {
      const t = path.join(to, entry.name)
      const s = path.join(from, entry.name)
      if (!fs.existsSync(s)) {
        fs.rmSync(t, { recursive: true, force: true })
        pruned.push(path.relative(dst, t) + (entry.isDirectory() ? '/' : ''))
      } else if (entry.isDirectory()) {
        pruneMirror(s, t)
      }
    }
  }
  fs.mkdirSync(dst, { recursive: true })
  walk(src, dst)
  if (fs.existsSync(dst)) {
    const walk2 = (from, rel) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const s = path.join(from, entry.name)
        const r = rel ? `${rel}/${entry.name}` : entry.name
        const srcP = path.join(src, r)
        if (entry.isDirectory()) {
          if (!fs.existsSync(srcP)) targetOnly.push(r + '/')
          // 指针目录是镜像：内容由 pruneMirror 负责，不当作「目标侧独有」噪声。
          else if (!fs.lstatSync(srcP).isDirectory() && resolveLinkedDir(srcP)) continue
          else walk2(s, r)
        } else if (!fs.existsSync(srcP)) {
          // preset 解析链接由本安装器建立，不是目标侧残留。
          if (!(opts.ignoreTargetOnly && opts.ignoreTargetOnly.has(r))) targetOnly.push(r)
        }
      }
    }
    walk2(dst, '')
  }
  // opts.mirror：整树按源镜像——货架物化路径（ensureDefaultShelf）用它，
  // 使「源侧删除」在货架自身也成立，而不只依赖 installPreset 的指针条目分支。
  if (opts.mirror) pruneMirror(src, dst)
  return { added, updated, same, targetOnly, pruned }
}

/** 默认档共享货架：仓库里是指向 classic 的指针（git symlink；Windows
 *  core.symlinks=false 时检出为含相对路径的文本文件，copyTree 的
 *  resolveLinkedDir 已跟随）。npm pack 会丢掉 symlink 条目，此时按此表
 *  从 classic 物化到 DSH_HOME——只写安装副本，绝不改打包源树。
 *  agents/ 与 skills/ 同源同理：货架内的相对链接（../../agents/*.agent.md）
 *  只有在货架被物化后才可达。 */
const DEFAULT_SHELF_DIRS = ['skills', 'agents']
const DEFAULT_SHELF_MARKERS = {
  skills: path.join('handoff', 'SKILL.md'),
  agents: 'kixparadigm.agent.md',
}

function ensureDefaultShelf(dirName, dst, log) {
  const dest = path.join(dst, dirName)
  const classic = path.join(PKG_ROOT, 'dsh/preset-classic', dirName)
  const marker = DEFAULT_SHELF_MARKERS[dirName]
  if (!marker || !fs.existsSync(path.join(classic, marker))) return null
  const missing = !fs.existsSync(path.join(dest, marker))
  // 目标侧可能残留同名指针文件（Windows 检出形态），先清掉再建树。
  if (missing && fs.existsSync(dest) && !fs.statSync(dest).isDirectory()) fs.rmSync(dest, { force: true })
  if (missing && log && log.warn) log.warn(`packed preset has no ${dirName} shelf; materializing from kixparadigm-classic`)
  // 已存在也走一次镜像同步：源侧删除/新增必须反映到安装副本。
  // 早退（marker 存在即 return null）会让 packed 路径（包里没有指针条目时）
  // 的货架**永不重同步**——上游删除的陈旧文件永久留在运行时。
  return copyTree(classic, dest, log, { mirror: true })
}

function ensureDefaultSkillsShelf(dst, log) {
  return ensureDefaultShelf('skills', dst, log)
}

function installPreset(log) {
  const results = []
  for (const variant of PRESET_VARIANTS) {
    const src = path.join(PKG_ROOT, variant.dir)
    const dst = path.join(dshHome(), '.agent-presets', variant.id)
    if (!fs.existsSync(path.join(src, 'agent.cordis.yml'))) {
      throw new Error(`preset 源目录缺失或不含 agent.cordis.yml: ${src}`)
    }
    log.step(`安装 preset ${variant.id} → ${dst}`)
    const r = copyTree(src, dst, log, { ignoreTargetOnly: new Set([PRESET_RESOLUTION_LINK]) })
    if (variant.id === 'kixparadigm') {
      for (const dirName of DEFAULT_SHELF_DIRS) {
        const extra = ensureDefaultShelf(dirName, dst, log)
        if (extra) {
          r.added.push(...extra.added.map((p) => path.join(dirName, p)))
          r.updated.push(...extra.updated.map((p) => path.join(dirName, p)))
        }
      }
    }
    log.ok(`preset ${variant.id}：新增 ${r.added.length} / 更新 ${r.updated.length} / 相同 ${r.same.length}`)
    if (r.pruned.length) {
      log.warn(`镜像裁剪 ${r.pruned.length} 个源侧已删除的残留（指针目录是镜像，非普通目标）`)
      if (!process.env.KIX_VERBOSE) log.warn(`  ${r.pruned.slice(0, 5).join(', ')}${r.pruned.length > 5 ? ' …' : ''}`)
    }
    if (r.targetOnly.length) {
      log.warn(`目标侧独有 ${r.targetOnly.length} 个文件（保留未删，如需清理请人工确认）`)
      if (!process.env.KIX_VERBOSE) log.warn(`  ${r.targetOnly.slice(0, 5).join(', ')}${r.targetOnly.length > 5 ? ' …' : ''}`)
    }
    results.push({ variant, ...r })
  }
  const runtime = adaptRuntimeForPreset(log)
  const out = results.length === 1 ? results[0] : results
  out.kixRuntime = runtime
  return out
}

/** 建立/修复 node_modules 链接（Windows junction，POSIX symlink）。 */
function ensureLink(linkPath, targetPath, log) {
  const target = path.resolve(targetPath)
  const isLink = (p) => {
    try { return fs.lstatSync(p).isSymbolicLink() } catch { return false }
  }
  if (fs.existsSync(linkPath)) {
    if (isLink(linkPath)) {
      let cur = null
      try { cur = path.resolve(fs.readlinkSync(linkPath)) } catch { /* ignore */ }
      if (cur === target) { log.ok(`链接正确: ${linkPath}`); return true }
      log.warn(`链接指向错误（${cur}），重建`)
      fs.unlinkSync(linkPath)
    } else {
      // 真实目录：仅当它是本插件副本时才替换，否则跳过
      const pkg = path.join(linkPath, 'package.json')
      if (fs.existsSync(pkg)) {
        let name = null
        try { name = JSON.parse(fs.readFileSync(pkg, 'utf8')).name } catch { /* ignore */ }
        if (name === BRIDGE_NAME) { fs.rmSync(linkPath, { recursive: true, force: true }) }
        else { log.warn(`node_modules/${BRIDGE_NAME} 是非本插件的真实目录，跳过替换`); return false }
      } else {
        log.warn(`node_modules/${BRIDGE_NAME} 是未知目录，跳过替换`)
        return false
      }
    }
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  if (process.platform === 'win32') fs.symlinkSync(target, linkPath, 'junction')
  else fs.symlinkSync(target, linkPath, 'dir')
  log.ok(`已建立链接: ${linkPath} -> ${target}`)
  return true
}

/** vision-bridge 挂载：插件文件 + node_modules 链接 + cordis.patch.yml 条目。 */
function installVisionBridge(log) {
  const home = dshHome()
  const profile = path.join(home, 'profiles', 'web')
  const source = path.join(profile, 'plugins', 'dsh-vision-bridge')
  const junction = path.join(profile, 'node_modules', 'dsh-vision-bridge')
  const bridgeSource = path.join(PKG_ROOT, BRIDGE_DIR)
  const patch = path.join(profile, 'cordis.patch.yml')

  if (!fs.existsSync(bridgeSource)) {
    log.warn('本包不含 vision-bridge 源码，跳过')
    return
  }

  // Validate and compose the patch before copying files or creating links. An
  // invalid user document must fail without leaving a partial installation.
  const existed = fs.existsSync(patch)
  const current = existed ? fs.readFileSync(patch, 'utf8') : ''
  const merged = mergeVisionBridgePatch(current)

  log.step(`安装 vision-bridge → ${source}`)
  copyTree(bridgeSource, source, log)

  const pkg = JSON.parse(fs.readFileSync(path.join(bridgeSource, 'package.json'), 'utf8'))
  if (!pkg.exports || !pkg.exports['./package.json']) {
    log.warn('package.json exports 缺 ./package.json（client 半将无法注册），请检查源码')
  }

  log.step('建立加载链接（loader require.resolve 路径）')
  ensureLink(junction, source, log)

  log.step('登记 cordis.patch.yml 挂载条目')
  if (!existed) fs.mkdirSync(path.dirname(patch), { recursive: true })
  if (merged.changed) fs.writeFileSync(patch, merged.text, 'utf8')
  if (!existed) {
    log.ok(`已创建 ${patch}`)
  } else if (merged.changed) {
    log.ok('已安全合并挂载条目')
  } else {
    log.ok('挂载条目已存在')
  }
}

function reportSettingsChecklist(log) {
  log.step('settings.yaml 检查（preset 装不进去，需人工确认）')
  const home = dshHome()
  const settings = path.join(home, 'settings.yaml')
  // DSH >= 0.2.0 在启动时把 settings.yaml 导入当前 profile，并把原文件改名为
  // `.imported`；0.1.x 仍读根目录。checked 的是「provider 名字出现在哪」，
  // 所以两代位置都算，只看根文件会在 0.2.0 上误报未配置。
  const sources = []
  for (const candidate of [settings, path.join(home, 'settings.yaml.imported')]) {
    if (fs.existsSync(candidate)) sources.push(candidate)
  }
  const profiles = path.join(home, 'profiles')
  if (fs.existsSync(profiles)) {
    for (const name of fs.readdirSync(profiles)) {
      const patch = path.join(profiles, name, 'cordis.patch.yml')
      if (fs.existsSync(patch)) sources.push(patch)
    }
  }
  if (sources.length === 0) {
    log.warn(`settings.yaml 不存在（${settings}）`)
    log.warn('请按 dsh/preset-classic/DSH-ADAPTATION.md 的 settings.yaml 段补配置（zai-vision 视觉 provider + zai-coding-cn 跨厂商观察者）')
    return
  }
  // 安装器自己写进 profile 的 bridge 注释里就有 "zai-vision" 字面量（BRIDGE_PATCH_LINES），
  // 不剔注释这条门禁恒真，还会让「settings.yaml 不存在」的告警不可达。
  const text = sources
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  let ok = true
  for (const name of ['zai-vision', 'zai-coding-cn']) {
    if (new RegExp(`\\b${name}\\b`).test(text)) log.ok(`llm-pi-ai.providers.${name} 已配置`)
    else { log.warn(`缺少 provider: ${name}`); ok = false }
  }
  if (!ok) {
    log.warn('请按 dsh/preset-classic/DSH-ADAPTATION.md 的 settings.yaml 段补配置（zai-vision 视觉 provider + zai-coding-cn 跨厂商观察者）')
  }
}

function uninstall(log) {
  const home = dshHome()
  const presetIds = PRESET_VARIANTS.map((v) => v.id)
  const source = path.join(home, 'profiles', 'web', 'plugins', BRIDGE_NAME)
  const junction = path.join(home, 'profiles', 'web', 'node_modules', BRIDGE_NAME)
  const patch = path.join(home, 'profiles', 'web', 'cordis.patch.yml')

  log.step(`卸载 ${presetIds.join(' + ')} 安装内容`)
  removePresetDeclarations(log)
  const keepSharedBridge = hasOtherPresetOwner(home, presetIds)
  if (keepSharedBridge) {
    log.info('检测到另一 kix preset 仍安装，vision-bridge 为共享组件，本次保留')
  }
  for (const id of presetIds) {
    const preset = path.join(home, '.agent-presets', id)
    if (fs.existsSync(preset)) { fs.rmSync(preset, { recursive: true, force: true }); log.ok(`已删除 preset: ${preset}`) }
    else log.info(`preset ${id} 不存在，跳过`)
  }
  if (keepSharedBridge) {
    log.info('共享 vision-bridge 与挂载条目已保留')
  } else {
    if (fs.existsSync(junction)) {
      try {
        const st = fs.lstatSync(junction)
        if (st.isSymbolicLink()) fs.unlinkSync(junction)
        else fs.rmSync(junction, { recursive: true, force: true })
        log.ok(`已删除链接: ${junction}`)
      } catch (e) { log.warn(`删除链接失败: ${e.message}`) }
    }
    if (fs.existsSync(source)) { fs.rmSync(source, { recursive: true, force: true }); log.ok(`已删除插件: ${source}`) }
  }
  if (!keepSharedBridge && fs.existsSync(patch)) {
    const lines = fs.readFileSync(patch, 'utf8').split('\n')
    const idx = lines.findIndex((l) => l.trim() === `- id: ${PATCH_ID}`)
    if (idx >= 0) {
      // 块 = [注释头] + [- insert: 行] + [id 行] + [name 行]（+ 紧随的一个空行）
      let start = idx
      while (start > 0 && lines[start - 1].trim() === '- insert:') start--
      let c = start - 1
      while (c >= 0 && /^\s*#/.test(lines[c])) c-- // 注释头向上到空行/非注释为止（区块间有空行分隔）
      start = c + 1
      let end = idx + 2 // id + name 两行
      if (lines[end] !== undefined && lines[end].trim() === '') end++
      const rest = [...lines.slice(0, start), ...lines.slice(end)].join('\n')
        .replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
      fs.writeFileSync(patch, restoreEmptyPatchRoot(rest), 'utf8')
      log.ok(`已从 ${patch} 移除挂载条目`)
    } else log.info('挂载条目不存在，跳过')
  }
  log.ok('卸载完成。重启 dsh web 后生效。')
}

function doctor(log) {
  const home = dshHome()
  log.step(`doctor — DSH_HOME = ${home}`)
  let allOk = true
  const preset = path.join(home, '.agent-presets', PRESET_VARIANTS[0].id)
  for (const variant of PRESET_VARIANTS) {
    if (fs.existsSync(path.join(home, '.agent-presets', variant.id, 'agent.cordis.yml'))) {
      log.ok(`preset ${variant.id} 已安装（agent.cordis.yml 存在）`)
    } else {
      log.warn(`preset ${variant.id} 未安装或缺失 agent.cordis.yml`)
      allOk = false
    }
  }
  const runtime = currentRuntime()
  if (!runtime || !runtime.registry) {
    log.info('当前 dsh 没有 agent preset registry。目录副本不会被自动挂载；这在 0.1.5 上是预期。')
  } else {
    const index = runtime.compaction && path.join(runtime.compaction, 'lib', 'index.js')
    const capped = index && fs.existsSync(index) && fs.readFileSync(index, 'utf8').includes('kix-cap-patch')
    if (capped) log.ok(`compaction cap patch 在 ${runtime.compaction}`)
    else { log.warn(`目标运行时未打 cap patch：${runtime.dshDir}`); allOk = false }
    const webPatch = path.join(home, 'profiles', 'web', 'cordis.patch.yml')
    const declared = fs.existsSync(webPatch) && fs.readFileSync(webPatch, 'utf8').includes(PRESET_PATCH_BEGIN)
    if (declared) log.ok('web profile 含本包 preset 声明')
    else { log.warn('web profile 没有本包 preset 声明（0.1.7 不会扫描目录）'); allOk = false }
    const want = new Set()
    for (const variant of PRESET_VARIANTS) {
      for (const name of presetBarePackages(variant)) want.add(name)
    }
    const resolved = presetResolutionRoot(runtime, want)
    const root = resolved && resolved.root
    for (const variant of PRESET_VARIANTS) {
      const link = path.join(home, '.agent-presets', variant.id, PRESET_RESOLUTION_LINK)
      let cur = null
      try {
        if (fs.lstatSync(link).isSymbolicLink()) cur = path.resolve(path.dirname(link), fs.readlinkSync(link))
      } catch { /* 缺失或不可读都按未链接处理 */ }
      if (!root || cur !== root) {
        log.warn(`preset ${variant.id} 缺少解析链接（${link} -> ${root || '未找到 node_modules'}）；registry 会报 never started`)
        allOk = false
      }
    }
    if (root) {
      log.ok(`preset 解析链接指向 ${root}`)
      if (resolved.missing.length) {
        log.warn(`该根解析不到 ${resolved.missing.length} 个 preset 引用的包：${resolved.missing.join(', ')}；对应插件在会话里会加载失败`)
        allOk = false
      }
    }
  }

  const source = path.join(home, 'profiles', 'web', 'plugins', BRIDGE_NAME)
  const junction = path.join(home, 'profiles', 'web', 'node_modules', BRIDGE_NAME)
  if (fs.existsSync(path.join(source, 'package.json'))) {
    log.ok('vision-bridge 插件文件就位')
    ensureLink(junction, source, log)
    const patch = path.join(home, 'profiles', 'web', 'cordis.patch.yml')
    if (fs.existsSync(patch) && new RegExp(`id:\\s*${PATCH_ID}\\s*$`, 'm').test(fs.readFileSync(patch, 'utf8'))) {
      log.ok('cordis.patch.yml 挂载条目就位')
    } else { log.warn('cordis.patch.yml 缺挂载条目（可运行 kixparadigm install 修复）'); allOk = false }
  } else {
    log.warn('vision-bridge 未安装')
    allOk = false
  }

  log.step('运行插件单元回归（installed preset）')
  for (const t of ['kix-guards.test.js', 'kix-commands.test.js', 'kix-cost.test.js', 'kix-route.test.js', 'kix-discipline.test.js', 'kix-orchestration.test.js', 'kix-focus.test.js']) {
    const test = path.join(preset, 'plugins', t)
    if (!fs.existsSync(test)) { log.warn(`测试文件缺失: ${test}`); allOk = false; continue }
    const r = spawnSync(process.execPath, [test], { stdio: 'inherit' })
    if (r.status === 0) log.ok(`${t} 通过`)
    else { log.warn(`${t} 失败 (exit ${r.status})`); allOk = false }
  }

  reportSettingsChecklist(log)
  log.step(allOk ? 'doctor：全部就绪。重启 dsh web 后开新会话生效。' : 'doctor：存在缺口，见上方 ⚠ 项。')
  return allOk
}

function installCopilot(log) {
  const ps1 = path.join(PKG_ROOT, 'install.ps1')
  const sh = path.join(PKG_ROOT, 'install.sh')
  if (process.platform === 'win32' && fs.existsSync(ps1)) {
    log.step('运行 install.ps1（VS Code Copilot 侧导入）')
    // 优先 pwsh（7.x）；未安装时回退系统自带 Windows PowerShell 5.1
    let r = null
    for (const cmd of ['pwsh', 'powershell']) {
      r = spawnSync(cmd, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: 'inherit' })
      if (!(r.error && r.error.code === 'ENOENT')) break
      log.warn(`${cmd} 不可用，尝试下一个可用 shell`)
    }
    if (r && r.error && r.error.code === 'ENOENT') {
      log.warn('未找到 pwsh / powershell（install.ps1 需要其中之一）')
      process.exitCode = 1
    } else if (r.status !== 0) {
      log.warn(`install.ps1 退出码 ${r.status}`)
      process.exitCode = r.status ?? 1
    }
  } else if (fs.existsSync(sh)) {
    log.step('运行 install.sh（VS Code Copilot 侧导入）')
    const r = spawnSync('bash', [sh], { stdio: 'inherit' })
    if (r.error && r.error.code === 'ENOENT') {
      log.warn('未找到 bash（install.sh 需要 bash，可安装 bash 后重试）')
      process.exitCode = 1
    } else if (r.status !== 0) {
      log.warn(`install.sh 退出码 ${r.status}`)
      process.exitCode = r.status ?? 1
    }
  } else {
    log.warn('未找到 install.ps1 / install.sh')
    process.exitCode = 1
  }
}

function cli(argv) {
  const args = argv || []
  const quiet = args.includes('--quiet') || args.includes('-q')
  const log = makeLog(quiet)
  if (args.includes('--version') || args.includes('-v') || args.includes('version')) {
    console.log(require(path.join(PKG_ROOT, 'package.json')).version)
    return
  }
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    console.log(`kixparadigm — kix 范式全家桶一键导入（presets: ${PRESET_VARIANTS.map((v) => v.id).join(', ')}）
用法:
  kixparadigm install [--preset-only]  安装全部 preset 变体 + vision-bridge（默认；npm 安装时自动执行）
  kixparadigm uninstall                卸载全部安装内容
  kixparadigm doctor                   自检安装状态
  kixparadigm copilot                  导入 VS Code Copilot 侧（可选）
  kixparadigm --version
目标目录: $DSH_HOME（默认 ~/.dsh）
0.1.7/master: 解析 KIX_DSH_PREFIX（安装根、dsh 包目录或 lib/bin.js），否则用 PATH 上的 dsh。按 Node 的解析找到 registry 后先打压缩/会话补丁，成功后才写 profile 声明。没有 registry 只复制目录。`)
    return
  }
  const cmd = args.find((a) => !a.startsWith('-')) || 'install'
  try {
    switch (cmd) {
      case 'install': {
        if (!args.includes('--preset-only')) installVisionBridge(log)
        const installed = installPreset(log)
        reportSettingsChecklist(log)
        const runtime = installed && installed.kixRuntime
        if (runtime && runtime.declared) {
          log.step('完成。重启 dsh web（Ctrl+C → dsh web）后开新会话，preset 生效；' +
            'vision-bridge client 半刷新页面即生效。')
        } else if (runtime && runtime.reason === 'no-profile') {
          log.step(`完成。运行时补丁已落到 ${runtime.prefix}。profile 尚未初始化或没有 registry bundle，声明未写。先运行一次该 profile，再执行 install。`)
        } else {
          log.step('完成。preset 目录已复制。当前 dsh 没有 agent preset registry，声明未写，重启不会加载这些 preset。')
        }
        break
      }
      case 'uninstall': uninstall(log); break
      case 'doctor': process.exitCode = doctor(log) ? 0 : 1; break
      case 'copilot': installCopilot(log); break
      default:
        log.warn(`未知命令: ${cmd}（见 kixparadigm --help）`)
        process.exitCode = 1
    }
  } catch (e) {
    log.warn(`安装失败: ${e.message}`)
    if (process.env.KIX_DEBUG) console.error(e)
    process.exitCode = 1
  }
}

if (require.main === module) cli(process.argv.slice(2))

module.exports = { cli, dshHome, hasOtherPresetOwner, installPreset, installPresetDeclarations, installVisionBridge, uninstall, doctor, copyTree, ensureDefaultSkillsShelf, ensureDefaultShelf, DEFAULT_SHELF_DIRS, mergeVisionBridgePatch, restoreEmptyPatchRoot, upsertPresetBlock, renderPresetPatchBlock, presetResolutionRoot, missingBarePackages }
