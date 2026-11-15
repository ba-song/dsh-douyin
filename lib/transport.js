/**
 * dsh-douyin 传输层（v1：SshExecTransport）。
 *
 * 约定（约定接口，由远程另一个任务部署服务端）：
 *   ssh -i <key> -p <port> -o BatchMode=yes -o StrictHostKeyChecking=yes
 *       -o UserKnownHostsFile=<known_hosts> <user>@<host>
 *       "PATH=<remoteNodeDir>:$PATH node <remoteClient>"
 *   - 请求 JSON 只走 stdin（一行，不拼 shell）；
 *   - 读 stdout 一行 JSON；
 *   - 超时杀子进程；失败不自动重放。
 *
 * 重要：本模块 import 时零副作用——不连 SSH、不起子进程、不读远程。
 * 密钥/known_hosts 的检查也推迟到第一次 request/readFile（preflight）。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { DouyinError, clip } from './errors.js'

const MAX_STDERR = 8 * 1024
/** 写操作快捷键白名单（抖音网页版：Z=点赞、C=收藏、X=评论） */
export const WRITE_KEYS = Object.freeze(['z', 'x', 'c'])
const ACTIVATE_CHROME = 'wid=$(xdotool search --onlyvisible --name "Google Chrome|Chromium|抖音|Douyin" 2>/dev/null | head -n1); [ -n "$wid" ] && xdotool windowactivate --sync "$wid" >/dev/null 2>&1 || true; '

const MAX_JSON_BYTES = 8 * 1024 * 1024
const REMOTE_PATH_RE = /^\/[A-Za-z0-9._/-]+$/

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

export function firstJsonLine(text) {
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim()
    if (s) return s
  }
  return ''
}

export function classifySpawnError(e) {
  if (e?.code === 'ENOENT') {
    return new DouyinError('E_BRIDGE_DOWN', '本机 ssh 命令不存在或不可执行')
  }
  if (e?.code === 'EACCES') {
    return new DouyinError('E_SSH_AUTH', 'ssh 不可执行，或私钥权限不足')
  }
  return new DouyinError('E_BRIDGE_DOWN', `SSH 启动失败：${clip(e?.message ?? e, 300)}`)
}

export function classifyExit(code, stderr, { bridge = false } = {}) {
  const msg = String(stderr ?? '')
  const hint = clip(msg, 300)
  if (code === 255 || /^ssh:/m.test(msg)) {
    if (
      /permission denied|publickey|host key verification failed|too many authentication failures|no mutual signature|bad permissions/i.test(
        msg,
      )
    ) {
      return new DouyinError('E_SSH_AUTH', `SSH 认证/主机校验失败${hint ? `：${hint}` : ''}`)
    }
    return new DouyinError('E_BRIDGE_DOWN', `SSH 连接失败${hint ? `：${hint}` : ''}`)
  }
  if (bridge && /no such file|not found|cannot find module|ENOENT/i.test(msg)) {
    return new DouyinError('E_BRIDGE_DOWN', `远程桥客户端不可用${hint ? `：${hint}` : ''}`)
  }
  return new DouyinError('E_REMOTE_IO', `远程命令失败（exit=${code}）${hint ? `：${hint}` : ''}`)
}

/**
 * 只允许取回远程截图目录下的 PNG；路径来自桥的返回值，仍按白名单校验。
 * @returns {string} 规范化后的远程路径
 */
export function assertSafeShotPath(remotePath, shotsDir) {
  const base = String(shotsDir ?? '').replace(/\/+$/, '')
  const s = String(remotePath ?? '').trim()
  if (!base || !s.startsWith(`${base}/`)) {
    throw new DouyinError('E_REMOTE_IO', '截图路径不在允许的远程目录内')
  }
  const name = s.slice(base.length + 1)
  if (!/^[A-Za-z0-9._-]+\.png$/i.test(name) || name.includes('..') || name.startsWith('.')) {
    throw new DouyinError('E_REMOTE_IO', '截图文件名不合法')
  }
  return s
}

export class SshExecTransport {
  /**
   * @param {ReturnType<import('./config.js').normalizeConfig>} cfg
   * @param {{spawnImpl?:Function, exists?:Function, log?:object}} [deps]
   */
  constructor(cfg, { spawnImpl = spawn, exists = existsSync, log = null } = {}) {
    this.cfg = cfg
    this.spawnImpl = spawnImpl
    this.exists = exists
    this.log = log
    this.name = 'ssh-exec'
  }

  /** 第一次调用才检查本地前置条件；缺失时返回 E_SSH_AUTH，不 spawn */
  preflight() {
    if (!this.exists(this.cfg.sshKeyPath)) {
      throw new DouyinError(
        'E_SSH_AUTH',
        `SSH 私钥不存在：${this.cfg.sshKeyPath}（由主人部署，插件不生成密钥）`,
      )
    }
    if (!this.exists(this.cfg.knownHosts)) {
      throw new DouyinError('E_SSH_AUTH', `known_hosts 不存在：${this.cfg.knownHosts}`)
    }
  }

  buildRemoteCommand() {
    const { remoteNodeDir, remoteClient } = this.cfg
    if (!REMOTE_PATH_RE.test(remoteNodeDir) || !REMOTE_PATH_RE.test(remoteClient)) {
      throw new DouyinError('E_BAD_ARG', '远程 node/client 路径不合法')
    }
    return `PATH=${remoteNodeDir}:$PATH node ${remoteClient}`
  }

  buildSshArgs(remoteCommand = this.buildRemoteCommand()) {
    const c = this.cfg
    return [
      '-i',
      c.sshKeyPath,
      '-p',
      String(c.sshPort),
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${c.knownHosts}`,
      `${c.sshUser}@${c.sshHost}`,
      remoteCommand,
    ]
  }

  /**
   * 发起一次请求。返回桥的原始应答对象（形如 {ok,cmd,result} / {ok:false,error}）。
   * 超时会 kill 子进程；不重试、不重放。
   */
  async request(payload, { timeoutMs } = {}) {
    this.preflight()
    const cmd = String(payload?.cmd ?? '')
    const timeout = Number.isFinite(timeoutMs)
      ? timeoutMs
      : cmd === 'open'
        ? this.cfg.openTimeoutMs
        : this.cfg.callTimeoutMs
    const timeoutCode = cmd === 'open' ? 'E_OPEN_TIMEOUT' : 'E_TIMEOUT'
    const res = await this._exec(this.buildRemoteCommand(), {
      timeoutMs: timeout,
      timeoutCode,
      input: `${JSON.stringify(payload)}\n`,
      maxStdoutBytes: MAX_JSON_BYTES,
    })
    const text = res.stdout.toString('utf8')
    const line = firstJsonLine(text)
    if (!line) {
      if (res.code === 0) throw new DouyinError('E_PARSE', '桥没有输出 JSON')
      throw classifyExit(res.code, res.stderr, { bridge: true })
    }
    try {
      const parsed = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new DouyinError('E_PARSE', '桥返回的 JSON 不是对象')
      }
      return parsed
    } catch (e) {
      if (e instanceof DouyinError) throw e
      throw new DouyinError('E_PARSE', '桥返回的内容不是合法 JSON')
    }
  }

  /**
   * 通过远程 X11 的 xdotool 往当前聚焦控件输入草稿文本。
   * 仅在评论 draftOnly 使用；文本走 stdin，不拼 shell；不涉及任意 JS/eval。
   */
  async typeText(text, { timeoutMs = 60000 } = {}) {
    this.preflight()
    const value = String(text ?? '')
    if (!value) return true
    const c = this.cfg
    const remote = [
      `DISPLAY=${shellQuote(c.remoteDisplay || ':20')}`,
      `XAUTHORITY=${shellQuote(c.remoteXAuthority || '/manager/extensions/desktop/Xauthority')}`,
      `sh -c ${shellQuote(`${ACTIVATE_CHROME}xdotool type --clearmodifiers --delay 60 --file -`)}`,
    ].join(' ')
    const res = await this._exec(remote, {
      timeoutMs,
      timeoutCode: 'E_TIMEOUT',
      input: value,
      maxStdoutBytes: 64 * 1024,
    })
    if (res.code !== 0) throw classifyExit(res.code, res.stderr)
    return true
  }

  /**
   * 清空当前聚焦的输入框：xdotool ctrl+a + BackSpace。
   * 只用于评论草稿（本地页面状态），不涉及提交；按键组合固定，不接受任意键。
   */
  async clearText({ timeoutMs = 15000 } = {}) {
    this.preflight()
    const c = this.cfg
    const remote = [
      `DISPLAY=${shellQuote(c.remoteDisplay || ':20')}`,
      `XAUTHORITY=${shellQuote(c.remoteXAuthority || '/manager/extensions/desktop/Xauthority')}`,
      `sh -c ${shellQuote(`${ACTIVATE_CHROME}xdotool key --clearmodifiers ctrl+a BackSpace`)}`,
    ].join(' ')
    const res = await this._exec(remote, {
      timeoutMs,
      timeoutCode: 'E_TIMEOUT',
      input: null,
      maxStdoutBytes: 64 * 1024,
    })
    if (res.code !== 0) throw classifyExit(res.code, res.stderr)
    return true
  }

  /**
   * 通过“远程剪贴板 + ctrl+v”粘贴文本（评论草稿用）。
   *
   * 为什么不用 xdotool type：2026-11-09 实测中文丢字严重（20 字丢 2–5 个，重试也不稳）；
   * 剪贴板粘贴 3/3 全对。依赖远程 xclip（远程 Ubuntu 已装，apt 包 0.13-3）。
   * 文本走 stdin 写临时文件，不拼 shell；临时文件固定路径，用完删除。
   */
  async pasteText(text, { timeoutMs = 20000 } = {}) {
    this.preflight()
    const value = String(text ?? '')
    if (!value) return true
    const c = this.cfg
    const disp = shellQuote(c.remoteDisplay || ':20')
    const auth = shellQuote(c.remoteXAuthority || '/manager/extensions/desktop/Xauthority')
    const file = '/tmp/dsh-douyin-clip.txt'

    const w = await this._exec(`cat > ${shellQuote(file)}`, {
      timeoutMs,
      timeoutCode: 'E_TIMEOUT',
      input: value,
      maxStdoutBytes: 64 * 1024,
    })
    if (w.code !== 0) throw classifyExit(w.code, w.stderr)

    const script =
      `${ACTIVATE_CHROME}` +
      `setsid xclip -selection clipboard -i ${file} >/dev/null 2>&1 & ` +
      'sleep 0.25; ' +
      'xdotool key --clearmodifiers ctrl+v; ' +
      `rm -f ${file}`
    const remote = [`DISPLAY=${disp}`, `XAUTHORITY=${auth}`, `sh -c ${shellQuote(script)}`].join(' ')
    const res = await this._exec(remote, {
      timeoutMs,
      timeoutCode: 'E_TIMEOUT',
      input: null,
      maxStdoutBytes: 64 * 1024,
    })
    if (res.code !== 0) throw classifyExit(res.code, res.stderr)
    return true
  }

  /**
   * 通过远程 X11 的 xdotool 按一个写操作快捷键（抖音网页版：Z=点赞、C=收藏、X=评论）。
   *
   * 为什么需要它：2026-11-09 实测 Playwright click 在点赞/收藏按钮上连续 15s 超时，
   * 页面其他位置（feed 卡片）也命中不了（hover 预览/浮层拦截鼠标命中），
   * 但键盘事件不走命中测试。只允许白名单键；不拼任意按键。
   */
  /**
   * 让页面/播放器拿到键盘焦点：在 Chrome 窗口中心点一下（X 层鼠标，不走命中测试）。
   *
   * 2026-11-09 实测：不点这一下，按 z/c 不会生效（播放器没焦点）；
   * 而 Playwright click 在 video/按钮上会被浮层命中测试挡住（15s 超时），
   * 所以这里用 xdotool 在 X 层点窗口中心（视频页=画面中央，安全）。
   */
  async focusPage({ timeoutMs = 15000 } = {}) {
    this.preflight()
    const c = this.cfg
    // 单行 sh：注意 `then` 后面不能跟分号（会 Syntax error）
    const script =
      'wid=$(xdotool search --onlyvisible --name "Google Chrome|Chromium|抖音|Douyin" 2>/dev/null | head -n1); ' +
      'if [ -n "$wid" ]; then ' +
      'xdotool windowactivate --sync "$wid" >/dev/null 2>&1 || true; ' +
      'eval $(xdotool getwindowgeometry --shell "$wid"); ' +
      'xdotool mousemove $((X+WIDTH/2)) $((Y+HEIGHT/2)) click 1; ' +
      'fi'
    const remote = [
      `DISPLAY=${shellQuote(c.remoteDisplay || ':20')}`,
      `XAUTHORITY=${shellQuote(c.remoteXAuthority || '/manager/extensions/desktop/Xauthority')}`,
      `sh -c ${shellQuote(script)}`,
    ].join(' ')
    const res = await this._exec(remote, {
      timeoutMs,
      timeoutCode: 'E_TIMEOUT',
      input: null,
      maxStdoutBytes: 64 * 1024,
    })
    if (res.code !== 0) throw classifyExit(res.code, res.stderr)
    return true
  }

  /** 真实 X11 鼠标点击屏幕坐标（用于 Playwright 命中测试被浮层挡住时）。 */
  async clickAt({ x, y, timeoutMs = 15000 } = {}) {
    this.preflight()
    const px = Math.max(0, Math.min(10000, Math.floor(Number(x) || 0)))
    const py = Math.max(0, Math.min(10000, Math.floor(Number(y) || 0)))
    const c = this.cfg
    const script = `wid=$(xdotool search --onlyvisible --name "Google Chrome|Chromium|抖音|Douyin" 2>/dev/null | head -n1); if [ -n "$wid" ]; then xdotool windowactivate --sync "$wid" >/dev/null 2>&1 || true; fi; xdotool mousemove ${px} ${py} click 1`
    const remote = [
      `DISPLAY=${shellQuote(c.remoteDisplay || ':20')}`,
      `XAUTHORITY=${shellQuote(c.remoteXAuthority || '/manager/extensions/desktop/Xauthority')}`,
      `sh -c ${shellQuote(script)}`,
    ].join(' ')
    const res = await this._exec(remote, { timeoutMs, timeoutCode: 'E_TIMEOUT', input: null, maxStdoutBytes: 64 * 1024 })
    if (res.code !== 0) throw classifyExit(res.code, res.stderr)
    return true
  }

  async pressKey(key, { timeoutMs = 15000, focus = true, focusWaitMs = 300 } = {}) {
    this.preflight()
    const k = String(key ?? '').trim().toLowerCase()
    if (!WRITE_KEYS.includes(k)) {
      throw new DouyinError('E_BAD_ARG', `pressKey 只允许 ${WRITE_KEYS.join('/')}`)
    }
    // 快捷键只对“有焦点的播放器”生效：默认先点一下窗口中心，再按键。
    // 放在 pressKey 内部而不是让调用方记得调，避免漏聚焦导致按键无效。
    if (focus) {
      await this.focusPage({ timeoutMs })
      if (focusWaitMs > 0) await new Promise((resolve) => setTimeout(resolve, focusWaitMs))
    }
    const c = this.cfg
    const remote = [
      `DISPLAY=${shellQuote(c.remoteDisplay || ':20')}`,
      `XAUTHORITY=${shellQuote(c.remoteXAuthority || '/manager/extensions/desktop/Xauthority')}`,
      'xdotool key --clearmodifiers --delay 50',
      shellQuote(k),
    ].join(' ')
    const res = await this._exec(remote, {
      timeoutMs,
      timeoutCode: 'E_TIMEOUT',
      input: null,
      maxStdoutBytes: 64 * 1024,
    })
    if (res.code !== 0) throw classifyExit(res.code, res.stderr)
    return true
  }

  /**
   * 用 SSH cat 取回远程截图。路径已按白名单校验；超限即 kill。
   */
  async readFile(remotePath, { timeoutMs, maxBytes } = {}) {
    this.preflight()
    const safePath = assertSafeShotPath(remotePath, this.cfg.shotsDir)
    const cap = Number.isFinite(maxBytes) ? maxBytes : this.cfg.maxScreenshotBytes
    const res = await this._exec(`cat -- ${shellQuote(safePath)}`, {
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : this.cfg.callTimeoutMs,
      timeoutCode: 'E_TIMEOUT',
      input: null,
      maxStdoutBytes: cap,
    })
    if (res.code !== 0) throw classifyExit(res.code, res.stderr)
    if (res.stdout.length > cap) {
      throw new DouyinError('E_REMOTE_IO', `远程文件超过上限（${cap} 字节）`)
    }
    return res.stdout
  }

  _exec(remoteCommand, { timeoutMs, timeoutCode = 'E_TIMEOUT', input = null, maxStdoutBytes = MAX_JSON_BYTES }) {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = this.spawnImpl('ssh', this.buildSshArgs(remoteCommand), {
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (e) {
        reject(classifySpawnError(e))
        return
      }

      const out = []
      let outBytes = 0
      let stderr = ''
      let settled = false
      let timer = null

      const finish = (fn, value) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        fn(value)
      }

      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // 进程可能已经退出
        }
        finish(reject, new DouyinError(timeoutCode, `SSH 调用超时（${timeoutMs}ms）`, { timeoutMs }))
      }, Math.max(1, timeoutMs))

      child.on('error', (e) => finish(reject, classifySpawnError(e)))
      child.stdout?.on('data', (d) => {
        if (settled) return
        const buf = Buffer.isBuffer(d) ? d : Buffer.from(d)
        out.push(buf)
        outBytes += buf.length
        if (outBytes > maxStdoutBytes) {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
          finish(
            reject,
            new DouyinError('E_REMOTE_IO', `远程输出超过上限（${maxStdoutBytes} 字节）`),
          )
        }
      })
      child.stderr?.on('data', (d) => {
        stderr = `${stderr}${String(d)}`
        if (stderr.length > MAX_STDERR) stderr = stderr.slice(-MAX_STDERR)
      })
      child.on('close', (code, signal) => {
        finish(resolve, {
          code: Number.isInteger(code) ? code : null,
          signal: signal ?? null,
          stdout: Buffer.concat(out),
          stderr,
        })
      })

      try {
        child.stdin?.on?.('error', () => {})
        if (input != null) child.stdin?.end(input)
        else child.stdin?.end()
      } catch {
        // close/error 会负责结束；stdin 写失败不单独抛
      }
    })
  }
}

/**
 * streamlocal 仅保留接口占位（v1 不实现）。
 * 明确返回 E_BRIDGE_DOWN，不偷偷回退到本地/其它通道。
 */

/**
 * 本机 Unix socket 传输：直接连 /persistent/cdp/bridge.sock，不再经 SSH。
 * 同一容器内的 desktop/browser/bridge 用这条通道最快；X11 写操作仍走本地 sh。
 */
export class LocalSocketTransport extends SshExecTransport {
  constructor(cfg, deps = {}) {
    super(cfg, deps)
    this.name = 'local-socket'
  }

  preflight() {
    const p = String(this.cfg.localSocket || '/persistent/cdp/bridge.sock')
    if (!this.exists(p)) throw new DouyinError('E_BRIDGE_DOWN', `本机桥 socket 不存在：${p}`)
  }

  async request(payload, { timeoutMs } = {}) {
    this.preflight()
    const socketPath = String(this.cfg.localSocket || '/persistent/cdp/bridge.sock')
    const cmd = String(payload?.cmd ?? '')
    const timeout = Number.isFinite(timeoutMs)
      ? timeoutMs
      : cmd === 'open'
        ? this.cfg.openTimeoutMs
        : this.cfg.callTimeoutMs
    const timeoutCode = cmd === 'open' ? 'E_OPEN_TIMEOUT' : 'E_TIMEOUT'
    const line = `${JSON.stringify(payload)}\n`
    return await new Promise((resolve, reject) => {
      const sock = net.connect(socketPath)
      let buf = ''
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { sock.destroy() } catch {}
        fn(value)
      }
      const timer = setTimeout(() => finish(reject, new DouyinError(timeoutCode, `本机桥调用超时（${timeout}ms）`, { timeoutMs: timeout })), Math.max(1, timeout))
      sock.setEncoding('utf8')
      sock.on('connect', () => { try { sock.write(line) } catch (e) { finish(reject, classifySpawnError(e)) } })
      sock.on('data', (chunk) => {
        buf += String(chunk)
        if (buf.length > MAX_JSON_BYTES) return finish(reject, new DouyinError('E_REMOTE_IO', '本机桥输出超过上限'))
        const nl = buf.indexOf('\n')
        if (nl < 0) return
        const text = buf.slice(0, nl).trim()
        try {
          const parsed = JSON.parse(text)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
          finish(resolve, parsed)
        } catch {
          finish(reject, new DouyinError('E_PARSE', '本机桥返回的内容不是合法 JSON'))
        }
      })
      sock.on('error', (e) => finish(reject, new DouyinError('E_BRIDGE_DOWN', `本机桥不可用：${String(e?.message ?? e).slice(0, 200)}`)))
      sock.on('close', () => { if (!settled) finish(reject, new DouyinError('E_BRIDGE_DOWN', '本机桥 socket 提前关闭')) })
    })
  }

  async readFile(remotePath, { maxBytes } = {}) {
    this.preflight()
    const safePath = assertSafeShotPath(remotePath, this.cfg.shotsDir)
    const cap = Number.isFinite(maxBytes) ? maxBytes : this.cfg.maxScreenshotBytes
    const data = readFileSync(safePath)
    if (data.length > cap) throw new DouyinError('E_REMOTE_IO', `本机文件超过上限（${cap} 字节）`)
    return data
  }

  _exec(localCommand, { timeoutMs, timeoutCode = 'E_TIMEOUT', input = null, maxStdoutBytes = MAX_JSON_BYTES }) {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = this.spawnImpl('sh', ['-c', localCommand], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } })
      } catch (e) {
        reject(classifySpawnError(e)); return
      }
      const out = []; let outBytes = 0; let stderr = ''; let settled = false
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value) }
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} finish(reject, new DouyinError(timeoutCode, `本机 X11 调用超时（${timeoutMs}ms）`)) }, Math.max(1, timeoutMs))
      child.on('error', (e) => finish(reject, classifySpawnError(e)))
      child.stdout?.on('data', (d) => { if (settled) return; const b=Buffer.isBuffer(d)?d:Buffer.from(d); out.push(b); outBytes+=b.length; if (outBytes>maxStdoutBytes) { try{child.kill('SIGKILL')}catch{} finish(reject,new DouyinError('E_REMOTE_IO',`本机输出超过上限（${maxStdoutBytes} 字节）`)) } })
      child.stderr?.on('data', (d) => { stderr = `${stderr}${String(d)}`; if (stderr.length > MAX_STDERR) stderr = stderr.slice(-MAX_STDERR) })
      child.on('close', (code, signal) => finish(resolve, { code: Number.isInteger(code) ? code : null, signal: signal ?? null, stdout: Buffer.concat(out), stderr }))
      try { child.stdin?.on?.('error', () => {}); if (input != null) child.stdin?.end(input); else child.stdin?.end() } catch {}
    })
  }
}

export class StreamLocalTransport {
  constructor(cfg) {
    this.cfg = cfg
    this.name = 'streamlocal'
  }

  async request() {
    throw new DouyinError('E_BRIDGE_DOWN', 'streamlocal 传输尚未实现（v1 只用 ssh-exec）')
  }

  async readFile() {
    throw new DouyinError('E_BRIDGE_DOWN', 'streamlocal 传输尚未实现（v1 只用 ssh-exec）')
  }

  async typeText() {
    throw new DouyinError('E_BRIDGE_DOWN', 'streamlocal 传输尚未实现（v1 只用 ssh-exec）')
  }
}

export function createTransport(cfg, deps = {}) {
  if (cfg.transport === 'local-socket') return new LocalSocketTransport(cfg, deps)
  if (cfg.transport === 'streamlocal') return new StreamLocalTransport(cfg)
  return new SshExecTransport(cfg, deps)
}
