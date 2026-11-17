/**
 * dsh-douyin · 抖音插件（v1：读 + 显式写第一层）
 *
 * 能力：status / feed / search / open / comments / screenshot / download / watch / like / favorite / comment /
 *       评论回复/删除、私信读/精确回复、私信实时 watcher（只读事件）、通知面板（只读）/精确回复。
 * 传输：SSH exec 远程 CDP 桥（/persistent/cdp/client-stdin.js）；v1 不做 streamlocal。
 * 边界：
 *  - 不注册 profile、不写 profile、不重启、不自动发消息、不自动写记忆（watch 显式写）；
 *  - click 仅用于搜索卡片开合/评论展开/显式写操作；真实写必须 confirm:true；不做 eval/登录/发布；
 *  - 私信 watcher 只读会话列表，不点开会话、不标已读、不发送、不路由（事件交 autonomy 取用）；
 *  - import / apply 阶段零副作用：不连 SSH、不起子进程、不读远程、不注册定时器；
 *    唯一例外是 `notifyWatchEnabled=true` / `dmWatchEnabled=true` 时在 apply 末尾挂 unref 的只读 watcher（默认关）；
 *    所有连接仍懒加载到第一次读取，失败返回错误码而不是抛给宿主。
 */
import { DEFAULTS, normalizeConfig } from './config.js'
import { createTransport } from './transport.js'
import { BridgeClient } from './bridge.js'
import { AuditLog, RateLimiter, SerialQueue } from './limits.js'
import { createDouyinService } from './service.js'
import { createNotifyWatcher } from './notify-watch.js'
import { createDmWatcher } from './dm-watch.js'
import { registerTools } from './tools.js'
import { toFailure } from './errors.js'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-douyin'
export const inject = ['tools']

/**
 * 设置页只认识 Config schema 里标了 `.volatile()` 的字段（dsh-settings 的
 * `volatileForm`/`isVolatilePath`），所以这里只声明设置卡片暴露的 2 个字段：
 *   - enabled：总开关
 *   - dailyQuota：每日配额（1..100）
 * 未声明的键（transport/sshHost/sshPort/... 以及所有默认值）走 schemastery 的
 * 非 strict 合并原样保留，normalizeConfig 继续按 DEFAULTS 清洗，运行时行为不变。
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
  dailyQuota: z.number().min(0).max(100).default(DEFAULTS.dailyQuota).volatile(),
})

const SERVICE_METHODS = [
  'status',
  'feed',
  'search',
  'open',
  'comments',
  'screenshot',
  'download',
  'like',
  'favorite',
  'comment',
  'commentReply',
  'commentDelete',
  'smsCode',
  'dmList',
  'dmRead',
  'dmSend',
  'notifyList',
  'notifyReply',
  // 2026-11-16：notify tab 定期重载（SPA 面板有缓存，不重载会漏通知）。
  // 之前漏在白名单里 → notify-watch 里 `typeof service.notifyRefreshForWatch === 'function'` 永远 false，
  // 这段逻辑是死代码（audit 缺陷 3）。它属于控制命令 → 走 userQueue。
  'notifyRefreshForWatch',
]

/**
 * watcher 原语：只由 notify-watch / dm-watch 的 tick 调用，走独立的 watchQueue（深度 1）。
 * 与用户工具调用（userQueue）分开，watcher 慢轮询不再把用户写操作排在后面（audit §3.3）。
 */
const WATCH_METHODS = [
  'notifySourceStart',
  'notifySourceTake',
  'notifySourceStop',
  'notifyBadgeProbe',
  'notifySnapshotForWatch',
  'dmPollConversations',
]

/** watchQueue 忙时的 skip 应答（保持 tick 的 busy 语义，不抛 E_BUSY） */
function watchBusyResult(e) {
  const retryAfterMs = Number(e?.retryAfterMs) || 0
  return {
    ok: true,
    skipped: true,
    reason: 'busy',
    code: 'E_BUSY',
    ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
  }
}

/**
 * 风控通知器：遇到抖音短信验证时把消息发给主人。
 * 通道优先级：dyChannel（QQ，mode=send 才发）→ 失败再 dyMail（邮件）。
 * 节流：同一进程内 riskNotifyMinGapMs（默认 10 分钟）只发一次，避免刷屏。
 * 只发"需要验证码"的通知，不发送任何验证码内容；不绕过验证。
 */
export function createOwnerNotifier({ ctx = null, cfg, log = null, clock = Date.now } = {}) {
  let lastAt = 0
  let lastResult = null
  return async function notifyOwner(payload = {}) {
    const body = String(payload?.text ?? '').trim().slice(0, 1500)
    if (!body) return { ok: false, code: 'E_EMPTY_BODY' }
    if (cfg?.riskNotifyEnabled === false) return { ok: false, code: 'E_DISABLED' }
    const now = Number(clock()) || Date.now()
    const gap = Math.max(60000, Number(cfg?.riskNotifyMinGapMs) || 600000)
    if (lastAt && now - lastAt < gap) return { ok: false, code: 'E_THROTTLED', lastAt, lastResult }
    const results = []
    const want = String(cfg?.riskNotifyChannel || 'qq')
    const tryQq = want === 'qq' || want === 'both'
    // QQ 失败/不可用时**总是**回退邮件（"发 QQ 或邮件"取并集，避免风控通知丢失）
    const tryMail = want === 'email' || want === 'both' || !results.some((r) => r.ok === true)
    if (tryQq) {
      try {
        const ch = ctx?.get?.('dyChannel')
        if (ch && typeof ch.canSend === 'function' && ch.canSend() && typeof ch.sendText === 'function') {
          const r = await ch.sendText({ kind: 'private', contactId: String(cfg?.ownerQqId ?? ''), text: body })
          results.push({ channel: 'qq', ok: r?.ok === true, code: r?.code ?? null })
        } else {
          results.push({ channel: 'qq', ok: false, code: 'MODE_NOT_SEND' })
        }
      } catch (e) {
        results.push({ channel: 'qq', ok: false, code: 'E_EXCEPTION', message: String(e?.message ?? e).slice(0, 120) })
      }
    }
    if (tryMail && !results.some((r) => r.ok === true)) {
      try {
        const mail = ctx?.get?.('dyMail')
        const owners = Array.isArray(mail?.ownerAddresses?.()) ? mail.ownerAddresses() : []
        const to = String(cfg?.riskNotifyEmail || owners[0] || '')
        if (mail && to) {
          const r = await mail.send({ to, subject: '抖音风控：需要短信验证码', body })
          results.push({ channel: 'email', ok: r?.ok === true, code: r?.code ?? null })
        } else {
          results.push({ channel: 'email', ok: false, code: 'E_NO_OWNER_ADDRESS' })
        }
      } catch (e) {
        results.push({ channel: 'email', ok: false, code: 'E_EXCEPTION', message: String(e?.message ?? e).slice(0, 120) })
      }
    }
    const ok = results.some((r) => r.ok === true)
    lastAt = now
    lastResult = { ok, results, at: now }
    try {
      log?.warn?.(`[douyin] 风控通知主人：ok=${ok} ${JSON.stringify(results).slice(0, 260)}`)
    } catch {}
    return lastResult
  }
}

/**
 * 组装运行时（不做任何 IO）。测试可注入 fake transport / clock。
 * @param {{
 *   ctx?: object,
 *   rawConfig?: object,
 *   transport?: object,
 *   clock?: () => number,
 *   logger?: object,
 *   sleep?: (ms:number) => Promise<void>,
 *   fetchImpl?: Function,
 * }} [options]
 */
export function createRuntime({
  ctx = null,
  rawConfig = {},
  transport = null,
  clock = Date.now,
  logger = null,
  sleep,
  fetchImpl,
} = {}) {
  const cfg = normalizeConfig(rawConfig)
  const log = logger ?? ctx?.logger?.('dsh-douyin') ?? console

  // 以下构造全部无 IO：审计文件首次工具调用才读，SSH 首次 request 才 spawn
  const audit = new AuditLog({
    file: cfg.auditFile,
    maxBytes: cfg.maxAuditBytes,
    tzOffsetMinutes: cfg.tzOffsetMinutes,
  })
  const limiter = new RateLimiter({ cfg, clock, audit })
  const realTransport = transport ?? createTransport(cfg, { log })
  const bridge = new BridgeClient({ transport: realTransport, cfg })
  const notifyOwner = createOwnerNotifier({ ctx, cfg, log, clock })
  const rawService = createDouyinService({
    cfg,
    bridge,
    transport: realTransport,
    limiter,
    clock,
    log,
    notifyOwner,
    ...(typeof sleep === 'function' ? { sleep } : {}),
    ...(typeof fetchImpl === 'function' ? { fetchImpl } : {}),
  })

  // 队列分道（protocol-v2 §C）：
  //   userQueue：所有工具调用（含 status/screenshot/控制命令），保留 maxQueue 语义；
  //   watchQueue：两个 watcher 的原语，深度固定 1，忙则 skip（不排队、不阻塞用户）。
  // 之前两者共用一个 SerialQueue：用户一次写操作要排在 notify tick 的 click/list（8–15s）后面。
  const userQueue = new SerialQueue({ maxQueue: cfg.maxQueue, label: 'user' })
  const watchQueue = new SerialQueue({ maxQueue: 1, label: 'watch' })
  const service = {}
  for (const method of SERVICE_METHODS) {
    if (typeof rawService[method] !== 'function') continue
    service[method] = (args) =>
      userQueue.run(() => rawService[method](args)).catch((e) => toFailure(e))
  }
  service.usage = () => rawService.usage()

  // watcher 原语：走 watchQueue；忙（深度 1 已被占）→ {ok:true,skipped:true,reason:'busy'}
  // 不写审计/不结算 watch（3s 级事件源不能刷审计），也不占用户队列。
  for (const method of WATCH_METHODS) {
    if (typeof rawService[method] !== 'function') continue
    service[method] = (args) =>
      watchQueue
        .run(() => rawService[method](args))
        .catch((e) => (e?.code === 'E_BUSY' ? watchBusyResult(e) : toFailure(e)))
  }

  // 纯内存判断（无 IO、不进队列）：dm-watch 用它过滤"本插件刚发出去的私信"。
  // 2026-11-17：之前没暴露 → watcher 里 `typeof service.isDmOutbound === 'function'` 永远 false，
  // 自己发的消息被当成对方新消息投到 home（重复投递的直接原因之一）。
  // 注意：**不暴露** dmProbeDirection（它会打开会话并标记已读，破坏"watcher 不开会话"的既有约束）。
  if (typeof rawService.isDmOutbound === 'function') {
    service.isDmOutbound = (conv) => rawService.isDmOutbound(conv) === true
  }

  // 队列统计（只读，不排队：status 里要能立刻看到）
  service.queueStats = () => {
    const user = userQueue.stats()
    const watch = watchQueue.stats()
    return {
      userDepth: user.depth,
      userMax: user.maxQueue,
      watchDepth: watch.depth,
      watchMax: watch.maxQueue,
      accepting: user.accepting,
      maxQueue: user.maxQueue,
      userAccepting: user.accepting,
      watchAccepting: watch.accepting,
      retryAfterMs: user.retryAfterMs,
      watchRetryAfterMs: watch.retryAfterMs,
    }
  }

  const register = (targetCtx = ctx) => registerTools({ ctx: targetCtx, service, cfg, log })
  // 只读通知 watcher：构造阶段零 IO/零定时器，只有 apply 里显式 start() 才排期
  const notifyWatcher = createNotifyWatcher({ cfg, service, ctx, log, clock, bridge })
  service.notifyWatch = (args) => notifyWatcher.request(args).catch((e) => toFailure(e))
  service.notifyWatchStatus = () => notifyWatcher.status()
  service.notifyWatchSubscribe = (fn) => notifyWatcher.subscribe(fn)
  // 兼容旧名字
  service.notifyStatus = () => ({ ...notifyWatcher.status(), cfgEnabled: cfg.notifyWatchEnabled, intervalMs: cfg.notifyWatchIntervalMs })

  // 私信 watcher 专用读取已在 WATCH_METHODS 里（走 watchQueue）

  // 只读私信 watcher（默认关）：dmWatch 返回新消息事件，不路由、不发消息、不打开会话。
  const dmWatcher = createDmWatcher({ cfg, service, ctx, log, clock, bridge })
  service.dmWatch = (args) => dmWatcher.request(args)
  service.dmWatchStatus = () => dmWatcher.status()
  // 可订阅：autonomy 直接挂回调；返回取消订阅函数。事件只读，不路由、不发消息。
  service.dmWatchSubscribe = (fn) => dmWatcher.subscribe(fn)

  return {
    cfg,
    log,
    transport: realTransport,
    bridge,
    limiter,
    audit,
    // 兼容旧字段：runtime.queue 仍是用户队列（tools.test 里用 runtime.queue.size）
    queue: userQueue,
    userQueue,
    watchQueue,
    rawService,
    service,
    notifyWatcher,
    dmWatcher,
    registerTools: register,
  }
}

export function apply(ctx, raw = {}) {
  try {
    const runtime = createRuntime({ ctx, rawConfig: raw })
    const registered = runtime.registerTools(ctx)
    if (runtime.cfg.exposeService && typeof ctx?.provide === 'function') {
      try {
        ctx.provide('dyDouyin', { version: 1, ...runtime.service })
      } catch (e) {
        runtime.log?.warn?.(`[douyin] provide('dyDouyin') 失败：${String(e?.message ?? e).slice(0, 200)}`)
      }
    }
    // 通知实时事件源：默认关；开启时先建基线，之后只投新通知。
    // 定时器 unref，不阻塞宿主退出；卸载时显式 stop，避免热重载重复挂。
    if (runtime.cfg.notifyWatchEnabled === true && runtime.cfg.enabled !== false) {
      try {
        const started = runtime.notifyWatcher.start()
        if (started) {
          runtime.log?.info?.(
            `[douyin] notify live watcher 已启动：每 ${Math.round(runtime.cfg.notifyWatchIntervalMs / 1000)}s badge/DOM 事件源（不每轮开面板）`,
          )
        }
      } catch (e) {
        runtime.log?.warn?.(`[douyin] notify watcher 启动失败（不影响工具）：${String(e?.message ?? e).slice(0, 200)}`)
      }
      try {
        ctx?.on?.('dispose', () => {
          try { runtime.notifyWatcher.stop() } catch {}
        })
      } catch {
        // 事件总线不可用也不影响
      }
    }
    // 私信实时 watcher：默认关；开启时每 dmWatchIntervalMs（默认 3s）只读 /chat 会话列表。
    // 定时器 unref；dispose 时 stop。事件只进队列/订阅，不路由、不发消息。
    if (runtime.cfg.dmWatchEnabled === true && runtime.cfg.enabled !== false) {
      try {
        const started = runtime.dmWatcher.start()
        if (started) {
          runtime.log?.info?.(
            `[douyin] dm watcher 已启动：每 ${Math.round(runtime.cfg.dmWatchIntervalMs / 1000)}s 只读 /chat 会话列表（不打开会话、不发送）`,
          )
        }
      } catch (e) {
        runtime.log?.warn?.(`[douyin] dm watcher 启动失败（不影响工具）：${String(e?.message ?? e).slice(0, 200)}`)
      }
      try {
        ctx?.on?.('dispose', () => {
          try { runtime.dmWatcher.stop() } catch {}
        })
      } catch {
        // 事件总线不可用也不影响
      }
    }
    return registered > 0 || runtime.cfg.exposeService
  } catch (e) {
    // 任何装配异常都不能把宿主带崩：记录后以“未启用”状态返回
    try {
      ctx?.logger?.('dsh-douyin')?.warn?.(`[douyin] 插件装配失败（未注册工具）：${String(e?.message ?? e).slice(0, 300)}`)
    } catch {
      // logger 也不可用时静默
    }
    return false
  }
}
