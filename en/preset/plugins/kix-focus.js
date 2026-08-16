// kix-focus — kixparadigm 极简 + 渐进披露 + PTC 协同（2026-08-16）
//
// 三层递进架构的实现载体（设计见 PLUGINIZATION-ROADMAP.md §8）：
//
//   Phase 1 — 常驻裁剪：tools.restrict 把模型每轮可见的工具从 85 个（~108KB
//     schema JSON）裁到常驻核心集。裁剪只影响"模型可见/可直呼"的继承全局
//     工具，scope 内注册的工具（门禁插件等）不受影响；restrict 后的工具仍
//     可被代理调用（见 Phase 2）。2026-08-16 实测修正：web/preset 架构下
//     基础工具全在 scope 层，全局层只剩宿主 MCP——allow 模式过滤后为空而
//     fail（MCP 全可见），改用 **deny 模式**（动态收集 mcp__* 全局工具名
//     移除）。
//   Phase 2 — 渐进披露：kix_capability_search 返回被裁剪工具的元数据
//     （名字/用途/参数摘要，不含全 schema —— 每轮不占上下文）；
//     kix_capability_call 代理执行目标工具（经 ctx.tools.execute，走完整
//     pre-execute→guards→execute→post-execute 管线，门禁依然拦截）。
//   Phase 3 — PTC 协同：保持 tool-presentation mode:both（native 直呼验证 +
//     run_code 机械多步），kix 红线「验证/观察用 native 直呼」不变；
//     kix_capability_call 同样可被 run_code 的 SDK 子分派调用（子分派过门禁）。
//
// 感知：模型直接调用被裁剪工具时（工具已 restrict 掉，正常应 UNKNOWN_TOOL），
//   若仍在工具目录中（如 MCP 注册的工具被 restrict 隐藏），本插件的 pre-execute
//   监听器返回引导：提示用 kix_capability_search/call 按需获取。
//
// 边界与诚实声明：
//   - restrict 是"模型可见面"裁剪，不是"可执行面"——代理调用仍能执行被裁剪
//     工具（这正是渐进披露的语义：能力在，schema 不常驻）。
//   - 常驻核心集 = 三通道执行/观察/交互必需 + 发现入口；其余按需。
//   - MCP 工具（GitHub/Playwright/Context7/Semgrep）schema 大且低频 → 全部按需。
//   - cordis_*（宿主平面注册的全局工具）→ 按需代理。
//   - scope 重型编排（workflow/goal）：restrict 裁剪不到（自动可见）。
//     2026-08-16：workflow 临时启用（自发使用测试中，测试后按「规则是负债」
//     决定去留；依赖 workflowEngine isolate realm，动态激活不可用，唯一
//     启用路径 = 取消 disabled 重启）；goal 默认 disabled + 按需激活
//     （kix_tool_activate 运行时 ctx.plugin 挂载，下一轮直呼；实测闭环）。
//     ralph 已移除（极低频 + 可替代，负债判定，2026-08-16）。job_*/subagent
//     -control 是范式日常路径 → 保留挂载并纳入语义常驻集。
//
// 挂载：agent.cordis.yml 一行（同款相对路径）：
//   - id: kix-focus
//     name: ./plugins/kix-focus.js
// 测试：node plugins/kix-focus.test.js

'use strict'

const { randomUUID } = require('node:crypto')

// ── 常驻核心集（每轮模型可见）────────────────────────────────────────────
// 三通道：执行（edit/write/pwsh/read/grep/glob）、观察（subagent 五档）、
// 交互（ask_user_question/todo_write/skill/web_search）、发现（kix_capability_*）。
//
// 注意 DSH restrict 契约：allow 列表只能含"全局工具名"，scope 内注册的工具
// （kix 的 subagent 五档、kix_capability_*、门禁插件工具）不受 restrict 影响、
// 自动可见，列入 allow 反而会 fail。所以 RESTRICT_ALLOW 只列全局工具；
// RESIDENT_TOOLS 是"常驻语义全集"（含 scope 工具，用于 search/感知判断）。
// 2026-08-15 实测（workflow 7 路并行审计）：workflow/goal/job_* 等
// preset 行注册的编排工具同为 scope-local —— restrict 裁剪不到、对模型
// 自动可见、可直接调用，无需经 capability_call 代理（全局视图查不到
// scope-local 名，代理反而失败）。故 SCOPE_RESIDENT 把它们纳入语义常驻集，
// 目录/统计口径与实际可见面一致；capability_call 对它们拒绝（"请直接调用"）。
// RESTRICT_ALLOW 是 allow 时代的白名单（现改用 deny 模式）；保留作统计/文档。
// 2026-08-16：web_search 低频（库文档已由 context7 MCP 承担）→ 移出常驻，
// 加入 deny 清单（经 capability_call 代理）。
const RESTRICT_ALLOW = [
  // 全局基础工具（host 平面注册）
  'edit', 'write', 'read', 'grep', 'glob', 'pwsh', 'bash',
  'ask_user_question', 'todo_write', 'skill',
]

// scope 注册、自动可见（restrict 裁剪不到）的编排/后台/控制工具
// 2026-08-15 精简：workflow/goal 低频重型 → 默认 disabled（主 agent 工具面
// 只留范式必需；restrict 裁不到 scope 工具，disabled 是唯一精简手段）。
// 2026-08-16：workflow 临时启用（自发使用测试）；ralph 移除。
// 2026-08-16 渐进面（方案 A，用户拍板）：subagent_lite/thinker/vision/fork
// 与 tool-jobs 默认 disabled + 按需激活（inject 宿主服务，动态挂载可行，
// 与 goal 同机制）。此处只列仍挂载的 scope 工具。
const SCOPE_RESIDENT = [
  // plan mode realm（挂载，先规划用 plan mode）
  'exit_plan_mode',
  // tool-subagent-control（挂载：三通道观察者管理）
  'list_agents', 'send_message', 'interrupt_agent',
]

// 常驻语义全集 = RESTRICT_ALLOW + scope 注册的观察/发现/编排工具（自动可见）
const RESIDENT_TOOLS = new Set([
  ...RESTRICT_ALLOW,
  // scope 注册（delegation group 的 subagent 核心两档 + 本插件发现入口）
  'subagent', 'subagent_cross',
  // workflow 已挂载（2026-08-16 临时启用,自发使用测试中）
  'workflow',
  'kix_capability_search', 'kix_capability_call',
  ...SCOPE_RESIDENT,
])

// ── 按需披露类别（kix_capability_search 的返回分组）───────────────────────
const CAPABILITY_GROUPS = [
  {
    id: 'github',
    title: 'GitHub MCP（Issue/PR/仓库/审查）',
    hint: '用 kix_capability_call 代理调用 mcp__github__* 工具',
    tools: ['mcp__github__'],
  },
  {
    id: 'playwright',
    title: 'Playwright 浏览器自动化（导航/快照/点击/截图）',
    hint: '用 kix_capability_call 代理调用 mcp__playwright__browser_* 工具',
    tools: ['mcp__playwright__'],
  },
  {
    id: 'context7',
    title: 'Context7 库文档（实时 API 查询）',
    hint: '用 kix_capability_call 代理调用 mcp__context7__* 工具',
    tools: ['mcp__context7__'],
  },
  {
    id: 'semgrep',
    title: 'Semgrep 代码安全扫描',
    hint: '用 kix_capability_call 代理调用 mcp__semgrep__* 工具',
    tools: ['mcp__semgrep__'],
  },
  {
    id: 'orchestration',
    title: '重型编排（workflow/goal）',
    hint: 'workflow 已挂载（直接可用，批量扇出/多阶段编排）；goal 默认未挂载，可按需激活（kix_tool_activate，下一轮直呼，kix_tool_deactivate 卸载）',
    tools: ['workflow', 'create_goal', 'update_goal', 'get_goal', 'exit_plan_mode'],
  },
  {
    id: 'subagent-tiers',
    title: '子代理细分档位（lite/thinker/vision/fork/reviewer/qa/dev）',
    hint: '默认未挂载（渐进面），按需激活：kix_tool_activate { tool: subagent_lite } 等；reviewer = 反方辩护三层只读审查（结论发布前对抗检查）；qa = Ivy 验收+签署（不写业务源码、证据门禁、signoff 工件）；dev = Nova/Sage/Milo 三合一编码（按 plan、target_rules 内写、不替 QA 签署）——qa/dev/reviewer 即编曲成员菜单',
    tools: ['subagent_lite', 'subagent_thinker', 'subagent_vision', 'subagent_fork', 'subagent_reviewer', 'subagent_qa', 'subagent_dev'],
  },
  {
    id: 'jobs',
    title: '后台任务（job_output/job_list/job_kill）',
    hint: '默认未挂载（渐进面），按需激活：kix_tool_activate { tool: jobs }，激活后下一轮直呼；长任务仍可 pwsh run_in_background 启动',
    tools: ['job_output', 'job_list', 'job_kill'],
  },
  {
    id: 'subagent-control',
    title: '子代理控制（list_agents/send_message/interrupt_agent）',
    hint: 'scope 常驻、可直接调用：查看/续话/中断已派子代理',
    tools: ['list_agents', 'send_message', 'interrupt_agent'],
  },
  {
    id: 'cordis',
    title: '动态插件（cordis_define/run/stop/undefine/inspect）',
    hint: '插件开发时用 kix_capability_call 代理调用 cordis_* 工具',
    tools: ['cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine', 'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self'],
  },
  {
    id: 'search',
    title: '网络搜索（web_search）',
    hint: '低频（库文档优先 context7 MCP），默认按需：用 kix_capability_call 代理调用 web_search',
    tools: ['web_search'],
  },
  {
    id: 'vision',
    title: '识图（read_image / subagent_vision）',
    hint: '主模型无视觉时用 subagent_vision（默认未挂载，kix_tool_activate { tool: subagent_vision } 激活）；read_image 按需',
    tools: ['read_image', 'subagent_vision'],
  },
]

// ── 长尾 fallback 组（2026-08-17 决策：发现面补兜底，不建动态分组系统）──
// 未被任何 CAPABILITY_GROUPS 覆盖、且不在常驻集的按需工具（新装的非
// mcp__* 命名空间全局工具、未归类全局/scope 工具等长尾），由
// searchCapabilities 自动归入此组——保证「能力存在即目录可达」的装即达语义。
// 只动态列成员（toolCount/exampleTools 实时），不做语义分组：title/hint 是
// 设计决策，schema 推不出来；全动态分组 = 过度工程（为低频长尾建推导系统）。
const FALLBACK_GROUP = {
  id: 'other',
  title: '其他按需工具（长尾/新命名空间）',
  hint: '未归类按需工具（全局工具用 kix_capability_call 代理调用，scope 工具可直接调用）；希望常驻可在 kix-focus 配置 extraResidentTools 追加',
  tools: [], // 动态：searchCapabilities 按实际未覆盖成员填充
}

// 纯函数：判断工具是否按需（不在常驻集）
function isOnDemand(name) {
  if (RESIDENT_TOOLS.has(name)) return false
  return true
}

// 纯函数：把一组工具 schema 投影为轻量元数据（名字/描述/参数名，不含全 schema）
function projectToolMeta(schemas, nameFilter) {
  return schemas
    .filter((s) => s && s.name && (!nameFilter || String(s.name).includes(nameFilter)))
    .map((s) => ({
      name: s.name,
      description: String(s.description || '').slice(0, 140),
      parameters: s.parameters && s.parameters.properties ? Object.keys(s.parameters.properties) : [],
    }))
}

// 纯函数：query 命中的具体工具元数据（每组上限 5；空 query 不投影 = 目录浏览模式）
// 2026-08-17：旧实现 projectToolMeta 存在但未接入 search —— 模型知道工具名
// 却不知道必填参数（外部审查 5.6 指出）。参数名进结果，完整 schema 仍由
// capability_call 的管线校验（渐进披露语义不破坏）。
function matchedToolMeta(members, q) {
  if (q === '') return {}
  const hits = projectToolMeta(members, q).slice(0, 5)
  return hits.length > 0 ? { matchedTools: hits } : {}
}

// 纯函数：按查询词在能力组里检索
// 2026-08-17（外部审查 5.6 发现 + 修复）：query 命中具体工具时附带该工具的
// 轻量元数据（名字/描述截断/参数名，来自 projectToolMeta）——旧实现只回组
// 级 exampleTools 名单，模型知道工具名却不知道必填参数，浪费一轮试错。
// 成本控制：仅 query 非空时投影（空 query = 全目录浏览，不投影）；每组上限
// 5 个命中（元数据按需披露的语义：先看参数名，完整 schema 调用时由管线校验）。
function searchCapabilities(schemas, query) {
  const q = String(query || '').toLowerCase().trim()
  const results = []
  for (const group of CAPABILITY_GROUPS) {
    const matched = group.tools.filter((t) => {
      if (t.endsWith('__')) return true // 前缀组（MCP 命名空间）
      return q === '' || t.toLowerCase().includes(q)
    })
    // 前缀组：query 非空时按名称匹配具体工具
    if (group.tools.some((t) => t.endsWith('__'))) {
      const prefix = group.tools[0]
      if (q !== '' && !schemas.some((s) => s.name && s.name.startsWith(prefix) && s.name.toLowerCase().includes(q))) {
        continue
      }
      const members = schemas.filter((s) => s.name && s.name.startsWith(prefix))
      if (members.length === 0 && q === '') continue
      results.push({
        id: group.id,
        title: group.title,
        hint: group.hint,
        toolCount: members.length,
        exampleTools: members.slice(0, 3).map((m) => m.name),
        tools: group.tools[0],
        ...matchedToolMeta(members, q),
      })
      continue
    }
    if (matched.length > 0 || q === '') {
      const members = schemas.filter((s) => s.name && group.tools.includes(s.name))
      results.push({
        id: group.id,
        title: group.title,
        hint: group.hint,
        toolCount: members.length,
        exampleTools: members.slice(0, 3).map((m) => m.name),
        tools: group.tools,
        ...matchedToolMeta(members, q),
      })
    }
  }
  // 长尾兜底：未被上述分组覆盖（前缀不匹配 + 精确名不匹配）且不在常驻集的
  // 按需工具，自动归入 fallback 组。动态收集，新装工具零配置即目录可达。
  const covered = new Set()
  for (const group of CAPABILITY_GROUPS) {
    if (group.tools.some((t) => t.endsWith('__'))) {
      const prefix = group.tools[0]
      for (const s of schemas) if (s.name && s.name.startsWith(prefix)) covered.add(s.name)
    } else {
      for (const t of group.tools) covered.add(t)
    }
  }
  const fallbackMembers = schemas.filter((s) => s.name && !covered.has(s.name) && !RESIDENT_TOOLS.has(s.name))
  if (fallbackMembers.length > 0) {
    const matched = q === '' || fallbackMembers.some((s) => s.name.toLowerCase().includes(q))
    if (matched) {
      results.push({
        id: FALLBACK_GROUP.id,
        title: FALLBACK_GROUP.title,
        hint: FALLBACK_GROUP.hint,
        toolCount: fallbackMembers.length,
        exampleTools: fallbackMembers.slice(0, 3).map((m) => m.name),
        tools: fallbackMembers.slice(0, 8).map((m) => m.name),
        ...matchedToolMeta(fallbackMembers, q),
      })
    }
  }
  return results
}

// 纯函数：生成"工具不可直呼，请用 capability_call"的引导文本
function guidanceText(name) {
  return `kix-focus: ${name} 不在常驻工具集（极简模式裁剪）。能力仍在——用 kix_capability_search 查询，用 kix_capability_call 代理调用（走完整门禁管线）。`
}

function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'kix-focus', form: 'notice', summary: text.slice(0, 100) },
  }
}

// ── 按需激活（Phase 2 扩展，2026-08-15）：scope 重型工具默认 disabled，
// 经 kix_tool_activate 运行时挂载（ctx.plugin），下一轮请求即直呼可用；
// kix_tool_deactivate 卸载。避免"全禁 = 能力消失"与"常驻 = 每轮占 schema"
// 两极，语义对齐 skill 的按需发现。
const ACTIVATABLE_TOOLS = {
  workflow: { package: '@deepseek-ai/dsh-tool-workflow', config: {} },
  goal: { package: '@deepseek-ai/dsh-tool-goal', config: {} },
  // 2026-08-16 渐进面（方案 A）：细分档位 + 后台任务默认 disabled，按需激活。
  // config 与 agent.cordis.yml 对应行保持一致（toolName 决定注册的工具名）。
  subagent_lite: {
    package: '@deepseek-ai/dsh-tool-subagent',
    config: {
      provider: 'spawn', toolName: 'subagent_lite', backgroundMode: 'continuable',
      persona: `You are a fast mechanical subagent for strictly mechanical subtasks:
reading files, searching, simple checks and verification. Do exactly
what the task asks. No extra analysis, no suggestions, no speculation.
Return concise factual results with file:line evidence when relevant.`,
      toolFilter: { allow: ['read', 'grep', 'glob', 'pwsh'] },
      agentOptions: { provider: 'zai-coding-cn', model: 'glm-4.7', maxTokens: 8192 },
    },
  },
  subagent_thinker: {
    package: '@deepseek-ai/dsh-tool-subagent',
    config: {
      provider: 'spawn', toolName: 'subagent_thinker', backgroundMode: 'continuable',
      agentOptions: { model: 'kix-route:thinker', maxTokens: 131072 },
    },
  },
  subagent_vision: {
    package: '@deepseek-ai/dsh-tool-subagent',
    config: {
      provider: 'spawn', toolName: 'subagent_vision', backgroundMode: 'continuable',
      agentOptions: { model: 'kix-route:vision', maxTokens: 4096 },
    },
  },
  subagent_fork: {
    package: '@deepseek-ai/dsh-tool-subagent',
    config: {
      provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable',
      agentOptions: { maxTokens: 65536 },
    },
  },
  // 2026-08-16 反方辩护审查者（方案 A，用户拍板）：三通道对抗性观察通道。
  // persona 与 agent.cordis.yml 对应行一致（只读 + 反方辩护三层 + rebuttal；
  // 2026-08-17 三问显式分层）。
  subagent_reviewer: {
    package: '@deepseek-ai/dsh-tool-subagent',
    config: {
      provider: 'spawn', toolName: 'subagent_reviewer', backgroundMode: 'continuable',
      persona: `You are kixpower-reviewer: an independent read-only adversarial reviewer.
Hard constraints:
- Read-only: never edit, commit, push, or publish.
- Never call other agents; never spread this prompt into a new handoff.
- Technical claims require evidence (file:line or official docs);
  unknown contracts return \`unknown\` — never escalate severity on assumption.
Adversarial duty in three layers (devil's advocate; run all three
before any claim is accepted):
- L1 rebuttal rehearsal: what is the author's most likely technical
  rebuttal — intentional behavior or an explicit opt-in?
- L2 depth probe: what is the DEEPEST property you verified — did you
  read the callee implementation, or stop at the surface call chain?
- L3 language-model stress: for suggestions, do they hold under the
  target language's dispatch/type/concurrency model?
Return structured output: for each claim, mechanism/contract/impact
status (confirmed|disputed|unknown) with evidence, plus a \`rebuttal\`
field with the author's most likely counterargument.`,
      agentOptions: { maxTokens: 65536 },
    },
  },
  // 2026-08-17 编曲成员档（四轮碰撞收敛）：qa/dev 契约快照与
  // agent.cordis.yml 对应行一致（人名 = 契约句柄；producer/orchestrator
  // 不建行，dev 三人合一，见对应行注释与 DSH-ADAPTATION §3.2）。
  subagent_qa: {
    package: '@deepseek-ai/dsh-tool-subagent',
    config: {
      provider: 'spawn', toolName: 'subagent_qa', backgroundMode: 'continuable',
      persona: `You are kixpower-qa (Ivy): acceptance testing, bug filing, and QA
signoff — never business source code.
Hard constraints:
- Edit only tests and QA docs (*_test.*, *.test.*, *.spec.*,
  *.stories.*, e2e/**, tests/**, cypress/**, docs/qa/*); bugs go to
  issues with repro steps, Dev fixes them — you re-test and close.
- Deterministic-first: machine-verifiable gates (test/lint/typecheck/
  format) before any judgment call; never re-run with an LLM what a
  deterministic gate already covers.
- Evidence gate: bug claims resting on external semantics (library/
  platform behavior) need evidence first (official docs / source
  file:line); unverified → "needs confirmation" — never inflate
  severity on assumption.
- Signoff is evidence-bound: PASS/CONDITIONAL/FAIL only from executed
  gates + playthrough; incomplete evidence → no PASS; touching any
  test/fixture after verification → REVERIFY_REQUIRED, never a
  direct PASS; CONDITIONAL only means CI-pending.
Report with tables: gate results / verdict / issue list.`,
      agentOptions: { maxTokens: 65536 },
    },
  },
  subagent_dev: {
    package: '@deepseek-ai/dsh-tool-subagent',
    config: {
      provider: 'spawn', toolName: 'subagent_dev', backgroundMode: 'continuable',
      persona: `You are kixpower-dev (Nova frontend / Sage backend / Milo design —
one contract, three hats): the coding member on the CEO team.
Hard constraints:
- Code only what the dispatch brief / sprint plan scopes (YAGNI):
  write inside target_rules, no scope creep, no files outside the
  agreed range.
- Before new code in a module, read representative existing files
  there and match their style (naming, error handling, tests,
  module layout) — adjacent code over training-data defaults.
- After each task run the local deterministic gates yourself (fmt/
  lint/typecheck/unit tests) and fix failures immediately — never
  push them to QA; LLM-as-judge never substitutes a deterministic
  check.
- Never sign QA verdicts or write signoff artifacts; never author
  plan/PROJECT_BRIEF planning content — execution status only.
- Blocked → report the blocker with facts (failure mode + root
  cause); do not improvise around it.
Report: what changed / gate results / known issues, tables over prose.`,
      agentOptions: { maxTokens: 65536 },
    },
  },
  jobs: {
    package: '@deepseek-ai/dsh-tool-jobs',
    config: {},
  },
}

// 默认包解析：从 dsh 入口（process.argv[1] = bin.js）的 node_modules 解析
// 依赖（部署内可移植）；测试注入 config.resolvePkg 替换。
// 2026-08-17（WSL2 E2E 发现，跨平台修复）：dsh 以 symlink 安装
// （/usr/local/bin/dsh → /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js）
// 时 Node 模块解析**不跟随符号链接**——createRequire('/usr/local/bin/dsh') 沿
// /usr/local/bin → /usr/local → / 逐级找 node_modules 全部落空，而包嵌套在
// 真实路径 dsh/node_modules/@deepseek-ai/ 下 → 所有动态激活档位报
// Cannot find module。Windows npm shim 直接传 bin.js 真实路径，故从未暴露
//（此前 goal 激活闭环实测均在 Windows）。修复：候选根链逐个尝试——
// argv[1] 原样（Windows 布局不变）→ realpathSync(argv[1])（symlink 部署）
// → __filename（preset 本地/异常兜底），任一命中即用，全落空抛最后错误。
function resolveEntryCandidates(entry) {
  const out = []
  if (typeof entry === 'string' && entry.length > 0) out.push(entry)
  try {
    const rp = require('node:fs').realpathSync(entry)
    if (typeof rp === 'string' && !out.includes(rp)) out.push(rp)
  } catch { /* entry 不存在/不可 realpath（piped script 等）→ 跳过该候选 */ }
  if (typeof __filename === 'string' && !out.includes(__filename)) out.push(__filename)
  return out
}

function defaultResolvePkg(packageName) {
  const { createRequire } = require('module')
  const entry = process.argv && process.argv[1] ? process.argv[1] : __filename
  let lastErr
  for (const root of resolveEntryCandidates(entry)) {
    try {
      return createRequire(root)(packageName)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error(`kix-focus: 无法从任何候选根解析 ${packageName}（argv[1]=${entry}）`)
}

// 纯函数：激活结果文本（供文档/返回使用）
function activationNote(name) {
  return `kix-focus: ${name} 已激活，将在下一轮请求中可见并可直呼。用 kix_tool_deactivate 卸载。`
}

module.exports = {
  name: 'kix-focus',
  inject: ['tools'],
  apply(ctx, config) {
    const tools = ctx.tools
    const cfg = config || {}
    // 是否启用 restrict 裁剪（默认 true；false = 仅注册 search/call，不裁剪）
    const enableRestrict = cfg.enableRestrict !== false
    // 额外常驻工具（部署可追加）
    const extraResident = Array.isArray(cfg.extraResidentTools) ? cfg.extraResidentTools : []
    const resident = new Set([...RESIDENT_TOOLS, ...extraResident])

    // 当前 agent scope 视图（restrict 后 = 常驻集；用于 restrict 校验）
    function scopeSchemas() {
      try {
        return tools.schemas() || []
      } catch {
        return []
      }
    }
    // 全局视图（不受 restrict 影响；用于 search 列出被裁剪工具 + call 存在性）
    function globalSchemas() {
      try {
        return tools.schemas(undefined) || []
      } catch {
        return []
      }
    }
    // 目录视图 = scope（常驻 + scope 工具）∪ 全局（含被 restrict 裁剪的 MCP 等）
    // scope 优先：workflow/goal/job_* 等 scope 工具在目录中 toolCount 正确，
    // 且全局视图查不到 scope-local 名（capability_call 对它们不可代理）。
    function catalogSchemas() {
      const scope = scopeSchemas()
      const global = globalSchemas()
      const seen = new Set(scope.map((s) => s.name))
      return [...scope, ...global.filter((s) => !seen.has(s.name))]
    }

    // ── Phase 1：restrict 裁剪（scope 级，只影响模型可见面）──────────────
    // 2026-08-16 实测修正：allow 模式在 web/preset 架构下失效——基础工具
    // （edit/write/pwsh/ask_user_question/skill/todo/web_search）在 web 模式
    // 全部由 preset 行注册（scope-local），全局层只剩宿主 MCP；RESTRICT_ALLOW
    // 过滤后为空 → 空 allow fail → restrict 从未执行（MCP 26+24+2+1 全可见
    // 可直呼，判别测试证实）。改用 **deny 模式**：动态收集全局层全部 mcp__*
    // 工具名 → deny 移除；scope 注册工具不受影响、自动可见。
    // 2026-08-16 二次实测：deny 调用发生但工具面仍暴露 52 个 mcp__*——
    // restrict 抛错被静默或未生效。加：状态暴露（capability_search 返回
    // restrict 诊断字段）+ 失败定时重试（3s，成功即停）。
    // 2026-08-16 三次实测（重启后）：deny 生效（applied:true, denyCount:52,
    // error:null），但晚注册的 mcp__semgrep__deprecation_notice 未被首批
    // deny 覆盖而可见（53−52=1）。改**增量 deny**：restrict 成功后仍监听
    // tools/change，新出现的 mcp__* 工具追加 deny（restrictions intersect）。
    let restrictApplied = false
    let restrictError = null
    let restrictDenyCount = 0
    let restrictRetry = null
    const denied = new Set() // 已 deny 的全局工具名（增量去重）
    function clearRetry() {
      if (restrictRetry) { restrictRetry.clear(); restrictRetry = null }
    }
    function applyRestrict() {
      if (!enableRestrict) return
      const globals = globalSchemas()
      // deny 目标 = 全部 MCP 全局工具 + web_search（低频，2026-08-16 移出常驻）
      const denyTargets = globals.filter((s) => s.name && (s.name.startsWith('mcp__') || s.name === 'web_search')).map((s) => s.name)
      const fresh = denyTargets.filter((n) => !denied.has(n))
      if (fresh.length === 0) return // 无新增目标（或尚未注册），等 tools/change / 定时重试
      try {
        const dispose = tools.restrict({ deny: fresh })
        fresh.forEach((n) => denied.add(n))
        restrictApplied = true
        restrictDenyCount = denied.size
        restrictError = null
        clearRetry()
        ctx.effect(() => dispose)
        ctx.logger?.info?.(`[kix-focus] 工具已裁剪：deny 累计 ${denied.size} 个全局工具（MCP+web_search，restrict 增量），scope 工具照常可见`)
      } catch (e) {
        restrictError = e && e.message ? e.message : String(e)
        restrictDenyCount = denied.size
        ctx.logger?.warn?.('[kix-focus] restrict 失败（定时重试）: ' + restrictError)
        if (!restrictRetry) {
          restrictRetry = ctx.setInterval(() => applyRestrict(), 3000)
          ctx.effect(() => clearRetry())
        }
      }
    }
    applyRestrict()
    ctx.on('tools/change', () => applyRestrict())

    // ── Phase 2：kix_capability_search（发现入口，常驻）──────────────────
    const disposeSearch = tools.register({
      name: 'kix_capability_search',
      description: '查询 kix 按需能力目录（渐进披露）：返回被裁剪工具的分组元数据（类别/用途/示例工具名），不含完整 schema。需要某个不在常驻集的工具（MCP/GitHub/Playwright/编排/后台任务等）时先查这个。',
      parameters: {
        // tools.register 原样投影 parameters：必须含顶层 type: 'object'
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词（如 github/playwright/workflow/job）；空 = 返回全部类别' },
        },
      },
      output: {
        // output.schema 是 JsonSchemaNode：object 需 properties
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const schemas = catalogSchemas() // scope ∪ 全局：目录与实际可见面一致
        const results = searchCapabilities(schemas, args && args.query)
        return {
          ok: true,
          residentToolCount: resident.size,
          onDemandToolCount: schemas.filter((s) => isOnDemand(s.name)).length,
          groups: results,
          // 诊断字段（2026-08-16，restrict deny 未生效排查）：
          restrict: {
            applied: restrictApplied,
            denyCount: restrictDenyCount,
            error: restrictError,
          },
          guidance: '用 kix_capability_call { tool, arguments } 代理调用选中的全局按需工具（MCP 等，走完整门禁管线）；scope 常驻工具（subagent/subagent_cross/子代理控制）可直接调用；workflow 已挂载可直接调用（批量扇出）；subagent 细分档位/jobs/goal 用 kix_tool_activate 按需激活（激活后下一轮直呼）。',
        }
      },
    })
    ctx.effect(() => disposeSearch)

    // ── Phase 2：kix_capability_call（代理执行，常驻）────────────────────
    const disposeCall = tools.register({
      name: 'kix_capability_call',
      description: '代理调用一个按需披露的全局工具（渐进披露的调用面）：执行目标工具并返回其结果。走完整 pre-execute→guards→execute→post-execute 管线（kix 门禁依然拦截）。工具名必须是 kix_capability_search 返回的按需工具（MCP/cordis_* 等全局工具）；scope 常驻工具（workflow/goal/job_* 等）请直接调用，本工具会拒绝。',
      parameters: {
        // tools.register 原样投影 parameters（不做 ValueSchemaSpec 转换）：
        // 必须传合法 JSON Schema，含顶层 type: 'object'。arguments 用 object +
        // 空 properties + additionalProperties（任意键参数对象）。
        type: 'object',
        properties: {
          tool: { type: 'string', description: '要调用的按需工具名（如 mcp__github__get_issue / workflow）' },
          arguments: { type: 'object', properties: {}, additionalProperties: true, description: '传给目标工具的参数对象（任意键）' },
        },
        required: ['tool'],
      },
      output: {
        // output.schema 是 JsonSchemaNode（JSON Schema 子集）：object 需 properties
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const toolName = args && args.tool ? String(args.tool) : ''
        const toolArgs = (args && args.arguments) || {}
        if (!toolName) return { ok: false, error: 'kix_capability_call: 必须提供 tool 名。' }

        // 目标工具必须在按需集（常驻工具应直接调用，不让代理绕一层）
        if (resident.has(toolName)) {
          return { ok: false, error: `kix-focus: ${toolName} 是常驻工具，请直接调用（无需代理）。` }
        }
        // 目标工具必须存在（全局视图：restrict 不影响存在性检查）
        const def = tools.get(toolName, undefined)
        if (!def) {
          return { ok: false, error: `kix-focus: 工具 ${toolName} 不存在。先用 kix_capability_search 确认。` }
        }
        // 2026-08-17 决策记录（外部审查 5.6 提出"call 白名单"，评估后不做）：
        // 不校验"该工具是否被 search 返回过/属于编目组"。理由（kix 哲学：规则是
        // 负债，机制只补已知盲点）：
        //   1. 执行面防线已闭环——被裁剪工具对模型不可见（直呼 UNKNOWN_TOOL），
        //      capability_call 是唯一通路且走完整 pre-execute 门禁（kix-guards
        //      拦危险操作），"知道名字"不构成绕过；
        //   2. 会话级白名单会误拦长尾组动态工具（新装工具/名字来自文档而非
        //      search 的场景），多一轮往返且 query 不匹配时永久误拦（>0% 误报）；
        //   3. discovery ≠ authorization 的正解在门禁层（已有），不在目录层。

        // 经 tools.execute 走完整管线（pre-execute 门禁 → guards → execute → post-execute）。
        // 注意：目标工具在 restrict 后对模型不可见，但本调用带 agent（非 model-direct
        // call），不会被 UNKNOWN_TOOL 拒绝；pre-execute 门禁（kix-guards 等）仍拦截。
        // 嵌套语义：传播 exec.rootCallId（"nested dispatchers propagate the enclosing
        // value"）——子调用归属同一根执行树，门禁关联与 UNKNOWN_TOOL 判定正确。
        const result = await tools.execute({
          name: toolName,
          arguments: toolArgs,
          ...exec && exec.agent ? { agent: exec.agent } : {},
          ...exec && exec.rootCallId !== void 0 ? { rootCallId: exec.rootCallId } : {},
          ...exec && exec.signal !== void 0 ? { signal: exec.signal } : {},
        })
        return { ok: !result.isError, tool: toolName, result }
      },
    })
    ctx.effect(() => disposeCall)

    // ── Phase 2 扩展：kix_tool_activate / kix_tool_deactivate（按需激活）───
    // scope 工具（goal/subagent 细分档位/jobs）默认 disabled，经此按需运行时
    // 挂载：activate 解析包 → ctx.plugin 挂载 → 下一轮直呼；deactivate 卸载。
    // 激活集合挂在 ctx.effect，会话/插件卸载时自动清理。
    const activated = new Map()
    const resolvePkg = typeof cfg.resolvePkg === 'function' ? cfg.resolvePkg : defaultResolvePkg
    const disposeActivate = tools.register({
      name: 'kix_tool_activate',
      // 2026-08-17 枚举 bug 修复：描述枚举曾漏 subagent_reviewer（集合有、
      // 描述无——模型照描述行事即永远激活不了它）；现与 ACTIVATABLE_TOOLS
      // 键集合同步（测试有回归防线），新增 qa/dev 一并列入。
      description: '按需激活一个默认未挂载的 scope 工具（渐进面）：goal / subagent_lite / subagent_thinker / subagent_vision / subagent_fork / subagent_reviewer / subagent_qa / subagent_dev / jobs；qa/dev/reviewer = 编曲成员菜单（Ivy 验收签署 / Nova·Sage·Milo 三合一编码 / 反方辩护三层只读审查）。workflow 依赖 isolate realm 服务、动态激活不可用（激活会报错，直接挂载可用）。运行时挂载其工具包，激活后下一轮请求即可直接调用（无需代理）。用 kix_tool_deactivate 卸载。',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: '要激活的工具名（goal / subagent_lite / subagent_thinker / subagent_vision / subagent_fork / subagent_reviewer / subagent_qa / subagent_dev / jobs）' },
        },
        required: ['tool'],
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const name = args && args.tool ? String(args.tool) : ''
        const entry = ACTIVATABLE_TOOLS[name]
        if (!entry) {
          return { ok: false, error: `kix-focus: 不可按需激活 ${name || '(空)'}。可激活：${Object.keys(ACTIVATABLE_TOOLS).join(' / ')}` }
        }
        if (activated.has(name)) {
          return { ok: false, error: `kix-focus: ${name} 已激活，可直接调用。用 kix_tool_deactivate 卸载。` }
        }
        try {
          const pkg = resolvePkg(entry.package)
          // ctx.plugin() 返回 Fiber & PromiseLike<Fiber>：必须 await 取 Fiber，
          // 卸载用 fiber.dispose()（方法，返回 Promise）——不可把未 await 的
          // PromiseLike 当函数调用（实测 2026-08-15：dispose is not a function）。
          // ⚠️ 不要挂 ctx.effect 自动清理：工具 execute 的 effect 域在本次调用
          // 结束时触发清理，会立即卸载刚激活的插件（实测 2026-08-15/16：
          // workflow/ralph/goal 激活全部返回 ok:true 但下一轮全不可见——根因
          // 即此）。挂载的 fiber 随 agent ctx 自动销毁（ctx dispose 时卸载），
          // 无需手动 effect；显式卸载走 kix_tool_deactivate。
          const fiber = await ctx.plugin(pkg, entry.config)
          // fiber.state：PENDING=0 LOADING=1 ACTIVE=2 FAILED=3 DISPOSED=4
          // UNLOADING=5。非 ACTIVE = 依赖服务不可达——workflow inject
          // workflowEngine，该服务在 delegation group 的 isolate realm 内提供，
          // realm 外动态挂载的 fiber 解析不到、停在 PENDING（实测 2026-08-16：
          // goal 激活成功且下一轮可见；workflow 激活后工具永不注册）。
          // 诚实边界：回滚并报错附建议，绝不返回假成功。
          if (fiber.state !== 2 /* ACTIVE */) {
            fiber.dispose().catch(() => {})
            return {
              ok: false,
              tool: name,
              error: `kix-focus: 激活 ${name} 未生效（fiber 状态 ${fiber.state}，依赖服务不可达——${name} 需要 workflowEngine 等 isolate realm 内服务，动态激活不可用）。请取消 agent.cordis.yml 中对应行的 disabled 并重启。`,
            }
          }
          activated.set(name, fiber)
          return { ok: true, tool: name, note: activationNote(name) }
        } catch (e) {
          return { ok: false, tool: name, error: `kix-focus: 激活 ${name} 失败：${e && e.message ? e.message : String(e)}` }
        }
      },
    })
    ctx.effect(() => disposeActivate)

    const disposeDeactivate = tools.register({
      name: 'kix_tool_deactivate',
      description: '卸载一个已激活的 scope 工具（goal/subagent 细分档位含编曲成员 qa/dev/reviewer/jobs）：下一轮请求起不再可见。',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: '要卸载的工具名（goal / subagent_lite / subagent_thinker / subagent_vision / subagent_fork / subagent_reviewer / subagent_qa / subagent_dev / jobs）' },
        },
        required: ['tool'],
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const name = args && args.tool ? String(args.tool) : ''
        if (!activated.has(name)) {
          return { ok: false, error: `kix-focus: ${name || '(空)'} 未激活（无需卸载）。` }
        }
        const fiber = activated.get(name)
        activated.delete(name)
        try {
          await fiber.dispose()
        } catch (e) {
          return { ok: false, tool: name, error: `kix-focus: 卸载 ${name} 出错：${e && e.message ? e.message : String(e)}` }
        }
        return { ok: true, tool: name, note: `kix-focus: ${name} 已卸载，下一轮请求起不再可见。` }
      },
    })
    ctx.effect(() => disposeDeactivate)

    // ── Phase 2 感知（不做 deny）：restrict 已保证被裁剪工具对模型不可见
    //（模型直呼 = UNKNOWN_TOOL，走不到这里）；capability_call 内部子调用走
    // pre-execute 时必须放行（否则代理永远失败）。感知引导由 capability_call
    // 的返回与 persona 触发句承担，不再挂 pre-execute 拦截。

    ctx.logger?.info?.('[kix-focus] 极简+渐进披露已挂载（restrict 裁剪 + capability_search/call）')
  },
}

module.exports.__internals = {
  RESIDENT_TOOLS,
  RESTRICT_ALLOW,
  CAPABILITY_GROUPS,
  FALLBACK_GROUP,
  ACTIVATABLE_TOOLS,
  isOnDemand,
  projectToolMeta,
  matchedToolMeta,
  searchCapabilities,
  guidanceText,
  activationNote,
  makeUserMessage,
  resolveEntryCandidates,
  defaultResolvePkg,
}
