/**
 * 浏览器之外的兜底通道：ttwid + iesdouyin 分享页 SSR。
 *
 * ## 为什么需要（2026-11-17 实测）
 *
 * 我们的主路径是"远程 Chrome 打开作品页 → 读 <source src>"。但如果桥挂了、
 * 页面是 JS 反爬壳、或者视频页没挂载成功，就拿不到直链。这时还有一条纯 HTTP 的路：
 *
 *   ttwid 注册接口 → 带 ttwid 的 iPhone UA 请求 `iesdouyin.com/share/video/<id>/`
 *   → `window._ROUTER_DATA.loaderData` 里 item_list[0].video.play_addr
 *   → `https://www.douyin.com/aweme/v1/play/?video_id=<play_addr.uri>` 302 → CDN mp4
 *
 * ## 踩过的坑（都来自实测，不是推测）
 *
 * 1. **必须带 ttwid**：不带 cookie 时分享页只回 32KB 占位对象（loaderData 里没有
 *    videoInfoRes），看起来像"SSR 失效"，其实只是缺 cookie。ttwid 用
 *    `ttwid.bytedance.com/ttwid/union/register/` 注册最稳（两次独立获取都成功）；
 *    分享页首访有时也会 Set-Cookie，但实测不稳定，不能赌。
 * 2. **必须 iPhone 移动 UA**：桌面 Chrome UA 会被 302 踢回 www.douyin.com（JS 壳）。
 * 3. **键名不能按前缀取第一个**：loaderData 里还有 `video_layout`（值为 null）和
 *    字面量 `video_(id)/page`，dsh-link-parse 就是踩了这个（`^(video_|note_)` 命中
 *    video_layout，于是永远报"item_list 为空"）。这里改成遍历所有键、找真正带
 *    videoInfoRes.item_list 的那个。
 * 4. **图集条目的 play_addr 是背景音乐 mp3**（`douyinstatic.com/...mp3`），
 *    不能当视频直链；图集要走 item.images。
 * 5. **`/playwm/`→`/play/` 去水印是旧办法**：2026-11-17 实测同一作品的 play 与
 *    playwm 跟随后字节完全相同（sha256 一致），所以这里只把它当"候选地址兼容"，
 *    不承诺去水印。
 *
 * 这条通道只做兜底：默认关闭不太可能，但只要主路径拿到直链就不会走它。
 */
import { DouyinError } from './errors.js'

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const TTWID_REGISTER = 'https://ttwid.bytedance.com/ttwid/union/register/'
const SHARE_BASE = 'https://www.iesdouyin.com/share'
const PLAY_ENDPOINT = 'https://www.douyin.com/aweme/v1/play/'
/** ttwid 缓存 30 分钟（实测同一会话内新 ttwid 都可用；跨小时未验证，保守短一点） */
const TTWID_TTL_MS = 30 * 60 * 1000

let ttwidCache = { value: '', at: 0 }

function timeoutSignal(ms) {
  const n = Math.max(1000, Number(ms) || 8000)
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(n)
    : undefined
}

/** 从 Set-Cookie 里抠 ttwid=... 的 name=value 段 */
export function pickTtwidCookie(res) {
  let list = []
  try {
    if (typeof res?.headers?.getSetCookie === 'function') list = res.headers.getSetCookie()
  } catch {
    list = []
  }
  if (!list.length) {
    const raw = res?.headers?.get?.('set-cookie')
    if (raw) list = String(raw).split(/,(?=[^;]+=)/)
  }
  for (const item of list) {
    const m = String(item).match(/(?:^|[;,\s])ttwid=([^;]+)/)
    if (m) return `ttwid=${m[1]}`
  }
  return ''
}

/** 注册一个 ttwid（带 30 分钟缓存）；force=true 强制换新 */
export async function fetchTtwid({ fetchImpl = globalThis.fetch, timeoutMs = 8000, force = false } = {}) {
  const now = Date.now()
  if (!force && ttwidCache.value && now - ttwidCache.at < TTWID_TTL_MS) return ttwidCache.value
  if (typeof fetchImpl !== 'function') throw new DouyinError('E_NO_MEDIA', '当前环境不支持 ttwid 注册')
  let res
  try {
    res = await fetchImpl(TTWID_REGISTER, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': IPHONE_UA },
      body: JSON.stringify({
        region: 'cn',
        aid: 1768,
        needFid: false,
        service: 'www.ixigua.com',
        migrate_info: { ticket: '', source: 'node' },
        cbUrlProtocol: 'https',
        union: true,
      }),
      signal: timeoutSignal(timeoutMs),
    })
  } catch (e) {
    throw new DouyinError('E_NO_MEDIA', `ttwid 注册失败：${String(e?.message ?? e).slice(0, 120)}`)
  }
  if (!res?.ok) throw new DouyinError('E_NO_MEDIA', `ttwid 注册失败 HTTP ${Number(res?.status) || '错误'}`)
  const cookie = pickTtwidCookie(res)
  if (!cookie) throw new DouyinError('E_NO_MEDIA', 'ttwid 注册接口没有下发 ttwid')
  ttwidCache = { value: cookie, at: now }
  return cookie
}

/** 测试/排障用：清掉缓存的 ttwid */
export function resetTtwidCache() {
  ttwidCache = { value: '', at: 0 }
}

/**
 * 从分享页 HTML 里抠出 item_list[0]。
 * 注意遍历所有 loaderData 键，不假设顺序（见文件头 §3）。
 */
export function extractShareItem(html) {
  const text = String(html ?? '')
  const m = text.match(/window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/)
  if (!m) throw new DouyinError('E_NO_MEDIA', '分享页里没有 _ROUTER_DATA（可能被反爬拦了）')
  let data
  try {
    data = JSON.parse(m[1].trim())
  } catch {
    throw new DouyinError('E_NO_MEDIA', '分享页 _ROUTER_DATA 不是合法 JSON')
  }
  const loader = data?.loaderData
  if (!loader || typeof loader !== 'object') throw new DouyinError('E_NO_MEDIA', '分享页 loaderData 为空')
  for (const [key, value] of Object.entries(loader)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const list = value?.videoInfoRes?.item_list
    if (Array.isArray(list) && list[0]) return list[0]
    void key
  }
  // 只有"占位对象"= 没带 ttwid，或作品已删除/私密
  throw new DouyinError('E_NO_MEDIA', '分享页没有作品数据（可能 ttwid 失效、作品已删除或仅作者可见）')
}

/** 选一张不带水印标记的图（分享页 image 对象有 url_list / download_url_list） */
export function pickShareImage(image) {
  if (!image || typeof image !== 'object') return ''
  for (const field of ['url_list', 'download_url_list']) {
    const list = image[field]
    if (!Array.isArray(list)) continue
    for (const url of list) {
      if (typeof url === 'string' && url && !url.includes('-water:')) return url
    }
  }
  return ''
}

/** 把分享页 item 转成我们的下载所需字段 */
export function mediaFromShareItem(item) {
  const images = Array.isArray(item?.images) ? item.images.map(pickShareImage).filter(Boolean) : []
  const playAddr = item?.video?.play_addr ?? {}
  const uri = String(playAddr.uri ?? '')
  const looksLikeAudio = (url) => {
    let decoded = url
    try {
      decoded = decodeURIComponent(url)
    } catch {
      decoded = url
    }
    // 图集条目的 play_addr 是背景音乐：直接 .mp3，或被 playwm 端点包成
    // `playwm/?video_id=https%3A%2F%2F…mp3&ratio=720p`（实测 2026-11-17）
    return /\.mp3(?:[?&#]|$)/i.test(decoded) || /ies-music/i.test(decoded)
  }
  const playUrls = (Array.isArray(playAddr.url_list) ? playAddr.url_list : [])
    .filter((u) => typeof u === 'string' && u)
    .filter((u) => !looksLikeAudio(u))
  const title = String(item?.desc ?? '').trim()
  return {
    kind: images.length ? 'gallery' : 'video',
    images,
    videoUri: uri,
    playUrls,
    title: title.split('\n')[0].slice(0, 120),
    description: title,
    author: String(item?.author?.nickname ?? '').trim(),
    durationSec: Number(item?.video?.duration) > 0 ? Math.round(Number(item.video.duration) / 1000) : 0,
  }
}

/** 用 play_addr.uri 换 302 播放地址（downloadMedia 会自己跟 302） */
export function playEndpointUrl(videoUri, { ratio = '720p' } = {}) {
  const uri = String(videoUri ?? '').trim()
  if (!uri) return ''
  return `${PLAY_ENDPOINT}?video_id=${encodeURIComponent(uri)}&ratio=${encodeURIComponent(ratio)}&line=0`
}

/**
 * 拉一条作品的分享页数据（ttwid + iPhone UA）。
 * @returns {Promise<{item:object, media:object, ttwidUsed:string}>}
 */
export async function fetchShareItem(videoId, { fetchImpl = globalThis.fetch, timeoutMs = 15000, kind = 'video' } = {}) {
  const id = String(videoId ?? '').trim()
  if (!/^\d{6,20}$/.test(id)) throw new DouyinError('E_BAD_ARG', '作品 id 必须是 6–20 位数字')
  if (typeof fetchImpl !== 'function') throw new DouyinError('E_NO_MEDIA', '当前环境不支持分享页兜底')
  const cookie = await fetchTtwid({ fetchImpl, timeoutMs })
  const url = `${SHARE_BASE}/${kind === 'note' ? 'note' : 'video'}/${id}/`
  let res
  try {
    res = await fetchImpl(url, {
      headers: {
        'user-agent': IPHONE_UA,
        accept: 'text/html,application/xhtml+xml,*/*',
        cookie,
      },
      signal: timeoutSignal(timeoutMs),
    })
  } catch (e) {
    throw new DouyinError('E_NO_MEDIA', `分享页请求失败：${String(e?.message ?? e).slice(0, 120)}`)
  }
  if (!res?.ok) throw new DouyinError('E_NO_MEDIA', `分享页 HTTP ${Number(res?.status) || '错误'}`)
  const html = await res.text()
  const item = extractShareItem(html)
  return { item, media: mediaFromShareItem(item), ttwidUsed: cookie }
}
