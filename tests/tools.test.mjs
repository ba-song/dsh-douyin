import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply, createRuntime } from '../lib/index.js'
import { registerTools } from '../lib/tools.js'
import {
  cleanupDir,
  detailOf,
  makeClock,
  makeCtx,
  makeFakeMemory,
  makeFakeTransport,
  makeMp4,
  makeTmpDir,
  ownerExec,
  setup,
  subagentExec,
} from './helpers.mjs'

const videoRow = (id, text = `video-${id}`) => ({ href: `//www.douyin.com/video/${id}`, text })

const TOOL_NAMES = [
  'dy_douyin_status',
  'dy_douyin_feed',
  'dy_douyin_search',
  'dy_douyin_open',
  'dy_douyin_comments',
  'dy_douyin_download',
  'dy_douyin_watch',
  'dy_douyin_like',
  'dy_douyin_favorite',
  'dy_douyin_comment',
  'dy_douyin_comment_reply',
  'dy_douyin_comment_delete',
  'dy_douyin_dm_list',
  'dy_douyin_dm_read',
  'dy_douyin_dm_send',
  'dy_douyin_dm_watch',
  'dy_douyin_notify_list',
  'dy_douyin_notify_reply',
  'dy_douyin_screenshot',
]

test('注册 19 个工具：名字 / 参数 / 输出 schema 齐全', () => {
  const s = setup()
  assert.deepEqual([...s.registry.keys()].sort(), [...TOOL_NAMES].sort())
  for (const name of TOOL_NAMES) {
    const def = s.registry.get(name)
    assert.equal(def.parameters.type, 'object')
    assert.equal(def.parameters.additionalProperties, false)
    assert.equal(def.output.schema.required[0], 'ok')
    assert.equal(typeof def.output.render, 'function')
    assert.equal(typeof def.execute, 'function')
  }
  const feed = s.registry.get('dy_douyin_feed')
  assert.equal(feed.parameters.properties.limit.maximum, 8)
  assert.equal(feed.parameters.properties.scroll.type, 'boolean')
  const comments = s.registry.get('dy_douyin_comments')
  assert.equal(comments.parameters.properties.limit.maximum, 50)
  assert.equal(comments.parameters.required, undefined)
  const notify = s.registry.get('dy_douyin_notify_list')
  assert.equal(notify.parameters.properties.limit.maximum, 50)
  assert.equal(notify.parameters.properties.loadMore.type, 'boolean')
  const notifyReply = s.registry.get('dy_douyin_notify_reply')
  assert.deepEqual(notifyReply.parameters.required, ['text'])
  assert.equal(notifyReply.parameters.properties.id.type, 'string')
  assert.equal(notifyReply.parameters.properties.index.maximum, 49)
  const dmRead = s.registry.get('dy_douyin_dm_read')
  assert.equal(dmRead.parameters.properties.conversationId.type, 'string')
  assert.equal(dmRead.parameters.properties.index.maximum, 19)
  const dmSend = s.registry.get('dy_douyin_dm_send')
  assert.deepEqual(dmSend.parameters.required, ['text'])
  assert.equal(dmSend.parameters.properties.messageId.type, 'string')
  const dmWatch = s.registry.get('dy_douyin_dm_watch')
  assert.deepEqual(dmWatch.parameters.properties.action.enum, ['poll', 'drain', 'start', 'stop', 'status'])
  assert.equal(dmWatch.parameters.properties.limit.maximum, 100)
  cleanupDir(s.dir)
})

test('owner/home 门禁：home cwd 允许，工作区/无关目录拒绝，子智能体一律拒绝', async () => {
  const s = setup()
  const status = s.registry.get('dy_douyin_status')

  const home = await status.execute({}, ownerExec({ cwd: '/sdcard/DSHA/生活/数据/home' }))
  assert.equal(home.ok, true)

  const unrelated = await status.execute({}, ownerExec({ cwd: '/sdcard/DSHA/工作区' }))
  assert.equal(unrelated.ok, false)
  assert.equal(detailOf(unrelated).code, 'E_PERMISSION')

  const sub = await status.execute({}, subagentExec())
  assert.equal(sub.ok, false)
  assert.equal(detailOf(sub).code, 'E_PERMISSION')

  const noCwd = await status.execute({}, { agent: { session: { id: 'x', header: { id: 'x' } } } })
  assert.equal(noCwd.ok, false)
  cleanupDir(s.dir)
})

test('ownerPrivateDirs 允许；dyHome.isHomeSession 也允许', async () => {
  const s = setup({
    rawConfig: { ownerPrivateDirs: ['/sdcard/DSHA/工作区/'] },
    ctxOptions: {
      dyHome: {
        isHomeSession: (sid) => sid === 'home-via-service',
      },
    },
  })
  const status = s.registry.get('dy_douyin_status')

  const privateDir = await status.execute({}, ownerExec({ cwd: '/sdcard/DSHA/工作区/统筹' }))
  assert.equal(privateDir.ok, true)

  const viaService = await status.execute(
    {},
    { agent: { session: { id: 'home-via-service', header: { id: 'home-via-service', cwd: '/somewhere/else' } } } },
  )
  assert.equal(viaService.ok, true)
  cleanupDir(s.dir)
})

test('tools 服务不可用：registerTools 返回 0、不抛；apply 不崩', () => {
  const { ctx } = makeCtx({ tools: false })
  const rt = createRuntime({ rawConfig: { auditFile: '' }, transport: makeFakeTransport() })
  assert.equal(rt.registerTools(ctx), 0)
  assert.equal(registerTools({ ctx, service: rt.service, cfg: rt.cfg }), 0)

  const s = setup({ tools: false })
  assert.equal(s.registry.size, 0)
  assert.ok(s.logs.some((line) => /tools 服务不可用/.test(line)))
  cleanupDir(s.dir)
})

test('启动零副作用：createRuntime 不读审计、不建目录、不连 SSH', () => {
  const dir = makeTmpDir('zeroio')
  const auditFile = join(dir, 'audit.jsonl')
  const screenshotDir = join(dir, 'shots')
  const rt = createRuntime({
    rawConfig: { auditFile, screenshotDir, sshKeyPath: join(dir, 'missing-key') },
    transport: makeFakeTransport(),
  })
  assert.equal(rt.cfg.auditFile, auditFile)
  assert.equal(existsSync(auditFile), false)
  assert.equal(existsSync(screenshotDir), false)
  assert.equal(rt.queue.size, 0)
  assert.equal(rt.transport.calls?.length ?? 0, 0)
  cleanupDir(dir)
})

test('apply：远程不可用/缺 key 时正常加载并注册，调用返回 E_SSH_AUTH 不抛', async () => {
  const dir = makeTmpDir('apply')
  const { ctx, registry, logs } = makeCtx()
  const ok = apply(ctx, {
    enabled: true,
    sshKeyPath: join(dir, 'missing-key'),
    knownHosts: join(dir, 'missing-known_hosts'),
    auditFile: join(dir, 'audit.jsonl'),
    screenshotDir: join(dir, 'shots'),
  })
  assert.equal(ok, true)
  assert.equal(registry.size, 19)
  assert.equal(existsSync(join(dir, 'audit.jsonl')), false)

  const res = await registry.get('dy_douyin_status').execute({}, ownerExec())
  assert.equal(res.ok, false)
  const detail = detailOf(res)
  assert.equal(detail.code, 'E_SSH_AUTH')
  assert.ok(logs.length >= 0)
  cleanupDir(dir)
})

test('apply：损坏/空配置不抛；ctx 为空也不把宿主带崩', () => {
  assert.equal(apply(undefined, null), false)
  assert.equal(apply(undefined, { transport: 'x', dailyQuota: -1 }), false)

  const { ctx, registry } = makeCtx()
  assert.equal(apply(ctx, { sshKeyPath: '/nonexistent/key', knownHosts: '/nonexistent/kh', auditFile: '/tmp/x-audit.jsonl' }), true)
  assert.equal(registry.size, 19)
})

test('apply：exposeService 默认关闭；显式 true 时 provide dyDouyin', () => {
  const dir = makeTmpDir('provide')
  {
    const { ctx, provided } = makeCtx()
    apply(ctx, { auditFile: join(dir, 'a1.jsonl'), exposeService: false })
    assert.equal(provided.has('dyDouyin'), false)
  }
  {
    const { ctx, provided } = makeCtx()
    apply(ctx, {
      auditFile: join(dir, 'a2.jsonl'),
      screenshotDir: join(dir, 's2'),
      exposeService: true,
    })
    assert.ok(provided.get('dyDouyin'))
    assert.equal(typeof provided.get('dyDouyin').feed, 'function')
    assert.equal(typeof provided.get('dyDouyin').usage, 'function')
    assert.equal(typeof provided.get('dyDouyin').dmWatch, 'function')
    assert.equal(typeof provided.get('dyDouyin').dmWatchStatus, 'function')
    assert.equal(typeof provided.get('dyDouyin').dmWatchSubscribe, 'function')
    assert.equal(typeof provided.get('dyDouyin').notifyWatch, 'function')
    assert.equal(typeof provided.get('dyDouyin').notifyWatchStatus, 'function')
    assert.equal(typeof provided.get('dyDouyin').notifyWatchSubscribe, 'function')
    assert.equal(typeof provided.get('dyDouyin').notifyBadgeProbe, 'function')
    assert.equal(typeof provided.get('dyDouyin').notifySnapshotForWatch, 'function')
  }
  cleanupDir(dir)
})

test('工具返回统一 {ok, detail}；成功/失败都走 JSON，不抛异常', async () => {
  const s = setup({
    handlers: {
      list: () => ({
        ok: true,
        cmd: 'list',
        result: [{ href: '//www.douyin.com/video/123456789', text: '一条' }],
      }),
    },
  })
  const ok = await s.registry.get('dy_douyin_feed').execute({ limit: 1 }, ownerExec())
  assert.equal(ok.ok, true)
  assert.equal(detailOf(ok).count, 1)
  assert.equal(detailOf(ok).items[0].videoId, '123456789')

  const bad = await s.registry.get('dy_douyin_feed').execute({ limit: 99 }, ownerExec())
  assert.equal(bad.ok, false)
  assert.equal(detailOf(bad).code, 'E_BAD_ARG')
  cleanupDir(s.dir)
})

test('工具并发：串行队列 + 5s 间隔在工具层同样生效', async () => {
  const clock = makeClock('2026-11-06T18:30:00+08:00')
  const s = setup({ clock, rawConfig: { minIntervalMs: 5000 } })
  const status = s.registry.get('dy_douyin_status')
  const first = await status.execute({}, ownerExec())
  assert.equal(first.ok, true)
  const second = await status.execute({}, ownerExec())
  assert.equal(second.ok, false)
  assert.equal(detailOf(second).code, 'E_MIN_INTERVAL')
  cleanupDir(s.dir)
})

test('dy_douyin_feed 工具透传 scroll=true，失败仍走 detail JSON', async () => {
  const s = setup({
    handlers: {
      list: () => ({ ok: true, cmd: 'list', result: [] }),
    },
  })
  // 用默认空列表触发一次 scroll 尝试（首批为空也会滚），最终仍 E_SELECTOR_MISS
  const r = await s.registry.get('dy_douyin_feed').execute({ limit: 2, scroll: true }, ownerExec())
  assert.equal(r.ok, false)
  assert.equal(detailOf(r).code, 'E_SELECTOR_MISS')
  assert.equal(s.transport.calls.filter((c) => c.cmd === 'scroll').length, 3)
  cleanupDir(s.dir)
})

function downloadFixture({ mem = null, author = '许肆意.', memory } = {}) {
  const dlDir = makeTmpDir('tool-dl')
  const mp4 = makeMp4()
  const ld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: '抖音', item: 'https://www.douyin.com' },
      { '@type': 'ListItem', position: 2, name: author, item: 'https://www.douyin.com/user/MS4wLjABAAAA_test' },
    ],
  })
  const s = setup({
    rawConfig: { downloadDir: dlDir },
    ctxOptions: { dyMemory: mem ?? undefined },
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/video/123456789' }),
      html: (p) => {
        if (p.selector.includes('ld+json')) return { ok: true, cmd: 'html', result: ld }
        if (p.selector === 'video') {
          return { ok: true, cmd: 'html', result: '<video><source src="https://v11-weba.douyinvod.com/x.mp4"></video>' }
        }
        if (p.selector === 'body') return { ok: true, cmd: 'html', result: `<div>${author}</div>` }
        return { ok: true, cmd: 'html', result: '' }
      },
      text: () => ({ ok: true, cmd: 'text', result: '' }),
      title: () => ({ ok: true, cmd: 'title', result: '测试标题' }),
    },
    fetchImpl: async () => new Response(mp4, { status: 200, headers: { 'content-length': String(mp4.length) } }),
  })
  return { s, dlDir, mp4, sidecar: join(dlDir, '123456789.json') }
}

test('download：解析作者、写 sidecar，且绝不写观看记忆', async () => {
  const mem = makeFakeMemory()
  const { s, dlDir, mp4, sidecar } = downloadFixture({ mem })
  const res = await s.registry.get('dy_douyin_download').execute({ videoId: '123456789' }, ownerExec())
  assert.equal(res.ok, true)
  const detail = detailOf(res)
  assert.equal(detail.author, '许肆意.')
  assert.equal(detail.bytes, mp4.length)
  assert.equal(mem.calls.length, 0) // download 不写记忆

  const meta = JSON.parse(readFileSync(sidecar, 'utf8'))
  assert.equal(meta.videoId, '123456789')
  assert.equal(meta.title, '测试标题')
  assert.equal(meta.author, '许肆意.')
  assert.equal(meta.file, join(dlDir, '123456789.mp4'))
  assert.equal(meta.bytes, mp4.length)
  assert.equal(meta.seconds, 12.3)
  assert.match(meta.downloadedAt, /^\d{4}-\d{2}-\d{2}T/)
  cleanupDir(s.dir)
  cleanupDir(dlDir)
})

test('watch：从 sidecar 写一条观看记忆，更新 watchedAt/watchMemoryId', async () => {
  const mem = makeFakeMemory()
  const { s, dlDir, sidecar } = downloadFixture({ mem })
  const exec = ownerExec({ id: 'home-watch-1' })
  assert.equal((await s.registry.get('dy_douyin_download').execute({ videoId: '123456789' }, exec)).ok, true)
  const res = await s.registry
    .get('dy_douyin_watch')
    .execute({ videoId: '123456789', thought: '很喜欢这个日落', summary: '洱海日落' }, exec)
  assert.equal(res.ok, true)
  const detail = detailOf(res)
  assert.equal(detail.memoryWritten, true)
  assert.equal(detail.memoryId, 1)
  assert.equal(mem.calls.length, 1)
  const call = mem.calls[0]
  assert.equal(call.source, 'douyin_watch')
  assert.match(call.ref, /videoId=123456789/)
  assert.match(call.ref, /123456789\.mp4/)
  assert.match(call.text, /《测试标题》/)
  assert.match(call.text, /@许肆意\./)
  assert.match(call.text, /观看想法：很喜欢这个日落/)
  assert.match(call.text, /摘要：洱海日落/)
  assert.match(call.text, /文件：.*123456789\.mp4/)
  assert.deepEqual(call.header, exec.agent.session.header)

  const meta = JSON.parse(readFileSync(sidecar, 'utf8'))
  assert.ok(meta.watchedAt)
  assert.equal(meta.watchMemoryId, 1)
  cleanupDir(s.dir)
  cleanupDir(dlDir)
})

test('watch：重复同一 videoId 幂等，不再写第二条', async () => {
  const mem = makeFakeMemory()
  const { s, dlDir } = downloadFixture({ mem })
  const exec = ownerExec()
  assert.equal((await s.registry.get('dy_douyin_download').execute({ videoId: '123456789' }, exec)).ok, true)
  assert.equal((await s.registry.get('dy_douyin_watch').execute({ videoId: '123456789' }, exec)).ok, true)
  assert.equal(mem.calls.length, 1)
  const again = await s.registry.get('dy_douyin_watch').execute({ videoId: '123456789', thought: '第二次' }, exec)
  assert.equal(again.ok, true)
  assert.equal(detailOf(again).duplicate, true)
  assert.equal(mem.calls.length, 1)
  cleanupDir(s.dir)
  cleanupDir(dlDir)
})

test('watch：无 dyMemory / dyMemory 失败都不阻断，返回 memoryWritten=false', async () => {
  {
    const { s, dlDir } = downloadFixture({ mem: null })
    const exec = ownerExec()
    assert.equal((await s.registry.get('dy_douyin_download').execute({ videoId: '123456789' }, exec)).ok, true)
    const r = await s.registry.get('dy_douyin_watch').execute({ videoId: '123456789' }, exec)
    assert.equal(r.ok, true)
    assert.equal(detailOf(r).memoryWritten, false)
    cleanupDir(s.dir)
    cleanupDir(dlDir)
  }
  {
    const mem = makeFakeMemory({ fail: true })
    const { s, dlDir } = downloadFixture({ mem })
    const exec = ownerExec()
    assert.equal((await s.registry.get('dy_douyin_download').execute({ videoId: '123456789' }, exec)).ok, true)
    const r = await s.registry.get('dy_douyin_watch').execute({ videoId: '123456789' }, exec)
    assert.equal(r.ok, true)
    assert.equal(detailOf(r).memoryWritten, false)
    assert.ok(s.logs.some((line) => /观看记忆写入失败/.test(line)))
    cleanupDir(s.dir)
    cleanupDir(dlDir)
  }
})

test('watch：sidecar 不存在 → E_NOT_FOUND；path 越界 → E_BAD_ARG', async () => {
  const dlDir = makeTmpDir('tool-watch-miss')
  const s = setup({
    rawConfig: { downloadDir: dlDir },
    ctxOptions: { dyMemory: makeFakeMemory() },
  })
  const exec = ownerExec()
  const missing = await s.registry.get('dy_douyin_watch').execute({ videoId: '123456789' }, exec)
  assert.equal(missing.ok, false)
  assert.equal(detailOf(missing).code, 'E_NOT_FOUND')

  const outside = await s.registry
    .get('dy_douyin_watch')
    .execute({ videoId: '123456789', path: '/tmp/evil.mp4' }, exec)
  assert.equal(outside.ok, false)
  assert.equal(detailOf(outside).code, 'E_BAD_ARG')
  cleanupDir(s.dir)
  cleanupDir(dlDir)
})

test('watch：可用 .mp4 路径定位 sidecar', async () => {
  const mem = makeFakeMemory()
  const { s, dlDir } = downloadFixture({ mem })
  const exec = ownerExec()
  assert.equal((await s.registry.get('dy_douyin_download').execute({ videoId: '123456789' }, exec)).ok, true)
  const r = await s.registry
    .get('dy_douyin_watch')
    .execute({ path: join(dlDir, '123456789.mp4'), thought: '路径方式' }, exec)
  assert.equal(r.ok, true)
  assert.equal(mem.calls.length, 1)
  cleanupDir(s.dir)
  cleanupDir(dlDir)
})

test('watch：作者未知时不写 @未知', async () => {
  const mem = makeFakeMemory()
  const { s, dlDir } = downloadFixture({ mem, author: '' })
  const exec = ownerExec()
  const dl = await s.registry.get('dy_douyin_download').execute({ videoId: '123456789' }, exec)
  assert.equal(detailOf(dl).author, '未知')
  const w = await s.registry.get('dy_douyin_watch').execute({ videoId: '123456789', thought: '测试' }, exec)
  assert.equal(w.ok, true)
  assert.equal(mem.calls.length, 1)
  assert.match(mem.calls[0].text, /作者未知/)
  assert.ok(!mem.calls[0].text.includes('@未知'))
  cleanupDir(s.dir)
  cleanupDir(dlDir)
})

test('dy_douyin_dm_watch 工具：owner 门禁 + poll 基线 + 暴露服务方法', async () => {
  const s = setup({
    rawConfig: { dmOwnerAliases: [] },
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/chat' }),
      count: () => ({ ok: true, cmd: 'count', result: 1 }),
      list: (p) => {
        if (p.selector === '[data-e2e="conversation-item"]' || p.selector === '.conversationConversationItemtitle') {
          return { ok: true, cmd: 'list', result: [{ text: '路人' }] }
        }
        if (p.selector === '.ConversationItemHinttextBox') return { ok: true, cmd: 'list', result: [{ text: '你好' }] }
        if (p.selector === '.ConversationItemTagNextToTitletimeStr') return { ok: true, cmd: 'list', result: [{ text: '刚刚' }] }
        return { ok: true, cmd: 'list', result: [] }
      },
    },
  })
  const def = s.registry.get('dy_douyin_dm_watch')
  const sub = await def.execute({ action: 'poll' }, subagentExec())
  assert.equal(sub.ok, false)
  assert.equal(detailOf(sub).code, 'E_PERMISSION')

  const ok = await def.execute({ action: 'poll' }, ownerExec())
  assert.equal(ok.ok, true)
  const detail = detailOf(ok)
  assert.equal(detail.tick.baseline, true)
  assert.deepEqual(detail.events, [])
  assert.equal(detail.primed, true)

  assert.equal(typeof s.runtime.service.dmWatch, 'function')
  assert.equal(typeof s.runtime.service.dmWatchStatus, 'function')
  assert.equal(typeof s.runtime.service.dmPollConversations, 'function')
  cleanupDir(s.dir)
})
