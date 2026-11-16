/**
 * dsh-douyin 业务层：读工具 + 显式写操作（like/favorite/评论草稿）的实现。
 *
 * 所有方法：
 * - 返回结构化对象，不把异常抛给宿主；
 * - 经过 RateLimiter 闸门（时段/配额/最小间隔），由外层 SerialQueue 保证串行；
 * - click 仅用于搜索卡片/评论展开/显式写操作；真实写必须 confirm:true；不做 eval/登录/私信/发布。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DouyinError, errorCode, toFailure } from './errors.js'
import { assertSafeShotPath } from './transport.js'
import {
  downloadMedia,
  extractAuthorFromHtml,
  extractAuthorFromLdJsonHtml,
  extractAuthorFromText,
  extractMediaUrls,
  extractMediaUrlsFromHtml,
  readSidecar,
  writeSidecar,
} from './download.js'
import { getVerifiedAction, recordLedger, removeLedger } from './write-ledger.js'

const DOUYIN_HOSTS = new Set(['www.douyin.com', 'douyin.com', 'm.douyin.com'])
const SHORT_HOSTS = new Set(['v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'])
const VIDEO_ID_RE = /^\d{6,20}$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MINUTE_MS = 60 * 1000
const SEARCH_RETRY_WAIT_MS = 2000
const SEARCH_LINK_RETRIES = 3
const SEARCH_LINK_WAIT_MS = 1000
const RETRYABLE_SEARCH_CODES = new Set([
  'E_SELECTOR_MISS',
  'E_TIMEOUT',
  'E_OPEN_TIMEOUT',
  'E_REMOTE_IO',
])
const DOWNLOAD_QUALITIES = new Set(['best', 'source', '720p', '1080p', '540p'])
const SEARCH_TYPES = new Set(['general', 'video', 'user', 'live'])
const SEARCH_NAV_TEXTS = new Set([
  '我的', '登录', '搜索', '首页', '关注', '朋友', '推荐', '消息', '投稿', '客户端', '下载抖音',
  '抖音电商', '综合', '视频', '用户', '直播', '商品', '音乐', '话题', '地点', '更多', '全部',
])

function normalizeDownloadQuality(value) {
  if (value === undefined || value === null || value === '') return 'best'
  const q = String(value).trim().toLowerCase()
  if (!DOWNLOAD_QUALITIES.has(q)) {
    throw new DouyinError('E_BAD_ARG', 'quality 只接受 best/source/720p/1080p/540p')
  }
  return q
}

const pad2 = (n) => String(n).padStart(2, '0')

function cut(text, max) {
  const chars = Array.from(String(text ?? ''))
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('')
}

function squash(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function asIntInRange(value, min, max, name) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new DouyinError('E_BAD_ARG', `${name} 必须是 ${min}–${max} 的整数`)
  }
  return n
}

const hash12 = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 12)

// ===== 主人身份 / 稳定 id（私信与通知共用）=====
// 2026-11-14 主人确认：通知备注可能是「饲养员」，抖音显示名是「草荧」；
// dm-owner.txt 第一行仍是最高优先级，和 dmOwnerAliases 取并集后统一比对。
const DM_MESSAGE_ID_RE = /^(dmc_[a-f0-9]{12}(?:-\d{1,3})?)\.(m_[a-f0-9]{12}(?:-\d{1,3})?)$/

/** 名字归一化：去 @、去空白、大小写不敏感（只用于“是不是主人”判断） */
export function normalizeOwnerKey(name) {
  return String(name ?? '').replace(/^@+/, '').replace(/\s+/g, '').toLowerCase()
}

/** 会话名/通知作者是否主人：命中别名列表（饲养员 / 草荧 / dm-owner.txt 第一行） */
export function isOwnerDisplayName(name, aliases = []) {
  const key = normalizeOwnerKey(name)
  if (!key) return false
  return (Array.isArray(aliases) ? aliases : []).some((a) => normalizeOwnerKey(a) === key)
}

/** 合并别名列表：去空/去 @/去重，保留顺序 */
export function mergeOwnerAliases(...groups) {
  const out = []
  const seen = new Set()
  for (const group of groups) {
    for (const raw of Array.isArray(group) ? group : [group]) {
      const s = String(raw ?? '').trim().replace(/^@+/, '')
      const key = normalizeOwnerKey(s)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(s)
    }
  }
  return out
}

/** 会话稳定 id：dmc_<归一化名字 hash>；同名会话按出现顺序加 -2/-3 */
export function dmConversationId(name) {
  return `dmc_${hash12(normalizeOwnerKey(name) || String(name ?? ''))}`
}

/** 同 base 的重复项按出现顺序补 -2/-3；index 是当前快照里的位置（0 基） */
function assignOccurrenceIds(items, baseFn) {
  const counts = new Map()
  return (Array.isArray(items) ? items : []).map((item, index) => {
    const base = baseFn(item, index)
    const n = (counts.get(base) ?? 0) + 1
    counts.set(base, n)
    return { ...item, id: n === 1 ? base : `${base}-${n}`, index }
  })
}

/** 会话列表加稳定 id / 位置 / isOwner */
export function assignDmConversationIds(items, ownerAliases = []) {
  return assignOccurrenceIds(items, (c) => dmConversationId(c?.name)).map((c) => ({
    ...c,
    isOwner: isOwnerDisplayName(c?.name, ownerAliases),
  }))
}

/**
 * 消息列表加稳定 id / 位置 / isOwner。
 * id = <conversationId>.m_<fromMe|text|time 的 hash>，dmSend 可只凭 messageId 反推会话；
 * 同一条消息重复出现（相同 fromMe/text/time）按顺序加 -2/-3。
 */
export function assignDmMessageIds(items, conversationId, { conversationOwner = false } = {}) {
  const convId = String(conversationId ?? '').trim()
  if (!convId) throw new DouyinError('E_BAD_ARG', 'conversationId 不能为空')
  return assignOccurrenceIds(Array.isArray(items) ? items : [], (m) => {
    // 只用方向 + 正文做 base：时间标签会随分组变化（刚刚→1分钟前），带上会破坏 id 稳定性
    const key = [m?.fromMe === true ? 'me' : 'them', squash(m?.text ?? '')].join('\u0001')
    return `${convId}.m_${hash12(key)}`
  }).map((m) => ({
    ...m,
    isOwner: conversationOwner === true && m?.fromMe !== true,
  }))
}

/** 解析 dm_read 返回的 messageId → 所属会话 id；不合法返回错误对象（不猜） */
export function parseDmMessageId(raw) {
  const s = String(raw ?? '').trim()
  const m = s.match(DM_MESSAGE_ID_RE)
  if (!m) return { ok: false, code: 'E_BAD_ARG', message: 'messageId 不合法（应使用 dm_read/dm_list 返回的 id）' }
  return { ok: true, conversationId: m[1], messageId: s }
}

/** /chat 消息行 → {fromMe,text,time}；时间标签是分组分隔，挂到后面第一条消息 */
export function parseDmMessageRows(rows) {
  let timeLabel = ''
  const items = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const cls = String(row?.class ?? '')
    if (cls.includes('MessageBoxTimetimeLayout')) {
      timeLabel = squash(row?.text ?? '')
      continue
    }
    if (!cls.includes('MessageItemTextcontainer')) continue
    items.push({ fromMe: cls.includes('isFromMe'), text: squash(row?.text ?? ''), time: timeLabel })
  }
  return items
}

/**
 * 在会话列表里精确定位一条：conversationId > index > name（重名 E_AMBIGUOUS）。
 * 同时给多个选择器时只做一致性校验，指向不同会话返回 E_BAD_ARG。
 */
export function resolveDmConversation(items, { name = '', conversationId = '', index = null } = {}) {
  const list = Array.isArray(items) ? items : []
  const wantedName = squash(name)
  const wantedId = String(conversationId ?? '').trim()
  if (Number.isInteger(index)) {
    if (index < 0 || index >= list.length) {
      return { ok: false, code: 'E_NOT_FOUND', message: `index=${index} 超出当前会话数 ${list.length}` }
    }
    const item = list[index]
    if (wantedId && item.id !== wantedId) {
      return { ok: false, code: 'E_BAD_ARG', message: 'index 与 conversationId 指向不同会话' }
    }
    if (wantedName && squash(item.name) !== wantedName) {
      return { ok: false, code: 'E_BAD_ARG', message: 'index 与 name 指向不同会话' }
    }
    return { ok: true, index, item }
  }
  if (wantedId) {
    const hits = []
    list.forEach((c, i) => { if (c?.id === wantedId) hits.push(i) })
    if (!hits.length) return { ok: false, code: 'E_NOT_FOUND', message: `没有找到会话 id=${wantedId}` }
    if (hits.length > 1) {
      return { ok: false, code: 'E_AMBIGUOUS', message: `会话 id=${wantedId} 匹配到 ${hits.length} 条`, indexes: hits }
    }
    const item = list[hits[0]]
    if (wantedName && squash(item.name) !== wantedName) {
      return { ok: false, code: 'E_BAD_ARG', message: 'conversationId 与 name 指向不同会话' }
    }
    return { ok: true, index: hits[0], item }
  }
  if (!wantedName) return { ok: false, code: 'E_BAD_ARG', message: '需要 name / conversationId / index 之一' }
  const exact = []
  list.forEach((c, i) => { if (squash(c?.name) === wantedName) exact.push(i) })
  if (!exact.length) return { ok: false, code: 'E_NOT_FOUND', message: `没有找到会话「${wantedName}」` }
  if (exact.length > 1) {
    return {
      ok: false,
      code: 'E_AMBIGUOUS',
      message: `会话「${wantedName}」匹配到 ${exact.length} 条，请用 conversationId/index 指定`,
      indexes: exact,
      candidates: exact.map((i) => ({
        id: list[i].id,
        index: i,
        name: list[i].name,
        preview: list[i].preview,
        time: list[i].time,
      })),
    }
  }
  return { ok: true, index: exact[0], item: list[exact[0]] }
}

export function isDouyinHost(hostname) {
  return DOUYIN_HOSTS.has(String(hostname ?? '').toLowerCase())
}

/** 是否抖音首页（path 为 /） */
export function isHomeUrl(raw) {
  try {
    const u = new URL(String(raw ?? ''))
    return (u.protocol === 'https:' || u.protocol === 'http:') && isDouyinHost(u.hostname) && (u.pathname === '/' || u.pathname === '')
  } catch {
    return false
  }
}

/** 只接受 douyin.com/video/<数字>；统一成 https://www.douyin.com/video/<id> */
export function parseVideoUrl(raw) {
  let u
  try {
    u = new URL(String(raw ?? '').trim())
  } catch {
    throw new DouyinError('E_BAD_URL', '视频 URL 格式不合法')
  }
  if (u.protocol !== 'https:') throw new DouyinError('E_BAD_URL', '视频 URL 必须是 https')
  if (!isDouyinHost(u.hostname)) throw new DouyinError('E_BAD_URL', '只允许 douyin.com 域名')
  const m = u.pathname.match(/^\/video\/(\d{6,20})\/?$/) || u.pathname.match(/^\/share\/video\/(\d{6,20})\/?$/)
  if (!m) throw new DouyinError('E_BAD_URL', '只允许 douyin.com/video/<数字> 形式的地址')
  return { videoId: m[1], url: `https://www.douyin.com/video/${m[1]}` }
}

/** {videoId|url} → 规范化目标；两者都传时要求指向同一条视频 */
export function resolveVideoTarget(args = {}) {
  const rawId = args?.videoId === undefined || args?.videoId === null ? '' : String(args.videoId).trim()
  const rawUrl = args?.url === undefined || args?.url === null ? '' : String(args.url).trim()
  let id = ''
  if (rawId) {
    if (!VIDEO_ID_RE.test(rawId)) throw new DouyinError('E_BAD_ARG', 'videoId 必须是 6–20 位数字')
    id = rawId
  }
  if (rawUrl) {
    const parsed = parseVideoUrl(rawUrl)
    if (id && parsed.videoId !== id) throw new DouyinError('E_BAD_ARG', 'videoId 与 url 指向不同视频')
    id = parsed.videoId
  }
  if (!id) throw new DouyinError('E_BAD_ARG', '需要 videoId 或 url')
  return { videoId: id, url: `https://www.douyin.com/video/${id}` }
}

/** 短链：v.douyin.com / iesdouyin.com/share/video/<id> → 规范 video URL */
export async function resolveVideoTargetAsync(args = {}, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const rawUrl = args?.url === undefined || args?.url === null ? '' : String(args.url).trim()
  if (!rawUrl) return resolveVideoTarget(args)
  let u
  try { u = new URL(rawUrl) } catch { throw new DouyinError('E_BAD_URL', '视频 URL 格式不合法') }
  const host = String(u.hostname || '').toLowerCase()
  if (host === 'iesdouyin.com' || host === 'www.iesdouyin.com') {
    const m = u.pathname.match(/^\/share\/video\/(\d{6,20})\/?$/)
    if (m) return { videoId: m[1], url: `https://www.douyin.com/video/${m[1]}` }
    throw new DouyinError('E_BAD_URL', 'iesdouyin 分享页缺少视频 id')
  }
  if (host !== 'v.douyin.com') return resolveVideoTarget(args)
  if (typeof fetchImpl !== 'function') throw new DouyinError('E_BAD_URL', '当前环境不支持短链解析')
  let res
  try {
    res = await fetchImpl(rawUrl, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new DouyinError('E_BAD_URL', `短链解析失败：${String(e?.message ?? e).slice(0, 120)}`)
  }
  const finalUrl = String(res?.url ?? '')
  if (!finalUrl) throw new DouyinError('E_BAD_URL', '短链没有跳转到视频页')
  try { return parseVideoUrl(finalUrl) } catch {}
  const m = finalUrl.match(/\/share\/video\/(\d{6,20})/)
  if (m) return { videoId: m[1], url: `https://www.douyin.com/video/${m[1]}` }
  throw new DouyinError('E_BAD_URL', '短链跳转后不是视频页')
}

/** 从 list 结果里提取视频卡片；href 在属性上，不是 <a> */
export function parseVideoItems(rows, maxText = 120) {
  const out = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const href = String(row?.href ?? row?.url ?? '')
    const directId = String(row?.['data-e2e-vid'] ?? row?.videoId ?? '').trim()
    const m = href.match(/\/video\/(\d{6,20})(?:[/?#]|$)/) || directId.match(/^(\d{6,20})$/)
    if (!m) continue
    const id = m[1]
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      videoId: id,
      url: `https://www.douyin.com/video/${id}`,
      text: cut(squash(row?.text ?? ''), maxText),
    })
  }
  return out
}

/** 评论里那些操作按钮/标记行，不算正文 */
const COMMENT_NOISE = /^(分享|回复|作者|置顶|展开\s*\d+\s*条回复|收起)$/

/** 时间行：刚刚 / 3小时前·河南 / 昨天 12:30 / 2024-05-01 */
const COMMENT_TIME = /^(刚刚|昨天|前天|\d+\s*(秒|分钟|小时|天|周|月|年)前|\d{4}-\d{2}-\d{2})(·|$|\s)/

/** 一条评论的文本按 "..." 切成若干段：第一段是主评论，后面是折叠着的回复 */
function splitCommentSegments(lines) {
  const dots = []
  lines.forEach((x, i) => {
    if (x === '...' || x === '…') dots.push(i)
  })
  if (!dots.length) return [{ author: '', lines }]
  const segs = []
  for (let k = 0; k < dots.length; k += 1) {
    const dot = dots[k]
    const start = dot + 1
    const end = k + 1 < dots.length ? Math.max(start, dots[k + 1] - 1) : lines.length
    if (k === 0) {
      segs.push({ author: lines[0], byAuthor: false, lines: lines.slice(start, end) })
      continue
    }
    // 省略号上面那行可能只是「作者/置顶」标记，真名还得再往上找
    let author = ''
    let byAuthor = false
    for (let i = dot - 1; i >= 0; i -= 1) {
      const s = lines[i]
      if (!s) continue
      if (s === '作者') { byAuthor = true; continue }
      if (COMMENT_NOISE.test(s)) continue
      author = s
      break
    }
    segs.push({ author, byAuthor, lines: lines.slice(start, end) })
  }
  return segs
}

function parseCommentSegment(seg, maxText) {
  const timeIdx = seg.lines.findIndex((x) => COMMENT_TIME.test(x))
  const beforeTime = timeIdx >= 0 ? seg.lines.slice(0, timeIdx) : seg.lines
  const afterTime = timeIdx >= 0 ? seg.lines.slice(timeIdx + 1) : []
  const body = cut(squash(beforeTime.filter((x) => !COMMENT_NOISE.test(x)).join(' ')), maxText)
  const likes = afterTime.find((x) => /^\d+$/.test(x)) ?? null
  const time = timeIdx >= 0 ? squash(seg.lines[timeIdx]) : null
  return { body, likes: likes === null ? null : Number(likes), time }
}

/** 评论时间标签 → 距今毫秒；解析不了（日期/昨天/天周月年）返回 null = 过期 */
export function parseCommentAgeMs(label, now = Date.now()) {
  const text = squash(String(label ?? '').split('·')[0])
  if (!text) return null
  if (text === '刚刚') return 0
  let m = text.match(/^(\d+)\s*秒前$/)
  if (m) return Number(m[1]) * 1000
  m = text.match(/^(\d+)\s*分钟前$/)
  if (m) return Number(m[1]) * MINUTE_MS
  m = text.match(/^(\d+)\s*小时前$/)
  if (m) return Number(m[1]) * 60 * MINUTE_MS
  return null
}

export function parseCommentItems(rows, maxText = 200) {
  const out = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const raw = String(row?.text ?? '')
    const lines = raw.split(/\n+/).map((x) => squash(x)).filter(Boolean)
    if (!lines.length || lines[0] === '加载中') continue
    const segs = splitCommentSegments(lines)
    const head = parseCommentSegment(segs[0], maxText)
    if (!head.body) continue
    // 折叠着的回复单独摘出来，别整段丢掉
    const replies = []
    for (const seg of segs.slice(1)) {
      const r = parseCommentSegment(seg, maxText)
      if (!r.body) continue
      replies.push({
        author: cut(squash(seg.author), 60) || null,
        text: r.body,
        likes: r.likes,
        time: r.time ?? null,
        ...(seg.byAuthor ? { byAuthor: true } : {}),
      })
    }
    const reply = raw.match(/展开\s*(\d+)\s*条回复/)
    out.push({
      author: cut(squash(segs[0].author), 60) || null,
      text: head.body,
      likes: head.likes,
      time: head.time ?? null,
      replyCount: Math.max(reply ? Number(reply[1]) : 0, replies.length),
      replies,
    })
  }
  return out
}

/** 通知面板里常见的关系标签（不是动作） */
const NOTIFY_RELATIONS = new Set(['朋友', '粉丝', 'AI分身', '作者', '互关', '关注'])

/**
 * 主站「通知/互动消息」一条 innerText 的动作规则（2026-11-14 真机抓取）：
 *   饲养员 朋友 @汐 在评论中提到了你星期三
 *   豆包 AI分身 <回复正文> 回复了你的评论星期三
 *   叹- 赞了你的评论 11-01
 *   疏淮 等5人赞了你的评论 10-04
 *   天空 赞了你的弹幕 10-25
 *   往事不堪回首 关注了你 09-08 回关
 * 动作词与时间可能在同一行（“…提到了你星期三”），所以取“最后出现的动作词”再切时间。
 */
const NOTIFY_ACTIONS = [
  { re: /等(\d+)人赞了你的评论/, type: 'like_comment', like: true },
  { re: /等(\d+)人赞了你的弹幕/, type: 'like_danmaku', like: true },
  { re: /赞了你的评论/, type: 'like_comment', like: true },
  { re: /赞了你的弹幕/, type: 'like_danmaku', like: true },
  { re: /回复了你的评论/, type: 'comment_reply' },
  // 2026-11-15 真机抓到的另一种回复文案：「…在你的评论下回复昨天」
  { re: /在你的评论下回复/, type: 'comment_reply' },
  { re: /在评论中提到了你/, type: 'mention' },
  { re: /关注了你/, type: 'follow' },
]

const NOTIFY_TIME_RE = /(刚刚|\d+\s*(?:秒|分钟|小时|天)前|昨天|前天|星期[一二三四五六日天]|\d{1,2}-\d{1,2}|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2})/

function pickNotifyAction(body) {
  let best = null
  for (const rule of NOTIFY_ACTIONS) {
    const re = new RegExp(rule.re.source, 'g')
    let m
    while ((m = re.exec(body)) !== null) {
      const hit = { ...rule, index: m.index, end: m.index + m[0].length, length: m[0].length, raw: m[0], groups: m.slice(1) }
      // 取“最靠后结束”的动作词；同一结束位置取更长的（“等5人赞了你的评论”优先于“赞了你的评论”）
      if (!best || hit.end > best.end || (hit.end === best.end && hit.length > best.length)) best = hit
      if (m.index === re.lastIndex) re.lastIndex += 1
    }
  }
  return best
}

function extractNotifyTime(tail) {
  // 「回关」是关注通知里的按钮文案，不是时间
  const text = squash(String(tail ?? '').replace(/(回关|已关注|去回复|查看)/g, ' '))
  const m = text.match(NOTIFY_TIME_RE)
  return m ? squash(m[1]) : ''
}

/** 通知相对时间归一：刚刚/N秒前/N分钟前/N小时前 → recent，避免同一通知时间标签变化后 id 漂移 */
export function normalizeNotifyTime(label) {
  const text = String(label ?? '').trim()
  return /刚刚|秒前|分钟前|小时前/.test(text) ? 'recent' : text
}

/** 通知条目的稳定 base id：type+actor+text+归一化时间；重复项由 parseNotifyItems 补 -2/-3 */
export function notifyItemId(item) {
  const parts = [item?.type, item?.actor, item?.text, normalizeNotifyTime(item?.time)].map((x) => String(x ?? ''))
  return `ntf_${hash12(parts.join('\u0001'))}`
}

/** 通知是否“结构上可回复”，以及是否在新鲜窗口内（windowMs=0 表示不限旧消息） */
export function isNotifyReplyable(item, { windowMs = 0, now = Date.now() } = {}) {
  if (item?.type !== 'mention' && item?.type !== 'comment_reply') return false
  if (!(Number(windowMs) > 0)) return true
  const age = Number(item?.ageMs)
  return Number.isFinite(age) && age >= 0 && age <= Number(windowMs)
}

/**
 * 只读解析通知面板条目；纯函数，测试可直接断言。
 * 返回 {id,index,actor,relation,type,text,time,ageMs,likeCount,isOwner,replyable,videoId,commentId,replySupported}。
 * id 来自 type+actor+text+归一化时间的 hash（同一快照里重复才加 -2/-3），index 是当前列表位置（0 基）。
 * 面板 DOM 里没有视频/评论链接，也没有「回复」按钮，所以 videoId/commentId 恒为 null。
 * ownerAliases 用于 isOwner（生产传 cfg.dmOwnerAliases + dm-owner.txt 第一行）。
 * replyWindowMs/now 用于 replyable；缺省 0=只看类型（mention/comment_reply）。
 */
export function parseNotifyItems(rows, maxText = 500, { ownerAliases = [], replyWindowMs = 0, now = Date.now() } = {}) {
  const raw = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = String(row?.text ?? '').replace(/\r/g, '').trim()
    if (!text || text === '点击加载更多' || text === '加载中' || text === '没有更多了') continue
    const lines = text.split(/\n+/).map((x) => squash(x)).filter(Boolean)
    if (!lines.length) continue
    const action = pickNotifyAction(lines.join('\n'))
    if (!action) continue
    const actor = cut(lines[0], 60)
    let idx = 1
    let relation = null
    if (idx < lines.length && NOTIFY_RELATIONS.has(lines[idx])) {
      relation = lines[idx]
      idx += 1
    }
    const body = lines.slice(idx).join('\n')
    const pos = body.lastIndexOf(action.raw)
    const before = pos >= 0 ? body.slice(0, pos) : ''
    const after = pos >= 0 ? body.slice(pos + action.raw.length) : ''
    const time = extractNotifyTime(after)
    const likeCount = action.like ? (action.groups?.[0] ? Number(action.groups[0]) : 1) : null
    raw.push({
      actor,
      relation,
      type: action.type,
      text: cut(squash(before), maxText),
      time,
      ageMs: parseCommentAgeMs(time),
      likeCount: Number.isFinite(likeCount) ? likeCount : null,
      isOwner: isOwnerDisplayName(actor, ownerAliases),
      replyable: isNotifyReplyable({ type: action.type, ageMs: parseCommentAgeMs(time) }, { windowMs: replyWindowMs, now }),
      videoId: null,
      commentId: null,
      replySupported: false,
    })
  }
  return assignOccurrenceIds(raw, (item) => notifyItemId(item))
}

function notifyTargetMatches(item, needle) {
  const lower = String(needle ?? '').trim().toLowerCase()
  if (!lower) return false
  const actor = String(item?.actor ?? '').trim().toLowerCase()
  const text = String(item?.text ?? '').toLowerCase()
  return Boolean((actor && actor === lower) || (text && text.includes(lower)))
}

/**
 * 在通知 items 里精确定位目标：id（来自 notifyList）> index（0 基）> target（作者精确优先/正文包含）。
 * 多条目命中但没给 id/index → E_AMBIGUOUS；id 与 target/index 指向不同条目 → E_BAD_ARG。
 * 纯函数，测试可直接断言。
 */
export function pickNotifyTarget(items, { target = '', index = null, id = '' } = {}) {
  const list = Array.isArray(items) ? items : []
  const wantedId = String(id ?? '').trim()
  if (wantedId) {
    const hits = []
    list.forEach((item, i) => { if (String(item?.id ?? '') === wantedId) hits.push(i) })
    if (!hits.length) {
      return { ok: false, code: 'E_NOT_FOUND', message: `id=${wantedId} 不在当前已加载通知里，请重新 notify_list` }
    }
    if (hits.length > 1) {
      return { ok: false, code: 'E_AMBIGUOUS', message: `id=${wantedId} 匹配到 ${hits.length} 条通知`, indexes: hits }
    }
    const item = list[hits[0]]
    if (String(target ?? '').trim() && !notifyTargetMatches(item, target)) {
      return { ok: false, code: 'E_BAD_ARG', message: 'id 与 target 指向不同通知', indexes: [hits[0]] }
    }
    if (Number.isInteger(index) && index !== hits[0]) {
      return { ok: false, code: 'E_BAD_ARG', message: 'id 与 index 指向不同通知', indexes: [hits[0]] }
    }
    return { ok: true, index: hits[0], item }
  }
  if (Number.isInteger(index)) {
    if (index < 0 || index >= list.length) {
      return { ok: false, code: 'E_NOT_FOUND', message: `index=${index} 超出当前通知条数 ${list.length}` }
    }
    const item = list[index]
    if (String(target ?? '').trim() && !notifyTargetMatches(item, target)) {
      return { ok: false, code: 'E_BAD_ARG', message: 'index 与 target 指向不同通知', indexes: [index] }
    }
    return { ok: true, index, item }
  }
  const needle = String(target ?? '').trim()
  if (!needle) return { ok: false, code: 'E_BAD_ARG', message: '需要 id / index / target 之一' }
  const lower = needle.toLowerCase()
  const exact = []
  const loose = []
  list.forEach((item, i) => {
    const actor = String(item?.actor ?? '').trim().toLowerCase()
    const text = String(item?.text ?? '').toLowerCase()
    if (actor && actor === lower) exact.push(i)
    else if (text && text.includes(lower)) loose.push(i)
  })
  const hits = exact.length ? exact : loose
  if (!hits.length) return { ok: false, code: 'E_NOT_FOUND', message: `当前通知里没有匹配「${needle}」的` }
  if (hits.length > 1) {
    return {
      ok: false,
      code: 'E_AMBIGUOUS',
      message: `匹配到 ${hits.length} 条通知，请用 id 或 index 指定（0 基）`,
      indexes: hits,
    }
  }
  return { ok: true, index: hits[0], item: list[hits[0]] }
}

/**
 * 通知入口角标探测：只读 header 通知按钮的 HTML/文本/子元素，不开面板。
 * 返回 {available,count,dot,mode,signature}；signature 用于 watcher 判断“角标变了”。
 * mode=count（数字角标）/dot（红点类）/html（兜底，只有显式开启 notifyWatchBadgeHtmlFallback 才当触发）。
 */
export function parseNotifyBadge({ html = '', text = '', children = [] } = {}) {
  const kids = Array.isArray(children) ? children : []
  let count = 0
  let dot = false
  for (const row of kids) {
    const t = squash(row?.text ?? '')
    const cls = `${row?.class ?? ''} ${row?.['data-e2e'] ?? ''}`
    if (/^\d{1,3}\+?$/.test(t)) count = Math.max(count, Number(String(t).replace(/\+$/, '')))
    if (/(badge|red-?dot|dot|count|unread|notice-num)/i.test(cls) && !/^\d{1,3}$/.test(t)) dot = true
  }
  if (!count) {
    const visible = squash(text)
    const m = visible.match(/(?:通知|消息)\s*(\d{1,3})\+?\s*$/) || visible.match(/^(\d{1,3})\+?$/)
    if (m) count = Number(m[1])
  }
  const htmlText = String(html ?? '')
  if (!count) {
    // 子元素 list 失败/选择器不支持时的兜底：只认 HTML 文本节点里的 1–3 位数字，不扫 SVG 属性
    const nums = [...htmlText.matchAll(/>\s*(\d{1,3})\+?\s*</g)].map((m) => Number(m[1])).filter((n) => n > 0)
    if (nums.length) count = Math.max(...nums)
  }
  if (!dot && /(?:class|data-e2e)="[^"]*(?:badge|red-?dot|unread|notice-num|count)[^"]*"/i.test(htmlText)) {
    dot = true
  }
  const htmlHash = html ? hash12(htmlText.replace(/\s+/g, ' ').trim()) : ''
  return {
    available: Boolean(html || squash(text)),
    count,
    dot,
    mode: count > 0 ? 'count' : dot ? 'dot' : 'html',
    htmlHash,
    signature: `count:${count}|dot:${dot ? 1 : 0}|html:${htmlHash}`,
  }
}

/**
 * jsWatch 事件是否可能是“新的互动通知”的触发源。
 * 只认 net 事件里通知/互动相关 URL 或正文关键字；排除私信/聊天接口，避免把 DM 正文带进通知链路。
 */
export function isNotifyTriggerEvent(event) {
  if (!event || event.kind !== 'net') return false
  const url = String(event.url ?? '')
  const body = String(event.body ?? '')
  if (/\/im\/|\/chat|conversation|message\/send|msg\/send/i.test(url)) return false
  const urlHit = /notice|notification|interact|comment|reply|mention/i.test(url)
  const bodyHit = /提到了你|回复了你的评论|在你的评论下回复|赞了你的评论|赞了你的弹幕|关注了你|等\d+人赞了/.test(body)
  return Boolean(urlHit || bodyHit)
}

/** 从通知跳转后的 URL 取 videoId：优先 ?modal_id=，其次 /video/<id> */
export function parseVideoIdFromUrl(raw) {
  const modal = parseModalId(raw)
  if (modal) return modal
  try {
    const u = new URL(String(raw ?? ''))
    const m = u.pathname.match(/\/video\/(\d{6,20})(?:[/?#]|$)/)
    if (m) return m[1]
  } catch {
    // 非 URL
  }
  return ''
}

/** 从当前 URL 里取搜索弹窗的 modal_id（视频 id） */
export function parseModalId(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    const id = u.searchParams.get('modal_id')
    if (id && VIDEO_ID_RE.test(id)) return id
  } catch {
    // 非标准 URL 继续用正则兜底
  }
  const m = s.match(/[?&#]modal_id=(\d{6,20})(?:[&#]|$)/)
  return m ? m[1] : ''
}

function normalizeSearchType(value) {
  const type = String(value ?? 'general').trim().toLowerCase() || 'general'
  if (!SEARCH_TYPES.has(type)) throw new DouyinError('E_BAD_ARG', 'type 只接受 general/video/user/live')
  return type
}

function parseUserHref(raw) {
  try {
    const u = new URL(String(raw ?? '').trim(), 'https://www.douyin.com')
    if (!/(^|\.)douyin\.com$/i.test(u.hostname)) return null
    const m = u.pathname.match(/^\/user\/([^/]+)/)
    if (!m) return null
    const id = decodeURIComponent(m[1])
    if (id === 'self' || !/^[A-Za-z0-9_-]{2,100}$/.test(id)) return null
    return { userId: id, url: `https://www.douyin.com/user/${id}` }
  } catch {
    return null
  }
}

function parseLiveHref(raw) {
  try {
    const u = new URL(String(raw ?? '').trim(), 'https://www.douyin.com')
    let id = ''
    const byPath = u.pathname.match(/\/live\/(\d{3,20})/)
    if (byPath) id = byPath[1]
    else if (/^live\.douyin\.com$/i.test(u.hostname)) {
      const m = u.pathname.match(/^\/(\d{3,20})/)
      if (m) id = m[1]
    }
    if (!id) return null
    return { roomId: id, url: `https://live.douyin.com/${id}` }
  } catch {
    return null
  }
}

/** user 搜索结果：读非 self 的 /user/ 链接，去重并过滤导航/空文本 */
export function parseUserSearchRows(rows, limit = 8) {
  const out = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = squash(row?.text ?? '')
    if (!text || SEARCH_NAV_TEXTS.has(text)) continue
    const parsed = parseUserHref(row?.href ?? row?.url ?? '')
    if (!parsed || seen.has(parsed.userId)) continue
    seen.add(parsed.userId)
    out.push({ userId: parsed.userId, url: parsed.url, text: cut(text, 120), type: 'user' })
    if (out.length >= limit) break
  }
  return out
}

/** live 搜索结果：读 /live/ 或 live.douyin.com/<id>，去重并过滤导航/空文本 */
export function parseLiveSearchRows(rows, limit = 8) {
  const out = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = squash(row?.text ?? '')
    if (!text || SEARCH_NAV_TEXTS.has(text)) continue
    const parsed = parseLiveHref(row?.href ?? row?.url ?? '')
    if (!parsed || seen.has(parsed.roomId)) continue
    seen.add(parsed.roomId)
    out.push({ roomId: parsed.roomId, url: parsed.url, text: cut(text, 120), type: 'live' })
    if (out.length >= limit) break
  }
  return out
}

/** 显示计数：5632 / 1,234 / 1.2万；无法解析返回 null */
export function parseDisplayCount(text) {
  const s = String(text ?? '').replace(/,/g, '').trim()
  const wan = s.match(/(\d+(?:\.\d+)?)\s*万/)
  if (wan) return Math.round(Number(wan[1]) * 10000)
  const m = s.match(/\d+/)
  return m ? Number(m[0]) : null
}

/**
 * 抖音点赞/收藏按钮的语义状态属性（2026-11-08 真实页面实测）。
 *
 * 视频页与图文页的 `[data-e2e="video-player-digg"]` /
 * `[data-e2e="video-player-collect"]` 都带这个属性，取值：
 *   点赞：video-player-is-digged    / video-player-no-digged
 *   收藏：video-player-is-collected / video-player-no-collect
 *
 * 这比 class（CSS Modules 哈希，如 `Fw5w6T_O`）和 aria（实测为 null）稳定，
 * 是 active 状态的唯一可靠读回信号。
 */
export const TOGGLE_STATE_ATTR = 'data-e2e-state'

/** 从 data-e2e-state / class / aria / 文本推断点赞/收藏是否激活；推断不了返回 null */
export function detectToggleActive({
  className = '',
  ariaPressed = '',
  ariaLabel = '',
  text = '',
  state = '',
} = {}) {
  // 1) 语义状态属性优先级最高（真实页面：is-xxx / no-xxx）
  const st = String(state ?? '').trim().toLowerCase()
  if (st) {
    if (/(^|-)is-/.test(st)) return true
    if (/(^|-)no-/.test(st)) return false
  }
  // 2) aria-pressed
  const aria = String(ariaPressed ?? '').toLowerCase()
  if (aria === 'true') return true
  if (aria === 'false') return false
  // 3) aria-label / 文本（“取消点赞”= 当前已赞）
  const label = `${ariaLabel ?? ''} ${text ?? ''}`
  if (/(取消赞|取消点赞|已赞|已点赞|取消收藏|已收藏)/.test(label)) return true
  // 4) class 兜底（哈希 class 命中不了就返回 null，交给计数差）
  const cls = String(className ?? '')
  if (/(^|\s)(?:active|is-active|liked|selected|checked|digged|collected)(?:\s|$)/i.test(cls)) return true
  if (/(^|\s)(?:inactive|unliked|unselected|unchecked)(?:\s|$)/i.test(cls)) return false
  return null
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function stamp(ms, tzOffsetMinutes) {
  const d = new Date(ms + tzOffsetMinutes * MINUTE_MS)
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`
}

/**
 * @param {{
 *   cfg: ReturnType<import('./config.js').normalizeConfig>,
 *   bridge: import('./bridge.js').BridgeClient,
 *   transport: {request:Function, readFile:Function, name?:string},
 *   limiter: import('./limits.js').RateLimiter,
 *   clock?: () => number,
 *   log?: object,
 *   sleep?: (ms:number) => Promise<void>,
 * }} deps
 */
export function createDouyinService({
  cfg,
  bridge,
  transport,
  limiter,
  clock = Date.now,
  log = null,
  sleep = defaultSleep,
  fetchImpl = globalThis.fetch,
}) {
  const tz = cfg.tzOffsetMinutes ?? 480
  // 2026-11-16：私信会话预览不带方向；记录本插件刚发出的消息，watcher 用它过滤自回消息
  const dmOutbound = new Map()
  const noteDmOutbound = (name, text) => {
    const k = `${squash(name)}\u0001${squash(text)}`
    if (!k.trim()) return
    dmOutbound.set(k, clock())
    const cut = clock() - 10 * 60_000
    for (const [key, at] of dmOutbound) if (Number(at) < cut) dmOutbound.delete(key)
  }
  const isDmOutbound = (conv) => dmOutbound.has(`${squash(conv?.name)}\u0001${squash(conv?.preview)}`)
  // 2026-11-14 多页面 role：watcher 固定落在独立 tab，不跟 feed/search/open 抢主页面。
  // withRole 在旧 bridge 客户端上不存在时退化为共享页面（保持旧版兼容），生产客户端已支持。
  const dmBridge = typeof bridge?.withRole === 'function' ? bridge.withRole('dm') : bridge
  const notifyBridge = typeof bridge?.withRole === 'function' ? bridge.withRole('notify') : bridge

  /** 下一次浏览类工具调用先结算上一条 watch；status/screenshot 不结算 */
  const settleActiveWatch = () => {
    try {
      limiter.settleWatch(clock())
    } catch {
      // 结算失败不影响本次工具执行（宁少不多）
    }
  }

  /**
   * 统一执行壳：闸门 → 执行 → 记账。
   * guard 失败不记账（不延长最小间隔）；执行失败记 ok=false；条数只由 watch 结算产生。
   */
  const exec = async (cmd, need, run) => {
    const started = clock()
    let gate
    try {
      gate = limiter.guard({ cmd, now: started, need })
    } catch (e) {
      return toFailure(e)
    }
    try {
      const result = await run(gate)
      const finished = clock()
      limiter.commit({
        cmd,
        now: finished,
        ok: result?.ok !== false,
        durationMs: finished - started,
      })
      return result
    } catch (e) {
      const finished = clock()
      limiter.commit({
        cmd,
        now: finished,
        ok: false,
        error: errorCode(e),
        durationMs: finished - started,
      })
      return toFailure(e)
    }
  }

  async function ensureHome() {
    let current = ''
    try {
      current = await bridge.url()
    } catch {
      // 读不到当前 URL 时按“不在首页”处理，open 失败会返回明确错误码
    }
    if (!isHomeUrl(current)) await bridge.open(cfg.homeUrl)
  }

  /** 0 条结果时区分验证码/登录/选择器失效，不猜测、不点击 */
  async function selectorMiss(reason, client = bridge) {
    let title = ''
    try {
      title = await client.title()
    } catch {
      // 探测失败不影响主错误
    }
    if (/验证码|captcha|安全验证|滑块/i.test(title)) {
      return new DouyinError('E_CHALLENGE', '页面出现验证码/安全验证，已停止')
    }
    // 登录浮层是 CLIENT.md 记载的只读特征；只 count，不点击
    try {
      const loginPanels = await client.count(cfg.loginSelector)
      if (loginPanels > 0) {
        return new DouyinError('E_LOGIN_REQUIRED', '页面出现登录浮层，登录态可能失效')
      }
    } catch {
      // count 失败按选择器未命中处理
    }
    if (/登录|log\s*in/i.test(title)) {
      return new DouyinError('E_LOGIN_REQUIRED', '页面需要登录，登录态可能失效')
    }
    return new DouyinError('E_SELECTOR_MISS', reason)
  }

  async function status() {
    return exec('status', 0, async () => {
      const t0 = clock()
      const ping = await bridge.ping()
      const url = await bridge.url()
      const title = await bridge.title()
      const usage = limiter.usage(clock())
      return {
        ok: true,
        proto: ping.proto,
        browser: ping.browser,
        pages: ping.pages,
        ...(ping.roles ? { roles: ping.roles } : {}),
        url,
        title,
        latencyMs: Math.max(0, clock() - t0),
        blockAssets: cfg.blockAssets,
        activeWatch: usage.activeWatch,
        minWatchMs: usage.minWatchMs,
        watchedCount: usage.watchedCount,
        watched: usage.watched,
      }
    })
  }

  /** blockAssets=true 时在 feed/search 开始时切一次资源拦截；失败只 warn，不阻断 */
  async function applyBlockAssets() {
    if (!cfg.blockAssets) return
    try {
      await bridge.assets(true)
    } catch (e) {
      log?.warn?.(`[douyin] 屏蔽图片/字体/媒体失败（继续执行）：${String(e?.message ?? e).slice(0, 120)}`)
    }
  }

  async function feed(args = {}) {
    settleActiveWatch()
    let limit
    let scroll
    try {
      limit = asIntInRange(args?.limit ?? 8, 1, 8, 'limit')
      if (args?.scroll !== undefined && typeof args.scroll !== 'boolean') {
        throw new DouyinError('E_BAD_ARG', 'scroll 必须是布尔值')
      }
      scroll = args?.scroll === true
    } catch (e) {
      return toFailure(e)
    }
    return exec('feed', 0, async () => {
      // 浏览列表免费：feed/search 不再按展示条数占配额
      const planned = limit
      await applyBlockAssets()
      await ensureHome()

      const items = []
      const seen = new Set()
      const take = (rows) => {
        for (const item of parseVideoItems(rows)) {
          if (seen.has(item.videoId)) continue
          seen.add(item.videoId)
          items.push(item)
          if (items.length >= planned) break
        }
      }
      const fetchRows = () =>
        bridge.list(cfg.feedSelector, {
          attrs: ['href', 'data-e2e-vid'],
          // 滚动后首页会追加新卡片，但 DOM 前几条仍是旧卡；多取一些再按 videoId 去重
          limit: Math.min(40, planned + seen.size),
          textLen: cfg.textLen,
        })

      take(await fetchRows())
      if (scroll) {
        // 当前卡片取完后最多再下滚 3 次；按 videoId 去重，直到 limit
        for (let step = 0; step < cfg.feedScrollMaxSteps && items.length < planned; step++) {
          try {
            await bridge.scroll(cfg.feedScrollDelta)
            await sleep(cfg.feedScrollWaitMs)
            take(await fetchRows())
          } catch (e) {
            if (!items.length) throw e
            log?.warn?.(
              `[douyin] feed scroll 中断（已有 ${items.length} 条）：${String(e?.message ?? e).slice(0, 120)}`,
            )
            break
          }
        }
      }
      if (!items.length) {
        throw await selectorMiss('推荐流没有取到视频卡片：选择器可能失效或页面未加载')
      }
      return { ok: true, items, count: items.length }
    })
  }

  /** 搜索页标题出现验证码/安全验证时立即停 */
  async function assertNotChallenge() {
    let title = ''
    try {
      title = await bridge.title()
    } catch {
      return
    }
    if (/验证码|captcha|安全验证|滑块/i.test(title)) {
      throw new DouyinError('E_CHALLENGE', '搜索页出现验证码/安全验证，已停止（需人工处理）')
    }
  }

  /**
   * 初始检查 + 最多 searchCardRetries 次重试，每次间隔 searchCardWaitMs。
   * count>0 后先 list 验证有文本行；空 list（spinner/骨架）继续等。
   */
  async function waitForSearchCards(planned) {
    for (let attempt = 0; attempt <= cfg.searchCardRetries; attempt++) {
      if (attempt > 0) await sleep(cfg.searchCardWaitMs)
      const cards = await bridge.count(cfg.searchSelector)
      if (cards <= 0) continue
      const rows = await bridge.list(cfg.searchSelector, {
        attrs: [],
        limit: planned,
        textLen: cfg.textLen,
      })
      if (rows.some((row) => squash(row?.text ?? '').length > 0)) {
        return { cards, rows }
      }
      // count 有命中但 list 没有文本：按 spinner/骨架处理，继续等
    }
    return { cards: 0, rows: [] }
  }

  /** 一次完整搜索：open → 等卡片 → 逐卡 click/modal_id/Escape；可重试错误由外层捕获 */
  async function searchOnce(type, planned, url) {
    const opened = await bridge.open(url)
    if (/验证码|captcha|安全验证|滑块/i.test(opened.title)) {
      throw new DouyinError('E_CHALLENGE', '搜索页出现验证码/安全验证，已停止（需人工处理）')
    }
    await assertNotChallenge()

    if (type === 'user') {
      // 用户结果页比视频卡片慢：最多等 3×1s，拿到带文本的 user 链接就返回
      for (let attempt = 0; attempt <= SEARCH_LINK_RETRIES; attempt++) {
        if (attempt > 0) await sleep(SEARCH_LINK_WAIT_MS)
        const rows = await bridge.list('a[href*="/user/"]', {
          attrs: ['href'],
          limit: Math.min(50, planned * 2),
          textLen: 60,
        })
        const items = parseUserSearchRows(rows, planned)
        if (items.length) return { items }
      }
      return { items: [] }
    }
    if (type === 'live') {
      // 直播结果同样可能延迟；空页不要误判成选择器错误，等最多 3×1s 后返回空
      for (let attempt = 0; attempt <= SEARCH_LINK_RETRIES; attempt++) {
        if (attempt > 0) await sleep(SEARCH_LINK_WAIT_MS)
        const rows = []
        for (const selector of [
          'a[href*="/live/"]',
          'a[href*="live.douyin.com/"]',
          '[data-e2e*="live"]',
        ]) {
          try {
            const part = await bridge.list(selector, {
              attrs: ['href'],
              limit: Math.min(50, planned * 2),
              textLen: 60,
            })
            rows.push(...part)
          } catch {
            // 该白名单选择器无结果/不可用，继续试下一个
          }
        }
        const items = parseLiveSearchRows(rows, planned)
        if (items.length) return { items }
      }
      return { items: [] }
    }

    const { cards, rows } = await waitForSearchCards(planned)
    if (cards <= 0 || !rows.length) {
      await assertNotChallenge()
      throw new DouyinError('E_SELECTOR_MISS', `搜索页没有可见卡片（${cfg.searchSelector}）`)
    }

    const items = []
    const seen = new Set()
    const target = Math.min(planned, rows.length)
    for (let i = 0; i < target; i++) {
      let clicked
      try {
        clicked = await bridge.click(cfg.searchSelector, { nth: i })
      } catch (e) {
        // click 失败跳过，不重试、不硬点
        log?.warn?.(`[douyin] 搜索卡片点击失败（nth=${i}），跳过：${String(e?.message ?? e).slice(0, 120)}`)
        continue
      }
      if (clicked === false || clicked?.ok === false) continue

      try {
        const current = await bridge.url()
        const videoId = parseModalId(current)
        if (!videoId) continue
        if (seen.has(videoId)) continue
        seen.add(videoId)
        items.push({
          videoId,
          url: `https://www.douyin.com/video/${videoId}`,
          text: cut(squash(rows[i]?.text ?? ''), 120),
        })
      } catch (e) {
        log?.warn?.(`[douyin] 搜索卡片读取 URL 失败（nth=${i}），跳过：${String(e?.message ?? e).slice(0, 120)}`)
      } finally {
        try {
          await bridge.press('Escape', { allowFocused: true })
        } catch (e) {
          log?.warn?.(`[douyin] 搜索卡片关闭（Escape）失败（nth=${i}）：${String(e?.message ?? e).slice(0, 120)}`)
        }
      }
    }

    if (!items.length) {
      await assertNotChallenge()
      throw new DouyinError('E_SELECTOR_MISS', '搜索卡片没有取到 modal_id；已跳过，不猜/不循环点击')
    }
    return { items }
  }

  async function search(args = {}) {
    settleActiveWatch()
    let query
    let limit
    let type
    try {
      query = String(args?.query ?? '').trim()
      const qLen = Array.from(query).length
      if (qLen < 1 || qLen > 40 || /[\u0000-\u001f\u007f]/.test(query)) {
        throw new DouyinError('E_BAD_ARG', 'query 必须是 1–40 个字符的纯文本')
      }
      limit = asIntInRange(args?.limit ?? 8, 1, 8, 'limit')
      type = normalizeSearchType(args?.type)
    } catch (e) {
      return toFailure(e)
    }
    return exec('search', 0, async () => {
      // 浏览列表免费：feed/search 不再按展示条数占配额
      const planned = limit
      const base = `https://www.douyin.com/search/${encodeURIComponent(query)}`
      const url = type === 'user' || type === 'live' ? `${base}?type=${type}` : base
      await applyBlockAssets()

      const attempts = 1 + Math.max(0, Math.min(1, Number(cfg.searchRetries) || 0))
      let firstError = null
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await sleep(SEARCH_RETRY_WAIT_MS)
        try {
          const { items } = await searchOnce(type, planned, url)
          const result = { ok: true, query, type, items, count: items.length }
          if (!items.length && (type === 'user' || type === 'live')) {
            result.note = type === 'live' ? '页面没有直播结果（可能确实无直播）' : '没有找到用户（可能确实无结果）'
          }
          return result
        } catch (e) {
          if (!firstError) firstError = e
          const code = errorCode(e)
          const canRetry = RETRYABLE_SEARCH_CODES.has(code)
          if (!canRetry || attempt >= attempts - 1) {
            // 重试仍失败：返回第一次的错误，不返回重试错误
            throw firstError
          }
          log?.warn?.(`[douyin] 搜索失败（${code}），${SEARCH_RETRY_WAIT_MS / 1000}s 后重试一次`)
        }
      }
      throw firstError ?? new DouyinError('E_REMOTE_IO', '搜索失败')
    })
  }

  async function openVideo(args = {}) {
    settleActiveWatch()
    let target
    try {
      target = await resolveVideoTargetAsync(args, { fetchImpl })
    } catch (e) {
      return toFailure(e)
    }
    return exec('open', 1, async () => {
      const r = await bridge.open(target.url)
      let title = r.title
      if (!title) {
        try {
          title = await bridge.title()
        } catch {
          title = ''
        }
      }
      const result = {
        ok: true,
        videoId: target.videoId,
        url: r.url || target.url,
        status: r.status,
        title,
      }
      // open 本身不记账；成功后才开始计时，下一次浏览类工具调用结算
      limiter.startWatch({ videoId: target.videoId, now: clock() })
      return result
    })
  }

  async function comments(args = {}) {
    settleActiveWatch()
    let videoId
    let limit
    try {
      const target = await resolveVideoTargetAsync({ videoId: args?.videoId, url: args?.url })
      videoId = target.videoId
      limit = asIntInRange(args?.limit ?? 20, 1, 50, 'limit')
    } catch (e) {
      return toFailure(e)
    }
    return exec('comments', 1, async () => {
      await bridge.open(`https://www.douyin.com/video/${videoId}`)
      let usedSelector = null
      let items = []
      let expandTried = false
      // 评论页懒加载：最多等 commentRetries 次，每次 commentWaitMs
      for (let attempt = 0; attempt <= cfg.commentRetries && !items.length; attempt++) {
        if (attempt > 0) await sleep(cfg.commentWaitMs)
        for (const selector of cfg.commentSelectors) {
          let n
          try {
            n = await bridge.count(selector)
          } catch {
            continue
          }
          if (!Number.isFinite(n) || n <= 0) continue
          let rows
          try {
            rows = await bridge.list(selector, { attrs: [], limit, textLen: cfg.commentTextLen })
          } catch {
            continue
          }
          const parsed = parseCommentItems(rows, cfg.commentTextLen).slice(0, limit)
          if (parsed.length) {
            usedSelector = selector
            items = parsed
            break
          }
        }
        // 一次都没抓到：评论栏默认是收起的，点一下那个展开按钮（只点白名单里的这一个）
        if (!items.length && !expandTried && attempt >= 2) {
          expandTried = true
          for (const openSelector of cfg.commentOpenSelectors) {
            try {
              await bridge.click(openSelector, { nth: 0, force: true })
              break
            } catch {}
          }
        }
      }
      if (!items.length) {
        throw await selectorMiss('评论选择器未命中（等了懒加载、也点过展开按钮）')
      }

      // 评论内“展开N条回复”：在滚动前逐个点 button.comment-reply-expand-btn（nth=0），
      // 点完重新 list 同一评论容器，把同一 comment-item 的回复段合并回来。
      if (usedSelector && cfg.commentReplyExpandMax > 0) {
        let expandButtons = 0
        try {
          expandButtons = await bridge.count('button.comment-reply-expand-btn')
        } catch {
          expandButtons = 0
        }
        const maxClicks = Math.min(limit, cfg.commentReplyExpandMax, Number.isFinite(expandButtons) ? expandButtons : 0)
        let clicked = 0
        for (let i = 0; i < maxClicks; i++) {
          try {
            const ok = await bridge.click('button.comment-reply-expand-btn', { nth: 0 })
            if (ok === false) continue
            clicked += 1
            await sleep(cfg.commentReplyWaitMs)
          } catch {
            // 点失败跳过，不循环硬点
          }
        }
        if (clicked > 0) {
          try {
            const rows = await bridge.list(usedSelector, {
              attrs: [],
              limit: Math.min(50, limit * 2),
              textLen: cfg.commentTextLen,
            })
            const expanded = parseCommentItems(rows, cfg.commentTextLen)
            const merged = new Map()
            for (const item of items) merged.set(`${item.author ?? ''}|${item.text}`, item)
            for (const item of expanded) merged.set(`${item.author ?? ''}|${item.text}`, item)
            items = [...merged.values()]
          } catch {
            // relist 失败保留初始 items
          }
        }
      }

      // 评论区懒加载：往下滚，读到新评论后按 author+text 去重
      if (args?.scroll !== false && items.length < limit) {
        const seen = new Set(items.map((x) => `${x.author ?? ''}|${x.text}`))
        for (let step = 0; step < cfg.commentScrollSteps && items.length < limit; step++) {
          try { await bridge.scroll(cfg.commentScrollDelta, { selector: '[data-e2e="comment-list"]' }) } catch { break }
          await sleep(cfg.commentScrollWaitMs)
          let rows = []
          try { rows = await bridge.list(usedSelector, { attrs: [], limit: limit * 2, textLen: cfg.commentTextLen }) } catch { break }
          const parsed = parseCommentItems(rows, cfg.commentTextLen)
          let added = 0
          for (const item of parsed) {
            const key = `${item.author ?? ''}|${item.text}`
            if (seen.has(key)) continue
            seen.add(key)
            items.push(item); added += 1
            if (items.length >= limit) break
          }
          if (!added) break
        }
      }
      items = items.slice(0, limit)
      return { ok: true, videoId, items, count: items.length, selector: usedSelector }
    })
  }

  // ===== 协议 v2 基础原语（2026-11-16）：能力探测 + 条件轮询 + 桥内输入 =====
  const PROBE_MAX_COUNTS = 8

  /** 选择器去重（保留顺序；空值过滤） */
  function dedupeSelectors(list) {
    const out = []
    const seen = new Set()
    for (const raw of Array.isArray(list) ? list : []) {
      const s = String(raw ?? '').trim()
      if (!s || seen.has(s)) continue
      seen.add(s)
      out.push(s)
    }
    return out
  }

  /** 桥能力探测：任何异常都按“不支持”处理（老桥降级，不报错） */
  async function supportsCap(client, cap) {
    try {
      return typeof client?.supports === 'function' ? (await client.supports(cap)) === true : false
    } catch {
      return false
    }
  }

  /**
   * 条件轮询原语（兼容假时钟：同时按次数和时间收敛，绝不无限循环）。
   * predicate 返回真值 = 命中；抛错只记录，不中断轮询。
   * 返回 { matched, value, attempts, reads, errors, ms, lastError }
   */
  async function pollUntil(predicate, { timeoutMs, intervalMs, maxAttempts } = {}) {
    const started = clock()
    const interval = Math.max(20, Number(intervalMs) || cfg.writeVerifyPollMs || 120)
    const total = Math.max(interval, Number(timeoutMs) || cfg.writeVerifyTimeoutMs || 1000)
    const attempts =
      Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : Math.max(1, Math.ceil(total / interval) + 1)
    let reads = 0
    let errors = 0
    let lastError = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let value
      let threw = false
      try {
        value = await predicate(attempt)
      } catch (e) {
        threw = true
        errors += 1
        lastError = e
      }
      if (!threw) reads += 1
      if (!threw && value !== undefined && value !== null && value !== false) {
        return { matched: true, value, attempts: attempt, reads, errors, lastError, ms: Math.max(0, clock() - started) }
      }
      if (attempt >= attempts) break
      if (clock() - started >= total) break
      await sleep(interval)
    }
    return { matched: false, value: null, attempts, reads, errors, lastError, ms: Math.max(0, clock() - started) }
  }

  /**
   * 等某个选择器出现（新桥 waitFor 一次往返；老桥 count 轮询）。
   * state 只支持 visible/attached（detached/hidden 只能走 waitFor）。
   */
  async function waitForSelector(selector, { state = 'visible', timeoutMs, intervalMs, client = bridge } = {}) {
    const sel = String(selector ?? '').trim()
    if (!sel) return { matched: false, selector: '', via: 'none', ms: 0 }
    const budget = Math.max(50, Math.min(8000, Number(timeoutMs ?? cfg.waitForTimeoutMs) || 2500))
    if (state === 'visible' || state === 'attached') {
      if (await supportsCap(client, 'waitFor')) {
        try {
          const r = await client.waitFor(sel, { state, timeoutMs: budget })
          return { matched: r.matched === true, selector: sel, via: 'waitFor', ms: r.ms ?? null }
        } catch (e) {
          // waitFor 失败（老桥 unknown command 等）→ 降级轮询
          log?.warn?.(`[douyin] waitFor 失败，降级轮询：${String(e?.message ?? e).slice(0, 120)}`)
        }
      }
      const poll = await pollUntil(async () => ((await client.count(sel)) > 0 ? true : null), {
        timeoutMs: budget,
        intervalMs: intervalMs ?? 150,
      })
      return { matched: poll.matched, selector: sel, via: 'poll', ms: poll.ms }
    }
    if (await supportsCap(client, 'waitFor')) {
      const r = await client.waitFor(sel, { state, timeoutMs: budget })
      return { matched: r.matched === true, selector: sel, via: 'waitFor', ms: r.ms ?? null }
    }
    return { matched: false, selector: sel, via: 'unsupported', ms: 0 }
  }

  /** 等一组选择器里任意一个出现（老桥按顺序 poll，每个一次 count） */
  async function waitForAny(selectors, { timeoutMs, intervalMs, client = bridge } = {}) {
    const list = dedupeSelectors(selectors)
    if (!list.length) return { matched: false, selector: '', via: 'none', ms: 0 }
    const budget = Math.max(50, Number(timeoutMs ?? cfg.waitForTimeoutMs) || 2500)
    if (await supportsCap(client, 'waitFor')) {
      const share = Math.max(50, Math.floor(budget / list.length))
      for (const sel of list) {
        try {
          const r = await client.waitFor(sel, { state: 'visible', timeoutMs: share })
          if (r.matched) return { matched: true, selector: sel, via: 'waitFor', ms: r.ms ?? null }
        } catch {
          // 换下一个
        }
      }
    }
    const poll = await pollUntil(async (attempt) => {
      const sel = list[(attempt - 1) % list.length]
      const n = await client.count(sel).catch(() => 0)
      return n > 0 ? sel : null
    }, { timeoutMs: budget, intervalMs: intervalMs ?? 200 })
    return { matched: poll.matched, selector: poll.value ?? '', via: poll.matched ? 'poll' : 'none', ms: poll.ms }
  }

  /** 等文本/草稿包含某段内容（回读用） */
  async function waitForTextContains(selector, needle, { timeoutMs, intervalMs, client = bridge } = {}) {
    const sel = String(selector ?? '').trim()
    const want = squash(needle)
    if (!sel || !want) return { matched: false, via: 'none', ms: 0, reads: 0, errors: 0 }
    const poll = await pollUntil(async () => {
      const raw = await client.text(sel)
      return squash(raw).includes(want) ? squash(raw) : null
    }, { timeoutMs: timeoutMs ?? cfg.writeVerifyTimeoutMs, intervalMs: intervalMs ?? cfg.writeVerifyPollMs })
    return { matched: poll.matched, text: poll.value ?? '', via: poll.matched ? 'poll' : 'none', ms: poll.ms, reads: poll.reads, errors: poll.errors }
  }

  /** 等文本被清空（clearText 后确认，替代固定 250ms） */
  async function waitForTextEmpty(selector, { timeoutMs = 600, intervalMs = 80, client = bridge } = {}) {
    const poll = await pollUntil(async () => {
      const raw = squash(await client.text(selector))
      return raw === '' ? true : null
    }, { timeoutMs, intervalMs })
    return { matched: poll.matched, reads: poll.reads, errors: poll.errors, ms: poll.ms }
  }

  /** 等 URL 变化（点通知条目/JS 点击后判断是否跳转），一次 poll = 1 条 url 命令 */
  async function waitForUrlChange(previousUrl, { timeoutMs = 3000, intervalMs = 200, client = bridge } = {}) {
    const prev = String(previousUrl ?? '')
    const poll = await pollUntil(async () => {
      const cur = await currentUrlOrEmpty(client).catch(() => '')
      return cur && cur !== prev ? cur : null
    }, { timeoutMs, intervalMs })
    return { matched: poll.matched, url: poll.value ?? '', reads: poll.reads, errors: poll.errors, ms: poll.ms }
  }

  /**
   * 桥内文本输入（协议 v2 §F）。返回 {via, bridge}；桥不支持/失败时返回 null 让调用方走 X11。
   * 只在**明确失败**（E_TYPE_FAILED / 老桥 unknown command）时降级，绝不掩盖“可能已输入”的异常。
   */
  async function bridgeTypeText(selector, text, { clear = false, mode = 'auto', client = bridge } = {}) {
    if (!(await supportsCap(client, 'type'))) return null
    try {
      const r = await client.typeText({ selector, text, clear, mode })
      return { via: r?.via || mode, chars: r?.chars ?? Array.from(String(text)).length, bridge: true }
    } catch (e) {
      if (e?.code === 'E_TYPE_FAILED' || e?.code === 'E_NO_INPUT') {
        log?.warn?.(`[douyin] 桥内输入失败，回退 X11：${String(e?.message ?? e).slice(0, 120)}`)
        client?.downgrade?.('type')
        return null
      }
      throw e
    }
  }

  /**
   * 把文本写进编辑框并读回确认：桥内 type 优先（不过 X11、支持中文），X11 剪贴板兜底。
   * 返回 {ok, via, draft, ms}；不抛异常，调用方按 ok 决定 E_UNVERIFIED / E_EXECUTION_UNKNOWN。
   */
  async function fillEditorText({ client = bridge, selector, text, activate = true, timeoutMs } = {}) {
    const sel = String(selector ?? '').trim()
    const value = String(text ?? '')
    const t0 = clock()
    if (!sel || !value) return { ok: false, via: 'none', draft: '', ms: 0 }
    let via = 'bridge'
    const typed = await bridgeTypeText(sel, value, { clear: true, client })
    if (!typed) {
      via = 'x11'
      if (activate) {
        try { await client.activate() } catch { /* 老桥无 activate */ }
      }
      try { await client.click(sel, { nth: 0, force: true }) } catch { /* 已聚焦也可直接粘贴 */ }
      if (typeof transport.clearText !== 'function' || typeof transport.pasteText !== 'function') {
        return { ok: false, via: 'none', draft: '', ms: Math.max(0, clock() - t0) }
      }
      await transport.clearText()
      await waitForTextEmpty(sel, { timeoutMs: 800, client }).catch(() => null)
      await transport.pasteText(value)
    }
    const got = await waitForTextContains(sel, value, {
      timeoutMs: timeoutMs ?? cfg.writeVerifyTimeoutMs,
      client,
    })
    return { ok: got.matched, via, draft: got.text ?? '', ms: Math.max(0, clock() - t0) }
  }

  /** 写操作对应的接口 URL 片段（protocol-v2.md §D；未核实的只做加分项，不判失败） */
  const NET_PATTERNS = Object.freeze({
    like: ['/commit/item/digg/'],
    favorite: ['/aweme/v1/web/aweme/collect/'],
    comment: ['/comment/publish/'],
    comment_reply: ['/comment/publish/'],
  })
  function netPatternsFor(action) {
    return NET_PATTERNS[action] ?? []
  }

  /** 网络响应观察：写前 arm（1 条命令）；返回 null 表示桥不支持/关闭 */
  async function armNetVerify(patterns, client = bridge) {
    if (cfg.netVerifyEnabled === false) return null
    if (!Array.isArray(patterns) || !patterns.length) return null
    if (!(await supportsCap(client, 'netArm')) || !(await supportsCap(client, 'netTake'))) return null
    try {
      const armed = await client.netArm(patterns)
      return { seq: armed.seq, patterns: armed.patterns }
    } catch (e) {
      log?.warn?.(`[douyin] netArm 失败（不影响写）：${String(e?.message ?? e).slice(0, 120)}`)
      return null
    }
  }

  /** 取网络事件；命中 2xx 才算“加分验证”。失败/不命中一律返回 null（不判失败）。 */
  async function takeNetVerify(armed, client = bridge) {
    if (!armed) return null
    try {
      const r = await client.netTake({ sinceSeq: armed.seq, timeoutMs: cfg.netVerifyTimeoutMs, want: 1 })
      if (!r.matched || !r.events.length) return null
      const hit = r.events.find((e) => Number(e.status) >= 200 && Number(e.status) < 300)
      return hit ? { url: hit.url, status: hit.status } : null
    } catch (e) {
      log?.warn?.(`[douyin] netTake 失败（不影响回读结论）：${String(e?.message ?? e).slice(0, 120)}`)
      return null
    }
  }

  /**
   * 所有写操作的公共前置：一次 probe（url/title/readyState + 去重后的阻塞选择器计数）。
   * 命中目标页 = 1 次往返；需要导航 = open(带 url/title) + 1 次 probe。
   * 老桥（无 probe 能力）降级为 url/open/title + 去重 count（不再重复查 loginSelector）。
   */
  async function openForWrite(videoId) {
    const targetUrl = `https://www.douyin.com/video/${videoId}`
    const isTarget = (url) => String(url ?? '').includes(`/video/${videoId}`) || String(url ?? '').includes(`/note/${videoId}`)
    const challengeRe = /验证码|captcha|安全验证|滑块/i
    // loginSelector 常与 writeBlockedSelectors 重叠（config.js 实测同一个 [id^="login-full-panel"]）：先去重
    const blocked = dedupeSelectors([cfg.loginSelector, ...cfg.writeBlockedSelectors]).slice(0, PROBE_MAX_COUNTS)
    const checkBlocked = (counts) => {
      for (const selector of blocked) {
        const n = Number(counts?.[selector])
        if (!Number.isFinite(n) || n <= 0) continue
        if (selector === cfg.loginSelector) {
          throw new DouyinError('E_LOGIN_REQUIRED', '页面出现登录浮层，登录态可能失效')
        }
        throw new DouyinError('E_LOGIN_REQUIRED', '页面出现短信验证/登录浮层，已停止写操作')
      }
    }

    if (await supportsCap(bridge, 'probe')) {
      let page = await bridge.probe({ counts: blocked })
      if (challengeRe.test(page.title)) {
        throw new DouyinError('E_CHALLENGE', '页面出现验证码/安全验证，已停止（需人工处理）')
      }
      if (!isTarget(page.url)) {
        const opened = await bridge.open(targetUrl, { reuse: cfg.openReuse !== false })
        if (challengeRe.test(opened.title)) {
          throw new DouyinError('E_CHALLENGE', '视频页出现验证码/安全验证，已停止（需人工处理）')
        }
        page = await bridge.probe({ counts: blocked })
        if (challengeRe.test(page.title)) {
          throw new DouyinError('E_CHALLENGE', '页面出现验证码/安全验证，已停止（需人工处理）')
        }
      }
      if (/登录|log\s*in/i.test(page.title)) {
        throw new DouyinError('E_LOGIN_REQUIRED', '页面需要登录，登录态可能失效')
      }
      checkBlocked(page.counts)
      return
    }

    // ---- 老桥降级路径（行为与旧版一致，只是去掉重复选择器/复用 open 返回值）----
    let current = ''
    try {
      current = await bridge.url()
    } catch {
      // ignore
    }
    let title = ''
    if (!isTarget(current)) {
      const opened = await bridge.open(targetUrl, { reuse: cfg.openReuse !== false })
      title = opened.title
      if (challengeRe.test(title)) {
        throw new DouyinError('E_CHALLENGE', '视频页出现验证码/安全验证，已停止（需人工处理）')
      }
    }
    if (!title) {
      try {
        title = await bridge.title()
      } catch {
        title = ''
      }
    }
    if (challengeRe.test(title)) {
      throw new DouyinError('E_CHALLENGE', '页面出现验证码/安全验证，已停止（需人工处理）')
    }
    if (/登录|log\s*in/i.test(title)) {
      throw new DouyinError('E_LOGIN_REQUIRED', '页面需要登录，登录态可能失效')
    }
    const counts = {}
    for (const selector of blocked) {
      try {
        counts[selector] = await bridge.count(selector)
      } catch (e) {
        if (e instanceof DouyinError) throw e
      }
    }
    checkBlocked(counts)
  }

  // 图文页（/note/<id>）从 /video/<id> 客户端重定向，按钮会晚 1–2 秒挂载；
  // 实测 2026-11-08：立即读会 E_SELECTOR_MISS，等一下就能读到。
  // 2026-11-16：固定 700ms 换成 poll（toggleReadRetries × toggleReadWaitMs，默认 4×150ms）。
  async function readToggleRows(client, selector, attrs) {
    if (await supportsCap(client, 'probe')) {
      const page = await client.probe({ selector, attrs, limit: 1, textLen: 120 })
      return page.rows
    }
    return client.list(selector, { attrs, limit: 1, textLen: 120 })
  }

  async function readToggleState(selector, { client = bridge } = {}) {
    const attrs = ['class', 'aria-pressed', 'aria-label', TOGGLE_STATE_ATTR]
    const attempts = Math.max(1, Number(cfg.toggleReadRetries) || 1)
    const interval = Math.max(50, Number(cfg.toggleReadWaitMs) || 150)
    const poll = await pollUntil(async () => {
      const rows = await readToggleRows(client, selector, attrs)
      return rows.length ? rows : null
    }, { timeoutMs: attempts * interval, intervalMs: interval, maxAttempts: attempts })
    if (!poll.matched) throw new DouyinError('E_SELECTOR_MISS', `选择器未命中：${selector}`)
    const row = poll.value[0] || {}
    const className = String(row.class ?? '')
    const ariaPressed = String(row['aria-pressed'] ?? '')
    const ariaLabel = String(row['aria-label'] ?? '')
    const state = String(row[TOGGLE_STATE_ATTR] ?? '')
    const text = squash(row.text ?? '')
    return {
      active: detectToggleActive({ className, ariaPressed, ariaLabel, text, state }),
      state: state || null,
      className,
      ariaPressed: ariaPressed || null,
      ariaLabel: ariaLabel || null,
      text,
      count: parseDisplayCount(text),
    }
  }

  /** 写后回读轮询：状态一变立即返回（默认 120ms/1.6s），替代固定 800ms sleep */
  async function pollToggleState(selector, { targetState, timeoutMs, intervalMs, client = bridge } = {}) {
    const poll = await pollUntil(async () => {
      const st = await readToggleState(selector, { client })
      if (st.active !== null && st.active === targetState) return st
      // 读到了明确的反态：继续轮询（给 UI 乐观更新一点时间），但保留最后一帧用于判 E_UNVERIFIED
      return null
    }, { timeoutMs: timeoutMs ?? cfg.writeVerifyTimeoutMs, intervalMs: intervalMs ?? cfg.writeVerifyPollMs })
    // 即使没命中，也要给出最后读到的状态（用于 before/after 与失败判定）
    let last = null
    if (!poll.matched) {
      try {
        last = await readToggleState(selector, { client })
      } catch {
        last = null
      }
    }
    return { ...poll, after: poll.matched ? poll.value : last }
  }

  function writeResult({ action, videoId, targetState, before, after, verified, result, code = null, extra = {} }) {
    const failureCode = code ?? 'E_UNVERIFIED'
    return {
      ok: verified === true,
      action,
      videoId,
      targetState,
      before,
      after,
      verified: verified === true,
      ...(result ? { result } : {}),
      ...(verified === true ? {} : { code: failureCode }),
      ...extra,
    }
  }

  async function toggleWrite(action, selector, args = {}, key = '') {
    settleActiveWatch()
    let target
    try {
      target = await resolveVideoTarget({ videoId: args?.videoId })
    } catch (e) {
      return toFailure(e)
    }
    const videoId = target.videoId
    const dryRun = args?.dryRun === true
    const targetState = args?.undo !== true
    const inputMode = args?.inputMode === undefined ? 'auto' : args.inputMode
    if (!['auto', 'click', 'key'].includes(inputMode)) {
      return { ok: false, code: 'E_BAD_ARG', message: 'inputMode 只允许 auto/click/key', action, videoId, targetState, verified: false }
    }
    if (inputMode === 'key' && !key) {
      return { ok: false, code: 'E_BAD_ARG', message: '该动作没有快捷键', action, videoId, targetState, verified: false }
    }
    if (!dryRun && args?.confirm !== true) {
      return { ok: false, code: 'E_CONFIRM_REQUIRED', message: '真实写操作必须 confirm:true', action, videoId, targetState, verified: false }
    }
    if (!dryRun) {
      const old = getVerifiedAction(cfg.downloadDir, { videoId, action, targetState })
      if (old) {
        return {
          ok: true,
          action,
          videoId,
          targetState,
          before: old.detail?.before ?? null,
          after: old.detail?.after ?? null,
          verified: true,
          idempotent: true,
          result: old.result,
        }
      }
    }
    return exec(action, 0, async () => {
      await openForWrite(videoId)
      const before = await readToggleState(selector)
      if (dryRun) {
        return {
          ok: true,
          action,
          videoId,
          targetState,
          before,
          after: before,
          verified: false,
          dryRun: true,
        }
      }
      if (before.active === targetState) {
        const result = targetState ? (action === 'like' ? 'liked' : 'favorited') : action === 'like' ? 'unliked' : 'unfavorited'
        try {
          recordLedger(cfg.downloadDir, {
            videoId,
            action,
            targetState,
            result,
            verified: true,
            detail: { before, after: before },
          })
        } catch (e) {
          log?.warn?.(`[douyin] 写账本失败（不阻断）：${String(e?.message ?? e).slice(0, 120)}`)
        }
        return { ok: true, action, videoId, targetState, before, after: before, verified: true, idempotent: true, result }
      }

      // 点击优先；点击被浮层拦截（E_TIMEOUT）时回退到键盘快捷键。
      // 2026-11-09 实测：Playwright click 在 digg/collect/feed 卡片上 15s 超时（命中测试被挡），
      // 但状态未变；此时先回读确认“真的没点上”，再按 Z/C，避免二次切换。
      // ===== 写执行（protocol-v2.md §D/§F）=====
      // 新版桥（capability pressHotkeys）：桥内 press 优先 → 轮询回读 → click 兜底 → X11 兜底。
      // 老桥：保持旧顺序（click 优先，E_TIMEOUT 且回读确认没生效才按 X11 快捷键）。
      // 铁律：任何一步之后**只要回读失败（读不到）就 E_EXECUTION_UNKNOWN，绝不再补动作**。
      const netArmed = await armNetVerify(netPatternsFor(action))
      const canBridgePress = key ? await supportsCap(bridge, 'pressHotkeys') : false
      const canX11Press = typeof transport.pressKey === 'function'
      const resultText = targetState
        ? action === 'like'
          ? 'liked'
          : 'favorited'
        : action === 'like'
          ? 'unliked'
          : 'unfavorited'
      let via = null
      let after = null
      let verified = false
      let unknown = false
      let lastError = null

      /** X11 快捷键（带输入框聚焦保护；pressKey 内部先点窗口中心取焦点） */
      const x11Press = async () => {
        if (!canX11Press) throw new DouyinError('E_NO_INPUT', '当前传输不支持按快捷键')
        let editors = 0
        try { editors = await bridge.count('[contenteditable]') } catch { editors = 0 }
        let focusedInput = 0
        try { focusedInput = await bridge.count('input:focus, textarea:focus') } catch { focusedInput = 0 }
        if (editors > 0 || focusedInput > 0) {
          throw new DouyinError('E_INPUT_FOCUSED', '评论框已打开或有输入框聚焦，拒绝按快捷键（会打进输入框）')
        }
        await transport.pressKey(key)
      }

      /** 按一次快捷键并轮询回读；返回 'verified' | 'unchanged' | 'unknown' */
      const pressThenVerify = async (kind, timeoutMs) => {
        if (kind === 'bridge') {
          via = 'press'
          let r
          try {
            r = await bridge.pressChar(key)
          } catch (e) {
            // 命令已发出但没等到应答（客户端超时）：只读确认一次，绝不再按第二下。
            // 2026-11-16 真机复现过：fav revert 返回 E_TIMEOUT，但状态其实已翻成 no-collect。
            if (e?.code === 'E_TIMEOUT' || e?.code === 'E_EXECUTION_UNKNOWN') {
              const probe = await pollToggleState(selector, {
                targetState,
                timeoutMs: Math.min(1200, Number(cfg.writeVerifyTimeoutMs) || 1600),
              })
              after = probe.after
              if (probe.matched) {
                verified = true
                return 'verified'
              }
              if (probe.reads > 0) return 'unchanged'
              unknown = true
              lastError = e
              return 'unknown'
            }
            throw e
          }
          if (r?.inputFocused === true) {
            throw new DouyinError('E_INPUT_FOCUSED', '桥内检测到输入框聚焦，拒绝按快捷键（会打进输入框）')
          }
          if (r?.ok === false) {
            throw new DouyinError('E_REMOTE_IO', '桥内按键被拒（未执行）')
          }
        } else {
          await x11Press()
          via = 'key'
        }
        const poll = await pollToggleState(selector, { targetState, timeoutMs })
        if (poll.matched) {
          after = poll.after
          verified = true
          return 'verified'
        }
        after = poll.after
        if (poll.reads === 0) {
          unknown = true
          lastError = poll.lastError
          return 'unknown'
        }
        return 'unchanged'
      }

      const clickThenVerify = async (timeoutMs) => {
        try {
          await bridge.click(selector, { nth: 0 })
        } catch (e) {
          if (e?.code !== 'E_TIMEOUT') throw e
          // click 超时既可能“没点上”也可能“点上了但 actionability 超时”：先只读确认
          const afterFail = await readToggleState(selector).catch(() => null)
          if (afterFail && afterFail.active === targetState) {
            after = afterFail
            verified = true
            via = 'click'
            return 'verified'
          }
          if (!afterFail) {
            unknown = true
            lastError = e
            via = 'click'
            return 'unknown'
          }
          return 'click-timeout-unchanged'
        }
        const poll = await pollToggleState(selector, { targetState, timeoutMs })
        after = poll.after
        if (poll.matched) {
          verified = true
          return 'verified'
        }
        if (poll.reads === 0) {
          unknown = true
          lastError = poll.lastError
          return 'unknown'
        }
        return 'unchanged'
      }

      if (inputMode === 'key') {
        if (canBridgePress) await pressThenVerify('bridge', cfg.writeVerifyTimeoutMs)
        else if (canX11Press) await pressThenVerify('x11', cfg.writeVerifyTimeoutMs)
        else throw new DouyinError('E_NO_INPUT', '当前传输不支持按快捷键')
      } else if (inputMode === 'click') {
        const r = await clickThenVerify(cfg.writeVerifyTimeoutMs)
        if (r === 'click-timeout-unchanged') {
          // 明确读到没生效：报超时（旧行为），不再补任何动作
          throw new DouyinError('E_TIMEOUT', '点击超时且回读确认状态未变（未重试）')
        }
      } else if (canBridgePress) {
        // 新版 auto：桥内 press 优先
        via = 'press'
        let r1
        try {
          r1 = await pressThenVerify('bridge', Math.min(900, Number(cfg.writeVerifyTimeoutMs) || 900))
        } catch (e) {
          // 评论框正开着/输入框聚焦时桥会拒绝按键（E_INPUT_FOCUSED）。此时**不碰键盘**，
          // 直接改走 click（Playwright 点击不看焦点），避免写操作被输入框状态整块挡住。
          if (e?.code !== 'E_INPUT_FOCUSED') throw e
          r1 = 'focus-blocked'
        }
        if (r1 === 'focus-blocked' || r1 === 'unchanged') {
          const r2 = await clickThenVerify(cfg.writeVerifyTimeoutMs)
          if (r2 === 'click-timeout-unchanged') {
            // click 超时 + 明确没生效 → X11 兜底（与旧路径一致的最后一手）
            const r3 = canX11Press ? await pressThenVerify('x11', cfg.writeVerifyTimeoutMs) : 'unchanged'
            if (r3 === 'verified') via = 'x11'
          }
        }
      } else {
        // 老桥 auto：保持旧顺序
        via = 'click'
        const r = await clickThenVerify(cfg.writeVerifyTimeoutMs)
        if (r === 'click-timeout-unchanged') {
          if (canX11Press) {
            const r2 = await pressThenVerify('x11', cfg.writeVerifyTimeoutMs)
            if (r2 === 'verified') via = 'key'
          }
        }
      }

      // 未核实的 patterns 只做加分项：DOM 回读不确定时，接口 2xx 可以把它升为 verified
      let net = null
      if (!verified) {
        net = await takeNetVerify(netArmed)
        if (net && (unknown || (after && after.active === null))) {
          verified = true
          unknown = false
          via = `${via ?? 'net'}+net`
        }
      }

      // 万级计数假阴性（audit §4.5）：data-e2e-state 缺失时，≥1万 的显示计数用 delta 必为 0，
      // 不能据此判“没生效”，只能判“不知道”。
      let code = null
      if (!verified) {
        if (unknown || !after) {
          code = 'E_EXECUTION_UNKNOWN'
        } else if (after.active !== null) {
          code = 'E_UNVERIFIED'
        } else if (before.count !== null && after.count !== null) {
          const bigCount =
            Number(before.count) >= 10000 ||
            Number(after.count) >= 10000 ||
            /万|w$/.test(String(after.text ?? '') + String(before.text ?? ''))
          if (bigCount) {
            code = 'E_EXECUTION_UNKNOWN'
          } else {
            const delta = after.count - before.count
            verified = targetState ? delta > 0 : delta < 0
            code = verified ? null : 'E_UNVERIFIED'
          }
        } else {
          code = 'E_EXECUTION_UNKNOWN'
        }
      }

      try {
        recordLedger(cfg.downloadDir, {
          videoId,
          action,
          targetState,
          result: verified ? resultText : 'unverified',
          verified,
          detail: {
            before,
            after,
            via,
            ...(net ? { net } : {}),
            ...(code ? { code } : {}),
          },
        })
      } catch (e) {
        log?.warn?.(`[douyin] 写账本失败（不阻断）：${String(e?.message ?? e).slice(0, 120)}`)
      }
      return writeResult({
        action,
        videoId,
        targetState,
        before,
        after,
        verified,
        result: verified ? resultText : undefined,
        code,
        extra: {
          via,
          ...(net ? { net } : {}),
          ...(lastError ? { detail: `回读失败：${String(lastError?.message ?? lastError).slice(0, 160)}` } : {}),
          ...(code === 'E_EXECUTION_UNKNOWN'
            ? { needsReview: true, note: '动作已发出但结果读不到：先只读核对真实状态，不要直接重试' }
            : {}),
        },
      })
    })
  }

  async function like(args = {}) {
    // 抖音网页版快捷键：Z=点赞（2026-11-09 查证）
    return toggleWrite('like', '[data-e2e="video-player-digg"]', args, 'z')
  }

  async function favorite(args = {}) {
    // 抖音网页版快捷键：C=收藏
    return toggleWrite('favorite', '[data-e2e="video-player-collect"]', args, 'c')
  }

  async function comment(args = {}) {
    settleActiveWatch()
    let target
    let text
    try {
      target = await resolveVideoTarget({ videoId: args?.videoId })
      text = String(args?.text ?? '').trim()
      if (!text || Array.from(text).length > 500) throw new DouyinError('E_BAD_ARG', 'text 必须是 1–500 字')
      if (args?.replyTo) throw new DouyinError('E_BAD_ARG', 'replyTo 暂未支持（先只做顶层评论草稿）')
    } catch (e) {
      return toFailure(e)
    }
    const videoId = target.videoId
    const draftOnly = args?.draftOnly !== false
    if (!draftOnly && args?.confirm !== true) {
      return { ok: false, code: 'E_CONFIRM_REQUIRED', message: '提交评论必须 confirm:true', action: 'comment', videoId, targetState: 'posted', verified: false }
    }
    if (!draftOnly) {
      if (!cfg.commentSubmitSelectors.length) {
        return {
          ok: false,
          code: 'E_SELECTOR_MISS',
          message: '评论提交按钮选择器未验证（config.commentSubmitSelectors 为空，不猜）',
          action: 'comment',
          videoId,
          targetState: 'posted',
          verified: false,
        }
      }
      const old = getVerifiedAction(cfg.downloadDir, { videoId, action: 'comment', targetState: 'posted' })
      const oldHash = old?.detail?.textHash
      // 旧账本没有 textHash：按视频幂等（向后兼容）；新账本按内容精确比对（同视频不同评论可再发）
      if (old && args?.force !== true && (!oldHash || oldHash === hash12(text))) {
        return {
          ok: true,
          action: 'comment',
          videoId,
          targetState: 'posted',
          before: old.detail?.before ?? null,
          after: old.detail?.after ?? null,
          verified: true,
          idempotent: true,
          result: old.result,
          note: '该视频已有已验证的评论记录（本次未发送）；要再发一条请传 force:true（仍需 confirm:true）',
        }
      }
    }
    return exec('comment', 0, async () => {
      await openForWrite(videoId)

      // 打开评论栏：固定 sleep → waitFor（新桥一次往返；老桥 count 轮询）
      let panel = 0
      try { panel = await bridge.count('[data-e2e="comment-list"]') } catch { panel = 0 }
      if (panel <= 0) {
        for (const selector of cfg.commentOpenSelectors) {
          try { await bridge.click(selector, { nth: 0, force: true }); break } catch {}
        }
        await waitForAny(
          [...cfg.commentSelectors, '[data-e2e="comment-list"]', ...cfg.commentInputSelectors],
          { timeoutMs: cfg.commentWaitMs, intervalMs: 150 },
        )
      }
      // 输入框：先找已挂载的；没有就点开输入区再等
      let inputSelector = ''
      for (const selector of cfg.commentInputSelectors) {
        try { if (await bridge.count(selector) > 0) { inputSelector = selector; break } } catch {}
      }
      if (!inputSelector) {
        for (const selector of cfg.commentInputOpenSelectors) {
          try { await bridge.click(selector, { nth: 0, force: true }); break } catch {}
        }
        const found = await waitForAny(cfg.commentInputSelectors, {
          timeoutMs: cfg.commentDraftWaitMs > 0 ? cfg.commentDraftWaitMs : cfg.waitForTimeoutMs,
          intervalMs: 120,
        })
        inputSelector = found.matched ? found.selector : ''
        if (!inputSelector) {
          for (const selector of cfg.commentInputSelectors) {
            try { if (await bridge.count(selector) > 0) { inputSelector = selector; break } } catch {}
          }
        }
      }
      if (!inputSelector) throw new DouyinError('E_SELECTOR_MISS', '评论输入框选择器未命中（不猜）')

      const beforeText = await bridge.text(inputSelector).catch(() => '')
      const before = { draft: beforeText || '' }
      // 协议 v2：桥内 type 优先（Playwright fill/insertText，支持中文，不再依赖 X11 焦点）；
      // 老桥/桥内失败 → 现有 X11 路径（点输入框取焦 + clearText/pasteText）。
      const supportsBridgeType = await supportsCap(bridge, 'type')
      const readDraft = async () => squash((await bridge.text(inputSelector).catch(() => '')) || '')
      /** X11 清空草稿（保留必要等待：ctrl+a+BackSpace 生效） */
      const x11ClearDraft = async () => {
        if (typeof transport.clearText !== 'function') return false
        await transport.clearText()
        await waitForTextEmpty(inputSelector, { timeoutMs: 600, intervalMs: 100 })
        return true
      }
      /** 桥内“清空”：type 没有单独的 clear 命令，且后续 fill 都带 clear:true，这里只做空操作记录 */
      const clearDraft = async () => {
        if (supportsBridgeType) return true
        return x11ClearDraft()
      }
      /** X11 一次输入（paste 优先 / type 兜底） */
      const x11InputText = async (value) => {
        if (typeof transport.pasteText === 'function') {
          try {
            await transport.pasteText(value)
            return 'paste'
          } catch (e) {
            if (typeof transport.typeText !== 'function') throw e
            log?.warn?.(`[douyin] 剪贴板粘贴失败，回退逐字输入：${String(e?.message ?? e).slice(0, 120)}`)
          }
        }
        if (typeof transport.typeText !== 'function') {
          throw new DouyinError('E_NO_INPUT', '当前传输不支持输入草稿')
        }
        await transport.typeText(value)
        return 'type'
      }
      /** 普通正文：桥内 type(clear:true) 优先，X11 兜底 */
      const inputText = async () => {
        if (supportsBridgeType) {
          const r = await bridgeTypeText(inputSelector, text, { clear: true, mode: 'auto' })
          if (r) return `type+${r.via}`
        }
        return x11InputText(text)
      }
      // 文本以 @名字 开头时，必须先键盘打 @ 才会弹提及候选（粘贴的 @ 只是普通字符），
      // 选中候选后再追加剩余正文。2026-11-10 真机验证：@豆包 → 回车 → douyin_mention_word + 正文。
      const mentionMatch = text.match(/^@([^\s@]{1,20})(?:\s+([\s\S]+))?$/)
      const mention = mentionMatch ? { name: mentionMatch[1], rest: mentionMatch[2] || '' } : null
      /** 候选列表：轮询到有内容或超时 */
      const listMentionRows = async () => {
        for (const sel of cfg.commentMentionSelectors) {
          const poll = await pollUntil(async () => {
            const rows = await bridge.list(sel, { limit: 10, textLen: 60 }).catch(() => [])
            return rows.length ? rows : null
          }, { timeoutMs: cfg.commentMentionWaitMs, intervalMs: 120 })
          if (poll.matched) return poll.value
        }
        return []
      }
      /** @提及：桥内 type(mode keys/insert) 优先；老桥走 X11 逐字 */
      const typeMention = async (name) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (attempt > 0) await clearDraft()
          if (supportsBridgeType) {
            // keys 只支持可打印 ASCII；中文名字用 insert（同样派发 input 事件，能触发提及候选）
            const mode = /^[\x20-\x7E]+$/.test(name) ? 'keys' : 'insert'
            const typed = await bridgeTypeText(inputSelector, `@${name}`, { clear: attempt === 0, mode })
            if (!typed) {
              // 桥内输入失败 → 本次改走 X11（DOM 明确没改）
              await transport.typeText('@')
              await waitForTextContains(inputSelector, '@', { timeoutMs: 600, intervalMs: 100 })
              await transport.typeText(name)
            }
          } else {
            await transport.typeText('@')
            await waitForTextContains(inputSelector, '@', { timeoutMs: 600, intervalMs: 100 })
            await transport.typeText(name)
          }
          const cur = await readDraft()
          if (!cur.includes(`@${name}`)) continue
          const rows = await listMentionRows()
          const hit = rows.findIndex((r) => squash(r?.text ?? '') === name)
          const idx = hit >= 0 ? hit : 0
          if (idx === 0) await bridge.press('Enter', { allowFocused: true })
          else await bridge.click(cfg.commentMentionSelectors[0], { nth: idx })
          const ok = await pollUntil(async () => {
            const chips = await bridge.count(cfg.commentMentionChipSelector).catch(() => 0)
            if (chips > 0) return true
            const draftNow = await readDraft()
            return draftNow.includes(`@${name}`) ? true : null
          }, { timeoutMs: cfg.commentMentionWaitMs, intervalMs: 120 })
          if (ok.matched) return true
        }
        return false
      }
      const fillDraft = async () => {
        if (!mention) return await inputText()
        const ok = await typeMention(mention.name)
        if (!ok) return null
        // 注意用原始文本判断结尾空格：squash 会 trim，导致误加第二个空格
        const curRaw = (await bridge.text(inputSelector).catch(() => '')) || ''
        if (mention.rest) {
          if (supportsBridgeType) {
            // 候选芯片已插入：后续正文只能 insert 追加（fill 会覆盖整段草稿）
            const prefix = /\s$/.test(curRaw) ? '' : ' '
            const r = await bridgeTypeText(inputSelector, `${prefix}${mention.rest.trimStart()}`, {
              clear: false,
              mode: 'insert',
            })
            if (!r) {
              if (!/\s$/.test(curRaw)) await transport.typeText(' ')
              await transport.pasteText(mention.rest.trimStart())
            }
            return 'mention+paste'
          }
          if (!/\s$/.test(curRaw)) await transport.typeText(' ')
          await transport.pasteText(mention.rest.trimStart())
        }
        return 'mention+paste'
      }
      /** 草稿是否已包含目标文本（@提及：芯片文本可能不含完整 @名字，放宽到正文片断） */
      const draftHasText = (draft, source) => {
        const s = squash(draft)
        if (s.includes(source)) return true
        if (mention?.rest) return s.includes(mention.rest.trimStart()) && s.includes(mention.name)
        return false
      }
      // X11 路径必须先点输入框拿焦点（桥内 type 不需要，省掉这次 click + 400ms 取焦等待）
      if (!supportsBridgeType) {
        await bridge.click(inputSelector, { nth: 0, force: true })
        // 点击后 DraftEditor 要过一会儿才真正拿到焦点；2026-11-09 实测立刻打字会丢首字
        await sleep(150)
      }
      if (supportsBridgeType) {
        // 已有草稿由 type(clear:true) 原子替换，不再单独 clearText
      } else if (beforeText && beforeText.trim()) {
        await x11ClearDraft()
      }
      let inputVia = await fillDraft()
      if (inputVia === null) {
        await clearDraft()
        return {
          ok: false,
          code: 'E_UNVERIFIED',
          action: 'comment',
          videoId,
          targetState: 'draft',
          before,
          after: { draft: await readDraft() },
          verified: false,
          draftFilled: false,
          mention: mention?.name ?? null,
          message: '提及没有选中（候选没出现或名字不匹配），未提交',
        }
      }
      // 草稿回读：轮询到包含目标文本（替代固定 commentDraftWaitMs sleep）
      let draftPoll = await waitForTextContains(inputSelector, mention ? mention.name : text, {
        timeoutMs: cfg.commentDraftWaitMs > 0 ? cfg.commentDraftWaitMs : cfg.waitForTimeoutMs,
        intervalMs: cfg.writeVerifyPollMs,
      })
      let draftValue = draftPoll.matched ? draftPoll.text : await readDraft()
      if (!draftHasText(draftValue, text)) {
        // 本地草稿：清空重来一次（丢字/残留都能救；不涉及提交）
        await clearDraft()
        inputVia = await fillDraft()
        if (inputVia === null) {
          await clearDraft()
          return {
            ok: false,
            code: 'E_UNVERIFIED',
            action: 'comment',
            videoId,
            targetState: 'draft',
            before,
            after: { draft: await readDraft() },
            verified: false,
            draftFilled: false,
            mention: mention?.name ?? null,
            message: '提及没有选中（重试后仍失败），未提交',
          }
        }
        draftPoll = await waitForTextContains(inputSelector, mention ? mention.name : text, {
          timeoutMs: cfg.commentDraftWaitMs > 0 ? cfg.commentDraftWaitMs : cfg.waitForTimeoutMs,
          intervalMs: cfg.writeVerifyPollMs,
        })
        draftValue = draftPoll.matched ? draftPoll.text : await readDraft()
      }
      if (!draftValue.includes(text)) {
        return { ok: false, code: 'E_UNVERIFIED', action: 'comment', videoId, targetState: 'draft', before, after: { draft: draftValue }, verified: false, draftFilled: false, mention: mention?.name ?? null }
      }
      if (draftOnly) {
        return {
          ok: true,
          action: 'comment',
          videoId,
          targetState: 'draft',
          before,
          after: { draft: draftValue },
          verified: true,
          draftFilled: true,
          draftValue,
          inputVia,
          mention: mention?.name ?? null,
        }
      }

      // 提交：只点 config 白名单里的提交按钮；默认空 = 未验证，不猜
      if (!cfg.commentSubmitSelectors.length) {
        throw new DouyinError('E_SELECTOR_MISS', '评论提交按钮选择器未验证（config.commentSubmitSelectors 为空，不猜）')
      }
      let submitSelector = ''
      for (const selector of cfg.commentSubmitSelectors) {
        try { if (await bridge.count(selector) > 0) { submitSelector = selector; break } } catch {}
      }
      if (!submitSelector) throw new DouyinError('E_SELECTOR_MISS', '评论提交按钮选择器未命中（不猜）')
      // 发送图标点击优先；若被浮层挡住（E_TIMEOUT），DraftEditor 仍聚焦，用 Enter 提交兜底。
      // 防重复提交（audit §4.2）：点前先回读草稿；草稿已清空/已出现评论 = 点击其实生效了，绝不再 Enter。
      const netArmed = await armNetVerify(netPatternsFor('comment'))
      let submitVia = 'click'
      try {
        await bridge.click(submitSelector, { nth: 0 })
      } catch (e) {
        if (e?.code !== 'E_TIMEOUT') throw e
        const draftNow = await bridge.text(inputSelector).catch(() => null)
        if (draftNow === null) {
          // 读不到草稿 = 不知道是否已提交：不按 Enter（绝不重放），交给回读判定
          submitVia = 'unknown'
        } else if (!draftNow.includes(text)) {
          submitVia = 'click'
        } else {
          submitVia = 'enter'
          await bridge.press('Enter', { allowFocused: true })
        }
      }
      // 写后回读：轮询到评论出现（替代固定 commentSubmitWaitMs sleep；一次往返/次）
      const verifyPoll = await pollUntil(async () => {
        const rows = await bridge.list(cfg.commentSelectors[0], { attrs: [], limit: 50, textLen: cfg.commentTextLen })
        const parsed = parseCommentItems(rows, cfg.commentTextLen)
        return parsed.some((item) => String(item.text ?? '').includes(text) || String(item.text ?? '').includes(text.slice(0, 30)))
          ? parsed
          : null
      }, { timeoutMs: cfg.commentSubmitWaitMs > 0 ? cfg.commentSubmitWaitMs : cfg.writeVerifyTimeoutMs, intervalMs: cfg.writeVerifyPollMs })
      let verified = verifyPoll.matched
      let net = null
      if (!verified) {
        net = await takeNetVerify(netArmed)
        if (net) verified = true
      }
      const resultCode = verified ? null : verifyPoll.reads === 0 ? 'E_EXECUTION_UNKNOWN' : 'E_UNVERIFIED'
      try {
        recordLedger(cfg.downloadDir, {
          videoId,
          action: 'comment',
          targetState: 'posted',
          result: verified ? 'commented' : 'unverified',
          verified,
          detail: {
            before,
            after: { draft: draftValue },
            submitVia,
            inputVia,
            textHash: hash12(text),
            ...(net ? { net } : {}),
            ...(resultCode ? { code: resultCode } : {}),
          },
        })
      } catch {}
      return {
        ok: verified,
        action: 'comment',
        videoId,
        targetState: 'posted',
        before,
        after: { draft: draftValue },
        verified,
        draftFilled: true,
        submitVia,
        inputVia,
        mention: mention?.name ?? null,
        ...(verified ? { result: 'commented' } : { code: resultCode }),
        ...(resultCode === 'E_EXECUTION_UNKNOWN'
          ? { needsReview: true, note: '动作已发出但结果读不到：先只读核对视频评论，不要直接重试' }
          : {}),
      }
    })
  }

  /**
   * 删除自己的一条评论：按文本在当前已加载评论里定位 → 点该条「更多」→ 点「删除评论」→ 回读确认。
   * 别人的评论菜单里没有「删除评论」→ E_SELECTOR_MISS；文本找不到 → E_NOT_FOUND（绝不盲删）。
   */
  async function commentDelete(args = {}) {
    settleActiveWatch()
    let target
    let text
    try {
      target = await resolveVideoTarget({ videoId: args?.videoId })
      text = String(args?.text ?? '').trim()
      if (!text || Array.from(text).length > 500) throw new DouyinError('E_BAD_ARG', 'text 必须是 1–500 字')
    } catch (e) {
      return toFailure(e)
    }
    const videoId = target.videoId
    if (args?.confirm !== true) {
      return { ok: false, code: 'E_CONFIRM_REQUIRED', message: '删除评论必须 confirm:true', action: 'comment_delete', videoId, targetState: 'deleted', verified: false }
    }
    // 幂等：同一视频 + 同一文本已“已验证删除” → 直接返回，不重复点菜单（菜单可能已不在）
    const oldDelete = getVerifiedAction(cfg.downloadDir, { videoId, action: 'comment_delete', targetState: 'deleted' })
    if (oldDelete && (args?.force !== true) && oldDelete.detail?.textHash === hash12(text)) {
      return {
        ok: true,
        action: 'comment_delete',
        videoId,
        targetState: 'deleted',
        deletedText: text,
        verified: true,
        idempotent: true,
        result: oldDelete.result,
      }
    }
    return exec('comment_delete', 0, async () => {
      await openForWrite(videoId)
      let panel = 0
      try { panel = await bridge.count('[data-e2e="comment-list"]') } catch { panel = 0 }
      if (panel <= 0) {
        for (const selector of cfg.commentOpenSelectors) {
          try { await bridge.click(selector, { nth: 0, force: true }); break } catch {}
        }
        await waitForAny(
          [...cfg.commentSelectors, '[data-e2e="comment-list"]', '[data-e2e="comment-item"]'],
          { timeoutMs: cfg.commentWaitMs, intervalMs: 150 },
        )
      }
      const items = await bridge.list('[data-e2e="comment-item"]', { limit: 50, textLen: 500 })
      const idx = items.findIndex((r) => String(r?.text ?? '').includes(text))
      if (idx < 0) {
        throw new DouyinError('E_NOT_FOUND', `已加载的 ${items.length} 条评论里没有包含「${text}」的（可能未加载/被折叠，不能盲删）`)
      }
      const netArmed = await armNetVerify(['/comment/delete/'])
      await bridge.click(cfg.commentMoreSelectors[0], { nth: idx })
      const menu = await waitForAny(cfg.commentDeleteSelectors, { timeoutMs: 800, intervalMs: 150 })
      if (!menu.matched) {
        throw new DouyinError('E_SELECTOR_MISS', '没有「删除评论」菜单项：这条可能不是自己的评论')
      }
      await bridge.click(menu.selector, { nth: 0 })
      // 回读确认：轮询到该条评论消失（替代固定 800ms）；读不到 = 不确定，绝不重试删除
      const verifyPoll = await pollUntil(async () => {
        const rows = await bridge.list('[data-e2e="comment-item"]', { limit: 50, textLen: 500 })
        return rows.some((r) => String(r?.text ?? '').includes(text)) ? null : rows
      }, { timeoutMs: cfg.writeVerifyTimeoutMs, intervalMs: cfg.writeVerifyPollMs })
      const after = verifyPoll.matched ? verifyPoll.value : items
      const still = !verifyPoll.matched
      const unknown = !verifyPoll.matched && verifyPoll.reads === 0
      let net = null
      if (still) {
        net = await takeNetVerify(netArmed)
        if (!net && unknown) {
          // 读不到评论列表 = 不知道删没删：E_EXECUTION_UNKNOWN，绝不重试
          try {
            recordLedger(cfg.downloadDir, {
              videoId,
              action: 'comment_delete',
              targetState: 'deleted',
              result: 'unverified',
              verified: false,
              detail: { text, index: idx, textHash: hash12(text), code: 'E_EXECUTION_UNKNOWN' },
            })
          } catch {}
          return {
            ok: false,
            code: 'E_EXECUTION_UNKNOWN',
            needsReview: true,
            action: 'comment_delete',
            videoId,
            targetState: 'deleted',
            deletedText: text,
            matchedIndex: idx,
            loadedBefore: items.length,
            verified: false,
            note: '删除点击已发出但评论列表读不到：先只读核对，不要重试删除',
          }
        }
      }
      const verified = !still || !!net
      try {
        recordLedger(cfg.downloadDir, {
          videoId,
          action: 'comment_delete',
          targetState: 'deleted',
          result: verified ? 'deleted' : 'unverified',
          verified,
          detail: { text, index: idx, textHash: hash12(text), ...(net ? { net } : {}) },
        })
      } catch (e) {
        log?.warn?.(`[douyin] 写账本失败（不阻断）：${String(e?.message ?? e).slice(0, 120)}`)
      }
      if (!verified) {
        return { ok: false, code: 'E_UNVERIFIED', action: 'comment_delete', videoId, targetState: 'deleted', deletedText: text, matchedIndex: idx, loadedBefore: items.length, loadedAfter: after.length, verified: false }
      }
      // 评论已删：清掉该视频的 comment:posted 账本，否则同视频再评论会被幂等挡住
      try {
        removeLedger(cfg.downloadDir, { videoId, action: 'comment', targetState: 'posted' })
      } catch (e) {
        log?.warn?.(`[douyin] 清理评论账本失败（不阻断）：${String(e?.message ?? e).slice(0, 120)}`)
      }
      // loadedBefore/loadedAfter 是“本次抓取到的条数”，不是视频总评论数；删一条后下一条会补位，两个数可能相同
      return { ok: true, action: 'comment_delete', videoId, targetState: 'deleted', deletedText: text, matchedIndex: idx, loadedBefore: items.length, loadedAfter: after.length, verified: true, result: 'deleted' }
    })
  }

  /**
   * 显式下载：只有她明确调用才执行；不自动下载 feed。
   * 媒体 URL 从远程当前视频页的 <video><source src> 读取（已有只读 list 命令），
   * 再由本地 fetch 拉流；quality 仅做参数校验，当前取页面首个 source（通常最高码率）。
   */
  async function download(args = {}) {
    // download 是显式工具调用：按“下一次浏览类调用”结算上一条 watch，但不开始新 watch
    settleActiveWatch()
    let target
    try {
      target = await resolveVideoTargetAsync(args, { fetchImpl })
      normalizeDownloadQuality(args?.quality)
    } catch (e) {
      return toFailure(e)
    }
    return exec('download', 0, async () => {
      // 同一 videoId 已有完整文件和 sidecar：直接复用，不重新拉流/重写
      const cached = readSidecar(cfg.downloadDir, target.videoId)
      if (cached && cached.file && existsSync(cached.file)) {
        try {
          if (statSync(cached.file).size === Number(cached.bytes)) {
            return {
              ok: true,
              videoId: target.videoId,
              file: cached.file,
              bytes: cached.bytes,
              seconds: cached.seconds,
              title: cached.title,
              author: cached.author,
              cached: true,
              duplicate: true,
            }
          }
        } catch {}
      }
      let current = ''
      try {
        current = await bridge.url()
      } catch {
        // 读不到 URL 时按需要打开处理
      }
      // 搜索页卡片作者：必须在 open 目标视频页之前抓，否则卡片 DOM 已经不在
      let searchAuthor = ''
      if (current.includes('/search/')) {
        try {
          const rows = await bridge.list(cfg.searchSelector, { attrs: ['href'], limit: 10, textLen: 120 })
          const hit = rows.find((row) => {
            const href = String(row?.href ?? '')
            return href.includes(`/video/${target.videoId}`) || href.includes(`modal_id=${target.videoId}`)
          })
          if (hit) searchAuthor = extractAuthorFromText(hit.text)
        } catch {
          searchAuthor = ''
        }
      }
      if (!current.includes(`/video/${target.videoId}`)) {
        const opened = await bridge.open(target.url)
        if (/验证码|captcha|安全验证|滑块/i.test(opened.title)) {
          throw new DouyinError('E_CHALLENGE', '视频页出现验证码/安全验证，已停止（需人工处理）')
        }
      }

      // 先读 outerHTML 解析 <source src>；长视频页的 <video> 可能晚几秒才挂载，轮询等待
      let urls = []
      for (let attempt = 0; attempt < 12 && !urls.length; attempt++) {
        if (attempt > 0) await sleep(1000)
        try {
          urls = extractMediaUrlsFromHtml(await bridge.html('video', { max: 12000 }))
        } catch {
          urls = []
        }
        if (!urls.length) {
          try {
            const rows = await bridge.list('video source', { attrs: ['src'], limit: 10, textLen: 20 })
            urls = extractMediaUrls(rows)
          } catch {
            urls = []
          }
        }
      }
      if (!urls.length) {
        throw new DouyinError(
          'E_NO_MEDIA',
          '没有取到视频媒体流；请主人在远程浏览器手动保存文件（插件不做绕路）',
        )
      }

      let title = ''
      try {
        title = await bridge.title()
      } catch {
        title = ''
      }

      // 作者：JSON-LD（真实页面 Breadcrumb 第二项）→ 页面 HTML → 页面文本；取不到才“未知”
      let author = ''
      const htmlOr = async (selector, max) => {
        try {
          return await bridge.html(selector, { max })
        } catch {
          return ''
        }
      }
      author = extractAuthorFromLdJsonHtml(await htmlOr('script[type="application/ld+json"]', 12000))
      if (!author) author = extractAuthorFromHtml(await htmlOr('body', 50000))
      if (!author) {
        try {
          author = extractAuthorFromText(await bridge.text('body'))
        } catch {
          author = ''
        }
      }
      if (!author && searchAuthor) author = searchAuthor
      author = author || '未知'

      const saved = await downloadMedia({
        url: urls[0],
        videoId: target.videoId,
        dir: cfg.downloadDir,
        fetchImpl,
      })
      // 下载只保存文件+sidecar 元数据；观看记忆由 dy_douyin_watch 在“看完后”写
      try {
        writeSidecar(cfg.downloadDir, {
          videoId: target.videoId,
          title,
          author,
          file: saved.file,
          bytes: saved.bytes,
          seconds: saved.seconds,
          downloadedAt: new Date(clock()).toISOString(),
        })
      } catch (e) {
        log?.warn?.(`[douyin] sidecar 写入失败（下载已完成）：${String(e?.message ?? e).slice(0, 160)}`)
      }
      const result = {
        ok: true,
        videoId: target.videoId,
        file: saved.file,
        bytes: saved.bytes,
        seconds: saved.seconds,
        author,
      }
      if (title) result.title = title
      return result
    })
  }

  async function screenshot() {
    return exec('screenshot', 0, async () => {
      const shot = await bridge.screenshot()
      const remote = assertSafeShotPath(shot.file, cfg.shotsDir)
      if (typeof transport.readFile !== 'function') {
        throw new DouyinError('E_REMOTE_IO', '当前传输不支持取回截图文件')
      }
      const buf = await transport.readFile(remote, {
        timeoutMs: cfg.callTimeoutMs,
        maxBytes: cfg.maxScreenshotBytes,
      })
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        throw new DouyinError('E_REMOTE_IO', '远程截图为空')
      }
      if (buf.length > cfg.maxScreenshotBytes) {
        throw new DouyinError('E_REMOTE_IO', `截图超过 ${cfg.maxScreenshotBytes} 字节上限`)
      }
      if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new DouyinError('E_REMOTE_IO', '远程返回的不是 PNG 截图')
      }
      const dir = cfg.screenshotDir
      const file = join(dir, `douyin-${stamp(clock(), tz)}-${basename(remote)}`)
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        writeFileSync(file, buf, { mode: 0o600 })
      } catch (e) {
        throw new DouyinError('E_REMOTE_IO', `截图落盘失败：${String(e?.message ?? e).slice(0, 200)}`)
      }
      return { ok: true, file, bytes: buf.length }
    })
  }

  function usage() {
    try {
      return { ok: true, ...limiter.usage(clock()) }
    } catch (e) {
      return toFailure(e)
    }
  }

  /** 回复一条 1 小时内的新评论；旧评论 E_STALE，找不到 E_NOT_FOUND，不盲回 */
  async function commentReply(args = {}) {
    settleActiveWatch()
    let videoId
    let target
    let text
    try {
      const t = await resolveVideoTarget({ videoId: args?.videoId })
      videoId = t.videoId
      target = String(args?.target ?? '').trim()
      text = String(args?.text ?? '').trim()
      if (!target || Array.from(target).length > 100) throw new DouyinError('E_BAD_ARG', 'target 必须是 1–100 字（评论正文或作者）')
      if (!text || Array.from(text).length > 500) throw new DouyinError('E_BAD_ARG', 'text 必须是 1–500 字')
    } catch (e) {
      return toFailure(e)
    }
    const base = { ok: false, action: 'comment_reply', videoId, target: cut(squash(target), 80) }
    if (args?.confirm !== true) {
      return { ...base, code: 'E_CONFIRM_REQUIRED', message: '回复评论必须 confirm:true', verified: false }
    }
    return exec('comment_reply', 0, async () => {
      await openForWrite(videoId)
      let panel = 0
      try { panel = await bridge.count('[data-e2e="comment-list"]') } catch { panel = 0 }
      if (panel <= 0) {
        for (const selector of cfg.commentOpenSelectors) {
          try { await bridge.click(selector, { nth: 0, force: true }); break } catch {}
        }
        await sleep(cfg.commentWaitMs)
      }
      let rows = []
      let usedSelector = cfg.commentSelectors[0]
      let items = []
      let idx = -1
      for (let attempt = 0; attempt <= Math.max(2, Number(cfg.commentRetries) || 0) && idx < 0; attempt++) {
        if (attempt > 0) await sleep(cfg.commentWaitMs)
        // 不能只看第一个有结果的选择器：草荧可能在 comment-list 行里，而 comment-item 只有前几条
        for (const selector of cfg.commentSelectors) {
          try {
            const next = await bridge.list(selector, { attrs: [], limit: 50, textLen: cfg.commentTextLen })
            if (!next.length) continue
            const parsed = parseCommentItems(next, cfg.commentTextLen)
            const found = parsed.findIndex((it) => String(it.text ?? '').includes(target) || String(it.author ?? '') === target)
            if (found >= 0) { rows = next; usedSelector = selector; items = parsed; idx = found; break }
            if (!rows.length) { rows = next; usedSelector = selector; items = parsed }
          } catch { /* 换下一个选择器 */ }
        }
        if (idx < 0) {
          items = parseCommentItems(rows, cfg.commentTextLen)
          idx = items.findIndex((it) => String(it.text ?? '').includes(target) || String(it.author ?? '') === target)
        }
        if (idx >= 0) break
        // 评论楼中楼/展开：把当前页所有“展开N条回复”点开，再读一轮
        try {
          const expand = await bridge.count('button.comment-reply-expand-btn')
          const max = Math.min(8, Math.max(0, Number(cfg.commentReplyExpandMax) || 0), Number(expand) || 0)
          for (let i = 0; i < max; i++) {
            try { await bridge.click('button.comment-reply-expand-btn', { nth: 0 }) } catch { break }
            await sleep(cfg.commentReplyWaitMs)
          }
          if (max > 0) {
            for (const selector of cfg.commentSelectors) {
              try {
                const next = await bridge.list(selector, { attrs: [], limit: 50, textLen: cfg.commentTextLen })
                if (next.length) { rows = next; usedSelector = selector; break }
              } catch {}
            }
            items = parseCommentItems(rows, cfg.commentTextLen)
            idx = items.findIndex((it) => String(it.text ?? '').includes(target) || String(it.author ?? '') === target)
          }
        } catch {}
      }
      if (idx < 0) throw new DouyinError('E_NOT_FOUND', `已加载的评论里没有匹配「${target}」的（不盲回）`)
      const age = parseCommentAgeMs(items[idx].time, clock())
      const unlimited = !(Number(cfg.commentReplyWindowMs) > 0)
      if (!unlimited && (age === null || age > cfg.commentReplyWindowMs)) {
        return {
          ...base,
          code: 'E_STALE',
          message: `目标评论${items[idx].time ? `（${items[idx].time}）` : ''}超过 ${Math.round(cfg.commentReplyWindowMs / 60000)} 分钟，不能回`,
          verified: false,
        }
      }
      const replyBtn = `${usedSelector} >> nth=${idx} >> text=回复`
      await bridge.click(replyBtn, { nth: 0, force: true })
      const replyBox = await waitForSelector('.comment-input-container-focus', { timeoutMs: 1600 })
      if (!replyBox.matched) throw new DouyinError('E_SELECTOR_MISS', '回复输入框没有出现（未进入回复态）')
      await bridge.click(cfg.commentReplyInputSelector, { nth: 0, force: true })
      const filled = await fillEditorText({ client: bridge, selector: cfg.commentReplyInputSelector, text })
      if (!filled.ok) {
        return { ...base, code: 'E_UNVERIFIED', message: '回复草稿读回不一致', draft: filled.draft, verified: false }
      }
      await bridge.click(cfg.commentReplySendSelector, { nth: 0 })
      // 提交后轮询回读（命中即返回），不再固定 sleep 1.5s
      const posted = await pollUntil(async () => {
        let afterRows = []
        for (const selector of cfg.commentSelectors) {
          try { afterRows = await bridge.list(selector, { attrs: [], limit: 20, textLen: cfg.commentTextLen }) } catch { afterRows = [] }
          if (afterRows.length) break
        }
        const afterItems = parseCommentItems(afterRows, cfg.commentTextLen)
        const afterItem = afterItems.find((it) => String(it.text ?? '').includes(target) || String(it.author ?? '') === target) || null
        return afterItem && (afterItem.replies || []).some((r) => String(r.text ?? '').includes(text)) ? true : null
      }, { timeoutMs: Math.max(2000, Number(cfg.commentSubmitWaitMs) || 1500), intervalMs: 400 })
      const verified = posted.matched === true
      const textHash = createHash('sha256').update(text).digest('hex').slice(0, 12)
      try {
        recordLedger(cfg.downloadDir, {
          videoId,
          action: 'comment_reply',
          targetState: 'posted',
          result: verified ? 'replied' : 'unverified',
          verified,
          detail: { target: cut(squash(target), 80), chars: Array.from(text).length, textHash },
        })
      } catch {}
      if (!verified) return { ...base, code: 'E_UNVERIFIED', message: '回复后回读不到这条', verified: false }
      return { ok: true, action: 'comment_reply', videoId, target: cut(squash(target), 80), verified: true, result: 'replied', chars: Array.from(text).length, textHash }
    })
  }

  // ===== 私信（/chat）=====
  // 2026-11-10 真实页面：会话名 [class~="conversationConversationItemtitle"]，
  // 消息容器 [class~="MessageItemTextcontainer"]（类名含 isFromMe = 自己发的），
  // 输入 [data-slate-editor="true"]（Slate），发送 .e2e-send-msg-btn（有文本时多 messageMsgInputpublishRedBtn）。

  /** 主人会话名（一行文本）；空 = 没有“可主动发”的例外 */
  function readDmOwner() {
    try {
      if (!existsSync(cfg.dmOwnerFile)) return ''
      return String(readFileSync(cfg.dmOwnerFile, 'utf8')).split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
    } catch {
      return ''
    }
  }

  /** 主人别名 = dmOwnerAliases + dm-owner.txt 第一行（并集，去重） */
  function ownerAliases() {
    return mergeOwnerAliases(cfg.dmOwnerAliases, readDmOwner())
  }

  /** 抖音私信时间标签 → 距今毫秒；识别不了（日期/昨天）返回 null = 视为过期 */
  function parseDmAgeMs(label, now = clock()) {
    const text = squash(label)
    if (!text) return null
    if (text === '刚刚') return 0
    let m = text.match(/^(\d+)\s*分钟前$/)
    if (m) return Number(m[1]) * MINUTE_MS
    m = text.match(/^(\d+)\s*小时前$/)
    if (m) return Number(m[1]) * 60 * MINUTE_MS
    m = text.match(/^(\d{1,2}):(\d{2})$/)
    if (m) {
      const d = new Date(now + tz * MINUTE_MS)
      const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(m[1]), Number(m[2])) - tz * MINUTE_MS
      let age = now - t
      if (age < -MINUTE_MS) age += 24 * 60 * MINUTE_MS
      return Math.max(0, age)
    }
    return null
  }

  /** 点开会话：普通 click 被浮层/动画挡住时用 force 兜底（只点会话条目，不点别的）。 */
  async function clickConversation(idx, name = '') {
    const selector = cfg.dmConversationSelectors[0]
    const attempts = [
      () => dmBridge.click(selector, { nth: idx }),
      () => dmBridge.click(selector, { nth: idx, force: true }),
    ]
    if (name) {
      attempts.push(() => dmBridge.click(`${selector}:has-text(${JSON.stringify(name)})`, { force: true }))
      attempts.push(() => dmBridge.click(`.conversationConversationItemtitle:text-is(${JSON.stringify(name)})`, { force: true }))
    }
    let last = null
    for (const attempt of attempts) {
      try {
        await attempt()
        for (let i = 0; i < 8; i++) {
          const inputs = await dmBridge.count(cfg.dmInputSelector).catch(() => 0)
          if (inputs > 0) return true
          await sleep(400)
        }
        return true
      } catch (e) { last = e }
    }
    throw last ?? new DouyinError('E_SELECTOR_MISS', '会话点不开')
  }

  /**
   * watcher 方向探针：会话预览只给文字+时间，看不到「谁发的」。
   * 预览变化时点开该会话，只读最后一条消息的 isFromMe，用来过滤汐自己发出的消息。
   * 不写、不回复；可能把该会话标为已读（当前页本来就在 /chat）。
   */
  async function dmProbeDirection(args = {}) {
    const prev = await currentUrlOrEmpty(dmBridge).catch(() => '')
    try {
      await openDm()
      const conversations = await listDmConversations()
      const picked = resolveDmConversation(conversations, {
        name: String(args?.name ?? '').trim(),
        conversationId: String(args?.conversationId ?? '').trim(),
        index: Number.isInteger(args?.index) ? args.index : null,
      })
      if (!picked?.ok) return { ok: false, code: picked?.code ?? 'NOT_FOUND', message: picked?.message }
      const messages = await readConversationMessages(picked.index)
      const last = messages.length ? messages[messages.length - 1] : null
      return { ok: true, fromMe: last?.fromMe === true, text: last?.text ?? '', time: last?.time ?? '', conversationId: picked.item?.id ?? args?.conversationId ?? null }
    } catch (e) {
      return toFailure(e)
    } finally {
      // 保持在 /chat（watcher 需要页面常驻），不恢复 main
      if (!prev.includes('/chat')) { /* 保持 /chat */ }
    }
  }

  /** 点开会话并读消息（带时间标签）；时间标签是分组分隔，按 DOM 顺序挂到后面的消息上 */
  async function readConversationMessages(idx) {
    await clickConversation(idx)
    await sleep(cfg.dmConversationWaitMs)
    const selector = `${cfg.dmTimeLayoutSelector}, ${cfg.dmMessageSelectors[0]}`
    const rows = await dmBridge.list(selector, { attrs: ['class'], limit: 50, textLen: 500 })
    return parseDmMessageRows(rows)
  }

  /** 今日成功发出的私信条数（读审计 jsonl；失败不占额度） */
  function countDmSendsToday(now = clock()) {
    try {
      if (!cfg.auditFile || !existsSync(cfg.auditFile)) return 0
      const day = new Date(now + tz * MINUTE_MS).toISOString().slice(0, 10)
      let n = 0
      for (const line of readFileSync(cfg.auditFile, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line)
          if (e?.cmd === 'dm_send' && e.ok === true && String(e.at ?? '').slice(0, 10) === day) n += 1
        } catch {
          // 坏行跳过
        }
      }
      return n
    } catch {
      return 0
    }
  }

  /** 读某个 role 的 URL；缺省 main（旧调用语义不变）。 */
  const currentUrlOrEmpty = async (client = bridge) => {
    try { return await client.url() } catch { return '' }
  }
  async function restorePage(prev, client = bridge) {
    if (!prev || prev.includes('/chat')) return false
    if (!/^https:\/\/(www\.)?douyin\.com\//.test(prev)) return false
    try {
      await client.open(prev)
      return true
    } catch (e) {
      log?.warn?.(`[douyin] 恢复页面失败（不阻断）：${String(e?.message ?? e).slice(0, 120)}`)
      return false
    }
  }

  async function openDm() {
    // 2026-11-14：主站右上角「消息」入口比 /chat 更快、更稳；先看面板是否已开。
    let current = ''
    try { current = await dmBridge.url() } catch { current = '' }
    if (!/\/chat(?:[/?#]|$)/.test(current)) { await dmBridge.open(cfg.dmUrl); await sleep(Math.max(2000, Number(cfg.dmWaitMs) || 0)) }
    let n = await dmBridge.count(cfg.dmConversationSelectors[0]).catch(() => 0)
    if (n <= 0) {
      // 主站入口优先用 data-e2e（比文案稳）；等它出现再点，避免只点一次就超时
      const entry = String(cfg.dmEntrySelector || 'header :text-is("消息")')
      // 主站 SPA 首次打开消息面板可能加载 10–20 秒；只点一次，等面板/会话出来，别连点把面板又关掉。
      try {
        await dmBridge.click(entry, { force: false })
      } catch {
        await dmBridge.click('header [data-e2e="im-entry"]', { force: true }).catch(() => {
          throw new DouyinError('E_SELECTOR_MISS', '主站消息入口点不到（可能未登录或页面被遮挡）')
        })
      }
      for (let attempt = 0; attempt < 25; attempt++) {
        n = await dmBridge.count(cfg.dmConversationSelectors[0]).catch(() => 0)
        if (n > 0) return n
        await sleep(1000)
      }
      // 第二次只用于“第一次点击没打开”的兜底
      try {
        await dmBridge.click('header [data-e2e="im-entry"]', { force: true })
        for (let attempt = 0; attempt < 12; attempt++) {
          n = await dmBridge.count(cfg.dmConversationSelectors[0]).catch(() => 0)
          if (n > 0) return n
          await sleep(1000)
        }
      } catch {}
    } else return n
    throw new DouyinError('E_SELECTOR_MISS', '主站消息面板没有加载出来')
  }

  async function listDmConversations(limit = 20) {
    const take = Math.max(1, Math.min(50, Number(limit) || 20))
    const items = await dmBridge.list(cfg.dmConversationSelectors[0], { limit: take, textLen: 120 }).catch(() => [])
    if (!items.length) return []
    // 主站面板：每条 conversation-item 内再取昵称/预览/时间，避免多个列表错位
    const titleSel = '.conversationConversationItemtitle'
    const names = await dmBridge.list(titleSel, { limit: take, textLen: 60 }).catch(() => [])
    const previews = await dmBridge.list(cfg.dmPreviewSelector, { limit: take, textLen: 120 }).catch(() => [])
    const times = await dmBridge.list(cfg.dmTimeSelector, { limit: take, textLen: 40 }).catch(() => [])
    const base = items.map((row, i) => ({
      name: squash(names[i]?.text ?? row?.text ?? ''),
      preview: squash(previews[i]?.text ?? ''),
      time: squash(times[i]?.text ?? ''),
    })).filter((x) => x.name)
    return assignDmConversationIds(base, ownerAliases())
  }

  /**
   * watcher 专用最小只读扫描：打开 /chat 读会话列表，不结算 watch、不写审计、不进配额。
   * keepOpen=true 时保持在 /chat（实时监听需要页面常驻）；false 时恢复原页面。
   */
  async function dmPollConversations(args = {}) {
    const keepOpen = args?.keepOpen !== false
    const limit = Math.max(1, Math.min(50, Number(args?.limit) || 20))
    const prev = await currentUrlOrEmpty(dmBridge)
    try {
      await openDm()
      const items = await listDmConversations(limit)
      return { ok: true, items, count: items.length }
    } catch (e) {
      return toFailure(e)
    } finally {
      if (!keepOpen) await restorePage(prev, dmBridge)
    }
  }

  async function dmList() {
    settleActiveWatch()
    return exec('dm_list', 0, async () => {
      const prev = await currentUrlOrEmpty(dmBridge)
      try {
        await openDm()
        const items = await listDmConversations()
        return { ok: true, items, count: items.length }
      } finally {
        await restorePage(prev, dmBridge)
      }
    })
  }

  async function dmRead(args = {}) {
    settleActiveWatch()
    let limit
    let selector
    try {
      limit = asIntInRange(args?.limit ?? 20, 1, 50, 'limit')
      const name = String(args?.name ?? '').trim()
      const conversationId = String(args?.conversationId ?? '').trim()
      if (name.length > 60) throw new DouyinError('E_BAD_ARG', 'name 必须是 1–60 字')
      if (conversationId.length > 80) throw new DouyinError('E_BAD_ARG', 'conversationId 不合法')
      let index = null
      if (args?.index !== undefined && args?.index !== null) index = asIntInRange(args.index, 0, 19, 'index')
      if (!name && !conversationId && !Number.isInteger(index)) {
        throw new DouyinError('E_BAD_ARG', '需要 name / conversationId / index 之一')
      }
      selector = { name, conversationId, index }
    } catch (e) {
      return toFailure(e)
    }
    return exec('dm_read', 0, async () => {
      const prev = await currentUrlOrEmpty(dmBridge)
      try {
        await openDm()
        const conversations = await listDmConversations()
        const picked = resolveDmConversation(conversations, selector)
        if (!picked.ok) {
          return {
            ok: false,
            code: picked.code,
            message: picked.message,
            ...(picked.indexes ? { indexes: picked.indexes } : {}),
            ...(picked.candidates ? { candidates: picked.candidates } : {}),
          }
        }
        const conv = picked.item
        const items = (await readConversationMessages(picked.index))
          .filter((m) => m.text)
        const withIds = assignDmMessageIds(items, conv.id, { conversationOwner: conv.isOwner })
          .map((m) => ({
            ...m,
            sender: m.fromMe ? 'me' : conv.name,
            ageMs: parseDmAgeMs(m.time, clock()),
          }))
        const sliced = withIds.slice(-limit)
        return {
          ok: true,
          name: conv.name,
          conversation: {
            id: conv.id,
            index: conv.index,
            name: conv.name,
            preview: conv.preview,
            time: conv.time,
            isOwner: conv.isOwner,
          },
          items: sliced,
          count: sliced.length,
          loaded: withIds.length,
        }
      } finally {
        await restorePage(prev, dmBridge)
      }
    })
  }

  async function dmSend(args = {}) {
    settleActiveWatch()
    let text
    let selector
    let messageId = ''
    try {
      text = String(args?.text ?? '').trim()
      if (!text || Array.from(text).length > 500) throw new DouyinError('E_BAD_ARG', 'text 必须是 1–500 字')
      const name = String(args?.name ?? '').trim()
      if (name.length > 60) throw new DouyinError('E_BAD_ARG', 'name 必须是 1–60 字')
      let conversationId = String(args?.conversationId ?? '').trim()
      messageId = String(args?.messageId ?? '').trim()
      // 通用 id：兼容 autonomy 直接传 dm_list/dm_read 返回的 id
      if (!messageId && args?.id !== undefined && args?.id !== null && String(args.id).trim()) {
        const gid = String(args.id).trim()
        if (gid.includes('.m_')) messageId = gid
        else if (gid.startsWith('dmc_')) conversationId = conversationId || gid
        else throw new DouyinError('E_BAD_ARG', 'id 必须是 dm_list/dm_read 返回的 conversationId 或 messageId')
      }
      let index = null
      if (args?.index !== undefined && args?.index !== null) index = asIntInRange(args.index, 0, 19, 'index')
      if (messageId) {
        if (messageId.length > 120) throw new DouyinError('E_BAD_ARG', 'messageId 不合法')
        const parsed = parseDmMessageId(messageId)
        if (!parsed.ok) throw new DouyinError(parsed.code, parsed.message)
        if (conversationId && conversationId !== parsed.conversationId) {
          throw new DouyinError('E_BAD_ARG', 'messageId 与 conversationId 指向不同会话')
        }
        conversationId = parsed.conversationId
      }
      if (conversationId.length > 80) throw new DouyinError('E_BAD_ARG', 'conversationId 不合法')
      if (!name && !conversationId && !Number.isInteger(index)) {
        throw new DouyinError('E_BAD_ARG', '需要 name / conversationId / messageId / index 之一（不再按名字猜）')
      }
      selector = { name, conversationId, index }
    } catch (e) {
      return toFailure(e)
    }
    const base = { ok: false, action: 'dm_send', name: selector.name, messageId: messageId || null }
    if (args?.confirm !== true) {
      return { ...base, code: 'E_CONFIRM_REQUIRED', message: '发私信必须 confirm:true', verified: false }
    }
    const used = countDmSendsToday(clock())
    if (cfg.dmDailyLimit > 0 && used >= cfg.dmDailyLimit) {
      return { ...base, code: 'E_QUOTA', message: `今日私信已达上限（${cfg.dmDailyLimit} 条）`, verified: false }
    }
    return exec('dm_send', 0, async () => {
      const prev = await currentUrlOrEmpty(dmBridge)
      try {
        log?.info?.('[douyin] dm_send step=openDm')
        await openDm()
        log?.info?.('[douyin] dm_send step=list')
        const conversations = await listDmConversations()
        log?.info?.(`[douyin] dm_send step=list-done n=${conversations.length}`)
        const picked = resolveDmConversation(conversations, selector)
        log?.info?.(`[douyin] dm_send step=pick idx=${picked?.index ?? -1} code=${picked?.code ?? 'ok'}`)
        if (!picked.ok) {
          return {
            ...base,
            code: picked.code,
            message: picked.message,
            ...(picked.indexes ? { indexes: picked.indexes } : {}),
            ...(picked.candidates ? { candidates: picked.candidates } : {}),
            verified: false,
          }
        }
        const conv = picked.item
        // 发送结果不带会话预览/时间，避免把最后一条正文带进返回（列表/读取接口才有）
        const convInfo = {
          id: conv.id,
          index: conv.index,
          name: conv.name,
          isOwner: conv.isOwner,
        }
        const runBase = { ...base, name: conv.name, conversation: convInfo }
        let messages = null
        const loadMessages = async () => {
          if (!messages) messages = (await readConversationMessages(picked.index)).filter((m) => m.text)
          return messages
        }
        if (messageId) {
          const withIds = assignDmMessageIds(await loadMessages(), conv.id, { conversationOwner: conv.isOwner })
          const targetMessage = withIds.find((m) => m.id === messageId) || null
          if (!targetMessage) {
            return {
              ...runBase,
              code: 'E_NOT_FOUND',
              message: `当前会话已加载消息里没有 ${messageId}（不盲发，请重新 dm_read）`,
              verified: false,
            }
          }
          if (targetMessage.fromMe) {
            return {
              ...runBase,
              code: 'E_BAD_ARG',
              message: 'messageId 指向自己发的消息，不能作为回复目标',
              verified: false,
            }
          }
        }
        // 策略（2026-11-10 主人定）：不设白名单；只回“对方最后一条消息 ≤1 小时”的会话；
        // 主人会话可主动发；旧日期（10/30）一律算过期。主人识别 = dm-owner.txt 第一行 + 别名。
        const isOwnerConv = conv.isOwner === true || isOwnerDisplayName(conv.name, ownerAliases())
        if (!isOwnerConv) {
          const inbound = (await loadMessages()).filter((m) => !m.fromMe)
          if (!inbound.length) {
            return { ...runBase, code: 'E_STALE', message: '对方没有新消息；只能回复，不能主动发', verified: false }
          }
          // DOM 顺序不保证（可能是新的在上）；窗口 0 = 不设限，只要求对方有消息
          const parsed = inbound
            .map((m) => ({ time: m.time, age: parseDmAgeMs(m.time) }))
            .filter((x) => x.age !== null)
          const unlimited = !(Number(cfg.dmReplyWindowMs) > 0)
          const fresh = unlimited ? (parsed[0] ?? (inbound.length ? { time: '', age: null } : null)) : parsed.find((x) => x.age <= cfg.dmReplyWindowMs)
          if (!fresh) {
            const newest = parsed.sort((a, b) => a.age - b.age)[0]
            return {
              ...runBase,
              code: 'E_STALE',
              message: newest
                ? `对方最新消息（${newest.time}）已超过 ${Math.round(cfg.dmReplyWindowMs / 60000)} 分钟，不能回`
                : '对方消息只有日期（无法判断 1 小时内），不能回',
              verified: false,
            }
          }
        } else if (!messages) {
          // messageId 分支已经通过 loadMessages 点开过会话，避免重复点击
          log?.info?.('[douyin] dm_send step=click-conv')
          await clickConversation(picked.index, conv.name)
          log?.info?.('[douyin] dm_send step=click-conv-done')
          await sleep(cfg.dmConversationWaitMs)
        }

        // 桥内 type 优先（slate 编辑器支持 fill/insertText，无需前台焦点）；X11 兜底时才 activate。
        await dmBridge.click(cfg.dmInputSelector, { nth: 0 })
        const filled = await fillEditorText({ client: dmBridge, selector: cfg.dmInputSelector, text })
        log?.info?.('[douyin] dm_send step=draft')
        if (!filled.ok) {
          return { ...runBase, code: 'E_UNVERIFIED', message: '私信草稿读回不一致', draft: filled.draft, verified: false }
        }

        log?.info?.('[douyin] dm_send step=send-list')
        const sendRows = await dmBridge.list(cfg.dmSendSelector, { attrs: ['class'], limit: 1 })
        const sendClass = String(sendRows[0]?.class ?? '')
        if (!sendClass.includes(cfg.dmSendEnabledClass)) {
          return { ...runBase, code: 'E_UNVERIFIED', message: '发送按钮未启用（草稿可能没进输入框）', verified: false }
        }
        await dmBridge.click(cfg.dmSendSelector, { nth: 0 })
        const readSent = async () => {
          const rows = await dmBridge.list(cfg.dmMessageSelectors[0], { attrs: ['class'], limit: 50, textLen: 500 })
          const items = rows.map((row) => ({
            fromMe: String(row?.class ?? '').includes('isFromMe'),
            text: squash(row?.text ?? ''),
          }))
          return items.some((x) => x.fromMe && x.text.includes(text))
        }
        const sentPoll = await pollUntil(async () => ((await readSent()) ? true : null), {
          timeoutMs: Math.max(1500, Number(cfg.dmSendWaitMs) || 1500),
          intervalMs: 400,
        })
        const verified = sentPoll.matched === true
        const textHash = createHash('sha256').update(text).digest('hex').slice(0, 12)
        try {
          recordLedger(cfg.downloadDir, {
            videoId: `dm:${conv.name}`,
            action: 'dm_send',
            targetState: 'sent',
            result: verified ? 'sent' : 'unverified',
            verified,
            detail: { name: conv.name, chars: Array.from(text).length, textHash, messageId: messageId || null },
          })
        } catch (e) {
          log?.warn?.(`[douyin] 私信账本失败（不阻断）：${String(e?.message ?? e).slice(0, 120)}`)
        }
        if (!verified) {
          return { ...runBase, code: 'E_UNVERIFIED', message: '发送后回读不到这条消息', verified: false, chars: Array.from(text).length }
        }
        noteDmOutbound(conv.name, text)
        return {
          ok: true,
          action: 'dm_send',
          name: conv.name,
          conversation: convInfo,
          messageId: messageId || null,
          verified: true,
          result: 'sent',
          chars: Array.from(text).length,
          textHash,
        }
      } finally {
        if (cfg.dmKeepPanelOpen !== true) await restorePage(prev, dmBridge)
      }
    })
  }

  // 通知面板的公共原语：notifyList（只读）与 notifyReply（confirm 门控）共用
  const DOUYIN_PAGE_RE = /^https:\/\/(www\.)?douyin\.com\//

  async function prepareNotifyPage(client = notifyBridge) {
    const prev = await currentUrlOrEmpty(client)
    const onDouyin = DOUYIN_PAGE_RE.test(prev)
    const blockedByModal = /[?&]modal_id=|\/video\/|\/note\//.test(prev)
    let navigated = false
    if (!onDouyin || blockedByModal) {
      await client.open(cfg.homeUrl)
      await sleep(Math.max(2500, Number(cfg.notifyWaitMs) || 0))
      navigated = true
    }
    return { prev, navigated }
  }

  /** 打开「通知」面板；已开则复用。navigate=false 时绝不导航（watcher 用），失败就返回错误。 */
  async function openNotifyPanel({ navigate = true, retries = null, client = bridge } = {}) {
    const attempts = Number.isInteger(retries) ? Math.max(1, retries) : cfg.notifyRetries
    let panel = await client.count(cfg.notifyPanelSelectors[0]).catch(() => 0)
    if (panel > 0) return panel
    if (navigate) await settleNotifyPage(client)
    for (let round = 0; round < (navigate ? 2 : 1); round += 1) {
      let clicked = false
      // 2026-11-16 实测：右上角「通知」是 **hover 展开**，点它不会开面板；
      // 而 `:has-text()` 这类 Playwright 扩展选择器在本页 >25s（不能用于轮询）。
      // 所以先用桥内 hoverText（按可见文字 hover，页内取包围盒 + mouse.move）打开下拉。
      if (await supportsCap(client, 'hoverText')) {
        for (const label of ['通知', '互动消息']) {
          try { await client.hoverText(label, { nth: 0 }) } catch { continue }
          const opened = await waitForSelector(cfg.notifyPanelSelectors[0], {
            state: 'attached',
            timeoutMs: 1500,
            client,
          })
          if (opened.matched) return 1
        }
      }
      // 优先点“通知”文字入口；再点 e2e 按钮；最后用文字入口兜底
      const entrySelectors = [
        ...cfg.notifyEntrySelectors,
        'header :text-is("通知")',
        'header [data-e2e="something-button"]:has-text("通知")',
      ]
      for (const selector of entrySelectors) {
        try {
          // 通知入口需要 hover 才展开菜单，3s 默认点击超时在真机上不够（实测会 E_SELECTOR_MISS）；
          // 这是"打开面板"的一次性动作，给足 8s，但要先 hover 触发菜单。
          try { await client.rect(selector, { nth: 0 }) } catch {}
          await client.click(selector, { nth: 0, force: false, timeoutMs: 8000 })
          clicked = true
          break
        } catch (e) {
          if (e?.code !== 'E_TIMEOUT' && e?.code !== 'E_SELECTOR_MISS') throw e
        }
      }
      if (clicked) {
        const opened = await waitForSelector(cfg.notifyPanelSelectors[0], {
          state: 'attached',
          timeoutMs: Math.max(2000, attempts * cfg.notifyWaitMs),
          client,
        })
        if (opened.matched) {
          panel = 1
          return panel
        }
        for (let attempt = 0; attempt < Math.min(3, attempts); attempt += 1) {
          panel = await client.count(cfg.notifyPanelSelectors[0]).catch(() => 0)
          if (panel > 0) return panel
          await sleep(cfg.notifyWaitMs)
        }
      }
      // 一轮没开：回主站首页再试一次，避免 modal/视频页挡住入口（watcher 模式不导航）
      if (navigate && round === 0) {
        try { await client.open(cfg.homeUrl); await sleep(2500) } catch {}
      }
    }
    throw await selectorMiss('通知面板没有加载出来（可能未登录/改版）', client)
  }

  /** 打开前的页面归位：首页 + 等 SPA 稳定，避免在 modal/视频页上点入口。 */
  async function settleNotifyPage(client = bridge) {
    let cur = await currentUrlOrEmpty(client).catch(() => '')
    if (!DOUYIN_PAGE_RE.test(cur) || /[?&]modal_id=|\/video\/|\/note\//.test(cur)) {
      try { await client.open(cfg.homeUrl); cur = await currentUrlOrEmpty(client).catch(() => '') } catch {}
      await sleep(Math.max(2500, Number(cfg.notifyWaitMs) || 0))
    }
    return cur
  }

  async function readNotifyRows(limit, client = bridge) {
    for (const selector of cfg.notifyItemSelectors) {
      try {
        const rows = await client.list(selector, {
          attrs: ['class'],
          limit: Math.min(50, Math.max(20, limit + 5)),
          textLen: cfg.notifyTextLen,
        })
        if (rows.length) return rows
      } catch {
        // 换下一个选择器
      }
    }
    return []
  }

  /** 通知解析选项：owner 别名 + 回复新鲜窗口（replyable 用） */
  const notifyParseOptions = (aliasList = null) => ({
    ownerAliases: aliasList ?? ownerAliases(),
    replyWindowMs: cfg.commentReplyWindowMs,
    now: clock(),
  })

  /** 面板必须已打开；读取并解析条目（空通知合法），可选点“点击加载更多”。 */
  async function readNotifyItemsFromPanel({ limit, loadMore, aliases = null, retries = null, client = bridge }) {
    const ownerNames = aliases ?? ownerAliases()
    const maxRetries = Number.isInteger(retries) ? Math.max(0, retries) : cfg.notifyRetries
    let rows = await readNotifyRows(limit, client)
    let items = parseNotifyItems(rows, cfg.notifyTextLen, notifyParseOptions(ownerNames))
    for (let attempt = 0; attempt < maxRetries && !items.length; attempt += 1) {
      await sleep(cfg.notifyWaitMs)
      rows = await readNotifyRows(limit, client)
      items = parseNotifyItems(rows, cfg.notifyTextLen, notifyParseOptions(ownerNames))
    }

    let clicks = 0
    while (loadMore && items.length < limit && clicks < cfg.notifyLoadMoreMax) {
      let more = false
      for (const selector of cfg.notifyLoadMoreSelectors) {
        // 只有最后一条文本确实是“点击加载更多”才点；否则绝不点条目（会跳视频/标记已读）
        const tail = squash((await client.text(selector).catch(() => '')) || '')
        if (!tail.includes('点击加载更多')) continue
        try {
          await client.click(selector, { nth: 0, force: true })
          more = true
          break
        } catch {
          // 点不到就停
        }
      }
      if (!more) break
      const beforeRows = rows.length
      await sleep(cfg.notifyLoadMoreWaitMs)
      rows = await readNotifyRows(limit, client)
      const next = parseNotifyItems(rows, cfg.notifyTextLen, notifyParseOptions(ownerNames))
      if (next.length <= items.length || rows.length <= beforeRows) {
        if (next.length > items.length) items = next
        break
      }
      items = next
      clicks += 1
    }
    return { items, clicks, rawCount: rows.length }
  }

  async function closeNotifyPanel(client = bridge) {
    try {
      // 不再点搜索框：那会打开搜索栏并抢焦点，后续评论区就打不开了。
      // 2026-11-15 真机实测：Escape 不关这个浮层；在页面空白处（body 中心，视频区域）真实点击才会关。
      await client.press('Escape', { allowFocused: true }).catch(() => {})
      await sleep(200)
      let still = await client.count(cfg.notifyPanelSelectors[0]).catch(() => 0)
      if (still > 0) {
        try { await client.click('body', { nth: 0, force: true }); } catch {}
        await sleep(250)
        still = await client.count(cfg.notifyPanelSelectors[0]).catch(() => 0)
      }
      if (still > 0) {
        // 兜底仍用通知入口切换关闭；绝不点搜索框/条目
        for (const selector of cfg.notifyEntrySelectors) {
          try { await client.click(selector, { nth: 0, force: true }); break } catch {}
        }
      }
    } catch {
      // 关面板失败不覆盖主结果
    }
  }

  // ===== 通知实时事件源原语（watcher 用；不写审计、不点条目、不点搜索框）=====

  /** 远端 jsWatch MutationObserver/fetch 包装：start/take/stop；只读观察，不点击。 */
  async function notifySourceStart() {
    // 私信页不装 jsWatch：避免把 DM 的 fetch/XHR 响应也 clone 观察（通知入口在 /chat 也不可用）
    const url = await currentUrlOrEmpty(notifyBridge).catch(() => '')
    if (/\/chat(?:[/?#]|$)/.test(url)) {
      return { ok: false, code: 'E_PAGE_UNSAFE', message: '私信页不启动通知 jsWatch（避免观察 DM 流量）', url }
    }
    const r = await notifyBridge.jsWatch('start')
    return { ok: true, ...(r && typeof r === 'object' ? r : {}) }
  }

  async function notifySourceTake(args = {}) {
    const limit = asIntInRange(args?.limit ?? cfg.notifyWatchJsTakeLimit, 1, 100, 'limit')
    const r = await notifyBridge.jsWatch('take', { limit })
    return { ok: true, ...(r && typeof r === 'object' ? r : {}) }
  }

  async function notifySourceStop() {
    const r = await notifyBridge.jsWatch('stop').catch(() => ({ ok: false }))
    return { ok: true, ...(r && typeof r === 'object' ? r : {}) }
  }

  /** 通知 SPA 面板是缓存的：定期在 notify tab 重载一次，才能看到新通知。不碰 main。 */
  async function notifyRefreshForWatch() {
    try {
      const url = await currentUrlOrEmpty(notifyBridge).catch(() => '')
      if (/\/chat(?:[/?#]|$)/.test(url)) return { ok: false, code: 'E_PAGE_UNSAFE', url }
      await notifyBridge.open(cfg.homeUrl)
      await sleep(Math.max(2500, Number(cfg.notifyWaitMs) || 0))
      return { ok: true, url: await currentUrlOrEmpty(notifyBridge).catch(() => '') }
    } catch (e) {
      return { ok: false, code: e?.code ?? 'E_REMOTE_IO', message: String(e?.message ?? e).slice(0, 200) }
    }
  }

  /** 只读角标探测：读 header 通知入口的 HTML/文本/子元素；不开面板、不导航。 */
  async function notifyBadgeProbe(args = {}) {
    const selectors = Array.isArray(args?.selectors) && args.selectors.length
      ? args.selectors
      : cfg.notifyWatchBadgeSelectors
    let lastCode = 'E_BADGE_MISS'
    for (const selector of selectors) {
      try {
        const n = await notifyBridge.count(selector)
        if (!n) continue
        const html = await notifyBridge.html(selector, { max: 8000 }).catch(() => '')
        const text = await notifyBridge.text(selector).catch(() => '')
        const children = await notifyBridge.list(`${selector} *`, {
          attrs: ['class', 'data-e2e'],
          limit: 24,
          textLen: 32,
        }).catch(() => [])
        const sig = parseNotifyBadge({ html, text, children })
        return { ok: true, available: sig.available, selector, ...sig }
      } catch (e) {
        lastCode = e?.code ?? 'E_REMOTE_IO'
      }
    }
    return { ok: true, available: false, signature: null, code: lastCode, reason: '没有找到通知入口/角标（不打开面板）' }
  }

  /**
   * watcher 用通知快照：面板已开则被动读；未开且 allowOpen=true 时才点一次「通知」入口，
   * 读完立即 closeNotifyPanel（Escape/入口切换，绝不点搜索框）。不导航到首页/视频页。
   */
  async function notifySnapshotForWatch(args = {}) {
    const limit = asIntInRange(args?.limit ?? cfg.notifyWatchLimit, 1, 50, 'limit')
    const allowOpen = args?.allowOpen === true
    const url = await currentUrlOrEmpty(notifyBridge).catch(() => '')
    let open = await notifyBridge.count(cfg.notifyPanelSelectors[0]).catch(() => 0)
    let opened = false
    if (open <= 0) {
      if (!allowOpen) return { ok: true, open: false, opened: false, items: [], count: 0, url }
      if (!DOUYIN_PAGE_RE.test(url)) {
        return { ok: false, code: 'E_PAGE_UNSAFE', message: '当前不在抖音页面，watcher 不导航', open: false, opened: false, url }
      }
      if (/[?&]modal_id=|\/video\/|\/note\//.test(url)) {
        return { ok: false, code: 'E_PAGE_UNSAFE', message: '当前在视频/模态页，watcher 不抢页面', open: false, opened: false, url }
      }
      if (/\/chat(?:[/?#]|$)/.test(url)) {
        return { ok: false, code: 'E_PAGE_UNSAFE', message: '当前在私信页，通知入口不可用', open: false, opened: false, url }
      }
      try {
        await openNotifyPanel({ navigate: false, retries: 8, client: notifyBridge })
        opened = true
        open = 1
      } catch (e) {
        return { ...toFailure(e), open: false, opened: false, url }
      }
    }
    try {
      const { items, rawCount } = await readNotifyItemsFromPanel({
        limit,
        loadMore: false,
        aliases: ownerAliases(),
        retries: opened ? 2 : 0,
        client: notifyBridge,
      })
      return {
        ok: true,
        open: true,
        opened,
        rawCount,
        items: items.slice(0, limit),
        count: Math.min(items.length, limit),
        loaded: items.length,
        url,
      }
    } catch (e) {
      return { ...toFailure(e), open: true, opened, url }
    } finally {
      if (opened) await closeNotifyPanel(notifyBridge)
    }
  }

  /**
   * 只读：读主站右上角「通知/互动消息」面板。
   * 安全边界：只点“通知入口/点击加载更多/搜索框（关面板）”，不点任何通知条目（不标记已读、不跳视频），
   * 不回复、不关注；条目里的视频/评论标识在 DOM 中不存在，故 videoId/commentId 恒为 null。
   */
  async function notifyList(args = {}) {
    settleActiveWatch()
    let limit
    let loadMore
    try {
      limit = asIntInRange(args?.limit ?? 20, 1, 50, 'limit')
      if (args?.loadMore !== undefined && typeof args?.loadMore !== 'boolean') {
        throw new DouyinError('E_BAD_ARG', 'loadMore 必须是布尔值')
      }
      loadMore = args?.loadMore !== false
    } catch (e) {
      return toFailure(e)
    }
    return exec('notify_list', 0, async () => {
      // 2026-11-15：通知用户工具固定 notify tab，不读/不导航 main。
      await prepareNotifyPage(notifyBridge)
      try {
        let panel = await notifyBridge.count(cfg.notifyPanelSelectors[0]).catch(() => 0)
        if (panel <= 0) {
          let clicked = false
          for (const selector of cfg.notifyEntrySelectors) {
            try {
              await notifyBridge.click(selector, { nth: 0, force: false })
              clicked = true
              break
            } catch (e) {
              if (e?.code !== 'E_TIMEOUT' && e?.code !== 'E_SELECTOR_MISS') throw e
            }
          }
          if (!clicked) {
            // 兜底：顶栏 [充钻石/客户端/通知/消息/投稿] 的第 3 个；只在主选择器都点不到时用
            try {
              await notifyBridge.click('header [data-e2e="something-button"]', { nth: 2, force: true })
            } catch {
              throw await selectorMiss('通知入口点不到（可能未登录/改版或被遮挡）', notifyBridge)
            }
          }
          for (let attempt = 0; attempt < cfg.notifyRetries; attempt += 1) {
            panel = await notifyBridge.count(cfg.notifyPanelSelectors[0]).catch(() => 0)
            if (panel > 0) break
            await sleep(cfg.notifyWaitMs)
          }
          if (panel <= 0) throw await selectorMiss('通知面板没有加载出来（可能未登录/改版）', notifyBridge)
        }

        const ownerNames = ownerAliases()
        const readRows = async () => {
          let rows = []
          for (const selector of cfg.notifyItemSelectors) {
            try {
              rows = await notifyBridge.list(selector, {
                attrs: ['class'],
                limit: Math.min(50, Math.max(20, limit + 5)),
                textLen: cfg.notifyTextLen,
              })
            } catch {
              rows = []
            }
            if (rows.length) break
          }
          return rows
        }

        let rows = await readRows()
        let rawCount = rows.length
        let items = parseNotifyItems(rows, cfg.notifyTextLen, notifyParseOptions(ownerNames))
        // 面板容器先出现、条目后到；空通知是合法结果，所以轮询到有内容或次数用完
        for (let attempt = 0; attempt < cfg.notifyRetries && !items.length; attempt += 1) {
          await sleep(cfg.notifyWaitMs)
          rows = await readRows()
          rawCount = Math.max(rawCount, rows.length)
          items = parseNotifyItems(rows, cfg.notifyTextLen, notifyParseOptions(ownerNames))
        }

        let clicks = 0
        while (loadMore && items.length < limit && clicks < cfg.notifyLoadMoreMax) {
          let more = false
          for (const selector of cfg.notifyLoadMoreSelectors) {
            // 只有最后一条文本确实是“点击加载更多”才点；否则绝不点条目（会跳视频/标记已读）
            const tail = squash((await notifyBridge.text(selector).catch(() => '')) || '')
            if (!tail.includes('点击加载更多')) continue
            try {
              await notifyBridge.click(selector, { nth: 0, force: true })
              more = true
              break
            } catch {
              // 点不到就停
            }
          }
          if (!more) break
          const beforeRows = rows.length
          await sleep(cfg.notifyLoadMoreWaitMs)
          rows = await readRows()
          rawCount = Math.max(rawCount, rows.length)
          const next = parseNotifyItems(rows, cfg.notifyTextLen, notifyParseOptions(ownerNames))
          if (next.length <= items.length || rows.length <= beforeRows) {
            if (next.length > items.length) items = next
            break
          }
          items = next
          clicks += 1
        }

        const filter = squash((await notifyBridge.text(cfg.notifyFilterSelector).catch(() => '')) || '') || null
        const url = await currentUrlOrEmpty(notifyBridge).catch(() => '')
        if (args?.inspect === true) {
          try {
            return {
              ok: true, role: 'notify', panel: '互动消息', filter, url, rawCount,
              items: items.slice(0, limit), count: Math.min(items.length, limit),
              loaded: items.length, loadMoreClicks: clicks,
              inspect: {
                html: await notifyBridge.html('[data-e2e="listDlgTest-container"]', { max: 50000 }).catch(() => ''),
                links: await notifyBridge.list('a', { attrs: ['href'], limit: 100, textLen: 200 }).catch(() => []),
                itemHtml: await notifyBridge.html(cfg.notifyItemSelectors[0], { max: 20000 }).catch(() => ''),
                itemAttrs: await notifyBridge.list(cfg.notifyItemSelectors[0], { attrs: ['class', 'data-e2e'], limit: 20, textLen: 500 }).catch(() => []),
                url,
              },
            }
          } catch {}
        }
        return {
          ok: true,
          role: 'notify',
          panel: '互动消息',
          filter,
          url,
          rawCount,
          items: items.slice(0, limit),
          count: Math.min(items.length, limit),
          loaded: items.length,
          loadMoreClicks: clicks,
          reply: {
            supported: true,
            via: 'dy_douyin_notify_reply',
            reason:
              'notify_reply 在同一个 notify tab 点条目→视频→评论回复；点条目会标记已读，main 不会被导航。',
          },
        }
      } finally {
        try {
          if (args?.keepOpen === true) {
            // 调试/后续 notify_reply：保持面板，由调用方关闭
          } else {
            // 绝不点搜索框关面板：Escape + 通知入口切换（搜索框会抢焦点/打开搜索栏）
            await closeNotifyPanel(notifyBridge)
          }
        } catch {
          // 关闭失败不覆盖主结果
        }
      }
    })
  }

  /** 打开通知面板并保持：固定 notify tab（不导航 main、不 reload main）；用完调用 notifyClose。 */
  async function notifyOpen() {
    // 不再先 open 首页：notifyList 的 prepareNotifyPage 会把 notify tab 归位到首页，重复 open 反而和 SPA 加载抢时序。
    const r = await notifyList({ limit: 5, loadMore: false, keepOpen: true })
    if (!r || r.ok !== true) return r
    return { ok: true, role: 'notify', panel: 1, url: r.url ?? (await currentUrlOrEmpty(notifyBridge).catch(() => '')) }
  }

  /** 关闭通知面板（Escape/通知入口切换；绝不点搜索框、不点条目）。 */
  async function notifyClose() {
    try { await closeNotifyPanel(notifyBridge); return { ok: true, role: 'notify' } } catch (e) { return toFailure(e) }
  }

  /** 只读诊断：在 notify tab 打开通知面板，抓 HTML/链接属性，不开条目、不导航 main。 */
  async function notifyInspect() {
    await prepareNotifyPage(notifyBridge)
    try {
      await openNotifyPanel({ client: notifyBridge })
      const html = await notifyBridge.html('[data-e2e="listDlgTest-container"]', { max: 50000 }).catch(() => '')
      const links = await notifyBridge.list('a', { attrs: ['href'], limit: 100, textLen: 200 }).catch(() => [])
      const items = await notifyBridge.list(cfg.notifyItemSelectors[0], { attrs: ['class', 'data-e2e'], limit: 20, textLen: 500 }).catch(() => [])
      return { ok: true, role: 'notify', html, links, items, url: await currentUrlOrEmpty(notifyBridge).catch(() => '') }
    } finally {
      try { await closeNotifyPanel(notifyBridge) } catch {}
    }
  }

  /** 在已打开的通知评论面板里回复（默认 notify tab；可传 client 复用 main 逻辑）。 */
  async function replyCurrentComment({ target, text, client = bridge }) {
    log?.info?.(`[douyin] current_reply step=list target=${target}`)
    let rows = []
    let usedSelector = cfg.commentSelectors[0]
    let items = []
    let idx = -1
    for (const selector of cfg.commentSelectors) {
      try {
        const next = await client.list(selector, { attrs: [], limit: 50, textLen: cfg.commentTextLen })
        if (!next.length) continue
        const parsed = parseCommentItems(next, cfg.commentTextLen)
        const found = parsed.findIndex((it) => String(it.text ?? '').includes(target) || String(it.author ?? '') === target)
        if (found >= 0) { rows = next; usedSelector = selector; items = parsed; idx = found; break }
        if (!rows.length) { rows = next; usedSelector = selector; items = parsed }
      } catch {}
    }
    log?.info?.(`[douyin] current_reply step=list-done idx=${idx}`)
    if (idx < 0) throw new DouyinError('E_NOT_FOUND', `当前评论面板里没有匹配「${target}」的（不盲回）`)
    const replyBtn = `${usedSelector} >> nth=${idx} >> text=回复`
    await client.click(replyBtn, { nth: 0, force: true })
    const boxed = await waitForSelector('.comment-input-container-focus', { timeoutMs: 1600, client })
    if (!boxed.matched) throw new DouyinError('E_SELECTOR_MISS', '回复输入框没有出现（当前评论上下文）')
    await client.click(cfg.commentReplyInputSelector, { nth: 0, force: true })
    const filled = await fillEditorText({ client, selector: cfg.commentReplyInputSelector, text })
    if (!filled.ok) return { ok: false, code: 'E_UNVERIFIED', message: '回复草稿读回不一致', draft: filled.draft, verified: false }
    await client.click(cfg.commentReplySendSelector, { nth: 0 })
    const posted = await pollUntil(async () => {
      let afterItems = []
      for (const selector of cfg.commentSelectors) {
        try {
          const next = await client.list(selector, { attrs: [], limit: 50, textLen: cfg.commentTextLen })
          if (next.length) afterItems = parseCommentItems(next, cfg.commentTextLen)
          if (afterItems.length) break
        } catch {}
      }
      const hit = afterItems.find((it) => String(it.text ?? '').includes(target) || String(it.author ?? '') === target) || null
      return hit && Array.isArray(hit.replies) && hit.replies.some((r) => String(r.text ?? '').includes(text)) ? true : null
    }, { timeoutMs: Math.max(2000, Number(cfg.commentSubmitWaitMs) || 1500), intervalMs: 400 })
    const verified = posted.matched === true
    return { ok: verified, verified, action: 'comment_reply', result: verified ? 'replied' : 'unverified', chars: Array.from(text).length, textHash: createHash('sha256').update(text).digest('hex').slice(0, 12), target: cut(squash(target), 80) }
  }

  /**
   * 回复一条通知（写操作，confirm 门控）：只支持 mention / comment_reply。
   * 全部在 notify tab 完成：读面板 → id 优先/index 次之定位 → 点条目（标记已读）→
   * notify tab 内取 videoId → 在当前评论上下文回复；main 不导航。
   * options.replyImpl 仅测试注入用（生产不传，走 notify tab 的 replyCurrentComment）。
   */
  async function notifyReply(args = {}, options = {}) {
    settleActiveWatch()
    let target
    let text
    let index = null
    let id = ''
    let commentTarget = ''
    try {
      target = String(args?.target ?? '').trim()
      id = String(args?.id ?? args?.notificationId ?? '').trim()
      text = String(args?.text ?? '').trim()
      if (args?.index !== undefined && args?.index !== null) index = asIntInRange(args.index, 0, 49, 'index')
      if (target && Array.from(target).length > 100) throw new DouyinError('E_BAD_ARG', 'target 必须是 1–100 字（作者名或通知正文片段）')
      if (id && id.length > 80) throw new DouyinError('E_BAD_ARG', 'id 必须是 notify_list 返回的 id')
      if (!target && !id && !Number.isInteger(index)) throw new DouyinError('E_BAD_ARG', '需要 id / index / target 之一')
      if (!text || Array.from(text).length > 500) throw new DouyinError('E_BAD_ARG', 'text 必须是 1–500 字')
      commentTarget = String(args?.commentTarget ?? '').trim()
      if (commentTarget && Array.from(commentTarget).length > 100) throw new DouyinError('E_BAD_ARG', 'commentTarget 必须是 1–100 字')
    } catch (e) {
      return toFailure(e)
    }
    const base = { ok: false, action: 'notify_reply', target, id: id || null, index }
    if (args?.confirm !== true) {
      return {
        ...base,
        code: 'E_CONFIRM_REQUIRED',
        message: '回复通知必须 confirm:true（会点开通知条目，可能标记已读并发出评论）',
        verified: false,
        markedRead: false,
      }
    }
    return exec('notify_reply', 0, async () => {
      log?.info?.('[douyin] notify_reply step=start')
      await prepareNotifyPage(notifyBridge)
      let itemClicked = false
      try {
        log?.info?.('[douyin] notify_reply step=open')
        await openNotifyPanel({ navigate: true, client: notifyBridge })
        log?.info?.('[douyin] notify_reply step=open-done')
        const snapshot = await readNotifyItemsFromPanel({ limit: 50, loadMore: false, client: notifyBridge })
        const picked = pickNotifyTarget(snapshot.items, { target, index, id })
        if (!picked.ok) {
          return {
            ...base,
            code: picked.code,
            message: picked.message,
            ...(picked.indexes ? { indexes: picked.indexes } : {}),
            verified: false,
            markedRead: false,
          }
        }
        const item = picked.item
        const notification = { id: item.id, type: item.type, actor: item.actor, text: item.text, time: item.time, isOwner: item.isOwner }
        if (item.type !== 'mention' && item.type !== 'comment_reply') {
          return {
            ...base,
            code: 'E_NOT_REPLYABLE',
            message: `通知类型 ${item.type} 不能回复（只支持 mention/comment_reply；like/follow 不点）`,
            notification,
            verified: false,
            markedRead: false,
          }
        }
        const age = item.ageMs
        const unlimited = !(Number(cfg.commentReplyWindowMs) > 0)
        if (!unlimited && (age === null || age > cfg.commentReplyWindowMs)) {
          return {
            ...base,
            code: 'E_STALE',
            message: `通知时间「${item.time || '未知'}」无法确认在 ${Math.round(cfg.commentReplyWindowMs / 60000)} 分钟内，不能回复（未点条目）`,
            notification,
            verified: false,
            markedRead: false,
          }
        }
        log?.info?.('[douyin] notify_reply step=click')
        const beforeUrl = await currentUrlOrEmpty(notifyBridge)
        const beforeVideo = parseVideoIdFromUrl(beforeUrl)
        try {
          itemClicked = true
          // 手动点击真正定位到评论的是“消息文字”，不是整行中心；优先点文字，失败再点整行
          let clickedText = false
          const before = await currentUrlOrEmpty(notifyBridge).catch(() => '')
          // 优先点通知行内部正文容器；不要用屏幕坐标硬点
          if (typeof notifyBridge.jsClick === 'function') {
            for (const sel of [`${cfg.notifyItemSelectors[0]} > div.w6dMe2gp`, `${cfg.notifyItemSelectors[0]} > div`]) {
              try {
                await notifyBridge.jsClick(sel, { nth: picked.index })
                for (let attempt = 0; attempt < 10 && !clickedText; attempt += 1) {
                  await sleep(300)
                  const after = await currentUrlOrEmpty(notifyBridge).catch(() => '')
                  if (after && after !== before) clickedText = true
                  else {
                    const panelNow = await notifyBridge.count(cfg.notifyPanelSelectors[0]).catch(() => 1)
                    if (panelNow === 0) clickedText = true
                  }
                }
                if (clickedText) break
              } catch {}
            }
          }
          if (!clickedText) await notifyBridge.click(cfg.notifyItemSelectors[0], { nth: picked.index, force: true })
        } catch (e) {
          itemClicked = false
          return {
            ...base,
            code: e?.code === 'E_TIMEOUT' ? 'E_TIMEOUT' : 'E_REMOTE_IO',
            message: `点不开通知条目：${String(e?.message ?? e).slice(0, 160)}`,
            notification,
            verified: false,
            markedRead: false,
          }
        }
        let videoId = ''
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const current = await notifyBridge.url().catch(() => '')
          const mid = parseVideoIdFromUrl(current)
          if (mid && mid !== beforeVideo) {
            videoId = mid
            break
          }
          if (mid && !beforeVideo) {
            videoId = mid
            break
          }
          await sleep(500)
        }
        let commentId = null
        try {
          const cur = await currentUrlOrEmpty(notifyBridge)
          const u = new URL(cur)
          commentId = u.searchParams.get('comment_id') || u.searchParams.get('commentId') || null
        } catch {}
        if (!videoId) {
          return {
            ...base,
            code: 'E_NOT_FOUND',
            message: '点了通知条目但没拿到 videoId（URL 没有出现 modal_id）',
            notification,
            verified: false,
            markedRead: true,
            note: '已尝试点条目，可能已标记已读',
          }
        }
        log?.info?.(`[douyin] notify_reply step=video videoId=${videoId}`)
        // 通知里的作者可能是本地备注（饲养员），评论区显示名是「草荧」：
        // 主人通知优先用 notifyCommentAuthor/dmOwnerDisplayName，再依次回退 actor、正文、target。
        const replyCandidates = []
        const addCandidate = (v) => {
          const s = squash(v).replace(/^@+/, '')
          if (s && !replyCandidates.includes(s)) replyCandidates.push(s)
        }
        if (commentTarget) addCandidate(commentTarget)
        else if (item.isOwner === true) {
          addCandidate(cfg.notifyCommentAuthor)
          addCandidate(cfg.dmOwnerDisplayName)
        }
        addCandidate(item.actor)
        addCandidate(item.text)
        addCandidate(target)
        const replyTarget = replyCandidates[0] || target || item.actor
        const useFake = typeof options?.replyImpl === 'function'
        const reply = useFake
          ? options.replyImpl
          : (a) => replyCurrentComment({ ...a, client: notifyBridge })
        log?.info?.(`[douyin] notify_reply step=reply target=${replyTarget}`)
        let result = await reply(useFake ? { videoId, target: replyTarget, text, confirm: true } : { target: replyTarget, text })
        let usedAlt = false
        if ((!result || result.ok !== true) && result?.code === 'E_NOT_FOUND') {
          // 最多再试 2 个候选（备注名 ↔ 显示名互换），仍然失败就明确 E_NOT_FOUND，不盲回
          let tried = 0
          for (const alt of replyCandidates) {
            if (tried >= 2) break
            if (!alt || alt === replyTarget) continue
            tried += 1
            usedAlt = true
            log?.info?.(`[douyin] notify_reply step=reply-alt target=${alt}`)
            result = await reply(useFake ? { videoId, target: alt, text, confirm: true } : { target: alt, text })
            if (result?.ok === true) break
            if (result?.code !== 'E_NOT_FOUND') break
          }
        }
        if (!result || result.ok !== true) {
          return {
            ...base,
            ...result,
            ok: false,
            action: 'notify_reply',
            videoId,
            notification,
            commentId,
            replyTarget,
            usedAltTarget: usedAlt,
            markedRead: true,
            note: '已标记已读（点开了通知条目）；回复未成功',
          }
        }
        return {
          ...result,
          ok: true,
          action: 'notify_reply',
          videoId,
          notification,
          commentId,
          replyTarget,
          usedAltTarget: usedAlt,
          markedRead: true,
          note: '已标记已读（点开了通知条目）',
        }
      } finally {
        try {
          if (itemClicked) {
            // notify tab 可能停在视频页；放回首页，保证通知 watcher/下次读取继续可用；main 不动。
            await notifyBridge.open(cfg.homeUrl)
          } else {
            await closeNotifyPanel(notifyBridge)
          }
        } catch {}
      }
    })
  }

  return {
    status, feed, search, open: openVideo, comments, screenshot, download, like, favorite, comment,
    commentReply, commentDelete, dmList, dmRead, dmSend, dmPollConversations, dmProbeDirection, isDmOutbound,
    notifyList, notifyReply, notifyInspect, notifyOpen, notifyClose,
    notifySourceStart, notifySourceTake, notifySourceStop, notifyBadgeProbe, notifySnapshotForWatch, notifyRefreshForWatch,
    usage,
  }
}
