import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export async function acquireAdminMaintenanceLock(repoRoot) {
  const lock = path.join(repoRoot, 'data', 'self-update', 'maintenance.lock')
  await fs.mkdir(path.dirname(lock), { recursive: true })
  try { await fs.mkdir(lock, { mode: 0o700 }) }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('升级或修复正在执行；若任务已中断，请先检查 data/self-update/maintenance.lock/owner.json')
    throw error
  }
  const id = crypto.randomUUID()
  try { await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ id, pid: process.pid, action: 'self-update', startedAt: new Date().toISOString() }), { mode: 0o600 }) }
  catch (error) { await fs.rm(lock, { recursive: true, force: true }); throw error }
  return id
}

export async function releaseAdminMaintenanceLock(repoRoot, id) {
  if (!id) return
  const lock = path.join(repoRoot, 'data', 'self-update', 'maintenance.lock')
  let owner
  try { owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (owner.id === id) await fs.rm(lock, { recursive: true, force: true })
}

export async function transferAdminMaintenanceLock(repoRoot, id, pid) {
  if (!id) return
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid maintenance verifier PID')
  const lock = path.join(repoRoot, 'data', 'self-update', 'maintenance.lock')
  const ownerPath = path.join(lock, 'owner.json')
  const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'))
  if (owner.id !== id) throw new Error('Maintenance lock ownership changed before verifier launch')
  const temporary = path.join(lock, `${id}.tmp`)
  await fs.writeFile(temporary, JSON.stringify({ ...owner, sourcePid: owner.pid, pid, action: 'self-update-verifier' }), { mode: 0o600 })
  await fs.rename(temporary, ownerPath)
}
