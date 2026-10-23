import fs from 'node:fs/promises'
import path from 'node:path'

async function directories(root, pattern) {
  const stat = await fs.lstat(root).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return []
  const entries = await fs.readdir(root, { withFileTypes: true })
  const rows = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !pattern.test(entry.name)) continue
    const target = path.join(root, entry.name)
    const info = await fs.lstat(target)
    if (info.isDirectory() && !info.isSymbolicLink()) rows.push({ target, name: entry.name, mtimeMs: info.mtimeMs })
  }
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
}

export async function cleanupSelfUpdateStorage(workDir, { keepBackups = 3, now = Date.now() } = {}) {
  if (!Number.isInteger(keepBackups) || keepBackups < 1) throw new Error('At least one rollback backup must be retained')
  const removed = []
  const backups = await directories(path.join(workDir, 'backups'), /^backup-.+-\d{13}-[a-f0-9]{8}$/)
  const runs = await directories(workDir, /^\d{13}-[a-f0-9]{8}$/)
  // Older failed runs may remain from releases that predate the finally cleanup.
  for (const item of [...backups.slice(keepBackups), ...runs.filter((item) => now - Number(item.name.split('-')[0]) > 7 * 86400000)]) {
    await fs.rm(item.target, { recursive: true, force: true })
    removed.push(item.target)
  }
  return { removed, retainedBackups: Math.min(backups.length, keepBackups) }
}

export async function cleanupFailedBuildStorage({ previewRoot, temporaryRoots = [], findBuild, now = Date.now(), retentionMs = 7 * 86400000 }) {
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
  const pattern = new RegExp(`^(?:(${uuid})|\\.uploading-(${uuid})-[a-f0-9]{12})$`)
  const candidates = []
  for (const project of await directories(previewRoot, /^[a-zA-Z0-9_-]+$/)) {
    candidates.push(...await directories(project.target, pattern))
  }
  for (const root of temporaryRoots) candidates.push(...await directories(root, pattern))
  const removed = []
  for (const item of candidates) {
    if (now - item.mtimeMs < retentionMs) continue
    const match = item.name.match(pattern)
    const build = await findBuild(match[1] || match[2])
    if (!build || !['failed', 'cancelled'].includes(build.status) || build.releaseStatus === 'publishing') continue
    const finishedAt = new Date(build.finishedAt || '').getTime()
    if (!Number.isFinite(finishedAt) || now - finishedAt < retentionMs) continue
    await fs.rm(item.target, { recursive: true, force: true })
    removed.push(item.target)
  }
  return { removed }
}
