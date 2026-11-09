import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { transferAdminMaintenanceLock } from '../src/services/admin-maintenance-lock.mjs'

const repoRootIndex = process.argv.indexOf('--repo-root')
const repoRoot = repoRootIndex >= 0 ? path.resolve(process.argv[repoRootIndex + 1] || '') : process.cwd()
const lockIndex = process.argv.indexOf('--lock-id')
const lockId = lockIndex >= 0 ? process.argv[lockIndex + 1] : ''
const verifier = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'verify-admin-restart.mjs'), ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: process.env,
  detached: true,
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
})
try {
  await new Promise((resolve, reject) => { verifier.once('spawn', resolve); verifier.once('error', reject) })
  await transferAdminMaintenanceLock(repoRoot, lockId, verifier.pid)
} catch (error) {
  verifier.kill()
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
verifier.unref()
