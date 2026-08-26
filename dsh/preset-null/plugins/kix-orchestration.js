// kix-orchestration — kixparadigm 编排交接门禁（2026-08-16，插件化改造 P2 补缺；v2 2026-08-16；v8 v1.2.10）
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
// v8（v1.2.10）：checkQaReturn 完成声明识别改为「负向表述优先排除 + 明确
//   正向锚点匹配」——not done / undone / not passed / passed nothing /
//   completed=false 不再触发提醒；回归见测试「负向表述」用例。
// v11（2026-08-17，P5 落地）：plan.md 契约写前校验——写 docs/sprint-N/plan.md
//   时校验 kix-guards 预算链真正消费的字段（task_sizing.derived_commit_budget /
//   blast_radius.max_commits）与任务清单存在性（边界注释「task_dag /
//   verifiable_gates 结构校验做轻量版」落地）；缺则 remind（ask/block 可配）。
//   只对 write 全量写入校验（args.content 可拿完整新内容）；edit 拿不到完整
//   新内容，0 误报纪律不猜测。
//
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
const { join, resolve, relative, isAbsolute } = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const lib = require('./consistency-lib.cjs')
const guardInternals = require('./kix-guards.js').__internals

const execFileP = promisify(execFile)

// ── 常量 ───────────────────────────────────────────────────────────────────
const SUBAGENT_TOOLS = new Set([
  'subagent', 'subagent_fork', 'subagent_cross', 'subagent_lite',
  'subagent_thinker', 'subagent_vision', 'subagent_reviewer',
  // 2026-08-17 编曲成员档：集合本意 = 全部 subagent 行（2026-08-17 前例
  // reviewer 漏收已修过一次），qa/dev 分派携带 sprint 元数据同样过交接 gate。
  'subagent_qa', 'subagent_dev',
  'subagent_codex', 'subagent_claude_code',
])
const SPRINT_MARKER = '.kixpower-current-sprint'
const REVIEW_STAGES = new Set(['design', 'final', 'verification'])
const REVIEW_POLICY = 'read-only'
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'diff', 'show', 'log', 'rev-parse', 'ls-files', 'ls-tree',
  'ls-remote', 'cat-file', 'blame', 'grep', 'describe', 'name-rev',
  'merge-base', 'for-each-ref', 'shortlog', 'diff-tree', 'diff-index',
])
const REVIEW_SHELL_MUTATING_COMMANDS = new Set([
  'apply_patch', 'rm', 'mv', 'cp', 'touch', 'mkdir', 'install', 'truncate', 'tee',
  'chmod', 'chown', 'ln',
  'set-content', 'add-content', 'out-file', 'remove-item', 'move-item', 'copy-item',
  'rename-item', 'new-item',
])
const PYTHON_WRITE_RE = /(?:\bopen\s*\([^)]*['"][wax+]|\.(?:write_text|write_bytes|unlink)\s*\(|\bos\.(?:remove|unlink|rename|replace)\s*\()/
const NODE_WRITE_RE = /(?:writeFileSync|appendFileSync|createWriteStream|rmSync|unlinkSync|renameSync)\s*\(/

// ── 纯判定函数（模块级：单元测试经 __internals 直接验证）─────────────────

// review epoch 是信息边界，不是观察预算。一个 review lead 可以继续递归分派，
// 但整棵观察树共享相同 artifact root，直到全部 child 结算前协调线程不能改它。
function subagentInvocation(exec) {
  const tool = String(exec && exec.name || '').toLowerCase()
  const args = exec && (exec.arguments ?? exec.args) || {}
  if (tool === 'kix_capability_call') {
    const nestedTool = String(args.tool || '').toLowerCase()
    if (SUBAGENT_TOOLS.has(nestedTool)) return { tool: nestedTool, args: args.arguments || {} }
  }
  return { tool, args }
}

function extractReviewEpochMeta(prompt) {
  const p = String(prompt || '')
  const field = (name) => {
    const m = new RegExp(`^[ \\t]*${name}:[ \\t]*(.+?)[ \\t]*$`, 'im').exec(p)
    return m && m[1] ? m[1].trim() : undefined
  }
  const stage = String(field('review_stage') || '').toLowerCase()
  const policy = String(field('review_policy') || '').toLowerCase().replace(/_/g, '-')
  const roots = [...p.matchAll(/^[ \t]*artifact_root:[ \t]*(.+?)[ \t]*$/gim)]
    .map((m) => m[1].trim())
    .filter(Boolean)
  if (!REVIEW_STAGES.has(stage) || policy !== REVIEW_POLICY || roots.length === 0 || roots.some((root) => !isAbsolute(root))) return undefined
  return {
    stage,
    policy,
    roots: [...new Set(roots.map((root) => resolve(root)))],
    revision: field('artifact_revision'),
  }
}

function pathInside(root, candidate) {
  if (!root || !candidate) return false
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function agentCwd(agent) {
  return agent && agent.session && agent.session.header && agent.session.header.cwd
}

function resolveAgentPath(agent, value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const p = value.trim()
  return isAbsolute(p) ? resolve(p) : resolve(agentCwd(agent) || process.cwd(), p)
}

function commandWorkdir(agent, args) {
  return resolveAgentPath(agent, args && args.workdir) || resolve(agentCwd(agent) || process.cwd())
}

// git branch / git config 有只读形态（列举、取值）和写形态（创建、删除、赋值）。
// 旧实现「不在白名单 = 写」把 `git branch -a` / `git config user.name` 锁进
// review epoch，逼协调线程改 probe 或杀掉观察者。按本条 invocation 的参数判定。
const GIT_BRANCH_WRITE_FLAGS = new Set([
  '-d', '-D', '-m', '-M', '-c', '-C', '-u',
  '--delete', '--move', '--copy', '--set-upstream-to', '--unset-upstream',
  '--edit-description', '--create-reflog',
])
const GIT_CONFIG_WRITE_FLAGS = new Set([
  '--add', '--unset', '--unset-all', '--replace-all',
  '--rename-section', '--remove-section', '--edit', '-e',
])
const GIT_CONFIG_GET_FLAGS = new Set([
  '--get', '--get-all', '--get-regexp', '--get-urlmatch',
  '--list', '-l', '--name-only', '--show-origin', '--show-scope',
])

function gitFlagBase(token) {
  const t = String(token || '')
  const eq = t.indexOf('=')
  return eq === -1 ? t : t.slice(0, eq)
}

function gitBranchIsMutation(args) {
  const list = Array.isArray(args) ? args : []
  let positional = 0
  for (let i = 0; i < list.length; i++) {
    const t = list[i]
    const flag = gitFlagBase(t)
    if (GIT_BRANCH_WRITE_FLAGS.has(t) || GIT_BRANCH_WRITE_FLAGS.has(flag)) return true
    if (t === '--list' || flag === '--list' || t === '--contains' || t === '--no-contains' ||
        t === '--merged' || t === '--no-merged' || t === '--points-at' || t === '--sort' ||
        t === '--format' || t === '--column') {
      if (!t.includes('=') && i + 1 < list.length && !String(list[i + 1]).startsWith('-')) i++
      continue
    }
    if (t.startsWith('-')) continue
    positional++
  }
  return positional > 0
}

function gitFirstPositional(args) {
  const list = Array.isArray(args) ? args : []
  for (let i = 0; i < list.length; i++) {
    const t = String(list[i])
    if (t.startsWith('-')) continue
    return t.toLowerCase()
  }
  return undefined
}

function gitStashIsMutation(args) {
  const action = gitFirstPositional(args)
  if (!action) return true
  return action !== 'list' && action !== 'show'
}

function gitRemoteIsMutation(args) {
  const action = gitFirstPositional(args)
  if (!action) return false
  return action !== 'show' && action !== 'get-url'
}

function gitTagIsMutation(args) {
  const writeFlags = new Set([
    '-d', '-D', '--delete', '-a', '--annotate', '-s', '--sign',
    '-u', '--local-user', '-f', '--force', '-m', '--message', '-F', '--file',
    '--create-reflog',
  ])
  const list = Array.isArray(args) ? args : []
  let listMode = false
  let positional = 0
  for (let i = 0; i < list.length; i++) {
    const t = String(list[i])
    const flag = gitFlagBase(t)
    if (writeFlags.has(t) || writeFlags.has(flag)) return true
    if (t === '-l' || t === '--list' || flag === '--list' || t === '-n' || flag === '-n') {
      listMode = true
      if (!t.includes('=') && i + 1 < list.length && !String(list[i + 1]).startsWith('-') && (t === '-n' || t === '--list' || flag === '--list')) i++
      continue
    }
    if (t.startsWith('-')) continue
    positional++
  }
  if (listMode) return false
  return positional > 0
}

function gitNotesIsMutation(args) {
  const action = gitFirstPositional(args)
  if (!action) return false
  return action !== 'list' && action !== 'show' && action !== 'get-ref'
}

function gitWorktreeIsMutation(args) {
  const action = gitFirstPositional(args)
  if (!action || action === 'list') return false
  return true
}

function gitReflogIsMutation(args) {
  const action = gitFirstPositional(args)
  if (!action || action === 'show' || action === 'exists') return false
  return true
}

function nodeEvalSource(args) {
  const list = Array.isArray(args) ? args : []
  for (let i = 0; i < list.length; i++) {
    const t = String(list[i])
    if (t === '-e' || t === '--eval' || t === '-p' || t === '--print') {
      return i + 1 < list.length ? String(list[i + 1]) : ''
    }
    if (t.startsWith('--eval=')) return t.slice('--eval='.length)
    if (t.startsWith('--print=')) return t.slice('--print='.length)
  }
  return undefined
}

function pythonEvalSource(args) {
  const list = Array.isArray(args) ? args : []
  for (let i = 0; i < list.length; i++) {
    const t = String(list[i])
    if (t === '-c') return i + 1 < list.length ? String(list[i + 1]) : ''
    if (t.startsWith('-c') && t.length > 2 && !t.startsWith('--')) return t.slice(2)
  }
  return undefined
}

function gitConfigIsMutation(args) {
  const list = Array.isArray(args) ? args : []
  let getMode = false
  let positional = 0
  for (let i = 0; i < list.length; i++) {
    const t = list[i]
    const flag = gitFlagBase(t)
    if (GIT_CONFIG_WRITE_FLAGS.has(t) || GIT_CONFIG_WRITE_FLAGS.has(flag)) return true
    if (GIT_CONFIG_GET_FLAGS.has(t) || GIT_CONFIG_GET_FLAGS.has(flag)) {
      getMode = true
      if (!t.includes('=') && (t === '--get' || t === '--get-all' || t === '--get-regexp' || t === '--get-urlmatch') &&
          i + 1 < list.length && !String(list[i + 1]).startsWith('-')) i++
      continue
    }
    if (t === '--global' || t === '--local' || t === '--system' || t === '--worktree') continue
    if (t === '--file' || t === '-f' || t === '--blob') {
      if (i + 1 < list.length && !String(list[i + 1]).startsWith('-')) i++
      continue
    }
    if (flag === '--file' || flag === '--blob') continue
    if (t.startsWith('-')) continue
    positional++
  }
  if (getMode) return false
  return positional >= 2
}

function reviewGitMutation(command) {
  const invocations = typeof guardInternals.gitInvocations === 'function'
    ? guardInternals.gitInvocations(String(command || ''))
    : []
  if (invocations.length === 0) {
    const subs = guardInternals.gitSubcommands(String(command || ''))
    for (const sub of subs) if (!READ_ONLY_GIT_SUBCOMMANDS.has(String(sub).toLowerCase())) return true
    return false
  }
  for (const inv of invocations) {
    const sub = String(inv.sub || '').toLowerCase()
    if (sub === 'branch') {
      if (gitBranchIsMutation(inv.args)) return true
      continue
    }
    if (sub === 'config') {
      if (gitConfigIsMutation(inv.args)) return true
      continue
    }
    if (sub === 'stash') {
      if (gitStashIsMutation(inv.args)) return true
      continue
    }
    if (sub === 'remote') {
      if (gitRemoteIsMutation(inv.args)) return true
      continue
    }
    if (sub === 'tag') {
      if (gitTagIsMutation(inv.args)) return true
      continue
    }
    if (sub === 'notes') {
      if (gitNotesIsMutation(inv.args)) return true
      continue
    }
    if (sub === 'worktree') {
      if (gitWorktreeIsMutation(inv.args)) return true
      continue
    }
    if (sub === 'reflog') {
      if (gitReflogIsMutation(inv.args)) return true
      continue
    }
    if (!READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return true
  }
  return false
}

function segmentHasUnquotedRedirect(text) {
  let quote = null
  let escaped = false
  const s = String(text || '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === '\\' && i + 1 < s.length) { i++; continue }
    if (ch === '>' && (i === 0 || /\s/.test(s[i - 1]))) {
      let j = i + 1
      if (s[j] === '>') j++
      while (j < s.length && /\s/.test(s[j])) j++
      if (j < s.length) return true
    }
  }
  return false
}

function reviewShellMutation(command) {
  const split = guardInternals.splitShellSegments
  const tokensOf = guardInternals.shellTokens
  const leading = guardInternals.leadingCommand
  for (const part of split(String(command || ''))) {
    if (segmentHasUnquotedRedirect(part.text)) return true
    const cmd = leading(tokensOf(part.text))
    if (!cmd) continue
    const name = String(cmd.name || '').toLowerCase()
    const args = Array.isArray(cmd.args) ? cmd.args : []
    if (REVIEW_SHELL_MUTATING_COMMANDS.has(name)) return true
    if (name === 'sed' && args.some((a) => a === '-i' || String(a).startsWith('-i'))) return true
    if (name === 'perl' && args.some((a) => a === '-pi' || String(a).startsWith('-pi'))) return true
    if (name === 'gofmt' && args.includes('-w')) return true
    if (name === 'go' && args[0] === 'fmt') return true
    if (name === 'cargo' && args[0] === 'fmt') return true
    if (name === 'eslint' && args.some((a) => a === '--fix' || a === '--write')) return true
    if (name === 'biome' && args[0] === 'check' && args.some((a) => a === '--fix' || a === '--write')) return true
    if (name === 'python' || name === 'python3') {
      const src = pythonEvalSource(args)
      if (src != null && PYTHON_WRITE_RE.test(src)) return true
      continue
    }
    if (name === 'node' || name === 'nodejs') {
      const src = nodeEvalSource(args)
      if (src != null) {
        const surface = typeof guardInternals.executableJsSurface === 'function'
          ? guardInternals.executableJsSurface(src)
          : src
        if (NODE_WRITE_RE.test(surface)) return true
      }
      continue
    }
    if (name === 'dd' && args.some((a) => String(a).startsWith('of='))) return true
  }
  return false
}

function reviewCommandRoot(agent, args) {
  const workdir = commandWorkdir(agent, args)
  const hinted = guardInternals.repoRootFromText(String(args && args.command || ''))
  return hinted ? resolveAgentPath({ session: { header: { cwd: workdir } } }, hinted) : workdir
}

function toolResultValue(result) {
  let value = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result
  if (value && value.ok === true && Object.prototype.hasOwnProperty.call(value, 'result')) value = value.result
  if (value && value.isError === false && Object.prototype.hasOwnProperty.call(value, 'value')) value = value.value
  return value
}

async function gitArtifactFingerprint(root) {
  try {
    const opts = { maxBuffer: 64 * 1024 * 1024 }
    const [head, status, diff, untracked] = await Promise.all([
      execFileP('git', ['-C', root, 'rev-parse', 'HEAD'], opts),
      execFileP('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], opts),
      execFileP('git', ['-C', root, 'diff', '--binary', '--no-ext-diff', 'HEAD', '--'], opts),
      execFileP('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], opts),
    ])
    const digest = createHash('sha256')
      .update(String(status.stdout || ''))
      .update('\0')
      .update(String(diff.stdout || ''))
    for (const file of String(untracked.stdout || '').split('\0').filter(Boolean)) {
      const full = join(root, file)
      const stat = statSync(full)
      digest.update('\0' + file + '\0' + stat.size + '\0')
      if (stat.isFile() && stat.size <= 16 * 1024 * 1024) digest.update(readFileSync(full))
      else digest.update(String(stat.mtimeMs))
    }
    const hash = digest.digest('hex')
    return `${String(head.stdout || '').trim()}:${hash}`
  } catch {
    return undefined
  }
}

// 从分派 prompt 提取交接元数据（Copilot hook 同款容错字段名）
function extractHandoffMeta(prompt) {
  const p = String(prompt || '')
  const out = { sprint: 0, mode: null, partition: null, target: null }
  const re = (pat) => new RegExp(pat, 'im')
  let m = re('^[ \\t]*current_sprint:\\s*(\\d+)[ \\t]*(?:#.*)?$').exec(p)
  if (m) out.sprint = Number(m[1])
  // v10.1（2026-08-17 交接 gate 机械兜底，Tri-Block 容错）：模型用 Tri-Block
  // 分派时可能只在 [CONTEXT] 段写"Sprint N"而漏写契约行 current_sprint: N →
  // 旧实现 sprint=0 → 交接门禁静默放行（2026-08-17 部署 E2E 实锤）。无契约行
  // 时从 [CONTEXT] 段兜底解析 Sprint N；范围刻意收窄到 [CONTEXT] 段（观察者/
  // 轻路径 prompt 无此段即不触发），且仅作兜底——契约行永远优先。
  if (!m) {
    const ctxSeg = /\[CONTEXT\]([\s\S]*?)(?=\[TASK\]|\[CONSTRAINTS\]|$)/i.exec(p)
    if (ctxSeg) {
      const sm = /\bSprint\s+(\d+)\b/i.exec(ctxSeg[1])
      if (sm) out.sprint = Number(sm[1])
    }
  }
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
// 本函数机械判定：QA 子代理返回文本含**明确正向**完成声明，但 progress.md 的
// completed/total 未同步 → 返回 reason（提醒而非 block，kix 哲学：补足非限制）。
// 0% 误报纪律落地：负向表述（not done/undone/not passed/passed nothing/
// completed=false）先排除，再匹配带语境锚点的正向声明；无声明或进度已同步
// → undefined（不提醒）。
const QA_NEGATIVE_MARKERS = [
  /\bnot\s+(?:done|complete(?:d)?|passed|finished|passing)\b/i,
  /\bno\s+(?:completion|pass)\b/i,
  /\bun(?:done|completed)\b/i,
  /\bpassed\s+nothing\b/i,
  /\bcompleted\s*[:=]\s*false\b/i,
  /\bdid\s+not\s+(?:complete|pass|finish)\b/i,
  /\bdoes\s+not\s+(?:complete|pass)\b/i,
  /(?:未|没有|尚未)(?:全部|所有)?(?:通过|完成)/,
  /(?:未|没有|尚未)通过/,
]
const QA_DONE_MARKERS = [
  /(?:✅|✔)[^\r\n]{0,40}(?:通过|passed|done|complete(?:d)?|完成|\bpass\b|\bPASS\b)/i,
  /(?:通过|passed|done|complete(?:d)?|完成)[^\r\n]{0,20}(?:✅|✔)/i,
  /(?:verdict|结论|result)\s*[:：]\s*(?:pass|passed|通过|完成|complete(?:d)?)/i,
  /\bQA\s+(?:passed|通过|完成|done|complete(?:d)?)\b/i,
  /\b(?:all|所有|全部)\s+(?:tests?|checks?|gates?|测试|用例)\s*(?:passed|通过|完成)/i,
  /\b(?:tests?|checks?|gates?)\s+(?:passed|完成|通过)\b/i,
  /(?:全部通过|全部完成|验收通过|验证通过|测试通过|质检通过)/,
  /\ball\s+(?:done|completed|passed)\b/i,
  /\bPASS(?:ED)?\b/i,
]
// 与 parseProgressState 的 completed/total 语义一致；失败返回 { ok: true }
// （无法读取进度时不做机械判定，避免误报——fail-open，与 checkHandoff 的
// fail-closed 读失败不同：这是提醒层不是门禁层）。
function hasQaCompletion(text) {
  const t = String(text || '')
  if (QA_NEGATIVE_MARKERS.some((re) => re.test(t))) return false
  return QA_DONE_MARKERS.some((re) => re.test(t))
}

function checkQaReturn({ text, progressMd }) {
  const t = String(text || '')
  if (!hasQaCompletion(t)) return undefined
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
// 纯属浪费延迟与回合占用。
// v4.1（同日，去硬编码）：**不按工具名门控**。工具名与平台是部署选择
// （preset 按平台挂载 pwsh/bash；WSL/容器/未来终端工具不可枚举），命令形态
// 才携带语义——bash 里跑 `pwsh -c "Start-Sleep 30"` 或 pwsh 里跑 bash sleep
// 都该命中，因此两种形态恒测于任意工具的 arguments.command（无 command 的
// 工具自然不命中，零开销短路）。检测面刻意收窄（0% 误报纪律）：命令含裸
// sleep 数字 **且** description 提及 subagent/子代理 → 一次性提醒改收回合。
// 测试退避/重试/等锁的 sleep（description 不匹配）不提醒；等后台 job 的
// 正确形态是 job_output wait:true（另一模式，不在本检测面）。
// 形态覆盖：bash `sleep 45`（含单位后缀 5m/30s/2h/1d 与小数）+ pwsh
// `Start-Sleep -Seconds 60` / `Start-Sleep 60`（大小写不敏感）。锚点防
// 引号内文本误报（Write-Output 'start-sleep 5' 不命中）。
const SLEEP_WAIT_CMD = /(^|[;&|]\s*)sleep\s+\d+(?:\.\d+)?[smhd]?\b/i
const PWSH_SLEEP_WAIT_CMD = /(^|[;\r\n]|&&|\|\|)\s*start-sleep\s+(?:-\w+\s+)*-?\d/i
const SLEEP_WAIT_DESC = /subagent|子代理/i
const SLEEP_WAIT_REMIND =
  'kix-orchestration: 检测到用 sleep 等待后台子代理。DSH 的结算/报告投递会无条件唤醒父级（收回合后自动开新回合，无丢失风险）；请改为：独立工作做完仍缺结果 → 简短状态后结束回合，等 subagent-settled/subagent-report 唤醒继续。sleep 只用于测试与超时语义（退避/等锁）。'

/** sleep 等待子代理判定（纯函数，测试经 __internals 验证）。平台无关：
 *  双命令形态恒测（bash sleep / pwsh Start-Sleep），不依赖工具名。 */
function isSleepWaitForSubagent({ command, description }) {
  const cmd = typeof command === 'string' ? command : ''
  const desc = typeof description === 'string' ? description : ''
  return (SLEEP_WAIT_CMD.test(cmd) || PWSH_SLEEP_WAIT_CMD.test(cmd)) && SLEEP_WAIT_DESC.test(desc)
}

// plan.md 契约轻量校验（v11，P5；边界注释「task_dag / verifiable_gates 结构
// 校验做轻量版（存在性）」落地）。只校验 kix-guards 预算链真正消费的字段 +
// 任务清单存在性——机械可枚举、0 误报（合法 plan 必然具备）：
//   - 预算链有源：task_sizing.derived_commit_budget 或 blast_radius.max_commits
//     （缺则 resolveCommitBudget 静默落冷启动 3——sprint-9 事故形态，guards v7 修过）
//   - 任务清单：至少一条 - [ ] / - [x]（`*` bullet 同样接受——GitHub 任务列表两种写法）
// 不做 manifest SHA 数学、不校验任务内容（认知层留给模型）。
function checkPlanContract(text) {
  const s = String(text || '')
  const reasons = []
  const hasBudgetSource = /task_sizing:[\s\S]*?derived_commit_budget:\s*\d+/.test(s) ||
    /blast_radius:[\s\S]*?max_commits:\s*\d+/.test(s)
  if (!hasBudgetSource) {
    reasons.push('plan.md 缺少 commit 预算来源（task_sizing.derived_commit_budget 或 blast_radius.max_commits）——预算兜底链将静默落冷启动 3')
  }
  if (!/[-*+]\s*\[[ xX]\]/.test(s)) {
    reasons.push('plan.md 缺少任务清单（- [ ] 条目）')
  }
  return reasons
}

function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'kix-orchestration', form: 'notice', summary: text.slice(0, 100) },
  }
}

function lifecycleRunKey(info) {
  return info && (info.runId || info.id) ? String(info.runId || info.id) : undefined
}

function lifecycleParentAgent(ctx, info) {
  const agents = ctx.get && ctx.get('agents')
  if (!agents || typeof agents.get !== 'function' || !info || !info.id) return undefined
  const child = agents.get(String(info.id))
  const parentId = child && child.session && child.session.header && child.session.header.parentSession
  return parentId ? agents.get(parentId) : undefined
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

    const states = new Map()
    const reviewEpochs = new Map()
    const reviewEpochByAgent = new Map()
    const lifecycleParents = new Map()

    function stateFor(agent) {
      const key = agent && agent.id ? String(agent.id) : 'anonymous'
      let st = states.get(key)
      if (!st) {
        const workspaceRoot = lib.resolveWorkspaceRoot(agent, sandboxPolicy) || undefined
        st = {
          enabled: true,
          reminded: false,
          returnReminded: false,
          sleepReminded: false,
          planReminded: false,
          pendingPlanRemind: null,
          workspaceRoot,
          reviewEpochIds: new Set(),
          pendingReviewEpochs: [],
        }
        states.set(key, st)
      }
      return st
    }

    function epochForAgent(agent) {
      const id = agent && agent.id ? String(agent.id) : undefined
      return id ? reviewEpochByAgent.get(id) : undefined
    }

    function activeEpochsOwnedBy(agent) {
      const st = stateFor(agent)
      return [...st.reviewEpochIds].map((id) => reviewEpochs.get(id)).filter((epoch) => epoch && !epoch.finalized)
    }

    function mutationPath(exec) {
      const tool = String(exec && exec.name || '').toLowerCase()
      if (tool !== 'edit' && tool !== 'write') return undefined
      const args = exec && (exec.arguments ?? exec.args)
      return resolveAgentPath(exec && exec.agent, args && (args.file_path || args.path))
    }

    function commandTouchesEpoch(exec, epoch) {
      const args = exec && (exec.arguments ?? exec.args)
      if (!args || typeof args.command !== 'string') return false
      const gitMutation = reviewGitMutation(args.command)
      const shellMutation = reviewShellMutation(args.command)
      if (!gitMutation && !shellMutation) return false
      const commandRoot = reviewCommandRoot(exec && exec.agent, args)
      return epoch.roots.some((root) =>
        pathInside(root, commandRoot) || pathInside(commandRoot, root) ||
        (shellMutation && String(args.command).includes(root)))
    }

    function epochBlocksMutation(exec, epoch) {
      const target = mutationPath(exec)
      if (target && epoch.roots.some((root) => pathInside(root, target))) return true
      return commandTouchesEpoch(exec, epoch)
    }

    async function beginReviewEpoch(exec) {
      if (epochForAgent(exec && exec.agent)) return undefined // descendants inherit; never nest/leak epochs
      const args = subagentInvocation(exec).args
      const meta = extractReviewEpochMeta(args && args.prompt)
      if (!meta || !exec || !exec.agent) return undefined
      const ownerId = String(exec.agent.id || 'anonymous')
      const epoch = {
        id: `${ownerId}:${String(exec.callId || randomUUID())}`,
        owner: exec.agent,
        ownerId,
        callId: exec.callId,
        label: String(args && args.description || ''),
        stage: meta.stage,
        policy: meta.policy,
        roots: meta.roots,
        revision: meta.revision,
        fingerprints: new Map(),
        activeAgents: new Set(),
        rootAgentId: undefined,
        finalized: false,
      }
      for (const root of epoch.roots) epoch.fingerprints.set(root, await gitArtifactFingerprint(root))
      reviewEpochs.set(epoch.id, epoch)
      const st = stateFor(exec.agent)
      st.reviewEpochIds.add(epoch.id)
      st.pendingReviewEpochs.push(epoch.id)
      return epoch
    }

    function bindReviewAgent(epoch, childId) {
      if (!epoch || !childId || epoch.finalized) return
      const id = String(childId)
      epoch.activeAgents.add(id)
      if (!epoch.rootAgentId) epoch.rootAgentId = id
      reviewEpochByAgent.set(id, epoch)
    }

    // subagent/start 没有 initiating callId；并发同标签调用只能先暂绑。工具返回的
    // continuable.subagentId 与 callId 同时可见，用它把 root child 纠正到真实 epoch。
    function bindRootReviewAgent(epoch, childId) {
      if (!epoch || !childId || epoch.finalized) return
      const id = String(childId)
      const priorEpoch = reviewEpochByAgent.get(id)
      if (priorEpoch && priorEpoch !== epoch) {
        priorEpoch.activeAgents.delete(id)
        if (priorEpoch.rootAgentId === id) priorEpoch.rootAgentId = undefined
      }
      if (epoch.rootAgentId && epoch.rootAgentId !== id) {
        const priorRoot = epoch.rootAgentId
        epoch.activeAgents.delete(priorRoot)
        if (reviewEpochByAgent.get(priorRoot) === epoch) reviewEpochByAgent.delete(priorRoot)
      }
      epoch.rootAgentId = id
      epoch.activeAgents.add(id)
      reviewEpochByAgent.set(id, epoch)
    }

    async function finalizeReviewEpoch(epoch, reason) {
      if (!epoch || epoch.finalized) return
      epoch.finalized = true
      reviewEpochs.delete(epoch.id)
      const ownerState = stateFor(epoch.owner)
      ownerState.reviewEpochIds.delete(epoch.id)
      ownerState.pendingReviewEpochs = ownerState.pendingReviewEpochs.filter((id) => id !== epoch.id)
      for (const id of epoch.activeAgents) reviewEpochByAgent.delete(id)
      if (reason === 'cancelled') return

      const changed = []
      for (const root of epoch.roots) {
        const before = epoch.fingerprints.get(root)
        const after = await gitArtifactFingerprint(root)
        if (before !== undefined && after !== undefined && before !== after) changed.push(root)
      }
      if (changed.length > 0 && epoch.owner && typeof epoch.owner.steer === 'function') {
        const text = `kix-orchestration: review epoch 的 artifact 在观察树结算前发生变化：${changed.join(', ')}。本轮 review/APPROVE 已失效；先检查共享工作区副作用，再以新 revision 开启 review epoch。`
        try { epoch.owner.steer(makeUserMessage(text)) } catch { /* advisory only */ }
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

    // review epoch 覆盖整棵递归观察树：lead 可以继续派 probe，但所有后代共享
    // 同一 artifact 冻结边界。宿主生命周期只传 info；start 期间从已注册 child
    // 的 durable lineage 恢复 parent，并按 runId 保留到 end。
    ctx.on('subagent/start', (info) => {
      const parent = lifecycleParentAgent(ctx, info)
      const runKey = lifecycleRunKey(info)
      if (!info || !info.id || !parent) return
      if (runKey) lifecycleParents.set(runKey, parent)
      const inherited = epochForAgent(parent)
      if (inherited) {
        bindReviewAgent(inherited, info.id)
        return
      }
      const st = stateFor(parent)
      const label = String(info.label || '')
      let epoch
      for (const id of st.pendingReviewEpochs) {
        const candidate = reviewEpochs.get(id)
        if (!candidate || candidate.rootAgentId) continue
        if (!epoch) epoch = candidate
        if (candidate.label && candidate.label === label) { epoch = candidate; break }
      }
      if (epoch) bindReviewAgent(epoch, info.id)
    })

    // ── pre-execute：review epoch 锁 + subagent 交接门禁 + sleep 检测 ────
    ctx.on('tools/pre-execute', async (exec, next) => {
      const name = exec && exec.name
      const invocation = subagentInvocation(exec)
      const tool = invocation.tool

      // 只读观察树仍可运行测试、写 /tmp reproducer、继续递归分派；只禁止修改
      // 绑定 artifact 的源文件或 Git 状态。协调线程同样受 epoch 写锁约束。
      const inheritedEpoch = epochForAgent(exec && exec.agent)
      if (inheritedEpoch && epochBlocksMutation(exec, inheritedEpoch)) {
        return { kind: 'deny', reason: `kix-orchestration: ${inheritedEpoch.stage} review epoch 正在只读观察 ${inheritedEpoch.roots.join(', ')}；该工具会改变被审 artifact。可继续验证/递归观察；要修复时先让当前观察树结算或中止，再开启新 revision。` }
      }
      for (const epoch of activeEpochsOwnedBy(exec && exec.agent)) {
        if (epochBlocksMutation(exec, epoch)) {
          return { kind: 'deny', reason: `kix-orchestration: ${epoch.stage} review epoch 尚未结算，不能修改 ${epoch.roots.join(', ')}。主线程可做不相关工作；要编辑请先等待或中止该观察树，编辑后以新 revision 重开。` }
        }
      }

      let startedReviewEpoch
      const reviewAwareNext = async () => {
        if (startedReviewEpoch === undefined) startedReviewEpoch = await beginReviewEpoch(exec)
        try {
          const decision = await next()
          if (startedReviewEpoch && decision && decision.kind === 'deny') {
            await finalizeReviewEpoch(startedReviewEpoch, 'cancelled')
          }
          return decision
        } catch (error) {
          if (startedReviewEpoch) await finalizeReviewEpoch(startedReviewEpoch, 'cancelled')
          throw error
        }
      }

      if (!SUBAGENT_TOOLS.has(tool)) {
        // v4.1：sleep 空转等待子代理（一次性提醒）。刻意不参与 intensity
        // block/ask——sleep 是编排卫生问题不是危险操作，remind 恰当。
        // 去硬编码：不按工具名门控——任意工具的 arguments.command 都查
        // （命令形态双正则恒测，平台/工具无关；无 command 的工具零开销短路）。
        const st = stateFor(exec && exec.agent)
        if (st.enabled && !st.sleepReminded) {
          const args = exec && (exec.arguments ?? exec.args)
          const cmd = args && typeof args.command === 'string' ? args.command : ''
          const desc = args && typeof args.description === 'string' ? args.description : ''
          if (cmd && isSleepWaitForSubagent({ command: cmd, description: desc })) {
            st.pendingSleepRemind = { callId: exec.callId }
          }
        }
        // v11（P5）：plan.md 契约写前校验。只对 write 全量写入校验
        // （args.content 可拿完整新内容——DSH write 工具契约）；edit 拿不到
        // 完整新内容，0 误报纪律不猜测（说明性注释，非机制缺陷）。
        // 受 st.enabled 门控（/kix-orchestration off 后不再拦——与 handoff/sleep
        // 分支同口径，off 必须对全部检查生效）。
        if (st.enabled && (tool === 'write' || tool === 'edit')) {
          const args = exec && (exec.arguments ?? exec.args)
          const p = args && (args.file_path || args.path)
          // 左边界 (?:^|/)：防 mydocs/sprint-1/plan.md 这类同后缀无关路径误命中（0 误报纪律）
          if (typeof p === 'string' && /(?:^|\/)docs\/sprint-\d+\/plan\.md$/i.test(p.replace(/\\/g, '/'))) {
            if (tool === 'write' && typeof args.content === 'string') {
              const planReasons = checkPlanContract(args.content)
              if (planReasons.length > 0) {
                const reason = 'kix-orchestration: ' + planReasons.join(' ')
                if (intensity === 'block') {
                  return { kind: 'deny', reason }
                }
                if (intensity === 'ask') {
                  const ok = await askUser(exec, reason)
                  if (ok === false) return { kind: 'deny', reason: 'kix-orchestration: 用户拒绝，请先补齐 plan 契约字段。' }
                  if (ok === void 0) return { kind: 'deny', reason: 'kix-orchestration: 无法向用户提问（无提问通道），已自动拒绝。' }
                  return next()
                }
                if (!st.planReminded) {
                  st.pendingPlanRemind = { callId: exec.callId, reason }
                }
              }
            }
          }
        }
        return next()
      }

      const args = invocation.args
      const agent = exec && exec.agent
      const st = stateFor(agent)
      if (!st.enabled) return reviewAwareNext()

      // DSH subagent 工具的 prompt 在 args.prompt（SubagentStartRequest 契约）
      const prompt = args && (args.prompt || args.content)
      if (typeof prompt !== 'string' || prompt.length === 0) return reviewAwareNext()

      const workspaceRoot = lib.resolveWorkspaceRoot(agent, sandboxPolicy) || st.workspaceRoot
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
          return reviewAwareNext()
        }
        // remind：放行 + 注入提醒（每会话一次）
        // 2026-08-16（审查修复，状态机泄漏）：reminded 移到投递成功后置位
        // （旧实现在投递前置位——dispatch 抛错不经 post-execute 时标志滞留，
        // 一次性提醒被烧掉）；pendingRemind 绑定发起 callId（旧实现无绑定，
        // 下一次任意工具调用都会错位消费注入）。
        if (st.reminded) return reviewAwareNext()
        st.pendingRemind = { callId: exec.callId, reason }
        return reviewAwareNext()
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
            return reviewAwareNext()
          }
          if (st.reminded) return reviewAwareNext()
          st.pendingRemind = { callId: exec.callId, reason }
          return reviewAwareNext()
        }
      }

      return reviewAwareNext()
    })

    // ── post-execute：注入 remind（handoff 槽 + v4 sleep 槽各自独立）──────
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const agent = exec && exec.agent
      const st = agent ? stateFor(agent) : undefined
      if (st) {
        const pendingEpoch = st.pendingReviewEpochs
          .map((id) => reviewEpochs.get(id))
          .find((epoch) => epoch && epoch.callId === (exec && exec.callId))
        if (pendingEpoch) {
          const value = toolResultValue(result)
          if (value && typeof value.subagentId === 'string') {
            bindRootReviewAgent(pendingEpoch, value.subagentId)
          }
          const failed = Boolean(result && result.isError) || Boolean(value && value.isError === true)
          if (failed && pendingEpoch.activeAgents.size === 0) await finalizeReviewEpoch(pendingEpoch, 'cancelled')
          else if (!failed && value && value.kind === 'foreground' && pendingEpoch.activeAgents.size === 0) {
            await finalizeReviewEpoch(pendingEpoch, 'settled')
          }
        }
      }
      if (!st || !st.enabled) return next()
      // v4：sleep 等待提醒（独立槽位 + 独立一次性标志，不烧 handoff 的
      // pendingRemind/reminded）。callId 不匹配时落回 handoff 槽继续判，
      // 两个槽的工具面不相交（bash vs subagent*），互不干扰。
      if (st.pendingSleepRemind && st.pendingSleepRemind.callId === (exec && exec.callId)) {
        st.pendingSleepRemind = false
        st.sleepReminded = true
        return lib.appendContexts(await next(), [makeUserMessage(SLEEP_WAIT_REMIND)])
      }
      // v11：plan 契约提醒（独立槽位 + 独立一次性标志，不烧 handoff/sleep 槽）
      if (st.pendingPlanRemind && st.pendingPlanRemind.callId === (exec && exec.callId)) {
        const reason = st.pendingPlanRemind.reason
        st.pendingPlanRemind = null
        st.planReminded = true
        return lib.appendContexts(await next(), [makeUserMessage(reason)])
      }
      if (!st.pendingRemind) return next()
      // 只消费与发起调用同 callId 的 post-execute；dispatch 抛错（不经
      // post-execute）时标志滞留，下一次无关工具调用不会错位注入。
      if (st.pendingRemind.callId !== (exec && exec.callId)) return next()
      const reason = st.pendingRemind.reason
      st.pendingRemind = false
      st.reminded = true // 投递成功才消耗一次性提醒
      return lib.appendContexts(await next(), [makeUserMessage(reason)])
    })

    // ── v2：subagent/end 返回侧校验（DSH×VS Code 融合矩阵 #2）────────────
    // VS Code subagentStop 等价物的 DSH 原生形态：emit 观察子代理返回，若 QA
    // 返回完成声明但 progress.md 未同步 → steer 注入提醒（remindOnce）。
    // emit 模式不能 block（那是 pre-execute/post-execute 的事），提醒层符合
    // kix「补足非限制」；0% 误报：无完成声明/进度已同步/无法读进度都不提醒。
    ctx.on('subagent/end', async (info) => {
      const runKey = lifecycleRunKey(info)
      const parent = (runKey && lifecycleParents.get(runKey)) || lifecycleParentAgent(ctx, info)
      if (runKey) lifecycleParents.delete(runKey)
      if (info && info.id) {
        const id = String(info.id)
        const epoch = reviewEpochByAgent.get(id)
        if (epoch) {
          // DSH keeps a continuable parent resident while descendants it created run,
          // so parent end cannot precede an accepted descendant's start/settlement edge.
          reviewEpochByAgent.delete(id)
          epoch.activeAgents.delete(id)
          if (epoch.activeAgents.size === 0) await finalizeReviewEpoch(epoch, 'settled')
        }
      }
      try {
        const agent = parent || (info && info.agent) || undefined
        if (!agent) return
        const st = stateFor(agent)
        if (!st.enabled || st.returnReminded) return
        const text = lastAssistantText(info && info.lastAssistantMessage)
        if (!text) return
        // parent agent 的 session cwd 优先；共享 resolver 统一部署回退语义。
        const workspaceRoot = lib.resolveWorkspaceRoot(agent, sandboxPolicy) || st.workspaceRoot
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

    ctx.logger?.info?.('[kix-orchestration] 编排交接门禁已挂载（review epoch：递归观察树 artifact 冻结/只读 Git 边界；handoff/closeout/QA 返回校验；sleep 空等待提醒）')
  },
}

module.exports.__internals = {
  subagentInvocation,
  extractReviewEpochMeta,
  pathInside,
  reviewGitMutation,
  gitBranchIsMutation,
  gitConfigIsMutation,
  reviewShellMutation,
  reviewCommandRoot,
  gitArtifactFingerprint,
  toolResultValue,
  READ_ONLY_GIT_SUBCOMMANDS,
  REVIEW_STAGES,
  REVIEW_POLICY,
  extractHandoffMeta,
  hasQaCompletion,
  QA_NEGATIVE_MARKERS,
  QA_DONE_MARKERS,
  parseProgressState,
  checkHandoff,
  checkQaReturn,
  checkCloseout,
  lastAssistantText,
  isCloseoutTestPath,
  baselineShaFromProgress,
  isSleepWaitForSubagent,
  SLEEP_WAIT_CMD,
  PWSH_SLEEP_WAIT_CMD,
  SLEEP_WAIT_DESC,
  checkPlanContract,
  makeUserMessage,
  SUBAGENT_TOOLS,
  SPRINT_MARKER,
}
