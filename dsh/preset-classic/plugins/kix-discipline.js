// kix-discipline — kixparadigm 纪律机制化（P0，2026-08-16）
//
// 定位：把 kix 的「需求三检」与「验证 gate」从 prompt 说教（模型自觉）改为
// 机制强制（hook + 工具 + 持久契约）。设计哲学按 kix 自身裁剪，不照搬生态插件
// （dsh-doublecheck 等只取「门禁+工具+持久状态」的机制结构，不取其规则内容）：
//
//   - 补足非限制：只拦「动作」（edit/write 前的契约缺失、回合结束无验证），
//     不拦「思考」（需求三检的内容判断留给模型，spec 是契约不是审讯）。
//   - 限制越少越好：默认 intensity=remind（提醒不阻断）；ask/block 需显式配置。
//     字面明确、低风险、可逆的任务，模型看到提醒后可忽略直接执行（kix：直接执行）。
//   - 阶段二相性：创造阶段（编辑中）只提醒一次（remindOnce），不反复打断；
//     验证阶段（回合结束 turn-stopping）检查"有实现 edit 但无测试运行"。
//   - 规则是负债：任何 gate 若 2 轮内无真实拦截记录（remind 从未触发），降级 opt-in
//     或删除（见 PLUGINIZATION-ROADMAP.md §7）。
//
// 机制（对照 DSH-ADAPTATION.md §2 的 hook 等价物表）：
//   - tools/pre-execute waterfall：edit/write 前检查 spec 契约在档。
//       * 无 spec + 首次实现编辑 → intensity 决定 remind（放行+注入提醒）/
//         ask（聊天内提问 ctx.userQuestions.ask，同 kix-guards v5）/
//         block（deny 带 reason）。
//       * 测试文件（*.test.* / test 目录）永远放行——写测试是需求三检/red 步骤。
//   - tools/post-execute waterfall：识别测试运行（bash/pwsh 命令匹配测试模式）
//     → 记录 green；识别实现 edit → 记录 red 证据缺失。
//   - agent/turn-stopping serial：回合结束时，本回合有实现 edit 且无测试运行
//     → 注入 green 提醒（remindOnce，durable 于会话日志）。
//   - agent/turn-stopping serial（v2，2026-08-16 用户反馈）：模型终稿把直接
//     请求判为「不处理 / 在别处处理 / 系统信息不足」→ 弹问让用户裁决（接受 /
//     要求继续；每会话一次）。启发式 ask（非 deny）——0% 误报纪律只约束
//     阻断层，ask 的误报成本 = 一次可忽略的确认问题。
//   - kix_discipline_spec 工具：模型记录需求三检契约（goal/xy/assumptions/path/
//     acceptance 五字段，对应 kix 三检①XY ②前提 ③路径 + 目标 + 验收；可选
//     mode 字段 = 编曲留痕：成员组合 + 一句理由，2026-08-17），写入
//     工作区 kix-discipline/spec.md + 会话状态（spec 契约跨会话可查）。
//   - /kix-discipline 命令：status / report / on|off（durable 开关）。
//
// 边界诚实声明（P0）：
//   - 「模糊任务」判定为保守启发式：无 spec 的首次实现编辑即提醒一次。不做
//     任务文本语义分析（那是模型判断，机制不越界）；ask/block 档需显式配置。
//   - gate 按 agent scope 挂载，不覆盖子代理会话（与 kix-guards 同款边界，
//     见 DSH-ADAPTATION.md §9 已知限制①）。
//   - spec 文件写入工作区 kix-discipline/ 目录，遵循 fs 沙箱策略。
//
// 挂载：preset agent.cordis.yml 一行（与 kix-guards 同款相对路径）：
//   - id: kix-discipline
//     name: ./plugins/kix-discipline.js
// 测试：node plugins/kix-discipline.test.js（纯逻辑经 __internals 验证）。

'use strict'

const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')
const lib = require('./consistency-lib.cjs')

// ── 常量 ───────────────────────────────────────────────────────────────────
const SPEC_FILENAME = 'spec.md'
const SPEC_DIRNAME = 'kix-discipline'

// solo 挑战信号（v7 编曲保育 ②，2026-08-19）：goal+path 合并文本出现这些
// 语义时，mode=solo 视为可疑（需辩护理由或改组合）。保守取向——只收明确的
// 跨模块/多文件/独立验收词汇，措辞模糊不触发（宁可漏放，不可误拦）。
const SOLO_CHALLENGE_RES = [
  /跨模块|多文件|多个文件|多个模块|全部界面|所有模块/,
  /独立验证|独立验收|独立审查|独立复核/,
  /并修复|且修复|审计.*修复/,
  /\bdev\b.*\bqa\b|\bqa\b.*独立|验证关键/,
]

/** mode=solo 与任务信号一致性挑战；返回 undefined = 放行（含：mode 非 solo /
 *  二次提交含辩护理由 / 信号未命中）。挑战一次即放（retryAllowed）。 */
function soloModeChallenge(spec) {
  const mode = String((spec && spec.mode) || '')
  // 只挑战「solo」自评（含中文写法）；空 mode 走 persona 路由提醒，不在此拦
  if (!/solo|单线程|主线程独|自己干/i.test(mode)) return undefined
  const text = `${spec.goal || ''}\n${spec.path || ''}`
  if (!SOLO_CHALLENGE_RES.some((re) => re.test(text))) return undefined
  // mode 里已带辩护理由（括号/冒号/破折号后的说明）→ 二次提交，放行
  const rationale = mode.replace(/^[\w\u4e00-\u9fff]+\s*[（(:：—-]?\s*/, '')
  if (rationale.length >= 8 && !/^(solo|主线程|单线程)/i.test(rationale)) return undefined
  return [
    'kix-discipline: mode=solo 与任务信号不一致——goal/path 显示跨模块/多文件/独立验证语义，',
    'solo 的适用面是「字面明确、低风险、可逆」（如单文件修复）。两种解除方式：',
    '① 改 mode 为实际组合（如 "dev+qa：跨模块改动需独立验收"，成员经 kix_capability_call 直达）；',
    '② 确认 solo 后重交，并在 mode 里附一句辩护理由（如 "solo：改动实际只涉及单文件且已有 green 测试覆盖"）。',
  ].join('')
}

// 测试命令模式（bash/pwsh 文本匹配；与 kix-guards 的 KNOWN_SAFE 同层判断）
const TEST_COMMAND_PATTERNS = [
  /(?:^|[;&|]\s*)(?:(?:pnpm|npm|npx|yarn|bun)(?:\s+run)?\s+(?:test|vitest|jest|mocha)(?:\s|$))/,
  /(?:^|[;&|]\s*)(?:(?:pytest|go\s+test|cargo\s+test|make\s+test|ctest)(?:\s|$))/,
  /(?:^|[;&|]\s*)(?:node\s+--test(?:\s|$))/,
  /(?:^|[;&|]\s*)(?:deno\s+test|uv\s+run\s+pytest)(?:\s|$)/,
]
// 实现编辑工具（写测试文件永远放行）
const MUTATION_TOOLS = new Set(['edit', 'write'])
// 测试文件模式（这些路径的编辑不算"实现编辑"，不触发 red/green gate）
const TEST_FILE_PATTERNS = [
  /(^|[\\/])(tests?|__tests__|specs?)([\\/]|$)/,
  /\.[tj]sx?\.(test|spec)\.[a-z0-9]+$/i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /\.(test|spec)\.(py|rs|go|java|rb)$/i,
]
const OPERATIONAL_ARTIFACT_PATTERNS = [
  /(^|\/)tmp-analyze(\/|$)/i,
  /(^|\/)kix-discipline\/spec\.md$/i,
  /(^|\/)docs\/sprint-\d+\/(?:plan|progress|done|blockers?|qa-signoff)\.md$/i,
  /(^|\/)docs\/\.kixpower-current-sprint$/i,
]
const DOCUMENTATION_FILE_PATTERN = /\.(?:md|mdx|rst|adoc)$/i

// ── v2：回合结束「拒绝/转交」弹问（2026-08-16 用户反馈）────────────────────
// 模型把直接请求判为「不处理 / 在别处处理 / 系统信息不足」时，回合结束弹问
// 让用户裁决。启发式 ask（非 deny）：误报成本 = 一次可忽略的确认问题，且每
// 会话只弹一次；readSurface 不可用/失败静默跳过（可选项）。
const DEFLECTION_MARKERS = [
  /不处理|不在(?:本次|我的)?(?:范围|职责)|在别(?:的)?地方处理|另开(?:会话|任务|议题)|转交(?:给)?(?:其他|别人)|超出(?:我的|本会话)?(?:范围|职责)/,
  /系统信息不足|信息不足/,
  /\bwon'?t\s+(?:handle|fix|do|process)|not\s+(?:in|within)\s+(?:my\s+|the\s+)?(?:scope|responsibility|purview)|handled\s+elsewhere|out\s+of\s+scope|defer(?:red)?\s+(?:to|elsewhere)\b|insufficient\s+(?:system\s+)?information/i,
]
function isDeflection(text) {
  return DEFLECTION_MARKERS.some((re) => re.test(String(text || '')))
}
const DEFLECTION_ASK_TEXT = 'kix-discipline: 本回合模型答复将任务判定为「不处理 / 在别处处理 / 信息不足」。若接受请回复「接受」；否则请说明要求，模型将据此继续处理。'
// 从会话表面（SessionSurfaceSnapshot.events，model-history 序）取最近一条
// assistant 消息文本（只取 text 块；形状不符/无文本返回 undefined）。
function lastAssistantText(surface) {
  if (!surface || !Array.isArray(surface.events)) return undefined
  for (let i = surface.events.length - 1; i >= 0; i--) {
    const ev = surface.events[i]
    if (ev && ev.type === 'assistant/message' && ev.data && ev.data.message) {
      const content = ev.data.message.content
      if (Array.isArray(content)) {
        const text = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
        if (text) return text
      }
      return undefined
    }
  }
  return undefined
}

// ── 纯判定函数（模块级：单元测试经 __internals 直接验证）─────────────────

function isTestCommand(text) {
  return TEST_COMMAND_PATTERNS.some((re) => re.test(String(text || '')))
}

function normalizeFilePath(path) {
  return String(path || '').replace(/\\/g, '/')
}

function isTestFile(path) {
  const p = normalizeFilePath(path)
  return TEST_FILE_PATTERNS.some((re) => re.test(p))
}

function classifyMutationPath(path) {
  const p = normalizeFilePath(path)
  if (isTestFile(p)) return 'test'
  if (OPERATIONAL_ARTIFACT_PATTERNS.some((re) => re.test(p))) return 'artifact'
  if (DOCUMENTATION_FILE_PATTERN.test(p)) return 'documentation'
  return 'source'
}

function isMutationTool(name) {
  return MUTATION_TOOLS.has(String(name || '').toLowerCase())
}

// spec 契约 markdown 生成（五字段对应 kix 三检 + 目标 + 验收）
function renderSpec(spec) {
  const s = spec || {}
  return [
    '# kix-discipline spec（需求三检契约）',
    '',
    '- 记录时间: ' + (s.recordedAt || new Date().toISOString()),
    '',
    '## Goal（要解决的根本问题）',
    s.goal || '（未填写）',
    '',
    '## XY 检查（需求三检①：要 X 真需要的是 Y？）',
    s.xy || '（未填写）',
    '',
    '## 前提假设（需求三检②：前提可验证吗？）',
    s.assumptions || '（未填写）',
    '',
    '## 更优路径（需求三检③：有更高维度解法吗？）',
    s.path || '（未填写）',
    '',
    '## 验收标准（可验证的完成定义）',
    s.acceptance || '（未填写）',
    '',
    '## 执行模式（编曲留痕：成员组合 + 一句理由）',
    s.mode && s.mode.trim().length > 0 ? s.mode : '（未记录——solo 或未触发组合）',
    '',
  ].join('\n')
}

// spec 契约五字段是否齐全（空/空白字段视为未完成——契约必须可验证才算数）
function specComplete(spec) {
  const s = spec || {}
  return ['goal', 'xy', 'assumptions', 'path', 'acceptance'].every(
    (k) => typeof s[k] === 'string' && s[k].trim().length > 0,
  )
}

// 从 markdown 反向解析 spec（读已有文件时用；宽松：缺字段返回 undefined）
// 2026-08-17（mode 字段引入暴露）：标题按字面构造 RegExp，ASCII 元字符
//（如「成员组合 + 一句理由」的 +）会改变匹配语义 → grab 空转返回
// undefined。escapeRe 按字面转义；既有标题无元字符，行为不变。
function parseSpec(text) {
  if (!text) return undefined
  const m = /^# kix-discipline spec/m.test(text)
  if (!m) return undefined
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const grab = (title) => {
    const re = new RegExp(`## ${escapeRe(title)}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n## |\\n\\n- 记录时间|$)`)
    const hit = re.exec(text)
    if (!hit) return undefined
    const v = hit[1].trim()
    return v.length > 0 ? v : undefined
  }
  // mode 为空时 renderSpec 写占位文案（spec.md 留可见槽位）；回读时把占位
  // 映射回 undefined，防止「未记录」假值混进契约（2026-08-17）。
  const MODE_PLACEHOLDER = '（未记录——solo 或未触发组合）'
  const modeVal = grab('执行模式（编曲留痕：成员组合 + 一句理由）')
  return {
    recordedAt: undefined,
    goal: grab('Goal（要解决的根本问题）'),
    xy: grab('XY 检查（需求三检①：要 X 真需要的是 Y？）'),
    assumptions: grab('前提假设（需求三检②：前提可验证吗？）'),
    path: grab('更优路径（需求三检③：有更高维度解法吗？）'),
    acceptance: grab('验收标准（可验证的完成定义）'),
    mode: modeVal === MODE_PLACEHOLDER ? undefined : modeVal,
  }
}

// 会话状态折叠（durable：从 spec 文件 + 会话内内存恢复）
// io：可选读写器 { readText(path), writeText(path, content) } —— apply 注入 ctx.fs
// （走 DSH 文件系统服务，经沙箱策略与 fs/write-intent 门禁），默认 node:fs 同步（测试用）。
function makeState({ sessionKey, workspaceRoot, io }) {
  const specFile = workspaceRoot ? join(workspaceRoot, SPEC_DIRNAME, SPEC_FILENAME) : undefined
  let cached = undefined
  let specLoaded = false
  let loadPromise = undefined
  return {
    specFile,
    enabled: true,
    remindOnce: true,
    redReminded: false,
    greenReminded: false,
    // 本回合（turn）内的实现编辑与测试运行计数——turn 边界重置
    turnEdits: 0,
    turnTests: 0,
    spec: undefined,
    async loadSpec() {
      // 2026-08-16（审查修复，spec 加载竞态）：eager 调用（fire-and-forget）
      // 与门禁调用共享同一个 in-flight promise——旧实现 specLoaded latch
      // 在 eager 未完成时即置位，门禁随后调用 loadSpec 立即返回 cached
      // （undefined），首编辑被「假性无 spec」误判（remind 烧掉唯一提醒 /
      // ask、block 误拒绝）。
      if (specLoaded) return loadPromise || cached
      specLoaded = true
      loadPromise = (async () => {
        if (specFile) {
          try {
            const text = io && io.readText ? await io.readText(specFile) : readFileSync(specFile, 'utf8')
            const parsed = parseSpec(text)
            if (parsed && specComplete(parsed)) cached = parsed
          } catch { cached = undefined }
        }
        return cached
      })()
      try { return await loadPromise }
      finally { loadPromise = undefined }
    },
    async saveSpec(spec) {
      if (loadPromise !== undefined) {
        try { await loadPromise } catch {}
      }
      cached = spec
      if (!specFile) return false
      try {
        if (io && io.writeText) {
          await io.writeText(specFile, renderSpec(spec))
        } else {
          mkdirSync(join(workspaceRoot, SPEC_DIRNAME), { recursive: true })
          writeFileSync(specFile, renderSpec(spec), 'utf8')
        }
        return true
      } catch {
        return false
      }
    },
  }
}

function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'kix-discipline', form: 'notice', summary: text.slice(0, 100) },
  }
}

module.exports = {
  name: 'kix-discipline',
  inject: ['tools', 'commands'],
  apply(ctx, config) {
    const tools = ctx.tools
    const commands = ctx.commands
    const cfg = config || {}
    const intensity = cfg.intensity || 'remind'
    const sandboxPolicy = ctx.get('sandboxPolicy')

    // ctx.fs 是 DSH 文件系统服务（经沙箱策略 + fs/write-intent 门禁）。可用时 spec 读写
    // 走 ctx.fs（深度融合，写入路径受沙箱约束）；缺失时降级 node:fs（跨环境不挂）。
    const dshFs = ctx.get('fs')
    const fsIo = dshFs !== undefined
      ? {
          async readText(path) {
            const target = await dshFs.resolve(path)
            return dshFs.readText(target)
          },
          async writeText(path, content) {
            const target = await dshFs.resolve(path)
            await dshFs.writeText(target, content, undefined, undefined, sandboxPolicy && sandboxPolicy.resolve ? sandboxPolicy.resolve({ mode: 'workspace-write' }) : undefined)
          },
        }
      : undefined

    // 每会话状态（key = agent session id；跨会话 durable 于 spec 文件）
    const states = new Map()
    function stateFor(agent) {
      const key = agent && agent.id ? String(agent.id) : 'anonymous'
      let st = states.get(key)
      if (!st) {
        const workspaceRoot = lib.resolveWorkspaceRoot(agent, sandboxPolicy) || undefined
        st = makeState({ sessionKey: key, workspaceRoot, io: fsIo })
        st.loadSpec().catch(() => { /* 缓存填充失败静默：后续 loadSpec 重试或降级 */ })
        states.set(key, st)
      }
      return st
    }

    // 聊天内提问（同 kix-guards v5：userQuestions.ask，fail-safe 拒绝）
    async function askUser(exec, reason) {
      const userQuestions = ctx.get('userQuestions')
      if (userQuestions === void 0 || exec === void 0 || exec.agent === void 0) return undefined
      try {
        const { answers } = await userQuestions.ask({
          questions: [{
            id: 'kix-discipline-confirm',
            question: reason,
            header: 'kix-discipline 确认',
            options: [
              { label: '先记录需求三检契约', description: '调用 kix_discipline_spec 后再继续。' },
              { label: '任务明确，直接继续', description: '字面明确低风险可逆，按 kix 直接执行。' },
            ],
          }],
          agent: exec.agent,
          ...exec.signal !== void 0 ? { signal: exec.signal } : {},
        })
        const selected = answers && answers[0] && answers[0].selected
        return Array.isArray(selected) && selected.includes('任务明确，直接继续')
      } catch {
        return undefined
      }
    }

    // ── 模型工具：记录需求三检契约 ────────────────────────────────────────
    const disposeSpecTool = tools.register({
      name: 'kix_discipline_spec',
      description: '记录需求三检契约（XY Problem / 前提假设 / 更优路径）到工作区 kix-discipline/spec.md。需求三检后、编辑前调用；跨会话复用。mode（可选）= 编曲留痕：成员组合+一句理由，如 "dev+qa：跨模块改动需独立验收" / "solo：字面明确单文件修复"。',
      parameters: {
        // tools.register 原样投影 parameters：必须含顶层 type: 'object'
        type: 'object',
        properties: {
          goal: { type: 'string', description: '要解决的根本问题（需求三检①：用户要 X 真需要的是 Y）' },
          xy: { type: 'string', description: 'XY 检查结论：确认了真正要解决的问题' },
          assumptions: { type: 'string', description: '前提假设（需求三检②）：需求成立的前提可验证吗' },
          path: { type: 'string', description: '更优路径（需求三检③）：选定的方案与理由' },
          acceptance: { type: 'string', description: '验收标准：可验证的完成定义（测试/gate 判据）' },
          mode: { type: 'string', description: '执行模式（编曲留痕，可选）：成员组合 + 一句理由——本单用了谁（solo/观察者/dev/qa/reviewer 组合）、为什么。命中路由信号组队时随契约一并记录' },
        },
        required: ['goal', 'xy', 'assumptions', 'path', 'acceptance'],
      },
      output: {
        // output.schema 是 JsonSchemaNode：object 需 properties
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const spec = {
          recordedAt: new Date().toISOString(),
          goal: String((args && args.goal) || '').trim(),
          xy: String((args && args.xy) || '').trim(),
          assumptions: String((args && args.assumptions) || '').trim(),
          path: String((args && args.path) || '').trim(),
          acceptance: String((args && args.acceptance) || '').trim(),
          // mode 可选（编曲留痕）：空 = solo/未组合，不进完整性判定的必填集
          mode: String((args && args.mode) || '').trim(),
        }
        const complete = specComplete(spec)
        if (!complete) {
          return { ok: false, error: 'spec 契约不完整：goal/xy/assumptions/path/acceptance 五字段均必填（需求三检必须全部落定才算契约）。' }
        }
        // v7 编曲保育 ②（2026-08-19 实测修正）：mode=solo 与任务信号一致性挑战。
        // 实测（b2da1f02）：跨模块+验证关键任务自评 solo，103 步零分派零编曲决策——
        // mode 自评失真是组队召回率的最后一公里断点。挑战补足非限制：信号不匹配时
        // 拒绝本次落档并说明理由（模型要么改 mode 要么给 solo 辩护理由，二次提交放行），
        // 不拦思考、不替代成员选择。信号判定保守：goal/path 里出现明确的跨模块/
        // 多文件/独立验证语义才触发；纯措辞模糊不算。
        const challenge = soloModeChallenge(spec)
        if (challenge) {
          return { ok: false, error: challenge, retryAllowed: true }
        }
        const agent = exec && exec.agent
        const st = stateFor(agent)
        const saved = await st.saveSpec(spec)
        return { ok: true, saved, specFile: st.specFile || null, contract: spec }
      },
    })
    ctx.effect(() => disposeSpecTool)

    // ── pre-execute：spec 契约门禁 + red 证据记录 ─────────────────────────
    ctx.on('tools/pre-execute', async (exec, next) => {
      const name = exec && exec.name
      const tool = (name || '').toLowerCase()
      const args = exec && (exec.arguments ?? exec.args)
      const agent = exec && exec.agent

      // 只关心实现编辑工具；非编辑工具（含测试命令）直接放行。
      // 2026-08-16（审查修复，turnTests 双重计数）：pre-execute 不再对测试
      // 命令 +1——命令尚未执行，成功/被拦/失败都未知；green 证据只在
      // post-execute 对「成功结果」计数（被门禁/sandbox 拦截或失败的测试
      // 不构成证据，turn-stopping 会据此提醒）。
      if (!isMutationTool(tool)) {
        return next()
      }

      const st = stateFor(agent)
      if (!st.enabled) return next()

      // 只有 source 编辑进入需求三检和 green gate。测试、文档与操作性工件
      // 各有自己的验证语义，不能伪装成“实现编辑未测试”。
      const path = args && (args.file_path || args.path)
      if (classifyMutationPath(path) !== 'source') return next()

      st.turnEdits++

      // spec 契约检查：无 spec + 首次实现编辑 → intensity 决定
      const spec = st.spec || (await st.loadSpec())
      if (spec) return next()

      const reason = 'kix-discipline: 该编辑前未记录需求三检契约（kix_discipline_spec）。先调用 kix_discipline_spec 落定 goal/xy/assumptions/path/acceptance，或确认任务字面明确低风险可逆后直接继续。'

      if (intensity === 'block') {
        return { kind: 'deny', reason }
      }
      if (intensity === 'ask') {
        const ok = await askUser(exec, reason)
        if (ok === false) return { kind: 'deny', reason: 'kix-discipline: 用户拒绝（未确认任务明确），请先记录需求三检契约。' }
        if (ok === void 0) return { kind: 'deny', reason: 'kix-discipline: 无法向用户提问（无提问通道），已自动拒绝。' }
        return next()
      }
      // remind：放行 + 注入提醒（每会话一次）
      if (st.remindOnce && st.redReminded) return next()
      st.redReminded = true
      // post-execute 注入（见下）；此处仅记录待注入标志
      st.pendingRemind = true
      return next()
    })

    // ── post-execute：注入 remind + green 证据记录 ────────────────────────
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const name = exec && exec.name
      const tool = (name || '').toLowerCase()
      const agent = exec && exec.agent
      const st = agent ? stateFor(agent) : undefined

      if (!st || !st.enabled) return next()

      // 测试运行结果：成功 → green 证据（回合内）
      const args = exec && (exec.arguments ?? exec.args)
      const cmdText = args && (args.command || args.cmd)
      if (typeof cmdText === 'string' && isTestCommand(cmdText)) {
        const ok = result && !result.isError
        if (ok) st.turnTests++
        return next()
      }

      // 待注入的 red remind（合并注入：await next() 后并 contexts——裸返回
      // 会短路瀑布饿死后挂载的监听器，WSL2 实弹实锤首写提醒因此丢失）
      if (st.pendingRemind) {
        st.pendingRemind = false
        const reason = 'kix-discipline: 本次编辑前未记录需求三检契约。若任务模糊或影响面大，请先调用 kix_discipline_spec 记录 goal/xy/assumptions/path/acceptance；字面明确低风险可逆的任务可忽略本提醒直接继续（kix 需求三检只按信号触发，不强制）。'
        return lib.appendContexts(await next(), [makeUserMessage(reason)])
      }
      return next()
    })

    // ── turn-stopping：回合结束 green 提醒 + 拒绝/转交弹问（v2）──────────
    ctx.on('agent/turn-stopping', async (payload) => {
      const agent = payload && payload.agent
      if (!agent) return
      const st = stateFor(agent)
      if (!st.enabled) return
      // 回合边界重置
      const hadEdits = st.turnEdits > 0
      const hadTests = st.turnTests > 0
      st.turnEdits = 0
      st.turnTests = 0
      // green gate：有实现 edit 无测试运行 → 提醒（原逻辑）
      if (hadEdits && !hadTests) {
        if (!(st.remindOnce && st.greenReminded)) {
          st.greenReminded = true
          const reason = 'kix-discipline: 本回合有实现编辑，但测试未通过或未运行（turnTests 只计成功结果——被拦/失败的测试不构成 green 证据）。交付前验证三问：① 测试镜像真实链路吗 ② 证据维度对吗 ③ 关键 claim 独立验证过吗。运行相关测试后再声称完成（kix 提交前必跑 lint/test）。'
          agent.steer(makeUserMessage(reason))
        }
      }
      // v2（用户反馈）：模型终稿把直接请求判为「不处理/在别处处理/信息不足」
      // → 弹问让用户裁决（每会话一次；本回合做过实现编辑不算拒绝）。
      // 启发式 ask（非 deny）：误报成本 = 一次可忽略的确认问题；readSurface
      // 缺失/失败静默跳过（可选项，不阻断）。
      if (!st.deflectionAsked && !hadEdits) {
        const sessionQuery = ctx.get('sessionQuery')
        const sessionId = agent && agent.session && agent.session.id
        if (sessionQuery && sessionId) {
          try {
            const surface = await sessionQuery.readSurface(sessionId)
            const text = lastAssistantText(surface)
            if (text && isDeflection(text)) {
              st.deflectionAsked = true
              agent.steer(makeUserMessage(DEFLECTION_ASK_TEXT))
            }
          } catch { /* 表面读取失败静默：弹问是可选项 */ }
        }
      }
    })

    // ── /kix-discipline 命令 ──────────────────────────────────────────────
    commands.register({
      name: 'kix-discipline',
      description: 'kix 纪律机制状态：status（开关/gate 强度/spec 契约）/ report（本会话纪律事实）/ on|off（durable 开关）',
      input: { hint: 'status | report | on | off' },
      handler: async ({ agent, rawInput }) => {
        const st = agent ? stateFor(agent) : undefined
        const arg = (rawInput || '').trim().toLowerCase()
        if (!st) return { kind: 'error', text: 'kix-discipline: 无可用 agent 上下文。' }
        if (arg === 'on' || arg === 'off') {
          st.enabled = arg === 'on'
          return { kind: 'success', text: `kix-discipline: 已${arg === 'on' ? '启用' : '停用'}（本会话）` }
        }
        const spec = st.spec || (await st.loadSpec())
        const specLine = spec && specComplete(spec)
          ? '✔ 已记录（' + spec.goal.slice(0, 60) + '…）'
          : '✘ 未记录需求三检契约'
        const base = [
          'kix-discipline status @ ' + new Date().toISOString(),
          'enabled: ' + st.enabled,
          'intensity: ' + intensity,
          'spec: ' + specLine,
          'redReminded: ' + st.redReminded + ' / greenReminded: ' + st.greenReminded,
          'turnEdits: ' + st.turnEdits + ' / turnTests: ' + st.turnTests,
        ]
        if (arg === 'report') {
          base.push('specFile: ' + (st.specFile || '（无工作区根，仅会话内存）'))
        }
        return { kind: 'success', text: base.join('\n') }
      },
    })

    ctx.logger?.info?.('[kix-discipline] 纪律门禁已挂载（pre-execute spec gate + turn-stopping green gate + kix_discipline_spec 工具）')
  },
}

module.exports.__internals = {
  isTestCommand,
  isTestFile,
  classifyMutationPath,
  isMutationTool,
  specComplete,
  renderSpec,
  parseSpec,
  soloModeChallenge,
  makeState,
  isDeflection,
  lastAssistantText,
  DEFLECTION_ASK_TEXT,
  DEFLECTION_MARKERS,
  TEST_COMMAND_PATTERNS,
  TEST_FILE_PATTERNS,
  OPERATIONAL_ARTIFACT_PATTERNS,
  DOCUMENTATION_FILE_PATTERN,
  SPEC_FILENAME,
  SPEC_DIRNAME,
}
