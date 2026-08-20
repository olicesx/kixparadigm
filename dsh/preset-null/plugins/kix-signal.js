// kix-signal — spec-draft 单信号（2026-08-18 三信号生；2026-08-19 两轮收敛仅存 S3）
//
// 出生证明（为什么存在）：
//   S3 spec-draft —— 门禁提醒合规 2/2 vs 模型自驱 13%：提醒通道已验证，但契约
//      五字段从零写是摩擦 → 提醒附带草稿模板，写作题变改错题。三信号中唯一
//      有对照证据支撑设计的信号（E2E：Windows 真宿主草稿注入成功）。
//
// 死亡证明（2026-08-19 两轮收敛，S1/S2 退役）：
//   S1 poll-guard —— 与宿主 repeat-tool-reminder 重叠（E2E 同场景双份齐射），
//      独占面（变参轮询）出生数据未分面统计，价值未证判退。
//   S2 orchestration-trigger（步数/跨仓库扇出提醒）—— 三层证据判退：
//      ① 与 kix-budget 重叠：streak@8 只读提醒（E2E 实证同会话齐射）+ 41 步
//         无计量硬 gate；步数触发器最常见触发面被 budget 早 32 步覆盖。
//      ② 历史重演：kixst 定时提醒 08-15 已减法移除（"恢复定时形态必须重估"）；
//         budget step gate 08-18 晚降为计量缺失 fallback——项目两次裁定步数
//         信号信噪比不划算，S2 未 cross-check 又引入第三次。
//      ③ 出生证据缺口：daes D2 正例（df9edb75）是模型自判触发而非计数器触发，
//         机械信号与正确触发时机的匹配度零数据；跨仓库信号是报告随口候选、
//         无分面统计；advisory 提升触发率本身无对照。
//      复活路径：tmp-zstd-analysis 复测口径若显示"步数/跨仓库超阈且 budget
//      未覆盖"的会话面真实存在，再带可证伪指标回来。
//
// 纪律（对照 kix-paradigm「规则是负债」）：
//   - 全部 advisory：只走 appendContexts 注入 user message，零 deny 零强制
//   - 每信号每会话最多提醒 1 次
//   - 独立文件：实验无收益时整文件退役（死亡证明预留，S1/S2 已先行示范）
//   - S3 与 kix-discipline 的 red-remind 同触发（首次源编辑无 spec）：
//     discipline 提醒一句 + 此处附草稿，各一次，语义互补可共存；
//     嫌吵可 config 去掉 specDraft 关掉草稿侧。
//
// 挂载（agent.cordis.yml）：
//   - id: kix-signal
//     name: ./plugins/kix-signal.js
//   config（可选）：
//     specDraft: true       // S3 开关（默认 true；false 显式关）

'use strict'

const lib = require('./consistency-lib.cjs')
const { randomUUID } = require('node:crypto')

// ── S3 源编辑分类（与 kix-discipline 同语义 + Go/Python/Rust 命名风格补充；
//    kix-discipline 的 TEST_FILE_PATTERNS 不覆盖 _test.go，此处从严）─────────
const NON_SOURCE_PATTERNS = [
  /(^|[\\/])(test|tests|__tests__|specs?)([\\/]|$)/i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /\.(test|spec)\.(py|rs|go|java|rb)$/i,
  /_test\.go$/i,
  /(^|[\\/])test_[^\\/]+\.(py|rs)$/i,
  /(^|\/)(docs?|notes?|examples?)(\/|$)/i,
  /\.md$/i,
]

function isSourcePath(p) {
  if (!p) return false
  const s = String(p)
  return !NON_SOURCE_PATTERNS.some((re) => re.test(s))
}

function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'kix-signal', form: 'notice', summary: text.slice(0, 100) },
  }
}

function stateFor(agent) {
  if (!agent) return undefined
  if (!agent.__kixSignal) {
    agent.__kixSignal = {
      specDraftReminded: false,
    }
  }
  return agent.__kixSignal
}

function specDraftText(targetPath, lastUserText) {
  const taskHint = lastUserText
    ? String(lastUserText).slice(0, 160).replace(/\s+/g, ' ')
    : '（从当前任务上下文补全）'
  return [
    'kix-signal: 检测到源编辑但无需求三检契约。草稿如下（按需修改后调用 kix_discipline_spec 落档；字面明确低风险可逆可忽略）：',
    '',
    '```',
    'goal: ' + taskHint,
    'xy: （用户字面要 X，真正需要的 Y 是——一句话）',
    'assumptions: （成立前提 1-2 条，可验证）',
    'path: （选定方案 + 为什么不是别的）',
    'acceptance: （完成判据：测试/gate/可复算数字）',
    'contract: 行为契约——必须不变：…；必须改变：…；必须成立：…；契约歧义/解读假设：…（有歧义先问，无法问则显式声明解读）',
    '```',
    '',
    '目标文件：' + targetPath,
  ].join('\n')
}

module.exports = {
  name: 'kix-signal',
  inject: ['tools', 'commands'],
  apply(ctx, config) {
    const tools = ctx.tools
    const commands = ctx.commands
    const cfg = config || {}
    const specDraftOn = cfg.specDraft !== false // 默认 true（2026-08-19 起默认接线）

    const disposeSignalTool = tools.register({
      name: 'kix_signal_status',
      description:
        '查看 kix-signal spec-draft 草稿信号当前会话状态（只读，调试用）',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const st = exec && exec.agent ? stateFor(exec.agent) : undefined
        if (!st) return { ok: false, error: 'no agent context' }
        return {
          ok: true,
          specDraft: { on: specDraftOn, reminded: st.specDraftReminded },
        }
      },
    })
    ctx.effect(() => disposeSignalTool)

    // ── pre-execute：S3 spec 草稿（源编辑 + 无 spec + 未提醒过）────────────
    ctx.on('tools/pre-execute', async (exec, next) => {
      const name = exec && exec.name
      const tool = (name || '').toLowerCase()
      const agent = exec && exec.agent
      const args = exec && (exec.arguments ?? exec.args)

      if (specDraftOn && (tool === 'edit' || tool === 'write')) {
        const st = agent ? stateFor(agent) : undefined
        const targetPath = args && (args.file_path || args.path)
        if (st && !st.specDraftReminded && isSourcePath(targetPath)) {
          st.specDraftReminded = true
          st.pendingDraft = String(targetPath || '')
          return next()
        }
      }
      return next()
    })

    // ── post-execute：S3 草稿注入（pendingDraft 在 pre-execute 标记）─────────
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const agent = exec && exec.agent
      const st = agent ? stateFor(agent) : undefined
      if (!st) return next()

      const notices = []

      if (st.pendingDraft) {
        const target = st.pendingDraft
        st.pendingDraft = ''
        let lastUserText
        try {
          const sessionQuery = ctx.get('sessionQuery')
          const sessionId = agent && agent.session && agent.session.id
          if (sessionQuery && sessionId) {
            const surface = await sessionQuery.readSurface(sessionId)
            lastUserText = lastUserTextFrom(surface)
          }
        } catch { /* 读不到就占位 */ }
        notices.push(makeUserMessage(specDraftText(target, lastUserText)))
      }

      if (notices.length === 0) return next()
      return lib.appendContexts(await next(), notices)
    })

    // ── /kixsig-check 用户命令：零 token 查看信号状态 ──────────────────────
    commands.register({
      name: 'kixsig-check',
      description: '查看 kix-signal spec-draft 草稿信号当前状态',
      // 无参命令：宿主 dsh-commands 契约 input 可选，省略即可（hint 不允许空串——
      // 2026-08-19 Windows 前台全挂根因：input: { hint: '' } 使整个 preset 挂载失败）
      async handler() {
        return 'kix-signal: 会话状态请经模型工具 kix_signal_status 查询（用户命令侧无 agent 上下文）。配置: specDraft=' + specDraftOn
      },
    })
  },
}

// 从会话表面取最近一条用户消息文本（模型可见的 user 消息，剥离系统注入）
function lastUserTextFrom(surface) {
  if (!surface || !Array.isArray(surface.events)) return undefined
  for (let i = surface.events.length - 1; i >= 0; i--) {
    const ev = surface.events[i]
    if (ev && ev.type === 'user/message' && ev.data && Array.isArray(ev.data.content)) {
      const text = ev.data.content
        .filter((c) => c && c.type === 'text')
        .map((c) => c.text)
        .join(' ')
        .trim()
      if (text && !text.startsWith('Current runtime') && !text.startsWith('<system-reminder>')) {
        return text
      }
    }
  }
  return undefined
}

module.exports.__internals = {
  isSourcePath,
  stateFor,
  specDraftText,
  lastUserTextFrom,
}
