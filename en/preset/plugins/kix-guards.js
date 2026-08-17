// kix-guards — kixparadigm 机械门禁的 DSH 原生实现（v9，v1.2.11）
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
//     限定用户级根（home/.dsh、.agent-presets、安装副本 agent.cordis.yml），项目级
//     settings.yaml 不再误拦；v11 再豁免源仓库 dsh/preset|en/preset 事实源
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
// v7（2026-08-16，dae 仓库实测误报驱动；0% 误报纪律）：
// v9（v1.2.11 用户决策：发布/评论等确认类门禁降为软约束）：
//   - 用户明确指示（如「评论到PR」）= 已决策；机械层不再逐操作提问。
//   - 原 ASK 级门禁（普通 push / 本地破坏性 git / gh 与 GitHub mutation）
//     全部改为放行，由 persona + kixpower-review 流程做软约束。
//   - 硬 DENY 仅保留真正不可逆/可机械判定为破坏性的操作：force push、
//     main/master 保护、控制平面写、破坏性 SQL、未知执行工具、run_code
//     受限能力、gh/GitHub 删除远端数据。
//
// v8（v1.2.10 自审整改；0% 误报反例回归）：
//   - 终端破坏性 SQL 改为「DB 客户端命令位 + SQL payload 语句级判定」：
//     echo/grep/字符串字面量不再误拦；显式 SQL 交给 isDestructiveSql 剥字符串/
//     注释；管道喂 SQL（echo DROP | psql）仍拦；DELETE/UPDATE 带 WHERE 放行。
//   - 控制平面保护改为只拦明确写意图（写/删/改动词或 shell 重定向命中目标）；
//     grep/cat/ls/Get-Content 等只读诊断放行。
//   - GitHub MCP 工具前缀可经 config.githubToolPrefix 配置（默认 mcp__github__）。
//
// v11（v1.2.14，PR#10 遗留）：targetsControlPlane 见任意 agent.cordis.yml 就
//   deny，把源仓库事实源（dsh/preset/、en/preset/）当成安装副本误伤——维护者
//   无法在本仓库改挂载注释/计数。安装面（~/.dsh / .agent-presets）仍优先命中。
//
//   - 修复「reflog 计数惩罚历史修整」：改用 reflog subject（%gs）口径，
//     只数 commit 类条目。reset / merge / pull / checkout / rebase 不再
//     计入（它们不创建 commit 对象；reset+recommit / rebase 是推荐的历史
//     修整工作流）。amend 计入 hard cap 口径（重写 commit 对象的 churn）
//     但不计入 budget 口径（不改逻辑 commit 数）。实测：3 逻辑 commit +
//     2 次 reset 重做 + 1 次 amend 曾被 %H 口径计为 8 次，误触熔断。
//   - 修复「过期 sprint 指针」：marker 指向的 sprint 已有 done.md → warn
//     并回退最大编号 sprint 目录；最大编号也已完结 → staleAll warn 并在
//     deny 消息标注「预算基线过期」。实测：docs/.kixpower-current-sprint
//     停在 6 而 sprint-9 已完结，门禁拿 12 天前 sprint-6 的 budget=3
//     约束 sprint-9 之后的 hotfix 工作。
//   - 修复「预算兜底缺口 + 静默冷启动」：plan.md 增读 blast_radius.max_commits
//     （ps1 同源字段）；优先级 progress.commit_budget > plan.task_sizing.
//     derived_commit_budget > plan.blast_radius.max_commits > 冷启动 3，
//     落冷启动必须 warn；deny 消息注明预算来源与 sprint 目录，移除误导性
//     的「按 DAG 重算」措辞（任务 DAG 是规划文档，不做拦截）。
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

// 终端数据库客户端（命令位判定 + SQL payload 语句级判定，v8）。
// v8 修复（0% 误报回归）：旧实现只要命令文本同时出现 DB 客户端名与破坏性
// 关键字就拦，导致 echo/grep/字符串字面量等只读或无关命令被误判。现改为：
//   1. 按 shell 分隔符拆段，识别「命令位」上的 DB 客户端（sudo/env 前缀兼容）；
//   2. 优先提取 -c/--command/-e/--execute/-Q/--query 的 SQL payload，
//      交给 isDestructiveSql 做剥字符串/注释后的语句级判定；
//   3. 无显式 payload 时，仅当前一段通过管道喂给 DB 客户端且含破坏性
//      关键字才拦（如 `echo DROP TABLE | psql`）。
//   `cat migration.sql | psql`、`grep psql`、`echo "psql DROP"` 不再误拦。
const DESTRUCTIVE_SQL_KEYWORD = /\b(?:DELETE|UPDATE|DROP|TRUNCATE|ALTER)\b/i
const DB_CLIENT_NAMES = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd', 'clickhouse-client', 'duckdb'])
const SQL_PAYLOAD_FLAGS = new Set(['-c', '--command', '-e', '--execute', '-Q', '--query'])

/** quote-aware shell 拆段：返回 [{ text, sepBefore }]；sepBefore 为 ;/&&/||/|/newline 或 null。 */
function splitShellSegments(text) {
  const parts = []
  let cur = ''
  let pendingSep = null
  let quote = null
  let escaped = false
  const flush = () => {
    const value = cur.trim()
    if (value) parts.push({ text: value, sepBefore: pendingSep })
    cur = ''
    pendingSep = null
  }
  const s = String(text || '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      cur += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue }
    if (ch === '\\' && i + 1 < s.length) { cur += ch + s[i + 1]; i++; continue }
    if (ch === ';' || ch === '\n' || ch === '\r') { flush(); pendingSep = ';'; continue }
    if (ch === '&' && s[i + 1] === '&') { flush(); pendingSep = '&&'; i++; continue }
    if (ch === '|' && s[i + 1] === '|') { flush(); pendingSep = '||'; i++; continue }
    if (ch === '|') { flush(); pendingSep = '|'; continue }
    cur += ch
  }
  flush()
  return parts
}

/** quote-aware shell 分词（去掉外层引号；保留内部转义后的内容）。 */
function shellTokens(segment) {
  const tokens = []
  let cur = ''
  let quote = null
  let escaped = false
  const s = String(segment || '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (escaped) { cur += ch; escaped = false }
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === '\\' && i + 1 < s.length) { cur += s[i + 1]; i++; continue }
    if (/\s/.test(ch)) { if (cur) { tokens.push(cur); cur = '' } continue }
    cur += ch
  }
  if (cur) tokens.push(cur)
  return tokens
}

function commandBasename(token) {
  const value = String(token || '')
  return value.replace(/^["']|["']$/g, '').replace(/\.exe$/i, '').split(/[\\/]/).pop().toLowerCase()
}

/** 返回 { name, args }：跳过赋值前缀与 sudo/env/command 及它们的前置旗标。 */
function leadingCommand(tokens) {
  const list = Array.isArray(tokens) ? tokens : []
  let i = 0
  while (i < list.length) {
    const t = list[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue }
    if (/^(?:sudo|doas|env|command)$/i.test(t)) { i++; continue }
    break
  }
  while (i < list.length && list[i].startsWith('-')) {
    i += (i + 1 < list.length && !list[i + 1].startsWith('-')) ? 2 : 1
  }
  if (i >= list.length) return undefined
  return { name: commandBasename(list[i]), args: list.slice(i + 1) }
}

/** 提取显式 SQL payload（flag value 或 --flag=value）。 */
function extractSqlPayload(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]
    const eq = raw.match(/^(--[a-z-]+)=(.*)$/i)
    if (eq && SQL_PAYLOAD_FLAGS.has(eq[1].toLowerCase())) return eq[2]
    if (SQL_PAYLOAD_FLAGS.has(raw.toLowerCase())) {
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) return tokens[i + 1]
    }
  }
  return undefined
}

function isTerminalDestructiveSql(text) {
  const parts = splitShellSegments(text)
  for (let i = 0; i < parts.length; i++) {
    const tokens = shellTokens(parts[i].text)
    const cmd = leadingCommand(tokens)
    if (!cmd || !DB_CLIENT_NAMES.has(cmd.name)) continue
    const payload = extractSqlPayload(tokens.slice(1))
    if (payload !== undefined) {
      if (isDestructiveSql(payload)) return true
      continue
    }
    if (parts[i].sepBefore === '|' && i > 0 && DESTRUCTIVE_SQL_KEYWORD.test(parts[i - 1].text)) return true
  }
  return false
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

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
//   限定 home 下的 .dsh 根、.agent-presets（全局唯一目录名）、安装副本
//   agent.cordis.yml（preset 专属）。
// v11：源仓库事实源 dsh/preset/ 与 en/preset/ 下的同名文件不是用户级安装
//   副本——bare `agent.cordis.yml` 子串会把维护者对自己仓库的编辑当成
//   CONTROL PLANE 误伤。安装副本仍走 .agent-presets / ~/.dsh 命中。
function isSourceRepoPresetPath(low) {
  return /(?:^|\/)(?:dsh|en)\/preset(?:\/|$)/.test(low)
}
function isInstallControlPlanePath(low) {
  const home = (process.env.USERPROFILE || process.env.HOME || '').toLowerCase().replace(/\\/g, '/')
  return (
    low.includes('.agent-presets') ||
    (home !== '' && low.includes(home + '/.dsh')) ||
    low.includes('~/.dsh') ||
    low.includes('$home/.dsh') ||
    low.includes('$env:userprofile/.dsh') ||
    low.includes('%userprofile%/.dsh')
  )
}
function targetsControlPlane(text) {
  const low = String(text || '').toLowerCase().replace(/\\/g, '/')
  // 安装面先于源路径豁免：挡住 dsh/preset/../../.dsh/.agent-presets 这类绕过。
  if (isInstallControlPlanePath(low)) return true
  if (isSourceRepoPresetPath(low)) return false
  return low.includes('agent.cordis.yml')
}

// ── v8：终端控制平面保护只拦「写意图」────────────────────────────────────
// 旧实现仅凭命令文本出现 ~/.dsh / agent.cordis.yml 就 deny，grep/cat/ls 等
// 只读诊断被误拦，违反机械层 0% 误报纪律。写意图判定：
//   1. shell 重定向目标命中控制平面 → deny；
//   2. 明确写/删/改动词，且控制平面路径位于其作用对象（删除/移动类任一
//      参数命中；cp/install/ln/git-clone 只认最后一个非旗标参数 = 目标）→ deny。
const CONTROL_PLANE_MODIFY_ANY = new Set([
  'rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri',
  'mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item',
  'touch', 'mkdir', 'md', 'new-item', 'ni', 'chmod', 'chown', 'icacls',
  'attrib', 'set-content', 'sc', 'add-content', 'ac', 'clear-content', 'clc',
  'out-file', 'set-item', 'si', 'tee',
])
const CONTROL_PLANE_DEST_LAST = new Set([
  'cp', 'copy', 'copy-item', 'cpi', 'robocopy', 'install',
  'ln', 'link', 'wget', 'curl', 'iwr', 'invoke-webrequest',
])
const DOWNLOAD_OUTPUT_FLAGS = new Set(['-o', '--output', '--output-document', '-outfile', '--outfile'])
function downloadOutputTarget(args) {
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]
    if (DOWNLOAD_OUTPUT_FLAGS.has(raw.toLowerCase())) {
      if (i + 1 < args.length) return args[i + 1]
      continue
    }
    const eq = raw.match(/^(--output|--output-document|--outfile)=(.*)$/i)
    if (eq) return eq[2]
  }
  return undefined
}
function lastNonFlagArg(args) {
  for (let i = args.length - 1; i >= 0; i--) {
    if (!args[i].startsWith('-')) return args[i]
  }
  return undefined
}
function redirectTargetsControlPlane(text) {
  const re = /(?:[12]?>>?|&>)\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/g
  let m
  while ((m = re.exec(text))) {
    const target = m[1] || m[2] || m[3]
    if (target && targetsControlPlane(target)) return true
  }
  return false
}
function isTerminalControlPlaneWrite(text) {
  const t = String(text || '')
  if (redirectTargetsControlPlane(t)) return true
  const parts = splitShellSegments(t)
  for (const part of parts) {
    const tokens = shellTokens(part.text)
    const cmd = leadingCommand(tokens)
    if (!cmd) continue
    if (CONTROL_PLANE_MODIFY_ANY.has(cmd.name)) {
      if (cmd.args.some((a) => targetsControlPlane(a))) return true
      continue
    }
    if (cmd.name === 'wget' || cmd.name === 'curl' || cmd.name === 'iwr' || cmd.name === 'invoke-webrequest') {
      const out = downloadOutputTarget(cmd.args)
      if (out && targetsControlPlane(out)) return true
      continue
    }
    if (CONTROL_PLANE_DEST_LAST.has(cmd.name)) {
      const dest = lastNonFlagArg(cmd.args)
      if (dest && targetsControlPlane(dest)) return true
      if ((cmd.name === 'mv' || cmd.name === 'move' || cmd.name === 'move-item' || cmd.name === 'mi') &&
        cmd.args.some((a) => targetsControlPlane(a))) return true
      continue
    }
    if (cmd.name === 'git' && /^clone$/i.test(cmd.args[0] || '')) {
      const dest = lastNonFlagArg(cmd.args.slice(1))
      if (dest && targetsControlPlane(dest)) return true
    }
  }
  return false
}

// 仓库根解析：git -C 参数提取（budget/分支检查共用）
function repoRootFromText(text) {
  const m = /\bgit\b[^;&|]*?\s-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(text)
  if (m) return m[1] || m[2] || m[3]
  // v10（2026-08-17，WSL2 E2E 边界修复）：`cd <repo> && git commit`（无 -C）
  // 且会话 cwd 非仓库根时，旧实现解析不到仓库根 → commit 的 main/预算检查
  // 静默跳过。提取 `cd <dir>` 作为候选仓库根——cd 必须位于命令位
  // （行首或 &&/;/|/|| 之后），避免 `echo cd /tmp` 误匹配；调用方 gitRead
  // 对非仓库目录失败返回 null → 自然 fail-safe 跳过（0% 误伤）。
  const cdm = /(?:^|[;&|]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(text)
  if (cdm) return cdm[1] || cdm[2] || cdm[3]
  return undefined
}

// v7：reflog 计数（%gs 口径）——只数 commit 类条目，不惩罚历史修整。
//   commits = 逻辑 commit（commit: / commit (initial):；不含 amend）
//   churn   = commit 对象创建（含 commit (amend):）→ hard cap 口径
//   reset / merge / pull / checkout / rebase 等 HEAD 移动不计入任何口径：
//   它们不创建 commit 对象，且 reset+recommit / rebase 是推荐的历史修整
//   工作流（实测误报根因之一：修 off-by-one 的 reset 重做被计进预算）。
//   amend 不计入 budget（不改逻辑 commit 数）但计入 hard cap（防无限重写）。
function countReflogCommits(reflogText) {
  const lines = String(reflogText || '').split('\n').map((l) => l.trim()).filter(Boolean)
  let commits = 0
  let churn = 0
  for (const s of lines) {
    if (s.startsWith('commit')) churn++
    if (s.startsWith('commit:') || s.startsWith('commit (initial):')) commits++
  }
  return { commits, churn }
}

// 预算解析（ps1 同源正则；progress.md 优先 → plan.md 两级 → 冷启动默认）
// v7：plan.md 增读 blast_radius.max_commits 兜底（sprint-9 实形：progress
// 无 commit_budget、plan 无 task_sizing，但 plan 的 blast_radius.max_commits
// 是 ps1 同源锁定的提交上限——此前读不到会静默落冷启动 3）。
// v7 修正优先级语义：按「是否匹配到」降级，不再按「值是否等于默认」——
// 显式 commit_budget: 3 不再被 plan 兜底覆盖（v6 潜伏 bug，兜底链放大）。
function resolveCommitBudget({ progressMd, planMd }) {
  let budget = COMMIT_BUDGET_DEFAULT
  let fromProgress = false
  if (progressMd) {
    const m = /^---[\s\S]*?blast_radius:[\s\S]*?commit_budget:\s*(\d+)/.exec(progressMd)
    if (m) { budget = Number(m[1]); fromProgress = true }
  }
  if (!fromProgress && planMd) {
    const m = /task_sizing:[\s\S]*?derived_commit_budget:\s*(\d+)/.exec(planMd)
    if (m) {
      budget = Number(m[1])
    } else {
      const m2 = /blast_radius:[\s\S]*?max_commits:\s*(\d+)/.exec(planMd)
      if (m2) budget = Number(m2[1])
    }
  }
  return budget
}

// v7：预算来源标注（冷启动 warn / deny 消息用；与 resolveCommitBudget 同优先级链）
function commitBudgetSource({ progressMd, planMd }) {
  if (progressMd && /^---[\s\S]*?blast_radius:[\s\S]*?commit_budget:\s*(\d+)/.test(progressMd)) return 'progress.md blast_radius.commit_budget'
  if (planMd && /task_sizing:[\s\S]*?derived_commit_budget:\s*(\d+)/.test(planMd)) return 'plan.md task_sizing.derived_commit_budget'
  if (planMd && /blast_radius:[\s\S]*?max_commits:\s*(\d+)/.test(planMd)) return 'plan.md blast_radius.max_commits'
  return '冷启动默认 ' + COMMIT_BUDGET_DEFAULT
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

// v7：active sprint 目录解析 + 完结检测（纯 fs 进出，供单元测试）。
//   marker（docs/.kixpower-current-sprint）优先；若其指向的 sprint 已有
//   done.md（已完结，预算基线过期）→ fallbackFrom 记录并回退最大编号目录
//   （实测误报根因之二：marker 停在已完结的 sprint-6，门禁拿其 budget=3
//   约束之后的工作）。最大编号也已完结 → staleAll（由调用方 warn + 标注）。
function resolveSprintContextPaths(docsRoot, currentSprint) {
  const fs = require('node:fs')
  const dir = activeSprintDir(docsRoot, currentSprint)
  if (!dir) return undefined
  const out = { dir, fallbackFrom: undefined, staleAll: false }
  let done = false
  try { done = fs.statSync(join(docsRoot, dir, 'done.md')).isFile() } catch { done = false }
  if (!done) return out
  const maxDir = activeSprintDir(docsRoot, 0)
  if (maxDir && maxDir !== dir) {
    out.fallbackFrom = dir
    out.dir = maxDir
    try { out.staleAll = fs.statSync(join(docsRoot, maxDir, 'done.md')).isFile() } catch { out.staleAll = false }
  } else {
    out.staleAll = true // 最大编号即 marker 指向且已完结
  }
  return out
}

module.exports = {
  name: 'kix-guards',
  inject: ['tools'],
  apply(ctx, config) {
    const cfg = config || {}
    // v8：GitHub MCP 命名前缀可配置（不同部署命名不是 mcp__github__ 时，
    // 旧硬编码会让整个 GitHub 写保护静默失效）。
    const GH_PREFIX = String(cfg.githubToolPrefix || 'mcp__github__')
    const GH_RE = new RegExp('^' + escapeRegex(GH_PREFIX))
    const DENY = (reason) => ({ kind: 'deny', reason })
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
    // v10.1（2026-08-17，部署 E2E 复验实锤）：补上 `commit`——原清单缺它，
    // isGitWrite() 对纯 `git commit` 返回 false → 2b 门禁整体跳过 → 分支/
    // 预算检查（checkGitCommit，v10 的 cd 解析落点）对普通 commit 永不执行，
    // main 分支直接 commit 静默放行（此前 v10 修复只覆盖了 resolveRepoRoot，
    // 单测也只测 repoRootFromText 未测整链，缺陷长期潜伏）。
    const DANGEROUS_GIT = new Set([
      'push', 'commit', 'reset', 'rebase', 'merge', 'cherry-pick', 'revert', 'clean',
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
    // v7：经 resolveSprintContextPaths 做「marker 指向已完结 sprint」的
    // 回退，并携带 sprintDir / staleAll 供 deny 消息标注预算基线状态。
    async function readSprintContext(repoRoot) {
      const docsRoot = join(repoRoot, 'docs')
      let currentSprint = 0
      try {
        const raw = await readFile(join(docsRoot, '.kixpower-current-sprint'), 'utf8')
        const n = Number(raw.trim())
        if (Number.isInteger(n) && n > 0) currentSprint = n
      } catch { /* 无 current-sprint 文件 */ }
      const resolved = resolveSprintContextPaths(docsRoot, currentSprint)
      if (!resolved) return {}
      if (resolved.fallbackFrom) {
        ctx.logger?.warn?.(`[kix-guards] active sprint 指针指向已完结的 ${resolved.fallbackFrom}（done.md 存在），回退到最大编号 ${resolved.dir} 解析预算——请同步 docs/.kixpower-current-sprint 或开新 sprint。`)
      }
      if (resolved.staleAll) {
        ctx.logger?.warn?.(`[kix-guards] 最大编号 sprint ${resolved.dir} 也已完结（done.md 存在）——预算基线可能不反映当前工作，建议开新 sprint 并写明 blast_radius.commit_budget。`)
      }
      const sprintRoot = join(docsRoot, resolved.dir)
      const out = { sprintDir: resolved.dir, staleAll: resolved.staleAll }
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
      // commit budget（ps1 检查 1；v7：%gs 口径只数 commit 类条目，
      // reset/merge/pull/checkout/rebase 与 budget 无关，amend 只进 hard cap）
      const reflog = await gitRead(repoRoot, ['reflog', '--since=1 hour ago', '--format=%gs', 'HEAD'])
      if (reflog === null) return undefined
      const { commits, churn } = countReflogCommits(reflog)
      if (churn >= COMMIT_HARD_CAP) {
        return DENY(`BLAST RADIUS HARD CAP: 1 小时窗口内已创建 ${churn} 个 commit（含 amend；绝对硬上限 ${COMMIT_HARD_CAP}）。立即停止并拆分 Sprint；不得从 plan.md 覆盖硬上限。`)
      }
      const { progressMd, planMd, sprintDir, staleAll } = await readSprintContext(repoRoot)
      const budget = resolveCommitBudget({ progressMd, planMd })
      const source = commitBudgetSource({ progressMd, planMd })
      if (source.startsWith('冷启动')) {
        ctx.logger?.warn?.(`[kix-guards] commit 预算落到冷启动默认 ${COMMIT_BUDGET_DEFAULT}（未在 sprint 文档解析到 commit_budget / derived_commit_budget / max_commits）——请在新 sprint 的 progress.md frontmatter 写明 blast_radius.commit_budget。`)
      }
      if (commits >= budget) {
        const staleNote = staleAll ? `；注意：预算基线来自已完结的 ${sprintDir || 'sprint'}，请开新 sprint 并同步 commit_budget` : ''
        return DENY(`BLAST RADIUS: 1 小时窗口内已 commit ${commits} 次（预算 ${budget}，来源：${sprintDir ? sprintDir + ' 的 ' : ''}${source}${staleNote}）。请重算 commit 预算并同步到 sprint 文档（progress.md frontmatter 的 blast_radius.commit_budget）；派生值超过 ${COMMIT_HARD_CAP} 时拆分 Sprint。`)
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
    const GITHUB_READ = new RegExp('^' + escapeRegex(GH_PREFIX) + '(get|list|search)_')
    const GITHUB_WRITE = new RegExp('^' + escapeRegex(GH_PREFIX) + '(create_or_update_file|delete_file|push_files)$')
    const GITHUB_MUTATION = new Set([
      'create_issue',
      'create_pull_request',
      'create_pull_request_review',
      'create_repository',
      'create_branch',
      'update_issue',
      'update_pull_request_branch',
      'add_issue_comment',
      'merge_pull_request',
      'fork_repository',
    ].map((suffix) => GH_PREFIX + suffix))
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
        // v9：软约束——是否发布/评论由 persona + review 流程判断；用户明确指示
        // 即已决策，机械层不再重复提问。
        return undefined
      }
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
      else if (name && GH_RE.test(name)) memoKey = 'ghub::' + name + '::' + stableArgs(args)
      if (memoKey && denyMemo.has(memoKey)) {
        return DENY(`BLAST RADIUS: 该操作此前已被拒绝（${denyMemo.get(memoKey)}）。禁止重复尝试；如确需执行，请向用户说明原因并等待其明确指示。`)
      }
      const deny = (reason) => {
        if (memoKey) denyMemo.set(memoKey, reason)
        return DENY(reason)
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
        // 2b. git 写保护（v3：解析式子命令门；v9：确认类操作软约束，不再提问）
        if (isGitWrite(text)) {
          if (isForcePush(text)) {
            return deny('BLAST RADIUS: git push --force 会重写远端历史。需用户明确确认；优先使用 --force-with-lease 或 git revert。')
          }
          // v9：本地破坏性 git 仅软约束，不提问；硬保护仍由 force-push/main 等 deny 承担。
          if (pushTargetsProtectedRef(text)) {
            return deny('BLAST RADIUS: 禁止直接 push 到 main/master。请推送 feature 分支并通过 PR 合并。')
          }
          // v9：普通 push 仅软约束，不提问；受保护分支/force push 仍 deny。
          if (hasGitSubcommand(text, 'commit')) {
            const decision = await checkGitCommit(text, exec)
            if (decision) return decision
          }
        }
        // 2c. 控制平面保护（v8：只拦明确写意图，grep/cat/ls 等只读诊断放行）
        if (isTerminalControlPlaneWrite(text)) {
          return deny('CONTROL PLANE: 禁止通过命令改写用户级 Agent/Skill/Prompt/Hook/设置。')
        }
        // 2d. gh CLI（GitHub CLI）写保护（v6：堵「经 pwsh 调 gh 绕过 MCP GitHub 门禁」）
        if (isGhDestructive(text)) {
          return deny('BLAST RADIUS: gh 破坏性操作（repo delete / api DELETE / release delete）会删除远程数据，禁止执行。')
        }
        // v9：gh 普通写操作仅软约束，不提问；gh 破坏性删除仍 deny。
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

      // 5. MCP GitHub 远程写保护（v9：mutation 软约束；write main/缺 branch 仍 deny）
      if (name && GH_RE.test(name)) {
        const decision = checkGitHubWrite(name, args)
        if (decision) return decision
      }

      return next()
    })

    // 记录挂载
    ctx.on('ready', () => {
      ctx.logger?.info?.('[kix-guards] 机械门禁监听器已挂载（v9：硬 deny 仅保留不可逆破坏；发布/评论/普通 push 等确认类操作软约束）')
    })
  },
}

// ── 纯逻辑导出（单元测试用，不影响 DSH loader）────────────────────────────
module.exports.__internals = {
  isDestructiveSql,
  stripSqlNoise,
  isTerminalDestructiveSql,
  splitShellSegments,
  shellTokens,
  extractSqlPayload,
  isTerminalControlPlaneWrite,
  redirectTargetsControlPlane,
  isForcePush,
  isLocalDestructiveAsk,
  pushTargetsProtectedRef,
  gitSubcommands,
  hasGitSubcommand,
  targetsControlPlane,
  repoRootFromText,
  resolveCommitBudget,
  commitBudgetSource,
  countReflogCommits,
  activeSprintDir,
  resolveSprintContextPaths,
  ghEntityAction,
  isGhMutation,
  isGhDestructive,
  normalizeMemo,
  stableArgs,
  escapeRegex,
  COMMIT_HARD_CAP,
  COMMIT_BUDGET_DEFAULT,
}
