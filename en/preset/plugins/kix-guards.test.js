// kix-guards 回归测试（v9，v1.2.11：确认类门禁降为软约束——普通 push / 本地破坏性 git / gh 与 GitHub mutation 不再提问；硬 deny 仅保留不可逆破坏性操作）
//
// 单元级验证：加载 kix-guards.js，mock DSH pre-execute 派发
// （模拟 dsh-tools createExecution 的输出结构：{ name, arguments, ... }），
// 覆盖全部门禁分支（deny / ask→聊天提问 / allow）+ __internals 纯逻辑。
// 运行：node plugins/kix-guards.test.js
//
// v5 语义：ask 级门禁不再返回 {kind:'ask'}（approval 弹窗），而是调用
// ctx.userQuestions.ask()（聊天内提问）；测试用 mock userQuestions 模拟
// 用户回答「允许执行/拒绝」，并覆盖降级路径（无 userQuestions → deny）。
//
// 注意：本测试模拟的是"监听器被 DSH 调用"后的决策逻辑；
// 运行时"监听器确实被挂载"的端到端验证需在新会话执行。

const path = require('node:path')
const assert = require('node:assert')
const os = require('node:os')

// ── mock ctx（cordis 插件 apply(ctx) 需要的表面）──────────────────────────
const listeners = {}
// 可切换的 userQuestions mock：undefined = 无服务（降级 deny）
let userQuestionsMock = null
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get(name) {
    return name === 'userQuestions' ? userQuestionsMock : undefined
  },
  on(event, cb) {
    ;(listeners[event] ||= []).push(cb)
  },
}

// ── 加载被测试插件 ────────────────────────────────────────────────────────
const plugin = require(path.join(__dirname, 'kix-guards.js'))
assert.strictEqual(plugin.name, 'kix-guards')
plugin.apply(ctx)
const preExecute = listeners['tools/pre-execute']
assert.ok(Array.isArray(preExecute) && preExecute.length === 1, 'pre-execute 监听器已注册')

// ── 模拟 DSH 派发 ─────────────────────────────────────────────────────────
// 带 agent（真实执行必有 agent）；无 agent → checkGitCommit 走「无法解析
// 仓库根 → 放行 + warn」路径（不依赖真实 git）。
function dispatch(name, args) {
  const exec = { name, arguments: args, token: 't', callId: 'c', agent: { id: 'test-agent' } }
  return preExecute[0](exec, () => Promise.resolve({ kind: 'allow' }))
}
// 无 agent 派发（降级路径验证）
function dispatchNoAgent(name, args) {
  const exec = { name, arguments: args, token: 't', callId: 'c' }
  return preExecute[0](exec, () => Promise.resolve({ kind: 'allow' }))
}

let passed = 0
let failed = 0
function check(label, decision, expect) {
  // expect: true=deny / false=allow
  const kind = decision && decision.kind
  const ok = (kind === 'deny') === expect
  if (ok) { passed++ } else { failed++ }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  →  ${kind}${ok ? '' : ` (expected ${expect ? 'deny' : 'allow'})`}`)
}

// v5：ask 级门禁 → 聊天内提问。模拟用户两种回答各跑一次：
//   允许执行 → allow；拒绝 → deny。
async function softCase(label, name, args) {
  // v9：确认类门禁不再提问；无论 userQuestions 是否存在都放行。
  userQuestionsMock = undefined
  const decision = await dispatch(name, args)
  check(`${label} → allow（v9 软约束）`, decision, false)
}

;(async () => {
  // ══ 1. 破坏性 SQL（v3：仅限 DB 客户端 / SQL 工具上下文；语句级判定）════
  check('pwsh: psql -c "drop table users" → deny', await dispatch('pwsh', { command: 'psql -c "drop table users"' }), true)
  check('pwsh: psql -c "DELETE FROM users" → deny', await dispatch('pwsh', { command: 'psql -c "DELETE FROM users"' }), true)
  // 终端保守硬拦（ps1 310 行）：DB 客户端含破坏性关键字即 deny，不区分 WHERE
  check('pwsh: psql -c "DELETE FROM users WHERE id = 1" → allow（v8 语句级）', await dispatch('pwsh', { command: 'psql -c "DELETE FROM users WHERE id = 1"' }), false)
  check('pwsh: psql -c "UPDATE users SET admin = 1" → deny (v2)', await dispatch('pwsh', { command: 'psql -c "UPDATE users SET admin = 1"' }), true)
  check('pwsh: psql -c "UPDATE users SET admin = 1 WHERE id = 2" → allow（v8 语句级）', await dispatch('pwsh', { command: 'psql -c "UPDATE users SET admin = 1 WHERE id = 2"' }), false)
  check('pwsh: psql -c "ALTER TABLE t ADD c int" → deny', await dispatch('pwsh', { command: 'psql -c "ALTER TABLE t ADD c int"' }), true)
  check('pwsh: psql -c "SELECT 1" → allow', await dispatch('pwsh', { command: 'psql -c "SELECT 1"' }), false)
  check('pwsh: mysql -e "DROP TABLE users" → deny', await dispatch('pwsh', { command: 'mysql -e "DROP TABLE users"' }), true)
  check('pwsh: sqlite3 app.sqlite "SELECT count(*) FROM t" → allow', await dispatch('pwsh', { command: 'sqlite3 app.sqlite "SELECT count(*) FROM t"' }), false)
  // 语句级（v3）：第一条无 WHERE 即拦，即使后续语句有 WHERE
  check('pwsh: psql -c "DELETE FROM a; SELECT * FROM t WHERE id=1" → deny (v3)', await dispatch('pwsh', { command: 'psql -c "DELETE FROM a; SELECT * FROM t WHERE id=1"' }), true)
  // 注释剥离（v3）：/* WHERE 1 */ 不算 WHERE
  check('pwsh: psql -c "DELETE FROM t /* WHERE 1 */" → deny (v3)', await dispatch('pwsh', { command: 'psql -c "DELETE FROM t /* WHERE 1 */"' }), true)
  // schema 限定名/引号名（v3）
  check('pwsh: psql -c "UPDATE public.users SET admin = 1" → deny (v3)', await dispatch('pwsh', { command: 'psql -c "UPDATE public.users SET admin = 1"' }), true)
  check('pwsh: psql -c "UPDATE \\"users\\" SET x = 1" → deny (v3)', await dispatch('pwsh', { command: 'psql -c "UPDATE \\"users\\" SET x = 1"' }), true)
  // 脱域误伤修复（v3）：裸终端文本不再判 SQL
  check('pwsh: grep -r "DELETE FROM users" src/ → allow (v3)', await dispatch('pwsh', { command: 'grep -r "DELETE FROM users" src/' }), false)
  check('pwsh: echo "drop table users" → allow (v3)', await dispatch('pwsh', { command: 'echo "drop table users"' }), false)
  check('pwsh: echo \'use psql; DELETE from users\' → allow (v8 命令位判定)', await dispatch('pwsh', { command: "echo 'use psql; DELETE from users'" }), false)
  check('pwsh: cat notes.md | grep psql && echo DELETE → allow (v8 命令位判定)', await dispatch('pwsh', { command: 'cat notes.md | grep psql && echo DELETE' }), false)
  check('pwsh: psql -c "SELECT \'DROP TABLE\'" → allow (v8 SQL 字符串剥离)', await dispatch('pwsh', { command: "psql -c \"SELECT 'DROP TABLE'\"" }), false)
  check('pwsh: echo DROP TABLE users | psql → deny (v8 管道喂 SQL)', await dispatch('pwsh', { command: 'echo DROP TABLE users | psql' }), true)

  // ── SQL 工具门禁（v3：SQL_TOOLS 已入白名单，门禁 4 可达）────────────────
  check('sql: DELETE FROM users → deny (v3)', await dispatch('sql', { sql: 'DELETE FROM users' }), true)
  check('sql: SELECT 1 → allow (v3)', await dispatch('sql', { sql: 'SELECT 1' }), false)
  check('sql_execute: DROP TABLE t → deny (v3)', await dispatch('sql_execute', { query: 'DROP TABLE t' }), true)

  // ══ 2. git 写保护（v3：解析式子命令门）════════════════════════════════
  check('pwsh: git push --force origin main → deny', await dispatch('pwsh', { command: 'git push --force origin main' }), true)
  check('pwsh: git push -f origin feature → deny (v2)', await dispatch('pwsh', { command: 'git push -f origin feature' }), true)
  check('pwsh: git push origin +main → deny (v2)', await dispatch('pwsh', { command: 'git push origin +main' }), true)
  check('pwsh: git push --mirror origin → deny (v2)', await dispatch('pwsh', { command: 'git push --mirror origin' }), true)
  // v5：ask 级门禁改为聊天内提问（force-with-lease 非硬 deny）
  await softCase('pwsh: git push --force-with-lease origin feature', 'pwsh', { command: 'git push --force-with-lease origin feature' })
  // v3 修复：-C / -c / git.exe 不再绕过
  check('pwsh: git -C C:\\repo push --force origin main → deny (v3)', await dispatch('pwsh', { command: 'git -C C:\\repo push --force origin main' }), true)
  check('pwsh: git -c user.name=x push --force origin main → deny (v3)', await dispatch('pwsh', { command: 'git -c user.name=x push --force origin main' }), true)
  check('pwsh: git.exe push --force origin main → deny (v3)', await dispatch('pwsh', { command: 'git.exe push --force origin main' }), true)
  // 人类确认点 ask（v5：聊天内提问）
  await softCase('pwsh: git -C C:\\repo reset --hard HEAD', 'pwsh', { command: 'git -C C:\\repo reset --hard HEAD' })
  await softCase('pwsh: git reset --hard HEAD', 'pwsh', { command: 'git reset --hard HEAD' })
  await softCase('pwsh: git clean -fd', 'pwsh', { command: 'git clean -fd' })
  await softCase('pwsh: git branch -D old', 'pwsh', { command: 'git branch -D old-branch' })
  await softCase('pwsh: git stash drop', 'pwsh', { command: 'git stash drop' })
  await softCase('pwsh: git checkout -- src/a.ts', 'pwsh', { command: 'git checkout -- src/a.ts' })
  await softCase('pwsh: git restore src/a.ts', 'pwsh', { command: 'git restore src/a.ts' })
  // push 目标受保护分支（v3：参数检测，不扫 commit message）
  await softCase('pwsh: git push origin feature', 'pwsh', { command: 'git push origin feature' })
  check('pwsh: git push origin main → deny (v3)', await dispatch('pwsh', { command: 'git push origin main' }), true)
  await softCase('pwsh: git push origin main-branch', 'pwsh', { command: 'git push origin main-branch' })
  check('pwsh: git push origin refs/heads/main → deny (v3)', await dispatch('pwsh', { command: 'git push origin refs/heads/main' }), true)
  check('pwsh: git commit -am "x" && git push origin main → deny', await dispatch('pwsh', { command: 'git commit -am "x" && git push origin main' }), true)
  // 只读/常规操作放行
  check('pwsh: git status → allow', await dispatch('pwsh', { command: 'git status' }), false)
  check('pwsh: git log → allow', await dispatch('pwsh', { command: 'git log --oneline' }), false)
  check('pwsh: git stash list → allow (v3)', await dispatch('pwsh', { command: 'git stash list' }), false)
  check('pwsh: git stash push -m "wip" → allow (v3)', await dispatch('pwsh', { command: 'git stash push -m "wip"' }), false)
  check('pwsh: git pull --rebase → allow (v3)', await dispatch('pwsh', { command: 'git pull --rebase' }), false)
  check('pwsh: git rebase -i HEAD~3 → allow (v3)', await dispatch('pwsh', { command: 'git rebase -i HEAD~3' }), false)
  check('pwsh: git rebase main → allow (v3)', await dispatch('pwsh', { command: 'git rebase main' }), false)
  // commit message 误伤修复（v3）：只扫真实子命令，不扫 message
  check('pwsh: git commit -m "push +5 items" → allow (v3)', await dispatch('pwsh', { command: 'git commit -m "push +5 items"' }), false)
  check('pwsh: git commit -m "fix push --force docs" → allow (v3)', await dispatch('pwsh', { command: 'git commit -m "fix push --force docs"' }), false)
  check('pwsh: git commit -m "sync master notes" → allow (v3)', await dispatch('pwsh', { command: 'git commit -m "sync master notes"' }), false)
  check('pwsh: git commit -m "update main.rs docs" → allow (v3)', await dispatch('pwsh', { command: 'git commit -m "update main.rs docs"' }), false)
  // lookbehind 前缀断言（v3）：分支名含 --force 不算 force push
  await softCase('pwsh: git push origin abc--force', 'pwsh', { command: 'git push origin abc--force' })
  // commit budget/分支（无 agent 仓库根 → 放行不崩）
  check('pwsh: git commit -am x（mock 无仓库根）→ allow', await dispatch('pwsh', { command: 'git commit -am "wip"' }), false)

  // ── v9 软约束：普通 push / 本地破坏性 git 不再依赖 userQuestions ─────
  userQuestionsMock = null
  check('pwsh: git push origin feature（无 userQuestions）→ allow（v9 软约束）', await dispatch('pwsh', { command: 'git push origin feature' }), false)
  check('pwsh: git reset --hard HEAD（无 userQuestions）→ allow（v9 软约束）', await dispatch('pwsh', { command: 'git reset --hard HEAD' }), false)
  check('pwsh: git push origin feature（无 agent）→ allow（v9 软约束）', await dispatchNoAgent('pwsh', { command: 'git push origin feature' }), false)
  userQuestionsMock = { ask: async () => { throw new Error('DELEGATED_CALLER') } }
  check('pwsh: gh pr create（提问服务不可用）→ allow（v9 软约束）', await dispatch('pwsh', { command: 'gh pr create --title v9-soft' }), false)

  // ══ 3. 控制平面保护（v3：home 限定，项目级同名文件不误伤）════════════
  const HOME = (process.env.USERPROFILE || os.homedir()).replace(/\\/g, '/')
  check(`pwsh: 读 ${HOME}/.dsh/settings.yaml → allow（v8 只读放行）`, await dispatch('pwsh', { command: `Get-Content ${HOME}\\.dsh\\settings.yaml` }), false)
  check('pwsh: grep/cat/ls 控制平面路径 → allow（v8 只读放行）', await dispatch('pwsh', { command: `grep -R kix ${HOME}/.dsh && cat ${HOME}/.dsh/agent.cordis.yml && ls ${HOME}/.dsh` }), false)
  check('pwsh: rm 控制平面文件 → deny（v8 写意图）', await dispatch('pwsh', { command: `rm ${HOME}/.dsh/agent.cordis.yml` }), true)
  check('pwsh: 重定向写控制平面 → deny（v8 写意图）', await dispatch('pwsh', { command: `echo x > ${HOME}/.dsh/settings.yaml` }), true)
  check('pwsh: cp 控制平面 → 外部备份 → allow（v8 目标非控制平面）', await dispatch('pwsh', { command: `cp ${HOME}/.dsh/settings.yaml /tmp/settings.bak` }), false)
  check('pwsh: cp 外部 → 控制平面 → deny（v8 目标命中）', await dispatch('pwsh', { command: `cp /tmp/settings.yaml ${HOME}/.dsh/settings.yaml` }), true)
  check(`pwsh: curl -o ${HOME}/.dsh/settings.yaml URL → deny（v8 下载目标）`, await dispatch('pwsh', { command: `curl -o ${HOME}/.dsh/settings.yaml https://example.com/x` }), true)
  check(`pwsh: curl -o /tmp/x URL → allow（v8 下载目标非控制平面）`, await dispatch('pwsh', { command: 'curl -o /tmp/x https://example.com/x' }), false)
  check('pwsh: 其他用户 home 的 .dsh → allow (v3)', await dispatch('pwsh', { command: 'Get-Content C:\\Users\\other\\.dsh\\settings.yaml' }), false)
  check('write: 编辑 preset 文件 → deny', await dispatch('write', { file_path: 'C:\\Users\\x\\.dsh\\.agent-presets\\kixparadigm\\agent.cordis.yml' }), true)
  check('edit: 项目 settings.yaml → allow (v3)', await dispatch('edit', { file_path: 'C:\\work\\project\\settings.yaml' }), false)
  check('edit: 项目 .credentials.yaml → allow (v3)', await dispatch('edit', { file_path: 'C:\\work\\project\\.credentials.yaml' }), false)
  check(`edit: ${HOME}/.dsh/profiles/web/plugins/x.js → deny`, await dispatch('edit', { file_path: `${HOME}\\.dsh\\profiles\\web\\plugins\\x.js` }), true)

  // ══ 4. run_code 代码体受限能力（v3 补 fs 直写）════════════════════════
  check('run_code: import("node:child_process") → deny', await dispatch('run_code', { code: 'const cp = await import("node:child_process"); return 1' }), true)
  check('run_code: fetch( 网络 → deny', await dispatch('run_code', { code: 'const r = await fetch("https://x"); return r' }), true)
  check('run_code: process.env 访问 → deny', await dispatch('run_code', { code: 'return process.env.HOME' }), true)
  check('run_code: WebSocket( → deny', await dispatch('run_code', { code: 'const ws = new WebSocket("ws://x")' }), true)
  check('run_code: require("fs") 直写 → deny (v3)', await dispatch('run_code', { code: "require('fs').writeFileSync('x','y')" }), true)
  check('run_code: import("fs") → deny (v3)', await dispatch('run_code', { code: 'const fs = await import("fs"); return fs' }), true)
  check('run_code: writeFileSync( → deny (v3)', await dispatch('run_code', { code: 'const fs = require("node:fs"); fs.writeFileSync("a","b")' }), true)
  check('run_code: 纯 tools.* 编排 → allow', await dispatch('run_code', { code: 'const a = await tools.read({file_path:"a.ts"}); return a' }), false)

  // ══ 5. 未知执行工具 ══════════════════════════════════════════════════
  check('python3 直呼（未登记）→ deny', await dispatch('python3', { code: 'print(1)' }), true)
  check('read（白名单）→ allow', await dispatch('read', { file_path: 'a.ts' }), false)

  // ══ 6. MCP GitHub 远程写保护 ══════════════════════════════════════════
  check('github create_or_update_file branch=main → deny', await dispatch('mcp__github__create_or_update_file', { owner: 'o', repo: 'r', path: 'a.ts', branch: 'main', content: 'x' }), true)
  check('github create_or_update_file 无 branch → deny', await dispatch('mcp__github__create_or_update_file', { owner: 'o', repo: 'r', path: 'a.ts', content: 'x' }), true)
  check('github create_or_update_file branch=feature → allow', await dispatch('mcp__github__create_or_update_file', { owner: 'o', repo: 'r', path: 'a.ts', branch: 'feature/x', content: 'x' }), false)
  check('github push_files branch=master → deny', await dispatch('mcp__github__push_files', { owner: 'o', repo: 'r', branch: 'master', files: [], message: 'm' }), true)
  // v5：mutation 类 ask → 聊天内提问
  await softCase('github merge_pull_request', 'mcp__github__merge_pull_request', { owner: 'o', repo: 'r', pull_number: 3 })
  await softCase('github add_issue_comment', 'mcp__github__add_issue_comment', { owner: 'o', repo: 'r', issue_number: 1, body: 'b' })
  check('github get_file_contents → allow', await dispatch('mcp__github__get_file_contents', { owner: 'o', repo: 'r', path: 'README.md' }), false)
  // v4 修复：只读工具不再被 `.*request_` 误判为 mutation（日志实测 2026-08-15）
  check('github get_pull_request → allow (v4)', await dispatch('mcp__github__get_pull_request', { owner: 'o', repo: 'r', pull_number: 1 }), false)
  check('github get_pull_request_files → allow (v4 修复)', await dispatch('mcp__github__get_pull_request_files', { owner: 'o', repo: 'r', pull_number: 1 }), false)
  check('github get_pull_request_comments → allow (v4 修复)', await dispatch('mcp__github__get_pull_request_comments', { owner: 'o', repo: 'r', pull_number: 1 }), false)
  check('github get_pull_request_reviews → allow (v4 修复)', await dispatch('mcp__github__get_pull_request_reviews', { owner: 'o', repo: 'r', pull_number: 1 }), false)
  check('github get_pull_request_status → allow (v4 修复)', await dispatch('mcp__github__get_pull_request_status', { owner: 'o', repo: 'r', pull_number: 1 }), false)
  check('github list_pull_requests → allow (v4)', await dispatch('mcp__github__list_pull_requests', { owner: 'o', repo: 'r' }), false)
  check('github get_issue → allow (v4)', await dispatch('mcp__github__get_issue', { owner: 'o', repo: 'r', issue_number: 1 }), false)
  check('github search_code → allow (v4)', await dispatch('mcp__github__search_code', { q: 'x' }), false)
  check('github list_commits → allow (v4)', await dispatch('mcp__github__list_commits', { owner: 'o', repo: 'r', sha: 'a' }), false)
  // v4：mutation 精确名单仍须提问（v5：聊天内提问）
  await softCase('github create_pull_request', 'mcp__github__create_pull_request', { owner: 'o', repo: 'r', title: 't', head: 'h', base: 'b' })
  await softCase('github create_pull_request_review', 'mcp__github__create_pull_request_review', { owner: 'o', repo: 'r', pull_number: 1, event: 'APPROVE' })
  await softCase('github update_issue', 'mcp__github__update_issue', { owner: 'o', repo: 'r', issue_number: 1, state: 'closed' })
  await softCase('github fork_repository', 'mcp__github__fork_repository', { owner: 'o', repo: 'r' })
  await softCase('github create_branch', 'mcp__github__create_branch', { owner: 'o', repo: 'r', branch: 'x' })

  // ══ 7. __internals 纯逻辑 ═════════════════════════════════════════════
  const I = plugin.__internals
  assert.ok(I, '__internals 已导出')

  // resolveCommitBudget
  assert.strictEqual(I.resolveCommitBudget({}), 3, '无上下文 → 默认 3')
  assert.strictEqual(I.resolveCommitBudget({ progressMd: '---\nblast_radius:\n  commit_budget: 7\n---\nx' }), 7, 'progress.md 优先')
  assert.strictEqual(I.resolveCommitBudget({ planMd: 'task_sizing:\n  derived_commit_budget: 5' }), 5, 'plan.md 回退')
  assert.strictEqual(I.resolveCommitBudget({ progressMd: '---\nblast_radius:\n  commit_budget: 7\n---\n', planMd: 'task_sizing:\n  derived_commit_budget: 5' }), 7, 'progress 覆盖 plan')
  passed += 4

  // isForcePush（push 子命令门 + lookbehind）
  assert.ok(I.isForcePush('git push --force origin x'))
  assert.ok(I.isForcePush('git push --force=true origin x'))
  assert.ok(I.isForcePush('git push -f origin x'))
  assert.ok(I.isForcePush('git push origin +main'))
  assert.ok(I.isForcePush('git push --mirror origin'))
  assert.ok(I.isForcePush('git -C C:\\repo push --force origin main'), '-C 前置不绕过 force')
  assert.ok(!I.isForcePush('git push --force-with-lease origin x'))
  assert.ok(!I.isForcePush('git push origin feature'))
  assert.ok(!I.isForcePush('git push origin abc--force'), 'abc--force 非 force（lookbehind）')
  assert.ok(!I.isForcePush('git commit -m "push --force docs"'), 'commit message 不触发 force')
  passed += 10

  // gitSubcommands 解析式
  assert.deepStrictEqual([...I.gitSubcommands('git -C C:\\repo push --force origin main')], ['push'])
  assert.deepStrictEqual([...I.gitSubcommands('git -c user.name=x push origin f')], ['push'])
  assert.deepStrictEqual([...I.gitSubcommands('git stash push -m "wip"')], ['stash'])
  assert.deepStrictEqual([...I.gitSubcommands('git commit -am x && git push origin main')], ['commit', 'push'])
  assert.deepStrictEqual([...I.gitSubcommands('git status')], ['status'])
  assert.deepStrictEqual([...I.gitSubcommands('git.exe push origin f')], ['push'])
  passed += 6

  // pushTargetsProtectedRef
  assert.ok(I.pushTargetsProtectedRef('git push origin main'))
  assert.ok(I.pushTargetsProtectedRef('git push origin refs/heads/main'))
  assert.ok(I.pushTargetsProtectedRef('git push --all origin'))
  assert.ok(!I.pushTargetsProtectedRef('git push origin feature'))
  assert.ok(!I.pushTargetsProtectedRef('git push origin main-branch'))
  assert.ok(!I.pushTargetsProtectedRef('git commit -m "push to main"'), 'commit message 不触发')
  passed += 6

  // isLocalDestructiveAsk
  assert.ok(I.isLocalDestructiveAsk('git reset --hard HEAD'))
  assert.ok(I.isLocalDestructiveAsk('git clean -fd'))
  assert.ok(I.isLocalDestructiveAsk('git stash clear'))
  assert.ok(I.isLocalDestructiveAsk('git checkout -- f'))
  assert.ok(I.isLocalDestructiveAsk('git restore f'))
  assert.ok(!I.isLocalDestructiveAsk('git stash list'))
  assert.ok(!I.isLocalDestructiveAsk('git status'))
  passed += 7

  // repoRootFromText
  assert.strictEqual(I.repoRootFromText('git -C C:\\work\\repo status'), 'C:\\work\\repo')
  assert.strictEqual(I.repoRootFromText('git -C "C:/work/repo" commit -am x'), 'C:/work/repo')
  assert.strictEqual(I.repoRootFromText('git status'), undefined)
  // v10: `cd <repo> && git commit` (no -C) also resolves the repo root (WSL2 E2E boundary fix)
  assert.strictEqual(I.repoRootFromText('cd /root/kix-guards-e2e && git add a.txt && git commit -m x'), '/root/kix-guards-e2e')
  assert.strictEqual(I.repoRootFromText('cd "C:/work/repo" && git commit -m x'), 'C:/work/repo')
  assert.strictEqual(I.repoRootFromText('echo cd /tmp && git status'), undefined, 'echo cd is not a directory switch')
  passed += 6

  // isDestructiveSql 语句级
  assert.ok(I.isDestructiveSql('UPDATE users SET a=1'))
  assert.ok(!I.isDestructiveSql('UPDATE users SET a=1 WHERE id=2'))
  assert.ok(I.isDestructiveSql('truncate table t'))
  assert.ok(I.isDestructiveSql('DELETE FROM a; SELECT * FROM t WHERE id=1'), '第一条无 WHERE 即拦')
  assert.ok(I.isDestructiveSql('UPDATE public.users SET admin = 1'), 'schema 限定名')
  assert.ok(I.isDestructiveSql('DELETE FROM t /* WHERE 1 */'), '注释中的 WHERE 不算')
  assert.ok(!I.isDestructiveSql('DELETE FROM t WHERE id = 1'))
  passed += 7

  // stripSqlNoise
  assert.strictEqual(I.stripSqlNoise("SELECT 'a;b' FROM t").includes(';'), false, '字符串内分号被剥')
  passed += 1

  // isTerminalDestructiveSql
  assert.ok(I.isTerminalDestructiveSql('psql -c "ALTER TABLE t ADD c int"'))
  assert.ok(!I.isTerminalDestructiveSql('psql -c "SELECT 1"'))
  assert.ok(!I.isTerminalDestructiveSql('SELECT DROP FROM nothing'), '无 DB 客户端不判')
  passed += 3

  // targetsControlPlane（home 限定）
  assert.ok(I.targetsControlPlane(`${HOME}/.dsh/settings.yaml`), '真实 home .dsh')
  assert.ok(I.targetsControlPlane('~/.dsh/settings.yaml'))
  assert.ok(I.targetsControlPlane('C:/Users/x/.dsh/.agent-presets/kixparadigm/agent.cordis.yml'))
  assert.ok(I.targetsControlPlane('C:/work/.agent-presets/foo/agent.cordis.yml'), '.agent-presets 全局唯一')
  assert.ok(!I.targetsControlPlane('C:/work/project/settings.yaml'), '项目 settings.yaml 不拦')
  assert.ok(!I.targetsControlPlane('C:/work/project/.credentials.yaml'), '项目凭据模板不拦')
  assert.ok(!I.targetsControlPlane('C:/Users/other/.dsh/settings.yaml'), '其他用户 home 不拦')
  passed += 7

  // ══ 8. v6：gh CLI 写保护 + 重复尝试记忆 ═════════════════════════════════
  // 8a. gh CLI 纯判定（__internals）
  assert.ok(I.isGhMutation('gh pr create --title x'), 'gh pr create → mutation')
  assert.ok(I.isGhMutation('gh -R o/r pr merge 3'), 'gh -R 前置不绕过')
  assert.ok(I.isGhMutation('gh --repo o/r issue close 3'), 'gh --repo 前置不绕过')
  assert.ok(I.isGhMutation('gh api -X POST repos/o/r/issues'), 'gh api POST → mutation')
  assert.ok(I.isGhMutation('gh secret set TOKEN'), 'gh secret set → mutation')
  assert.ok(!I.isGhMutation('gh pr view 3'), 'gh pr view → 放行')
  assert.ok(!I.isGhMutation('gh issue list'), 'gh issue list → 放行')
  assert.ok(!I.isGhMutation('gh auth status'), 'gh auth status → 放行')
  assert.ok(!I.isGhMutation('gh api repos/o/r/pulls/3'), 'gh api GET → 放行')
  assert.ok(!I.isGhMutation('git push origin feature'), '非 gh 不判')
  assert.ok(I.isGhDestructive('gh repo delete o/r'), 'gh repo delete → 破坏性')
  assert.ok(I.isGhDestructive('gh api -X DELETE repos/o/r'), 'gh api DELETE → 破坏性')
  assert.ok(!I.isGhDestructive('gh pr create --title x'), 'gh pr create 非破坏性')
  assert.deepStrictEqual(I.ghEntityAction('gh pr create --title x'), { entity: 'pr', action: 'create' })
  assert.deepStrictEqual(I.ghEntityAction('gh --repo o/r pr merge'), { entity: 'pr', action: 'merge' })
  passed += 15

  // 8b. gh 门禁派发（v6：写操作 ask 聊天提问 / 破坏性 deny / 只读放行）
  await softCase('pwsh: gh pr create --title v6-gh', 'pwsh', { command: 'gh pr create --title v6-gh' })
  await softCase('pwsh: gh pr merge 12', 'pwsh', { command: 'gh pr merge 12' })
  await softCase('pwsh: gh issue close 7', 'pwsh', { command: 'gh issue close 7' })
  check('pwsh: gh repo delete o/r → deny', await dispatch('pwsh', { command: 'gh repo delete o/r' }), true)
  check('pwsh: gh api -X DELETE repos/o/r → deny', await dispatch('pwsh', { command: 'gh api -X DELETE repos/o/r' }), true)
  check('pwsh: gh pr view 3 → allow', await dispatch('pwsh', { command: 'gh pr view 3' }), false)
  check('pwsh: gh issue list → allow', await dispatch('pwsh', { command: 'gh issue list' }), false)
  check('pwsh: gh api repos/o/r → allow', await dispatch('pwsh', { command: 'gh api repos/o/r' }), false)

  // 8c. 重复尝试记忆：只记录硬 deny；软约束操作（v9）放行且不记录。
  check('v9: 普通 git push 软约束 → allow 且不记录', await dispatch('pwsh', { command: 'git push origin v9-repeat' }), false)
  check('v9: gh pr create 软约束 → allow 且不记录', await dispatch('pwsh', { command: 'gh pr create --title v9-repeat' }), false)
  check('v9: GitHub merge_pull_request 软约束 → allow', await dispatch('mcp__github__merge_pull_request', { owner: 'o', repo: 'r', pull_number: 99 }), false)
  // 硬 deny 路径重复记忆仍然有效（edit 控制平面 / force push）
  const v9Cp = 'C:\\Users\\v9\\.dsh\\.agent-presets\\kixparadigm\\agent.cordis.yml'
  check('v9: edit 控制平面首次 → deny + 记录', await dispatch('edit', { file_path: v9Cp }), true)
  check('v9: edit 同路径重复 → deny（memo）', await dispatch('edit', { file_path: v9Cp }), true)
  check('v9: force push 首次 → deny + 记录', await dispatch('pwsh', { command: 'git push --force origin v9-force' }), true)
  check('v9: 同 force push 重复 → deny（memo，不再重复检查）', await dispatch('pwsh', { command: 'git   push --force origin v9-force' }), true)
  check('v9: 不同命令不受 memo 影响 → allow', await dispatch('pwsh', { command: 'git status' }), false)

  // ══ 9. v7：commit budget 三重修复（reflog %gs 口径 / 完结 sprint 回退 / 预算兜底）══
  // 9a. countReflogCommits：%gs 口径只数 commit 类条目
  assert.deepStrictEqual(I.countReflogCommits(''), { commits: 0, churn: 0 }, '空 reflog → 0/0')
  assert.deepStrictEqual(I.countReflogCommits('commit: a\ncommit: b\nreset: moving to HEAD~1\ncommit: c'), { commits: 3, churn: 3 }, 'reset 不计入')
  assert.deepStrictEqual(I.countReflogCommits('commit: a\ncommit (amend): b\npull: Fast-forward\nmerge: x: Merge branch y\ncheckout: moving to z'), { commits: 1, churn: 2 }, 'amend 只进 hard cap 口径')
  assert.deepStrictEqual(I.countReflogCommits('reset: moving to HEAD~1\nrebase (finish): returning to refs/heads/kdae\npull: Fast-forward'), { commits: 0, churn: 0 }, '历史修整类全部不计')
  assert.deepStrictEqual(I.countReflogCommits('commit (initial): init'), { commits: 1, churn: 1 }, 'initial commit 计入')
  // 事故回归（2026-08-16 dae 仓库实测）：3 逻辑 commit + 2 次 reset 重做（各跟一个
  // recommit）+ 1 次 amend，v6 的 %H 口径计 8 次 → 误触过期 budget=3 熔断；
  // v7 = 5 个逻辑 commit（budget 口径）/ 6 个 commit 对象（hard cap 口径）
  assert.deepStrictEqual(
    I.countReflogCommits('commit: fix1\ncommit: fix2\ncommit: e2e-test\nreset: moving to HEAD~1\ncommit: fix1-re\nreset: moving to HEAD~1\ncommit: fix2-re\ncommit (amend): fix2-re'),
    { commits: 5, churn: 6 },
    '事故回归：8 → commits 5 / churn 6',
  )
  passed += 6

  // 9b. resolveCommitBudget：plan.md blast_radius.max_commits 兜底链
  assert.strictEqual(I.resolveCommitBudget({ planMd: 'blast_radius:\n  max_commits: 5\n' }), 5, 'plan.md max_commits 兜底 (v7)')
  assert.strictEqual(I.resolveCommitBudget({ planMd: 'task_sizing:\n  derived_commit_budget: 4\nblast_radius:\n  max_commits: 9\n' }), 4, 'task_sizing 优先于 max_commits')
  assert.strictEqual(I.resolveCommitBudget({ progressMd: '---\nblast_radius:\n  commit_budget: 3\n---\n', planMd: 'task_sizing:\n  derived_commit_budget: 8\nblast_radius:\n  max_commits: 9\n' }), 3, 'progress 覆盖 plan 两级')
  assert.strictEqual(I.resolveCommitBudget({ progressMd: '---\nsprint: 9\nstatus: complete\n---\n# trace\n', planMd: 'blast_radius:\n  branch_required: true\n  max_commits: 5\n' }), 5, 'sprint-9 实形：progress 无预算字段 → plan max_commits 兜底')
  passed += 4

  // 9c. commitBudgetSource：来源标注（deny 消息 / 冷启动 warn）
  assert.strictEqual(I.commitBudgetSource({}), '冷启动默认 3', '无上下文 → 冷启动')
  assert.strictEqual(I.commitBudgetSource({ progressMd: '---\nblast_radius:\n  commit_budget: 7\n---\n' }), 'progress.md blast_radius.commit_budget')
  assert.strictEqual(I.commitBudgetSource({ planMd: 'task_sizing:\n  derived_commit_budget: 5\n' }), 'plan.md task_sizing.derived_commit_budget')
  assert.strictEqual(I.commitBudgetSource({ planMd: 'blast_radius:\n  max_commits: 5\n' }), 'plan.md blast_radius.max_commits')
  passed += 4

  // 9d. resolveSprintContextPaths：marker 指向已完结 sprint → 回退最大编号
  const fsx = require('node:fs')
  const tmpBase = fsx.mkdtempSync(path.join(os.tmpdir(), 'kix-guards-v7-'))
  const docsRoot = path.join(tmpBase, 'docs')
  fsx.mkdirSync(docsRoot, { recursive: true })
  const mkSprint = (n, opts) => {
    const d = path.join(docsRoot, 'sprint-' + n)
    fsx.mkdirSync(d, { recursive: true })
    if (opts && opts.progressMd) fsx.writeFileSync(path.join(d, 'progress.md'), opts.progressMd)
    if (opts && opts.done) fsx.writeFileSync(path.join(d, 'done.md'), '---\nstatus: done\n---\n')
  }
  assert.strictEqual(I.resolveSprintContextPaths(docsRoot, 0), undefined, '无 sprint 目录 → undefined')
  mkSprint(6, { done: true, progressMd: '---\nblast_radius:\n  commit_budget: 3\n---\n' })
  assert.deepStrictEqual(I.resolveSprintContextPaths(docsRoot, 6), { dir: 'sprint-6', fallbackFrom: undefined, staleAll: true }, '唯一 sprint 已完结 → staleAll')
  mkSprint(9, { progressMd: '---\nsprint: 9\n---\n' })
  assert.deepStrictEqual(I.resolveSprintContextPaths(docsRoot, 6), { dir: 'sprint-9', fallbackFrom: 'sprint-6', staleAll: false }, '事故回归：marker 停在已完结 sprint-6 → 回退 sprint-9')
  assert.deepStrictEqual(I.resolveSprintContextPaths(docsRoot, 9), { dir: 'sprint-9', fallbackFrom: undefined, staleAll: false }, 'marker 直指活跃 sprint')
  assert.deepStrictEqual(I.resolveSprintContextPaths(docsRoot, 0), { dir: 'sprint-9', fallbackFrom: undefined, staleAll: false }, '无 marker → 最大编号')
  fsx.rmSync(tmpBase, { recursive: true, force: true })
  passed += 5

  // 9e. v8：GitHub 前缀可配置（部署命名不同时不再静默失效）
  {
    const customListeners = {}
    const customCtx = {
      logger: { info() {}, warn() {}, error() {} },
      get(name) { return name === 'userQuestions' ? userQuestionsMock : undefined },
      on(event, cb) { ;(customListeners[event] ||= []).push(cb) },
    }
    plugin.apply(customCtx, { githubToolPrefix: 'mcp__gh__' })
    const customPre = customListeners['tools/pre-execute'][0]
    const customDispatch = (name, args) => customPre({ name, arguments: args, token: 't', callId: 'c', agent: { id: 'test-agent' } }, () => Promise.resolve({ kind: 'allow' }))
    check('v9 自定义 GitHub 前缀：mcp__gh__ 写 main → deny', await customDispatch('mcp__gh__create_or_update_file', { owner: 'o', repo: 'r', path: 'a.ts', branch: 'main', content: 'x' }), true)
    check('v9 自定义 GitHub 前缀：旧 mcp__github__ 前缀不再误纳入 → allow', await customDispatch('mcp__github__create_or_update_file', { owner: 'o', repo: 'r', path: 'a.ts', branch: 'feature', content: 'x' }), false)
    check('v9 自定义 GitHub 前缀：新前缀只读 get → allow', await customDispatch('mcp__gh__get_issue', { owner: 'o', repo: 'r', issue_number: 1 }), false)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
})()
