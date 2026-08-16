#!/usr/bin/env node
'use strict'
// kixparadigm-en package-level consistency guard (v1.2.10).
// Mirrors the repo-level scripts/check-dsh-consistency.cjs checks that can run
// from the packed EN package (only en/preset + en README are present there).

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const failures = []
function fail(msg) { failures.push(msg) }
function ok(msg) { console.log(`  ✔ ${msg}`) }

function read(p) {
  try { return fs.readFileSync(p, 'utf8') } catch (e) { fail(`无法读取 ${p}: ${e.message}`); return undefined }
}

function extractPersona(file) {
  const text = read(path.join(ROOT, file))
  if (text === undefined) return undefined
  const start = text.indexOf('text: |-')
  const end = text.indexOf('- id: agent-instructions', start)
  if (start < 0 || end < 0) { fail(`${file}: 找不到 persona 块或 agent-instructions 锚点`); return undefined }
  const raw = text.slice(start + 'text: |-'.length, end).replace(/^\r?\n/, '')
  return raw.split(/\r?\n/).map((line) => (/^\s{6}/.test(line) ? line.slice(6) : line.replace(/^\s+/, ''))).join('\n').trim()
}

function estimateTokens(text) {
  const s = String(text || '')
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length
  const words = (s.match(/[A-Za-z0-9_]+(?:[.'-][A-Za-z0-9_]+)*/g) || []).length
  const other = Math.max(0, s.length - cjk - (s.match(/[A-Za-z0-9_]/g) || []).length)
  return Math.ceil(cjk * 1.05 + words * 0.75 + other * 0.4)
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

function markdownLinkTargets() {
  const root = path.join(ROOT, 'preset')
  const bad = []
  for (const file of walk(root)) {
    if (!file.endsWith('.md')) continue
    const lines = read(file).split(/\r?\n/)
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
        if (!fs.existsSync(path.resolve(path.dirname(file), target)) && !fs.existsSync(path.resolve(root, target))) {
          bad.push(`${path.relative(ROOT, file)}:${index + 1} -> ${url}`)
        }
      }
    })
  }
  if (bad.length) fail(`en/preset 断链 ${bad.length} 条：\n    ${bad.join('\n    ')}`)
  else ok('en/preset: 本地 Markdown 链接全部可达')
}

function checkSyntax(root, label) {
  const files = walk(root).filter((f) => /\.(?:js|cjs|mjs)$/.test(f))
  let bad = 0
  for (const file of files) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (r.status !== 0) { bad++; fail(`${label}: ${path.relative(ROOT, file)} 语法检查失败`) }
  }
  if (bad === 0) ok(`${label}: ${files.length} 个 JS/CJS/MJS 语法检查通过`)
}

const persona = extractPersona('preset/agent.cordis.yml')
if (persona !== undefined) {
  const est = estimateTokens(persona)
  if (persona.length > 9500) fail(`EN persona ${persona.length} chars 超过 9500`)
  if (est > 2600) fail(`EN persona 估算 token ${est} 超过 2600`)
  ok(`EN persona: ${persona.length} chars / ~${est} est tokens`)
}

const pkg = JSON.parse(read('package.json'))
if (pkg.version !== '1.2.10') fail(`en/package.json 版本应为 1.2.10，实际 ${pkg.version}`)
else ok(`en/package.json 版本 ${pkg.version}`)
if (!pkg.engines || pkg.engines.node !== '>=20.16.0') fail('en/package.json engines.node 应为 >=20.16.0')
else ok('en/package.json engines.node >=20.16.0')

markdownLinkTargets()
checkSyntax(path.join(ROOT, 'preset'), 'en/preset')
checkSyntax(path.join(ROOT, 'bridge'), 'en/bridge')
checkSyntax(path.join(ROOT, 'scripts'), 'en/scripts')

if (failures.length) {
  console.error(`\nCONSISTENCY FAIL (${failures.length})`)
  for (const f of failures) console.error('  ✖ ' + f)
  process.exit(1)
}
console.log('\nCONSISTENCY OK')
