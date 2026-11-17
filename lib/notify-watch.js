/**
 * 抖音互动通知 → autonomy 的实时事件源（默认关闭，profile 里显式开）。
 *
 * 设计（2026-11-14 主人/Lead 四步要求）：
 * - 3–5s（默认 3s，可配 2–30s）事件源，不再 10 分钟轮询；
 * - 优先 badge/角标 DOM + jsWatch（MutationObserver/fetch 包装）事件；**不每 tick 强开面板**，
 *   只有角标/网络事件显示“有新通知”时才点一次「通知」入口，读完立刻 Escape/入口切换关闭；
 * - 绝不点搜索框（旧 close 逻辑会点 searchbar-input，已在 service.closeNotifyPanel 移除）；
 * - 面板已经打开时只被动读当前 DOM（allowOpen:false），不点任何通知条目、不标已读；
 * - 事件带稳定 id / actor / type / text / time / ageMs / isOwner / replyable / route / source；
 * - 主人事件 → dyHome（contactId=actor）；其他人 → 统一“抖音”会话（contactId 可配，默认 douyin）；
 * - 不发送、不回复、不路由别的东西；dyHome 不可用只记日志，不重试。
 *
 * 限制：面板在视频/模态页、私信页时 watcher 不导航、不抢页面（E_PAGE_UNSAFE）；
 *       这些页面上的通知要等回到主站页面后由 badge/网络触发补齐（或下一轮基线）。
 *
 * 2026-11-16 稳定性/性能改造（protocol-v2 §B/§C）：
 * - panel 模式不再每 tick 开面板：只有 badge/net 触发，或距上次读面板 >= notifyPanelPollMs（默认 60s）才开；
 * - 失败指数退避（watchBackoffMinMs/MaxMs/Factor）+ 连续失败熔断（watchBreakerFails/CooldownMs）；
 * - 崩溃类错误（Target crashed / E_CRASH / E_BRIDGE_DOWN）立刻请求一次桥 health（老桥不认识时静默）；
 * - watchQueue 忙（skipped:busy）时整轮跳过，不推进基线/候选/失败计数。
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createWatchGuard, isCrashCode, isWatchFailCode } from './limits.js'
import { isNotifyReplyable, isNotifyTriggerEvent, parseNotifyItems } from './service.js'

const hash12 = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 12)

const NOTIFY_TYPE_LABELS = Object.freeze({
  mention: '@提及',
  comment_reply: '回复评论',
  like_comment: '赞了评论',
  like_danmaku: '赞了弹幕',
  follow: '新关注',
})

const DEFAULT_MAX_TEXT = 500
const MAX_PENDING_EVENTS = 200
const HEALTH_TIMEOUT = Symbol('health-timeout')

function cut(text, max = DEFAULT_MAX_TEXT) {
  const chars = Array.from(String(text ?? ''))
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('')
}

function squash(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** 去重键：type+actor+text+time；缺字段用空串，全空返回 '' 表示跳过 */
export function notifyKey(item) {
  const type = String(item?.type ?? '')
  const actor = String(item?.actor ?? '')
  const text = String(item?.text ?? '')
  const time = String(item?.time ?? '')
  if (!type && !actor && !text && !time) return ''
  return [type, actor, text, time].join('\u0001')
}

/** 去重键：相对时间归一到 recent，避免同一通知时间标签变化后重复投 */
export function notifyDedupeKey(item) {
  const type = String(item?.type ?? '')
  const actor = String(item?.actor ?? '')
  const text = String(item?.text ?? '')
  const rawTime = String(item?.time ?? '')
  // 2026-11-16：刷新后相对时间会变绝对时间（如 09:41），也要归一，避免重复投旧通知
  const time = /刚刚|秒前|分钟前|小时前/.test(rawTime) || /^\d{1,2}:\d{2}$/.test(rawTime) ? 'recent' : rawTime
  if (!type && !actor && !text && !time) return ''
  return [type, actor, text, time].join('\u0001')
}

/** 投递给 home 的正文：类型 + 作者 + 正文 + 时间（≤500 字） */
export function formatNotifyText(item, max = DEFAULT_MAX_TEXT) {
  const actor = String(item?.actor ?? '').trim() || '抖音用户'
  const label = NOTIFY_TYPE_LABELS[String(item?.type ?? '')] || '通知'
  const text = String(item?.text ?? '').trim()
  const time = String(item?.time ?? '').trim()
  const body = text ? `：${text}` : ''
  const tail = time ? `（${time}）` : ''
  return cut(`【抖音通知】${label}｜${actor}${body}${tail}`, max)
}

function readOwnerAliasesFrom(cfg) {
  const out = []
  const seen = new Set()
  const add = (raw) => {
    const s = String(raw ?? '').trim().replace(/^@+/, '')
    const key = s.replace(/\s+/g, '').toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(s)
  }
  for (const a of Array.isArray(cfg?.dmOwnerAliases) ? cfg.dmOwnerAliases : []) add(a)
  try {
    if (cfg?.dmOwnerFile && existsSync(cfg.dmOwnerFile)) {
      const line = String(readFileSync(cfg.dmOwnerFile, 'utf8')).split('\n').map((x) => x.trim()).find(Boolean)
      if (line) add(line)
    }
  } catch {
    // 读不到主人文件就用别名
  }
  return out
}

/**
 * @param {{
 *   cfg: object,
 *   service: object,
 *   ctx?: object|null,
 *   log?: object|null,
 *   clock?: () => number,
 *   timers?: { setTimeout?: Function, clearTimeout?: Function },
 *   onEvent?: (event: object) => void,
 *   bridge?: object|null,   // 崩溃感知用：bridge.call('health') / bridge.health()（可选，老桥静默忽略）
 * }} deps
 */
export function createNotifyWatcher({
  cfg,
  service,
  ctx = null,
  log = null,
  clock = Date.now,
  timers = null,
  onEvent = null,
  bridge = null,
} = {}) {
  const setT = timers?.setTimeout ?? setTimeout
  const clearT = timers?.clearTimeout ?? clearTimeout
  const seen = new Set()
  // 2026-11-17 修 bug：相对时间（刚刚/N分钟前）的通知 id 会把时间归一成 "recent"，
  // 于是「主人第二次 @汐」的 id 和第一次完全相同 → 被 seen 永久吞掉（实测 @ 了没反应）。
  // 现在相对时间的事件按「估算发生时间」(now - ageMs) 判重：同一条通知每次读到的 est 基本不变；
  // 而新的 @ 会有一个新的 est（相差 > 判重窗口）→ 重新投递。est 落盘，重启后不会把同一条再投一遍。
  const delivered = new Map() // baseHash -> estMs
  const pending = []
  const subscribers = new Set()
  const stats = {
    ticks: 0,
    baselineAt: null,
    eventsEmitted: 0,
    delivered: 0,
    skipped: 0,
    errors: 0,
    panelOpens: 0,
    panelOpenSkipped: 0,
    panelPollsDue: 0,
    triggerBadge: 0,
    triggerNet: 0,
    busySkips: 0,
    healthProbes: 0,
    healthErrors: 0,
    healthSkipped: 0,
    lastHealthAt: null,
    lastHealth: null,
    lastCode: null,
    lastErrorAt: null,
    lastTickAt: null,
    lastOkAt: null,
    sourceSeq: 0,
    sourceCursor: 0,
    sourcePending: 0,
    recentDupeSkipped: 0,
  }
  let timer = null
  let stopped = false
  let running = false
  let primed = false
  let lastLoggedCode = null
  let stateLoaded = false
  let lastBadgeSig = null
  let lastBadge = null
  let badgeAvailable = false
  let badgeCount = 0
  let badgeMode = null
  let sourceStarted = false
  let sourceCode = null
  let nextSourceRetryAt = 0
  let lastSourceStartAt = 0
  let nextBaselineAt = 0
  let lastPanelOpenAt = 0
  let lastPanelReadAt = 0
  let lastPanelPollAt = 0
  let pendingTrigger = false
  let lastPanelRawCount = 0
  let lastPanelItemCount = 0
  let tickFailCode = null
  let tickFailMessage = null
  const triggerSuppressMs = 5000
  const ownerAliases = readOwnerAliasesFrom(cfg)

  const intervalMs = Math.max(2000, Math.min(30000, Number(cfg?.notifyWatchIntervalMs) || 3000))
  const startupDelayMs = Math.max(0, Math.min(60000, Number(cfg?.notifyWatchStartupDelayMs) || 0))
  const maxSeen = Math.max(50, Math.min(5000, Number(cfg?.notifyWatchMaxSeen) || 500))
  const limit = Math.max(1, Math.min(50, Number(cfg?.notifyWatchLimit) || 20))
  const maxAgeMs = Math.max(60000, Number(cfg?.notifyWatchMaxAgeMs) || 600000)
  const takeLimit = Math.max(1, Math.min(100, Number(cfg?.notifyWatchJsTakeLimit) || 30))
  const sourceMode = ['auto', 'badge', 'js', 'panel'].includes(cfg?.notifyWatchSource)
    ? cfg.notifyWatchSource
    : 'auto'
  const badgeSelectors = Array.isArray(cfg?.notifyWatchBadgeSelectors) ? cfg.notifyWatchBadgeSelectors : []
  const badgeHtmlFallback = cfg?.notifyWatchBadgeHtmlFallback === true
  const baselineEnabled = cfg?.notifyWatchBaselineEnabled !== false
  const baselineRetryMs = Math.max(10000, Math.min(600000, Number(cfg?.notifyWatchBaselineRetryMs) || 60000))
  const panelMinGapMs = Math.max(3000, Math.min(300000, Number(cfg?.notifyWatchPanelMinGapMs) || 15000))
  // 相对时间通知的判重窗口（同一 @ 在窗口内算同一条；大于窗口视为新的一条）
  const recentDupeWindowMs = Math.max(30000, Math.min(600000, Number(cfg?.notifyRecentDupeWindowMs) || 120000))
  // 重启补投窗口：进程重启后第一轮把窗口内"没投过"的通知补一次（est 判重保证不重复）
  const catchUpMaxAgeMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(cfg?.notifyCatchUpMaxAgeMs ?? 6 * 60 * 60 * 1000) || 0))
  let firstTickDone = false
  const reloadMs = Math.max(5000, Math.min(600000, Number(cfg?.notifyWatchReloadMs) || 15000))
  let lastPanelReloadAt = 0
  // 独立 notify tab 专用：panel 模式仍以面板为数据源，但不再每 tick 开面板：
  // 只有 badge/net 触发，或距上次读面板 >= notifyPanelPollMs（默认 60s）才开（protocol-v2 §B）。
  const forcePanelPoll = sourceMode === 'panel'
  const panelPollMs = Math.max(5000, Math.min(600000, Number(cfg?.notifyPanelPollMs ?? 60000) || 60000))
  const healthTimeoutMs = Math.max(300, Math.min(10000, Number(cfg?.watchHealthTimeoutMs ?? 2500) || 2500))
  // 失败指数退避 + 熔断（cfg 键由 corefix 并行加；没加时全用默认值）
  const guard = createWatchGuard({
    minMs: Number(cfg?.watchBackoffMinMs ?? 3000),
    maxMs: Number(cfg?.watchBackoffMaxMs ?? 60000),
    factor: Number(cfg?.watchBackoffFactor ?? 2),
    breakerFails: Number(cfg?.watchBreakerFails ?? 12),
    cooldownMs: Number(cfg?.watchBreakerCooldownMs ?? 300000),
    clock,
    log,
    label: 'notify live watcher',
  })
  const deliver = cfg?.notifyWatchDeliver !== false
  const stateFile = String(cfg?.notifyWatchStateFile ?? '')

  function loadState() {
    if (stateLoaded) return
    stateLoaded = true
    if (!stateFile) return
    try {
      const data = JSON.parse(readFileSync(stateFile, 'utf8'))
      // version 1 是旧 10 分钟 notifyList watcher 的 key 格式，和实时事件 id 不兼容：
      // 直接忽略并重新建基线，避免把历史通知当新事件灌进 home。
      if (data?.version !== 2) return
      if (Array.isArray(data?.seen)) {
        for (const h of data.seen.slice(-maxSeen)) if (typeof h === 'string') seen.add(h)
      }
      const deliveredRaw = data?.delivered && typeof data.delivered === 'object' && !Array.isArray(data.delivered)
        ? data.delivered
        : null
      if (deliveredRaw) {
        for (const [h, at] of Object.entries(deliveredRaw).slice(-200)) {
          const v = Number(at)
          if (typeof h === 'string' && h && Number.isFinite(v)) delivered.set(h, v)
        }
      }
      primed = data?.primed === true
      if (Number.isFinite(Number(data?.baselineAt))) stats.baselineAt = Number(data.baselineAt)
    } catch {
      // 状态文件缺失/损坏：当首次启动重新建基线
    }
  }

  function saveState() {
    if (!stateFile) return
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(
        stateFile,
        JSON.stringify({
          version: 2,
          primed,
          baselineAt: stats.baselineAt,
          seen: [...seen],
          // 只存 baseHash→估算发生时间，不存正文（去重够用）
          delivered: Object.fromEntries([...delivered].slice(-200)),
          updatedAt: clock(),
        }),
        { encoding: 'utf8', mode: 0o600 },
      )
    } catch {
      // 落盘失败不影响事件投递
    }
  }

  function prune() {
    while (seen.size > maxSeen) {
      const first = seen.values().next()
      if (first.done) break
      seen.delete(first.value)
    }
    // delivered：最多 200 条，且只留最近 7 天
    const cutoff = clock() - 7 * 24 * 3600_000
    for (const [h, at] of delivered) {
      if (Number(at) < cutoff) delivered.delete(h)
    }
    while (delivered.size > 200) {
      const first = delivered.keys().next()
      if (first.done) break
      delivered.delete(first.value)
    }
  }

  // 2026-11-17：把关键事件写文件（ctx.logger 在 DSH 里看不到，排障没有观测点）。
  // 只记 时间/类型/计数/错误码，不记通知正文；文件超过 512KB 自动截断重写。
  const logFile = String(cfg?.notifyWatchLogFile ?? '/sdcard/DSHA/媒体/抖音/notify-watch.log')
  let logFileBytes = -1
  function fileLog(kind, data = {}) {
    if (!logFile) return
    try {
      if (logFileBytes < 0) {
        try { logFileBytes = statSync(logFile).size } catch { logFileBytes = 0 }
      }
      if (logFileBytes > 512 * 1024) {
        try { writeFileSync(logFile, '', { encoding: 'utf8', mode: 0o600 }) } catch {}
        logFileBytes = 0
      }
      const line = JSON.stringify({ at: new Date(clock()).toISOString(), kind, ...data }).slice(0, 1200)
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
      logFileBytes += line.length + 1
    } catch {
      // 日志失败不影响主流程
    }
  }

  function logOnce(code, message) {
    if (code === lastLoggedCode) return
    lastLoggedCode = code
    try {
      log?.warn?.(`[douyin] notify live watcher ${message}`)
    } catch {
      // 日志失败不影响主流程
    }
  }

  /** watchQueue 忙（深度 1）时的 skip 应答：整轮跳过，不算失败也不算成功 */
  function busyOf(r) {
    return Boolean(r && r.ok !== false && r.skipped === true && String(r.reason ?? '') === 'busy')
  }

  function busySkip(triggers = []) {
    stats.busySkips += 1
    return { ok: true, skipped: true, reason: 'busy', newCount: 0, events: [], triggers }
  }

  /** 记一次本轮失败（只影响本轮 failed 标记；退避由 guard 在 schedule 侧算） */
  function noteError(code, message = '') {
    const c = String(code ?? 'E_REMOTE_IO')
    stats.errors += 1
    stats.lastCode = c
    stats.lastErrorAt = clock()
    tickFailCode = c
    if (message) tickFailMessage = String(message).slice(0, 300)
    return c
  }

  function summarizeHealth(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null
    const roles = {}
    if (result.roles && typeof result.roles === 'object' && !Array.isArray(result.roles)) {
      for (const [role, info] of Object.entries(result.roles)) {
        roles[role] = String(info?.renderer ?? 'unknown')
      }
    }
    return {
      browser: result.browser === true,
      pages: Number(result.pages) || 0,
      ...(Object.keys(roles).length ? { roles } : {}),
    }
  }

  function raceTimeout(promise, ms) {
    let timer = null
    const timeout = new Promise((resolve) => {
      timer = setT(() => resolve(HEALTH_TIMEOUT), ms)
      timer?.unref?.()
    })
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
      if (timer) {
        try { clearT(timer) } catch {}
        timer = null
      }
    })
  }

  /**
   * 崩溃感知：立刻请求一次桥 health（极快命令，不排队）。
   * - 老桥/老客户端不认识 health（E_UNKNOWN_CMD / E_BAD_ARG）→ 静默忽略，只记 stats.healthSkipped；
   * - 没有 bridge 依赖也跳过（只记日志），绝不因此让 tick 抛错。
   */
  async function probeHealth(reason) {
    stats.healthProbes += 1
    try {
      log?.warn?.(`[douyin] notify live watcher 页面崩溃（${String(reason ?? 'crash')}），已请求健康检查`)
    } catch {}
    if (!bridge || typeof bridge !== 'object') {
      stats.healthSkipped += 1
      return { ok: false, skipped: true, reason: 'no-bridge' }
    }
    let pending
    try {
      pending = typeof bridge.health === 'function'
        ? bridge.health()
        : (typeof bridge.call === 'function' ? bridge.call('health', {}, { timeoutMs: healthTimeoutMs }) : null)
    } catch (e) {
      pending = Promise.reject(e)
    }
    if (!pending) {
      stats.healthSkipped += 1
      return { ok: false, skipped: true, reason: 'no-health' }
    }
    try {
      const r = await raceTimeout(pending, healthTimeoutMs)
      if (r === HEALTH_TIMEOUT) {
        stats.healthErrors += 1
        try { log?.warn?.('[douyin] notify live watcher 健康检查超时（不重试）') } catch {}
        return { ok: false, code: 'E_TIMEOUT' }
      }
      stats.lastHealthAt = clock()
      stats.lastHealth = summarizeHealth(r)
      return { ok: true, result: r }
    } catch (e) {
      const code = String(e?.code ?? 'E_REMOTE_IO')
      const message = String(e?.message ?? e)
      if (code === 'E_UNKNOWN_CMD' || code === 'E_BAD_ARG' || /unknown|不允许的桥命令|not allowed/i.test(message)) {
        stats.healthSkipped += 1
        return { ok: false, skipped: true, code }
      }
      stats.healthErrors += 1
      return { ok: false, code }
    }
  }

  function parseOpts() {
    return { ownerAliases, replyWindowMs: cfg?.commentReplyWindowMs ?? 0, now: clock() }
  }

  function itemKey(item) {
    return String(item?.id ?? '') || notifyDedupeKey(item)
  }

  function isFresh(item, limitMs = maxAgeMs) {
    if (!Object.prototype.hasOwnProperty.call(item ?? {}, 'ageMs')) return true
    // parseNotifyItems 对“星期三/日期”给 ageMs=null：视为旧通知，不投实时事件
    if (item.ageMs === null || item.ageMs === undefined) return false
    const age = Number(item.ageMs)
    if (!Number.isFinite(age) || age < 0 || age > limitMs) return false
    return true
  }

  function buildEvent(item, source) {
    const key = itemKey(item)
    const owner = item?.isOwner === true
    return {
      id: key,
      type: item?.type ?? '',
      actor: item?.actor ?? '',
      text: item?.text ?? '',
      time: item?.time ?? '',
      ageMs: item?.ageMs ?? null,
      isOwner: owner,
      owner,
      replyable: item?.replyable === true || isNotifyReplyable(item, { windowMs: cfg?.commentReplyWindowMs ?? 0, now: clock() }),
      route: owner ? 'home' : 'douyin',
      source,
      at: clock(),
    }
  }

  function notifySubscribers(event) {
    for (const fn of [onEvent, ...subscribers]) {
      if (typeof fn !== 'function') continue
      try {
        fn(event)
      } catch {
        // 订阅者异常不能打断 watcher
      }
    }
  }

  function bufferEvents(events) {
    for (const event of Array.isArray(events) ? events : []) {
      pending.push(event)
      while (pending.length > MAX_PENDING_EVENTS) {
        pending.shift()
        stats.skipped += 1
      }
    }
  }

  function drainEvents(n = 100) {
    const take = Math.max(1, Math.min(MAX_PENDING_EVENTS, Number(n) || 100))
    return pending.splice(0, take)
  }

  function recentBaseKey(item) {
    return hash12(`${item?.type ?? ''}\u0001${item?.actor ?? ''}\u0001${item?.text ?? ''}`)
  }

  function seed(items) {
    for (const item of Array.isArray(items) ? items : []) {
      const key = itemKey(item)
      if (key) seen.add(key)
      // 基线里的相对时间条目也记 est：之后同一条（est 基本不变）不会当新事件，新的 @ 仍会投
      // 注意 Number(null)===0：ageMs 为 null（只有日期/星期的旧通知）不能当"刚刚"处理
      const ageRaw = item?.ageMs
      const age = Number(ageRaw)
      if (ageRaw !== null && ageRaw !== undefined && Number.isFinite(age) && age >= 0) {
        const base = recentBaseKey(item)
        if (!delivered.has(base)) delivered.set(base, clock() - age)
      }
    }
    prune()
  }

  async function snapshot({ allowOpen }) {
    if (typeof service?.notifySnapshotForWatch === 'function') {
      const r = await service.notifySnapshotForWatch({ allowOpen, limit })
      if (busyOf(r)) return { ok: true, busy: true, open: false, opened: false, items: [], count: 0 }
      return r
    }
    // 兼容旧注入（只有 notifyList）：只能当成“打开面板读一次”
    if (allowOpen && typeof service?.notifyList === 'function') {
      const r = await service.notifyList({ limit, loadMore: false, keepOpen: false })
      if (busyOf(r)) return { ok: true, busy: true, open: false, opened: false, items: [], count: 0 }
      return { ...(r ?? {}), open: r?.ok === true, opened: r?.ok === true }
    }
    return { ok: true, open: false, opened: false, items: [], count: 0 }
  }

  async function probeBadge() {
    if (typeof service?.notifyBadgeProbe !== 'function') return { ok: true, available: false }
    const r = await service.notifyBadgeProbe({ selectors: badgeSelectors })
    if (busyOf(r)) return { ok: true, busy: true, available: false, code: 'E_BUSY' }
    return r
  }

  async function ensureSource() {
    if (sourceMode === 'panel' || sourceMode === 'badge') return { ok: true, skipped: true }
    // jsWatch 的 observer 在页面导航后会丢；每 10s 重新 start 一次（幂等）以重新武装
    if (sourceStarted && clock() - lastSourceStartAt < 10000) return { ok: true, started: true }
    if (typeof service?.notifySourceStart !== 'function') {
      sourceCode = 'E_BAD_ARG'
      return { ok: false, code: sourceCode }
    }
    if (clock() < nextSourceRetryAt) return { ok: false, code: sourceCode }
    let r
    try {
      r = await service.notifySourceStart()
    } catch (e) {
      r = { ok: false, code: e?.code ?? 'E_REMOTE_IO' }
    }
    // watchQueue 忙：本轮整轮跳过（不改 sourceCode/退避状态，下一轮重试 start）
    if (busyOf(r)) return { ok: true, busy: true, started: false }
    if (r?.ok === true) {
      const recovered = sourceCode === 'E_PAGE_UNSAFE'
      sourceStarted = true
      lastSourceStartAt = clock()
      sourceCode = null
      // 从私信页/视频页回到主站页后，立刻允许基线重试，不干等 60s
      if (recovered) nextBaselineAt = 0
      try { log?.info?.('[douyin] notify live watcher 已启动 jsWatch（DOM/fetch 观察，不点条目）') } catch {}
      return r
    }
    sourceCode = String(r?.code ?? 'E_REMOTE_IO')
    sourceStarted = false
    // 页面不安全会随用户切页很快变化，按一个轮询间隔重试；其它错误 60s 退避
    nextSourceRetryAt = clock() + (sourceCode === 'E_PAGE_UNSAFE' ? intervalMs : 60000)
    logOnce(sourceCode, `jsWatch 启动失败（继续 badge/面板模式）：${sourceCode}`)
    return r
  }

  async function takeSource() {
    if (!sourceStarted || typeof service?.notifySourceTake !== 'function') return { ok: true, events: [] }
    let r
    try {
      r = await service.notifySourceTake({ limit: takeLimit })
    } catch (e) {
      r = { ok: false, code: e?.code ?? 'E_REMOTE_IO', events: [] }
    }
    if (busyOf(r)) return { ok: true, busy: true, events: [] }
    if (r?.ok !== true) {
      const code = noteError(r?.code ?? 'E_REMOTE_IO', r?.message)
      logOnce(code, `jsWatch take 失败（不重试同轮）：${code}`)
      return { ok: false, code, events: [] }
    }
    const seq = Number(r.seq) || 0
    // 页面导航会换一个 JS context，jsWatch seq 归零：下一轮重新 start
    if (stats.sourceSeq > 0 && seq < stats.sourceSeq) {
      sourceStarted = false
      sourceCode = 'E_SOURCE_RESET'
      lastSourceStartAt = 0
      nextSourceRetryAt = 0
      logOnce('E_SOURCE_RESET', 'jsWatch 上下文重置（页面导航），下一轮重新安装 observer')
    }
    stats.sourceSeq = seq
    stats.sourceCursor = Number(r.cursor) || 0
    stats.sourcePending = Number(r.pending) || 0
    return { ok: true, events: Array.isArray(r.events) ? r.events : [] }
  }

  function checkBadgeSignature(probe) {
    if (!probe || probe.available !== true) {
      badgeAvailable = false
      lastBadgeSig = null
      lastBadge = null
      return false
    }
    badgeAvailable = true
    badgeCount = Number(probe.count) || 0
    badgeMode = probe.mode ?? 'html'
    const sig = String(probe.signature ?? '')
    if (lastBadgeSig === null || !lastBadge) {
      lastBadgeSig = sig
      lastBadge = { count: badgeCount, dot: probe.dot === true, mode: badgeMode }
      return false
    }
    const prev = lastBadge
    const increased = badgeCount > prev.count
      || (probe.dot === true && prev.dot !== true)
      || (badgeCount > 0 && prev.count === 0)
    const htmlChanged = badgeHtmlFallback && badgeMode === 'html' && sig !== lastBadgeSig
    lastBadgeSig = sig
    lastBadge = { count: badgeCount, dot: probe.dot === true, mode: badgeMode }
    return Boolean(increased || htmlChanged)
  }

  async function deliverEvents(events) {
    if (!deliver || !events.length) return { delivered: 0, skipped: 0 }
    // 有订阅方（autonomy）时由订阅方统一路由，避免 owner 通知同时被直接投 home 造成重复
    if (subscribers.size > 0) return { delivered: 0, skipped: 0, delegated: true }
    let home = null
    try {
      home = ctx?.get?.('dyHome') ?? null
    } catch {
      home = null
    }
    if (!home || typeof home.deliver !== 'function') {
      fileLog('deliver-unavailable', { count: events.length, delegated: false })
      stats.skipped += events.length
      logOnce('E_HOME_UNAVAILABLE', `dyHome 不可用，${events.length} 条通知事件未投递（事件仍已入队）`)
      return { delivered: 0, skipped: events.length }
    }
    let delivered = 0
    let skipped = 0
    for (const event of events) {
      const payload = event.isOwner === true
        ? {
            channel: 'douyin',
            kind: 'private',
            contactId: String(event.actor ?? '').trim() || 'douyin',
            contactName: String(event.actor ?? '').trim() || '抖音',
            text: formatNotifyText(event),
            priority: 'normal',
          }
        : {
            channel: 'douyin',
            kind: 'private',
            contactId: String(cfg?.notifyWatchOtherContactId ?? 'douyin').trim() || 'douyin',
            contactName: String(cfg?.notifyWatchOtherContactName ?? '抖音').trim() || '抖音',
            text: formatNotifyText(event),
            priority: 'normal',
          }
      try {
        const r = await home.deliver(payload)
        if (r && r.ok === true) delivered += 1
        else {
          skipped += 1
          logOnce(String(r?.code ?? 'HOME_REJECTED'), `home 拒收通知（不重试）：${String(r?.code ?? 'UNKNOWN')}`)
        }
      } catch (e) {
        skipped += 1
        logOnce(String(e?.code ?? 'DELIVERY_FAILED'), `home 投递异常（不重试）：${String(e?.code ?? e?.message ?? e)}`)
      }
    }
    fileLog('deliver', { delivered, skipped, total: events.length })
    stats.delivered += delivered
    stats.skipped += skipped
    return { delivered, skipped }
  }

  /**
   * 单次事件源轮询：badge/jsWatch/已开面板 → 候选 → 去重 → 事件 → dyHome。
   *
   * 2026-11-16：panel 模式不再每 tick 开面板 —— pendingTrigger 只在
   *   (a) 有 badge/net 触发，或 (b) 距上次读面板 >= notifyPanelPollMs（默认 60s）时置位；
   * watchQueue 忙（skipped:busy）时整轮跳过，不推进基线/候选。
   */
  async function runTick() {
    if (forcePanelPoll && typeof service?.notifyRefreshForWatch === 'function' && clock() - lastPanelReloadAt >= reloadMs) {
      lastPanelReloadAt = clock()
      try { await service.notifyRefreshForWatch() } catch {}
    }
    const src = await ensureSource()
    if (src?.busy) return busySkip()
    const candidates = []
    const triggers = []

    const useBadge = sourceMode === 'auto' || sourceMode === 'badge'
    const badgeProbe = useBadge
      ? await probeBadge().catch((e) => ({ ok: false, code: e?.code ?? 'E_REMOTE_IO', available: false }))
      : { ok: true, available: false }
    if (badgeProbe?.busy) return busySkip(triggers)
    if (useBadge && badgeProbe?.available === false) {
      logOnce(String(badgeProbe?.code ?? 'E_BADGE_MISS'), '角标入口未命中（不打开面板；继续 jsWatch/已开面板模式）')
    }
    if (checkBadgeSignature(badgeProbe)) {
      triggers.push('badge')
      stats.triggerBadge += 1
    }

    const source = await takeSource()
    if (source?.busy) return busySkip(triggers)
    for (const ev of source.events ?? []) {
      if (ev?.kind === 'dom') {
        // jsWatch 也会观察私信会话/消息节点；这里只收通知面板，避免把 DM 正文误当通知
        const selector = String(ev.selector ?? '')
        if (/conversation|MessageItem|message-item|chat/i.test(selector)) continue
        const parsed = parseNotifyItems([{ text: String(ev.text ?? '') }], cfg?.notifyTextLen ?? 500, parseOpts())
        for (const item of parsed) candidates.push({ item, source: 'js-dom' })
      } else if (isNotifyTriggerEvent(ev)) {
        // 开/读面板本身会触发通知 API 响应；读后 5s 内的 net 事件不再当第二次触发，防自激循环
        if (clock() - lastPanelReadAt > triggerSuppressMs) {
          triggers.push('net')
          stats.triggerNet += 1
        }
      }
    }

    // 面板已经开着：被动读，绝不点条目；未开则不发任何点击
    const passive = await snapshot({ allowOpen: false }).catch((e) => ({ ok: false, code: e?.code ?? 'E_REMOTE_IO', open: false, items: [] }))
    if (passive?.busy) return busySkip(triggers)
    if (passive?.ok !== false && passive?.open === true) {
      lastPanelReadAt = clock()
      lastPanelPollAt = clock()
      pendingTrigger = false // 面板开着，本轮已被动读到，不需要再开
      lastPanelRawCount = Number(passive.rawCount) || (passive.items ?? []).length
      lastPanelItemCount = (passive.items ?? []).length
      for (const item of passive.items ?? []) candidates.push({ item, source: 'panel' })
    }

    if (!primed) {
      if (passive?.open === true && (passive.items ?? []).length) {
        seed(passive.items)
        primed = true
        pendingTrigger = false
        stats.baselineAt = clock()
        saveState()
        try { log?.info?.(`[douyin] notify live watcher 基线 ${seen.size} 条（已打开面板，历史不投）`) } catch {}
        return { ok: true, baseline: true, newCount: 0, events: [], triggers }
      }
      if (baselineEnabled && clock() >= nextBaselineAt) {
        nextBaselineAt = clock() + baselineRetryMs
        const snap = await snapshot({ allowOpen: true }).catch((e) => ({ ok: false, code: e?.code ?? 'E_REMOTE_IO', open: false, items: [] }))
        if (snap?.busy) return busySkip(triggers)
        if (snap?.opened === true) stats.panelOpens += 1
        if (snap?.ok === true && snap?.open === true) {
          lastPanelReadAt = clock()
          lastPanelPollAt = clock()
          lastPanelRawCount = Number(snap.rawCount) || (snap.items ?? []).length
          lastPanelItemCount = (snap.items ?? []).length
          seed(snap.items ?? [])
          primed = true
          pendingTrigger = false
          stats.baselineAt = clock()
          saveState()
          try { log?.info?.(`[douyin] notify live watcher 基线 ${seen.size} 条（历史不投）`) } catch {}
          return { ok: true, baseline: true, newCount: 0, events: [], triggers }
        }
        const code = noteError(snap?.code ?? 'E_REMOTE_IO', snap?.message)
        logOnce(code, `基线读取失败（不导航/不重试同轮）：${code}`)
      }
      // 还没基线：只把本次 DOM 候选丢掉/不投，等基线读取；绝不把历史一次灌出去
      return { ok: true, baseline: false, newCount: 0, events: [], triggers }
    }

    // (a) badge/net 触发；(b) panel 模式到点（默认 60s）才开一次面板
    const panelPollDue = forcePanelPoll && clock() - lastPanelPollAt >= panelPollMs
    if (panelPollDue) stats.panelPollsDue += 1
    if (triggers.length > 0 || panelPollDue) pendingTrigger = true
    if (pendingTrigger && passive?.open !== true) {
      if (clock() - lastPanelOpenAt < panelMinGapMs) {
        stats.panelOpenSkipped += 1
      } else {
        lastPanelOpenAt = clock()
        pendingTrigger = false
        const snap = await snapshot({ allowOpen: true }).catch((e) => ({ ok: false, code: e?.code ?? 'E_REMOTE_IO', open: false, items: [] }))
        if (snap?.busy) return busySkip(triggers)
        if (snap?.opened === true) stats.panelOpens += 1
        if (snap?.ok === true && snap?.open === true) {
          lastPanelReadAt = clock()
          lastPanelPollAt = clock()
          lastPanelRawCount = Number(snap.rawCount) || (snap.items ?? []).length
          lastPanelItemCount = (snap.items ?? []).length
          for (const item of snap.items ?? []) candidates.push({ item, source: 'panel' })
        } else if (snap?.code) {
          pendingTrigger = true // 页面不安全/临时失败：过窗后继续补读
          const code = noteError(snap.code, snap.message)
          logOnce(code, `触发后读取面板失败（过窗后补读）：${code}`)
        }
      }
    }

    // 去重 + 新鲜度过滤
    const fresh = []
    const freshKeys = new Set()
    for (const c of candidates) {
      const item = c.item
      const key = itemKey(item)
      if (!key || freshKeys.has(key)) continue
      // 重启后的第一轮：用 catchUp 窗口放宽（漏掉的通知补一次；est 判重防重复）
      const freshLimit = firstTickDone || catchUpMaxAgeMs <= 0 ? maxAgeMs : Math.max(maxAgeMs, catchUpMaxAgeMs)
      if (!isFresh(item, freshLimit)) {
        if (!seen.has(key)) seen.add(key)
        continue
      }
      // 相对时间（刚刚/N分钟前/N小时前）：按「估算发生时间 est」判重，而不是"永久 seen"
      const age = Number(item?.ageMs)
      if (Number.isFinite(age) && age >= 0) {
        const base = recentBaseKey(item)
        const est = clock() - age
        const prevEst = delivered.get(base)
        if (Number.isFinite(prevEst) && Math.abs(est - prevEst) < recentDupeWindowMs) {
          stats.recentDupeSkipped += 1
          freshKeys.add(key)
          continue
        }
        delivered.set(base, est)
      } else if (seen.has(key)) {
        continue
      }
      freshKeys.add(key)
      fresh.push(buildEvent(item, c.source))
    }
    for (const ev of fresh) seen.add(ev.id)
    if (!firstTickDone) firstTickDone = true
    prune()
    stats.lastOkAt = clock()
    if (fresh.length) {
      for (const ev of fresh) {
        stats.eventsEmitted += 1
        notifySubscribers(ev)
      }
      saveState()
      fileLog('events', {
        count: fresh.length,
        triggers,
        items: fresh.slice(0, 10).map((e) => ({ type: e.type, actor: e.actor, time: e.time, ageMs: e.ageMs, owner: e.isOwner })),
      })
      if (deliver) await deliverEvents(fresh)
      try { log?.info?.(`[douyin] notify live watcher 新事件 ${fresh.length} 条（只读，未点条目）`) } catch {}
    }
    return { ok: true, baseline: false, newCount: fresh.length, events: fresh, triggers }
  }

  /** 对外 tick：串行守卫 + 把本轮失败码挂到返回值（退避由 schedule 侧 guard 决定） */
  async function tick() {
    if (running) return { ok: true, skipped: true, reason: 'busy', newCount: 0, events: [] }
    running = true
    stats.ticks += 1
    stats.lastTickAt = clock()
    tickFailCode = null
    tickFailMessage = null
    loadState()
    if (!primed && !baselineEnabled) {
      primed = true
      stats.baselineAt = clock()
      saveState()
    }
    try {
      const r = await runTick()
      // 心跳：每 20 tick 记一行，便于确认 watcher 真的在跑（排障用）
      if (stats.ticks % 20 === 0) {
        fileLog('tick', {
          ticks: stats.ticks,
          primed,
          pollsDue: stats.panelPollsDue,
          opens: stats.panelOpens,
          events: stats.eventsEmitted,
          delivered: stats.delivered,
          newCount: r?.newCount ?? 0,
          triggers: r?.triggers ?? [],
          lastCode: stats.lastCode,
        })
      }
      if (tickFailCode && r?.failed !== true) {
        const out = { ...r, failed: true, code: tickFailCode, ...(tickFailMessage ? { message: tickFailMessage } : {}) }
        // 崩溃类错误：本轮立刻请求一次桥 health（单次 tick 里的崩溃也要可见）
        if (isCrashCode(out.code, out.message ?? '')) {
          try { await probeHealth(out.code === 'E_REMOTE_IO' ? 'Target crashed' : out.code) } catch {}
        }
        return out
      }
      return r
    } finally {
      running = false
    }
  }

  /**
   * tick 之后的失败处理 + 下一次排期时长：
   * - 失败类错误 → guard.fail（指数退避 / 熔断）；
   * - 崩溃类 → 立刻请求一次桥 health（不阻塞排期）；
   * - busy skip → 不算失败，按正常间隔重试；
   * - 成功 → 退避归零。
   */
  async function afterTick(result) {
    const code = result?.failed === true || result?.ok === false
      ? String(result?.code ?? stats.lastCode ?? 'E_REMOTE_IO')
      : null
    if (code) {
      // 只处理 tick 之外的兜底异常（tick 内部已做过崩溃探测，避免重复发 health）
      if (result?.failed !== true && isCrashCode(code, result?.message ?? '')) {
        try { await probeHealth(code === 'E_REMOTE_IO' ? 'Target crashed' : code) } catch {}
      }
      if (isWatchFailCode(code)) {
        fileLog('fail', { code, errors: stats.errors })
        return guard.fail(code, intervalMs)
      }
      return guard.neutral(intervalMs)
    }
    if (result?.skipped === true && String(result?.reason ?? '') === 'busy') {
      stats.busySkips += 1
      return intervalMs
    }
    return guard.succeed(intervalMs)
  }

  function schedule(delayMs) {
    if (stopped) return
    const wait = Math.max(0, Number(delayMs) || 0)
    guard.setNextTickAt(clock() + wait)
    timer = setT(() => {
      timer = null
      // 返回 promise：真实 setTimeout 忽略返回值；测试可以 await 这一轮（含重新排期）
      const run = (async () => {
        let r = { ok: false, code: 'E_REMOTE_IO' }
        try {
          r = await tick()
        } catch (e) {
          r = { ok: false, code: e?.code ?? 'E_REMOTE_IO', message: String(e?.message ?? e) }
        }
        try { bufferEvents(r?.events) } catch {}
        let next = intervalMs
        try { next = await afterTick(r) } catch {}
        schedule(next)
        return { result: r, nextDelayMs: next }
      })()
      run.catch(() => {})
      return run
    }, wait)
    timer?.unref?.()
  }

  function start() {
    if (stopped || timer) return false
    if (cfg?.notifyWatchEnabled !== true) return false
    fileLog('start', { intervalMs, sourceMode, panelPollMs, maxAgeMs, catchUpMaxAgeMs, stateFile, primed })
    schedule(startupDelayMs)
    return true
  }

  function stop() {
    stopped = true
    if (timer) {
      try { clearT(timer) } catch {}
      timer = null
    }
    if (sourceStarted && typeof service?.notifySourceStop === 'function') {
      try { void service.notifySourceStop().catch(() => {}) } catch {}
      sourceStarted = false
    }
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {}
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }

  function status() {
    return {
      enabled: cfg?.notifyWatchEnabled === true,
      running: Boolean(timer),
      stopped,
      primed,
      seen: seen.size,
      pending: pending.length,
      intervalMs,
      startupDelayMs,
      sourceMode,
      sourceStarted,
      sourceCode,
      badgeAvailable,
      badgeCount,
      badgeMode,
      panelMinGapMs,
      panelPollMs,
      catchUpMaxAgeMs,
      firstTickDone,
      lastPanelOpenAt,
      lastPanelPollAt,
      lastPanelRawCount,
      lastPanelItemCount,
      healthTimeoutMs,
      hasBridge: Boolean(bridge),
      ...stats,
      // 退避/熔断：backoffMs / fails / breakerOpen / nextTickAt / lastFailCode（+= stats.lastCode）
      ...guard.status(),
    }
  }

  /**
   * notifyWatch 服务/工具入口：poll（默认，轮询一次并取队列）/drain/start/stop/status。
   * 事件不回复、不发送、不点条目。
   */
  async function request(args = {}) {
    const action = String(args?.action ?? '').trim() || 'poll'
    const n = Math.max(1, Math.min(100, Number(args?.limit) || 20))
    if (action === 'status') return { ok: true, events: [], count: 0, ...status() }
    if (action === 'start') {
      const started = start()
      return { ok: true, started, events: [], count: 0, ...status() }
    }
    if (action === 'stop') {
      stop()
      return { ok: true, stopped: true, events: [], count: 0, ...status() }
    }
    if (action === 'drain') {
      const events = drainEvents(n)
      return { ok: true, events, count: events.length, ...status() }
    }
    if (action !== 'poll') {
      return { ok: false, code: 'E_BAD_ARG', message: 'action 只接受 poll/drain/start/stop/status', events: [], count: 0 }
    }
    const r = await tick()
    bufferEvents(r.events)
    const events = drainEvents(n)
    return {
      ok: r.ok !== false,
      ...(r.code ? { code: r.code } : {}),
      ...(r.message ? { message: r.message } : {}),
      events,
      count: events.length,
      tick: {
        ok: r.ok !== false,
        baseline: r.baseline === true,
        newCount: r.newCount ?? 0,
        skipped: r.skipped === true,
        triggers: Array.isArray(r.triggers) ? r.triggers : [],
      },
      ...status(),
    }
  }

  return {
    start,
    stop,
    tick,
    request,
    status,
    subscribe,
    drainEvents,
    seen,
    get primed() {
      return primed
    },
  }
}
