/**
 * dsh-douyin 限流 / 时段 / 审计 / 串行队列。
 *
 * 规则（主人 2026-11-07 定稿）：
 * - 每天最多 40 条（成功打开/展示的视频/搜索结果）；
 * - 单次浏览会话最多 8 条；两次调用间隔 ≥30 分钟算新会话；
 * - 每次工具调用最小间隔 5s；所有调用串行；
 * - 可用时段按 Asia/Shanghai；00:00–08:00 静默最高优先。
 *
 * 设计：
 * - 状态惰性从本地审计文件重建：apply 阶段不读文件、不产生任何 IO；
 * - 审计只写 时间/命令/条数/ok/error，不记页面正文/cookie；
 * - 所有失败都用 DouyinError 表达，由工具层转成结构化 JSON。
 */
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { DouyinError } from './errors.js'

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** 会占用“条数”配额、且受可用时段限制的浏览命令 */
export const BROWSE_COMMANDS = new Set(['feed', 'search', 'open', 'comments'])

const pad2 = (n) => String(n).padStart(2, '0')

/** 把 UTC 时间戳平移到指定时区的“墙上时间” */
function shifted(ms, tzOffsetMinutes) {
  return new Date(ms + tzOffsetMinutes * MINUTE_MS)
}

export function dayKey(ms, tzOffsetMinutes = 480) {
  const d = shifted(ms, tzOffsetMinutes)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

export function minutesOfDay(ms, tzOffsetMinutes = 480) {
  const d = shifted(ms, tzOffsetMinutes)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/** 0=周日 … 6=周六 */
export function weekdayOf(ms, tzOffsetMinutes = 480) {
  return shifted(ms, tzOffsetMinutes).getUTCDay()
}

export function inRanges(minute, ranges) {
  for (const [start, end] of ranges) {
    if (start <= end) {
      if (minute >= start && minute < end) return true
    } else if (minute >= start || minute < end) {
      // 跨午夜区间（如 22:00-02:00）
      return true
    }
  }
  return false
}

/**
 * @param {number} ms
 * @param {{weekday:number[][],weekend:number[][],silence:number[][]}} windows
 * @param {number} tzOffsetMinutes
 * @returns {{allowed:boolean, reason:'silence'|'outside'|null}}
 */
export function isInTimeWindows(ms, windows, tzOffsetMinutes = 480) {
  const minute = minutesOfDay(ms, tzOffsetMinutes)
  if (inRanges(minute, windows.silence ?? [])) return { allowed: false, reason: 'silence' }
  const weekday = weekdayOf(ms, tzOffsetMinutes)
  const ranges = weekday === 0 || weekday === 6 ? windows.weekend : windows.weekday
  if (!inRanges(minute, ranges ?? [])) return { allowed: false, reason: 'outside' }
  return { allowed: true, reason: null }
}

/** 找到下一个允许的时刻（最多向后找 7 天）；找不到返回 null */
export function nextAllowedAt(ms, windows, tzOffsetMinutes = 480) {
  const startMinute = Math.floor(ms / MINUTE_MS)
  for (let i = 0; i <= 7 * 24 * 60; i++) {
    const t = (startMinute + i) * MINUTE_MS
    if (isInTimeWindows(t, windows, tzOffsetMinutes).allowed) return t
  }
  return null
}

/** 本地审计时间串，例如 2026-11-07T16:35:00+08:00 */
export function shanghaiIso(ms, tzOffsetMinutes = 480) {
  const d = shifted(ms, tzOffsetMinutes)
  const sign = tzOffsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(tzOffsetMinutes)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 本地 JSONL 审计。
 * - 构造零 IO；首次 readRecent 才读文件；
 * - append 失败静默忽略，不影响工具结果；
 * - 超过 maxBytes 时滚动为 .1（只保留一份旧文件）。
 */
export class AuditLog {
  constructor({ file, maxBytes = 5 * 1024 * 1024, tzOffsetMinutes = 480, maxReadBytes = 4 * 1024 * 1024 } = {}) {
    this.file = file ?? ''
    this.maxBytes = maxBytes
    this.tzOffsetMinutes = tzOffsetMinutes
    this.maxReadBytes = maxReadBytes
  }

  readRecent({ sinceMs = 0, limit = 2000 } = {}) {
    if (!this.file) return []
    try {
      const st = statSync(this.file)
      if (!st.isFile() || st.size === 0) return []
      const len = Math.min(st.size, this.maxReadBytes)
      const start = st.size - len
      const buf = Buffer.allocUnsafe(len)
      const fd = openSync(this.file, 'r')
      try {
        readSync(fd, buf, 0, len, start)
      } finally {
        closeSync(fd)
      }
      let text = buf.toString('utf8')
      if (start > 0) {
        const i = text.indexOf('\n')
        text = i >= 0 ? text.slice(i + 1) : ''
      }
      const out = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line)
          if (e && Number.isFinite(e.ts) && e.ts >= sinceMs) out.push(e)
        } catch {
          // 半行/坏行直接跳过
        }
      }
      return out.slice(-limit)
    } catch {
      return []
    }
  }

  append(entry) {
    if (!this.file) return false
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      try {
        if (statSync(this.file).size > this.maxBytes) renameSync(this.file, `${this.file}.1`)
      } catch {
        // 文件不存在 / 滚动失败都不阻断写入
      }
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
      return true
    } catch {
      return false
    }
  }
}

/**
 * 限流器：guard（执行前闸门）→ 执行 → commit（记账）。
 * 串行由 SerialQueue 保证；这里只负责状态，不做等待。
 */
export class RateLimiter {
  constructor({ cfg, clock = Date.now, audit = null }) {
    this.cfg = cfg
    this.clock = clock
    this.tz = cfg.tzOffsetMinutes ?? 480
    this.minWatchMs = Number.isFinite(Number(cfg.minWatchMs)) ? Number(cfg.minWatchMs) : 10000
    this.audit =
      audit ??
      new AuditLog({
        file: cfg.auditFile,
        maxBytes: cfg.maxAuditBytes,
        tzOffsetMinutes: this.tz,
      })
    this.loaded = false
    this.day = null
    this.dailyUsed = 0
    this.sessionStart = 0
    this.sessionUsed = 0
    this.lastCallAt = 0
    this.lastActionAt = 0
    // 只存在内存：进程退出即丢弃，重启不恢复（宁少不多）
    this.activeWatch = null
  }

  /** 首次调用时从审计重建当天用量与当前会话；apply/import 阶段不会触发 */
  _ensureLoaded(now) {
    if (this.loaded) return
    this.loaded = true
    this.day = dayKey(now, this.tz)
    const entries = this.audit.readRecent({ sinceMs: now - 7 * DAY_MS, limit: 5000 })
    if (!entries.length) return

    // watch 审计不算一次工具调用：lastCallAt 只取普通命令的 commit
    const callEntries = entries.filter((e) => e.cmd !== 'watch')
    if (callEntries.length) {
      this.lastCallAt = callEntries[callEntries.length - 1].ts
      this.lastActionAt = this.lastCallAt
    }

    for (const e of entries) {
      // 条数只来自 watch 结算；旧语义的 feed/search 计数不参与
      if (e.cmd === 'watch' && dayKey(e.ts, this.tz) === this.day) this.dailyUsed += num(e.count)
    }

    // 从最新一条往前回溯，连续（间隔 < sessionGapMs）的记录属于当前会话
    let used = 0
    let prev = null
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (prev !== null && prev - e.ts >= this.cfg.sessionGapMs) break
      if (e.cmd === 'watch') used += num(e.count)
      prev = e.ts
    }
    this.sessionUsed = used
    this.sessionStart = prev ?? 0
  }

  _rollDay(now) {
    const today = dayKey(now, this.tz)
    if (this.day !== today) {
      this.day = today
      this.dailyUsed = 0
      // 会话不因跨零点重置，只按“最后一次活动间隔”判断
    }
  }

  _roll(now) {
    this._rollDay(now)
    const gap = this.cfg.sessionGapMs
    if (!this.sessionStart || (this.lastActionAt > 0 && now - this.lastActionAt >= gap)) {
      this.sessionStart = now
      this.sessionUsed = 0
    }
  }

  /**
   * 执行前闸门。失败 throw DouyinError，不改变任何计数。
   * @param {{cmd:string, now?:number, need?:number}} args
   * @returns {{capacity:number, dailyLeft:number, sessionLeft:number}}
   */
  guard({ cmd, now = this.clock(), need = 1 }) {
    const cfg = this.cfg
    if (!cfg.enabled) {
      throw new DouyinError('E_DISABLED', '抖音工具未启用（enabled=false）')
    }
    this._ensureLoaded(now)
    this._roll(now)

    if (BROWSE_COMMANDS.has(cmd)) {
      const win = isInTimeWindows(now, cfg.timeWindows, this.tz)
      if (!win.allowed) {
        const next = nextAllowedAt(now, cfg.timeWindows, this.tz)
        const message =
          win.reason === 'silence'
            ? '当前是她的静默时段（00:00–08:00），不浏览抖音'
            : '当前不在可用时段（Asia/Shanghai）'
        throw new DouyinError('E_TIME_WINDOW', message, {
          retryAfterMs: next && next > now ? next - now : null,
        })
      }
    }

    const gap = cfg.minIntervalMs
    if (this.lastCallAt > 0 && now - this.lastCallAt < gap) {
      const retryAfterMs = gap - (now - this.lastCallAt)
      throw new DouyinError('E_MIN_INTERVAL', `调用太频繁：两次调用至少间隔 ${Math.ceil(gap / 1000)}s`, {
        retryAfterMs,
      })
    }

    // 0 = 不设限（主人 2026-11-14）；只保留串行/最小间隔这些执行安全，不挡次数
    const dailyUnlimited = !(Number(cfg.dailyQuota) > 0)
    const sessionUnlimited = !(Number(cfg.perSession) > 0)
    const dailyLeft = dailyUnlimited ? Number.MAX_SAFE_INTEGER : Math.max(0, cfg.dailyQuota - this.dailyUsed)
    const sessionLeft = sessionUnlimited ? Number.MAX_SAFE_INTEGER : Math.max(0, cfg.perSession - this.sessionUsed)
    if (need > 0) {
      if (!dailyUnlimited && dailyLeft <= 0) {
        throw new DouyinError('E_QUOTA', `今日配额已用完（${cfg.dailyQuota} 条）`)
      }
      if (!sessionUnlimited && sessionLeft <= 0) {
        throw new DouyinError(
          'E_SESSION_QUOTA',
          `本次浏览会话已到上限（${cfg.perSession} 条），间隔 30 分钟后算新会话`,
        )
      }
    }
    return {
      capacity: Math.max(0, Math.min(dailyLeft, sessionLeft)),
      dailyLeft,
      sessionLeft,
    }
  }

  /**
   * 执行后记账：只更新时间戳并写审计，**不增加条数**（条数只由 watch 结算产生）。
   * 写审计失败不影响返回值。
   */
  commit({ cmd, now = this.clock(), ok, error = null, durationMs = 0 }) {
    this.lastCallAt = now
    this.lastActionAt = now
    const entry = {
      ts: now,
      at: shanghaiIso(now, this.tz),
      cmd: String(cmd),
      count: 0,
      ok: Boolean(ok),
      error: ok ? null : String(error ?? 'E_REMOTE_IO'),
    }
    if (durationMs > 0) entry.durationMs = Math.round(durationMs)
    this.audit.append(entry)
    return entry
  }

  /** 开始计一条 activeWatch（open 成功后调用；只存在内存） */
  startWatch({ videoId, now = this.clock(), startedAt = null } = {}) {
    const at =
      startedAt !== null && startedAt !== undefined && Number.isFinite(Number(startedAt))
        ? Number(startedAt)
        : now
    this._ensureLoaded(at)
    this.activeWatch = { videoId: String(videoId ?? ''), startedAt: at }
    return this.activeWatch
  }

  /**
   * 结算上一条 activeWatch：>=minWatchMs 计 1 条，否则计 0；清 activeWatch。
   * charge 只写审计/加计数，不更新 lastCallAt。
   */
  settleWatch(now = this.clock()) {
    const watch = this.activeWatch
    if (!watch) return null
    this.activeWatch = null
    const watchMs = Math.max(0, now - watch.startedAt)
    const charged = watchMs >= this.minWatchMs ? 1 : 0
    const entry = this.charge({
      count: charged,
      now,
      meta: { videoId: watch.videoId, watchMs },
    })
    return { videoId: watch.videoId, watchMs, charged: charged === 1, entry }
  }

  /**
   * 只加 daily/session 计数并写 cmd:'watch' 审计；不更新 lastCallAt。
   * @param {{count?:number, now?:number, meta?:{videoId?:string, watchMs?:number}}} args
   */
  charge({ count = 1, now = this.clock(), meta = null } = {}) {
    this._ensureLoaded(now)
    this._rollDay(now)
    const n = Math.max(0, Math.floor(Number(count) || 0))
    if (n > 0) {
      this.dailyUsed += n
      this.sessionUsed += n
      if (!this.sessionStart) this.sessionStart = now
    }
    const videoId = meta?.videoId === undefined || meta?.videoId === null ? null : String(meta.videoId)
    const watchMs = Math.max(0, Math.round(Number(meta?.watchMs) || 0))
    const entry = {
      ts: now,
      at: shanghaiIso(now, this.tz),
      cmd: 'watch',
      count: n,
      ok: true,
      error: null,
      videoId,
      watchMs,
      charged: n > 0,
    }
    this.audit.append(entry)
    return entry
  }

  /** 只读状态（不滚动、不写文件、不更新 lastCallAt） */
  usage(now = this.clock()) {
    this._ensureLoaded(now)
    const today = dayKey(now, this.tz)
    const dailyUsed = this.day === today ? this.dailyUsed : 0
    const active = this.sessionStart > 0 && this.lastActionAt > 0 && now - this.lastActionAt < this.cfg.sessionGapMs
    const sessionUsed = active ? this.sessionUsed : 0
    const win = isInTimeWindows(now, this.cfg.timeWindows, this.tz)
    const activeWatch = this.activeWatch
      ? {
          videoId: this.activeWatch.videoId,
          startedAt: this.activeWatch.startedAt,
          elapsedMs: Math.max(0, now - this.activeWatch.startedAt),
        }
      : null
    return {
      dailyUsed,
      dailyQuota: this.cfg.dailyQuota,
      dailyLeft: Math.max(0, this.cfg.dailyQuota - dailyUsed),
      sessionUsed,
      perSession: this.cfg.perSession,
      sessionLeft: Math.max(0, this.cfg.perSession - sessionUsed),
      lastCallAt: this.lastCallAt || null,
      minWatchMs: this.minWatchMs,
      activeWatch,
      watchedCount: dailyUsed,
      watched: { daily: dailyUsed, session: sessionUsed },
      timeWindow: {
        allowed: win.allowed,
        reason: win.reason,
      },
    }
  }
}

/**
 * 串行队列：一条队列内严格串行；队列满时立即 E_BUSY，不无限堆积；上一单失败不会打断后续。
 *
 * 2026-11-16 背压（auditor 附录 B）：E_BUSY 不再只给一句"稍后再试"，错误对象带
 * `retryAfterMs`（按超载档位 300–1500ms 线性给），调用方（工具层 `toFailure`）可直接读它决定等待。
 * 队列统计用 `stats()` 只读暴露 depth/maxQueue/accepting，供 service.queueStats() 汇总。
 */
export const BUSY_RETRY_MIN_MS = 300
export const BUSY_RETRY_MAX_MS = 1500

export class SerialQueue {
  /**
   * @param {{maxQueue?: number, label?: string}} [opts] label 只用于日志/统计可读性
   */
  constructor({ maxQueue = 8, label = '' } = {}) {
    this.maxQueue = Math.max(1, Number(maxQueue) || 8)
    this.label = String(label ?? '')
    this.depth = 0
    this.tail = Promise.resolve()
  }

  /** 队列满时的建议等待：超载 1 档 300ms，逐档 +300ms，封顶 1500ms */
  busyRetryAfterMs() {
    const overload = Math.max(1, this.depth - this.maxQueue + 1)
    return Math.min(BUSY_RETRY_MAX_MS, Math.max(BUSY_RETRY_MIN_MS, BUSY_RETRY_MIN_MS * overload))
  }

  run(fn) {
    if (this.depth >= this.maxQueue) {
      const retryAfterMs = this.busyRetryAfterMs()
      return Promise.reject(
        new DouyinError('E_BUSY', `抖音工具正忙（串行队列已满），约 ${retryAfterMs}ms 后重试`, { retryAfterMs }),
      )
    }
    this.depth += 1
    const start = this.tail.then(() => fn())
    this.tail = start.then(
      () => {},
      () => {},
    )
    return start.finally(() => {
      this.depth -= 1
    })
  }

  get size() {
    return this.depth
  }

  /** 只读统计；accepting=false 表示现在调用会立刻 E_BUSY */
  stats() {
    const depth = this.depth
    return {
      ...(this.label ? { label: this.label } : {}),
      depth,
      maxQueue: this.maxQueue,
      accepting: depth < this.maxQueue,
      retryAfterMs: depth < this.maxQueue ? 0 : this.busyRetryAfterMs(),
    }
  }
}

/**
 * watcher 的"指数退避 + 熔断"状态机（纯状态，不排定时器；两个 watcher 共用同一公式）。
 *
 * 规则（protocol-v2 §B / research §2.7）：
 * - 只有失败类错误（见 WATCH_FAIL_CODES）才退避；业务失败（E_SELECTOR_MISS 等）不改状态；
 * - 第一次失败 delay = max(intervalMs, watchBackoffMinMs)；之后每次 ×factor，封顶 watchBackoffMaxMs；
 * - 连续失败 >= watchBreakerFails → 熔断：不再按间隔排期，改为等冷却 watchBreakerCooldownMs；
 * - 冷却到点自动安排一次探测 tick：成功 → 全部复位（fails=0/backoffMs=0/breakerOpen=false）；
 *   探测再失败 → 重新冷却一个周期；
 * - 成功一次 backoffMs 归零（spec）。
 * 所有参数在构造时按范围夹紧（配置没加这些键时用默认值）。
 */
export const WATCH_FAIL_CODES = Object.freeze([
  'E_REMOTE_IO',
  'E_BRIDGE_DOWN',
  'E_TIMEOUT',
  'E_PAGE_UNSAFE',
  'E_COMMAND_FAILED',
])

const WATCH_FAIL_SET = new Set(WATCH_FAIL_CODES)

/** 失败是否属于"该退避"的类别（E_SELECTOR_MISS 等业务失败不算，避免一次选择器抖动就慢下来） */
export function isWatchFailCode(code) {
  return WATCH_FAIL_SET.has(String(code ?? ''))
}

/**
 * 是否崩溃类错误（页面 renderer 崩 / 浏览器断开）：这类要立刻请求一次桥 health。
 * - E_REMOTE_IO + message 含 crash（Playwright "Target crashed"）；兼容 E_CRASH / E_BRIDGE_DOWN。
 */
export function isCrashCode(code, message = '') {
  const c = String(code ?? '')
  if (c === 'E_CRASH') return true
  if (c === 'E_BRIDGE_DOWN') return true
  if (c === 'E_REMOTE_IO' && /crash/i.test(String(message ?? ''))) return true
  return false
}

const intIn = (value, fallback, lo, hi) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

const floatIn = (value, fallback, lo, hi) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(lo, Math.min(hi, n))
}

/**
 * @param {{
 *   minMs?: number, maxMs?: number, factor?: number,
 *   breakerFails?: number, cooldownMs?: number,
 *   clock?: () => number, log?: object|null, label?: string,
 * }} [opts]
 */
export function createWatchGuard({
  minMs = 3000,
  maxMs = 60000,
  factor = 2,
  breakerFails = 12,
  cooldownMs = 300000,
  clock = Date.now,
  log = null,
  label = 'watcher',
} = {}) {
  const minBackoffMs = intIn(minMs, 3000, 1000, 60000)
  const maxBackoffMs = Math.max(minBackoffMs, intIn(maxMs, 60000, 5000, 600000))
  const backoffFactor = floatIn(factor, 2, 1.2, 5)
  const breakerLimit = intIn(breakerFails, 12, 2, 100)
  const cooldown = intIn(cooldownMs, 300000, 30000, 3600000)

  let backoffMs = 0
  let fails = 0
  let breakerOpen = false
  let breakerOpenedAt = 0
  let cooldownUntil = 0
  let nextTickAt = 0
  let lastFailCode = null
  let lastFailAt = null
  let probeTicks = 0
  let warnedOpen = false

  const warnOnce = (message) => {
    try {
      log?.warn?.(`[douyin] ${label} ${message}`)
    } catch {
      // 日志失败不能打断 watcher
    }
  }

  /** 只读状态，直接并进 status() */
  function status() {
    return {
      backoffMs,
      fails,
      breakerOpen,
      breakerOpenedAt: breakerOpenedAt || null,
      breakerCooldownMs: cooldown,
      breakerResumeAt: cooldownUntil || null,
      breakerProbeTicks: probeTicks,
      nextTickAt: nextTickAt || null,
      lastFailCode,
      lastFailAt,
      backoff: {
        minMs: minBackoffMs,
        maxMs: maxBackoffMs,
        factor: backoffFactor,
        breakerFails: breakerLimit,
      },
    }
  }

  /**
   * 下一次该等多久。熔断中 → 冷却剩余时间（到点后按 intervalMs 安排单次探测）；
   * 否则 → max(intervalMs, backoffMs)（失败时不会比正常间隔更快）。
   */
  function delayMs(intervalMs = 0) {
    const base = Math.max(0, Number(intervalMs) || 0)
    if (breakerOpen) {
      const left = cooldownUntil - clock()
      if (left > 0) return left
      return base || minBackoffMs
    }
    return Math.max(base, backoffMs)
  }

  /** 成功一次：退避/失败计数归零，熔断复位 */
  function succeed(intervalMs = 0) {
    const wasOpen = breakerOpen
    backoffMs = 0
    fails = 0
    lastFailCode = null
    if (wasOpen) {
      breakerOpen = false
      breakerOpenedAt = 0
      cooldownUntil = 0
      probeTicks = 0
      warnedOpen = false
      try {
        log?.info?.(`[douyin] ${label} 熔断后探测成功，已恢复（退避归零）`)
      } catch {}
    }
    return Math.max(0, Number(intervalMs) || 0)
  }

  /** 非退避类失败：不改退避/熔断状态，只按当前 backoff 节奏继续 */
  function neutral(intervalMs = 0) {
    return delayMs(intervalMs)
  }

  /** 失败一次：指数退避 + 连续失败熔断；返回下一次 delay */
  function fail(code, intervalMs = 0) {
    lastFailCode = String(code ?? 'E_REMOTE_IO')
    lastFailAt = clock()
    fails += 1
    backoffMs = backoffMs > 0
      ? Math.min(maxBackoffMs, Math.max(minBackoffMs, backoffMs * backoffFactor))
      : minBackoffMs
    if (breakerOpen) {
      // 熔断后探测失败：重新冷却一个周期（不重复告警）
      probeTicks += 1
      breakerOpenedAt = clock()
      cooldownUntil = clock() + cooldown
    } else if (fails >= breakerLimit) {
      breakerOpen = true
      breakerOpenedAt = clock()
      cooldownUntil = clock() + cooldown
      probeTicks = 0
      if (!warnedOpen) {
        warnedOpen = true
        warnOnce(`连续失败 ${fails} 次（最后 ${lastFailCode}），已熔断暂停，${Math.round(cooldown / 1000)}s 后探测一次`)
      }
    }
    return delayMs(intervalMs)
  }

  function setNextTickAt(at) {
    nextTickAt = Number.isFinite(Number(at)) ? Number(at) : 0
    return nextTickAt
  }

  return {
    status,
    delayMs,
    succeed,
    neutral,
    fail,
    setNextTickAt,
    get breakerOpen() {
      return breakerOpen
    },
    get backoffMs() {
      return backoffMs
    },
    get fails() {
      return fails
    },
  }
}
