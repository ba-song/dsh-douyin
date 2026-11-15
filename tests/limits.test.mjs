import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { normalizeConfig } from '../lib/config.js'
import {
  AuditLog,
  RateLimiter,
  SerialQueue,
  dayKey,
  isInTimeWindows,
  minutesOfDay,
  nextAllowedAt,
} from '../lib/limits.js'
import { cleanupDir, makeTmpDir } from './helpers.mjs'

const ALL_DAY = {
  weekday: [[0, 1440]],
  weekend: [[0, 1440]],
  silence: [],
}

function baseCfg(overrides = {}) {
  return {
    enabled: true,
    tzOffsetMinutes: 480,
    timeWindows: ALL_DAY,
    dailyQuota: 40,
    perSession: 8,
    sessionGapMs: 1800000,
    minIntervalMs: 0,
    minWatchMs: 10000,
    auditFile: '',
    maxAuditBytes: 5 * 1024 * 1024,
    ...overrides,
  }
}

function nullAudit() {
  return { readRecent: () => [], append: () => true }
}

function makeLimiter(overrides = {}, opts = {}) {
  const cfg = baseCfg(overrides)
  return {
    cfg,
    limiter: new RateLimiter({
      cfg,
      clock: opts.clock ?? (() => Date.parse('2026-11-06T18:30:00+08:00')),
      audit: opts.audit ?? nullAudit(),
    }),
  }
}

test('dayKey / minutesOfDay 按 Asia/Shanghai 计算', () => {
  const t = Date.parse('2026-11-06T08:30:00+08:00')
  assert.equal(dayKey(t), '2026-11-06')
  assert.equal(minutesOfDay(t), 510)
  // 上海 00:30 仍然是当地 11-07，UTC 是 11-06 16:30
  assert.equal(dayKey(Date.parse('2026-11-07T00:30:00+08:00')), '2026-11-07')
})

test('可用时段：工作日三窗口、周末全天、00-08 静默最高优先', () => {
  const { timeWindows } = normalizeConfig({})
  const check = (iso) => isInTimeWindows(Date.parse(iso), timeWindows, 480)

  assert.equal(check('2026-11-06T08:30:00+08:00').allowed, true) // 周五上午
  assert.equal(check('2026-11-06T09:00:00+08:00').allowed, false)
  assert.equal(check('2026-11-06T10:00:00+08:00').allowed, false)
  assert.equal(check('2026-11-06T12:30:00+08:00').allowed, true)
  assert.equal(check('2026-11-06T14:00:00+08:00').allowed, false)
  assert.equal(check('2026-11-06T17:59:00+08:00').allowed, false)
  assert.equal(check('2026-11-06T18:00:00+08:00').allowed, true)
  assert.equal(check('2026-11-06T23:59:00+08:00').allowed, true)

  // 周六周日全天，但 00-08 仍是静默
  assert.equal(check('2026-11-07T01:00:00+08:00').allowed, false)
  assert.equal(check('2026-11-07T01:00:00+08:00').reason, 'silence')
  assert.equal(check('2026-11-07T09:00:00+08:00').allowed, true)
  assert.equal(check('2026-11-08T23:59:00+08:00').allowed, true)

  // 周一 07:59 静默，08:00 起开放
  assert.equal(check('2026-11-09T07:59:00+08:00').allowed, false)
  assert.equal(check('2026-11-09T08:00:00+08:00').allowed, true)
  assert.equal(check('2026-11-10T00:30:00+08:00').allowed, false) // 周二凌晨
})

test('nextAllowedAt：周五 10:00 → 下一个 12:00', () => {
  const { timeWindows } = normalizeConfig({})
  const now = Date.parse('2026-11-06T10:00:30+08:00')
  const next = nextAllowedAt(now, timeWindows, 480)
  assert.equal(next, Date.parse('2026-11-06T12:00:00+08:00'))
})

test('guard：enabled=false → E_DISABLED', () => {
  const { limiter } = makeLimiter({ enabled: false })
  assert.throws(
    () => limiter.guard({ cmd: 'status', now: Date.parse('2026-11-06T18:30:00+08:00') }),
    (e) => e.code === 'E_DISABLED',
  )
})

test('最小间隔 5s：太快 E_MIN_INTERVAL，带 retryAfterMs', () => {
  const now = Date.parse('2026-11-06T18:30:00+08:00')
  const { limiter } = makeLimiter({ minIntervalMs: 5000 })
  limiter.guard({ cmd: 'status', now })
  limiter.commit({ cmd: 'status', now, ok: true, count: 0 })

  assert.throws(
    () => limiter.guard({ cmd: 'status', now: now + 1000 }),
    (e) => e.code === 'E_MIN_INTERVAL' && e.retryAfterMs === 4000,
  )
  assert.doesNotThrow(() => limiter.guard({ cmd: 'status', now: now + 5000 }))
})

test('单次会话 8 条：watch 结算满 2 条后第 3 次 open 被拒，30 分钟后新会话', () => {
  let now = Date.parse('2026-11-06T18:30:00+08:00')
  const { limiter } = makeLimiter({ perSession: 2 })
  for (let i = 0; i < 2; i++) {
    limiter.guard({ cmd: 'open', now })
    limiter.commit({ cmd: 'open', now, ok: true })
    limiter.startWatch({ videoId: `video-${i}`, now })
    const settled = limiter.settleWatch(now + 10000)
    assert.equal(settled.charged, true)
    now += 11000
  }
  assert.throws(
    () => limiter.guard({ cmd: 'open', now }),
    (e) => e.code === 'E_SESSION_QUOTA',
  )
  now += 1800000
  assert.doesNotThrow(() => limiter.guard({ cmd: 'open', now }))
})

test('每日 40 条：5 个会话 × 8 条 watch 后 E_QUOTA', () => {
  let now = Date.parse('2026-11-06T18:30:00+08:00')
  const { limiter } = makeLimiter({ dailyQuota: 40, perSession: 8 })
  for (let session = 0; session < 5; session++) {
    if (session > 0) now += 31 * 60 * 1000
    for (let i = 0; i < 8; i++) {
      limiter.guard({ cmd: 'open', now })
      limiter.commit({ cmd: 'open', now, ok: true })
      limiter.startWatch({ videoId: `v${session}-${i}`, now })
      assert.equal(limiter.settleWatch(now + 10000).charged, true)
      now += 11000
    }
    assert.equal(limiter.usage(now).dailyUsed, (session + 1) * 8)
  }
  assert.throws(
    () => limiter.guard({ cmd: 'open', now }),
    (e) => e.code === 'E_QUOTA',
  )
})

test('watch 结算：<10s 计 0、>=10s 计 1；feed commit 不计数', () => {
  const t0 = Date.parse('2026-11-06T18:30:00+08:00')
  const { limiter } = makeLimiter({ minWatchMs: 10000 })

  limiter.guard({ cmd: 'open', now: t0 })
  limiter.commit({ cmd: 'open', now: t0, ok: true })
  limiter.startWatch({ videoId: '111111111', now: t0 })
  const short = limiter.settleWatch(t0 + 9999)
  assert.equal(short.charged, false)
  assert.equal(short.watchMs, 9999)
  assert.equal(limiter.usage(t0 + 9999).dailyUsed, 0)

  const t1 = t0 + 10000
  limiter.guard({ cmd: 'open', now: t1 })
  limiter.commit({ cmd: 'open', now: t1, ok: true })
  limiter.startWatch({ videoId: '222222222', now: t1 })
  const full = limiter.settleWatch(t1 + 10000)
  assert.equal(full.charged, true)
  assert.equal(full.watchMs, 10000)
  assert.equal(limiter.usage(t1 + 10000).dailyUsed, 1)
  assert.equal(limiter.usage(t1 + 10000).sessionUsed, 1)

  // 普通命令 commit 不再加条数
  limiter.commit({ cmd: 'feed', now: t1 + 11000, ok: true })
  limiter.commit({ cmd: 'comments', now: t1 + 12000, ok: false, error: 'E_SELECTOR_MISS' })
  assert.equal(limiter.usage(t1 + 12000).dailyUsed, 1)
})

test('activeWatch：startWatch 不持久化；usage 返回 elapsed/minWatchMs/watched', () => {
  const t0 = Date.parse('2026-11-06T18:30:00+08:00')
  const { limiter } = makeLimiter({ minWatchMs: 10000 })
  limiter.startWatch({ videoId: '123456789', now: t0 })
  const usage = limiter.usage(t0 + 4000)
  assert.equal(usage.activeWatch.videoId, '123456789')
  assert.equal(usage.activeWatch.startedAt, t0)
  assert.equal(usage.activeWatch.elapsedMs, 4000)
  assert.equal(usage.minWatchMs, 10000)
  assert.equal(usage.watchedCount, 0)
  assert.deepEqual(usage.watched, { daily: 0, session: 0 })

  // 新 limiter 不会恢复 activeWatch（重启宁少不多）
  const fresh = new RateLimiter({
    cfg: baseCfg({ minWatchMs: 10000 }),
    clock: () => t0 + 4000,
    audit: nullAudit(),
  })
  assert.equal(fresh.usage(t0 + 4000).activeWatch, null)
})

test('charge 不改变 lastCallAt；audit 带 videoId/watchMs/charged', () => {
  const dir = makeTmpDir('charge')
  const file = join(dir, 'audit.jsonl')
  const t0 = Date.parse('2026-11-06T18:30:00+08:00')
  const cfg = baseCfg({ auditFile: file, minIntervalMs: 5000 })
  const audit = new AuditLog({ file, tzOffsetMinutes: 480 })
  const limiter = new RateLimiter({ cfg, clock: () => t0, audit })

  limiter.guard({ cmd: 'open', now: t0 })
  limiter.commit({ cmd: 'open', now: t0, ok: true })
  limiter.startWatch({ videoId: '123456789', now: t0 })
  limiter.settleWatch(t0 + 10000)

  assert.equal(limiter.lastCallAt, t0)
  // 若 charge 更新了 lastCallAt，t0+10001 距 t0+10000 仅 1ms 会 E_MIN_INTERVAL；这里应放行
  assert.doesNotThrow(() => limiter.guard({ cmd: 'feed', now: t0 + 10001 }))

  const entries = audit.readRecent({ sinceMs: 0 })
  const watch = entries.find((e) => e.cmd === 'watch')
  assert.ok(watch)
  assert.equal(watch.videoId, '123456789')
  assert.equal(watch.watchMs, 10000)
  assert.equal(watch.charged, true)
  assert.equal(watch.count, 1)
  assert.equal(watch.ok, true)

  const restored = new RateLimiter({
    cfg,
    clock: () => t0 + 10002,
    audit: new AuditLog({ file, tzOffsetMinutes: 480 }),
  })
  assert.equal(restored.usage(t0 + 10002).dailyUsed, 1)
  assert.equal(restored.usage(t0 + 10002).activeWatch, null)
  // lastCallAt 取普通命令（open t0），不被 watch 审计覆盖；t0+10001 距 t0 已 >5s
  assert.doesNotThrow(() => restored.guard({ cmd: 'feed', now: t0 + 10001 }))
  cleanupDir(dir)
})

test('审计字段：普通命令 count=0；watch 才带条数', () => {
  const dir = makeTmpDir('audit')
  const file = join(dir, 'audit.jsonl')
  const t0 = Date.parse('2026-11-06T18:30:00+08:00')
  const cfg = baseCfg({ auditFile: file })
  const audit = new AuditLog({ file, tzOffsetMinutes: 480 })
  const limiter = new RateLimiter({ cfg, clock: () => t0, audit })

  limiter.guard({ cmd: 'feed', now: t0 })
  limiter.commit({ cmd: 'feed', now: t0, ok: true })
  limiter.guard({ cmd: 'open', now: t0 + 6000 })
  limiter.commit({ cmd: 'open', now: t0 + 6000, ok: true })
  limiter.startWatch({ videoId: '123456789', now: t0 + 6000 })
  limiter.settleWatch(t0 + 7000) // 不足 10s

  const entries = audit.readRecent({ sinceMs: 0 })
  assert.deepEqual(Object.keys(entries[0]).sort(), ['at', 'cmd', 'count', 'error', 'ok', 'ts'])
  assert.equal(entries[0].cmd, 'feed')
  assert.equal(entries[0].count, 0)
  const watch = entries.find((e) => e.cmd === 'watch')
  assert.equal(watch.count, 0)
  assert.equal(watch.charged, false)
  assert.equal(watch.watchMs, 1000)
  assert.equal(limiter.usage(t0 + 7000).dailyUsed, 0)
  cleanupDir(dir)
})

test('SerialQueue：严格串行，队列满 E_BUSY', async () => {
  const q = new SerialQueue({ maxQueue: 2 })
  let running = 0
  let maxRunning = 0
  const job = (ms) => () =>
    new Promise((resolve) => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      setTimeout(() => {
        running -= 1
        resolve(ms)
      }, ms)
    })

  const p1 = q.run(job(20))
  const p2 = q.run(job(5))
  const p3 = q.run(job(1))
  await assert.rejects(p3, (e) => e.code === 'E_BUSY')
  const [a, b] = await Promise.all([p1, p2])
  assert.equal(a, 20)
  assert.equal(b, 5)
  assert.equal(maxRunning, 1)
  assert.equal(q.size, 0)
})

test('SerialQueue：上一单失败不打断后续', async () => {
  const q = new SerialQueue({ maxQueue: 2 })
  const p1 = q.run(async () => {
    throw new Error('boom')
  })
  const p2 = q.run(async () => 'ok')
  await assert.rejects(p1, /boom/)
  assert.equal(await p2, 'ok')
})

test('0 = 不设限：dailyQuota/perSession 为 0 时，已用很多条也不抛', () => {
  const { limiter } = makeLimiter({ dailyQuota: 0, perSession: 0 })
  limiter.charge({ count: 999, now: Date.parse('2026-11-06T18:30:00+08:00') })
  const g = limiter.guard({ cmd: 'watch', need: 1, now: Date.parse('2026-11-06T18:31:00+08:00') })
  assert.equal(g.dailyLeft, Number.MAX_SAFE_INTEGER)
  assert.equal(g.sessionLeft, Number.MAX_SAFE_INTEGER)
})
