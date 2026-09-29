// kix-webauth — 本机回环 + 显式 LAN 主机免 token（宿主部署面插件，profile 层）
//
// 问题（2026-09-09 用户决策）：DSH web 每个进程重掷一次性 launch token，启动行打印
//   dsh web: http://127.0.0.1:<port>/?token=<每次不同>
// 重启后旧书签/自动化地址必然 401（token 已换），而本机单用户部署里这条 token 只增加
// 摩擦——"只限本机使用，token 只会变复杂"。
//
// 方案：**只**在「web 绑定是回环」且「请求 Host 免认证」时跳过浏览器认证，逐请求判定：
//   - requestRejection：保留 Host/Origin 反 DNS-rebinding 栅栏（403 原样返回），只吞掉 401；
//   - authorizeIndex：免认证请求直接放行 index（不再写 401、不再 mint cookie、不再 303）；
//   - authenticatedUrl：免认证地址返回干净 URL（启动行/自动开浏览器不再带 ?token=）。
// 免认证 Host 面（isAuthFreeHostname）：回环 + 宿主信任面里显式列名的主机。其余情况
// （绑定非回环、Host 不在面内）行为与上游完全一致。
//
// 2026-09-16 用户决策（内网迁移；主机名/IP 按发布要求在本仓脱敏为示例）：部署迁到内网
// 主机后经 socat relay 访问，浏览器 Host 永远非回环，原"仅回环"规则等于永远要 token。
// 免认证面扩展为「回环 + 宿主显式信任的 authority」——显式列名，不做后缀/通配（子域与
// 近似域不命中，见测试用例）；bind 仍必须是回环（relay 后面的 dsh 依旧只听 127.0.0.1，
// 条件不动）。取舍：LAN 内任何设备打开页面即可驱动该 agent（与 danger-full-access 同
// 一信任域）。
//
// 信任面为什么复用宿主权威（--trusted-host → ctx.webRuntime.trustedHosts）而不是本插件
// 自己的常量名单：上游 Host/Origin 栅栏先于 token 判定，本插件只吞 401、403 原样放行
// ——不在宿主 trustedHosts 里的 Host 根本到不了这里。私有名单只会与宿主漂移，且会把
// 部署主机名写进仓库。
//
// 为什么必须挂在 profile 层（不是预设行）：`ctx.connection` 是宿主服务，且预设是 lazy
// mount——首个会话之前 index 请求就已经需要认证了。挂载见
// dsh/preset/patches/kix-webhook.runtime-overlay.yml 的 kix-webauth 行（`--patch` 覆盖层；
// 该行因需绝对路径而默认注释，启用时取消注释并填本机检出路径）。
//
// 本文件与 overlay 同层：部署面资产，不随预设组成物化进 agent realm，因此不放 plugins/
// ——那里的文件按语言中立镜像约定必须四根一致，而部署面插件只服务本机 default 档。
// 单元测试在 plugins/kix-webauth.test.js（放那儿是为了 `npm test` 自动发现）。
//
// 安全边界（不要把它读成"关掉鉴权"）：
//   - 绑 127.0.0.1 时外部不可达；跨站请求仍被 Host/Origin 栅栏挡下（403）；
//   - 非 JSON 请求体、未信任 authority 的路径一行未改，仍由上游处理；
//   - 免认证面 = 回环 + 宿主显式信任面（--trusted-host）；对外绑定本身不扩大本插件
//     （bind 必须回环），改面 = 改启动行而不是改代码；
//   - 单用户信任域里，本插件等价于"同机 + 宿主列名的 LAN 主机上任何设备可驱动该
//     agent"——用户显式接受的取舍（与 danger-full-access 同一信任域），不是默认安全姿态。
//
// 规则是负债：本插件不加私有配置项（信任面复用宿主已有的 --trusted-host）、不缓存判定
// 结果——判定就是纯函数，信任名单每次现读。

'use strict'

const name = 'kix-webauth'

// 已接管的服务实例（HMR 重载可能换新实例；同一实例重复 apply 幂等）
const OVERRIDDEN = new WeakSet()

/**
 * 回环 hostname 判定（与上游 dsh-client-connection 的 isLoopbackHostname 同规则）：
 * localhost、IPv6 回环、127/8 任一点分十进制地址。
 * @param {unknown} hostname - WHATWG URL hostname（IPv6 保留方括号）或裸主机名
 * @returns {boolean}
 */
function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true
  const parts = host.split('.')
  return parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * 请求的 Host authority 主机名（node:http IncomingMessage 与 fetch Request 都支持）。
 * @param {unknown} request
 * @returns {string | undefined}
 */
function requestHostname(request) {
  if (request === null || typeof request !== 'object') return undefined
  const headers = request.headers
  if (headers === null || headers === undefined) return undefined
  let raw
  if (typeof headers.get === 'function') raw = headers.get('host')
  else raw = headers.host ?? headers.Host
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    return new URL(`http://${raw}`).hostname
  } catch {
    return undefined
  }
}

/** @param {unknown} request @returns {boolean} */
function isLoopbackRequest(request) {
  return isLoopbackHostname(requestHostname(request))
}

/** @param {unknown} baseUrl @returns {boolean} */
function isLoopbackUrl(baseUrl) {
  try {
    return isLoopbackHostname(new URL(String(baseUrl)).hostname)
  } catch {
    return false
  }
}

/**
 * 宿主信任面条目 → hostname 集合：接受裸主机名、`host:port`、IPv6 方括号形式；端口被
 * 忽略（与上游 isTrustedApiRequest 的「port-less 条目匹配任意端口」同语义）。
 * 只做显式列名匹配，不做后缀/通配——`a.example.lan.evil.com`、`evil-a.example.lan`、
 * 相邻 IP 一律不命中（见测试）。
 * @param {unknown} entries - `ctx.webRuntime.trustedHosts`
 * @returns {Set<string>}
 */
function trustedHostnamesOf(entries) {
  const hosts = new Set()
  if (!Array.isArray(entries)) return hosts
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry === '') continue
    try {
      const host = new URL(`http://${entry}`).hostname
      if (host !== '') hosts.add(host.toLowerCase())
    } catch {
      /* 非法 authority：忽略该条 */
    }
  }
  return hosts
}

/**
 * 免认证 hostname 判定：回环 或 宿主信任面里显式列名的主机（2026-09-16 内网迁移）。
 * @param {unknown} hostname - WHATWG URL hostname（IPv6 保留方括号）或裸主机名
 * @param {unknown} trustedEntries - 宿主信任面条目（--trusted-host / LAN 派生字面量）
 * @returns {boolean}
 */
function isAuthFreeHostname(hostname, trustedEntries) {
  return (
    isLoopbackHostname(hostname) ||
    (typeof hostname === 'string' && trustedHostnamesOf(trustedEntries).has(hostname.toLowerCase()))
  )
}

/** @param {unknown} request @param {unknown} trustedEntries @returns {boolean} */
function isAuthFreeRequest(request, trustedEntries) {
  return isAuthFreeHostname(requestHostname(request), trustedEntries)
}

/** @param {unknown} baseUrl @param {unknown} trustedEntries @returns {boolean} */
function isAuthFreeUrl(baseUrl, trustedEntries) {
  try {
    return isAuthFreeHostname(new URL(String(baseUrl)).hostname, trustedEntries)
  } catch {
    return false
  }
}

/**
 * 干净应用 URL（与上游 authenticatedUrl 同形，只是不带 token 查询参数）。
 * @param {string} baseUrl
 * @returns {string}
 */
function cleanUrl(baseUrl) {
  const url = new URL(baseUrl)
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.href
}

/**
 * 在回环部署上接管 `ctx.connection` 的三个认证入口（免认证面 = 回环 + 宿主信任面）。
 * @param {object} ctx - 宿主插件上下文
 */
function apply(ctx) {
  ctx.inject(['connection', 'webServer', 'webRuntime'], (scope) => {
    const connection = scope.connection
    const bindHost = scope.webServer === undefined ? undefined : scope.webServer.host
    if (connection === undefined || connection === null) return
    if (!isLoopbackHostname(bindHost)) {
      ctx.logger.info(`kix-webauth: web 绑定 ${String(bindHost)} 不是回环，浏览器认证保持上游行为`)
      return
    }
    if (OVERRIDDEN.has(connection)) return
    OVERRIDDEN.add(connection)

    // 信任名单现读：webRuntime 可能晚于 connection 就绪，闭包里快照会读到空表
    const trustedEntries = () => {
      try {
        const runtime = scope.webRuntime
        return runtime === undefined || runtime === null ? [] : runtime.trustedHosts
      } catch {
        return [] // 服务尚未 provide（例如非 web 组合）：退化为仅回环
      }
    }

    const original = {
      requestRejection: connection.requestRejection.bind(connection),
      authorizeIndex: connection.authorizeIndex.bind(connection),
      authenticatedUrl: connection.authenticatedUrl.bind(connection),
    }

    connection.requestRejection = (request) => {
      const rejection = original.requestRejection(request)
      // 403（Host/Origin 栅栏）与 undefined（已放行）原样返回；只吞免认证请求的 401。
      if (rejection !== 401) return rejection
      return isAuthFreeRequest(request, trustedEntries()) ? undefined : rejection
    }
    connection.authorizeIndex = (request, response) =>
      isAuthFreeRequest(request, trustedEntries())
        ? true
        : original.authorizeIndex(request, response)
    connection.authenticatedUrl = (baseUrl) =>
      isAuthFreeUrl(baseUrl, trustedEntries()) ? cleanUrl(baseUrl) : original.authenticatedUrl(baseUrl)

    const listed = [...trustedHostnamesOf(trustedEntries())].join(' / ')
    ctx.logger.info(
      `kix-webauth: 回环部署（${String(bindHost)}）已免 token，含宿主信任面 ` +
        `${listed === '' ? '（空，仅回环）' : listed}；其余 Host 仍走上游认证`,
    )
  })
}

module.exports = {
  name,
  apply,
  isLoopbackHostname,
  requestHostname,
  isLoopbackRequest,
  isLoopbackUrl,
  trustedHostnamesOf,
  isAuthFreeHostname,
  isAuthFreeRequest,
  isAuthFreeUrl,
  cleanUrl,
}
