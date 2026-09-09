'use strict'

// kix-webhook 单元测试（2026-09-09）
//
// 测的是 decide() 的行为面：投递 → 会话请求（或 null）。不 mock webhookRuntime 的
// 内部实现，只验证本插件自己的规则层（事件匹配/忽略名单/并发闸/插值/绝对路径闸）。
// 真实链路（签名 HTTP → dispatch → 起会话 → 模型执行）由部署侧 E2E 覆盖，
// 见插件头部注释的 2026-09-09 实测记录。

const assert = require('node:assert/strict')
const { test } = require('node:test')
const plugin = require('./kix-webhook.js')

function delivery(overrides = {}) {
  const { name = 'pull_request', action = 'opened', payload = {}, ...rest } = overrides
  return {
    kind: 'github',
    source: 'primary-github',
    deliveryId: 'delivery-1',
    receivedAt: 1_788_900_000_000,
    event: {
      name,
      payload: {
        action,
        pull_request: { number: 42, title: 'add webhook bridge', html_url: 'https://github.com/o/r/pull/42' },
        repository: { full_name: 'o/r' },
        sender: { login: 'alice' },
        ...payload,
      },
    },
    ...rest,
  }
}

const baseConfig = { enabled: true, workspacePath: '/tmp/ws', maxSessions: 1 }

test('disabled config never starts a session', () => {
  assert.equal(plugin.decide(delivery(), { ...baseConfig, enabled: false }, { started: 0 }), null)
})

test('workspacePath must be absolute', () => {
  assert.equal(plugin.decide(delivery(), { ...baseConfig, workspacePath: 'relative/path' }, { started: 0 }), null)
  assert.equal(plugin.decide(delivery(), { ...baseConfig, workspacePath: undefined }, { started: 0 }), null)
  assert.ok(plugin.decide(delivery(), { ...baseConfig, workspacePath: 'C:\\ws' }, { started: 0 }))
})

test('default events are pull_request.opened and issues.opened', () => {
  assert.ok(plugin.decide(delivery(), baseConfig, { started: 0 }))
  assert.ok(plugin.decide(delivery({ name: 'issues' }), baseConfig, { started: 0 }))
  assert.equal(plugin.decide(delivery({ action: 'closed' }), baseConfig, { started: 0 }), null)
  assert.equal(plugin.decide(delivery({ name: 'push', action: undefined }), baseConfig, { started: 0 }), null)
})

test('event patterns support prefix/suffix wildcards', () => {
  const cfg = { ...baseConfig, events: ['pull_request.*'] }
  assert.ok(plugin.decide(delivery({ action: 'synchronize' }), cfg, { started: 0 }))
  assert.equal(plugin.decide(delivery({ name: 'issues' }), cfg, { started: 0 }), null)
})

test('bot senders are ignored by default', () => {
  const bot = delivery({ payload: { sender: { login: 'dependabot[bot]' } } })
  assert.equal(plugin.decide(bot, baseConfig, { started: 0 }), null)
  assert.ok(plugin.decide(delivery({ payload: { sender: { login: 'alice' } } }), baseConfig, { started: 0 }))
})

test('maxSessions acts as a fuse', () => {
  assert.equal(plugin.decide(delivery(), baseConfig, { started: 1 }), null)
  assert.ok(plugin.decide(delivery(), { ...baseConfig, maxSessions: 2 }, { started: 1 }))
  assert.equal(plugin.decide(delivery(), { ...baseConfig, maxSessions: 0 }, { started: 0 }), null)
})

test('request carries the configured preset surface and a rendered title', () => {
  const request = plugin.decide(delivery(), baseConfig, { started: 0 })
  assert.equal(request.workspacePath, '/tmp/ws')
  assert.equal(request.agentPreset, 'kixparadigm')
  assert.equal(request.permissionPreset, 'danger-full-access')
  assert.equal(request.title, 'pull_request#42 add webhook bridge')
  assert.match(request.prompt, /pull_request/)
  assert.match(request.prompt, /o\/r/)
})

test('promptTemplate interpolates delivery context and keeps unknown keys literal', () => {
  const rendered = plugin.renderTemplate('{{event}} {{action}} {{number}} {{missing}}', {
    event: 'issues', action: 'opened', number: '7',
  })
  assert.equal(rendered, 'issues opened 7 {{missing}}')
})

test('malformed deliveries are ignored instead of throwing', () => {
  assert.equal(plugin.decide(null, baseConfig, { started: 0 }), null)
  assert.equal(plugin.decide({}, baseConfig, { started: 0 }), null)
  assert.equal(plugin.decide({ event: {} }, baseConfig, { started: 0 }), null)
})

test('apply while disabled returns before injecting (no service lookup, one log)', () => {
  const logs = []
  const ctx = {
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), debug: () => {} },
    inject: () => { throw new Error('should not inject while disabled') },
  }
  plugin.apply(ctx, { enabled: false })
  assert.equal(logs.length, 1)
  assert.match(logs[0][1], /disabled/)
  // 提示必须指向**预设行**（profile patch 覆盖不到 preset 内部行，实测 2026-09-09）
  assert.match(logs[0][1], /PRESET row/)
})

// enabled=true 但宿主没有 webhookRuntime（0.1.1 及更早）时：插件不得抛错，
// 只调用一次 inject 并就此停住（cordis 语义：依赖未满足的 fiber 保持 pending，
// 服务出现后再执行回调）。本用例只证明「不抛错 + 恰好一次 inject + 无注册」；
// 真正的 pending→恢复语义属宿主 cordis，不在本单测覆盖范围内。
test('apply with enabled=true but no webhookRuntime stays pending without throwing', () => {
  const logs = []
  const injects = []
  const ctx = {
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), debug: () => {} },
    inject: (services, cb) => { injects.push(services); return { dispose() {} } },
  }
  assert.doesNotThrow(() => plugin.apply(ctx, { enabled: true, workspacePath: '/tmp/ws' }))
  assert.equal(injects.length, 1)
  assert.deepEqual(injects[0], ['webhookRuntime'])
  assert.equal(logs.length, 0)
})

test('apply refuses a non-absolute workspacePath before injecting', () => {
  const logs = []
  let injected = false
  const ctx = {
    logger: { info: () => {}, warn: (m) => logs.push(m), debug: () => {} },
    inject: () => { injected = true },
  }
  plugin.apply(ctx, { enabled: true, workspacePath: 'relative' })
  assert.equal(injected, false)
  assert.match(logs[0], /absolute/)
})

test('apply registers a github rule that honours the session fuse', () => {
  const registered = []
  const scope = {
    effect: (fn) => { fn(); return () => {} },
    webhookRuntime: { register: (rule) => { registered.push(rule); return () => {} } },
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    inject: (services, cb) => { assert.deepEqual(services, ['webhookRuntime']); cb(scope) },
  }
  plugin.apply(ctx, { enabled: true, workspacePath: '/tmp/ws', maxSessions: 1 })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'kix-webhook')
  assert.equal(registered[0].kind, 'github')
  assert.ok(registered[0].run(delivery(), new AbortController().signal))
  assert.equal(registered[0].run(delivery(), new AbortController().signal), null)
})
