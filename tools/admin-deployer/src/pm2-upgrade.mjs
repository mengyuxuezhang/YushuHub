import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const here = path.dirname(fileURLToPath(import.meta.url))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function runLegacyUpgrade({ conn, exec, upload, writeFile, appRoot, packagePath, expectedSha256, expectedVersion, action = 'upgrade' }) {
  if (!['upgrade', 'recover', 'rollback', 'status'].includes(action)) throw new Error('不支持的PM2升级操作')
  let source = path.resolve(here, '../assets/admin-upgrade')
  try { await fs.access(path.join(source, 'bundle.json')) } catch { source = path.resolve(here, '../../upgrade-controller') }
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'bundle.json'), 'utf8'))
  if (manifest.format !== 1 || !manifest.files.includes('pm2_zip.py')) throw new Error('部署工具缺少受验的独立升级组件')
  const operationId = crypto.randomUUID(), job = '/var/lib/yushuhub-upgrade/launchers/' + operationId
  const guard = "import os,pathlib,sys;p=pathlib.Path('/var/lib/yushuhub-upgrade');p.mkdir(mode=0o700,exist_ok=True);s=p.lstat();assert os.geteuid()==0 and not p.is_symlink() and s.st_uid==0 and not s.st_mode & 0o022;pathlib.Path(sys.argv[1]).mkdir(mode=0o700,parents=True)"
  await exec(conn, `python3 -c ${quote(guard)} ${quote(job)}`)
  for (const name of manifest.files) {
    if (!/^[a-z][a-z0-9._-]+$/.test(name)) throw new Error('独立升级组件清单无效')
    await upload(conn, path.join(source, name), job + '/' + name)
  }
  const request = { appRoot, operationId }
  if (action === 'upgrade') {
    const bytes = await fs.readFile(packagePath)
    request.sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    if (expectedSha256 && request.sha256 !== expectedSha256) throw new Error('升级包SHA-256与更新清单不一致')
    request.archiveFile = job + '/package.zip'; request.expectedVersion = expectedVersion || ''
    await upload(conn, packagePath, request.archiveFile)
  }
  request.mysqldump = (await exec(conn, "if [ -x /www/server/mysql/bin/mysqldump ]; then printf /www/server/mysql/bin/mysqldump; else printf /usr/bin/mysqldump; fi")).trim()
  const requestFile = job + '/request.json'
  await writeFile(conn, requestFile, JSON.stringify(request))
  await exec(conn, `chmod 600 ${quote(job)}/*`)
  const command = operation => `python3 ${quote(job + '/pm2_zip.py')} ${operation} --request ${quote(requestFile)}`
  if (action === 'status') {
    console.log(await exec(conn, command('status'))); return
  }
  const accepted = JSON.parse(await exec(conn, command(action) + ' --detach'))
  console.log(`独立任务已接收：${accepted.operationId}；断开部署工具后任务仍会继续。`)
  let lastStage = ''
  for (let attempt = 0; attempt < 450; attempt++) {
    const status = JSON.parse(await exec(conn, command('status')))
    if (status.stage !== lastStage) { console.log(`任务阶段：${status.stage || 'accepted'}`); lastStage = status.stage }
    if (['committed', 'rolled_back', 'rejected', 'failed', 'needs_attention'].includes(status.stage)) {
      if (status.stage === 'committed' || status.stage === 'rolled_back' && action !== 'upgrade') { console.log(JSON.stringify(status)); return }
      throw new Error(`升级任务未提交成功：${status.stage} ${status.error || ''}。请使用查看任务或恢复功能核对。`)
    }
    await wait(2000)
  }
  throw new Error('任务仍未结束，请使用查看升级任务功能核对；不要重复提交升级')
}
