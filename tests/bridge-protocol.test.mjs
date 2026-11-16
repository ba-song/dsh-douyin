/**
 * 桥协议 v2 单测（不启动浏览器、不连 socket）：
 * - 纯函数：selector 校验 / netArm pattern 校验 / type 文本校验 / press 键名与焦点判定 / URL 归一化；
 * - 常量：click/waitFor/health 的夹取边界与 capabilities；
 * - 静态核对：dispatch 的 case 列表与 COMMANDS 完全一致（新命令都接了分支、老命令没丢）。
 *
 * 加载方式：package.json 是 type:module，而 bridge/cdp-bridge.js 是 CommonJS（线上由 node 直接跑），
 * 所以复制成 .cjs 再 require —— 这样断言纯函数完全不需要 Chromium。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', 'bridge', 'cdp-bridge.js')
const SRC_TEXT = fs.readFileSync(SRC, 'utf8')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-proto-'))
const tmpFile = path.join(tmpDir, 'cdp-bridge.cjs')
fs.copyFileSync(SRC, tmpFile)
const requireCjs = createRequire(import.meta.url)
const bridge = requireCjs(tmpFile)
const T = bridge.__test

process.on('exit', () => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

const codeOf = (fn) => {
  try {
    fn()
  } catch (error) {
    return error && error.code
  }
  return null
}

test('bridge __test 出口：纯函数齐全，且加载模块不会启动服务（main 有 require.main 守卫）', () => {
  const names = [
    'validateSelector', 'selectorOk', 'validatePatterns', 'normalizeProbeCounts',
    'normalizeWaitState', 'normalizeUrlForCompare', 'validateTypeText', 'validateKeysText',
    'normalizeTypeMode', 'normalizePressKey', 'isEditableDescriptor', 'isPlaywrightTimeout', 'clampInt',
  ]
  for (const name of names) assert.equal(typeof T[name], 'function', `缺少纯函数 ${name}`)
  assert.match(SRC_TEXT, /if \(require\.main === module\) \{\s*void main\(\);/)
  assert.doesNotMatch(SRC_TEXT, /^void main\(\);$/m, '末尾不能再有无条件 void main()')
})

test('A1 ping capabilities 含新能力位；COMMANDS 含新命令', () => {
  const caps = T.constants.CAPABILITIES
  for (const cap of ['health', 'probe', 'waitFor', 'netArm', 'netTake', 'type', 'pressHotkeys', 'clickTimeout', 'clickNoScroll', 'openReuse']) {
    assert.ok(caps.includes(cap), `capabilities 缺 ${cap}`)
  }
  const cmds = T.constants.COMMANDS
  for (const cmd of ['health', 'probe', 'waitFor', 'netArm', 'netTake', 'type']) {
    assert.ok(cmds.includes(cmd), `COMMANDS 缺 ${cmd}`)
  }
  // 老命令一个都不能少
  for (const legacy of ['ping', 'open', 'tabs', 'title', 'url', 'text', 'html', 'count', 'list', 'links', 'click', 'scroll', 'press', 'assets', 'jsRead', 'jsWatch', 'jsClick', 'rect', 'activate', 'screenshot', 'restart']) {
    assert.ok(cmds.includes(legacy), `老命令丢了：${legacy}`)
  }
})

test('dispatch 静态核对：case 列表与 COMMANDS 一一对应（无遗漏、无重复、无多余）', () => {
  const start = SRC_TEXT.indexOf('switch (cmd) {')
  assert.ok(start > 0, '找不到 dispatch 的 switch (cmd)')
  const body = SRC_TEXT.slice(start, SRC_TEXT.indexOf('default:', start))
  const cases = [...body.matchAll(/case '([A-Za-z0-9_]+)':/g)].map((m) => m[1])
  const uniq = new Set(cases)
  assert.equal(uniq.size, cases.length, `dispatch 有重复 case：${cases.join(',')}`)
  const known = new Set(T.constants.COMMANDS)
  const missing = [...known].filter((cmd) => !uniq.has(cmd))
  const extra = [...uniq].filter((cmd) => !known.has(cmd))
  assert.deepEqual(missing, [], `COMMANDS 里有命令没接进 dispatch：${missing.join(',')}`)
  assert.deepEqual(extra, [], `dispatch 有不在 COMMANDS 的 case：${extra.join(',')}`)
})

test('A3 probe：counts 归一（≤8、保序、原串作 key）；selector 静态校验', () => {
  assert.deepEqual(T.normalizeProbeCounts(undefined), [])
  assert.deepEqual(
    T.normalizeProbeCounts(['[data-e2e="video-player-digg"]', ' #login-panel ']),
    ['[data-e2e="video-player-digg"]', '#login-panel'],
  )
  const nine = Array.from({ length: 9 }, (_, i) => `#s${i}`)
  assert.equal(codeOf(() => T.normalizeProbeCounts(nine)), 'E_BAD_ARG')
  assert.equal(codeOf(() => T.normalizeProbeCounts('[x]')), 'E_BAD_ARG')

  assert.equal(T.selectorOk('[data-e2e="video-player-digg"]'), true)
  assert.equal(T.selectorOk('text=删除评论'), true)
  assert.equal(T.selectorOk('   '), false)
  assert.equal(T.selectorOk('a\u0000b'), false)
  assert.equal(T.selectorOk('x'.repeat(T.constants.SELECTOR_MAX_LEN + 1)), false)
  assert.equal(T.validateSelector('  #login-panel  '), '#login-panel')
  assert.equal(codeOf(() => T.validateSelector('')), 'E_BAD_SELECTOR')
  assert.equal(codeOf(() => T.validateSelector('x'.repeat(T.constants.SELECTOR_MAX_LEN + 1))), 'E_BAD_SELECTOR')
})

test('A4 waitFor：state 白名单/缺省 visible；timeoutMs 夹在 50..8000', () => {
  assert.equal(T.normalizeWaitState(undefined), 'visible')
  assert.equal(T.normalizeWaitState('VISIBLE'), 'visible')
  assert.equal(T.normalizeWaitState('detached'), 'detached')
  assert.deepEqual([...T.constants.WAIT_STATES], ['attached', 'detached', 'visible', 'hidden'])
  assert.equal(codeOf(() => T.normalizeWaitState('gone')), 'E_BAD_ARG')
  const c = T.constants
  assert.equal(c.WAIT_TIMEOUT_MIN, 50)
  assert.equal(c.WAIT_TIMEOUT_MAX, 8000)
  assert.equal(c.WAIT_TIMEOUT_DEFAULT, 2500)
  assert.equal(T.clampInt(10, c.WAIT_TIMEOUT_MIN, c.WAIT_TIMEOUT_MAX, c.WAIT_TIMEOUT_DEFAULT), 50)
  assert.equal(T.clampInt(99999, c.WAIT_TIMEOUT_MIN, c.WAIT_TIMEOUT_MAX, c.WAIT_TIMEOUT_DEFAULT), 8000)
  assert.equal(T.clampInt('abc', c.WAIT_TIMEOUT_MIN, c.WAIT_TIMEOUT_MAX, c.WAIT_TIMEOUT_DEFAULT), 2500)
})

test('A5 netArm：pattern 白名单正则、≤8 个、去重保序；非法 E_BAD_PATTERN / E_BAD_ARG', () => {
  const ok = T.validatePatterns(['/aweme/v1/web/commit/item/digg/', '/aweme/v1/web/comment/publish/', 'collect'])
  assert.deepEqual(ok, ['/aweme/v1/web/commit/item/digg/', '/aweme/v1/web/comment/publish/', 'collect'])
  assert.deepEqual(T.validatePatterns(['a', 'a', 'b']), ['a', 'b'])
  assert.equal(codeOf(() => T.validatePatterns(['has space'])), 'E_BAD_PATTERN')
  assert.equal(codeOf(() => T.validatePatterns(['点赞接口'])), 'E_BAD_PATTERN')
  assert.equal(codeOf(() => T.validatePatterns(['x'.repeat(121)])), 'E_BAD_PATTERN')
  assert.equal(codeOf(() => T.validatePatterns(['javascript:alert(1)'])), 'E_BAD_PATTERN')
  assert.equal(codeOf(() => T.validatePatterns(Array.from({ length: 9 }, (_, i) => `/p${i}`))), 'E_BAD_PATTERN')
  assert.equal(codeOf(() => T.validatePatterns([])), 'E_BAD_ARG')
  assert.equal(codeOf(() => T.validatePatterns(undefined)), 'E_BAD_ARG')
  assert.equal(codeOf(() => T.validatePatterns('/x/')), 'E_BAD_ARG')
  assert.equal(T.constants.NET_MAX_EVENTS, 200)
  assert.equal(T.constants.NET_MAX_PATTERNS, 8)
})

test('A7 open：URL 归一化忽略 hash 与末尾 /，保留 query；normalizeDouyinUrl 仍限 http(s)+抖音域', () => {
  const cmp = T.normalizeUrlForCompare
  assert.equal(cmp('https://www.douyin.com/chat'), cmp('https://www.douyin.com/chat/'))
  assert.equal(cmp('https://www.douyin.com/?recommend=1&from_nav=1#top'), cmp('https://www.douyin.com?recommend=1&from_nav=1'))
  assert.notEqual(cmp('https://www.douyin.com/chat'), cmp('https://www.douyin.com/?recommend=1&from_nav=1'))
  assert.equal(cmp(''), '')
  assert.equal(cmp('https://www.douyin.com/#/video/1'), 'https://www.douyin.com')
  assert.equal(T.normalizeDouyinUrl('http://www.douyin.com/video/1'), 'https://www.douyin.com/video/1')
  assert.equal(codeOf(() => T.normalizeDouyinUrl('')), 'E_BAD_URL')
  assert.equal(codeOf(() => T.normalizeDouyinUrl('https://evil.example.com/x')), 'E_BAD_URL')
  assert.equal(codeOf(() => T.normalizeDouyinUrl('ftp://www.douyin.com/x')), 'E_BAD_URL')
})

test('A6 click：timeout 夹取边界与默认值（非 force 3000 / force 1500 / scroll 600）', () => {
  const c = T.constants
  assert.equal(c.CLICK_TIMEOUT_DEFAULT, 3000)
  assert.equal(c.CLICK_TIMEOUT_FORCE_DEFAULT, 1500)
  assert.equal(c.CLICK_TIMEOUT_MIN, 200)
  assert.equal(c.CLICK_TIMEOUT_MAX, 15000)
  assert.equal(c.CLICK_SCROLL_TIMEOUT, 600)
  assert.equal(T.clampInt(50, c.CLICK_TIMEOUT_MIN, c.CLICK_TIMEOUT_MAX, c.CLICK_TIMEOUT_DEFAULT), 200)
  assert.equal(T.clampInt(60000, c.CLICK_TIMEOUT_MIN, c.CLICK_TIMEOUT_MAX, c.CLICK_TIMEOUT_DEFAULT), 15000)
  assert.equal(T.clampInt(undefined, c.CLICK_TIMEOUT_MIN, c.CLICK_TIMEOUT_MAX, c.CLICK_TIMEOUT_FORCE_DEFAULT), 1500)
})

test('A2 health：单 role evaluate 上限 400ms', () => {
  assert.equal(T.constants.HEALTH_EVAL_TIMEOUT, 400)
})

test('A9 type：text 纯文本/≤2000/空串可当"只清空"；keys 模式只允许可打印 ASCII', () => {
  assert.equal(T.validateTypeText('@豆包 你好'), '@豆包 你好')
  assert.equal(T.validateTypeText(''), '')
  assert.equal(T.charCount('@豆包 你好'), 6)
  assert.equal(T.charCount('😀ab'), 3)
  assert.equal(T.validateTypeText('x'.repeat(T.constants.TYPE_MAX_CHARS)).length, 2000)
  assert.equal(codeOf(() => T.validateTypeText('x'.repeat(T.constants.TYPE_MAX_CHARS + 1))), 'E_BAD_ARG')
  assert.equal(codeOf(() => T.validateTypeText(123)), 'E_BAD_ARG')
  assert.equal(codeOf(() => T.validateTypeText(undefined)), 'E_BAD_ARG')

  assert.equal(T.validateKeysText('z@doubao.com'), 'z@doubao.com')
  assert.equal(T.validateKeysText(''), '')
  assert.equal(codeOf(() => T.validateKeysText('中文')), 'E_BAD_TEXT')
  assert.equal(codeOf(() => T.validateKeysText('abc\n')), 'E_BAD_TEXT')
  assert.equal(codeOf(() => T.validateKeysText('x'.repeat(T.constants.TYPE_MAX_CHARS + 1))), 'E_BAD_ARG')

  assert.equal(T.normalizeTypeMode(undefined), 'auto')
  assert.equal(T.normalizeTypeMode('FILL'), 'fill')
  assert.deepEqual([...T.constants.TYPE_MODES], ['auto', 'fill', 'insert', 'keys'])
  assert.equal(codeOf(() => T.normalizeTypeMode('paste')), 'E_BAD_ARG')
  assert.equal(T.normalizeNth(undefined), 0)
  assert.equal(T.normalizeNth('2'), 2)
  assert.equal(codeOf(() => T.normalizeNth(-1)), 'E_BAD_NTH')
  assert.equal(codeOf(() => T.normalizeNth('x')), 'E_BAD_NTH')
})

test('A10 press：白名单 z/c/x + 命名键；输入框聚焦判定（E_INPUT_FOCUSED 的纯函数依据）', () => {
  assert.equal(T.normalizePressKey('z'), 'z')
  assert.equal(T.normalizePressKey('Z'), 'z')
  assert.equal(T.normalizePressKey('c'), 'c')
  assert.equal(T.normalizePressKey('X'), 'x')
  assert.equal(T.normalizePressKey('Enter'), 'Enter')
  assert.equal(T.normalizePressKey('Escape'), 'Escape')
  assert.equal(T.normalizePressKey('ArrowDown'), 'ArrowDown')
  assert.deepEqual([...T.constants.PRESS_HOTKEY_CHARS], ['z', 'c', 'x'])
  assert.equal(codeOf(() => T.normalizePressKey('q')), 'E_BAD_KEY')
  assert.equal(codeOf(() => T.normalizePressKey('')), 'E_BAD_KEY')
  assert.equal(codeOf(() => T.normalizePressKey('enter')), 'E_BAD_KEY')

  assert.equal(T.isEditableDescriptor({ tagName: 'INPUT', isContentEditable: false, editableAncestor: false }), true)
  assert.equal(T.isEditableDescriptor({ tagName: 'textarea', isContentEditable: false, editableAncestor: false }), true)
  assert.equal(T.isEditableDescriptor({ tagName: 'div', isContentEditable: true, editableAncestor: false }), true)
  assert.equal(T.isEditableDescriptor({ tagName: 'span', isContentEditable: false, editableAncestor: true }), true)
  assert.equal(T.isEditableDescriptor({ tagName: 'div', isContentEditable: false, editableAncestor: false }), false)
  assert.equal(T.isEditableDescriptor({ tagName: '', isContentEditable: false, editableAncestor: false }), false)
  assert.equal(T.isEditableDescriptor(null), false)
  assert.equal(T.isEditableDescriptor(undefined), false)
})

test('超时错误识别：waitFor 超时算 matched:false，崩溃/其它错误仍抛出', () => {
  assert.equal(T.isPlaywrightTimeout(Object.assign(new Error('locator.waitFor: Timeout 2500ms exceeded.'), { name: 'TimeoutError' })), true)
  assert.equal(T.isPlaywrightTimeout(Object.assign(new Error('Timeout 5000ms exceeded'), {})), true)
  assert.equal(T.isPlaywrightTimeout(new Error('Target crashed')), false)
  assert.equal(T.isPlaywrightTimeout(new Error('Unknown engine "x" while parsing selector')), false)
})
