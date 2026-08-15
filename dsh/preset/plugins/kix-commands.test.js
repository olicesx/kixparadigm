// kix-commands 回归测试（P1-8）
//
// 单元级验证：加载 kix-commands.js，mock DSH ctx.commands 表面，
// 覆盖：注册 5 个命令、handler 读取 prompt 文件并剥离 frontmatter、
// {{input}} 替换、steer 注入消息形状、错误路径。
// 运行：node skills/kixpower/scripts/kix-commands.test.js（源仓库）
// 提示：测试以源仓库布局运行，须把 KIX_COMMANDS_PROMPTS_DIR 指向源仓库
// prompts/（插件默认按安装副本布局解析 ../prompts）。

const path = require('node:path')
const assert = require('node:assert')

// 源仓库 prompts/（插件在安装副本时默认 ../prompts；此处仅在源仓库布局下显式指向）
const { existsSync } = require('node:fs')
const srcPrompts = path.join(__dirname, '..', '..', '..', 'prompts')
if (existsSync(srcPrompts)) {
  process.env.KIX_COMMANDS_PROMPTS_DIR = srcPrompts
}

// ── mock ctx（cordis 插件 apply(ctx) 需要的表面）──────────────────────────
const registered = []
const steered = []
const ctx = {
  logger: { info() {}, warn() {} },
  commands: {
    register(entry) { registered.push(entry) },
  },
  on() {},
}

const pluginPath = path.join(__dirname, 'kix-commands.js')
const plugin = require(pluginPath)
plugin.apply(ctx)

// ── 断言 1：5 个命令全部注册，名称合法 ─────────────────────────────────────
const names = registered.map((e) => e.name).sort()
assert.deepStrictEqual(names, [
  'kixpower', 'kixpower-continue', 'kixpower-import', 'kixpower-new', 'kixpower-review',
], '应注册 5 个 kixpower 命令')
for (const e of registered) {
  assert.match(e.name, /^[a-z0-9_-]+$/, `命令名 ${e.name} 必须小写 [a-z0-9_-]`)
  assert.ok(typeof e.description === 'string' && e.description.length > 0, `${e.name} 需描述`)
  assert.ok(e.input && typeof e.input.hint === 'string', `${e.name} 需 input.hint`)
  assert.strictEqual(typeof e.handler, 'function', `${e.name} 需 handler`)
}

// ── 断言 2：handler 注入正确形状的 user 消息（mock agent）─────────────────
const fakeAgent = { steer(msg) { steered.push(msg) } }
const newCmd = registered.find((e) => e.name === 'kixpower-new')
const result = newCmd.handler({ agent: fakeAgent, rawInput: 'demo-app' })
assert.strictEqual(result.kind, 'success', '正常路径应 success')
assert.strictEqual(steered.length, 1, '应注入一条消息')
const msg = steered[0]
assert.strictEqual(msg.role, 'user', '消息角色 user')
assert.ok(msg.id && typeof msg.id === 'string', '消息带 id')
assert.strictEqual(msg.source.kind, 'user', '来源 user（用户主动触发命令）')
assert.strictEqual(msg.content[0].type, 'text', 'content 是 text 块')
assert.ok(msg.content[0].text.includes('模式 1：全新项目初始化'), '正文应为流程 prompt（frontmatter 已剥离）')
assert.ok(!msg.content[0].text.startsWith('---'), 'frontmatter 不应进入消息')
assert.ok(msg.content[0].text.includes('demo-app'), '{{input}} 应被替换为 rawInput')

// ── 断言 3：无参数时 {{input}} 留空不报错 ──────────────────────────────────
steered.length = 0
const noArg = newCmd.handler({ agent: fakeAgent, rawInput: '' })
assert.strictEqual(noArg.kind, 'success')
assert.strictEqual(steered.length, 1)
assert.ok(!steered[0].content[0].text.includes('{{input}}'), '空参数时占位符应被清掉或保留原样——此处允许保留，但不应崩溃')

// ── 断言 4：缺 agent 时返回 error 不抛 ─────────────────────────────────────
const noAgent = newCmd.handler({ agent: undefined, rawInput: 'x' })
assert.strictEqual(noAgent.kind, 'error', '无 agent 应 error')

// ── 断言 5：kixpower（智能路由）命令同样工作 ───────────────────────────────
steered.length = 0
const router = registered.find((e) => e.name === 'kixpower')
const r2 = router.handler({ agent: fakeAgent, rawInput: '审查 PR' })
assert.strictEqual(r2.kind, 'success')
assert.strictEqual(steered.length, 1)
assert.ok(steered[0].content[0].text.includes('审查 PR'), '智能路由也应替换输入')

// ── 断言 6：rawInput 含 $ 特殊字符时不被 replace 替换串特殊解释 ─────────────
// （GLM 独立审查 minor①：replace 第二参为字符串时 $&/$1 会被特殊解释）
steered.length = 0
const dollar = newCmd.handler({ agent: fakeAgent, rawInput: '$1 & $& cost' })
assert.strictEqual(dollar.kind, 'success')
const injected = steered[0].content[0].text
const idx = injected.indexOf('$1 & $& cost')
assert.ok(idx >= 0, `rawInput 应原样注入（未被替换串特殊解释），实际：${JSON.stringify(injected.slice(-40))}`)

console.log(`[kix-commands.test] 全部通过：${registered.length} 个命令注册，注册/handler/注入/错误路径/特殊字符 6 组断言 OK`)
