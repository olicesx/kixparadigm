// kix-webauth — 本机回环访问免 token（宿主部署面插件，profile 层）
//
// 问题（2026-09-09 用户决策）：DSH web 每个进程重掷一次性 launch token，启动行打印
//   dsh web: http://127.0.0.1:<port>/?token=<每次不同>
// 重启后旧书签/自动化地址必然 401（token 已换），而本机单用户部署里这条 token 只增加
// 摩擦——"只限本机使用，token 只会变复杂"。
//
// 方案：**只**在「web 绑定是回环」且「请求 Host 是回环」时跳过浏览器认证，逐请求判定：
//   - requestRejection：保留 Host/Origin 反 DNS-rebinding 栅栏（403 原样返回），只吞掉 401；
//   - authorizeIndex：回环请求直接放行 index（不再写 401、不再 mint cookie、不再 303）；
//   - authenticatedUrl：回环地址返回干净 URL（启动行/自动开浏览器不再带 ?token=）。
// 其余情况（绑定非回环、Host 非回环、LAN / --trusted-host 访问）行为与上游完全一致。
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
//   - 部署一旦改成对外绑定或加 --trusted-host，非回环 Host 自动回到上游认证；
//   - 本机多用户机器上，本插件等价于"同机任何进程可驱动该 agent"——这是用户显式接受的
//     本机单用户取舍（与 danger-full-access 同一信任域），不是默认安全姿态。
//
// 规则是负债：不做白名单、不做配置项、不缓存判定结果——判定就是两个纯函数。

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
 * 在回环部署上接管 `ctx.connection` 的三个认证入口。
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
      // 403（Host/Origin 栅栏）与 undefined（已放行）原样返回；只吞回环请求的 401。
      if (rejection !== 401) return rejection
      return isLoopbackRequest(request) ? undefined : rejection
    }
    connection.authorizeIndex = (request, response) =>
      isLoopbackRequest(request) ? true : original.authorizeIndex(request, response)
    connection.authenticatedUrl = (baseUrl) =>
      isLoopbackUrl(baseUrl) ? cleanUrl(baseUrl) : original.authenticatedUrl(baseUrl)

    ctx.logger.info(`kix-webauth: 回环部署（${String(bindHost)}）已免 token；非回环 Host 仍走上游认证`)
  })
}

module.exports = {
  name,
  apply,
  isLoopbackHostname,
  requestHostname,
  isLoopbackRequest,
  isLoopbackUrl,
  cleanUrl,
}
