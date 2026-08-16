// kix-focus 回归测试（2026-08-16）
//
// 单元级验证：加载 kix-focus.js，mock DSH tools 服务（register/restrict/schemas/execute），
// 覆盖：
//   - 纯逻辑（__internals）：isOnDemand / projectToolMeta / searchCapabilities /
//     guidanceText / RESIDENT_TOOLS / CAPABILITY_GROUPS
//   - 插件挂载：restrict 被调用（裁剪）、search/call 工具注册、pre-execute 引导
//   - call 代理执行：常驻工具拒绝、未知工具报错、按需工具走 execute
// 运行：node plugins/kix-focus.test.js

const path = require('node:path')
const assert = require('node:assert')

// ── mock ctx ───────────────────────────────────────────────────────────────
const listeners = {}
// resolvePkg 返回包名字符串本身（mock 的 ctx.plugin 按字符串比较 pkg 判定
// goal 包注册名；旧实现返回 {fake:...} 对象导致永远匹配不上）
const configMock = { resolvePkg: (pkgName) => pkgName }
const registeredTools = []
let restrictCalls = []
let executeCalls = []
let mockSchemas = []          // scope 视图（scope 注册工具）
let mockGlobalSchemas = []    // 全局视图（MCP 等；scope-local 名不可见）
// 2026-08-17 视图感知回归防线：真实 DSH 的全局视图查不到 scope-local 名，
// 旧 mock 不区分视图，曾让「自动激活挂载后复查失败」缺陷在 82 断言全绿下
// 漏网（WSL2 E2E 实锤：capability_call 报"工具不存在"）。现在 schemas()/
// get(name) = scope，schemas(undefined)/get(name, undefined) = 全局。
// 按需激活 spy：ctx.plugin 返回 Fiber 形对象（await 后取 fiber.dispose()）
const pluginCalls = []
let disposeCalls = 0
// 可配置 fiber.state：默认 ACTIVE(2)；非 ACTIVE 回滚路径测试用 fiberStateOverride
let fiberStateOverride = null
// ctx.effect 记录（回归防线：激活不得注册自动清理回调——真实 DSH 的工具
// execute effect 域在调用结束时触发清理，会立即卸载刚激活的插件；mock 的
// no-op effect 曾让该缺陷在 49 断言全绿下漏网）
const effectCalls = []
const ctx = {
  config: configMock,
  logger: { info() {}, warn() {}, error() {} },
  get() { return undefined },
  on(event, cb) { (listeners[event] ||= []).push(cb) },
  effect(cb) { effectCalls.push(cb) },
  setInterval() { return { clear() {} } },
  plugin(pkg, cfg) {
    // 模拟挂载副作用：按 cfg.toolName 注册对应工具（goal 包注册 create_goal 等），
    // dispose 时移除——自动激活路径依赖"挂载后 tools.get 可见"。
    const names = cfg && cfg.toolName ? [cfg.toolName]
      : pkg === '@deepseek-ai/dsh-tool-goal' ? ['create_goal', 'update_goal', 'get_goal']
      : []
    pluginCalls.push({ pkg, cfg, names })
    for (const n of names) if (!mockSchemas.some((s) => s.name === n)) mockSchemas.push({ name: n, description: 'activated ' + n })
    return {
      dispose: async () => {
        disposeCalls++
        for (const n of names) {
          const idx = mockSchemas.findIndex((s) => s.name === n)
          if (idx >= 0) mockSchemas.splice(idx, 1)
        }
      },
      state: fiberStateOverride !== null ? fiberStateOverride : 2,
    }
  },
}
ctx.tools = {
  register(def) { registeredTools.push(def); return () => {} },
  restrict(filter) { restrictCalls.push(filter); return () => {} },
  // 2026-08-17 视图语义对齐真实 dsh-tools（源码+API 文档实证）：
  // `get(name, scope)`/`schemas(scope)` 中 scope 省略或显式 undefined 都是
  // **全局视图**（`peek(undefined)`=undefined、`chainLayers(undefined)` 无
  // 覆盖层）；scope 工具注册在 agent 层，只在 **agent 视图** 可见。agent
  // 视图 = 全局 ∪ 祖先 ∪ 自身层 → mock 中合并两表（scope 优先）。
  // 旧 mock 把"无参=scope、undefined 参=全局"当语义，曾让 scope 优先修复
  // 在单测全绿下空转（真实运行时两者机械等同，WSL2 E2E + 源码实锤）。
  schemas(scope) { return scope === undefined ? mockGlobalSchemas : mockSchemas },
  get(name, scope) {
    const list = scope === undefined
      ? mockGlobalSchemas
      : [...mockSchemas, ...mockGlobalSchemas] // agent 视图：scope ∪ 全局
    return list.find((s) => s.name === name) ? { name } : undefined
  },
  async execute(input) { executeCalls.push(input); return { isError: false, value: { executed: input.name } } },
}

// ── 加载被测试插件 ────────────────────────────────────────────────────────
const plugin = require(path.join(__dirname, 'kix-focus.js'))
assert.strictEqual(plugin.name, 'kix-focus')
// 预置工具 schema（apply 时 restrict 需要看到已注册工具；scope 与全局分视图）
mockSchemas = [
  { name: 'edit', description: 'Edit' }, { name: 'read', description: 'Read' },
  { name: 'subagent', description: 'Sub' }, { name: 'ask_user_question', description: 'Ask' },
  { name: 'pwsh', description: 'Shell' },
  { name: 'workflow', description: 'Flow' },
  { name: 'job_output', description: 'Job' },
]
mockGlobalSchemas = [
  { name: 'mcp__github__get_issue', description: 'Issue' },
]
plugin.apply(ctx, configMock)
assert.ok(registeredTools.some((t) => t.name === 'kix_capability_search'), 'search 工具已注册')
assert.ok(registeredTools.some((t) => t.name === 'kix_capability_call'), 'call 工具已注册')
assert.ok(restrictCalls.length === 1, 'restrict 被调用一次')

const I = plugin.__internals
const searchTool = registeredTools.find((t) => t.name === 'kix_capability_search')
const callTool = registeredTools.find((t) => t.name === 'kix_capability_call')

let passed = 0
let failed = 0
// 2026-08-17 harness 修复 v2：ok 改 async 并 await cond，全部断言经
// `await ok(...)` 顺序执行——旧 `if (cond)` 对 Promise 恒真（异步用例
// 空转 PASS），且并发 pending 收集会让共享态（fiberStateOverride/mockSchemas/
// pluginCalls）跨用例交错。主流程包进 async IIFE 逐条 await。
async function ok(label, cond) {
  const okk = await cond
  if (okk) { passed++ } else { failed++ }
  console.log(`${okk ? 'PASS' : 'FAIL'}  ${label}`)
}
function section(title) { console.log('\n── ' + title + ' ──') }
;(async () => {

// ── 1. 纯逻辑：isOnDemand / RESIDENT_TOOLS ────────────────────────────────
section('isOnDemand / 常驻集')
await ok('edit 常驻', I.RESIDENT_TOOLS.has('edit'))
await ok('read 常驻', I.RESIDENT_TOOLS.has('read'))
await ok('subagent 常驻', I.RESIDENT_TOOLS.has('subagent'))
await ok('subagent_cross 常驻', I.RESIDENT_TOOLS.has('subagent_cross'))
await ok('subagent_lite 未挂载(渐进面,默认 disabled)', I.isOnDemand('subagent_lite'))
await ok('subagent_reviewer 未挂载(渐进面,默认 disabled)', I.isOnDemand('subagent_reviewer'))
await ok('subagent_fork 未挂载(渐进面,默认 disabled)', I.isOnDemand('subagent_fork'))
await ok('ask_user_question 常驻', I.RESIDENT_TOOLS.has('ask_user_question'))
await ok('kix_capability_search 常驻', I.RESIDENT_TOOLS.has('kix_capability_search'))
await ok('mcp__github__get_issue 按需', I.isOnDemand('mcp__github__get_issue'))
await ok('web_search 按需(低频,移出常驻)', I.isOnDemand('web_search'))
await ok('read_image 按需', I.isOnDemand('read_image'))
await ok('workflow 常驻(临时启用,自发使用测试中)', !I.isOnDemand('workflow'))
await ok('create_goal 未挂载(默认 disabled,不在常驻集)', I.isOnDemand('create_goal'))
await ok('job_output 常驻(2026-08-17 jobs 常驻化)', !I.isOnDemand('job_output'))
await ok('list_agents 常驻(scope 自动可见)', !I.isOnDemand('list_agents'))
await ok('edit 非按需', !I.isOnDemand('edit'))

// ── 2. 纯逻辑：projectToolMeta ────────────────────────────────────────────
section('projectToolMeta')
await ok('投影轻量元数据', (() => {
  const meta = I.projectToolMeta([
    { name: 'mcp__github__get_issue', description: 'Get details of an issue', parameters: { properties: { owner: {}, issue_number: {} } } },
  ])
  return meta.length === 1 && meta[0].name === 'mcp__github__get_issue'
    && Array.isArray(meta[0].parameters) && meta[0].parameters.includes('owner')
    && meta[0].description.length <= 140
})())
await ok('nameFilter 过滤', (() => {
  const meta = I.projectToolMeta([
    { name: 'mcp__github__get_issue', description: 'x' },
    { name: 'mcp__playwright__browser_click', description: 'y' },
  ], 'github')
  return meta.length === 1 && meta[0].name.includes('github')
})())

// ── 3. 纯逻辑：searchCapabilities ─────────────────────────────────────────
section('searchCapabilities')
const sampleSchemas = [
  { name: 'mcp__github__get_issue', description: 'Get issue' },
  { name: 'mcp__github__create_issue', description: 'Create issue' },
  { name: 'mcp__github__merge_pull_request', description: 'Merge PR' },
  { name: 'mcp__playwright__browser_click', description: 'Click' },
  { name: 'mcp__playwright__browser_snapshot', description: 'Snapshot' },
  { name: 'workflow', description: 'Run workflow' },
  { name: 'create_goal', description: 'Create goal' },
  { name: 'job_output', description: 'Job output' },
]
await ok('空查询返回全部类别', (() => {
  const r = I.searchCapabilities(sampleSchemas, '')
  return r.some((g) => g.id === 'github') && r.some((g) => g.id === 'orchestration') && r.some((g) => g.id === 'jobs')
})())
await ok('查询 github 只返回 github 组', (() => {
  const r = I.searchCapabilities(sampleSchemas, 'github')
  return r.every((g) => g.id === 'github') && r[0].toolCount === 3
})())
await ok('查询 workflow 返回编排组', (() => {
  const r = I.searchCapabilities(sampleSchemas, 'workflow')
  return r.some((g) => g.id === 'orchestration')
})())
await ok('组内 exampleTools 截断 3 个', (() => {
  const r = I.searchCapabilities(sampleSchemas, '')
  const gh = r.find((g) => g.id === 'github')
  return gh.exampleTools.length === 3
})())

// ── 3b. 长尾 fallback 组（2026-08-17 决策：发现面补兜底，不建动态分组）───
section('fallback 长尾兜底')
const longTailSchemas = [
  ...sampleSchemas,
  { name: 'mcp__linear__get_issue', description: 'Linear issue' }, // 新命名空间 MCP（未归类前缀）
  { name: 'custom_global_tool', description: 'Custom global' },   // 非 MCP 全局工具（未归类）
]
await ok('未覆盖按需工具自动归入 fallback 组', (() => {
  const r = I.searchCapabilities(longTailSchemas, '')
  const fb = r.find((g) => g.id === 'other')
  return fb !== undefined
    && fb.toolCount === 2
    && fb.exampleTools.includes('mcp__linear__get_issue')
    && fb.exampleTools.includes('custom_global_tool')
})())
await ok('已覆盖工具与常驻工具不进 fallback', (() => {
  const r = I.searchCapabilities(longTailSchemas, '')
  const fb = r.find((g) => g.id === 'other')
  return fb.exampleTools.every((n) =>
    !n.startsWith('mcp__github__') && !n.startsWith('mcp__playwright__')
    && n !== 'workflow' && n !== 'create_goal' && n !== 'job_output')
})())
await ok('fallback query 过滤按成员名（组级统计不变）', (() => {
  const r = I.searchCapabilities(longTailSchemas, 'linear')
  const fb = r.find((g) => g.id === 'other')
  return fb !== undefined && fb.toolCount === 2
})())

// ── 3c. matchedToolMeta（2026-08-17，外部审查 5.6：search 结果带参数名）────
section('search 带工具元数据（参数名披露）')
const metaSchemas = [
  { name: 'mcp__github__get_issue', description: 'Get issue', parameters: { properties: { owner: {}, repo: {}, issue_number: {} } } },
  { name: 'mcp__github__get_pull_request', description: 'Get PR', parameters: { properties: { owner: {}, pull_number: {} } } },
  { name: 'mcp__github__create_issue', description: 'Create issue', parameters: { properties: { owner: {}, title: {} } } },
  { name: 'mcp__playwright__browser_click', description: 'Click', parameters: { properties: { target: {} } } },
]
await ok('query 命中 → matchedTools 带 name/description/参数名', (() => {
  const r = I.searchCapabilities(metaSchemas, 'issue')
  const gh = r.find((g) => g.id === 'github')
  return gh !== undefined && Array.isArray(gh.matchedTools)
    && gh.matchedTools.some((m) => m.name === 'mcp__github__get_issue'
      && m.parameters.includes('owner') && m.parameters.includes('issue_number')
      && typeof m.description === 'string')
})())
await ok('query 命中 PR → matchedTools 含 pull_number 参数', (() => {
  const r = I.searchCapabilities(metaSchemas, 'pull_request')
  const gh = r.find((g) => g.id === 'github')
  return gh !== undefined && gh.matchedTools.some((m) => m.name === 'mcp__github__get_pull_request'
    && m.parameters.includes('pull_number'))
})())
await ok('空 query（目录浏览模式）不投影 matchedTools（token 成本控制）', (() => {
  const r = I.searchCapabilities(metaSchemas, '')
  return r.every((g) => g.matchedTools === undefined)
})())
await ok('matchedTools 每组上限 5', (() => {
  const many = Array.from({ length: 8 }, (_, i) => ({ name: `mcp__github__tool_${i}_issue`, description: 'd', parameters: { properties: { x: {} } } }))
  const r = I.searchCapabilities(many, 'issue')
  const gh = r.find((g) => g.id === 'github')
  return gh !== undefined && gh.matchedTools.length === 5
})())
await ok('query 无命中 → 组不带 matchedTools（不返回空数组）', (() => {
  const r = I.searchCapabilities(metaSchemas, 'zzz_no_match')
  const gh = r.find((g) => g.id === 'github')
  return gh === undefined || gh.matchedTools === undefined
})())
await ok('新命名空间工具仍可被 call 代理（执行面动态,无需注册）', (async () => {
  mockSchemas = longTailSchemas.filter((s) => !s.name.startsWith('mcp__') && s.name !== 'custom_global_tool').map((s) => ({ ...s, parameters: { properties: { a: {} } } }))
  mockGlobalSchemas = longTailSchemas.filter((s) => s.name.startsWith('mcp__') || s.name === 'custom_global_tool').map((s) => ({ ...s, parameters: { properties: { a: {} } } }))
  executeCalls = []
  const r = await callTool.execute({ tool: 'mcp__linear__get_issue', arguments: {} })
  return r.ok === true && r.tool === 'mcp__linear__get_issue' && executeCalls.length === 1
})())

// ── 4. guidanceText ────────────────────────────────────────────────────────
section('guidanceText')
await ok('引导文本含工具名', I.guidanceText('mcp__github__x').includes('mcp__github__x'))
await ok('引导文本提示 capability_call', I.guidanceText('x').includes('kix_capability_call'))

// ── 5. 插件行为：search 工具 execute ─────────────────────────────────────
section('kix_capability_search.execute')
mockSchemas = [
  ...sampleSchemas.filter((s) => !s.name.startsWith('mcp__')).map((s) => ({ ...s, parameters: { properties: { a: {} } } })),
  { name: 'edit', description: 'Edit', parameters: { properties: {} } }, // 常驻 scope 工具（capability_call 应拒绝）
]
mockGlobalSchemas = sampleSchemas.filter((s) => s.name.startsWith('mcp__')).map((s) => ({ ...s, parameters: { properties: { a: {} } } }))
await ok('search 返回分组统计', (async () => {
  const r = await searchTool.execute({ query: 'github' })
  return r.ok === true && r.onDemandToolCount > 0 && r.groups.some((g) => g.id === 'github')
})())
await ok('search 空查询返回统计', (async () => {
  const r = await searchTool.execute({ query: '' })
  return r.ok === true && r.residentToolCount > 0 && r.onDemandToolCount > 0
})())

// ── 6. 插件行为：call 工具 execute ────────────────────────────────────────
section('kix_capability_call.execute')
await ok('代理调用按需工具 → execute 走管线', (async () => {
  executeCalls = []
  const r = await callTool.execute({ tool: 'mcp__github__get_issue', arguments: { owner: 'o', repo: 'r', issue_number: 1 } })
  return r.ok === true && r.tool === 'mcp__github__get_issue'
    && executeCalls.length === 1 && executeCalls[0].name === 'mcp__github__get_issue'
})())
await ok('嵌套调用传播 rootCallId（同一执行树）', (async () => {
  executeCalls = []
  await callTool.execute({ tool: 'mcp__github__get_issue', arguments: { owner: 'o' } }, { agent: { id: 'a' }, rootCallId: 'root-123', signal: undefined })
  return executeCalls.length === 1 && executeCalls[0].rootCallId === 'root-123'
})())
await ok('代理调用 scope 常驻工具(job_output) → 拒绝', (async () => {
  // scope 工具只在 agent 视图可见——必须带 exec.agent（真实运行时 executor 总会提供）
  const r = await callTool.execute({ tool: 'job_output', arguments: {} }, { agent: { id: 'a' } })
  return r.ok === false && String(r.error).includes('常驻')
})())
await ok('代理调用常驻工具 → 拒绝', (async () => {
  const r = await callTool.execute({ tool: 'edit', arguments: {} }, { agent: { id: 'a' } })
  return r.ok === false && String(r.error).includes('常驻')
})())
await ok('代理调用未知工具 → 报错', (async () => {
  const r = await callTool.execute({ tool: 'nonexistent_tool', arguments: {} })
  return r.ok === false && String(r.error).includes('不存在')
})())
await ok('缺 tool 名 → 报错', (async () => {
  const r = await callTool.execute({})
  return r.ok === false && String(r.error).includes('tool')
})())

// ── 7. 无 pre-execute 感知拦截（capability_call 内部子调用必须放行）──────
section('感知设计（不挂 pre-execute deny）')
await ok('不注册 pre-execute 拦截监听器', (() => {
  const pe = listeners['tools/pre-execute']
  return pe === undefined || pe.length === 0
})())
await ok('guidanceText 仍导出（供文档/返回使用）', I.guidanceText('x').includes('kix_capability_call'))

// ── 8. restrict 裁剪校验 ──────────────────────────────────────────────────
section('restrict 裁剪')
await ok('output.schema.type 合法(JsonSchemaType 枚举,防挂载失败回归)', (() => {
  const valid = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
  return registeredTools.every((t) => t.output && t.output.schema && valid.includes(t.output.schema.type))
})())
await ok('parameters 含顶层 type:object(register 原样投影,防 type:null 回归)', (() => {
  return registeredTools.every((t) => t.parameters && t.parameters.type === 'object' && t.parameters.properties !== undefined)
})())
await ok('restrict deny 裁剪 MCP 全局工具(deny 模式,allow 在 web 架构失效)', (() => {
  const deny = restrictCalls[0].deny
  return Array.isArray(deny) && deny.includes('mcp__github__get_issue')
})())
await ok('restrict deny 含 web_search(低频移出常驻)', (() => {
  // 全局视图需要含 web_search 才会被收集——追加后触发 tools/change
  if (!mockGlobalSchemas.some((s) => s.name === 'web_search')) {
    mockGlobalSchemas.push({ name: 'web_search', description: 'Search' })
    ;(listeners['tools/change'] || []).forEach((cb) => cb())
  }
  const last = restrictCalls[restrictCalls.length - 1]
  return Array.isArray(last.deny) && last.deny.includes('web_search')
})())
await ok('restrict deny 不含 scope-local 工具', (() => {
  const deny = restrictCalls[0].deny
  const scopeLocals = ['subagent', 'subagent_cross', 'subagent_lite', 'kix_capability_search', 'kix_capability_call', 'edit', 'read', 'pwsh']
  return deny.every((n) => !scopeLocals.includes(n))
})())
await ok('增量 deny:tools/change 后新注册 mcp__ 工具被追加', (() => {
  // 模拟 MCP 晚注册:全局视图追加 semgrep 工具 → 触发 tools/change
  mockGlobalSchemas.push({ name: 'mcp__semgrep__deprecation_notice', description: 'Deprecated' })
  const before = restrictCalls.length
  ;(listeners['tools/change'] || []).forEach((cb) => cb())
  const last = restrictCalls[restrictCalls.length - 1]
  return restrictCalls.length === before + 1
    && Array.isArray(last.deny) && last.deny.includes('mcp__semgrep__deprecation_notice')
    && !last.deny.includes('mcp__github__get_issue') // 增量:不重复 deny 已覆盖的
})())
await ok('RESTRICT_ALLOW 全部是全局工具名', (() => {
  const scopeLocals = ['subagent', 'subagent_fork', 'subagent_cross', 'subagent_lite', 'subagent_thinker', 'subagent_vision', 'kix_capability_search', 'kix_capability_call']
  return I.RESTRICT_ALLOW.every((n) => !scopeLocals.includes(n))
})())
await ok('RESIDENT_TOOLS 是 RESTRICT_ALLOW 超集', (() => {
  return I.RESTRICT_ALLOW.every((n) => I.RESIDENT_TOOLS.has(n))
})())

// ── 9. 按需激活（kix_tool_activate / kix_tool_deactivate）──────────────────
section('按需激活')
const activateTool = registeredTools.find((t) => t.name === 'kix_tool_activate')
const deactivateTool = registeredTools.find((t) => t.name === 'kix_tool_deactivate')
await ok('activate/deactivate 工具已注册', activateTool !== undefined && deactivateTool !== undefined)
await ok('ACTIVATABLE_TOOLS 含 workflow/goal/细分档位/reviewer/qa/dev(ralph/jobs 已移除)', (() => {
  return ['workflow', 'goal', 'subagent_lite', 'subagent_thinker', 'subagent_vision', 'subagent_fork', 'subagent_reviewer', 'subagent_qa', 'subagent_dev']
    .every((n) => I.ACTIVATABLE_TOOLS[n] && I.ACTIVATABLE_TOOLS[n].package)
    && I.ACTIVATABLE_TOOLS.ralph === undefined
    && I.ACTIVATABLE_TOOLS.jobs === undefined
})())
await ok('subagent_reviewer 激活配置含反方辩护三层 persona', (() => {
  const c = I.ACTIVATABLE_TOOLS.subagent_reviewer.config
  return c.toolName === 'subagent_reviewer'
    && c.persona.includes('adversarial reviewer')
    && c.persona.includes('L1 rebuttal rehearsal')
    && c.persona.includes('L2 depth probe')
    && c.persona.includes('L3 language-model stress')
    && c.persona.includes('rebuttal')
    && c.agentOptions.maxTokens === 65536
})())
await ok('subagent_qa 激活配置含 Ivy 契约（不写业务源码/证据门禁/REVERIFY）', (() => {
  const c = I.ACTIVATABLE_TOOLS.subagent_qa.config
  return c.toolName === 'subagent_qa'
    && c.persona.includes('Ivy')
    && c.persona.includes('never business source code')
    && c.persona.includes('Evidence gate')
    && c.persona.includes('REVERIFY_REQUIRED')
    && c.agentOptions.maxTokens === 65536
})())
await ok('subagent_dev 激活配置含三人合一契约（Nova/Sage/Milo/不替 QA 签署）', (() => {
  const c = I.ACTIVATABLE_TOOLS.subagent_dev.config
  return c.toolName === 'subagent_dev'
    && c.persona.includes('Nova') && c.persona.includes('Sage') && c.persona.includes('Milo')
    && c.persona.includes('target_rules')
    && c.persona.includes('Never sign QA verdicts')
    && c.agentOptions.maxTokens === 65536
})())
await ok('激活/卸载描述完整枚举 ACTIVATABLE_TOOLS（枚举 bug 回归防线：reviewer 曾漏）', (() => {
  const names = Object.keys(I.ACTIVATABLE_TOOLS)
  const actParam = activateTool.parameters.properties.tool.description
  const deaParam = deactivateTool.parameters.properties.tool.description
  // workflow 依赖 isolate realm 动态激活不可用 → 永不进入 activated 集合，
  // deactivate 不枚举它（激活描述仍提及并说明原因）。
  return names.every((n) => n === 'workflow'
    ? activateTool.description.includes(n)
    : activateTool.description.includes(n) && actParam.includes(n) && deaParam.includes(n))
})())
await ok('subagent_lite 激活配置含 toolName/toolFilter', (() => {
  const c = I.ACTIVATABLE_TOOLS.subagent_lite.config
  return c.toolName === 'subagent_lite' && Array.isArray(c.toolFilter.allow) && c.agentOptions.maxTokens === 8192
})())
await ok('jobs 已移出可激活清单（2026-08-17 常驻化，动态挂载会冲突）', I.ACTIVATABLE_TOOLS.jobs === undefined)
await ok('activationNote 文本引导 deactivate', I.activationNote('workflow').includes('kix_tool_deactivate'))
await ok('激活未知工具 → 报错', (async () => {
  const r = await activateTool.execute({ tool: 'nonexistent' })
  return r.ok === false && String(r.error).includes('不可按需激活')
})())
await ok('激活 workflow → ctx.plugin 挂载', (async () => {
  pluginCalls.length = 0
  const before = effectCalls.length
  const r = await activateTool.execute({ tool: 'workflow' })
  return r.ok === true && r.tool === 'workflow'
    && pluginCalls.length === 1 && pluginCalls[0].cfg && pluginCalls[0].cfg.subagentProvider === undefined
    && effectCalls.length === before // 回归防线：激活不得注册自动清理 effect
})())
await ok('激活 fiber 非 ACTIVE(PENDING,依赖服务不可达) → 回滚并报错', (async () => {
  fiberStateOverride = 0 // PENDING
  const beforeDispose = disposeCalls
  // 用尚未激活的 subagent_lite（workflow 已在上个用例激活，会命中"已激活"分支）
  const r = await activateTool.execute({ tool: 'subagent_lite' })
  fiberStateOverride = null
  return r.ok === false && String(r.error).includes('未生效')
    && disposeCalls === beforeDispose + 1 // 回滚：dispose 被调
    && r.tool === 'subagent_lite'
})())
await ok('重复激活 → 拒绝', (async () => {
  const r = await activateTool.execute({ tool: 'workflow' })
  return r.ok === false && String(r.error).includes('已激活')
})())
await ok('deactivate 未激活的工具 → 报错', (async () => {
  const r = await deactivateTool.execute({ tool: 'goal' })
  return r.ok === false && String(r.error).includes('未激活')
})())
await ok('deactivate 已激活 → dispose 被调', (async () => {
  const before = disposeCalls
  const r = await deactivateTool.execute({ tool: 'workflow' })
  return r.ok === true && disposeCalls === before + 1
})())
await ok('deactivate 后可重新激活', (async () => {
  const r = await activateTool.execute({ tool: 'workflow' })
  return r.ok === true
})())
await ok('激活 goal → 正常挂载', (async () => {
  pluginCalls.length = 0
  const r = await activateTool.execute({ tool: 'goal' })
  return r.ok === true && pluginCalls.length === 1
})())

// ── 9b. 首次使用自动激活（2026-08-17 决策 A+B：capability_call 代理即挂载）─
// 用户原则：机械无认知负担的工具常驻（jobs）；有认知负担的工具由机制自动激活
// （细分档位/goal）——模型无需记住先 kix_tool_activate，激活由机制兜底。
section('首次使用自动激活（capability_call 代理即挂载）')
await ok('job_list/job_kill 与 job_output 同为常驻集', !I.isOnDemand('job_list') && !I.isOnDemand('job_kill'))
await ok('activate/deactivate 描述与参数枚举不含 jobs（常驻化）', (() => {
  const actParam = activateTool.parameters.properties.tool.description
  const deaParam = deactivateTool.parameters.properties.tool.description
  return !actParam.includes('jobs') && !deaParam.includes('jobs') && !activateTool.description.includes(' / jobs')
})())
await ok('capability_call 首次调用细分档位 → 自动挂载并执行', (async () => {
  pluginCalls.length = 0
  executeCalls = []
  const before = effectCalls.length
  // 真实运行时 executor 总会带 exec.agent；agent 视图才看得到 scope 工具
  const r = await callTool.execute({ tool: 'subagent_qa', arguments: { prompt: 'verify' } }, { agent: { id: 'agent-1' } })
  return r.ok === true && r.tool === 'subagent_qa'
    && r.autoActivated === true && String(r.note).includes('首次使用自动激活')
    && pluginCalls.length === 1 && pluginCalls[0].cfg.toolName === 'subagent_qa'
    && executeCalls.length === 1 && executeCalls[0].name === 'subagent_qa'
    && effectCalls.length === before // 回归防线：自动激活同样不得注册自动清理 effect
})())
await ok('已自动激活后再次代理调用 → 不再挂载、直接执行', (async () => {
  pluginCalls.length = 0
  executeCalls = []
  const r = await callTool.execute({ tool: 'subagent_qa', arguments: {} }, { agent: { id: 'agent-1' } })
  return r.ok === true && r.autoActivated === undefined
    && pluginCalls.length === 0 && executeCalls.length === 1
})())
await ok('activationKeyFor：goal 工具名 → goal 激活键（工具名≠激活名映射）', (() => {
  return I.activationKeyFor('create_goal') === 'goal'
    && I.activationKeyFor('update_goal') === 'goal'
    && I.activationKeyFor('get_goal') === 'goal'
    && I.activationKeyFor('subagent_qa') === 'subagent_qa'
    && I.activationKeyFor('workflow') === 'workflow'
    && I.activationKeyFor('job_output') === null
    && I.activationKeyFor('nonexistent') === null
})())
await ok('capability_call 首次调用 goal（create_goal）→ 自动挂载并执行', (async () => {
  // 前置：section 9 已显式激活 goal（activated 键 'goal'，挂载即注册 create_goal）
  // → 先卸载还原未挂载态，才能测自动激活路径
  await deactivateTool.execute({ tool: 'goal' })
  pluginCalls.length = 0
  executeCalls = []
  const r = await callTool.execute({ tool: 'create_goal', arguments: { objective: 'x' } }, { agent: { id: 'agent-1' } })
  return r.ok === true && r.autoActivated === true
    && pluginCalls.length === 1 && pluginCalls[0].pkg === '@deepseek-ai/dsh-tool-goal'
    && executeCalls.length === 1 && executeCalls[0].name === 'create_goal'
})())
await ok('已挂载的常驻工具仍拒绝代理（job_output 常驻）', (async () => {
  const r = await callTool.execute({ tool: 'job_output', arguments: {} }, { agent: { id: 'agent-1' } })
  return r.ok === false && String(r.error).includes('常驻')
})())
await ok('自动激活后可用 kix_tool_deactivate 卸载', (async () => {
  const before = disposeCalls
  const r = await deactivateTool.execute({ tool: 'subagent_qa' })
  return r.ok === true && disposeCalls === before + 1
})())
await ok('卸载后再代理调用 → 重新自动挂载', (async () => {
  pluginCalls.length = 0
  executeCalls = []
  const r = await callTool.execute({ tool: 'subagent_qa', arguments: {} }, { agent: { id: 'agent-1' } })
  return r.ok === true && r.autoActivated === true && pluginCalls.length === 1
})())
await ok('自动激活 fiber 非 ACTIVE → 回滚报错且不执行', (async () => {
  fiberStateOverride = 0 // PENDING（依赖服务不可达，如 workflow 的 isolate realm）
  const beforeDispose = disposeCalls
  executeCalls = []
  const r = await callTool.execute({ tool: 'subagent_lite', arguments: {} }, { agent: { id: 'agent-1' } })
  fiberStateOverride = null
  return r.ok === false && String(r.error).includes('未生效')
    && disposeCalls === beforeDispose + 1 && executeCalls.length === 0
})())

// ── 10. 跨平台包解析（2026-08-17 WSL2 E2E 发现的 symlink 部署 bug）────────
// 场景：dsh 以符号链接安装（/usr/local/bin/dsh → …/dsh/lib/bin.js），Node
// 模块解析不跟随 symlink → createRequire(argv[1]) 沿错误根解析全部落空。
// 修复 = 候选根链（argv[1] → realpath → __filename）。此处用临时目录 +
// symlink（Linux）/ junction（Windows，免管理员）复现该布局做端到端断言。
section('跨平台包解析（symlink 部署）')
const fsSync = require('node:fs')
const osMod = require('node:os')
await ok('resolveEntryCandidates: entry 首位、插件文件兜底在链内', (() => {
  // 注意：链内 __filename 是插件模块自己的（kix-focus.js），非本测试文件
  const c = I.resolveEntryCandidates('/some/entry.js')
  const pluginFile = path.resolve(__dirname, 'kix-focus.js')
  return c[0] === '/some/entry.js' && c.includes(pluginFile)
})())
await ok('resolveEntryCandidates: 非 symlink entry 去重（realpath 同值不重复）', (() => {
  const pluginFile = path.resolve(__dirname, 'kix-focus.js')
  const c = I.resolveEntryCandidates(pluginFile)
  return c.filter((x) => x === pluginFile).length === 1
})())
await ok('symlink 部署（WSL2 实测 bug 场景）: realpath 候选解析成功', (() => {
  const tmp = fsSync.mkdtempSync(path.join(osMod.tmpdir(), 'kix-focus-res-'))
  const pkgRoot = path.join(tmp, 'dsh-install')
  const nm = path.join(pkgRoot, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent')
  fsSync.mkdirSync(nm, { recursive: true })
  fsSync.writeFileSync(path.join(nm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tool-subagent', version: '0.0.0-test', main: 'index.js' }))
  fsSync.writeFileSync(path.join(nm, 'index.js'), 'module.exports = { __resolverTest: true }')
  const linkDir = path.join(tmp, 'bin-link')
  try {
    fsSync.symlinkSync(pkgRoot, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    // 极少数受限制环境无法创建任何链接 → 本断言退化为记录性跳过（不判失败，
    // 但也不计通过语义的损失：链式回退行为已由下一断言覆盖）
    return I.resolveEntryCandidates('/x').length >= 2
  }
  // 复现：argv[1] = 链接路径下的入口（Node 解析不跟随链接）
  const linkEntry = path.join(linkDir, 'dsh')
  const realEntry = path.join(pkgRoot, 'dsh')
  fsSync.writeFileSync(realEntry, '// entry')
  const c = I.resolveEntryCandidates(linkEntry)
  const viaRealpath = c.includes(realEntry)
  const savedArgv1 = process.argv[1]
  process.argv[1] = linkEntry
  let resolved = null
  try {
    const mod = I.defaultResolvePkg('@deepseek-ai/dsh-tool-subagent')
    resolved = mod && mod.__resolverTest === true
  } catch {
    resolved = false
  } finally {
    process.argv[1] = savedArgv1
  }
  fsSync.rmSync(tmp, { recursive: true, force: true })
  return viaRealpath && resolved === true
})())
await ok('全候选落空 → 抛最后错误（不静默 undefined）', (() => {
  const savedArgv1 = process.argv[1]
  process.argv[1] = '/nonexistent-root/entry.js'
  let threw = false
  try { I.defaultResolvePkg('@deepseek-ai/definitely-not-installed-xyz') } catch { threw = true }
  process.argv[1] = savedArgv1
  return threw
})())

// ── 汇总 ──
console.log('\n──────────────────────────────')
console.log(`kix-focus: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
})().catch((e) => { console.error('kix-focus.test 异常:', e); process.exit(1) })
