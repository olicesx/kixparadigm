#!/usr/bin/env node
'use strict'
// kixparadigm DSH 一致性守护（v1.2.11；2026-08-17 拆核重构）——防「规则是负债」类漂移：
//   - persona 常驻预算（字符数 + 近似 token 估算）
//   - README 可观察计数与 preset 实际文件一致
//   - zh/en 插件字节一致（语言中立复制约定）
//   - DSH/en preset 本地 Markdown 链接可达
//   - 全部 JS/CJS/MJS 语法可解析
//   - package 版本与 engines 声明一致
// 检查逻辑已提取到 dsh/preset/plugins/consistency-lib.cjs（与 kix-consistency 插件
// 共用单一事实源，防「CI 一套、运行时一套」双源漂移）；本文件只做 CLI 组装。
// 不依赖第三方包；npm test 会运行。

const path = require('node:path')
const lib = require('../dsh/preset/plugins/consistency-lib.cjs')

const ROOT = path.join(__dirname, '..')

console.log('== kixparadigm DSH consistency check ==')

const { failures, notes } = lib.runAllZh(ROOT)
for (const n of notes) console.log('  ✔ ' + n)

if (failures.length) {
  console.error(`\nCONSISTENCY FAIL (${failures.length})`)
  for (const f of failures) console.error('  ✖ ' + f)
  process.exit(1)
}
console.log('\nCONSISTENCY OK')
