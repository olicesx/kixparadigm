// 门禁验证脚本：直接调用 preset 挂载的 kix-guards.js 判定函数
// 用法：node scripts/verify-guards.js
// 路径解析：preset 取自 $DSH_HOME/.agent-presets/kixparadigm（默认 ~/.dsh），
//           source 取自仓库 canonical dsh/preset/plugins/kix-guards.js
'use strict'

const { join } = require('node:path')
const { homedir } = require('node:os')

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const presetGuard = join(dshHome, '.agent-presets', 'kixparadigm', 'plugins', 'kix-guards.js')
const bundleGuard = join(__dirname, '..', 'dsh', 'preset', 'plugins', 'kix-guards.js')

function load(p) {
  try { return require(p).__internals } catch (e) { return { error: e.message } }
}

const preset = load(presetGuard)
const bundle = load(bundleGuard)

const cases = [
  ['UPDATE without WHERE', 'isDestructiveSql', ['UPDATE users SET admin = 1'], true],
  ['UPDATE with WHERE', 'isDestructiveSql', ['UPDATE users SET admin = 1 WHERE id = 2'], false],
  ['DROP', 'isDestructiveSql', ['DROP TABLE users'], true],
  ['terminal SQL client', 'isTerminalDestructiveSql', ['psql -c "DELETE FROM users"'], true],
  ['echo is not SQL execution', 'isTerminalDestructiveSql', ['echo "DELETE FROM users"'], false],
  ['force push', 'isForcePush', ['git push --force origin main'], true],
  ['feature push', 'isForcePush', ['git push origin feature'], false],
  ['Git long option', 'hasGitSubcommand', ['git --work-tree C:/repo commit -am x', 'commit'], true],
]

let failed = Boolean(preset.error || bundle.error)
for (const [name, fnName, args, expected] of cases) {
  const presetFn = preset[fnName]
  const bundleFn = bundle[fnName]
  const presetValue = typeof presetFn === 'function' ? presetFn(...args) : 'N/A'
  const bundleValue = typeof bundleFn === 'function' ? bundleFn(...args) : 'N/A'
  const ok = presetValue === expected && bundleValue === expected
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'} [${name}] expected=${expected} preset=${presetValue} source=${bundleValue}`)
}

if (failed) process.exitCode = 1

console.log('---')
console.log('preset loaded:', preset.error ? 'ERROR ' + preset.error : 'ok')
console.log('bundle loaded:', bundle.error ? 'ERROR ' + bundle.error : 'ok')
