#!/usr/bin/env node
'use strict'
// kixparadigm DSH 一致性守护（v1.2.10）——防「规则是负债」类漂移：
//   - persona 常驻预算（字符数 + 近似 token 估算）
//   - README 可观察计数与 preset 实际文件一致
//   - zh/en 插件字节一致（语言中立复制约定）
//   - DSH/en preset 本地 Markdown 链接可达
//   - 全部 JS/CJS/MJS 语法可解析
//   - package 版本与 engines 声明一致
// 不依赖第三方包；npm test 会运行。

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
  const text = read(file)
  if (text === undefined) return undefined
  const start = text.indexOf('text: |-')
  const end = text.indexOf('- id: agent-instructions', start)
  if (start < 0 || end < 0) { fail(`${file}: 找不到 persona 块或 agent-instructions 锚点`); return undefined }
  const raw = text.slice(start + 'text: |-'.length, end).replace(/^\r?\n/, '')
  const lines = raw.split(/\r?\n/)
  const dedented = lines.map((line) => {
    if (/^\s{6}/.test(line)) return line.slice(6)
    return line.replace(/^\s+/, '')
  })
  return dedented.join('\n').trim()
}

// 近似 o200k token 估算：CJK 字符按 ~1.05、英文词按 ~0.75、其余字符按 ~0.4。
// 这是保守预算代理，不是 tokenizer；精确数在文档中记录，精确回归由阈值变化触发人工复核。
function estimateTokens(text) {
  const s = String(text || '')
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length
  const words = (s.match(/[A-Za-z0-9_]+(?:[.'-][A-Za-z0-9_]+)*/g) || []).length
  const other = Math.max(0, s.length - cjk - (s.match(/[A-Za-z0-9_]/g) || []).length)
  return Math.ceil(cjk * 1.05 + words * 0.75 + other * 0.4)
}

function checkPersonaBudget(rel, maxChars, maxEstTokens) {
  const file = path.join(ROOT, rel)
  const text = extractPersona(file)
  if (text === undefined) return
  const chars = text.length
  const tokens = estimateTokens(text)
  if (chars > maxChars) fail(`${rel}: persona 字符 ${chars} 超过预算 ${maxChars}`)
  if (tokens > maxEstTokens) fail(`${rel}: persona 估算 token ${tokens} 超过预算 ${maxEstTokens}`)
  ok(`${rel}: persona ${chars} chars / ~${tokens} est tokens（预算 ${maxChars}/${maxEstTokens}）`)
}

function checkFilesEqual(a, b, label) {
  const pa = path.join(ROOT, a)
  const pb = path.join(ROOT, b)
  if (!fs.existsSync(pa)) { fail(`${a} 缺失`); return }
  if (!fs.existsSync(pb)) { fail(`${b} 缺失`); return }
  if (fs.readFileSync(pa).equals(fs.readFileSync(pb))) ok(`${label}: 字节一致`)
  else fail(`${label}: ${a} 与 ${b} 不一致`)
}

function markdownLinkTargets(root, rel) {
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
        const resolved = path.resolve(path.dirname(file), target)
        const fromRoot = path.resolve(root, target)
        if (!fs.existsSync(resolved) && !fs.existsSync(fromRoot)) {
          bad.push(`${path.relative(ROOT, file)}:${index + 1} -> ${url}`)
        }
      }
    })
  }
  if (bad.length) fail(`${rel}: 断链 ${bad.length} 条：\n    ${bad.join('\n    ')}`)
  else ok(`${rel}: 本地 Markdown 链接全部可达`)
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

function checkSyntax(root, label) {
  const files = walk(root).filter((f) => /\.(?:js|cjs|mjs)$/.test(f))
  let bad = 0
  for (const file of files) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (r.status !== 0) { bad++; fail(`${label}: ${path.relative(ROOT, file)} 语法检查失败`) }
  }
  if (bad === 0) ok(`${label}: ${files.length} 个 JS/CJS/MJS 语法检查通过`)
}

function main() {
  console.log('== kixparadigm DSH consistency check ==')

  checkPersonaBudget('dsh/preset/agent.cordis.yml', 4500, 2600)
  checkPersonaBudget('en/preset/agent.cordis.yml', 9500, 2600)

  const memories = fs.readdirSync(path.join(ROOT, 'dsh/preset/memories')).filter((f) => f.endsWith('.md'))
  if (memories.length !== 4) fail(`dsh/preset/memories 预期 4 个，实际 ${memories.length}`)
  else ok(`dsh/preset/memories = ${memories.length}（README 计数同步）`)

  const zhReadme = read('README.md') || ''
  const enReadme = read('README.en.md') || ''
  if (!zhReadme.includes('+ 4 记忆')) fail('README.md 缺少预设记忆数 4 的表述')
  else ok('README.md 记忆计数 = 4')
  if (!enReadme.includes('+ 4 memories')) fail('README.en.md 缺少预设记忆数 4 的表述')
  else ok('README.en.md 记忆计数 = 4')

  for (const name of ['kix-commands.js', 'kix-cost.js', 'kix-discipline.js', 'kix-focus.js', 'kix-guards.js', 'kix-orchestration.js', 'kix-route.js', 'kix-stalled.js']) {
    checkFilesEqual(`dsh/preset/plugins/${name}`, `en/preset/plugins/${name}`, `plugins/${name}`)
    const testName = name.replace('.js', '.test.js')
    if (fs.existsSync(path.join(ROOT, 'dsh/preset/plugins', testName)) || fs.existsSync(path.join(ROOT, 'en/preset/plugins', testName))) {
      checkFilesEqual(`dsh/preset/plugins/${testName}`, `en/preset/plugins/${testName}`, `plugins/${testName}`)
    } else {
      ok(`plugins/${testName}: 双侧均无测试（如 opt-in 的 kix-stalled），跳过`)
    }
  }

  const zhPkg = JSON.parse(read('package.json'))
  const enPkg = JSON.parse(read('en/package.json'))
  if (zhPkg.version !== enPkg.version) fail(`中英包版本不一致：${zhPkg.version} vs ${enPkg.version}`)
  else ok(`中英包版本一致：${zhPkg.version}`)
  if (zhPkg.engines && zhPkg.engines.node !== '>=20.16.0') fail('package.json engines.node 应为 >=20.16.0（与 process.getBuiltinModule 最低版本对齐）')
  if (enPkg.engines && enPkg.engines.node !== '>=20.16.0') fail('en/package.json engines.node 应为 >=20.16.0')
  if (zhPkg.engines && enPkg.engines && zhPkg.engines.node === '>=20.16.0' && enPkg.engines.node === '>=20.16.0') ok('engines.node >=20.16.0 中英一致')

  checkFilesEqual('dsh/vision-bridge/index.js', 'en/bridge/index.js', 'vision-bridge/index.js')
  checkFilesEqual('dsh/vision-bridge/test.js', 'en/bridge/test.js', 'vision-bridge/test.js')
  checkFilesEqual('dsh/preset/plugins/kix-guards.js', 'plugins/kix-guards.js', 'root plugins/kix-guards.js（与 DSH 同源，VS Code 备查副本）')
  checkFilesEqual('dsh/preset/plugins/kix-guards.test.js', 'plugins/kix-guards.test.js', 'root plugins/kix-guards.test.js')

  markdownLinkTargets(path.join(ROOT, 'dsh/preset'), 'dsh/preset')
  markdownLinkTargets(path.join(ROOT, 'en/preset'), 'en/preset')
  checkSyntax(path.join(ROOT, 'dsh/preset'), 'dsh/preset')
  checkSyntax(path.join(ROOT, 'en/preset'), 'en/preset')
  checkSyntax(path.join(ROOT, 'dsh/vision-bridge'), 'dsh/vision-bridge')
  checkSyntax(path.join(ROOT, 'en/bridge'), 'en/bridge')
  checkSyntax(path.join(ROOT, 'scripts'), 'scripts')

  if (failures.length) {
    console.error(`\nCONSISTENCY FAIL (${failures.length})`)
    for (const f of failures) console.error('  ✖ ' + f)
    process.exit(1)
  }
  console.log('\nCONSISTENCY OK')
}

main()
