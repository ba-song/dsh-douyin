/**
 * 通知实时事件源的服务原语测试（fake bridge，不连真实服务、不打开真实面板）。
 * 覆盖：snapshot 非强制打开/读完即关、页面不安全不导航、badge 解析、jsWatch start/take/stop、
 *       绝不点搜索框/条目。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { cleanupDir, makeClock, setup } from './helpers.mjs'

const ENTRY = 'header [data-e2e="something-button"]:has-text("通知")'
const PANEL = '[data-e2e="listDlgTest-container"]'
const ITEM = '[data-e2e="listDlgTest-container"] > div:nth-child(2) > div'
const CLOSE = '[data-e2e="searchbar-input"]'
const ROWS = [
  { text: '饲养员\n朋友\n@汐\n在评论中提到了你刚刚' },
  { text: '豆包\nAI分身\n回复正文\n回复了你的评论30分钟前' },
  { text: '叹-\n赞了你的评论\n11-01' },
  { text: '点击加载更多' },
]

function makeFixture({ firstUrl = 'https://www.douyin.com/jingxuan', panelOpen = false, escapeCloses = true } = {}) {
  const clock = makeClock()
  let open = panelOpen
  let url = firstUrl
  let badgeCount = 0
  const rows = ROWS.slice()
  const clicks = []
  const presses = []
  const s = setup({
    clock,
    rawConfig: {
      notifyWatchBadgeSelectors: [ENTRY],
      dmOwnerAliases: ['饲养员', '草荧'],
      dmOwnerFile: join('/tmp', 'does-not-exist-dm-owner.txt'),
      notifyWatchBadgeHtmlFallback: false,
    },
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: url }),
      count: (p) => ({
        ok: true,
        cmd: 'count',
        result: p.selector === PANEL ? (open ? 1 : 0) : p.selector === ENTRY ? 1 : 0,
      }),
      html: (p) => ({
        ok: true,
        cmd: 'html',
        result: p.selector === ENTRY ? `<span class="badge">${badgeCount}</span>` : '',
      }),
      text: (p) => ({
        ok: true,
        cmd: 'text',
        result: p.selector === ENTRY ? '通知' : p.selector === '[data-e2e="cur-filter"]' ? '全部消息' : '',
      }),
      list: (p) => {
        if (p.selector === ITEM) {
          return { ok: true, cmd: 'list', result: open ? rows : [] }
        }
        if (String(p.selector).startsWith(ENTRY)) {
          return { ok: true, cmd: 'list', result: [{ text: String(badgeCount), class: 'u-badge' }] }
        }
        return { ok: true, cmd: 'list', result: [] }
      },
      click: (p) => {
        clicks.push(p)
        if (p.selector === ENTRY || String(p.selector).includes('通知')) open = !open
        if (p.selector === CLOSE) open = false
        return { ok: true, cmd: 'click', result: true }
      },
      press: (p) => {
        presses.push(p)
        if (p.key === 'Escape' && escapeCloses) open = false
        return { ok: true, cmd: 'press', result: true }
      },
      jsWatch: (p) => ({
        ok: true,
        cmd: 'jsWatch',
        result: { action: p.action, installed: true, seq: 2, cursor: 1, pending: 1, events: [{ kind: 'net', url: '/notice', body: '{}' }] },
      }),
    },
  })
  return {
    s,
    get open() { return open },
    setOpen: (v) => { open = v },
    setBadge: (n) => { badgeCount = n },
    clock,
    // 新通知在"3 分钟后"到达（est 差 180s > 判重窗口 120s），避免同一时钟下被当成同一条
    addRow: (text) => { clock.advance(180000); rows.splice(Math.max(0, rows.length - 1), 0, { text }) },
    clicks,
    presses,
    setUrl: (u) => { url = u },
  }
}

test('notifySnapshotForWatch：allowOpen=false 不点任何东西；面板已开只读', async () => {
  const f = makeFixture({ panelOpen: false })
  const closed = await f.s.runtime.rawService.notifySnapshotForWatch({ allowOpen: false, limit: 20 })
  assert.equal(closed.ok, true)
  assert.equal(closed.open, false)
  assert.equal(f.clicks.length, 0)
  assert.equal(f.presses.length, 0)

  f.setOpen(true) // 外部已把面板打开
  const opened = await f.s.runtime.rawService.notifySnapshotForWatch({ allowOpen: false, limit: 20 })
  assert.equal(opened.ok, true)
  assert.equal(opened.open, true)
  assert.equal(opened.opened, false)
  assert.equal(opened.items.length, 3)
  assert.equal(opened.items[0].isOwner, true)
  assert.equal(opened.items[0].replyable, true)
  // 被动读不关面板、不点条目
  assert.equal(f.clicks.length, 0)
  cleanupDir(f.s.dir)
})

test('notifySnapshotForWatch：allowOpen=true 点一次入口、读完 Escape 关闭；不点搜索框/条目', async () => {
  const f = makeFixture({ panelOpen: false })
  const r = await f.s.runtime.rawService.notifySnapshotForWatch({ allowOpen: true, limit: 20 })
  assert.equal(r.ok, true)
  assert.equal(r.open, true)
  assert.equal(r.opened, true)
  assert.equal(r.items.length, 3)
  assert.ok(f.clicks.some((c) => c.selector === ENTRY))
  assert.equal(f.clicks.filter((c) => c.selector === CLOSE).length, 0)
  assert.equal(f.clicks.filter((c) => c.selector === ITEM).length, 0)
  assert.ok(f.presses.some((p) => p.key === 'Escape'))
  assert.equal(f.open, false)
  cleanupDir(f.s.dir)
})

test('notifySnapshotForWatch：Escape 不关面板时用通知入口切换关闭，仍不点搜索框', async () => {
  const f = makeFixture({ escapeCloses: false })
  const r = await f.s.runtime.rawService.notifySnapshotForWatch({ allowOpen: true, limit: 20 })
  assert.equal(r.ok, true)
  assert.equal(r.open, true)
  assert.equal(f.open, false)
  assert.ok(f.clicks.filter((c) => c.selector === ENTRY).length >= 2) // 开 + 关
  assert.equal(f.clicks.filter((c) => c.selector === CLOSE).length, 0)
  assert.equal(f.clicks.filter((c) => c.selector === ITEM).length, 0)
  cleanupDir(f.s.dir)
})

test('notifySnapshotForWatch：视频页/私信页/非抖音页 → E_PAGE_UNSAFE，不导航不开面板', async () => {
  for (const url of [
    'https://www.douyin.com/video/7707903837473934632',
    'https://www.douyin.com/jingxuan?modal_id=7707903837473934632',
    'https://www.douyin.com/chat',
    'https://example.com/',
  ]) {
    const f = makeFixture({ firstUrl: url })
    const r = await f.s.runtime.rawService.notifySnapshotForWatch({ allowOpen: true, limit: 20 })
    assert.equal(r.ok, false, url)
    assert.equal(r.code, 'E_PAGE_UNSAFE', url)
    assert.equal(f.clicks.length, 0, url)
    cleanupDir(f.s.dir)
  }
})

test('notifyBadgeProbe：只读角标，不开面板/不点击；返回 count/dot/signature', async () => {
  const f = makeFixture()
  f.setBadge(3)
  const r = await f.s.runtime.rawService.notifyBadgeProbe({ selectors: [ENTRY] })
  assert.equal(r.ok, true)
  assert.equal(r.available, true)
  assert.equal(r.count, 3)
  assert.equal(r.mode, 'count')
  assert.match(r.signature, /^count:3\|dot:[01]\|html:/)
  assert.equal(f.clicks.length, 0)
  cleanupDir(f.s.dir)
})

test('notifySourceStart/Take/Stop：调用桥的 jsWatch start/take/stop', async () => {
  const f = makeFixture()
  const start = await f.s.runtime.rawService.notifySourceStart()
  assert.equal(start.ok, true)
  const take = await f.s.runtime.rawService.notifySourceTake({ limit: 5 })
  assert.equal(take.ok, true)
  assert.equal(Array.isArray(take.events), true)
  const stop = await f.s.runtime.rawService.notifySourceStop()
  assert.equal(stop.ok, true)
  const cmds = f.s.transport.calls.filter((c) => c.cmd === 'jsWatch').map((c) => c.action)
  assert.deepEqual(cmds, ['start', 'take', 'stop'])
  assert.equal(f.clicks.length, 0)
  cleanupDir(f.s.dir)
})

test('runtime service：notifyWatchStatus / notifyWatchSubscribe / notifyWatch 接线', async () => {
  const f = makeFixture()
  const st = f.s.runtime.service.notifyWatchStatus()
  assert.equal(typeof st, 'object')
  assert.equal(st.intervalMs, 3000)
  assert.equal(st.enabled, false)
  const unsub = f.s.runtime.service.notifyWatchSubscribe(() => {})
  assert.equal(typeof unsub, 'function')
  unsub()
  const status = await f.s.runtime.service.notifyWatch({ action: 'status' })
  assert.equal(status.ok, true)
  assert.equal(status.intervalMs, 3000)
  assert.equal(Array.isArray(status.events), true)
  cleanupDir(f.s.dir)
})

test('runtime notifyWatch：baseline 后 badge 变化才开面板并产出新事件（含 replyable）', async () => {
  const f = makeFixture()
  const first = await f.s.runtime.service.notifyWatch({ action: 'poll' })
  assert.equal(first.ok, true)
  assert.equal(first.tick.baseline, true)
  assert.equal(first.events.length, 0)
  assert.equal(f.s.runtime.service.notifyWatchStatus().primed, true)

  f.addRow('叹-\n赞了你的评论\n刚刚')
  f.setBadge(1)
  const second = await f.s.runtime.service.notifyWatch({ action: 'poll' })
  assert.equal(second.ok, true)
  assert.equal(second.count, 1)
  assert.equal(second.events[0].actor, '叹-')
  assert.equal(second.events[0].type, 'like_comment')
  assert.equal(second.events[0].replyable, false)
  assert.equal(second.events[0].isOwner, false)
  assert.ok(f.clicks.some((c) => c.selector === ENTRY))
  assert.equal(f.clicks.filter((c) => c.selector === CLOSE).length, 0)
  assert.equal(f.clicks.filter((c) => c.selector === ITEM).length, 0)
  cleanupDir(f.s.dir)
})

test('notifySourceStart：私信页不启动 jsWatch（避免观察 DM 流量）', async () => {
  const f = makeFixture({ firstUrl: 'https://www.douyin.com/chat' })
  const r = await f.s.runtime.rawService.notifySourceStart()
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_PAGE_UNSAFE')
  assert.equal(f.s.transport.calls.filter((c) => c.cmd === 'jsWatch').length, 0)
  cleanupDir(f.s.dir)
})
