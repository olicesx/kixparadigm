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
// 触发面（限制越少越好，边界自感知）：扫描工作区「DSH preset 根」（同时含
// agent.cordis.yml + preset.yml 的目录，深度 ≤2）。发现 ≥2 个 preset 根才引导——
// 该相同的数份必须相同（各根下同名 plugins/*.{js,cjs} 字节一致，语言中立代码）。
// 单 preset / 普通仓库零开销放行（边界 = preset 根；边界外路径天然不触发，
// 无需任何逐路径豁免规则）。
// kix 全量契约（persona 预算 / memories 计数 / README 表述 / 版本对 / vision-bridge）
// 由仓库自带 scripts/check-dsh-consistency.cjs **自声明**触发——仓库自己携带契约
// 入口才算契约仓，不是按仓库名硬编码（防外仓误伤 = 防过拟合）。
//
// 强度：默认 remind（只做启发引导）；ask/block 需 agent.cordis.yml 显式配置。remindOnce：
// 每会话每类别一次（persona/plugins/memories/readme/package/vision/misc/parity-hint）。
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
// shell 写入（cp/Set-Content/重定向/sed -i…）不走 file_path，写前拿不到目标——
// pre 只登记命令中提到的 preset 根内路径，post（磁盘已是新状态）才做身份组检查。
const SHELL_TOOLS = new Set(['pwsh', 'bash'])
const SHELL_TARGETS_CAP = 8

const PERSONA_BUDGET = {
  zh: { maxChars: 4500, maxEstTokens: 2600 },
  en: { maxChars: 9500, maxEstTokens: 2600 },
}

// ── 纯判定函数（模块级：单元测试经 __internals 直接验证）─────────────────

// 契约层入口：仓库自带一致性契约脚本 = 自声明「本仓适用 kix 全量契约」。
// 通用层（身份组）不看这个——任何 ≥2 preset 根的工作区都引导；契约层只对
// 自带契约入口的仓库开（persona 预算 / memories 计数 / README 表述等是本仓
// 特定常量，外仓没有这些约定，硬套就是过拟合）。
function hasContractEntry(root) {
  if (!root || typeof root !== 'string') return false
  return fs.existsSync(path.join(root, 'scripts/check-dsh-consistency.cjs'))
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

// 写入路径 → 提醒类别（remindOnce 粒度；边界外返回 null，零开销放行）
// 通用层（任意 ≥2 preset 根工作区）：
//   - plugins/*.{js,cjs} → 'plugins'：机械身份组（字节一致，与 CI 动态清单同口径）
//   - 其余根内路径 → 'parity'：**启发 hint**（不断言失败）——skills/agents/prompts 等
//     是翻译关系不是字节关系，机械校验必误报（zh/en 结构本就不镜像）；提醒把
//     「其它根对应份是否需要同步」这个维度交给模型判断，正是「没说到的形态靠提醒感知」
// 契约层（自带 scripts/check-dsh-consistency.cjs）：persona / memories / README /
// package / vision——本仓自声明契约，外仓不套用。
function classifyWrite(rel, presetRoots, withContract) {
  const p = String(rel || '').replace(/\\/g, '/')
  const roots = Array.isArray(presetRoots) ? presetRoots : []
  const home = lib.presetRootOf(p, roots)
  if (home) {
    const suffix = p.slice(home.length + 1)
    if (/^plugins\/[^/]+\.(?:js|cjs)$/.test(suffix)) return 'plugins'
    if (withContract) {
      if (suffix === 'agent.cordis.yml') return 'persona'
      if (/^memories\//.test(suffix)) return 'memories'
    }
    return 'parity'
  }
  if (withContract) {
    if (p === 'README.md' || p === 'README.en.md') return 'readme'
    if (p === 'package.json' || p === 'en/package.json') return 'package'
    if (/^dsh\/vision-bridge\//.test(p) || /^en\/bridge\//.test(p)) return 'vision'
  }
  return null
}

// 写入路径 → 相关子检查函数数组（增量：每次写入只跑与目标文件相关的检查）
// roots / withContract 可选（测试直呼时现场发现）；插件运行时传缓存值。
function pickChecks(root, rel, presetRoots, withContract) {
  const p = String(rel || '').replace(/\\/g, '/')
  const checks = []
  const roots = Array.isArray(presetRoots) && presetRoots.length ? presetRoots : lib.discoverPresetRoots(root)
  // 单 preset 根 / 普通仓库：零开销（<2 份谈不上「该相同的数份」）
  if (!Array.isArray(roots) || roots.length < 2) return checks
  const contract = typeof withContract === 'boolean' ? withContract : hasContractEntry(root)
  const category = classifyWrite(p, roots, contract)
  if (!category) return checks
  const home = lib.presetRootOf(p, roots)
  if (category === 'persona') {
    // 预算是本仓两套 edition 的常量；未知名 preset 根无预算可查 → 不硬套
    const budget = home === 'dsh/preset' ? PERSONA_BUDGET.zh : home === 'en/preset' ? PERSONA_BUDGET.en : null
    if (budget) checks.push(() => lib.checkPersonaBudget({ root, rel: p, ...budget }))
  }
  if (category === 'plugins') {
    const name = path.posix.basename(p)
    checks.push(() => lib.checkPluginPair({ root, name, presetRoots: roots }))
    // 写插件源码时顺带校验自身语法（测试文件不查——node --check 对 test 同样适用，
    // 但测试文件由 npm test 管，写时语法拦截只对源码，减少噪音）；
    // 目标尚不存在（pre-write 新建文件）时跳过——检查不存在的文件只产 missing 噪音
    if (!/\.test\.js$/.test(name) && fs.existsSync(path.join(root, p))) {
      checks.push(() => lib.checkFileSyntax({ root, rel: p, label: `plugins/${name}` }))
    }
  }
  if (category === 'memories') {
    checks.push(() => lib.checkMemoriesCount({ root, rel: home + '/memories', expected: 4 }))
  }
  if (category === 'readme') {
    const phrase = p === 'README.md' ? '+ 4 记忆' : '+ 4 memories'
    checks.push(() => lib.checkReadmePhrase({ root, rel: p, phrase }))
  }
  if (category === 'package') {
    checks.push(() => lib.checkVersionPair({ root }))
  }
  if (category === 'vision') {
    checks.push(() => lib.checkIdenticalSet({ root, paths: ['dsh/vision-bridge/index.js', 'en/bridge/index.js'], label: 'vision-bridge/index.js' }))
    checks.push(() => lib.checkIdenticalSet({ root, paths: ['dsh/vision-bridge/test.js', 'en/bridge/test.js'], label: 'vision-bridge/test.js' }))
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

// 从写入目标反推工作区（首派发兜底）：live 首次工具派发时 agent 可能还解析不出
// 会话 cwd（WSL2 实弹实锤：首写 parity hint 丢失、第二写靠 stateFor 自愈才触发）。
// 写入目标本身是绝对路径——沿祖先找「含 ≥2 个 preset 根」的最近祖先，用同一
// discoverPresetRoots 判定（边界仍由标记决定，不猜）。找到即写入 state 供后续
// 派发复用；找不到保持零开销。只兜 write/edit（shell 命令路径多为相对，不适用）。
function discoverRootsFromFile(absPath, configuredRoots) {
  if (typeof absPath !== 'string' || absPath.length === 0) return null
  const norm = path.normalize(absPath.replace(/\\/g, '/'))
  if (!path.isAbsolute(norm)) return null
  let dir = path.dirname(norm)
  for (let i = 0; i < 8 && dir && dir !== path.dirname(dir); i++) {
    const roots = (configuredRoots && configuredRoots.length ? configuredRoots : lib.discoverPresetRoots(dir))
    if (Array.isArray(roots) && roots.length >= 2) return { workspaceRoot: dir, presetRoots: roots }
    dir = path.dirname(dir)
  }
  return null
}

// parity hint 文案（write/edit 与 shell 共用）：点名其余根 + 交给模型判断
function buildParityHint(relPath, home, presetRoots) {
  const suffix = relPath.slice(home.length + 1)
  const others = presetRoots.filter((r) => r !== home)
  return 'kix-consistency hint: 写入 ' + relPath + '（preset 根 ' + home + '）。' +
    '该类文件无机械一致性检查（字节校验只覆盖各根 plugins）；' +
    '其余根（' + others.join(', ') + '）的对应份「' + suffix + '」是否需要同步/翻译由你判断。'
}

// 从 shell 命令文本提取 preset 根内路径（启发：正斜杠/反斜杠均认，截到引号/空白）。
// 误提取的代价 = 一次 post 检查（文件不存在 → checkPluginPair 报 missing，仍是有效提醒）。
function extractShellTargets(cmd, presetRoots) {
  const out = []
  const seen = new Set()
  for (const root of presetRoots) {
    const esc = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[/\\\\]')
    const re = new RegExp(esc + '[/\\\\]([A-Za-z0-9_.\-/\\\\]+)', 'g')
    let m
    while ((m = re.exec(String(cmd || '')))) {
      const rel = m[1].replace(/\\/g, '/').replace(/[^A-Za-z0-9_.\-/]+.*$/, '')
      if (!rel || rel.length === 0) continue
      const key = root + '/' + rel
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ root, rel })
      if (out.length >= SHELL_TARGETS_CAP) return out
    }
  }
  return out
}

module.exports = {
  name: 'kix-consistency',
  inject: ['tools'],
  apply(ctx, config) {
    const cfg = config || {}
    const intensity = cfg.intensity || 'remind'

    // 会话工作区根：lib.resolveWorkspaceRoot（与 kix-guards 共用的单一实现）。
    // sandboxPolicy.workspaceRoot 是部署回退（常为 process.cwd()），不是会话工作区——
    // 误用回退值 → isRepoRoot(/root) 失败 → 整插件在任何非启动目录工作区静默失效
    // （WSL2 E2E 实锤）。
    function resolveWorkspaceRoot(agent) {
      return lib.resolveWorkspaceRoot(agent, ctx.get('sandboxPolicy'))
    }

    const states = new Map()
    // 配置覆盖：presetRoots 显式声明身份组根（自定义布局的仓库用；默认自感知扫描）
    const configuredRoots = Array.isArray(cfg.presetRoots)
      ? cfg.presetRoots.filter((r) => typeof r === 'string' && r.length > 0)
      : null
    function rootsFor(root) {
      if (configuredRoots && configuredRoots.length > 0) return configuredRoots.slice()
      return lib.discoverPresetRoots(root)
    }
    function stateFor(agent) {
      const key = agent && agent.id ? String(agent.id) : 'anonymous'
      let st = states.get(key)
      if (!st) {
        const root = resolveWorkspaceRoot(agent)
        st = {
          enabled: true,
          workspaceRoot: root,
          presetRoots: root ? rootsFor(root) : [],
          contract: root ? hasContractEntry(root) : false,
          reminded: new Set(),
          pendingRemind: new Map(),
          pendingShell: new Map(),
        }
        states.set(key, st)
      } else {
        const live = resolveWorkspaceRoot(agent)
        if (live && live !== st.workspaceRoot) {
          st.workspaceRoot = live
          st.presetRoots = rootsFor(live)
          st.contract = hasContractEntry(live)
        }
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

      // shell 写入：pre 只登记命令中提到的 preset 根内路径（写前磁盘未变，检查无意义）
      if (SHELL_TOOLS.has(tool)) {
        const st = stateFor(exec && exec.agent)
        if (!st.enabled || !st.workspaceRoot || !Array.isArray(st.presetRoots) || st.presetRoots.length < 2) return next()
        const args = exec && (exec.arguments ?? exec.args)
        const cmd = args && (args.command || args.script || args.cmd)
        if (typeof cmd !== 'string' || cmd.length === 0) return next()
        const targets = extractShellTargets(cmd, st.presetRoots)
        if (targets.length === 0) return next()
        st.pendingShell.set(exec.callId, targets)
        return next()
      }

      if (!MUTATION_TOOLS.has(tool)) return next()

      const args = exec && (exec.arguments ?? exec.args)
      const rawPath = args && (args.file_path || args.path)
      if (typeof rawPath !== 'string' || rawPath.length === 0) return next()

      const st = stateFor(exec && exec.agent)
      if (!st.enabled) return next()
      // 通用门禁：≥2 个自感知 preset 根才引导（单 preset / 普通仓库零开销放行）。
      // 首派发兜底：live 会话的首次工具派发可能解析不出会话 cwd（WSL2 实弹实锤：
      // 首写 hint 丢失、第二写靠 stateFor 自愈才触发）——此时写入目标本身是绝对
      // 路径，从它反推含 ≥2 preset 根的祖先工作区，找到即固化进 state 供后续复用。
      if (!st.workspaceRoot || !Array.isArray(st.presetRoots) || st.presetRoots.length < 2) {
        const healed = discoverRootsFromFile(rawPath, configuredRoots)
        if (!healed) return next()
        st.workspaceRoot = healed.workspaceRoot
        st.presetRoots = healed.presetRoots
        st.contract = hasContractEntry(healed.workspaceRoot)
      }

      const relPath = toRepoRel(st.workspaceRoot, rawPath)
      const category = classifyWrite(relPath, st.presetRoots, st.contract)
      if (!category) return next()

      // parity = 启发 hint（无机械检查）：不断言失败，只把「其它根对应份」这个
      // 维度提给模型——翻译/结构同步是模型判断，不是门禁。remindOnce 限噪。
      if (category === 'parity') {
        if (st.reminded.has('parity')) return next()
        const home = lib.presetRootOf(relPath, st.presetRoots) || ''
        st.pendingRemind.set(exec.callId, { category: 'parity', reason: buildParityHint(relPath, home, st.presetRoots) })
        return next()
      }

      const checks = pickChecks(st.workspaceRoot, relPath, st.presetRoots, st.contract)
      if (checks.length === 0) return next()

      const failures = []
      for (const run of checks) {
        const r = run()
        if (r && r.failures) failures.push(...r.failures)
      }
      if (failures.length === 0) return next()

      // 去重：同一缺失可能被身份组与语法检查重复报（WSL2 实弹曾三连 missing）
      const unique = [...new Set(failures)]
      const reason = 'kix-consistency: ' + unique.join(' ')

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
      if (!st.enabled) return next()

      // shell 写入后验：磁盘已是新状态，身份组检查此刻才有效；漂移优先于 hint
      const shellTargets = st.pendingShell.get(exec && exec.callId)
      if (shellTargets) {
        st.pendingShell.delete(exec.callId)
        const pluginNames = new Set()
        let hasOther = false
        let firstOther = null
        for (const t of shellTargets) {
          if (/^plugins\/[^/]+\.(?:js|cjs)$/.test(t.rel)) pluginNames.add(t.rel.replace(/^plugins\//, ''))
          else if (!firstOther) { firstOther = t; hasOther = true }
        }
        const failures = []
        for (const n of pluginNames) {
          const r = lib.checkPluginPair({ root: st.workspaceRoot, name: n, presetRoots: st.presetRoots })
          if (r && r.failures) failures.push(...r.failures)
        }
        if (failures.length) {
          if (st.reminded.has('plugins')) return next()
          st.reminded.add('plugins')
          return lib.appendContexts(await next(), [makeUserMessage('kix-consistency: shell 写入后检测到身份组漂移 — ' + failures.join(' ') + '。该相同的数份必须相同；同步或回滚由你判断。')])
        }
        if (hasOther && !st.reminded.has('parity')) {
          st.reminded.add('parity')
          return lib.appendContexts(await next(), [makeUserMessage(buildParityHint(firstOther.root + '/' + firstOther.rel, firstOther.root, st.presetRoots))])
        }
        return next()
      }

      if (st.pendingRemind.size === 0) return next()
      const pending = st.pendingRemind.get(exec && exec.callId)
      if (!pending) return next()
      st.pendingRemind.delete(exec.callId)
      // 并发同类别双写：首条投递已消耗该类别，后续挂起条目静默丢弃（remindOnce）
      if (st.reminded.has(pending.category)) return next()
      st.reminded.add(pending.category)
      return lib.appendContexts(await next(), [makeUserMessage(pending.reason)])
    })

    ctx.logger?.info?.('[kix-consistency] 一致性写时拦截已挂载（边界自感知：≥2 preset 根才引导，身份组 = 各根同名 plugins；契约层由 scripts 入口自声明；与 CI 共用 consistency-lib 单一事实源）')
  },
}

module.exports.__internals = {
  hasContractEntry,
  toRepoRel,
  classifyWrite,
  pickChecks,
  buildParityHint,
  discoverRootsFromFile,
  extractShellTargets,
  MUTATION_TOOLS,
  SHELL_TOOLS,
  makeUserMessage,
}
