/**
 * 抖音私信 → autonomy 的只读实时 watcher（默认关闭，profile 里显式开）。
 *
 * 设计约束（2026-11-14）：
 * - 只复用 `dmPollConversations`（打开 /chat 读会话列表）或 `dmList`；**不点开会话**
 *   （点开会标记已读）、不发送、不点赞、不回复；
 * - 默认每 3s 轮询（可配 2s–300s，要求 2–5s）；不用 10 分钟级轮询；
 * - 第一次成功读取只建基线，不把历史会话当“新消息”灌给 autonomy；
 * - 去重键 = 会话名 + 最后一条预览 + 归一化时间；同一快照重复出现只投一次；
 * - 新指纹要连续 dmWatchConfirmTicks（默认 2）次成功读取都出现才确认，过滤页面切换/并发导航的瞬时错位；
 * - 事件只进内存队列 / 订阅回调，**不路由、不投 home、不发消息**；谁取用谁负责；
 * - 定时器 unref，不阻塞宿主退出；stop() 后不再排期；读取失败只记日志、不抛、不重试。
 *
 * 已知限制：会话列表只给“最后一条预览 + 时间标签”，看不到消息 id/方向；
 * 需要精确到某条消息时，调用方再用事件里的 conversationId 调 `dmRead` 拿 id 列表。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isOwnerDisplayName } from './service.js'

const MIN_INTERVAL_MS = 2000
const MAX_INTERVAL_MS = 300000
const DEFAULT_INTERVAL_MS = 3000
const MAX_PENDING_EVENTS = 200
const DEFAULT_LIST_LIMIT = 20

function squash(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

const hash12 = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 12)

/**
 * 相对时间归一：刚刚/N秒前/N分钟前/N小时前 → recent。
 * 会话列表的时间只是标签，几分钟后“刚刚”会变“1分钟前”；不归一会在没有新消息时误报。
 * 代价：1 小时内同一会话发来“和上一条完全相同”的文字时，列表层无法区分（精确消息请 dmRead）。
 */
export function normalizeDmTimeLabel(label) {
  const text = squash(label)
  if (!text) return ''
  // 2026-11-16：页面刷新后“刚刚”会变成 "09:41"，旧指纹就会重复投递。
  // 当天绝对时间与相对时间统一归一，避免同一预览因时间标签变化再报一次。
  return /刚刚|秒前|分钟前|小时前/.test(text) || /^\d{1,2}:\d{2}$/.test(text) ? 'recent' : text
}

/** 会话“最后一条消息”的指纹：会话名 + 预览 + 归一化时间；历史相同快照不会重复上报 */
export function dmConversationFingerprint(conv) {
  return [squash(conv?.name), squash(conv?.preview), normalizeDmTimeLabel(conv?.time)].join('\u0001')
}

export function dmConversationFingerprintHash(conv) {
  return hash12(dmConversationFingerprint(conv))
}

/** 事件正文（方便日志/autonomy 直接读）；不含任何消息 id 推断 */
export function formatDmEventText(event) {
  const who = event?.owner === true ? `主人(${String(event?.conversationName ?? '').trim() || '?'})` : String(event?.conversationName ?? '').trim() || '抖音用户'
  const text = String(event?.text ?? '').trim()
  const time = String(event?.time ?? '').trim()
  return `【抖音私信】${who}${text ? `：${text}` : ''}${time ? `（${time}）` : ''}`
}

/**
 * @param {{
 *   cfg: object,
 *   service: { dmPollConversations?: Function, dmList?: Function },
 *   ctx?: object|null,
 *   log?: object|null,
 *   clock?: () => number,
 *   timers?: { setTimeout?: Function, clearTimeout?: Function },
 *   onEvent?: (event: object) => void,
 * }} deps
 */
export function createDmWatcher({
  cfg,
  service,
  ctx = null,
  log = null,
  clock = Date.now,
  timers = null,
  onEvent = null,
} = {}) {
  const setT = timers?.setTimeout ?? setTimeout
  const clearT = timers?.clearTimeout ?? clearTimeout
  const seen = new Set()
  const candidates = new Map() // fingerprint -> { conv, hits, firstAt }
  const pending = []
  const subscribers = new Set()
  const stats = {
    ticks: 0,
    baselineAt: null,
    eventsEmitted: 0,
    dropped: 0,
    errors: 0,
    lastCode: null,
    lastErrorAt: null,
    lastTickAt: null,
    lastOkAt: null,
    selfSkipped: 0,
  }
  let timer = null
  let stopped = false
  let running = false
  let primed = false
  let seq = 0
  let lastLoggedCode = null
  let stateLoaded = false

  const intervalMs = Math.max(
    MIN_INTERVAL_MS,
    Math.min(MAX_INTERVAL_MS, Number(cfg?.dmWatchIntervalMs) || DEFAULT_INTERVAL_MS),
  )
  const startupDelayMs = Math.max(0, Math.min(60000, Number(cfg?.dmWatchStartupDelayMs) || 0))
  const maxSeen = Math.max(50, Math.min(5000, Number(cfg?.dmWatchMaxSeen) || 1000))
  const confirmTicks = Math.max(1, Math.min(5, Number(cfg?.dmWatchConfirmTicks) || 2))
  const listLimit = Math.max(1, Math.min(50, Number(cfg?.dmWatchLimit) || DEFAULT_LIST_LIMIT))
  const keepOpen = cfg?.dmWatchKeepOpen !== false
  const stateFile = String(cfg?.dmWatchStateFile ?? '')
  const ownerAliases = Array.isArray(cfg?.dmOwnerAliases) ? cfg.dmOwnerAliases : []

  function loadState() {
    if (stateLoaded) return
    stateLoaded = true
    if (!stateFile) return
    try {
      const data = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (Array.isArray(data?.seen)) {
        for (const h of data.seen.slice(-maxSeen)) if (typeof h === 'string') seen.add(h)
      }
      primed = data?.primed === true
      if (Number.isFinite(Number(data?.baselineAt))) stats.baselineAt = Number(data.baselineAt)
    } catch {
      // 状态文件缺失/损坏：当作首次启动，重新建基线
    }
  }

  function saveState() {
    if (!stateFile) return
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(
        stateFile,
        JSON.stringify({ version: 1, primed, baselineAt: stats.baselineAt, seen: [...seen], updatedAt: clock() }),
        { encoding: 'utf8', mode: 0o600 },
      )
    } catch {
      // 落盘失败不影响投递；下一轮还会尝试
    }
  }

  function prune() {
    while (seen.size > maxSeen) {
      const first = seen.values().next()
      if (first.done) break
      seen.delete(first.value)
    }
  }

  function logOnce(code, message) {
    if (code === lastLoggedCode) return
    lastLoggedCode = code
    try {
      log?.warn?.(`[douyin] dm watcher ${message}`)
    } catch {
      // 日志失败不影响主流程
    }
  }

  function resolveRead() {
    if (typeof service?.dmPollConversations === 'function') {
      return (opts) => service.dmPollConversations(opts)
    }
    if (typeof service?.dmList === 'function') {
      return () => service.dmList()
    }
    return null
  }

  function buildEvent(conv, h) {
    const rawPreview = squash(conv?.preview)
    const fromMe = /^我[：:]/.test(rawPreview)
    const text = fromMe ? squash(rawPreview.replace(/^我[：:]\s*/, '')) : rawPreview
    const owner = conv?.isOwner === true || isOwnerDisplayName(conv?.name, ownerAliases)
    seq += 1
    const conversation = {
      id: conv?.id ?? null,
      index: Number.isInteger(conv?.index) ? conv.index : null,
      name: squash(conv?.name),
      preview: rawPreview,
      time: squash(conv?.time),
      isOwner: owner,
    }
    return {
      id: `dme_${h.slice(0, 12)}_${seq}`,
      type: 'dm_message',
      kind: 'dm_message',
      seq,
      at: clock(),
      owner,
      isOwner: owner,
      fromMe,
      conversationId: conversation.id,
      conversationName: conversation.name,
      sender: fromMe ? 'me' : conversation.name,
      conversationIndex: conversation.index,
      text,
      preview: rawPreview,
      time: conversation.time,
      conversation,
      dedupeKey: h,
    }
  }

  function notifySubscribers(event) {
    const callbacks = [onEvent, ...subscribers]
    for (const fn of callbacks) {
      if (typeof fn !== 'function') continue
      try {
        fn(event)
      } catch {
        // 订阅者异常不能打断 watcher
      }
    }
  }

  /** 后台/按需 poll 的事件进队列，供 dmWatch({action:'drain'}) 取走 */
  function bufferEvents(events) {
    for (const event of Array.isArray(events) ? events : []) {
      pending.push(event)
      while (pending.length > MAX_PENDING_EVENTS) {
        pending.shift()
        stats.dropped += 1
      }
    }
  }

  function drainEvents(limit = 100) {
    const n = Math.max(1, Math.min(MAX_PENDING_EVENTS, Number(limit) || 100))
    return pending.splice(0, n)
  }

  /**
   * 单次轮询：读会话列表 → 去重 → 只把基线之后的新会话/新预览事件放入队列。
   * 返回 {ok, code?, baseline?, newCount, events, skipped?}；不 throw。
   */
  async function tick() {
    if (running) return { ok: true, skipped: true, reason: 'busy', newCount: 0, events: [] }
    const read = resolveRead()
    if (!read) {
      const code = 'E_BAD_ARG'
      stats.errors += 1
      stats.lastCode = code
      stats.lastErrorAt = clock()
      logOnce(code, 'service 没有 dmPollConversations/dmList，无法轮询')
      return { ok: false, code, message: 'service 不具备私信读取能力', newCount: 0, events: [] }
    }
    running = true
    stats.ticks += 1
    stats.lastTickAt = clock()
    loadState()
    try {
      let result
      try {
        result = await read({ limit: listLimit, keepOpen })
      } catch (e) {
        result = { ok: false, code: e?.code ?? 'E_REMOTE_IO', message: String(e?.message ?? e) }
      }
      if (!result || result.ok !== true) {
        const code = String(result?.code ?? 'E_REMOTE_IO')
        stats.errors += 1
        stats.lastCode = code
        stats.lastErrorAt = clock()
        logOnce(code, `读取失败（不重试）：${code}`)
        return { ok: false, code, newCount: 0, events: [] }
      }
      stats.lastOkAt = clock()
      const items = Array.isArray(result.items) ? result.items : []
      const current = new Map()
      for (const conv of items) {
        if (!squash(conv?.name)) continue
        const h = dmConversationFingerprintHash(conv)
        if (seen.has(h)) continue
        current.set(h, conv)
      }
      if (!primed) {
        for (const h of current.keys()) seen.add(h)
        primed = true
        stats.baselineAt = clock()
        saveState()
        try {
          log?.info?.(`[douyin] dm watcher 基线 ${seen.size} 条（历史会话不投递）`)
        } catch {}
        return { ok: true, baseline: true, newCount: 0, events: [] }
      }
      // 只保留本轮仍存在的候选；新指纹连续 confirmTicks 次成功读取才确认，避免页面切换时误报
      for (const h of [...candidates.keys()]) {
        if (!current.has(h)) candidates.delete(h)
      }
      const fresh = []
      for (const [h, conv] of current) {
        const prev = candidates.get(h)
        const hits = (prev?.hits ?? 0) + 1
        if (hits >= confirmTicks) {
          candidates.delete(h)
          // 预览不带方向：确认时只读探测最后一条消息，过滤汐自己发出的消息
          let fromMe = /^我[：:]/.test(String(conv?.preview ?? ''))
          if (typeof service?.dmProbeDirection === 'function') {
            try {
              const probe = await service.dmProbeDirection({ name: conv?.name, conversationId: conv?.id, index: conv?.index })
              if (probe?.ok === true) fromMe = probe.fromMe === true
            } catch {}
          }
          seen.add(h)
          if (fromMe) { stats.selfSkipped += 1; continue }
          fresh.push(buildEvent(conv, h))
        } else {
          candidates.set(h, { conv, hits, firstAt: prev?.firstAt ?? clock() })
        }
      }
      prune()
      for (const event of fresh) {
        stats.eventsEmitted += 1
        notifySubscribers(event)
      }
      // 只有确认了新事件/基线才落盘，避免每 3s 写一次 /sdcard
      if (fresh.length) saveState()
      if (fresh.length) {
        try {
          log?.info?.(`[douyin] dm watcher 新私信事件 ${fresh.length} 条（只读，未打开会话）`)
        } catch {}
      }
      return { ok: true, baseline: false, newCount: fresh.length, events: fresh }
    } finally {
      running = false
    }
  }

  function schedule(delayMs) {
    if (stopped) return
    timer = setT(() => {
      timer = null
      void tick()
        .then((r) => bufferEvents(r?.events))
        .catch(() => {})
        .finally(() => schedule(intervalMs))
    }, delayMs)
    timer?.unref?.()
  }

  function start() {
    if (stopped || timer) return false
    if (cfg?.dmWatchEnabled !== true) return false
    schedule(startupDelayMs)
    return true
  }

  function stop() {
    stopped = true
    if (timer) {
      try {
        clearT(timer)
      } catch {}
      timer = null
    }
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {}
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }

  function status() {
    return {
      enabled: cfg?.dmWatchEnabled === true,
      running: Boolean(timer),
      stopped,
      primed,
      seen: seen.size,
      candidates: candidates.size,
      confirmTicks,
      pending: pending.length,
      intervalMs,
      startupDelayMs,
      keepOpen,
      ...stats,
    }
  }

  /**
   * dmWatch 服务入口：不路由、不发消息，只返回事件/状态。
   * action：poll（默认，轮询一次并取走队列）/ drain（只取队列）/ start / stop / status。
   */
  async function request(args = {}) {
    const action = String(args?.action ?? '').trim() || 'poll'
    const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20))
    if (action === 'status') {
      return { ok: true, events: [], count: 0, ...status() }
    }
    if (action === 'start') {
      const started = start()
      return { ok: true, started, events: [], count: 0, ...status() }
    }
    if (action === 'stop') {
      stop()
      return { ok: true, stopped: true, events: [], count: 0, ...status() }
    }
    if (action === 'drain') {
      const events = drainEvents(limit)
      return { ok: true, events, count: events.length, ...status() }
    }
    if (action !== 'poll') {
      return { ok: false, code: 'E_BAD_ARG', message: 'action 只接受 poll/drain/start/stop/status', events: [], count: 0 }
    }
    const r = await tick()
    bufferEvents(r.events)
    const events = drainEvents(limit)
    return {
      ok: r.ok !== false,
      ...(r.code ? { code: r.code } : {}),
      ...(r.message ? { message: r.message } : {}),
      events,
      count: events.length,
      tick: {
        ok: r.ok !== false,
        ...(r.code ? { code: r.code } : {}),
        baseline: r.baseline === true,
        newCount: r.newCount ?? 0,
        skipped: r.skipped === true,
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
