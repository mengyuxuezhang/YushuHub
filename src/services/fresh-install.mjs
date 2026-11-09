import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { hashPassword, verifyPassword } from '../utils/crypto.mjs'

export const validPasswordHash = value => /^pbkdf2_sha256\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(value || '')
export const validInstallationToken = value => typeof value === 'string' && value.length >= 32 && value.length <= 128 && !/\s/.test(value) && !/^REPLACE_/.test(value)
export function equalSecret(left, right) {
  const digest = value => crypto.createHash('sha256').update(String(value || '')).digest()
  return crypto.timingSafeEqual(digest(left), digest(right))
}
export function installInput(input) {
  if (typeof input?.password !== 'string' || input.password.length < 16 || input.password.length > 128 || !/[a-zA-Z]/.test(input.password) || !/[^a-zA-Z]/.test(input.password)) throw new Error('请选择16–128位、包含字母与其他字符的管理员密码')
  const url = new URL(input.publicUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname.includes('.')) throw new Error('请填写最终使用的HTTPS域名，不含路径')
  return { format: 1, installationId: crypto.randomUUID(), publicUrl: url.origin, adminPasswordHash: hashPassword(input.password), stage: 'pending' }
}
export async function readInstallation(file) {
  let state
  try { state = JSON.parse(await fs.readFile(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return null; throw new Error('初始化记录损坏，请恢复配套备份') }
  if (state.format !== 1 || !/^[a-f0-9-]{36}$/.test(state.installationId || '') || !validPasswordHash(state.adminPasswordHash) || !['pending', 'complete'].includes(state.stage)) throw new Error('初始化记录无效，请恢复配套备份')
  return state
}
export async function saveInstallation(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + crypto.randomUUID()
  const handle = await fs.open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(state)); await handle.sync() } finally { await handle.close() }
  await fs.rename(temporary, file)
  if (process.platform !== 'win32') {
    const directory = await fs.open(path.dirname(file), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
}
export function retryMatches(state, input) {
  return new URL(input.publicUrl).origin === state.publicUrl && verifyPassword(input.password, state.adminPasswordHash)
}

// A fresh database must be empty, or already bound to this exact installation.
// The connection retains an advisory lock until the business process exits.
export async function claimFreshDatabase(connection, state, { allowCreate = false } = {}) {
  const [[lock]] = await connection.query("SELECT GET_LOCK('yushuhub-fresh-writer', 0) acquired")
  if (Number(lock.acquired) !== 1) throw new Error('另一个实例正在使用此数据库')
  const [tables] = await connection.query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()')
  if (!tables.length && allowCreate) {
    await connection.query('CREATE TABLE yushuhub_installation (id TINYINT PRIMARY KEY, installation_id VARCHAR(36) NOT NULL)')
    await connection.query('INSERT INTO yushuhub_installation VALUES (1, ?)', [state.installationId])
  } else {
    if (!tables.some(row => row.name === 'yushuhub_installation')) throw new Error('数据库不是本次新装的空库，禁止覆盖')
    const [rows] = await connection.query('SELECT installation_id FROM yushuhub_installation WHERE id=1')
    // A crash between CREATE and INSERT is safely retryable only while no business tables exist.
    if (!rows.length && tables.length === 1 && allowCreate) await connection.query('INSERT INTO yushuhub_installation VALUES (1, ?)', [state.installationId])
    else if (rows.length !== 1 || rows[0].installation_id !== state.installationId) throw new Error('数据库与持久初始化记录不匹配')
  }
}
