/**
 * 2026-11-17：ttwid + iesdouyin 分享页兜底通道。
 *
 * 全部离线（mock fetch），证据来源见 /tmp/probe-parse/REPORT.md §A、§D5：
 * 不带 ttwid 只有占位对象、带 ttwid 才有 videoInfoRes；桌面 UA 会被 302 踢回 www。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractShareItem,
  fetchShareItem,
  fetchTtwid,
  mediaFromShareItem,
  pickTtwidCookie,
  playEndpointUrl,
  resetTtwidCache,
} from '../lib/sharepage.js'
import { cleanupDir, makeTmpDir, setup } from './helpers.mjs'

const VIDEO_ITEM = {
  aweme_id: '7436613508646702348',
  desc: '送给所有知道我名字的人 #李子柒',
  author: { nickname: '李子柒' },
  video: {
    duration: 747734,
    play_addr: {
      uri: 'v0300fg10000csq1minog65hhjm23oe0',
      url_list: ['https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0300fg10000csq1minog65hhjm23oe0&ratio=720p&line=0'],
    },
  },
  images: [],
}

const NOTE_ITEM = {
  aweme_id: '7680883233307342947',
  desc: '如何获取你的前100个用户？#ai',
  author: { nickname: '霖贝塔AI日记' },
  video: {
    play_addr: {
      uri: 'https://lf26-music-east.douyinstatic.com/obj/ies-music-hj/7670055808746507067.mp3',
      url_list: ['https://lf26-music-east.douyinstatic.com/obj/ies-music-hj/7670055808746507067.mp3'],
    },
  },
  images: [
    {
      url_list: ['https://p3-pc-sign.douyinpic.com/a~tplv-dy-aweme-images:q75.webp'],
      download_url_list: ['https://p3-pc-sign.douyinpic.com/a-water:1~tplv-dy-aweme-images:q75.webp'],
    },
    { url_list: ['https://p3-pc-sign.douyinpic.com/b~tplv-dy-aweme-images:q75.webp'] },
  ],
}

// 实测形态：图集的 play_addr 被 playwm 端点包成 `?video_id=<urlencoded mp3>`
const NOTE_ITEM_WRAPPED_AUDIO = {
  ...NOTE_ITEM,
  video: {
    play_addr: {
      uri: 'https://lf26-music-east.douyinstatic.com/obj/ies-music-hj/767.mp3',
      url_list: [
        'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=https%3A%2F%2Flf26-music-east.douyinstatic.com%2Fobj%2Fies-music-hj%2F7670055808746507067.mp3&ratio=720p&line=0',
      ],
    },
  },
}

function shareHtml(item) {
  const payload = {
    loaderData: {
      video_layout: null,
      'video_(id)/page': { videoInfoRes: { item_list: [item] } },
    },
  }
  return `<html><script>window._ROUTER_DATA = ${JSON.stringify(payload)}</script></html>`
}

function ttwidResponse() {
  return {
    ok: true,
    status: 200,
    headers: { getSetCookie: () => ['ttwid=1%7Cabc%7C1794875799%7Cdeadbeef; Path=/; Domain=bytedance.com'] },
    text: async () => '{"status_code":0}',
  }
}

test('ttwid 注册：从 Set-Cookie 抠 name=value；并缓存', async () => {
  resetTtwidCache()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return ttwidResponse()
  }
  const cookie = await fetchTtwid({ fetchImpl })
  assert.equal(cookie, 'ttwid=1%7Cabc%7C1794875799%7Cdeadbeef')
  await fetchTtwid({ fetchImpl })
  assert.equal(calls, 1, '30 分钟内应复用缓存')
  await fetchTtwid({ fetchImpl, force: true })
  assert.equal(calls, 2)
  resetTtwidCache()
})

test('pickTtwidCookie：没有 set-cookie 时返回空串', () => {
  assert.equal(pickTtwidCookie({ headers: {} }), '')
  assert.equal(
    pickTtwidCookie({ headers: { getSetCookie: () => ['other=1; Path=/', 'ttwid=xyz; Path=/'] } }),
    'ttwid=xyz',
  )
})

test('extractShareItem：跳过 video_layout 占位对象（link-parse 踩过的坑）', () => {
  const item = extractShareItem(shareHtml(VIDEO_ITEM))
  assert.equal(item.aweme_id, '7436613508646702348')

  // 无 cookie 的旧现象：只有占位对象 → 明确报错，不静默返回空
  const placeholder = { loaderData: { video_layout: null, 'video_(id)/page': { ua: 'x', isSpider: false } } }
  assert.throws(
    () => extractShareItem(`<script>window._ROUTER_DATA = ${JSON.stringify(placeholder)}</script>`),
    (e) => e.code === 'E_NO_MEDIA',
  )
  assert.throws(() => extractShareItem('<html>no data</html>'), (e) => e.code === 'E_NO_MEDIA')
})

test('mediaFromShareItem：视频出 uri 候选；图集出图片且不把背景音乐当视频', () => {
  const video = mediaFromShareItem(VIDEO_ITEM)
  assert.equal(video.kind, 'video')
  assert.equal(video.author, '李子柒')
  assert.equal(video.durationSec, 748)
  assert.equal(video.playUrls.length, 1)
  assert.match(video.playUrls[0], /playwm/)

  const note = mediaFromShareItem(NOTE_ITEM)
  assert.equal(note.kind, 'gallery')
  assert.equal(note.images.length, 2)
  assert.equal(note.playUrls.length, 0, '图集的 play_addr 是 mp3，必须过滤')
  assert.equal(
    mediaFromShareItem(NOTE_ITEM_WRAPPED_AUDIO).playUrls.length,
    0,
    '被 playwm 端点包起来的 mp3 也要过滤',
  )
  assert.ok(!note.images[0].includes('-water:'), '优先选不带水印标记的图')

  assert.equal(
    playEndpointUrl('v0300fg10000csq1minog65hhjm23oe0'),
    'https://www.douyin.com/aweme/v1/play/?video_id=v0300fg10000csq1minog65hhjm23oe0&ratio=720p&line=0',
  )
  assert.equal(playEndpointUrl(''), '')
})

test('fetchShareItem：注册 ttwid → 带 cookie 请求分享页 → 解析 item', async () => {
  resetTtwidCache()
  const seen = []
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url: String(url), cookie: opts.headers?.cookie ?? '', ua: opts.headers?.['user-agent'] ?? '' })
    if (String(url).includes('ttwid.bytedance.com')) return ttwidResponse()
    return { ok: true, status: 200, text: async () => shareHtml(VIDEO_ITEM) }
  }
  const out = await fetchShareItem('7436613508646702348', { fetchImpl })
  assert.equal(out.item.aweme_id, '7436613508646702348')
  assert.equal(out.media.videoUri, 'v0300fg10000csq1minog65hhjm23oe0')
  const page = seen.find((x) => x.url.includes('iesdouyin.com'))
  assert.match(page.url, /\/share\/video\/7436613508646702348\/$/)
  assert.match(page.cookie, /^ttwid=/)
  assert.match(page.ua, /iPhone/)
  resetTtwidCache()
})

test('service.download：浏览器拿不到直链时用分享页兜底落盘，并标 mediaSource', async () => {
  resetTtwidCache()
  const dir = makeTmpDir('sharepage')
  const mp4 = Buffer.from([0, 0, 0, 16, ...Buffer.from('ftypisom'), 0, 0, 2, 0])
  const fetchImpl = async (url) => {
    const u = String(url)
    if (u.includes('ttwid.bytedance.com')) return ttwidResponse()
    if (u.includes('iesdouyin.com')) return { ok: true, status: 200, text: async () => shareHtml(VIDEO_ITEM) }
    // play 端点（含 302 的最终 CDN）直接回字节
    return new Response(mp4, { status: 200 })
  }
  const s = setup({
    rawConfig: { downloadDir: dir },
    fetchImpl,
    handlers: {
      // 模拟"页面是 JS 壳"：没有 video 元素、没有图集图
      html: () => ({ ok: true, cmd: 'html', result: '' }),
      list: () => ({ ok: true, cmd: 'list', result: [] }),
      title: () => ({ ok: true, cmd: 'title', result: '' }),
    },
  })
  const r = await s.runtime.service.download({ videoId: '7436613508646702348' })
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'video')
  assert.equal(r.mediaSource, 'share-page')
  assert.equal(r.author, '李子柒')
  assert.match(r.title, /送给所有知道我名字的人/)
  assert.ok(r.bytes > 0)
  cleanupDir(s.dir)
  cleanupDir(dir)
  resetTtwidCache()
})
