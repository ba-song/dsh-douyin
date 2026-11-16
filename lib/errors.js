/**
 * dsh-douyin 错误码与统一失败载荷。
 *
 * 约束：所有对外（工具返回值 / dyDouyin 服务）失败都返回结构对象，
 * 不把异常抛给宿主；异常只在模块内部用来表达失败原因。
 */

/** 需求里约定的错误码（v1 必须能出现） */
export const ERROR_CODES = Object.freeze({
  E_BRIDGE_DOWN: 'E_BRIDGE_DOWN',
  E_SSH_AUTH: 'E_SSH_AUTH',
  E_TIMEOUT: 'E_TIMEOUT',
  E_OPEN_TIMEOUT: 'E_OPEN_TIMEOUT',
  E_BAD_ARG: 'E_BAD_ARG',
  E_BAD_URL: 'E_BAD_URL',
  E_SELECTOR_MISS: 'E_SELECTOR_MISS',
  E_LOGIN_REQUIRED: 'E_LOGIN_REQUIRED',
  E_CHALLENGE: 'E_CHALLENGE',
  E_REMOTE_IO: 'E_REMOTE_IO',
  E_BUSY: 'E_BUSY',
  E_PARSE: 'E_PARSE',
  E_NO_MEDIA: 'E_NO_MEDIA',
  E_TOO_LARGE: 'E_TOO_LARGE',
  E_DISK_FULL: 'E_DISK_FULL',
  E_DOWNLOAD_FAILED: 'E_DOWNLOAD_FAILED',
  E_NOT_FOUND: 'E_NOT_FOUND',
  E_CONFIRM_REQUIRED: 'E_CONFIRM_REQUIRED',
  E_UNVERIFIED: 'E_UNVERIFIED',
  // 2026-11-16（抖音优化）：动作已发出、但结果读不到（页面崩溃/回读全部失败）。
  // 与 E_UNVERIFIED 的区别：E_UNVERIFIED = 明确读到“没生效”；本码 = 不知道生效没生效。
  // 语义约束：调用方**绝不能自动重放**，必须先人工/只读核对真实状态再决定。
  E_EXECUTION_UNKNOWN: 'E_EXECUTION_UNKNOWN',
  E_NO_INPUT: 'E_NO_INPUT',
  E_INPUT_FOCUSED: 'E_INPUT_FOCUSED',
  E_STALE: 'E_STALE',
})

/** 插件内部额外使用的闸门错误码（会在 README 里列明） */
export const GATE_CODES = Object.freeze({
  E_DISABLED: 'E_DISABLED',
  E_TIME_WINDOW: 'E_TIME_WINDOW',
  E_MIN_INTERVAL: 'E_MIN_INTERVAL',
  E_QUOTA: 'E_QUOTA',
  E_SESSION_QUOTA: 'E_SESSION_QUOTA',
  E_PERMISSION: 'E_PERMISSION',
})

const KNOWN = new Set([...Object.values(ERROR_CODES), ...Object.values(GATE_CODES)])

export class DouyinError extends Error {
  /**
   * @param {string} code 错误码
   * @param {string} message 人类可读说明（不含页面全文/cookie）
   * @param {Record<string, unknown>} [extra] 额外字段：retryAfterMs / detail 等
   */
  constructor(code, message, extra = null) {
    super(String(message ?? code))
    this.name = 'DouyinError'
    this.code = KNOWN.has(code) ? code : 'E_REMOTE_IO'
    if (extra && typeof extra === 'object') {
      for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined && v !== null) this[k] = v
      }
    }
  }
}

export function isDouyinError(e) {
  return e instanceof DouyinError || (e && typeof e.code === 'string' && e.code.startsWith('E_'))
}

/** 从任意异常提取稳定的错误码；未知异常统一 E_REMOTE_IO，避免泄露内部栈 */
export function errorCode(e) {
  const code = typeof e?.code === 'string' ? e.code : ''
  return KNOWN.has(code) ? code : 'E_REMOTE_IO'
}

/** 截断，防止把远程 stderr / 页面内容整段带进工具结果 */
export function clip(text, max = 400) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 统一失败载荷：工具层直接 JSON.stringify 后返回。
 * 不包含页面正文、cookie、密钥内容。
 */
export function toFailure(e, fallbackCode = 'E_REMOTE_IO') {
  const code = e?.code && KNOWN.has(e.code) ? e.code : fallbackCode
  const out = { ok: false, code, message: clip(e?.message ?? code, 500) }
  for (const key of ['retryAfterMs', 'timeoutMs', 'detail']) {
    const v = e?.[key]
    if (v !== undefined && v !== null) {
      out[key] = typeof v === 'number' ? Math.round(v) : clip(v, 300)
    }
  }
  return out
}
