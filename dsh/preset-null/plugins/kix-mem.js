// kix-mem — 无助时刻经验救援库（拉取式，零常驻上下文，2026-08-19）
//
// 出生证明（用户当日实证）：
//   模型在走投无路时会急切翻找以前的经验——记忆文件用「指针 + 头尾索引」
//   格式后，无助时刻有一个低成本的经验库可依靠。本插件把该通道做成工具
//   而非注入：常驻成本为零，只在模型主动求助时拉取（EXP3 证据：模型只用
//   有用的工具，不因存在而用——no-op 安慰剂 48 run 零调用）。
//   库内容 = preset memories/ 目录，格式遵循 orchestration-lessons.md 的
//   头部署急索引 + 文末新条目约定；文件也可被 read 工具直接读。
// 退役条件：模型长期不调用且质量不降 → 删除；或经验全部过时 → 重写库。
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const MEM_DIR = path.resolve(__dirname, '..', 'memories')

const DESCRIPTION =
  'Browse a crisis-indexed library of hard-won empirical lessons from past sessions (contract clarity, verification, cost relocation, harness pitfalls). Entries cite the experiment or incident they came from. action=list returns the catalog; action=get returns one full note. The files can also be read directly.'

function listEntries() {
  const out = []
  if (!fs.existsSync(MEM_DIR)) return out
  for (const f of fs.readdirSync(MEM_DIR).sort()) {
    if (!f.endsWith('.md')) continue
    const full = path.join(MEM_DIR, f)
    try {
      const text = fs.readFileSync(full, 'utf-8')
      const lines = text.split('\n')
      const title = (lines.find((l) => l.startsWith('# ')) || f).replace(/^#\s+/, '')
      const idx = lines.find((l) => l.includes('求助索引'))
      out.push({ file: 'memories/' + f, title, index: idx ? idx.replace(/^>\s*/, '').slice(0, 220) : '', bytes: text.length })
    } catch (_) { /* unreadable: skip */ }
  }
  return out
}

module.exports = {
  name: 'kix-mem',
  inject: ['tools'],
  apply(ctx) {
    const dispose = ctx.tools.register({
      name: 'experience',
      description: DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"list" (catalog) or "get" (one full note).' },
          name: { type: 'string', description: 'For get: file name, e.g. "verification-lessons.md".' },
        },
        additionalProperties: true,
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const action = (args && args.action) || 'list'
        if (action === 'list') {
          const entries = listEntries()
          return { ok: true, dir: MEM_DIR, count: entries.length, entries }
        }
        if (action === 'get') {
          const name = String((args && args.name) || '')
          const safe = path.basename(name)
          const full = path.join(MEM_DIR, safe)
          if (!full.startsWith(MEM_DIR) || !fs.existsSync(full)) {
            return { ok: false, error: 'no such note: ' + safe + ' (action=list to catalog)' }
          }
          return { ok: true, file: 'memories/' + safe, text: fs.readFileSync(full, 'utf-8') }
        }
        return { ok: false, error: 'unknown action ' + action }
      },
    })
    ctx.effect(() => dispose)
  },
}

module.exports.__internals = { listEntries, MEM_DIR }
