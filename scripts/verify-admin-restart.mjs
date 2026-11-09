import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import * as cp from 'node:child_process'
import { releaseAdminMaintenanceLock } from '../src/services/admin-maintenance-lock.mjs'
import { createAdminRuntimeProbe } from '../src/services/admin-runtime-probe.mjs'
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
const lockId = value('--lock-id')
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
  let verified = false
  let stablePid = 0
  let stableChecks = 0
  let lastError = 'service did not become ready'
  let diagnostics = null
  const probe = createAdminRuntimeProbe({ fs: fsSync, cp, path, pm2Bin })
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    await wait(1000)
    try {
      let pid
      if (process.platform !== 'win32') {
        diagnostics = probe.inspect({ name: pm2Name, cwd: repoRoot, port })
        pid = probe.assertOwnership(diagnostics, { previousPid }).pid
      } else {
        const { stdout } = await execFileAsync(pm2Bin, ['jlist'], { cwd: repoRoot, windowsHide: true })
        const row = JSON.parse(stdout).find((item) => item?.name === pm2Name)
        pid = Number(row?.pid || 0)
        if (row?.pm2_env?.status !== 'online' || !pid || pid === previousPid) throw new Error('PM2 has not switched to a new online process')
        if (path.resolve(row?.pm2_env?.pm_cwd || '') !== repoRoot) throw new Error('PM2 working directory does not match the application directory')
      }
      const runtimeResponse = await fetch(`${baseUrl}/api/runtime-info`, { signal: AbortSignal.timeout(4000) })
      if (!runtimeResponse.ok) throw new Error(`runtime endpoint returned HTTP ${runtimeResponse.status}`)
      const runtime = await runtimeResponse.json()
      if (runtime?.data?.version !== expectedVersion) throw new Error(`running version is ${runtime?.data?.version || 'unknown'}`)
      await verifyFrontend(baseUrl, expectedHtml)
      if (publicUrl && !/example\.com/i.test(publicUrl)) await verifyFrontend(publicUrl, expectedHtml)
      stableChecks = stablePid === pid ? stableChecks + 1 : 1
      stablePid = pid
      if (stableChecks >= 3) {
        await writeStatus('verified', { pid, verifiedAt: new Date().toISOString() })
        try {
          const cleanup = await cleanupSelfUpdateStorage(workDir)
          console.log(`Self-update storage: removed=${cleanup.removed.length}, retainedBackups=${cleanup.retainedBackups}`)
        } catch (error) {
          console.warn(`Self-update cleanup failed: ${error.message}`)
        }
        verified = true
        break
      }
    } catch (error) {
      stableChecks = 0
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  if (!verified) {
    const failure = new Error(lastError)
    failure.diagnostics = diagnostics
    throw failure
  }
} catch (error) {
  await writeStatus('failed', { error: error instanceof Error ? error.message : String(error), diagnostics: error.diagnostics || null }).catch(() => {})
  console.error(error.message)
  if (error.diagnostics) console.error(JSON.stringify(error.diagnostics))
  process.exitCode = 1
} finally {
  await releaseAdminMaintenanceLock(repoRoot, lockId)
}
