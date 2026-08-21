// kix-signal 回归测试
//
// 单元级验证：mock DSH ctx 表面（tools/commands/events），驱动完整
// pre/post-execute 管线，覆盖 S3 机制与 S1/S2 退役后的纯函数残留面：
//   S3 草稿：源编辑触发注入、测试/文档路径不触发、只提醒一次、默认开/false 关
//   （S1 轮询 2026-08-19 退役：与宿主 repeat-tool-reminder 重叠；
//    S2 编排 2026-08-19 退役：与 kix-budget streak/41步 gate 重叠——见插件头部死亡证明）
// 运行：node kix-signal.test.js

const assert = require('node:assert')
const plugin = require('./kix-signal.js')
const { isSourcePath, specDraftText } = plugin.__internals

// ── mock ctx：事件注册表 + next 链 ────────────────────────────────────────
function makeCtx() {
  const handlers = { 'tools/pre-execute': [], 'tools/post-execute': [] }
  const registered = { tools: [], commands: [] }
  const effects = []
  const ctx = {
    tools: {
      register(def) { registered.tools.push(def); return () => {} },
    },
    commands: {
      // 镜像宿主 dsh-commands 契约（register 校验）：input 可选；给了则 hint
      // 必须是非空字符串。2026-08-19 Windows 前台全挂教训：mock 不校验导致
      // input: { hint: '' } 过了 31 个单测却在真宿主上炸掉整个 preset 挂载。
      register(def) {
        if (typeof def.handler !== 'function') throw new TypeError(`command "${def.name}" handler must be a function`)
        if (def.input !== undefined) {
          if (typeof def.input !== 'object' || def.input === null || !('hint' in def.input) || typeof def.input.hint !== 'string') throw new TypeError(`command "${def.name}" input hint must be a string`)
          if (def.input.hint.trim().length === 0) throw new TypeError(`command "${def.name}" input hint must not be empty`)
        }
        registered.commands.push(def); return () => {}
      },
    },
    on(evt, fn) { (handlers[evt] || []).push(fn) },
    get(key) { return undefined },
    effect(fn) { effects.push(fn) },
  }
  ctx.__handlers = handlers
  ctx.__registered = registered
  return ctx
}

async function runPost(ctx, agent, name, args, result) {
  const hs = ctx.__handlers['tools/post-execute']
  let decision = { kind: 'accept' }
  const nextFns = hs.map(() => async () => decision)
  // 模拟瀑布：从最后一个往前包（后注册先执行？DSH 约定注册序执行，next 透传下游）
  let i = 0
  const runNext = async () => {
    if (i >= hs.length) return { kind: 'accept' }
    const fn = hs[i++]
    return fn({ name, arguments: args, agent }, result, runNext)
  }
  return runNext()
}

async function runPre(ctx, agent, name, args) {
  const hs = ctx.__handlers['tools/pre-execute']
  let i = 0
  const runNext = async () => {
    if (i >= hs.length) return { kind: 'accept' }
    const fn = hs[i++]
    return fn({ name, arguments: args, agent }, runNext)
  }
  return runNext()
}

function makeAgent() {
  return { session: { id: 'test-sess' } }
}

// 捕获注入的 notices
function contextsOf(decision) {
  return (decision && Array.isArray(decision.additionalContexts)) ? decision.additionalContexts : []
}
function textOf(msgs) {
  return msgs.map((m) => m.content[0].text).join('\n')
}

let passed = 0
function ok(cond, label) {
  assert.ok(cond, label)
  passed++
  console.log('  ok - ' + label)
}

// ═══ S1 poll-guard：2026-08-19 退役（与宿主 repeat-tool-reminder 重叠，
//     独占面未证），测试块随机制一并移除。见插件头部死亡证明。 ═══════════
async function main() {

// ═══ S3 spec 草稿 ═══════════════════════════════════════════════════════
console.log('# S3 spec-draft')
{
  const ctx = makeCtx()
  plugin.apply(ctx, { specDraft: true })
  const agent = makeAgent()
  const res = { ok: true }

  // 源编辑：pre 标记 + post 注入草稿
  await runPre(ctx, agent, 'edit', { file_path: 'C:/x/src/app/main.go' })
  const d = await runPost(ctx, agent, 'edit', { file_path: 'C:/x/src/app/main.go' }, res)
  ok(contextsOf(d).length === 1, '源编辑触发草稿注入')
  ok(textOf(contextsOf(d)).includes('goal:'), '草稿含 goal 字段')
  ok(textOf(contextsOf(d)).includes('kix_discipline_spec'), '草稿指向落档工具')
  ok(textOf(contextsOf(d)).includes('contract:'), '草稿含 contract 槽（与 kix_discipline_spec 双向引用）')
  // 只一次
  await runPre(ctx, agent, 'edit', { file_path: 'C:/x/src/app/other.go' })
  const d2 = await runPost(ctx, agent, 'edit', { file_path: 'C:/x/src/app/other.go' }, res)
  ok(contextsOf(d2).length === 0, '草稿只注一次')

  // 测试/文档路径不触发
  const agent2 = makeAgent()
  await runPre(ctx, agent2, 'edit', { file_path: 'C:/x/src/app/main_test.go' })
  const d3 = await runPost(ctx, agent2, 'edit', { file_path: 'C:/x/src/app/main_test.go' }, res)
  ok(contextsOf(d3).length === 0, '测试文件不触发草稿')
  const agent3 = makeAgent()
  await runPre(ctx, agent3, 'write', { file_path: 'C:/x/docs/README.md' })
  const d4 = await runPost(ctx, agent3, 'write', { file_path: 'C:/x/docs/README.md' }, res)
  ok(contextsOf(d4).length === 0, '文档不触发草稿')

  // 默认开启（2026-08-19 起默认接线）；specDraft: false 显式关
  const ctx2 = makeCtx()
  plugin.apply(ctx2, {})
  const agent4 = makeAgent()
  await runPre(ctx2, agent4, 'edit', { file_path: 'C:/x/src/app/main.go' })
  const d5 = await runPost(ctx2, agent4, 'edit', { file_path: 'C:/x/src/app/main.go' }, res)
  ok(contextsOf(d5).length === 1, '默认（无 config）注入草稿')
  const ctx3 = makeCtx()
  plugin.apply(ctx3, { specDraft: false })
  const agent5 = makeAgent()
  await runPre(ctx3, agent5, 'edit', { file_path: 'C:/x/src/app/main.go' })
  const d6 = await runPost(ctx3, agent5, 'edit', { file_path: 'C:/x/src/app/main.go' }, res)
  ok(contextsOf(d6).length === 0, 'specDraft: false 显式关闭')
}

// ═══ 单元：纯函数 ════════════════════════════════════════════════════════
console.log('# pure helpers')
{
  ok(isSourcePath('C:/x/src/main.go') === true, 'isSourcePath 源码=true')
  ok(isSourcePath('C:/x/src/main_test.go') === false, 'isSourcePath 测试=false')
  ok(isSourcePath('C:/x/docs/adr/001.md') === false, 'isSourcePath 文档=false')
  ok(specDraftText('/tmp/a.go', 'do the thing').includes('do the thing'), 'specDraftText 含任务上下文')
  ok(specDraftText('/tmp/a.go', undefined).includes('（从当前任务上下文补全）'), 'specDraftText 无上下文时占位')
}

console.log(`\nALL PASS (${passed} assertions)`)
}
main().catch((e) => { console.error(e); process.exit(1) })
