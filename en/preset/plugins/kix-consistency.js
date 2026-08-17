// kix-consistency — 一致性守护写时拦截（2026-08-17，PLUGINIZATION-ROADMAP P5 落地）
//
// 背景：check-dsh-consistency.cjs 只在 CI/npm test 期校验——改 dsh/preset/ 文件时
// 不实时拦截，drift（zh/en 不同步、persona 超预算、计数失同步）要等下次测试才暴露。
// 本插件把「唯一事实源」约定从自觉变机械：写 preset 相关文件时跑**相关子检查**，
// 失败 → remind（放行 + 注入提醒，文档可回滚不 deny）。
//
// 单一事实源：检查逻辑全部在 ./consistency-lib.cjs（zh/en 字节一致共享）；
// CI 脚本与本插件共用同一实现——不复制断言，防「CI 一套、运行时一套」双源漂移。
//
// 触发面（限制越少越好）：仅「kixparadigm 源仓库指纹」工作区（workspaceRoot 含
// dsh/preset + en/preset + scripts/check-dsh-consistency.cjs）的 preset 区域写入。
// 其余工作区/路径零开销放行。
//
// 强度：默认 remind；ask/block 需 agent.cordis.yml 显式配置。remindOnce：
// 每会话每类别一次（persona/plugins/memories/readme/package/vision/misc）。
//
// 挂载：agent.cordis.yml 一行：
//   - id: kix-consistency
//     name: ./plugins/kix-consistency.js
// 测试：node plugins/kix-consistency.test.js

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const lib = require('./consistency-lib.cjs')

const MUTATION_TOOLS = new Set(['edit', 'write'])

const PERSONA_BUDGET = {
  zh: { maxChars: 4500, maxEstTokens: 2600 },
  en: { maxChars: 9500, maxEstTokens: 2600 },
}

// ── 纯判定函数（模块级：单元测试经 __internals 直接验证）─────────────────

// kixparadigm 源仓库指纹：preset 双份 + scripts 全量入口同时存在。
function isRepoRoot(root) {
  if (!root || typeof root !== 'string') return false
  return fs.existsSync(path.join(root, 'dsh/preset/agent.cordis.yml')) &&
    fs.existsSync(path.join(root, 'en/preset/agent.cordis.yml')) &&
    fs.existsSync(path.join(root, 'scripts/check-dsh-consistency.cjs'))
}

// write/edit 的 file_path 可能是绝对路径、带 ./ 的相对路径、或 Windows 盘符路径。
// 先相对 workspaceRoot 归一成仓库相对正斜杠路径，classifyWrite 才不会因写法静默失效。
function toRepoRel(root, filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return ''
  const raw = filePath.replace(/\\/g, '/')
  if (!root) return raw.replace(/^\.\//, '')
  const abs = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(root, filePath)
  const rootAbs = path.resolve(root)
  const rel = path.relative(rootAbs, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return raw.replace(/^\.\//, '')
  return rel.replace(/\\/g, '/')
}

// 写入路径 → 提醒类别（remindOnce 粒度；非 preset 区域返回 null，零开销放行）
// 插件文件匹配 .js/.cjs——与 lib.pluginNames() 的 CI 动态清单同口径：
// consistency-lib.cjs 这类共享库源码同样受写时守护（否则「唯一事实源」自身裸奔）
function classifyWrite(rel) {
  const p = String(rel || '').replace(/\\/g, '/')
  if (p === 'dsh/preset/agent.cordis.yml' || p === 'en/preset/agent.cordis.yml') return 'persona'
  if (/^(?:dsh\/preset|en\/preset)\/plugins\/[^/]+\.(?:js|cjs)$/.test(p)) return 'plugins'
  if (/^(?:dsh\/preset|en\/preset)\/memories\//.test(p)) return 'memories'
  if (p === 'README.md' || p === 'README.en.md') return 'readme'
  if (p === 'package.json' || p === 'en/package.json') return 'package'
  if (/^dsh\/vision-bridge\//.test(p) || /^en\/bridge\//.test(p)) return 'vision'
  return null
}

// 写入路径 → 相关子检查函数数组（增量：每次写入只跑与目标文件相关的检查）
function pickChecks(root, rel) {
  const p = String(rel || '').replace(/\\/g, '/')
  const checks = []
  if (p === 'dsh/preset/agent.cordis.yml') {
    checks.push(() => lib.checkPersonaBudget({ root, rel: 'dsh/preset/agent.cordis.yml', ...PERSONA_BUDGET.zh }))
  }
  if (p === 'en/preset/agent.cordis.yml') {
    checks.push(() => lib.checkPersonaBudget({ root, rel: 'en/preset/agent.cordis.yml', ...PERSONA_BUDGET.en }))
  }
  const pluginRel = /^(?:dsh\/preset|en\/preset)\/plugins\/([^/]+\.(?:js|cjs))$/.exec(p)
  if (pluginRel) {
    const name = pluginRel[1]
    checks.push(() => lib.checkPluginPair({ root, name }))
    // 写插件源码时顺带校验自身语法（测试文件不查——node --check 对 test 同样适用，
    // 但测试文件由 npm test 管，写时语法拦截只对源码，减少噪音）
    if (!/\.test\.js$/.test(name)) {
      checks.push(() => lib.checkFileSyntax({ root, rel: p, label: `plugins/${name}` }))
    }
  }
  if (/^dsh\/preset\/memories\//.test(p)) {
    checks.push(() => lib.checkMemoriesCount({ root, rel: 'dsh/preset/memories', expected: 4 }))
  }
  if (/^en\/preset\/memories\//.test(p)) {
    checks.push(() => lib.checkMemoriesCount({ root, rel: 'en/preset/memories', expected: 4 }))
  }
  if (p === 'README.md') {
    checks.push(() => lib.checkReadmePhrase({ root, rel: 'README.md', phrase: '+ 4 记忆' }))
  }
  if (p === 'README.en.md') {
    checks.push(() => lib.checkReadmePhrase({ root, rel: 'README.en.md', phrase: '+ 4 memories' }))
  }
  if (p === 'package.json' || p === 'en/package.json') {
    checks.push(() => lib.checkVersionPair({ root }))
  }
  if (/^dsh\/vision-bridge\//.test(p) || /^en\/bridge\//.test(p)) {
    checks.push(() => lib.checkFilesEqual({ root, a: 'dsh/vision-bridge/index.js', b: 'en/bridge/index.js', label: 'vision-bridge/index.js' }))
    checks.push(() => lib.checkFilesEqual({ root, a: 'dsh/vision-bridge/test.js', b: 'en/bridge/test.js', label: 'vision-bridge/test.js' }))
  }
  return checks
}

function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'kix-consistency', form: 'notice', summary: text.slice(0, 100) },
  }
}

module.exports = {
  name: 'kix-consistency',
  inject: ['tools'],
  apply(ctx, config) {
    const cfg = config || {}
    const intensity = cfg.intensity || 'remind'

    const states = new Map()
    function stateFor(agent) {
      const key = agent && agent.id ? String(agent.id) : 'anonymous'
      let st = states.get(key)
      if (!st) {
        const sandboxPolicy = ctx.get('sandboxPolicy')
        const session = agent && agent.session
        const header = session && session.header
        st = {
          enabled: true,
          workspaceRoot: (sandboxPolicy !== undefined && sandboxPolicy.workspaceRoot) ||
            (header && header.cwd) || undefined,
          reminded: new Set(),
          pendingRemind: new Map(),
        }
        states.set(key, st)
      }
      return st
    }

    async function askUser(exec, reason) {
      const userQuestions = ctx.get('userQuestions')
      if (userQuestions === void 0 || exec === void 0 || exec.agent === void 0) return undefined
      try {
        const { answers } = await userQuestions.ask({
          questions: [{
            id: 'kix-consistency-confirm',
            question: reason,
            header: 'kix-consistency 确认',
            options: [
              { label: '继续写入', description: '已知晓不一致，继续（稍后统一同步）。' },
              { label: '取消写入', description: '先修复不一致再写。' },
            ],
          }],
          agent: exec.agent,
          ...exec.signal !== void 0 ? { signal: exec.signal } : {},
        })
        const selected = answers && answers[0] && answers[0].selected
        return Array.isArray(selected) && selected.includes('继续写入')
      } catch {
        return undefined
      }
    }

    // ── pre-execute：preset 区域写时增量校验 ─────────────────────────────
    ctx.on('tools/pre-execute', async (exec, next) => {
      const name = exec && exec.name
      const tool = (name || '').toLowerCase()
      if (!MUTATION_TOOLS.has(tool)) return next()

      const args = exec && (exec.arguments ?? exec.args)
      const rawPath = args && (args.file_path || args.path)
      if (typeof rawPath !== 'string' || rawPath.length === 0) return next()

      const st = stateFor(exec && exec.agent)
      if (!st.enabled) return next()
      if (!st.workspaceRoot || !isRepoRoot(st.workspaceRoot)) return next()

      const relPath = toRepoRel(st.workspaceRoot, rawPath)
      const category = classifyWrite(relPath)
      if (!category) return next()

      const checks = pickChecks(st.workspaceRoot, relPath)
      if (checks.length === 0) return next()

      const failures = []
      for (const run of checks) {
        const r = run()
        if (r && r.failures) failures.push(...r.failures)
      }
      if (failures.length === 0) return next()

      const reason = 'kix-consistency: ' + failures.join(' ')

      if (intensity === 'block') {
        return { kind: 'deny', reason }
      }
      if (intensity === 'ask') {
        const ok = await askUser(exec, reason)
        if (ok === false) return { kind: 'deny', reason: 'kix-consistency: 用户取消，先修复一致性再写。' }
        if (ok === void 0) return { kind: 'deny', reason: 'kix-consistency: 无法向用户提问（无提问通道），已自动拒绝。' }
        return next()
      }
      // remind：放行 + 注入提醒（每会话每类别一次；投递成功才消耗，同 kix-orchestration）。
      // pendingRemind 为 Map<callId, …>：同一 agent 并发写不同类别（如一次块内
      // zh 插件 + README）时单槽会互相覆盖丢提醒，按 callId 各自挂起、post 按号消费。
      if (st.reminded.has(category)) return next()
      st.pendingRemind.set(exec.callId, { category, reason })
      return next()
    })

    // ── post-execute：注入 remind（按 callId 匹配消费，防错位注入）────────
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const st = stateFor(exec && exec.agent)
      if (!st.enabled || st.pendingRemind.size === 0) return next()
      const pending = st.pendingRemind.get(exec && exec.callId)
      if (!pending) return next()
      st.pendingRemind.delete(exec.callId)
      // 并发同类别双写：首条投递已消耗该类别，后续挂起条目静默丢弃（remindOnce）
      if (st.reminded.has(pending.category)) return next()
      st.reminded.add(pending.category)
      return { kind: 'accept', additionalContexts: [makeUserMessage(pending.reason)] }
    })

    ctx.logger?.info?.('[kix-consistency] 一致性写时拦截已挂载（preset 区域增量校验 + remind；与 CI 共用 consistency-lib 单一事实源）')
  },
}

module.exports.__internals = {
  isRepoRoot,
  toRepoRel,
  classifyWrite,
  pickChecks,
  MUTATION_TOOLS,
  makeUserMessage,
}
