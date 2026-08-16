// kix-orchestration — kixparadigm 编排交接门禁（2026-08-16，插件化改造 P2 补缺）
//
// 背景（用户 2026-08-16 指出"迁移是否失真"）：Copilot 侧 kixpower 的编排纪律由
// 9 个 PreToolUse/PostToolUse hooks 自动触发（validate-handoff.ps1 /
// validate-qa-signoff.ps1 / qa-freshness-check.ps1 / block-source-edit*.ps1 /
// blast-radius-check.ps1 / cleanup-qa-session.ps1 / auto-update-progress.ps1）。
// 迁移到 DSH 后，只有 blast-radius 由 kix-guards 接管，其余 7 个 hooks 变成
// "仅 prompt 约束"（模型自觉）——这就是感知到的"失真"：机械动作丢了自动化。
//
// 本插件按 kix 哲学（规则是负债、机制只补已知盲点、补足非限制）做**有界移植**：
//   只移植跨环境通用、失败代价高、可机械枚举的交接纪律；不移植 Copilot 特有流程
//   （worktree 登记 / plan_snapshot_sha / l2_gate_manifest_sha256 / stash 基线 /
//   reverify marker 等深度校验——那些绑定 Copilot 的 runSubagent+agentName 分派
//   格式，DSH 的 subagent 是 prompt 注入，过度移植 = 负债，见 PLUGINIZATION-ROADMAP.md）。
//
// 机制（DSH 原生事件，与 kix-discipline 同构）：
//   - tools/pre-execute：对 subagent* 工具的分派，从 prompt 提取交接元数据，
//     校验"规划完成才可进入 Dev/QA"：
//       * prompt 声明 current_sprint=N → 工作区须有 docs/.kixpower-current-sprint
//         且值一致（Copilot hook 同款：禁止回退猜测最新 Sprint）；
//       * sprint 目录 docs/sprint-N/plan.md + progress.md 必须存在（规划完成）；
//       * progress.md frontmatter 不得有 status: blocked / blocked_tasks>0 /
//         ❌ Blocked 条目（有 blocker 不得交接下一阶段）；
//       * 切换 QA 时 completed_tasks 必须 == total_tasks（全部任务完成才可 QA）。
//     强度：默认 remind（放行+注入提醒，remindOnce）；ask / block 需显式配置。
//   - /kix-orchestration 命令：status / on|off（会话开关）。
//
// 边界（诚实声明）：
//   - 只拦"模型显式分派 subagent 且 prompt 带 current_sprint/handoff 元数据"的调用；
//     无元数据的分派（如三通道观察子代理）不触发——那是认知层不是编排交接。
//   - 按 agent scope 挂载，不覆盖子代理会话（同 kix-guards/kix-discipline）。
//   - worktree/SHA/manifest 深度校验不移植（见上）；plan.md 的 task_dag /
//     verifiable_gates 结构校验做轻量版（存在性），不做 manifest SHA 数学。
//
// 挂载：agent.cordis.yml 一行（同款相对路径）：
//   - id: kix-orchestration
//     name: ./plugins/kix-orchestration.js
// 测试：node plugins/kix-orchestration.test.js

'use strict'

const { readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')

// ── 常量 ───────────────────────────────────────────────────────────────────
const SUBAGENT_TOOLS = new Set([
  'subagent', 'subagent_fork', 'subagent_cross', 'subagent_lite',
  'subagent_thinker', 'subagent_vision', 'subagent_codex', 'subagent_claude_code',
])
const SPRINT_MARKER = '.kixpower-current-sprint'

// ── 纯判定函数（模块级：单元测试经 __internals 直接验证）─────────────────

// 从分派 prompt 提取交接元数据（Copilot hook 同款容错字段名）
function extractHandoffMeta(prompt) {
  const p = String(prompt || '')
  const out = { sprint: 0, mode: null, partition: null, target: null }
  const re = (pat) => new RegExp(pat, 'im')
  let m = re('^[ \\t]*current_sprint:\\s*(\\d+)[ \\t]*(?:#.*)?$').exec(p)
  if (m) out.sprint = Number(m[1])
  m = re('^[ \\t]*handoff_mode:\\s*(\\S+)[ \\t]*(?:#.*)?$').exec(p)
  if (m) out.mode = m[1]
  m = re('^[ \\t]*partition_id:\\s*(\\S+)[ \\t]*(?:#.*)?$').exec(p)
  if (m) out.partition = m[1]
  m = re('^[ \\t]*handoff_stage:\\s*(\\S+)[ \\t]*(?:#.*)?$').exec(p)
  if (m) out.mode = out.mode || m[1]
  return out
}

// 从 progress.md frontmatter 解析状态（Copilot hook 同款字段）
function parseProgressState(text) {
  const t = String(text || '')
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t)
  const front = fm ? fm[1] : t
  const strip = (s) => s.replace(new RegExp('^([ \\t]*[A-Za-z_][\\w]*:[^\\r\\n#]*?)[ \\t]+#[^\\r\\n]*$', 'm'), '$1')
  const clean = strip(front)
  const grab = (key) => {
    const m = new RegExp('^[ \\t]*' + key + ':\\s*(\\d+)[ \\t]*(?:#.*)?$', 'im').exec(clean)
    return m ? Number(m[1]) : undefined
  }
  const blocked = new RegExp('^status:\\s*blocked[ \\t]*(?:#.*)?$', 'im').test(clean)
  const blockedTasks = grab('blocked_tasks') || 0
  const hasBlockedEntry = new RegExp('^\\s*(?:[-*]\\s*)?❌\\s*Blocked:\\s*\\S+', 'im').test(t)
  return {
    blocked: blocked || blockedTasks > 0 || hasBlockedEntry,
    blockedTasks,
    completed: grab('completed_tasks'),
    total: grab('total_tasks'),
    l2VerifiedSha: undefined, // 深度校验不移植（见文件头）
  }
}

// 校验"是否可交接"——返回 { ok: true } 或 { ok: false, reason }
function checkHandoff({ prompt, workspaceRoot }) {
  const meta = extractHandoffMeta(prompt)
  // 无交接元数据 → 不是编排交接（三通道观察等），放行
  if (meta.sprint <= 0) return { ok: true, meta }

  const reasons = []
  const docsRoot = workspaceRoot ? join(workspaceRoot, 'docs') : null

  // 1. active Sprint marker 必须存在且一致（Copilot hook 同款）
  // 2026-08-16（审查修复，fail-open）：existsSync 对目录返回 true（误建为
  // 目录即通过存在校验）→ 改用 statSync().isFile()；读失败 push reason
  // （fail-closed），不再静默吞。
  const markerFile = docsRoot ? join(docsRoot, SPRINT_MARKER) : null
  if (!markerFile || !isFile(markerFile)) {
    reasons.push('工作区缺少 docs/.kixpower-current-sprint marker；禁止回退猜测最新 Sprint。请由 orchestrator 先写 active Sprint marker。')
  } else {
    let active = 0
    try {
      const v = readFileSync(markerFile, 'utf8').trim()
      if (/^\d+$/.test(v)) active = Number(v)
    } catch (e) {
      reasons.push(`读取 docs/.kixpower-current-sprint 失败（${e && e.message ? e.message : String(e)}），按缺失处理（fail-closed）。`)
    }
    if (active !== meta.sprint) {
      reasons.push(`current_sprint=${meta.sprint} 与 active Sprint marker=${active || '无'} 不一致。请先同步 docs/.kixpower-current-sprint。`)
    }
  }

  // 2. sprint 目录的 plan.md + progress.md 必须存在（规划完成才可进入 Dev/QA）
  if (docsRoot) {
    const sprintDir = join(docsRoot, 'sprint-' + meta.sprint)
    const planFile = join(sprintDir, 'plan.md')
    const progressFile = join(sprintDir, 'progress.md')
    if (!isFile(planFile) || !isFile(progressFile)) {
      reasons.push(`docs/sprint-${meta.sprint}/ 的 plan.md 或 progress.md 不存在（或误建为目录）。Producer 必须先完成规划与进度文件初始化，再交接。`)
    } else {
      // 3. progress 无 blocker
      try {
        const state = parseProgressState(readFileSync(progressFile, 'utf8'))
        if (state.blocked) {
          reasons.push(`docs/sprint-${meta.sprint}/progress.md 存在阻塞项（blocked_tasks=${state.blockedTasks}）。解决所有 blocker 后再交接。`)
        }
        // 4. 切 QA 时任务必须全部完成
        if (meta.mode === 'qa' || /qa/.test(meta.mode || '')) {
          if (state.completed === undefined || state.total === undefined || state.completed !== state.total) {
            reasons.push(`docs/sprint-${meta.sprint}/progress.md 尚未完成全部任务（${state.completed ?? '?'}/${state.total ?? '?'}），不能交接 QA。`)
          }
        }
      } catch (e) {
        // 2026-08-16（审查修复）：exists 通过后的读分支失败 → push reason（fail-closed），
        // 旧注释"上面已报缺文件"与事实不符——此分支位于 exists 通过之后。
        reasons.push(`读取 docs/sprint-${meta.sprint}/progress.md 失败（${e && e.message ? e.message : String(e)}），blocker/QA 校验跳过（fail-closed）。`)
      }
    }
  } else {
    reasons.push('无法解析工作区根（无 workspaceRoot/cwd），跳过 sprint 文件校验。')
  }

  return reasons.length === 0 ? { ok: true, meta } : { ok: false, meta, reasons }
}

// 2026-08-16（审查修复）：文件存在性检查——existsSync 对目录返回 true 会
// 让误建为目录的 marker/plan/progress 通过校验（fail-open）；statSync 判定
// 必须是常规文件。
function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'kix-orchestration', form: 'notice', summary: text.slice(0, 100) },
  }
}

module.exports = {
  name: 'kix-orchestration',
  inject: ['tools', 'commands'],
  apply(ctx, config) {
    const tools = ctx.tools
    const commands = ctx.commands
    const cfg = config || {}
    const intensity = cfg.intensity || 'remind'
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const defaultRoot = sandboxPolicy !== undefined && sandboxPolicy.workspaceRoot ? sandboxPolicy.workspaceRoot : undefined

    const states = new Map()
    function stateFor(agent) {
      const key = agent && agent.id ? String(agent.id) : 'anonymous'
      let st = states.get(key)
      if (!st) {
        const session = agent && agent.session
        const header = session && session.header
        const cwd = header && header.cwd && typeof header.cwd === 'string' ? header.cwd : undefined
        st = { enabled: true, reminded: false, workspaceRoot: defaultRoot || cwd || undefined }
        states.set(key, st)
      }
      return st
    }

    function agentCwd(exec) {
      try {
        const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
        return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
      } catch {
        return undefined
      }
    }

    async function askUser(exec, reason) {
      const userQuestions = ctx.get('userQuestions')
      if (userQuestions === void 0 || exec === void 0 || exec.agent === void 0) return undefined
      try {
        const { answers } = await userQuestions.ask({
          questions: [{
            id: 'kix-orchestration-confirm',
            question: reason,
            header: 'kix-orchestration 确认',
            options: [
              { label: '先完成规划/解除阻塞', description: '补齐 plan/progress 后再交接。' },
              { label: '交接条件已满足，继续', description: '确认编排状态无误，放行分派。' },
            ],
          }],
          agent: exec.agent,
          ...exec.signal !== void 0 ? { signal: exec.signal } : {},
        })
        const selected = answers && answers[0] && answers[0].selected
        return Array.isArray(selected) && selected.includes('交接条件已满足，继续')
      } catch {
        return undefined
      }
    }

    // ── pre-execute：subagent 交接门禁 ────────────────────────────────────
    ctx.on('tools/pre-execute', async (exec, next) => {
      const name = exec && exec.name
      const tool = (name || '').toLowerCase()
      if (!SUBAGENT_TOOLS.has(tool)) return next()

      const args = exec && (exec.arguments ?? exec.args)
      const agent = exec && exec.agent
      const st = stateFor(agent)
      if (!st.enabled) return next()

      // DSH subagent 工具的 prompt 在 args.prompt（SubagentStartRequest 契约）
      const prompt = args && (args.prompt || args.content)
      if (typeof prompt !== 'string' || prompt.length === 0) return next()

      const workspaceRoot = st.workspaceRoot || agentCwd(exec)
      const result = checkHandoff({ prompt, workspaceRoot })
      if (result.ok) return next()

      const reason = 'kix-orchestration: ' + result.reasons.join(' ')

      if (intensity === 'block') {
        return { kind: 'deny', reason }
      }
      if (intensity === 'ask') {
        const ok = await askUser(exec, reason)
        if (ok === false) return { kind: 'deny', reason: 'kix-orchestration: 用户拒绝，请先完成交接前置条件。' }
        if (ok === void 0) return { kind: 'deny', reason: 'kix-orchestration: 无法向用户提问（无提问通道），已自动拒绝。' }
        return next()
      }
      // remind：放行 + 注入提醒（每会话一次）
      // 2026-08-16（审查修复，状态机泄漏）：reminded 移到投递成功后置位
      // （旧实现在投递前置位——dispatch 抛错不经 post-execute 时标志滞留，
      // 一次性提醒被烧掉）；pendingRemind 绑定发起 callId（旧实现无绑定，
      // 下一次任意工具调用都会错位消费注入）。
      if (st.reminded) return next()
      st.pendingRemind = { callId: exec.callId, reason }
      return next()
    })

    // ── post-execute：注入 remind ─────────────────────────────────────────
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const agent = exec && exec.agent
      const st = agent ? stateFor(agent) : undefined
      if (!st || !st.enabled || !st.pendingRemind) return next()
      // 只消费与发起调用同 callId 的 post-execute；dispatch 抛错（不经
      // post-execute）时标志滞留，下一次无关工具调用不会错位注入。
      if (st.pendingRemind.callId !== (exec && exec.callId)) return next()
      const reason = st.pendingRemind.reason
      st.pendingRemind = false
      st.reminded = true // 投递成功才消耗一次性提醒
      return { kind: 'accept', additionalContexts: [makeUserMessage(reason)] }
    })

    // ── /kix-orchestration 命令 ───────────────────────────────────────────
    commands.register({
      name: 'kix-orchestration',
      description: 'kix 编排交接门禁状态：status / on|off（会话开关）',
      input: { hint: 'status | on | off' },
      handler: ({ agent, rawInput }) => {
        const st = agent ? stateFor(agent) : undefined
        const arg = (rawInput || '').trim().toLowerCase()
        if (!st) return { kind: 'error', text: 'kix-orchestration: 无可用 agent 上下文。' }
        if (arg === 'on' || arg === 'off') {
          st.enabled = arg === 'on'
          return { kind: 'success', text: `kix-orchestration: 已${arg === 'on' ? '启用' : '停用'}（本会话）` }
        }
        return {
          kind: 'success',
          text: [
            'kix-orchestration status @ ' + new Date().toISOString(),
            'enabled: ' + st.enabled,
            'intensity: ' + intensity,
            'workspaceRoot: ' + (st.workspaceRoot || '（无，需 cwd）'),
            'reminded: ' + st.reminded,
          ].join('\n'),
        }
      },
    })

    ctx.logger?.info?.('[kix-orchestration] 编排交接门禁已挂载（subagent pre-execute：sprint marker/plan/progress/blocker 校验）')
  },
}

module.exports.__internals = {
  extractHandoffMeta,
  parseProgressState,
  checkHandoff,
  makeUserMessage,
  SUBAGENT_TOOLS,
  SPRINT_MARKER,
}
