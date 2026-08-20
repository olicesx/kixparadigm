// kix-probe — 中性裸执行器 + 免费测度（EXP3 冻结版 + L2 落地）
//
// 出生证明：
//   EXP3（48 runs）证明 probe 被真实采纳且行为正确——采纳时先探测后修复
//   （步骤 11–15 扫契约边缘 vs 首个修复 edit 在 16）、零成本溢价（1.00×）、
//   无仪式滥用（no-op note 安慰剂 48 run 全程零调用）。
//   L2 迭代（2026-08-19）：三轮实验的存活缺陷共同点是「不测量就看不见」
//   （成本搬迁/环境掩盖/延迟校验）——把测度做成免费副产品：
//   每次执行自动附带 duration_ms；measure=true 时附 tracemalloc 峰值。
// 复活条件：若未来模型自带测量习惯（trace 数据显示 probe 采纳率趋零且
//   质量不降），本插件退役。
'use strict'
const { spawn } = require('node:child_process')
const path = require('node:path')
const crypto = require('node:crypto')

const DESCRIPTION =
  'Run a short Python snippet in a fresh process against the current workspace; returns stdout, stderr, exit code, and wall-clock duration, optionally peak memory. Use for isolated Python checks (memory/time probing, quick verification); for full shell commands use bash.'

const MEASURE_WRAPPER = [
  'import sys, tracemalloc',
  'src = sys.stdin.read()',
  'tracemalloc.start()',
  'g = {"__name__": "__main__"}',
  'rc = 0',
  'try:',
  '    exec(compile(src, "<probe>", "exec"), g)',
  'except SystemExit as e:',
  '    rc = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)',
  'except BaseException:',
  '    import traceback; traceback.print_exc(); rc = 1',
  'cur, peak = tracemalloc.get_traced_memory()',
  'sys.stderr.write("\\n[probe traced_peak_mb=%.1f]\\n" % (peak / 1e6))',
  'sys.exit(rc)',
].join('\n')

module.exports = {
  name: 'kix-probe',
  inject: ['tools'],
  apply(ctx) {
    const dispose = ctx.tools.register({
      name: 'probe',
      description: DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python source to run.' },
          measure: { type: 'boolean', description: 'Also report traced peak memory of this run.' },
        },
        required: ['code'],
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const code = args && typeof args.code === 'string' ? args.code : ''
        if (!code.trim()) return { ok: false, error: 'empty code' }
        const measure = args && args.measure === true
        let cwd = '.'
        try {
          cwd = (exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd) || '.'
        } catch (_) { /* keep '.' */ }

        const runWith = (exe) =>
          new Promise((resolve) => {
            const argv = measure ? [ '-c', MEASURE_WRAPPER ] : [ '-c', code ]
            const p = spawn(exe, argv, { cwd, env: Object.assign({}, process.env, { PYTHONPATH: cwd }) })
            if (measure) {
              p.stdin.on('error', () => { /* ignore EPIPE if child died early */ })
              p.stdin.write(code)
              p.stdin.end()
            }
            let out = ''
            let err = ''
            let settled = false
            const t0 = Date.now()
            const timer = setTimeout(() => {
              if (settled) return
              settled = true
              try { p.kill('SIGKILL') } catch (_) { /* already gone */ }
              resolve({ ok: true, timed_out: true, exit_code: null, duration_ms: Date.now() - t0, stdout: '', stderr: 'probe: killed after 60s' })
            }, 60000)
            p.stdout.on('data', (d) => { out += d })
            p.stderr.on('data', (d) => { err += d })
            p.on('error', () => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resolve(null)
            })
            p.on('close', (c) => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              const duration_ms = Date.now() - t0
              const id = crypto.randomUUID().slice(0, 8)
              // L3 经济补贴的物理形态：紧凑输出（默认尾 4000/1500 字符）
              const res = { ok: true, exit_code: c, duration_ms,
                            stdout: out.slice(-4000), stderr: err.slice(-1500) }
              if (measure) {
                const m = /\[probe traced_peak_mb=([0-9.]+)\]/.exec(err)
                if (m) res.traced_peak_mb = Number(m[1])
              }
              res.note = 'probe-' + id
              resolve(res)
            })
          })
        let res = await runWith(path.join(cwd, 'venv', 'bin', 'python'))
        if (!res) res = await runWith('python3')
        if (!res) return { ok: false, error: 'no python interpreter available' }
        return res
      },
    })
    ctx.effect(() => dispose)
  },
}
