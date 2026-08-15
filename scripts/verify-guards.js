// 门禁验证脚本：直接调用 preset 挂载的 kix-guards.js 判定函数
// 用法：node scripts/verify-guards.js
// 路径解析：preset 取自 $DSH_HOME/.agent-presets/kixparadigm（默认 ~/.dsh），
//           bundle 取自本脚本的 ../plugins/kix-guards.js
'use strict'

const { join } = require('node:path')
const { homedir } = require('node:os')

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const presetGuard = join(dshHome, '.agent-presets', 'kixparadigm', 'plugins', 'kix-guards.js')
const bundleGuard = join(__dirname, '..', 'plugins', 'kix-guards.js')

function load(p) {
  try { return require(p).__internals } catch (e) { return { error: e.message } }
}

const preset = load(presetGuard)
const bundle = load(bundleGuard)

const cases = [
  ['echo "UPDATE users SET admin = 1"', 'UPDATE-no-WHERE'],
  ['echo "drop table users"', 'DROP'],
  ['git push --force origin main', 'force push'],
  ['echo "delete from users"', 'DELETE-no-WHERE'],
]

for (const [label, [text]] of cases.entries()) {
  const [cmd, name] = cases[label]
  const pSql = preset.isDestructiveSql ? preset.isDestructiveSql(cmd) : 'N/A'
  const bSql = bundle.isDestructiveSql ? bundle.isDestructiveSql(cmd) : 'N/A'
  const pForce = preset.isForcePush ? preset.isForcePush(cmd) : 'N/A'
  console.log(`[${name}]`)
  console.log(`  preset: isDestructiveSql=${pSql} isForcePush=${pForce}`)
  console.log(`  bundle: isDestructiveSql=${bSql} isForcePush=${bForce(preset, bundle, cmd)}`)
}

function bForce(preset, bundle, cmd) {
  return bundle.isForcePush ? bundle.isForcePush(cmd) : 'N/A'
}

console.log('---')
console.log('preset loaded:', preset.error ? 'ERROR ' + preset.error : 'ok')
console.log('bundle loaded:', bundle.error ? 'ERROR ' + bundle.error : 'ok')
