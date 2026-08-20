'use strict'
// kix-browser.test.js — 单测：URL 门禁/action 校验/文本截断/插件形状/串行队列语义。
// 不依赖真浏览器（playwright-core 懒加载，注册路径零 require）。E2E 探针另跑。

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')

const pluginPath = path.join(__dirname, 'kix-browser.js')
const plugin = require(pluginPath)

// ── 形状：module.exports 契约 ─────────────────────────────────────────
test('plugin exports shape (name/inject/apply/_test)', () => {
  assert.equal(plugin.name, 'kix-browser')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin._test && typeof plugin._test.urlRejection === 'function')
})

// ── apply：注册工具且 schema 形状正确，dispose 可卸载 ─────────────────
test('apply registers browser tool with compact schema, disposable', () => {
  const registered = []
  const effects = []
  const logs = []
  const ctx = {
    tools: {
      register(def) {
        registered.push(def)
        return () => registered.splice(registered.indexOf(def), 1)
      },
    },
    effect: (fn) => effects.push(fn),
    logger: { info: (m) => logs.push(m) },
  }
  plugin.apply(ctx)
  assert.equal(registered.length, 1)
  const t = registered[0]
  assert.equal(t.name, 'browser')
  // parameters：JSON Schema 形状（tools.register 原样投影）
  assert.equal(t.parameters.type, 'object')
  assert.equal(t.parameters.required[0], 'action')
  assert.deepEqual(t.parameters.properties.action.enum.slice().sort(), plugin._test.ACTIONS.slice().sort())
  assert.equal(t.parameters.additionalProperties, false)
  // output：{schema, render} 契约（render 返回 ContentBlock[]）
  assert.equal(t.output.schema.type, 'object')
  assert.equal(typeof t.output.render, 'function')
  const blocks = t.output.render({}, { ok: true })
  assert.ok(Array.isArray(blocks) && blocks[0].type === 'text')
  assert.match(blocks[0].text, /"ok":true/)
  // execute 存在且是异步
  assert.equal(typeof t.execute, 'function')
  // dispose 生效（2026-08-20 语义适配：effect 回调返回卸载钩子）
  assert.equal(effects.length, 1)
  const teardown = effects[0]()
  assert.equal(typeof teardown, 'function', 'effect callback must return the disposer')
  teardown()
  assert.equal(registered.length, 0)
  assert.ok(logs.some((l) => l.includes('kix-browser')))
})

// ── 回归（2026-08-20）：effect 回调注册即执行，工具不得被秒注销 ────────
// cordis 语义：ctx.effect(cb) 的 cb 在注册时立即执行，cb 返回的函数才是
// 卸载钩子。曾因此翻车：花括号体 `ctx.effect(() => { dispose() … })` 在
// apply 瞬间注销工具（apply 正常返回、agent 视图永远查不到）。本测试用
// 镜像运行时的 mock（注册即执行回调）锁死该形态。
test('effect registration runs the callback immediately — tool must survive it', () => {
  const registered = []
  const disposers = []
  const ctx = {
    tools: {
      register(def) {
        registered.push(def)
        return () => registered.splice(registered.indexOf(def), 1)
      },
    },
    // 镜像 cordis：回调注册即执行，返回函数被收集为卸载钩子
    effect: (fn) => disposers.push(fn()),
    logger: { info: () => {} },
  }
  plugin.apply(ctx)
  // 注册存续：effect 注册（回调已执行）后工具仍可见——旧 bug 在此归零
  assert.equal(registered.length, 1, 'tool was unregistered during apply (immediate-dispose bug)')
  // 卸载钩子：调用收集到的函数才注销
  assert.equal(disposers.length, 1)
  assert.equal(typeof disposers[0], 'function', 'effect callback must return the disposer')
  disposers[0]()
  assert.equal(registered.length, 0)
})

// ── URL 门禁：放行/拒绝清单 ──────────────────────────────────────────
test('urlRejection allows http/https/about:blank', () => {
  assert.equal(plugin._test.urlRejection('http://a.b'), null)
  assert.equal(plugin._test.urlRejection('https://a.b/x?y=1'), null)
  assert.equal(plugin._test.urlRejection('about:blank'), null)
})
test('urlRejection rejects file/javascript/data/empty/garbage', () => {
  assert.match(plugin._test.urlRejection('file:///C:/win.ini'), /协议 file:/)
  assert.match(plugin._test.urlRejection('javascript:alert(1)'), /协议/)
  assert.match(plugin._test.urlRejection('data:text/html,x'), /协议/)
  assert.match(plugin._test.urlRejection(''), /非空/)
  assert.match(plugin._test.urlRejection(42), /非空/)
  assert.match(plugin._test.urlRejection('not a url'), /无法解析/)
})

// ── 文本截断 ─────────────────────────────────────────────────────────
test('clipText trims and clips with ellipsis', () => {
  assert.equal(plugin._test.clipText('  a  b  ', 10), 'a b')
  assert.equal(plugin._test.clipText('x'.repeat(50), 10), 'x'.repeat(10) + '…')
  assert.equal(plugin._test.clipText(null, 10), '')
})

// ── 未知 action 拒绝（execute 纯路径，无需浏览器）────────────────────
test('execute rejects unknown action without touching browser', async () => {
  const def = captureRegister(plugin)
  const r = await def.execute({ action: 'nope' })
  assert.equal(r.ok, false)
  assert.match(r.error, /未知 action/)
})

// ── 无会话时的操作给出引导 ───────────────────────────────────────────
test('actions before open return guidance error', async () => {
  const def = captureRegister(plugin)
  // close 无会话也应 ok（幂等）
  assert.equal((await def.execute({ action: 'close' })).ok, true)
  const r = await def.execute({ action: 'snapshot' })
  assert.equal(r.ok, false)
  assert.match(r.error, /先 browser\(\{action:"open"/)
})

// ── 串行队列：并发 execute 按序完成且互不吞错 ────────────────────────
test('serialized queue resolves all and isolates failures', async () => {
  const def = captureRegister(plugin)
  const results = await Promise.all([
    def.execute({ action: 'close' }),
    def.execute({ action: 'bogus' }),
    def.execute({ action: 'close' }),
  ])
  assert.equal(results[0].ok, true)
  assert.equal(results[1].ok, false)
  assert.equal(results[2].ok, true)
})

// ── 安装指引：resolveCore 失败消息含可操作路径 ────────────────────────
test('install guidance is actionable when core missing', () => {
  // 直接调用模块内未导出的 resolveCore 不可行；通过 _test 之外的路径验证：
  // KIX_BROWSER_CORE 指向不存在路径 + 清空 coreLib 缓存后执行 open，应得到安装指引。
  // 这里仅验证消息常量存在于源码（轻量静态断言，防漂移）。
  const src = fs.readFileSync(pluginPath, 'utf8')
  assert.match(src, /playwright-core 未安装或不可解析/)
  assert.match(src, /KIX_BROWSER_CORE/)
  assert.match(src, /npm install playwright-core/)
})

// ── snapshotElements：真实函数引用（字符串函数体在该版 playwright-core 返回 undefined，E2E 实证）──
test('snapshotElements is a real function and extracts from node list', () => {
  assert.equal(typeof plugin._test.snapshotElements, 'function')
  const fake = [
    {
      id: 'go', tagName: 'A', innerText: ' Go ', getAttribute: (k) => (k === 'data-testid' ? null : null),
      previousElementSibling: null,
    },
    {
      id: null, name: 'q', tagName: 'INPUT', value: 'hi', innerText: '', getAttribute: () => null,
      previousElementSibling: { tagName: 'INPUT' },
    },
  ]
  const out = plugin._test.snapshotElements(fake)
  assert.equal(out.length, 2)
  assert.equal(out[0].selector, '#go')
  assert.equal(out[0].text, 'Go')
  assert.equal(out[1].selector, 'input[name="q"]')
  assert.equal(out[1].text, 'hi')
})

// ── 新 action 纯参数校验（会话门禁前置，无需浏览器）──────────────────
test('v2 action validation paths are precise before session gate', async () => {
  const def = captureRegister(plugin)
  assert.match((await def.execute({ action: 'press' })).error, /需要 key/)
  assert.match((await def.execute({ action: 'press', key: 'Enter' })).error, /先 browser/) // 校验过、会话未建
  assert.match((await def.execute({ action: 'select', selector: '#s' })).error, /value 或 values/)
  assert.match((await def.execute({ action: 'select' })).error, /需要 selector/)
  assert.match((await def.execute({ action: 'upload', selector: '#f', files: [] })).error, /files/)
  assert.match((await def.execute({ action: 'upload', selector: '#f', files: ['Z:\\no\\such.png'] })).error, /文件不存在/)
  assert.match((await def.execute({ action: 'wait' })).error, /text 或 selector/)
  assert.match((await def.execute({ action: 'hover' })).error, /需要 selector/)
  assert.match((await def.execute({ action: 'tabs' })).error, /无活动会话/)
})

// ── dialog：策略纯路径（无会话可设可查，非法值拒绝）─────────────────
test('dialog policy validates and persists without session', async () => {
  const def = captureRegister(plugin)
  assert.match((await def.execute({ action: 'dialog', auto: 'bogus' })).error, /accept\/dismiss/)
  const ok = await def.execute({ action: 'dialog', auto: 'accept' })
  assert.equal(ok.ok, true)
  assert.equal(ok.auto, 'accept')
  assert.equal(ok.lastDialog, null)
  // close 复位策略
  await def.execute({ action: 'close' })
  const after = await def.execute({ action: 'dialog' })
  assert.equal(after.auto, 'dismiss')
})

// helper：跑一次 apply 拿到注册的 def（隔离的注册面）
function captureRegister(p) {
  let def = null
  p.apply({
    tools: { register: (d) => ((def = d), () => {}) },
    effect: () => {},
    logger: { info: () => {} },
  })
  return def
}
