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
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isNotifyReplyable, isNotifyTriggerEvent, parseNotifyItems } from './service.js'

const NOTIFY_TYPE_LABELS = Object.freeze({
  mention: '@提及',
  comment_reply: '回复评论',
  like_comment: '赞了评论',
  like_danmaku: '赞了弹幕',
  follow: '新关注',
})

const DEFAULT_MAX_TEXT = 500
const MAX_PENDING_EVENTS = 200

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
  const time = /刚刚|秒前|分钟前|小时前/.test(rawTime) ? 'recent' : rawTime
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
} = {}) {
  const setT = timers?.setTimeout ?? setTimeout
  const clearT = timers?.clearTimeout ?? clearTimeout
  const seen = new Set()
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
    triggerBadge: 0,
    triggerNet: 0,
    lastCode: null,
    lastErrorAt: null,
    lastTickAt: null,
    lastOkAt: null,
    sourceSeq: 0,
    sourceCursor: 0,
    sourcePending: 0,
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
  let pendingTrigger = false
  let lastPanelRawCount = 0
  let lastPanelItemCount = 0
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
  const reloadMs = Math.max(5000, Math.min(600000, Number(cfg?.notifyWatchReloadMs) || 15000))
  let lastPanelReloadAt = 0
  // 独立 notify tab 专用：panel 模式每轮主动读一次面板，不依赖 badge/net（主页面不被占用）
  const forcePanelPoll = sourceMode === 'panel'
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
        JSON.stringify({ version: 2, primed, baselineAt: stats.baselineAt, seen: [...seen], updatedAt: clock() }),
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

  function parseOpts() {
    return { ownerAliases, replyWindowMs: cfg?.commentReplyWindowMs ?? 0, now: clock() }
  }

  function itemKey(item) {
    return String(item?.id ?? '') || notifyDedupeKey(item)
  }

  function isFresh(item) {
    if (!Object.prototype.hasOwnProperty.call(item ?? {}, 'ageMs')) return true
    // parseNotifyItems 对“星期三/日期”给 ageMs=null：视为旧通知，不投实时事件
    if (item.ageMs === null || item.ageMs === undefined) return false
    const age = Number(item.ageMs)
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return false
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

  function seed(items) {
    for (const item of Array.isArray(items) ? items : []) {
      const key = itemKey(item)
      if (key) seen.add(key)
    }
    prune()
  }

  async function snapshot({ allowOpen }) {
    if (typeof service?.notifySnapshotForWatch === 'function') {
      return await service.notifySnapshotForWatch({ allowOpen, limit })
    }
    // 兼容旧注入（只有 notifyList）：只能当成“打开面板读一次”
    if (allowOpen && typeof service?.notifyList === 'function') {
      const r = await service.notifyList({ limit, loadMore: false, keepOpen: false })
      return { ...(r ?? {}), open: r?.ok === true, opened: r?.ok === true }
    }
    return { ok: true, open: false, opened: false, items: [], count: 0 }
  }

  async function probeBadge() {
    if (typeof service?.notifyBadgeProbe !== 'function') return { ok: true, available: false }
    return await service.notifyBadgeProbe({ selectors: badgeSelectors })
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
    if (r?.ok !== true) {
      stats.errors += 1
      stats.lastCode = String(r?.code ?? 'E_REMOTE_IO')
      stats.lastErrorAt = clock()
      logOnce(stats.lastCode, `jsWatch take 失败（不重试同轮）：${stats.lastCode}`)
      return { ok: false, code: stats.lastCode, events: [] }
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
    stats.delivered += delivered
    stats.skipped += skipped
    return { delivered, skipped }
  }

  /**
   * 单次事件源轮询：badge/jsWatch/已开面板 → 候选 → 去重 → 事件 → dyHome。
   * 不每 tick 开面板；只有角标/网络触发且过最小间隔才开一次。
   */
  async function tick() {
    if (running) return { ok: true, skipped: true, reason: 'busy', newCount: 0, events: [] }
    running = true
    stats.ticks += 1
    stats.lastTickAt = clock()
    loadState()
    if (!primed && !baselineEnabled) {
      primed = true
      stats.baselineAt = clock()
      saveState()
    }
    try {
      if (forcePanelPoll && typeof service?.notifyRefreshForWatch === 'function' && clock() - lastPanelReloadAt >= reloadMs) {
        lastPanelReloadAt = clock()
        try { await service.notifyRefreshForWatch() } catch {}
      }
      await ensureSource()
      const candidates = []
      const triggers = []

      const useBadge = sourceMode === 'auto' || sourceMode === 'badge'
      const badgeProbe = useBadge
        ? await probeBadge().catch((e) => ({ ok: false, code: e?.code ?? 'E_REMOTE_IO', available: false }))
        : { ok: true, available: false }
      if (useBadge && badgeProbe?.available === false) {
        logOnce(String(badgeProbe?.code ?? 'E_BADGE_MISS'), '角标入口未命中（不打开面板；继续 jsWatch/已开面板模式）')
      }
      if (checkBadgeSignature(badgeProbe)) {
        triggers.push('badge')
        stats.triggerBadge += 1
      }

      const source = await takeSource()
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
      if (passive?.ok !== false && passive?.open === true) {
        lastPanelReadAt = clock()
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
          if (snap?.opened === true) stats.panelOpens += 1
          if (snap?.ok === true && snap?.open === true) {
            lastPanelReadAt = clock()
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
          stats.errors += 1
          stats.lastCode = String(snap?.code ?? 'E_REMOTE_IO')
          stats.lastErrorAt = clock()
          logOnce(stats.lastCode, `基线读取失败（不导航/不重试同轮）：${stats.lastCode}`)
        }
        // 还没基线：只把本次 DOM 候选丢掉/不投，等基线读取；绝不把历史一次灌出去
        return { ok: true, baseline: false, newCount: 0, events: [], triggers }
      }

      // 有 badge/net 触发：面板没开、过了最小间隔才开一次读快照；间隔内先记 pending，过窗后补读
      if (forcePanelPoll || triggers.length > 0) pendingTrigger = true
      if (pendingTrigger && passive?.open !== true) {
        if (clock() - lastPanelOpenAt < panelMinGapMs) {
          stats.panelOpenSkipped += 1
        } else {
          lastPanelOpenAt = clock()
          pendingTrigger = false
          const snap = await snapshot({ allowOpen: true }).catch((e) => ({ ok: false, code: e?.code ?? 'E_REMOTE_IO', open: false, items: [] }))
          if (snap?.opened === true) stats.panelOpens += 1
          if (snap?.ok === true && snap?.open === true) {
            lastPanelReadAt = clock()
            lastPanelRawCount = Number(snap.rawCount) || (snap.items ?? []).length
            lastPanelItemCount = (snap.items ?? []).length
            for (const item of snap.items ?? []) candidates.push({ item, source: 'panel' })
          } else if (snap?.code) {
            pendingTrigger = true // 页面不安全/临时失败：过窗后继续补读
            stats.errors += 1
            stats.lastCode = String(snap.code)
            stats.lastErrorAt = clock()
            logOnce(stats.lastCode, `触发后读取面板失败（过窗后补读）：${stats.lastCode}`)
          }
        }
      }

      // 去重 + 新鲜度过滤
      const fresh = []
      const freshKeys = new Set()
      for (const c of candidates) {
        const item = c.item
        const key = itemKey(item)
        if (!key || seen.has(key) || freshKeys.has(key)) continue
        if (!isFresh(item)) {
          seen.add(key)
          continue
        }
        freshKeys.add(key)
        fresh.push(buildEvent(item, c.source))
      }
      for (const ev of fresh) seen.add(ev.id)
      prune()
      stats.lastOkAt = clock()
      if (fresh.length) {
        for (const ev of fresh) {
          stats.eventsEmitted += 1
          notifySubscribers(ev)
        }
        saveState()
        if (deliver) await deliverEvents(fresh)
        try { log?.info?.(`[douyin] notify live watcher 新事件 ${fresh.length} 条（只读，未点条目）`) } catch {}
      }
      return { ok: true, baseline: false, newCount: fresh.length, events: fresh, triggers }
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
    if (cfg?.notifyWatchEnabled !== true) return false
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
      lastPanelOpenAt,
      lastPanelRawCount,
      lastPanelItemCount,
      ...stats,
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
