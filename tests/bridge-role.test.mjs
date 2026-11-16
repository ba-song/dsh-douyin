/**
 * 多页面 role 路由测试（fake transport，不连真实服务）：
 * - BridgeClient：缺省 main 不带 role；withRole('notify'/'dm') 显式带 role；
 * - 通知 watcher 原语全部落在 notify role；
 * - 私信 watcher 轮询全部落在 dm role（不碰 main）；
 * - feed / 首页归位仍是 main（不带 role，旧调用兼容）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { BridgeClient, PAGE_ROLES, normalizePageRole } from '../lib/bridge.js'
import { cleanupDir, makeFakeTransport, setup } from './helpers.mjs'

const HOME = 'https://www.douyin.com/?recommend=1&from_nav=1'

test('normalizePageRole：只允许 main/notify/dm，缺省 main', () => {
  assert.deepEqual([...PAGE_ROLES], ['main', 'notify', 'dm'])
  assert.equal(normalizePageRole(undefined), 'main')
  assert.equal(normalizePageRole('notify'), 'notify')
  assert.equal(normalizePageRole('DM'), 'dm')
  assert.throws(() => normalizePageRole('video'), /role/)
})

test('BridgeClient：main 不带 role（旧协议兼容）；withRole 显式 role；tabs 透传', async () => {
  const transport = makeFakeTransport({
    tabs: () => ({
        ok: true,
        cmd: 'tabs',
        result: [
          { role: 'main', index: 0, url: HOME, title: '推荐' },
          { role: 'notify', index: 1, url: HOME, title: '通知' },
          { role: 'dm', index: 2, url: 'https://www.douyin.com/chat', title: '私信' },
        ],
    }),
  })
  const main = new BridgeClient({ transport, cfg: {} })
  await main.open(HOME)
  assert.equal(transport.calls[0].cmd, 'open')
  assert.equal(transport.calls[0].role, undefined)
  assert.equal(transport.calls[0].pageRole, undefined)

  const dm = main.withRole('dm')
  await dm.open('https://www.douyin.com/chat')
  assert.equal(transport.calls[1].role, 'dm')

  const notify = main.withRole('notify')
  await notify.jsWatch('start')
  assert.equal(transport.calls[2].role, 'notify')
  assert.equal(transport.calls[2].action, 'start')

  await main.jsWatch('take', { limit: 5 })
  assert.equal(transport.calls[3].role, undefined)

  const tabs = await main.tabs()
  assert.deepEqual(tabs.map((x) => x.role), ['main', 'notify', 'dm'])
  assert.equal(tabs[2].url, 'https://www.douyin.com/chat')
  assert.throws(() => main.withRole('video'), /role/)
})

test('service：notifySourceStart/Take/Stop + badge + snapshot 全部使用 notify role', async () => {
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: HOME }),
      count: () => ({ ok: true, cmd: 'count', result: 0 }),
      html: () => ({ ok: true, cmd: 'html', result: '<span class="badge">1</span>' }),
      text: () => ({ ok: true, cmd: 'text', result: '通知' }),
      list: () => ({ ok: true, cmd: 'list', result: [] }),
      jsWatch: (p) => ({ ok: true, cmd: 'jsWatch', result: { action: p.action, seq: 1, cursor: 0, pending: 0, events: [] } }),
    },
  })
  const start = await s.runtime.rawService.notifySourceStart()
  assert.equal(start.ok, true)
  await s.runtime.rawService.notifySourceTake({ limit: 5 })
  await s.runtime.rawService.notifySourceStop()
  await s.runtime.rawService.notifyBadgeProbe({ selectors: ['header [data-e2e="something-button"]'] })
  const snap = await s.runtime.rawService.notifySnapshotForWatch({ allowOpen: false, limit: 20 })
  assert.equal(snap.ok, true)

  const js = s.transport.calls.filter((c) => c.cmd === 'jsWatch')
  assert.deepEqual(js.map((c) => c.action), ['start', 'take', 'stop'])
  assert.ok(js.every((c) => c.role === 'notify'))
  const urlCalls = s.transport.calls.filter((c) => c.cmd === 'url')
  assert.ok(urlCalls.length >= 2)
  assert.ok(urlCalls.every((c) => c.role === 'notify'))
  const countCalls = s.transport.calls.filter((c) => c.cmd === 'count')
  assert.ok(countCalls.every((c) => c.role === 'notify'))
  cleanupDir(s.dir)
})

test('service：dmPollConversations 在 dm role 打开 /chat，不碰 main', async () => {
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: HOME }),
      count: () => ({ ok: true, cmd: 'count', result: 1 }),
      list: () => ({ ok: true, cmd: 'list', result: [] }),
    },
  })
  const r = await s.runtime.rawService.dmPollConversations({ limit: 5, keepOpen: true })
  assert.equal(r.ok, true)
  const open = s.transport.calls.find((c) => c.cmd === 'open')
  assert.equal(open.role, 'dm')
  assert.equal(open.url, 'https://www.douyin.com/chat')
  assert.ok(s.transport.calls.every((c) => c.cmd === 'ping' || c.role === 'dm'))
  cleanupDir(s.dir)
})

test('service：feed 首页归位仍是 main（不带 role）', async () => {
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/999999999' }),
      list: () => ({ ok: true, cmd: 'list', result: [] }),
    },
  })
  await s.runtime.rawService.feed({ limit: 1 })
  const open = s.transport.calls.find((c) => c.cmd === 'open')
  assert.equal(open.url, HOME)
  assert.equal(open.role, undefined)
  cleanupDir(s.dir)
})

/** 让出事件循环，确保已排进队列的任务开始跑 */
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('队列分道：watchQueue 忙时 watch 原语 skip:busy，userQueue 仍立即执行；queueStats 字段', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const s = setup({
    handlers: {
      url: async (payload) => {
        // 只卡 dm role 的 url（status 走 main，不能被这个 gate 误伤）
        if (payload?.role === 'dm') await gate
        return { ok: true, cmd: 'url', result: HOME }
      },
      count: () => ({ ok: true, cmd: 'count', result: 1 }),
      list: () => ({ ok: true, cmd: 'list', result: [] }),
      jsWatch: () => ({ ok: true, cmd: 'jsWatch', result: { action: 'start', seq: 1, cursor: 0, pending: 0, events: [] } }),
    },
    rawConfig: { minIntervalMs: 0 },
  })

  // 用 dmPollConversations（watchQueue）占住唯一的 watch 槽位
  const busyPromise = s.runtime.service.dmPollConversations({ limit: 5 })
  await tick()
  const stats = s.runtime.service.queueStats()
  assert.equal(stats.watchDepth, 1)
  assert.equal(stats.watchMax, 1)
  assert.equal(stats.watchAccepting, false)
  assert.equal(stats.userDepth, 0)
  assert.equal(stats.accepting, true)
  assert.equal(stats.userMax, 8)
  assert.equal(stats.maxQueue, 8)

  // watch 原语忙 → {ok:true,skipped:true,reason:'busy'}（保持 tick 的 busy 语义，不抛 E_BUSY）
  const skipped = await s.runtime.service.notifySourceStart()
  assert.equal(skipped.ok, true)
  assert.equal(skipped.skipped, true)
  assert.equal(skipped.reason, 'busy')
  assert.equal(skipped.code, 'E_BUSY')
  assert.ok(skipped.retryAfterMs >= 300 && skipped.retryAfterMs <= 1500)

  // 关键：watch 占着槽位时，userQueue 调用不能被卡住（分道前共用一个队列，会排队到 watcher 之后）
  const status = await Promise.race([
    s.runtime.service.status(),
    new Promise((resolve) => setTimeout(() => resolve('BLOCKED'), 1000)),
  ])
  assert.notEqual(status, 'BLOCKED', 'userQueue 被 watchQueue 阻塞')
  assert.equal(status.ok, true)

  release()
  const dm = await busyPromise
  assert.equal(dm.ok, true)
  assert.equal(s.runtime.service.queueStats().watchDepth, 0)
  cleanupDir(s.dir)
})

test('队列背压：userQueue 满时 E_BUSY 带 retryAfterMs（300–1500ms），队列统计可见', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const s = setup({
    handlers: {
      ping: async () => {
        await gate
        return { ok: true, cmd: 'ping', result: { proto: '1.0', browser: true, pages: 1 } }
      },
    },
    rawConfig: { minIntervalMs: 0, maxQueue: 1 },
  })
  const first = s.runtime.service.status()
  await tick()
  const stats = s.runtime.service.queueStats()
  assert.equal(stats.userDepth, 1)
  assert.equal(stats.accepting, false)
  assert.ok(stats.retryAfterMs >= 300 && stats.retryAfterMs <= 1500)

  const second = await s.runtime.service.status()
  assert.equal(second.ok, false)
  assert.equal(second.code, 'E_BUSY')
  assert.ok(second.retryAfterMs >= 300 && second.retryAfterMs <= 1500, `retryAfterMs=${second.retryAfterMs}`)

  release()
  const ok = await first
  assert.equal(ok.ok, true)
  assert.equal(s.runtime.service.queueStats().userDepth, 0)
  cleanupDir(s.dir)
})

test('notifyRefreshForWatch 已注册进 service 包装（audit 缺陷 3），走 userQueue', async () => {
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: HOME }),
      open: () => ({ ok: true, cmd: 'open', result: { url: HOME, status: 200, title: '抖音' } }),
    },
    rawConfig: { minIntervalMs: 0 },
  })
  assert.equal(typeof s.runtime.service.notifyRefreshForWatch, 'function')
  // 2026-11-17：已在主站类页面时只做 URL 检查、不做 7–9s 重导航（否则 15s 一次会把全局串行链占满）
  const r = await s.runtime.service.notifyRefreshForWatch()
  assert.equal(r.ok, true)
  assert.equal(r.skipped, 'homeish')
  assert.equal(s.transport.calls.find((c) => c.cmd === 'open'), undefined, '主站类页面不应导航')
  cleanupDir(s.dir)
})

test('notifyRefreshForWatch：notify tab 漂到视频页时才 open 回首页（只碰 notify tab）', async () => {
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/7558343112453410106' }),
      open: () => ({ ok: true, cmd: 'open', result: { url: HOME, status: 200, title: '抖音' } }),
    },
    rawConfig: { minIntervalMs: 0 },
  })
  const r = await s.runtime.service.notifyRefreshForWatch()
  assert.equal(r.ok, true)
  const open = s.transport.calls.find((c) => c.cmd === 'open')
  assert.ok(open, '视频页应导航回首页')
  assert.equal(open.role, 'notify', '重载只碰 notify tab')
  cleanupDir(s.dir)
})
