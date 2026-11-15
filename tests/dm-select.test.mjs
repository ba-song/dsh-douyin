/**
 * 私信精确选择测试（fixture / fake bridge，不连真实服务、不发真实消息）。
 * 覆盖：dm_read 的 conversationId/index/name 定位、稳定 messageId、isOwner；
 *       dm_send 按 messageId/conversationId/index/name 精确发送、重名 E_AMBIGUOUS、
 *       messageId 找不到/指向自己/E_BAD_ARG；主人别名可主动发。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { cleanupDir, makeSleep, setup } from './helpers.mjs'
import { dmConversationId, resolveDmConversation, assignDmMessageIds, parseDmMessageId } from '../lib/service.js'

const DM_ITEM = '[data-e2e="conversation-item"]'
const DM_TITLE = '.conversationConversationItemtitle'
const DM_PREVIEW = '.ConversationItemHinttextBox'
const DM_TIME = '.ConversationItemTagNextToTitletimeStr'
const DM_MSG = '[class~="MessageItemTextcontainer"]'
const DM_TIME_LAYOUT = '[class~="MessageBoxTimetimeLayout"]'
const DM_SEND = '.e2e-send-msg-btn'

/**
 * 假 /chat：conversations 决定列表；messages[name] 决定点开会话后的消息。
 * click(DM_ITEM) 记下 openIdx，click(DM_SEND) 把草稿追加成 fromMe 消息，供回读验证。
 */
function dmEnv({
  conversations = [
    { name: '饲养员', preview: '在吗', time: '刚刚' },
    { name: '路人', preview: '你好', time: '30分钟前' },
  ],
  messages = { 饲养员: [{ text: '在吗', fromMe: false }], 路人: [{ text: '你好', fromMe: false }] },
  ownerFile = '',
  rawConfig = {},
} = {}) {
  let draft = ''
  const sent = []
  let openIdx = -1
  const s = setup({
    rawConfig: { dmOwnerAliases: [], dmKeepPanelOpen: true, ...rawConfig },
    sleep: makeSleep(),
    handlers: {
      url: () => ({ ok: true, cmd: 'url', result: 'https://www.douyin.com/chat' }),
      count: (p) => ({
        ok: true,
        cmd: 'count',
        result: p.selector === DM_ITEM ? conversations.length : 1,
      }),
      list: (p) => {
        if (p.selector === DM_ITEM || p.selector === DM_TITLE) {
          return { ok: true, cmd: 'list', result: conversations.map((c) => ({ text: c.name })) }
        }
        if (p.selector === DM_PREVIEW) {
          return { ok: true, cmd: 'list', result: conversations.map((c) => ({ text: c.preview ?? '' })) }
        }
        if (p.selector === DM_TIME) {
          return { ok: true, cmd: 'list', result: conversations.map((c) => ({ text: c.time ?? '刚刚' })) }
        }
        if (p.selector === `${DM_TIME_LAYOUT}, ${DM_MSG}`) {
          if (openIdx < 0 || !conversations[openIdx]) return { ok: true, cmd: 'list', result: [] }
          const conv = conversations[openIdx]
          const rows = [{ text: conv.time ?? '刚刚', class: 'MessageBoxTimetimeLayout' }]
          for (const m of messages[conv.name] ?? []) {
            rows.push({
              text: m.text,
              class: m.fromMe ? 'MessageItemTextcontainer MessageItemTextisFromMe' : 'MessageItemTextcontainer',
            })
          }
          return { ok: true, cmd: 'list', result: rows }
        }
        if (p.selector === DM_MSG) {
          if (openIdx < 0 || !conversations[openIdx]) return { ok: true, cmd: 'list', result: [] }
          const conv = conversations[openIdx]
          return {
            ok: true,
            cmd: 'list',
            result: (messages[conv.name] ?? []).map((m) => ({
              text: m.text,
              class: m.fromMe ? 'MessageItemTextcontainer MessageItemTextisFromMe' : 'MessageItemTextcontainer',
            })),
          }
        }
        if (p.selector === DM_SEND) {
          return {
            ok: true,
            cmd: 'list',
            result: [{ class: 'messageMsgInputpublishBtn messageMsgInputpublishRedBtn e2e-send-msg-btn' }],
          }
        }
        return { ok: true, cmd: 'list', result: [] }
      },
      click: (p) => {
        if (p.selector === DM_ITEM) {
          openIdx = p.nth
          return { ok: true, cmd: 'click', result: true }
        }
        if (p.selector === DM_SEND) {
          const conv = conversations[openIdx]
          const text = draft
          sent.push(text)
          if (conv) {
            messages[conv.name] = messages[conv.name] ?? []
            messages[conv.name].push({ text, fromMe: true })
          }
          return { ok: true, cmd: 'click', result: true }
        }
        return { ok: true, cmd: 'click', result: true }
      },
      press: () => ({ ok: true, cmd: 'press', result: true }),
      text: (p) => ({ ok: true, cmd: 'text', result: p.selector === '[data-slate-editor="true"]' ? draft : '' }),
    },
  })
  s.transport.pasteText = async (t) => {
    draft = t
    s.transport.pastes.push({ text: t })
    return true
  }
  s.transport.clearText = async () => {
    draft = ''
    s.transport.clearTexts.push({})
    return true
  }
  const file = join(s.dir, 'dm-owner.txt')
  writeFileSync(file, ownerFile)
  s.runtime.cfg.dmOwnerFile = file
  return { s, get sent() { return sent }, messages, conversations }
}

function firstInboundId(readResult, idx = 0) {
  return readResult.items[idx].id
}

test('纯函数：resolveDmConversation 的 id/index/name 优先级与重名；parseDmMessageId 反推会话', () => {
  const items = [
    { id: dmConversationId('饲养员'), index: 0, name: '饲养员' },
    { id: dmConversationId('路人'), index: 1, name: '路人' },
    { id: `${dmConversationId('饲养员')}-2`, index: 2, name: '饲养员' },
  ]
  assert.deepEqual(resolveDmConversation(items, { conversationId: dmConversationId('路人') }), { ok: true, index: 1, item: items[1] })
  assert.deepEqual(resolveDmConversation(items, { index: 2 }), { ok: true, index: 2, item: items[2] })
  const amb = resolveDmConversation(items, { name: '饲养员' })
  assert.equal(amb.code, 'E_AMBIGUOUS')
  assert.deepEqual(amb.indexes, [0, 2])
  assert.equal(amb.candidates.length, 2)
  assert.equal(resolveDmConversation(items, { name: '路人', index: 0 }).code, 'E_BAD_ARG')
  assert.equal(resolveDmConversation(items, {}).code, 'E_BAD_ARG')
  assert.equal(resolveDmConversation(items, { name: '不存在' }).code, 'E_NOT_FOUND')

  const convId = dmConversationId('路人')
  const withIds = assignDmMessageIds(
    [
      { fromMe: false, text: '你好', time: '刚刚' },
      { fromMe: false, text: '你好', time: '刚刚' },
      { fromMe: true, text: '在的', time: '刚刚' },
    ],
    convId,
    { conversationOwner: true },
  )
  assert.equal(withIds[0].isOwner, true)
  assert.equal(withIds[1].isOwner, true)
  assert.equal(withIds[2].isOwner, false)
  assert.notEqual(withIds[0].id, withIds[1].id)
  assert.equal(parseDmMessageId(withIds[0].id).conversationId, convId)
  assert.equal(parseDmMessageId(withIds[0].id).ok, true)
  assert.equal(parseDmMessageId('随便写的').code, 'E_BAD_ARG')
  assert.equal(parseDmMessageId(`dmc_000000000000.m_000000000000`).ok, true)
})

test('dm_read：conversationId / index / name 精确选择；重名 E_AMBIGUOUS；不按名字猜', async () => {
  {
    const f = dmEnv()
    const byId = await f.s.runtime.service.dmRead({ conversationId: dmConversationId('路人') })
    assert.equal(byId.ok, true)
    assert.equal(byId.name, '路人')
    assert.equal(byId.conversation.index, 1)
    assert.equal(byId.conversation.isOwner, false)
    assert.deepEqual(byId.items.map((m) => m.text), ['你好'])
    assert.equal(byId.items[0].sender, '路人')
    assert.equal(byId.items[0].index, 0)
    assert.match(byId.items[0].id, /^dmc_[a-f0-9]{12}\.m_[a-f0-9]{12}$/)

    const byIndex = await f.s.runtime.service.dmRead({ index: 0 })
    assert.equal(byIndex.ok, true)
    assert.equal(byIndex.name, '饲养员')

    const miss = await f.s.runtime.service.dmRead({ name: '不存在' })
    assert.equal(miss.code, 'E_NOT_FOUND')

    const mismatch = await f.s.runtime.service.dmRead({ name: '路人', index: 0 })
    assert.equal(mismatch.code, 'E_BAD_ARG')
    cleanupDir(f.s.dir)
  }
  {
    const dup = dmEnv({
      conversations: [
        { name: '饲养员', preview: '一', time: '刚刚' },
        { name: '饲养员', preview: '二', time: '刚刚' },
      ],
      messages: {},
    })
    const amb = await dup.s.runtime.service.dmRead({ name: '饲养员' })
    assert.equal(amb.code, 'E_AMBIGUOUS')
    assert.deepEqual(amb.indexes, [0, 1])
    assert.equal(amb.candidates.length, 2)
    const byId = await dup.s.runtime.service.dmRead({ conversationId: dmConversationId('饲养员') })
    assert.equal(byId.ok, true)
    assert.equal(byId.conversation.index, 0)
    cleanupDir(dup.s.dir)
  }
})

test('dm_read：消息 id 重复读取稳定；主人会话 isOwner=true，自己发的消息 isOwner=false', async () => {
  const f = dmEnv({
    conversations: [{ name: '饲养员', preview: '在吗', time: '刚刚' }],
    messages: {
      饲养员: [
        { text: '在吗', fromMe: false },
        { text: '在的', fromMe: true },
      ],
    },
    ownerFile: '饲养员\n',
  })
  const a = await f.s.runtime.service.dmRead({ name: '饲养员' })
  const b = await f.s.runtime.service.dmRead({ name: '饲养员' })
  assert.equal(a.conversation.isOwner, true)
  assert.equal(a.items[0].isOwner, true)
  assert.equal(a.items[0].sender, '饲养员')
  assert.equal(a.items[1].isOwner, false)
  assert.equal(a.items[1].sender, 'me')
  assert.deepEqual(a.items.map((m) => m.id), b.items.map((m) => m.id))
  cleanupDir(f.s.dir)
})

test('dm_send：按 messageId 精确回复（回读验证、返回 conversation）', async () => {
  const f = dmEnv()
  const read = await f.s.runtime.service.dmRead({ conversationId: dmConversationId('路人') })
  const messageId = firstInboundId(read)
  const r = await f.s.runtime.service.dmSend({ messageId, text: '在的', confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.verified, true)
  assert.equal(r.messageId, messageId)
  assert.equal(r.conversation.id, dmConversationId('路人'))
  assert.equal(r.conversation.name, '路人')
  assert.deepEqual(f.sent, ['在的'])
  cleanupDir(f.s.dir)
})

test('dm_send：conversationId / index / name 三种定位都可用', async () => {
  for (const selector of [
    { conversationId: dmConversationId('路人') },
    { index: 1 },
    { name: '路人' },
  ]) {
    const f = dmEnv()
    const r = await f.s.runtime.service.dmSend({ ...selector, text: '你好呀', confirm: true })
    assert.equal(r.ok, true, JSON.stringify(selector))
    assert.equal(r.name, '路人')
    assert.deepEqual(f.sent, ['你好呀'])
    cleanupDir(f.s.dir)
  }
})

test('dm_send：没有选择器 → E_BAD_ARG；重名 → E_AMBIGUOUS，不粘贴不发送', async () => {
  {
    const f = dmEnv()
    const r = await f.s.runtime.service.dmSend({ text: '你好', confirm: true })
    assert.equal(r.code, 'E_BAD_ARG')
    assert.equal(f.s.transport.pastes.length, 0)
    cleanupDir(f.s.dir)
  }
  {
    const f = dmEnv({
      conversations: [
        { name: '饲养员', preview: '一', time: '刚刚' },
        { name: '饲养员', preview: '二', time: '刚刚' },
      ],
      messages: {},
    })
    const r = await f.s.runtime.service.dmSend({ name: '饲养员', text: '你好', confirm: true })
    assert.equal(r.code, 'E_AMBIGUOUS')
    assert.equal(r.candidates.length, 2)
    assert.equal(f.s.transport.pastes.length, 0)
    assert.equal(f.s.transport.calls.filter((c) => c.cmd === 'click' && c.selector === DM_SEND).length, 0)
    cleanupDir(f.s.dir)
  }
})

test('dm_send：messageId 不存在 / 指向自己 / 与 conversationId 不一致 → 拒绝且不发送', async () => {
  {
    const f = dmEnv()
    const read = await f.s.runtime.service.dmRead({ conversationId: dmConversationId('路人') })
    const fakeId = `${dmConversationId('路人')}.m_ffffffffffff`
    const r = await f.s.runtime.service.dmSend({ messageId: fakeId, text: '在的', confirm: true })
    assert.equal(r.code, 'E_NOT_FOUND')
    assert.equal(f.s.transport.pastes.length, 0)
    assert.equal(f.sent.length, 0)
    assert.ok(read)
    cleanupDir(f.s.dir)
  }
  {
    const f = dmEnv()
    const read = await f.s.runtime.service.dmRead({ conversationId: dmConversationId('路人') })
    const own = read.items.find((m) => m.fromMe)
    // 夹具里没有自己的消息：补一条后重新读
    assert.equal(own, undefined)
    f.messages['路人'].push({ text: '在的', fromMe: true })
    const reread = await f.s.runtime.service.dmRead({ conversationId: dmConversationId('路人') })
    const ownId = reread.items.find((m) => m.fromMe).id
    const r = await f.s.runtime.service.dmSend({ messageId: ownId, text: '嗯', confirm: true })
    assert.equal(r.code, 'E_BAD_ARG')
    assert.equal(f.s.transport.pastes.length, 0)
    cleanupDir(f.s.dir)
  }
  {
    const f = dmEnv()
    const read = await f.s.runtime.service.dmRead({ conversationId: dmConversationId('路人') })
    const messageId = firstInboundId(read)
    const r = await f.s.runtime.service.dmSend({
      messageId,
      conversationId: dmConversationId('饲养员'),
      text: '在的',
      confirm: true,
    })
    assert.equal(r.code, 'E_BAD_ARG')
    assert.equal(f.s.transport.pastes.length, 0)
    cleanupDir(f.s.dir)
  }
})

test('dm_send：主人别名（草荧）可主动发；普通会话无对方消息 → E_STALE', async () => {
  {
    const f = dmEnv({
      conversations: [{ name: '草荧', preview: '', time: '' }],
      messages: { 草荧: [] },
      rawConfig: { dmOwnerAliases: ['饲养员', '草荧'] },
    })
    const r = await f.s.runtime.service.dmSend({ name: '草荧', text: '主动找你', confirm: true })
    assert.equal(r.ok, true)
    assert.equal(r.conversation.isOwner, true)
    assert.deepEqual(f.sent, ['主动找你'])
    cleanupDir(f.s.dir)
  }
  {
    const f = dmEnv({
      conversations: [{ name: '路人', preview: '', time: '' }],
      messages: { 路人: [] },
    })
    const r = await f.s.runtime.service.dmSend({ name: '路人', text: '在吗', confirm: true })
    assert.equal(r.code, 'E_STALE')
    assert.equal(f.s.transport.pastes.length, 0)
    cleanupDir(f.s.dir)
  }
})

test('dm_send：缺 confirm 时即使 selector 精确也不触网', async () => {
  const f = dmEnv()
  const read = await f.s.runtime.service.dmRead({ conversationId: dmConversationId('路人') })
  const r = await f.s.runtime.service.dmSend({ messageId: firstInboundId(read), text: '在的' })
  assert.equal(r.code, 'E_CONFIRM_REQUIRED')
  assert.equal(f.s.transport.pastes.length, 0)
  assert.equal(f.s.transport.calls.filter((c) => c.cmd === 'click' && c.selector === DM_SEND).length, 0)
  cleanupDir(f.s.dir)
})

test('dmPollConversations：只读扫描不写审计、不点开会话；结果带 id/index/isOwner', async () => {
  const f = dmEnv({ ownerFile: '饲养员\n' })
  const audit = join(f.s.dir, 'audit.jsonl')
  const r = await f.s.runtime.service.dmPollConversations({ limit: 20, keepOpen: true })
  assert.equal(r.ok, true)
  assert.equal(r.count, 2)
  assert.equal(r.items[0].id, dmConversationId('饲养员'))
  assert.equal(r.items[0].index, 0)
  assert.equal(r.items[0].isOwner, true)
  assert.equal(r.items[1].isOwner, false)
  assert.equal(f.s.transport.calls.filter((c) => c.cmd === 'click' && c.selector === DM_ITEM).length, 0)
  assert.equal(existsSync(audit), false)
  cleanupDir(f.s.dir)
})

test('service.dmWatch：runtime 接线可用；首次基线、新预览产生事件、owner 标注', async () => {
  const f = dmEnv({
    conversations: [{ name: '路人', preview: '你好', time: '30分钟前' }],
    messages: { 路人: [{ text: '你好', fromMe: false }] },
    rawConfig: { dmOwnerAliases: ['饲养员', '草荧'] },
  })
  const first = await f.s.runtime.service.dmWatch({ action: 'poll' })
  assert.equal(first.ok, true)
  assert.equal(first.tick.baseline, true)
  assert.deepEqual(first.events, [])

  // 直接改夹具里的会话预览，模拟对方新消息
  const got = []
  const unsubscribe = f.s.runtime.service.dmWatchSubscribe((e) => got.push(e))
  f.conversations[0] = { name: '饲养员', preview: '在吗', time: '刚刚' }
  const pending = await f.s.runtime.service.dmWatch({ action: 'poll' })
  assert.equal(pending.count, 0, '默认 confirmTicks=2：第一次只进候选')
  const second = await f.s.runtime.service.dmWatch({ action: 'poll' })
  assert.equal(second.ok, true)
  assert.equal(second.count, 1)
  assert.equal(second.events[0].owner, true)
  assert.equal(second.events[0].conversationName, '饲养员')
  assert.equal(second.events[0].text, '在吗')
  assert.equal(second.events[0].sender, '饲养员')
  assert.equal(got.length, 1)
  assert.equal(got[0].owner, true)
  unsubscribe()

  const status = await f.s.runtime.service.dmWatch({ action: 'status' })
  assert.equal(status.ok, true)
  assert.equal(status.primed, true)
  assert.equal(status.eventsEmitted, 1)

  const stop = await f.s.runtime.service.dmWatch({ action: 'stop' })
  assert.equal(stop.ok, true)
  assert.equal(stop.stopped, true)
  cleanupDir(f.s.dir)
})

test('dm_read：没有任何选择器 → E_BAD_ARG，不触网', async () => {
  const f = dmEnv()
  const r = await f.s.runtime.service.dmRead({})
  assert.equal(r.code, 'E_BAD_ARG')
  assert.equal(f.s.transport.calls.length, 0)
  cleanupDir(f.s.dir)
})
