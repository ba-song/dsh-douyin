import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG, cleanupDir, detailOf, makeClock, makeFakeMemory, makeMp4, makeTmpDir, setup } from './helpers.mjs'
import { detectToggleActive, dmConversationId, parseModalId, parseNotifyItems, parseVideoIdFromUrl, parseVideoItems, pickNotifyTarget, TOGGLE_STATE_ATTR } from '../lib/service.js'

test('parseModalId：从 URL 查询/哈希中取 6–20 位 modal_id', () => {
  assert.equal(parseModalId('https://www.douyin.com/search/x?modal_id=123456789&type=general'), '123456789')
  assert.equal(parseModalId('https://www.douyin.com/search/x#foo=1&modal_id=123456789'), '123456789')
  assert.equal(parseModalId('https://www.douyin.com/search/x?modal_id=abc'), '')
  assert.equal(parseModalId('https://www.douyin.com/search/x'), '')
  assert.equal(parseModalId(null), '')
})

test('parseVideoItems：推荐页 data-e2e-vid 与精选页 href 都能解析', () => {
  assert.deepEqual(
    parseVideoItems([
      { href: '//www.douyin.com/video/111111111?x=1', text: '精选卡' },
      { 'data-e2e-vid': '222222222', text: '推荐卡' },
      { 'data-e2e-vid': '111111111', text: '重复' },
      { 'data-e2e-vid': 'bad', text: '非法' },
    ]),
    [
      { videoId: '111111111', url: 'https://www.douyin.com/video/111111111', text: '精选卡' },
      { videoId: '222222222', url: 'https://www.douyin.com/video/222222222', text: '推荐卡' },
    ],
  )
})

function videoRow(id, text = `video-${id}`) {
  return { href: `//www.douyin.com/video/${id}?previous_page=app_code_link`, text }
}

test('status：ping + url/title，返回约定字段；只读不占配额', async () => {
  const s = setup()
  const r = await s.runtime.service.status()
  assert.equal(r.ok, true)
  assert.equal(r.proto, '1.0')
  assert.equal(r.browser, true)
  assert.equal(r.pages, 1)
  assert.equal(r.url, 'https://www.douyin.com/')
  assert.equal(r.title, '抖音-记录美好生活')
  assert.equal(typeof r.latencyMs, 'number')
  assert.equal(r.blockAssets, false)
  assert.deepEqual(
    s.transport.calls.map((c) => c.cmd),
    ['ping', 'url', 'title'],
  )
  assert.equal(s.runtime.service.usage().dailyUsed, 0)
  cleanupDir(s.dir)
})

test('feed：不在首页先 open 首页，再 list；解析/去重 href，limit 生效', async () => {
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/999999999' }),
      list: (p) => ({
        ok: true,
        cmd: 'list',
        result: [videoRow('111111111', '第一条'), videoRow('222222222', '第二条'), videoRow('111111111', '重复')].slice(0, p.limit),
      }),
    },
  })
  const r = await s.runtime.service.feed({ limit: 3 })
  assert.equal(r.ok, true)
  assert.equal(r.count, 2)
  assert.deepEqual(
    r.items.map((x) => x.videoId),
    ['111111111', '222222222'],
  )
  assert.equal(r.items[0].url, 'https://www.douyin.com/video/111111111')
  assert.equal(r.items[0].text, '第一条')

  const cmds = s.transport.calls.map((c) => c.cmd)
  assert.deepEqual(cmds, ['url', 'open', 'list'])
  const openCall = s.transport.calls.find((c) => c.cmd === 'open')
  assert.equal(openCall.url, 'https://www.douyin.com/?recommend=1&from_nav=1')
  const listCall = s.transport.calls.find((c) => c.cmd === 'list')
  assert.equal(listCall.selector, 'div.waterfall-videoCardContainer, [data-e2e="feed-item"] [data-e2e-vid]')
  assert.deepEqual(listCall.attrs, ['href', 'data-e2e-vid'])
  assert.equal(listCall.limit, 3)
  assert.equal(listCall.textLen, 60)
  cleanupDir(s.dir)
})

test('feed：浏览免费，perSession 不再限制取卡、也不计数', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => videoRow(`1000000${i}`))
  const s = setup({
    rawConfig: { perSession: 3 },
    handlers: { list: () => ({ ok: true, cmd: 'list', result: rows }) },
  })
  const r = await s.runtime.service.feed({ limit: 8 })
  assert.equal(r.ok, true)
  assert.equal(r.count, 8)
  assert.equal(s.transport.calls.find((c) => c.cmd === 'list').limit, 8)
  assert.equal(s.runtime.service.usage().sessionUsed, 0)
  assert.equal(s.runtime.service.usage().dailyUsed, 0)
  cleanupDir(s.dir)
})

test('feed：0 条且页面是验证码 → E_CHALLENGE；普通 0 条 → E_SELECTOR_MISS', async () => {
  {
    const s = setup({ handlers: { title: () => ({ ok: true, cmd: 'title', result: '验证码中间页' }) } })
    const r = await s.runtime.service.feed({})
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E_CHALLENGE')
    cleanupDir(s.dir)
  }
  {
    const s = setup()
    const r = await s.runtime.service.feed({})
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E_SELECTOR_MISS')
    cleanupDir(s.dir)
  }
})

test('feed scroll=true：下滚 1 次、等 800ms、按 videoId 去重直到 limit', async () => {
  let listCall = 0
  const batches = [
    [videoRow('111111111', '第一条'), videoRow('222222222', '第二条')],
    [videoRow('222222222', '重复'), videoRow('333333333', '第三条'), videoRow('444444444', '第四条')],
  ]
  const s = setup({
    handlers: {
      list: () => ({ ok: true, cmd: 'list', result: batches[Math.min(listCall++, 1)] }),
    },
  })
  const r = await s.runtime.service.feed({ limit: 4, scroll: true })
  assert.equal(r.ok, true)
  assert.equal(r.count, 4)
  assert.deepEqual(
    r.items.map((i) => i.videoId),
    ['111111111', '222222222', '333333333', '444444444'],
  )
  const scrollCalls = s.transport.calls.filter((c) => c.cmd === 'scroll')
  assert.equal(scrollCalls.length, 1)
  assert.equal(scrollCalls[0].dy, 700)
  assert.deepEqual(s.sleep.calls, [800])
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'list').length, 2)
  assert.equal(s.runtime.service.usage().dailyUsed, 0)
  cleanupDir(s.dir)
})

test('feed scroll=true：最多下滚 3 次，重复卡片不会重复计数', async () => {
  const s = setup({
    handlers: {
      list: () => ({ ok: true, cmd: 'list', result: [videoRow('111111111', '只有一条')] }),
    },
  })
  const r = await s.runtime.service.feed({ limit: 8, scroll: true })
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'scroll').length, 3)
  assert.deepEqual(s.sleep.calls, [800, 800, 800])
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'list').length, 4)
  assert.equal(s.runtime.service.usage().dailyUsed, 0)
  cleanupDir(s.dir)
})

test('feed scroll=true：首批为空也会下滚，滚出卡片后正常返回', async () => {
  let call = 0
  const s = setup({
    handlers: {
      list: () => ({
        ok: true,
        cmd: 'list',
        result: call++ === 0 ? [] : [videoRow('111111111', '滚出来的'), videoRow('222222222', '第二条')],
      }),
    },
  })
  const r = await s.runtime.service.feed({ limit: 2, scroll: true })
  assert.equal(r.ok, true)
  assert.equal(r.count, 2)
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'scroll').length, 1)
  cleanupDir(s.dir)
})

test('feed scroll 失败：已有卡片则返回部分结果，不整体失败', async () => {
  const s = setup({
    handlers: {
      scroll: () => ({ ok: false, cmd: 'scroll', error: 'scroll exploded' }),
      list: () => ({ ok: true, cmd: 'list', result: [videoRow('111111111'), videoRow('222222222')] }),
    },
  })
  const r = await s.runtime.service.feed({ limit: 8, scroll: true })
  assert.equal(r.ok, true)
  assert.equal(r.count, 2)
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'scroll').length, 1)
  assert.equal(s.runtime.service.usage().dailyUsed, 0)
  cleanupDir(s.dir)
})

test('search：等可见卡片后逐个 click 取 modal_id、Escape 关闭', async () => {
  const rows = [{ text: '结果A' }, { text: '结果B' }]
  let modal = ''
  const s = setup({
    handlers: {
      count: (p) => ({
        ok: true,
        cmd: 'count',
        result: p.selector === 'div.search-result-card' ? 2 : 0,
      }),
      list: (p) => ({ ok: true, cmd: 'list', result: rows.slice(0, p.limit) }),
      click: (p) => {
        modal = `70000000000000000${p.nth + 1}`
        return { ok: true, cmd: 'click', result: true }
      },
      url: () => ({
        ok: true,
        cmd: 'url',
        result: `https://www.douyin.com/search/%E7%8C%AB?modal_id=${modal}`,
      }),
      press: () => {
        modal = ''
        return { ok: true, cmd: 'press', result: true }
      },
    },
  })
  const r = await s.runtime.service.search({ query: '猫 猫', limit: 2 })
  assert.equal(r.ok, true)
  assert.equal(r.query, '猫 猫')
  assert.equal(r.count, 2)
  assert.deepEqual(r.items, [
    {
      videoId: '700000000000000001',
      url: 'https://www.douyin.com/video/700000000000000001',
      text: '结果A',
    },
    {
      videoId: '700000000000000002',
      url: 'https://www.douyin.com/video/700000000000000002',
      text: '结果B',
    },
  ])

  const openCall = s.transport.calls.find((c) => c.cmd === 'open')
  assert.equal(openCall.url, `https://www.douyin.com/search/${encodeURIComponent('猫 猫')}`)
  assert.ok(openCall.url.includes('%E7%8C%AB%20%E7%8C%AB'))
  const listCall = s.transport.calls.find((c) => c.cmd === 'list')
  assert.equal(listCall.selector, 'div.search-result-card')
  assert.deepEqual(listCall.attrs, [])
  const clicks = s.transport.calls.filter((c) => c.cmd === 'click')
  assert.deepEqual(
    clicks.map((c) => c.nth),
    [0, 1],
  )
  assert.ok(clicks.every((c) => c.selector === 'div.search-result-card'))
  const presses = s.transport.calls.filter((c) => c.cmd === 'press')
  assert.equal(presses.length, 2)
  assert.ok(presses.every((c) => c.key === 'Escape'))
  cleanupDir(s.dir)
})

test('search：可见卡片最多重试 3 次，每次等 1s', async () => {
  let countN = 0
  const s = setup({
    handlers: {
      count: () => ({ ok: true, cmd: 'count', result: [0, 0, 2][countN++] ?? 2 }),
      list: () => ({ ok: true, cmd: 'list', result: [{ text: 'ok' }] }),
      click: () => ({ ok: true, cmd: 'click', result: true }),
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/search/x?modal_id=123456789' }),
    },
  })
  const r = await s.runtime.service.search({ query: 'x', limit: 1 })
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  assert.deepEqual(s.sleep.calls, [1500, 1500])
  assert.equal(countN, 3)
  cleanupDir(s.dir)
})

test('search：无可见卡片（整体重试关）→ E_SELECTOR_MISS', async () => {
  const s = setup({
    rawConfig: { searchRetries: 0 },
    handlers: { count: () => ({ ok: true, cmd: 'count', result: 0 }) },
  })
  const r = await s.runtime.service.search({ query: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_SELECTOR_MISS')
  assert.deepEqual(s.sleep.calls, Array(12).fill(1500))
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'count').length, 13)
  assert.ok(!s.transport.calls.some((c) => c.cmd === 'click'))
  cleanupDir(s.dir)
})

test('search：标题含验证码 → E_CHALLENGE（open 返回标题或 title 命令均可）', async () => {
  {
    const s = setup({
      handlers: { open: (p) => ({ ok: true, cmd: 'open', result: { url: p.url, status: 200, title: '验证码中间页' } }) },
    })
    const r = await s.runtime.service.search({ query: 'x' })
    assert.equal(r.code, 'E_CHALLENGE')
    assert.ok(!s.transport.calls.some((c) => c.cmd === 'count'))
    cleanupDir(s.dir)
  }
  {
    const s = setup({
      handlers: { title: () => ({ ok: true, cmd: 'title', result: '验证码中间页' }) },
    })
    const r = await s.runtime.service.search({ query: 'x' })
    assert.equal(r.code, 'E_CHALLENGE')
    cleanupDir(s.dir)
  }
})

test('search：click 失败跳过，不影响其他卡片', async () => {
  const rows = [{ text: 'A' }, { text: 'B' }, { text: 'C' }]
  let modal = ''
  const s = setup({
    handlers: {
      count: () => ({ ok: true, cmd: 'count', result: 3 }),
      list: () => ({ ok: true, cmd: 'list', result: rows }),
      click: (p) => {
        if (p.nth === 1) {
          const e = new Error('click timeout')
          e.code = 'E_TIMEOUT'
          throw e
        }
        modal = `80000000000000000${p.nth + 1}`
        return { ok: true, cmd: 'click', result: true }
      },
      url: () => ({ ok: true, cmd: 'url', result: `https://www.douyin.com/search/x?modal_id=${modal}` }),
      press: () => {
        modal = ''
        return { ok: true, cmd: 'press', result: true }
      },
    },
  })
  const r = await s.runtime.service.search({ query: 'x', limit: 3 })
  assert.equal(r.ok, true)
  assert.equal(r.count, 2)
  assert.deepEqual(
    r.items.map((i) => i.videoId),
    ['800000000000000001', '800000000000000003'],
  )
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'click').length, 3)
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'press').length, 2)
  cleanupDir(s.dir)
})

test('search：拿不到 modal_id 的卡片跳过，但仍按 Escape 关闭', async () => {
  const rows = [{ text: 'A' }, { text: 'B' }, { text: 'C' }]
  let lastNth = -1
  const s = setup({
    handlers: {
      count: () => ({ ok: true, cmd: 'count', result: 3 }),
      list: () => ({ ok: true, cmd: 'list', result: rows }),
      click: (p) => {
        lastNth = p.nth
        return { ok: true, cmd: 'click', result: true }
      },
      url: () => ({
        ok: true,
        cmd: 'url',
        result:
          lastNth === 1
            ? 'https://www.douyin.com/search/x'
            : `https://www.douyin.com/search/x?modal_id=90000000000000000${lastNth + 1}`,
      }),
      press: () => ({ ok: true, cmd: 'press', result: true }),
    },
  })
  const r = await s.runtime.service.search({ query: 'x', limit: 3 })
  assert.equal(r.ok, true)
  assert.equal(r.count, 2)
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'press').length, 3)
  cleanupDir(s.dir)
})

test('search：全部拿不到 modal_id → E_SELECTOR_MISS，不猜（整体重试关）', async () => {
  const s = setup({
    rawConfig: { searchRetries: 0 },
    handlers: {
      count: () => ({ ok: true, cmd: 'count', result: 2 }),
      list: () => ({ ok: true, cmd: 'list', result: [{ text: 'A' }, { text: 'B' }] }),
      click: () => ({ ok: true, cmd: 'click', result: true }),
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/search/x' }),
    },
  })
  const r = await s.runtime.service.search({ query: 'x', limit: 2 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_SELECTOR_MISS')
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'click').length, 2)
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'press').length, 2)
  cleanupDir(s.dir)
})

test('search：失败一次后重试成功（默认 searchRetries=1）', async () => {
  let openN = 0
  let listN = 0
  const s = setup({
    handlers: {
      open: (p) => {
        openN += 1
        if (openN === 1) return { ok: false, cmd: 'open', error: 'timeout waiting for navigation' }
        return { ok: true, cmd: 'open', result: { url: p.url, status: 200, title: '抖音' } }
      },
      count: () => ({ ok: true, cmd: 'count', result: 1 }),
      list: () => {
        listN += 1
        return { ok: true, cmd: 'list', result: [{ text: '重试成功' }] }
      },
      click: () => ({ ok: true, cmd: 'click', result: true }),
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/search/x?modal_id=123456789' }),
    },
  })
  const r = await s.runtime.service.search({ query: 'x', limit: 1 })
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  assert.equal(openN, 2)
  assert.equal(listN, 1)
  assert.deepEqual(s.sleep.calls, [2000]) // 只有重试前的 2s；首次 open 失败，未进入卡片等待
  const opens = s.transport.calls.filter((c) => c.cmd === 'open')
  assert.equal(opens.length, 2)
  assert.equal(opens[0].url, opens[1].url)
  cleanupDir(s.dir)
})

test('search：最多只重试一次，重试仍失败返回原错误', async () => {
  let openN = 0
  const s = setup({
    handlers: {
      open: () => {
        openN += 1
        return openN === 1
          ? { ok: false, cmd: 'open', error: 'timeout first' }
          : { ok: false, cmd: 'open', error: 'captcha required' }
      },
    },
  })
  const r = await s.runtime.service.search({ query: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_OPEN_TIMEOUT') // 第一次的错误
  assert.match(r.message, /timeout first/)
  assert.equal(openN, 2)
  assert.deepEqual(s.sleep.calls, [2000])
  cleanupDir(s.dir)
})

test('search：不可重试错误不重试（E_CHALLENGE / E_LOGIN_REQUIRED）', async () => {
  for (const [error, code] of [
    ['captcha required', 'E_CHALLENGE'],
    ['login required', 'E_LOGIN_REQUIRED'],
  ]) {
    const s = setup({ handlers: { open: () => ({ ok: false, cmd: 'open', error }) } })
    const r = await s.runtime.service.search({ query: 'x' })
    assert.equal(r.code, code)
    assert.equal(s.transport.calls.filter((c) => c.cmd === 'open').length, 1)
    assert.deepEqual(s.sleep.calls, [])
    cleanupDir(s.dir)
  }
})

test('search：count>0 但 list 无文本时继续等，不把 spinner/骨架当卡片', async () => {
  let listN = 0
  const s = setup({
    handlers: {
      count: () => ({ ok: true, cmd: 'count', result: 1 }),
      list: () => {
        listN += 1
        return {
          ok: true,
          cmd: 'list',
          result: listN === 1 ? [{ text: '   ' }] : [{ text: '真卡片' }],
        }
      },
      click: () => ({ ok: true, cmd: 'click', result: true }),
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/search/x?modal_id=123456789' }),
    },
  })
  const r = await s.runtime.service.search({ query: 'x', limit: 1 })
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  assert.equal(listN, 2)
  assert.deepEqual(s.sleep.calls, [1500])
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'count').length, 2)
  cleanupDir(s.dir)
})

test('search：不可重试的时段拒绝不会触发重试', async () => {
  const clock = makeClock('2026-11-06T10:00:00+08:00')
  const s = setup({ clock })
  const r = await s.runtime.service.search({ query: 'x' })
  assert.equal(r.code, 'E_TIME_WINDOW')
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'open').length, 0)
  assert.deepEqual(s.sleep.calls, [])
  cleanupDir(s.dir)
})

test('参数校验：query 空/41 字/控制字符、limit 越界 → E_BAD_ARG', async () => {
  const s = setup()
  const cases = [
    () => s.runtime.service.search({ query: '' }),
    () => s.runtime.service.search({ query: '   ' }),
    () => s.runtime.service.search({ query: 'a'.repeat(41) }),
    () => s.runtime.service.search({ query: 'a\nb' }),
    () => s.runtime.service.search({ query: 'ok', limit: 9 }),
    () => s.runtime.service.search({ query: 'ok', type: 'bogus' }),
    () => s.runtime.service.feed({ limit: 0 }),
    () => s.runtime.service.feed({ limit: 9 }),
    () => s.runtime.service.comments({ videoId: '12345' }),
    () => s.runtime.service.comments({ videoId: '123456', limit: 51 }),
  ]
  for (const run of cases) {
    const r = await run()
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E_BAD_ARG')
  }
  assert.equal(s.transport.calls.length, 0)
  cleanupDir(s.dir)
})

test('open：videoId/url 白名单；非法域名/协议/路径 → E_BAD_URL；冲突 → E_BAD_ARG', async () => {
  const s = setup({
    handlers: {
      open: (p) => ({ ok: true, cmd: 'open', result: { url: p.url, status: 200, title: '视频标题' } }),
    },
  })
  const byId = await s.runtime.service.open({ videoId: '123456789' })
  assert.equal(byId.ok, true)
  assert.equal(byId.videoId, '123456789')
  assert.equal(byId.url, 'https://www.douyin.com/video/123456789')
  assert.equal(byId.status, 200)
  assert.equal(byId.title, '视频标题')

  const byUrl = await s.runtime.service.open({ url: 'https://m.douyin.com/video/123456789/?x=1' })
  assert.equal(byUrl.ok, true)
  assert.equal(byUrl.videoId, '123456789')

  const bad = [
    { url: 'https://www.douyin.com.evil.com/video/123456789' },
    { url: 'http://www.douyin.com/video/123456789' },
    { url: 'https://www.douyin.com/video/abc' },
    { url: 'https://www.douyin.com/note/123456789' },
  ]
  for (const args of bad) {
    const r = await s.runtime.service.open(args)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E_BAD_URL')
  }
  const badId = await s.runtime.service.open({ videoId: 'abc' })
  assert.equal(badId.code, 'E_BAD_ARG')
  const conflict = await s.runtime.service.open({
    videoId: '111111111',
    url: 'https://www.douyin.com/video/222222222',
  })
  assert.equal(conflict.code, 'E_BAD_ARG')
  cleanupDir(s.dir)
})

test('comments：只尝试白名单选择器，命中后返回文本；命中就不点展开', async () => {
  const s = setup({
    handlers: {
      count: (p) => ({
        ok: true,
        cmd: 'count',
        result: p.selector === 'button.comment-reply-expand-btn' || p.selector === '[data-e2e="comment-item"]' ? 0 : 2,
      }),
      list: (p) => ({
        ok: true,
        cmd: 'list',
        result: p.selector === '[data-e2e="comment-item"]' ? [] : [{ text: ' 好看 ' }, { text: '第二条' }],
      }),
    },
  })
  const r = await s.runtime.service.comments({ videoId: '123456789', limit: 2 })
  assert.equal(r.ok, true)
  assert.equal(r.videoId, '123456789')
  assert.equal(r.count, 2)
  assert.equal(r.selector, 'div.comment-item')
  assert.deepEqual(r.items, [
    { author: null, text: '好看', likes: null, time: null, replyCount: 0, replies: [] },
    { author: null, text: '第二条', likes: null, time: null, replyCount: 0, replies: [] },
  ])
  const cmds = s.transport.calls.map((c) => c.cmd)
  assert.ok(!cmds.includes('click'))
  assert.equal(cmds[0], 'open')
  cleanupDir(s.dir)
})

test('comments：一条都抓不到时，点一次评论展开按钮', async () => {
  const s = setup({
    handlers: {
      count: () => ({ ok: true, cmd: 'count', result: 0 }),
      list: () => ({ ok: true, cmd: 'list', result: [] }),
      click: () => ({ ok: true, cmd: 'click', result: true }),
    },
  })
  const r = await s.runtime.service.comments({ videoId: '123456789' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_SELECTOR_MISS')
  const clicks = s.transport.calls.filter((c) => c.cmd === 'click')
  assert.equal(clicks.length, 1)
  assert.equal(clicks[0].selector, '[data-e2e="feed-comment-icon"]')
  cleanupDir(s.dir)
})

test('comments：所有选择器未命中 → E_SELECTOR_MISS，命令本身不计数', async () => {
  const s = setup()
  const r = await s.runtime.service.comments({ videoId: '123456789' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_SELECTOR_MISS')
  assert.match(r.message, /展开/)
  assert.equal(s.runtime.service.usage().dailyUsed, 0)
  cleanupDir(s.dir)
})

test('screenshot：远程 PNG 落盘，返回 {file,bytes}；不占配额', async () => {
  const s = setup()
  const r = await s.runtime.service.screenshot()
  assert.equal(r.ok, true)
  assert.equal(r.bytes, PNG.length)
  assert.ok(r.file.startsWith(join(s.dir, 'shots')))
  assert.ok(existsSync(r.file))
  assert.equal(statSync(r.file).size, PNG.length)
  assert.deepEqual(readFileSync(r.file), PNG)
  assert.equal(s.transport.readFileCalls[0].path, '/persistent/cdp/shots/shot-1.png')
  assert.equal(s.runtime.service.usage().dailyUsed, 0)
  cleanupDir(s.dir)
})

test('screenshot 失败分支：路径非法/非 PNG/超限/传输不支持 → E_REMOTE_IO', async () => {
  {
    const s = setup({
      handlers: { screenshot: () => ({ ok: true, cmd: 'screenshot', result: { file: '/tmp/evil.png' } }) },
    })
    const r = await s.runtime.service.screenshot()
    assert.equal(r.code, 'E_REMOTE_IO')
    cleanupDir(s.dir)
  }
  {
    const s = setup()
    s.transport.readFileResult = Buffer.from('not a png')
    const r = await s.runtime.service.screenshot()
    assert.equal(r.code, 'E_REMOTE_IO')
    cleanupDir(s.dir)
  }
  {
    const s = setup({ rawConfig: { maxScreenshotBytes: 64 * 1024 } })
    s.transport.readFileResult = Buffer.alloc(70 * 1024, 1)
    const r = await s.runtime.service.screenshot()
    assert.equal(r.code, 'E_REMOTE_IO')
    cleanupDir(s.dir)
  }
  {
    const s = setup()
    s.transport.readFile = undefined
    const r = await s.runtime.service.screenshot()
    assert.equal(r.code, 'E_REMOTE_IO')
    cleanupDir(s.dir)
  }
})

test('远程错误映射：open 超时 → E_OPEN_TIMEOUT；验证码 → E_CHALLENGE；登录 → E_LOGIN_REQUIRED', async () => {
  {
    const s = setup({
      handlers: {
        open: () => ({ ok: false, cmd: 'open', error: 'Timeout 120000ms exceeded waiting for navigation' }),
      },
    })
    const r = await s.runtime.service.open({ videoId: '123456789' })
    assert.equal(r.code, 'E_OPEN_TIMEOUT')
    cleanupDir(s.dir)
  }
  {
    const s = setup({
      handlers: { ping: () => ({ ok: false, cmd: 'ping', error: 'captcha required' }) },
    })
    const r = await s.runtime.service.status()
    assert.equal(r.code, 'E_CHALLENGE')
    cleanupDir(s.dir)
  }
  {
    const s = setup({
      handlers: { ping: () => ({ ok: false, cmd: 'ping', error: 'login required' }) },
    })
    const r = await s.runtime.service.status()
    assert.equal(r.code, 'E_LOGIN_REQUIRED')
    cleanupDir(s.dir)
  }
})

test('可用时段：周五 10:00 浏览被拒 E_TIME_WINDOW，status 仍可用', async () => {
  const clock = makeClock('2026-11-06T10:00:00+08:00')
  const s = setup({ clock })
  const feed = await s.runtime.service.feed({})
  assert.equal(feed.ok, false)
  assert.equal(feed.code, 'E_TIME_WINDOW')
  assert.ok(feed.retryAfterMs >= 60 * 60 * 1000)

  const status = await s.runtime.service.status()
  assert.equal(status.ok, true)
  cleanupDir(s.dir)
})

test('最小间隔：5s 内第二次调用 E_MIN_INTERVAL，之后恢复', async () => {
  const clock = makeClock('2026-11-06T18:30:00+08:00')
  const s = setup({ clock, rawConfig: { minIntervalMs: 5000 } })
  assert.equal((await s.runtime.service.status()).ok, true)
  const second = await s.runtime.service.status()
  assert.equal(second.code, 'E_MIN_INTERVAL')
  assert.equal(second.retryAfterMs, 5000)
  clock.advance(5000)
  assert.equal((await s.runtime.service.status()).ok, true)
  cleanupDir(s.dir)
})

test('并发调用严格串行（同一时刻只有一条在飞）', async () => {
  const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms))
  const s = setup({
    handlers: {
      ping: async () => {
        await delay(10)
        return { ok: true, cmd: 'ping', result: { proto: '1.0', browser: true, pages: 1 } }
      },
      title: async () => {
        await delay(10)
        return { ok: true, cmd: 'title', result: '抖音' }
      },
      url: async () => {
        await delay(10)
        return { ok: true, cmd: 'url', result: 'https://www.douyin.com/' }
      },
    },
    rawConfig: { minIntervalMs: 0, maxQueue: 4 },
  })
  const [a, b] = await Promise.all([s.runtime.service.status(), s.runtime.service.status()])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(s.transport.maxActive, 1)
  cleanupDir(s.dir)
})

test('队列满：E_BUSY，不无限堆积', async () => {
  const s = setup({
    handlers: {
      ping: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, cmd: 'ping', result: { proto: '1.0', browser: true, pages: 1 } }), 30)),
    },
    rawConfig: { minIntervalMs: 0, maxQueue: 1 },
  })
  const first = s.runtime.service.status()
  const second = await s.runtime.service.status()
  assert.equal(second.ok, false)
  assert.equal(second.code, 'E_BUSY')
  await first
  cleanupDir(s.dir)
})

test('enabled=false：所有工具 E_DISABLED（仍注册，便于排障）', async () => {
  const s = setup({ rawConfig: { enabled: false } })
  const cases = [
    ['status', {}],
    ['feed', {}],
    ['screenshot', {}],
    ['download', { videoId: '123456789' }],
  ]
  for (const [name, args] of cases) {
    const r = await s.runtime.service[name](args)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E_DISABLED')
  }
  assert.equal(s.registry.size, 19)
  cleanupDir(s.dir)
})

test('工具层：owner 门禁、detail JSON、错误不抛', async () => {
  const s = setup()
  const def = s.registry.get('dy_douyin_status')
  const asSub = await def.execute({}, { agent: { session: { id: 'sub', header: { cwd: '/sdcard/DSHA/生活/数据/home', delegationDepth: 1 } } } })
  assert.equal(asSub.ok, false)
  assert.equal(detailOf(asSub).code, 'E_PERMISSION')

  const asOwner = await def.execute({}, { agent: { session: { id: 'home', header: { cwd: '/sdcard/DSHA/生活/数据/home' } } } })
  assert.equal(asOwner.ok, true)
  assert.equal(detailOf(asOwner).proto, '1.0')
  cleanupDir(s.dir)
})

test('远程桥不可用：错误码透传并写审计（ok=false），不抛', async () => {
  const s = setup({
    handlers: {
      ping: () => {
        const e = new Error('bridge socket missing')
        e.code = 'E_BRIDGE_DOWN'
        throw e
      },
    },
  })
  const r = await s.runtime.service.status()
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_BRIDGE_DOWN')
  const lines = readFileSync(join(s.dir, 'audit.jsonl'), 'utf8').trim().split('\n')
  const last = JSON.parse(lines[lines.length - 1])
  assert.equal(last.cmd, 'status')
  assert.equal(last.ok, false)
  assert.equal(last.error, 'E_BRIDGE_DOWN')
  assert.equal(last.count, 0)
  cleanupDir(s.dir)
})

test('审计记录 feed：浏览免费，count 恒为 0', async () => {
  const s = setup({
    handlers: {
      list: () => ({
        ok: true,
        cmd: 'list',
        result: [videoRow('111111111'), videoRow('222222222')],
      }),
    },
  })
  const r = await s.runtime.service.feed({ limit: 2 })
  assert.equal(r.ok, true)
  const lines = readFileSync(join(s.dir, 'audit.jsonl'), 'utf8').trim().split('\n')
  const last = JSON.parse(lines[lines.length - 1])
  assert.equal(last.cmd, 'feed')
  assert.equal(last.ok, true)
  assert.equal(last.count, 0)
  assert.equal(s.runtime.service.usage().dailyUsed, 0)
  cleanupDir(s.dir)
})

test('桥应答结构异常（list 不是数组）→ E_PARSE', async () => {
  const s = setup({ handlers: { list: () => ({ ok: true, cmd: 'list', result: { items: [] } }) } })
  const r = await s.runtime.service.feed({})
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_PARSE')
  cleanupDir(s.dir)
})

test('登录浮层：0 条 + 登录面板 count>0 → E_LOGIN_REQUIRED（只 count，不点击）', async () => {
  const s = setup({
    handlers: {
      count: (p) => ({ ok: true, cmd: 'count', result: p.selector === '[id^="login-full-panel"]' ? 1 : 0 }),
    },
  })
  const r = await s.runtime.service.feed({})
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_LOGIN_REQUIRED')
  assert.ok(!s.transport.calls.some((c) => c.cmd === 'click'))
  cleanupDir(s.dir)
})

test('bridge 新命令：scroll/press/click 参数校验与命令白名单', async () => {
  const s = setup()
  await assert.rejects(s.runtime.bridge.call('eval'), (e) => e.code === 'E_BAD_ARG')
  await assert.rejects(s.runtime.bridge.scroll('x'), (e) => e.code === 'E_BAD_ARG')
  await assert.rejects(s.runtime.bridge.press('F5'), (e) => e.code === 'E_BAD_ARG')
  await assert.rejects(s.runtime.bridge.click(''), (e) => e.code === 'E_BAD_ARG')
  await assert.rejects(s.runtime.bridge.click('div.x', { nth: -1 }), (e) => e.code === 'E_BAD_ARG')

  assert.equal(await s.runtime.bridge.scroll(700), true)
  // 协议 v2 §A10：press 返回 {ok,key,inputFocused}（对象是 truthy，旧调用仍然成立）
  const pressed = await s.runtime.bridge.press('Escape')
  assert.equal(pressed?.ok, true)
  assert.equal(pressed?.key, 'Escape')
  const clicked = await s.runtime.bridge.click('div.search-result-card', { nth: 1 })
  assert.equal(clicked?.ok, true)
  assert.deepEqual(
    s.transport.calls.map((c) => c.cmd),
    ['scroll', 'press', 'click'],
  )
  assert.equal(s.transport.calls[0].dy, 700)
  assert.equal(s.transport.calls[1].key, 'Escape')
  assert.equal(s.transport.calls[2].nth, 1)
  cleanupDir(s.dir)
})

test('blockAssets=true：feed 开始时调一次 assets({block:true})，结束后不恢复', async () => {
  const s = setup({
    rawConfig: { blockAssets: true },
    handlers: {
      list: () => ({ ok: true, cmd: 'list', result: [videoRow('111111111'), videoRow('222222222')] }),
    },
  })
  const r = await s.runtime.service.feed({ limit: 2 })
  assert.equal(r.ok, true)
  assert.equal(r.count, 2)
  const assetsCalls = s.transport.calls.filter((c) => c.cmd === 'assets')
  assert.equal(assetsCalls.length, 1)
  assert.equal(assetsCalls[0].block, true)
  assert.equal(s.transport.calls[0].cmd, 'assets')
  // 不强制恢复：没有 assets(false)
  assert.ok(!s.transport.calls.some((c) => c.cmd === 'assets' && c.block === false))
  cleanupDir(s.dir)
})

test('blockAssets=true：search 开始时调一次 assets({block:true})，结束后不恢复', async () => {
  const s = setup({
    rawConfig: { blockAssets: true },
    handlers: {
      count: () => ({ ok: true, cmd: 'count', result: 1 }),
      list: () => ({ ok: true, cmd: 'list', result: [{ text: '搜索结果' }] }),
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/search/x?modal_id=123456789' }),
    },
  })
  const r = await s.runtime.service.search({ query: 'x', limit: 1 })
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  const assetsCalls = s.transport.calls.filter((c) => c.cmd === 'assets')
  assert.equal(assetsCalls.length, 1)
  assert.equal(assetsCalls[0].block, true)
  assert.equal(s.transport.calls[0].cmd, 'assets')
  assert.ok(!s.transport.calls.some((c) => c.cmd === 'assets' && c.block === false))
  cleanupDir(s.dir)
})

test('blockAssets=false：feed/search 不调 assets', async () => {
  {
    const s = setup({
      handlers: { list: () => ({ ok: true, cmd: 'list', result: [videoRow('111111111')] }) },
    })
    const r = await s.runtime.service.feed({})
    assert.equal(r.ok, true)
    assert.ok(!s.transport.calls.some((c) => c.cmd === 'assets'))
    cleanupDir(s.dir)
  }
  {
    const s = setup({
      handlers: {
        count: () => ({ ok: true, cmd: 'count', result: 1 }),
        list: () => ({ ok: true, cmd: 'list', result: [{ text: 'A' }] }),
        url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/search/x?modal_id=123456789' }),
      },
    })
    const r = await s.runtime.service.search({ query: 'x', limit: 1 })
    assert.equal(r.ok, true)
    assert.ok(!s.transport.calls.some((c) => c.cmd === 'assets'))
    cleanupDir(s.dir)
  }
})

test('assets 失败只 warn，feed/search 继续执行', async () => {
  const failAssets = { assets: () => ({ ok: false, cmd: 'assets', error: 'assets exploded' }) }
  {
    const s = setup({
      rawConfig: { blockAssets: true },
      handlers: {
        ...failAssets,
        list: () => ({ ok: true, cmd: 'list', result: [videoRow('111111111')] }),
      },
    })
    const r = await s.runtime.service.feed({ limit: 1 })
    assert.equal(r.ok, true)
    assert.equal(r.count, 1)
    assert.ok(s.logs.some((line) => /屏蔽图片\/字体\/媒体失败/.test(line)))
    cleanupDir(s.dir)
  }
  {
    const s = setup({
      rawConfig: { blockAssets: true },
      handlers: {
        ...failAssets,
        count: () => ({ ok: true, cmd: 'count', result: 1 }),
        list: () => ({ ok: true, cmd: 'list', result: [{ text: 'A' }] }),
        url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/search/x?modal_id=123456789' }),
      },
    })
    const r = await s.runtime.service.search({ query: 'x', limit: 1 })
    assert.equal(r.ok, true)
    assert.equal(r.count, 1)
    assert.ok(s.logs.some((line) => /屏蔽图片\/字体\/媒体失败/.test(line)))
    cleanupDir(s.dir)
  }
})

test('status 返回 blockAssets 配置，但不触发 assets 命令', async () => {
  const s = setup({ rawConfig: { blockAssets: true } })
  const r = await s.runtime.service.status()
  assert.equal(r.ok, true)
  assert.equal(r.blockAssets, true)
  assert.ok(!s.transport.calls.some((c) => c.cmd === 'assets'))
  cleanupDir(s.dir)
})

test('open：成功才记 activeWatch，open 本身不计数；status/usage 可查', async () => {
  const clock = makeClock('2026-11-06T18:30:00+08:00')
  const s = setup({ clock })
  const r = await s.runtime.service.open({ videoId: '123456789' })
  assert.equal(r.ok, true)
  const usage = s.runtime.service.usage()
  assert.equal(usage.dailyUsed, 0)
  assert.equal(usage.sessionUsed, 0)
  assert.equal(usage.minWatchMs, 10000)
  assert.equal(usage.activeWatch.videoId, '123456789')
  assert.equal(usage.activeWatch.startedAt, clock.now())

  // status 不结算，仍能看到 activeWatch
  const status = await s.runtime.service.status()
  assert.equal(status.ok, true)
  assert.equal(status.activeWatch.videoId, '123456789')
  assert.equal(status.minWatchMs, 10000)
  assert.equal(status.watchedCount, 0)
  assert.deepEqual(status.watched, { daily: 0, session: 0 })
  assert.equal(s.runtime.service.usage().dailyUsed, 0)
  cleanupDir(s.dir)
})

test('watch 结算：<10s 计 0、>=10s 计 1（由下一次 feed 触发）', async () => {
  const clock = makeClock('2026-11-06T18:30:00+08:00')
  const s = setup({
    clock,
    handlers: { list: () => ({ ok: true, cmd: 'list', result: [videoRow('111111111')] }) },
  })

  assert.equal((await s.runtime.service.open({ videoId: '123456789' })).ok, true)
  clock.advance(9999)
  assert.equal((await s.runtime.service.feed({ limit: 1 })).ok, true)
  assert.equal(s.runtime.service.usage().dailyUsed, 0)
  assert.equal(s.runtime.service.usage().activeWatch, null)

  assert.equal((await s.runtime.service.open({ videoId: '123456789' })).ok, true) // 同一视频重新计时
  clock.advance(10000)
  assert.equal((await s.runtime.service.feed({ limit: 1 })).ok, true)
  const usage = s.runtime.service.usage()
  assert.equal(usage.dailyUsed, 1)
  assert.equal(usage.sessionUsed, 1)
  assert.equal(usage.activeWatch, null)

  const watchEntries = readFileSync(join(s.dir, 'audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((e) => e.cmd === 'watch')
  assert.equal(watchEntries.length, 2)
  assert.equal(watchEntries[0].charged, false)
  assert.equal(watchEntries[0].watchMs, 9999)
  assert.equal(watchEntries[1].charged, true)
  assert.equal(watchEntries[1].watchMs, 10000)
  assert.equal(watchEntries[1].videoId, '123456789')
  cleanupDir(s.dir)
})

test('feed/search 浏览免费；配额满后 open 被拒，但 feed 仍可浏览', async () => {
  const clock = makeClock('2026-11-06T18:30:00+08:00')
  let modal = ''
  const s = setup({
    clock,
    rawConfig: { dailyQuota: 1, perSession: 8 },
    handlers: {
      url: () => ({
        ok: true,
        cmd: 'url',
        result: modal ? `https://www.douyin.com/search/x?modal_id=${modal}` : 'https://www.douyin.com/',
      }),
      count: () => ({ ok: true, cmd: 'count', result: 1 }),
      list: (p) => ({
        ok: true,
        cmd: 'list',
        result: p.selector === 'div.search-result-card' ? [{ text: '搜索结果' }] : [videoRow('111111111')],
      }),
      click: () => {
        modal = '123456789'
        return { ok: true, cmd: 'click', result: true }
      },
      press: () => {
        modal = ''
        return { ok: true, cmd: 'press', result: true }
      },
    },
  })

  assert.equal((await s.runtime.service.feed({ limit: 8 })).ok, true)
  assert.equal((await s.runtime.service.search({ query: 'x', limit: 1 })).ok, true)
  assert.equal(s.runtime.service.usage().dailyUsed, 0)

  assert.equal((await s.runtime.service.open({ videoId: '123456789' })).ok, true)
  clock.advance(10000)
  assert.equal((await s.runtime.service.feed({ limit: 8 })).ok, true)
  assert.equal(s.runtime.service.usage().dailyUsed, 1)
  assert.equal(s.runtime.service.usage().dailyLeft, 0)

  const openCallsBefore = s.transport.calls.filter((c) => c.cmd === 'open').length
  const rejected = await s.runtime.service.open({ videoId: '222222222' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'E_QUOTA')
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'open').length, openCallsBefore)
  assert.equal(s.runtime.service.usage().activeWatch, null)

  // 配额满仍可浏览列表（feed/search need=0）
  assert.equal((await s.runtime.service.feed({ limit: 8 })).ok, true)
  assert.equal(s.runtime.service.usage().dailyUsed, 1)
  cleanupDir(s.dir)
})

test('comments 作为下一次调用会先结算上一条 watch', async () => {
  const clock = makeClock('2026-11-06T18:30:00+08:00')
  const s = setup({
    clock,
    handlers: {
      count: () => ({ ok: true, cmd: 'count', result: 1 }),
      list: () => ({ ok: true, cmd: 'list', result: [{ text: '一条评论' }] }),
    },
  })
  assert.equal((await s.runtime.service.open({ videoId: '123456789' })).ok, true)
  clock.advance(12000)
  const r = await s.runtime.service.comments({ videoId: '123456789', limit: 1 })
  assert.equal(r.ok, true)
  assert.equal(s.runtime.service.usage().dailyUsed, 1)
  assert.equal(s.runtime.service.usage().activeWatch, null)
  // comments 不开始新的 watch
  assert.equal(s.runtime.service.usage().activeWatch, null)
  cleanupDir(s.dir)
})

test('open 失败不建 activeWatch', async () => {
  const clock = makeClock('2026-11-06T18:30:00+08:00')
  const s = setup({
    clock,
    handlers: { open: () => ({ ok: false, cmd: 'open', error: 'open failed' }) },
  })
  const r = await s.runtime.service.open({ videoId: '123456789' })
  assert.equal(r.ok, false)
  assert.equal(s.runtime.service.usage().activeWatch, null)
  assert.equal(s.runtime.service.usage().dailyUsed, 0)
  cleanupDir(s.dir)
})

test('连续 open 同一视频按新计时；上一次 >=10s 先结算', async () => {
  const clock = makeClock('2026-11-06T18:30:00+08:00')
  const s = setup({ clock })
  assert.equal((await s.runtime.service.open({ videoId: '123456789' })).ok, true)
  clock.advance(10001)
  assert.equal((await s.runtime.service.open({ videoId: '123456789' })).ok, true)
  const usage = s.runtime.service.usage()
  assert.equal(usage.dailyUsed, 1)
  assert.equal(usage.activeWatch.videoId, '123456789')
  assert.equal(usage.activeWatch.startedAt, clock.now())
  assert.equal(usage.activeWatch.elapsedMs, 0)
  cleanupDir(s.dir)
})

test('search 作为下一次调用会先结算上一条 watch', async () => {
  const clock = makeClock('2026-11-06T18:30:00+08:00')
  const s = setup({
    clock,
    handlers: {
      count: () => ({ ok: true, cmd: 'count', result: 1 }),
      list: () => ({ ok: true, cmd: 'list', result: [{ text: '搜索结果' }] }),
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/search/x?modal_id=123456789' }),
    },
  })
  assert.equal((await s.runtime.service.open({ videoId: '123456789' })).ok, true)
  clock.advance(10000)
  const r = await s.runtime.service.search({ query: 'x', limit: 1 })
  assert.equal(r.ok, true)
  assert.equal(s.runtime.service.usage().dailyUsed, 1)
  assert.equal(s.runtime.service.usage().activeWatch, null)
  cleanupDir(s.dir)
})

test('status/screenshot 不结算 activeWatch', async () => {
  const clock = makeClock('2026-11-06T18:30:00+08:00')
  const s = setup({ clock })
  assert.equal((await s.runtime.service.open({ videoId: '123456789' })).ok, true)
  clock.advance(12000)

  assert.equal((await s.runtime.service.status()).ok, true)
  assert.equal(s.runtime.service.usage().dailyUsed, 0)
  assert.equal(s.runtime.service.usage().activeWatch.videoId, '123456789')

  assert.equal((await s.runtime.service.screenshot()).ok, true)
  assert.equal(s.runtime.service.usage().dailyUsed, 0)
  assert.equal(s.runtime.service.usage().activeWatch.elapsedMs, 12000)

  // 下一次 feed 才结算
  s.transport.handlers.list = () => ({ ok: true, cmd: 'list', result: [videoRow('111111111')] })
  assert.equal((await s.runtime.service.feed({ limit: 1 })).ok, true)
  assert.equal(s.runtime.service.usage().dailyUsed, 1)
  assert.equal(s.runtime.service.usage().activeWatch, null)
  cleanupDir(s.dir)
})

test('download：html <source src> 取媒体流，本地落盘并返回 videoId/file/bytes/seconds/title', async () => {
  const dlDir = makeTmpDir('download-service')
  const mp4 = makeMp4()
  const fetched = []
  const s = setup({
    rawConfig: { downloadDir: dlDir },
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      html: () => ({
        ok: true,
        cmd: 'html',
        result: '<video><source src="https://v11-weba.douyinvod.com/x.mp4?a=1&amp;b=2"></video>',
      }),
      title: () => ({ ok: true, cmd: 'title', result: '测试标题' }),
    },
    fetchImpl: async (url) => {
      fetched.push(url)
      return new Response(mp4, { status: 200, headers: { 'content-length': String(mp4.length) } })
    },
  })
  const r = await s.runtime.service.download({ videoId: '123456789' })
  assert.equal(r.ok, true)
  assert.equal(r.videoId, '123456789')
  assert.equal(r.file, join(dlDir, '123456789.mp4'))
  assert.equal(r.bytes, mp4.length)
  assert.equal(r.seconds, 12.3)
  assert.equal(r.title, '测试标题')
  assert.deepEqual(fetched, ['https://v11-weba.douyinvod.com/x.mp4?a=1&b=2'])
  assert.ok(!s.transport.calls.some((c) => c.cmd === 'open')) // 当前页已是目标，不重复导航
  cleanupDir(s.dir)
  cleanupDir(dlDir)
})

test('download：html 为空时回退 list(video source)', async () => {
  const dlDir = makeTmpDir('download-fallback')
  const mp4 = makeMp4()
  const s = setup({
    rawConfig: { downloadDir: dlDir },
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      html: () => ({ ok: true, cmd: 'html', result: '' }),
      list: (p) => ({
        ok: true,
        cmd: 'list',
        result: p.selector === 'video source' ? [{ src: 'https://v26-web.douyinvod.com/y.mp4' }] : [],
      }),
    },
    fetchImpl: async () => new Response(mp4, { status: 200, headers: { 'content-length': String(mp4.length) } }),
  })
  const r = await s.runtime.service.download({ videoId: '123456789' })
  assert.equal(r.ok, true)
  assert.equal(r.bytes, mp4.length)
  cleanupDir(s.dir)
  cleanupDir(dlDir)
})

test('download：拿不到媒体流 → E_NO_MEDIA，提示手动保存，不调用 fetch', async () => {
  const dlDir = makeTmpDir('download-nomedia')
  let fetched = 0
  const s = setup({
    rawConfig: { downloadDir: dlDir },
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      html: () => ({ ok: true, cmd: 'html', result: '' }),
      list: () => ({ ok: true, cmd: 'list', result: [] }),
    },
    fetchImpl: async () => {
      fetched += 1
      return new Response('', { status: 200 })
    },
  })
  const r = await s.runtime.service.download({ videoId: '123456789' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_NO_MEDIA')
  assert.match(r.message, /手动保存/)
  assert.equal(fetched, 0)
  assert.deepEqual(readdirSync(dlDir), [])
  cleanupDir(s.dir)
  cleanupDir(dlDir)
})

test('download：fetch 失败 → E_NO_MEDIA，不留文件', async () => {
  const dlDir = makeTmpDir('download-fetchfail')
  const s = setup({
    rawConfig: { downloadDir: dlDir },
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      html: () => ({ ok: true, cmd: 'html', result: '<video><source src="https://v11-weba.douyinvod.com/x.mp4"></video>' }),
    },
    fetchImpl: async () => {
      throw new Error('network blocked')
    },
  })
  const r = await s.runtime.service.download({ videoId: '123456789' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_NO_MEDIA')
  assert.deepEqual(readdirSync(dlDir), [])
  cleanupDir(s.dir)
  cleanupDir(dlDir)
})

test('download：短链解析出 videoId 后下载', async () => {
  const dlDir = makeTmpDir('download-short')
  const mp4 = makeMp4()
  const s = setup({
    rawConfig: { downloadDir: dlDir },
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      html: () => ({ ok: true, cmd: 'html', result: '<video><source src="https://v11-weba.douyinvod.com/x.mp4"></video>' }),
    },
    fetchImpl: async (url, opts = {}) => {
      if (opts.method === 'HEAD') return { url: 'https://www.douyin.com/video/123456789' }
      return new Response(mp4, { status: 200, headers: { 'content-length': String(mp4.length) } })
    },
  })
  const r = await s.runtime.service.download({ url: 'https://v.douyin.com/abc123/' })
  assert.equal(r.ok, true)
  assert.equal(r.videoId, '123456789')
  assert.equal(r.file, join(dlDir, '123456789.mp4'))
  cleanupDir(s.dir)
  cleanupDir(dlDir)
})

test('download：参数/路径校验；非法参数不碰 bridge/fetch', async () => {
  const dlDir = makeTmpDir('download-args')
  let fetched = 0
  const s = setup({
    rawConfig: { downloadDir: dlDir },
    fetchImpl: async () => {
      fetched += 1
      return new Response(makeMp4(), { status: 200 })
    },
  })
  const cases = [
    [{}, 'E_BAD_ARG'],
    [{ videoId: 'abc' }, 'E_BAD_ARG'],
    [{ videoId: '123456789', quality: '4k' }, 'E_BAD_ARG'],
    [{ url: 'https://evil.example/video/123456789' }, 'E_BAD_URL'],
  ]
  for (const [args, code] of cases) {
    const r = await s.runtime.service.download(args)
    assert.equal(r.ok, false)
    assert.equal(r.code, code)
  }
  assert.equal(s.transport.calls.length, 0)
  assert.equal(fetched, 0)
  cleanupDir(s.dir)
  cleanupDir(dlDir)
})

test('download 不自动触发：feed/search/open 不需要媒体提取或 fetch', async () => {
  const dlDir = makeTmpDir('download-noauto')
  let fetched = 0
  let modal = ''
  const s = setup({
    rawConfig: { downloadDir: dlDir },
    handlers: {
      count: () => ({ ok: true, cmd: 'count', result: 1 }),
      list: (p) => ({
        ok: true,
        cmd: 'list',
        result: p.selector.includes('waterfall')
          ? [videoRow('111111111')]
          : p.selector.includes('search-result-card')
            ? [{ text: 'A' }]
            : [],
      }),
      click: () => {
        modal = '123456789'
        return { ok: true, cmd: 'click', result: true }
      },
      url: () => ({
        ok: true,
        cmd: 'url',
        result: modal ? `https://www.douyin.com/search/x?modal_id=${modal}` : 'https://www.douyin.com/',
      }),
      press: () => {
        modal = ''
        return { ok: true, cmd: 'press', result: true }
      },
    },
    fetchImpl: async () => {
      fetched += 1
      return new Response(makeMp4(), { status: 200 })
    },
  })
  assert.equal((await s.runtime.service.feed({ limit: 1 })).ok, true)
  assert.equal((await s.runtime.service.search({ query: 'x', limit: 1 })).ok, true)
  assert.equal((await s.runtime.service.open({ videoId: '123456789' })).ok, true)
  assert.equal(fetched, 0)
  assert.ok(!s.transport.calls.some((c) => c.cmd === 'html'))
  assert.ok(!s.transport.calls.some((c) => c.selector === 'video source'))
  cleanupDir(s.dir)
  cleanupDir(dlDir)
})

test('download：作者可从命中的搜索卡片文本兜底', async () => {
  const dlDir = makeTmpDir('download-search-author')
  const mp4 = makeMp4()
  const s = setup({
    rawConfig: { downloadDir: dlDir },
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/search/%E6%97%A5%E8%90%BD' }),
      html: (p) => ({
        ok: true,
        cmd: 'html',
        result: p.selector === 'video' ? '<video><source src="https://v11-weba.douyinvod.com/x.mp4"></video>' : '',
      }),
      list: (p) => ({
        ok: true,
        cmd: 'list',
        result: p.selector.includes('search-result-card')
          ? [{ href: 'https://www.douyin.com/video/123456789', text: '@作者甲 这个日落' }]
          : [],
      }),
      text: () => ({ ok: true, cmd: 'text', result: '' }),
    },
    fetchImpl: async () => new Response(mp4, { status: 200, headers: { 'content-length': String(mp4.length) } }),
  })
  const r = await s.runtime.service.download({ videoId: '123456789' })
  assert.equal(r.ok, true)
  assert.equal(r.author, '作者甲')
  cleanupDir(s.dir)
  cleanupDir(dlDir)
})

test('comments：展开回复按钮后重新 list，replies 非空且 replyCount 真实', async () => {
  let listN = 0
  const initial = '甲\n...\n好看的\n1小时前\n3\n分享\n回复\n展开1条回复'
  const expanded = '甲\n...\n好看的\n1小时前\n3\n分享\n回复\n乙\n...\n回复内容\n2小时前\n0\n分享\n回复\n收起'
  const s = setup({
    handlers: {
      count: (p) => ({
        ok: true,
        cmd: 'count',
        result: p.selector === 'button.comment-reply-expand-btn' ? 1 : p.selector === 'div.comment-item' ? 1 : 0,
      }),
      list: (p) => {
        if (p.selector !== 'div.comment-item') return { ok: true, cmd: 'list', result: [] }
        listN += 1
        return { ok: true, cmd: 'list', result: [{ text: listN === 1 ? initial : expanded }] }
      },
      click: () => ({ ok: true, cmd: 'click', result: true }),
    },
  })
  const r = await s.runtime.service.comments({ videoId: '123456789', limit: 1, scroll: false })
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].replyCount, 1)
  assert.equal(r.items[0].replies.length, 1)
  assert.equal(r.items[0].replies[0].author, '乙')
  assert.equal(r.items[0].replies[0].text, '回复内容')
  assert.ok(!r.items.some((x) => /展开\s*\d+条回复/.test(x.text)))
  const clicks = s.transport.calls.filter((c) => c.cmd === 'click')
  assert.equal(clicks.length, 1)
  assert.equal(clicks[0].selector, 'button.comment-reply-expand-btn')
  assert.equal(clicks[0].nth, 0)
  assert.deepEqual(s.sleep.calls, [500])
  cleanupDir(s.dir)
})

test('comments：展开按钮 click 失败跳过，不阻断初始评论', async () => {
  const s = setup({
    handlers: {
      count: (p) => ({
        ok: true,
        cmd: 'count',
        result: p.selector === 'button.comment-reply-expand-btn' ? 1 : p.selector === 'div.comment-item' ? 1 : 0,
      }),
      list: (p) => ({
        ok: true,
        cmd: 'list',
        result: p.selector === 'div.comment-item' ? [{ text: '甲\n好看的\n1小时前\n3' }] : [],
      }),
      click: () => {
        const e = new Error('click timeout')
        e.code = 'E_TIMEOUT'
        throw e
      },
    },
  })
  const r = await s.runtime.service.comments({ videoId: '123456789', limit: 1, scroll: false })
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 1)
  assert.deepEqual(r.items[0].replies, [])
  cleanupDir(s.dir)
})

test('search type=user：URL 带 type=user，按 userId 去重并过滤导航/空文本', async () => {
  const s = setup({
    handlers: {
      list: (p) => ({
        ok: true,
        cmd: 'list',
        result: p.selector === 'a[href*="/user/"]'
          ? [
              { href: '//www.douyin.com/user/MS4wABC', text: '海边的风' },
              { href: '//www.douyin.com/user/MS4wABC?from=search', text: '海边的风' },
              { href: '//www.douyin.com/user/self', text: '我的' },
              { href: '//www.douyin.com/user/MS4wDEF', text: '用户' },
              { href: '//www.douyin.com/user/MS4wGHI', text: '' },
              { href: '//www.douyin.com/user/MS4wJKL', text: '海的女儿' },
            ]
          : [],
      }),
    },
  })
  const r = await s.runtime.service.search({ query: '海', type: 'user', limit: 5 })
  assert.equal(r.ok, true)
  assert.equal(r.type, 'user')
  assert.equal(r.count, 2)
  assert.deepEqual(
    r.items.map((x) => x.userId),
    ['MS4wABC', 'MS4wJKL'],
  )
  assert.ok(r.items.every((x) => x.type === 'user' && x.url.startsWith('https://www.douyin.com/user/')))
  const openCall = s.transport.calls.find((c) => c.cmd === 'open')
  assert.equal(openCall.url, `https://www.douyin.com/search/${encodeURIComponent('海')}?type=user`)
  cleanupDir(s.dir)
})

test('search type=user：空结果 ok:true,count:0 带 note', async () => {
  const s = setup({ handlers: { list: () => ({ ok: true, cmd: 'list', result: [] }) } })
  const r = await s.runtime.service.search({ query: '海', type: 'user' })
  assert.equal(r.ok, true)
  assert.equal(r.type, 'user')
  assert.equal(r.count, 0)
  assert.match(r.note, /没有找到用户/)
  cleanupDir(s.dir)
})

test('search type=live：URL 带 type=live，解析 roomId 去重', async () => {
  const s = setup({
    handlers: {
      list: (p) => ({
        ok: true,
        cmd: 'list',
        result: p.selector === 'a[href*="/live/"]'
          ? [
              { href: 'https://live.douyin.com/123456', text: '海边直播' },
              { href: '//live.douyin.com/123456?from=search', text: '海边直播' },
              { href: 'https://www.douyin.com/live/789012', text: '另一个直播' },
              { href: 'https://www.douyin.com/live/789012', text: '' },
              { href: 'https://www.douyin.com/live/345678', text: '直播' },
            ]
          : [],
      }),
    },
  })
  const r = await s.runtime.service.search({ query: '海', type: 'live', limit: 5 })
  assert.equal(r.ok, true)
  assert.equal(r.type, 'live')
  assert.equal(r.count, 2)
  assert.deepEqual(
    r.items.map((x) => x.roomId),
    ['123456', '789012'],
  )
  assert.ok(r.items.every((x) => x.type === 'live' && x.url.startsWith('https://live.douyin.com/')))
  const openCall = s.transport.calls.find((c) => c.cmd === 'open')
  assert.equal(openCall.url, `https://www.douyin.com/search/${encodeURIComponent('海')}?type=live`)
  cleanupDir(s.dir)
})

test('search type=live：无结果 ok:true,count:0 带 note，不抛', async () => {
  const s = setup({ handlers: { list: () => ({ ok: true, cmd: 'list', result: [] }) } })
  const r = await s.runtime.service.search({ query: '海', type: 'live' })
  assert.equal(r.ok, true)
  assert.equal(r.type, 'live')
  assert.equal(r.count, 0)
  assert.match(r.note, /没有直播结果/)
  cleanupDir(s.dir)
})

function toggleFixture(action) {
  const selector = action === 'like' ? '[data-e2e="video-player-digg"]' : '[data-e2e="video-player-collect"]'
  // 2026-11-08 真实页面：active 只体现在 data-e2e-state，class 是哈希、aria 为 null
  const activeState = action === 'like' ? 'video-player-is-digged' : 'video-player-is-collected'
  const inactiveState = action === 'like' ? 'video-player-no-digged' : 'video-player-no-collect'
  let active = false
  let count = 10
  let clicks = 0
  let bump = true
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      count: () => ({ ok: true, cmd: 'count', result: 0 }),
      list: (p) => ({
        ok: true,
        cmd: 'list',
        result: p.selector === selector
          ? [{ text: String(count), class: '', 'aria-pressed': null, 'data-e2e-state': active ? activeState : inactiveState }]
          : [],
      }),
      click: (p) => {
        if (p.selector === selector) {
          clicks += 1
          if (bump) {
            active = !active
            count += active ? 1 : -1
          }
        }
        return { ok: true, cmd: 'click', result: true }
      },
    },
  })
  return {
    s,
    selector,
    get active() { return active },
    get clicks() { return clicks },
    setBump(v) { bump = v },
  }
}

test('like：confirm 缺失 E_CONFIRM_REQUIRED；dryRun 不点击', async () => {
  const { s, selector } = toggleFixture('like')
  const missing = await s.runtime.service.like({ videoId: '123456789' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'E_CONFIRM_REQUIRED')
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'click').length, 0)

  const dry = await s.runtime.service.like({ videoId: '123456789', dryRun: true })
  assert.equal(dry.ok, true)
  assert.equal(dry.dryRun, true)
  assert.equal(dry.verified, false)
  assert.equal(dry.before.active, false)
  assert.equal(dry.before.state, 'video-player-no-digged')
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'click').length, 0)
  const reads = s.transport.calls.filter((c) => c.cmd === 'list' && c.selector === selector)
  assert.equal(reads.length, 1)
  assert.ok(reads[0].attrs.includes(TOGGLE_STATE_ATTR), '回读必须请求 data-e2e-state')
  cleanupDir(s.dir)
})

test('detectToggleActive：真实页面只给 data-e2e-state 也能判 active；哈希 class 不误判', () => {
  assert.equal(detectToggleActive({ state: 'video-player-is-digged' }), true)
  assert.equal(detectToggleActive({ state: 'video-player-no-digged' }), false)
  assert.equal(detectToggleActive({ state: 'video-player-is-collected' }), true)
  assert.equal(detectToggleActive({ state: 'video-player-no-collect' }), false)
  // 大小写/空白容错
  assert.equal(detectToggleActive({ state: '  VIDEO-PLAYER-IS-DIGGED  ' }), true)
  // 实测的哈希 class + null aria：旧逻辑返回 null，不能假装已赞
  assert.equal(detectToggleActive({ class: 'wn9Oh5bX uoBorZji GI7ARE9c' }), null)
  // 未知 state 不误判，继续回落
  assert.equal(detectToggleActive({ state: 'video-player-unknown' }), null)
})

test('like：点击后回读 active，verified；重复调用走账本幂等；undo 点回', async () => {
  const f = toggleFixture('like')
  const { s, selector } = f
  const r1 = await s.runtime.service.like({ videoId: '123456789', confirm: true })
  assert.equal(r1.ok, true)
  assert.equal(r1.verified, true)
  assert.equal(r1.after.active, true)
  assert.equal(f.clicks, 1)
  const ledger = JSON.parse(readFileSync(join(s.runtime.cfg.downloadDir, '.write-ledger.json'), 'utf8'))
  const key = '123456789:like:true'
  assert.equal(ledger.actions[key].verified, true)
  assert.equal(ledger.actions[key].action, 'like')

  const again = await s.runtime.service.like({ videoId: '123456789', confirm: true })
  assert.equal(again.ok, true)
  assert.equal(again.idempotent, true)
  assert.equal(f.clicks, 1)

  const undo = await s.runtime.service.like({ videoId: '123456789', undo: true, confirm: true })
  assert.equal(undo.ok, true)
  assert.equal(undo.verified, true)
  assert.equal(undo.after.active, false)
  assert.equal(f.clicks, 2)
  cleanupDir(s.dir)
})

test('like：点击成功但回读不变 → verified:false，不重试', async () => {
  const f = toggleFixture('like')
  const { s } = f
  f.setBump(false)
  const r = await s.runtime.service.like({ videoId: '123456789', confirm: true })
  assert.equal(r.ok, false)
  assert.equal(r.verified, false)
  assert.equal(r.code, 'E_UNVERIFIED')
  assert.equal(f.clicks, 1) // 一次点击，无重试
  cleanupDir(s.dir)
})

test('like：选择器缺失/验证码登录态 → 明确错误，不点击', async () => {
  {
    const s = setup({ handlers: { url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }), list: () => ({ ok: true, cmd: 'list', result: [] }), count: () => ({ ok: true, cmd: 'count', result: 0 }) } })
    const r = await s.runtime.service.like({ videoId: '123456789', dryRun: true })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E_SELECTOR_MISS')
    cleanupDir(s.dir)
  }
  {
    const s = setup({ handlers: { url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }), title: () => ({ ok: true, cmd: 'title', result: '验证码中间页' }) } })
    const r = await s.runtime.service.like({ videoId: '123456789', confirm: true })
    assert.equal(r.code, 'E_CHALLENGE')
    assert.equal(s.transport.calls.filter((c) => c.cmd === 'click').length, 0)
    cleanupDir(s.dir)
  }
})

function keyboardFixture({ editors = 0, focusedInput = 0, clickBehavior = 'timeout' } = {}) {
  let active = false
  let count = 10
  const selector = '[data-e2e="video-player-digg"]'
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      count: (p) => ({
        ok: true,
        cmd: 'count',
        result:
          p.selector === '[contenteditable]'
            ? editors
            : p.selector === 'input:focus, textarea:focus'
              ? focusedInput
              : 0,
      }),
      list: (p) => ({
        ok: true,
        cmd: 'list',
        result: p.selector === selector
          ? [{ text: String(count), 'data-e2e-state': active ? 'video-player-is-digged' : 'video-player-no-digged' }]
          : [],
      }),
      click: () => {
        if (clickBehavior === 'ok') {
          active = true
          count += 1
          return { ok: true, cmd: 'click', result: true }
        }
        if (clickBehavior === 'timeout-but-clicked') {
          active = true
          count += 1
        }
        return { ok: false, cmd: 'click', error: 'locator.click: Timeout 15000ms exceeded.' }
      },
    },
  })
  s.transport.pressKey = async (key) => {
    s.transport.pressKeys.push({ key })
    if (key === 'z') {
      active = true
      count += 1
    }
    return true
  }
  return { s, selector, get active() { return active }, get count() { return count } }
}

test('like：点击被浮层拦截（E_TIMEOUT）且状态未变 → 回退键盘 Z，回读 verified', async () => {
  const f = keyboardFixture()
  const r = await f.s.runtime.service.like({ videoId: '123456789', confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.verified, true)
  assert.equal(r.via, 'key')
  assert.equal(r.after.state, 'video-player-is-digged')
  assert.deepEqual(f.s.transport.pressKeys.map((x) => x.key), ['z'])
  cleanupDir(f.s.dir)
})

test('like：点击超时但状态其实已变 → 不再按键（避免二次切换），via=click', async () => {
  const f = keyboardFixture({ clickBehavior: 'timeout-but-clicked' })
  const r = await f.s.runtime.service.like({ videoId: '123456789', confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.verified, true)
  assert.equal(r.via, 'click')
  assert.equal(f.s.transport.pressKeys.length, 0)
  cleanupDir(f.s.dir)
})

test('like：inputMode=key 直接按键，不点击；快捷键 Z', async () => {
  const f = keyboardFixture()
  const r = await f.s.runtime.service.like({ videoId: '123456789', confirm: true, inputMode: 'key' })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'key')
  assert.equal(f.s.transport.calls.filter((c) => c.cmd === 'click').length, 0)
  assert.deepEqual(f.s.transport.pressKeys.map((x) => x.key), ['z'])
  cleanupDir(f.s.dir)
})

test('like：评论输入框打开时按快捷键 → E_INPUT_FOCUSED，不按键', async () => {
  const f = keyboardFixture({ editors: 1 })
  const r = await f.s.runtime.service.like({ videoId: '123456789', confirm: true, inputMode: 'key' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_INPUT_FOCUSED')
  assert.equal(f.s.transport.pressKeys.length, 0)
  cleanupDir(f.s.dir)
})

test('like：有输入框聚焦时按快捷键 → E_INPUT_FOCUSED，不按键', async () => {
  const f = keyboardFixture({ focusedInput: 1 })
  const r = await f.s.runtime.service.like({ videoId: '123456789', confirm: true, inputMode: 'key' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_INPUT_FOCUSED')
  assert.equal(f.s.transport.pressKeys.length, 0)
  cleanupDir(f.s.dir)
})

test('like：inputMode 非法 → E_BAD_ARG，不点击不按键', async () => {
  const f = keyboardFixture()
  const r = await f.s.runtime.service.like({ videoId: '123456789', confirm: true, inputMode: 'mouse' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_BAD_ARG')
  assert.equal(f.s.transport.calls.length, 0)
  cleanupDir(f.s.dir)
})

test('favorite：选择器与状态回读、undo', async () => {
  const f = toggleFixture('favorite')
  const { s, selector } = f
  const r = await s.runtime.service.favorite({ videoId: '123456789', confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'favorite')
  assert.equal(r.verified, true)
  assert.equal(r.after.active, true)
  assert.equal(r.after.state, 'video-player-is-collected')
  const click = s.transport.calls.find((c) => c.cmd === 'click')
  assert.equal(click.selector, selector)
  const undo = await s.runtime.service.favorite({ videoId: '123456789', undo: true, confirm: true })
  assert.equal(undo.ok, true)
  assert.equal(undo.after.active, false)
  assert.equal(f.clicks, 2)
  cleanupDir(s.dir)
})

test('like：没有 data-e2e-state 时回落到计数差（兼容旧 DOM）', async () => {
  let active = false
  let count = 100
  const selector = '[data-e2e="video-player-digg"]'
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      count: () => ({ ok: true, cmd: 'count', result: 0 }),
      list: (p) => ({
        ok: true,
        cmd: 'list',
        result: p.selector === selector ? [{ text: String(count), class: '' }] : [],
      }),
      click: (p) => {
        if (p.selector === selector) {
          active = !active
          count += active ? 1 : -1
        }
        return { ok: true, cmd: 'click', result: true }
      },
    },
  })
  const dry = await s.runtime.service.like({ videoId: '123456789', dryRun: true })
  assert.equal(dry.before.active, null)
  assert.equal(dry.before.state, null)
  assert.equal(dry.before.count, 100)
  const r = await s.runtime.service.like({ videoId: '123456789', confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.verified, true)
  assert.equal(r.after.count, 101)
  cleanupDir(s.dir)
})

test('readToggleState：按钮晚挂载时重试（图文页 /note/ 重定向实测）', async () => {
  let reads = 0
  const selector = '[data-e2e="video-player-digg"]'
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      count: () => ({ ok: true, cmd: 'count', result: 0 }),
      list: (p) => {
        if (p.selector !== selector) return { ok: true, cmd: 'list', result: [] }
        reads += 1
        return { ok: true, cmd: 'list', result: reads < 2 ? [] : [{ text: '1742', 'data-e2e-state': 'video-player-no-digged' }] }
      },
    },
  })
  const r = await s.runtime.service.like({ videoId: '123456789', dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.before.state, 'video-player-no-digged')
  assert.equal(r.before.active, false)
  assert.equal(reads, 2)
  cleanupDir(s.dir)
})

test('openForWrite：已在 /note/<id> 不重复导航', async () => {
  const selector = '[data-e2e="video-player-digg"]'
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/note/123456789' }),
      title: () => ({ ok: true, cmd: 'title', result: '一条图文' }),
      count: () => ({ ok: true, cmd: 'count', result: 0 }),
      list: (p) => ({
        ok: true,
        cmd: 'list',
        result: p.selector === selector ? [{ text: '9', 'data-e2e-state': 'video-player-is-digged' }] : [],
      }),
    },
  })
  const r = await s.runtime.service.like({ videoId: '123456789', dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.before.active, true)
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'open').length, 0)
  cleanupDir(s.dir)
})

function commentFixture({ submitSelectors = [], commentAfterSubmit = '我\n...\n草稿评论\n1分钟前\n0', submitClickTimeout = false, initialDraft = '' } = {}) {
  let draft = initialDraft
  let clicks = 0
  let typed = 0
  let pasted = 0
  const s = setup({
    rawConfig: { commentSubmitSelectors: submitSelectors },
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      count: (p) => ({
        ok: true,
        cmd: 'count',
        result:
          p.selector === '[data-e2e="comment-list"]' ||
          p.selector === '[contenteditable]' ||
          (submitSelectors.includes(p.selector))
            ? 1
            : 0,
      }),
      click: (p) => {
        if (submitClickTimeout && submitSelectors.includes(p.selector)) {
          return { ok: false, cmd: 'click', error: 'locator.click: Timeout 15000ms exceeded.' }
        }
        clicks += 1
        return { ok: true, cmd: 'click', result: true }
      },
      press: () => ({ ok: true, cmd: 'press', result: true }),
      text: () => ({ ok: true, cmd: 'text', result: draft }),
      list: (p) => ({
        ok: true,
        cmd: 'list',
        result: p.selector === '[data-e2e="comment-item"]' ? [{ text: commentAfterSubmit }] : [],
      }),
    },
  })
  s.transport.typeText = async (text) => {
    typed += 1
    draft = text
    s.transport.typedTexts.push({ text })
    return true
  }
  s.transport.pasteText = async (text) => {
    pasted += 1
    draft = text
    s.transport.pastes.push({ text })
    return true
  }
  s.transport.clearText = async () => {
    draft = ''
    s.transport.clearTexts.push({})
    s.transport.typedTexts.push({ text: '', cleared: true })
    return true
  }
  return { s, get clicks() { return clicks }, get typed() { return typed }, get pasted() { return pasted }, get draft() { return draft }, setDraft(v) { draft = v } }
}

test('comment：缺少 confirm 提交被拒；draftOnly 默认只填草稿不提交', async () => {
  {
    const { s } = commentFixture({ submitSelectors: ['button.submit'] })
    const r = await s.runtime.service.comment({ videoId: '123456789', text: '草稿评论', draftOnly: false })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E_CONFIRM_REQUIRED')
    cleanupDir(s.dir)
  }
  const f = commentFixture({ submitSelectors: ['button.submit'] })
  const { s } = f
  const r = await s.runtime.service.comment({ videoId: '123456789', text: '草稿评论' })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'comment')
  assert.equal(r.targetState, 'draft')
  assert.equal(r.draftFilled, true)
  assert.equal(r.draftValue, '草稿评论')
  assert.equal(r.verified, true)
  assert.equal(f.draft, '草稿评论')
  assert.equal(f.pasted, 1)
  assert.ok(f.clicks >= 1) // 点击输入框
  assert.ok(!s.transport.calls.some((c) => c.cmd === 'click' && c.selector === 'button.submit'))
  assert.ok(!existsSync(join(s.runtime.cfg.downloadDir, '.write-ledger.json')))
  cleanupDir(s.dir)
})

test('comment：已有草稿先清空再打字（防重复/插到光标处）', async () => {
  const f = commentFixture({ initialDraft: '旧草稿' })
  const { s } = f
  const r = await s.runtime.service.comment({ videoId: '123456789', text: '新的评论' })
  assert.equal(r.ok, true)
  assert.equal(r.draftValue, '新的评论')
  assert.equal(f.draft, '新的评论')
  assert.equal(f.pasted, 1)
  assert.equal(s.transport.clearTexts.length, 1)
  assert.equal(s.transport.typedTexts[0].cleared, true, '先清空')
  assert.equal(s.transport.pastes[0].text, '新的评论')
  cleanupDir(s.dir)
})

test('comment：首次读回不匹配 → 清空重打一次后成功', async () => {
  const f = commentFixture()
  const { s } = f
  let calls = 0
  s.transport.pasteText = async (text) => {
    calls += 1
    s.transport.pastes.push({ text })
    f.setDraft(calls === 1 ? text.slice(1) : text) // 第一次模拟丢首字
    return true
  }
  const r = await s.runtime.service.comment({ videoId: '123456789', text: '草稿评论' })
  assert.equal(r.ok, true)
  assert.equal(r.draftValue, '草稿评论')
  assert.equal(calls, 2)
  assert.equal(s.transport.clearTexts.length, 1)
  cleanupDir(s.dir)
})

test('comment：@提及走键盘选中，再粘贴正文', async () => {
  let draft = ''
  let presses = 0
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      count: (p) => ({
        ok: true,
        cmd: 'count',
        result: ['[data-e2e="comment-list"]', '[contenteditable]', '.douyin_mention_word'].includes(p.selector) ? 1 : 0,
      }),
      list: (p) => {
        if (p.selector === '[class~="lgAE_oZa"]') return { ok: true, cmd: 'list', result: [{ text: '豆包' }] }
        return { ok: true, cmd: 'list', result: [] }
      },
      click: () => ({ ok: true, cmd: 'click', result: true }),
      press: () => {
        presses += 1
        draft += ' '
        return { ok: true, cmd: 'press', result: true }
      },
      text: () => ({ ok: true, cmd: 'text', result: draft }),
    },
  })
  s.transport.typeText = async (t) => {
    draft += t
    s.transport.typedTexts.push({ text: t })
    return true
  }
  s.transport.pasteText = async (t) => {
    draft += t
    s.transport.pastes.push({ text: t })
    return true
  }
  s.transport.clearText = async () => {
    draft = ''
    return true
  }
  const r = await s.runtime.service.comment({ videoId: '123456789', text: '@豆包 帮我总结一下' })
  assert.equal(r.ok, true)
  assert.equal(r.draftFilled, true)
  assert.equal(r.mention, '豆包')
  assert.equal(r.inputVia, 'mention+paste')
  assert.equal(presses, 1)
  assert.deepEqual(s.transport.typedTexts.map((x) => x.text), ['@', '豆包'])
  assert.deepEqual(s.transport.pastes.map((x) => x.text), ['帮我总结一下'])
  assert.equal(draft, '@豆包 帮我总结一下')
  cleanupDir(s.dir)
})

test('comment：提交按钮选择器为空时 E_SELECTOR_MISS，不猜', async () => {
  const { s } = commentFixture()
  const r = await s.runtime.service.comment({ videoId: '123456789', text: '草稿评论', draftOnly: false, confirm: true })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_SELECTOR_MISS')
  assert.equal(s.transport.calls.length, 0)
  cleanupDir(s.dir)
})

test('comment：confirm 后提交并回读自己的评论，写账本幂等', async () => {
  const f = commentFixture({ submitSelectors: ['button.submit'] })
  const { s } = f
  const r = await s.runtime.service.comment({ videoId: '123456789', text: '草稿评论', draftOnly: false, confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.targetState, 'posted')
  assert.equal(r.verified, true)
  assert.equal(f.pasted, 1)
  const ledger = JSON.parse(readFileSync(join(s.runtime.cfg.downloadDir, '.write-ledger.json'), 'utf8'))
  assert.equal(ledger.actions['123456789:comment:posted'].verified, true)
  const again = await s.runtime.service.comment({ videoId: '123456789', text: '草稿评论', draftOnly: false, confirm: true })
  assert.equal(again.ok, true)
  assert.equal(again.idempotent, true)
  assert.equal(f.pasted, 1)
  cleanupDir(s.dir)
})

test('comment：输入框选择器缺失 → E_SELECTOR_MISS，不输入', async () => {
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      count: () => ({ ok: true, cmd: 'count', result: 0 }),
      click: () => ({ ok: true, cmd: 'click', result: true }),
    },
  })
  const r = await s.runtime.service.comment({ videoId: '123456789', text: '草稿' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_SELECTOR_MISS')
  assert.equal(s.transport.typedTexts.length, 0)
  assert.equal(s.transport.pastes.length, 0)
  cleanupDir(s.dir)
})

function deleteFixture({ menuSelector = 'text=删除评论' } = {}) {
  let rows = [
    { text: '别人\n...\n好看\n1天前' },
    { text: '汐\n...\n我的评论ABC\n刚刚' },
  ]
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      count: (p) => ({
        ok: true,
        cmd: 'count',
        result: p.selector === '[data-e2e="comment-list"]' || (menuSelector && p.selector === menuSelector) ? 1 : 0,
      }),
      list: () => ({ ok: true, cmd: 'list', result: rows }),
      click: (p) => {
        if (p.selector === menuSelector) rows = rows.filter((r) => !r.text.includes('我的评论ABC'))
        return { ok: true, cmd: 'click', result: true }
      },
    },
  })
  return { s, get rows() { return rows } }
}

test('comment_delete：按文本定位并点「更多」→「删除评论」→ 回读确认，并清掉 posted 账本', async () => {
  const f = deleteFixture()
  const { s } = f
  // 预置一条 comment:posted 账本（模拟之前发过评论），删除后应被清掉
  const ledgerFile = join(s.runtime.cfg.downloadDir, '.write-ledger.json')
  mkdirSync(s.runtime.cfg.downloadDir, { recursive: true })
  writeFileSync(ledgerFile, JSON.stringify({ version: 1, actions: { '123456789:comment:posted': { videoId: '123456789', action: 'comment', targetState: 'posted', verified: true, result: 'commented' } } }))
  const r = await s.runtime.service.commentDelete({ videoId: '123456789', text: '我的评论ABC', confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.verified, true)
  assert.equal(r.action, 'comment_delete')
  assert.equal(r.deletedText, '我的评论ABC')
  assert.equal(r.matchedIndex, 1)
  assert.equal(r.loadedBefore, 2)
  assert.equal(r.loadedAfter, 1)
  const more = s.transport.calls.find((c) => c.cmd === 'click' && c.selector === '[data-e2e="video-comment-more"]')
  assert.equal(more.nth, 1, '删第 2 条（下标 1）')
  const menu = s.transport.calls.find((c) => c.cmd === 'click' && c.selector === 'text=删除评论')
  assert.ok(menu)
  const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'))
  assert.equal(ledger.actions['123456789:comment_delete:deleted'].verified, true)
  assert.equal(ledger.actions['123456789:comment:posted'], undefined, '删除后清掉 posted 记录')
  cleanupDir(s.dir)
})

test('comment_delete：找不到文本 → E_NOT_FOUND，不点任何菜单', async () => {
  const f = deleteFixture()
  const r = await f.s.runtime.service.commentDelete({ videoId: '123456789', text: '不存在的评论', confirm: true })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_NOT_FOUND')
  assert.equal(f.s.transport.calls.filter((c) => c.cmd === 'click' && c.selector === '[data-e2e="video-comment-more"]').length, 0)
  cleanupDir(f.s.dir)
})

test('comment_delete：没有「删除评论」菜单项（别人的评论）→ E_SELECTOR_MISS', async () => {
  const f = deleteFixture({ menuSelector: null })
  const r = await f.s.runtime.service.commentDelete({ videoId: '123456789', text: '我的评论ABC', confirm: true })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_SELECTOR_MISS')
  assert.equal(f.s.transport.calls.filter((c) => c.cmd === 'click' && c.selector === 'text=删除评论').length, 0)
  cleanupDir(f.s.dir)
})

test('comment_delete：缺 confirm → E_CONFIRM_REQUIRED，不执行', async () => {
  const f = deleteFixture()
  const r = await f.s.runtime.service.commentDelete({ videoId: '123456789', text: '我的评论ABC' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_CONFIRM_REQUIRED')
  assert.equal(f.s.transport.calls.length, 0)
  cleanupDir(f.s.dir)
})

test('comment：发送图标被挡（E_TIMEOUT）→ Enter 兜底提交并回读', async () => {
  const f = commentFixture({ submitSelectors: ['button.submit'], submitClickTimeout: true })
  const { s } = f
  const r = await s.runtime.service.comment({ videoId: '123456789', text: '草稿评论', draftOnly: false, confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.verified, true)
  assert.equal(r.submitVia, 'enter')
  const presses = s.transport.calls.filter((c) => c.cmd === 'press')
  assert.equal(presses.length, 1)
  assert.equal(presses[0].key, 'Enter')
  cleanupDir(s.dir)
})

test('comment：已有 posted 账本 → idempotent 带 before/after 与 note；force 可重发', async () => {
  const f = commentFixture({ submitSelectors: ['button.submit'] })
  const { s } = f
  const ledgerFile = join(s.runtime.cfg.downloadDir, '.write-ledger.json')
  mkdirSync(s.runtime.cfg.downloadDir, { recursive: true })
  writeFileSync(ledgerFile, JSON.stringify({
    version: 1,
    actions: {
      '123456789:comment:posted': {
        videoId: '123456789', action: 'comment', targetState: 'posted', verified: true, result: 'commented',
        detail: { before: { draft: '旧' }, after: { draft: '旧评论' } },
      },
    },
  }))
  const r = await s.runtime.service.comment({ videoId: '123456789', text: '新评论', draftOnly: false, confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.idempotent, true)
  assert.deepEqual(r.before, { draft: '旧' })
  assert.deepEqual(r.after, { draft: '旧评论' })
  assert.match(r.note, /force:true/)
  assert.equal(f.pasted, 0)

  const forced = await s.runtime.service.comment({ videoId: '123456789', text: '草稿评论', draftOnly: false, confirm: true, force: true })
  assert.equal(forced.ok, true)
  assert.equal(forced.idempotent, undefined)
  assert.equal(f.pasted, 1)
  cleanupDir(s.dir)
})

test('comment：提交后回读不到自己的评论 → E_UNVERIFIED，不重试', async () => {
  const f = commentFixture({ submitSelectors: ['button.submit'], commentAfterSubmit: '别人\n...\n无关评论\n1分钟前\n0' })
  const { s } = f
  const r = await s.runtime.service.comment({ videoId: '123456789', text: '草稿评论', draftOnly: false, confirm: true })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_UNVERIFIED')
  assert.equal(r.verified, false)
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'click' && c.selector === 'button.submit').length, 1)
  cleanupDir(s.dir)
})

test('写操作：短信验证/登录浮层 → E_LOGIN_REQUIRED，不点击', async () => {
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      count: (p) => ({
        ok: true,
        cmd: 'count',
        result: p.selector === '[class*="verify_sms"]' ? 1 : 0,
      }),
    },
  })
  const r = await s.runtime.service.like({ videoId: '123456789', dryRun: true })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_LOGIN_REQUIRED')
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'click').length, 0)
  const c = await s.runtime.service.comment({ videoId: '123456789', text: '草稿' })
  assert.equal(c.code, 'E_LOGIN_REQUIRED')
  assert.equal(s.transport.typedTexts.length, 0)
  assert.equal(s.transport.pastes.length, 0)
  cleanupDir(s.dir)
})

// ===== 私信（/chat）=====
// 2026-11-14 主站「消息」面板改造后，openDm 先数 [data-e2e="conversation-item"]；
// 夹具同时兼容旧 class（/chat）与新的 data-e2e 选择器，避免测试因选择器顺序误判。
const DM_ITEM = '[data-e2e="conversation-item"]'
const DM_TITLE = '.conversationConversationItemtitle'
const DM_CONV = '[class~="conversationConversationItemtitle"]'
const DM_PREVIEW = '.ConversationItemHinttextBox'
const DM_TIME = '.ConversationItemTagNextToTitletimeStr'
const DM_MSG = '[class~="MessageItemTextcontainer"]'
const DM_TIME_LAYOUT = '[class~="MessageBoxTimetimeLayout"]'
const DM_SEND = '.e2e-send-msg-btn'

function dmFixture({ names = ['饲养员', '01', '发日常', '流浪的小猫'], messages = [], timeLabel = '刚刚', owner = '', rawConfig = {} } = {}) {
  let draft = ''
  const sent = []
  const s = setup({
    rawConfig: { dmOwnerAliases: [], ...rawConfig },
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/chat' }),
      count: (p) => ({ ok: true, cmd: 'count', result: p.selector === DM_CONV || p.selector === DM_ITEM ? names.length : 1 }),
      list: (p) => {
        if (p.selector === DM_CONV || p.selector === DM_ITEM) return { ok: true, cmd: 'list', result: names.map((n) => ({ text: n })) }
        if (p.selector === DM_TITLE) return { ok: true, cmd: 'list', result: names.map((n) => ({ text: n })) }
        if (p.selector === DM_PREVIEW) return { ok: true, cmd: 'list', result: names.map((_, i) => ({ text: `预览${i}` })) }
        if (p.selector === DM_TIME) return { ok: true, cmd: 'list', result: names.map(() => ({ text: '10/30' })) }
        if (p.selector === `${DM_TIME_LAYOUT}, ${DM_MSG}`) {
          return {
            ok: true,
            cmd: 'list',
            result: [
              { text: timeLabel, class: 'MessageBoxTimetimeLayout' },
              ...messages,
              ...sent.map((t) => ({ text: t, class: 'MessageItemTextcontainer MessageItemTextisFromMe' })),
            ],
          }
        }
        if (p.selector === DM_MSG) {
          return {
            ok: true,
            cmd: 'list',
            result: [...messages, ...sent.map((t) => ({ text: t, class: 'MessageItemTextcontainer MessageItemTextisFromMe' }))],
          }
        }
        if (p.selector === DM_SEND) {
          return { ok: true, cmd: 'list', result: [{ class: 'messageMsgInputpublishBtn messageMsgInputpublishRedBtn e2e-send-msg-btn' }] }
        }
        return { ok: true, cmd: 'list', result: [] }
      },
      click: (p) => {
        if (p.selector === DM_SEND) sent.push(draft)
        return { ok: true, cmd: 'click', result: true }
      },
      press: () => ({ ok: true, cmd: 'press', result: true }),
      text: () => ({ ok: true, cmd: 'text', result: draft }),
    },
  })
  s.transport.pasteText = async (t) => {
    draft = t
    s.transport.pastes.push({ text: t })
    return true
  }
  s.transport.clearText = async () => {
    draft = ''
    s.transport.clearTexts.push({})
    return true
  }
  const ownerFile = join(s.dir, 'dm-owner.txt')
  writeFileSync(ownerFile, owner)
  s.runtime.cfg.dmOwnerFile = ownerFile
  return { s, get sent() { return sent }, setDraft(v) { draft = v } }
}

test('dm_list：读会话名/预览/时间，不点开会话；带稳定 id/index/isOwner', async () => {
  const f = dmFixture()
  const r = await f.s.runtime.service.dmList()
  assert.equal(r.ok, true)
  assert.equal(r.count, 4)
  assert.deepEqual(r.items[0], {
    name: '饲养员',
    preview: '预览0',
    time: '10/30',
    id: dmConversationId('饲养员'),
    index: 0,
    isOwner: false,
  })
  assert.equal(f.s.transport.calls.filter((c) => c.cmd === 'click').length, 0)
  cleanupDir(f.s.dir)
})

test('dm_read：按名字精确匹配、点开、解析 fromMe + 时间标签 + 稳定 messageId', async () => {
  const f = dmFixture({
    timeLabel: '10/30',
    messages: [
      { text: '在吗', class: 'MessageItemTextcontainer' },
      { text: '在的', class: 'MessageItemTextcontainer MessageItemTextisFromMe' },
    ],
  })
  const r = await f.s.runtime.service.dmRead({ name: '01' })
  assert.equal(r.ok, true)
  assert.equal(r.conversation.id, dmConversationId('01'))
  assert.equal(r.conversation.name, '01')
  assert.equal(r.conversation.isOwner, false)
  const convId = dmConversationId('01')
  assert.equal(r.items.length, 2)
  assert.equal(r.items[0].fromMe, false)
  assert.equal(r.items[0].text, '在吗')
  assert.equal(r.items[0].time, '10/30')
  assert.equal(r.items[0].index, 0)
  assert.equal(r.items[0].isOwner, false)
  assert.equal(r.items[0].ageMs, null)
  assert.match(r.items[0].id, /^dmc_[a-f0-9]{12}\.m_[a-f0-9]{12}$/)
  assert.equal(r.items[0].id.split('.')[0], convId)
  assert.equal(r.items[1].fromMe, true)
  assert.equal(r.items[1].text, '在的')
  assert.equal(r.items[1].index, 1)
  assert.equal(r.items[1].isOwner, false)
  assert.notEqual(r.items[1].id, r.items[0].id)
  const click = f.s.transport.calls.find((c) => c.cmd === 'click' && (c.selector === DM_ITEM || c.selector === DM_CONV))
  assert.equal(click.nth, 1)
  cleanupDir(f.s.dir)
})

test('dm_send：缺 confirm / 会话不存在 → 明确拒绝', async () => {
  {
    const f = dmFixture()
    const r = await f.s.runtime.service.dmSend({ name: '饲养员', text: '你好' })
    assert.equal(r.code, 'E_CONFIRM_REQUIRED')
    assert.equal(f.s.transport.calls.length, 0)
    cleanupDir(f.s.dir)
  }
  {
    const f = dmFixture()
    const r = await f.s.runtime.service.dmSend({ name: '不存在的人', text: '你好', confirm: true })
    assert.equal(r.code, 'E_NOT_FOUND')
    cleanupDir(f.s.dir)
  }
})

test('dm_send：对方最后一条超过 1 小时（日期标签）→ E_STALE，不发', async () => {
  const f = dmFixture({ timeLabel: '10/30', messages: [{ text: '在吗', class: 'MessageItemTextcontainer' }] })
  const r = await f.s.runtime.service.dmSend({ name: '饲养员', text: '你好', confirm: true })
  assert.equal(r.code, 'E_STALE')
  assert.equal(f.s.transport.pastes.length, 0)
  cleanupDir(f.s.dir)
})

test('dm_send：对方 30 分钟前发过 → 允许回复并回读验证', async () => {
  const f = dmFixture({ timeLabel: '30分钟前', messages: [{ text: '在吗', class: 'MessageItemTextcontainer' }] })
  const r = await f.s.runtime.service.dmSend({ name: '饲养员', text: '在的', confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.verified, true)
  assert.equal(r.name, '饲养员')
  assert.deepEqual(f.sent, ['在的'])
  cleanupDir(f.s.dir)
})

test('dm_send：主人会话没有新消息也可主动发', async () => {
  const f = dmFixture({ owner: '饲养员', messages: [] })
  const r = await f.s.runtime.service.dmSend({ name: '饲养员', text: '主动发一条', confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.verified, true)
  assert.deepEqual(f.sent, ['主动发一条'])
  cleanupDir(f.s.dir)
})

test('dm_send：今日条数达上限 → E_QUOTA', async () => {
  const f = dmFixture({ timeLabel: '刚刚', messages: [{ text: '在吗', class: 'MessageItemTextcontainer' }] })
  const audit = join(f.s.dir, 'audit.jsonl')
  const at = '2026-11-06T18:30:00+08:00'
  writeFileSync(audit, [1, 2, 3].map(() => JSON.stringify({ at, cmd: 'dm_send', ok: true })).join('\n') + '\n')
  f.s.runtime.cfg.auditFile = audit
  f.s.runtime.cfg.dmDailyLimit = 3
  const r = await f.s.runtime.service.dmSend({ name: '饲养员', text: '晚安', confirm: true })
  assert.equal(r.code, 'E_QUOTA')
  cleanupDir(f.s.dir)
})

// ===== 评论回复（1 小时窗口）=====
function replyFixture({ time = '刚刚·北京', afterTime = '刚刚', sendOk = true } = {}) {
  let draft = ''
  let phase = 'before'
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      count: (p) => ({
        ok: true,
        cmd: 'count',
        result:
          p.selector === '[data-e2e="comment-list"]' ||
          p.selector === '[contenteditable]' ||
          p.selector === '.comment-input-container-focus' ? 1 : 0,
      }),
      list: (p) => {
        if (p.selector !== '[data-e2e="comment-item"]') return { ok: true, cmd: 'list', result: [] }
        const base = `作者甲\n...\n目标评论\n${time}\n0\n分享\n回复`
        if (phase === 'before') return { ok: true, cmd: 'list', result: [{ text: base }] }
        const withReply = sendOk
          ? `${base}\n汐\n...\n谢谢\n${afterTime}\n0\n分享\n回复`
          : base
        return { ok: true, cmd: 'list', result: [{ text: withReply }] }
      },
      click: (p) => {
        if (String(p.selector || '').includes('text=回复')) {
          // noop: reply editor opens
        }
        if (String(p.selector || '').includes('commentInput-right-ct')) phase = 'after'
        return { ok: true, cmd: 'click', result: true }
      },
      text: () => ({ ok: true, cmd: 'text', result: draft }),
    },
  })
  s.transport.pasteText = async (t) => {
    draft = t
    s.transport.pastes.push({ text: t })
    return true
  }
  s.transport.clearText = async () => {
    draft = ''
    return true
  }
  return { s }
}

test('comment_reply：1 小时内的新评论 → 点回复、粘贴、发送、回读验证', async () => {
  const f = replyFixture()
  const r = await f.s.runtime.service.commentReply({ videoId: '123456789', target: '目标评论', text: '谢谢', confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.verified, true)
  assert.equal(r.action, 'comment_reply')
  assert.equal(r.result, 'replied')
  assert.equal(f.s.transport.pastes.length, 1)
  const ledger = JSON.parse(readFileSync(join(f.s.runtime.cfg.downloadDir, '.write-ledger.json'), 'utf8'))
  assert.equal(ledger.actions['123456789:comment_reply:posted'].verified, true)
  cleanupDir(f.s.dir)
})

test('comment_reply：旧评论（日期）→ E_STALE，不点回复', async () => {
  const f = replyFixture({ time: '10/30·北京' })
  const r = await f.s.runtime.service.commentReply({ videoId: '123456789', target: '目标评论', text: '谢谢', confirm: true })
  assert.equal(r.code, 'E_STALE')
  assert.equal(f.s.transport.pastes.length, 0)
  cleanupDir(f.s.dir)
})

test('comment_reply：找不到目标 / 缺 confirm → 明确拒绝', async () => {
  {
    const f = replyFixture()
    const r = await f.s.runtime.service.commentReply({ videoId: '123456789', target: '不存在', text: '谢谢', confirm: true })
    assert.equal(r.code, 'E_NOT_FOUND')
    cleanupDir(f.s.dir)
  }
  {
    const f = replyFixture()
    const r = await f.s.runtime.service.commentReply({ videoId: '123456789', target: '目标评论', text: '谢谢' })
    assert.equal(r.code, 'E_CONFIRM_REQUIRED')
    cleanupDir(f.s.dir)
  }
})

// ===== 通知/互动消息（主站右上角「通知」；2026-11-14 真机抓取）=====
const NOTIFY_PANEL = '[data-e2e="listDlgTest-container"]'
const NOTIFY_ITEM = '[data-e2e="listDlgTest-container"] > div:nth-child(2) > div'
const NOTIFY_LAST = '[data-e2e="listDlgTest-container"] > div:nth-child(2) > div:last-child'
const NOTIFY_FILTER = '[data-e2e="cur-filter"]'
const NOTIFY_CLOSE = '[data-e2e="searchbar-input"]'

const NOTIFY_ROWS = [
  { text: '饲养员\n朋友\n@汐\n在评论中提到了你星期三' },
  { text: '豆包\nAI分身\n这是京城大师赛的狼人杀搞笑切片，笑点是狼队友的超长反射弧\n回复了你的评论星期三' },
  { text: '叹-\n赞了你的评论\n11-01' },
  { text: '疏淮\n等5人赞了你的评论\n10-04' },
  { text: '天空\n赞了你的弹幕\n10-25' },
  { text: '往事不堪回首\n关注了你\n09-08\n回关' },
  { text: '点击加载更多' },
]

function notifyFixture({ rows = NOTIFY_ROWS, extraRows = [], panel = true } = {}) {
  let panelOpen = false
  let loaded = [...rows]
  let moreClicks = 0
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/' }),
      title: () => ({ ok: true, cmd: 'title', result: '抖音-记录美好生活' }),
      count: (p) => ({
        ok: true,
        cmd: 'count',
        result: p.selector === NOTIFY_PANEL && panel && panelOpen ? 1 : 0,
      }),
      list: (p) => ({
        ok: true,
        cmd: 'list',
        result: p.selector === NOTIFY_ITEM ? loaded : [],
      }),
      click: (p) => {
        if (p.selector.includes('通知') || p.selector === 'header [data-e2e="something-button"]') {
          panelOpen = true
          return { ok: true, cmd: 'click', result: true }
        }
        if (p.selector === NOTIFY_CLOSE) {
          panelOpen = false
          return { ok: true, cmd: 'click', result: true }
        }
        if (p.selector === NOTIFY_LAST) {
          moreClicks += 1
          if (extraRows.length) loaded = [...loaded.slice(0, -1), ...extraRows, loaded[loaded.length - 1]]
          return { ok: true, cmd: 'click', result: true }
        }
        return { ok: true, cmd: 'click', result: true }
      },
      text: (p) => ({
        ok: true,
        cmd: 'text',
        result:
          p.selector === NOTIFY_FILTER
            ? '全部消息'
            : p.selector === NOTIFY_LAST
              ? loaded[loaded.length - 1]?.text ?? ''
              : '',
      }),
      press: () => ({ ok: true, cmd: 'press', result: true }),
    },
  })
  return {
    s,
    get moreClicks() {
      return moreClicks
    },
  }
}

test('parseNotifyItems：@提及/回复/赞/弹幕/关注，过滤“点击加载更多”；带稳定 id/index/isOwner', () => {
  const items = parseNotifyItems(NOTIFY_ROWS, 500)
  assert.equal(items.length, 6)
  const { id, index, ...first } = items[0]
  assert.match(id, /^ntf_[a-f0-9]{12}$/)
  assert.equal(index, 0)
  assert.deepEqual(first, {
    actor: '饲养员',
    relation: '朋友',
    type: 'mention',
    text: '@汐',
    time: '星期三',
    ageMs: null,
    likeCount: null,
    isOwner: false,
    replyable: true,
    videoId: null,
    commentId: null,
    replySupported: false,
  })
  assert.equal(items[0].id, parseNotifyItems(NOTIFY_ROWS, 500)[0].id) // 重复读取 id 稳定
  assert.equal(items[1].type, 'comment_reply')
  assert.equal(items[1].time, '星期三')
  assert.ok(items[1].text.includes('京城大师赛'))
  assert.equal(items[2].type, 'like_comment')
  assert.equal(items[2].time, '11-01')
  assert.equal(items[3].type, 'like_comment')
  assert.equal(items[3].likeCount, 5)
  assert.equal(items[4].type, 'like_danmaku')
  assert.equal(items[5].type, 'follow')
  assert.equal(items[5].time, '09-08')
  assert.equal(items[5].text, '')
  for (let i = 0; i < items.length; i += 1) assert.equal(items[i].index, i)

  // 2026-11-15 真机文案：不是“回复了你的评论”，而是“在你的评论下回复”
  const under = parseNotifyItems([{ text: '饲养员\n朋友\n是的，大傻鱼还不太会用抖音[图片]\n在你的评论下回复昨天' }], 500)
  assert.equal(under.length, 1)
  assert.equal(under[0].type, 'comment_reply')
  assert.equal(under[0].time, '昨天')
  assert.ok(under[0].text.includes('大傻鱼'))

  // 相同四元组的两条通知：id 加 -2 区分，仍然稳定
  const dupRows = [
    { text: '饲养员\n朋友\n@汐\n在评论中提到了你30分钟前' },
    { text: '饲养员\n朋友\n@汐\n在评论中提到了你30分钟前' },
  ]
  const dup = parseNotifyItems(dupRows, 500, { ownerAliases: ['饲养员', '草荧'] })
  assert.equal(dup.length, 2)
  assert.doesNotMatch(dup[0].id, /-2$/)
  assert.equal(dup[1].id, `${dup[0].id}-2`)
  assert.equal(dup[0].isOwner, true)
  assert.equal(dup[1].isOwner, true)
})

test('notify_list：只读解析面板，不点条目、不标记已读、不回复', async () => {
  const f = notifyFixture()
  const r = await f.s.runtime.service.notifyList({ limit: 20, loadMore: false })
  assert.equal(r.ok, true)
  assert.equal(r.panel, '互动消息')
  assert.equal(r.filter, '全部消息')
  assert.equal(r.count, 6)
  assert.equal(r.items[0].type, 'mention')
  assert.equal(r.reply.supported, true)
  assert.equal(r.role, 'notify')
  assert.equal(f.s.transport.calls.filter((c) => c.cmd === 'click' && c.selector === NOTIFY_ITEM).length, 0)
  assert.ok(f.s.transport.calls.some((c) => c.cmd === 'click' && String(c.selector).includes('通知')))
  // 关闭面板只按 Escape / 通知入口，不点搜索框（searchbar-input）
  assert.equal(f.s.transport.calls.filter((c) => c.cmd === 'click' && c.selector === NOTIFY_CLOSE).length, 0)
  assert.ok(f.s.transport.calls.some((c) => c.cmd === 'press' && c.key === 'Escape'))
  cleanupDir(f.s.dir)
})

test('notify_list：loadMore=true 点“点击加载更多”补齐，仍不点条目', async () => {
  const f = notifyFixture({
    rows: [NOTIFY_ROWS[0], { text: '点击加载更多' }],
    extraRows: [NOTIFY_ROWS[1], NOTIFY_ROWS[2]],
  })
  const r = await f.s.runtime.service.notifyList({ limit: 3 })
  assert.equal(r.ok, true)
  assert.equal(r.count, 3)
  assert.equal(r.loadMoreClicks, 1)
  assert.equal(f.moreClicks, 1)
  assert.equal(f.s.transport.calls.filter((c) => c.cmd === 'click' && c.selector === NOTIFY_ITEM).length, 0)
  cleanupDir(f.s.dir)
})

test('notify_list：空通知面板 → ok:true,count:0', async () => {
  const f = notifyFixture({ rows: [] })
  const r = await f.s.runtime.service.notifyList({ loadMore: false })
  assert.equal(r.ok, true)
  assert.equal(r.count, 0)
  assert.deepEqual(r.items, [])
  cleanupDir(f.s.dir)
})

test('notify_list：面板始终不出现 → E_SELECTOR_MISS，不点条目', async () => {
  const f = notifyFixture({ panel: false })
  const r = await f.s.runtime.service.notifyList()
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_SELECTOR_MISS')
  assert.equal(f.s.transport.calls.filter((c) => c.cmd === 'click' && c.selector === NOTIFY_ITEM).length, 0)
  cleanupDir(f.s.dir)
})

test('notify_list：limit / loadMore 非法 → E_BAD_ARG，不触网', async () => {
  const f = notifyFixture()
  const a = await f.s.runtime.service.notifyList({ limit: 0 })
  assert.equal(a.code, 'E_BAD_ARG')
  const b = await f.s.runtime.service.notifyList({ loadMore: 'yes' })
  assert.equal(b.code, 'E_BAD_ARG')
  assert.equal(f.s.transport.calls.length, 0)
  cleanupDir(f.s.dir)
})

// ===== 通知回复（confirm 门控；2026-11-14 task-12）=====
const NOTIFY_REPLY_ROWS = [
  { text: '饲养员\n朋友\n@汐\n在评论中提到了你30分钟前' },
  { text: '豆包\nAI分身\n这是回复正文\n回复了你的评论30分钟前' },
  { text: '叹-\n赞了你的评论\n11-01' },
  { text: '往事不堪回首\n关注了你\n09-08\n回关' },
  { text: '老通知\n朋友\n@汐\n在评论中提到了你星期三' },
]

function notifyReplyFixture({ rows = NOTIFY_REPLY_ROWS, modalId = '123456789', afterUrl = null } = {}) {
  let panelOpen = false
  let itemClicked = false
  let itemNth = null
  const clickedUrl = afterUrl || `https://www.douyin.com/jingxuan?modal_id=${modalId}`
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: itemClicked ? clickedUrl : 'https://www.douyin.com/' }),
      title: () => ({ ok: true, cmd: 'title', result: '抖音-记录美好生活' }),
      count: (p) => ({ ok: true, cmd: 'count', result: p.selector === NOTIFY_PANEL && panelOpen ? 1 : 0 }),
      list: (p) => ({ ok: true, cmd: 'list', result: p.selector === NOTIFY_ITEM ? rows : [] }),
      text: (p) => ({
        ok: true,
        cmd: 'text',
        result:
          p.selector === NOTIFY_FILTER
            ? '全部消息'
            : p.selector === NOTIFY_LAST
              ? rows[rows.length - 1]?.text ?? ''
              : '',
      }),
      click: (p) => {
        if (String(p.selector).includes('通知') || p.selector === 'header [data-e2e="something-button"]') {
          panelOpen = true
          return { ok: true, cmd: 'click', result: true }
        }
        if (p.selector === NOTIFY_CLOSE) {
          panelOpen = false
          return { ok: true, cmd: 'click', result: true }
        }
        if (p.selector === NOTIFY_ITEM) {
          itemClicked = true
          itemNth = p.nth
          return { ok: true, cmd: 'click', result: true }
        }
        return { ok: true, cmd: 'click', result: true }
      },
      press: () => ({ ok: true, cmd: 'press', result: true }),
    },
  })
  return {
    s,
    get itemClicked() {
      return itemClicked
    },
    get itemNth() {
      return itemNth
    },
  }
}

function notifyReplyCommentFixture() {
  let panelOpen = false
  let itemClicked = false
  let itemNth = null
  let draft = ''
  let phase = 'before'
  const rows = [{ text: '饲养员\n朋友\n@汐\n在评论中提到了你刚刚' }]
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: itemClicked ? 'https://www.douyin.com/video/123456789' : 'https://www.douyin.com/?recommend=1' }),
      count: (p) => ({
        ok: true,
        cmd: 'count',
        result: p.selector === NOTIFY_PANEL && panelOpen
          ? 1
          : p.selector === '.comment-input-container-focus' ? 1 : 0,
      }),
      list: (p) => {
        if (p.selector === NOTIFY_ITEM) return { ok: true, cmd: 'list', result: rows }
        if (p.selector === '[data-e2e="comment-item"]') {
          const base = '草荧\n...\n目标评论\n刚刚\n0\n分享\n回复'
          const text = phase === 'after' ? `${base}\n汐\n...\n谢谢\n刚刚\n0\n分享\n回复` : base
          return { ok: true, cmd: 'list', result: [{ text }] }
        }
        return { ok: true, cmd: 'list', result: [] }
      },
      text: (p) => ({
        ok: true,
        cmd: 'text',
        result: p.selector === NOTIFY_FILTER
          ? '全部消息'
          : p.selector === '.comment-input-container-focus [contenteditable]' ? draft : '',
      }),
      click: (p) => {
        if (p.selector === 'body') panelOpen = false
        if (String(p.selector).includes('通知')) panelOpen = true
        if (p.selector === NOTIFY_ITEM) { itemClicked = true; itemNth = p.nth }
        if (String(p.selector).includes('commentInput-right-ct')) phase = 'after'
        return { ok: true, cmd: 'click', result: true }
      },
      press: () => ({ ok: true, cmd: 'press', result: true }),
    },
  })
  s.transport.pasteText = async (t) => { draft = t; s.transport.pastes.push({ text: t }); return true }
  s.transport.clearText = async () => { draft = ''; return true }
  return {
    s,
    get itemClicked() { return itemClicked },
    get itemNth() { return itemNth },
  }
}

test('pickNotifyTarget / parseVideoIdFromUrl：定位与 URL 取 videoId（纯函数）', () => {
  const items = parseNotifyItems(NOTIFY_REPLY_ROWS, 500)
  assert.equal(items.length, 5)
  assert.deepEqual(pickNotifyTarget(items, { target: '饲养员' }), { ok: true, index: 0, item: items[0] })
  assert.deepEqual(pickNotifyTarget(items, { target: '回复正文' }), { ok: true, index: 1, item: items[1] })
  assert.equal(pickNotifyTarget(items, { target: '不存在' }).code, 'E_NOT_FOUND')
  const ambiguous = pickNotifyTarget(
    parseNotifyItems([{ text: '饲养员\n朋友\n@汐\n在评论中提到了你30分钟前' }, { text: '豆包\nAI分身\n回复正文\n回复了你的评论30分钟前' }, { text: '饲养员\n朋友\n@汐\n在评论中提到了你20分钟前' }], 500),
    { target: '饲养员' },
  )
  assert.equal(ambiguous.code, 'E_AMBIGUOUS')
  assert.deepEqual(ambiguous.indexes, [0, 2])
  assert.deepEqual(pickNotifyTarget(items, { index: 2 }), { ok: true, index: 2, item: items[2] })
  assert.equal(pickNotifyTarget(items, { target: '随便', index: 2 }).code, 'E_BAD_ARG')
  assert.deepEqual(pickNotifyTarget(items, { id: items[1].id }), { ok: true, index: 1, item: items[1] })
  assert.equal(pickNotifyTarget(items, { id: items[1].id, target: '饲养员' }).code, 'E_BAD_ARG')
  assert.equal(pickNotifyTarget(items, { id: 'ntf_not_exist' }).code, 'E_NOT_FOUND')
  assert.equal(pickNotifyTarget(items, {}).code, 'E_BAD_ARG')
  assert.equal(parseVideoIdFromUrl('https://www.douyin.com/jingxuan?modal_id=7706417085110723449'), '7706417085110723449')
  assert.equal(parseVideoIdFromUrl('https://www.douyin.com/video/123456789'), '123456789')
  assert.equal(parseVideoIdFromUrl('https://www.douyin.com/'), '')
  assert.equal(parseVideoIdFromUrl('not a url'), '')
})

test('notify_reply：缺 confirm → E_CONFIRM_REQUIRED，不触网、不点条目', async () => {
  const f = notifyReplyFixture()
  const r = await f.s.runtime.rawService.notifyReply({ target: '饲养员', text: '谢谢' })
  assert.equal(r.code, 'E_CONFIRM_REQUIRED')
  assert.equal(r.markedRead, false)
  assert.equal(f.s.transport.calls.length, 0)
  assert.equal(f.itemClicked, false)
  cleanupDir(f.s.dir)
})

test('notify_reply：like/follow → E_NOT_REPLYABLE，不点条目、不标已读', async () => {
  for (const target of ['叹-', '往事不堪回首']) {
    const f = notifyReplyFixture()
    const r = await f.s.runtime.rawService.notifyReply({ target, text: '谢谢', confirm: true })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E_NOT_REPLYABLE')
    assert.equal(r.markedRead, false)
    assert.equal(f.itemClicked, false)
    cleanupDir(f.s.dir)
  }
})

test('notify_reply：找不到 / 多条 → E_NOT_FOUND / E_AMBIGUOUS，不点条目', async () => {
  {
    const f = notifyReplyFixture()
    const r = await f.s.runtime.rawService.notifyReply({ target: '不存在的人', text: '谢谢', confirm: true })
    assert.equal(r.code, 'E_NOT_FOUND')
    assert.equal(f.itemClicked, false)
    cleanupDir(f.s.dir)
  }
  {
    const f = notifyReplyFixture({
      rows: [
        { text: '饲养员\n朋友\n@汐\n在评论中提到了你30分钟前' },
        { text: '豆包\nAI分身\n回复正文\n回复了你的评论30分钟前' },
        { text: '饲养员\n朋友\n@汐\n在评论中提到了你20分钟前' },
      ],
    })
    const r = await f.s.runtime.rawService.notifyReply({ target: '饲养员', text: '谢谢', confirm: true })
    assert.equal(r.code, 'E_AMBIGUOUS')
    assert.deepEqual(r.indexes, [0, 2])
    assert.equal(f.itemClicked, false)
    cleanupDir(f.s.dir)
  }
})

test('notify_reply：旧通知（只有星期三/日期）→ E_STALE，不点条目不标已读', async () => {
  const f = notifyReplyFixture()
  const r = await f.s.runtime.rawService.notifyReply({ target: '老通知', text: '谢谢', confirm: true })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_STALE')
  assert.equal(r.markedRead, false)
  assert.equal(f.itemClicked, false)
  cleanupDir(f.s.dir)
})

test('notify_reply：成功路径 → 点条目、取 videoId、复用 commentReply、markedRead', async () => {
  const f = notifyReplyFixture()
  let replyArgs = null
  const r = await f.s.runtime.rawService.notifyReply(
    { target: '饲养员', text: '谢谢分享', confirm: true },
    {
      replyImpl: async (args) => {
        replyArgs = args
        return { ok: true, verified: true, result: 'replied', chars: 4, action: 'comment_reply' }
      },
    },
  )
  assert.equal(r.ok, true)
  assert.equal(r.action, 'notify_reply')
  assert.equal(r.videoId, '123456789')
  assert.equal(r.markedRead, true)
  assert.equal(r.verified, true)
  assert.match(r.note, /已标记已读/)
  assert.equal(f.itemClicked, true)
  assert.equal(f.itemNth, 0)
  assert.deepEqual(replyArgs, { videoId: '123456789', target: '草荧', text: '谢谢分享', confirm: true })
  assert.equal(r.notification.isOwner, true)
  assert.match(r.notification.id, /^ntf_[a-f0-9]{12}$/)
  cleanupDir(f.s.dir)
})

test('notify_reply：点条目后拿不到 videoId → E_NOT_FOUND，markedRead:true', async () => {
  const f = notifyReplyFixture({ afterUrl: 'https://www.douyin.com/' })
  const r = await f.s.runtime.rawService.notifyReply({ target: '饲养员', text: '谢谢', confirm: true }, { replyImpl: async () => ({ ok: true, verified: true }) })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_NOT_FOUND')
  assert.equal(r.markedRead, true)
  assert.equal(f.itemClicked, true)
  cleanupDir(f.s.dir)
})

test('notify_reply：commentReply 失败时原样带 code，markedRead:true 且不重试', async () => {
  const f = notifyReplyFixture()
  let calls = 0
  const r = await f.s.runtime.rawService.notifyReply(
    { target: '饲养员', text: '谢谢', confirm: true },
    {
      replyImpl: async () => {
        calls += 1
        return { ok: false, code: 'E_STALE', message: '目标评论超过 1 小时', verified: false }
      },
    },
  )
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_STALE')
  assert.equal(r.markedRead, true)
  assert.equal(calls, 1)
  cleanupDir(f.s.dir)
})

test('notify_list：每条带稳定 id/index/isOwner（饲养员 → owner）', async () => {
  const f = notifyFixture()
  const r = await f.s.runtime.service.notifyList({ limit: 20, loadMore: false })
  assert.equal(r.ok, true)
  assert.match(r.items[0].id, /^ntf_[a-f0-9]{12}$/)
  assert.equal(r.items[0].index, 0)
  assert.equal(r.items[0].isOwner, true)
  assert.equal(r.items[0].replyable, true)
  assert.equal(r.items[2].isOwner, false)
  assert.equal(r.items[2].replyable, false)
  // 重复读取 id 稳定
  const again = await f.s.runtime.service.notifyList({ limit: 20, loadMore: false })
  assert.deepEqual(r.items.map((x) => x.id), again.items.map((x) => x.id))
  cleanupDir(f.s.dir)
})

test('通知用户工具：notifyList/notifyOpen/notifyClose/notifyInspect 全部走 notify role，main 不动', async () => {
  const f = notifyFixture()
  const list = await f.s.runtime.service.notifyList({ limit: 20, loadMore: false })
  assert.equal(list.ok, true)
  assert.equal(list.role, 'notify')
  assert.ok(f.s.transport.calls.length > 0)
  assert.ok(f.s.transport.calls.every((c) => c.role === 'notify'), JSON.stringify(f.s.transport.calls.map((c) => [c.cmd, c.role])))
  assert.ok(!f.s.transport.calls.some((c) => c.cmd === 'open' && c.url !== undefined && c.role !== 'notify'))

  const opened = await f.s.runtime.rawService.notifyOpen()
  assert.equal(opened.ok, true)
  assert.equal(opened.role, 'notify')
  assert.ok(f.s.transport.calls.every((c) => c.role === 'notify'))

  const closed = await f.s.runtime.rawService.notifyClose()
  assert.equal(closed.ok, true)
  assert.equal(closed.role, 'notify')
  assert.ok(f.s.transport.calls.every((c) => c.role === 'notify'))

  const inspected = await f.s.runtime.rawService.notifyInspect()
  assert.equal(inspected.ok, true)
  assert.equal(inspected.role, 'notify')
  assert.ok(f.s.transport.calls.every((c) => c.role === 'notify'))
  cleanupDir(f.s.dir)
})

test('notify_reply：默认回复链路在 notify tab 的当前评论区完成（不调用 commentReply/main）', async () => {
  const f = notifyReplyCommentFixture()
  const r = await f.s.runtime.rawService.notifyReply(
    { target: '饲养员', text: '谢谢', confirm: true },
    {},
  )
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.verified, true)
  assert.equal(r.videoId, '123456789')
  assert.equal(f.itemClicked, true)
  assert.equal(f.itemNth, 0)
  assert.deepEqual(f.s.transport.pastes.map((p) => p.text), ['谢谢'])
  assert.ok(f.s.transport.calls.every((c) => c.role === 'notify'), JSON.stringify(f.s.transport.calls.map((c) => [c.cmd, c.role])))
  cleanupDir(f.s.dir)
})

test('notify_reply：多目标 3 条，按 id 选第 2/3 条不回错；index-only 也可选', async () => {
  const rows = [
    { text: '甲\n朋友\n@汐\n在评论中提到了你30分钟前' },
    { text: '乙\n朋友\n@汐\n在评论中提到了你30分钟前' },
    { text: '丙\n朋友\n@汐\n在评论中提到了你30分钟前' },
  ]
  const items = parseNotifyItems(rows, 500)
  assert.equal(items.length, 3)
  for (const [pos, item] of [[1, items[1]], [2, items[2]]]) {
    const f = notifyReplyFixture({ rows })
    const r = await f.s.runtime.rawService.notifyReply(
      { id: item.id, text: '谢谢', confirm: true },
      { replyImpl: async () => ({ ok: true, verified: true, result: 'replied' }) },
    )
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.notification.id, item.id)
    assert.equal(f.itemNth, pos)
    assert.ok(f.s.transport.calls.every((c) => c.role === 'notify'), JSON.stringify(f.s.transport.calls.map((c) => [c.cmd, c.role])))
    cleanupDir(f.s.dir)
  }
  {
    const f = notifyReplyFixture({ rows })
    const r = await f.s.runtime.rawService.notifyReply(
      { index: 2, text: '谢谢', confirm: true },
      { replyImpl: async () => ({ ok: true, verified: true, result: 'replied' }) },
    )
    assert.equal(r.ok, true)
    assert.equal(r.notification.id, items[2].id)
    assert.equal(f.itemNth, 2)
    cleanupDir(f.s.dir)
  }
})

test('notify_reply：按 id 精确选择（不再按作者名猜）；id 与 target/index 不一致 → E_BAD_ARG', async () => {
  const items = parseNotifyItems(NOTIFY_REPLY_ROWS, 500)
  {
    const f = notifyReplyFixture()
    let replyArgs = null
    const r = await f.s.runtime.rawService.notifyReply(
      { id: items[0].id, text: '谢谢', confirm: true },
      {
        replyImpl: async (args) => {
          replyArgs = args
          return { ok: true, verified: true, result: 'replied' }
        },
      },
    )
    assert.equal(r.ok, true)
    assert.equal(r.markedRead, true)
    assert.equal(r.notification.id, items[0].id)
    assert.equal(f.itemClicked, true)
    assert.equal(f.itemNth, 0)
    assert.equal(replyArgs.target, '草荧')
    cleanupDir(f.s.dir)
  }
  {
    const f = notifyReplyFixture()
    const bad = await f.s.runtime.rawService.notifyReply(
      { id: items[1].id, target: '饲养员', text: '谢谢', confirm: true },
      { replyImpl: async () => ({ ok: true, verified: true }) },
    )
    assert.equal(bad.code, 'E_BAD_ARG')
    assert.equal(f.itemClicked, false)
    cleanupDir(f.s.dir)
  }
  {
    const f = notifyReplyFixture()
    const bad = await f.s.runtime.rawService.notifyReply(
      { id: items[1].id, index: 0, text: '谢谢', confirm: true },
      { replyImpl: async () => ({ ok: true, verified: true }) },
    )
    assert.equal(bad.code, 'E_BAD_ARG')
    assert.equal(f.itemClicked, false)
    cleanupDir(f.s.dir)
  }
  {
    const f = notifyReplyFixture()
    const miss = await f.s.runtime.rawService.notifyReply({ id: 'ntf_not_exist', text: '谢谢', confirm: true })
    assert.equal(miss.code, 'E_NOT_FOUND')
    assert.equal(f.itemClicked, false)
    cleanupDir(f.s.dir)
  }
  {
    const f = notifyReplyFixture()
    const noSel = await f.s.runtime.rawService.notifyReply({ text: '谢谢', confirm: true })
    assert.equal(noSel.code, 'E_BAD_ARG')
    assert.equal(f.s.transport.calls.length, 0)
    cleanupDir(f.s.dir)
  }
})

test('notify_reply：owner 通知先按显示名“草荧”，E_NOT_FOUND 后回退备注名“饲养员”', async () => {
  const f = notifyReplyFixture()
  const calls = []
  const r = await f.s.runtime.rawService.notifyReply(
    { target: '饲养员', text: '谢谢', confirm: true },
    {
      replyImpl: async (args) => {
        calls.push(args.target)
        if (args.target === '草荧') return { ok: false, code: 'E_NOT_FOUND', message: 'not found' }
        return { ok: true, verified: true, result: 'replied' }
      },
    },
  )
  assert.equal(r.ok, true)
  assert.deepEqual(calls, ['草荧', '饲养员'])
  assert.equal(r.replyTarget, '草荧')
  assert.equal(r.usedAltTarget, true)
  cleanupDir(f.s.dir)
})

test('notify_reply：非主人通知不套用“草荧”映射，回复目标仍是作者本人', async () => {
  const f = notifyReplyFixture({
    rows: [{ text: '豆包\nAI分身\n这是回复正文\n回复了你的评论30分钟前' }],
  })
  const calls = []
  const r = await f.s.runtime.rawService.notifyReply(
    { target: '豆包', text: '谢谢', confirm: true },
    {
      replyImpl: async (args) => {
        calls.push(args.target)
        return { ok: true, verified: true, result: 'replied' }
      },
    },
  )
  assert.equal(r.ok, true)
  assert.equal(r.notification.isOwner, false)
  assert.deepEqual(calls, ['豆包'])
  cleanupDir(f.s.dir)
})
