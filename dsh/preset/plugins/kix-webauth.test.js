'use strict'

// kix-webauth 单元测试（2026-09-09）
//
// 测的是本插件自己的判定面：什么时候接管 `ctx.connection` 的三个认证入口，以及接管后
// 回环/非回环请求各自走哪条路。不启动真实 web 服务、不碰运行中的 dsh 进程——真实链路
// （重启后无 token 打开 GUI + /api 调用）由用户在重启后验收，见插件头部注释。

const assert = require('node:assert/strict')
const { test } = require('node:test')
const plugin = require('../patches/kix-webauth.js')

// 上游 HostConnectionService 的最小替身：按 Host 复刻真实行为（evil.com → 403 栅栏，
// 无 cookie → 401，有 cookie → 放行），用于验证"我们只吞 401、不吞 403"。
function fakeConnection() {
  return {
    calls: { requestRejection: 0, authorizeIndex: 0, authenticatedUrl: 0 },
    requestRejection(request) {
      this.calls.requestRejection += 1
      const host = plugin.requestHostname(request)
      if (host === 'evil.example') return 403
      const cookie = request.headers.cookie
      return typeof cookie === 'string' && cookie.length > 0 ? undefined : 401
    },
    authorizeIndex() {
      this.calls.authorizeIndex += 1
      return false
    },
    authenticatedUrl(baseUrl) {
      this.calls.authenticatedUrl += 1
      return `${baseUrl.replace(/\/$/, '')}/?token=upstream-launch-token`
    },
  }
}

function fakeCtx({ bindHost = '127.0.0.1', connection = fakeConnection() } = {}) {
  const logs = []
  const ctx = {
    logger: { info: (m) => logs.push(m), warn: () => {}, debug: () => {} },
    inject: (services, cb) => {
      assert.deepEqual(services, ['connection', 'webServer'])
      cb({ connection, webServer: { host: bindHost } })
    },
  }
  return { ctx, connection, logs }
}

const req = (host, cookie) => ({ method: 'GET', url: '/', headers: { host, ...(cookie ? { cookie } : {}) } })

test('loopback hostname classification matches upstream rules', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '[::1]', '::1', 'LOCALHOST']) {
    assert.equal(plugin.isLoopbackHostname(host), true, `${host} should be loopback`)
  }
  for (const host of ['0.0.0.0', '128.0.0.1', '127.0.0.256', 'evil.example', '127.0.0', '', undefined, 42]) {
    assert.equal(plugin.isLoopbackHostname(host), false, `${String(host)} should not be loopback`)
  }
})

test('requestHostname reads node:http and fetch header shapes', () => {
  assert.equal(plugin.requestHostname(req('127.0.0.1:3080')), '127.0.0.1')
  assert.equal(plugin.requestHostname(req('[::1]:3080')), '[::1]')
  assert.equal(plugin.requestHostname({ headers: new Headers({ host: 'localhost:3080' }) }), 'localhost')
  assert.equal(plugin.requestHostname({ headers: {} }), undefined)
  assert.equal(plugin.requestHostname({ headers: { host: 'not a host' } }), undefined)
  assert.equal(plugin.requestHostname(undefined), undefined)
})

test('cleanUrl strips path, query and hash without touching authority', () => {
  assert.equal(plugin.cleanUrl('http://127.0.0.1:3080/?token=abc#x'), 'http://127.0.0.1:3080/')
  assert.equal(plugin.cleanUrl('http://127.0.0.1:3080/some/path'), 'http://127.0.0.1:3080/')
})

test('loopback deployment: 401 becomes a pass, 403 fence survives', () => {
  const { ctx, connection } = fakeCtx()
  plugin.apply(ctx)

  assert.equal(connection.requestRejection(req('127.0.0.1:3080')), undefined)
  assert.equal(connection.requestRejection(req('localhost:3080')), undefined)
  assert.equal(connection.requestRejection(req('evil.example')), 403)
  assert.equal(connection.requestRejection(req('192.168.1.9:3080')), 401)
  assert.equal(connection.calls.requestRejection, 4, '原始判定仍被调用（不短路栅栏）')
})

test('loopback deployment: index passes without token, LAN index keeps upstream', () => {
  const { ctx, connection } = fakeCtx()
  plugin.apply(ctx)
  const res = { writeHead: () => {}, end: () => {} }

  assert.equal(connection.authorizeIndex(req('127.0.0.1:3080'), res), true)
  assert.equal(connection.authorizeIndex(req('192.168.1.9:3080'), res), false)
  assert.equal(connection.calls.authorizeIndex, 1, '非回环才走上游授权')
})

test('loopback deployment: printed url loses the token, LAN url keeps it', () => {
  const { ctx, connection } = fakeCtx()
  plugin.apply(ctx)

  assert.equal(connection.authenticatedUrl('http://127.0.0.1:3080'), 'http://127.0.0.1:3080/')
  assert.equal(
    connection.authenticatedUrl('http://192.168.1.9:3080'),
    'http://192.168.1.9:3080/?token=upstream-launch-token',
  )
  assert.equal(connection.calls.authenticatedUrl, 1)
})

test('non-loopback bind keeps upstream auth untouched', () => {
  const { ctx, connection, logs } = fakeCtx({ bindHost: '0.0.0.0' })
  plugin.apply(ctx)

  assert.equal(connection.requestRejection(req('127.0.0.1:3080')), 401)
  assert.equal(connection.authorizeIndex(req('127.0.0.1:3080'), {}), false)
  assert.equal(
    connection.authenticatedUrl('http://127.0.0.1:3080'),
    'http://127.0.0.1:3080/?token=upstream-launch-token',
  )
  assert.equal(logs.length, 1)
  assert.match(logs[0], /不是回环/)
})

test('apply is idempotent for the same service instance', () => {
  const { ctx, connection } = fakeCtx()
  plugin.apply(ctx)
  const once = connection.requestRejection
  plugin.apply(ctx)
  assert.equal(connection.requestRejection, once)
  assert.equal(connection.requestRejection(req('127.0.0.1:3080')), undefined)
})

test('a replaced service instance is overridden again', () => {
  const first = fakeCtx()
  plugin.apply(first.ctx)
  const second = fakeCtx()
  plugin.apply(second.ctx)

  assert.equal(first.connection.requestRejection(req('127.0.0.1:3080')), undefined)
  assert.equal(second.connection.requestRejection(req('127.0.0.1:3080')), undefined)
  assert.equal(second.connection.authenticatedUrl('http://127.0.0.1:3080'), 'http://127.0.0.1:3080/')
})
