import assert from 'node:assert'
import { resolveVideoTargetAsync } from '../lib/service.js'

let called = 0
const fake = async () => { called += 1; return { url: 'https://www.douyin.com/video/7686522928946482475?x=1' } }
const a = await resolveVideoTargetAsync({ url: 'https://v.douyin.com/Y3NcR0uLrpM/' }, { fetchImpl: fake })
assert.equal(a.videoId, '7686522928946482475')
assert.equal(called, 1)
const b = await resolveVideoTargetAsync({ url: 'https://www.iesdouyin.com/share/video/123456789/' })
assert.equal(b.videoId, '123456789')
let failed = false
try { await resolveVideoTargetAsync({ url: 'https://v.douyin.com/bad/' }, { fetchImpl: async () => ({ url: 'https://example.com/x' }) }) } catch (e) { failed = e.code === 'E_BAD_URL' }
assert.equal(failed, true)
console.log(JSON.stringify({ ok: true, test: 'short-link' }))
