// execution-result.cjs — 工具执行终态的单一事实源（canonical ToolExecutionResult）
//
// 出生证明（2026-09-09）：kix-discipline 用 `result && !result.isError` 判成功，
// 于是非零 bash exitCode（canonical value 为 { kind:'foreground', exitCode:N }）
// 仍被记为 green/lint 证据，后台 spawn 的 { kind:'background', jobId } 也被当成
// 执行成功。kix-settle 早已按 canonical 形状判定（foregroundExecutionSucceeded /
// terminalJobOutcome），但 settle 已 require discipline，反向依赖会成环——本模块
// 是两侧共用的第三处，形状与终态语义只在这里定义一次。
//
// DSH 侧真实形状（@deepseek-ai/dsh-tool-bash / dsh-tool-pwsh / dsh-tool-jobs）：
//   post-execute 收到 { isError, value }；成功结果的成功与否只看 value：
//     - 前台：{ kind:'foreground', exitCode, timedOut, aborted, sandbox?:{denied} }
//     - 后台：{ kind:'background', jobId }（启动本身不是证据）
//     - job_output：{ text, job:{ id, status: running|stopping|completed|killed|failed, detail } }
//   失败结果是 { isError:true, error:{...} }，没有 value。
//
// 判定口径：
//   - 只有 foreground exitCode === 0 且未 timedOut/aborted/被 sandbox 拒绝算成功；
//   - background 只提取 jobId；终态证据由 job_output 的 completed 且 detail 无非零
//     exit code 判定（bash 后台 job 的 detail 恒为 `exit code: N` 或 signal/killed）；
//   - run_code 的结构化汇总 { logs, result } 没有 exit code，本身不是执行证据；
//     真正的验证证据是 run_code 内可见的工具子调用终态（子调用同样经
//     tools/post-execute 派发，各自携带 canonical 形状）。不解析程序正文；
//   - 未知形状一律不算成功（宁可漏记，不可误记）。
'use strict'

/** 直接执行的验证工具（自带 exit code 语义）。run_code 不在其中：见文件头。 */
const DIRECT_EXECUTION_TOOLS = new Set(['probe'])
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'killed'])
const FAILED_JOB_STATUSES = new Set(['failed', 'killed'])

/** 取 canonical value：兼容 { value } 包装与 { ok:true, result } 旧包装。 */
function resultValue(result) {
  let value = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result
  if (value && value.ok === true && Object.prototype.hasOwnProperty.call(value, 'result')) value = value.result
  return value
}

/** 前台执行成功：canonical foreground exitCode=0 且未超时/中止/被沙箱拒绝。 */
function foregroundExecutionSucceeded(result) {
  if (!result || result.isError === true) return false
  const value = resultValue(result)
  if (!value || value.kind !== 'foreground') return false
  return value.exitCode === 0 && value.timedOut !== true && value.aborted !== true && value.sandbox?.denied !== true
}

/** 后台启动句柄的 jobId；启动本身不构成执行证据。 */
function backgroundJobId(result) {
  if (!result || result.isError === true) return undefined
  const value = resultValue(result)
  return value && value.kind === 'background' && typeof value.jobId === 'string' ? value.jobId : undefined
}

/** job_output 终态：{ id, success }；running/stopping/未知状态返回 undefined。 */
function terminalJobOutcome(result) {
  if (!result || result.isError === true) return undefined
  const value = resultValue(result)
  const job = value && value.job
  if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) return undefined
  const detail = String(job.detail || '')
  const failed = FAILED_JOB_STATUSES.has(job.status) || /exit code:\s*[1-9]\d*/i.test(detail)
  return { id: String(job.id || ''), success: !failed && job.status === 'completed' }
}

/** 直接执行工具（probe）的成功判定；无 exit code 的汇总（run_code）不算证据。 */
function directExecutionSucceeded(tool, result) {
  if (!DIRECT_EXECUTION_TOOLS.has(tool) || !result || result.isError === true) return false
  const value = resultValue(result)
  if (value && typeof value === 'object') {
    if (value.error || value.ok === false || value.success === false) return false
    if (value.timedOut === true || value.timed_out === true || value.aborted === true) return false
    const exitCode = typeof value.exitCode === 'number' ? value.exitCode : value.exit_code
    if (typeof exitCode === 'number' || exitCode === null) return exitCode === 0
  }
  // 没有 exit code 的结构化汇总不是执行证据：只有可见的工具子调用终态才计证。
  return false
}

module.exports = {
  DIRECT_EXECUTION_TOOLS,
  TERMINAL_JOB_STATUSES,
  FAILED_JOB_STATUSES,
  resultValue,
  foregroundExecutionSucceeded,
  backgroundJobId,
  terminalJobOutcome,
  directExecutionSucceeded,
}
