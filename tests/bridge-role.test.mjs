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
