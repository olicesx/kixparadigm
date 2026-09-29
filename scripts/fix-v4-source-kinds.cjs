#!/usr/bin/env node
// One-shot fixer: lift retired v3 message-source syntax into v4 producer-owned kinds.
// DSH 0.2.0-rc.1 (session format v4) rejects source:{kind:'plugin',plugin:X} at
// inbox-splice admission ("format v4 message requires a producer-owned source kind").
// The v3->v4 migrator maps it to {kind:'plugin:X'}; we produce that shape directly.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const ROOTS = [
  'dsh/preset',
  'dsh/preset-classic',
  'dsh/preset-null',
  'en/preset-classic-en',
]
const BASE = path.join(__dirname, '..')

const SRC_RE = /source: \{ kind: 'plugin', plugin: '([a-z0-9-]+)', /g
const TEST_RE = /steers\[0\]\?\.source\?\.plugin === 'kix-route'/g

let files = 0, hits = 0, testHits = 0
for (const root of ROOTS) {
  const dir = path.join(BASE, root, 'plugins')
  if (!fs.existsSync(dir)) { console.error('MISSING ROOT', dir); process.exit(1) }
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.js') && !name.endsWith('.cjs')) continue
    const full = path.join(dir, name)
    const before = fs.readFileSync(full, 'utf8')
    let after = before, n = 0
    after = after.replace(SRC_RE, (m, name2) => { n++; return `source: { kind: 'plugin:${name2}', ` })
    let t = 0
    if (name === 'kix-route.test.js') {
      after = after.replace(TEST_RE, () => { t++; return "steers[0]?.source?.kind === 'plugin:kix-route'" })
    }
    if (n === 0 && t === 0) continue
    fs.writeFileSync(full, after)
    files++
    hits += n
    testHits += t
    console.log(`${root}/plugins/${name}: ${n} source lift(s)${t ? `, ${t} test assertion(s)` : ''}`)
  }
}
console.log(`\nTOTAL: ${files} files, ${hits} source lifts, ${testHits} test assertions`)

// Post-conditions: no retired syntax remains; every producer kind is well-formed.
let bad = 0
for (const root of ROOTS) {
  const dir = path.join(BASE, root, 'plugins')
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js') && !name.endsWith('.cjs')) continue
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    if (/kind: 'plugin',\s*plugin:/.test(text)) { console.error('LEFTOVER RETIRED SYNTAX:', `${root}/plugins/${name}`); bad++ }
    // Only plugin-owned kinds are in scope; host kinds (user/tool/…) have their own admission.
    for (const m of text.matchAll(/source: \{ kind: '(plugin:[^']*)'/g)) {
      if (!/^plugin:[a-z0-9-]+$/.test(m[1])) { console.error('BAD PRODUCER KIND:', `${root}/plugins/${name}`, m[1]); bad++ }
    }
  }
}
process.exit(bad === 0 ? 0 : 1)
