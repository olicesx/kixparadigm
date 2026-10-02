#!/usr/bin/env node
'use strict'
// kixparadigm-en package-level consistency guard (v1.2.11).
// Mirrors the repo-level scripts/check-dsh-consistency.cjs checks that can run
// from the packed EN package (only en/preset + en README are present there).
// 2026-08-17: logic extracted to preset/plugins/consistency-lib.cjs (shared with
// the kix-consistency plugin — single source of truth for CI and runtime checks).

const path = require('node:path')
const lib = require('../preset-classic-en/plugins/consistency-lib.cjs')

const ROOT = path.join(__dirname, '..')

// 2026-10-02 收口：版本期望从 en/package.json 动态读取（同 zh runAllZh 从
// zh 包读取的模式），消灭手工锚漂移——原硬编码 '1.3.16' 自 v1.3.17 起一直
// 过期，en npm test 链在 consistency 处长期误红。
const expectedVersion = require('../package.json').version

const { failures, notes } = lib.runAllEn(ROOT, expectedVersion)
for (const n of notes) console.log('  ✔ ' + n)

if (failures.length) {
  console.error(`\nCONSISTENCY FAIL (${failures.length})`)
  for (const f of failures) console.error('  ✖ ' + f)
  process.exit(1)
}
console.log('\nCONSISTENCY OK')

