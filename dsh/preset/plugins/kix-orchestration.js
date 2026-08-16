// kix-orchestration — kixparadigm 编排交接门禁（2026-08-16，插件化改造 P2 补缺；v2 2026-08-16）
//
// 背景（用户 2026-08-16 指出"迁移是否失真"）：Copilot 侧 kixpower 的编排纪律由
// 9 个 PreToolUse/PostToolUse hooks 自动触发（validate-handoff.ps1 /
// validate-qa-signoff.ps1 / qa-freshness-check.ps1 / block-source-edit*.ps1 /
// blast-radius-check.ps1 / cleanup-qa-session.ps1 / auto-update-progress.ps1）。
// 迁移到 DSH 后，只有 blast-radius 由 kix-guards 接管，其余 7 个 hooks 变成
// "仅 prompt 约束"（模型自觉）——这就是感知到的"失真"：机械动作丢了自动化。
//
// 本插件按 kix 哲学（规则是负债、机制只补已知盲点、补足非限制）做**有界融合**：
//   只融合跨环境通用、失败代价高、可机械枚举的交接纪律；不移植 Copilot 特有流程
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
//   - subagent/end（v2，DSH×VS Code 融合矩阵 #2）：QA 子代理返回侧一致性校验——
//     VS Code 的 subagentStop 可在子代理返回后校验；DSH 原生等价是 subagent/end
//     emit（带 lastAssistantMessage）。返回含完成声明但 progress.md 未同步 →
//     agent.steer() 注入提醒（remindOnce；提醒层不 block，0% 误报）。详见
//     dsh/preset/DSH-FUSION-MATRIX.md §2。
//   - producer_closeout 收尾证据链（v3，2026-08-16）：Copilot 侧 validate-qa-signoff
//     （qa-signoff 文件/L2 SHA 绑定/manifest digest/reverify marker/stash 基线）
//     绑定 Copilot 特有流程不移植；DSH 原生补「防假完成」三件事：
//       * kix-discipline/spec.md 的「验收标准」在档（完成定义可验证）；
//       * progress.md completed==total（任务全完成，复用 parseProgressState）；
//       * 测试文件自 progress 的 l2_verified_sha 后有变更 → 要求全量重验
//         （替代 reverify marker，git diff 机械检测，不引入 marker 文件）。
//     强度与交接 gate 同档（默认 remind）；读失败 fail-open（提醒层不拦）。
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

const { readFileSync, statSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileP = promisify(execFile)

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

// ── v2（2026-08-16，DSH×VS Code 融合矩阵 #2）：QA 返回侧一致性校验 ─────────
// VS Code 的 subagentStop 可在子代理返回后校验/block；DSH 的原生等价是
// `subagent/end`（emit，带 lastAssistantMessage）——kix-orchestration 原来只
// 做 pre-execute 分派前校验，缺"返回侧"。
// 本函数机械判定：QA 子代理返回文本含完成声明，但 progress.md 的
// completed/total 未同步 → 返回 reason（提醒而非 block，kix 哲学：补足非限制）。
// 0% 误报纪律：只认明确的完成声明模式；无声明或进度已同步 → undefined（不提醒）。
const QA_DONE_MARKERS = [
  /(?:✅|✔|done|complete|passed|通过|完成|verdict\s*[:：]\s*pass|all\s+passed)/i,
]
// 与 parseProgressState 的 completed/total 语义一致；失败返回 { ok: true }
// （无法读取进度时不做机械判定，避免误报——fail-open，与 checkHandoff 的
// fail-closed 读失败不同：这是提醒层不是门禁层）。
function checkQaReturn({ text, progressMd }) {
  const t = String(text || '')
  if (!QA_DONE_MARKERS.some((re) => re.test(t))) return undefined
  const state = parseProgressState(progressMd || '')
  if (state.completed === undefined || state.total === undefined) return undefined
  if (state.completed === state.total) return undefined
  return `kix-orchestration: QA 子代理返回了完成声明，但 progress.md 进度未同步（completed=${state.completed}/${state.total}）。请让 QA 更新 progress.md 完成度后再交接。`
}

// 从 subagent/end 的 lastAssistantMessage（ContentBlock[]）提取纯文本
function lastAssistantText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

// ── v3（2026-08-16，DSH×VS Code 融合矩阵 #2 扩展）：QA 收尾证据链 gate ──────
// Copilot 侧 validate-qa-signoff.ps1 在 Producer closeout 前机械强制：
//   qa-signoff 文件 status=PASS/CONDITIONAL、L2 SHA 绑定 HEAD、gate manifest
//   digest 一致、reverify marker、stash 基线、签署后变更拦截。
// DSH 侧按 kix 哲学做**有界融合**（不搬 worktree/SHA 数学/stash——绑定 Copilot
// 特有流程 = 负债，见 DSH-ADAPTATION §2）；用 DSH 原生机制补「防假完成」三件事：
//   1. spec 契约（kix-discipline/spec.md 的 acceptance）在档——"完成定义可验证"；
//   2. progress.md 的 completed==total——"任务全完成"（复用 parseProgressState）；
//   3. 测试文件自 progress 记录的基础 SHA 后无变更——"QA 改过测试必须重验"
//      （替代 Copilot 的 reverify marker，用 git diff 机械检测，不引入 marker 文件）。
// 0% 误报纪律：无法读 spec/progress/git（无工作区/读失败）→ fail-open 不拦
// （提醒层不是门禁层，与 checkQaReturn 同哲学；checkHandoff 的 fail-closed
// 只用于它已覆盖的交接前置）。返回 reasons[]（空 = 通过）。
function checkCloseout({ prompt, workspaceRoot, specMd, progressMd, testDiff }) {
  const reasons = []
  if (!/producer_closeout/i.test(String(prompt || ''))) return reasons

  // 1. spec 契约在档（acceptance 必填——kix-discipline 五字段的验收标准）
  const specOk = typeof specMd === 'string' && /## 验收标准（可验证的完成定义）/i.test(specMd) &&
    (() => {
      const m = /## 验收标准（可验证的完成定义）[\s\S]*?\n([\s\S]*?)(?=\n## |$)/.exec(specMd)
      if (!m) return false
      const v = m[1].trim()
      // 占位符（（未填写））不算验收标准；空/占位 → 未记录
      return v.length > 0 && v !== '（未填写）'
    })()
  if (!specOk) {
    reasons.push('收尾前未在 kix-discipline/spec.md 记录「验收标准」（acceptance）。请先调用 kix_discipline_spec 落定完成定义。')
  }

  // 2. progress.md 任务全完成
  const state = parseProgressState(progressMd || '')
  if (state.completed === undefined || state.total === undefined) {
    reasons.push('收尾时无法从 progress.md 读取 completed/total。请先同步进度文件。')
  } else if (state.completed !== state.total) {
    reasons.push(`收尾时 progress.md 任务未完成（completed=${state.completed}/${state.total}）。全部完成后才能收尾。`)
  }

  // 3. 测试文件自基础 SHA 后无变更（Copilot reverify marker 的 DSH 等价）
  if (Array.isArray(testDiff) && testDiff.length > 0) {
    reasons.push(`测试文件自上次验证后有变更（${testDiff.slice(0, 3).join(', ')}…）。必须完成全量 L2 重新验证后再收尾。`)
  }

  return reasons
}

// 测试文件路径判定（与 kix-discipline 的 TEST_FILE_PATTERNS 同构）
const CLOSEOUT_TEST_PATH = /(^|[\\/])(tests?|e2e|cypress)([\\/]|$)|(?:^|[\\/])(?:.+[._-])?(?:test|spec|stories)\.[a-z0-9]+$/i
function isCloseoutTestPath(p) {
  return CLOSEOUT_TEST_PATH.test(String(p || '').replace(/\\/g, '/'))
}

// 测试变更检测：自基础 SHA 起 diff 的测试文件列表（无基础 SHA → 空，fail-open）。
// 纯异步函数：workspaceRoot 为 git 仓库根；返回匹配测试路径的数组。
async function changedTestPathsSince(workspaceRoot, baseSha) {
  if (!workspaceRoot || !/^[0-9a-f]{40}$/i.test(String(baseSha || ''))) return []
  try {
    const { stdout } = await execFileP('git', ['-C', workspaceRoot, 'diff', '--name-only', baseSha, 'HEAD'], {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    return String(stdout)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((p) => isCloseoutTestPath(p))
  } catch {
    return [] // 无 git 仓库/读取失败 → fail-open（不拦，提醒层）
  }
}

// 从 progress.md frontmatter 读基础 SHA（Copilot 的 l2_verified_sha 同源字段）
function baselineShaFromProgress(progressMd) {
  const t = String(progressMd || '')
  const m = /^[ \t]*l2_verified_sha:[ \t]*([0-9a-f]{40})/im.exec(t)
  return m ? m[1] : undefined
}

// ── v4（2026-08-17，WSL2 实测驱动）：sleep 空转等待子代理检测 ─────────────
// 实测（dae 审查会话）：主线程 8 次 `sleep 45~240s` 占住回合等后台子代理，
// description 全部含 subagent/子代理 字样。DSH 机制事实（dsh-subagent
// notifySettlement 源码）：结算投递无条件（token 耗尽/失败/取消/拆卸都通知
// 父级），父级 idle → followup 自动开新回合——收回合零丢失风险，sleep 等待
// 纯属浪费延迟与回合占用。检测面刻意收窄（0% 误报纪律）：bash 命令含裸
// sleep 数字 **且** description 提及 subagent/子代理 → 一次性提醒改收回合。
// 测试退避/重试/等锁的 sleep（description 不匹配）不提醒；等后台 job 的
// 正确形态是 job_output wait:true（另一模式，不在本检测面）。
const SLEEP_WAIT_CMD = /(^|[;&|]\s*)sleep\s+\d/
const SLEEP_WAIT_DESC = /subagent|子代理/i
const SLEEP_WAIT_REMIND =
  'kix-orchestration: 检测到用 sleep 等待后台子代理。DSH 的结算/报告投递会无条件唤醒父级（收回合后自动开新回合，无丢失风险）；请改为：独立工作做完仍缺结果 → 简短状态后结束回合，等 subagent-settled/subagent-report 唤醒继续。sleep 只用于测试与超时语义（退避/等锁）。'

/** bash sleep 等待子代理判定（纯函数，测试经 __internals 验证）。 */
function isSleepWaitForSubagent({ command, description }) {
  const cmd = typeof command === 'string' ? command : ''
  const desc = typeof description === 'string' ? description : ''
  return SLEEP_WAIT_CMD.test(cmd) && SLEEP_WAIT_DESC.test(desc)
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
        st = { enabled: true, reminded: false, returnReminded: false, sleepReminded: false, workspaceRoot: defaultRoot || cwd || undefined }
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

    // ── pre-execute：subagent 交接门禁 + v4 sleep 等待检测 ────────────────
    ctx.on('tools/pre-execute', async (exec, next) => {
      const name = exec && exec.name
      const tool = (name || '').toLowerCase()
      if (!SUBAGENT_TOOLS.has(tool)) {
        // v4：sleep 空转等待子代理（一次性提醒）。刻意不参与 intensity
        // block/ask——sleep 是编排卫生问题不是危险操作，remind 恰当。
        if (tool === 'bash') {
          const st = exec && exec.agent ? stateFor(exec.agent) : undefined
          if (st && st.enabled && !st.sleepReminded) {
            const args = exec && (exec.arguments ?? exec.args)
            const cmd = args && typeof args.command === 'string' ? args.command : ''
            const desc = args && typeof args.description === 'string' ? args.description : ''
            if (isSleepWaitForSubagent({ command: cmd, description: desc })) {
              st.pendingSleepRemind = { callId: exec.callId }
            }
          }
        }
        return next()
      }

      const args = exec && (exec.arguments ?? exec.args)
      const agent = exec && exec.agent
      const st = stateFor(agent)
      if (!st.enabled) return next()

      // DSH subagent 工具的 prompt 在 args.prompt（SubagentStartRequest 契约）
      const prompt = args && (args.prompt || args.content)
      if (typeof prompt !== 'string' || prompt.length === 0) return next()

      const workspaceRoot = st.workspaceRoot || agentCwd(exec)
      const result = checkHandoff({ prompt, workspaceRoot })
      if (!result.ok) {
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
      }

      // v3：producer_closeout 收尾 gate（QA 证据链，DSH 原生；见 checkCloseout 注释）
      if (/producer_closeout/i.test(prompt)) {
        const closeReasons = []
        try {
          const specFile = join(workspaceRoot, 'kix-discipline', 'spec.md')
          const specMd = isFile(specFile) ? readFileSync(specFile, 'utf8') : undefined
          // active sprint 的 progress.md（与 checkHandoff/subagent/end 同源）
          const docsRoot = join(workspaceRoot, 'docs')
          const markerFile = join(docsRoot, SPRINT_MARKER)
          let active = 0
          if (isFile(markerFile)) {
            const v = readFileSync(markerFile, 'utf8').trim()
            if (/^\d+$/.test(v)) active = Number(v)
          }
          let progressMd = undefined
          if (active > 0) {
            const pf = join(docsRoot, 'sprint-' + active, 'progress.md')
            if (isFile(pf)) progressMd = readFileSync(pf, 'utf8')
          }
          const baseSha = baselineShaFromProgress(progressMd)
          const testDiff = await changedTestPathsSince(workspaceRoot, baseSha)
          closeReasons.push(...checkCloseout({ prompt, workspaceRoot, specMd, progressMd, testDiff }))
        } catch { /* 读失败 → fail-open（提醒层不拦） */ }

        if (closeReasons.length > 0) {
          const reason = 'kix-orchestration: ' + closeReasons.join(' ')
          if (intensity === 'block') {
            return { kind: 'deny', reason }
          }
          if (intensity === 'ask') {
            const ok = await askUser(exec, reason)
            if (ok === false) return { kind: 'deny', reason: 'kix-orchestration: 用户拒绝，请先补齐收尾证据链。' }
            if (ok === void 0) return { kind: 'deny', reason: 'kix-orchestration: 无法向用户提问（无提问通道），已自动拒绝。' }
            return next()
          }
          if (st.reminded) return next()
          st.pendingRemind = { callId: exec.callId, reason }
          return next()
        }
      }

      return next()
    })

    // ── post-execute：注入 remind（handoff 槽 + v4 sleep 槽各自独立）──────
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const agent = exec && exec.agent
      const st = agent ? stateFor(agent) : undefined
      if (!st || !st.enabled) return next()
      // v4：sleep 等待提醒（独立槽位 + 独立一次性标志，不烧 handoff 的
      // pendingRemind/reminded）。callId 不匹配时落回 handoff 槽继续判，
      // 两个槽的工具面不相交（bash vs subagent*），互不干扰。
      if (st.pendingSleepRemind && st.pendingSleepRemind.callId === (exec && exec.callId)) {
        st.pendingSleepRemind = false
        st.sleepReminded = true
        return { kind: 'accept', additionalContexts: [makeUserMessage(SLEEP_WAIT_REMIND)] }
      }
      if (!st.pendingRemind) return next()
      // 只消费与发起调用同 callId 的 post-execute；dispatch 抛错（不经
      // post-execute）时标志滞留，下一次无关工具调用不会错位注入。
      if (st.pendingRemind.callId !== (exec && exec.callId)) return next()
      const reason = st.pendingRemind.reason
      st.pendingRemind = false
      st.reminded = true // 投递成功才消耗一次性提醒
      return { kind: 'accept', additionalContexts: [makeUserMessage(reason)] }
    })

    // ── v2：subagent/end 返回侧校验（DSH×VS Code 融合矩阵 #2）────────────
    // VS Code subagentStop 等价物的 DSH 原生形态：emit 观察子代理返回，若 QA
    // 返回完成声明但 progress.md 未同步 → steer 注入提醒（remindOnce）。
    // emit 模式不能 block（那是 pre-execute/post-execute 的事），提醒层符合
    // kix「补足非限制」；0% 误报：无完成声明/进度已同步/无法读进度都不提醒。
    ctx.on('subagent/end', (info, parent) => {
      try {
        const agent = parent || (info && info.agent) || undefined
        if (!agent) return
        const st = stateFor(agent)
        if (!st.enabled || st.returnReminded) return
        const text = lastAssistantText(info && info.lastAssistantMessage)
        if (!text) return
        // parent agent 自身的 cwd 是权威工作区根（subagent/end 的 parent 即发起方）；
        // sandbox 默认根仅作兜底（与 pre-execute 的 agentCwd 优先级相反：这里是
        // 父代理视角，不是工具执行视角）。
        const parentCwd = (agent.session && agent.session.header && agent.session.header.cwd) || undefined
        const workspaceRoot = parentCwd || st.workspaceRoot || undefined
        if (!workspaceRoot) return
        // 读 active sprint 的 progress.md（与 checkHandoff 同源；读失败 fail-open）
        let progressMd = undefined
        try {
          const docsRoot = join(workspaceRoot, 'docs')
          const markerFile = join(docsRoot, SPRINT_MARKER)
          let active = 0
          if (isFile(markerFile)) {
            const v = readFileSync(markerFile, 'utf8').trim()
            if (/^\d+$/.test(v)) active = Number(v)
          }
          const dirs = []
          try {
            for (const e of readdirSync(docsRoot, { withFileTypes: true })) {
              if (e.isDirectory() && /^sprint-\d+$/.test(e.name)) dirs.push(e.name)
            }
          } catch { /* 无 docs 目录 → 跳过 */ }
          const target = active > 0 ? 'sprint-' + active : (dirs.sort().pop() || '')
          if (target) {
            const pf = join(docsRoot, target, 'progress.md')
            if (isFile(pf)) progressMd = readFileSync(pf, 'utf8')
          }
        } catch { /* 读失败 → 不提醒（fail-open） */ }
        const reason = checkQaReturn({ text, progressMd })
        if (!reason) return
        st.returnReminded = true
        agent.steer(makeUserMessage(reason))
      } catch { /* 监听器自身异常不阻断（emit 容器化） */ }
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

    ctx.logger?.info?.('[kix-orchestration] 编排交接门禁已挂载（subagent pre-execute：sprint marker/plan/progress/blocker 校验 + producer_closeout 收尾证据链 v3；subagent/end：QA 返回侧一致性校验 v2；bash sleep 等待子代理一次性提醒 v4）')
  },
}

module.exports.__internals = {
  extractHandoffMeta,
  parseProgressState,
  checkHandoff,
  checkQaReturn,
  checkCloseout,
  lastAssistantText,
  isCloseoutTestPath,
  baselineShaFromProgress,
  isSleepWaitForSubagent,
  SLEEP_WAIT_CMD,
  SLEEP_WAIT_DESC,
  makeUserMessage,
  SUBAGENT_TOOLS,
  SPRINT_MARKER,
}
