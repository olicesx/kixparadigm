// kix-guards 回归测试（v3，2026-08-21 独立审查修复后）
//
// 单元级验证：加载 kix-guards.js，mock DSH pre-execute 派发
// （模拟 dsh-tools createExecution 的输出结构：{ name, arguments, ... }），
// 覆盖全部门禁分支（deny / ask / allow）+ __internals 纯逻辑。
// 运行：node plugins/kix-guards.test.js
//
// 注意：本测试模拟的是"监听器被 DSH 调用"后的决策逻辑；
// 运行时"监听器确实被挂载"的端到端验证需在新会话执行。

const path = require('node:path')
const assert = require('node:assert')
const os = require('node:os')

// ── mock ctx（cordis 插件 apply(ctx) 需要的表面）──────────────────────────
const listeners = {}
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
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
// 无 agent → checkGitCommit 走「无法解析仓库根 → 放行 + warn」路径（不依赖真实 git）。
function dispatch(name, args) {
  const exec = { name, arguments: args, token: 't', callId: 'c' }
  return preExecute[0](exec, () => Promise.resolve({ kind: 'allow' }))
}

let passed = 0
let failed = 0
function check(label, decision, expect) {
  // expect: true=deny / false=allow / 'ask'
  const kind = decision && decision.kind
  const ok = expect === 'ask' ? kind === 'ask' : (kind === 'deny') === expect
  if (ok) { passed++ } else { failed++ }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  →  ${kind}${ok ? '' : ` (expected ${expect === 'ask' ? 'ask' : expect ? 'deny' : 'allow'})`}`)
}

;(async () => {
  // ══ 1. 破坏性 SQL（v3：仅限 DB 客户端 / SQL 工具上下文；语句级判定）════
  check('pwsh: psql -c "drop table users" → deny', await dispatch('pwsh', { command: 'psql -c "drop table users"' }), true)
  check('pwsh: psql -c "DELETE FROM users" → deny', await dispatch('pwsh', { command: 'psql -c "DELETE FROM users"' }), true)
  // 终端保守硬拦（ps1 310 行）：DB 客户端含破坏性关键字即 deny，不区分 WHERE
  check('pwsh: psql -c "DELETE FROM users WHERE id = 1" → deny（保守）', await dispatch('pwsh', { command: 'psql -c "DELETE FROM users WHERE id = 1"' }), true)
  check('pwsh: psql -c "UPDATE users SET admin = 1" → deny (v2)', await dispatch('pwsh', { command: 'psql -c "UPDATE users SET admin = 1"' }), true)
  check('pwsh: psql -c "UPDATE users SET admin = 1 WHERE id = 2" → deny（保守）', await dispatch('pwsh', { command: 'psql -c "UPDATE users SET admin = 1 WHERE id = 2"' }), true)
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
  check('pwsh: psql -c "UPDATE \\"users\\" SET x = 1" → deny (v3)', await dispatch('pwsh', { command: 'psql -c "UPDATE "users" SET x = 1"' }), true)
  // 脱域误伤修复（v3）：裸终端文本不再判 SQL
  check('pwsh: grep -r "DELETE FROM users" src/ → allow (v3)', await dispatch('pwsh', { command: 'grep -r "DELETE FROM users" src/' }), false)
  check('pwsh: echo "drop table users" → allow (v3)', await dispatch('pwsh', { command: 'echo "drop table users"' }), false)

  // ── SQL 工具门禁（v3：SQL_TOOLS 已入白名单，门禁 4 可达）────────────────
  check('sql: DELETE FROM users → deny (v3)', await dispatch('sql', { sql: 'DELETE FROM users' }), true)
  check('sql: SELECT 1 → allow (v3)', await dispatch('sql', { sql: 'SELECT 1' }), false)
  check('sql_execute: DROP TABLE t → deny (v3)', await dispatch('sql_execute', { query: 'DROP TABLE t' }), true)

  // ══ 2. git 写保护（v3：解析式子命令门）════════════════════════════════
  check('pwsh: git push --force origin main → deny', await dispatch('pwsh', { command: 'git push --force origin main' }), true)
  check('pwsh: git push -f origin feature → deny (v2)', await dispatch('pwsh', { command: 'git push -f origin feature' }), true)
  check('pwsh: git push origin +main → deny (v2)', await dispatch('pwsh', { command: 'git push origin +main' }), true)
  check('pwsh: git push --mirror origin → deny (v2)', await dispatch('pwsh', { command: 'git push --mirror origin' }), true)
  check('pwsh: git push --force-with-lease origin feature → ask (v2)', await dispatch('pwsh', { command: 'git push --force-with-lease origin feature' }), 'ask')
  // v3 修复：-C / -c / git.exe 不再绕过
  check('pwsh: git -C C:\\repo push --force origin main → deny (v3)', await dispatch('pwsh', { command: 'git -C C:\\repo push --force origin main' }), true)
  check('pwsh: git -c user.name=x push --force origin main → deny (v3)', await dispatch('pwsh', { command: 'git -c user.name=x push --force origin main' }), true)
  check('pwsh: git.exe push --force origin main → deny (v3)', await dispatch('pwsh', { command: 'git.exe push --force origin main' }), true)
  check('pwsh: git -C C:\\repo reset --hard HEAD → ask (v3)', await dispatch('pwsh', { command: 'git -C C:\\repo reset --hard HEAD' }), 'ask')
  // 人类确认点 ask
  check('pwsh: git reset --hard HEAD → ask', await dispatch('pwsh', { command: 'git reset --hard HEAD' }), 'ask')
  check('pwsh: git clean -fd → ask', await dispatch('pwsh', { command: 'git clean -fd' }), 'ask')
  check('pwsh: git branch -D old → ask', await dispatch('pwsh', { command: 'git branch -D old-branch' }), 'ask')
  check('pwsh: git stash drop → ask', await dispatch('pwsh', { command: 'git stash drop' }), 'ask')
  check('pwsh: git checkout -- src/a.ts → ask', await dispatch('pwsh', { command: 'git checkout -- src/a.ts' }), 'ask')
  check('pwsh: git restore src/a.ts → ask', await dispatch('pwsh', { command: 'git restore src/a.ts' }), 'ask')
  // push 目标受保护分支（v3：参数检测，不扫 commit message）
  check('pwsh: git push origin feature → ask (v2)', await dispatch('pwsh', { command: 'git push origin feature' }), 'ask')
  check('pwsh: git push origin main → deny (v3)', await dispatch('pwsh', { command: 'git push origin main' }), true)
  check('pwsh: git push origin main-branch → ask (v3)', await dispatch('pwsh', { command: 'git push origin main-branch' }), 'ask')
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
  check('pwsh: git push origin abc--force → ask (v3)', await dispatch('pwsh', { command: 'git push origin abc--force' }), 'ask')
  // commit budget/分支（无 agent → 放行不崩）
  check('pwsh: git commit -am x（无 agent）→ allow', await dispatch('pwsh', { command: 'git commit -am "wip"' }), false)

  // ══ 3. 控制平面保护（v3：home 限定，项目级同名文件不误伤）════════════
  const HOME = (process.env.USERPROFILE || os.homedir()).replace(/\\/g, '/')
  check(`pwsh: 读 ${HOME}/.dsh/settings.yaml → deny`, await dispatch('pwsh', { command: `Get-Content ${HOME}\\.dsh\\settings.yaml` }), true)
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
  check('github merge_pull_request → ask', await dispatch('mcp__github__merge_pull_request', { owner: 'o', repo: 'r', pull_number: 3 }), 'ask')
  check('github add_issue_comment → ask', await dispatch('mcp__github__add_issue_comment', { owner: 'o', repo: 'r', issue_number: 1, body: 'b' }), 'ask')
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
  // v4：mutation 精确名单仍须 ask（含原 `request_` 意图覆盖的 review 提交）
  check('github create_pull_request → ask (v4)', await dispatch('mcp__github__create_pull_request', { owner: 'o', repo: 'r', title: 't', head: 'h', base: 'b' }), 'ask')
  check('github create_pull_request_review → ask (v4)', await dispatch('mcp__github__create_pull_request_review', { owner: 'o', repo: 'r', pull_number: 1, event: 'APPROVE' }), 'ask')
  check('github update_issue → ask (v4)', await dispatch('mcp__github__update_issue', { owner: 'o', repo: 'r', issue_number: 1, state: 'closed' }), 'ask')
  check('github fork_repository → ask (v4)', await dispatch('mcp__github__fork_repository', { owner: 'o', repo: 'r' }), 'ask')
  check('github create_branch → ask (v4)', await dispatch('mcp__github__create_branch', { owner: 'o', repo: 'r', branch: 'x' }), 'ask')

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
  passed += 3

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

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
})()
