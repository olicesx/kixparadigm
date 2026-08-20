// kix4 smoke tests — fake-ctx harness (repo convention: node plugins/kix4.test.js)
'use strict'
const assert = require('node:assert')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

// 自包含定位：优先本仓库 preset 目录（CI/分发场景）；本机安装副本存在时用安装面
const REPO_BASE = path.join(__dirname, '..')
const INSTALLED_BASE = '/root/.dsh/.agent-presets/kixparadigm'
const fs0 = require('node:fs')
const BASE = fs0.existsSync(path.join(INSTALLED_BASE, 'agent.cordis.yml')) ? INSTALLED_BASE : REPO_BASE

function fakeCtx() {
  const handlers = {}
  const disposers = []
  return {
    tools: {
      registered: [],
      register(def) { this.registered.push(def); return () => { const i = this.registered.indexOf(def); if (i >= 0) this.registered.splice(i, 1) } },
    },
    on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn) },
    effect(fn) { disposers.push(fn) },
    __handlers: handlers,
    __disposers: disposers,
  }
}

async function fire(ctx, evt, ...args) {
  const hs = ctx.__handlers[evt] || []
  // event signatures: tools/post-execute(exec, result, next); others(payload)
  let chain = args.length > 1 ? args[1] : undefined
  for (const h of hs) {
    if (evt === 'tools/post-execute') {
      const r = await h(args[0], args[1], () => chain)
      if (r !== undefined) chain = r
    } else {
      await h(...args)
    }
  }
  return chain
}

let passed = 0
function ok(name, cond) { assert.ok(cond, name); passed++; console.log('  PASS', name) }

async function main() {
// ── kix-probe ─────────────────────────────────────────────
{
  console.log('kix-probe:')
  const probe = require(path.join(BASE, 'plugins/kix-probe.js'))
  const ctx = fakeCtx()
  probe.apply(ctx)
  const def = ctx.tools.registered.find((d) => d.name === 'probe')
  ok('registers probe', !!def)
  ok('description mentions no task/crisis words', !/test|smoke|regression|verify/i.test(def.description))
  ok('description mentions duration and memory', /duration/.test(def.description) && /memory/.test(def.description))
  ok('parameters: code required, measure optional', def.parameters.required[0] === 'code' && !!def.parameters.properties.measure)
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-ws-'))
  const r1 = await def.execute({ code: 'print(6*7)' }, { agent: { session: { header: { cwd: ws } } } })
  ok('executes and captures stdout', r1.ok && r1.stdout.includes('42'))
  ok('duration_ms present', typeof r1.duration_ms === 'number' && r1.duration_ms >= 0)
  ok('exit_code 0', r1.exit_code === 0)
  const r2 = await def.execute({ code: 'import sys\nsys.exit(3)\nprint("x")', measure: true }, { agent: { session: { header: { cwd: ws } } } })
  ok('exit_code 3 propagated', r2.exit_code === 3)
  const r3 = await def.execute({ code: 'x = [0]*10**6\nprint(sum(x))' , measure: true }, { agent: { session: { header: { cwd: ws } } } })
  ok('measure reports traced_peak_mb', r3.ok && typeof r3.traced_peak_mb === 'number' && r3.traced_peak_mb >= 0)
  const r4 = await def.execute({ code: '' })
  ok('empty code rejected', r4.ok === false)
  const r5 = await def.execute({ code: 'import time\ntime.sleep(62)' }, { agent: { session: { header: { cwd: ws } } } })
  ok('60s timeout enforced', r5.timed_out === true)
}

// ── kix-settle ────────────────────────────────────────────
{
  console.log('kix-settle:')
  const settle = require(path.join(BASE, 'plugins/kix-settle.js'))
  const ctx = fakeCtx()
  settle.apply(ctx)
  const session = { id: 's1', header: { cwd: '/ws/proj' } }
  const agent = { session }
  const res1 = { contexts: [] }
  await fire(ctx, 'tools/post-execute', { agent, name: 'edit', arguments: { file_path: '/ws/proj/a.py' } }, res1)
  ok('edit flows through chain without breaking (flash-compat shell3 form)', res1.contexts.length === 0)
  const agent2 = { session: { id: 's2', header: { cwd: '/ws/proj' } } }
  await fire(ctx, 'tools/post-execute', { agent: agent2, name: 'edit', arguments: { file_path: '/outside/x.py' } }, { contexts: [] })
  ok('handler never throws on any exec shape', true)
}

// ── kix-mem ───────────────────────────────────────────────
{
  console.log('kix-mem:')
  const mem = require(path.join(BASE, 'plugins/kix-mem.js'))
  const entries = mem.__internals.listEntries()
  ok('experience library has entries', entries.length >= 1)
  const lesson = entries.find((e) => e.file.includes('incentive-lessons'))
  ok('incentive-lessons.md listed with crisis index', !!lesson && lesson.index.includes('求助索引'))
  const ctx = fakeCtx()
  mem.apply(ctx)
  const def = ctx.tools.registered.find((d) => d.name === 'experience')
  ok('registers experience tool', !!def)
  const r1 = await def.execute({ action: 'list' })
  ok('list returns catalog', r1.ok && r1.count >= 1 && Array.isArray(r1.entries))
  const r2 = await def.execute({ action: 'get', name: 'incentive-lessons.md' })
  ok('get returns full note', r2.ok && r2.text.includes('契约清晰度'))
  const r3 = await def.execute({ action: 'get', name: '../../etc/passwd' })
  ok('path traversal blocked (basename only)', r3.ok === false)
}

// ── kix-budget L3 patch ──────────────────────────────────
{
  console.log('kix-budget L3:')
  const src = fs.readFileSync(path.join(BASE, 'plugins/kix-budget.js'), 'utf8')
  ok('verify-subsudy hook present', src.includes("=== 'probe' || _nm === 'run_code'") || src.includes("_nm === 'probe'"))
  ok('read-only streak logic intact', src.includes('isReadOnlyTool(exec && exec.name, args)'))
  // functional: run budget internals through its own test file if present
  const testPath = path.join(BASE, 'plugins/kix-budget.test.js')
  if (fs.existsSync(testPath)) {
    const { execSync } = require('node:child_process')
    try {
      execSync('node ' + JSON.stringify(testPath), { cwd: path.join(BASE, 'plugins'), stdio: 'pipe', timeout: 60000 })
      ok('existing kix-budget unit tests still pass', true)
    } catch (e) {
      ok('existing kix-budget unit tests still pass', false)
    }
  }
}

// ── composition parity ────────────────────────────────────
{
  console.log('composition parity:')
  const a = fs.readFileSync(path.join(BASE, 'agent.cordis.yml'), 'utf8')
  const v2Path = '/root/.dsh/.agent-presets/kixincentive/agent.cordis.yml'
  const nullPath = BASE === INSTALLED_BASE
    ? '/root/.dsh/.agent-presets/kixparadigm-null/agent.cordis.yml'
    : path.join(__dirname, '..', '..', 'preset-null', 'agent.cordis.yml')
  if (!fs.existsSync(v2Path)) {
    // CI / fresh checkout: frozen v2 anchor is an install-side experimental asset;
    // verify intra-repo parity instead (default vs null plugin rows).
    const n = fs.readFileSync(nullPath, 'utf8')
    const idsA = (a.match(/^- id: .+$/gm) || [])
    const idsN = (n.match(/^- id: .+$/gm) || [])
    ok('null variant plugin rows identical (repo mode)', idsA.length === idsN.length)
    ok('null persona is minimal', n.includes('Preserve safety, permissions, user intent, and evidence integrity.'))
    return
  }
  const v2 = fs.readFileSync(v2Path, 'utf8')
  const n = fs.readFileSync(nullPath, 'utf8')
  ok('v2 composition untouched', require('node:crypto').createHash('sha256').update(v2).digest('hex') === '49f820801d0660c57a2797c8ca9ea3c9b68cbedbc1c120c98de98abef9df5643')
  const idsA = (a.match(/^- id: .+$/gm) || [])
  const idsV2 = (v2.match(/^- id: .+$/gm) || [])
  ok('kixparadigm = v2 rows + exactly 5 new plugin rows (probe/settle/mem/browser + stalled 全开 2026-08-20)', idsA.length === idsV2.length + 5)
  ok('new rows are probe/settle/mem/browser/stalled', /- id: kix-probe/.test(a) && /- id: kix-settle/.test(a) && /- id: kix-mem/.test(a) && /- id: kix-browser/.test(a) && /- id: kix-stalled/.test(a))
  ok('previously disabled flow plugins re-enabled (discipline/orchestration/consistency/commands/signal)', !/id: kix-discipline\s*\n\s*name: .*\n\s*disabled: true/.test(a) && !/id: kix-orchestration\s*\n\s*name: .*\n\s*disabled: true/.test(a) && !/id: kix-consistency\s*\n\s*name: .*\n\s*disabled: true/.test(a) && !/id: kix-commands\s*\n\s*name: .*\n\s*disabled: true/.test(a) && !/id: kix-signal\s*\n\s*name: .*\n\s*disabled: true/.test(a))
  const idsN = (n.match(/^- id: .+$/gm) || [])
  ok('null variant plugin rows identical', idsA.length === idsN.length)
  ok('null persona is minimal', n.includes('Preserve safety, permissions, user intent, and evidence integrity.') && !n.includes('kixParadigm — AI 自编排最小范式'))
}

console.log('\nALL ' + passed + ' CHECKS PASS')
}
main().catch((e)=>{console.error(e);process.exit(1)})
