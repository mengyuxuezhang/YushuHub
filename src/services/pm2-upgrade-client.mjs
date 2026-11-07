import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const ROOT = '/var/lib/yushuhub-upgrade'
const TERMINAL = new Set(['committed', 'rolled_back', 'rejected', 'failed'])
const directory = repoRoot => path.join(ROOT, 'pm2', crypto.createHash('sha256').update(repoRoot).digest('hex'))
async function json(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) return null; throw error } }

export async function readPm2UpgradeStatus(repoRoot) {
  const state = directory(repoRoot), record = await json(path.join(state, 'transaction.json')), request = await json(path.join(state, 'last-request.json'))
  const selected = request && request.operationId !== record?.operationId && (!record || TERMINAL.has(record.stage)) ? request : record
  if (!selected) return null
  const result = Object.fromEntries(['operationId', 'stage', 'updatedAt', 'error'].filter(key => selected[key] !== undefined).map(key => [key, selected[key]]))
  if (result.error && !/^[A-Z][A-Z0-9_]{0,120}$/.test(result.error)) result.error = 'ZIP_UPGRADE_FAILED'
  return result
}

export async function schedulePm2Upgrade({ repoRoot, archiveFile, sha256, expectedVersion, action = 'upgrade' }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('当前PM2升级适配器需要Linux root管理实例，请使用部署工具检查运行用户')
  if (!['upgrade', 'recover', 'rollback'].includes(action)) throw new Error('不支持的恢复操作')
  if (await fs.realpath(repoRoot) !== repoRoot) throw new Error('实例目录存在别名，请先使用部署工具核对')
  const current = await readPm2UpgradeStatus(repoRoot)
  if (current && !TERMINAL.has(current.stage) && action !== 'recover') throw new Error('已有未完成的升级任务，请先检测或恢复任务')
  await fs.mkdir(ROOT, { recursive: true, mode: 0o700 })
  const rootStatus = await fs.lstat(ROOT)
  if (rootStatus.isSymbolicLink() || rootStatus.uid !== 0 || rootStatus.mode & 0o022) throw new Error('独立升级状态目录需要管理员核对权限')
  const operationId = crypto.randomUUID(), job = path.join(ROOT, 'launchers', operationId)
  await fs.mkdir(job, { recursive: true, mode: 0o700 })
  let source = path.join(repoRoot, 'scripts/admin-upgrade')
  if (!(await json(path.join(source, 'bundle.json')))) source = path.join(repoRoot, 'tools/upgrade-controller')
  const manifest = await json(path.join(source, 'bundle.json'))
  if (manifest?.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.includes('pm2_zip.py')) throw new Error('当前安装包缺少独立升级组件，请使用新版部署工具')
  for (const name of manifest.files) {
    if (!/^[a-z][a-z0-9._-]+$/.test(name)) throw new Error('独立升级组件清单无效')
    await fs.copyFile(path.join(source, name), path.join(job, name))
    await fs.chmod(path.join(job, name), 0o600)
  }
  const request = { appRoot: repoRoot, operationId }
  if (action === 'upgrade') {
    request.archiveFile = path.join(job, 'package.zip')
    request.sha256 = sha256; request.expectedVersion = expectedVersion
    await fs.copyFile(archiveFile, request.archiveFile); await fs.chmod(request.archiveFile, 0o600)
  }
  try { await fs.access('/www/server/mysql/bin/mysqldump'); request.mysqldump = '/www/server/mysql/bin/mysqldump' }
  catch { request.mysqldump = '/usr/bin/mysqldump' }
  const requestFile = path.join(job, 'request.json')
  await fs.writeFile(requestFile, JSON.stringify(request), { mode: 0o600, flag: 'wx' })
  try {
    const { stdout } = await execute('python3', [path.join(job, 'pm2_zip.py'), action, '--request', requestFile, '--detach'], { timeout: 15000, maxBuffer: 65536, windowsHide: true })
    const task = JSON.parse(stdout)
    if (task.stage !== 'accepted' || task.operationId !== operationId) throw new Error('Unexpected worker acknowledgment')
    return { deploymentMode: 'pm2', inProgress: true, upgradeTask: task,
      runningVersion: '', message: '独立升级任务已提交，验证后将记录结果；服务可能短暂中断' }
  } catch { throw new Error('独立升级进程未能确认接收任务，请检测任务状态后再重试') }
}
