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

// 该相同的数份必须相同（kix 哲学：不是写死的 zh/en 一对）。
// 边界自感知：preset 根 = 同时含 agent.cordis.yml + preset.yml 的目录（DSH preset
// 布局双标记，压假阳性），深度 ≤2 扫描（跳过 .* / node_modules）。
// 边界即 preset 根本身：非 preset 根路径天然出组，无需任何逐路径豁免规则。
// 其它仓库：≥2 个 preset 根才引导；单 preset / 普通项目零开销放行——规则是负债，
// 只做启发引导。
const PRESET_MARKERS = ['agent.cordis.yml', 'preset.yml']

function isPresetRootDir(root, rel) {
  return PRESET_MARKERS.every((m) => fs.existsSync(path.join(root, rel, m)))
}

function discoverPresetRoots(root, extraRoots) {
  if (!root || typeof root !== 'string') return []
  const out = []
  const add = (rel) => {
    const n = String(rel || '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (!n || n.startsWith('..') || path.isAbsolute(n)) return
    if (out.includes(n)) return
    if (isPresetRootDir(root, n)) out.push(n)
  }
  for (const rel of (Array.isArray(extraRoots) ? extraRoots : [])) add(rel)
  let top
  try { top = fs.readdirSync(root, { withFileTypes: true }) } catch { return out.sort() }
  for (const d1 of top) {
    if (!d1.isDirectory() || d1.name.startsWith('.') || d1.name === 'node_modules') continue
    add(d1.name)
    let mid
    try { mid = fs.readdirSync(path.join(root, d1.name), { withFileTypes: true }) } catch { continue }
    for (const d2 of mid) {
      if (!d2.isDirectory() || d2.name.startsWith('.')) continue
      add(d1.name + '/' + d2.name)
    }
  }
  return out.sort()
}

function isMultiPresetWorkspace(root) {
  return discoverPresetRoots(root).length >= 2
}

// post-execute 注入合并：注入方先 `await next()` 拿下游 decision，再把自己的
// contexts 并进去。裸返回 accept-decision 会短路瀑布、饿死后面挂载的监听器
// （WSL2 实弹实锤：kix-discipline 注入后，后挂载的 kix-consistency 的 post
// 永远收不到同一调用——首写提醒丢失）。非 accept 的下游 decision（block 等
// 更强决定）原样放行不覆盖；下游无可合并对象时新建 accept。
function appendContexts(decision, msgs) {
  const list = Array.isArray(msgs) ? msgs.filter(Boolean) : []
  if (list.length === 0) return decision
  if (decision && typeof decision === 'object' && decision.kind && decision.kind !== 'accept') return decision
  const base = decision && typeof decision === 'object' ? decision : {}
  const prev = Array.isArray(base.additionalContexts) ? base.additionalContexts : []
  return { ...base, kind: base.kind || 'accept', additionalContexts: [...prev, ...list] }
}

// 会话工作区根解析（kix-consistency / kix-guards 共用，防双源）：
// 会话 header.cwd（DSH 官方口径：不可变 cwd 才是 workspace-write 边界）→
// sandboxPolicy.resolve({session})（逐调用根）→ sandboxPolicy.workspaceRoot
// （部署回退，常为 process.cwd()——误当会话工作区会让整套自感知静默失效，
// WSL2 E2E 实锤）。全部拿不到 → null。
function resolveWorkspaceRoot(agent, sandboxPolicy) {
  try {
    const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  } catch { /* fall through */ }
  if (sandboxPolicy === undefined || sandboxPolicy === null) return null
  if (typeof sandboxPolicy.resolve === 'function') {
    try {
      const session = agent && agent.session
      const resolved = sandboxPolicy.resolve(session ? { session } : {})
      if (resolved && typeof resolved.workspaceRoot === 'string' && resolved.workspaceRoot.length > 0) {
        return resolved.workspaceRoot
      }
    } catch { /* fall through */ }
  }
  const fallback = sandboxPolicy.workspaceRoot
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : null
}

// paths ≥ 2；任一缺失 / 任一份与锚点（第一份）字节不同 → failure。
function checkIdenticalSet({ root, paths, label }) {
  const failures = []
  const notes = []
  const list = Array.isArray(paths) ? paths.filter(Boolean) : []
  if (list.length < 2) return { failures: [`${label}: identity set needs ≥2 paths`], notes }
  const missing = list.filter((p) => !fs.existsSync(path.join(root, p)))
  if (missing.length) return { failures: missing.map((p) => `${p} missing`), notes }
  const bufs = list.map((p) => fs.readFileSync(path.join(root, p)))
  const differ = []
  for (let i = 1; i < bufs.length; i++) {
    if (!bufs[0].equals(bufs[i])) differ.push(list[i])
  }
  if (differ.length) {
    failures.push(`${label}: ${list.length} copies not identical (${list[0]} differs from ${differ.join(', ')})`)
  } else {
    notes.push(`${label}: ${list.length} copies byte-identical`)
  }
  return { failures, notes }
}

// 两文件是 N=2 的特例；保留给既有调用方。
function checkFilesEqual({ root, a, b, label }) {
  return checkIdenticalSet({ root, paths: [a, b], label })
}

// 从被写路径反推它属于哪个已发现的 preset 根（最长前缀）。
function presetRootOf(rel, presetRoots) {
  const p = String(rel || '').replace(/\\/g, '/')
  let hit = null
  for (const r of presetRoots) {
    if (p === r || p.startsWith(r + '/')) {
      if (!hit || r.length > hit.length) hit = r
    }
  }
  return hit
}

// 身份组：同一相对路径在每个 preset 根下的对应文件。
// 例：写 dsh/preset/plugins/x.js → [dsh/preset/plugins/x.js, en/preset/plugins/x.js]
function identityPathsFor(rel, presetRoots) {
  const p = String(rel || '').replace(/\\/g, '/')
  const home = presetRootOf(p, presetRoots)
  if (!home) return []
  const suffix = p.slice(home.length).replace(/^\//, '')
  return presetRoots.map((r) => (suffix ? r + '/' + suffix : r))
}

function pluginIdentityPaths(name, presetRoots) {
  return (Array.isArray(presetRoots) ? presetRoots : []).map((r) => r + '/plugins/' + name)
}

// 插件身份组：每个已发现 preset 根下的同名文件（未传 roots 则现场发现）。
// test 任一根存在则整组校验；全无 test → note 跳过（如 opt-in kix-stalled）。
function checkPluginPair({ root, name, presetRoots }) {
  const roots = Array.isArray(presetRoots) && presetRoots.length ? presetRoots : discoverPresetRoots(root)
  const paths = pluginIdentityPaths(name, roots)
  const out = checkIdenticalSet({
    root, paths, label: `plugins/${name}`,
  })
  const testName = name.replace(/\.(?:js|cjs)$/, '.test.js')
  const testPaths = pluginIdentityPaths(testName, roots)
  const hasTest = testPaths.some((p) => fs.existsSync(path.join(root, p)))
  if (!hasTest) {
    out.notes.push(`plugins/${testName}: absent on all copies (opt-in), skipped`)
    return out
  }
  const t = checkIdenticalSet({
    root, paths: testPaths, label: `plugins/${testName}`,
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
    checkIdenticalSet({ root, paths: ['dsh/vision-bridge/index.js', 'en/bridge/index.js'], label: 'vision-bridge/index.js' }),
    checkIdenticalSet({ root, paths: ['dsh/vision-bridge/test.js', 'en/bridge/test.js'], label: 'vision-bridge/test.js' }),
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
  checkIdenticalSet,
  PRESET_MARKERS,
  discoverPresetRoots,
  isMultiPresetWorkspace,
  appendContexts,
  resolveWorkspaceRoot,
  presetRootOf,
  identityPathsFor,
  pluginIdentityPaths,
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
