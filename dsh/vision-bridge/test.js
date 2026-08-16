'use strict'
// dsh-vision-bridge 纯逻辑回归（v1.2.10 补测试面）：
//   - 凭据读取：env 优先 / ~/.dsh/.credentials.yaml 解析 / 缺失返回 undefined
//   - describeImages：成功路径（调用参数正确 + 结果清理）、HTTP 错误抛错
// 浏览器 client 半依赖 DSH UI 运行时，仍由 ensure-vision-bridge / 双路径 E2E 覆盖。

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

test('module exports server route and apply entry', () => {
  assert.equal(typeof bridge.apply, 'function')
  assert.equal(bridge.name, 'dsh-vision-bridge')
  assert.match(bridge.ROUTE_PATH, /^\/api\//)
})
