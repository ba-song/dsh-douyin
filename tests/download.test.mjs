import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_DOWNLOAD_BYTES,
  downloadMedia,
  extractAuthorFromHtml,
  extractAuthorFromLdJsonHtml,
  extractAuthorFromText,
  extractMediaUrls,
  extractMediaUrlsFromHtml,
  isAllowedMediaUrl,
  mp4DurationSeconds,
  readSidecar,
  sidecarPath,
  updateSidecar,
  writeSidecar,
} from '../lib/download.js'
import { cleanupDir, makeTmpDir } from './helpers.mjs'

function makeMp4({ timescale = 1000, duration = 12300 } = {}) {
  const ftyp = Buffer.from([0, 0, 0, 16, ...Buffer.from('ftypisom'), 0, 0, 2, 0])
  const mvhd = Buffer.alloc(40)
  mvhd.writeUInt32BE(40, 0)
  mvhd.write('mvhd', 4, 'latin1')
  // version/flags=0；creation/modification=0；timescale/duration
  mvhd.writeUInt32BE(timescale, 20)
  mvhd.writeUInt32BE(duration, 24)
  return Buffer.concat([ftyp, mvhd])
}

function responseFor(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers })
}

const GOOD_URL = 'https://v11-weba.douyinvod.com/video/tos/x.mp4?a=1'

test('媒体 URL：只接受抖音媒体域名 https；html/list 都能解析并去重', () => {
  assert.equal(isAllowedMediaUrl(GOOD_URL), true)
  assert.equal(isAllowedMediaUrl('https://www.douyin.com/aweme/v1/play/?x=1'), true)
  assert.equal(isAllowedMediaUrl('http://v11-weba.douyinvod.com/x.mp4'), false)
  assert.equal(isAllowedMediaUrl('https://evil.example/x.mp4'), false)

  const html = `<video><source src="https://v11-weba.douyinvod.com/a.mp4?a=1&amp;b=2"><source src="https://evil.example/x.mp4"><video src="https://v26-web.douyinvod.com/b.mp4"></video></video>`
  assert.deepEqual(extractMediaUrlsFromHtml(html), [
    'https://v11-weba.douyinvod.com/a.mp4?a=1&b=2',
    'https://v26-web.douyinvod.com/b.mp4',
  ])
  assert.deepEqual(
    extractMediaUrls([
      { src: 'https://www.douyin.com/aweme/v1/play/?x=1' },
      { src: 'https://v11-weba.douyinvod.com/x.mp4' },
      { src: 'https://v11-weba.douyinvod.com/x.mp4' },
      { src: 'https://evil.example/x.mp4' },
    ]),
    ['https://www.douyin.com/aweme/v1/play/?x=1', 'https://v11-weba.douyinvod.com/x.mp4'],
  )
})

test('mp4DurationSeconds：解析 mvhd 的 timescale/duration', async () => {
  const dir = makeTmpDir('mp4dur')
  const file = join(dir, 'a.mp4')
  writeFileSync(file, makeMp4({ timescale: 1000, duration: 12300 }))
  assert.equal(await mp4DurationSeconds(file), 12.3)
  rmSync(file)
  // 找不到 mvhd 返回 0，不影响下载
  writeFileSync(file, Buffer.from('not mp4'))
  assert.equal(await mp4DurationSeconds(file), 0)
  cleanupDir(dir)
})

test('downloadMedia：成功写 <videoId>.mp4，返回 bytes/seconds，无临时文件', async () => {
  const dir = makeTmpDir('download-ok')
  const mp4 = makeMp4()
  let seenUrl = ''
  const fetchImpl = async (url) => {
    seenUrl = url
    return responseFor(mp4, {
      headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) },
    })
  }
  const r = await downloadMedia({ url: GOOD_URL, videoId: '123456789', dir, fetchImpl })
  assert.equal(seenUrl, GOOD_URL)
  assert.equal(r.file, join(dir, '123456789.mp4'))
  assert.equal(r.bytes, mp4.length)
  assert.equal(r.seconds, 12.3)
  assert.deepEqual(readFileSync(r.file), mp4)
  assert.deepEqual(
    readdirSync(dir),
    ['123456789.mp4'],
  )
  cleanupDir(dir)
})

test('downloadMedia：超过大小上限 E_TOO_LARGE，且不留文件', async () => {
  const dir = makeTmpDir('download-large')
  const mp4 = makeMp4()
  const fetchImpl = async () => responseFor(mp4, { headers: { 'content-length': String(mp4.length) } })
  await assert.rejects(
    downloadMedia({ url: GOOD_URL, videoId: '123456789', dir, fetchImpl, maxBytes: 16 }),
    (e) => e.code === 'E_TOO_LARGE',
  )
  assert.deepEqual(readdirSync(dir), [])

  const noLength = async () => responseFor(mp4)
  await assert.rejects(
    downloadMedia({ url: GOOD_URL, videoId: '123456789', dir, fetchImpl: noLength, maxBytes: 16 }),
    (e) => e.code === 'E_TOO_LARGE',
  )
  assert.deepEqual(readdirSync(dir), [])
  cleanupDir(dir)
})

test('downloadMedia：磁盘不足 E_DISK_FULL，不发起下载', async () => {
  const dir = makeTmpDir('download-disk')
  let fetched = 0
  const fetchImpl = async () => {
    fetched += 1
    return responseFor(makeMp4(), { headers: { 'content-length': '1024' } })
  }
  await assert.rejects(
    downloadMedia({
      url: GOOD_URL,
      videoId: '123456789',
      dir,
      fetchImpl,
      statfsImpl: () => ({ bavail: 1, bsize: 1024 }),
    }),
    (e) => e.code === 'E_DISK_FULL',
  )
  assert.equal(fetched, 1) // 先拿到 content-length 再判断磁盘
  assert.deepEqual(readdirSync(dir), [])
  cleanupDir(dir)
})

test('downloadMedia：网络失败/HTTP 失败/非 MP4/无 body → E_NO_MEDIA，且清理临时文件', async () => {
  const dir = makeTmpDir('download-miss')
  const cases = [
    async () => {
      throw new Error('network down')
    },
    async () => responseFor('forbidden', { status: 403 }),
    async () => responseFor('hello, not mp4'),
    async () => ({ ok: true, status: 200, headers: { get: () => null }, body: null }),
  ]
  for (const fetchImpl of cases) {
    await assert.rejects(
      downloadMedia({ url: GOOD_URL, videoId: '123456789', dir, fetchImpl }),
      (e) => e.code === 'E_NO_MEDIA',
    )
    assert.deepEqual(readdirSync(dir), [])
  }
  cleanupDir(dir)
})

test('downloadMedia：目录不可用/无权限 → E_PERMISSION', async () => {
  const dir = makeTmpDir('download-perm')
  const blocked = join(dir, 'blocked')
  writeFileSync(blocked, 'x')
  await assert.rejects(
    downloadMedia({ url: GOOD_URL, videoId: '123456789', dir: blocked, fetchImpl: async () => responseFor(makeMp4()) }),
    (e) => e.code === 'E_PERMISSION',
  )
  cleanupDir(dir)
})

test('常量：单文件 300MB 上限', () => {
  assert.equal(MAX_DOWNLOAD_BYTES, 300 * 1024 * 1024)
})

test('作者解析：JSON-LD user 链接 / data-e2e / 非 self user 链接 / 页面文本', () => {
  const ld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { position: 1, name: '抖音', item: 'https://www.douyin.com' },
      { position: 2, name: '许肆意.', item: 'https://www.douyin.com/user/MS4wLjABAAAA_test' },
    ],
  })
  assert.equal(extractAuthorFromLdJsonHtml(ld), '许肆意.')
  assert.equal(
    extractAuthorFromHtml('<div data-e2e="video-author-name"><span>@作者甲</span></div>'),
    '作者甲',
  )
  assert.equal(
    extractAuthorFromHtml('<a href="https://www.douyin.com/user/MS4wLjABAAAA_x">阿乙</a>'),
    '阿乙',
  )
  assert.equal(extractAuthorFromHtml('<a href="https://www.douyin.com/user/self">我的</a>'), '')
  assert.equal(extractAuthorFromText('作者：丙丁\n其他'), '丙丁')
  assert.equal(extractAuthorFromText('看这个 @戊己 的视频'), '戊己')
  assert.equal(extractAuthorFromText('contact@douyin.com'), '')
  assert.equal(extractAuthorFromText(''), '')
  assert.equal(extractAuthorFromLdJsonHtml('not json'), '')
})

test('sidecar：原子写/读/更新，字段可回读', () => {
  const dir = makeTmpDir('sidecar')
  const meta = {
    videoId: '123456789',
    title: '标题',
    author: '@/作者甲',
    file: join(dir, '123456789.mp4'),
    bytes: 56,
    seconds: 12.3,
    downloadedAt: '2026-11-08T00:00:00.000Z',
  }
  const file = writeSidecar(dir, meta)
  assert.equal(file, sidecarPath(dir, '123456789'))
  const got = readSidecar(dir, '123456789')
  assert.equal(got.title, '标题')
  assert.equal(got.author, '@/作者甲')
  assert.equal(got.videoId, '123456789')
  const next = updateSidecar(dir, '123456789', {
    watchedAt: '2026-11-08T00:10:00.000Z',
    watchMemoryId: 7,
  })
  assert.equal(next.watchMemoryId, 7)
  const reread = readSidecar(dir, '123456789')
  assert.equal(reread.watchedAt, '2026-11-08T00:10:00.000Z')
  assert.equal(reread.watchMemoryId, 7)
  assert.equal(readSidecar(dir, '999999999'), null)
  cleanupDir(dir)
})
