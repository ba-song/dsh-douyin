/**
 * 2026-11-17：图集下载 + 分享文案 + 无水印候选。
 *
 * 背景：主人的两条需求——
 *   1) 抖音分享文案（「复制打开抖音… https://v.douyin.com/xxx/ 复制此链接」）要能直接用；
 *   2) /note/<id> 图文作品要能落成本地图片（参考 wlq6dfup20090104/dsh-douyin-video）。
 * 这里全部离线：假 fetch、假 transport、临时目录，不碰生产目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  detectImageExt,
  downloadGalleryImages,
  isAllowedImageUrl,
  normalizeMediaCandidates,
} from '../lib/download.js'
import { extractDouyinUrlFromText, extractGalleryImageUrls, resolveVideoTargetAsync } from '../lib/service.js'
import { cleanupDir, makeTmpDir, setup } from './helpers.mjs'

const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x20, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(32, 7),
])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 3)])

test('分享文案：抠出抖音链接（带 scheme / 裸域名 / 结尾标点）', () => {
  const share = '7.43 复制打开抖音，看看【某某的作品】这个一定要看 https://v.douyin.com/abcd1234/ 复制此链接，打开Dou音搜索'
  assert.equal(extractDouyinUrlFromText(share), 'https://v.douyin.com/abcd1234')

  assert.equal(
    extractDouyinUrlFromText('看这个 v.douyin.com/xyz789/ 好玩'),
    'https://v.douyin.com/xyz789',
  )
  assert.equal(
    extractDouyinUrlFromText('https://www.douyin.com/video/7436613508646702348。'),
    'https://www.douyin.com/video/7436613508646702348',
  )
  assert.equal(
    extractDouyinUrlFromText('https://www.iesdouyin.com/share/note/7680883233307342947/?a=1'),
    'https://www.iesdouyin.com/share/note/7680883233307342947',
  )
  // 别把别人的链接当抖音链接
  assert.equal(extractDouyinUrlFromText('https://www.bilibili.com/video/BV1xx'), '')
  assert.equal(extractDouyinUrlFromText('今天没有链接'), '')
})

test('短链解析：图集短链 → /note/<id>，kind=note（不是 E_BAD_URL）', async () => {
  const fetchImpl = async (url) => ({
    url: String(url).startsWith('https://v.douyin.com/')
      ? 'https://www.iesdouyin.com/share/note/7680883233307342947/?region=CN&from_ssr=1'
      : 'https://www.douyin.com/',
  })
  const note = await resolveVideoTargetAsync({ url: 'https://v.douyin.com/G8Oggg_IXMA/' }, { fetchImpl })
  assert.equal(note.videoId, '7680883233307342947')
  assert.equal(note.kind, 'note')
  assert.equal(note.url, 'https://www.douyin.com/note/7680883233307342947')

  // 直接贴整段分享文案也要能解析（不需要网络）
  const byText = await resolveVideoTargetAsync(
    { url: '3.21 复制打开抖音，看看 https://www.douyin.com/video/7436613508646702348 作品' },
    { fetchImpl },
  )
  assert.equal(byText.videoId, '7436613508646702348')
  assert.equal(byText.kind, 'video')
})

test('无水印候选：/playwm/ 换成 /play/ 放前面，原地址兜底', () => {
  const urls = [
    'https://v26-web.douyinvod.com/a/playwm/video/tos/x.mp4?sign=1',
    'https://v26-web.douyinvod.com/a/play/video/tos/y.mp4?sign=2',
    'https://v26-web.douyinvod.com/a/playwm/video/tos/x.mp4?sign=1',
  ]
  assert.deepEqual(normalizeMediaCandidates(urls), [
    'https://v26-web.douyinvod.com/a/play/video/tos/x.mp4?sign=1',
    'https://v26-web.douyinvod.com/a/playwm/video/tos/x.mp4?sign=1',
    'https://v26-web.douyinvod.com/a/play/video/tos/y.mp4?sign=2',
  ])
})

test('图集：图片域名白名单 + 去重 + 协议相对地址补齐', () => {
  assert.equal(isAllowedImageUrl('https://p3-pc-sign.douyinpic.com/tos-cn-i-0813/oE7E~tplv-dy-aweme-images:q75.webp'), true)
  assert.equal(isAllowedImageUrl('http://p3-pc-sign.douyinpic.com/x.webp'), false)
  assert.equal(isAllowedImageUrl('https://evil.example/x.jpg'), false)

  const rows = [
    { src: 'https://p3-pc-sign.douyinpic.com/a~tplv-dy-aweme-images:q75.webp' },
    { src: '//p3-pc-sign.douyinpic.com/b~tplv-dy-aweme-images:q75.webp' },
    { src: 'https://p3-pc-sign.douyinpic.com/a~tplv-dy-aweme-images:q75.webp' },
    { src: 'https://evil.example/c.jpg' },
    { src: '' },
  ]
  assert.deepEqual(extractGalleryImageUrls(rows), [
    'https://p3-pc-sign.douyinpic.com/a~tplv-dy-aweme-images:q75.webp',
    'https://p3-pc-sign.douyinpic.com/b~tplv-dy-aweme-images:q75.webp',
  ])
  assert.equal(detectImageExt(WEBP), '.webp')
  assert.equal(detectImageExt(JPG), '.jpg')
  assert.equal(detectImageExt(Buffer.from('<html>403</html>')), null)
})

test('downloadGalleryImages：按文件头认格式、坏图跳过、不写半成品', async () => {
  const dir = makeTmpDir('gallery')
  const fetchImpl = async (url) => {
    if (String(url).includes('bad')) return new Response('<html>403</html>', { status: 200 })
    if (String(url).includes('webp')) return new Response(WEBP, { status: 200 })
    return new Response(JPG, { status: 200 })
  }
  const out = await downloadGalleryImages({
    urls: [
      'https://p3-pc-sign.douyinpic.com/a-webp~tplv-dy-aweme-images:q75.webp',
      'https://p3-pc-sign.douyinpic.com/b-bad.jpg',
      'https://p3-pc-sign.douyinpic.com/c.jpg',
      'https://evil.example/d.jpg',
    ],
    videoId: '7680883233307342947',
    dir,
    fetchImpl,
  })
  assert.equal(out.files.length, 2)
  assert.equal(out.skipped.length, 2)
  assert.deepEqual(readdirSync(dir).sort(), ['7680883233307342947-01.webp', '7680883233307342947-02.jpg'])
  assert.equal(readFileSync(out.files[0].file).length, WEBP.length)
  cleanupDir(dir)
})

test('service.download：图集页无视频流时落成图片，并写 kind=gallery 的 sidecar', async () => {
  const s = setup({
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/' }),
      // 图文页没有 <source src>；作品图在 img[src*=aweme-images] 上
      html: () => ({ ok: true, cmd: 'html', result: '' }),
      list: (payload) => {
        if (payload.selector === 'img[src*="aweme-images"]') {
          return {
            ok: true,
            cmd: 'list',
            result: [
              { text: '', src: 'https://p3-pc-sign.douyinpic.com/a~tplv-dy-aweme-images:q75.webp' },
              { text: '', src: 'https://p3-pc-sign.douyinpic.com/a~tplv-dy-aweme-images:q75.webp' },
              { text: '', src: 'https://p3-pc-sign.douyinpic.com/b~tplv-dy-aweme-images:q75.webp' },
            ],
          }
        }
        return { ok: true, cmd: 'list', result: [] }
      },
      title: () => ({ ok: true, cmd: 'title', result: '图文作品' }),
    },
    fetchImpl: async () => new Response(WEBP, { status: 200 }),
  })
  const r = await s.runtime.service.download({ videoId: '7680883233307342947' })
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'gallery')
  assert.equal(r.count, 2)
  assert.equal(r.files.length, 2)
  for (const item of r.files) assert.equal(existsSync(item.file), true)
  const sidecar = JSON.parse(readFileSync(join(s.dir, 'downloads', '7680883233307342947.json'), 'utf8'))
  assert.equal(sidecar.kind, 'gallery')
  assert.equal(sidecar.images.length, 2)

  // 再下一次：命中 sidecar 直接复用，不再拉图
  const again = await s.runtime.service.download({ videoId: '7680883233307342947' })
  assert.equal(again.cached, true)
  assert.equal(again.count, 2)
  cleanupDir(s.dir)
})
