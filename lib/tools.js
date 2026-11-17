/**
 * 工具注册：dy_douyin_*（只读，owner/home 专用）。
 *
 * 与 dsh-autonomy/lib/tools.js 的 isOwnerContext 同口径：
 * - 子智能体（parentSession / origin=subagent / delegationDepth>0）一律拒绝；
 * - 她的 home 会话（ctx.get('dyHome').isHomeSession）或 cwd 落在 home/owner 私有目录内才允许。
 */
import { basename, isAbsolute, resolve } from 'node:path'
import { DouyinError, toFailure } from './errors.js'
import { readSidecar, updateSidecar } from './download.js'

const OUT = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
  required: ['ok', 'detail'],
  additionalProperties: false,
}
const pack = (obj) => ({ ok: obj?.ok !== false, detail: JSON.stringify(obj, null, 2) })
const render = (_args, value) => [{ type: 'text', text: value.detail }]

const LIMIT_FEED = {
  type: 'number',
  minimum: 1,
  maximum: 8,
  description: '本次最多取几条（1–8，默认 8；浏览列表本身不占配额）',
}

const LIST_OUTPUT = '返回 {ok, items:[{videoId,url,text}], count}；失败返回 {ok:false, code, message}'

function cutText(value, max = 200) {
  const chars = Array.from(String(value ?? '').replace(/\s+/g, ' ').trim())
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('')
}

/** watch 的路径限制在 downloadDir 内；videoId/path 至少给一个，sidecar 必须存在 */
function resolveWatchTarget(args = {}, cfg = null) {
  const dir = String(cfg?.downloadDir ?? '').replace(/\/+$/, '')
  if (!dir.startsWith('/')) throw new DouyinError('E_BAD_ARG', 'downloadDir 未配置')
  let id = args?.videoId === undefined || args?.videoId === null ? '' : String(args.videoId).trim()
  let file = ''
  if (args?.path !== undefined && args?.path !== null && String(args.path).trim()) {
    const raw = String(args.path).trim()
    if (!isAbsolute(raw)) throw new DouyinError('E_BAD_ARG', 'path 必须是绝对路径')
    const abs = resolve(raw)
    if (!abs.startsWith(`${dir}/`)) throw new DouyinError('E_BAD_ARG', 'path 必须位于下载目录内')
    if (/\.json$/i.test(abs)) {
      const base = basename(abs, '.json')
      if (!/^\d{6,20}$/.test(base)) throw new DouyinError('E_BAD_ARG', 'sidecar 文件名必须是 <videoId>.json')
      if (id && id !== base) throw new DouyinError('E_BAD_ARG', 'videoId 与 path 不一致')
      id = base
    } else if (/\.mp4$/i.test(abs)) {
      const base = basename(abs, '.mp4')
      if (!/^\d{6,20}$/.test(base)) throw new DouyinError('E_BAD_ARG', '视频文件名必须是 <videoId>.mp4')
      if (id && id !== base) throw new DouyinError('E_BAD_ARG', 'videoId 与 path 不一致')
      id = base
      file = abs
    } else {
      throw new DouyinError('E_BAD_ARG', 'path 只接受 .mp4/.json')
    }
  }
  if (!id) throw new DouyinError('E_BAD_ARG', '需要 videoId 或 path')
  if (!/^\d{6,20}$/.test(id)) throw new DouyinError('E_BAD_ARG', 'videoId 必须是 6–20 位数字')
  const meta = readSidecar(dir, id)
  if (!meta) throw new DouyinError('E_NOT_FOUND', `没有找到 ${id}.json，请先 dy_douyin_download`)
  const metaFile = String(meta.file ?? '')
  if (file && metaFile && resolve(file) !== resolve(metaFile)) {
    throw new DouyinError('E_BAD_ARG', 'path 与 sidecar 记录的文件不一致')
  }
  file = metaFile || file
  if (!file || !isAbsolute(file) || !file.startsWith(`${dir}/`) || !/\.mp4$/i.test(file)) {
    throw new DouyinError('E_PARSE', 'sidecar 的 file 字段不合法')
  }
  return { dir, id, file, meta }
}

/** 看完后写一条观看记忆；重复 videoId 由 sidecar watchedAt/watchMemoryId 判幂等 */
async function rememberWatch({ ctx, exec, log, cfg, args }) {
  const { dir, id, file, meta } = resolveWatchTarget(args, cfg)
  const title = cutText(meta.title, 200)
  const author = cutText(meta.author, 60) || '未知'
  const base = { ok: true, videoId: id, file, title, author }
  if (meta.watchMemoryId || meta.watchedAt) {
    return { ...base, duplicate: true, memoryWritten: false, memoryId: meta.watchMemoryId ?? null }
  }

  const memory = ctx?.get?.('dyMemory')
  if (!memory || typeof memory.addEpisode !== 'function') {
    log?.warn?.('[douyin] dyMemory 不可用，观看记忆未写')
    return { ...base, duplicate: false, memoryWritten: false, warning: 'dyMemory 不可用' }
  }
  const header = exec?.agent?.session?.header ?? exec?.session?.header ?? null
  if (!header || typeof header !== 'object') {
    log?.warn?.('[douyin] 缺少 session header，观看记忆未写')
    return { ...base, duplicate: false, memoryWritten: false, warning: '缺少 session header' }
  }

  const thought = cutText(args?.thought, 400)
  const summary = cutText(args?.summary, 600)
  const note = cutText(args?.note, 200)
  const thoughtText = thought || note || '未记录'
  const authorText = author && author !== '未知' ? `@${author}` : '作者未知'
  let text =
    `看过抖音视频${title ? `《${title}》` : '（无标题）'}（${authorText}，videoId=${id}）；` +
    `观看想法：${thoughtText}；摘要：${summary || '未填写'}；文件：${file}`
  if (note && thought && note !== thought) text += `；备注：${note}`

  let out
  try {
    out = await memory.addEpisode({
      text,
      source: 'douyin_watch',
      ref: `videoId=${id}; file=${file}`,
      channel: 'douyin',
      videoId: id,
      file,
      header,
    })
  } catch (e) {
    log?.warn?.(`[douyin] 观看记忆写入失败（不影响下载文件）：${String(e?.message ?? e).slice(0, 160)}`)
    return { ...base, duplicate: false, memoryWritten: false, warning: '观看记忆写入失败' }
  }

  try {
    updateSidecar(dir, id, {
      watchedAt: new Date().toISOString(),
      watchMemoryId: out?.id === undefined || out?.id === null ? null : out.id,
    })
  } catch (e) {
    log?.warn?.(`[douyin] sidecar 更新失败（记忆已写）：${String(e?.message ?? e).slice(0, 160)}`)
  }
  return {
    ...base,
    duplicate: false,
    memoryWritten: true,
    memoryId: out?.id === undefined || out?.id === null ? null : out.id,
  }
}

/** 纯函数，方便测试直接断言注册定义 */
export function buildToolDefs(service, ctx = null, log = null, cfg = null) {
  // watch 是本地 sidecar+记忆写：串行化，避免并发读同一 sidecar 时重复写记忆
  let watchTail = Promise.resolve()
  const watchSerial = (args, exec) => {
    const run = watchTail.then(() => rememberWatch({ ctx, exec, log, cfg, args }))
    watchTail = run.then(
      () => {},
      () => {},
    )
    return run
  }
  return [
    {
      name: 'dy_douyin_status',
      description:
        '看抖音只读桥的状态（ping + 当前页 title/url）：{ok,proto,browser,pages,url,title,latencyMs,blockAssets,activeWatch,minWatchMs,watchedCount}。只读，不占配额，不受可用时段限制；owner/home 专用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: OUT, render },
      execute: async () => service.status(),
    },
    {
      name: 'dy_douyin_feed',
      description:
        `看抖音推荐流（只读）：必要时打开首页，再取视频卡片；scroll=true 时最多再下滚 3 次（每次约 700px、等 0.8s），按 videoId 去重直到 limit。${LIST_OUTPUT}。浏览卡片本身不占配额（只有看够 minWatchMs 的视频才计数）。配置 blockAssets=true 可预屏蔽图片/字体/媒体提速（截图封面会空）。只读，不点赞/不评论；owner/home 专用。`,
      parameters: {
        type: 'object',
        properties: {
          limit: LIMIT_FEED,
          scroll: {
            type: 'boolean',
            description: 'true=当前卡片不够时继续下滚最多 3 次（默认 false，行为不变）',
          },
        },
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) => service.feed({ limit: args.limit, scroll: args.scroll }),
    },
    {
      name: 'dy_douyin_search',
      description:
        `按关键词搜抖音（只读）：type=general/video 走视频卡片点击 modal_id；type=user 读 /user/ 链接（去导航/去重）；type=live 读直播卡片/直播链接（空结果 ok:true,count:0 带 note）。user/live 的 URL 会加 ?type=...；选择器/超时/远程 IO 失败自动重试一次。${LIST_OUTPUT}，另带 query/type。query 1–40 字；owner/home 专用。`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 40, description: '搜索关键词（1–40 字）' },
          type: { type: 'string', enum: ['general', 'video', 'user', 'live'], description: '搜索分类，默认 general' },
          limit: LIMIT_FEED,
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) => service.search({ query: args.query, limit: args.limit, type: args.type }),
    },
    {
      name: 'dy_douyin_open',
      description:
        '打开一条抖音作品页（只读）：{ok,videoId,url,status,title}。成功打开后开始计时（open 本身不计数），下一次浏览类工具调用按是否看够 minWatchMs 结算 0/1 条。接受作品 id、douyin.com/video|note/<数字>、iesdouyin 分享页、v.douyin.com 短链，或整段分享文案；不自动连播/翻页；owner/home 专用。',
      parameters: {
        type: 'object',
        properties: {
          videoId: { type: 'string', description: '作品 id（6–20 位数字）' },
          url: {
            type: 'string',
            description: '作品页、短链或整段分享文案：https://www.douyin.com/video|note/<数字> / https://v.douyin.com/... / iesdouyin 分享页',
          },
        },
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) => service.open({ videoId: args.videoId, url: args.url }),
    },
    {
      name: 'dy_douyin_comments',
      description:
        '打开视频页并用白名单选择器读评论（只读）：初始评论后最多点 20 个 button.comment-reply-expand-btn 展开回复（逐个 nth=0 + 等 500ms），再 list 合并；返回 {ok,videoId,items:[{author,text,likes,replyCount,replies[]}],count}。失败/无评论返回 E_SELECTOR_MISS；只点白名单按钮，不点赞/不回复/不猜。owner/home 专用。',
      parameters: {
        type: 'object',
        properties: {
          videoId: { type: 'string', description: '视频 id（6–20 位数字）' },
          url: { type: 'string', description: '也可传视频页/短链；与 videoId 二选一' },
          limit: { type: 'number', minimum: 1, maximum: 50, description: '最多取几条评论（1–50，默认 20）' },
          scroll: { type: 'boolean', description: '不够时是否往下滚加载更多（默认 true）' },
        },
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) => service.comments({ videoId: args.videoId, url: args.url, limit: args.limit, scroll: args.scroll }),
    },
    {
      name: 'dy_douyin_notify_list',
      description:
        '读抖音「通知/互动消息」面板（只读，owner/home）：固定使用独立 notify tab，不读/不导航 main。点「通知」打开面板，读当前已加载条目，返回 {ok,role,panel,filter,items:[{id,index,actor,relation,type,text,time,ageMs,likeCount,isOwner,replyable,videoId,commentId}],count,loaded,rawCount,reply}。每条带稳定 id（可给 notify_reply 精确选择）和 index（0 基）；isOwner=饲养员/草荧/dm-owner.txt 第一行；replyable=mention/comment_reply 且时间在窗口内。type=mention / comment_reply / like_comment / like_danmaku / follow。面板 DOM 里没有视频链接、也没有「回复」按钮，所以 videoId/commentId 恒为 null；本工具不点条目、不标记已读、不回复。关闭面板：Escape → 页面空白处真实点击（真机实测 Escape 不关这个浮层）→ 通知入口兜底，不点搜索框/条目。limit 1–50（默认 20）；loadMore=true（默认）时自动点「点击加载更多」最多 3 次补齐。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', minimum: 1, maximum: 50, description: '最多返回几条（1–50，默认 20）' },
          loadMore: { type: 'boolean', description: 'true=不足时点「点击加载更多」（默认 true）；false=只读当前已加载' },
        },
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) => service.notifyList({ limit: args.limit, loadMore: args.loadMore }),
    },
    {
      name: 'dy_douyin_notify_reply',
      description:
        '回复一条抖音通知（写操作，owner/home，必须 confirm:true）：只支持 type=mention/comment_reply。固定使用独立 notify tab，不导航 main。先用通知 id（notify_list 返回的稳定 id）或 index（0 基）精确选择；只给 target 时按作者名精确/正文包含匹配，多条 E_AMBIGUOUS（不盲回）。id/index/target 指向不同条目 E_BAD_ARG。时间只有日期/星期或超过 1 小时直接 E_STALE（不点条目）；like/follow 返回 E_NOT_REPLYABLE（不点）。确认后在该 notify tab 点开通知条目（**会把该条标记为已读**）→从 URL 取 videoId→在当前 notify tab 的评论区回复（owner 通知优先用草荧显示名，失败回退备注名）→回读评论列表判 verified；回复完 notify tab 回首页，main 不动。找不到 E_NOT_FOUND；不自动回复、不批量。返回带 markedRead:true。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'notify_list 返回的通知 id（推荐；精确选择）' },
          target: { type: 'string', description: '通知作者名或正文片段（1–100 字；没有 id 时必填）' },
          text: { type: 'string', description: '回复正文（1–500 字）' },
          confirm: { type: 'boolean', description: '必须 true；缺省返回 E_CONFIRM_REQUIRED（会点开通知、可能标记已读并发出评论）' },
          index: { type: 'number', minimum: 0, maximum: 49, description: '可选：第几条通知（0 基），用于消歧' },
          commentTarget: { type: 'string', description: '可选：评论回复的 target（默认用主人显示名/通知作者；1–100 字）' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) =>
        service.notifyReply({
          id: args.id,
          target: args.target,
          text: args.text,
          confirm: args.confirm,
          index: args.index,
          commentTarget: args.commentTarget,
        }),
    },
    {
      name: 'dy_douyin_download',
      description:
        '下载一条抖音作品到本地（只有她明确喜欢/要求时才调用，绝不自动下载 feed）：只读打开作品页→从 <source src> 取媒体 URL（/playwm/ 优先换 /play/ 无水印版）→本地落盘到 /sdcard/DSHA/媒体/抖音/下载/<videoId>.mp4，并写同名 sidecar JSON；`/note/<id>` 图文作品落成 <videoId>-NN.jpg/webp 图集。返回 {ok,videoId,kind,file,bytes,seconds,title?,author}，图集额外带 files/count。url 可直接贴整段分享文案。只保存文件，不写观看记忆；看完后调 dy_douyin_watch。单文件 ≤300MB，拿不到媒体流 E_NO_MEDIA；不自动转写。owner/home 专用。',
      parameters: {
        type: 'object',
        properties: {
          videoId: { type: 'string', description: '作品 id（6–20 位数字）' },
          url: {
            type: 'string',
            description: '作品页、短链或整段分享文案：douyin.com/video|note/<数字> / v.douyin.com/... / iesdouyin 分享页 / 「复制打开抖音… https://v.douyin.com/xxx/ 复制此链接」',
          },
          quality: {
            type: 'string',
            enum: ['best', 'source', '720p', '1080p', '540p'],
            description: '画质偏好（预留；当前取页面首个 source，通常最高码率）',
          },
        },
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) =>
        service.download({ videoId: args.videoId, url: args.url, quality: args.quality }),
    },
    {
      name: 'dy_douyin_watch',
      description:
        '看完下载的视频后写一条观看记忆（owner/home）：从 <downloadDir>/<videoId>.json 取 title/author/file，写一条 dyMemory.addEpisode；同 videoId 已写过则幂等跳过；失败只 warn、不抛。参数：videoId 或 path（.mp4/.json，必须位于下载目录）；thought/summary/note 可选。',
      parameters: {
        type: 'object',
        properties: {
          videoId: { type: 'string', description: '视频 id（6–20 位数字）' },
          path: { type: 'string', description: '下载目录内的 .mp4 或 sidecar .json 绝对路径' },
          thought: { type: 'string', description: '观看想法（≤400 字，超出截断）' },
          summary: { type: 'string', description: '内容摘要（≤600 字，超出截断）' },
          note: { type: 'string', description: '可选备注/喜欢原因（≤200 字，超出截断）' },
        },
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}, exec = null) => watchSerial(args, exec),
    },
    {
      name: 'dy_douyin_like',
      description:
        '给抖音视频点赞/取消点赞（owner/home）：selector `[data-e2e="video-player-digg"]`；dryRun=true 只打开视频页读状态（含 `data-e2e-state`），不点击；真实写必须 confirm:true 且 dryRun 不为 true；默认 inputMode=auto 先点击，点击被浮层拦截（E_TIMEOUT）且回读确认没点上时回退键盘 Z；点击/按键后回读 `data-e2e-state`（video-player-is-digged / no-digged），读不到再回落 class/aria/计数，回读不一致返回 verified:false、不重试；同 videoId+目标状态幂等，写账本。',
      parameters: {
        type: 'object',
        properties: {
          videoId: { type: 'string', description: '视频 id（6–20 位数字）' },
          undo: { type: 'boolean', description: 'true=取消点赞，默认 false=点赞' },
          confirm: { type: 'boolean', description: '真实写必须 true；缺省返回 E_CONFIRM_REQUIRED' },
          dryRun: { type: 'boolean', description: 'true=只检查状态/选择器，不点击' },
          inputMode: { type: 'string', enum: ['auto', 'click', 'key'], description: 'auto=先点击、失败回退键盘 Z（默认）；click=只点；key=只按快捷键' },
        },
        required: ['videoId'],
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) => service.like(args),
    },
    {
      name: 'dy_douyin_favorite',
      description:
        '收藏/取消收藏抖音视频（owner/home）：selector `[data-e2e="video-player-collect"]`；dryRun=true 只读状态（含 `data-e2e-state`）；真实写必须 confirm:true；默认 inputMode=auto 先点击，被浮层拦截时回退键盘 C；点击/按键后回读 `data-e2e-state`（video-player-is-collected / no-collect），读不到再回落 class/aria/计数，verified:false 不重试；同 videoId+目标状态幂等，写账本。',
      parameters: {
        type: 'object',
        properties: {
          videoId: { type: 'string', description: '视频 id（6–20 位数字）' },
          undo: { type: 'boolean', description: 'true=取消收藏，默认 false=收藏' },
          confirm: { type: 'boolean', description: '真实写必须 true；缺省返回 E_CONFIRM_REQUIRED' },
          dryRun: { type: 'boolean', description: 'true=只检查状态/选择器，不点击' },
          inputMode: { type: 'string', enum: ['auto', 'click', 'key'], description: 'auto=先点击、失败回退键盘 C（默认）；click=只点；key=只按快捷键' },
        },
        required: ['videoId'],
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) => service.favorite(args),
    },
    {
      name: 'dy_douyin_comment',
      description:
        '写抖音评论草稿（owner/home）：打开视频页/评论栏，点击白名单输入框（DraftEditor `[contenteditable]`），先清空已有草稿：文本以 `@名字` 开头时用键盘输入 `@`+名字并回车选中提及候选（粘贴的 @ 只是普通字符，不会触发提及），再剪贴板粘贴剩余正文；否则整段剪贴板粘贴。不提交；返回 draftFilled/draftValue/inputVia/mention。draftOnly=false + confirm=true 才尝试提交；提交按钮选择器已抓取，点击被挡时用 Enter 兜底，提交后以评论列表回读判定 verified。同 videoId 已有 posted 账本时返回 idempotent:true（带 before/after，不发送）；要再发一条传 force:true。不做自动回复/批量评论。',
      parameters: {
        type: 'object',
        properties: {
          videoId: { type: 'string', description: '视频 id（6–20 位数字）' },
          text: { type: 'string', description: '评论草稿（1–500 字）' },
          replyTo: { type: 'string', description: '预留；暂不支持（传了返回 E_BAD_ARG）' },
          draftOnly: { type: 'boolean', description: '默认 true=只填草稿；false+confirm=true 才允许提交' },
          confirm: { type: 'boolean', description: '提交评论必须 true；仅草稿不需要' },
          force: { type: 'boolean', description: 'true=忽略该视频已有的 posted 账本，强制再发一条（仍需 confirm:true）' },
        },
        required: ['videoId', 'text'],
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) => service.comment(args),
    },
    {
      name: 'dy_douyin_comment_reply',
      description:
        '回复一条 1 小时内的新评论（owner/home）：打开视频/评论栏，按 target（评论正文片段或作者名）在当前已加载评论里定位；目标评论时间必须是“刚刚 / N分钟前 / N小时前”且 ≤ commentReplyWindowMs（默认 1 小时），旧评论返回 E_STALE；点该条「回复」→ 内联 DraftEditor → 剪贴板粘贴 → 点发送 → 回读评论的回复段验证。必须 confirm:true；找不到 E_NOT_FOUND，不盲回。',
      parameters: {
        type: 'object',
        properties: {
          videoId: { type: 'string', description: '视频 id（6–20 位数字）' },
          target: { type: 'string', description: '目标评论的正文片段或作者名（1–100 字）' },
          text: { type: 'string', description: '回复正文（1–500 字）' },
          confirm: { type: 'boolean', description: '回复必须 true；缺省返回 E_CONFIRM_REQUIRED' },
        },
        required: ['videoId', 'target', 'text'],
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) => service.commentReply(args),
    },
    {
      name: 'dy_douyin_comment_delete',
      description:
        '删除自己在抖音视频下的一条评论（owner/home）：按 text 在当前已加载的评论里匹配（最多 50 条），点该条「更多」→「删除评论」，删除后回读列表确认。必须 confirm:true；别人的评论菜单里没有删除项（E_SELECTOR_MISS）；找不到 E_NOT_FOUND，绝不盲删；不批量、不自动。',
      parameters: {
        type: 'object',
        properties: {
          videoId: { type: 'string', description: '视频 id（6–20 位数字）' },
          text: { type: 'string', description: '要删的评论正文（1–500 字，按包含匹配）' },
          confirm: { type: 'boolean', description: '删除必须 true；缺省返回 E_CONFIRM_REQUIRED' },
        },
        required: ['videoId', 'text'],
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) => service.commentDelete(args),
    },
    {
      name: 'dy_douyin_sms_code',
      description:
        '填入主人提供的短信验证码（owner/home，写操作）：抖音因风控弹出短信验证面板时，汐先通过 QQ/邮件通知主人；主人把手机上收到的验证码回给她后，用本工具填入并点「验证」。不绕过验证、不猜码；当前没有验证面板返回 E_NOT_FOUND；提交后面板仍在返回 E_UNVERIFIED（可能码错/过期）。必须 confirm:true。返回 {ok,verified,submitVia,chars}。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '主人提供的短信验证码（4–8 位数字）' },
          confirm: { type: 'boolean', description: '填入验证码必须 true；缺省返回 E_CONFIRM_REQUIRED' },
        },
        required: ['code'],
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) => service.smsCode(args),
    },
    {
      name: 'dy_douyin_dm_list',
      description:
        '列出抖音私信会话（只读，owner/home）：打开 /chat，读会话名/最后一条预览/时间；不点开会话、不发送。每条带稳定 id（conversationId）、index（0 基）、isOwner（饲养员/草荧/dm-owner.txt 第一行）。返回 {ok,items:[{id,index,name,preview,time,isOwner}],count}。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: OUT, render },
      execute: async () => service.dmList(),
    },
    {
      name: 'dy_douyin_dm_read',
      description:
        '读一个已有私信会话（只读，owner/home）：按 conversationId / index（来自 dm_list）或 name 精确定位并点开，读最近最多 50 条消息。每条消息带稳定 id（messageId）、index、sender(会话名)、fromMe、time、isOwner；返回 conversation 里也有 id/index/isOwner。name 匹配到多个会话时 E_AMBIGUOUS（不猜）。点开会话会标记已读；只读不发送。',
      parameters: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: 'dm_list 返回的会话 id（dmc_…，推荐）' },
          index: { type: 'number', minimum: 0, maximum: 19, description: 'dm_list 里的会话位置（0 基，用于消歧）' },
          name: { type: 'string', description: '会话名（1–60 字，精确匹配；重名请改用 conversationId/index）' },
          limit: { type: 'number', minimum: 1, maximum: 50, description: '最多返回几条（默认 20，取最近 N 条）' },
        },
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) =>
        service.dmRead({
          conversationId: args.conversationId,
          index: args.index,
          name: args.name,
          limit: args.limit,
        }),
    },
    {
      name: 'dy_douyin_dm_send',
      description:
        '回一条已有私信（owner/home）：按 dm_list 的 conversationId/index 或 dm_read 的 messageId 精确定位（兼容 name；重名时 E_AMBIGUOUS，不按名字猜）。只回“对方最后一条消息在 dmReplyWindowMs 内”的会话；主人会话（dm-owner.txt/饲养员/草荧）可主动发；旧日期一律 E_STALE。messageId 必须来自 dm_read，且不能指向自己发的消息；找不到 E_NOT_FOUND，绝不盲发。必须 confirm:true，受每日限额（dmDailyLimit）。输入用剪贴板粘贴，发送后回读验证；不新建会话、不群发、不自动回复。返回不含正文，只有 name/conversation/chars/textHash/verified。',
      parameters: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: 'dm_list 返回的会话 id（推荐）' },
          messageId: { type: 'string', description: 'dm_read 返回的消息 id（精确回复目标；同时反推会话）' },
          index: { type: 'number', minimum: 0, maximum: 19, description: 'dm_list 里的会话位置（0 基）' },
          name: { type: 'string', description: '已有会话名（精确匹配；重名请改用 conversationId/index）' },
          text: { type: 'string', description: '私信正文（1–500 字）' },
          confirm: { type: 'boolean', description: '发送必须 true；缺省返回 E_CONFIRM_REQUIRED' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) => service.dmSend(args),
    },
    {
      name: 'dy_douyin_dm_watch',
      description:
        '抖音私信实时 watcher（只读，owner/home）：返回“新消息事件”列表，事件带 owner=true/false（主人饲养员/草荧）与 conversationId/conversationName/text/time；不打开会话、不标记已读、不发送、不路由。action=poll（默认，轮询一次并取走队列）/drain（只取队列）/start/stop/status；limit 1–100（默认 20）。第一次读取只建基线，历史会话不重复上报；读取失败只记日志不重试。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['poll', 'drain', 'start', 'stop', 'status'],
            description: 'poll=轮询一次并取队列（默认）；drain=只取队列；start/stop/status 控制后台 watcher',
          },
          limit: { type: 'number', minimum: 1, maximum: 100, description: '本次最多返回几条事件（默认 20）' },
        },
        additionalProperties: false,
      },
      output: { schema: OUT, render },
      execute: async (args = {}) => service.dmWatch({ action: args.action, limit: args.limit }),
    },
    {
      name: 'dy_douyin_screenshot',
      description:
        '截取远程浏览器当前页（只读）：回传 PNG 存到本地截图目录，返回 {ok,file,bytes}。不占配额；1–2MB 上限；owner/home 专用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: OUT, render },
      execute: async () => service.screenshot(),
    },
  ]
}

/**
 * @param {{ctx:object, service:object, cfg:object, log?:object}} deps
 * @returns {number} 成功注册的工具数；tools 服务不可用返回 0（不抛）
 */
export function registerTools({ ctx, service, cfg, log = null }) {
  let tools = null
  try {
    tools = ctx?.get?.('tools') ?? null
  } catch {
    tools = null
  }
  if (!tools || typeof tools.register !== 'function') {
    log?.warn?.('[douyin] tools 服务不可用：dy_douyin_* 未注册（插件其余部分不影响）')
    return 0
  }

  const wrap = (name, fn) => async (args = {}, exec) => {
    const access = contextAccess(ctx, exec, cfg)
    if (access === 'none') {
      return pack({ ok: false, code: 'E_PERMISSION', message: '只有主人、她的家或抖音渠道会话可以使用抖音工具' })
    }
    if (access === 'channel' && !isChannelToolAllowed(name, cfg)) {
      return pack({
        ok: false,
        code: 'E_PERMISSION',
        message: `抖音渠道会话只开放只读/私信/通知类工具；${name} 需要 owner/home 权限`,
      })
    }
    let result
    try {
      result = await fn(args ?? {}, exec)
    } catch (e) {
      result = toFailure(e)
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      result = { ok: false, code: 'E_REMOTE_IO', message: '工具返回为空' }
    }
    return pack(result)
  }

  let registered = 0
  for (const def of buildToolDefs(service, ctx, log, cfg)) {
    try {
      tools.register({ ...def, execute: wrap(def.name, def.execute) })
      registered += 1
    } catch (e) {
      log?.warn?.(`[douyin] 注册 ${def.name} 失败：${String(e?.message ?? e).slice(0, 200)}`)
    }
  }
  return registered
}

/**
 * 访问级别：'owner'（主人/她的家，全部工具）/ 'channel'（抖音渠道会话，白名单子集）/ 'none'。
 * 2026-11-17 主人要求：汐在抖音渠道（/sdcard/DSHA/渠道/douyin）的会话也要能用抖音工具。
 */
export function contextAccess(ctx, exec, cfg) {
  try {
    const sess = exec?.agent?.session ?? exec?.session
    const h = sess?.header ?? {}
    // 子代理/委派会话一律不给（防止被委派出去的上下文拿到写权限）
    if (h.parentSession || String(h.origin ?? '') === 'subagent' || Number(h.delegationDepth ?? 0) > 0) {
      return 'none'
    }
    const sid = String(h.id ?? sess?.id ?? '')
    if (sid) {
      try {
        const home = ctx?.get?.('dyHome')
        if (home?.isHomeSession?.(sid)) return 'owner'
      } catch {
        // dyHome 不可用时继续按 cwd 判断
      }
    }
    const cwd = String(h.cwd ?? '')
    if (!cwd) return 'none'
    const norm = (d) => String(d ?? '').replace(/\/+$/, '')
    const under = (dirs) =>
      dirs
        .filter(Boolean)
        .map(norm)
        .filter(Boolean)
        .some((p) => cwd === p || cwd.startsWith(`${p}/`))
    if (under([cfg?.homeCwd, ...(Array.isArray(cfg?.ownerPrivateDirs) ? cfg.ownerPrivateDirs : [])])) return 'owner'
    if (under(Array.isArray(cfg?.channelCwds) ? cfg.channelCwds : [])) return 'channel'
    return 'none'
  } catch {
    return 'none'
  }
}

/** 抖音渠道会话能用哪些工具（白名单；空=全禁） */
export function isChannelToolAllowed(name, cfg) {
  const list = Array.isArray(cfg?.channelToolAllowlist) ? cfg.channelToolAllowlist : []
  return list.includes(String(name ?? ''))
}

/** owner/home 门禁；任何异常都按“不是 owner”处理（保留旧 API，测试/外部仍可用） */
export function isOwnerContext(ctx, exec, cfg) {
  return contextAccess(ctx, exec, cfg) === 'owner'
}

function legacyIsOwnerContext(ctx, exec, cfg) {
  try {
    const sess = exec?.agent?.session ?? exec?.session
    const h = sess?.header ?? {}
    if (h.parentSession || String(h.origin ?? '') === 'subagent' || Number(h.delegationDepth ?? 0) > 0) {
      return false
    }
    const sid = String(h.id ?? sess?.id ?? '')
    if (sid) {
      try {
        const home = ctx?.get?.('dyHome')
        if (home?.isHomeSession?.(sid)) return true
      } catch {
        // dyHome 不可用时继续按 cwd 判断
      }
    }
    const cwd = String(h.cwd ?? '')
    if (!cwd) return false
    const dirs = [cfg?.homeCwd, ...(Array.isArray(cfg?.ownerPrivateDirs) ? cfg.ownerPrivateDirs : [])].filter(Boolean)
    return dirs.some((d) => {
      const p = String(d).replace(/\/+$/, '')
      return cwd === p || cwd.startsWith(`${p}/`)
    })
  } catch {
    return false
  }
}
