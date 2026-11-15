/**
 * 写操作账本（本地 `.write-ledger.json`，与下载 sidecar 同目录）。
 * 记录：videoId/action/targetState/at/result/verified；同 videoId+action+targetState 已验证则幂等。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DouyinError } from './errors.js'

export const WRITE_LEDGER_FILE = '.write-ledger.json'

export function ledgerPath(dir) {
  if (typeof dir !== 'string' || !dir.startsWith('/')) throw new DouyinError('E_BAD_ARG', 'downloadDir 未配置')
  return join(dir, WRITE_LEDGER_FILE)
}

export function readLedger(dir) {
  const file = ledgerPath(dir)
  if (!existsSync(file)) return { version: 1, actions: {} }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || typeof data !== 'object' || !data.actions || typeof data.actions !== 'object') {
      return { version: 1, actions: {} }
    }
    return data
  } catch {
    return { version: 1, actions: {} }
  }
}

export function ledgerKey({ videoId, action, targetState }) {
  return `${String(videoId)}:${String(action)}:${targetState === undefined ? '' : String(targetState)}`
}

export function getVerifiedAction(dir, record) {
  const ledger = readLedger(dir)
  const found = ledger.actions[ledgerKey(record)]
  return found && found.verified === true ? found : null
}

/**
 * 删除一条账本记录（例如评论删掉后，清掉 `comment:posted`，允许重新评论）。
 * 记录不存在时返回 false；写盘失败抛 E_PERMISSION。
 */
export function removeLedger(dir, record) {
  const file = ledgerPath(dir)
  const ledger = readLedger(dir)
  const key = ledgerKey(record)
  if (!ledger.actions[key]) return false
  delete ledger.actions[key]
  const tmp = `${file}.${process.pid}.${Date.now()}.rm.tmp`
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch {}
    throw new DouyinError('E_PERMISSION', `写账本失败：${String(e?.message ?? e).slice(0, 160)}`)
  }
}

export function recordLedger(dir, record) {
  const file = ledgerPath(dir)
  const ledger = readLedger(dir)
  const entry = {
    videoId: String(record.videoId),
    action: String(record.action),
    targetState: record.targetState === undefined ? null : record.targetState,
    at: record.at ?? new Date().toISOString(),
    result: String(record.result ?? 'unknown'),
    verified: record.verified === true,
    ...(record.detail && typeof record.detail === 'object' ? { detail: record.detail } : {}),
  }
  ledger.actions[ledgerKey(entry)] = entry
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
    return entry
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // ignore
    }
    throw new DouyinError('E_PERMISSION', `写账本失败：${String(e?.message ?? e).slice(0, 160)}`)
  }
}
