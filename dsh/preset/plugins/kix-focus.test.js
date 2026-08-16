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
const configMock = { resolvePkg: (pkgName) => ({ fake: pkgName }) }
const registeredTools = []
let restrictCalls = []
let executeCalls = []
let mockSchemas = []
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
    pluginCalls.push({ pkg, cfg })
    return { dispose: async () => { disposeCalls++ }, state: fiberStateOverride !== null ? fiberStateOverride : 2 }
  },
}
ctx.tools = {
  register(def) { registeredTools.push(def); return () => {} },
  restrict(filter) { restrictCalls.push(filter); return () => {} },
  schemas() { return mockSchemas },
  get(name) {
    // 模拟：常驻工具 + 按需工具都"存在"于注册表
    return mockSchemas.find((s) => s.name === name) ? { name } : undefined
  },
  async execute(input) { executeCalls.push(input); return { isError: false, value: { executed: input.name } } },
}

// ── 加载被测试插件 ────────────────────────────────────────────────────────
const plugin = require(path.join(__dirname, 'kix-focus.js'))
assert.strictEqual(plugin.name, 'kix-focus')
// 预置工具 schema（apply 时 restrict 需要看到已注册工具）
mockSchemas = [
  { name: 'edit', description: 'Edit' }, { name: 'read', description: 'Read' },
  { name: 'subagent', description: 'Sub' }, { name: 'ask_user_question', description: 'Ask' },
  { name: 'pwsh', description: 'Shell' },
  { name: 'mcp__github__get_issue', description: 'Issue' },
  { name: 'workflow', description: 'Flow' },
  { name: 'job_output', description: 'Job' },
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
function ok(label, cond) {
  if (cond) { passed++ } else { failed++ }
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
}
function section(title) { console.log('\n── ' + title + ' ──') }

// ── 1. 纯逻辑：isOnDemand / RESIDENT_TOOLS ────────────────────────────────
section('isOnDemand / 常驻集')
ok('edit 常驻', I.RESIDENT_TOOLS.has('edit'))
ok('read 常驻', I.RESIDENT_TOOLS.has('read'))
ok('subagent 常驻', I.RESIDENT_TOOLS.has('subagent'))
ok('subagent_cross 常驻', I.RESIDENT_TOOLS.has('subagent_cross'))
ok('subagent_lite 未挂载(渐进面,默认 disabled)', I.isOnDemand('subagent_lite'))
ok('subagent_fork 未挂载(渐进面,默认 disabled)', I.isOnDemand('subagent_fork'))
ok('ask_user_question 常驻', I.RESIDENT_TOOLS.has('ask_user_question'))
ok('kix_capability_search 常驻', I.RESIDENT_TOOLS.has('kix_capability_search'))
ok('mcp__github__get_issue 按需', I.isOnDemand('mcp__github__get_issue'))
ok('web_search 按需(低频,移出常驻)', I.isOnDemand('web_search'))
ok('read_image 按需', I.isOnDemand('read_image'))
ok('workflow 常驻(临时启用,自发使用测试中)', !I.isOnDemand('workflow'))
ok('create_goal 未挂载(默认 disabled,不在常驻集)', I.isOnDemand('create_goal'))
ok('job_output 未挂载(渐进面,默认 disabled)', I.isOnDemand('job_output'))
ok('list_agents 常驻(scope 自动可见)', !I.isOnDemand('list_agents'))
ok('edit 非按需', !I.isOnDemand('edit'))

// ── 2. 纯逻辑：projectToolMeta ────────────────────────────────────────────
section('projectToolMeta')
ok('投影轻量元数据', (() => {
  const meta = I.projectToolMeta([
    { name: 'mcp__github__get_issue', description: 'Get details of an issue', parameters: { properties: { owner: {}, issue_number: {} } } },
  ])
  return meta.length === 1 && meta[0].name === 'mcp__github__get_issue'
    && Array.isArray(meta[0].parameters) && meta[0].parameters.includes('owner')
    && meta[0].description.length <= 140
})())
ok('nameFilter 过滤', (() => {
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
ok('空查询返回全部类别', (() => {
  const r = I.searchCapabilities(sampleSchemas, '')
  return r.some((g) => g.id === 'github') && r.some((g) => g.id === 'orchestration') && r.some((g) => g.id === 'jobs')
})())
ok('查询 github 只返回 github 组', (() => {
  const r = I.searchCapabilities(sampleSchemas, 'github')
  return r.every((g) => g.id === 'github') && r[0].toolCount === 3
})())
ok('查询 workflow 返回编排组', (() => {
  const r = I.searchCapabilities(sampleSchemas, 'workflow')
  return r.some((g) => g.id === 'orchestration')
})())
ok('组内 exampleTools 截断 3 个', (() => {
  const r = I.searchCapabilities(sampleSchemas, '')
  const gh = r.find((g) => g.id === 'github')
  return gh.exampleTools.length === 3
})())

// ── 4. guidanceText ────────────────────────────────────────────────────────
section('guidanceText')
ok('引导文本含工具名', I.guidanceText('mcp__github__x').includes('mcp__github__x'))
ok('引导文本提示 capability_call', I.guidanceText('x').includes('kix_capability_call'))

// ── 5. 插件行为：search 工具 execute ─────────────────────────────────────
section('kix_capability_search.execute')
mockSchemas = sampleSchemas.map((s) => ({ ...s, parameters: { properties: { a: {} } } }))
ok('search 返回分组统计', (async () => {
  const r = await searchTool.execute({ query: 'github' })
  return r.ok === true && r.onDemandToolCount > 0 && r.groups.some((g) => g.id === 'github')
})())
ok('search 空查询返回统计', (async () => {
  const r = await searchTool.execute({ query: '' })
  return r.ok === true && r.residentToolCount > 0 && r.onDemandToolCount > 0
})())

// ── 6. 插件行为：call 工具 execute ────────────────────────────────────────
section('kix_capability_call.execute')
ok('代理调用按需工具 → execute 走管线', (async () => {
  executeCalls = []
  const r = await callTool.execute({ tool: 'mcp__github__get_issue', arguments: { owner: 'o', repo: 'r', issue_number: 1 } })
  return r.ok === true && r.tool === 'mcp__github__get_issue'
    && executeCalls.length === 1 && executeCalls[0].name === 'mcp__github__get_issue'
})())
ok('嵌套调用传播 rootCallId（同一执行树）', (async () => {
  executeCalls = []
  await callTool.execute({ tool: 'mcp__github__get_issue', arguments: { owner: 'o' } }, { agent: { id: 'a' }, rootCallId: 'root-123', signal: undefined })
  return executeCalls.length === 1 && executeCalls[0].rootCallId === 'root-123'
})())
ok('代理调用 scope 常驻工具(job_output) → 拒绝', (async () => {
  const r = await callTool.execute({ tool: 'job_output', arguments: {} })
  return r.ok === false && String(r.error).includes('常驻')
})())
ok('代理调用常驻工具 → 拒绝', (async () => {
  const r = await callTool.execute({ tool: 'edit', arguments: {} })
  return r.ok === false && String(r.error).includes('常驻')
})())
ok('代理调用未知工具 → 报错', (async () => {
  const r = await callTool.execute({ tool: 'nonexistent_tool', arguments: {} })
  return r.ok === false && String(r.error).includes('不存在')
})())
ok('缺 tool 名 → 报错', (async () => {
  const r = await callTool.execute({})
  return r.ok === false && String(r.error).includes('tool')
})())

// ── 7. 无 pre-execute 感知拦截（capability_call 内部子调用必须放行）──────
section('感知设计（不挂 pre-execute deny）')
ok('不注册 pre-execute 拦截监听器', (() => {
  const pe = listeners['tools/pre-execute']
  return pe === undefined || pe.length === 0
})())
ok('guidanceText 仍导出（供文档/返回使用）', I.guidanceText('x').includes('kix_capability_call'))

// ── 8. restrict 裁剪校验 ──────────────────────────────────────────────────
section('restrict 裁剪')
ok('output.schema.type 合法(JsonSchemaType 枚举,防挂载失败回归)', (() => {
  const valid = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
  return registeredTools.every((t) => t.output && t.output.schema && valid.includes(t.output.schema.type))
})())
ok('parameters 含顶层 type:object(register 原样投影,防 type:null 回归)', (() => {
  return registeredTools.every((t) => t.parameters && t.parameters.type === 'object' && t.parameters.properties !== undefined)
})())
ok('restrict deny 裁剪 MCP 全局工具(deny 模式,allow 在 web 架构失效)', (() => {
  const deny = restrictCalls[0].deny
  return Array.isArray(deny) && deny.includes('mcp__github__get_issue')
})())
ok('restrict deny 含 web_search(低频移出常驻)', (() => {
  // mockSchemas 需要含 web_search 才会被收集——追加后触发 tools/change
  if (!mockSchemas.some((s) => s.name === 'web_search')) {
    mockSchemas.push({ name: 'web_search', description: 'Search' })
    ;(listeners['tools/change'] || []).forEach((cb) => cb())
  }
  const last = restrictCalls[restrictCalls.length - 1]
  return Array.isArray(last.deny) && last.deny.includes('web_search')
})())
ok('restrict deny 不含 scope-local 工具', (() => {
  const deny = restrictCalls[0].deny
  const scopeLocals = ['subagent', 'subagent_cross', 'subagent_lite', 'kix_capability_search', 'kix_capability_call', 'edit', 'read', 'pwsh']
  return deny.every((n) => !scopeLocals.includes(n))
})())
ok('增量 deny:tools/change 后新注册 mcp__ 工具被追加', (() => {
  // 模拟 MCP 晚注册:mockSchemas 追加 semgrep 工具 → 触发 tools/change
  mockSchemas.push({ name: 'mcp__semgrep__deprecation_notice', description: 'Deprecated' })
  const before = restrictCalls.length
  ;(listeners['tools/change'] || []).forEach((cb) => cb())
  const last = restrictCalls[restrictCalls.length - 1]
  return restrictCalls.length === before + 1
    && Array.isArray(last.deny) && last.deny.includes('mcp__semgrep__deprecation_notice')
    && !last.deny.includes('mcp__github__get_issue') // 增量:不重复 deny 已覆盖的
})())
ok('RESTRICT_ALLOW 全部是全局工具名', (() => {
  const scopeLocals = ['subagent', 'subagent_fork', 'subagent_cross', 'subagent_lite', 'subagent_thinker', 'subagent_vision', 'kix_capability_search', 'kix_capability_call']
  return I.RESTRICT_ALLOW.every((n) => !scopeLocals.includes(n))
})())
ok('RESIDENT_TOOLS 是 RESTRICT_ALLOW 超集', (() => {
  return I.RESTRICT_ALLOW.every((n) => I.RESIDENT_TOOLS.has(n))
})())

// ── 9. 按需激活（kix_tool_activate / kix_tool_deactivate）──────────────────
section('按需激活')
const activateTool = registeredTools.find((t) => t.name === 'kix_tool_activate')
const deactivateTool = registeredTools.find((t) => t.name === 'kix_tool_deactivate')
ok('activate/deactivate 工具已注册', activateTool !== undefined && deactivateTool !== undefined)
ok('ACTIVATABLE_TOOLS 含 workflow/goal/细分档位/jobs(ralph 已移除)', (() => {
  return ['workflow', 'goal', 'subagent_lite', 'subagent_thinker', 'subagent_vision', 'subagent_fork', 'jobs']
    .every((n) => I.ACTIVATABLE_TOOLS[n] && I.ACTIVATABLE_TOOLS[n].package)
    && I.ACTIVATABLE_TOOLS.ralph === undefined
})())
ok('subagent_lite 激活配置含 toolName/toolFilter', (() => {
  const c = I.ACTIVATABLE_TOOLS.subagent_lite.config
  return c.toolName === 'subagent_lite' && Array.isArray(c.toolFilter.allow) && c.agentOptions.maxTokens === 8192
})())
ok('jobs 激活指向 dsh-tool-jobs', I.ACTIVATABLE_TOOLS.jobs.package === '@deepseek-ai/dsh-tool-jobs')
ok('activationNote 文本引导 deactivate', I.activationNote('workflow').includes('kix_tool_deactivate'))
ok('激活未知工具 → 报错', (async () => {
  const r = await activateTool.execute({ tool: 'nonexistent' })
  return r.ok === false && String(r.error).includes('不可按需激活')
})())
ok('激活 workflow → ctx.plugin 挂载', (async () => {
  pluginCalls.length = 0
  const before = effectCalls.length
  const r = await activateTool.execute({ tool: 'workflow' })
  return r.ok === true && r.tool === 'workflow'
    && pluginCalls.length === 1 && pluginCalls[0].cfg && pluginCalls[0].cfg.subagentProvider === undefined
    && effectCalls.length === before // 回归防线：激活不得注册自动清理 effect
})())
ok('激活 fiber 非 ACTIVE(PENDING,依赖服务不可达) → 回滚并报错', (async () => {
  fiberStateOverride = 0 // PENDING
  const beforeDispose = disposeCalls
  const r = await activateTool.execute({ tool: 'workflow' })
  fiberStateOverride = null
  return r.ok === false && String(r.error).includes('未生效')
    && disposeCalls === beforeDispose + 1 // 回滚：dispose 被调
    && r.tool === 'workflow'
})())
ok('重复激活 → 拒绝', (async () => {
  const r = await activateTool.execute({ tool: 'workflow' })
  return r.ok === false && String(r.error).includes('已激活')
})())
ok('deactivate 未激活的工具 → 报错', (async () => {
  const r = await deactivateTool.execute({ tool: 'goal' })
  return r.ok === false && String(r.error).includes('未激活')
})())
ok('deactivate 已激活 → dispose 被调', (async () => {
  const before = disposeCalls
  const r = await deactivateTool.execute({ tool: 'workflow' })
  return r.ok === true && disposeCalls === before + 1
})())
ok('deactivate 后可重新激活', (async () => {
  const r = await activateTool.execute({ tool: 'workflow' })
  return r.ok === true
})())
ok('激活 goal → 正常挂载', (async () => {
  pluginCalls.length = 0
  const r = await activateTool.execute({ tool: 'goal' })
  return r.ok === true && pluginCalls.length === 1
})())

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────')
console.log(`kix-focus: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
