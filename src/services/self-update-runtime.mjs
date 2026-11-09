import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import * as cp from 'node:child_process'
import { createAdminRuntimeProbe } from './admin-runtime-probe.mjs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

export function selectCurrentPm2Process(processes, { pid, configuredName, repoRoot, ancestorPids = [] }) {
  const normalizedRoot = path.resolve(repoRoot)
  const rows = Array.isArray(processes) ? processes : []
  const same = rows.filter(item => path.resolve(item?.pm2_env?.pm_cwd || '') === normalizedRoot)
  if (same.filter(item => item?.pm2_env?.status === 'online' && Number(item.pid) > 0).length > 1) throw new Error('multiple online PM2 processes use the application directory')
  const byPid = same.find((item) => [Number(pid), ...ancestorPids].includes(Number(item?.pid)))
  if (byPid) return byPid
  throw new Error(`PM2 could not identify the running admin process (pid=${pid}, configured=${configuredName})`)
}

export async function resolveCurrentPm2Process({ runCommand, pm2Bin, configuredName, repoRoot, pid = process.pid, port }) {
  const output = await runCommand(pm2Bin, ['jlist'], { logOutput: false })
  let processes
  try { processes = JSON.parse(output) } catch { throw new Error('PM2 returned invalid process metadata') }
  const ancestorPids = []
  if (process.platform === 'linux') {
    let next = pid
    while (next > 1 && ancestorPids.length < 128) {
      try {
        const stat = await fs.readFile(`/proc/${next}/stat`, 'utf8')
        next = Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[1])
        if (ancestorPids.includes(next)) break
        ancestorPids.push(next)
      } catch { break }
    }
  }
  const selected = selectCurrentPm2Process(processes, { pid, configuredName, repoRoot, ancestorPids })
  if (selected?.pm2_env?.status !== 'online') throw new Error(`PM2 process ${selected.name} is not online`)
  if (port && process.platform === 'linux') {
    const probe = createAdminRuntimeProbe({ fs: fsSync, cp, path, pm2Bin })
    probe.assertOwnership(probe.inspect({ name: selected.name, cwd: repoRoot, port }))
  }
  return {
    name: selected.name,
    pid: Number(selected.pid || 0),
    cwd: path.resolve(selected.pm2_env.pm_cwd || ''),
  }
}

export async function readSelfUpdateRestartStatus(workDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(workDir, 'restart-status.json'), 'utf8'))
  } catch {
    return null
  }
}

export async function scheduleVerifiedSelfRestart({
  repoRoot,
  workDir,
  pm2Bin,
  pm2Name,
  previousPid,
  port,
  expectedVersion,
  delayMs,
  publicUrl = '',
  lockId = '',
}) {
  const statusPath = path.join(workDir, 'restart-status.json')
  const logPath = path.join(workDir, 'restart.log')
  const initial = {
    state: 'scheduled',
    pm2Name,
    previousPid,
    expectedVersion,
    port,
    updatedAt: new Date().toISOString(),
  }
  await fs.writeFile(statusPath, `${JSON.stringify(initial, null, 2)}\n`, 'utf8')
  const logHandle = await fs.open(logPath, 'a')
  const child = spawn(process.execPath, [
    path.join(repoRoot, 'scripts', 'launch-admin-restart-verifier.mjs'),
    '--repo-root', repoRoot,
    '--work-dir', workDir,
    '--pm2-bin', pm2Bin,
    '--pm2-name', pm2Name,
    '--previous-pid', String(previousPid || 0),
    '--port', String(port),
    '--expected-version', expectedVersion,
    '--delay-ms', String(delayMs),
    '--public-url', publicUrl,
    '--lock-id', lockId,
  ], {
    cwd: repoRoot,
    env: process.env,
    detached: true,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
    windowsHide: true,
  })
  try {
  await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`restart verifier launcher exited with code ${code}`)))
  }).catch(async (error) => {
    const failed = { ...initial, state: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() }
    await fs.writeFile(statusPath, `${JSON.stringify(failed, null, 2)}\n`, 'utf8').catch(() => {})
    throw error
  })
  } finally {
    await logHandle.close()
  }
  return initial
}

export function inspectSelfUpdateRuntime({ name, repoRoot, port, pm2Bin }) {
  try { return createAdminRuntimeProbe({ fs: fsSync, cp, path, pm2Bin }).inspect({ name, cwd: repoRoot, port }) }
  catch (error) { return { error: error.code || 'runtime_inspection_failed' } }
}
