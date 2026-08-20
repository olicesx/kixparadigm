// kix-budget 回归测试（v6，2026-08-18）
//
// 单元级验证：加载 kix-budget.js，mock cordis ctx（on/effect/get）与
// tokenMeter/toolResultPruner/llm 服务，覆盖：
//   - 预算解析：按窗口分档（≤128K→0.85；≤400K→0.65；≤1M→0.40；>1M→0.35，
//     v1.2.21 完全动态化：默认帽废止）——窗口由运行时模型信息解析、
//     无窗口回退绝对帽
//   - 只读分类：grep/cat/管道组合 → true；重定向/git 写子命令/python/
//     node → false（马拉松实测 python3 heredoc 全在写文件）
//   - streak 门禁：连续 8 步只读 → 注入一次 ⑳ 建议，第 9 步不重复
//   - 预算建议：ctx ≥ 预算 → 注入一次 ㉑ 建议（优先于 streak）；纯散文
//     回合走 turn-stopping steer 通道
//   - 急剪：单结果超过宿主字符阈值或 ctx ≥ 50% 预算 → pre-step 调 pruneSession
//   - 主会话 context>动态预算，或动态计量不可用且 step>40 → 硬门禁，
//     foreground 交接（lite/goal/dev·qa·reviewer）解除；gate 期后台 transition 被拒
//   - turn/start 重置回合内状态
// 运行：node plugins/kix-budget.test.js

const path = require('node:path')
const assert = require('node:assert')

// ── mock ctx ────────────────────────────────────────────────────────────────
const listeners = {}
const services = {}
const logs = []
const ctx = {
  logger: { info(m) { logs.push(m) }, warn(m) { logs.push('W:' + m) }, error(m) { logs.push('E:' + m) } },
  on(event, cb) {
    ;(listeners[event] ||= []).push(cb)
  },
  effect(fn) { this.cleanup = fn },
  get(name) {
    return services[name]
  },
}

// ── 加载被测试插件 ────────────────────────────────────────────────────────
const plugin = require(path.join(__dirname, 'kix-budget.js'))
assert.strictEqual(plugin.name, 'kix-budget')
plugin.apply(ctx)
for (const ev of ['session/event', 'agent/pre-step', 'tools/pre-execute', 'tools/post-execute', 'agent/turn-stopping']) {
  assert.ok(listeners[ev] && listeners[ev].length === 1, `${ev} 监听器已注册`)
}

const I = plugin.__internals

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++; console.log('  ✓ ' + label) }
  else { failed++; console.log('  ✗ ' + label) }
}

// ── 纯逻辑 ────────────────────────────────────────────────────────────────
console.log('== 预算解析 ==')
check('resolveBudgetTokens: 1M 窗口 → 400K 纯分档（v1.2.21 完全动态化：默认帽废止）', I.resolveBudgetTokens(1000000, I.DEFAULTS) === 400000)
check('resolveBudgetTokens: 128K 窗口 → 111411 按比例', I.resolveBudgetTokens(131072, I.DEFAULTS) === 111411)
check('resolveBudgetTokens: 400K 窗口 → 260K 按比例（分档变更：由0.30→0.65）', I.resolveBudgetTokens(400000, I.DEFAULTS) === 260000)
check('resolveBudgetTokens: 无窗口 → 回退 absoluteCapTokens', I.resolveBudgetTokens(undefined, I.DEFAULTS) === 150000)
check('resolveBudgetTokens: 300K 窗口 → 195K 按比例（分档：0.65）', I.resolveBudgetTokens(300000, I.DEFAULTS) === 195000)
check('resolveBudgetTokens: 800K 窗口 → 320K（v1.2.21 完全动态化：0.40 新档、默认帽废止）', I.resolveBudgetTokens(800000, I.DEFAULTS) === 320000)
check('resolveBudgetTokens: 1M 边界 1048576 → 419430（0.40 档）', I.resolveBudgetTokens(1048576, I.DEFAULTS) === 419430)
check('resolveBudgetTokens: 2M 窗口 2097152 → 734003（0.35 档，无帽截断）', I.resolveBudgetTokens(2097152, I.DEFAULTS) === 734003)
check('resolveBudgetTokens: 1.5M 窗口 1500000 → 525000（0.35 档，无帽截断；v1.2.21 完全动态化：默认帽废止）', I.resolveBudgetTokens(1500000, I.DEFAULTS) === 525000)
check('resolveBudgetTokens: 显式 budgetRatio=0.4 + 1M 窗口 → 400K 配置覆盖', I.resolveBudgetTokens(1000000, { budgetRatio: 0.4 }) === 400000)
check('main agent depth 0', I.isMainAgent({ options: { subagentDepth: 0 } }) === true)
check('child agent depth 1', I.isMainAgent({ options: { subagentDepth: 1 } }) === false)
check('header depth 0 identifies main', I.isMainAgent({ options: {}, session: { header: { delegationDepth: 0 } } }) === true)
check('header missing depth follows host top-level default', I.isMainAgent({ options: {}, session: { header: {} } }) === true)
check('header depth 1 identifies child', I.isMainAgent({ options: {}, session: { header: { delegationDepth: 1 } } }) === false)
check('missing depth fails open', I.isMainAgent({ options: {} }) === false)

console.log('== 只读分类 ==')
check('grep → 只读', I.isReadOnlyCommand('grep -rn foo src/') === true)
check('cd && grep 管道 head → 只读', I.isReadOnlyCommand('cd /tmp/x && grep -c todo f | head -5') === true)
check('cat → 只读', I.isReadOnlyCommand('cat a.txt') === true)
check('git log → 只读', I.isReadOnlyCommand('git log --oneline -3') === true)
check('echo 重定向 → 非只读', I.isReadOnlyCommand('echo hi > f') === false)
check('git commit → 非只读', I.isReadOnlyCommand('git add -A && git commit -m x') === false)
check('python3 heredoc → 非只读（马拉松写文件形态）', I.isReadOnlyCommand("python3 - <<'PY'\nwrite\nPY") === false)
check('node 脚本 → 非只读', I.isReadOnlyCommand('node scripts/x.js') === false)
check('npm test → 非只读（保守）', I.isReadOnlyCommand('npm test') === false)
check('sed -i → 非只读', I.isReadOnlyCommand('sed -i s/a/b/ f') === false)
check('2>/dev/null 不误伤 grep', I.isReadOnlyCommand('grep -rn x src 2>/dev/null') === true)
check('git config 写操作 → 非只读', I.isReadOnlyCommand('git config user.name test') === false)
check('git branch 写操作 → 非只读', I.isReadOnlyCommand('git branch new-branch') === false)
check('git tag 写操作 → 非只读', I.isReadOnlyCommand('git tag v1.0') === false)
check('git remote 写操作 → 非只读', I.isReadOnlyCommand('git remote add upstream https://x') === false)
check('git update-ref 写操作 → 非只读', I.isReadOnlyCommand('git update-ref refs/heads/x abc') === false)
check('git tag --list 保守否决（㉒权衡：子命令级正则不分读写形态）', I.isReadOnlyCommand('git tag --list') === false)
check('git remote -v 保守否决（同上）', I.isReadOnlyCommand('git remote -v') === false)
check('read 工具 → 只读', I.isReadOnlyTool('read', {}) === true)
check('bash cat → 只读', I.isReadOnlyTool('bash', { command: 'cat f' }) === true)
check('bash npm install → 非只读', I.isReadOnlyTool('bash', { command: 'npm install' }) === false)
check('edit 工具 → 非只读', I.isReadOnlyTool('edit', {}) === false)
check('background lite 不完成交接', I.transitionCompletesHandoff({ name: 'subagent_lite', arguments: { run_in_background: true } }) === false)
check('foreground lite 完成交接', I.transitionCompletesHandoff({ name: 'subagent_lite', arguments: { run_in_background: false } }) === true)
check('proxy foreground lite 完成交接', I.transitionCompletesHandoff({ name: 'kix_capability_call', arguments: { tool: 'subagent_lite', arguments: { run_in_background: false } } }) === true)
check('create_goal 完成交接', I.transitionCompletesHandoff({ name: 'create_goal', arguments: {} }) === true)

// ── v7 编曲保育（2026-08-19）：gate 定价中立，不干预成员选择 ─────────────
check('HANDOFF_TARGETS 含全部角色档', I.HANDOFF_TARGETS.has('subagent_dev') && I.HANDOFF_TARGETS.has('subagent_qa') && I.HANDOFF_TARGETS.has('subagent_reviewer'))
check('foreground dev 完成交接', I.transitionCompletesHandoff({ name: 'subagent_dev', arguments: { run_in_background: false } }) === true)
check('foreground qa 完成交接', I.transitionCompletesHandoff({ name: 'subagent_qa', arguments: { run_in_background: false } }) === true)
check('foreground reviewer 完成交接', I.transitionCompletesHandoff({ name: 'subagent_reviewer', arguments: { run_in_background: false } }) === true)
check('background dev 不完成交接', I.transitionCompletesHandoff({ name: 'subagent_dev', arguments: { run_in_background: true } }) === false)
check('proxy foreground qa 完成交接', I.transitionCompletesHandoff({ name: 'kix_capability_call', arguments: { tool: 'subagent_qa', arguments: { run_in_background: false } } }) === true)
check('gate 期角色档激活属于发现（放行不 deny）', I.isHandoffDiscovery({ name: 'kix_tool_activate', arguments: { tool: 'subagent_dev' } }) === true)
check('gate 期 goal 激活仍属发现', I.isHandoffDiscovery({ name: 'kix_tool_activate', arguments: { tool: 'goal' } }) === true)
check('gate 期无关激活不属于发现', I.isHandoffDiscovery({ name: 'kix_tool_activate', arguments: { tool: 'browser' } }) === false)
{
  const streak = I.streakAdviceText(8)
  const routed = /(?:subagent_)?(?:lite|dev|qa|reviewer)|create_goal|\bgoal\b|kixpower|capability_call|capability_search/
  check('streak 标明收敛建议而非交接', streak.includes('收敛建议') && streak.includes('不是交接完成') === true)
  check('streak 直接作答合法', streak.includes('可结算主张') && streak.includes('合法动作') === true)
  check('streak 判断留主线程且不重复', streak.includes('判断与编排留在主线程') && streak.includes('本回合不再重复提醒') === true)
  check('streak 不点名成员', routed.test(streak) === false)
}
check('文案含重路径菜单（gate）', I.handoffText({ handoffReason: 'context', handoffBudget: 400000, handoffStep: 41 }).includes('subagent_dev') === true)
check('文案中立声明（gate）', I.handoffText({ handoffReason: 'context', handoffBudget: 400000, handoffStep: 41 }).includes('成员选择是编曲决策') === true)
{
  const ctxAdvice = I.contextAdviceText(420000, 400000)
  const routed = /(?:subagent_)?(?:lite|dev|qa|reviewer)|create_goal|\bgoal\b|kixpower|capability_call|capability_search/
  check('context 提醒含预算数字', ctxAdvice.includes('420K') && ctxAdvice.includes('400K') === true)
  check('context 直接作答合法', ctxAdvice.includes('可结算主张') && ctxAdvice.includes('合法动作') === true)
  check('context 不点名成员', routed.test(ctxAdvice) === false)
}
check('unrelated proxy argument substring 不算 transition', I.transitionToolOf({ name: 'kix_capability_call', arguments: { tool: 'web_search', arguments: { query: 'subagent_lite' } } }) === undefined)
check('structured status: top-level success wins over report evidence', I.structuredResultStatus({ ok: true, result: 'report cites {"ok":false}' }) === 'success')
check('structured status: canonical isError=false is success', I.structuredResultStatus({ isError: false, content: 'report' }) === 'success')
check('structured status: nested report object is ignored', I.structuredResultStatus({ content: [{ ok: false }] }) === 'unknown')
check('structured status: prose containing failure sample is unknown', I.structuredResultStatus('report cites {"ok":false}') === 'unknown')
check('structured status: complete failure envelope is failure', I.structuredResultStatus('{"ok":false,"error":"x"}') === 'failure')
check('proxy status: canonical value envelope controls success', I.transitionResultStatus({ name: 'kix_capability_call' }, { isError: false, value: { ok: true } }) === 'success')
check('proxy status: canonical value envelope controls failure', I.transitionResultStatus({ name: 'kix_capability_call' }, { isError: false, value: { ok: false } }) === 'failure')
check('proxy status: real DSH canonical wrapper unlocks foreground lite', I.transitionResultStatus({ name: 'kix_capability_call' }, { isError: false, value: { ok: true, tool: 'subagent_lite', result: { isError: false, value: { kind: 'foreground', output: [] } } } }) === 'success')
check('event status: rendered complete envelope is success', I.toolResultEventStatus({ message: { content: [{ content: [{ type: 'text', text: '{"ok":true}' }] }] } }) === 'success')
check('rendered status: cyclic content fails closed without throw', (() => { const value = {}; value.content = value; return I.toolResultEventStatus({ message: { content: value } }) === 'unknown' })())
check('rendered status: over-deep content fails closed without throw', (() => { let value = { text: 'plain' }; for (let i = 0; i < 20; i++) value = { content: value }; return I.toolResultEventStatus({ message: { content: value } }) === 'unknown' })())
check('proxy status: prose without envelope stays unknown', I.transitionResultStatus({ name: 'kix_capability_call' }, { isError: false, content: [{ type: 'text', text: 'plain report' }] }) === 'unknown')

// ── 派发模拟 ──────────────────────────────────────────────────────────────
function makeAgent(sessionId, provider, model, depth = 0) {
  return {
    id: 'agent-' + sessionId,
    options: { subagentDepth: depth },
    session: {
      id: sessionId,
      requestHeader() {
        return { config: { provider, model } }
      },
    },
    steered: [],
    steer(msg) { this.steered.push(msg) },
  }
}
const mainAgent = makeAgent('s-main', 'zai-coding-cn', 'glm-5.3')
// 1M 窗口 → 预算 400K（0.40 档，v1.2.21 完全动态化）；prune 触发线 = 200K
services.llm = {
  resolveModelInfo: async (provider, model) => {
    if (model === 'glm-5.3') return { context: { contextWindow: 1000000 } }
    if (model === 'small-128k') return { context: { contextWindow: 131072 } }
    throw new Error('unknown')
  },
}

async function postExec(agent, name, args, result = { isError: false }) {
  const decision = await listeners['tools/post-execute'][0](
    { name, arguments: args, agent },
    result,
    async () => ({ kind: 'accept' }),
  )
  return decision
}
async function preGate(agent, name, args) {
  return listeners['tools/pre-execute'][0](
    { name, arguments: args, agent },
    async () => ({ kind: 'allow' }),
  )
}
async function preStep(agent, step) {
  return listeners['agent/pre-step'][0](
    { agent, turn: 1, step },
    async () => ({ kind: 'enter', messages: [] }),
  )
}
function appendedText(decision) {
  try {
    const c = decision && decision.additionalContexts && decision.additionalContexts[0]
    return c && c.content && c.content[0] && c.content[0].text
  } catch { return undefined }
}

async function main() {
  console.log('== streak 门禁（㉒）==')
  listeners['session/event'][0](mainAgent.session, { type: 'turn/start', data: { turn: 1 } })
  let d = null
  for (let i = 1; i <= 7; i++) d = await postExec(mainAgent, 'bash', { command: 'cat file' + i })
  check('第 7 步只读：无建议（阈值 8 未到）', appendedText(d) === undefined)
  d = await postExec(mainAgent, 'bash', { command: 'cat file8' })
  const t8 = appendedText(d)
  check('第 8 步只读：注入收敛建议', typeof t8 === 'string' && t8.includes('kix-budget') && t8.includes('可结算主张') && t8.includes('artifact'))
  d = await postExec(mainAgent, 'bash', { command: 'cat file9' })
  check('第 9 步：不重复注入', appendedText(d) === undefined)
  d = await postExec(mainAgent, 'edit', { file_path: 'x' })
  d = await postExec(mainAgent, 'bash', { command: 'cat y' })
  check('变异步骤重置 streak（1 步只读无建议）', appendedText(d) === undefined)

  console.log('== context handoff gate（㉑/㉕）==')
  listeners['session/event'][0](mainAgent.session, { type: 'turn/start', data: { turn: 2 } })
  listeners['session/event'][0](mainAgent.session, {
    type: 'assistant/message',
    data: { usage: { inputTokens: 250000, cacheReadTokens: 180000 } },
  })
  check('记账：input+cacheRead = 430K', I.usageContextTokens({ inputTokens: 250000, cacheReadTokens: 180000 }) === 430000)
  d = await postExec(mainAgent, 'edit', { file_path: 'x' })
  const tb = appendedText(d)
  check('ctx 430K ≥ 动态预算 400K：注入 gate', typeof tb === 'string' && tb.includes('kix-budget gate') && tb.includes('create_goal'))
  check('普通工具被 gate 拒绝', (await preGate(mainAgent, 'read', {})).kind === 'deny')
  check('unrelated capability_call 参数仅提及 lite 仍被 gate 拒绝', (await preGate(mainAgent, 'kix_capability_call', { tool: 'web_search', arguments: { query: 'subagent_lite usage' } })).kind === 'deny')
  const backgroundLite = { tool: 'subagent_lite', arguments: { run_in_background: true } }
  check('gate 期 background lite transition 被拒（结果回流加重溢出）', (await preGate(mainAgent, 'kix_capability_call', backgroundLite)).kind === 'deny')
  const foregroundLite = { tool: 'subagent_lite', arguments: { run_in_background: false } }
  await postExec(mainAgent, 'kix_capability_call', foregroundLite, { isError: false, value: { ok: true }, content: [{ type: 'text', text: '{"ok":true}' }] })
  check('foreground lite 完整回流后解除 gate', (await preGate(mainAgent, 'read', {})).kind === 'allow')

  // ── v7 编曲保育（管线级）：角色档分派在 gate 下对称可达 ─────────────────
  listeners['session/event'][0](mainAgent.session, { type: 'turn/start', data: { turn: 4 } })
  listeners['session/event'][0](mainAgent.session, {
    type: 'assistant/message',
    data: { usage: { inputTokens: 250000, cacheReadTokens: 180000 } },
  })
  await postExec(mainAgent, 'edit', { file_path: 'y' })
  check('gate 重新激活', (await preGate(mainAgent, 'read', {})).kind === 'deny')
  check('gate 期角色档激活（发现）放行', (await preGate(mainAgent, 'kix_tool_activate', { tool: 'subagent_dev' })).kind === 'allow')
  const backgroundDev = { tool: 'subagent_dev', arguments: { run_in_background: true } }
  check('gate 期 background dev transition 被拒（防 64K 角色档后台空耗）', (await preGate(mainAgent, 'kix_capability_call', backgroundDev)).kind === 'deny')
  const foregroundDev = { tool: 'subagent_dev', arguments: { run_in_background: false } }
  await postExec(mainAgent, 'kix_capability_call', foregroundDev, { isError: false, value: { ok: true }, content: [{ type: 'text', text: '{"ok":true}' }] })
  check('foreground dev 完整回流后解除 gate（管线级）', (await preGate(mainAgent, 'read', {})).kind === 'allow')
  const nestedAgent = makeAgent('s-nested', 'zai-coding-cn', 'glm-5.3')
  listeners['session/event'][0](nestedAgent.session, { type: 'turn/start', data: { turn: 1 } })
  await preStep(nestedAgent, 41)
  await postExec(nestedAgent, 'kix_capability_call', { tool: 'create_goal' }, { isError: false, content: [{ type: 'text', text: '{\"ok\":false,\"result\":{\"isError\":true}}' }] })
  check('嵌套目标失败不解除 gate', (await preGate(nestedAgent, 'read', {})).kind === 'deny')
  await postExec(nestedAgent, 'kix_capability_call', { tool: 'create_goal' }, { isError: false, content: [{ type: 'text', text: '{\"ok\":true}' }] })
  check('嵌套目标成功才解除 gate', (await preGate(nestedAgent, 'read', {})).kind === 'allow')
  const unknownProxyAgent = makeAgent('s-unknown-proxy', 'zai-coding-cn', 'glm-5.3')
  listeners['session/event'][0](unknownProxyAgent.session, { type: 'turn/start', data: { turn: 1 } })
  await preStep(unknownProxyAgent, 41)
  await postExec(unknownProxyAgent, 'kix_capability_call', { tool: 'subagent_lite', arguments: { run_in_background: false } }, { isError: false, content: [{ type: 'text', text: 'plain report without envelope' }] })
  check('proxy unknown result 不解除 gate', (await preGate(unknownProxyAgent, 'read', {})).kind === 'deny')
  const eventAgent = makeAgent('s-event-clear', 'zai-coding-cn', 'glm-5.3')
  listeners['session/event'][0](eventAgent.session, { type: 'turn/start', data: { turn: 1 } })
  await preStep(eventAgent, 41)
  listeners['session/event'][0](eventAgent.session, { type: 'tool/call', data: { callId: 'event-1', name: 'kix_capability_call', arguments: { tool: 'subagent_lite', arguments: { run_in_background: false } } } })
  listeners['session/event'][0](eventAgent.session, { type: 'tool/result', data: { message: { source: { callId: 'event-1' }, content: [{ content: [{ type: 'text', text: '{\"ok\":true,\"tool\":\"subagent_lite\"}' }] }] } } })
  check('session event 成功配对解除 gate', (await preGate(eventAgent, 'read', {})).kind === 'allow')

  console.log('== turn-stopping steer 通道 ==')
  listeners['session/event'][0](mainAgent.session, { type: 'turn/start', data: { turn: 3 } })
  listeners['session/event'][0](mainAgent.session, {
    type: 'assistant/message',
    data: { usage: { inputTokens: 410000, cacheReadTokens: 5000 } },
  })
  await listeners['agent/turn-stopping'][0]({ agent: mainAgent, turn: 3 })
  check('纯散文回合超预算（415K ≥ 400K）→ steer 一次', mainAgent.steered.length === 1 && mainAgent.steered[0].content[0].text.includes('kix-budget'))
  await listeners['agent/turn-stopping'][0]({ agent: mainAgent, turn: 3 })
  check('同回合不重复 steer', mainAgent.steered.length === 1)
  const lowAgent = makeAgent('s-low', 'zai-coding-cn', 'glm-5.3')
  listeners['session/event'][0](lowAgent.session, { type: 'turn/start', data: { turn: 1 } })
  listeners['session/event'][0](lowAgent.session, {
    type: 'assistant/message',
    data: { usage: { inputTokens: 5000, cacheReadTokens: 0 } },
  })
  await listeners['agent/turn-stopping'][0]({ agent: lowAgent, turn: 1 })
  check('低 ctx 回合不 steer', lowAgent.steered.length === 0)

  console.log('== turn step gate（㉑）==')
  const stepAgent = makeAgent('s-steps', 'zai-coding-cn', 'glm-5.3')
  listeners['session/event'][0](stepAgent.session, { type: 'turn/start', data: { turn: 1 } })
  await preStep(stepAgent, 40)
  check('step 40 remains available', (await preGate(stepAgent, 'read', {})).kind === 'allow')
  await preStep(stepAgent, 41)
  const stepDeny = await preGate(stepAgent, 'grep', {})
  check('缺 usage 计量时 step 41 兜底拒绝', stepDeny.kind === 'deny' && stepDeny.reason.includes('兜底边界 41'))
  await listeners['agent/turn-stopping'][0]({ agent: stepAgent, turn: 1 })
  check('fallback step gate steers once', stepAgent.steered.length === 1 && stepAgent.steered[0].source.form === 'gate')
  const measuredStepAgent = makeAgent('s-steps-measured', 'zai-coding-cn', 'glm-5.3')
  listeners['session/event'][0](measuredStepAgent.session, { type: 'turn/start', data: { turn: 1 } })
  listeners['session/event'][0](measuredStepAgent.session, { type: 'assistant/message', data: { usage: { inputTokens: 5000 } } })
  await preStep(measuredStepAgent, 41)
  check('动态窗口+usage 有效且低于预算时 step 41 不拒绝', (await preGate(measuredStepAgent, 'read', {})).kind === 'allow')
  await listeners['agent/turn-stopping'][0]({ agent: measuredStepAgent, turn: 1 })
  check('动态计量有效时 turn-stopping 不注入 step gate', measuredStepAgent.steered.length === 0)
  const childAgent = makeAgent('s-child', 'zai-coding-cn', 'glm-5.3', 1)
  await preStep(childAgent, 41)
  check('child step 41 is not main gate', (await preGate(childAgent, 'read', {})).kind === 'allow')
  const stepRecoveryAgent = makeAgent('s-step-recovery', 'zai-coding-cn', 'glm-5.3')
  listeners['session/event'][0](stepRecoveryAgent.session, { type: 'turn/start', data: { turn: 1 } })
  await preStep(stepRecoveryAgent, 41)
  check('step gate recovery starts denied', (await preGate(stepRecoveryAgent, 'read', {})).kind === 'deny')
  await postExec(stepRecoveryAgent, 'kix_capability_call', { tool: 'subagent_lite', arguments: { run_in_background: false } }, { isError: false, value: { ok: true }, content: [{ type: 'text', text: '{"ok":true}' }] })
  await preStep(stepRecoveryAgent, 42)
  check('successful handoff keeps next step open', (await preGate(stepRecoveryAgent, 'read', {})).kind === 'allow')
  const reportAgent = makeAgent('s-report-status', 'zai-coding-cn', 'glm-5.3')
  listeners['session/event'][0](reportAgent.session, { type: 'turn/start', data: { turn: 1 } })
  await preStep(reportAgent, 41)
  await postExec(reportAgent, 'subagent_lite', { run_in_background: false }, { isError: false, content: [{ type: 'text', text: 'report cites {"ok":false} as evidence' }] })
  check('foreground report 引用失败 envelope 不阻止解锁', (await preGate(reportAgent, 'read', {})).kind === 'allow')

  console.log('== 急剪（㉓）==')
  let pruned = 0
  services.tokenMeter = {
    measure() { return { totalTokens: 300000 } },
  }
  services.toolResultPruner = {
    config: { thresholdChars: 2048 },
    pruneSession() { pruned++; return { pruned: [{ seq: 1 }], charsRemoved: 9000 } },
  }
  listeners['session/event'][0](mainAgent.session, { type: 'tool/result', data: {} })
  let pre = await listeners['agent/pre-step'][0]({ agent: mainAgent, signal: undefined }, async () => 'NEXT')
  check('脏 + 300K ≥ 200K prune 线（1M 窗口预算 400K）→ pruneSession 被调', pruned === 1)
  check('pre-step 不阻断（next 透传）', pre === 'NEXT')
  const oversizeAgent = makeAgent('s-oversize', 'zai-coding-cn', 'glm-5.3')
  listeners['session/event'][0](oversizeAgent.session, { type: 'tool/result', data: { message: { content: [{ content: [{ type: 'text', text: 'x'.repeat(3000) }] }] } } })
  await preStep(oversizeAgent, 1)
  check('3K 单结果低于上下文半量也剪裁', pruned === 2)
  pre = await listeners['agent/pre-step'][0]({ agent: mainAgent, signal: undefined }, async () => 'NEXT2')
  check('无新结果不重复 prune', pruned === 2 && pre === 'NEXT2')
  // 小窗口模型：预算约 45.9K，prune 线约 22.9K，300K 仍触发
  const smallAgent = makeAgent('s-small', 'x', 'small-128k')
  listeners['session/event'][0](smallAgent.session, { type: 'tool/result', data: {} })
  await listeners['agent/pre-step'][0]({ agent: smallAgent, signal: undefined }, async () => 'NEXT3')
  check('小窗口模型同样过线触发', pruned === 3)
  delete services.tokenMeter
  listeners['session/event'][0](mainAgent.session, { type: 'tool/result', data: {} })
  pre = await listeners['agent/pre-step'][0]({ agent: mainAgent, signal: undefined }, async () => 'NEXT4')
  check('tokenMeter 缺失 → 不抛错（跨环境不挂）', pre === 'NEXT4' && pruned === 3)
  services.tokenMeter = { measure() { return { totalTokens: 300000 } } }
  const boundaryAgent = makeAgent('s-boundary-oversize', 'zai-coding-cn', 'glm-5.3')
  listeners['session/event'][0](boundaryAgent.session, { type: 'turn/start', data: { turn: 1 } })
  listeners['session/event'][0](boundaryAgent.session, { type: 'tool/result', data: { message: { content: [{ content: [{ type: 'text', text: 'y'.repeat(3000) }] }] } } })
  listeners['session/event'][0](boundaryAgent.session, { type: 'turn/start', data: { turn: 2 } })
  await preStep(boundaryAgent, 1)
  check('oversize result survives turn boundary', pruned === 4)
  // { landed } 返回形态兼容（宿主 pruner 变体）：计入 charsRemoved 才触发日志分支
  services.toolResultPruner = {
    config: { thresholdChars: 2048 },
    pruneSession() { pruned++; return { landed: [{ seq: 9 }], charsRemoved: 5000 } },
  }
  listeners['session/event'][0](mainAgent.session, { type: 'tool/result', data: {} })
  pre = await listeners['agent/pre-step'][0]({ agent: mainAgent, signal: undefined }, async () => 'NEXT5')
  check('{ landed } 形态 → pruneSession 被调且不抛错', pre === 'NEXT5' && pruned === 5)
  // 宿主无 config.thresholdChars → 回退默认 resultThresholdChars=2048，3K 结果仍剪
  services.toolResultPruner = {
    pruneSession() { pruned++; return { pruned: [{ seq: 10 }] } },
  }
  const defaultThresholdAgent = makeAgent('s-default-threshold', 'zai-coding-cn', 'glm-5.3')
  listeners['session/event'][0](defaultThresholdAgent.session, {
    type: 'tool/result',
    data: { message: { content: [{ content: [{ type: 'text', text: 'x'.repeat(3000) }] }] } },
  })
  await listeners['agent/pre-step'][0]({ agent: defaultThresholdAgent, signal: undefined }, async () => 'NEXT6')
  check('缺 config.thresholdChars → 默认 2K 阈值仍剪 3K 结果', pruned === 6)
  delete services.tokenMeter

  console.log('== 解析失败可重试 ==')
  let retryCalls = 0
  services.llm = { resolveModelInfo: async () => { retryCalls++; if (retryCalls === 1) throw new Error('temporary'); return { context: { contextWindow: 131072 } } } }
  const retryAgent = makeAgent('s-retry', 'provider', 'retry-model')
  listeners['session/event'][0](retryAgent.session, { type: 'assistant/message', data: { usage: { inputTokens: 120000 } } })
  await preStep(retryAgent, 1)
  check('解析失败不锁死绝对回退', retryCalls === 1 && (await preGate(retryAgent, 'read', {})).kind === 'allow')
  await preStep(retryAgent, 2)
  check('第二次读取到动态窗口', retryCalls === 2 && (await preGate(retryAgent, 'read', {})).kind === 'deny')
  services.tokenMeter = { measure() { return { totalTokens: 420000 } } }
  services.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 1000000 } }) }
  const noUsageAgent = makeAgent('s-no-usage', 'provider', 'no-usage')
  await preStep(noUsageAgent, 1)
  check('无 usage 时 tokenMeter 仍触发上下文 gate（420K ≥ 400K）', (await preGate(noUsageAgent, 'read', {})).kind === 'deny')
  delete services.tokenMeter
  let missingWindowCalls = 0
  services.llm = { resolveModelInfo: async () => { missingWindowCalls++; return { context: {} } } }
  const missingWindowAgent = makeAgent('s-missing-window', 'provider', 'missing-window')
  listeners['session/event'][0](missingWindowAgent.session, { type: 'assistant/message', data: { usage: { inputTokens: 100000 } } })
  await preStep(missingWindowAgent, 1)
  await preStep(missingWindowAgent, 2)
  await preStep(missingWindowAgent, 41)
  check('成功但缺窗口信息不永久缓存', missingWindowCalls === 3)
  check('usage 存在但窗口缺失时 step 41 仍作 fallback', (await preGate(missingWindowAgent, 'read', {})).kind === 'deny')
  const cleanup = ctx.cleanup
  if (typeof cleanup === 'function') cleanup()
  check('effect 注册了可调用 cleanup', typeof cleanup === 'function')

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process['exit'](1)
}

main().catch((e) => { console.error(e); process['exit'](1) })