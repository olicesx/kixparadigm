#!/usr/bin/env node
/**
 * list-plugin-tools.cjs
 * 对比 dsh/preset/plugins/ 与 en/preset/plugins/ 下的插件文件集合（仅 .js，排除 *.test.js），
 * 输出三组：两边共有 / 只在 dsh / 只在 en，并打印总数。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = {
  dsh: path.join(ROOT, 'dsh', 'preset', 'plugins'),
  en: path.join(ROOT, 'en', 'preset', 'plugins'),
};

function listPlugins(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .sort();
}

const dsh = new Set(listPlugins(DIRS.dsh));
const en = new Set(listPlugins(DIRS.en));

const both = [...dsh].filter((f) => en.has(f));
const onlyDsh = [...dsh].filter((f) => !en.has(f));
const onlyEn = [...en].filter((f) => !dsh.has(f));

function print(title, items) {
  console.log(`=== ${title} (${items.length}) ===`);
  for (const f of items) console.log('  ' + f);
  console.log('');
}

print('两边共有', both);
print('只在 dsh/', onlyDsh);
print('只在 en/', onlyEn);

const total = both.length + onlyDsh.length + onlyEn.length;
console.log(`总数: ${total}（共有 ${both.length} + 只在 dsh ${onlyDsh.length} + 只在 en ${onlyEn.length}）`);
