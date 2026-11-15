/**
 * 测试脚手架：假时钟、假 transport、假 ctx/tools、假 SSH 子进程。
 * 原则：不真连 SSH、不碰生产目录、不写生产审计。
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRuntime } from '../lib/index.js'

export function makeMp4({ timescale = 1000, duration = 12300 } = {}) {
  const ftyp = Buffer.from([0, 0, 0, 16, ...Buffer.from('ftypisom'), 0, 0, 2, 0])
  const mvhd = Buffer.alloc(40)
  mvhd.writeUInt32BE(40, 0)
  mvhd.write('mvhd', 4, 'latin1')
  mvhd.writeUInt32BE(timescale, 20)
  mvhd.writeUInt32BE(duration, 24)
  return Buffer.concat([ftyp, mvhd])
}

export function makeFakeMemory({ fail = false } = {}) {
  const calls = []
  return {
    calls,
    async addEpisode(input) {
      calls.push(input)
      if (fail) throw new Error('memory unavailable')
      return { id: calls.length }
    },
  }
}

export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-douyin-screenshot'),
])

/** 2026-11-06 是周五（Asia/Shanghai） */
export const FRIDAY_EVENING = '2026-11-06T18:30:00+08:00'

export function makeClock(startIso = FRIDAY_EVENING) {
  let now = Date.parse(startIso)
  return {
    now: () => now,
    set: (ms) => {
      now = ms
    },
    advance: (ms) => {
      now += ms
    },
    iso: () => new Date(now).toISOString(),
  }
}

export function makeTmpDir(label = 'case') {
  return mkdtempSync(join(tmpdir(), `dsh-douyin-${label}-`))
}

export function cleanupDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 测试清理失败不影响断言
  }
}

export function touchFile(file, content = 'x') {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** 默认应答：模拟远程桥的一问一答 */
export function defaultResponse(payload) {
  switch (payload.cmd) {
    case 'ping':
      return { ok: true, cmd: 'ping', result: { proto: '1.0', browser: true, pages: 1 } }
    case 'title':
      return { ok: true, cmd: 'title', result: '抖音-记录美好生活' }
    case 'url':
      return { ok: true, cmd: 'url', result: 'https://www.douyin.com/' }
    case 'open':
      return { ok: true, cmd: 'open', result: { url: payload.url, status: 200, title: '抖音' } }
    case 'list':
      return { ok: true, cmd: 'list', result: [] }
    case 'count':
      return { ok: true, cmd: 'count', result: 0 }
    case 'screenshot':
      return { ok: true, cmd: 'screenshot', result: { file: '/persistent/cdp/shots/shot-1.png' } }
    case 'scroll':
      return { ok: true, cmd: 'scroll', result: true }
    case 'press':
      return { ok: true, cmd: 'press', result: true }
    case 'click':
      return { ok: true, cmd: 'click', result: true }
    case 'assets':
      return { ok: true, cmd: 'assets', result: true }
    case 'html':
      return { ok: true, cmd: 'html', result: '' }
    case 'text':
      return { ok: true, cmd: 'text', result: '' }
    default:
      return { ok: true, cmd: payload.cmd, result: {} }
  }
}

/** 记录调用参数的假 sleep；测试里默认立即返回，不真的等 800ms */
export function makeSleep() {
  const calls = []
  const sleep = async (ms) => {
    calls.push(ms)
  }
  sleep.calls = calls
  return sleep
}

export function makeFakeTransport(handlers = {}) {
  const calls = []
  const readFileCalls = []
  let active = 0
  let maxActive = 0

  const transport = {
    name: 'fake',
    calls,
    readFileCalls,
    readFileResult: PNG,
    handlers,
    get maxActive() {
      return maxActive
    },
    async request(payload, opts = {}) {
      active += 1
      maxActive = Math.max(maxActive, active)
      calls.push({ ...payload, __timeoutMs: opts.timeoutMs })
      try {
        const h = handlers[payload.cmd]
        if (typeof h === 'function') return await h(payload, opts)
        if (h !== undefined) return h
        return defaultResponse(payload)
      } finally {
        active -= 1
      }
    },
    async readFile(path, opts = {}) {
      readFileCalls.push({ path, ...opts })
      const r = transport.readFileResult
      return typeof r === 'function' ? r(path, opts) : r
    },
    typedTexts: [],
    async typeText(text, opts = {}) {
      transport.typedTexts.push({ text, ...opts })
      return true
    },
    pressKeys: [],
    async pressKey(key, opts = {}) {
      transport.pressKeys.push({ key, ...opts })
      return true
    },
    pastes: [],
    async pasteText(text, opts = {}) {
      transport.pastes.push({ text, ...opts })
      return true
    },
    clearTexts: [],
    async clearText(opts = {}) {
      transport.clearTexts.push(opts)
      return true
    },
    focusCalls: [],
    async focusPage(opts = {}) {
      transport.focusCalls.push(opts)
      return true
    },
  }
  return transport
}

export function makeCtx({ tools = true, dyHome = null, dyMemory = null } = {}) {
  const registry = new Map()
  const logs = []
  const provided = new Map()
  const toolService = tools
    ? {
        register(def) {
          if (!def?.name) throw new Error('tool name required')
          if (registry.has(def.name)) throw new Error(`duplicate tool: ${def.name}`)
          registry.set(def.name, def)
        },
      }
    : null

  const ctx = {
    get(name) {
      if (name === 'tools') return toolService
      if (name === 'dyHome') return dyHome
      if (name === 'dyMemory') return dyMemory
      return undefined
    },
    provide(name, value) {
      provided.set(name, value)
    },
    logger() {
      return {
        info: (m) => logs.push(['info', String(m)]),
        warn: (m) => logs.push(['warn', String(m)]),
        error: (m) => logs.push(['error', String(m)]),
        debug: () => {},
      }
    },
  }
  return { ctx, registry, logs, provided }
}

export function ownerExec({
  id = 'home-session-1',
  cwd = '/sdcard/DSHA/生活/数据/home',
  header = {},
} = {}) {
  const h = { id, cwd, ...header }
  return { agent: { session: { id, header: h } } }
}

export function subagentExec() {
  return {
    agent: {
      session: {
        id: 'sub-1',
        header: { id: 'sub-1', cwd: '/sdcard/DSHA/生活/数据/home', delegationDepth: 1 },
      },
    },
  }
}

export function callTool(registry, toolName, args = {}, exec = ownerExec()) {
  const def = registry.get(toolName)
  if (!def) throw new Error(`tool not registered: ${toolName}`)
  return def.execute(args, exec)
}

export function detailOf(result) {
  return JSON.parse(result.detail)
}

/**
 * 创建一个带假 transport / 假时钟 / 临时目录的运行时，并注册工具。
 */
export function setup({
  rawConfig = {},
  handlers = {},
  clock = null,
  ctxOptions = {},
  tools = true,
  sleep = null,
  fetchImpl = null,
} = {}) {
  const dir = makeTmpDir('runtime')
  const clock0 = clock ?? makeClock()
  const transport = makeFakeTransport(handlers)
  const sleep0 = sleep ?? makeSleep()
  const logs = []
  const logger = {
    info: (m) => logs.push(String(m)),
    warn: (m) => logs.push(String(m)),
    error: (m) => logs.push(String(m)),
    debug: () => {},
  }
  const runtime = createRuntime({
    rawConfig: {
      auditFile: join(dir, 'audit.jsonl'),
      screenshotDir: join(dir, 'shots'),
      downloadDir: join(dir, 'downloads'),
      minIntervalMs: 0, // 测试默认不卡最小间隔；需要时由单测显式覆盖
      ...rawConfig,
    },
    transport,
    clock: clock0.now,
    logger,
    sleep: sleep0,
    ...(typeof fetchImpl === 'function' ? { fetchImpl } : {}),
  })
  const { ctx, registry, logs: ctxLogs, provided } = makeCtx({ ...ctxOptions, tools })
  runtime.registerTools(ctx)
  for (const line of ctxLogs) logs.push(line) // ctx 侧日志一次性并入，logger 数组保持 live
  return {
    dir,
    transport,
    clock: clock0,
    sleep: sleep0,
    runtime,
    ctx,
    registry,
    logs,
    provided,
  }
}

/** 造一个假的 SSH 子进程；默认在下个微任务里发 stdout/stderr 并 close */
export function makeFakeSpawn({
  stdout = '',
  stderr = '',
  code = 0,
  hold = false,
  onKill = null,
} = {}) {
  const calls = []
  const spawnImpl = (cmd, args, opts) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = {
      written: '',
      ended: false,
      on() {},
      end(chunk = '') {
        this.written += String(chunk ?? '')
        this.ended = true
      },
    }
    child.killed = false
    child.kill = (signal) => {
      child.killed = true
      if (onKill) onKill(child, signal)
    }
    if (!hold) {
      queueMicrotask(() => {
        if (stdout && stdout.length) child.stdout.emit('data', Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
        if (stderr && stderr.length) child.stderr.emit('data', Buffer.from(stderr))
        child.emit('close', code, null)
      })
    }
    calls.push({ cmd, args, opts, child })
    return child
  }
  spawnImpl.calls = calls
  return spawnImpl
}

/** 传输层测试用的完整 cfg（只含 SshExecTransport 读取的字段） */
export function makeTransportCfg(dir, overrides = {}) {
  const key = join(dir, 'id_ed25519')
  const knownHosts = join(dir, 'known_hosts')
  touchFile(key)
  touchFile(knownHosts)
  return {
    sshHost: '127.0.0.1',
    sshPort: 2222,
    sshUser: 'root',
    sshKeyPath: key,
    knownHosts,
    remoteNodeDir: '/manager/extensions/harness/program/node/bin',
    remoteClient: '/persistent/cdp/client-stdin.js',
    shotsDir: '/persistent/cdp/shots',
    openTimeoutMs: 120000,
    callTimeoutMs: 30000,
    maxScreenshotBytes: 2 * 1024 * 1024,
    ...overrides,
  }
}

export function fileExists(p) {
  return existsSync(p)
}
