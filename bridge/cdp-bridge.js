#!/usr/bin/env node
'use strict';

/**
 * cdp-bridge.js — 远程 headful Chromium 的 Unix socket JSONL 桥。
 * 只暴露固定命令白名单；Playwright 内部走 --remote-debugging-pipe，不监听 CDP TCP。
 * 用法：由 start.sh 用 harness Node 24 启动。
 */

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const { chromium } = require('/persistent/pw/node_modules/playwright');

const BASE = process.env.CDP_BASE || '/persistent/cdp';
const PROFILE = process.env.CHROME_PROFILE || '/persistent/chrome-profile';
const SOCKET = path.join(BASE, 'bridge.sock');
const ENDPOINT = path.join(BASE, 'endpoint.json');
const LOG = path.join(BASE, 'bridge.log');
const PIDFILE = path.join(BASE, 'bridge.pid');
const SHOTS = path.join(BASE, 'shots');
// 2026-11-14 实测：/ 和 ?recommend=1 都会在数秒后落到 /jingxuan（精选，waterfall 卡片）；
// 只有导航「推荐」链接的完整 URL ?recommend=1&from_nav=1 稳定停在推荐（feed-active-video/单列播放器，3/3 实测）。
const DEFAULT_START_URL = 'https://www.douyin.com/?recommend=1&from_nav=1';
const START_URL = process.env.START_URL || DEFAULT_START_URL;
const NOTIFY_URL = process.env.NOTIFY_URL || START_URL;
const DM_URL = process.env.DM_URL || 'https://www.douyin.com/chat';
const DISPLAY = process.env.DISPLAY || ':20';
const XAUTHORITY = process.env.XAUTHORITY || '/manager/extensions/desktop/Xauthority';
const BROWSERS_DIR = process.env.PLAYWRIGHT_BROWSERS_PATH || '/persistent/pw-browsers';

// 多页面 role 模型：main / notify / dm 三个固定 tab，各自独立，互不导航。
const ROLES = Object.freeze(['main', 'notify', 'dm']);
const DEFAULT_ROLE = 'main';
const COMMANDS = [
  'ping', 'open', 'tabs', 'title', 'url', 'text', 'html', 'count',
  'list', 'links', 'click', 'scroll', 'press', 'assets', 'jsRead', 'jsWatch', 'jsClick', 'rect', 'activate', 'screenshot', 'restart',
  // 协议 v2（2026-11-16）：一次往返取状态 / 条件等待 / 接口响应确认 / 极快健康检查 / 桥内文本输入
  'health', 'probe', 'waitFor', 'netArm', 'netTake', 'type',
  // 2026-11-16：按可见文字 hover（通知入口是 hover 展开，且 :has-text 选择器在本页极慢）
  'hoverText',
];
const LIMITS = {
  open: 120000,
  restart: 120000,
  screenshot: 30000,
  click: 30000,
  scroll: 30000,
  press: 5000,
  assets: 30000,
  jsRead: 30000,
  jsWatch: 30000,
  jsClick: 30000,
  rect: 30000,
  activate: 30000,
  health: 5000,
  probe: 30000,
  waitFor: 12000,
  netArm: 30000,
  netTake: 30000,
  default: 30000,
};
/** ping 暴露的能力位：插件侧据此判断能否用新命令（老桥没有这个字段 → 走旧多调用路径） */
const CAPABILITIES = Object.freeze([
  'health', 'probe', 'waitFor', 'netArm', 'netTake', 'clickTimeout', 'clickNoScroll', 'openReuse',
  'type', 'pressHotkeys',
]);
/** click：非 force 默认 3s，force 默认 1.5s；scrollIntoViewIfNeeded 只给 600ms */
const CLICK_TIMEOUT_DEFAULT = 3000;
const CLICK_TIMEOUT_FORCE_DEFAULT = 1500;
const CLICK_TIMEOUT_MIN = 200;
const CLICK_TIMEOUT_MAX = 15000;
const CLICK_SCROLL_TIMEOUT = 600;
/** health：单 role 一次 evaluate 的上限；probe/waitFor 的通用短上限 */
const HEALTH_EVAL_TIMEOUT = 400;
const READYSTATE_TIMEOUT = 800;
const TITLE_FAST_TIMEOUT = 800;
const PROBE_MAX_COUNTS = 8;
const PROBE_MAX_ATTRS = 10;
const WAIT_STATES = Object.freeze(['attached', 'detached', 'visible', 'hidden']);
const WAIT_TIMEOUT_MIN = 50;
const WAIT_TIMEOUT_MAX = 8000;
const WAIT_TIMEOUT_DEFAULT = 2500;
/** netArm/netTake：只记 url/method/status/seq/ts，不存 body */
const NET_PATTERN_RE = /^[A-Za-z0-9_\-./?=&%:]{1,120}$/;
const NET_MAX_PATTERNS = 8;
const NET_MAX_EVENTS = 200;
const NET_TAKE_MAX_WANT = 50;
const NET_TAKE_MAX_EVENTS = 20;
const NET_TAKE_TIMEOUT_MIN = 50;
const NET_TAKE_TIMEOUT_MAX = 8000;
const NET_TAKE_TIMEOUT_DEFAULT = 1200;
const NET_TAKE_POLL_INTERVAL = 60;
/** selector 静态校验上限（Playwright 引擎语法留给运行时；这里只挡空/超长/控制字符） */
const SELECTOR_MAX_LEN = 512;
/** type：纯文本写入（A9）。只当纯文本，不接受脚本/表达式；keys 模式只允许可打印 ASCII */
const TYPE_MAX_CHARS = 2000;
const TYPE_MODES = Object.freeze(['auto', 'fill', 'insert', 'keys']);
const TYPE_FILL_TIMEOUT = 2500;
const TYPE_FILL_CLEAR_TIMEOUT = 1500;
const TYPE_FOCUS_CLICK_TIMEOUT = 800;
const PRINTABLE_ASCII_RE = /^[\x20-\x7E]*$/;
/** press：A10 快捷键白名单（z/c/x 是抖音网页版点赞/收藏/评论） */
const PRESS_NAMED_KEYS = Object.freeze(['Escape', 'Enter', 'ArrowDown', 'ArrowUp']);
const PRESS_HOTKEY_CHARS = Object.freeze(['z', 'c', 'x']);
const ALLOWED_HOSTS = new Set(['www.douyin.com', 'douyin.com', 'login.douyin.com']);

let context = null;
let launching = null;
let shuttingDown = false;
let pending = 0;
/** role -> Page（活着的角色页） */
const pageByRole = new Map();
/** Page -> role（tabs 反查用） */
const roleByPage = new WeakMap();
const DEFAULT_ASSET_TYPES = ['image', 'font', 'media'];
const CDP_TYPE = { image: 'Image', font: 'Font', media: 'Media' };
/** 资源拦截按 role 独立：主页面开图/关图不影响 notify/dm 页 */
const assetStateByRole = new Map();
/** CDP Fetch 会话按 role 独立 */
const cdpSessionByRole = new Map();
/** 已崩溃的 Page（WeakSet：page.isClosed() 在 renderer 崩溃时仍为 false，必须单独记） */
const crashedPages = new WeakSet();
/** 挂过生命周期的 Page（防重复挂） */
const watchedPages = new WeakSet();
/** role -> 崩溃时间戳（page.on('crash') 写入；health 直接读缓存，不再 evaluate） */
const crashedAtByRole = new Map();
/** role -> 崩溃瞬间的 url/title 快照（崩溃后不能 evaluate 取 title，只能回缓存） */
const crashedInfoByRole = new Map();
/** role -> 最近一次成功读到的 title（崩溃快照的兜底） */
const lastTitleByRole = new Map();
/** 与 Set 同款接口，方便按契约写法 add/has/delete */
const crashedRoles = {
  add: (role) => crashedAtByRole.set(role, Date.now()),
  has: (role) => crashedAtByRole.has(role),
  delete: (role) => crashedAtByRole.delete(role),
  keys: () => [...crashedAtByRole.keys()],
  clear: () => crashedAtByRole.clear(),
  at: (role) => crashedAtByRole.get(role) || 0,
};

function nowIso() { return new Date().toISOString(); }

function log(message) {
  const line = `${nowIso()} ${message}\n`;
  try {
    fs.appendFileSync(LOG, line, { mode: 0o600 });
  } catch {
    try { process.stderr.write(line); } catch {}
  }
}

function ensureDirs() {
  for (const dir of [BASE, SHOTS, PROFILE]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  for (const dir of [path.join(PROFILE, 'home'), path.join(PROFILE, 'xdg'), path.join(PROFILE, 'cache'), path.join(BASE, 'crash')]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try { fs.chmodSync(BASE, 0o700); } catch {}
  try { fs.chmodSync(SHOTS, 0o700); } catch {}
  try { fs.chmodSync(PROFILE, 0o700); } catch {}
}

function findChrome() {
  const explicit = String(process.env.CHROME_PATH || '').trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  let entries = [];
  try { entries = fs.readdirSync(BROWSERS_DIR); } catch {}
  const versions = entries
    .filter((name) => /^chromium-\d+$/.test(name))
    .map((name) => ({ name, n: Number(name.split('-')[1]) }))
    .sort((a, b) => b.n - a.n);
  for (const v of versions) {
    const candidate = path.join(BROWSERS_DIR, v.name, 'chrome-linux-arm64', 'chrome');
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const candidate of [
    path.join(BROWSERS_DIR, 'chromium-1243', 'chrome-linux-arm64', 'chrome'),
    '/usr/bin/chromium',
  ]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function clearSingleton() {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(PROFILE, name), { force: true }); } catch {}
  }
}

function browserAlive() {
  if (!context) return false;
  try {
    const b = context.browser?.();
    if (b && typeof b.isConnected === 'function') return b.isConnected();
    return Array.isArray(context.pages());
  } catch {
    return false;
  }
}

function pageAlive(p) {
  try { return Boolean(p && !p.isClosed() && !crashedPages.has(p)); } catch { return false; }
}

/** 同步取 url（page.url() 读主 frame 的缓存 URL，renderer 崩了也能取，不走 evaluate） */
function safeUrl(p) {
  try { return p ? String(p.url() || '') : ''; } catch { return ''; }
}

/**
 * 给任意 promise 套一个"到点就返回 fallback"的短上限。
 * 不取消原 promise，但两个分支都挂了 handler，不会产生 unhandledRejection。
 */
function withDeadline(promise, ms, fallback) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { done = true; resolve(fallback); }, ms);
    Promise.resolve(promise).then(
      (value) => { if (!done) { clearTimeout(timer); resolve(value); } },
      (error) => { if (!done) { clearTimeout(timer); reject(error); } },
    );
  });
}

/** 短上限取 title：比 pageTitle（3s）快，崩溃/超时都退化成空串 */
async function pageTitleFast(p, ms = TITLE_FAST_TIMEOUT) {
  try {
    const title = await withDeadline(p.title(), ms, '');
    const text = String(title || '');
    return text;
  } catch {
    return '';
  }
}

/** 短上限取 readyState；取不到返回空串（调用方自己决定降级） */
async function pageReadyState(p, ms = READYSTATE_TIMEOUT) {
  try {
    return String(await withDeadline(p.evaluate(() => document.readyState), ms, '') || '');
  } catch {
    return '';
  }
}

/**
 * 崩溃/关闭监听（协议 v2 §A8）：
 * - crash → 日志 + 从 pageByRole 摘掉 + 记 crashedRoles + close()，下次 ensureRolePage 自然重建；
 * - close → 只在映射仍指向该页时摘掉（避免误删新页）。
 * 每个 Page 只挂一次（WeakSet），重复注册不叠加。
 */
function watchPageLifecycle(p, role) {
  try {
    if (!p || watchedPages.has(p)) return p;
    watchedPages.add(p);
    p.on('crash', () => {
      crashedPages.add(p);
      crashedRoles.add(role);
      crashedInfoByRole.set(role, { url: safeUrl(p), title: lastTitleByRole.get(role) || '', at: crashedRoles.at(role) });
      if (pageByRole.get(role) === p) pageByRole.delete(role);
      log(`role=${role} page CRASHED url=${safeUrl(p)} (dropped from pageByRole)`);
      try { p.close().catch(() => {}); } catch {}
    });
    p.on('close', () => {
      if (pageByRole.get(role) === p) pageByRole.delete(role);
      log(`role=${role} page closed url=${safeUrl(p)}`);
    });
  } catch (error) {
    log(`watch lifecycle ${role}: ${String(error && error.message || error).slice(0, 160)}`);
  }
  return p;
}

/** 统一登记 role page：映射 + 生命周期监听 + 清掉该 role 的旧崩溃标记 */
function registerRolePage(role, p) {
  pageByRole.set(role, p);
  roleByPage.set(p, role);
  crashedRoles.delete(role);
  crashedInfoByRole.delete(role);
  watchPageLifecycle(p, role);
  return p;
}

/** 解析请求里的 role / pageRole；缺省 main，未知 role 明确报错。 */
function roleOfRequest(req) {
  const raw = req && (req.role !== undefined ? req.role : req.pageRole);
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_ROLE;
  const role = String(raw).trim().toLowerCase();
  if (!ROLES.includes(role)) {
    throw Object.assign(new Error(`E_BAD_ROLE: ${role} (allowed: ${ROLES.join('/')})`), { code: 'E_BAD_ROLE' });
  }
  return role;
}

function roleForPage(p) {
  try { return roleByPage.get(p) || null; } catch { return null; }
}

function getRolePage(role) {
  const p = pageByRole.get(role);
  if (pageAlive(p)) return p;
  if (p) pageByRole.delete(role);
  return null;
}

function liveRoles() {
  const out = {};
  for (const role of ROLES) out[role] = Boolean(getRolePage(role));
  return out;
}

async function stopBrowser() {
  const old = context;
  context = null;
  pageByRole.clear();
  cdpSessionByRole.clear();
  assetStateByRole.clear();
  if (!old) return;
  if (externalBrowser) {
    try { await externalBrowser.close(); } catch (error) { log(`disconnect cdp: ${String(error.message || error).slice(0, 200)}`); }
    externalBrowser = null;
    return;
  }
  try { await old.close(); } catch (error) { log(`close browser: ${String(error.message || error).slice(0, 200)}`); }
}

async function ensureBrowser() {
  if (!browserAlive()) await launchBrowser();
  if (!context) throw Object.assign(new Error('E_BROWSER_DOWN'), { code: 'E_BROWSER_DOWN' });
  return context;
}

async function pageTitle(p) {
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(''), 3000);
      Promise.resolve()
        .then(() => p.title())
        .then((t) => { clearTimeout(timer); resolve(String(t || '')); })
        .catch(() => { clearTimeout(timer); resolve(''); });
    });
  } catch {
    return '';
  }
}

/**
 * 非 main 页统一静音：推荐流在后台 tab 也可能 autoplay，三个 tab 同时出声会打扰主页面。
 * 用 addInitScript 在页面脚本前挂 play 捕获；只挂 notify/dm 页，不影响 main 的音频。
 */
async function attachMute(p) {
  try {
    await p.addInitScript(() => {
      const mute = (el) => { try { el.muted = true; } catch {} };
      document.addEventListener('play', (event) => {
        const t = event && event.target;
        if (t && (t.tagName === 'VIDEO' || t.tagName === 'AUDIO')) mute(t);
      }, true);
      document.addEventListener('DOMContentLoaded', () => {
        try { document.querySelectorAll('video,audio').forEach(mute); } catch {}
      }, { once: true });
    });
  } catch (error) {
    log(`mute init ${String(error.message || error).slice(0, 160)}`);
  }
}

function assetState(role) {
  let state = assetStateByRole.get(role);
  if (!state) {
    state = { block: false, types: new Set(DEFAULT_ASSET_TYPES) };
    assetStateByRole.set(role, state);
  }
  return state;
}

async function ensureCdpSession(role) {
  const existing = cdpSessionByRole.get(role);
  if (existing) return existing;
  const p = await ensureRolePage(role);
  const session = await context.newCDPSession(p);
  session.on('Fetch.requestPaused', async (event) => {
    try {
      await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
    } catch {}
  });
  cdpSessionByRole.set(role, session);
  return session;
}

async function applyAssetBlock(role) {
  if (!context) return;
  const state = assetState(role);
  let session = cdpSessionByRole.get(role) || null;
  if (!session) {
    if (!state.block) return;
    session = await ensureCdpSession(role);
  }
  try {
    await session.send('Fetch.disable');
  } catch {}
  if (!state.block) {
    log(`assets block off role=${role}`);
    return;
  }
  const types = [...state.types].map((t) => CDP_TYPE[t]).filter(Boolean);
  if (!types.length) {
    log(`assets block on role=${role} (types empty)`);
    return;
  }
  await session.send('Fetch.enable', {
    patterns: types.map((resourceType) => ({ urlPattern: '*', resourceType })),
  });
  log(`assets block on role=${role} ${types.join(',')}`);
}

async function cmdAssets(req) {
  const role = roleOfRequest(req);
  if (typeof req.block !== 'boolean') throw Object.assign(new Error('E_BAD_BLOCK: boolean required'), { code: 'E_BAD_BLOCK' });
  const allowed = new Set(DEFAULT_ASSET_TYPES);
  let nextTypes = null;
  if (Array.isArray(req.types)) {
    for (const t of req.types) {
      if (!allowed.has(String(t))) throw Object.assign(new Error(`E_BAD_TYPE: ${t}`), { code: 'E_BAD_TYPE' });
    }
    nextTypes = req.types.map(String);
  }
  await ensureRolePage(role);
  const state = assetState(role);
  if (nextTypes) state.types = new Set(nextTypes);
  if (req.block && !nextTypes) state.types = new Set(DEFAULT_ASSET_TYPES);
  state.block = req.block;
  await applyAssetBlock(role);
  return { role, block: state.block, types: [...state.types] };
}



// ===== 外部 Chromium 150（本容器专用）=====
// Playwright 自带的新版 chromium 在 proot 下会 SIGTRAP；用 Debian Chromium 150 手动起 CDP，
// Playwright 只做 connectOverCDP，不负责 launch。
const CHROME_BIN = process.env.DOUYIN_CHROME_BIN || '/usr/local/bin/chromium150';
const CDP_PORT = Number(process.env.DOUYIN_CDP_PORT || 9222);
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
let externalBrowser = null;

async function cdpReady() {
  try {
    const r = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

async function ensureExternalChrome() {
  if (await cdpReady()) return;
  const { spawn } = require('node:child_process');
  log(`spawn ${CHROME_BIN} --remote-debugging-port=${CDP_PORT}`);
  const child = spawn(CHROME_BIN, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=2380,1040', '--window-position=10,20',
    '--no-first-run', '--no-default-browser-check', '--disable-popup-blocking',
    '--lang=zh-CN',
  ], { detached: true, stdio: 'ignore', env: { ...process.env, DISPLAY, XAUTHORITY } });
  child.unref();
  for (let i = 0; i < 120; i++) {
    if (await cdpReady()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Object.assign(new Error('E_NO_CDP: chromium150 CDP not ready'), { code: 'E_NO_CDP' });
}
// ===== 外部 Chromium 结束 =====

async function launchBrowser() {
  if (launching) return launching;
  launching = (async () => {
    await stopBrowser();
    ensureDirs();
    clearSingleton();
    log('ensure external chromium150 + connectOverCDP');
    await ensureExternalChrome();
    externalBrowser = await chromium.connectOverCDP(CDP_URL, { timeout: 60000 });
    context = externalBrowser.contexts()[0] || await externalBrowser.newContext();
    context.setDefaultTimeout(30000);
    context.setDefaultNavigationTimeout(60000);
    // 协议 v2 §A8：context 关闭清理 role 映射（下次 ensureBrowser 重建）
    try {
      context.on('close', () => {
        log('context closed: clearing role pages');
        pageByRole.clear();
        cdpSessionByRole.clear();
        assetStateByRole.clear();
        crashedRoles.clear();
        crashedInfoByRole.clear();
        lastTitleByRole.clear();
      });
    } catch (error) {
      log(`context close listener: ${String(error && error.message || error).slice(0, 160)}`);
    }
    const pages = context.pages();
    const main = pages[0] || await context.newPage();
    registerRolePage('main', main);
    if (START_URL) {
      try {
        await gotoPage(main, START_URL);
      } catch (error) {
        log(`startup goto main: ${String(error.message || error).slice(0, 300)}`);
      }
    }
    log(`role=main ready url=${main.url()}`);
    // 后台两个 tab：notify 停在推荐首页（通知入口/角标），dm 停在 /chat（私信 watcher）。
    // 它们不抢 main，且统一静音，避免后台视频出声。
    for (const role of ['notify', 'dm']) {
      try {
        const p = await context.newPage();
        registerRolePage(role, p);
        await attachMute(p);
        if (role !== 'main') {
          // 后台角色页不允许播放视频：重写 play()、监听 play 事件、1 秒巡检
          try {
            await p.addInitScript(() => {
              const stop = () => { document.querySelectorAll('video').forEach((v) => { try { if (!v.paused) v.pause(); } catch (e) {} }); };
              try {
                HTMLMediaElement.prototype.play = function () { try { this.pause(); } catch (e) {} return Promise.reject(new Error('dsh-bg-blocked')); };
              } catch (e) {}
              document.addEventListener('play', (ev) => { try { ev.target.pause(); } catch (e) {} }, true);
              setInterval(stop, 1000);
              try { new MutationObserver(stop).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
              window.addEventListener('load', stop);
            });
          } catch (e) { log(`no-video init ${role}: ${String(e.message || e).slice(0, 120)}`); }
        }
        // notify 页只服务“读通知”：屏蔽 media/image/font，减少解码与渲染开销（文本/选择器不受影响）
        // 可用 DOUYIN_NOTIFY_LIGHT=0 关闭；DOUYIN_NOTIFY_LIGHT=all 连 dm 页一起屏蔽
        const lightTargets = role === 'notify' ? ['media', 'image', 'font']
          : (process.env.DOUYIN_NOTIFY_LIGHT === 'all' && role === 'dm' ? ['media', 'image', 'font'] : null);
        if (lightTargets && process.env.DOUYIN_NOTIFY_LIGHT === '1') {
          try {
            await p.route('**/*', (route) => {
              const t = route.request().resourceType();
              return lightTargets.includes(t) ? route.abort() : route.continue();
            });
          } catch (e) { log(`light route ${role}: ${String(e.message || e).slice(0, 120)}`); }
        }
        const initial = role === 'notify' ? NOTIFY_URL : DM_URL;
        if (initial) {
          try {
            await gotoPage(p, initial);
          } catch (error) {
            log(`startup goto ${role}: ${String(error.message || error).slice(0, 300)}`);
          }
        }
        log(`role=${role} ready url=${p.url()}`);
      } catch (error) {
        log(`role=${role} init failed: ${String(error.message || error).slice(0, 300)}`);
      }
    }
    try { await main.bringToFront(); } catch {}
    // 关掉非角色页（Chrome 恢复会话会带出多余 tab，白烧 CPU）
    for (const extra of context.pages()) {
      if (!roleByPage.has(extra)) {
        try { const u = String(extra.url()).slice(0, 80); await extra.close(); log(`closed extra tab ${u}`); } catch (e) {}
      }
    }
    log(`browser ready roles=${JSON.stringify(liveRoles())} pages=${context.pages().length}`);
    // 8 秒后再清一次非角色页（Chrome 恢复会话的 tab 可能晚到）
    setTimeout(() => {
      try {
        for (const extra of context.pages()) {
          if (!roleByPage.has(extra)) { extra.close().catch(() => {}); }
        }
      } catch (e) {}
    }, 8000);
    return context;
  })();
  try { return await launching; } finally { launching = null; }
}

/**
 * 取某个 role 的 page；不存在（被用户关掉/首次创建）才新建，绝不碰其他 role。
 * main 迁移/回收后也走这里，但不自动导航；notify/dm 新建时补默认 URL。
 */
/**
 * 2026-11-17：清理"同一个 role 有多个活 page"的孤儿 tab（实测出现过两个 /chat 都属于 dm）。
 * 只关**桥自己管理**的重复 role 页（roleByPage 里有、且不是 pageByRole 当前指向的那个），
 * 不动用户手动打开的普通 tab。
 */
async function pruneDuplicateRolePages() {
  if (!context) return 0;
  let closed = 0;
  try {
    for (const p of context.pages()) {
      const role = roleByPage.get(p);
      if (!role) continue;
      if (pageByRole.get(role) === p) continue;
      try {
        roleByPage.delete(p);
        await p.close();
        closed += 1;
        log(`closed duplicate role page role=${role}`);
      } catch (error) {
        log(`close duplicate role page failed role=${role}: ${String(error && error.message || error).slice(0, 120)}`);
      }
    }
  } catch {}
  return closed;
}

async function ensureRolePage(role) {
  await ensureBrowser();
  await pruneDuplicateRolePages();
  let p = getRolePage(role);
  if (p) return p;
  if (crashedRoles.has(role)) log(`role=${role} rebuilding after crash at=${crashedRoles.at(role)}`);
  p = await context.newPage();
  registerRolePage(role, p);
  if (role !== 'main') await attachMute(p);
  log(`role=${role} recreated`);
  const initial = role === 'notify' ? NOTIFY_URL : role === 'dm' ? DM_URL : '';
  if (initial) {
    try {
      await gotoPage(p, initial);
      log(`role=${role} initial url=${p.url()}`);
    } catch (error) {
      log(`role=${role} initial goto: ${String(error.message || error).slice(0, 300)}`);
    }
  }
  const state = assetState(role);
  if (state.block) {
    try { await applyAssetBlock(role); } catch (error) { log(`apply assets ${role}: ${String(error.message || error).slice(0, 160)}`); }
  }
  return p;
}

async function gotoPage(p, url) {
  try {
    return await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (error) {
    const msg = String(error.message || error);
    // 搜索页常常 domcontentloaded 迟迟不触发；退到 commit，让插件自己等卡片
    log(`goto fallback commit: ${msg.slice(0, 120)}`);
    return await p.goto(url, { waitUntil: 'commit', timeout: 30000 });
  }
}

function normalizeDouyinUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw Object.assign(new Error('E_BAD_URL: empty'), { code: 'E_BAD_URL' });
  let u;
  try { u = new URL(raw); } catch { throw Object.assign(new Error('E_BAD_URL: invalid url'), { code: 'E_BAD_URL' }); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw Object.assign(new Error('E_BAD_URL: only http(s)'), { code: 'E_BAD_URL' });
  }
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
    throw Object.assign(new Error(`E_BAD_URL: host ${u.hostname} not allowed`), { code: 'E_BAD_URL' });
  }
  u.protocol = 'https:';
  return u.toString();
}

// ===== 纯校验/归一化函数（可单测：不碰浏览器）=====

function codeError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function badArg(message) { return codeError('E_BAD_ARG', message); }
function badSelector(message) { return codeError('E_BAD_SELECTOR', message); }
function badPattern(message) { return codeError('E_BAD_PATTERN', message); }

/**
 * selector 静态校验：只挡空/超长/控制字符（引擎语法仍由 Playwright 运行时判定）。
 * probe 的 counts 单项用它做"宽松判定"（invalid → -1），waitFor/click 用它抛 E_BAD_SELECTOR。
 */
function selectorOk(selector) {
  const raw = typeof selector === 'string' ? selector : String(selector === undefined || selector === null ? '' : selector);
  const s = raw.trim();
  if (!s) return false;
  if (s.length > SELECTOR_MAX_LEN) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  return true;
}

function validateSelector(selector) {
  const s = String(selector === undefined || selector === null ? '' : selector).trim();
  if (!s) throw badSelector('empty selector');
  if (s.length > SELECTOR_MAX_LEN) throw badSelector(`selector too long (${s.length} > ${SELECTOR_MAX_LEN})`);
  if (/[\u0000-\u001f\u007f]/.test(s)) throw badSelector('selector contains control chars');
  return s;
}

/** netArm patterns：URL 子串白名单，≤8 个、每个 1..120 且只允许 URL 常见字符；去重保序 */
function validatePatterns(input) {
  if (input === undefined || input === null) throw badArg('patterns: non-empty array required');
  if (!Array.isArray(input)) throw badArg('patterns: array required');
  if (input.length === 0) throw badArg('patterns: non-empty array required');
  if (input.length > NET_MAX_PATTERNS) throw badPattern(`too many patterns (${input.length} > ${NET_MAX_PATTERNS})`);
  const out = [];
  for (const raw of input) {
    const s = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!NET_PATTERN_RE.test(s)) throw badPattern(`rejected pattern (allowed: ${NET_PATTERN_RE.source}, max 120): ${s.slice(0, 60)}`);
    if (!out.includes(s)) out.push(s);
  }
  if (out.length === 0) throw badArg('patterns: empty after normalize');
  return out;
}

/** probe counts：≤8 个、按请求顺序保留原始 selector 字符串（非法项留给调用处标 -1） */
function normalizeProbeCounts(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw badArg('counts: array required');
  if (input.length > PROBE_MAX_COUNTS) throw badArg(`counts too many (${input.length} > ${PROBE_MAX_COUNTS})`);
  return input.map((x) => String(x === undefined || x === null ? '' : x).trim());
}

function normalizeWaitState(input) {
  const s = String(input === undefined || input === null || input === '' ? 'visible' : input).trim().toLowerCase();
  if (!WAIT_STATES.includes(s)) throw badArg(`state must be one of ${WAIT_STATES.join('/')}, got ${s.slice(0, 30)}`);
  return s;
}

/** open reuse 的 URL 比对口径：忽略 hash、忽略末尾 `/`、查询串保留（顺序不归一） */
function normalizeUrlForCompare(input) {
  const raw = String(input === undefined || input === null ? '' : input).trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const pathname = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${pathname}${u.search}`;
  } catch {
    return raw.replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

function charCount(text) {
  return [...String(text === undefined || text === null ? '' : text)].length;
}

/** type 的正文校验（A9）：必须是字符串、按码点 ≤2000；空串合法（表示"只清空"）；只当纯文本 */
function validateTypeText(input) {
  if (typeof input !== 'string') throw badArg('text: string required (pure text only)');
  if (charCount(input) > TYPE_MAX_CHARS) throw badArg(`text too long (${charCount(input)} > ${TYPE_MAX_CHARS})`);
  return input;
}

/** keys 模式只允许可打印 ASCII（\x20-\x7E），否则 E_BAD_TEXT */
function validateKeysText(text) {
  const s = validateTypeText(text);
  if (!PRINTABLE_ASCII_RE.test(s)) throw codeError('E_BAD_TEXT', 'keys mode allows printable ASCII only [\\x20-\\x7E]');
  return s;
}

function normalizeTypeMode(input) {
  const s = String(input === undefined || input === null || input === '' ? 'auto' : input).trim().toLowerCase();
  if (!TYPE_MODES.includes(s)) throw badArg(`mode must be one of ${TYPE_MODES.join('/')}, got ${s.slice(0, 20)}`);
  return s;
}

function normalizeNth(input) {
  if (input === undefined || input === null || input === '') return 0;
  const n = Number(input);
  if (!Number.isInteger(n) || n < 0) throw codeError('E_BAD_NTH', `nth must be integer >= 0, got ${String(input).slice(0, 20)}`);
  return n;
}

/** press 键名归一：命名键必须精确（旧协议兼容），z/c/x 大小写都收，统一小写 */
function normalizePressKey(input) {
  const raw = String(input === undefined || input === null ? '' : input).trim();
  if (!raw) throw codeError('E_BAD_KEY', 'empty key');
  if (raw.length === 1) {
    const lower = raw.toLowerCase();
    if (PRESS_HOTKEY_CHARS.includes(lower)) return lower;
    throw codeError('E_BAD_KEY', `hotkey must be one of ${PRESS_HOTKEY_CHARS.join('/')}`);
  }
  if (PRESS_NAMED_KEYS.includes(raw)) return raw;
  throw codeError('E_BAD_KEY', `${raw.slice(0, 20)} (allowed: ${[...PRESS_NAMED_KEYS, ...PRESS_HOTKEY_CHARS].join('/')})`);
}

/**
 * activeElement 是否是可编辑控件（纯函数，便于单测）。
 * 入参是页面里取回的描述对象：{tagName, isContentEditable, editableAncestor}。
 */
function isEditableDescriptor(desc) {
  if (!desc || typeof desc !== 'object') return false;
  const tag = String(desc.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (desc.isContentEditable === true) return true;
  if (desc.editableAncestor === true) return true;
  return false;
}

function pngSize(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length < 24 || b.toString('ascii', 1, 4) !== 'PNG') return { width: null, height: null };
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch {
    return { width: null, height: null };
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/**
 * 协议 v2 §A7：
 * - reuse=true（默认）且目标 URL 与当前 URL 归一化相等（忽略 hash/末尾 `/`）→ 不导航，直接返回 reused；
 * - 删掉固定 waitForTimeout(1000)，改 readyState 条件等待（800ms 上限）；
 * - title 为空再等 500ms 取一次；整体目标 p50 ≤ 2s（真导航除外）。
 */
async function cmdOpen(req) {
  const role = roleOfRequest(req);
  const url = normalizeDouyinUrl(req.url);
  const p = await ensureRolePage(role);
  const reuse = req.reuse !== false;
  if (reuse) {
    const current = safeUrl(p);
    if (current && normalizeUrlForCompare(current) === normalizeUrlForCompare(url)) {
      const title = await pageTitleFast(p);
      if (title) lastTitleByRole.set(role, title);
      return { role, url: current, status: 0, title, reused: true };
    }
  }
  const response = await gotoPage(p, url);
  const status = response && typeof response.status === 'function' ? response.status() : 0;
  try {
    await p.waitForFunction(() => document.readyState !== 'loading', undefined, { timeout: READYSTATE_TIMEOUT, polling: 50 });
  } catch {}
  let title = await pageTitleFast(p);
  if (!title) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    title = await pageTitleFast(p, 500);
  }
  const finalUrl = safeUrl(p);
  if (title) lastTitleByRole.set(role, title);
  return { role, url: finalUrl, status, title };
}

async function cmdText(req) {
  const role = roleOfRequest(req);
  const p = await ensureRolePage(role);
  const loc = p.locator(String(req.selector || ''));
  if (await loc.count() === 0) return null;
  return await loc.first().innerText({ timeout: 5000 });
}

async function cmdHtml(req) {
  const role = roleOfRequest(req);
  const p = await ensureRolePage(role);
  const max = clampInt(req.max, 1, 20000, 2000);
  const loc = p.locator(String(req.selector || ''));
  if (await loc.count() === 0) return null;
  const html = await loc.first().innerHTML({ timeout: 5000 });
  return String(html).slice(0, max);
}

async function cmdCount(req) {
  const role = roleOfRequest(req);
  const p = await ensureRolePage(role);
  return await p.locator(String(req.selector || '')).count();
}

/**
 * list 的行抽取逻辑（cmdList 与 cmdProbe 共用，截断规则一致）：
 * count = 选择器命中数；rows 最多 limit 行，text 截 textLen，attrs 最多 10 个。
 *
 * 2026-11-16 性能改造：旧实现每行 1 次 innerText + N 次 getAttribute（Playwright 每属性一次 CDP 往返），
 * 实测 list 4 attrs ≈ 800ms。现在**页内一次 evaluate** 完成 count + 文本 + 属性，
 * 只把结果 JSON 带回来（截断在页内做），典型 10–30ms。固定只读函数，不接收任意脚本。
 */
async function listRows(p, selector, options = {}) {
  const limit = clampInt(options.limit, 1, 50, 20);
  const textLen = clampInt(options.textLen, 1, 500, 60);
  const attrs = Array.isArray(options.attrs) ? options.attrs.map(String).slice(0, PROBE_MAX_ATTRS) : [];
  try {
    const result = await p.evaluate(({ selector, limit, textLen, attrs }) => {
      const nodes = document.querySelectorAll(selector);
      const count = nodes.length;
      const rows = [];
      const n = Math.min(count, limit);
      for (let i = 0; i < n; i += 1) {
        const el = nodes[i];
        const row = {};
        try {
          row.text = String(el.innerText || '').slice(0, textLen);
        } catch {
          row.text = null;
        }
        for (const attr of attrs) {
          try { row[attr] = el.getAttribute(attr); } catch { row[attr] = null; }
        }
        rows.push(row);
      }
      return { count, rows };
    }, { selector, limit, textLen, attrs });
    if (result && typeof result === 'object') return result;
  } catch (error) {
    // 页内 querySelectorAll 跑不了（Playwright 扩展语法 :has-text()/:text-is()/>> 链）→ 老实现兜底
    const msg = String(error && error.message || error);
    if (!/not a valid selector|is not a valid selector|Unexpected token|Unknown engine|SyntaxError|DOMException/i.test(msg)) throw error;
  }
  const loc = p.locator(selector);
  const count = await loc.count();
  const out = [];
  for (let i = 0; i < count && out.length < limit; i += 1) {
    const el = loc.nth(i);
    const item = {};
    try {
      const text = await el.innerText({ timeout: 5000 });
      item.text = String(text || '').slice(0, textLen);
    } catch { item.text = null; }
    for (const attr of attrs) {
      try { item[attr] = await el.getAttribute(attr); } catch { item[attr] = null; }
    }
    out.push(item);
  }
  return { count, rows: out };
}

async function cmdList(req) {
  const role = roleOfRequest(req);
  const p = await ensureRolePage(role);
  const { rows } = await listRows(p, String(req.selector || ''), req);
  return rows;
}

/**
 * 只读 JS 定位（2026-11-14，主人允许）：在页面执行固定只读函数，不接收任意脚本。
 * 用于找评论区里的 @提及/作者；返回 DOM 评论、body 命中、页面内嵌 JSON 命中。
 */
async function cmdJsClick(req) {
  const role = roleOfRequest(req);
  const p = await ensureRolePage(role);
  const selector = String(req.selector || '');
  if (!selector) throw Object.assign(new Error('E_SELECTOR_REQUIRED'), { code: 'E_SELECTOR_REQUIRED' });
  const nth = Number.isInteger(Number(req.nth)) ? Number(req.nth) : 0;
  return await p.evaluate(({ selector, nth }) => {
    const el = document.querySelectorAll(selector)[nth];
    if (!el) return { ok: false, code: 'E_NO_ELEMENT', count: document.querySelectorAll(selector).length };
    const r = el.getBoundingClientRect();
    const target = (r.width > 0 && r.height > 0) ? el : el.closest('div') || el;
    try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
    return { ok: true, tag: target.tagName, text: String(target.innerText || '').slice(0, 200), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  }, { selector, nth });
}

async function cmdRect(req) {
  const role = roleOfRequest(req);
  const p = await ensureRolePage(role);
  const selector = String(req.selector || '');
  if (!selector) throw Object.assign(new Error('E_SELECTOR_REQUIRED'), { code: 'E_SELECTOR_REQUIRED' });
  const nth = Number.isInteger(Number(req.nth)) ? Number(req.nth) : 0;
  const box = await p.evaluate(({ selector, nth }) => {
    const els = document.querySelectorAll(selector);
    const el = els[nth];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, { selector, nth });
  if (!box) throw Object.assign(new Error('E_NO_BOX'), { code: 'E_NO_BOX' });
  const view = await p.evaluate(() => ({ screenX: window.screenX, screenY: window.screenY, outerHeight: window.outerHeight, innerHeight: window.innerHeight, dpr: window.devicePixelRatio }));
  return { box, view, abs: { x: view.screenX + box.x, y: view.screenY + (view.outerHeight - view.innerHeight) + box.y } };
}


async function cmdJsWatch(req) {
  const role = roleOfRequest(req);
  const p = await ensureRolePage(role);
  const action = String(req.action || 'status');
  const limit = clampInt(req.limit, 1, 100, 30);
  const result = await p.evaluate(({ action, limit }) => {
    const w = window.__dshJsWatch || (window.__dshJsWatch = {
      events: [], seq: 0, cursor: 0, installedAt: Date.now(), observer: null, fetchWrapped: false, xhrWrapped: false,
    });
    const cut = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const push = (kind, data) => {
      const text = cut(data && (data.text || data.body || data.url || ''), 800);
      const key = `${kind}|${text}|${data && data.url ? data.url : ''}`;
      w.seq += 1;
      w.events.push({ seq: w.seq, at: Date.now(), kind, key, ...data, text });
      if (w.events.length > 800) w.events.splice(0, w.events.length - 800);
    };
    const isInteresting = (text) => /通知|私信|评论|互动|消息|提到了你|回复了|@|mention|message|comment|notification|interact/i.test(text);
    const scanNode = (node) => {
      if (!(node instanceof Element)) return;
      try {
        const text = String(node.innerText || '').slice(0, 600);
        if (!text || !isInteresting(text)) return;
        if (node.matches && (node.matches('[data-e2e="listDlgTest-container"], [data-e2e="conversation-item"], [class*="Conversation"], [class*="MessageItem"]') || node.querySelector('[data-e2e="listDlgTest-container"], [data-e2e="conversation-item"]'))) {
          push('dom', { text, selector: node.getAttribute('data-e2e') || node.className || '', html: cut(node.innerHTML, 1200) });
        }
      } catch {}
    };
    if (action === 'start' || action === 'status') {
      if (!w.observer) {
        w.observer = new MutationObserver((records) => {
          for (const r of records) {
            for (const n of r.addedNodes || []) scanNode(n);
          }
        });
        try { w.observer.observe(document.body || document.documentElement, { childList: true, subtree: true }); } catch {}
      }
      if (!w.fetchWrapped && typeof window.fetch === 'function') {
        w.fetchWrapped = true;
        const orig = window.fetch;
        window.fetch = async function (...args) {
          const res = await orig.apply(this, args);
          try {
            const url = String(args[0] && args[0].url ? args[0].url : args[0] || '');
            if (isInteresting(url) || /notification|message|comment|interact|notice/i.test(url)) {
              const clone = res.clone();
              const body = await clone.text();
              if (isInteresting(body)) push('net', { url, body: body.slice(0, 1500) });
            }
          } catch {}
          return res;
        };
      }
      if (!w.xhrWrapped && typeof XMLHttpRequest !== 'undefined') {
        w.xhrWrapped = true;
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) { this.__dshUrl = String(url || ''); return origOpen.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function () {
          this.addEventListener('load', () => { try { const body = String(this.responseText || ''); if (isInteresting(this.__dshUrl) || isInteresting(body)) push('net', { url: this.__dshUrl || '', body: body.slice(0, 1500) }); } catch {} });
          return origSend.apply(this, arguments);
        };
      }
      return { ok: true, action, installed: Boolean(w.observer), fetchWrapped: w.fetchWrapped, xhrWrapped: w.xhrWrapped, seq: w.seq, cursor: w.cursor, pending: Math.max(0, w.events.length - w.cursor) };
    }
    if (action === 'take') {
      const out = w.events.slice(w.cursor, w.cursor + limit);
      w.cursor += out.length;
      return { ok: true, action, seq: w.seq, cursor: w.cursor, events: out, pending: Math.max(0, w.events.length - w.cursor) };
    }
    if (action === 'stop') {
      try { w.observer?.disconnect?.(); } catch {}
      w.observer = null;
      return { ok: true, action, seq: w.seq, cursor: w.cursor };
    }
    return { ok: false, action, error: 'unknown action' };
  }, { action, limit });
  return { role, ...(result && typeof result === 'object' ? result : { result }) };
}

async function cmdJsRead(req) {
  const role = roleOfRequest(req);
  const p = await ensureRolePage(role);
  const needle = String(req.needle || '').slice(0, 100);
  if (!needle) throw Object.assign(new Error('E_NEEDLE_REQUIRED'), { code: 'E_NEEDLE_REQUIRED' });
  const max = clampInt(req.max, 1, 20, 8);
  const scroll = req.scroll === true;
  return await p.evaluate(async ({ needle, max, scroll }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const cut = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const seen = new Set();
    const hits = [];
    const collect = () => {
      const nodes = document.querySelectorAll('[data-e2e="comment-item"], [class*="comment-item"], [class*="CommentItem"]');
      for (const el of nodes) {
        const t = String(el.innerText || '');
        if (!t) continue;
        const key = cut(t, 240);
        if (seen.has(key)) continue;
        seen.add(key);
        if (t.includes(needle) && hits.length < max) hits.push({ text: cut(t, 500), html: cut(el.innerHTML, 800) });
      }
      return nodes.length;
    };
    let commentCount = collect();
    if (scroll) {
      for (let round = 0; round < 10 && hits.length === 0; round += 1) {
        try {
          const buttons = [...document.querySelectorAll('button, [role="button"]')].filter((b) => /展开|展开更多/.test(String(b.innerText || '')));
          for (const b of buttons.slice(0, 30)) { try { b.click(); } catch {} }
        } catch {}
        const scroller = document.querySelector('[data-e2e="comment-list"]')
          || [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 100 && d.clientHeight > 200)
          || document.scrollingElement;
        try { scroller.scrollTop = scroller.scrollHeight; } catch {}
        await sleep(700);
        commentCount = Math.max(commentCount, collect());
      }
    }
    const bodyText = String(document.body && document.body.innerText || '');
    const bodyHits = [];
    for (const line of bodyText.split(/\n+/)) {
      if (line.includes(needle) && bodyHits.length < max) bodyHits.push(cut(line, 300));
    }
    const stateHits = [];
    for (const k of ['__INITIAL_STATE__', '__INIT_DATA__', '_ROUTER_DATA', 'RENDER_DATA']) {
      try {
        const raw = window[k];
        if (!raw) continue;
        const s = JSON.stringify(raw);
        const i = s.indexOf(needle);
        if (i >= 0 && stateHits.length < max) stateHits.push({ key: k, snippet: cut(s.slice(Math.max(0, i - 200), i + 500), 700) });
      } catch {}
    }
    return { url: location.href, title: document.title, bodyHasNeedle: bodyText.includes(needle), bodyHits, commentCount, comments: hits, stateHits, textHasNeedleInHtml: String(document.documentElement && document.documentElement.innerHTML || '').includes(needle) };
  }, { needle, max, scroll });
}


async function cmdLinks(req) {
  const role = roleOfRequest(req);
  const p = await ensureRolePage(role);
  const loc = p.locator('a');
  const count = await loc.count();
  const out = [];
  for (let i = 0; i < count && out.length < 200; i += 1) {
    const el = loc.nth(i);
    let href = null;
    let text = '';
    try { href = await el.getAttribute('href'); } catch {}
    try { text = String((await el.innerText({ timeout: 2000 })) || '').slice(0, 80); } catch {}
    out.push({ href, text });
  }
  return out;
}

/**
 * 协议 v2 §A6：
 * - timeoutMs 默认 3000（force 默认 1500），夹 200..15000，替代硬编码 15000；
 * - scroll 默认 true 但只给 600ms（fixed/零尺寸元素不再白等 3s），scroll:false 时跳过；
 * - 命中 0 个仍立即 E_SELECTOR_MISS；
 * - 成功返回 {ok:true,ms}（插件侧兼容布尔/对象两种）。
 */
/**
 * 按“可见文字”hover（协议 v2 追加，2026-11-16）。
 * 为什么需要：抖音右上角「通知」是 hover 才展开的下拉；而 `:has-text()` 这类 Playwright 扩展选择器
 * 在这个重页面上实测 >25s，不能用。这里用固定只读函数找「叶子节点文字完全相等」的元素，
 * 取包围盒中心后 page.mouse.move 过去——不接收任意脚本，只接收一段纯文字。
 */
async function cmdHoverText(req) {
  const role = roleOfRequest(req);
  const p = await ensureRolePage(role);
  const text = String(req.text === undefined || req.text === null ? '' : req.text).trim().slice(0, 40);
  if (!text) throw badArg('hoverText needs text');
  const nth = normalizeNth(req.nth);
  const box = await p.evaluate(({ text, nth }) => {
    const all = document.querySelectorAll('body *');
    const hits = [];
    for (const el of all) {
      if (el.children && el.children.length) continue;
      const t = String(el.textContent || '').trim();
      if (t !== text) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      hits.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      if (hits.length > 50) break;
    }
    return hits[nth] || null;
  }, { text, nth });
  if (!box) throw Object.assign(new Error(`E_TEXT_MISS: ${text}`), { code: 'E_TEXT_MISS' });
  await p.mouse.move(box.x, box.y);
  return { role, text, nth, x: box.x, y: box.y };
}

async function cmdClick(req) {
  const role = roleOfRequest(req);
  const p = await ensureRolePage(role);
  const rawSelector = String(req.selector || '');
  if (!selectorOk(rawSelector)) throw Object.assign(new Error('E_BAD_SELECTOR'), { code: 'E_BAD_SELECTOR' });
  const selector = rawSelector.trim();
  const loc = p.locator(selector);
  const count = await loc.count();
  if (count === 0) throw Object.assign(new Error('E_SELECTOR_MISS'), { code: 'E_SELECTOR_MISS' });
  let target = loc.first();
  if (req.nth !== undefined && req.nth !== null) {
    const nth = Number(req.nth);
    if (!Number.isInteger(nth) || nth < 0) throw Object.assign(new Error('E_BAD_NTH'), { code: 'E_BAD_NTH' });
    if (nth >= count) throw Object.assign(new Error(`E_INDEX: nth=${nth} count=${count}`), { code: 'E_INDEX' });
    target = loc.nth(nth);
  }
  const force = Boolean(req.force);
  const timeoutMs = clampInt(req.timeoutMs, CLICK_TIMEOUT_MIN, CLICK_TIMEOUT_MAX,
    force ? CLICK_TIMEOUT_FORCE_DEFAULT : CLICK_TIMEOUT_DEFAULT);
  const scroll = req.scroll !== false;
  const started = Date.now();
  // 滚动进视口只是尽力而为：零尺寸/fixed 的图标会在这里卡到超时，不该挡住点击本身
  if (scroll) {
    try {
      await target.scrollIntoViewIfNeeded({ timeout: CLICK_SCROLL_TIMEOUT });
    } catch {}
  }
  try {
    await target.click({ force, timeout: timeoutMs });
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    if (!force) throw error;
  }
  // force 兜底：元素被遮挡或没有可点尺寸时，直接派发一轮鼠标事件
  // 不用任意 JS：Playwright 的 dispatchEvent 只派发一个 click 事件
  const dispatched = await target.dispatchEvent('click').then(() => true).catch(() => false);
  if (!dispatched) throw Object.assign(new Error('E_CLICK_FAILED'), { code: 'E_CLICK_FAILED' });
  return { ok: true, ms: Date.now() - started, dispatched: true };
}

// ===== 协议 v2 新命令：health / probe / waitFor / netArm / netTake / type / press =====

const HEALTH_EVAL_FALLBACK = -1;

/** 单 role 健康判定（§A2）：crashed 走缓存不 evaluate；closed 直接判；否则 evaluate(()=>1) 带 400ms 上限 */
async function roleHealthOf(role) {
  const crashedAt = crashedRoles.at(role);
  if (crashedAt) {
    const cached = crashedInfoByRole.get(role) || {};
    return { url: cached.url || null, title: cached.title || lastTitleByRole.get(role) || '', renderer: 'crashed', crashed: true, crashedAt };
  }
  const p = getRolePage(role);
  if (!p) return { url: null, title: lastTitleByRole.get(role) || '', renderer: 'closed', crashed: false };
  const [aliveFlag, titleNow] = await Promise.all([
    withDeadline(p.evaluate(() => 1), HEALTH_EVAL_TIMEOUT, HEALTH_EVAL_FALLBACK).catch(() => HEALTH_EVAL_FALLBACK),
    pageTitleFast(p, 250),
  ]);
  const renderer = aliveFlag === 1 ? 'ok' : 'unknown';
  if (titleNow) lastTitleByRole.set(role, titleNow);
  return { url: safeUrl(p) || null, title: titleNow || lastTitleByRole.get(role) || '', renderer, crashed: false };
}

/** §A2：极快健康检查；不 ensureBrowser（浏览器没起也立刻回答），三个 role 并行 evaluate */
async function cmdHealth() {
  let pages = 0;
  let browser = false;
  try {
    browser = browserAlive();
    pages = context ? context.pages().length : 0;
  } catch {}
  const entries = await Promise.all(ROLES.map(async (role) => [role, await roleHealthOf(role)]));
  const roles = {};
  for (const [role, info] of entries) roles[role] = info;
  return { browser, pages, roles };
}

/** §A3：一次往返拿 url/title/readyState/多个 count/一次 list */
async function cmdProbe(req) {
  const role = roleOfRequest(req);
  const countsReq = normalizeProbeCounts(req.counts);
  const selectorRaw = req.selector === undefined || req.selector === null ? '' : String(req.selector);
  const selector = selectorRaw.trim();
  if (!countsReq.length && !selector) throw badArg('probe needs counts[] or selector');
  if (selector && !selectorOk(selector)) throw badSelector('selector invalid');
  const p = await ensureRolePage(role);
  const [title, readyState] = await Promise.all([pageTitleFast(p), pageReadyState(p)]);
  if (title) lastTitleByRole.set(role, title);
  // counts 并行；单个 selector 非法/取不到只让该项 -1，整体不失败
  // counts：一次页内 evaluate 全查（旧实现每个 selector 一次 locator.count 往返，且
  // [id^="..."]/[class*="..."] 这类属性前缀在选择器引擎里极慢，实测 846ms）。
  // 单个 selector 非法/取不到只让该项 -1，整体不失败。
  const validSel = countsReq.filter((sel) => sel && selectorOk(sel));
  const counts = {};
  for (const sel of countsReq) if (!sel || !selectorOk(sel)) counts[sel] = -1;
  if (validSel.length) {
    let inPage = null;
    try {
      inPage = await p.evaluate(({ sels }) => {
        const out = {};
        for (const s of sels) {
          try { out[s] = document.querySelectorAll(s).length; } catch { out[s] = -1; }
        }
        return out;
      }, { sels: validSel });
    } catch {
      inPage = null; // 页面崩溃/evaluate 失败 → 退回逐项（保持旧行为，不伪装 0）
    }
    if (inPage && typeof inPage === 'object') {
      const unresolved = [];
      for (const sel of validSel) {
        const n = Number(inPage[sel]);
        if (Number.isFinite(n) && n >= 0) counts[sel] = Math.floor(n);
        else unresolved.push(sel);
      }
      // 页内 querySelectorAll 跑不了的（Playwright 扩展语法如 :has-text()/:text-is()、>> 链）→
      // 退回 Playwright locator.count，保证老选择器语义不变（只对这类做一次往返）。
      if (unresolved.length) {
        const entries = await Promise.all(unresolved.map(async (sel) => {
          try { return [sel, await p.locator(sel).count()]; } catch { return [sel, -1]; }
        }));
        for (const [sel, value] of entries) counts[sel] = value;
      }
    } else {
      const entries = await Promise.all(validSel.map(async (sel) => {
        try { return [sel, await p.locator(sel).count()]; } catch { return [sel, -1]; }
      }));
      for (const [sel, value] of entries) counts[sel] = value;
    }
  }
  let count = null;
  let rows = [];
  if (selector) {
    try {
      const out = await listRows(p, selector, req);
      count = out.count;
      rows = out.rows;
    } catch (error) {
      const msg = String(error && error.message || error);
      // 只有"选择器用不了"才归 E_BAD_SELECTOR；崩溃/超时要原样抛，别伪装成选择器问题
      if (/valid selector|unexpected token|unknown engine|parse error|selector.*invalid/i.test(msg)) {
        throw badSelector(msg.slice(0, 140));
      }
      throw error;
    }
  }
  return { role, url: safeUrl(p), title, readyState, counts, count, rows };
}

/** Playwright 的超时错误（waitFor 等），用于把"超时"和"崩溃/非法选择器"分开 */
function isPlaywrightTimeout(error) {
  const name = String(error && error.name || '');
  const msg = String(error && error.message || '');
  return name === 'TimeoutError' || /Timeout \d+ms exceeded/i.test(msg);
}

/** §A4：条件等待，超时 matched:false（不报错）；selector 非法 E_BAD_SELECTOR */
async function cmdWaitFor(req) {
  const role = roleOfRequest(req);
  const selector = validateSelector(req.selector);
  const state = normalizeWaitState(req.state);
  const timeoutMs = clampInt(req.timeoutMs, WAIT_TIMEOUT_MIN, WAIT_TIMEOUT_MAX, WAIT_TIMEOUT_DEFAULT);
  const p = await ensureRolePage(role);
  const started = Date.now();
  try {
    await p.locator(selector).first().waitFor({ state, timeout: timeoutMs });
    return { role, matched: true, ms: Date.now() - started, state, timeoutMs };
  } catch (error) {
    if (isPlaywrightTimeout(error)) return { role, matched: false, ms: Date.now() - started, state, timeoutMs };
    const msg = String(error && error.message || error);
    if (/valid selector|unexpected token|unknown engine|parse error|selector.*invalid/i.test(msg)) {
      throw badSelector(msg.slice(0, 160));
    }
    throw error;
  }
}

/**
 * 页面内安装网络包装（在 page context 执行，必须自包含）：
 * fetch + XHR 固定包装，只记 url/method/status/seq/ts，不存 body；幂等（重复 arm 只更新 patterns）。
 */
function installNetTracker({ patterns, max }) {
  const key = '__dshNet';
  let net = window[key];
  if (!net) {
    net = window[key] = { installed: false, seq: 0, events: [], patterns: [], max: 200, wrappedFetch: false, wrappedXhr: false };
  }
  net.patterns = Array.isArray(patterns) ? patterns.slice(0, 8) : [];
  net.max = Math.max(1, Math.min(1000, Number(max) || 200));
  const hit = (url) => {
    const u = String(url || '');
    if (!u) return false;
    for (const p of net.patterns) { if (u.indexOf(p) >= 0) return true; }
    return false;
  };
  const push = (url, method, status) => {
    net.seq += 1;
    net.events.push({
      seq: net.seq,
      url: String(url || '').slice(0, 800),
      method: String(method || 'GET').toUpperCase().slice(0, 8),
      status: Number.isFinite(Number(status)) ? Number(status) : 0,
      ts: Date.now(),
    });
    if (net.events.length > net.max) net.events.splice(0, net.events.length - net.max);
  };
  if (!net.wrappedFetch && typeof window.fetch === 'function') {
    net.wrappedFetch = true;
    const orig = window.fetch;
    window.fetch = function (...args) {
      const input = args[0];
      const url = String(input && input.url ? input.url : input || '');
      const method = String((args[1] && args[1].method) || (input && input.method) || 'GET');
      const promise = orig.apply(this, args);
      if (hit(url)) {
        try {
          promise.then(
            (res) => { try { push(res && res.url ? res.url : url, method, res && res.status); } catch (e) {} },
            () => { try { push(url, method, 0); } catch (e) {} },
          );
        } catch (e) {}
      }
      return promise;
    };
  }
  if (!net.wrappedXhr && typeof XMLHttpRequest !== 'undefined') {
    net.wrappedXhr = true;
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__dshNetUrl = String(url || '');
      this.__dshNetMethod = String(method || 'GET');
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const self = this;
      if (hit(self.__dshNetUrl || '')) {
        try {
          self.addEventListener('loadend', () => { try { push(self.responseURL || self.__dshNetUrl, self.__dshNetMethod, self.status); } catch (e) {} });
        } catch (e) {}
      }
      return origSend.apply(this, arguments);
    };
  }
  net.installed = true;
  return { installed: net.installed, seq: net.seq, events: net.events.length, patterns: net.patterns.slice() };
}

/** §A5：arm 固定包装（幂等、不阻塞页面） */
async function cmdNetArm(req) {
  const role = roleOfRequest(req);
  const patterns = validatePatterns(req.patterns);
  const p = await ensureRolePage(role);
  const result = await p.evaluate(installNetTracker, { patterns, max: NET_MAX_EVENTS });
  return {
    role,
    armed: true,
    seq: Number(result && result.seq) || 0,
    patterns: Array.isArray(result && result.patterns) ? result.patterns : patterns,
  };
}

/** §A5：在 timeoutMs 内轮询 __dshNet.events，命中 want 条即返回（否则 matched:false） */
async function cmdNetTake(req) {
  const role = roleOfRequest(req);
  const sinceSeq = clampInt(req.sinceSeq, 0, Number.MAX_SAFE_INTEGER, 0);
  const timeoutMs = clampInt(req.timeoutMs, NET_TAKE_TIMEOUT_MIN, NET_TAKE_TIMEOUT_MAX, NET_TAKE_TIMEOUT_DEFAULT);
  const want = clampInt(req.want, 1, NET_TAKE_MAX_WANT, 1);
  const p = await ensureRolePage(role);
  const started = Date.now();
  let seq = 0;
  let events = [];
  let missing = false;
  for (;;) {
    const snap = await p.evaluate(() => {
      const n = window.__dshNet;
      if (!n) return { missing: true, seq: 0, events: [] };
      return { missing: false, seq: Number(n.seq) || 0, events: Array.isArray(n.events) ? n.events.slice(-200) : [] };
    });
    if (!snap || snap.missing) {
      missing = true;
      seq = 0;
      events = [];
      break;
    }
    seq = Number(snap.seq) || 0;
    events = (snap.events || [])
      .filter((e) => e && Number(e.seq) > sinceSeq)
      .slice(0, NET_TAKE_MAX_EVENTS);
    if (events.length >= want) break;
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, Math.max(10, Math.min(NET_TAKE_POLL_INTERVAL, timeoutMs - elapsed))));
  }
  const matched = events.length >= want;
  const out = { role, seq, events, matched, ms: Date.now() - started, timeoutMs, want };
  if (missing) out.missing = true;
  return out;
}

/**
 * 页面内取 activeElement 描述（自包含）：判断"现在是不是在输入框里"。
 * 真正判定交给 Node 侧的 isEditableDescriptor（纯函数，可单测）。
 */
function describeActiveElement() {
  const el = document.activeElement;
  if (!el) return { tagName: '', isContentEditable: false, editableAncestor: false };
  let editableAncestor = false;
  try {
    editableAncestor = Boolean(el.closest && el.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'));
  } catch (e) {}
  return {
    tagName: String(el.tagName || '').toUpperCase(),
    isContentEditable: Boolean(el.isContentEditable),
    editableAncestor,
  };
}

async function activeInputFocused(p) {
  const desc = await withDeadline(p.evaluate(describeActiveElement), 600, null).catch(() => null);
  return isEditableDescriptor(desc);
}

/**
 * §A9：桥内纯文本写入（替代 X11 剪贴板/逐字输入）。
 * mode=auto：有 selector 先 fill（clear 时先 fill('')），失败退 click(force,800) + keyboard.insertText。
 * 只当纯文本，不接受脚本/表达式。
 */
async function cmdType(req) {
  const role = roleOfRequest(req);
  const mode = normalizeTypeMode(req.mode);
  const text = mode === 'keys' ? validateKeysText(req.text) : validateTypeText(req.text);
  const clear = req.clear === true;
  const selectorRaw = req.selector === undefined || req.selector === null ? '' : String(req.selector);
  const selector = selectorRaw.trim() ? validateSelector(selectorRaw) : '';
  const nth = normalizeNth(req.nth);
  const p = await ensureRolePage(role);
  const started = Date.now();
  const done = (via) => ({ role, via, chars: charCount(text), ms: Date.now() - started });
  const focusByClick = async () => {
    if (!selector) return false;
    try {
      await p.locator(selector).nth(nth).click({ force: true, timeout: TYPE_FOCUS_CLICK_TIMEOUT });
      return true;
    } catch {
      return false;
    }
  };
  // insertText/keys 都要求"当前真的有可编辑元素在焦点上"，否则会静默打到 body 上，宁可失败
  const requireFocused = async () => {
    if (await activeInputFocused(p)) return;
    throw codeError('E_TYPE_FAILED', 'no focused editable element (input/textarea/contenteditable) for keyboard text');
  };
  if (mode === 'keys') {
    if (selector) await focusByClick();
    await requireFocused();
    try {
      await p.keyboard.type(text, { delay: 0 });
      return done('keys');
    } catch (error) {
      throw codeError('E_TYPE_FAILED', `keys type failed: ${String(error && error.message || error).slice(0, 160)}`);
    }
  }
  if (mode === 'insert') {
    if (selector) await focusByClick();
    await requireFocused();
    try {
      await p.keyboard.insertText(text);
      return done('insert');
    } catch (error) {
      throw codeError('E_TYPE_FAILED', `insertText failed: ${String(error && error.message || error).slice(0, 160)}`);
    }
  }
  if (mode === 'fill') {
    if (!selector) throw badArg('fill mode requires selector');
    try {
      const loc = p.locator(selector).nth(nth);
      if (clear) await loc.fill('', { timeout: TYPE_FILL_CLEAR_TIMEOUT });
      await loc.fill(text, { timeout: TYPE_FILL_TIMEOUT });
      return done('fill');
    } catch (error) {
      throw codeError('E_TYPE_FAILED', `fill failed: ${String(error && error.message || error).slice(0, 160)}`);
    }
  }
  // auto
  if (selector) {
    try {
      const loc = p.locator(selector).nth(nth);
      if (clear) await loc.fill('', { timeout: TYPE_FILL_CLEAR_TIMEOUT });
      await loc.fill(text, { timeout: TYPE_FILL_TIMEOUT });
      return done('fill');
    } catch (error) {
      log(`type auto fill fallback: ${String(error && error.message || error).slice(0, 160)}`);
      await focusByClick();
    }
  }
  try {
    await requireFocused();
    await p.keyboard.insertText(text);
    return done('insert');
  } catch (error) {
    if (error && error.code === 'E_TYPE_FAILED') throw error;
    throw codeError('E_TYPE_FAILED', `fill+insert both failed: ${String(error && error.message || error).slice(0, 160)}`);
  }
}

/** §A10：快捷键走桥；按键前检查 activeElement（输入框聚焦时拒绝，除非 req.allowFocused===true） */
async function cmdPress(req) {
  const role = roleOfRequest(req);
  const p = await ensureRolePage(role);
  const key = normalizePressKey(req.key);
  const focused = await activeInputFocused(p);
  const allowFocused = req.allowFocused === true;
  if (focused && !allowFocused) {
    throw codeError('E_INPUT_FOCUSED', `active element is an editable input; refusing key=${key} (pass allowFocused:true to override)`);
  }
  await p.keyboard.press(key);
  return { role, key, inputFocused: focused };
}

async function cmdScroll(req) {
  const role = roleOfRequest(req);
  const p = await ensureRolePage(role);
  const dy = Number(req.dy);
  if (!Number.isInteger(dy) || dy < -2000 || dy > 2000) {
    throw Object.assign(new Error('E_BAD_DY: integer -2000..2000 required'), { code: 'E_BAD_DY' });
  }
  const vp = p.viewportSize() || { width: 1280, height: 700 };
  let moved = false;
  if (req.selector) {
    try {
      const loc = p.locator(String(req.selector)).first();
      if (await loc.count()) { await loc.hover({ timeout: 5000 }); moved = true; }
    } catch {}
  }
  if (!moved) await p.mouse.move(Math.floor(vp.width / 2), Math.floor(vp.height / 2));
  await p.mouse.wheel(0, dy);
  await p.waitForTimeout(900);
  return { dy };
}

async function cmdScreenshot(req) {
  const role = roleOfRequest(req);
  const p = await ensureRolePage(role);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '');
  const file = path.join(SHOTS, `shot-${role}-${stamp}.png`);
  await p.screenshot({ path: file, type: 'png', timeout: 30000 });
  const size = fs.statSync(file);
  const dim = pngSize(file);
  return { file, bytes: size.size, width: dim.width, height: dim.height };
}

async function cmdRestart() {
  await stopBrowser();
  await launchBrowser();
  return { browser: browserAlive(), pages: context ? context.pages().length : 0, roles: liveRoles() };
}

/** 把指定 role 的 tab 提到最前（私信输入等 X11 焦点操作前用；watcher 不调用）。 */
async function cmdActivate(req) {
  const role = roleOfRequest(req);
  const p = await ensureRolePage(role);
  await p.bringToFront();
  return { role, url: p.url() };
}

async function dispatch(req) {
  const cmd = String(req && req.cmd || '');
  if (!COMMANDS.includes(cmd)) {
    throw Object.assign(new Error(`E_UNKNOWN_CMD: ${cmd}`), { code: 'E_UNKNOWN_CMD' });
  }
  const started = Date.now();
  let role = DEFAULT_ROLE;
  try {
    role = roleOfRequest(req);
    const result = await withTimeout(async () => {
      switch (cmd) {
        case 'ping': {
          let pages = 0;
          let urls = {};
          try { pages = context ? context.pages().length : 0; } catch {}
          for (const r of ROLES) {
            const p = getRolePage(r);
            urls[r] = p ? p.url() : null;
          }
          // 协议 v2 §A1：老字段全保留，新增 version/capabilities/crashed（老桥没有这三个字段）
          return {
            proto: '1.0',
            version: '2',
            browser: browserAlive(),
            launching: Boolean(launching),
            pages,
            roles: liveRoles(),
            urls,
            capabilities: [...CAPABILITIES],
            crashed: crashedRoles.keys(),
          };
        }
        case 'open': return await cmdOpen(req);
        case 'tabs': {
          await ensureBrowser();
          await pruneDuplicateRolePages();
          const pages = context.pages();
          const out = [];
          for (let i = 0; i < pages.length; i += 1) {
            const x = pages[i];
            let url = '';
            try { url = x.url(); } catch {}
            out.push({ role: roleForPage(x), index: i, url, title: await pageTitle(x) });
          }
          return out;
        }
        case 'title': { const p = await ensureRolePage(role); return await pageTitle(p); }
        case 'url': { const p = await ensureRolePage(role); return p.url(); }
        case 'activate': return await cmdActivate(req);
        case 'text': return await cmdText(req);
        case 'html': return await cmdHtml(req);
        case 'count': return await cmdCount(req);
        case 'list': return await cmdList(req);
        case 'jsRead': return await cmdJsRead(req);
        case 'jsWatch': return await cmdJsWatch(req);
        case 'rect': return await cmdRect(req);
        case 'jsClick': return await cmdJsClick(req);
        case 'hoverText': return await cmdHoverText(req);
        case 'links': return await cmdLinks(req);
        case 'click': return await cmdClick(req);
        case 'scroll': return await cmdScroll(req);
        case 'press': return await cmdPress(req);
        case 'type': return await cmdType(req);
        case 'health': return await cmdHealth(req);
        case 'probe': return await cmdProbe(req);
        case 'waitFor': return await cmdWaitFor(req);
        case 'netArm': return await cmdNetArm(req);
        case 'netTake': return await cmdNetTake(req);
        case 'assets': return await cmdAssets(req);
        case 'screenshot': return await cmdScreenshot(req);
        case 'restart': return await cmdRestart();
        default: throw Object.assign(new Error('E_UNKNOWN_CMD'), { code: 'E_UNKNOWN_CMD' });
      }
    }, LIMITS[cmd] || LIMITS.default, cmd);
    log(`cmd=${cmd} role=${role} ok ms=${Date.now() - started}`);
    return { ok: true, cmd, role, result };
  } catch (error) {
    const code = error && error.code ? error.code : 'E_COMMAND_FAILED';
    const message = String(error && error.message ? error.message : error).slice(0, 500);
    log(`cmd=${cmd} role=${role} fail code=${code} ms=${Date.now() - started} msg=${message.slice(0, 160)}`);
    return { ok: false, cmd, role, code, error: message };
  }
}

function withTimeout(promiseFactory, ms, label) {
  let timer = null;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`E_TIMEOUT: ${label}`), { code: 'E_TIMEOUT' })), ms);
    Promise.resolve().then(promiseFactory).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

let chain = Promise.resolve();
function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

function writeEndpoint() {
  const payload = {
    proto: '1.0',
    socket: SOCKET,
    transport: 'unix-socket-jsonl',
    commands: COMMANDS,
    roles: [...ROLES],
    roleModel: 'multi-page: main|notify|dm; request role/pageRole, default main',
    pid: process.pid,
    startedAt: nowIso(),
  };
  fs.writeFileSync(ENDPOINT, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  try { fs.chmodSync(ENDPOINT, 0o600); } catch {}
}

const server = net.createServer((sock) => {
  let buf = '';
  let responded = false;
  let timer = null;

  const finish = (obj) => {
    if (responded) return;
    responded = true;
    if (timer) clearTimeout(timer);
    try { sock.end(`${JSON.stringify(obj)}\n`); } catch {}
  };

  sock.setEncoding('utf8');
  timer = setTimeout(() => finish({ ok: false, cmd: null, code: 'E_TIMEOUT', error: 'socket timeout' }), 125000);
  sock.on('error', (error) => {
    log(`socket error: ${String(error.message || error).slice(0, 200)}`);
    finish({ ok: false, cmd: null, code: 'E_SOCKET', error: 'socket error' });
  });
  sock.on('data', (chunk) => {
    if (responded) return;
    buf += chunk;
    const idx = buf.indexOf('\n');
    if (idx < 0) {
      if (buf.length > 1024 * 1024) finish({ ok: false, cmd: null, code: 'E_TOO_LARGE', error: 'request too large' });
      return;
    }
    const line = buf.slice(0, idx).trim();
    buf = '';
    if (!line) { finish({ ok: false, cmd: null, code: 'E_EMPTY', error: 'empty request' }); return; }
    let req;
    try { req = JSON.parse(line); } catch { finish({ ok: false, cmd: null, code: 'E_BAD_JSON', error: 'invalid json' }); return; }
    // ping/health 不进串行队列：health 要能在 30s 卡死命令期间也立刻回答（§A2 p95 < 200ms）
    if (req.cmd === 'ping' || req.cmd === 'health') {
      const fastCmd = String(req.cmd);
      dispatch(req).then((result) => finish(result)).catch((error) => finish({ ok: false, cmd: fastCmd, code: 'E_INTERNAL', error: String(error && error.message || error).slice(0, 300) }));
      return;
    }
    pending += 1;
    enqueue(() => dispatch(req)).then((result) => {
      pending -= 1;
      finish(result);
    }).catch((error) => {
      pending -= 1;
      finish({ ok: false, cmd: req && req.cmd || null, code: 'E_INTERNAL', error: String(error && error.message || error).slice(0, 300) });
    });
  });
});

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutdown ${reason}`);
  try { server.close(); } catch {}
  try { fs.rmSync(SOCKET, { force: true }); } catch {}
  try { fs.rmSync(ENDPOINT, { force: true }); } catch {}
  try { await stopBrowser(); } catch {}
  try { fs.rmSync(PIDFILE, { force: true }); } catch {}
  process.exit(0);
}

async function main() {
  ensureDirs();
  try { fs.rmSync(SOCKET, { force: true }); } catch {}
  try { fs.rmSync(ENDPOINT, { force: true }); } catch {}
  fs.writeFileSync(PIDFILE, `${process.pid}\n`, { mode: 0o600 });
  try { fs.chmodSync(PIDFILE, 0o600); } catch {}
  server.on('error', (error) => {
    log(`server error: ${String(error.message || error).slice(0, 300)}`);
    process.exit(1);
  });
  server.listen(SOCKET, () => {
    try { fs.chmodSync(SOCKET, 0o600); } catch {}
    writeEndpoint();
    log(`listening ${SOCKET} pid=${process.pid}`);
  });
  launchBrowser().catch((error) => {
    log(`initial launch failed: ${String(error.message || error).slice(0, 500)}`);
  });
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('uncaughtException', (error) => {
  log(`uncaughtException: ${String(error && error.stack || error).slice(0, 800)}`);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  log(`unhandledRejection: ${String(error && error.stack || error).slice(0, 800)}`);
});

// 只在被当作主模块直接运行时启动服务；被测试 require/import 时只导出纯函数，不碰 socket/浏览器。
if (require.main === module) {
  void main();
}

/**
 * 测试出口（不启动浏览器）：tests/bridge-protocol.test.mjs 只断言这些纯函数。
 * 生产路径（node cdp-bridge.js）行为不变。
 */
module.exports.__test = {
  codeError,
  clampInt,
  selectorOk,
  validateSelector,
  validatePatterns,
  normalizeProbeCounts,
  normalizeWaitState,
  normalizeUrlForCompare,
  normalizeDouyinUrl,
  validateTypeText,
  validateKeysText,
  normalizeTypeMode,
  normalizeNth,
  normalizePressKey,
  isEditableDescriptor,
  isPlaywrightTimeout,
  charCount,
  constants: {
    CAPABILITIES,
    COMMANDS,
    LIMITS,
    PRESS_NAMED_KEYS,
    PRESS_HOTKEY_CHARS,
    TYPE_MODES,
    TYPE_MAX_CHARS,
    WAIT_STATES,
    WAIT_TIMEOUT_MIN,
    WAIT_TIMEOUT_MAX,
    WAIT_TIMEOUT_DEFAULT,
    CLICK_TIMEOUT_DEFAULT,
    CLICK_TIMEOUT_FORCE_DEFAULT,
    CLICK_TIMEOUT_MIN,
    CLICK_TIMEOUT_MAX,
    CLICK_SCROLL_TIMEOUT,
    NET_PATTERN_RE,
    NET_MAX_PATTERNS,
    NET_MAX_EVENTS,
    SELECTOR_MAX_LEN,
    HEALTH_EVAL_TIMEOUT,
  },
};

