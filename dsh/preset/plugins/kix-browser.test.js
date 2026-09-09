'use strict'
// kix-browser.test.js — 单测：URL 门禁/action 校验/文本截断/插件形状/串行队列语义
//   + 会话隔离回归（2026-09-09：不同 agent/apply 互不导航/关闭）。
// 默认不依赖真浏览器：隔离测试用 KIX_BROWSER_CORE 指向本文件生成的 fake
// playwright-core（launch/connectOverCDP 语义镜像：CDP 断连不关真实页面）。
// 真浏览器 smoke 为 opt-in：KIX_BROWSER_SMOKE=1 node --test kix-browser.test.js。

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const pluginPath = path.join(__dirname, 'kix-browser.js')

// ── fake playwright-core（隔离测试的确定性 seam）────────────────────────
// 写入临时目录，经 KIX_BROWSER_CORE 注入；plugin 的 resolveCore 优先读它。
const fakeCoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kix-browser-fake-core-'))
const fakeCorePath = path.join(fakeCoreDir, 'playwright-core', 'index.js')
fs.mkdirSync(path.dirname(fakeCorePath), { recursive: true })
fs.writeFileSync(fakeCorePath, `'use strict'
const state = {
  launchCalls: 0,
  connectCalls: 0,
  browsers: [],
  connections: [],
  realPages: [],      // 共享“真实浏览器”已有 tab（CDP 借用面）
  hangNextGoto: false,
  releaseHang: null,
}
let pageSeq = 0
function makePage(url0) {
  return {
    __id: ++pageSeq,
    __url: url0 || 'about:blank',
    __closed: false,
    __handlers: {},
    url() { return this.__url },
    async title() { return 'fake:' + this.__id },
    async goto(u) {
      if (state.hangNextGoto) {
        state.hangNextGoto = false
        await new Promise((r) => { state.releaseHang = r })
      }
      this.__url = u
      return { status: () => 200 }
    },
    async evaluate() { return 'body ' + this.__id },
    async $$eval(_sel, fn) {
      const node = { id: 'fake-root', tagName: 'BUTTON', innerText: 'ok', value: '', getAttribute: () => null, previousElementSibling: null }
      return fn([node])
    },
    locator() { return { first: () => ({ click: async () => {}, fill: async () => {}, hover: async () => {}, selectOption: async () => {}, setInputFiles: async () => {}, waitFor: async () => {} }) } },
    getByText() { return { first: () => ({ waitFor: async () => {} }) } },
    async waitForSelector() {},
    keyboard: { async press() {} },
    async goBack() { return { status: () => 200 } },
    async goForward() { return { status: () => 200 } },
    async reload() { return { status: () => 200 } },
    async screenshot() {},
    async bringToFront() {},
    on(ev, h) { this.__handlers[ev] = h },
    async close() { this.__closed = true },
  }
}
const realCtx = {
  pages: () => state.realPages,
  newPage: async () => { const p = makePage('about:blank'); state.realPages.push(p); return p },
}
async function launch() {
  state.launchCalls++
  const pages = []
  const ctx = { pages: () => pages, newPage: async () => { const p = makePage(); pages.push(p); return p } }
  const browser = {
    __kind: 'launch', __pages: pages, __closed: false,
    contexts: () => [ctx],
    newPage: async () => ctx.newPage(),
    async close() { this.__closed = true; for (const p of pages) p.__closed = true },
  }
  state.browsers.push(browser)
  return browser
}
async function connectOverCDP() {
  state.connectCalls++
  const conn = {
    __kind: 'cdp', __closed: false,
    contexts: () => [realCtx],
    newPage: () => realCtx.newPage(),
    async close() { this.__closed = true },
  }
  state.connections.push(conn)
  return conn
}
module.exports = { chromium: { launch, connectOverCDP }, __state: state, __makePage: makePage }
`, 'utf8')
process.env.KIX_BROWSER_CORE = fakeCorePath
process.env.KIX_BROWSER_CDP = ''
const fake = require(fakeCorePath)

const plugin = require(pluginPath)
process.on('exit', () => { try { fs.rmSync(fakeCoreDir, { recursive: true, force: true }) } catch { /* 忽略 */ } })

/** 调用上下文：agent + session（owner key 优先 session.id）。 */
function execOf(agentId, sessionId) {
  return { agent: { id: agentId, ...(sessionId ? { session: { id: sessionId } } : {}) } }
}
/** 一个独立 apply 实例（镜像 cordis effect 语义：回调立即执行，返回值是卸载钩子）。 */
function applyInstance(p, config) {
  let def = null
  const teardowns = []
  p.apply({
    tools: { register: (d) => { def = d; return () => {} } },
    effect: (fn) => teardowns.push(fn()),
    logger: { info: () => {} },
  }, config)
  return { def, teardown: () => teardowns.forEach((fn) => fn()) }
}

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

// ══ 会话隔离回归（2026-09-09）══════════════════════════════════════════
// 真实症状：主线程 browser.open 当前 GUI + snapshot 成功后，另一会话审计
// browser 时 type 报「无活动页面」——browser/page/queue/dialog 全是模块级
// 单例，execute 忽略 exec 上下文，任一会话 close 关掉所有人的浏览器。
// 以下用 fake core 钉死：owner = session.id || agent.id；无 agent → 每 apply
// 私有 fallback；卸载只清自己。
const openA = (def, exec, url = 'about:blank') => def.execute({ action: 'open', url }, exec)

test('isolation: two agents in one apply get separate browsers and pages', async () => {
  const { def } = applyInstance(plugin)
  const before = fake.__state.launchCalls
  const a = await openA(def, execOf('agent-a'))
  const b = await openA(def, execOf('agent-b'))
  assert.equal(a.ok, true, a.error)
  assert.equal(b.ok, true, b.error)
  assert.equal(fake.__state.launchCalls - before, 2, '每个 owner 各自建立会话（不得复用同一 browser）')
  const sa = await def.execute({ action: 'snapshot' }, execOf('agent-a'))
  const sb = await def.execute({ action: 'snapshot' }, execOf('agent-b'))
  assert.equal(sa.ok, true, sa.error)
  assert.equal(sb.ok, true, sb.error)
  await def.execute({ action: 'close' }, execOf('agent-a'))
  const sb2 = await def.execute({ action: 'snapshot' }, execOf('agent-b'))
  assert.equal(sb2.ok, true, 'A 的 close 不得影响 B（原症状：无活动页面）')
  const sa2 = await def.execute({ action: 'snapshot' }, execOf('agent-a'))
  assert.equal(sa2.ok, false, 'A 自己 close 后应无活动页面')
  await def.execute({ action: 'close' }, execOf('agent-b'))
})

test('isolation: same session id shares one owner session across agents', async () => {
  const { def } = applyInstance(plugin)
  const before = fake.__state.launchCalls
  const a = await openA(def, execOf('agent-x', 'shared-session'))
  const b = await openA(def, execOf('agent-y', 'shared-session'))
  assert.equal(a.ok, true, a.error)
  assert.equal(b.ok, true, b.error)
  assert.equal(fake.__state.launchCalls - before, 1, '同一 session 复用同一会话')
  await def.execute({ action: 'close' }, execOf('agent-x', 'shared-session'))
  assert.equal((await def.execute({ action: 'snapshot' }, execOf('agent-y', 'shared-session'))).ok, false)
})

test('isolation: two apply instances of the same module do not share sessions', async () => {
  const a = applyInstance(plugin)
  const b = applyInstance(plugin)
  assert.equal((await openA(a.def, execOf('preset-owner'))).ok, true)
  assert.equal((await openA(b.def, execOf('preset-owner'))).ok, true)
  await a.def.execute({ action: 'close' }, execOf('preset-owner'))
  const sb = await b.def.execute({ action: 'snapshot' }, execOf('preset-owner'))
  assert.equal(sb.ok, true, 'A 实例的 close 不得影响 B 实例')
  await b.def.execute({ action: 'close' }, execOf('preset-owner'))
})

test('isolation: no-agent calls use a per-apply private fallback session', async () => {
  const a = applyInstance(plugin)
  const b = applyInstance(plugin)
  assert.equal((await openA(a.def, undefined)).ok, true)
  assert.equal((await openA(b.def, undefined)).ok, true)
  await a.def.execute({ action: 'close' })
  const sb = await b.def.execute({ action: 'snapshot' })
  assert.equal(sb.ok, true, '无 agent 的 fallback 也必须每 apply 私有')
  await b.def.execute({ action: 'close' })
})

test('isolation: dialog policy and lastDialog are per owner', async () => {
  const { def } = applyInstance(plugin)
  assert.equal((await def.execute({ action: 'dialog', auto: 'accept' }, execOf('dlg-a'))).ok, true)
  const b = await def.execute({ action: 'dialog' }, execOf('dlg-b'))
  assert.equal(b.auto, 'dismiss', 'B 的弹窗策略不得被 A 改')
  const a = await def.execute({ action: 'dialog' }, execOf('dlg-a'))
  assert.equal(a.auto, 'accept')
  assert.equal(a.lastDialog, null)
})

test('isolation: a hung owner does not block another owner (per-owner queue)', async () => {
  const { def } = applyInstance(plugin)
  fake.__state.hangNextGoto = true
  const hung = openA(def, execOf('queue-a'))
  try {
    await new Promise((r) => setTimeout(r, 20)) // 让 A 的调用进入队列并挂住
    const raced = await Promise.race([
      openA(def, execOf('queue-b')),
      new Promise((r) => setTimeout(() => r({ ok: false, error: 'blocked-by-other-owner' }), 2000)),
    ])
    assert.equal(raced.ok, true, `B 不得被 A 的挂起调用阻塞：${raced.error}`)
  } finally {
    if (fake.__state.releaseHang) fake.__state.releaseHang()
    await hung.catch(() => {})
    await def.execute({ action: 'close' }, execOf('queue-a'))
    await def.execute({ action: 'close' }, execOf('queue-b'))
  }
})

test('isolation: unmount closes only that apply instance sessions', async () => {
  const a = applyInstance(plugin)
  const b = applyInstance(plugin)
  assert.equal((await openA(a.def, execOf('unmount-owner'))).ok, true)
  assert.equal((await openA(b.def, execOf('unmount-owner'))).ok, true)
  a.teardown()
  await new Promise((r) => setTimeout(r, 10))
  const sb = await b.def.execute({ action: 'snapshot' }, execOf('unmount-owner'))
  assert.equal(sb.ok, true, 'A 卸载不得关掉 B 的会话')
  const sa = await a.def.execute({ action: 'snapshot' }, execOf('unmount-owner'))
  assert.equal(sa.ok, false, 'A 卸载后自己不再有会话')
  await b.def.execute({ action: 'close' }, execOf('unmount-owner'))
})

// ── CDP：独立会话各自开 tab（保留同 context 登录态），借用页生命周期只读 ──
test('CDP: each owner opens its own tab and never auto-borrows an existing one', async () => {
  process.env.KIX_BROWSER_CDP = 'http://127.0.0.1:9222'
  try {
    const borrowed = fake.__makePage('https://user.example.test/keep')
    fake.__state.realPages.push(borrowed) // 真实浏览器里已有页面（主线程/用户）
    const { def } = applyInstance(plugin)
    const connBefore = fake.__state.connectCalls
    const a = await openA(def, execOf('cdp-a'))
    const b = await openA(def, execOf('cdp-b'))
    assert.equal(a.ok, true, a.error)
    assert.equal(b.ok, true, b.error)
    assert.equal(a.mode, 'cdp')
    assert.equal(b.mode, 'cdp')
    assert.equal(fake.__state.connectCalls - connBefore, 2, '每个 owner 各自连接（close 只断自己）')
    const own = fake.__state.realPages.filter((p) => p !== borrowed)
    assert.equal(own.length, 2, '每个 owner 各自新建 tab（不得自动共享同一 tab）')
    assert.notEqual(own[0], own[1])
    assert.equal(borrowed.__url, 'https://user.example.test/keep', '已有页面不得被导航')

    const list = await def.execute({ action: 'tabs' }, execOf('cdp-a'))
    assert.equal(list.ok, true, list.error)
    assert.equal(list.tabs[0].owned, false, '借用页标记为 not owned')
    assert.ok(list.tabs.some((t) => t.owned === true), '自有 tab 标记为 owned')
    assert.equal(list.tabs[0].url, 'https://user.example.test/keep')

    const sw = await def.execute({ action: 'tabs', switch: 0 }, execOf('cdp-a'))
    assert.equal(sw.ok, true, sw.error)
    assert.equal(sw.owned, false)
    assert.equal(sw.url, 'https://user.example.test/keep')

    await def.execute({ action: 'close' }, execOf('cdp-a'))
    assert.equal(borrowed.__closed, false, 'close 不得关闭借用页（别人的 tab）')
    assert.equal(own[0].__closed || own[1].__closed, true, 'close 回收本会话自有 tab')
    assert.equal(fake.__state.connections.filter((c) => c.__closed).length >= 1, true, '只断开自己的连接')

    const listB = await def.execute({ action: 'tabs' }, execOf('cdp-b'))
    assert.equal(listB.ok, true, 'B 的会话不受 A 的 close 影响')
    await def.execute({ action: 'close' }, execOf('cdp-b'))
    assert.equal(borrowed.__closed, false)
  } finally {
    process.env.KIX_BROWSER_CDP = ''
  }
})

// ── 真浏览器 smoke（opt-in）：两个 owner 各自 launch，close 互不影响 ─────
test('real smoke: two owners isolated with real chromium (KIX_BROWSER_SMOKE=1)', { skip: process.env.KIX_BROWSER_SMOKE !== '1' }, () => {
  const core = process.env.KIX_BROWSER_REAL_CORE || '/root/.dsh/node_modules/playwright-core'
  const script = `
const assert = require('node:assert')
const plugin = require(${JSON.stringify(pluginPath)})
let def = null
plugin.apply({ tools: { register: (d) => ((def = d), () => {}) }, effect: () => {}, logger: { info: () => {} } })
const execOf = (id) => ({ agent: { id } })
;(async () => {
  const a = await def.execute({ action: 'open', url: 'about:blank' }, execOf('smoke-a'))
  assert.equal(a.ok, true, 'A open: ' + a.error)
  const b = await def.execute({ action: 'open', url: 'about:blank' }, execOf('smoke-b'))
  assert.equal(b.ok, true, 'B open: ' + b.error)
  assert.equal(a.mode, 'launch')
  assert.equal((await def.execute({ action: 'snapshot' }, execOf('smoke-a'))).ok, true)
  assert.equal((await def.execute({ action: 'snapshot' }, execOf('smoke-b'))).ok, true)
  await def.execute({ action: 'close' }, execOf('smoke-a'))
  const sb = await def.execute({ action: 'snapshot' }, execOf('smoke-b'))
  assert.equal(sb.ok, true, 'B 被 A 的 close 影响：' + sb.error)
  const sa = await def.execute({ action: 'snapshot' }, execOf('smoke-a'))
  assert.equal(sa.ok, false)
  const tabsB = await def.execute({ action: 'tabs' }, execOf('smoke-b'))
  assert.equal(tabsB.ok, true, 'B tabs: ' + tabsB.error)
  await def.execute({ action: 'close' }, execOf('smoke-b'))
  console.log(JSON.stringify({ ok: true, aMode: a.mode, bMode: b.mode, bTabs: tabsB.tabs.length, aErrorAfterClose: sa.error }))
})().catch((e) => { console.error(e && e.stack || e); process.exit(1) })
`
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, KIX_BROWSER_CORE: core, KIX_BROWSER_CDP: '', KIX_BROWSER_HEADLESS: 'true' },
  })
  assert.equal(r.status, 0, `real smoke failed:\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /"ok":true/)
})
