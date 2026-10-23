import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

const repoRootIndex = process.argv.indexOf('--repo-root')
const repoRoot = repoRootIndex >= 0 ? path.resolve(process.argv[repoRootIndex + 1] || '') : process.cwd()
const verifier = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'verify-admin-restart.mjs'), ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: process.env,
  detached: true,
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
})
verifier.on('error', (error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
verifier.unref()
