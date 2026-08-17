'use strict'
// kixparadigm consistency-lib — 一致性守护纯函数核心（2026-08-17，P5 提取）
//
// 单一事实源：scripts/check-dsh-consistency.cjs（zh 全量入口）、
// en/scripts/check-consistency.cjs（en 包全量入口）、
// plugins/kix-consistency.js（写时增量拦截）三者共用本文件——
// 防「CI 一套、运行时一套」双源漂移（与 kix「消灭双源」范式一致）。
//
// 约定：本文件不打印、不改进程退出码；所有检查返回 { failures: string[], notes: string[] }。
// 消息统一英文（zh/en 字节一致约束）。ROOT 由调用方传入（脚本传包根，插件传工作区根）。
// 不依赖第三方包。

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// ── 基础工具 ──────────────────────────────────────────────────────────────
function read(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8')
  } catch {
    return null
  }
}

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

// 近似 o200k token 估算：CJK 字符按 ~1.05、英文词按 ~0.75、其余字符按 ~0.4。
// 保守预算代理，不是 tokenizer；精确数在文档中记录，精确回归由阈值变化触发人工复核。
function estimateTokens(text) {
  const s = String(text || '')
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length
  const words = (s.match(/[A-Za-z0-9_]+(?:[.'-][A-Za-z0-9_]+)*/g) || []).length
  const other = Math.max(0, s.length - cjk - (s.match(/[A-Za-z0-9_]/g) || []).length)
  return Math.ceil(cjk * 1.05 + words * 0.75 + other * 0.4)
}

// ── 检查项（全部返回 { failures, notes }，无 console 副作用）──────────────

function extractPersona(root, rel) {
  const text = read(root, rel)
  if (text === null) return { persona: null, error: `${rel}: unreadable` }
  const start = text.indexOf('text: |-')
  const end = text.indexOf('- id: agent-instructions', start)
  if (start < 0 || end < 0) {
    return { persona: null, error: `${rel}: persona block or agent-instructions anchor not found` }
  }
  const raw = text.slice(start + 'text: |-'.length, end).replace(/^\r?\n/, '')
  const lines = raw.split(/\r?\n/)
  const dedented = lines.map((line) => {
    if (/^\s{6}/.test(line)) return line.slice(6)
    return line.replace(/^\s+/, '')
  })
  return { persona: dedented.join('\n').trim() }
}

function checkPersonaBudget({ root, rel, maxChars, maxEstTokens }) {
  const failures = []
  const notes = []
  const { persona, error } = extractPersona(root, rel)
  if (error) return { failures: [error], notes }
  const chars = persona.length
  const tokens = estimateTokens(persona)
  if (chars > maxChars) failures.push(`${rel}: persona ${chars} chars exceeds budget ${maxChars}`)
  if (tokens > maxEstTokens) failures.push(`${rel}: persona ~${tokens} est tokens exceeds budget ${maxEstTokens}`)
  notes.push(`${rel}: persona ${chars} chars / ~${tokens} est tokens (budget ${maxChars}/${maxEstTokens})`)
  return { failures, notes }
}

// 两文件字节一致（a/b 缺失分别报错，缺失与差异都是 failure）
function checkFilesEqual({ root, a, b, label }) {
  const failures = []
  const notes = []
  const pa = path.join(root, a)
  const pb = path.join(root, b)
  if (!fs.existsSync(pa)) return { failures: [`${a} missing`], notes }
  if (!fs.existsSync(pb)) return { failures: [`${b} missing`], notes }
  if (fs.readFileSync(pa).equals(fs.readFileSync(pb))) notes.push(`${label}: byte-identical`)
  else failures.push(`${label}: ${a} differs from ${b}`)
  return { failures, notes }
}

// 插件对：dsh/preset/plugins/{name} vs en/preset/plugins/{name} 字节一致；
// test 文件存在（任一侧）则同样校验；双侧均无 test → note 跳过（如 opt-in kix-stalled）。
function checkPluginPair({ root, name }) {
  const out = checkFilesEqual({
    root, a: `dsh/preset/plugins/${name}`, b: `en/preset/plugins/${name}`, label: `plugins/${name}`,
  })
  const testName = name.replace(/\.js$/, '.test.js')
  const hasTest = fs.existsSync(path.join(root, 'dsh/preset/plugins', testName)) ||
    fs.existsSync(path.join(root, 'en/preset/plugins', testName))
  if (!hasTest) {
    out.notes.push(`plugins/${testName}: absent on both sides (opt-in), skipped`)
    return out
  }
  const t = checkFilesEqual({
    root, a: `dsh/preset/plugins/${testName}`, b: `en/preset/plugins/${testName}`, label: `plugins/${testName}`,
  })
  out.failures.push(...t.failures)
  out.notes.push(...t.notes)
  return out
}

// memories 目录计数（README 计数同步的事实源）
function checkMemoriesCount({ root, rel, expected }) {
  const failures = []
  const notes = []
  const dir = path.join(root, rel)
  if (!fs.existsSync(dir)) return { failures: [`${rel} missing`], notes }
  const count = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length
  if (count !== expected) failures.push(`${rel}: expected ${expected} memories, got ${count}`)
  else notes.push(`${rel} = ${count} (README count in sync)`)
  return { failures, notes }
}

// README 固定表述（如「+ 4 记忆」——易变计数自报约定的一部分）
function checkReadmePhrase({ root, rel, phrase }) {
  const failures = []
  const notes = []
  const text = read(root, rel)
  if (text === null) return { failures: [`${rel}: unreadable`], notes }
  if (!text.includes(phrase)) failures.push(`${rel}: missing phrase "${phrase}"`)
  else notes.push(`${rel}: contains "${phrase}"`)
  return { failures, notes }
}

// zh/en 包版本 + engines 一致（仓库级）
function checkVersionPair({ root }) {
  const failures = []
  const notes = []
  const zhText = read(root, 'package.json')
  const enText = read(root, 'en/package.json')
  if (zhText === null || enText === null) return { failures: ['package.json or en/package.json unreadable'], notes }
  let zhPkg
  let enPkg
  try { zhPkg = JSON.parse(zhText) } catch { return { failures: ['package.json not valid JSON'], notes } }
  try { enPkg = JSON.parse(enText) } catch { return { failures: ['en/package.json not valid JSON'], notes } }
  if (zhPkg.version !== enPkg.version) failures.push(`zh/en package version mismatch: ${zhPkg.version} vs ${enPkg.version}`)
  else notes.push(`zh/en package version consistent: ${zhPkg.version}`)
  if (zhPkg.engines && zhPkg.engines.node !== '>=20.16.0') failures.push('package.json: engines.node should be >=20.16.0')
  if (enPkg.engines && enPkg.engines.node !== '>=20.16.0') failures.push('en/package.json: engines.node should be >=20.16.0')
  if (!failures.some((f) => f.includes('engines'))) notes.push('engines.node >=20.16.0 zh/en consistent')
  return { failures, notes }
}

// en 包内版本检查（en 包无 zh 侧对照；expected 由调用方钉值——en/scripts 维持版本声明）
function checkEnPkgVersion({ root, rel, expected }) {
  const failures = []
  const notes = []
  const text = read(root, rel)
  if (text === null) return { failures: [`${rel}: unreadable`], notes }
  let pkg
  try { pkg = JSON.parse(text) } catch { return { failures: [`${rel}: not valid JSON`], notes } }
  if (pkg.version !== expected) failures.push(`${rel}: version should be ${expected}, got ${pkg.version}`)
  else notes.push(`${rel}: version ${pkg.version}`)
  if (!pkg.engines || pkg.engines.node !== '>=20.16.0') failures.push(`${rel}: engines.node should be >=20.16.0`)
  else notes.push(`${rel}: engines.node >=20.16.0`)
  return { failures, notes }
}

// 本地 markdown 链接可达（相对链接目标；https/mailto/锚点跳过）
function checkMarkdownLinks({ root, rel }) {
  const failures = []
  const notes = []
  const dir = path.join(root, rel)
  if (!fs.existsSync(dir)) return { failures: [`${rel} missing`], notes }
  const bad = []
  for (const file of walk(dir)) {
    if (!file.endsWith('.md')) continue
    const text = read(root, path.relative(root, file))
    if (text === null) continue
    const lines = text.split(/\r?\n/)
    let fence = false
    lines.forEach((line, index) => {
      if (/^\s*```/.test(line)) { fence = !fence; return }
      if (fence) return
      const re = /\[[^\]]*\]\(([^)]*)\)/g
      let m
      while ((m = re.exec(line))) {
        const url = m[1].trim()
        if (/^(?:https?:|#|mailto:)/.test(url)) continue
        const target = url.split('#')[0].trim()
        if (!target || !/\.[A-Za-z0-9]+$/.test(target)) continue
        const fromFile = path.resolve(path.dirname(file), target)
        const fromRoot = path.resolve(dir, target)
        if (!fs.existsSync(fromFile) && !fs.existsSync(fromRoot)) {
          bad.push(`${path.relative(root, file)}:${index + 1} -> ${url}`)
        }
      }
    })
  }
  if (bad.length) failures.push(`${rel}: ${bad.length} broken link(s): ${bad.join(' | ')}`)
  else notes.push(`${rel}: all local markdown links reachable`)
  return { failures, notes }
}

// 全量 JS/CJS/MJS 语法检查（walk + node --check）
function checkSyntax({ root, rel, label }) {
  const failures = []
  const notes = []
  const dir = path.join(root, rel)
  if (!fs.existsSync(dir)) return { failures: [`${rel} missing`], notes }
  const files = walk(dir).filter((f) => /\.(?:js|cjs|mjs)$/.test(f))
  let bad = 0
  for (const file of files) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (r.status !== 0) { bad++; failures.push(`${label}: ${path.relative(root, file)} syntax check failed`) }
  }
  if (bad === 0) notes.push(`${label}: ${files.length} JS/CJS/MJS syntax OK`)
  return { failures, notes }
}

// 单文件语法检查（写时增量用：只校验写入目标本身，不 walk 全目录）
function checkFileSyntax({ root, rel, label }) {
  const failures = []
  const notes = []
  const file = path.join(root, rel)
  if (!fs.existsSync(file)) return { failures: [`${rel} missing`], notes }
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (r.status !== 0) {
    const firstLine = String(r.stderr || '').split('\n')[0]
    failures.push(`${label || rel}: syntax check failed: ${firstLine || 'unknown error'}`)
  } else {
    notes.push(`${label || rel}: syntax OK`)
  }
  return { failures, notes }
}

function merge(...results) {
  const failures = []
  const notes = []
  for (const r of results) {
    if (r && r.failures) failures.push(...r.failures)
    if (r && r.notes) notes.push(...r.notes)
  }
  return { failures, notes }
}

// 动态插件清单（dsh/preset/plugins/*.{js,cjs} 非 test——新增插件自动纳入，
// 不维护硬编码清单；共享库 consistency-lib.cjs 也在同步检查范围：核心文件
// 的 zh/en 漂移同样会被 checkPluginPair 拦截）
function pluginNames(root) {
  const dir = path.join(root, 'dsh/preset/plugins')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => /\.(?:js|cjs)$/.test(f) && !/\.test\.(?:js|cjs)$/.test(f))
    .sort()
}

// ── 全量组装 ───────────────────────────────────────────────────────────────
// zh 全量（仓库级：dsh/preset + en/preset + README + 副本 + 链接 + 语法）
function runAllZh(root) {
  return merge(
    checkPersonaBudget({ root, rel: 'dsh/preset/agent.cordis.yml', maxChars: 4500, maxEstTokens: 2600 }),
    checkPersonaBudget({ root, rel: 'en/preset/agent.cordis.yml', maxChars: 9500, maxEstTokens: 2600 }),
    checkMemoriesCount({ root, rel: 'dsh/preset/memories', expected: 4 }),
    checkReadmePhrase({ root, rel: 'README.md', phrase: '+ 4 记忆' }),
    checkReadmePhrase({ root, rel: 'README.en.md', phrase: '+ 4 memories' }),
    ...pluginNames(root).map((name) => checkPluginPair({ root, name })),
    checkVersionPair({ root }),
    checkFilesEqual({ root, a: 'dsh/vision-bridge/index.js', b: 'en/bridge/index.js', label: 'vision-bridge/index.js' }),
    checkFilesEqual({ root, a: 'dsh/vision-bridge/test.js', b: 'en/bridge/test.js', label: 'vision-bridge/test.js' }),
    checkFilesEqual({ root, a: 'dsh/preset/plugins/kix-guards.js', b: 'plugins/kix-guards.js', label: 'root plugins/kix-guards.js (VS Code reference copy)' }),
    checkFilesEqual({ root, a: 'dsh/preset/plugins/kix-guards.test.js', b: 'plugins/kix-guards.test.js', label: 'root plugins/kix-guards.test.js' }),
    checkMarkdownLinks({ root, rel: 'dsh/preset' }),
    checkMarkdownLinks({ root, rel: 'en/preset' }),
    checkSyntax({ root, rel: 'dsh/preset', label: 'dsh/preset' }),
    checkSyntax({ root, rel: 'en/preset', label: 'en/preset' }),
    checkSyntax({ root, rel: 'dsh/vision-bridge', label: 'dsh/vision-bridge' }),
    checkSyntax({ root, rel: 'en/bridge', label: 'en/bridge' }),
    checkSyntax({ root, rel: 'scripts', label: 'scripts' }),
  )
}

// en 包全量（en 包内：preset + bridge + scripts；版本由调用方钉值）
function runAllEn(root, expectedVersion) {
  return merge(
    checkPersonaBudget({ root, rel: 'preset/agent.cordis.yml', maxChars: 9500, maxEstTokens: 2600 }),
    checkEnPkgVersion({ root, rel: 'package.json', expected: expectedVersion }),
    checkMarkdownLinks({ root, rel: 'preset' }),
    checkSyntax({ root, rel: 'preset', label: 'en/preset' }),
    checkSyntax({ root, rel: 'bridge', label: 'en/bridge' }),
    checkSyntax({ root, rel: 'scripts', label: 'en/scripts' }),
  )
}

module.exports = {
  estimateTokens,
  extractPersona,
  checkPersonaBudget,
  checkFilesEqual,
  checkPluginPair,
  checkMemoriesCount,
  checkReadmePhrase,
  checkVersionPair,
  checkEnPkgVersion,
  checkMarkdownLinks,
  checkSyntax,
  checkFileSyntax,
  merge,
  runAllZh,
  runAllEn,
  pluginNames,
}
