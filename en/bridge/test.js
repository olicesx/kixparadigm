'use strict'
// dsh-vision-bridge 纯逻辑回归（v1.2.10 补测试面）：
//   - 凭据读取：env 优先 / ~/.dsh/.credentials.yaml 解析 / 缺失返回 undefined
//   - describeImages：成功路径（调用参数正确 + 结果清理）、HTTP 错误抛错
//   - 注册路由的能力三态与隔离；VM hook driver 执行真实 client submit 和异步失效边界。
// 浏览器真实 dock/宿主提交集成仍需 GUI E2E 补强，测试不调用外部模型。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const bridge = require('./index.js')

test('readCredential: env overrides credentials file', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vision-bridge-cred-'))
  const oldHome = process.env.DSH_HOME
  const oldEnv = process.env.ZAI_CODING_CN_API_KEY
  t.after(() => {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    if (oldEnv === undefined) delete process.env.ZAI_CODING_CN_API_KEY
    else process.env.ZAI_CODING_CN_API_KEY = oldEnv
    fs.rmSync(home, { recursive: true, force: true })
  })
  process.env.DSH_HOME = home
  process.env.ZAI_CODING_CN_API_KEY = 'env-key'
  assert.equal(bridge.readCredential('ZAI_CODING_CN_API_KEY'), 'env-key')
  delete process.env.ZAI_CODING_CN_API_KEY
})

test('readCredential: parses quoted credentials file', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vision-bridge-file-'))
  const oldHome = process.env.DSH_HOME
  const oldEnv = process.env.ZAI_CODING_CN_API_KEY
  t.after(() => {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    if (oldEnv === undefined) delete process.env.ZAI_CODING_CN_API_KEY
    else process.env.ZAI_CODING_CN_API_KEY = oldEnv
    fs.rmSync(home, { recursive: true, force: true })
  })
  delete process.env.ZAI_CODING_CN_API_KEY
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, '.credentials.yaml'), "ZAI_CODING_CN_API_KEY: 'file-key'\n", 'utf8')
  process.env.DSH_HOME = home
  assert.equal(bridge.readCredential('ZAI_CODING_CN_API_KEY'), 'file-key')
  assert.equal(bridge.readCredential('MISSING_KEY'), undefined)
})

test('cleanModelText: strips only a complete code-fence wrapper', () => {
  assert.equal(bridge.cleanModelText('```text\n图片内容是表格\n```'), '图片内容是表格')
  assert.equal(bridge.cleanModelText('正文前\n```text\n代码\n```\n正文后'), '正文前\n```text\n代码\n```\n正文后')
  assert.equal(bridge.cleanModelText('普通文本'), '普通文本')
})

test('describeImages: sends GLM request and returns cleaned text', async (t) => {
  const originalFetch = globalThis.fetch
  let seenUrl = ''
  let seenBody = null
  globalThis.fetch = async (url, options) => {
    seenUrl = String(url)
    seenBody = JSON.parse(options.body)
    return new Response(JSON.stringify({ choices: [{ message: { content: '```text\n图片内容是表格\n```' } }] }), { status: 200 })
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const text = await bridge.describeImages('key', [{ mime: 'image/png', base64: 'AAAA' }], '问题')
  assert.match(seenUrl, /^https:\/\/open\.bigmodel\.cn\//)
  assert.equal(seenBody.model, 'glm-4.6v')
  assert.equal(seenBody.messages[0].content[0].image_url.url, 'data:image/png;base64,AAAA')
  assert.equal(text, '图片内容是表格')
})

test('describeImages: HTTP errors are thrown with status', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('rate limited', { status: 429 })
  t.after(() => { globalThis.fetch = originalFetch })
  await assert.rejects(() => bridge.describeImages('key', [{ mime: 'image/png', base64: 'AAAA' }]), (err) => err.status === 429 && /GLM 429/.test(err.message))
})

// Exercise registered HTTP handlers without opening a port or contacting a provider.
function serverHarness(info, plugin = bridge) {
  const routes = new Map()
  plugin.apply({ get(name) {
    if (name === 'webServer') return { register(route) { routes.set(route.path, route.handler) } }
    if (name === 'llm') return { async resolveModelInfo(provider, model) {
      assert.equal(provider, 'su2api'); assert.equal(model, 'gpt-6-astra')
      if (info instanceof Error) throw info
      return info
    } }
    throw new Error('unexpected service: ' + name)
  } })
  return async (url, body) => {
    const handler = routes.get(url)
    assert.equal(typeof handler, 'function', 'route must actually be registered')
    const req = require('node:stream').Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'
    let status, data
    await handler(req, { writeHead(code) { status = code }, end(text) { data = JSON.parse(text) } })
    return { status, data }
  }
}

test('capabilities route: exact identity, three states, no credentials or inference', async (t) => {
  let credentialReads = 0, externalCalls = 0
  const isolated = { exports: {} }
  require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'), {
    module: isolated, Buffer,
    require(name) { return name === 'node:fs' ? { existsSync() { credentialReads++; throw new Error('credential file forbidden') }, readFileSync() { credentialReads++; throw new Error('credential read forbidden') } } : require(name) },
    process: { env: new Proxy({}, { get() { credentialReads++; throw new Error('credential env forbidden') } }) },
    fetch() { externalCalls++; throw new Error('external fetch forbidden') }
  })
  t.after(() => { assert.equal(credentialReads, 0); assert.equal(externalCalls, 0) })
  for (const [info, expected] of [[{ inputModalities: ['image', 'text'] }, true], [{ inputModalities: ['text'] }, false], [{}, null], [{ inputModalities: [] }, null], [new Error('lookup failed'), null]]) {
    const request = serverHarness(info, isolated.exports)
    const result = await request('/api/dsh-vision-bridge/capabilities', { provider: 'su2api', model: 'gpt-6-astra' })
    assert.deepEqual(result, { status: 200, data: { provider: 'su2api', model: 'gpt-6-astra', supportsImages: expected } })
    assert.equal((await request('/api/dsh-vision-bridge/capabilities', {})).data.supportsImages, null)
    assert.equal((await request('/api/dsh-vision-bridge/capabilities', { provider: 'su2api', model: 'gpt-6-astra', images: [] })).status, 400)
    // Old, unrefreshed pages send only { images }; backend deployment must protect them too.
    const images = [{ base64: 'A'.repeat(12 * 1024 * 1024) }]
    for (const identity of [{}, { provider: 'su2api' }, { model: 'gpt-6-astra' }]) {
      assert.deepEqual(await request('/api/dsh-vision-bridge/describe', { ...identity, images }), { status: 200, data: { mode: 'keep' } })
    }
    if (expected !== false) {
      assert.deepEqual(await request('/api/dsh-vision-bridge/describe', { provider: 'su2api', model: 'gpt-6-astra', images }), { status: 200, data: { mode: 'keep' } })
    }
  }
})

const flush = () => new Promise((resolve) => setImmediate(resolve))
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

// Minimal hook driver runs the actual dock and its installed submit wrapper.
function clientHarness(t, options = {}) {
  const hooks = [], effects = []
  let cursor = 0, exported, snapshot = { status: 'ready', current: { provider: 'su2api', model: 'gpt-6-astra' } }
  const listeners = new Set()
  const seen = { native: 0, reads: 0, draftImages: 0, mutations: [], capabilities: [], describe: [] }
  const files = [{ size: options.size || 10, type: 'image/png' }]
  const directory = { store: { getSnapshot: () => snapshot, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } }, load() { throw new Error('bridge must not load directory') } }
  const React = {
    useRef(value) { const i = cursor++; return hooks[i] || (hooks[i] = { current: value }) },
    useState(value) { const i = cursor++; if (!(i in hooks)) hooks[i] = value; return [hooks[i], (v) => { hooks[i] = v }] },
    useEffect(fn, deps) { const i = cursor++, old = hooks[i]; if (!old || deps.some((d, n) => d !== old.deps[n])) { effects.push(() => { old?.cleanup?.(); hooks[i] = { deps, cleanup: fn() } }) } },
    createElement() { return null }
  }
  const actions = { submit() { seen.native++ }, setDraft(text) { seen.mutations.push(['draft', text]) }, removeImage(id) { seen.mutations.push(['remove', id]) } }
  let props = { sessionId: 's1', input: { imageIds: ['a'], draft: 'question' }, inputActions: actions }
  const ctx = { get(name) {
    if (name === 'modelDirectories') return options.noService ? null : { directoryFor: () => directory }
    if (name === 'conversation') return { draftImages() { seen.draftImages++; return files.map((file) => ({ file })) } }
  } }
  require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load({ factory }) { exported = factory(() => React) } } },
    AbortController, console: { warn() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    FileReader: class { readAsDataURL() { seen.reads++; const done = () => { this.result = 'data:image/png;base64,AAAA'; this.onload() }; if (options.read) options.read.promise.then(done); else done() } },
    async fetch(url, init) {
      const body = JSON.parse(init.body)
      if (url.endsWith('/capabilities')) {
        seen.capabilities.push(body)
        const supportsImages = options.capability ? await options.capability(body, seen.capabilities.length) : options.supportsImages
        return { ok: true, json: async () => ({ ...body, supportsImages: supportsImages ?? null }) }
      }
      seen.describe.push({ body, signal: init.signal })
      const data = options.describe ? await options.describe.promise : { mode: 'describe', text: 'description' }
      return { ok: true, json: async () => data }
    }
  })
  const dock = exported.makeVisionDock(ctx)
  function render(patch = {}) { props = { ...props, ...patch }; cursor = 0; dock(props); effects.splice(0).forEach((fn) => fn()) }
  render()
  t.after(() => { for (const hook of hooks) hook?.cleanup?.() })
  return { seen, actions, render, files, update(patch, notify = true) { snapshot = { ...snapshot, ...patch }; if (notify) listeners.forEach((fn) => fn()) } }
}

test('client: image capability bypasses bridge even above 8MB', async (t) => {
  const h = clientHarness(t, { supportsImages: true, size: 9 * 1024 * 1024 })
  await flush(); h.actions.submit(); await flush()
  assert.equal(h.seen.native, 1)
  assert.equal(h.seen.reads, 0)
  assert.equal(h.seen.draftImages, 0)
  assert.deepEqual(h.seen.describe, [])
  assert.deepEqual(h.seen.mutations, [])
})

test('client: text model converts click with exact current identity', async (t) => {
  const h = clientHarness(t, { supportsImages: false })
  await flush(); h.actions.submit(); await flush()
  assert.equal(h.seen.native, 1)
  assert.deepEqual(h.seen.describe[0].body, { provider: 'su2api', model: 'gpt-6-astra', images: [{ mime: 'image/png', base64: 'AAAA' }] })
  assert.deepEqual(h.seen.mutations, [['draft', 'question\n\n📷 [图片自动识别] description'], ['remove', 'a']])
})

test('client: unknown and unstable selections always use native submit', async (t) => {
  for (const status of ['idle', 'loading', 'selecting', 'error']) {
    const h = clientHarness(t, { supportsImages: false })
    await flush(); h.update({ status }); h.actions.submit(); await flush()
    assert.equal(h.seen.native, 1, status)
    assert.equal(h.seen.reads, 0, status)
  }
  for (const options of [{}, { noService: true }]) {
    const h = clientHarness(t, options)
    await flush(); h.actions.submit(); await flush()
    assert.equal(h.seen.native, 1)
    assert.equal(h.seen.draftImages, 0)
  }
  const h = clientHarness(t, { supportsImages: false })
  await flush(); h.render({ sessionId: null }); h.actions.submit(); await flush()
  assert.equal(h.seen.native, 1)
  assert.equal(h.seen.reads, 0)
})

test('client: same route refresh and late old capability cannot authorize conversion', async (t) => {
  const late = deferred()
  const h = clientHarness(t, { capability: (_, n) => n === 1 ? late.promise : true })
  h.update({ status: 'loading' }); h.update({ status: 'ready' })
  await flush(); late.resolve(false); await flush(); h.actions.submit(); await flush()
  assert.equal(h.seen.capabilities.length, 2)
  assert.equal(h.seen.native, 1)
  assert.equal(h.seen.reads, 0)
  h.update({ current: null, status: 'idle' }) // resetConnected projection
  h.update({ current: { provider: 'su2api', model: 'gpt-6-astra' }, status: 'ready' })
  await flush(); h.actions.submit(); await flush()
  assert.equal(h.seen.capabilities.length, 3)
  assert.equal(h.seen.native, 2)
})

test('client: model change while FileReader waits prevents image POST', async (t) => {
  const read = deferred(), h = clientHarness(t, { supportsImages: false, read })
  await flush(); h.actions.submit()
  h.update({ current: { provider: 'other', model: 'vision' } })
  read.resolve(); await flush()
  assert.equal(h.seen.describe.length, 0)
  assert.equal(h.seen.native, 0)
  assert.deepEqual(h.seen.mutations, [])
})

test('client: in-flight describe cannot mutate changed session, model or attachments', async (t) => {
  for (const change of [h => h.render({ sessionId: 's2' }), h => h.update({ current: { provider: 'other', model: 'image' } }), h => h.render({ input: { imageIds: ['a', 'b'], draft: 'new draft' } }), h => { h.files[0] = { size: 12, type: 'image/png' } }]) {
    const describe = deferred(), h = clientHarness(t, { supportsImages: false, describe })
    await flush(); h.actions.submit(); await flush()
    assert.equal(h.seen.describe.length, 1)
    change(h)
    describe.resolve({ mode: 'describe', text: 'obsolete' }); await flush()
    assert.deepEqual(h.seen.mutations, [])
    assert.equal(h.seen.native, 0)
    assert.equal(h.seen.describe[0].signal.aborted, true)
  }
})

test('describe route: image and unknown metadata keep images before size limit', async () => {
  for (const info of [{ inputModalities: ['image'] }, {}, new Error('lookup failed')]) {
    const request = serverHarness(info)
    assert.deepEqual(await request('/api/dsh-vision-bridge/describe', { provider: 'su2api', model: 'gpt-6-astra', images: [{ base64: 'A'.repeat(12 * 1024 * 1024) }] }), { status: 200, data: { mode: 'keep' } })
    assert.equal((await request('/api/dsh-vision-bridge/describe', { images: [] })).status, 400)
    assert.equal((await request('/api/dsh-vision-bridge/describe', { images: [{ base64: 'AAAA' }], visionModel: 'arbitrary-model' })).status, 400)
  }
})

test('client: submit rereads snapshot even before subscription notification', async (t) => {
  const h = clientHarness(t, { supportsImages: false })
  await flush(); h.update({ status: 'selecting' }, false); h.actions.submit(); await flush()
  assert.equal(h.seen.native, 1)
  assert.equal(h.seen.draftImages, 0)
})

test('client: image exemption precedes busy guard from earlier text conversion', async (t) => {
  const describe = deferred()
  const h = clientHarness(t, { describe, capability: ({ model }) => model === 'vision' })
  await flush(); h.actions.submit(); await flush()
  h.update({ current: { provider: 'other', model: 'vision' } }); await flush()
  const before = h.seen.draftImages
  h.actions.submit()
  assert.equal(h.seen.native, 1)
  assert.equal(h.seen.draftImages, before)
  assert.equal(h.seen.describe.length, 1)
  describe.resolve({ mode: 'describe', text: 'old' }); await flush()
  assert.deepEqual(h.seen.mutations, [])
  assert.equal(h.seen.native, 1)
})

test('client: failures retain originals and text-only 8MB limit remains', async (t) => {
  const h = clientHarness(t, { supportsImages: false, size: 9 * 1024 * 1024 })
  await flush(); h.actions.submit(); await flush()
  assert.equal(h.seen.native, 0); assert.equal(h.seen.reads, 0); assert.deepEqual(h.seen.mutations, [])
  const describe = deferred(), failed = clientHarness(t, { supportsImages: false, describe })
  await flush(); failed.actions.submit(); await flush()
  describe.resolve({ error: 'failed' }); await flush()
  assert.equal(failed.seen.native, 0); assert.deepEqual(failed.seen.mutations, [])
  const unknown = clientHarness(t, { capability() { throw new Error('metadata unavailable') } })
  await flush(); unknown.actions.submit(); await flush()
  assert.equal(unknown.seen.native, 1); assert.equal(unknown.seen.reads, 0)
})

test('client: attachment changes during FileReader and ABA edits preserve all images', async (t) => {
  for (const revert of [false, true]) {
    const read = deferred(), h = clientHarness(t, { supportsImages: false, read })
    await flush(); h.actions.submit()
    h.render({ input: { imageIds: ['a', 'b'], draft: 'new' } })
    if (revert) h.render({ input: { imageIds: ['a'], draft: 'new' } })
    read.resolve(); await flush()
    assert.equal(h.seen.describe.length, 0)
    assert.equal(h.seen.native, 0)
    assert.deepEqual(h.seen.mutations, [])
  }
})

test('client: stable attachments retain text typed during conversion', async (t) => {
  const describe = deferred(), h = clientHarness(t, { supportsImages: false, describe })
  await flush(); h.actions.submit(); await flush()
  h.render({ input: { imageIds: ['a'], draft: 'latest text' } })
  describe.resolve({ mode: 'describe', text: 'result' }); await flush()
  assert.equal(h.seen.native, 1)
  assert.deepEqual(h.seen.mutations, [['draft', 'latest text\n\n📷 [图片自动识别] result'], ['remove', 'a']])
})

test('client: partially ready attachment collection must not delete unread images', async (t) => {
  const h = clientHarness(t, { supportsImages: false })
  h.render({ input: { imageIds: ['a', 'still-uploading'], draft: 'question' } })
  await flush(); h.actions.submit(); await flush()
  assert.equal(h.seen.describe.length, 0)
  assert.equal(h.seen.native, 0)
  assert.deepEqual(h.seen.mutations, [])
})

test('module exports server route and apply entry', () => {
  assert.equal(typeof bridge.apply, 'function')
  assert.equal(bridge.name, 'dsh-vision-bridge')
  assert.match(bridge.ROUTE_PATH, /^\/api\//)
})
