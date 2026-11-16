/**
 * 私信实时 watcher 测试（fake service / fake timers，不连真实服务、不打开真实会话）。
 * 覆盖：基线不重复上报、owner 区分、预览变化事件、相对时间归一、队列/订阅、
 *       读取失败保持未基线、状态落盘、启停定时器、不触达 home。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDmWatcher,
  dmConversationFingerprint,
  dmConversationFingerprintHash,
  formatDmEventText,
  normalizeDmTimeLabel,
} from '../lib/dm-watch.js'
import { normalizeConfig } from '../lib/config.js'

const OWNER_CONV = {
  id: 'dmc_aaaaaaaaaaaa',
  index: 0,
  name: '饲养员',
  preview: '在吗',
  time: '刚刚',
  isOwner: true,
}
const OTHER_CONV = {
  id: 'dmc_bbbbbbbbbbbb',
  index: 1,
  name: '路人',
  preview: '你好',
  time: '30分钟前',
  isOwner: false,
}

function makeCfg(over = {}) {
  // over 在 normalizeConfig 之后合并：watchBackoff*/watchBreaker* 由 corefix 并行加进 lib/config.js，
  // 本测试不依赖这些键是否已经存在（插件侧一律带默认值读）。
  return {
    ...normalizeConfig({
      dmWatchEnabled: true,
      dmWatchIntervalMs: 3000,
      dmWatchStartupDelayMs: 0,
      dmOwnerAliases: ['饲养员', '草荧'],
    }),
    ...over,
  }
}

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
  timers.fire = async (t) => {
    const r = await t.fn()
    return r
  }
  return timers
}

function makeService(items = []) {
  const calls = []
  let failCode = null
  const svc = {
    calls,
    items,
    failMessage: null,
    async dmPollConversations(opts = {}) {
      calls.push(opts)
      if (failCode) return { ok: false, code: failCode, message: svc.failMessage ?? failCode }
      return { ok: true, items: svc.items.slice(), count: svc.items.length }
    },
    fail(code) {
      failCode = code
    },
  }
  return svc
}

function makeLogger() {
  const lines = []
  return { lines, info: (m) => lines.push(['info', String(m)]), warn: (m) => lines.push(['warn', String(m)]) }
}

function makeClock(start = 1794657000000) {
  let now = start
  return {
    now: () => now,
    advance: (ms) => { now += ms },
    set: (ms) => { now = ms },
  }
}

test('纯函数：时间归一 / 指纹 / 事件正文', () => {
  assert.equal(normalizeDmTimeLabel('刚刚'), 'recent')
  assert.equal(normalizeDmTimeLabel('3分钟前'), 'recent')
  assert.equal(normalizeDmTimeLabel('2小时前'), 'recent')
  assert.equal(normalizeDmTimeLabel('10/30'), '10/30')
  assert.equal(normalizeDmTimeLabel(''), '')
  assert.equal(dmConversationFingerprintHash(OWNER_CONV), dmConversationFingerprintHash({ ...OWNER_CONV, time: '5分钟前' }))
  assert.notEqual(dmConversationFingerprintHash(OWNER_CONV), dmConversationFingerprintHash({ ...OWNER_CONV, preview: '新消息' }))
  assert.match(dmConversationFingerprint(OWNER_CONV), /^饲养员\u0001在吗\u0001recent$/)
  assert.equal(
    formatDmEventText({ owner: true, conversationName: '饲养员', text: '在吗', time: '刚刚' }),
    '【抖音私信】主人(饲养员)：在吗（刚刚）',
  )
  assert.equal(
    formatDmEventText({ owner: false, conversationName: '路人', text: '你好', time: '' }),
    '【抖音私信】路人：你好',
  )
})

test('dm watcher：第一次只建基线；新会话才产生 owner=true/false 事件；重复不投', async () => {
  const svc = makeService([OWNER_CONV])
  const w = createDmWatcher({ cfg: makeCfg(), service: svc })
  const first = await w.tick()
  assert.equal(first.ok, true)
  assert.equal(first.baseline, true)
  assert.equal(first.newCount, 0)
  assert.equal(w.primed, true)
  assert.equal(svc.calls[0].keepOpen, true)
  assert.equal(svc.calls[0].limit, 20)

  svc.items.push(OTHER_CONV)
  const pending1 = await w.tick()
  assert.equal(pending1.newCount, 0, '默认 confirmTicks=2：第一眼只进候选，不投')
  assert.equal(w.status().candidates, 1)
  const second = await w.tick()
  assert.equal(second.baseline, false)
  assert.equal(second.newCount, 1)
  assert.equal(second.events.length, 1)
  assert.equal(w.status().candidates, 0)
  const ev = second.events[0]
  assert.equal(ev.type, 'dm_message')
  assert.equal(ev.owner, false)
  assert.equal(ev.isOwner, false)
  assert.equal(ev.conversationName, '路人')
  assert.equal(ev.sender, '路人')
  assert.equal(ev.conversationId, 'dmc_bbbbbbbbbbbb')
  assert.equal(ev.text, '你好')
  assert.equal(ev.time, '30分钟前')
  assert.match(ev.id, /^dme_[a-f0-9]{12}_\d+$/)
  assert.equal(ev.dedupeKey, dmConversationFingerprintHash(OTHER_CONV))

  const third = await w.tick()
  assert.equal(third.newCount, 0)
  assert.equal(w.status().eventsEmitted, 1)
})

test('dm watcher：owner 事件标注；相对时间从“刚刚”→“1分钟前”不重复上报；预览变化才报', async () => {
  const svc = makeService([{ ...OWNER_CONV }])
  const w = createDmWatcher({ cfg: makeCfg(), service: svc })
  await w.tick() // baseline

  svc.items = [{ ...OWNER_CONV, time: '1分钟前' }]
  let r = await w.tick()
  assert.equal(r.newCount, 0)

  svc.items = [{ ...OWNER_CONV, time: '1分钟前', preview: '新的消息' }]
  assert.equal((await w.tick()).newCount, 0)
  r = await w.tick()
  assert.equal(r.newCount, 1)
  assert.equal(r.events[0].owner, true)
  assert.equal(r.events[0].isOwner, true)
  assert.equal(r.events[0].text, '新的消息')
  assert.equal(r.events[0].time, '1分钟前')

  // 自己的预览（“我：”）确认后直接跳过，不投 home；stats.selfSkipped 记一笔
  svc.items = [{ ...OWNER_CONV, time: '1分钟前', preview: '我：晚安' }]
  assert.equal((await w.tick()).newCount, 0)
  r = await w.tick()
  assert.equal(r.newCount, 0)
  assert.equal(w.status().selfSkipped, 1)
})

test('dm watcher：owner 判断兼容别名与列表里没带 isOwner 的 fake', async () => {
  const svc = makeService([{ id: 'dmc_dddddddddddd', index: 1, name: '陌生人', preview: '嗨', time: '刚刚' }])
  const w = createDmWatcher({ cfg: makeCfg(), service: svc })
  await w.tick()
  svc.items.push({ id: 'dmc_cccccccccccc', index: 0, name: '草荧', preview: '在吗', time: '刚刚' })
  assert.equal((await w.tick()).newCount, 0)
  const r = await w.tick()
  assert.equal(r.newCount, 1)
  assert.equal(r.events[0].owner, true)
  assert.equal(r.events[0].conversationName, '草荧')

  svc.items.push({ id: 'dmc_eeeeeeeeeeee', index: 2, name: '陌生人2', preview: '你好', time: '刚刚' })
  assert.equal((await w.tick()).newCount, 0)
  const r2 = await w.tick()
  assert.equal(r2.events[0].owner, false)
})

test('dm watcher：request poll/drain 队列语义 + subscribe/onEvent；订阅者抛错不影响', async () => {
  const svc = makeService([OWNER_CONV])
  const received = []
  let onEventCalls = 0
  const w = createDmWatcher({
    cfg: makeCfg(),
    service: svc,
    onEvent: () => {
      onEventCalls += 1
      throw new Error('bad subscriber')
    },
  })
  const unsub = w.subscribe((e) => received.push(e))
  const base = await w.request({ action: 'poll' })
  assert.equal(base.ok, true)
  assert.equal(base.tick.baseline, true)
  assert.equal(base.events.length, 0)

  svc.items.push(OTHER_CONV)
  const poll0 = await w.request({ action: 'poll' })
  assert.equal(poll0.ok, true)
  assert.equal(poll0.count, 0, 'confirmTicks=2：第一次 poll 只进候选')
  const poll = await w.request({ action: 'poll' })
  assert.equal(poll.ok, true)
  assert.equal(poll.count, 1)
  assert.equal(poll.events[0].conversationName, '路人')
  assert.equal(received.length, 1)
  assert.equal(onEventCalls, 1)

  // 已取走：drain 为空
  const drained = await w.request({ action: 'drain' })
  assert.equal(drained.count, 0)
  const status = await w.request({ action: 'status' })
  assert.equal(status.ok, true)
  assert.equal(status.primed, true)
  unsub()
  svc.items.push({ ...OTHER_CONV, preview: '再来一条' })
  await w.request({ action: 'poll' })
  await w.request({ action: 'poll' })
  assert.equal(received.length, 1) // 已退订
})

test('dm watcher：读取失败保持未基线，恢复后只建基线；日志只记一次同码', async () => {
  const svc = makeService([OWNER_CONV])
  svc.fail('E_TIMEOUT')
  const log = makeLogger()
  const w = createDmWatcher({ cfg: makeCfg(), service: svc, log })
  const bad = await w.tick()
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'E_TIMEOUT')
  assert.equal(w.primed, false)
  assert.equal(w.status().errors, 1)
  await w.tick()
  assert.equal(log.lines.filter(([lvl, m]) => lvl === 'warn' && m.includes('E_TIMEOUT')).length, 1)

  // 恢复：第一次成功读取只建基线
  const goodSvc = makeService([OWNER_CONV])
  const w2 = createDmWatcher({ cfg: makeCfg(), service: goodSvc })
  const good = await w2.tick()
  assert.equal(good.baseline, true)
  assert.equal(good.newCount, 0)
})

test('dm watcher：并发 tick 第二次 skipped:busy；不打开会话/不调用 home', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const service = {
    async dmPollConversations() {
      calls += 1
      await gate
      return { ok: true, items: [OWNER_CONV] }
    },
  }
  const home = { delivered: 0, async deliver() { this.delivered += 1; return { ok: true } } }
  const ctx = { get: (name) => (name === 'dyHome' ? home : undefined) }
  const w = createDmWatcher({ cfg: makeCfg(), service, ctx })
  const p1 = w.tick()
  const p2 = await w.tick()
  assert.equal(p2.skipped, true)
  assert.equal(p2.reason, 'busy')
  release()
  const r1 = await p1
  assert.equal(r1.baseline, true)
  assert.equal(calls, 1)
  assert.equal(home.delivered, 0)
})

test('dm watcher：状态落盘后重启不重复投同一快照', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dy-dm-watch-'))
  try {
    const stateFile = join(dir, 'seen.json')
    const cfg = makeCfg({ dmWatchStateFile: stateFile })
    const svc1 = makeService([{ ...OWNER_CONV, time: '刚刚' }])
    const w1 = createDmWatcher({ cfg, service: svc1 })
    assert.equal((await w1.tick()).baseline, true)

    const svc2 = makeService([{ ...OWNER_CONV, time: '1分钟前' }])
    const w2 = createDmWatcher({ cfg, service: svc2 })
    const r = await w2.tick()
    assert.equal(r.newCount, 0)
    assert.equal(r.baseline, false)

    svc2.items.push(OTHER_CONV)
    assert.equal((await w2.tick()).newCount, 0)
    const r2 = await w2.tick()
    assert.equal(r2.newCount, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dm watcher：默认关；start/stop 定时器与 interval 下限 2s；dispose 后不再排期', () => {
  const off = createDmWatcher({ cfg: normalizeConfig({}), service: makeService([]) })
  assert.equal(off.status().enabled, false)
  assert.equal(off.start(), false)

  const scheduled = []
  const cleared = []
  const timers = {
    setTimeout(fn, ms) {
      const t = { fn, ms, unref() {} }
      scheduled.push(t)
      return t
    },
    clearTimeout(t) {
      cleared.push(t)
    },
  }
  const cfg = makeCfg({ dmWatchStartupDelayMs: 5, dmWatchIntervalMs: 3000 })
  const w = createDmWatcher({ cfg, service: makeService([]), timers })
  assert.equal(w.start(), true)
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].ms, 5)
  assert.equal(w.status().running, true)
  assert.equal(w.status().intervalMs, 3000)
  w.stop()
  assert.equal(cleared.length, 1)
  assert.equal(w.start(), false)

  // 低于 2s 的配置回落默认 3s；2s 合法
  const low = normalizeConfig({ dmWatchIntervalMs: 1000 })
  assert.equal(low.dmWatchIntervalMs, 3000)
  const min = normalizeConfig({ dmWatchIntervalMs: 2000 })
  assert.equal(min.dmWatchIntervalMs, 2000)
  // 2–5s 内的自定义值保留
  assert.equal(normalizeConfig({ dmWatchIntervalMs: 5000 }).dmWatchIntervalMs, 5000)

  // 定时器到点会轮询并把事件写入队列
  const svc = makeService([OWNER_CONV])
  const w2 = createDmWatcher({ cfg: makeCfg({ dmWatchStartupDelayMs: 0 }), service: svc, timers })
  const before = scheduled.length
  assert.equal(w2.start(), true)
  assert.equal(scheduled.length, before + 1)
})

test('dm watcher：页面切换造成的瞬时错位（出现一次又消失）不产生假事件', async () => {
  const svc = makeService([OWNER_CONV])
  const w = createDmWatcher({ cfg: makeCfg(), service: svc })
  await w.tick() // baseline

  // 模拟导航过程中名称/预览错位：多出一条假会话，下一轮消失
  svc.items.push({ id: 'dmc_ffffffffffff', index: 9, name: '饲养员', preview: '', time: '' })
  assert.equal((await w.tick()).newCount, 0)
  assert.equal(w.status().candidates, 1)
  svc.items.pop()
  assert.equal((await w.tick()).newCount, 0)
  assert.equal(w.status().candidates, 0)

  // 真实新消息：连续两轮存在才投
  svc.items.push({ ...OTHER_CONV, preview: '真的来了' })
  assert.equal((await w.tick()).newCount, 0)
  const r = await w.tick()
  assert.equal(r.newCount, 1)
  assert.equal(r.events[0].text, '真的来了')
})

test('失败退避：连续两次失败后 schedule 被推迟（3s→6s，fake timers 实测 delay）', async () => {
  const timers = makeTimers()
  const clock = makeClock(1794657000000)
  const svc = makeService([OWNER_CONV])
  svc.fail('E_REMOTE_IO')
  const w = createDmWatcher({
    cfg: makeCfg({ dmWatchStartupDelayMs: 0, watchBackoffMinMs: 3000, watchBackoffMaxMs: 60000, watchBackoffFactor: 2 }),
    service: svc,
    timers,
    clock: clock.now,
  })
  assert.equal(w.start(), true)
  assert.equal(timers.scheduled.length, 1)
  assert.equal(timers.scheduled[0].ms, 0, '启动延迟 0')

  // 第 1 次失败：按 max(intervalMs, minBackoff) = 3000 排期
  let out = await timers.fire(timers.scheduled[0])
  assert.equal(out.result.ok, false)
  assert.equal(out.result.code, 'E_REMOTE_IO')
  assert.equal(out.nextDelayMs, 3000)
  assert.equal(timers.scheduled.at(-1).ms, 3000)
  assert.equal(w.status().fails, 1)
  assert.equal(w.status().backoffMs, 3000)
  assert.equal(w.status().breakerOpen, false)

  // 第 2 次失败：6s（比正常 3s 间隔推迟一倍）
  clock.advance(3000)
  out = await timers.fire(timers.scheduled.at(-1))
  assert.equal(out.nextDelayMs, 6000)
  assert.equal(timers.scheduled.at(-1).ms, 6000)
  assert.equal(w.status().fails, 2)
  assert.equal(w.status().backoffMs, 6000)
  assert.ok(w.status().nextTickAt > clock.now(), 'nextTickAt 必须指向未来')

  // 成功一次：退避归零，回到 intervalMs
  svc.fail(null)
  clock.advance(6000)
  out = await timers.fire(timers.scheduled.at(-1))
  assert.equal(out.nextDelayMs, 3000)
  assert.equal(w.status().fails, 0)
  assert.equal(w.status().backoffMs, 0)
  w.stop()
})

test('熔断：连续 N 次失败暂停 watcher（冷却内不再按间隔），冷却到点单次探测成功后复位', async () => {
  const timers = makeTimers()
  const clock = makeClock(1794657000000)
  const svc = makeService([OWNER_CONV])
  svc.fail('E_TIMEOUT')
  const log = makeLogger()
  const w = createDmWatcher({
    cfg: makeCfg({
      dmWatchStartupDelayMs: 0,
      watchBackoffMinMs: 3000,
      watchBackoffMaxMs: 60000,
      watchBackoffFactor: 2,
      watchBreakerFails: 3,
      watchBreakerCooldownMs: 30000,
    }),
    service: svc,
    timers,
    clock: clock.now,
    log,
  })
  w.start()
  assert.equal(timers.scheduled[0].ms, 0)

  let out = await timers.fire(timers.scheduled[0]) // fail 1 → 3000
  assert.equal(out.nextDelayMs, 3000)
  clock.advance(3000)
  out = await timers.fire(timers.scheduled.at(-1)) // fail 2 → 6000
  assert.equal(out.nextDelayMs, 6000)
  clock.advance(6000)
  out = await timers.fire(timers.scheduled.at(-1)) // fail 3 → 熔断
  assert.equal(w.status().fails, 3)
  assert.equal(w.status().breakerOpen, true)
  assert.equal(out.nextDelayMs, 30000, '熔断后等一个冷却周期，不再按 interval/backoff 排期')
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && m.includes('已熔断')))

  // 熔断中：delayMs 仍是冷却剩余（不会被 interval 抢跑）
  assert.equal(w.status().breakerCooldownMs, 30000)
  assert.equal(w.status().breakerProbeTicks, 0)

  // 冷却到点：单次探测仍失败 → 重新冷却一个周期
  clock.advance(30000)
  out = await timers.fire(timers.scheduled.at(-1))
  assert.equal(out.result.ok, false)
  assert.equal(out.nextDelayMs, 30000)
  assert.equal(w.status().breakerOpen, true)
  assert.equal(w.status().breakerProbeTicks, 1)

  // 再冷却后探测成功 → 复位（fails=0 / backoffMs=0 / breakerOpen=false）
  svc.fail(null)
  clock.advance(30000)
  out = await timers.fire(timers.scheduled.at(-1))
  assert.equal(out.result.baseline, true)
  assert.equal(out.nextDelayMs, 3000)
  const st = w.status()
  assert.equal(st.breakerOpen, false)
  assert.equal(st.fails, 0)
  assert.equal(st.backoffMs, 0)
  assert.equal(st.lastFailCode, null)
  w.stop()
})

test('崩溃感知：E_REMOTE_IO + Target crashed → 立刻请求一次桥 health；老桥 E_UNKNOWN_CMD 静默', async () => {
  const clock = makeClock(1794657000000)
  const svc = makeService([OWNER_CONV])
  svc.fail('E_REMOTE_IO')
  svc.failMessage = 'locator.count: Target crashed'
  const log = makeLogger()
  const healthCalls = []
  const bridge = {
    async call(cmd, params, opts) {
      healthCalls.push({ cmd, params, opts })
      const e = new Error('不允许的桥命令：health')
      e.code = 'E_BAD_ARG'
      throw e
    },
  }
  const w = createDmWatcher({ cfg: makeCfg({ dmWatchStartupDelayMs: 0 }), service: svc, bridge, clock: clock.now, log })
  const r = await w.tick()
  assert.equal(r.ok, false)
  const st = w.status()
  assert.equal(st.healthProbes, 1)
  assert.equal(st.healthSkipped, 1)
  // 老桥不认识 health：不再刷错误日志，只保留"已请求健康检查"这一条 warn
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'warn' && m.includes('页面崩溃') && m.includes('已请求健康检查')))
  assert.equal(healthCalls.length, 1)
  assert.equal(healthCalls[0].cmd, 'health')
  // tick() 自身不改退避（退避在 schedule 侧），但状态里崩溃探测结果可见
  assert.equal(st.lastHealth, null)
})

test('崩溃感知：bridge 可用时 health 结果进 status（按 role 的 renderer）', async () => {
  const clock = makeClock(1794657000000)
  const timers = makeTimers()
  const svc = makeService([OWNER_CONV])
  svc.fail('E_BRIDGE_DOWN')
  svc.failMessage = 'bridge down'
  const bridge = {
    async call(cmd) {
      return {
        browser: true,
        pages: 2,
        roles: {
          main: { renderer: 'ok' },
          dm: { renderer: 'crashed', crashedAt: 1 },
        },
      }
    },
  }
  const w = createDmWatcher({ cfg: makeCfg({ dmWatchStartupDelayMs: 0 }), service: svc, bridge, timers, clock: clock.now })
  w.start()
  await timers.fire(timers.scheduled[0])
  const st = w.status()
  assert.equal(st.healthProbes, 1)
  assert.equal(st.healthErrors, 0)
  assert.deepEqual(st.lastHealth, { browser: true, pages: 2, roles: { main: 'ok', dm: 'crashed' } })
  assert.equal(st.healthSkipped, 0)
  w.stop()
})
