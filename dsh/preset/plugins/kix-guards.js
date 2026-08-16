// kix-guards — kixparadigm 机械门禁的 DSH 原生实现（v6，2026-08-16）
//
// 移植自 kixpower 的 blast-radius-check.ps1 / block-source-edit.ps1 核心门禁，
// 以 DSH `tools/pre-execute` 监听器形态自动拦截（等价 Copilot PreToolUse hook）。
//
// v2（2026-08-15）：补全 blast-radius 未接线门禁 —— commit budget、真实分支检查、
// force push 完整检测、MCP GitHub 远程写保护、终端数据库客户端保守拦截、
// UPDATE without WHERE、人类确认点 ask。
// v3（2026-08-15，独立审查 2fed9f16 驱动）：
//   - 修复漏拦：git 子命令改「解析式」检测（gitSubcommands），`git -C x push --force`、
//     `git -c k=v push`、`git.exe push`、`git -C x reset --hard` 不再绕过整个 git 门禁；
//     push 目标参数检测补 refs/heads/main 形态
//   - 修复误伤：isDestructiveSql 限定 SQL 上下文（DB 客户端 / SQL 工具），grep/echo 裸
//     文本不再误拦；改语句级判定 + 剥字符串/注释（`DELETE FROM a; SELECT ... WHERE`、
//     `UPDATE public.users SET`、`/* WHERE 1 */` 不再漏拦）；force/main 检测限定真实
//     push/commit 子命令（commit message 含 "push +5"/"main.rs" 不再误拦）；`--force`/
//     `--mirror` 补 `(?<![\w-])` 前缀断言（`abc--force` 不再误拦）；移除 rebase 兜底硬
//     deny（`git rebase -i`/`git pull --rebase` 放行，与 ps1 一致）；targetsControlPlane
//     限定用户级根（home/.dsh、.agent-presets、agent.cordis.yml），项目级 settings.yaml
//     不再误拦
//   - SQL 工具（sql/sql_execute/run_sql）加入 KNOWN_SAFE_TOOLS（消除门禁 1 死代码，
//     门禁 4 可达）；run_code 1b 补 require('fs')/import('fs')/writeFileSync 检查
//   - 保留（按 kix 0% 误报纪律 + 规则是负债）：角色边界门禁不接（exec.agent 无角色
//     标记）、预算一致性软警告不接（建议类不进机械层）、SQL 文件引用检查不接
//     （psql -f 场景，文本纪律覆盖，见 capability map §3）
// v5（2026-08-15，用户决策）：ask 级门禁从 approval 服务弹窗改为**聊天内提问**
//   （ctx.userQuestions.ask —— 即 ask_user_question 的底层服务）。审批策略
//   danger-full-access 已恢复 approval: never（全自动、零审批弹窗）；需人类确认
//   的门禁（普通 git push / 本地破坏性 Git 操作 / GitHub 写）在聊天里问
//   「允许执行/拒绝」，用户回答决定放行。硬 deny（force push / main 分支 /
//   控制平面 / 破坏性 SQL / 未知执行工具 / commit budget）不变。
//   降级（fail-safe）：无 userQuestions 服务 / exec 无 agent / 提问被中止或
//   抛错（子代理 DELEGATED_CALLER、无 provider 等）→ 自动拒绝（deny）。
// v6（2026-08-16，用户实测反馈驱动）：
//   - 堵「gh CLI 绕门禁」：模型常经 pwsh 调 gh（GitHub CLI）绕过 MCP GitHub
//     ask 门禁（实测反馈：批量开 PR）。新增终端 2d 门禁：gh 写操作（pr
//     create/merge/close/reopen/ready/review、issue create/close/edit、
//     repo create/fork/transfer、release create/delete、branch -d/-D、
//     secret/variable set、workflow run、api -X POST/PATCH/PUT/DELETE 等）
//     → 聊天内 ask（与 MCP GitHub mutation 同档）；破坏性（gh repo delete /
//     gh api -X DELETE / gh release delete）→ deny。只读 gh（view/list/auth/
//     api GET）放行。0 误报：gh 是 GitHub 专用 CLI，子命令枚举精确。
//   - 堵「反复重复」：会话内同一操作（终端命令规范化文本 / edit 路径 /
//     GitHub 工具名+参数）已被 deny 或用户拒绝后再次出现 → 直接 deny 附
//     原拒绝原因 +「禁止重复尝试」，不再反复提问。memo 存插件闭包（每
//     agent scope 一份 = 每会话独立），只记录拒绝（用户放行的不记录）。
//
// 挂载方式：preset agent.cordis.yml 中一行：
//   - id: kix-guards
//     name: ./plugins/kix-guards.js
// 说明：本监听器按 agent scope 挂载，只拦本 preset 的会话；deny 返回 reason 由
// 工具执行管道呈现；ask 级门禁直接调 ctx.userQuestions.ask() 在聊天里提问
// （无 agent/无 userQuestions 自动降级 deny，fail-safe）。
//
// 纯逻辑导出：module.exports.__internals 供单元测试直接验证判定函数
// （不影响 DSH loader：loader 只读 name/inject/apply）。

'use strict'

const { readFile } = require('node:fs/promises')
const { join } = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileP = promisify(execFile)

// ── 常量（blast-radius ps1 同源）───────────────────────────────────────────
const COMMIT_HARD_CAP = 10          // 9 Ways 防线：绝对硬上限，不可配
const COMMIT_BUDGET_DEFAULT = 3     // 冷启动兜底（δ 未知时的保守值）

const DB_CLIENTS = /(?:\b|^)(psql|mysql|mariadb|sqlite3|sqlcmd|clickhouse-client|duckdb)\b/

// ── v3 纯判定函数（模块级：单元测试经 __internals 直接验证）───────────────

// 剥 SQL 字符串/注释噪音（ps1 332-335 同序列）
function stripSqlNoise(text) {
  let t = String(text || '')
  t = t.replace(/'(?:''|[^'])*'/g, ' ')
  t = t.replace(/"(?:""|[^"])*"/g, ' ')
  t = t.replace(/\/\*[\s\S]*?\*\//g, ' ')
  t = t.replace(/(?:--|#)[^\r\n]*/g, ' ')
  return t
}

// v3：语句级判定（ps1 340-347/362-368 语义）：
//   - 按 ; 分语句；DROP/TRUNCATE/ALTER 任意出现 → 破坏性
//   - DELETE FROM / UPDATE SET 且该语句无 WHERE → 破坏性
//   只在 SQL 上下文（DB 客户端 / SQL 工具）调用，不作用于裸终端文本。
function isDestructiveSql(text) {
  const t = stripSqlNoise(text)
  for (const stmt of t.split(';')) {
    if (/\b(?:drop|truncate|alter)\b/i.test(stmt)) return true
    if ((/\bdelete\b[^;]*?\bfrom\b/i.test(stmt) || /\bupdate\b[^;]*?\bset\b/i.test(stmt)) && !/\bwhere\b/i.test(stmt)) return true
  }
  return false
}

// 终端数据库客户端：无法可靠静态解析，含破坏性关键字一律硬拦（ps1 310 行同款：
// 直接对命令文本做关键字检测，不剥引号——剥引号会把 SQL 内容也剥掉）。
const DESTRUCTIVE_SQL_KEYWORD = /\b(?:DELETE|UPDATE|DROP|TRUNCATE|ALTER)\b/i
function isTerminalDestructiveSql(text) {
  return DB_CLIENTS.test(text) && DESTRUCTIVE_SQL_KEYWORD.test(text)
}

// v3：git 子命令解析式检测（修复 -C/-c/git.exe 绕过；ps1 Get-KixGitCommandPartsAll 的简化）
// 对每个 `git[.exe]` 出现位置，跳过旗标（短旗标 -C/-c 等跳过其值，长旗标 --x 无值），
// 取第一个非旗标 token 为子命令。
function gitSubcommands(text) {
  const subs = new Set()
  const re = /\bgit(?:\.exe)?\b/g
  let m
  while ((m = re.exec(text))) {
    const rest = text.slice(m.index + m[0].length)
    const tokens = rest.split(/\s+/).filter(Boolean)
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.startsWith('--')) continue
      if (t.startsWith('-')) {
        // 短旗标通常带值（-C <path> / -c <key=val>）；下一 token 非旗标即为其值
        if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) i++
        continue
      }
      subs.add(t.replace(/^["']|["']$/g, ''))
      break
    }
  }
  return subs
}
function hasGitSubcommand(text, sub) {
  return gitSubcommands(text).has(sub)
}

// ── v6：gh CLI（GitHub CLI）写保护 ─────────────────────────────────────────
// 模型常经 pwsh 调 gh 绕过 MCP GitHub 门禁（实测反馈：gh pr create 批量开 PR）。
// gh 是 GitHub 专用 CLI：实体+动作枚举精确——只读（view/list/auth/api GET）
// 放行，写操作 ask（与 MCP GitHub mutation 同档），破坏性 deny。
const GH_MUTATION_ACTIONS = new Map([
  ['pr', new Set(['create', 'merge', 'close', 'reopen', 'ready', 'review', 'edit', 'delete', 'comment'])],
  ['issue', new Set(['create', 'close', 'reopen', 'edit', 'delete', 'comment', 'pin', 'unpin', 'lock', 'unlock', 'transfer'])],
  ['repo', new Set(['create', 'fork', 'transfer', 'rename', 'edit', 'archive', 'unarchive', 'delete'])],
  ['release', new Set(['create', 'edit', 'delete'])],
  ['branch', new Set(['-d', '-D', 'delete'])],
  ['run', new Set(['rerun', 'cancel', 'delete'])],
  ['secret', new Set(['set', 'delete'])],
  ['variable', new Set(['set', 'delete'])],
  ['gist', new Set(['create', 'edit', 'delete'])],
  ['workflow', new Set(['run', 'enable', 'disable'])],
])
// gh api 显式写方法（-X/--method POST|PATCH|PUT|DELETE；GET 及无方法放行）
const GH_API_WRITE_METHOD = /\bgh\b[^;&|]*\bapi\b[^;&|]*\s(?:-X|--method)\s+["']?(?:POST|PATCH|PUT|DELETE)\b/i
// 破坏性（删除远程数据）：repo delete / release delete / api DELETE
const GH_DESTRUCTIVE = /(?:\bgh\b[^;&|]*\b(?:repo\s+delete|release\s+delete)\b)|(?:\bgh\b[^;&|]*\bapi\b[^;&|]*\s(?:-X|--method)\s+["']?DELETE\b)/i

// 解析 gh 的（实体, 动作）：跳过旗标及其值（-R o/r、--repo o/r、--repo=v、
// --title "x" 等；长旗标内联值含 "=" 直接跳过）
function ghEntityAction(text) {
  const re = /\bgh\b/g
  let m
  while ((m = re.exec(text))) {
    const rest = text.slice(m.index + m[0].length)
    const tokens = rest.split(/\s+/).filter(Boolean)
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.startsWith('-')) {
        if (t.startsWith('--') && t.includes('=')) continue // --flag=value
        if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) i++ // 旗标带值
        continue
      }
      const entity = t.replace(/^["']|["']$/g, '').toLowerCase()
      let action = undefined
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
        action = tokens[i + 1].replace(/^["']|["']$/g, '').toLowerCase()
      }
      return { entity, action }
    }
  }
  return undefined
}

function isGhDestructive(text) {
  return GH_DESTRUCTIVE.test(String(text || ''))
}

function isGhMutation(text) {
  const t = String(text || '')
  if (!/\bgh\b/.test(t)) return false
  if (isGhDestructive(t)) return false // 破坏性走 deny 档（调用方先判）
  if (GH_API_WRITE_METHOD.test(t)) return true
  const hit = ghEntityAction(t)
  if (!hit || !hit.action) return false
  const actions = GH_MUTATION_ACTIONS.get(hit.entity)
  return actions !== undefined && actions.has(hit.action)
}

// ── v6：重复尝试记忆（会话内同操作已被拒 → 直接 deny，不再反复提问）──────
function normalizeMemo(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ')
}
function stableArgs(args) {
  if (!args || typeof args !== 'object') return ''
  return Object.keys(args)
    .filter((k) => args[k] !== undefined)
    .sort()
    .map((k) => `${k}=${typeof args[k] === 'object' ? JSON.stringify(args[k]) : String(args[k])}`)
    .join('&')
}

// ps1 检查 3：force push 完整检测（--force / -f / push +refs 语法 / --mirror）。
// 只在真实 push 子命令上下文判定；带 (?<![\w-]) 前缀断言（abc--force 不算）。
function isForcePush(text) {
  if (!hasGitSubcommand(text, 'push')) return false
  return (
    /(?<![\w-])--force(?:=(?:true|1))?(?![\w-])/.test(text) ||
    /(?<!\S)-f(?!\S)/.test(text) ||
    /\bpush\b[^;&|]*\s\+\S+/.test(text) ||
    /(?<![\w-])--mirror(?![\w-])/.test(text)
  )
}

// v3：push 目标是否含受保护分支（ps1 检查 3 的 explicitProtectedRef + pushAll 简化：
// 裸 main/master token 或 refs/heads/main|master；只扫真实 push 子命令之后的参数）
function pushTargetsProtectedRef(text) {
  const re = /\bgit(?:\.exe)?\b(?:\s+-{1,2}[A-Za-z][A-Za-z-]*(?:\s+(?:"[^"]*"|'[^']*'|\S+))?)*\s+push\b([\s\S]*)/gi
  let m
  while ((m = re.exec(text))) {
    const args = m[1] || ''
    if (/(?<![\w/-])(?:main|master)(?![\w/-])/.test(args)) return true
    if (/refs\/heads\/(?:main|master)/.test(args)) return true
    if (/\s--all\b/.test(args)) return true
  }
  return false
}

// ps1 检查 3/4 ask 分支：会丢失本地工作的 Git 操作（人类确认点）。
// 注意：\b 在 `--` 与空格之间不成立（两个非词字符），故 checkout -- 不带尾 \b；
// clean -f 的 [a-z]*f 与 ps1 同式（无尾 \b，-fd 中 f 后是 d 仍应命中）。
function isLocalDestructiveAsk(text) {
  return (
    /\breset\s+--hard\b/.test(text) ||
    /\bclean\b[^;&|]*-[a-z]*f/.test(text) ||
    /\bbranch\s+-D\b/.test(text) ||
    /\bstash\s+(?:drop|clear)\b/.test(text) ||
    /\bcheckout\s+--/.test(text) ||
    /\brestore\b/.test(text)
  )
}

// v3：用户级控制平面路径判定（修复项目级 settings.yaml 误伤）：
//   限定 home 下的 .dsh 根、.agent-presets（全局唯一目录名）、agent.cordis.yml（preset 专属）。
function targetsControlPlane(text) {
  const low = String(text || '').toLowerCase().replace(/\\/g, '/')
  const home = (process.env.USERPROFILE || process.env.HOME || '').toLowerCase().replace(/\\/g, '/')
  return (
    low.includes('.agent-presets') ||
    low.includes('agent.cordis.yml') ||
    (home !== '' && low.includes(home + '/.dsh')) ||
    low.includes('~/.dsh') ||
    low.includes('$home/.dsh') ||
    low.includes('$env:userprofile/.dsh') ||
    low.includes('%userprofile%/.dsh')
  )
}

// 仓库根解析：git -C 参数提取（budget/分支检查共用）
function repoRootFromText(text) {
  const m = /\bgit\b[^;&|]*?\s-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(text)
  if (m) return m[1] || m[2] || m[3]
  return undefined
}

// 预算解析（ps1 同源正则；progress.md 优先 → plan.md → 默认）
function resolveCommitBudget({ progressMd, planMd }) {
  let budget = COMMIT_BUDGET_DEFAULT
  if (progressMd) {
    const m = /^---[\s\S]*?blast_radius:[\s\S]*?commit_budget:\s*(\d+)/.exec(progressMd)
    if (m) budget = Number(m[1])
  }
  if (planMd) {
    const m = /task_sizing:[\s\S]*?derived_commit_budget:\s*(\d+)/.exec(planMd)
    if (m && budget === COMMIT_BUDGET_DEFAULT) budget = Number(m[1])
  }
  return budget
}

// 找 active sprint 目录（ps1：docs/.kixpower-current-sprint 优先 → 最大数字）
function activeSprintDir(docsRoot, currentSprint) {
  const fs = require('node:fs')
  let entries = []
  try {
    entries = fs.readdirSync(docsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  const sprints = entries
    .filter((e) => e.isDirectory() && /^sprint-\d+$/.test(e.name))
    .map((e) => ({ name: e.name, n: Number(e.name.slice(7)) }))
    .sort((a, b) => b.n - a.n)
  if (currentSprint > 0) {
    const hit = sprints.find((s) => s.n === currentSprint)
    if (hit) return hit.name
  }
  return sprints.length > 0 ? sprints[0].name : undefined
}

module.exports = {
  name: 'kix-guards',
  inject: ['tools'],
  apply(ctx) {
    const DENY = (reason) => ({ kind: 'deny', reason })
    const ASK = (reason) => ({ kind: 'ask', reason })
    // v6：会话内重复尝试记忆（key → 原拒绝原因；只记录拒绝，用户放行不记）
    const denyMemo = new Map()

    // ── 工具分类 ──────────────────────────────────────────────────────────
    const TERMINAL_TOOLS = new Set(['pwsh', 'bash'])
    const EDIT_TOOLS = new Set(['write', 'edit'])
    const SQL_TOOLS = new Set(['sql', 'sql_execute', 'run_sql'])
    const KNOWN_SAFE_TOOLS = new Set([
      'read', 'grep', 'glob', 'web_search', 'skill', 'ask_user_question',
      'todo_write', 'job_output', 'job_list', 'job_kill', 'subagent',
      'subagent_fork', 'subagent_cross', 'send_message', 'list_agents',
      'read_image', 'get_goal', 'create_goal', 'update_goal',
      'workflow', 'ralph', 'plan', 'exit_plan_mode', 'interrupt_agent',
      'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
      'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine',
      // SQL 工具：v3 起入白名单（否则门禁 1 的 /run|exec/ 正则先拒，门禁 4 死代码）
      'sql', 'sql_execute', 'run_sql',
      // kix-focus 渐进披露（2026-08-16）：发现目录 + 代理调用入口。call 的
      // 内部子调用（tools.execute）走完整 pre-execute，门禁对每个被代理工具
      // 依然拦截；此处显式白名单防御未来正则变化误伤（名字本身不含 exec/run）。
      'kix_capability_search', 'kix_capability_call',
      // PTC/Code Mode 呈现（mode: both）：run_code 是保留传输，其 SDK 子分派
      // 走完整 pre-execute 管线，本门禁对程序内每个工具调用依然拦截；
      // run_code 本身由门禁 1b 做代码体受限能力检查。
      'run_code',
    ])

    // 危险 git 子命令（写操作；branch 亦含破坏性 -D 分支删除）
    const DANGEROUS_GIT = new Set([
      'push', 'reset', 'rebase', 'merge', 'cherry-pick', 'revert', 'clean',
      'checkout', 'restore', 'stash', 'branch', 'rm', 'mv', 'gc', 'prune', 'reflog',
      'update-ref', 'symbolic-ref', 'commit-tree', 'fast-import',
      'hash-object', 'replace', 'am', 'apply', 'pull',
    ])

    function commandText(args) {
      const cmd = args && (args.command || args.cmd)
      if (typeof cmd === 'string') return cmd
      if (args && Array.isArray(args.argv)) return args.argv.join(' ')
      return ''
    }

    // v3：解析式子命令检测（isGitWrite 门）
    function isGitWrite(text) {
      if (!/\bgit(?:\.exe)?\b/.test(text)) return false
      const subs = gitSubcommands(text)
      for (const sub of subs) {
        if (DANGEROUS_GIT.has(sub)) return true
      }
      return false
    }

    // ── agent 会话 cwd（budget/分支检查的仓库根 fallback）─────────────────
    function agentCwd(exec) {
      try {
        const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
        return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
      } catch {
        return undefined
      }
    }
    function resolveRepoRoot(text, exec) {
      const fromText = repoRootFromText(text)
      if (fromText) return fromText
      const cwd = agentCwd(exec)
      if (cwd) return cwd
      return undefined
    }

    // ── git 只读查询（reflog 计数 / 当前分支）─────────────────────────────
    async function gitRead(repoRoot, args) {
      try {
        const { stdout } = await execFileP('git', args, {
          cwd: repoRoot,
          timeout: 5000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        })
        return stdout
      } catch {
        return null
      }
    }

    // 读取 sprint 上下文文件内容（供预算解析；任何失败返回空对象不拦）
    async function readSprintContext(repoRoot) {
      const docsRoot = join(repoRoot, 'docs')
      let currentSprint = 0
      try {
        const raw = await readFile(join(docsRoot, '.kixpower-current-sprint'), 'utf8')
        const n = Number(raw.trim())
        if (Number.isInteger(n) && n > 0) currentSprint = n
      } catch { /* 无 current-sprint 文件 */ }
      const dir = activeSprintDir(docsRoot, currentSprint)
      if (!dir) return {}
      const sprintRoot = join(docsRoot, dir)
      const out = {}
      try { out.progressMd = await readFile(join(sprintRoot, 'progress.md'), 'utf8') } catch { /* 无 progress.md */ }
      try { out.planMd = await readFile(join(sprintRoot, 'plan.md'), 'utf8') } catch { /* 无 plan.md */ }
      return out
    }

    // ── git commit 前置检查（budget + feature branch）────────────────────
    // 返回 decision 或 undefined（无法解析仓库根 → 放行 + warn）
    async function checkGitCommit(text, exec) {
      const repoRoot = resolveRepoRoot(text, exec)
      if (!repoRoot) {
        ctx.logger?.warn?.('[kix-guards] git commit 无法解析仓库根，跳过 budget/分支检查')
        return undefined
      }
      // 分支检查（ps1 检查 4）
      const branch = (await gitRead(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
      if (branch === 'main' || branch === 'master') {
        return DENY(`BLAST RADIUS: 禁止在 ${branch} 分支直接 commit。先创建 feature 分支并通过 PR/MR 合并。`)
      }
      // commit budget（ps1 检查 1）
      const reflog = await gitRead(repoRoot, ['reflog', '--since=1 hour ago', '--format=%H', 'HEAD'])
      if (reflog === null) return undefined
      const count = reflog.trim() === '' ? 0 : reflog.trim().split('\n').length
      if (count >= COMMIT_HARD_CAP) {
        return DENY(`BLAST RADIUS HARD CAP: 已 commit ${count} 次（绝对硬上限 ${COMMIT_HARD_CAP}）。立即停止并拆分 Sprint；不得从 plan.md 覆盖硬上限。`)
      }
      const { progressMd, planMd } = await readSprintContext(repoRoot)
      const budget = resolveCommitBudget({ progressMd, planMd })
      if (count >= budget) {
        return DENY(`BLAST RADIUS: 已 commit ${count} 次（预算 ${budget}）。Producer 必须按 DAG 重算并同步预算；派生值超过 ${COMMIT_HARD_CAP} 时拆分 Sprint。`)
      }
      return undefined
    }

    // ── MCP GitHub 远程写保护（ps1 检查 5）────────────────────────────────
    // 只读工具（get_/list_/search_*）直接放行；write 类（写文件/推分支）必须
    // 显式提供非 main/master 的 branch；mutation 类：聊天内提问确认（v5）。
    // v4（2026-08-15）：按工具名精确匹配，废除"包含子串"式正则——旧实现
    // `.*request_` 把 get_pull_request_files/comments/reviews/status 等只读
    // 工具误判为 mutation（日志实测：PR 审查会话中 get_pull_request_files 被
    // ASK，agent 被迫全程绕道 gh CLI，只读调用被拒会打断审查流程）。
    const GITHUB_READ = /^mcp__github__(get|list|search)_/
    const GITHUB_WRITE = /^mcp__github__(create_or_update_file|delete_file|push_files)$/
    const GITHUB_MUTATION = new Set([
      'mcp__github__create_issue',
      'mcp__github__create_pull_request',
      'mcp__github__create_pull_request_review',
      'mcp__github__create_repository',
      'mcp__github__create_branch',
      'mcp__github__update_issue',
      'mcp__github__update_pull_request_branch',
      'mcp__github__add_issue_comment',
      'mcp__github__merge_pull_request',
      'mcp__github__fork_repository',
    ])
    function checkGitHubWrite(name, args) {
      if (GITHUB_READ.test(name)) return undefined
      if (GITHUB_WRITE.test(name)) {
        const branch = args && (args.branch || args.target_branch || args.ref)
        if (!branch) {
          return DENY('BLAST RADIUS: GitHub 远程写入未提供目标 branch，无法确认不是 main/master。请显式提供 feature branch。')
        }
        if (branch === 'main' || branch === 'master') {
          return DENY('BLAST RADIUS: 禁止通过 GitHub 工具直接写 main/master。写入 feature 分支并通过 PR 合并。')
        }
        return undefined
      }
      if (GITHUB_MUTATION.has(name)) {
        return ASK('BLAST RADIUS: 该 GitHub 操作会写入共享系统。确认目标、内容与分支后再继续。')
      }
      return undefined
    }

    // ── v5：聊天内提问（替代 approval 服务弹窗）───────────────────────────
    // 调用 ctx.userQuestions.ask() —— 即 ask_user_question 工具底层的同一服务，
    // 问题显示在聊天里，用户回答「允许执行/拒绝」后继续。
    // 返回：true=用户允许 / false=用户拒绝 / undefined=降级拒绝
    //   （无 userQuestions 服务 / exec 无 agent / 提问被中止或抛错，如子代理
    //   DELEGATED_CALLER、无 UI provider —— fail-safe 一律拒绝）。
    async function askUser(exec, reason) {
      const userQuestions = ctx.get('userQuestions')
      if (userQuestions === void 0 || exec === void 0 || exec.agent === void 0) return undefined
      try {
        const { answers } = await userQuestions.ask({
          questions: [{
            id: 'kix-guards-confirm',
            question: reason,
            header: 'BLAST RADIUS 确认',
            options: [
              { label: '允许执行', description: '确认这是有意的操作，放行执行。' },
              { label: '拒绝', description: '阻止该操作执行。' },
            ],
          }],
          agent: exec.agent,
          ...exec.signal !== void 0 ? { signal: exec.signal } : {},
        })
        const selected = answers && answers[0] && answers[0].selected
        return Array.isArray(selected) && selected.includes('允许执行')
      } catch {
        return undefined
      }
    }

    // 门禁 ask 决策统一处理：拒绝/降级 → deny（reason 区分），允许 → 继续后续检查
    async function resolveAsk(exec, decision) {
      if (decision.kind !== 'ask') return decision
      const ok = await askUser(exec, decision.reason)
      if (ok === false) return DENY('BLAST RADIUS: 用户拒绝执行该操作。')
      if (ok === void 0) return DENY('BLAST RADIUS: 无法向用户提问（无提问通道或非主会话），已自动拒绝。')
      return undefined
    }

    // ── pre-execute 监听器（自动拦截）─────────────────────────────────────
    ctx.on('tools/pre-execute', async (exec, next) => {
      const name = exec && exec.name
      // DSH 契约：参数在 exec.arguments（createExecution 的 {...base, arguments}），
      // 兼容旧字段名 exec.args（历史 bug 根因，2026-08-15 修复）。
      const args = exec && (exec.arguments ?? exec.args)
      const text = commandText(args)
      const tool = (name || '').toLowerCase()

      // v6：重复尝试记忆——同操作已被拒（硬 deny / 用户拒绝）→ 直接 deny，
      // 附原拒绝原因 + 禁止重复尝试，不再反复提问（堵「反复重复」反馈）。
      const pathArg = args && typeof (args.file_path ?? args.path) === 'string' ? (args.file_path ?? args.path) : undefined
      let memoKey = null
      if (TERMINAL_TOOLS.has(tool) && text) memoKey = 'term::' + normalizeMemo(text)
      else if (EDIT_TOOLS.has(tool) && pathArg) memoKey = 'edit::' + normalizeMemo(pathArg)
      else if (name && /^mcp__github__/.test(name)) memoKey = 'ghub::' + name + '::' + stableArgs(args)
      if (memoKey && denyMemo.has(memoKey)) {
        return DENY(`BLAST RADIUS: 该操作此前已被拒绝（${denyMemo.get(memoKey)}）。禁止重复尝试；如确需执行，请向用户说明原因并等待其明确指示。`)
      }
      const deny = (reason) => {
        if (memoKey) denyMemo.set(memoKey, reason)
        return DENY(reason)
      }
      const resolveAskRecord = async (execArg, decision) => {
        const resolved = await resolveAsk(execArg, decision)
        if (resolved && resolved.kind === 'deny' && memoKey) denyMemo.set(memoKey, resolved.reason)
        return resolved
      }

      // 1. 未知代码执行工具（无副作用的脚本类）→ deny
      if (/exec|run|eval|shell|snippet|python|node|jupyter|pylance|debug|repl|kernel|interpreter/.test(tool) && !KNOWN_SAFE_TOOLS.has(tool)) {
        return deny(`BLAST RADIUS: 未登记的工具 ${name} 无法验证副作用，拒绝执行。`)
      }

      // 1b. run_code 代码体受限能力检查（P0 修复 2026-08-15；v3 补 fs 直写）
      if (tool === 'run_code' && args && typeof args.code === 'string') {
        const code = args.code
        if (/import\s*\(\s*["']node:|require\s*\(\s*["']node:|child_process|fetch\s*\(|WebSocket\s*\(|process\.|\b(?:require|import)\s*\(\s*["']fs["']\)|writeFileSync\s*\(/.test(code)) {
          return deny('BLAST RADIUS: run_code 代码体包含受限能力（node: 动态 import / child_process / fetch / WebSocket / process 访问 / fs 直写）已拦截。run_code 是通用 Node 运行时，这些能力可绕过工具门禁；需要此类能力时请改用 native 工具（pwsh 等）经门禁执行。')
        }
      }

      // 2. 终端命令门禁
      if (TERMINAL_TOOLS.has(tool) && text) {
        // 2a. 破坏性 SQL —— v3 起仅限数据库客户端上下文（ps1 检查 2 终端部分；
        //     grep/echo 等裸文本不再误拦）
        if (isTerminalDestructiveSql(text)) {
          return deny('BLAST RADIUS: 终端数据库客户端中的破坏性 SQL（DELETE/UPDATE without WHERE / DROP/TRUNCATE/ALTER）已拦截。请改用结构化工具或先在事务/只读副本中验证。')
        }
        // 2b. git 写保护（v3：解析式子命令门 + 顺序对齐 ps1：force → local ask →
        //     push main → push ask → budget/分支；v5：ask 级门禁改为聊天内提问）
        if (isGitWrite(text)) {
          if (isForcePush(text)) {
            return deny('BLAST RADIUS: git push --force 会重写远端历史。需用户明确确认；优先使用 --force-with-lease 或 git revert。')
          }
          if (isLocalDestructiveAsk(text)) {
            const decision = await resolveAskRecord(exec, ASK('BLAST RADIUS: 检测到会丢失本地工作的 Git 操作（reset --hard / clean -f / branch -D / stash drop|clear / checkout -- / restore）。请确认目标仓库、分支和待丢弃内容。'))
            if (decision) return decision
          }
          if (pushTargetsProtectedRef(text)) {
            return deny('BLAST RADIUS: 禁止直接 push 到 main/master。请推送 feature 分支并通过 PR 合并。')
          }
          if (hasGitSubcommand(text, 'push')) {
            const decision = await resolveAskRecord(exec, ASK('BLAST RADIUS: git push 会写入共享远端。确认远端、源分支和目标分支后再继续。'))
            if (decision) return decision
          }
          if (hasGitSubcommand(text, 'commit')) {
            const decision = await checkGitCommit(text, exec)
            if (decision) return decision
          }
        }
        // 2c. 控制平面保护
        if (targetsControlPlane(text)) {
          return deny('CONTROL PLANE: 禁止通过命令改写用户级 Agent/Skill/Prompt/Hook/设置。')
        }
        // 2d. gh CLI（GitHub CLI）写保护（v6：堵「经 pwsh 调 gh 绕过 MCP GitHub 门禁」）
        if (isGhDestructive(text)) {
          return deny('BLAST RADIUS: gh 破坏性操作（repo delete / api DELETE / release delete）会删除远程数据，禁止执行。')
        }
        if (isGhMutation(text)) {
          const decision = await resolveAskRecord(exec, ASK('BLAST RADIUS: gh 写操作会写入共享 GitHub（与 MCP GitHub 门禁同档）。确认目标仓库、分支与内容后再继续。'))
          if (decision) return decision
        }
      }

      // 3. 编辑工具控制平面保护
      if (EDIT_TOOLS.has(tool) && args) {
        const path = args.file_path || args.path || ''
        if (typeof path === 'string' && targetsControlPlane(path)) {
          return deny('CONTROL PLANE: 禁止编辑用户级 Agent/Skill/Prompt/Hook/设置文件。')
        }
      }

      // 4. SQL 工具门禁（v3：SQL_TOOLS 已入 KNOWN_SAFE_TOOLS，此门禁可达）
      if (SQL_TOOLS.has(tool)) {
        const sql = args && (args.sql || args.query || args.statement)
        if (typeof sql === 'string' && isDestructiveSql(sql)) {
          return deny('BLAST RADIUS: 破坏性 SQL（DELETE/UPDATE without WHERE / DROP/TRUNCATE/ALTER）已拦截。')
        }
      }

      // 5. MCP GitHub 远程写保护（v5：mutation 的 ask 级门禁改为聊天内提问）
      if (name && /^mcp__github__/.test(name)) {
        const decision = checkGitHubWrite(name, args)
        if (decision) {
          const resolved = await resolveAskRecord(exec, decision)
          if (resolved) return resolved
        }
      }

      return next()
    })

    // 记录挂载
    ctx.on('ready', () => {
      ctx.logger?.info?.('[kix-guards] 机械门禁监听器已挂载（pre-execute，v5：解析式子命令门/budget/branch/force-push/GitHub/SQL 完整；ask 级门禁改为聊天内提问）')
    })
  },
}

// ── 纯逻辑导出（单元测试用，不影响 DSH loader）────────────────────────────
module.exports.__internals = {
  isDestructiveSql,
  stripSqlNoise,
  isTerminalDestructiveSql,
  isForcePush,
  isLocalDestructiveAsk,
  pushTargetsProtectedRef,
  gitSubcommands,
  hasGitSubcommand,
  targetsControlPlane,
  repoRootFromText,
  resolveCommitBudget,
  activeSprintDir,
  ghEntityAction,
  isGhMutation,
  isGhDestructive,
  normalizeMemo,
  stableArgs,
  COMMIT_HARD_CAP,
  COMMIT_BUDGET_DEFAULT,
}
