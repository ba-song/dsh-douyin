/**
 * dsh-douyin 配置：默认值 + 容错归一化。
 *
 * 设计约束（主人 2026-11-07 特别提醒）：
 * - 纯函数：不读文件、不连 SSH、不起子进程、不注册定时器；apply 调用它也是零副作用。
 * - 非法值一律回落到默认值并记 warnings，绝不 throw —— 错误配置不能把宿主搞崩。
 *
 * 时段（Asia/Shanghai，固定 UTC+8，无夏令时）：
 * - 工作日 08:00–09:00、12:00–14:00、18:00–次日 09:00；
 * - 周末全天；
 * - 00:00–08:00 是她的静默时段，优先级最高，对所有日期生效。
 * 归一化后 timeWindows 是“分钟区间”数组：[startMinute, endMinute]，end 可为 1440。
 */

// cosmokit 的 volatile 引用标记（index.js 里 .volatile() 字段解析后就是这种只读引用）
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * 是否像 volatile 引用：
 * - 真实引用：cosmokit `createVolatile` 的冻结对象，带 write 标记 + get()（isVolatile 同口径）；
 * - 兼容形态：只暴露 get() 的普通只读引用（测试桩/跨运行时快照），也按引用还原。
 */
function isVolatileRef(value) {
  if (value === null || typeof value !== 'object' || typeof value.get !== 'function') return false
  if (VOLATILE_WRITE in value) return true
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === 'get'
}

/**
 * 把 schemastery `.volatile()` 解析出来的引用还原成普通 JSON 值。
 * cordis 在调用 apply 前会用插件导出的 Config schema 解析 profile 配置，
 * volatile 字段会变成 `{ get() }` 只读引用；normalizeConfig 是本插件唯一配置读入口，
 * 所以先还原再清洗。对原本就是普通对象的配置零影响。
 */
export function unwrapVolatile(value, seen = new Set()) {
  if (isVolatileRef(value)) {
    return unwrapVolatile(value.get(), seen)
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    const out = value.map((item) => unwrapVolatile(item, seen))
    seen.delete(value)
    return out
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    if (seen.has(value)) return value
    seen.add(value)
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = unwrapVolatile(item, seen)
    seen.delete(value)
    return out
  }
  return value
}

export const DEFAULT_TIME_WINDOWS = Object.freeze({
  weekday: Object.freeze(['08:00-09:00', '12:00-14:00', '18:00-24:00']),
  weekend: Object.freeze(['00:00-24:00']),
  silence: Object.freeze(['00:00-08:00']),
})

export const DEFAULTS = Object.freeze({
  // 总开关；关掉后所有工具返回 E_DISABLED（仍注册，便于排障）
  enabled: true,

  // 传输：v1 只用 ssh-exec；streamlocal 只保留占位接口
  transport: 'ssh-exec',
  localSocket: '/persistent/cdp/bridge.sock',
  sshHost: '127.0.0.1',
  sshPort: 2222,
  sshUser: 'root',
  sshKeyPath: '/root/.dsh/douyin/ssh/id_ed25519',
  knownHosts: '/root/.dsh/douyin/known_hosts',

  // 远程桥：固定命令白名单客户端（一行 JSON 进、一行 JSON 出）
  remoteNodeDir: '/manager/extensions/harness/program/node/bin',
  remoteClient: '/persistent/cdp/client-stdin.js',
  shotsDir: '/persistent/cdp/shots',

  // 超时：open 120s，其余 30s
  openTimeoutMs: 120000,
  callTimeoutMs: 30000,

  // ===== 写路径 / 桥协议 v2 旋钮（2026-11-16 抖音优化，protocol-v2.md §B）=====
  // click 超时：桥侧不再硬编码 15s（实测 click ok avg 2.2s，15s 只会把被浮层挡住变成长时间占链）
  clickTimeoutMs: 3000,
  // 点前 scrollIntoViewIfNeeded 的超时；0 = 传 scroll:false 跳过（它对 position:fixed 会白等）
  clickScrollTimeoutMs: 600,
  // open 同 URL 复用（归一化后相等则不导航）
  openReuse: true,
  // 桥没有 capabilities（老桥）时自动降级为旧的多次调用路径，不报错
  probeEnabled: true,
  // waitFor 条件等待上限
  waitForTimeoutMs: 2500,
  // 写后回读轮询：每 120ms 读一次，最多 1.6s；状态一变立即返回（替代固定 800ms sleep）
  writeVerifyPollMs: 120,
  writeVerifyTimeoutMs: 1600,
  // 读点赞/收藏状态：最多 4 次、每次间隔 150ms（替代固定 700ms）
  toggleReadRetries: 4,
  toggleReadWaitMs: 150,
  // 写操作用 netArm/netTake 校验接口 200（未核实 patterns 只加分，不判失败）
  netVerifyEnabled: true,
  netVerifyTimeoutMs: 1500,
  // notify panel 模式不再每 tick 开面板，只在该间隔到点或 trigger 时开（watcher 用）
  notifyPanelPollMs: 60000,
  // watcher 失败指数退避 / 熔断（watcher 侧读取，配置归口在 config.js）
  watchBackoffMinMs: 3000,
  watchBackoffMaxMs: 60000,
  watchBackoffFactor: 2,
  watchBreakerFails: 12,
  watchBreakerCooldownMs: 300000,

  // 限流（条数 = 成功打开/展示的视频/搜索结果）
  dailyQuota: 40,
  perSession: 8,
  sessionGapMs: 30 * 60 * 1000,
  minIntervalMs: 5000,
  maxQueue: 8,

  // 时段与审计
  tzOffsetMinutes: 480,
  timeWindows: DEFAULT_TIME_WINDOWS,

  // 抖音页面
  // 2026-11-14 实测：/ 和 ?recommend=1 都会在数秒后落到 /jingxuan（精选）；
  // 只有导航「推荐」链接完整 URL（?recommend=1&from_nav=1）稳定停在推荐页。
  homeUrl: 'https://www.douyin.com/?recommend=1&from_nav=1',
  loginSelector: '[id^="login-full-panel"]',
  // 精选页是瀑布流卡片；推荐页是单列 video（data-e2e-vid 在子节点）。两个都认，避免 homeUrl 切到推荐后 feed 抓空。
  feedSelector: 'div.waterfall-videoCardContainer, [data-e2e="feed-item"] [data-e2e-vid]',
  searchSelector: 'div.search-result-card',
  commentSelectors: Object.freeze([
    '[data-e2e="comment-item"]',
    'div.comment-item',
    'div[data-e2e="comment-list"] > div',
  ]),
  // 评论区默认是收起的：抓不到时点一下这个按钮把它展开（只点这一个白名单选择器）
  commentOpenSelectors: Object.freeze(['[data-e2e="feed-comment-icon"]']),
  textLen: 60,
  commentTextLen: 200,
  // 评论页是懒加载：打开视频后最多等 8 次 × 1.5s
  commentWaitMs: 1500,
  commentRetries: 12,
  // 评论区是虚拟列表：滚一下已加载的会被整片卸载（实测 38 条直接掉到 0），所以默认不滚
  commentScrollSteps: 3,
  commentScrollDelta: 700,
  commentScrollWaitMs: 800,
  // 评论内“展开N条回复”：最多点 20 个，每个点完等 500ms
  commentReplyExpandMax: 20,
  commentReplyWaitMs: 500,
  // 写操作（只在她确认后）：读回等待、评论输入/提交选择器、远程键盘
  writeReadbackWaitMs: 800,
  commentInputSelectors: Object.freeze(['[contenteditable]']),
  commentInputOpenSelectors: Object.freeze(['text=留下你的精彩评论吧']),
  // 2026-11-08 真实页面抓取：评论输入框右侧最后一个 span 是发送图标（红色箭头），
  // 有文本时 class 多一个启用态；点击后仍以“评论列表回读”为 verified 判据。
  // 注意：选择器已抓到，但“真实提交”还没验收（首次提交由主人确认后做）。
  commentSubmitSelectors: Object.freeze([
    '#comment-input-container .commentInput-right-ct span:last-child',
  ]),
  // 自己评论的「更多」菜单项（2026-11-09 真实页面抓取：div.y2mcPJ_B，文本=删除评论）
  commentDeleteSelectors: Object.freeze(['text=删除评论']),
  // @提及（2026-11-10 真机：键盘打 @ 才会弹候选，粘贴不会；候选 class 是哈希 lgAE_oZa）
  // 评论回复（2026-11-10 真机：点评论「回复」→ 内联 DraftEditor；发送图标在回复框祖先里的 wchsYBpK）
  commentReplyWindowMs: 60 * 60 * 1000,
  // 点「回复」后主输入框切到 reply 模式：容器多一个 comment-input-container-focus
  commentReplyInputSelector: '.comment-input-container-focus [contenteditable]',
  commentReplySendSelector: '.comment-input-container-focus .commentInput-right-ct span:last-child',
  commentMentionSelectors: Object.freeze(['[class~="lgAE_oZa"]']),
  commentMentionChipSelector: '.douyin_mention_word',
  commentMentionWaitMs: 800,
  commentMoreSelectors: Object.freeze(['[data-e2e="video-comment-more"]']),
  // 私信（2026-11-10 真实页面 /chat 抓取；只回已有会话，白名单文件默认空 = 禁止发送）
  dmUrl: 'https://www.douyin.com/chat',
  dmEntrySelector: 'header :text-is("消息")',
  dmWaitMs: 4000,
  dmConversationWaitMs: 2000,
  dmSendWaitMs: 1500,
  dmConversationSelectors: Object.freeze(['[data-e2e="conversation-item"]', '[class~="conversationConversationItemtitle"]']),
  dmPreviewSelector: '.ConversationItemHinttextBox',
  dmTimeSelector: '.ConversationItemTagNextToTitletimeStr',
  dmMessageSelectors: Object.freeze(['[class~="MessageItemTextcontainer"]']),
  dmInputSelector: '[data-slate-editor="true"]',
  dmSendSelector: '.e2e-send-msg-btn',
  dmSendEnabledClass: 'messageMsgInputpublishRedBtn',
  dmAllowlistFile: '/sdcard/DSHA/媒体/抖音/dm-allowlist.json', // 兼容旧配置；v2 不再用它做发送门禁
  dmOwnerFile: '/sdcard/DSHA/媒体/抖音/dm-owner.txt',
  dmReplyWindowMs: 60 * 60 * 1000,
  dmTimeLayoutSelector: '[class~="MessageBoxTimetimeLayout"]',
  dmDailyLimit: 3,
  dmKeepPanelOpen: false,
  // 主人识别（2026-11-14 主人确认）：通知里备注可能是「饲养员」，抖音显示名是「草荧」。
  // dm-owner.txt 第一行仍优先生效，和这里的别名取并集；用于 dmWatch 事件 / 列表 isOwner / 通知回复目标映射。
  dmOwnerAliases: Object.freeze(['饲养员', '草荧']),
  dmOwnerDisplayName: '草荧',
  // 私信实时 watcher（只读，供 autonomy 取用）：默认关，profile 里显式 dmWatchEnabled:true 才起后台定时器。
  // 轮询间隔默认 3s（要求 2–5s 可配置）；第一次成功读取只建基线，之后只投“会话预览+时间”首次变化。
  // 开启后 dm watcher 在独立 dm tab 停在 /chat 持续监听，不导航 main（2026-11-14 多页面 role 模型）。
  dmWatchEnabled: false,
  dmWatchIntervalMs: 3000, // 强制 ≥2000ms
  dmWatchStartupDelayMs: 3000,
  dmWatchLimit: 20,
  dmWatchMaxSeen: 1000,
  dmWatchConfirmTicks: 2, // 新指纹连续出现 N 次才确认（防页面切换/并发导航造成假事件）
  dmWatchStateFile: '',
  dmWatchKeepOpen: true,
  // 通知/互动消息（2026-11-14 真机抓取，只读）：主站右上角「通知」按钮打开面板。
  // 面板 DOM：listDlgTest-container > div:nth-child(2) > div（每条）+ 最后一条“点击加载更多”。
  // 条目里没有视频链接、也没有「回复」按钮；videoId 只能点开条目后从 URL 的 modal_id 拿。
  notifyEntrySelectors: Object.freeze([
    'header [data-e2e="something-button"]:has-text("通知")',
    'header :text-is("通知")',
  ]),
  notifyPanelSelectors: Object.freeze(['[data-e2e="listDlgTest-container"]']),
  notifyItemSelectors: Object.freeze([
    '[data-e2e="listDlgTest-container"] > div:nth-child(2) > div',
  ]),
  notifyLoadMoreSelectors: Object.freeze([
    '[data-e2e="listDlgTest-container"] > div:nth-child(2) > div:last-child',
  ]),
  notifyFilterSelector: '[data-e2e="cur-filter"]',
  // 已弃用（2026-11-14）：关闭面板只按 Escape/通知入口切换，绝不再点搜索框；字段保留兼容但不再使用。
  notifyCloseSelector: '[data-e2e="searchbar-input"]',
  notifyWaitMs: 800,
  notifyRetries: 20,
  notifyLoadMoreWaitMs: 1500,
  notifyLoadMoreMax: 3,
  notifyTextLen: 500,
  // 通知作者是本地备注「饲养员」，评论区显示名是「草荧」；回复时用这个映射
  notifyCommentAuthor: '',
  // 通知实时事件源（task-11/13，默认关闭）：
  // jsWatch(badge/DOM/net) + 已打开面板被动读取；只有 badge/net 真变化才开一次面板，绝不每 3s 强开。
  notifyWatchEnabled: false,
  notifyWatchIntervalMs: 3000, // 2–30s；默认 3s（要求 3–5s）
  notifyWatchStartupDelayMs: 1000, // 启动后先跑一次建基线
  notifyWatchLimit: 20,
  notifyWatchMaxSeen: 500,
  notifyWatchMaxAgeMs: 10 * 60_000,
  notifyWatchStateFile: '',
  notifyWatchSource: 'auto', // auto|badge|js|panel
  notifyWatchBadgeSelectors: Object.freeze([
    'header [data-e2e="something-button"]:has-text("通知")',
  ]),
  notifyWatchBadgeHtmlFallback: false, // true=角标无数值/红点时用入口 HTML 变化当触发（可能误报，默认关）
  notifyWatchJsTakeLimit: 30,
  notifyWatchBaselineEnabled: true,
  notifyWatchBaselineRetryMs: 15000,
  notifyWatchPanelMinGapMs: 15000, // 两次主动开面板的最小间隔，避免抖动静止
  // notify tab 的 SPA 面板会缓存旧数据；定期重载一次才能看到新通知（不碰 main）
  // 2026-11-17：重载是重导航（实测 7-9s，会占满全局串行链），默认从 15s 放宽到 60s；
  // 且 service.notifyRefreshForWatch 对「已在主站类页面」只做 URL 检查、不导航。
  notifyWatchReloadMs: 60000,
  // 2026-11-17：重启补投——进程重启后的**第一次**成功读取，把 catchUp 窗口内"从未投递过"的通知补一次
  // （配合 est 判重，不会把已投过的再投一遍）。0 = 关闭补投。
  notifyCatchUpMaxAgeMs: 2 * 60 * 60 * 1000,
  // watcher 观测日志（只记计数/错误码，不记正文）；排障用
  notifyWatchLogFile: '/sdcard/DSHA/媒体/抖音/notify-watch.log',
  notifyWatchDeliver: true, // 事件同时投 dyHome：主人→home，其他人→统一“抖音”会话
  notifyWatchOtherContactId: 'douyin',
  notifyWatchOtherContactName: '抖音',
  commentDraftWaitMs: 800,
  commentSubmitWaitMs: 1500,
  remoteDisplay: ':20',
  remoteXAuthority: '/manager/extensions/desktop/Xauthority',
  // 写前拦截：短信验证/登录浮层（命中即 E_LOGIN_REQUIRED，不继续点）
  writeBlockedSelectors: Object.freeze([
    '[class*="verify_sms"]',
    '[id^="login-full-panel"]',
    '[class*="login-full-panel"]',
  ]),
  // 推荐流往下刷：scroll=true 时最多 3 次，每次滚 700px、等 800ms
  feedScrollDelta: 700,
  feedScrollWaitMs: 800,
  feedScrollMaxSteps: 3,
  // 搜索页等可见卡片：初始检查 + 最多 3 次重试，每次 1s
  searchCardWaitMs: 1500,
  searchCardRetries: 12,
  // 搜索整体失败后最多重试 1 次（仅对选择器/超时/远程 IO 类错误）
  searchRetries: 1,
  // 可选：进 feed/search 前让远程桥拦截 image/font/media（默认关；开启后截图封面会空）
  blockAssets: false,
  // 只有“真的看了 ≥10 秒”的视频才计数（open 记 activeWatch，下一次浏览工具调用结算）
  minWatchMs: 10000,

  // 截图：远程路径校验 + 本地落盘
  screenshotDir: '/sdcard/DSHA/媒体/抖音',
  maxScreenshotBytes: 2 * 1024 * 1024,
  // 下载：目标目录固定，文件名只由 videoId 生成；工具不接受任意路径
  downloadDir: '/sdcard/DSHA/媒体/抖音/下载',
  // 图集：`/note/<id>` 页面里作品图的选择器（2026-11-17 实测 img[src*=aweme-images] 命中 4 张）
  gallerySelector: 'img[src*="aweme-images"]',
  // 单条图集最多下几张（抖音图集上限一般 35 张）
  maxGalleryImages: 30,

  // 本地审计（只记 时间/命令/条数/ok/error，不记页面正文/cookie）
  auditFile: '/root/.dsh/douyin/douyin_audit.jsonl',
  maxAuditBytes: 5 * 1024 * 1024,

  // owner/home 门禁（与 dsh-autonomy 的 isOwnerContext 同口径）
  homeCwd: '/sdcard/DSHA/生活/数据/home',
  ownerPrivateDirs: Object.freeze([]),

  // 2026-11-17（主人要求）：抖音渠道会话（/sdcard/DSHA/渠道/douyin）也要能用抖音工具。
  // 为了不把"点赞/评论/删除"这类主动写权限扩散到可能由陌生人触发的会话，只放开一个白名单子集：
  // 读 + 私信读/回 + 通知读/回 + 截图/下载/观看记忆。
  channelCwds: Object.freeze(['/sdcard/DSHA/渠道/douyin']),
  channelToolAllowlist: Object.freeze([
    'dy_douyin_status',
    'dy_douyin_feed',
    'dy_douyin_search',
    'dy_douyin_open',
    'dy_douyin_comments',
    'dy_douyin_screenshot',
    'dy_douyin_download',
    'dy_douyin_watch',
    'dy_douyin_dm_list',
    'dy_douyin_dm_read',
    'dy_douyin_dm_send',
    'dy_douyin_dm_watch',
    'dy_douyin_notify_list',
    'dy_douyin_notify_reply',
    'dy_douyin_sms_code',
  ]),

  // 风控（短信验证）→ 通知主人：默认走 QQ（dyChannel），失败再走邮件（dyMail）。
  riskNotifyEnabled: true,
  ownerQqId: '',
  riskNotifyMinGapMs: 600000,
  riskNotifyEmail: '',
  riskNotifyChannel: 'qq',

  // 供后续生活插件调用；默认不 provide，避免与未来同名服务冲突
  exposeService: false,
})

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const REMOTE_PATH_RE = /^\/[A-Za-z0-9._/-]+$/
const SELECTOR_RE = /^[^\n\r\u0000-\u001f]{1,200}$/

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

function asString(value, fallback, { max = 240, re = null } = {}) {
  if (typeof value !== 'string') return fallback
  const s = value.trim()
  if (!s || s.length > max) return fallback
  if (re && !re.test(s)) return fallback
  return s
}

/** 远程绝对路径：禁止 .. 段（避免 node 执行到非预期脚本） */
function asRemotePath(value, fallback) {
  const s = asString(value, fallback, { max: 300, re: REMOTE_PATH_RE })
  if (s.split('/').includes('..')) return fallback
  return s
}

function asInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) return fallback
  return n
}

/** 小数旋钮（退避倍数）：只在 min..max 内接受，非法回落默认 */
function asNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) return fallback
  return n
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** "HH:MM-HH:MM" → [start, end] 分钟；24:00 合法；起止相同视为非法 */
export function parseMinuteRange(text) {
  if (typeof text !== 'string') return null
  const m = text.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const a = Number(m[1]) * 60 + Number(m[2])
  const b = Number(m[3]) * 60 + Number(m[4])
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null
  if (a < 0 || a > 1440 || b < 0 || b > 1440) return null
  if (a === b) return null
  return [a, b]
}

function normalizeRangeList(input, fallback, warnings, label) {
  if (input === undefined || input === null) return fallback.map(parseMinuteRange).filter(Boolean)
  const arr = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : null
  if (!arr) {
    warnings.push(`timeWindows.${label} 不是数组/字符串，使用默认值`)
    return fallback.map(parseMinuteRange).filter(Boolean)
  }
  if (arr.length === 0) return [] // 显式空数组 = 该组不限（silence 可用于关闭静默）
  const out = arr.map(parseMinuteRange).filter(Boolean)
  if (!out.length) {
    warnings.push(`timeWindows.${label} 没有合法区间（HH:MM-HH:MM），使用默认值`)
    return fallback.map(parseMinuteRange).filter(Boolean)
  }
  return out
}

/**
 * timeWindows 支持三种写法：
 * 1) 对象 {weekday:[...], weekend:[...], silence:[...]}
 * 2) 字符串/数组：工作日与周末共用同一组，静默用默认
 * 3) 缺省：默认时段
 */
export function normalizeTimeWindows(raw, warnings = []) {
  const fallback = DEFAULT_TIME_WINDOWS
  if (raw === undefined || raw === null) {
    return {
      weekday: normalizeRangeList(undefined, fallback.weekday, warnings, 'weekday'),
      weekend: normalizeRangeList(undefined, fallback.weekend, warnings, 'weekend'),
      silence: normalizeRangeList(undefined, fallback.silence, warnings, 'silence'),
    }
  }
  if (typeof raw === 'string' || Array.isArray(raw)) {
    const shared = normalizeRangeList(raw, fallback.weekday, warnings, 'shared')
    return {
      weekday: shared,
      weekend: shared,
      silence: normalizeRangeList(undefined, fallback.silence, warnings, 'silence'),
    }
  }
  if (!isPlainObject(raw)) {
    warnings.push('timeWindows 类型不正确，使用默认值')
  }
  const obj = isPlainObject(raw) ? raw : {}
  return {
    weekday: normalizeRangeList(obj.weekday, fallback.weekday, warnings, 'weekday'),
    weekend: normalizeRangeList(obj.weekend, fallback.weekend, warnings, 'weekend'),
    silence: normalizeRangeList(obj.silence, fallback.silence, warnings, 'silence'),
  }
}

function normalizeSelectors(raw, warnings, { fallback = DEFAULTS.commentSelectors, label = 'commentSelectors', allowEmpty = false } = {}) {
  if (raw === undefined || raw === null) return [...fallback]
  const arr = Array.isArray(raw) ? raw : []
  const out = arr
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => SELECTOR_RE.test(x))
    .slice(0, 6)
  if (!out.length) {
    if (allowEmpty) return []
    warnings.push(`${label} 为空/非法，使用默认（未验证）选择器`)
    return [...fallback]
  }
  return out
}

function normalizeHomeUrl(value, warnings) {
  if (value === undefined || value === null) return DEFAULTS.homeUrl
  const s = asString(value, '', { max: 300 })
  try {
    const u = new URL(s)
    if (u.protocol === 'https:' && ['www.douyin.com', 'douyin.com', 'm.douyin.com'].includes(u.hostname)) {
      return u.href
    }
  } catch {
    // fallthrough
  }
  warnings.push('homeUrl 不是 douyin.com 的 https 地址，使用默认值')
  return DEFAULTS.homeUrl
}

/** 允许列表：工具名 / 简单标识数组（去空格、去重、限长） */
function normalizeNameList(raw, warnings, { max = 60, maxLen = 80 } = {}) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    warnings.push('channelToolAllowlist 不是数组，忽略')
    return []
  }
  const out = []
  for (const item of raw) {
    const s = typeof item === 'string' ? item.trim() : ''
    if (!s || s.length > maxLen) continue
    if (!out.includes(s)) out.push(s)
    if (out.length >= max) break
  }
  return out
}

function normalizeDirs(raw, warnings) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    warnings.push('ownerPrivateDirs 不是数组，忽略')
    return []
  }
  return raw
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x.startsWith('/') && x.length <= 300)
    .map((x) => x.replace(/\/+$/, ''))
    .filter(Boolean)
    .slice(0, 20)
}

/** 名字别名列表：去 @、压空白、去重；空/非法回落默认（不抛） */
function normalizeNames(raw, fallback, warnings, label, { max = 10, maxChars = 60, allowEmpty = false } = {}) {
  if (raw === undefined || raw === null) return [...fallback]
  if (!Array.isArray(raw)) {
    warnings.push(`${label} 不是数组，使用默认值`)
    return [...fallback]
  }
  const out = []
  const seen = new Set()
  for (const x of raw) {
    if (typeof x !== 'string') continue
    const s = x.trim().replace(/^@+/, '').replace(/\s+/g, ' ')
    if (!s || Array.from(s).length > maxChars) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= max) break
  }
  if (!out.length) {
    if (allowEmpty) return []
    warnings.push(`${label} 为空/非法，使用默认值`)
    return [...fallback]
  }
  return out
}

/**
 * 归一化配置。永不 throw；非法项回落默认值并写入 warnings。
 * @param {unknown} raw
 * @returns {ReturnType<typeof DEFAULTS> & {warnings: string[]}}
 */
export function normalizeConfig(raw) {
  const warnings = []
  // 唯一配置读入口：先把 Config schema 的 .volatile() 引用还原成普通值
  raw = unwrapVolatile(raw)
  const r = isPlainObject(raw) ? raw : {}

  const transportRaw = typeof r.transport === 'string' ? r.transport.trim() : ''
  let transport = DEFAULTS.transport
  if (transportRaw === 'ssh-exec' || transportRaw === 'streamlocal' || transportRaw === 'local-socket') transport = transportRaw
  else if (transportRaw) warnings.push(`transport=${transportRaw} 不支持，回落到 ssh-exec`)

  const homeUrl = normalizeHomeUrl(r.homeUrl, warnings)
  const timeWindows = normalizeTimeWindows(r.timeWindows, warnings)

  const cfg = {
    ...DEFAULTS,
    enabled: asBool(r.enabled, DEFAULTS.enabled),
    transport,
    localSocket: asRemotePath(r.localSocket, DEFAULTS.localSocket),

    sshHost: asString(r.sshHost, DEFAULTS.sshHost, { max: 200, re: HOST_RE }),
    sshPort: asInt(r.sshPort, DEFAULTS.sshPort, 1, 65535),
    sshUser: asString(r.sshUser, DEFAULTS.sshUser, { max: 64, re: USER_RE }),
    sshKeyPath: asString(r.sshKeyPath, DEFAULTS.sshKeyPath, { max: 300 }),
    knownHosts: asString(r.knownHosts, DEFAULTS.knownHosts, { max: 300 }),

    remoteNodeDir: asRemotePath(r.remoteNodeDir, DEFAULTS.remoteNodeDir),
    remoteClient: asRemotePath(r.remoteClient, DEFAULTS.remoteClient),
    shotsDir: asRemotePath(r.shotsDir, DEFAULTS.shotsDir),

    openTimeoutMs: asInt(r.openTimeoutMs, DEFAULTS.openTimeoutMs, 1000, 300000),
    callTimeoutMs: asInt(r.callTimeoutMs, DEFAULTS.callTimeoutMs, 1000, 120000),

    // ===== 写路径 / 桥协议 v2 旋钮（protocol-v2.md §B；非法值回落默认，不 throw）=====
    clickTimeoutMs: asInt(r.clickTimeoutMs, DEFAULTS.clickTimeoutMs, 200, 15000),
    clickScrollTimeoutMs: asInt(r.clickScrollTimeoutMs, DEFAULTS.clickScrollTimeoutMs, 0, 3000),
    openReuse: asBool(r.openReuse, DEFAULTS.openReuse),
    probeEnabled: asBool(r.probeEnabled, DEFAULTS.probeEnabled),
    waitForTimeoutMs: asInt(r.waitForTimeoutMs, DEFAULTS.waitForTimeoutMs, 300, 8000),
    writeVerifyPollMs: asInt(r.writeVerifyPollMs, DEFAULTS.writeVerifyPollMs, 50, 1000),
    writeVerifyTimeoutMs: asInt(r.writeVerifyTimeoutMs, DEFAULTS.writeVerifyTimeoutMs, 200, 5000),
    toggleReadRetries: asInt(r.toggleReadRetries, DEFAULTS.toggleReadRetries, 1, 10),
    toggleReadWaitMs: asInt(r.toggleReadWaitMs, DEFAULTS.toggleReadWaitMs, 50, 2000),
    netVerifyEnabled: asBool(r.netVerifyEnabled, DEFAULTS.netVerifyEnabled),
    netVerifyTimeoutMs: asInt(r.netVerifyTimeoutMs, DEFAULTS.netVerifyTimeoutMs, 300, 4000),
    notifyPanelPollMs: asInt(r.notifyPanelPollMs, DEFAULTS.notifyPanelPollMs, 5000, 600000),
    watchBackoffMinMs: asInt(r.watchBackoffMinMs, DEFAULTS.watchBackoffMinMs, 1000, 60000),
    watchBackoffMaxMs: asInt(r.watchBackoffMaxMs, DEFAULTS.watchBackoffMaxMs, 5000, 600000),
    watchBackoffFactor: asNumber(r.watchBackoffFactor, DEFAULTS.watchBackoffFactor, 1.2, 5),
    watchBreakerFails: asInt(r.watchBreakerFails, DEFAULTS.watchBreakerFails, 2, 100),
    watchBreakerCooldownMs: asInt(r.watchBreakerCooldownMs, DEFAULTS.watchBreakerCooldownMs, 30000, 3600000),

    dailyQuota: asInt(r.dailyQuota, DEFAULTS.dailyQuota, 0, 100),
    perSession: asInt(r.perSession, DEFAULTS.perSession, 0, 20),
    sessionGapMs: asInt(r.sessionGapMs, DEFAULTS.sessionGapMs, 0, 24 * 60 * 60 * 1000),
    minIntervalMs: asInt(r.minIntervalMs, DEFAULTS.minIntervalMs, 0, 600000),
    maxQueue: asInt(r.maxQueue, DEFAULTS.maxQueue, 1, 32),

    tzOffsetMinutes: asInt(r.tzOffsetMinutes, DEFAULTS.tzOffsetMinutes, -720, 840),
    timeWindows,

    homeUrl,
    loginSelector: asString(r.loginSelector, DEFAULTS.loginSelector, { max: 200, re: SELECTOR_RE }),
    feedSelector: asString(r.feedSelector, DEFAULTS.feedSelector, { max: 200, re: SELECTOR_RE }),
    searchSelector: asString(r.searchSelector, DEFAULTS.searchSelector, { max: 200, re: SELECTOR_RE }),
    commentSelectors: normalizeSelectors(r.commentSelectors, warnings),
    commentOpenSelectors: normalizeSelectors(r.commentOpenSelectors, warnings, {
      fallback: DEFAULTS.commentOpenSelectors,
      label: 'commentOpenSelectors',
      allowEmpty: true,
    }),
    textLen: asInt(r.textLen, DEFAULTS.textLen, 20, 500),
    commentTextLen: asInt(r.commentTextLen, DEFAULTS.commentTextLen, 20, 1000),
    feedScrollDelta: asInt(r.feedScrollDelta, DEFAULTS.feedScrollDelta, 1, 10000),
    feedScrollWaitMs: asInt(r.feedScrollWaitMs, DEFAULTS.feedScrollWaitMs, 0, 10000),
    feedScrollMaxSteps: asInt(r.feedScrollMaxSteps, DEFAULTS.feedScrollMaxSteps, 1, 10),
    searchCardWaitMs: asInt(r.searchCardWaitMs, DEFAULTS.searchCardWaitMs, 0, 10000),
    searchCardRetries: asInt(r.searchCardRetries, DEFAULTS.searchCardRetries, 1, 10),
    commentWaitMs: asInt(r.commentWaitMs, DEFAULTS.commentWaitMs, 0, 10000),
    commentRetries: asInt(r.commentRetries, DEFAULTS.commentRetries, 0, 30),
    commentScrollSteps: asInt(r.commentScrollSteps, DEFAULTS.commentScrollSteps, 0, 10),
    commentScrollDelta: asInt(r.commentScrollDelta, DEFAULTS.commentScrollDelta, 100, 2000),
    commentScrollWaitMs: asInt(r.commentScrollWaitMs, DEFAULTS.commentScrollWaitMs, 0, 10000),
    commentReplyExpandMax: asInt(r.commentReplyExpandMax, DEFAULTS.commentReplyExpandMax, 0, 20),
    commentReplyWaitMs: asInt(r.commentReplyWaitMs, DEFAULTS.commentReplyWaitMs, 0, 5000),
    writeReadbackWaitMs: asInt(r.writeReadbackWaitMs, DEFAULTS.writeReadbackWaitMs, 0, 5000),
    commentInputSelectors: normalizeSelectors(r.commentInputSelectors, warnings, {
      fallback: DEFAULTS.commentInputSelectors,
      label: 'commentInputSelectors',
    }),
    commentInputOpenSelectors: normalizeSelectors(r.commentInputOpenSelectors, warnings, {
      fallback: DEFAULTS.commentInputOpenSelectors,
      label: 'commentInputOpenSelectors',
    }),
    commentSubmitSelectors: normalizeSelectors(r.commentSubmitSelectors, warnings, {
      fallback: DEFAULTS.commentSubmitSelectors,
      label: 'commentSubmitSelectors',
      allowEmpty: true,
    }),
    commentDeleteSelectors: normalizeSelectors(r.commentDeleteSelectors, warnings, {
      fallback: DEFAULTS.commentDeleteSelectors,
      label: 'commentDeleteSelectors',
    }),
    commentMoreSelectors: normalizeSelectors(r.commentMoreSelectors, warnings, {
      fallback: DEFAULTS.commentMoreSelectors,
      label: 'commentMoreSelectors',
    }),
    commentReplyWindowMs: asInt(r.commentReplyWindowMs, DEFAULTS.commentReplyWindowMs, 0, 24 * 60 * 60 * 1000),
    commentReplyInputSelector: asString(r.commentReplyInputSelector, DEFAULTS.commentReplyInputSelector, { max: 200 }),
    commentReplySendSelector: asString(r.commentReplySendSelector, DEFAULTS.commentReplySendSelector, { max: 300 }),
    commentMentionSelectors: normalizeSelectors(r.commentMentionSelectors, warnings, {
      fallback: DEFAULTS.commentMentionSelectors,
      label: 'commentMentionSelectors',
    }),
    commentMentionChipSelector: asString(r.commentMentionChipSelector, DEFAULTS.commentMentionChipSelector, { max: 200 }),
    commentMentionWaitMs: asInt(r.commentMentionWaitMs, DEFAULTS.commentMentionWaitMs, 0, 10000),
    dmUrl: asString(r.dmUrl, DEFAULTS.dmUrl, { max: 300 }),
    dmEntrySelector: asString(r.dmEntrySelector, DEFAULTS.dmEntrySelector, { max: 200 }),
    dmWaitMs: asInt(r.dmWaitMs, DEFAULTS.dmWaitMs, 0, 30000),
    dmConversationWaitMs: asInt(r.dmConversationWaitMs, DEFAULTS.dmConversationWaitMs, 0, 15000),
    dmSendWaitMs: asInt(r.dmSendWaitMs, DEFAULTS.dmSendWaitMs, 0, 15000),
    dmConversationSelectors: normalizeSelectors(r.dmConversationSelectors, warnings, {
      fallback: DEFAULTS.dmConversationSelectors,
      label: 'dmConversationSelectors',
    }),
    dmMessageSelectors: normalizeSelectors(r.dmMessageSelectors, warnings, {
      fallback: DEFAULTS.dmMessageSelectors,
      label: 'dmMessageSelectors',
    }),
    dmPreviewSelector: asString(r.dmPreviewSelector, DEFAULTS.dmPreviewSelector, { max: 200 }),
    dmTimeSelector: asString(r.dmTimeSelector, DEFAULTS.dmTimeSelector, { max: 200 }),
    dmInputSelector: asString(r.dmInputSelector, DEFAULTS.dmInputSelector, { max: 200 }),
    dmSendSelector: asString(r.dmSendSelector, DEFAULTS.dmSendSelector, { max: 200 }),
    dmSendEnabledClass: asString(r.dmSendEnabledClass, DEFAULTS.dmSendEnabledClass, { max: 100 }),
    dmAllowlistFile: asString(r.dmAllowlistFile, DEFAULTS.dmAllowlistFile, { max: 300 }),
    dmOwnerFile: asString(r.dmOwnerFile, DEFAULTS.dmOwnerFile, { max: 300 }),
    dmReplyWindowMs: asInt(r.dmReplyWindowMs, DEFAULTS.dmReplyWindowMs, 0, 24 * 60 * 60 * 1000),
    dmTimeLayoutSelector: asString(r.dmTimeLayoutSelector, DEFAULTS.dmTimeLayoutSelector, { max: 200 }),
    dmDailyLimit: asInt(r.dmDailyLimit, DEFAULTS.dmDailyLimit, 0, 20),
    dmKeepPanelOpen: asBool(r.dmKeepPanelOpen, DEFAULTS.dmKeepPanelOpen),
    dmOwnerAliases: normalizeNames(r.dmOwnerAliases, DEFAULTS.dmOwnerAliases, warnings, 'dmOwnerAliases', { allowEmpty: true }),
    dmOwnerDisplayName: asString(r.dmOwnerDisplayName, DEFAULTS.dmOwnerDisplayName, { max: 60 }),
    dmWatchEnabled: asBool(r.dmWatchEnabled, DEFAULTS.dmWatchEnabled),
    dmWatchIntervalMs: asInt(r.dmWatchIntervalMs, DEFAULTS.dmWatchIntervalMs, 2000, 300000),
    dmWatchStartupDelayMs: asInt(r.dmWatchStartupDelayMs, DEFAULTS.dmWatchStartupDelayMs, 0, 60000),
    dmWatchLimit: asInt(r.dmWatchLimit, DEFAULTS.dmWatchLimit, 1, 50),
    dmWatchMaxSeen: asInt(r.dmWatchMaxSeen, DEFAULTS.dmWatchMaxSeen, 50, 5000),
    dmWatchConfirmTicks: asInt(r.dmWatchConfirmTicks, DEFAULTS.dmWatchConfirmTicks, 1, 5),
    dmWatchStateFile: asString(r.dmWatchStateFile, DEFAULTS.dmWatchStateFile, { max: 300 }),
    dmWatchKeepOpen: asBool(r.dmWatchKeepOpen, DEFAULTS.dmWatchKeepOpen),
    notifyEntrySelectors: normalizeSelectors(r.notifyEntrySelectors, warnings, {
      fallback: DEFAULTS.notifyEntrySelectors,
      label: 'notifyEntrySelectors',
    }),
    notifyPanelSelectors: normalizeSelectors(r.notifyPanelSelectors, warnings, {
      fallback: DEFAULTS.notifyPanelSelectors,
      label: 'notifyPanelSelectors',
    }),
    notifyItemSelectors: normalizeSelectors(r.notifyItemSelectors, warnings, {
      fallback: DEFAULTS.notifyItemSelectors,
      label: 'notifyItemSelectors',
    }),
    notifyLoadMoreSelectors: normalizeSelectors(r.notifyLoadMoreSelectors, warnings, {
      fallback: DEFAULTS.notifyLoadMoreSelectors,
      label: 'notifyLoadMoreSelectors',
    }),
    notifyFilterSelector: asString(r.notifyFilterSelector, DEFAULTS.notifyFilterSelector, { max: 200 }),
    notifyCloseSelector: asString(r.notifyCloseSelector, DEFAULTS.notifyCloseSelector, { max: 200 }),
    notifyWaitMs: asInt(r.notifyWaitMs, DEFAULTS.notifyWaitMs, 0, 10000),
    notifyRetries: asInt(r.notifyRetries, DEFAULTS.notifyRetries, 1, 60),
    notifyLoadMoreWaitMs: asInt(r.notifyLoadMoreWaitMs, DEFAULTS.notifyLoadMoreWaitMs, 0, 10000),
    notifyLoadMoreMax: asInt(r.notifyLoadMoreMax, DEFAULTS.notifyLoadMoreMax, 0, 10),
    notifyTextLen: asInt(r.notifyTextLen, DEFAULTS.notifyTextLen, 20, 1000),
    notifyCommentAuthor: asString(r.notifyCommentAuthor, DEFAULTS.notifyCommentAuthor, { max: 100 }),
    notifyWatchEnabled: asBool(r.notifyWatchEnabled, DEFAULTS.notifyWatchEnabled),
    notifyWatchIntervalMs: asInt(r.notifyWatchIntervalMs, DEFAULTS.notifyWatchIntervalMs, 2000, 30000),
    notifyWatchStartupDelayMs: asInt(r.notifyWatchStartupDelayMs, DEFAULTS.notifyWatchStartupDelayMs, 0, 60000),
    notifyWatchLimit: asInt(r.notifyWatchLimit, DEFAULTS.notifyWatchLimit, 1, 50),
    notifyWatchMaxSeen: asInt(r.notifyWatchMaxSeen, DEFAULTS.notifyWatchMaxSeen, 50, 5000),
    notifyWatchMaxAgeMs: asInt(r.notifyWatchMaxAgeMs, DEFAULTS.notifyWatchMaxAgeMs, 60_000, 24 * 60 * 60 * 1000),
    notifyWatchStateFile: asString(r.notifyWatchStateFile, DEFAULTS.notifyWatchStateFile, { max: 300 }),
    notifyWatchSource: ['auto', 'badge', 'js', 'panel'].includes(String(r.notifyWatchSource ?? '').trim()) ? String(r.notifyWatchSource).trim() : DEFAULTS.notifyWatchSource,
    notifyWatchBadgeSelectors: normalizeSelectors(r.notifyWatchBadgeSelectors, warnings, {
      fallback: DEFAULTS.notifyWatchBadgeSelectors,
      label: 'notifyWatchBadgeSelectors',
      allowEmpty: true,
    }),
    notifyWatchBadgeHtmlFallback: asBool(r.notifyWatchBadgeHtmlFallback, DEFAULTS.notifyWatchBadgeHtmlFallback),
    notifyWatchJsTakeLimit: asInt(r.notifyWatchJsTakeLimit, DEFAULTS.notifyWatchJsTakeLimit, 1, 100),
    notifyWatchBaselineEnabled: asBool(r.notifyWatchBaselineEnabled, DEFAULTS.notifyWatchBaselineEnabled),
    notifyWatchBaselineRetryMs: asInt(r.notifyWatchBaselineRetryMs, DEFAULTS.notifyWatchBaselineRetryMs, 5000, 600000),
    notifyWatchPanelMinGapMs: asInt(r.notifyWatchPanelMinGapMs, DEFAULTS.notifyWatchPanelMinGapMs, 3000, 300000),
    notifyWatchReloadMs: asInt(r.notifyWatchReloadMs, DEFAULTS.notifyWatchReloadMs, 5000, 600000),
    notifyCatchUpMaxAgeMs: asInt(r.notifyCatchUpMaxAgeMs, DEFAULTS.notifyCatchUpMaxAgeMs, 0, 24 * 60 * 60 * 1000),
    notifyWatchLogFile: asString(r.notifyWatchLogFile, DEFAULTS.notifyWatchLogFile, { max: 300 }),
    notifyWatchDeliver: asBool(r.notifyWatchDeliver, DEFAULTS.notifyWatchDeliver),
    notifyWatchOtherContactId: asString(r.notifyWatchOtherContactId, DEFAULTS.notifyWatchOtherContactId, { max: 80 }),
    notifyWatchOtherContactName: asString(r.notifyWatchOtherContactName, DEFAULTS.notifyWatchOtherContactName, { max: 80 }),
    commentDraftWaitMs: asInt(r.commentDraftWaitMs, DEFAULTS.commentDraftWaitMs, 0, 5000),
    commentSubmitWaitMs: asInt(r.commentSubmitWaitMs, DEFAULTS.commentSubmitWaitMs, 0, 10000),
    remoteDisplay: asString(r.remoteDisplay, DEFAULTS.remoteDisplay, { max: 20, re: /^:\d{1,3}$/ }),
    remoteXAuthority: asRemotePath(r.remoteXAuthority, DEFAULTS.remoteXAuthority),
    writeBlockedSelectors: normalizeSelectors(r.writeBlockedSelectors, warnings, {
      fallback: DEFAULTS.writeBlockedSelectors,
      label: 'writeBlockedSelectors',
    }),
    searchRetries: asInt(r.searchRetries, DEFAULTS.searchRetries, 0, 1),
    blockAssets: asBool(r.blockAssets, DEFAULTS.blockAssets),
    minWatchMs: asInt(r.minWatchMs, DEFAULTS.minWatchMs, 0, 600000),

    screenshotDir: asString(r.screenshotDir, DEFAULTS.screenshotDir, { max: 300 }),
    maxScreenshotBytes: asInt(r.maxScreenshotBytes, DEFAULTS.maxScreenshotBytes, 64 * 1024, 16 * 1024 * 1024),
    downloadDir: asString(r.downloadDir, DEFAULTS.downloadDir, { max: 300 }),
    gallerySelector: asString(r.gallerySelector, DEFAULTS.gallerySelector, { max: 200 }),
    maxGalleryImages: asInt(r.maxGalleryImages, DEFAULTS.maxGalleryImages, 1, 50),

    auditFile: asString(r.auditFile, DEFAULTS.auditFile, { max: 300 }),
    maxAuditBytes: asInt(r.maxAuditBytes, DEFAULTS.maxAuditBytes, 1024 * 1024, 50 * 1024 * 1024),

    homeCwd: asString(r.homeCwd, DEFAULTS.homeCwd, { max: 300 }),
    ownerPrivateDirs: normalizeDirs(r.ownerPrivateDirs, warnings),
    // 2026-11-17：抖音渠道会话（默认 /sdcard/DSHA/渠道/douyin）也允许用抖音工具，但只给白名单子集
    channelCwds:
      r.channelCwds === undefined || r.channelCwds === null
        ? [...DEFAULTS.channelCwds]
        : normalizeDirs(r.channelCwds, warnings),
    channelToolAllowlist:
      r.channelToolAllowlist === undefined || r.channelToolAllowlist === null
        ? [...DEFAULTS.channelToolAllowlist]
        : normalizeNameList(r.channelToolAllowlist, warnings),

    // 风控 → 通知主人（QQ 优先，邮件兜底）
    riskNotifyEnabled: asBool(r.riskNotifyEnabled, DEFAULTS.riskNotifyEnabled),
    ownerQqId: asString(r.ownerQqId, DEFAULTS.ownerQqId, { max: 24, re: /^[0-9]{5,20}$/ }),
    riskNotifyMinGapMs: asInt(r.riskNotifyMinGapMs, DEFAULTS.riskNotifyMinGapMs, 60000, 3600000),
    riskNotifyEmail: asString(r.riskNotifyEmail, DEFAULTS.riskNotifyEmail, { max: 200 }),
    riskNotifyChannel: ['qq', 'email', 'both'].includes(String(r.riskNotifyChannel))
      ? String(r.riskNotifyChannel)
      : DEFAULTS.riskNotifyChannel,
    exposeService: asBool(r.exposeService, DEFAULTS.exposeService),

    warnings,
  }

  // 截图目录必须是绝对路径（不强制存在；首次落盘时才 mkdir）
  if (!cfg.screenshotDir.startsWith('/')) {
    warnings.push('screenshotDir 不是绝对路径，使用默认值')
    cfg.screenshotDir = DEFAULTS.screenshotDir
  }
  if (!cfg.downloadDir.startsWith('/')) {
    warnings.push('downloadDir 不是绝对路径，使用默认值')
    cfg.downloadDir = DEFAULTS.downloadDir
  }
  if (r.notifyWatchIntervalMs !== undefined && r.notifyWatchIntervalMs !== null) {
    const n = Number(r.notifyWatchIntervalMs)
    if (!Number.isInteger(n) || n < 2000 || n > 30000) {
      warnings.push(`notifyWatchIntervalMs=${String(r.notifyWatchIntervalMs)} 超出 2000–30000，已回落 ${DEFAULTS.notifyWatchIntervalMs}`)
    }
  }
  if (r.notifyWatchSource !== undefined && r.notifyWatchSource !== null && !['auto', 'badge', 'js', 'panel'].includes(String(r.notifyWatchSource).trim())) {
    warnings.push(`notifyWatchSource=${String(r.notifyWatchSource)} 不支持，回落 ${DEFAULTS.notifyWatchSource}`)
  }
  if (!cfg.sshKeyPath.startsWith('/')) cfg.sshKeyPath = DEFAULTS.sshKeyPath
  if (!cfg.knownHosts.startsWith('/')) cfg.knownHosts = DEFAULTS.knownHosts
  if (!cfg.auditFile.startsWith('/')) cfg.auditFile = DEFAULTS.auditFile
  if (!cfg.homeCwd.startsWith('/')) cfg.homeCwd = DEFAULTS.homeCwd

  // 协议 v2 数值旋钮越界时记一条 warning（行为已回落默认，便于排障时看出配置没生效）
  const RANGE_WARN = {
    clickTimeoutMs: [200, 15000],
    clickScrollTimeoutMs: [0, 3000],
    waitForTimeoutMs: [300, 8000],
    writeVerifyPollMs: [50, 1000],
    writeVerifyTimeoutMs: [200, 5000],
    toggleReadRetries: [1, 10],
    toggleReadWaitMs: [50, 2000],
    netVerifyTimeoutMs: [300, 4000],
    notifyPanelPollMs: [5000, 600000],
    watchBackoffMinMs: [1000, 60000],
    watchBackoffMaxMs: [5000, 600000],
    watchBackoffFactor: [1.2, 5],
    watchBreakerFails: [2, 100],
    watchBreakerCooldownMs: [30000, 3600000],
  }
  for (const [key, [min, max]] of Object.entries(RANGE_WARN)) {
    const rawValue = r[key]
    if (rawValue === undefined || rawValue === null) continue
    const n = Number(rawValue)
    if (!Number.isFinite(n) || n < min || n > max) {
      warnings.push(`${key}=${String(rawValue)} 超出 ${min}–${max}，已回落 ${DEFAULTS[key]}`)
    }
  }

  return cfg
}
