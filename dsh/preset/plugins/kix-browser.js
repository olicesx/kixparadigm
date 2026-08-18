// kix-browser.js — DSH 原生浏览器自动化（playwright-core 直驱，2026-08-18）
//
// 挂载形态（渐进披露，2026-08-18 与用户确认）：agent.cordis.yml 挂载行默认
// 注释（不占常驻 schema）；经 kix-focus 的 ACTIVATABLE_TOOLS.browser
// （pkgPath 本地解析）首用自动激活——kix_capability_call { tool:"browser" }
// 即挂载，下一轮直呼；kix_tool_deactivate 卸载。常驻需取消 yml 注释+重启。
//
// 动机（对比 MCP 五跳链路，实证见 dsh-capability-map.md「浏览器自动化」行）：
//   MCP 层在本宿主解析损坏（navigate/click ToolNotFound）+ schema 有损翻译 +
//   npx 缓存漂移 + 24 工具 token 税。本插件单紧凑工具覆盖高频形态：
//   爬取/截图/E2E/接管真实浏览器。
//
// 设计：
//   1. 单工具 browser{action,...}，action 枚举 open/snapshot/click/type/screenshot/
//      text/close——常驻 schema ~1KB（vs MCP 24 份）。
//   2. 会话持久：browser/page 句柄存插件模块态，跨调用存活；CDP attach 优先
//      （接管真实浏览器：Edge/Chrome --remote-debugging-port=9222 启动后 attach，
//      登录态/标签页全保留），launch headless chromium 兜底。
//   3. playwright-core 懒 require：未安装不影响插件装载与其他工具；解析失败
//      返回精确安装指引。
//   4. 内置门禁：URL 仅放行 http/https/about:blank（拒 file:/javascript:/data:）。
//   5. 并发串行化：内部 promise 队列，防两个调用争用同一 page。
//
// 环境变量：
//   KIX_BROWSER_CDP       CDP 端点（默认 http://127.0.0.1:9222；设为空串禁用 attach）
//   KIX_BROWSER_HEADLESS  launch 模式无头开关（默认 true）
//   KIX_BROWSER_CORE      playwright-core 显式路径（默认常规 require 解析 + ~/.dsh 兜底）
//   KIX_BROWSER_TIMEOUT   导航/定位超时 ms（默认 15000）
//
// 单元测试：node plugins/kix-browser.test.js（URL 门禁/action 校验/状态机/安装指引，
//   不依赖真浏览器；E2E 探针见仓库 .kix-tmp/，部署后手动跑）。

'use strict'

const ACTIONS = ['open', 'snapshot', 'click', 'type', 'press', 'select', 'hover', 'back', 'forward', 'reload', 'wait', 'screenshot', 'upload', 'tabs', 'dialog', 'text', 'close']

// ── 纯函数（单测直接覆盖）──────────────────────────────────────────────

/** URL 门禁：仅 http/https/about:blank。返回 null=放行，否则拒绝原因。 */
function urlRejection(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return 'URL 必须是非空字符串'
  let u
  try {
    u = new URL(raw)
  } catch {
    return `无法解析为 URL：${raw.slice(0, 120)}`
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return null
  if (raw === 'about:blank') return null
  return `协议 ${u.protocol} 不在放行清单（http/https/about:blank）——file:/javascript:/data: 一律拒绝`
}

/** 元素文本截断（保首尾空白清洁）。 */
function clipText(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** 快照元素提取（真实函数引用传入 $$eval——字符串函数体在该版 playwright-core 返回 undefined，E2E 实证）。 */
function snapshotElements(nodes) {
  // $$eval 把匹配节点作为数组传入；自查询兜底（与选择器保持同步）
  const els = nodes && nodes.length ? nodes : document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[onclick]')
  const out = []
  for (let i = 0; i < els.length && out.length < 60; i++) {
    const el = els[i]
    let selector = ''
    if (el.id) selector = '#' + (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id)
    else if (el.getAttribute('data-testid')) selector = '[data-testid=' + JSON.stringify(el.getAttribute('data-testid')) + ']'
    else if (el.name) selector = el.tagName.toLowerCase() + '[name=' + JSON.stringify(el.name) + ']'
    else {
      let nth = 1, sib = el
      while ((sib = sib.previousElementSibling) && sib.tagName === el.tagName) nth++
      selector = el.tagName.toLowerCase() + ':nth-of-type(' + nth + ')'
    }
    out.push({ tag: el.tagName.toLowerCase(), selector, text: (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80) })
  }
  return out
}

// ── 插件态 ────────────────────────────────────────────────────────────
let browserHandle = null // playwright Browser
let pageHandle = null // playwright Page
let sessionMode = null // 'cdp' | 'launch'
let coreLib = null // 懒加载的 playwright-core 模块
let queueTail = Promise.resolve() // 串行化队列
let dialogAuto = 'dismiss' // 弹窗策略：dismiss | accept（dialog action 可改）
let lastDialog = null // 最近弹窗 {type,message,defaultValue}（每次 action 结果可查）

/** 给 page 挂弹窗监听（幂等）：记录信息并按策略自动处理，防 Playwright 默认静默驳回破坏流程。 */
function wirePage(p) {
  if (!p || p.__kixBrowserWired) return p
  p.__kixBrowserWired = true
  p.on('dialog', (d) => {
    lastDialog = { type: d.type(), message: clipText(d.message(), 300), defaultValue: d.defaultValue() || null }
    try {
      ;(dialogAuto === 'accept' ? d.accept() : d.dismiss()).catch(() => {})
    } catch {
      /* 同步异常忽略 */
    }
  })
  return p
}

function env(name, fallback) {
  const v = process.env[name]
  return v === undefined ? fallback : v
}

/** 解析 playwright-core：常规 require → env 显式路径 → ~/.dsh/node_modules 兜底。 */
function resolveCore() {
  if (coreLib) return coreLib
  const path = require('path')
  const fs = require('fs')
  const candidates = []
  const explicit = env('KIX_BROWSER_CORE', '')
  if (explicit) candidates.push(explicit)
  try {
    candidates.push(require.resolve('playwright-core'))
  } catch {
    /* 常规解析失败，走兜底 */
  }
  const home = env('DSH_HOME', '') || (env('USERPROFILE', '') || env('HOME', ''))
  if (home) candidates.push(path.join(home, 'node_modules', 'playwright-core'))
  for (const c of candidates) {
    try {
      // candidates 可能是包目录（package.json main 入口）
      coreLib = typeof c === 'string' && c.endsWith('playwright-core') && fs.existsSync(path.join(c, 'package.json'))
        ? require(path.join(c, 'package.json')) && require(c)
        : require(c)
      if (coreLib && coreLib.chromium) return coreLib
    } catch {
      /* 试下一个候选 */
    }
  }
  throw new Error(
    'playwright-core 未安装或不可解析。安装任一处皆可（跨平台 Win/macOS/Linux/WSL2）：\n' +
      '  1) 宿主 home（推荐，双端部署通吃）：npm install playwright-core --prefix "' +
      (home || '~/.dsh') +
      '"\n' +
      '  2) 源仓库根：在 kix-bundle 根 npm install playwright-core\n' +
      '  3) 显式指定：设 KIX_BROWSER_CORE=<playwright-core 目录>\n' +
      '浏览器二进制（launch 模式才需要；CDP attach 不需要）：\n' +
      '  Windows/macOS: npx playwright install chromium\n' +
      '  Linux/WSL2: npx playwright install --with-deps chromium（需 sudo 装系统库）'
  )
}

/** 建立会话：CDP attach 优先，失败降级 launch。 */
async function ensureSession() {
  if (browserHandle && pageHandle) return
  const core = resolveCore()
  const cdp = env('KIX_BROWSER_CDP', 'http://127.0.0.1:9222')
  if (cdp) {
    try {
      browserHandle = await core.chromium.connectOverCDP(cdp, { timeout: 5000 })
      sessionMode = 'cdp'
      const ctx0 = browserHandle.contexts()[0]
      pageHandle = wirePage(ctx0 ? ctx0.pages()[0] || (await ctx0.newPage()) : await browserHandle.newPage())
      return
    } catch {
      // CDP 不可达（真实浏览器未开调试端口）→ launch 兜底
    }
  }
  browserHandle = await core.chromium.launch({ headless: env('KIX_BROWSER_HEADLESS', 'true') !== 'false' })
  sessionMode = 'launch'
  pageHandle = wirePage(await browserHandle.newPage())
}

async function closeSession() {
  const b = browserHandle
  browserHandle = null
  pageHandle = null
  sessionMode = null
  dialogAuto = 'dismiss'
  lastDialog = null
  if (b) {
    try {
      await b.close() // cdp 模式=断开连接（浏览器存活）；launch 模式=结束进程
    } catch {
      /* 关闭失败不阻塞 */
    }
  }
}

// ── action 实现（全部在串行队列内执行）───────────────────────────────
async function runAction(args) {
  const action = args && args.action
  if (!ACTIONS.includes(action)) {
    return { ok: false, error: `未知 action「${action}」，合法值：${ACTIONS.join('/')}` }
  }
  const timeoutMs = Number(env('KIX_BROWSER_TIMEOUT', '15000')) || 15000

  if (action === 'close') {
    await closeSession()
    return { ok: true, closed: true }
  }

  // 弹窗策略：无需会话即可设置/查询（纯参数校验前置，单测覆盖）
  if (action === 'dialog') {
    if (args.auto !== undefined && args.auto !== 'accept' && args.auto !== 'dismiss') {
      return { ok: false, error: 'dialog.auto 只接受 accept/dismiss' }
    }
    if (args.auto) dialogAuto = args.auto
    return { ok: true, auto: dialogAuto, lastDialog }
  }

  // 纯参数校验（会话门禁之前——错误信息精确，单测无需浏览器）
  if (action === 'open') {
    const rej = urlRejection(args.url)
    if (rej) return { ok: false, error: rej }
  } else if (action === 'press') {
    if (!args.key || typeof args.key !== 'string') return { ok: false, error: 'press 需要 key（如 Enter/Tab/Escape/ArrowDown/Control+a）' }
  } else if (action === 'select') {
    if (!args.selector) return { ok: false, error: 'select 需要 selector' }
    if (args.value === undefined && !Array.isArray(args.values)) return { ok: false, error: 'select 需要 value 或 values（数组，多选）' }
  } else if (action === 'upload') {
    if (!args.selector) return { ok: false, error: 'upload 需要 selector（input[type=file]）' }
    if (!Array.isArray(args.files) || args.files.length === 0) return { ok: false, error: 'upload 需要 files（绝对路径数组）' }
    const fsMod = require('fs')
    for (const f of args.files) {
      if (!fsMod.existsSync(f)) return { ok: false, error: `文件不存在：${f}` }
    }
  } else if (action === 'wait') {
    if (!args.text && !args.selector) return { ok: false, error: 'wait 需要 text 或 selector 之一' }
  } else if (action === 'click' || action === 'hover') {
    if (!args.selector) return { ok: false, error: `${action} 需要 selector（CSS 或 text= 前缀）` }
  } else if (action === 'type') {
    if (!args.selector || typeof args.text !== 'string') return { ok: false, error: 'type 需要 selector 与 text' }
  }

  if (action === 'open') {
    await ensureSession()
    const resp = await pageHandle.goto(args.url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' })
    return { ok: true, mode: sessionMode, url: pageHandle.url(), status: resp ? resp.status() : null, title: clipText(await pageHandle.title(), 120) }
  }

  if (action === 'tabs' && !browserHandle) return { ok: false, error: '无活动会话：先 browser({action:"open", url}) 建立会话' }
  if (!pageHandle) return { ok: false, error: '无活动页面：先 browser({action:"open", url}) 建立会话' }

  if (action === 'snapshot') {
    const elements = await pageHandle.$$eval('a[href],button,input,select,textarea,[role="button"],[onclick]', snapshotElements)
    return {
      ok: true,
      url: pageHandle.url(),
      title: clipText(await pageHandle.title(), 120),
      text: clipText(await pageHandle.evaluate(() => document.body.innerText), 4000),
      elements,
      lastDialog,
    }
  }
  if (action === 'text') {
    return { ok: true, url: pageHandle.url(), text: clipText(await pageHandle.evaluate(() => document.body.innerText), 12000) }
  }
  if (action === 'click') {
    await pageHandle.locator(args.selector).first().click({ timeout: timeoutMs })
    return { ok: true, clicked: args.selector, url: pageHandle.url(), lastDialog }
  }
  if (action === 'type') {
    await pageHandle.locator(args.selector).first().fill(args.text, { timeout: timeoutMs })
    return { ok: true, typed: args.text.length, url: pageHandle.url() }
  }
  if (action === 'press') {
    await pageHandle.keyboard.press(args.key)
    return { ok: true, pressed: args.key, url: pageHandle.url(), lastDialog }
  }
  if (action === 'select') {
    const vals = Array.isArray(args.values) ? args.values : [args.value]
    await pageHandle.locator(args.selector).first().selectOption(vals, { timeout: timeoutMs })
    return { ok: true, selected: vals, url: pageHandle.url() }
  }
  if (action === 'hover') {
    await pageHandle.locator(args.selector).first().hover({ timeout: timeoutMs })
    return { ok: true, hovered: args.selector, url: pageHandle.url() }
  }
  if (action === 'back' || action === 'forward' || action === 'reload') {
    const r =
      action === 'back'
        ? await pageHandle.goBack({ timeout: timeoutMs })
        : action === 'forward'
          ? await pageHandle.goForward({ timeout: timeoutMs })
          : await pageHandle.reload({ timeout: timeoutMs })
    return { ok: true, action, url: pageHandle.url(), status: r ? r.status() : null, title: clipText(await pageHandle.title(), 120) }
  }
  if (action === 'wait') {
    if (args.selector) await pageHandle.waitForSelector(args.selector, { timeout: timeoutMs })
    else await pageHandle.getByText(args.text).first().waitFor({ timeout: timeoutMs })
    return { ok: true, waited: args.selector || `text=${args.text}`, url: pageHandle.url() }
  }
  if (action === 'screenshot') {
    const os = require('os')
    const p = args.path || require('path').join(os.tmpdir(), `kix-browser-${Date.now()}.png`)
    await pageHandle.screenshot({ path: p, fullPage: !!args.fullPage })
    return { ok: true, path: p, fullPage: !!args.fullPage }
  }
  if (action === 'upload') {
    await pageHandle.locator(args.selector).first().setInputFiles(args.files, { timeout: timeoutMs })
    return { ok: true, uploaded: args.files }
  }
  if (action === 'tabs') {
    const pages = browserHandle.contexts().flatMap((c) => c.pages())
    if (typeof args.switch === 'number') {
      if (args.switch < 0 || args.switch >= pages.length) return { ok: false, error: `tab 索引越界：${args.switch}（共 ${pages.length} 个）` }
      pageHandle = wirePage(pages[args.switch])
      await pageHandle.bringToFront().catch(() => {})
      return { ok: true, switched: args.switch, url: pageHandle.url() }
    }
    const list = []
    for (let i = 0; i < pages.length; i++) {
      list.push({ index: i, url: pages[i].url(), title: clipText(await pages[i].title().catch(() => ''), 80) })
    }
    return { ok: true, tabs: list, active: pages.indexOf(pageHandle) }
  }
  return { ok: false, error: `action「${action}」已枚举但未实现（内部错误）` }
}

// ── 插件入口 ──────────────────────────────────────────────────────────
module.exports = {
  name: 'kix-browser',
  inject: ['tools'],
  apply(ctx) {
    const tools = ctx.tools
    const dispose = tools.register({
      name: 'browser',
      description:
        '浏览器自动化（playwright-core 直驱，会话跨调用持久）。action：open{url}（CDP attach 真实浏览器优先，headless chromium 兜底）|snapshot{ }（url/title/正文+可交互元素 selector 清单）|text{ }（长正文）|click{selector}|type{selector,text}|press{key}（Enter/Tab/Escape/Control+a…）|select{selector,value|values}|hover{selector}|back|forward|reload|wait{text|selector}|screenshot{path?,fullPage?}|upload{selector,files}|tabs{switch?}（列出/切换标签）|dialog{auto?}（弹窗策略 accept/dismiss，默认 dismiss，结果含 lastDialog）|close{ }。selector 支持 CSS 与 text= 前缀。仅 http/https/about:blank。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ACTIONS, description: '要执行的动作' },
          url: { type: 'string', description: 'open：目标 URL（http/https/about:blank）' },
          selector: { type: 'string', description: 'click/type/select/hover/upload：CSS 选择器或 text=可见文本' },
          text: { type: 'string', description: 'type：填入文本；wait：等待可见的正文文本' },
          key: { type: 'string', description: 'press：键名（Enter/Tab/Escape/ArrowDown/Control+a…）' },
          value: { type: 'string', description: 'select：单选值' },
          values: { type: 'array', items: { type: 'string' }, description: 'select：多选值数组' },
          path: { type: 'string', description: 'screenshot：落盘绝对路径（缺省临时目录）' },
          fullPage: { type: 'boolean', description: 'screenshot：整页截图（默认视口）' },
          files: { type: 'array', items: { type: 'string' }, description: 'upload：本地文件绝对路径数组' },
          switch: { type: 'number', description: 'tabs：切换到该索引（缺省=列出全部）' },
          auto: { type: 'string', enum: ['accept', 'dismiss'], description: 'dialog：后续弹窗自动处理策略' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        // output.schema 是 JsonSchemaNode：object 需 properties
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (a, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        // 串行队列：同一 page 上的并发操作按序执行
        const run = queueTail.then(() => runAction(args)).catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
        // 队列推进不因单次失败中断
        queueTail = run.then(
          () => undefined,
          () => undefined
        )
        return run
      },
    })
    ctx.effect(() => {
      dispose()
      // 插件卸载时静默收尾（不等待）
      closeSession().catch(() => undefined)
    })
    ctx.logger?.info?.('[kix-browser] browser 工具已注册（playwright-core 懒加载，CDP attach 优先）')
  },
  // 导出纯函数供单测（不注册任何东西）
  _test: { urlRejection, clipText, snapshotElements, ACTIONS },
}
