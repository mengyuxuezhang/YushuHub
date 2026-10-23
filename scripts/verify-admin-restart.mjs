import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cleanupSelfUpdateStorage } from '../src/services/storage-retention.mjs'

const execFileAsync = promisify(execFile)
const value = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || '') : ''
}
const repoRoot = path.resolve(value('--repo-root'))
const workDir = path.resolve(value('--work-dir'))
const pm2Bin = value('--pm2-bin') || 'pm2'
const pm2Name = value('--pm2-name')
const previousPid = Number(value('--previous-pid') || 0)
const port = Number(value('--port'))
const expectedVersion = value('--expected-version')
const delayMs = Number(value('--delay-ms') || 1200)
const publicUrl = value('--public-url')
const statusPath = path.join(workDir, 'restart-status.json')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function writeStatus(state, extra = {}) {
  const body = { state, pm2Name, previousPid, expectedVersion, port, updatedAt: new Date().toISOString(), ...extra }
  const temporary = `${statusPath}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, statusPath)
}
async function verifyFrontend(baseUrl, expectedHtml) {
  const htmlResponse = await fetch(new URL('/admin/v2/', baseUrl), { signal: AbortSignal.timeout(4000) })
  if (!htmlResponse.ok) throw new Error(`admin HTML returned HTTP ${htmlResponse.status}`)
  const html = await htmlResponse.text()
  if (html !== expectedHtml) throw new Error(`${baseUrl} is serving an HTML shell different from the installed release`)
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\/assets\/[^"?]+\.(?:js|css))"/g)].map((match) => match[1])
  if (assets.length < 2) throw new Error('admin HTML does not reference both JS and CSS assets')
  for (const asset of assets) {
    const response = await fetch(new URL(asset, baseUrl), { signal: AbortSignal.timeout(5000) })
    const type = String(response.headers.get('content-type') || '').toLowerCase()
    if (!response.ok) throw new Error(`${asset} returned HTTP ${response.status}`)
    if (asset.endsWith('.js') && !type.includes('javascript')) throw new Error(`${asset} returned ${type || 'no content type'}`)
    if (asset.endsWith('.css') && !type.includes('text/css')) throw new Error(`${asset} returned ${type || 'no content type'}`)
  }
}

try {
  if (!repoRoot || !workDir || !pm2Name || !port || !expectedVersion) throw new Error('restart verifier arguments are incomplete')
  await wait(delayMs)
  await writeStatus('restarting')
  await execFileAsync(pm2Bin, ['restart', pm2Name, '--update-env'], { cwd: repoRoot, windowsHide: true })
  const baseUrl = `http://127.0.0.1:${port}`
  const expectedHtml = await fs.readFile(path.join(repoRoot, 'web', 'admin-v2', 'index.html'), 'utf8')
  let stableChecks = 0
  let lastError = 'service did not become ready'
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    await wait(1000)
    try {
      const { stdout } = await execFileAsync(pm2Bin, ['jlist'], { cwd: repoRoot, windowsHide: true })
      const row = JSON.parse(stdout).find((item) => item?.name === pm2Name)
      const pid = Number(row?.pid || 0)
      if (row?.pm2_env?.status !== 'online' || !pid || pid === previousPid) throw new Error('PM2 has not switched to a new online process')
      if (path.resolve(row?.pm2_env?.pm_cwd || '') !== repoRoot) throw new Error('PM2 working directory does not match the application directory')
      if (process.platform !== 'win32') {
        const { stdout: sockets } = await execFileAsync('ss', ['-ltnp', `sport = :${port}`], { windowsHide: true })
        if (!sockets.includes(`pid=${pid},`)) throw new Error('target port is not owned by the restarted PM2 PID')
      }
      const runtimeResponse = await fetch(`${baseUrl}/api/runtime-info`, { signal: AbortSignal.timeout(4000) })
      if (!runtimeResponse.ok) throw new Error(`runtime endpoint returned HTTP ${runtimeResponse.status}`)
      const runtime = await runtimeResponse.json()
      if (runtime?.data?.version !== expectedVersion) throw new Error(`running version is ${runtime?.data?.version || 'unknown'}`)
      await verifyFrontend(baseUrl, expectedHtml)
      if (publicUrl && !/example\.com/i.test(publicUrl)) await verifyFrontend(publicUrl, expectedHtml)
      stableChecks += 1
      if (stableChecks >= 3) {
        await writeStatus('verified', { pid, verifiedAt: new Date().toISOString() })
        try {
          const cleanup = await cleanupSelfUpdateStorage(workDir)
          console.log(`Self-update storage: removed=${cleanup.removed.length}, retainedBackups=${cleanup.retainedBackups}`)
        } catch (error) {
          console.warn(`Self-update cleanup failed: ${error.message}`)
        }
        process.exit(0)
      }
    } catch (error) {
      stableChecks = 0
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(lastError)
} catch (error) {
  await writeStatus('failed', { error: error instanceof Error ? error.message : String(error) }).catch(() => {})
  process.exit(1)
}
