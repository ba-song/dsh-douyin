/**
 * 通知实时事件源测试（fake service / fake timers，不连真实服务、不开真实面板）。
 * 覆盖：3s 默认间隔、baseline、badge/DOM/net 触发、不每 tick 开面板、
 *       面板已开被动读、利率限制、owner→home / 其他人→统一抖音会话、订阅、状态落盘。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNotifyWatcher,
  formatNotifyText,
  notifyDedupeKey,
} from '../lib/notify-watch.js'
import {
  isNotifyReplyable,
  isNotifyTriggerEvent,
  notifyItemId,
  parseNotifyBadge,
} from '../lib/service.js'
import { normalizeConfig } from '../lib/config.js'

const ownerItem = (over = {}) => ({
  id: 'ntf_owner',
  index: 0,
  actor: '饲养员',
  relation: '朋友',
  type: 'mention',
  text: '@汐',
  time: '刚刚',
  ageMs: 0,
  likeCount: null,
  isOwner: true,
  replyable: true,
  videoId: null,
  commentId: null,
  replySupported: false,
  ...over,
})
const otherItem = (over = {}) => ({
  id: 'ntf_other',
  index: 1,
  actor: '豆包',
  relation: 'AI分身',
  type: 'comment_reply',
  text: '回复正文',
  time: '30分钟前',
  ageMs: 30 * 60 * 1000,
  likeCount: null,
  isOwner: false,
  replyable: true,
  videoId: null,
  commentId: null,
  replySupported: false,
  ...over,
})
const followItem = (over = {}) => ({
  id: 'ntf_follow',
  index: 2,
  actor: '往事不堪回首',
  type: 'follow',
  text: '',
  time: '刚刚',
  ageMs: 0,
  isOwner: false,
  replyable: false,
  ...over,
})

function makeClock(start = 1794657000000) {
  let now = start
  return {
    now: () => now,
    advance: (ms) => { now += ms },
    set: (ms) => { now = ms },
  }
}

function makeFakeService({
  items = [ownerItem()],
  badge = { ok: true, available: true, count: 0, dot: false, mode: 'count', signature: 'count:0|dot:0|html:' },
  panelOpen = false,
  unsafe = false,
} = {}) {
  const state = {
    items: items.slice(),
    badge,
    panelOpen,
    unsafe,
    sourceEvents: [],
    opens: 0,
    allowOpenCalls: [],
    snapshotCalls: 0,
    started: 0,
    stopped: 0,
    taken: 0,
  }
  const service = {
    state,
    async notifySourceStart() {
      state.started += 1
      return { ok: true, started: true, seq: 0, cursor: 0 }
    },
    async notifySourceTake() {
      state.taken += 1
      const events = state.sourceEvents.splice(0)
      return { ok: true, events, seq: events.length, cursor: events.length, pending: 0 }
    },
    async notifySourceStop() {
      state.stopped += 1
      return { ok: true }
    },
    async notifyBadgeProbe() {
      return state.badge
    },
    async notifySnapshotForWatch({ allowOpen } = {}) {
      state.snapshotCalls += 1
      state.allowOpenCalls.push(allowOpen === true)
      if (state.unsafe && allowOpen) return { ok: false, code: 'E_PAGE_UNSAFE', open: false, items: [] }
      if (!allowOpen) {
        return state.panelOpen
          ? { ok: true, open: true, opened: false, items: state.items.slice(), count: state.items.length }
          : { ok: true, open: false, opened: false, items: [], count: 0 }
      }
      state.opens += 1
      state.panelOpen = true
      const out = { ok: true, open: true, opened: true, items: state.items.slice(), count: state.items.length }
      state.panelOpen = false // service 读完立刻 close
      return out
    },
  }
  return service
}

function makeCfg(over = {}) {
  // 注意：over 在 normalizeConfig 之后合并 —— watchBackoff*/watchBreaker*/notifyPanelPollMs 这些
  // 2026-11-16 新增键由 corefix 并行加进 lib/config.js，本测试不依赖它们是否已存在。
  return {
    ...normalizeConfig({
      notifyWatchEnabled: true,
      notifyWatchIntervalMs: 3000,
      notifyWatchStartupDelayMs: 0,
      notifyWatchBaselineRetryMs: 10000,
      notifyWatchPanelMinGapMs: 3000,
      notifyWatchMaxAgeMs: 24 * 60 * 60 * 1000,
      dmOwnerAliases: ['饲养员', '草荧'],
      dmOwnerFile: '',
    }),
    ...over,
  }
}

function makeHome({ result = { ok: true }, throwError = null } = {}) {
  const calls = []
  return {
    calls,
    async deliver(payload) {
      calls.push(payload)
      if (throwError) throw throwError
      return result
    },
  }
}

function makeCtx(home) {
  return { get: (name) => (name === 'dyHome' ? home : undefined) }
}

function makeLogger() {
  const lines = []
  return { lines, info: (m) => lines.push(['info', String(m)]), warn: (m) => lines.push(['warn', String(m)]) }
}

test('纯函数：稳定 id / 去重键 / 正文 / 角标 / 触发过滤 / replyable', () => {
  const a = { type: 'mention', actor: '饲养员', text: '@汐', time: '刚刚' }
  const b = { ...a, time: '1分钟前' }
  assert.equal(notifyItemId(a), notifyItemId(b))
  assert.equal(notifyDedupeKey(a), notifyDedupeKey(b))
  assert.notEqual(notifyItemId(a), notifyItemId({ ...a, text: '@汐2' }))
  assert.equal(formatNotifyText(otherItem()), '【抖音通知】回复评论｜豆包：回复正文（30分钟前）')

  const cnt = parseNotifyBadge({
    html: '<span class="badge">3</span>',
    text: '通知',
    children: [{ text: '3', class: 'u-badge' }],
  })
  assert.equal(cnt.available, true)
  assert.equal(cnt.count, 3)
  assert.equal(cnt.mode, 'count')
  const dot = parseNotifyBadge({ html: '<i class="red-dot"></i>', text: '通知', children: [{ text: '', class: 'red-dot' }] })
  assert.equal(dot.dot, true)
  assert.equal(dot.mode, 'dot')
  const none = parseNotifyBadge({ html: '<svg></svg>', text: '通知', children: [] })
  assert.equal(none.count, 0)
  assert.equal(none.mode, 'html')

  assert.equal(isNotifyTriggerEvent({ kind: 'net', url: 'https://www.douyin.com/aweme/v1/web/notice/list', body: '' }), true)
  assert.equal(isNotifyTriggerEvent({ kind: 'net', url: 'https://www.douyin.com/aweme/v1/web/im/chat', body: '回复了你的评论' }), false)
  assert.equal(isNotifyTriggerEvent({ kind: 'net', url: 'https://x/y', body: '赞了你的评论' }), true)
  assert.equal(isNotifyTriggerEvent({ kind: 'dom', url: '', body: '赞了你的评论' }), false)

  assert.equal(isNotifyReplyable(ownerItem()), true)
  assert.equal(isNotifyReplyable(followItem()), false)
  assert.equal(isNotifyReplyable(otherItem({ ageMs: 2 * 60 * 60 * 1000 }), { windowMs: 3600000 }), false)
  assert.equal(isNotifyReplyable(otherItem(), { windowMs: 0 }), true)
})

test('baseline：首轮只读一次面板并建基线；之后无触发不反复开面板', async () => {
  const svc = makeFakeService()
  const home = makeHome()
  const w = createNotifyWatcher({ cfg: makeCfg(), service: svc, ctx: makeCtx(home) })
  const first = await w.tick()
  assert.equal(first.ok, true)
  assert.equal(first.baseline, true)
  assert.equal(first.newCount, 0)
  assert.equal(w.primed, true)
  assert.equal(svc.state.opens, 1)
  assert.equal(home.calls.length, 0)
  const st = w.status()
  assert.equal(st.intervalMs, 3000)
  assert.equal(st.badgeAvailable, true)
  assert.equal(st.badgeCount, 0)
  assert.equal(st.sourceStarted, true)

  for (let i = 0; i < 5; i += 1) {
    const r = await w.tick()
    assert.equal(r.newCount, 0)
  }
  // 只有 baseline 开过一次；每 tick 仅 allowOpen:false 的被动检查
  assert.equal(svc.state.opens, 1)
  assert.ok(svc.state.allowOpenCalls.filter((x) => x === false).length >= 6)
  assert.equal(svc.state.allowOpenCalls.filter((x) => x === true).length, 1)
})

test('badge 变化：只开一次面板，新通知带 isOwner/replyable/route；其他人→统一 douyin', async () => {
  const svc = makeFakeService({ items: [ownerItem()] })
  const home = makeHome()
  const w = createNotifyWatcher({ cfg: makeCfg(), service: svc, ctx: makeCtx(home) })
  await w.tick() // baseline

  svc.state.badge = { ok: true, available: true, count: 1, dot: false, mode: 'count', signature: 'count:1|dot:0|html:' }
  svc.state.items.push(otherItem())
  const r = await w.tick()
  assert.equal(r.ok, true)
  assert.equal(r.newCount, 1)
  const ev = r.events[0]
  assert.equal(ev.id, 'ntf_other')
  assert.equal(ev.actor, '豆包')
  assert.equal(ev.isOwner, false)
  assert.equal(ev.owner, false)
  assert.equal(ev.replyable, true)
  assert.equal(ev.route, 'douyin')
  assert.equal(ev.ageMs, 30 * 60 * 1000)
  assert.equal(svc.state.opens, 2)
  assert.equal(home.calls.length, 1)
  assert.deepEqual(home.calls[0], {
    channel: 'douyin',
    kind: 'private',
    contactId: 'douyin',
    contactName: '抖音',
    text: '【抖音通知】回复评论｜豆包：回复正文（30分钟前）',
    priority: 'normal',
  })

  // 同一条不重复投
  const again = await w.tick()
  assert.equal(again.newCount, 0)
  assert.equal(home.calls.length, 1)
})

test('owner 事件 → home 的 contactId=actor；其他人 → 统一 douyin 会话', async () => {
  const clock = makeClock()
  const svc = makeFakeService({ items: [ownerItem()] })
  const home = makeHome()
  const w = createNotifyWatcher({ cfg: makeCfg(), service: svc, ctx: makeCtx(home), clock: clock.now })
  await w.tick()
  svc.state.badge = { ok: true, available: true, count: 1, dot: false, mode: 'count', signature: 'count:1' }
  svc.state.items.push(ownerItem({ id: 'ntf_owner2', text: '@汐 新' }))
  await w.tick()
  assert.equal(home.calls[0].contactId, '饲养员')
  assert.equal(home.calls[0].contactName, '饲养员')

  clock.advance(16000)
  svc.state.badge = { ok: true, available: true, count: 2, dot: false, mode: 'count', signature: 'count:2' }
  svc.state.items.push(otherItem({ id: 'ntf_other2' }))
  await w.tick()
  assert.equal(home.calls[1].contactId, 'douyin')
  assert.equal(home.calls[1].contactName, '抖音')
})

test('jsWatch DOM 事件直接产出通知，不需要开面板', async () => {
  const svc = makeFakeService({ items: [ownerItem()] })
  const home = makeHome()
  const w = createNotifyWatcher({ cfg: makeCfg(), service: svc, ctx: makeCtx(home) })
  await w.tick() // baseline; opens=1
  svc.state.sourceEvents.push({
    kind: 'dom',
    text: '豆包\nAI分身\n回复正文\n回复了你的评论30分钟前',
  })
  const r = await w.tick()
  assert.equal(r.newCount, 1)
  assert.equal(r.events[0].source, 'js-dom')
  assert.equal(r.events[0].actor, '豆包')
  assert.equal(svc.state.opens, 1) // 没有额外开面板

  // 旧通知（ageMs=null）不当新事件
  svc.state.sourceEvents.push({ kind: 'dom', text: '老通知\n朋友\n@汐\n在评论中提到了你星期三' })
  const old = await w.tick()
  assert.equal(old.newCount, 0)

  // 私信/会话 DOM 即使文本里带“关注了你”也不进通知链路
  svc.state.sourceEvents.push({ kind: 'dom', selector: 'conversation-item', text: '路人\n我关注了你\n刚刚' })
  const dm = await w.tick()
  assert.equal(dm.newCount, 0)
})

test('panel 模式：到 notifyPanelPollMs 才主动读面板；首轮基线，下一轮新条目产出事件', async () => {
  const clock = makeClock()
  const svc = makeFakeService({ items: [ownerItem()] })
  const w = createNotifyWatcher({
    cfg: makeCfg({ notifyWatchSource: 'panel', notifyWatchPanelMinGapMs: 3000, notifyPanelPollMs: 5000 }),
    service: svc,
    clock: clock.now,
  })
  const first = await w.tick()
  assert.equal(first.ok, true)
  assert.equal(first.baseline, true)
  assert.equal(w.primed, true)
  assert.equal(svc.state.opens, 1)
  assert.equal(w.status().seen, 1)
  assert.equal(w.status().sourceMode, 'panel')
  assert.equal(w.status().panelPollMs, 5000)

  clock.advance(6000) // 过 notifyPanelPollMs(5s)
  svc.state.items.push(otherItem())
  const second = await w.tick()
  assert.equal(second.baseline, false)
  assert.equal(second.newCount, 1)
  assert.equal(second.events[0].id, otherItem().id)
  assert.equal(second.events[0].source, 'panel')
  assert.equal(svc.state.opens, 2)
  assert.equal(w.status().panelPollsDue, 1)
  // panel 模式不依赖 badge/net，也不启动 jsWatch
  assert.equal(svc.state.started, 0)
  assert.equal(svc.state.taken, 0)
})

test('panel 模式：同一 tick / 间隔内不再无条件开面板（默认 60s 才主动读一次）', async () => {
  const clock = makeClock()
  const svc = makeFakeService({ items: [ownerItem()] })
  const w = createNotifyWatcher({
    cfg: makeCfg({ notifyWatchSource: 'panel' }), // 不传 notifyPanelPollMs → 默认 60000
    service: svc,
    clock: clock.now,
  })
  await w.tick() // baseline 开一次
  const opensAfterBaseline = svc.state.opens
  assert.equal(opensAfterBaseline, 1)
  assert.equal(w.status().panelPollMs, 60000)

  // 同一时刻连跑 4 轮（每轮之间只推进 1s，远小于 60s）：一轮都不该开面板
  for (let i = 0; i < 4; i += 1) {
    clock.advance(1000)
    const r = await w.tick()
    assert.equal(r.ok, true)
    assert.equal(svc.state.opens, opensAfterBaseline, `第 ${i + 1} 轮不该开面板`)
  }
  assert.equal(w.status().panelPollsDue, 0)

  // 到 60s 才到点：开一次，且只开一次
  clock.advance(60000)
  await w.tick()
  assert.equal(svc.state.opens, opensAfterBaseline + 1)
  assert.equal(w.status().panelPollsDue, 1)
  clock.advance(1000)
  await w.tick()
  assert.equal(svc.state.opens, opensAfterBaseline + 1, '开过之后 60s 内不再开')
})

test('jsWatch net 触发：读后 5s 抑制自激；过最小间隔才开面板', async () => {
  const clock = makeClock()
  const svc = makeFakeService({ items: [ownerItem()] })
  const home = makeHome()
  const w = createNotifyWatcher({
    cfg: makeCfg({ notifyWatchPanelMinGapMs: 15000 }),
    service: svc,
    ctx: makeCtx(home),
    clock: clock.now,
  })
  await w.tick() // baseline，lastPanelReadAt = t0

  clock.advance(6000) // 过了读后抑制窗口
  svc.state.items.push(otherItem())
  svc.state.sourceEvents.push({ kind: 'net', url: 'https://www.douyin.com/aweme/v1/web/notice/list', body: '{"a":1}' })
  const r1 = await w.tick()
  assert.equal(r1.newCount, 1)
  assert.equal(svc.state.opens, 2)

  clock.advance(6000) // 抑制窗口已过，但 15s 面板最小间隔未到
  svc.state.items.push(followItem())
  svc.state.sourceEvents.push({ kind: 'net', url: 'https://www.douyin.com/aweme/v1/web/notice/list', body: '{"a":2}' })
  const r2 = await w.tick()
  assert.equal(r2.newCount, 0)
  assert.equal(svc.state.opens, 2)
  assert.equal(w.status().panelOpenSkipped, 1)

  // 间隔内被跳过的触发要记 pending；时间过了即使没有新事件也要补读
  clock.advance(16000)
  const r3 = await w.tick()
  assert.equal(svc.state.opens, 3)
  assert.equal(r3.newCount, 1)
  assert.equal(r3.events[0].type, 'follow')
})

test('面板已经打开：被动读并投新条目，不开面板；不点条目、不点搜索框', async () => {
  const svc = makeFakeService({ items: [ownerItem()] })
  const home = makeHome()
  const w = createNotifyWatcher({ cfg: makeCfg(), service: svc, ctx: makeCtx(home) })
  await w.tick() // baseline opens=1
  svc.state.panelOpen = true
  svc.state.items.push(otherItem())
  const r = await w.tick()
  assert.equal(r.newCount, 1)
  assert.equal(r.events[0].source, 'panel')
  assert.equal(svc.state.opens, 1) // 没有额外点开
  assert.equal(svc.state.allowOpenCalls.at(-1), false)
})

test('页面不安全/基线失败：不导航、不抢页面；恢复后只建基线', async () => {
  const svc = makeFakeService({ unsafe: true })
  const log = makeLogger()
  const w = createNotifyWatcher({ cfg: makeCfg(), service: svc, log })
  const r = await w.tick()
  assert.equal(r.ok, true)
  assert.equal(r.baseline, false)
  assert.equal(w.primed, false)
  assert.equal(svc.state.opens, 0)
  assert.ok(log.lines.some(([lvl, msg]) => lvl === 'warn' && msg.includes('E_PAGE_UNSAFE')))

  // 同轮不会连续重试；下一轮（同一时间）也不反复开
  await w.tick()
  assert.equal(svc.state.opens, 0)
  svc.state.unsafe = false
  await w.tick()
  assert.equal(svc.state.opens, 0) // baselineRetry 未到，不重试
  assert.equal(w.primed, false)
})

test('dyHome 不可用/拒收：事件仍入队和订阅，不重试、不崩', async () => {
  const svc = makeFakeService({ items: [ownerItem()] })
  const log = makeLogger()
  const received = []
  const w = createNotifyWatcher({
    cfg: makeCfg(),
    service: svc,
    ctx: makeCtx(null),
    log,
    onEvent: (e) => received.push(e),
  })
  await w.tick()
  svc.state.badge = { ok: true, available: true, count: 1, dot: false, mode: 'count', signature: 'count:1' }
  svc.state.items.push(otherItem())
  const r = await w.tick()
  assert.equal(r.newCount, 1)
  assert.equal(received.length, 1)
  assert.equal(w.status().delivered, 0)
  assert.ok(log.lines.some(([lvl, msg]) => lvl === 'warn' && msg.includes('dyHome 不可用')))
  const again = await w.tick()
  assert.equal(again.newCount, 0) // 已见，不补投
})

test('状态落盘：重启后不重复投历史，只投新条目', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dy-notify-live-'))
  try {
    const stateFile = join(dir, 'seen.json')
    const item = ownerItem({ time: '刚刚' })
    const svc1 = makeFakeService({ items: [item] })
    const cfg = makeCfg({ notifyWatchStateFile: stateFile })
    const w1 = createNotifyWatcher({ cfg, service: svc1 })
    assert.equal((await w1.tick()).baseline, true)

    const svc2 = makeFakeService({ items: [{ ...item, time: '1分钟前' }] })
    const w2 = createNotifyWatcher({ cfg, service: svc2 })
    let r = await w2.tick()
    assert.equal(r.baseline, false)
    assert.equal(r.newCount, 0)
    svc2.state.items.push(otherItem())
    svc2.state.badge = { ok: true, available: true, count: 1, dot: false, mode: 'count', signature: 'count:1' }
    r = await w2.tick()
    assert.equal(r.newCount, 1)
    assert.equal(r.events[0].actor, '豆包')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('默认关闭；interval 默认 3s、下限 2s；start/stop 定时器', async () => {
  const off = normalizeConfig({})
  assert.equal(off.notifyWatchEnabled, false)
  assert.equal(off.notifyWatchIntervalMs, 3000)
  assert.equal(normalizeConfig({ notifyWatchIntervalMs: 1000 }).notifyWatchIntervalMs, 3000)
  assert.equal(normalizeConfig({ notifyWatchIntervalMs: 2000 }).notifyWatchIntervalMs, 2000)
  assert.equal(normalizeConfig({ notifyWatchIntervalMs: 5000 }).notifyWatchIntervalMs, 5000)
  assert.equal(normalizeConfig({ notifyWatchIntervalMs: 600000 }).notifyWatchIntervalMs, 3000)

  const scheduled = []
  const cleared = []
  const timers = {
    setTimeout(fn, ms) {
      const t = { fn, ms, unref() {} }
      scheduled.push(t)
      return t
    },
    clearTimeout(t) { cleared.push(t) },
  }
  const svc = makeFakeService()
  const w = createNotifyWatcher({ cfg: makeCfg({ notifyWatchStartupDelayMs: 5 }), service: svc, timers })
  assert.equal(w.start(), true)
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].ms, 5)
  assert.equal(w.status().running, true)
  w.stop()
  assert.equal(cleared.length, 1)
  assert.equal(w.start(), false)

  const disabled = createNotifyWatcher({ cfg: normalizeConfig({}), service: svc, timers })
  assert.equal(disabled.start(), false)
})

test('subscribe/onEvent 抛错不影响；request poll/drain 队列语义', async () => {
  const svc = makeFakeService({ items: [ownerItem()] })
  const received = []
  let onEventCalls = 0
  const w = createNotifyWatcher({
    cfg: makeCfg(),
    service: svc,
    onEvent: () => {
      onEventCalls += 1
      throw new Error('bad')
    },
  })
  const unsub = w.subscribe((e) => received.push(e))
  const base = await w.request({ action: 'poll' })
  assert.equal(base.tick.baseline, true)
  assert.equal(base.events.length, 0)

  svc.state.badge = { ok: true, available: true, count: 1, dot: false, mode: 'count', signature: 'count:1' }
  svc.state.items.push(otherItem())
  const poll = await w.request({ action: 'poll' })
  assert.equal(poll.count, 1)
  assert.equal(poll.events[0].actor, '豆包')
  assert.equal(received.length, 1)
  assert.equal(onEventCalls, 1)

  const drained = await w.request({ action: 'drain' })
  assert.equal(drained.count, 0)
  unsub()
})

test('旧 version:1 状态文件不兼容 → 忽略并重新建基线，不把历史当新事件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dy-notify-oldstate-'))
  try {
    const stateFile = join(dir, 'seen.json')
    // 旧 watcher 的 seen 是 32 位 hex hash，不是 ntf_ id；version 1
    writeFileSync(stateFile, JSON.stringify({ version: 1, primed: true, baselineAt: 1, seen: ['deadbeef'.repeat(4)] }))
    const svc = makeFakeService({ items: [ownerItem({ time: '30分钟前', ageMs: 30 * 60 * 1000 })] })
    const w = createNotifyWatcher({ cfg: makeCfg({ notifyWatchStateFile: stateFile }), service: svc })
    const r = await w.tick()
    assert.equal(r.baseline, true)
    assert.equal(r.newCount, 0)
    assert.equal(w.primed, true)
    assert.equal(svc.state.opens, 1)
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(saved.version, 2)
    assert.equal(saved.primed, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 假 timers：记录 delay，测试可手动"到点"并 await 这一轮（含重新排期） */
function makeTimers() {
  const scheduled = []
  const cleared = []
  const timers = {
    scheduled,
    cleared,
    setTimeout(fn, ms) {
      const t = { fn, ms, unref() { return this } }
      scheduled.push(t)
      return t
    },
    clearTimeout(t) {
      cleared.push(t)
    },
  }
  timers.fire = async (t) => await t.fn()
  return timers
}

test('失败退避：基线读取连续失败 → schedule 3s→6s；退避/熔断字段进 status()', async () => {
  const timers = makeTimers()
  const clock = makeClock()
  const svc = makeFakeService({ unsafe: true })
  const w = createNotifyWatcher({
    cfg: makeCfg({
      notifyWatchStartupDelayMs: 0,
      notifyWatchBaselineRetryMs: 5000,
      watchBackoffMinMs: 3000,
      watchBackoffMaxMs: 60000,
      watchBackoffFactor: 2,
    }),
    service: svc,
    timers,
    clock: clock.now,
  })
  assert.equal(w.start(), true)
  assert.equal(timers.scheduled[0].ms, 0)

  let out = await timers.fire(timers.scheduled[0])
  assert.equal(out.result.failed, true)
  assert.equal(out.result.code, 'E_PAGE_UNSAFE')
  assert.equal(out.nextDelayMs, 3000)
  let st = w.status()
  assert.equal(st.fails, 1)
  assert.equal(st.backoffMs, 3000)
  assert.equal(st.breakerOpen, false)
  assert.equal(st.lastCode, 'E_PAGE_UNSAFE')
  assert.equal(st.lastFailCode, 'E_PAGE_UNSAFE')
  assert.ok(st.nextTickAt > clock.now())
  assert.equal(st.backoff.minMs, 3000)
  assert.equal(st.backoff.factor, 2)

  clock.advance(11000) // 过 baselineRetryMs（watcher 内下限 10s），再失败一次
  out = await timers.fire(timers.scheduled.at(-1))
  assert.equal(out.nextDelayMs, 6000)
  st = w.status()
  assert.equal(st.fails, 2)
  assert.equal(st.backoffMs, 6000)

  // 非失败类错误（角标未命中）不改退避状态
  const svc2 = makeFakeService()
  const timers2 = makeTimers()
  const w2 = createNotifyWatcher({
    cfg: makeCfg({ notifyWatchStartupDelayMs: 0, watchBreakerFails: 3 }),
    service: svc2,
    timers: timers2,
    clock: clock.now,
  })
  w2.start()
  await timers2.fire(timers2.scheduled[0])
  svc2.state.badge = { ok: false, code: 'E_BADGE_MISS', available: false }
  const neutral = await timers2.fire(timers2.scheduled.at(-1))
  assert.equal(w2.status().fails, 0, '角标未命中（非失败类）不累计退避失败')
  assert.equal(w2.status().backoffMs, 0)
  assert.equal(neutral.nextDelayMs, 3000)
  w.stop()
  w2.stop()
})

test('崩溃感知（panel 模式）：E_REMOTE_IO + Target crashed → status 记录 health 探测结果', async () => {
  const clock = makeClock()
  const svc = {
    async notifySnapshotForWatch() {
      return { ok: false, code: 'E_REMOTE_IO', message: 'locator.count: Target crashed', open: false, items: [] }
    },
  }
  const log = makeLogger()
  const healthCalls = []
  const bridge = {
    async health() {
      healthCalls.push('health')
      return { browser: true, pages: 3, roles: { notify: { renderer: 'crashed' }, main: { renderer: 'ok' } } }
    },
  }
  const w = createNotifyWatcher({
    cfg: makeCfg({ notifyWatchSource: 'panel' }),
    service: svc,
    log,
    clock: clock.now,
    bridge,
  })
  const r = await w.tick()
  assert.equal(r.failed, true)
  assert.equal(r.code, 'E_REMOTE_IO')
  const st = w.status()
  assert.equal(st.healthProbes, 1)
  assert.equal(st.healthSkipped, 0)
  assert.equal(healthCalls.length, 1)
  assert.deepEqual(st.lastHealth, { browser: true, pages: 3, roles: { notify: 'crashed', main: 'ok' } })
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && m.includes('页面崩溃') && m.includes('已请求健康检查')))
  assert.equal(st.hasBridge, true)
  assert.equal(st.breakerOpen, false, '单次崩溃不熔断（熔断由 schedule 侧累计）')
})

test('崩溃感知：没有 bridge 依赖时跳过 health，只记日志', async () => {
  const clock = makeClock()
  const svc = makeFakeService()
  const log = makeLogger()
  const w = createNotifyWatcher({
    cfg: makeCfg({ notifyWatchSource: 'panel' }),
    service: svc,
    log,
    clock: clock.now,
  })
  const original = svc.notifySnapshotForWatch
  svc.notifySnapshotForWatch = async () => ({ ok: false, code: 'E_REMOTE_IO', message: 'Target crashed', open: false, items: [] })
  const r = await w.tick()
  svc.notifySnapshotForWatch = original
  assert.equal(r.failed, true)
  assert.equal(w.status().healthProbes, 1)
  assert.equal(w.status().healthSkipped, 1)
  assert.deepEqual(w.status().lastHealth, null)
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && m.includes('已请求健康检查')))
})

test('重复 @提及：同一分钟内不重复投；隔几分钟的新 @ 会重新投（不再被永久 seen 吞掉）', async () => {
  const svc = makeFakeService({ panelOpen: true, items: [ownerItem({ id: 'ntf_owner', time: '刚刚', ageMs: 0 })] })
  const home = makeHome()
  const clock = makeClock()
  const cfg = makeCfg({ notifyWatchSource: 'panel', notifyPanelPollMs: 5000 })
  const w = createNotifyWatcher({ cfg, service: svc, ctx: makeCtx(home), clock: clock.now })
  await w.tick()
  assert.equal(home.calls.length, 0, '基线不投')

  // 5 分钟后主人的新 @提及：标签仍然是"刚刚"（相对时间），修 bug 前会被永久 seen 吞掉
  clock.advance(5 * 60 * 1000)
  svc.state.items = [ownerItem({ id: 'ntf_owner', time: '刚刚', ageMs: 0 })]
  const r1 = await w.tick()
  assert.equal(r1.newCount, 1, '隔 5 分钟的新 @ 必须投递')
  assert.equal(home.calls.length, 1)
  assert.equal(home.calls[0].channel, 'douyin')

  // 3s 后再读：同一条不能重复投
  clock.advance(3000)
  const r2 = await w.tick()
  assert.equal(r2.newCount, 0, '同一条 @ 不能重复投')
  assert.equal(home.calls.length, 1)
  assert.ok(w.status().recentDupeSkipped >= 1)

  // 再过 10 分钟又 @ 一次（同样 actor/text/"刚刚"）：必须再次投递
  clock.advance(10 * 60 * 1000)
  svc.state.items = [ownerItem({ id: 'ntf_owner', time: '刚刚', ageMs: 0 })]
  const r3 = await w.tick()
  assert.equal(r3.newCount, 1, '10 分钟后的又一次 @ 必须投递')
  assert.equal(home.calls.length, 2)
})

test('重启补投：首轮把 catchUp 窗口内没投过的旧通知补一次；之后不再重复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-catchup-'))
  const stateFile = join(dir, 'seen.json')
  writeFileSync(stateFile, JSON.stringify({ version: 2, primed: true, baselineAt: 1, seen: [], delivered: {} }))
  const cfg = makeCfg({
    notifyWatchSource: 'panel',
    notifyPanelPollMs: 5000,
    notifyWatchMaxAgeMs: 10 * 60 * 1000,
    notifyCatchUpMaxAgeMs: 6 * 60 * 60 * 1000,
    notifyWatchStateFile: stateFile,
  })
  const svc = makeFakeService({ panelOpen: true, items: [ownerItem({ id: 'ntf_owner', time: '18:48', ageMs: 20 * 60 * 1000 })] })
  const home = makeHome()
  const clock = makeClock()
  const w = createNotifyWatcher({ cfg, service: svc, ctx: makeCtx(home), clock: clock.now })
  const r1 = await w.tick()
  assert.equal(r1.newCount, 1, '20 分钟前的 @ 超出常规 10 分钟窗口，但补投窗口内应投一次')
  assert.equal(home.calls.length, 1)

  clock.advance(3000)
  const r2 = await w.tick()
  assert.equal(r2.newCount, 0, '补投后不重复')
  assert.equal(home.calls.length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('重启补投关闭（catchUp=0）时，超出常规窗口的旧通知不投', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-nocatchup-'))
  const stateFile = join(dir, 'seen.json')
  writeFileSync(stateFile, JSON.stringify({ version: 2, primed: true, baselineAt: 1, seen: [], delivered: {} }))
  const cfg = makeCfg({
    notifyWatchSource: 'panel',
    notifyPanelPollMs: 5000,
    notifyWatchMaxAgeMs: 10 * 60 * 1000,
    notifyCatchUpMaxAgeMs: 0,
    notifyWatchStateFile: stateFile,
  })
  const svc = makeFakeService({ panelOpen: true, items: [ownerItem({ id: 'ntf_owner', time: '18:48', ageMs: 20 * 60 * 1000 })] })
  const home = makeHome()
  const clock = makeClock()
  const w = createNotifyWatcher({ cfg, service: svc, ctx: makeCtx(home), clock: clock.now })
  const r = await w.tick()
  assert.equal(r.newCount, 0)
  assert.equal(home.calls.length, 0)
  rmSync(dir, { recursive: true, force: true })
})
