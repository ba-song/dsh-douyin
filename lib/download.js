/**
 * 抖音视频下载：媒体 URL 提取 + 本地 MP4 落盘 + 时长解析。
 *
 * 安全边界：
 * - 只接受抖音媒体域名（douyinvod/douyin/snssdk 等）的 https URL；
 * - 目标目录固定为配置的 downloadDir，文件名只由数字 videoId 生成；
 * - 单文件硬上限 300MB；写入用临时文件，成功后才 rename 成 <videoId>.mp4；
 * - 不使用 eval/JS，不碰远程任意路径。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DouyinError } from './errors.js'

export const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000
export const VIDEO_ID_RE = /^\d{6,20}$/
/** 图集（/note/<id>）单张上限，抖音图集单张一般 < 5MB */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_GALLERY_IMAGES = 30

const ALLOWED_MEDIA_SUFFIXES = ['douyinvod.com', 'douyin.com', 'snssdk.com', 'bytecdn.cn', 'bytedance.com']
/**
 * 图集图片域名白名单（与视频流分开）。
 * 2026-11-17 实测：图文作品的图片在 `p3-pc-sign.douyinpic.com`（/note/ 页面 DOM 与
 * 第三方解析接口拿到的是同一批 URL）。图片和视频不是同一套 CDN，混进媒体白名单
 * 会让“图片域名”也能当视频下载，所以单独一张表。
 */
const ALLOWED_IMAGE_SUFFIXES = ['douyinpic.com', 'byteimg.com', 'douyin.com']
const AUTHOR_REJECT = /^(我的|未知|抖音|作者|search|douyin|首页|推荐)$/
const MIN_FREE_MARGIN = 16 * 1024 * 1024
const UNKNOWN_LENGTH_RESERVE = 64 * 1024 * 1024

/** 只允许抖音媒体域名的 https 地址（防 SSRF/任意下载） */
export function isAllowedMediaUrl(raw) {
  let u
  try {
    u = new URL(String(raw ?? '').trim())
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()
  return ALLOWED_MEDIA_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

/** 只允许抖音图集图片域名的 https 地址 */
export function isAllowedImageUrl(raw) {
  let u
  try {
    u = new URL(String(raw ?? '').trim())
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()
  return ALLOWED_IMAGE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

/**
 * 媒体候选排序：把 `/playwm/`（带水印版本）换成 `/play/` 放到前面。
 *
 * 2026-11-17 实测：www.douyin.com 播放器的 `<source src>` 已经是 `v26-web.douyinvod.com`
 * 的非 playwm 直链，抽帧检查没有水印；但历史版本/其它入口（H5、分享页）会给
 * `.../playwm/...` 的地址，抖音公开的老办法就是把它换成 `/play/`。这里不假设
 * 一定存在 playwm，只在出现时优先试无水印版本，原地址保留作兜底。
 *
 * @param {string[]} urls
 * @returns {string[]} 去重、保序、无水印优先
 */
export function normalizeMediaCandidates(urls) {
  const out = []
  const seen = new Set()
  const push = (value) => {
    const s = String(value ?? '').trim()
    if (!s || seen.has(s)) return
    seen.add(s)
    out.push(s)
  }
  for (const raw of Array.isArray(urls) ? urls : []) {
    const s = String(raw ?? '').trim()
    if (!s) continue
    if (s.includes('/playwm/')) push(s.replace('/playwm/', '/play/'))
    push(s)
  }
  return out
}

/** 按文件头认图片格式；认不出返回 null（不写错扩展名） */
export function detectImageExt(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif'
  if (
    buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return '.webp'
  }
  return null
}

/** 从 bridge.html('video') 的 outerHTML 里提取 <source src>/<video src>（HTML 实体反解） */
export function extractMediaUrlsFromHtml(html) {
  const text = String(html ?? '')
  const out = []
  const seen = new Set()
  const re = /<(?:source|video)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi
  let m
  while ((m = re.exec(text))) {
    const src = String(m[1]).replace(/&amp;/g, '&').trim()
    if (!isAllowedMediaUrl(src) || seen.has(src)) continue
    seen.add(src)
    out.push(src)
  }
  return out
}

/** 从 bridge.list('video source', attrs:['src']) 的行里提取媒体 URL（保序去重） */
export function extractMediaUrls(rows) {
  const out = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    let src = String(row?.src ?? row?.url ?? '').trim()
    if (!src) continue
    src = src.replace(/&amp;/g, '&')
    if (!isAllowedMediaUrl(src)) continue
    if (seen.has(src)) continue
    seen.add(src)
    out.push(src)
  }
  return out
}


function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function stripTags(text) {
  return decodeEntities(String(text ?? '').replace(/<[^>]*>/g, ' '))
}

/** 作者名清洗：去 @/作者：前缀、标签、空白，限 60 字；明显不是名字的返回 '' */
export function normalizeAuthor(raw) {
  let s = stripTags(raw).replace(/\s+/g, ' ').trim()
  s = s.replace(/^作者[：:]\s*/, '').replace(/^@+/, '').trim()
  s = s.replace(/^["'“”]+|["'“”]+$/g, '').trim()
  if (!s || s.length > 60) return ''
  if (AUTHOR_REJECT.test(s)) return ''
  return s
}

/** 从 JSON-LD（BreadcrumbList/author）取作者；真实视频页 Breadcrumb 第二项是作者 */
export function extractAuthorFromLdJsonHtml(html) {
  const text = String(html ?? '').trim()
  if (!text) return ''
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return ''
  }
  const visit = (node) => {
    if (!node || typeof node !== 'object') return ''
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item)
        if (found) return found
      }
      return ''
    }
    const url = String(node.item?.url ?? node.item ?? node.url ?? node['@id'] ?? '')
    if (/\/user\//i.test(url) && !/\/user\/self/i.test(url)) {
      const name = normalizeAuthor(node.name ?? node.author?.name ?? '')
      if (name) return name
    }
    if (node.author) {
      if (typeof node.author === 'string') {
        const name = normalizeAuthor(node.author)
        if (name) return name
      } else if (typeof node.author === 'object') {
        const name = normalizeAuthor(node.author.name ?? '')
        if (name) return name
      }
    }
    for (const key of ['itemListElement', '@graph', 'author', 'mainEntity']) {
      if (node[key]) {
        const found = visit(node[key])
        if (found) return found
      }
    }
    return ''
  }
  return visit(data)
}

/** 从视频页 HTML 取作者：data-e2e 作者节点 / 非 self 的 user 链接 / meta author / 内嵌 author 字段 */
export function extractAuthorFromHtml(html) {
  const text = String(html ?? '')
  if (!text) return ''
  const attr = text.match(
    /data-e2e=["'](?:video-)?author(?:-name)?["'][^>]*>([\s\S]{0,300}?)<\/(?:div|span|a)>/i,
  )
  if (attr) {
    const name = normalizeAuthor(attr[1])
    if (name) return name
  }
  const links = /<a\b[^>]*href=["']([^"']*\/user\/[^"']*)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi
  let m
  while ((m = links.exec(text))) {
    if (/\/user\/self/i.test(m[1])) continue
    const name = normalizeAuthor(m[2])
    if (name) return name
  }
  const meta = text.match(
    /<meta[^>]+(?:name|property)=["'](?:author|article:author)["'][^>]+content=["']([^"']{1,80})["']/i,
  )
  if (meta) {
    const name = normalizeAuthor(meta[1])
    if (name) return name
  }
  const json = text.match(/"author"\s*:\s*\{[^{}]{0,800}?"nickname"\s*:\s*"([^"]{1,80})"/i)
  if (json) {
    const name = normalizeAuthor(json[1])
    if (name) return name
  }
  const jsonName = text.match(/"(?:authorName|nickname)"\s*:\s*"([^"]{1,80})"/i)
  if (jsonName) {
    const name = normalizeAuthor(jsonName[1])
    if (name) return name
  }
  return ''
}

/** 从页面纯文本/搜索卡片文本取作者：@xxx / 作者：xxx */
export function extractAuthorFromText(text) {
  const clean = stripTags(text)
  if (!clean) return ''
  const byLabel = clean.match(/作者[：:]\s*([^\n]{1,60})/)
  if (byLabel) {
    const name = normalizeAuthor(byLabel[1])
    if (name) return name
  }
  const byAt = clean.match(/(?:^|\s)@([A-Za-z0-9_\u4e00-\u9fa5.\-]{1,40})(?=\s|$|[，。,.!?！？:：])/)
  if (byAt) {
    const raw = byAt[1]
    if (!/\.(?:com|cn|net|org)$/i.test(raw)) {
      const name = normalizeAuthor(raw)
      if (name) return name
    }
  }
  return ''
}

export function sidecarPath(dir, videoId) {
  const id = String(videoId ?? '').trim()
  if (!VIDEO_ID_RE.test(id)) throw new DouyinError('E_BAD_ARG', 'videoId 必须是 6–20 位数字')
  if (typeof dir !== 'string' || !dir.startsWith('/')) throw new DouyinError('E_BAD_ARG', '下载目录必须是绝对路径')
  return join(dir, `${id}.json`)
}

/** 原子写 sidecar；字段：videoId/title/author/file/bytes/seconds/downloadedAt */
export function writeSidecar(dir, meta) {
  const id = String(meta?.videoId ?? '').trim()
  const file = sidecarPath(dir, id)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(tmp, `${JSON.stringify({ ...meta, videoId: id }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
    return file
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // ignore
    }
    throw fsFailure(e, 'sidecar')
  }
}

export function readSidecar(dir, videoId) {
  let file
  try {
    file = sidecarPath(dir, videoId)
  } catch {
    return null
  }
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch {
    return null
  }
}

export function updateSidecar(dir, videoId, patch) {
  const current = readSidecar(dir, videoId)
  if (!current) return null
  const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}), videoId: String(videoId) }
  writeSidecar(dir, next)
  return next
}

function isMp4Head(head) {
  if (!head || head.length < 12) return false
  const type = head.subarray(4, 8).toString('latin1')
  return type === 'ftyp' || type === 'moov'
}

function fsFailure(e, action) {
  const code = String(e?.code ?? '')
  const detail = String(e?.message ?? e).slice(0, 180)
  if (code === 'ENOSPC') return new DouyinError('E_DISK_FULL', `磁盘空间不足（${action}）：${detail}`)
  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'EROFS' ||
    code === 'ENOTDIR' ||
    code === 'EISDIR' ||
    code === 'EEXIST'
  ) {
    return new DouyinError('E_PERMISSION', `下载目录不可写（${action}）：${detail}`)
  }
  return new DouyinError('E_DOWNLOAD_FAILED', `下载失败（${action}）：${detail}`)
}

async function* bodyChunks(body) {
  if (!body) return
  if (Buffer.isBuffer(body)) {
    yield body
    return
  }
  if (typeof body.getReader === 'function') {
    const reader = body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        if (value) yield value
      }
    } finally {
      try {
        reader.releaseLock?.()
      } catch {
        // ignore
      }
    }
    return
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) if (chunk) yield chunk
    return
  }
  throw new DouyinError('E_NO_MEDIA', '媒体响应没有可读的 body')
}

/** 解析 MP4 mvhd 中的时长（秒）；找不到返回 0，不影响下载成功 */
export async function mp4DurationSeconds(file) {
  let fh
  try {
    fh = await openFile(file, 'r')
  } catch {
    return 0
  }
  try {
    const chunkSize = 1024 * 1024
    const chunk = Buffer.allocUnsafe(chunkSize)
    let carry = Buffer.alloc(0)
    let offset = 0
    while (true) {
      const { bytesRead } = await fh.read(chunk, 0, chunkSize, offset)
      if (!bytesRead) return 0
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      let searchFrom = 0
      while (true) {
        const idx = data.indexOf('mvhd', searchFrom, 'latin1')
        if (idx < 0) break
        if (idx + 36 <= data.length) {
          const seconds = parseMvhd(data, idx)
          if (seconds > 0) return seconds
        } else {
          // mvhd 落在 chunk 末尾，按绝对位置补读 40 字节
          const abs = offset - carry.length + idx
          const extra = Buffer.alloc(40)
          const r = await fh.read(extra, 0, 40, abs)
          if (r.bytesRead >= 36) {
            const seconds = parseMvhd(extra, 0)
            if (seconds > 0) return seconds
          }
        }
        searchFrom = idx + 4
      }
      carry = data.subarray(Math.max(0, data.length - 8))
      offset += bytesRead
    }
  } catch {
    return 0
  } finally {
    await fh.close().catch(() => {})
  }
}

function parseMvhd(buf, idx) {
  try {
    const version = buf[idx + 4]
    let timescale
    let duration
    if (version === 1) {
      timescale = buf.readUInt32BE(idx + 24)
      duration = Number(buf.readBigUInt64BE(idx + 28))
    } else {
      timescale = buf.readUInt32BE(idx + 16)
      duration = buf.readUInt32BE(idx + 20)
    }
    if (!timescale || !Number.isFinite(duration) || duration <= 0) return 0
    const seconds = duration / timescale
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10) / 10 : 0
  } catch {
    return 0
  }
}

/**
 * 下载媒体 URL 到 <dir>/<videoId>.mp4。
 * @returns {Promise<{file:string, bytes:number, seconds:number}>}
 */
export async function downloadMedia({
  url,
  videoId,
  dir,
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_DOWNLOAD_BYTES,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  statfsImpl = statfsSync,
} = {}) {
  const id = String(videoId ?? '').trim()
  if (!VIDEO_ID_RE.test(id)) throw new DouyinError('E_BAD_ARG', 'videoId 必须是 6–20 位数字')
  if (typeof dir !== 'string' || !dir.startsWith('/')) throw new DouyinError('E_BAD_ARG', '下载目录必须是绝对路径')
  if (!isAllowedMediaUrl(url)) throw new DouyinError('E_BAD_URL', '媒体地址不在抖音媒体域名白名单内')
  if (typeof fetchImpl !== 'function') throw new DouyinError('E_DOWNLOAD_FAILED', '当前环境不支持下载')

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (e) {
    throw fsFailure(e, 'mkdir')
  }

  const contentLengthFromDisk = (() => {
    try {
      const s = statfsImpl(dir)
      return Number(s.bavail) * Number(s.bsize)
    } catch {
      return null
    }
  })()

  let res
  try {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || DOWNLOAD_TIMEOUT_MS))
      : undefined
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        referer: 'https://www.douyin.com/',
      },
      ...(signal ? { signal } : {}),
    })
  } catch (e) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      throw new DouyinError('E_TIMEOUT', `下载超时（${Math.round(timeoutMs / 1000)}s）`)
    }
    throw new DouyinError('E_NO_MEDIA', `拉取媒体流失败（可能已过期/被拦）：${String(e?.message ?? e).slice(0, 180)}`)
  }

  const status = Number(res?.status)
  if (res?.ok === false || (Number.isFinite(status) && status >= 400)) {
    throw new DouyinError('E_NO_MEDIA', `媒体服务器返回 HTTP ${status || '错误'}（可能已过期/需登录）`)
  }
  if (!res?.body) throw new DouyinError('E_NO_MEDIA', '媒体流为空，请主人在远程浏览器手动保存文件')

  const headerLen = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(headerLen) && headerLen > maxBytes) {
    throw new DouyinError('E_TOO_LARGE', `视频超过单文件上限（${maxBytes} 字节）`)
  }
  if (contentLengthFromDisk !== null) {
    const expected = Number.isFinite(headerLen) && headerLen > 0 ? headerLen : UNKNOWN_LENGTH_RESERVE
    if (contentLengthFromDisk < expected + MIN_FREE_MARGIN) {
      throw new DouyinError('E_DISK_FULL', '磁盘可用空间不足，已取消下载')
    }
  }

  const target = join(dir, `${id}.mp4`)
  const tmp = join(dir, `.${id}.${process.pid}.${Date.now()}.part`)
  let fh = null
  let bytes = 0
  let head = Buffer.alloc(0)
  try {
    fh = await openFile(tmp, 'wx', 0o600)
    for await (const chunk of bodyChunks(res.body)) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (!buf.length) continue
      bytes += buf.length
      if (bytes > maxBytes) throw new DouyinError('E_TOO_LARGE', `视频超过单文件上限（${maxBytes} 字节）`)
      if (head.length < 16) head = Buffer.concat([head, buf.subarray(0, 16 - head.length)])
      await fh.write(buf)
    }
    await fh.close()
    fh = null
    if (!isMp4Head(head)) throw new DouyinError('E_NO_MEDIA', '下载内容不是有效的 MP4（可能已过期/需登录）')
    renameSync(tmp, target)
    const seconds = await mp4DurationSeconds(target)
    return { file: target, bytes, seconds }
  } catch (e) {
    if (fh) await fh.close().catch(() => {})
    rmSync(tmp, { force: true })
    if (e instanceof DouyinError) throw e
    throw fsFailure(e, 'write')
  }
}

/**
 * 下载一组图集图片到 `<dir>/<videoId>-NN.<ext>`。
 *
 * 为什么和视频分开：
 * - 图集是 /note/<id>，页面里没有视频流，只有 `img[src*=aweme-images]`；
 * - 图片 URL 的扩展名常写 `.webp`（实际也是 webp），不能用 MP4 的 ftyp 校验；
 * - 单张几 MB，整体读进内存再按文件头认格式，比流式更简单且不会写错扩展名。
 *
 * 单张失败不抛：跳过并记进 `skipped`，最后只要有一张成功就算成功。
 *
 * @returns {Promise<{files:{file:string,bytes:number}[], skipped:{url:string,reason:string}[]}>}
 */
export async function downloadGalleryImages({
  urls,
  videoId,
  dir,
  fetchImpl = globalThis.fetch,
  maxImages = MAX_GALLERY_IMAGES,
  maxBytes = MAX_IMAGE_BYTES,
  timeoutMs = 60 * 1000,
} = {}) {
  const id = String(videoId ?? '').trim()
  if (!VIDEO_ID_RE.test(id)) throw new DouyinError('E_BAD_ARG', 'videoId 必须是 6–20 位数字')
  if (typeof dir !== 'string' || !dir.startsWith('/')) throw new DouyinError('E_BAD_ARG', '下载目录必须是绝对路径')
  if (typeof fetchImpl !== 'function') throw new DouyinError('E_NO_MEDIA', '当前环境不支持下载')

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (e) {
    throw fsFailure(e, 'mkdir')
  }

  const limit = Math.max(1, Math.min(MAX_GALLERY_IMAGES, Number(maxImages) || MAX_GALLERY_IMAGES))
  const files = []
  const skipped = []
  const seen = new Set()
  for (const raw of Array.isArray(urls) ? urls : []) {
    if (files.length >= limit) break
    const url = String(raw ?? '').trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    if (!isAllowedImageUrl(url)) {
      skipped.push({ url: url.slice(0, 160), reason: '图片地址不在抖音图片域名白名单内' })
      continue
    }
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 60 * 1000))
        : undefined
      const res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          referer: 'https://www.douyin.com/',
        },
        ...(signal ? { signal } : {}),
      })
      const status = Number(res?.status)
      if (res?.ok === false || (Number.isFinite(status) && status >= 400)) {
        skipped.push({ url: url.slice(0, 160), reason: `HTTP ${status || '错误'}` })
        continue
      }
      if (!res?.body) {
        skipped.push({ url: url.slice(0, 160), reason: '响应没有 body' })
        continue
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) {
        skipped.push({ url: url.slice(0, 160), reason: '0 字节' })
        continue
      }
      if (buf.length > maxBytes) {
        skipped.push({ url: url.slice(0, 160), reason: `超过单张上限（${maxBytes} 字节）` })
        continue
      }
      const ext = detectImageExt(buf)
      if (!ext) {
        skipped.push({ url: url.slice(0, 160), reason: '内容不是图片（可能被防盗链拦了）' })
        continue
      }
      const file = join(dir, `${id}-${String(files.length + 1).padStart(2, '0')}${ext}`)
      const tmp = `${file}.${process.pid}.${Date.now()}.part`
      try {
        writeFileSync(tmp, buf, { mode: 0o600 })
        renameSync(tmp, file)
      } catch (e) {
        try {
          rmSync(tmp, { force: true })
        } catch {
          // ignore
        }
        throw fsFailure(e, 'write')
      }
      files.push({ file, bytes: buf.length })
    } catch (e) {
      if (e instanceof DouyinError) throw e
      skipped.push({ url: url.slice(0, 160), reason: String(e?.message ?? e).slice(0, 160) })
    }
  }
  return { files, skipped }
}
