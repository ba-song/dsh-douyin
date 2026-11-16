/**
 * 远程 CDP 桥的客户端：把白名单命令翻译成一行 JSON，校验应答。
 *
 * 桥命令白名单（服务端约定）：
 *   ping / open / tabs / title / url / text / html / count / list / links / click / scroll / press /
 *   screenshot / assets / jsRead / jsWatch / jsClick / rect / activate / restart
 *
 * 2026-11-16 协议 v2（protocol-v2.md §A/§F，**全部向后兼容**）：
 *   - ping 的 result 增加 capabilities/version；插件据此决定用新命令还是老路径；
 *   - 新命令：health / probe / waitFor / netArm / netTake / type；
 *   - click 支持 timeoutMs/scroll；open 支持 reuse；press 白名单扩 z/c/x（快捷键走桥，不走 X11）。
 *   老桥（ping 没有 capabilities）时必须整体降级到旧的多次调用路径，**不能报错**。
 *
 * 2026-11-14 多页面 role 模型（协议向后兼容）：
 *   - role/pageRole 缺省 = main（旧调用不带 role 时行为不变）；
 *   - notify / dm 的请求会显式带 role，服务端落在各自独立的 tab，不导航 main；
 *   - open 可指定 role 并复用该 role 的 page；
 *   - jsWatch 等 JS 状态按 role 的 page 天然隔离。
 * 本插件只使用只读子集：ping / open / tabs / title / url / count / list / html / screenshot /
 * scroll / press / click / assets / jsRead / jsWatch / jsClick / rect / activate。
 * scroll/press/click 只用于「推荐流下滚」和「搜索卡片打开→Esc 关闭」；assets 只切换资源拦截；
 * 不点赞/评论/登录/发布。
 */
import { DouyinError, clip } from './errors.js'

export const READONLY_COMMANDS = Object.freeze([
  'ping',
  'open',
  'tabs',
  'title',
  'url',
  'count',
  'list',
  'html',
  'text',
  'screenshot',
  'scroll',
  'press',
  'click',
  'assets',
  'jsRead',
  'jsWatch',
  'rect',
  'jsClick',
  'activate',
  // 协议 v2 受控命令（不是任意 JS）：崩溃健康检查 / 状态包 / 条件等待 / 网络响应观察 / 桥内文本输入
  'health',
  'probe',
  'waitFor',
  'netArm',
  'netTake',
  'type',
])

/** 固定三个页面角色；main=推荐流/搜索/视频，notify=通知面板，dm=/chat 私信 */
export const PAGE_ROLES = Object.freeze(['main', 'notify', 'dm'])

export function normalizePageRole(role) {
  const raw = role === undefined || role === null || String(role).trim() === '' ? 'main' : String(role).trim().toLowerCase()
  if (!PAGE_ROLES.includes(raw)) {
    throw new DouyinError('E_BAD_ARG', `role 只允许 ${PAGE_ROLES.join('/')}`)
  }
  return raw
}

/** press 只允许的按键（服务端白名单同款；2026-11-16 扩 z/c/x：抖音网页版点赞/收藏/评论快捷键） */
export const PRESS_KEYS = Object.freeze(['Escape', 'Enter', 'ArrowDown', 'ArrowUp', 'z', 'c', 'x'])

/** 快捷键字符（只这三个走"按键写操作"；其余 press 键仍可用于 UI 操作） */
export const WRITE_KEY_CHARS = Object.freeze(['z', 'c', 'x'])

/** 协议 v2 能力名（ping.capabilities 里的字符串） */
export const CAP_HEALTH = 'health'
export const CAP_PROBE = 'probe'
export const CAP_WAIT_FOR = 'waitFor'
export const CAP_NET_ARM = 'netArm'
export const CAP_NET_TAKE = 'netTake'
export const CAP_TYPE = 'type'
export const CAP_PRESS_HOTKEYS = 'pressHotkeys'
export const CAP_CLICK_TIMEOUT = 'clickTimeout'
export const CAP_CLICK_NO_SCROLL = 'clickNoScroll'
export const CAP_OPEN_REUSE = 'openReuse'

/** 把远程 error 字符串收敛成本地错误码（只读、可重试性由调用方决定，不自动重放） */
export function mapRemoteError(cmd, error) {
  const msg = String(error ?? '')
  const hint = clip(msg, 300)
  // 桥显式返回的错误码（E_INPUT_FOCUSED / E_TYPE_FAILED / E_BAD_TEXT ...）优先原样保留，
  // 否则 "inputFocused" / "type failed" 会被下面的 selector/locator 正则误判成 E_SELECTOR_MISS。
  const explicit = msg.match(/\b(E_[A-Z][A-Z0-9_]{2,40})\b/)
  if (explicit) {
    return new DouyinError(explicit[1], `远程命令失败：${hint || explicit[1]}`)
  }
  if (/timed?\s*out|timeout|超时/i.test(msg)) {
    return new DouyinError(
      cmd === 'open' ? 'E_OPEN_TIMEOUT' : 'E_TIMEOUT',
      `远程${cmd === 'open' ? '打开页面' : '命令'}超时${hint ? `：${hint}` : ''}`,
    )
  }
  if (/target crashed|page crashed|renderer crashed/i.test(msg)) {
    return new DouyinError('E_REMOTE_IO', `页面 renderer 崩溃（需桥侧重建 role page）${hint ? `：${hint}` : ''}`, {
      detail: 'page_crashed',
    })
  }
  if (/captcha|challenge|安全验证|验证码|滑块|verify/i.test(msg)) {
    return new DouyinError('E_CHALLENGE', '页面出现验证码/安全验证，已停止（需人工处理）')
  }
  if (/login|登录|未登录/i.test(msg)) {
    return new DouyinError('E_LOGIN_REQUIRED', '页面需要登录（登录态可能失效）')
  }
  if (/selector|locator/i.test(msg)) {
    return new DouyinError('E_SELECTOR_MISS', `选择器未命中或非法${hint ? `：${hint}` : ''}`)
  }
  if (/socket|ECONNREFUSED|ENOENT|no such file|not running|bridge.*down|连接被拒/i.test(msg)) {
    return new DouyinError('E_BRIDGE_DOWN', `远程桥不可用${hint ? `：${hint}` : ''}`)
  }
  return new DouyinError('E_REMOTE_IO', `远程命令失败${hint ? `：${hint}` : ''}`)
}

function asText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.url === 'string') return value.url
  }
  return ''
}

export class BridgeClient {
  constructor({ transport, cfg, role = 'main', capState = null }) {
    this.transport = transport
    this.cfg = cfg
    this.role = normalizePageRole(role)
    // 能力缓存按 transport 共享（bridge 是全局的，main/notify/dm 三个客户端共用一份）。
    // 结构：{ value: Set<string>|null, promise: Promise|null }；null = 还没探测过（老桥语义 = 空集合）。
    this._caps = capState ?? { value: null, promise: null }
  }

  /** 派生一个固定 role 的客户端，共用同一个 transport（和同一份能力缓存）；用于 notify/dm 独立 tab。 */
  withRole(role) {
    return new BridgeClient({ transport: this.transport, cfg: this.cfg, role, capState: this._caps })
  }

  /**
   * 探测桥能力：ping 的 result.capabilities。老桥没有该字段 → 空集合（调用方降级，不报错）。
   * 失败（桥不可用）也按空集合缓存，真正的错误由后续 url/list 等命令抛出。
   */
  async capabilities({ refresh = false } = {}) {
    if (!refresh && this._caps.value) return this._caps.value
    if (!refresh && this._caps.promise) return this._caps.promise
    const p = (async () => {
      let set = new Set()
      try {
        const r = await this.call('ping')
        if (Array.isArray(r?.capabilities)) {
          set = new Set(r.capabilities.filter((x) => typeof x === 'string' && x))
        }
      } catch {
        set = new Set()
      }
      this._caps.value = set
      this._caps.promise = null
      return set
    })()
    this._caps.promise = p
    return p
  }

  /** 是否支持某条协议 v2 命令；老桥/未探测到一律 false（调用方必须走旧路径）。 */
  async supports(cmd) {
    const name = String(cmd ?? '')
    if (!name) return false
    if (name === CAP_PROBE && this.cfg?.probeEnabled === false) return false
    const caps = await this.capabilities()
    return caps.has(name)
  }

  /** 某个能力在运行时被证明不可用（例如桥返回 unknown command）：移除，后续自动降级。 */
  downgrade(cmd) {
    if (this._caps.value) this._caps.value.delete(String(cmd))
  }

  /** 清空能力缓存（桥重启/换协议后强制重新探测）。 */
  resetCapabilities() {
    this._caps.value = null
    this._caps.promise = null
  }

  async call(cmd, params = {}, { timeoutMs, role } = {}) {
    if (!READONLY_COMMANDS.includes(cmd)) {
      throw new DouyinError('E_BAD_ARG', `不允许的桥命令：${cmd}`)
    }
    const effective = normalizePageRole(role === undefined ? this.role : role)
    // cmd 放最后，防止调用方参数覆盖白名单命令；role/pageRole 只由客户端注入
    const { role: _role, pageRole: _pageRole, cmd: _cmd, ...rest } = params && typeof params === 'object' ? params : {}
    const payload = {
      ...rest,
      ...(effective !== 'main' ? { role: effective } : {}),
      cmd,
    }
    const response = await this.transport.request(payload, { timeoutMs })
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new DouyinError('E_PARSE', '桥应答不是对象')
    }
    if (response.ok === false) {
      const mapped = mapRemoteError(cmd, response.error)
      // 老桥把未知命令当 E_COMMAND_UNKNOWN / unknown command 返回：就地降级，让调用方走旧路径
      if (mapped.code === 'E_BAD_ARG' || /unknown command|不支持的命令|E_COMMAND_UNKNOWN/i.test(String(response.error ?? ''))) {
        this.downgrade(cmd)
      }
      throw mapped
    }
    return response.result
  }

  async ping() {
    const r = await this.call('ping')
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw new DouyinError('E_PARSE', 'ping 应答缺少 proto/browser/pages')
    }
    const roles = r.roles && typeof r.roles === 'object' && !Array.isArray(r.roles) ? r.roles : null
    const capabilities = Array.isArray(r.capabilities) ? r.capabilities.filter((x) => typeof x === 'string' && x) : []
    return {
      proto: asText(r.proto),
      version: asText(r.version) || null,
      browser: r.browser === true,
      pages: Number.isFinite(Number(r.pages)) ? Number(r.pages) : 0,
      capabilities,
      ...(roles ? { roles } : {}),
    }
  }

  /** 列出所有 tab：`[{role,index,url,title}]`；role 为 null 表示非本桥管理页。 */
  async tabs() {
    const r = await this.call('tabs')
    if (!Array.isArray(r)) throw new DouyinError('E_PARSE', 'tabs 返回值不是数组')
    return r.filter((row) => row && typeof row === 'object' && !Array.isArray(row)).map((row) => ({
      role: row.role === null || row.role === undefined ? null : String(row.role),
      index: Number.isFinite(Number(row.index)) ? Number(row.index) : null,
      url: asText(row.url),
      title: asText(row.title),
    }))
  }

  async title({ role } = {}) {
    return asText(await this.call('title', {}, { role }))
  }

  async url({ role } = {}) {
    return asText(await this.call('url', {}, { role }))
  }

  /**
   * 打开 URL。协议 v2：reuse=true（默认）时同 URL 复用当前页，不导航 → 返回 reused:true。
   * @returns {{role:string,url:string,status:number|null,title:string,reused:boolean}}
   */
  async open(url, { role, reuse } = {}) {
    if (typeof url !== 'string' || !url) throw new DouyinError('E_BAD_ARG', 'open 需要 URL')
    const params = { url }
    if (reuse !== undefined) params.reuse = reuse === true
    const r = await this.call('open', params, { role })
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      return {
        role: r.role === undefined || r.role === null ? normalizePageRole(role) : String(r.role),
        url: asText(r.url) || url,
        status: Number.isFinite(Number(r.status)) ? Number(r.status) : null,
        title: asText(r.title),
        reused: r.reused === true,
      }
    }
    return { role: normalizePageRole(role), url, status: null, title: asText(r), reused: false }
  }

  /**
   * 一次往返读页面状态 + 多个选择器计数（+ 可选一次 list）。
   * 老桥没有 probe 能力时调用方必须先 supports('probe')，不要直接调（会 E_REMOTE_IO）。
   * @returns {{url:string,title:string,readyState:string,counts:Record<string,number>,count:number|null,rows:Array<object>}}
   */
  async probe({ counts = [], selector = '', attrs = [], limit = 1, textLen = 120, role } = {}) {
    const safeCounts = (Array.isArray(counts) ? counts : [])
      .filter((s) => typeof s === 'string' && s.trim())
      .slice(0, 8)
    const sel = typeof selector === 'string' ? selector.trim() : ''
    if (!safeCounts.length && !sel) throw new DouyinError('E_BAD_ARG', 'probe 需要 counts 或 selector')
    const safeAttrs = (Array.isArray(attrs) ? attrs : [])
      .filter((a) => typeof a === 'string' && /^[A-Za-z0-9:_-]{1,40}$/.test(a))
      .slice(0, 4)
    const params = {}
    if (safeCounts.length) params.counts = safeCounts
    if (sel) {
      params.selector = sel
      params.attrs = safeAttrs
      params.limit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 1)))
      params.textLen = Math.max(20, Math.min(500, Math.floor(Number(textLen) || 120)))
    }
    const r = await this.call('probe', params, { role })
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new DouyinError('E_PARSE', 'probe 应答不是对象')
    const countsOut = {}
    if (r.counts && typeof r.counts === 'object' && !Array.isArray(r.counts)) {
      for (const [key, value] of Object.entries(r.counts)) {
        const n = Number(value)
        countsOut[key] = Number.isFinite(n) ? n : -1
      }
    }
    return {
      url: asText(r.url),
      title: asText(r.title),
      readyState: asText(r.readyState),
      counts: countsOut,
      count: Number.isFinite(Number(r.count)) ? Number(r.count) : null,
      rows: Array.isArray(r.rows) ? r.rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row)) : [],
    }
  }

  /** 条件等待：状态变化就返回；超时 matched:false（不是错误，由调用方决定）。 */
  async waitFor(selector, { state = 'visible', timeoutMs, role } = {}) {
    const sel = String(selector ?? '').trim()
    if (!sel) throw new DouyinError('E_BAD_ARG', 'waitFor 需要选择器')
    const st = String(state || 'visible')
    if (!['visible', 'attached', 'detached', 'hidden'].includes(st)) {
      throw new DouyinError('E_BAD_ARG', 'waitFor.state 只允许 visible/attached/detached/hidden')
    }
    const t = Math.max(50, Math.min(8000, Math.floor(Number(timeoutMs) || 2500)))
    const r = await this.call('waitFor', { selector: sel, state: st, timeoutMs: t }, { role })
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new DouyinError('E_PARSE', 'waitFor 应答不是对象')
    return { matched: r.matched === true, ms: Number.isFinite(Number(r.ms)) ? Number(r.ms) : null }
  }

  /** 角色健康（崩溃/关闭）；老桥没有该命令时由调用方忽略。 */
  async health({ role } = {}) {
    const r = await this.call('health', {}, { role })
    return r && typeof r === 'object' && !Array.isArray(r) ? r : null
  }

  /** 安装网络响应观察（只记录 url/method/status/seq/ts，不存 body）。 */
  async netArm(patterns, { role } = {}) {
    const list = (Array.isArray(patterns) ? patterns : [patterns])
      .filter((p) => typeof p === 'string' && /^[A-Za-z0-9_\-./?=&%:]{1,120}$/.test(p))
      .slice(0, 8)
    if (!list.length) throw new DouyinError('E_BAD_ARG', 'netArm 需要至少一个合法 URL 片段')
    const r = await this.call('netArm', { patterns: list }, { role })
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new DouyinError('E_PARSE', 'netArm 应答不是对象')
    return { armed: r.armed === true, seq: Number.isFinite(Number(r.seq)) ? Number(r.seq) : 0, patterns: list }
  }

  /** 取 sinceSeq 之后的网络事件；matched:false 表示窗口内没等到（不是错误）。 */
  async netTake({ sinceSeq = 0, timeoutMs, want = 1, role } = {}) {
    const params = {
      sinceSeq: Math.max(0, Math.floor(Number(sinceSeq) || 0)),
      timeoutMs: Math.max(0, Math.min(4000, Math.floor(Number(timeoutMs) || 0))),
      want: Math.max(1, Math.min(20, Math.floor(Number(want) || 1))),
    }
    const r = await this.call('netTake', params, { role })
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new DouyinError('E_PARSE', 'netTake 应答不是对象')
    const events = Array.isArray(r.events) ? r.events.filter((e) => e && typeof e === 'object') : []
    return {
      matched: r.matched === true,
      seq: Number.isFinite(Number(r.seq)) ? Number(r.seq) : params.sinceSeq,
      events: events.map((e) => ({
        seq: Number.isFinite(Number(e.seq)) ? Number(e.seq) : null,
        url: asText(e.url),
        method: asText(e.method),
        status: Number.isFinite(Number(e.status)) ? Number(e.status) : null,
        ts: Number.isFinite(Number(e.ts)) ? Number(e.ts) : null,
      })),
    }
  }

  /**
   * 桥内文本输入（协议 v2 §F A9）：走 Playwright fill/insertText，不经 X11 剪贴板。
   * mode: auto(默认) / fill / insert / keys（keys 只允许可打印 ASCII）
   * @returns {{via:string,chars:number}}
   */
  async typeText({ selector = '', text, clear = false, mode = 'auto', nth = 0, role } = {}) {
    const value = String(text ?? '')
    if (!value) throw new DouyinError('E_BAD_ARG', 'type 需要非空 text')
    if (Array.from(value).length > 2000) throw new DouyinError('E_BAD_ARG', 'type.text 最多 2000 字')
    const m = String(mode || 'auto')
    if (!['auto', 'fill', 'insert', 'keys'].includes(m)) {
      throw new DouyinError('E_BAD_ARG', 'type.mode 只允许 auto/fill/insert/keys')
    }
    if (m === 'keys' && !/^[\x20-\x7E]*$/.test(value)) {
      throw new DouyinError('E_BAD_ARG', 'type.mode=keys 只允许可打印 ASCII')
    }
    const params = { text: value, clear: clear === true, mode: m }
    const sel = typeof selector === 'string' ? selector.trim() : ''
    if (sel) {
      params.selector = sel
      const n = Number(nth)
      params.nth = Number.isInteger(n) && n >= 0 && n <= 100 ? n : 0
    } else if (m === 'fill' || m === 'auto') {
      // 没有选择器时只能走 insert/keys（fill 需要 locator）
      params.mode = m === 'fill' ? 'insert' : 'auto'
    }
    const r = await this.call('type', params, { role })
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      return { via: asText(r.via) || m, chars: Number.isFinite(Number(r.chars)) ? Number(r.chars) : Array.from(value).length }
    }
    return { via: m, chars: Array.from(value).length }
  }

  /**
   * 桥内快捷键（点赞 z / 收藏 c / 评论 x）。返回 {key,inputFocused}；inputFocused=true 表示被拒。
   * 老桥没有 pressHotkeys 能力时调用方不要用，改走 X11。
   */
  async pressChar(key, { role } = {}) {
    const k = String(key ?? '')
    if (!WRITE_KEY_CHARS.includes(k)) throw new DouyinError('E_BAD_ARG', 'pressChar 只允许 z/c/x')
    const r = await this.call('press', { key: k }, { role })
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      return { ok: r.ok !== false, key: asText(r.key) || k, inputFocused: r.inputFocused === true }
    }
    return { ok: r !== false, key: k, inputFocused: false }
  }

  /** 把 role 的 tab 提到最前（私信输入前需要 X11 焦点；watcher 不调用）。 */
  async activate({ role } = {}) {
    const r = await this.call('activate', {}, { role })
    return r && typeof r === 'object' ? { role: asText(r.role) || normalizePageRole(role), url: asText(r.url) } : { role: normalizePageRole(role) }
  }

  async count(selector, { role } = {}) {
    if (typeof selector !== 'string' || !selector.trim()) {
      throw new DouyinError('E_BAD_ARG', 'count 需要选择器')
    }
    const r = await this.call('count', { selector }, { role })
    const n = Number(r)
    if (!Number.isFinite(n) || n < 0) throw new DouyinError('E_PARSE', 'count 返回值不是数字')
    return Math.floor(n)
  }

  async list(selector, { attrs = [], limit = 8, textLen = 60, role } = {}) {
    if (typeof selector !== 'string' || !selector.trim()) {
      throw new DouyinError('E_BAD_ARG', 'list 需要选择器')
    }
    const safeAttrs = (Array.isArray(attrs) ? attrs : [])
      .filter((a) => typeof a === 'string' && /^[A-Za-z0-9:_-]{1,40}$/.test(a))
      .slice(0, 4)
    // 远程桥单次最多 50 条；客户端原先把上限夹在 20，导致评论/feed 多取时被截断
    const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 8)))
    const safeTextLen = Math.max(20, Math.min(500, Math.floor(Number(textLen) || 60)))
    const r = await this.call('list', {
      selector,
      attrs: safeAttrs,
      limit: safeLimit,
      textLen: safeTextLen,
    }, { role })
    if (!Array.isArray(r)) throw new DouyinError('E_PARSE', 'list 返回值不是数组')
    return r.filter((row) => row && typeof row === 'object' && !Array.isArray(row))
  }

  async text(selector, { role } = {}) {
    if (typeof selector !== 'string' || !selector.trim()) {
      throw new DouyinError('E_BAD_ARG', 'text 需要选择器')
    }
    return asText(await this.call('text', { selector }, { role }))
  }

  async html(selector, { max = 4000, role } = {}) {
    if (typeof selector !== 'string' || !selector.trim()) {
      throw new DouyinError('E_BAD_ARG', 'html 需要选择器')
    }
    const safeMax = Math.max(100, Math.min(50000, Math.floor(Number(max) || 4000)))
    const r = await this.call('html', { selector, max: safeMax }, { role })
    return asText(r)
  }

  async jsClick(selector, { nth = 0, role } = {}) {
    const sel = String(selector ?? '').trim()
    if (!sel) throw new DouyinError('E_BAD_ARG', 'jsClick 需要 selector')
    return this.call('jsClick', { selector: sel, nth: Math.max(0, Number(nth) || 0) }, { role })
  }

  async rect(selector, { nth = 0, role } = {}) {
    const sel = String(selector ?? '').trim()
    if (!sel) throw new DouyinError('E_BAD_ARG', 'rect 需要 selector')
    return this.call('rect', { selector: sel, nth: Math.max(0, Number(nth) || 0) }, { role })
  }

  async jsWatch(action, { limit = 30, role } = {}) {
    const a = String(action || 'status')
    if (!['start', 'take', 'stop', 'status'].includes(a)) throw new DouyinError('E_BAD_ARG', 'jsWatch action 必须是 start/take/stop/status')
    return this.call('jsWatch', { action: a, limit: Math.max(1, Math.min(100, Number(limit) || 30)) }, { role })
  }

  async jsRead(needle, { max = 8, role } = {}) {
    const n = String(needle ?? '').trim().slice(0, 100)
    if (!n) throw new DouyinError('E_BAD_ARG', 'jsRead 需要 needle')
    const r = await this.call('jsRead', { needle: n, max: Math.max(1, Math.min(20, Number(max) || 8)) }, { role })
    return r && typeof r === 'object' ? r : null
  }

  async screenshot({ role } = {}) {
    const r = await this.call('screenshot', {}, { role })
    if (!r || typeof r !== 'object' || !r.file) {
      throw new DouyinError('E_PARSE', 'screenshot 应答缺少 file')
    }
    return { file: String(r.file) }
  }

  /** 鼠标滚轮下滚；dy 像素数 */
  async scroll(dy, { selector, role } = {}) {
    const n = Number(dy)
    if (!Number.isFinite(n)) throw new DouyinError('E_BAD_ARG', 'scroll 需要数字 dy')
    const r = await this.call('scroll', { dy: n, ...(selector ? { selector: String(selector) } : {}) }, { role })
    return r !== false
  }

  /**
   * 发送白名单按键（Escape/Enter/ArrowDown/ArrowUp/z/c/x）。
   * 桥默认拒绝“输入框聚焦时按键”（防打进输入框）；提交流程的 Enter / 关面板的 Escape
   * 需要显式 allowFocused:true（协议 v2 A10 逃生门），点赞/收藏不要传。
   * @returns {{ok:boolean,key:string,inputFocused:boolean}}
   */
  async press(key, { role, allowFocused = false } = {}) {
    if (!PRESS_KEYS.includes(key)) {
      throw new DouyinError('E_BAD_ARG', `press 只允许 ${PRESS_KEYS.join('/')}`)
    }
    const params = { key }
    if (allowFocused === true) params.allowFocused = true
    const r = await this.call('press', params, { role })
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      return { ok: r.ok !== false, key: asText(r.key) || String(key), inputFocused: r.inputFocused === true }
    }
    return { ok: r !== false, key: String(key), inputFocused: false }
  }

  /** 让远程桥拦截 image/font/media（block=true）；失败由调用方决定是否忽略 */
  async assets(block = true, { role } = {}) {
    const r = await this.call('assets', { block: block === true }, { role })
    return r !== false
  }

  /**
   * 点击选择器命中的第 nth 个元素（nth 从 0 开始）。
   * 协议 v2：timeoutMs（默认取 cfg.clickTimeoutMs，夹 200..15000）、scroll（默认按 cfg.clickScrollTimeoutMs>0）。
   */
  async click(selector, { nth, force, timeoutMs, scroll, role } = {}) {
    if (typeof selector !== 'string' || !selector.trim()) {
      throw new DouyinError('E_BAD_ARG', 'click 需要选择器')
    }
    const params = { selector }
    if (nth !== undefined && nth !== null) {
      const n = Number(nth)
      if (!Number.isInteger(n) || n < 0 || n > 100) throw new DouyinError('E_BAD_ARG', 'click.nth 必须是 0–100 的整数')
      params.nth = n
    }
    if (force !== undefined) params.force = force === true
    // 老桥会忽略这两个参数（它们只是多传的 JSON 字段），所以无条件透传是安全的
    const t = Number(timeoutMs ?? this.cfg?.clickTimeoutMs ?? 3000)
    params.timeoutMs = Math.max(200, Math.min(15000, Number.isFinite(t) ? Math.floor(t) : 3000))
    const scrollOn = scroll === undefined ? Number(this.cfg?.clickScrollTimeoutMs ?? 600) > 0 : scroll === true
    params.scroll = scrollOn
    const r = await this.call('click', params, { role })
    // 协议 v2：返回 {ok,ms}；老桥返回 true。统一成对象，调用方用 ok===false 判失败
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      return { ok: r.ok !== false, ms: Number.isFinite(Number(r.ms)) ? Number(r.ms) : null }
    }
    return { ok: r !== false, ms: null }
  }
}
