// kix-focus — kixparadigm 极简 + 渐进披露 + PTC 协同（2026-08-16）
//
// 三层递进架构的实现载体（设计见 PLUGINIZATION-ROADMAP.md §8）：
//
//   Phase 1 — 常驻裁剪：tools.restrict 把模型每轮可见的工具从 85 个（~108KB
//     schema JSON）裁到常驻核心集（~12 个）。裁剪只影响"模型可见/可直呼"的
//     继承全局工具，scope 内注册的工具（门禁插件等）不受影响；restrict 后的
//     工具仍可被代理调用（见 Phase 2）。
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
//   - scope 重型编排（workflow/goal/ralph）：restrict 裁剪不到（自动可见），
//     2026-08-15 决策 = 默认 disabled + **按需激活**（kix_tool_activate 运行时
//     ctx.plugin 挂载，下一轮直呼；kix_tool_deactivate 卸载）——避免"全禁"
//     与"常驻占 schema"两极，语义对齐 skill 按需发现。job_*/subagent-control
//     是范式日常路径 → 保留挂载并纳入语义常驻集。实测（2026-08-15）：
//     workflow 7 路并行审计成功——机制可用，激活即用。
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
// 2026-08-15 实测（workflow 7 路并行审计）：workflow/ralph/goal/job_* 等
// preset 行注册的编排工具同为 scope-local —— restrict 裁剪不到、对模型
// 自动可见、可直接调用，无需经 capability_call 代理（全局视图查不到
// scope-local 名，代理反而失败）。故 SCOPE_RESIDENT 把它们纳入语义常驻集，
// 目录/统计口径与实际可见面一致；capability_call 对它们拒绝（"请直接调用"）。
const RESTRICT_ALLOW = [
  // 全局基础工具（host 平面注册）
  'edit', 'write', 'read', 'grep', 'glob', 'pwsh', 'bash',
  'ask_user_question', 'todo_write', 'skill', 'web_search',
]

// scope 注册、自动可见（restrict 裁剪不到）的编排/后台/控制工具
// 2026-08-15 精简：workflow/ralph/goal 低频重型 → agent.cordis.yml 默认
// disabled（主 agent 工具面只留范式必需；restrict 裁不到 scope 工具，
// disabled 是唯一精简手段）。此处只列仍挂载的 scope 工具。
const SCOPE_RESIDENT = [
  // plan mode realm（挂载，先规划用 plan mode）
  'exit_plan_mode',
  // tool-jobs（挂载：长任务后台回收）
  'job_output', 'job_list', 'job_kill',
  // tool-subagent-control（挂载：三通道观察者管理）
  'list_agents', 'send_message', 'interrupt_agent',
]

// 常驻语义全集 = RESTRICT_ALLOW + scope 注册的观察/发现/编排工具（自动可见）
const RESIDENT_TOOLS = new Set([
  ...RESTRICT_ALLOW,
  // scope 注册（delegation group 的 subagent 五档 + 本插件发现入口）
  'subagent', 'subagent_fork', 'subagent_cross', 'subagent_lite', 'subagent_thinker', 'subagent_vision',
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
    title: '重型编排（workflow/goal/ralph）',
    hint: '默认未挂载，按需激活：调 kix_tool_activate { tool }，激活后下一轮可直接调用；用完 kix_tool_deactivate 卸载',
    tools: ['workflow', 'create_goal', 'update_goal', 'get_goal', 'ralph', 'exit_plan_mode'],
  },
  {
    id: 'jobs',
    title: '后台任务（job_output/job_list/job_kill）',
    hint: 'scope 常驻、可直接调用：长任务 pwsh run_in_background 后回收结果',
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
    id: 'vision',
    title: '识图（read_image）',
    hint: '主模型无视觉时用 subagent_vision（常驻）；read_image 按需',
    tools: ['read_image'],
  },
]

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

// 纯函数：按查询词在能力组里检索
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
  ralph: { package: '@deepseek-ai/dsh-tool-ralph', config: { subagentProvider: 'spawn', maxRounds: 64 } },
  goal: { package: '@deepseek-ai/dsh-tool-goal', config: {} },
}

// 默认包解析：从 dsh 入口（process.argv[1] = bin.js）的 node_modules 解析
// 依赖（部署内可移植）；测试注入 config.resolvePkg 替换。
function defaultResolvePkg(packageName) {
  const { createRequire } = require('module')
  const entry = process.argv && process.argv[1] ? process.argv[1] : __filename
  return createRequire(entry)(packageName)
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
    // scope 优先：workflow/ralph/goal/job_* 等 scope 工具在目录中 toolCount 正确，
    // 且全局视图查不到 scope-local 名（capability_call 对它们不可代理）。
    function catalogSchemas() {
      const scope = scopeSchemas()
      const global = globalSchemas()
      const seen = new Set(scope.map((s) => s.name))
      return [...scope, ...global.filter((s) => !seen.has(s.name))]
    }

    // ── Phase 1：restrict 裁剪（scope 级，只影响模型可见面）──────────────
    // allow 列表只含"RESTRICT_ALLOW 中已注册的全局工具"（restrict 对未知名
    // 与 scope-local 名 fail；scope 注册的 subagent 五档/capability_* 自动可见，
    // 不列入 allow）。MCP/工具可能晚于插件 apply 注册，故监听 tools/change 重试。
    let restrictApplied = false
    function applyRestrict() {
      if (!enableRestrict || restrictApplied) return
      const visible = new Set(globalSchemas().map((s) => s.name))
      const allow = RESTRICT_ALLOW.filter((n) => visible.has(n))
      if (allow.length === 0) return // 全局工具尚未注册完，等 tools/change
      try {
        const dispose = tools.restrict({ allow })
        restrictApplied = true
        ctx.effect(() => dispose)
        ctx.logger?.info?.(`[kix-focus] 工具已裁剪：保留 ${allow.length} 个全局常驻 + scope 工具（restrict）`)
      } catch (e) {
        ctx.logger?.warn?.('[kix-focus] restrict 失败（稍后重试）: ' + (e && e.message ? e.message : String(e)))
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
          guidance: '用 kix_capability_call { tool, arguments } 代理调用选中的全局按需工具（MCP 等，走完整门禁管线）；scope 常驻工具（job_*/子代理控制）可直接调用；workflow/goal/ralph 用 kix_tool_activate 按需激活（激活后下一轮直呼）。',
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
    // scope 重型工具（workflow/ralph/goal）在 agent.cordis.yml 默认 disabled，
    // 经此按需运行时挂载：activate 解析包 → ctx.plugin 挂载 → 下一轮直呼；
    // deactivate 卸载。激活集合挂在 ctx.effect，会话/插件卸载时自动清理。
    const activated = new Map()
    const resolvePkg = typeof cfg.resolvePkg === 'function' ? cfg.resolvePkg : defaultResolvePkg
    const disposeActivate = tools.register({
      name: 'kix_tool_activate',
      description: '按需激活一个默认未挂载的 scope 重型工具（workflow/goal/ralph）：运行时挂载其工具包，激活后下一轮请求即可直接调用（无需代理）。用 kix_tool_deactivate 卸载。',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: '要激活的工具名（workflow / ralph / goal）' },
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
          const dispose = ctx.plugin(pkg, entry.config)
          activated.set(name, dispose)
          ctx.effect(() => {
            dispose()
            activated.delete(name)
          })
          return { ok: true, tool: name, note: activationNote(name) }
        } catch (e) {
          return { ok: false, tool: name, error: `kix-focus: 激活 ${name} 失败：${e && e.message ? e.message : String(e)}` }
        }
      },
    })
    ctx.effect(() => disposeActivate)

    const disposeDeactivate = tools.register({
      name: 'kix_tool_deactivate',
      description: '卸载一个已激活的 scope 重型工具（workflow/goal/ralph）：下一轮请求起不再可见。',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: '要卸载的工具名（workflow / ralph / goal）' },
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
        const dispose = activated.get(name)
        activated.delete(name)
        try {
          dispose()
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
  ACTIVATABLE_TOOLS,
  isOnDemand,
  projectToolMeta,
  searchCapabilities,
  guidanceText,
  activationNote,
  makeUserMessage,
}
