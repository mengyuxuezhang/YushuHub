import fsp from 'node:fs/promises'
import path from 'node:path'
import { APP_LOG_DIR, APP_LOG_FILE, SELF_UPDATE_WORK_DIR } from '../config/paths.mjs'
import { nowIso } from './time.mjs'

export function writeAppLog(scope, message) {
  const line = `[${nowIso()}] [${scope}] ${String(message || '').replace(/\s+/g, ' ').slice(0, 2000)}\n`
  fsp.mkdir(APP_LOG_DIR, { recursive: true })
    .then(() => fsp.appendFile(APP_LOG_FILE, line, 'utf-8'))
    .catch(() => {})
}

export async function tailTextFile(file, maxBytes = 12000) {
  try {
    const stat = await fsp.stat(file)
    const start = Math.max(0, stat.size - maxBytes)
    const handle = await fsp.open(file, 'r')
    try {
      const buffer = Buffer.alloc(stat.size - start)
      await handle.read(buffer, 0, buffer.length, start)
      return buffer.toString('utf-8')
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

export async function appendSelfUpdateLog(chunk) {
  await fsp.mkdir(SELF_UPDATE_WORK_DIR, { recursive: true })
  await fsp.appendFile(path.join(SELF_UPDATE_WORK_DIR, 'update.log'), `[${nowIso()}] ${chunk}\n`, 'utf-8')
}

export async function readSelfUpdateLog() {
  try {
    const raw = await fsp.readFile(path.join(SELF_UPDATE_WORK_DIR, 'update.log'), 'utf-8')
    return raw.slice(-120000)
  } catch {
    return ''
  }
}
