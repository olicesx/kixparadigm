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
// 免认证 Host 面（isAuthFreeHostname）：回环 + 显式列名的 LAN 主机（见下方
// TRUSTED_LAN_HOSTNAMES）。其余情况（绑定非回环、Host 不在面内）行为与上游完全一致。
//
// 2026-09-16 用户决策（dsh.internal.example 迁移）：部署迁到 dsh.internal.example 后经 socat relay 访问，
// 浏览器 Host 永远非回环，原"仅回环"规则等于永远要 token。免认证面扩展为
// 「回环 + dsh.internal.example + 192.0.2.10」——显式列名，不做后缀/通配（子域与近似域不命中）；
// bind 仍必须是回环（relay 后面的 dsh 依旧只听 127.0.0.1，条件不动）。
// 取舍：LAN 内任何设备打开页面即可驱动该 agent（与 danger-full-access 同一信任域）。
//
// 为什么必须挂在 profile 层（不是预设行）：`ctx.connection` 是宿主服务，且预设是 lazy
// mount——首个会话之前 index 请求就已经需要认证了。挂载见
// dsh/preset/patches/kix-webhook.runtime-overlay.yml 的 kix-webauth 行（`--patch` 覆盖层）。
//
// 本文件与 overlay 同层：部署面资产，不随预设组成物化进 agent realm，因此不放 plugins/
// ——那里的文件按语言中立镜像约定必须四根一致，而部署面插件只服务本机 default 档。
// 单元测试在 plugins/kix-webauth.test.js（放那儿是为了 `npm test` 自动发现）。
//
// 安全边界（不要把它读成"关掉鉴权"）：
//   - 绑 127.0.0.1 时外部不可达；跨站请求仍被 Host/Origin 栅栏挡下（403）；
//   - 非 JSON 请求体、未信任 authority 的路径一行未改，仍由上游处理；
//   - 加 --trusted-host 或对外绑定不会扩大本插件（bind 必须回环）；免认证面只认
//     显式列名 + 回环，改面 = 改本文件（有测试与决策记录）；
//   - 单用户信任域里，本插件等价于"同机 + 列名 LAN 内任何设备可驱动该 agent"——
//     用户显式接受的取舍（与 danger-full-access 同一信任域），不是默认安全姿态。
//
// 规则是负债：不做配置项、不缓存判定结果——判定就是纯函数；列名集合只在有真实
// 部署需要时增加。

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

// 免认证 LAN 主机面：显式列名，不做后缀/通配——dsh.internal.example.evil.com、evil-dsh.internal.example、
// 192.0.2.11 一律不命中。要加机器 = 加一行 + 补测试 + 留决策记录。
const TRUSTED_LAN_HOSTNAMES = new Set(['dsh.internal.example', '192.0.2.10'])

/**
 * 免认证 hostname 判定：回环 或 显式列名的 LAN 主机（2026-09-16 dsh.internal.example 迁移）。
 * @param {unknown} hostname - WHATWG URL hostname（IPv6 保留方括号）或裸主机名
 * @returns {boolean}
 */
function isAuthFreeHostname(hostname) {
  return (
    isLoopbackHostname(hostname) ||
    (typeof hostname === 'string' && TRUSTED_LAN_HOSTNAMES.has(hostname.toLowerCase()))
  )
}

/** @param {unknown} request @returns {boolean} */
function isAuthFreeRequest(request) {
  return isAuthFreeHostname(requestHostname(request))
}

/** @param {unknown} baseUrl @returns {boolean} */
function isAuthFreeUrl(baseUrl) {
  try {
    return isAuthFreeHostname(new URL(String(baseUrl)).hostname)
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
 * 在回环部署上接管 `ctx.connection` 的三个认证入口（免认证面 = 回环 + 列名 LAN 主机）。
 * @param {object} ctx - 宿主插件上下文
 */
function apply(ctx) {
  ctx.inject(['connection', 'webServer'], (scope) => {
    const connection = scope.connection
    const bindHost = scope.webServer === undefined ? undefined : scope.webServer.host
    if (connection === undefined || connection === null) return
    if (!isLoopbackHostname(bindHost)) {
      ctx.logger.info(`kix-webauth: web 绑定 ${String(bindHost)} 不是回环，浏览器认证保持上游行为`)
      return
    }
    if (OVERRIDDEN.has(connection)) return
    OVERRIDDEN.add(connection)

    const original = {
      requestRejection: connection.requestRejection.bind(connection),
      authorizeIndex: connection.authorizeIndex.bind(connection),
      authenticatedUrl: connection.authenticatedUrl.bind(connection),
    }

    connection.requestRejection = (request) => {
      const rejection = original.requestRejection(request)
      // 403（Host/Origin 栅栏）与 undefined（已放行）原样返回；只吞免认证请求的 401。
      if (rejection !== 401) return rejection
      return isAuthFreeRequest(request) ? undefined : rejection
    }
    connection.authorizeIndex = (request, response) =>
      isAuthFreeRequest(request) ? true : original.authorizeIndex(request, response)
    connection.authenticatedUrl = (baseUrl) =>
      isAuthFreeUrl(baseUrl) ? cleanUrl(baseUrl) : original.authenticatedUrl(baseUrl)

    ctx.logger.info(
      `kix-webauth: 回环部署（${String(bindHost)}）已免 token，含列名 LAN 主机 ` +
        `${[...TRUSTED_LAN_HOSTNAMES].join(' / ')}；其余 Host 仍走上游认证`,
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
  isAuthFreeHostname,
  isAuthFreeRequest,
  isAuthFreeUrl,
  cleanUrl,
}
