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
  'dmList',
  'dmRead',
  'dmSend',
  'notifyList',
  'notifyReply',
]

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
  const rawService = createDouyinService({
    cfg,
    bridge,
    transport: realTransport,
    limiter,
    clock,
    log,
    ...(typeof sleep === 'function' ? { sleep } : {}),
    ...(typeof fetchImpl === 'function' ? { fetchImpl } : {}),
  })

  // 所有工具调用（含 status/screenshot）共用一条串行队列
  const queue = new SerialQueue({ maxQueue: cfg.maxQueue })
  const service = {}
  for (const method of SERVICE_METHODS) {
    service[method] = (args) =>
      queue.run(() => rawService[method](args)).catch((e) => toFailure(e))
  }
  service.usage = () => rawService.usage()

  // 通知实时事件源原语：走同一串行队列；不写审计/不结算 watch（3s 级事件源不能刷审计）
  for (const method of ['notifySourceStart', 'notifySourceTake', 'notifySourceStop', 'notifyBadgeProbe', 'notifySnapshotForWatch']) {
    service[method] = (args) => queue.run(() => rawService[method](args)).catch((e) => toFailure(e))
  }

  const register = (targetCtx = ctx) => registerTools({ ctx: targetCtx, service, cfg, log })
  // 只读通知 watcher：构造阶段零 IO/零定时器，只有 apply 里显式 start() 才排期
  const notifyWatcher = createNotifyWatcher({ cfg, service, ctx, log, clock })
  service.notifyWatch = (args) => notifyWatcher.request(args).catch((e) => toFailure(e))
  service.notifyWatchStatus = () => notifyWatcher.status()
  service.notifyWatchSubscribe = (fn) => notifyWatcher.subscribe(fn)
  // 兼容旧名字
  service.notifyStatus = () => ({ ...notifyWatcher.status(), cfgEnabled: cfg.notifyWatchEnabled, intervalMs: cfg.notifyWatchIntervalMs })

  // 私信 watcher 专用读取：走同一串行队列，但不结算 watch/不写审计/不进配额（每 3s 轮询不能刷审计）
  service.dmPollConversations = (args) =>
    queue.run(() => rawService.dmPollConversations(args)).catch((e) => toFailure(e))

  // 只读私信 watcher（默认关）：dmWatch 返回新消息事件，不路由、不发消息、不打开会话。
  const dmWatcher = createDmWatcher({ cfg, service, ctx, log, clock })
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
    queue,
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
