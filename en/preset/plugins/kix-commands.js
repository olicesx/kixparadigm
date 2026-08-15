// kix-commands — kixparadigm 的 /kixpower-* slash 命令的 DSH 原生命令注册
//
// P1-8 落地：把 kix 的 5 个流程命令（kixpower-new / kixpower-import /
// kixpower-continue / kixpower-review / kixpower）注册为 DSH `ctx.commands`
// 命令平面的原生命令。收益（对照 P1-8 落地前 DSH-ADAPTATION.md §7 的"无 UI 注册"现状）：
//   - 用户在 UI 输入框敲 / 即可看到命令候选（description 即 UI 帮助）
//   - 触发零 token：命令解析与簿记（command/run + command/done 日志事件对）
//     绝不进模型历史，模型只在命令注入的 user 消息出现后才开始工作
//   - 语义与 `/plan` 命令一致：handler 通过 agent.steer(createUserMessage)
//     把流程 prompt 注入为模型可见的 user 消息 → 模型下一轮执行流程
//
// 设计要点（对照 dsh-command-goal 先例）：
//   - inject: ['commands'] 注册到命令注册表；命令在 agent.ctx 下注册会精确
//     限定该 agent 并遮蔽同名全局（本 preset 的 standing scope 即如此）
//   - handler 只做"读 prompt 文件 → 注入 user 消息"，不执行流程本身
//     （流程执行是模型的工作；handler 无模型轮次、无副作用）
//   - prompt 文件路径解析：插件在 preset 的 plugins/ 下，prompts 在 ../prompts/
//   - 命令名必须小写 [a-z0-9_-]（dsh-commands 契约）
//   - 失败一律返回 { kind: 'error', text }，绝不静默
//
// 消息构造（对齐 dsh-llm createUserMessage 产物）：id 用 crypto.randomUUID()
// （MessageId 是 branded string，运行时即普通字符串），role/content/source
// 与 createUserMessage({content, source:{kind:'user'}}) 同形。不依赖外部包，
// 相对路径插件只 require 内置模块（与 dsh-vision-bridge 同款约束）。
//
// 挂载：preset agent.cordis.yml 中一行（与 kix-guards 同款相对路径）：
//   - id: kix-commands
//     name: ./plugins/kix-commands.js
// 测试：KIX_COMMANDS_PROMPTS_DIR 可覆盖 prompts 目录（kix-commands.test.js 用；
// 安装副本行为不变——默认 join(__dirname, '..', 'prompts')）。

'use strict'

const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')

const PROMPTS_DIR = process.env.KIX_COMMANDS_PROMPTS_DIR || join(__dirname, '..', 'prompts')

// 命令注册表：name → prompt 文件 + UI 描述 + 参数提示
const COMMANDS = [
  {
    name: 'kixpower-new',
    file: 'kixpower-new.prompt.md',
    description: '全新项目启动：访谈→Producer→Dev→L2→QA→L4→Producer 收尾',
    hint: '[项目名 技术栈]',
  },
  {
    name: 'kixpower-import',
    file: 'kixpower-import.prompt.md',
    description: '导入现有项目到 kixpower 流程',
    hint: '[项目路径]',
  },
  {
    name: 'kixpower-continue',
    file: 'kixpower-continue.prompt.md',
    description: '继续当前 kixpower Sprint',
    hint: '[Sprint 号]',
  },
  {
    name: 'kixpower-review',
    file: 'kixpower-review.prompt.md',
    description: '对当前 PR 执行 kixpower 审查流程',
    hint: '[PR 号]',
  },
  {
    name: 'kixpower',
    file: 'kixpower.prompt.md',
    description: 'kixpower 智能路由：选择匹配的流程',
    hint: '[任务描述]',
  },
]

/** 剥离 prompt 文件的 YAML frontmatter（--- 块），只留正文指令。 */
function stripFrontmatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return match ? text.slice(match[0].length) : text
}

/** 读取 prompt 文件：剥离 frontmatter + 替换 {{input}}。失败返回 null。 */
function loadPrompt(file, rawInput) {
  try {
    let text = readFileSync(join(PROMPTS_DIR, file), 'utf8')
    text = stripFrontmatter(text)
    const input = (rawInput || '').trim()
    // 有参数 → 替换占位符；空参数 → 清空占位符（不留字面量给模型）。
    // 用函数替换器：rawInput 含 $&/$1 等时避免 replace 的替换串特殊解释
    // （GLM 独立审查 minor①，2026-08-21 修复）。
    text = text.replace(/\{\{\s*input\s*\}\}/g, () => input)
    return text
  } catch {
    return null
  }
}

module.exports = {
  name: 'kix-commands',
  inject: ['commands'],
  apply(ctx) {
    for (const cmd of COMMANDS) {
      ctx.commands.register({
        name: cmd.name,
        description: cmd.description,
        input: { hint: cmd.hint },
        handler: ({ agent, rawInput }) => {
          const promptText = loadPrompt(cmd.file, rawInput || '')
          if (promptText === null) {
            return {
              kind: 'error',
              text: `kix-commands: 无法读取 ${cmd.file}（preset prompts 目录不可达）。请检查 preset 安装完整性。`,
            }
          }
          if (!agent) {
            return { kind: 'error', text: 'kix-commands: 无可用 agent 上下文，无法注入流程。' }
          }
          // 注入模型可见 user 消息：正文 = 流程 prompt，来源 kind:'user'
          // （用户主动输入 /kixpower-* 即用户意图，与 /plan 注入同语义）。
          agent.steer({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: promptText }],
            source: { kind: 'user' },
          })
          return {
            kind: 'success',
            text: `已注入 ${cmd.name} 流程（${promptText.length} 字符）。模型将在下一轮按流程执行。`,
          }
        },
      })
    }
    ctx.logger?.info?.('[kix-commands] 已注册 /kixpower-* 原生命令')
  },
}
