import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, normalizeConfig, parseMinuteRange, unwrapVolatile } from '../lib/config.js'
import { Config } from '../lib/index.js'

const VOLATILE = Symbol.for('cosmokit.volatile.write')

test('Config：只声明 enabled/dailyQuota，两个都是 volatile；空对象解析出 DEFAULTS', () => {
  const parsed = Config({})
  assert.deepEqual(Object.keys(parsed).sort(), ['dailyQuota', 'enabled'])
  for (const key of ['enabled', 'dailyQuota']) {
    assert.equal(typeof parsed[key], 'object')
    assert.equal(typeof parsed[key].get, 'function')
    assert.ok(VOLATILE in parsed[key])
  }
  assert.equal(parsed.enabled.get(), DEFAULTS.enabled)
  assert.equal(parsed.dailyQuota.get(), DEFAULTS.dailyQuota)
  assert.equal(parsed.dailyQuota.get(), 40)
})

test('Config：未声明的键非 strict 透传（transport/ssh*/perSession 不丢）', () => {
  const parsed = Config({ transport: 'ssh-exec', sshHost: '10.0.0.2', sshPort: 2222, perSession: 3 })
  assert.equal(parsed.transport, 'ssh-exec')
  assert.equal(parsed.sshHost, '10.0.0.2')
  assert.equal(parsed.sshPort, 2222)
  assert.equal(parsed.perSession, 3)
  assert.equal(parsed.enabled.get(), true)
  assert.equal(parsed.dailyQuota.get(), 40)
})

test('Config：dailyQuota 范围 0..100（0=不设限）；越界/类型错误抛 ValidationError', () => {
  assert.equal(Config({ dailyQuota: 0 }).dailyQuota.get(), 0)
  assert.throws(() => Config({ dailyQuota: 101 }), /dailyQuota/)
  assert.throws(() => Config({ enabled: 'yes' }), /enabled/)
  assert.equal(Config({ dailyQuota: 1 }).dailyQuota.get(), 1)
  assert.equal(Config({ dailyQuota: 100 }).dailyQuota.get(), 100)
})

test('unwrapVolatile：还原 {get()} 引用，普通对象深拷贝、非普通对象原样', () => {
  const ref = { get: () => 42 }
  Object.defineProperty(ref, VOLATILE, { value: true, enumerable: true })
  assert.equal(unwrapVolatile(ref), 42)
  assert.deepEqual(unwrapVolatile({ a: ref, b: [ref, 1] }), { a: 42, b: [42, 1] })
  const plain = { x: 1 }
  const copy = unwrapVolatile(plain)
  assert.deepEqual(copy, plain)
  assert.notEqual(copy, plain)
  assert.equal(unwrapVolatile(null), null)
  assert.equal(unwrapVolatile('x'), 'x')
})

test('normalizeConfig 还原 volatile 引用：enabled=false / dailyQuota=10', () => {
  const cfg = normalizeConfig({
    enabled: { get: () => false },
    dailyQuota: { get: () => 10 },
  })
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.dailyQuota, 10)
  assert.deepEqual(cfg.warnings, [])
  // 等价的手写 Config 解析结果也一样
  const viaSchema = normalizeConfig(Config({ enabled: false, dailyQuota: 10 }))
  assert.equal(viaSchema.enabled, false)
  assert.equal(viaSchema.dailyQuota, 10)
  const empty = normalizeConfig(Config({}))
  assert.equal(empty.enabled, true)
  assert.equal(empty.dailyQuota, 40)
  assert.equal(empty.transport, 'ssh-exec')
})

test('默认配置：enabled=true / ssh-exec / 40 条 / 单会话 8 条 / 30 分钟 / 5 秒', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.transport, 'ssh-exec')
  assert.equal(cfg.dailyQuota, 40)
  assert.equal(cfg.perSession, 8)
  assert.equal(cfg.sessionGapMs, 1800000)
  assert.equal(cfg.minIntervalMs, 5000)
  assert.equal(cfg.sshHost, DEFAULTS.sshHost)
  assert.equal(cfg.sshPort, 2222)
  assert.equal(cfg.openTimeoutMs, 120000)
  assert.equal(cfg.callTimeoutMs, 30000)
  assert.equal(cfg.searchSelector, 'div.search-result-card')
  assert.equal(cfg.feedScrollDelta, 700)
  assert.equal(cfg.feedScrollWaitMs, 800)
  assert.equal(cfg.feedScrollMaxSteps, 3)
  assert.equal(cfg.searchCardWaitMs, 1500)
  assert.equal(cfg.searchCardRetries, 12)
  assert.equal(cfg.searchRetries, 1)
  assert.equal(cfg.commentReplyExpandMax, 20)
  assert.equal(cfg.commentReplyWaitMs, 500)
  assert.equal(cfg.writeReadbackWaitMs, 800)
  assert.deepEqual(cfg.commentInputSelectors, ['[contenteditable]'])
  assert.deepEqual(cfg.commentSubmitSelectors, [
    '#comment-input-container .commentInput-right-ct span:last-child',
  ])
  assert.equal(cfg.remoteDisplay, ':20')
  assert.ok(cfg.writeBlockedSelectors.includes('[class*="verify_sms"]'))
  assert.equal(cfg.blockAssets, false)
  assert.equal(cfg.minWatchMs, 10000)
  assert.deepEqual(cfg.warnings, [])
})

test('searchRetries：默认 1（最多 1 次），0 可关；越界回落默认', () => {
  assert.equal(normalizeConfig({ searchRetries: 0 }).searchRetries, 0)
  assert.equal(normalizeConfig({ searchRetries: 1 }).searchRetries, 1)
  assert.equal(normalizeConfig({ searchRetries: 2 }).searchRetries, 1)
  assert.equal(normalizeConfig({ searchRetries: -1 }).searchRetries, 1)
})

test('minWatchMs：默认 10s，可配；非法值回落默认', () => {
  assert.equal(normalizeConfig({ minWatchMs: 5000 }).minWatchMs, 5000)
  assert.equal(normalizeConfig({ minWatchMs: 0 }).minWatchMs, 0)
  assert.equal(normalizeConfig({ minWatchMs: 'x' }).minWatchMs, 10000)
  assert.equal(normalizeConfig({ minWatchMs: -1 }).minWatchMs, 10000)
  assert.equal(normalizeConfig({ minWatchMs: 9999999 }).minWatchMs, 10000)
})

test('blockAssets：布尔开关，默认关；非布尔回落 false', () => {
  assert.equal(normalizeConfig({ blockAssets: true }).blockAssets, true)
  assert.equal(normalizeConfig({ blockAssets: false }).blockAssets, false)
  assert.equal(normalizeConfig({ blockAssets: 'true' }).blockAssets, false)
  assert.equal(normalizeConfig({ blockAssets: 1 }).blockAssets, false)
})

test('默认时段：工作日 08-09 / 12-14 / 18-24，周末全天，00-08 静默', () => {
  const { timeWindows } = normalizeConfig({})
  assert.deepEqual(timeWindows.weekday, [
    [480, 540],
    [720, 840],
    [1080, 1440],
  ])
  assert.deepEqual(timeWindows.weekend, [[0, 1440]])
  assert.deepEqual(timeWindows.silence, [[0, 480]])
})

test('非法 transport / 数值 / 路径回落到默认值并记 warnings，不 throw', () => {
  const cfg = normalizeConfig({
    transport: 'carrier-pigeon',
    dailyQuota: 'many',
    perSession: -3,
    minIntervalMs: 9999999,
    sshHost: '-oProxyCommand=evil',
    sshUser: 'bad user',
    remoteClient: '/persistent/cdp/../etc/passwd',
    screenshotDir: 'relative/path',
    commentSelectors: ['   ', 42],
    ownerPrivateDirs: ['/sdcard/ok/', 123, 'relative'],
  })
  assert.equal(cfg.transport, 'ssh-exec')
  assert.equal(cfg.dailyQuota, 40)
  assert.equal(cfg.perSession, 8)
  assert.equal(cfg.minIntervalMs, 5000)
  assert.equal(cfg.sshHost, DEFAULTS.sshHost)
  assert.equal(cfg.sshUser, DEFAULTS.sshUser)
  assert.equal(cfg.remoteClient, DEFAULTS.remoteClient)
  assert.equal(cfg.screenshotDir, DEFAULTS.screenshotDir)
  assert.deepEqual(cfg.commentSelectors, [...DEFAULTS.commentSelectors])
  assert.deepEqual(cfg.ownerPrivateDirs, ['/sdcard/ok'])
  assert.ok(cfg.warnings.length >= 3)
})

test('timeWindows 支持共享数组写法与显式空 silence', () => {
  const cfg = normalizeConfig({
    timeWindows: {
      weekday: ['09:00-10:30', 'bad'],
      weekend: [],
      silence: [],
    },
  })
  assert.deepEqual(cfg.timeWindows.weekday, [[540, 630]])
  assert.deepEqual(cfg.timeWindows.weekend, [])
  assert.deepEqual(cfg.timeWindows.silence, [])

  const shared = normalizeConfig({ timeWindows: '08:00-09:00' })
  assert.deepEqual(shared.timeWindows.weekday, [[480, 540]])
  assert.deepEqual(shared.timeWindows.weekend, [[480, 540]])
  assert.deepEqual(shared.timeWindows.silence, [[0, 480]])
})

test('parseMinuteRange：合法/跨午夜/24:00/非法', () => {
  assert.deepEqual(parseMinuteRange('08:00-09:00'), [480, 540])
  assert.deepEqual(parseMinuteRange('18:00-24:00'), [1080, 1440])
  assert.deepEqual(parseMinuteRange('22:00-02:00'), [1320, 120])
  assert.equal(parseMinuteRange('08:00'), null)
  assert.equal(parseMinuteRange('08:00-08:00'), null)
  assert.equal(parseMinuteRange('25:00-26:00'), null)
  assert.equal(parseMinuteRange(null), null)
})

test('owner/home 门禁目录、exposeService 默认关闭', () => {
  const cfg = normalizeConfig({ ownerPrivateDirs: ['/sdcard/DSHA/工作区/'] })
  assert.equal(cfg.homeCwd, '/sdcard/DSHA/生活/数据/home')
  assert.deepEqual(cfg.ownerPrivateDirs, ['/sdcard/DSHA/工作区'])
  assert.equal(cfg.exposeService, false)
})

test('非对象配置按默认值处理', () => {
  for (const raw of [null, undefined, 'x', 42, []]) {
    const cfg = normalizeConfig(raw)
    assert.equal(cfg.enabled, true)
    assert.equal(cfg.transport, 'ssh-exec')
  }
})

test('homeUrl 只接受 douyin.com 的 https 地址，否则回落默认', () => {
  assert.equal(normalizeConfig({ homeUrl: 'https://evil.example/' }).homeUrl, DEFAULTS.homeUrl)
  assert.equal(normalizeConfig({ homeUrl: 'http://www.douyin.com/' }).homeUrl, DEFAULTS.homeUrl)
  assert.equal(normalizeConfig({ homeUrl: 'https://m.douyin.com/' }).homeUrl, 'https://m.douyin.com/')
})

test('私信 watcher / 主人别名：默认值与非法值回落', () => {
  const cfg = normalizeConfig({})
  assert.deepEqual(cfg.dmOwnerAliases, ['饲养员', '草荧'])
  assert.equal(cfg.dmOwnerDisplayName, '草荧')
  assert.equal(cfg.dmWatchEnabled, false)
  assert.equal(cfg.dmWatchIntervalMs, 3000)
  assert.equal(cfg.dmWatchStartupDelayMs, 3000)
  assert.equal(cfg.dmWatchLimit, 20)
  assert.equal(cfg.dmWatchConfirmTicks, 2)
  assert.equal(cfg.dmWatchKeepOpen, true)

  assert.equal(normalizeConfig({ dmWatchIntervalMs: 2000 }).dmWatchIntervalMs, 2000)
  assert.equal(normalizeConfig({ dmWatchIntervalMs: 5000 }).dmWatchIntervalMs, 5000)
  assert.equal(normalizeConfig({ dmWatchIntervalMs: 1000 }).dmWatchIntervalMs, 3000)
  assert.equal(normalizeConfig({ dmWatchIntervalMs: 999999 }).dmWatchIntervalMs, 3000)
  assert.equal(normalizeConfig({ dmWatchConfirmTicks: 1 }).dmWatchConfirmTicks, 1)
  assert.equal(normalizeConfig({ dmWatchConfirmTicks: 9 }).dmWatchConfirmTicks, 2)
  assert.equal(normalizeConfig({ dmWatchEnabled: 'yes' }).dmWatchEnabled, false)
  assert.equal(normalizeConfig({ dmWatchKeepOpen: false }).dmWatchKeepOpen, false)

  assert.deepEqual(normalizeConfig({ dmOwnerAliases: [] }).dmOwnerAliases, [])
  assert.deepEqual(normalizeConfig({ dmOwnerAliases: ['@草荧', ' 饲养员 ', '草荧'] }).dmOwnerAliases, ['草荧', '饲养员'])
  const bad = normalizeConfig({ dmOwnerAliases: '草荧' })
  assert.deepEqual(bad.dmOwnerAliases, ['饲养员', '草荧'])
  assert.ok(bad.warnings.some((w) => /dmOwnerAliases/.test(w)))
})

test('通知实时事件源配置：3s 默认、2s 下限、source/badge/确认/面板间隔', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.notifyWatchEnabled, false)
  assert.equal(cfg.notifyWatchIntervalMs, 3000)
  assert.equal(cfg.notifyWatchSource, 'auto')
  assert.equal(cfg.notifyWatchJsTakeLimit, 30)
  assert.equal(cfg.notifyWatchBaselineEnabled, true)
  assert.equal(cfg.notifyWatchBaselineRetryMs, 15000)
  assert.equal(cfg.notifyWatchPanelMinGapMs, 15000)
  assert.equal(cfg.notifyWatchDeliver, true)
  assert.equal(cfg.notifyWatchOtherContactId, 'douyin')
  assert.equal(cfg.notifyWatchOtherContactName, '抖音')
  assert.deepEqual(cfg.notifyWatchBadgeSelectors, ['header [data-e2e="something-button"]:has-text("通知")'])

  assert.equal(normalizeConfig({ notifyWatchIntervalMs: 2000 }).notifyWatchIntervalMs, 2000)
  assert.equal(normalizeConfig({ notifyWatchIntervalMs: 5000 }).notifyWatchIntervalMs, 5000)
  assert.equal(normalizeConfig({ notifyWatchIntervalMs: 1000 }).notifyWatchIntervalMs, 3000)
  assert.equal(normalizeConfig({ notifyWatchIntervalMs: 600000 }).notifyWatchIntervalMs, 3000)
  assert.equal(normalizeConfig({ notifyWatchIntervalMs: 9999999 }).notifyWatchIntervalMs, 3000)
  assert.ok(normalizeConfig({ notifyWatchIntervalMs: 600000 }).warnings.some((w) => /notifyWatchIntervalMs/.test(w)))
  assert.ok(normalizeConfig({ notifyWatchSource: 'bad' }).warnings.some((w) => /notifyWatchSource/.test(w)))
  assert.equal(normalizeConfig({ notifyWatchSource: 'js' }).notifyWatchSource, 'js')
  assert.equal(normalizeConfig({ notifyWatchSource: 'bad' }).notifyWatchSource, 'auto')
  assert.equal(normalizeConfig({ notifyWatchPanelMinGapMs: 1000 }).notifyWatchPanelMinGapMs, 15000)
  assert.equal(normalizeConfig({ notifyWatchDeliver: false }).notifyWatchDeliver, false)
  assert.deepEqual(normalizeConfig({ notifyWatchBadgeSelectors: [] }).notifyWatchBadgeSelectors, [])
})
