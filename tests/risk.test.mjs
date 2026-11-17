/**
 * 风控（短信验证）相关：通知主人（QQ 优先/邮件兜底/节流） + 填入主人提供的验证码。
 * 全部 fake ctx / fake transport，不连真服务。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { detailOf, setup } from './helpers.mjs'

const { createOwnerNotifier } = await import('../lib/index.js')

function fakeCtx({ qqSend = true, qqOk = true, mailOk = true, owners = ['owner@example.com'] } = {}) {
  const calls = { qq: [], mail: [] }
  const services = {
    dyChannel: {
      canSend: () => qqSend,
      async sendText(payload) {
        calls.qq.push(payload)
        return qqOk ? { ok: true } : { ok: false, code: 'QQ_FAIL' }
      },
    },
    dyMail: {
      ownerAddresses: () => owners,
      async send(payload) {
        calls.mail.push(payload)
        return mailOk ? { ok: true } : { ok: false, code: 'MAIL_FAIL' }
      },
    },
  }
  return { calls, get: (name) => services[name] ?? null }
}

const baseCfg = { riskNotifyEnabled: true, ownerQqId: '2971030080', riskNotifyMinGapMs: 600000, riskNotifyChannel: 'qq' }

test('风控通知：QQ 成功即发一条；10 分钟内重发被节流', async () => {
  const ctx = fakeCtx()
  let now = 1_000_000
  const notify = createOwnerNotifier({ ctx, cfg: baseCfg, clock: () => now })
  const r1 = await notify({ text: '【抖音风控】需要验证码' })
  assert.equal(r1.ok, true)
  assert.equal(ctx.calls.qq.length, 1)
  assert.equal(ctx.calls.qq[0].contactId, '2971030080')
  assert.equal(ctx.calls.qq[0].kind, 'private')

  now += 60_000
  const r2 = await notify({ text: '再来一条' })
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'E_THROTTLED')
  assert.equal(ctx.calls.qq.length, 1, '节流期内不再发')

  now += 600_000
  const r3 = await notify({ text: '过窗再发' })
  assert.equal(r3.ok, true)
  assert.equal(ctx.calls.qq.length, 2)
})

test('风控通知：QQ 不可用/失败时回退邮件；都没有地址则 ok=false', async () => {
  const ctx1 = fakeCtx({ qqSend: false })
  const rt1 = createOwnerNotifier({ ctx: ctx1, cfg: baseCfg, clock: () => 1 })
  const r1 = await rt1({ text: '风控' })
  assert.equal(r1.ok, true)
  assert.equal(ctx1.calls.qq.length, 0)
  assert.equal(ctx1.calls.mail.length, 1)
  assert.equal(ctx1.calls.mail[0].to, 'owner@example.com')

  const ctx2 = fakeCtx({ qqSend: false, owners: [] })
  const rt2 = createOwnerNotifier({ ctx: ctx2, cfg: baseCfg, clock: () => 1 })
  const r2 = await rt2({ text: '风控' })
  assert.equal(r2.ok, false)
  assert.equal(ctx2.calls.mail.length, 0)
  assert.ok(r2.results.some((x) => x.code === 'E_NO_OWNER_ADDRESS'))
})

test('风控通知：disabled 时直接返回 E_DISABLED，不发任何消息', async () => {
  const ctx = fakeCtx()
  const notify = createOwnerNotifier({ ctx, cfg: { ...baseCfg, riskNotifyEnabled: false }, clock: () => 1 })
  const r = await notify({ text: '风控' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_DISABLED')
  assert.equal(ctx.calls.qq.length + ctx.calls.mail.length, 0)
})

test('sms_code：没面板 → E_NOT_FOUND；缺 confirm → E_CONFIRM_REQUIRED；非数字 → E_BAD_ARG', async () => {
  const s = setup({
    handlers: {
      ping: () => ({ ok: true, cmd: 'ping', result: { proto: '1.0', browser: true, pages: 1, capabilities: ['type', 'probe', 'waitFor', 'netArm', 'netTake', 'pressHotkeys'] } }),
      count: () => ({ ok: true, cmd: 'count', result: 0 }),
    },
  })
  const noConfirm = await s.runtime.service.smsCode({ code: '123456' })
  assert.equal(noConfirm.ok, false)
  assert.equal(noConfirm.code, 'E_CONFIRM_REQUIRED')
  const bad = await s.runtime.service.smsCode({ code: 'abc', confirm: true })
  assert.equal(bad.code, 'E_BAD_ARG')
  const none = await s.runtime.service.smsCode({ code: '123456', confirm: true })
  assert.equal(none.ok, false)
  assert.equal(none.code, 'E_NOT_FOUND')
})

test('sms_code：有面板 → 填码 + 点验证 + 面板消失 = verified', async () => {
  let panel = 1
  const s = setup({
    handlers: {
      ping: () => ({ ok: true, cmd: 'ping', result: { proto: '1.0', browser: true, pages: 1, capabilities: ['type', 'probe', 'waitFor', 'netArm', 'netTake', 'pressHotkeys'] } }),
      count: () => ({ ok: true, cmd: 'count', result: panel }),
      type: () => ({ ok: true, cmd: 'type', result: { via: 'fill', chars: 6 } }),
      text: () => ({ ok: true, cmd: 'text', result: '123456' }),
      click: () => {
        panel = 0
        return { ok: true, cmd: 'click', result: { ok: true, ms: 5 } }
      },
    },
  })
  const r = await s.runtime.service.smsCode({ code: '123456', confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.verified, true)
  const typeCall = s.transport.calls.find((c) => c.cmd === 'type')
  assert.equal(typeCall.text, '123456', '只把码当纯文本填进去')
  const clickCall = s.transport.calls.find((c) => c.cmd === 'click')
  assert.match(clickCall.selector, /验证/)
  cleanup: {}
})
