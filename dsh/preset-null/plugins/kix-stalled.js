// kix-stalled — L3 档 A 静态资产（2026-08-15，减法版）
//
// 定位：只读、无状态、无常驻的 stalled 机械检测原语。
//   - /kixst-check <项目根>：用户命令，零 token，扫描 docs/sprint-*/progress.md
//     判定停滞 Sprint（status 进行中且 last_updated 超 24h）
//   - kix_stalled_check 模型工具：模型侧按需检查（workflow preflight 双保险等）
//
// 设计纪律（对照 dsh-capability-map.md §6）：
//   - 未验证不承诺：仅 status ∈ {in-progress,in_progress,active} 且时间戳可解析
//     且超阈值才判 stalled；done / 缺时间戳不误报
//   - 规则是负债：不做常驻定时器、不写 frontmatter、不注入提醒（enable/disable
//     形态在原型历史 pkg-14 保留，真实项目证据需要后再恢复）
//   - 阈值固定 24h：是否参数化待真实项目定夺，不提前铺参数面
//
// 挂载：agent.cordis.yml 一行（默认注释 = opt-in，启用见 scripts/install-kix-stalled.ps1）
//   - id: kix-stalled
//     name: ./plugins/kix-stalled.js

'use strict'

const STALLED_HOURS = 24

function parseDate(v) {
  if (!v) return undefined
  const t = Date.parse(v)
  if (!isNaN(t)) return t
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime()
  return undefined
}

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const fm = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) fm[kv[1]] = kv[2].trim()
  }
  return fm
}

async function scanRoot(fs, root) {
  const result = { root, sprints: [] }
  try {
    const docsTarget = await fs.resolve('docs', { cwd: root })
    const entries = await fs.listDir(docsTarget)
    const sprints = entries.filter((e) => e.name && /^sprint-\d+$/.test(e.name))
    for (const s of sprints) {
      const item = { dir: s.name, status: 'unknown', lastUpdated: null, stalled: false, ageHours: null, note: null }
      try {
        const target = await fs.resolve('docs/' + s.name + '/progress.md', { cwd: root })
        const text = await fs.readText(target)
        const fm = parseFrontmatter(text)
        const status = String(fm.status || '').toLowerCase()
        item.status = status || 'unknown'
        item.lastUpdated = fm.last_updated || fm.lastUpdated || null
        const last = parseDate(item.lastUpdated)
        item.ageHours = last === undefined ? null : Math.round((Date.now() - last) / 3600000)
        const inProgress = status === 'in-progress' || status === 'in_progress' || status === 'active'
        if (inProgress && last !== undefined && item.ageHours > STALLED_HOURS) {
          item.stalled = true
        } else if (inProgress && last === undefined) {
          item.note = 'no parseable last_updated; skipped (no false positive)'
        }
      } catch (e) {
        item.note = 'skip: ' + (e && e.message ? e.message : String(e))
      }
      result.sprints.push(item)
    }
  } catch (e) {
    result.note = 'no docs/ or unreadable: ' + (e && e.message ? e.message : String(e))
  }
  return result
}

function formatScan(result) {
  const lines = []
  for (const s of result.sprints) {
    const age = s.ageHours === null ? '?' : s.ageHours + 'h'
    lines.push((s.stalled ? '⚠️ STALLED  ' : 'ok         ') + s.dir + '  status=' + s.status + '  age=' + age + (s.note ? '  (' + s.note + ')' : ''))
  }
  if (lines.length === 0) lines.push('（无 docs/sprint-*/progress.md）')
  const stalled = result.sprints.filter((s) => s.stalled).length
  return 'kixst-check @ ' + new Date().toISOString() + '\n' + lines.join('\n') + '\nstalled: ' + stalled + ' (threshold=' + STALLED_HOURS + 'h)'
}

module.exports = {
  name: 'kix-stalled',
  inject: ['fs', 'commands', 'tools'],
  apply(ctx) {
    const fs = ctx.fs
    const commands = ctx.commands
    const tools = ctx.tools
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const defaultRoot = sandboxPolicy !== undefined && sandboxPolicy.workspaceRoot ? sandboxPolicy.workspaceRoot : undefined

    // 用户命令：零 token、只读、无状态
    commands.register({
      name: 'kixst-check',
      description: '扫描项目 docs/sprint-*/progress.md 检测停滞 Sprint（只读，threshold=24h）',
      input: { hint: '[项目根目录]' },
      async handler({ rawInput }) {
        const root = (rawInput || '').trim() || defaultRoot
        if (!root) return { kind: 'error', text: 'kixst-check: 未提供项目根目录（且无 workspaceRoot 可回退）' }
        try {
          const result = await scanRoot(fs, root)
          return { kind: 'success', text: formatScan(result) }
        } catch (e) {
          return { kind: 'error', text: 'kixst-check 失败: ' + (e && e.message ? e.message : String(e)) }
        }
      },
    })

    // 模型工具：模型侧按需检查（workflow preflight 双保险等场景）
    const disposeTool = tools.register({
      name: 'kix_stalled_check',
      description: '扫描项目根下 docs/sprint-*/progress.md，检测停滞（stalled）Sprint（status 进行中且 last_updated 超过 24h）。只读，无副作用。',
      parameters: {
        // tools.register 原样投影 parameters：必须含顶层 type: 'object'
        type: 'object',
        properties: {
          root: { type: 'string', description: '项目根目录（绝对路径）；缺省用当前工作区根' },
        },
      },
      output: {
        // output.schema 是 JsonSchemaNode：object 需 properties
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const root = args && args.root ? String(args.root) : defaultRoot
        if (!root) return { ok: false, error: 'no root; pass root explicitly' }
        const result = await scanRoot(fs, root)
        return { ok: true, checkedAt: new Date().toISOString(), stalledCount: result.sprints.filter((s) => s.stalled).length, project: result }
      },
    })
    ctx.effect(() => disposeTool)
  },
}

module.exports.__internals = { scanRoot, formatScan, parseDate, parseFrontmatter, STALLED_HOURS }
