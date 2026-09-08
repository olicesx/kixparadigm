// kix-consistency — 一致性守护写时拦截（2026-08-17，PLUGINIZATION-ROADMAP（classic 档）P5 落地）
//
// 背景：check-dsh-consistency.cjs 只在 CI/npm test 期校验——改 dsh/preset/ 文件时
// 不实时拦截，drift（zh/en 不同步、persona 超预算、分发镜像漂移）要等下次测试才暴露。
// 本插件把「唯一事实源」约定从自觉变机械：写 preset 相关文件时跑**相关子检查**，
// 失败 → remind（放行 + 注入提醒，文档可回滚不 deny）。
//
// 写后结算出生证明（2026-08-23，ZCode P6.1 + 本地复现）：旧实现只在 pre
// 检查旧文件；初始 persona 在预算内时，同次 edit 写到 5092 chars，post 提醒为 0。
// 现成功 write/edit 后按实际文件重算，既抓首写 drift/超预算，也避免修复后投递旧提醒；
// 失败写入不结算。退役条件：真实 trace 中首写增量提醒长期零贡献，且宿主提供原子
// write-result 校验或 CI 前移到同一交付时刻。
//
// 单一事实源：检查逻辑全部在 ./consistency-lib.cjs（zh/en 字节一致共享）；
// CI 脚本与本插件共用同一实现——不复制断言，防「CI 一套、运行时一套」双源漂移。
//
// 触发面（限制越少越好，边界自感知）：扫描工作区「DSH preset 根」（同时含
// agent.cordis.yml + preset.yml 的目录，深度 ≤2）。发现 ≥2 个 preset 根才引导——
// 该相同的数份必须相同：默认各根同名 plugins 字节一致；变体由
// consistency-lib PLUGIN_IDENTITY_GROUPS 分簇（budget 两簇，probe/settle/mem 仅 incentive 面）。
// 单 preset / 普通仓库零开销放行（边界 = preset 根；边界外路径天然不触发，
// 无需任何逐路径豁免规则）。
// kix 全量契约（persona 预算 / 版本对 / distribution mirror Interfaces）
// 由仓库自带 scripts/check-dsh-consistency.cjs **自声明**触发——仓库自己携带契约
// 入口才算契约仓，不是按仓库名硬编码（防外仓误伤 = 防过拟合）。
//
// 强度：默认 remind（只做启发引导）；ask/block 需 agent.cordis.yml 显式配置。remindOnce：
// 每会话每类别一次（persona/plugins/package/vision/misc/parity-hint）。
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
// shell 写入（cp/重定向/sed -i…）不做机械提取（评审否决：命令文本启发式提取是
// 负债——覆盖差、误提取、连字符级细节 bug 靠实弹才暴露）。shell 通道的同步感知
// 交给软启发：write/edit 工具的 parity hint 已把「其它根对应份」的维度立起来，
// 模型在 shell 任务里同样带着这个意识；机械兜底由 CI 全量检查承担。

// v1.3.4：预算单源进 consistency-lib（PERSONA_BUDGETS）——原此处本地常量
// 与 runAllZh 硬编码 6000/3400 双源漂移，同一检查两套阈值。
const PERSONA_BUDGET = lib.PERSONA_BUDGETS

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
// 契约层（自带 scripts/check-dsh-consistency.cjs）：persona / package / vision——
// 本仓自声明契约，外仓不套用；memories/README 只走通用 parity hint。
function classifyWrite(rel, presetRoots, withContract) {
  const p = String(rel || '').replace(/\\/g, '/')
  const roots = Array.isArray(presetRoots) ? presetRoots : []
  const home = lib.presetRootOf(p, roots)
  if (home) {
    const suffix = p.slice(home.length + 1)
    if (/^plugins\/[^/]+\.(?:js|cjs)$/.test(suffix)) return 'plugins'
    if (withContract && suffix === 'agent.cordis.yml') return 'persona'
    return 'parity'
  }
  if (withContract) {
    if (p === 'package.json' || p === 'en/package.json') return 'package'
    if (/^dsh\/vision-bridge\//.test(p) || /^en\/bridge\//.test(p)) return 'vision'
  }
  return null
}

function personaBudgetFor(home) {
  if (home === 'dsh/preset' || home === 'dsh/preset-classic') return PERSONA_BUDGET.zh
  if (home === 'en/preset' || home === 'en/preset-classic-en') return PERSONA_BUDGET.en
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
    // 预算是本仓当前 edition 的单源常量；null/未知 preset 根无预算可查 → 不硬套
    const budget = personaBudgetFor(home)
    if (budget) checks.push(() => lib.checkPersonaBudget({ root, rel: p, ...budget }))
  }
  if (category === 'plugins') {
    const basename = path.posix.basename(p)
    // pair 按文件名交给 lib 决定是否归一到伴侣源码；语法跳过必须看原始
    // basename——归一后再测 /\.test.js$/ 会把已存在的测试文件误开成源码语法检查。
    checks.push(() => lib.checkPluginPair({ root, name: basename, presetRoots: roots }))
    // 写插件源码时顺带校验自身语法（测试文件不查——node --check 对 test 同样适用，
    // 但测试文件由 npm test 管，写时语法拦截只对源码，减少噪音）；
    // 目标尚不存在（pre-write 新建文件）时跳过——检查不存在的文件只产 missing 噪音
    if (!/\.test\.(?:js|cjs)$/.test(basename) && fs.existsSync(path.join(root, p))) {
      checks.push(() => lib.checkFileSyntax({ root, rel: p, label: `plugins/${basename}` }))
    }
  }
  if (category === 'package') {
    checks.push(() => lib.checkVersionPair({ root }))
  }
  if (category === 'vision') {
    checks.push(() => lib.checkMirrorTree({ root, left: 'dsh/vision-bridge', right: 'en/bridge', label: 'vision-bridge' }))
    if (/\.(?:js|cjs|mjs)$/.test(p) && fs.existsSync(path.join(root, p))) {
      checks.push(() => lib.checkFileSyntax({ root, rel: p, label: p }))
    }
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

function resultFailed(result) {
  return Boolean(result && result.isError === true)
}

function collectFailures(checks) {
  const failures = []
  for (const run of checks) {
    const r = run()
    if (r && Array.isArray(r.failures)) failures.push(...r.failures)
  }
  return [...new Set(failures)]
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

// parity hint 文案：点名其余根 + 交给模型判断
function buildParityHint(relPath, home, presetRoots) {
  const suffix = relPath.slice(home.length + 1)
  const others = presetRoots.filter((r) => r !== home)
  return 'kix-consistency hint: 写入 ' + relPath + '（preset 根 ' + home + '）。' +
    '该类文件无机械一致性检查（字节校验只覆盖各根 plugins）；' +
    '其余根（' + others.join(', ') + '）的对应份「' + suffix + '」是否需要同步/翻译由你判断。'
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

    function ensureWorkspaceState(st, rawPath) {
      if (st.workspaceRoot && Array.isArray(st.presetRoots) && st.presetRoots.length >= 2) return true
      const healed = discoverRootsFromFile(rawPath, configuredRoots)
      if (!healed) return false
      st.workspaceRoot = healed.workspaceRoot
      st.presetRoots = healed.presetRoots
      st.contract = hasContractEntry(healed.workspaceRoot)
      return true
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
      // 通用门禁：≥2 个自感知 preset 根才引导（单 preset / 普通仓库零开销放行）。
      // 首派发兜底：live 会话的首次工具派发可能解析不出会话 cwd（WSL2 实弹实锤：
      // 首写 hint 丢失、第二写靠 stateFor 自愈才触发）——此时写入目标本身是绝对
      // 路径，从它反推含 ≥2 preset 根的祖先工作区，找到即固化进 state 供后续复用。
      if (!ensureWorkspaceState(st, rawPath)) return next()

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

      const failures = collectFailures(checks)
      if (failures.length === 0) return next()

      // 去重：同一缺失可能被身份组与语法检查重复报（WSL2 实弹曾三连 missing）
      const reason = 'kix-consistency: ' + failures.join(' ')

      if (intensity === 'block') {
        return { kind: 'deny', reason }
      }
      if (intensity === 'ask') {
        const ok = await askUser(exec, reason)
        if (ok === false) return { kind: 'deny', reason: 'kix-consistency: 用户取消，先修复一致性再写。' }
        if (ok === void 0) return { kind: 'deny', reason: 'kix-consistency: 无法向用户提问（无提问通道），已自动拒绝。' }
        st.pendingRemind.set(exec.callId, { category, acknowledged: true })
        return next()
      }
      // remind：放行 + 注入提醒（每会话每类别一次；投递成功才消耗，同 kix-orchestration）。
      // pendingRemind 为 Map<callId, …>：同一 agent 并发写不同类别（如一次块内
      // zh 插件 + vision）时单槽会互相覆盖丢提醒，按 callId 各自挂起、post 按号消费。
      if (st.reminded.has(category)) return next()
      st.pendingRemind.set(exec.callId, { category, reason })
      return next()
    })

    // ── post-execute：成功写入后按实际文件重算，再注入 remind ─────────────
    // pre 检查负责 block/ask 与旧债提示；post 重算填上「初始全绿、单次写入引入
    // drift/超预算」的首写盲点。真实调用携带原 exec.arguments；旧测试/异常适配器
    // 若未回传路径，才退回 pre 挂起理由。失败、被策略拦截或取消的写入均不结算。
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const outcome = await next()
      try {
        const st = stateFor(exec && exec.agent)
        if (!st.enabled) return outcome

        const callId = exec && exec.callId
        const pending = callId ? st.pendingRemind.get(callId) : undefined
        if (callId) st.pendingRemind.delete(callId)
        if (resultFailed(result) || (pending && pending.acknowledged)) return outcome

        let category = pending && pending.category
        let reason = pending && pending.reason
        const tool = String(exec && exec.name || '').toLowerCase()
        const args = exec && (exec.arguments ?? exec.args)
        const rawPath = args && (args.file_path || args.path)

        if (MUTATION_TOOLS.has(tool) && typeof rawPath === 'string' && rawPath.length > 0 && ensureWorkspaceState(st, rawPath)) {
          const relPath = toRepoRel(st.workspaceRoot, rawPath)
          const actualCategory = classifyWrite(relPath, st.presetRoots, st.contract)
          if (actualCategory && actualCategory !== 'parity') {
            category = actualCategory
            const failures = collectFailures(pickChecks(st.workspaceRoot, relPath, st.presetRoots, st.contract))
            reason = failures.length > 0 ? 'kix-consistency: ' + failures.join(' ') : undefined
          }
        }

        if (!category || !reason || st.reminded.has(category)) return outcome
        // 非 accept decision 不携带 additionalContexts；此时不得空耗 remindOnce。
        if (outcome && typeof outcome === 'object' && outcome.kind && outcome.kind !== 'accept') return outcome
        // 并发同类别双写：首条真实投递消耗该类别，后续条目静默丢弃（remindOnce）。
        st.reminded.add(category)
        return lib.appendContexts(outcome, [makeUserMessage(reason)])
      } catch (e) {
        // post 观察绝不能把已成功的 write/edit 改报失败（DSH 会传播监听器异常）。
        ctx.logger?.warn?.('kix-consistency: 写后重算跳过：' + (e && e.message ? e.message : String(e)))
        return outcome
      }
    })

    ctx.logger?.info?.('[kix-consistency] 一致性写时拦截已挂载（边界自感知：≥2 preset 根才引导，身份组 = 各根同名 plugins；契约层由 scripts 入口自声明；与 CI 共用 consistency-lib 单一事实源）')
  },
}

module.exports.__internals = {
  hasContractEntry,
  toRepoRel,
  classifyWrite,
  personaBudgetFor,
  pickChecks,
  buildParityHint,
  discoverRootsFromFile,
  MUTATION_TOOLS,
  makeUserMessage,
}
