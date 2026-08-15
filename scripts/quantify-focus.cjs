// 量化 kix-focus 裁剪效果:改造前(85 工具全量) vs 改造后(常驻集)
const fs = require('fs')
const raw = fs.readFileSync('C:/Users/37112/AppData/Local/Temp/dsh-spill-49zQmj/session-bc5f9e0200fc/79bf7c72fb30-cordis_inspect_query.txt', 'utf8')
// 切分工具条目:按顶层 "name": 出现位置切块
const re = /"name": "([^"]+)"/g
const chunks = []
let last = 0
let m
while ((m = re.exec(raw))) {
  const name = m[1]
  const start = raw.lastIndexOf('{', m.index)
  if (last > 0) chunks.push({ name: prevName, size: start - lastStart })
  prevName = name
  lastStart = start
  last = m.index
}
if (prevName) chunks.push({ name: prevName, size: raw.length - lastStart })

// 去重(相同工具名取最后一次出现)
const byName = {}
for (const c of chunks) byName[c.name] = c.size
const allNames = Object.keys(byName)
const total = allNames.reduce((s, n) => s + byName[n], 0)

// 常驻集(kix-focus RESIDENT_TOOLS)
const resident = ['edit', 'write', 'pwsh', 'read', 'grep', 'glob',
  'subagent', 'subagent_fork', 'subagent_cross', 'subagent_lite', 'subagent_thinker', 'subagent_vision',
  'ask_user_question', 'todo_write', 'skill', 'web_search',
  'kix_capability_search', 'kix_capability_call']

const residentSize = resident.filter(n => byName[n]).reduce((s, n) => s + byName[n], 0)
const residentNames = resident.filter(n => byName[n])
const onDemandSize = total - residentSize

console.log('=== kix-focus 裁剪量化(当前会话清单) ===')
console.log('改造前: 工具数 ' + allNames.length + ', schema 总字节 ' + total.toLocaleString())
console.log('常驻集(清单中可识别 ' + residentNames.length + ' 个): ' + residentSize.toLocaleString() + ' B')
console.log('按需披露(MCP+编排等): ' + onDemandSize.toLocaleString() + ' B')
console.log('裁剪率: ' + (100 * (1 - residentSize / total)).toFixed(1) + '%')
console.log('')
console.log('=== 各类别字节 ===')
const mcpSize = allNames.filter(n => n.startsWith('mcp__')).reduce((s, n) => s + byName[n], 0)
const nativeSize = allNames.filter(n => !n.startsWith('mcp__')).reduce((s, n) => s + byName[n], 0)
console.log('MCP 工具(' + allNames.filter(n => n.startsWith('mcp__')).length + ' 个): ' + mcpSize.toLocaleString() + ' B')
console.log('native 工具(' + allNames.filter(n => !n.startsWith('mcp__')).length + ' 个): ' + nativeSize.toLocaleString() + ' B')
console.log('')
console.log('=== 每轮 token 估算(字节/3.5 近似) ===')
console.log('改造前 ~' + Math.round(total / 3.5).toLocaleString() + ' tokens')
console.log('改造后 ~' + Math.round(residentSize / 3.5).toLocaleString() + ' tokens')
console.log('降幅 ~' + (100 * (1 - residentSize / total)).toFixed(1) + '%')
