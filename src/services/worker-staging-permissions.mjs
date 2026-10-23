import path from 'node:path'
import fsp from 'node:fs/promises'

const STAGING_DIRECTORY_MODE = 0o2775

function assertDirectChild(rootDir, projectId) {
  const root = path.resolve(String(rootDir || ''))
  const id = String(projectId || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(id)) {
    throw new Error(`Invalid worker staging project ID: ${projectId}`)
  }
  const target = path.resolve(root, id)
  if (path.dirname(target) !== root) {
    throw new Error(`Worker staging path escapes its root: ${projectId}`)
  }
  return { root, id, target }
}

async function requireRealDirectory(filesystem, target, label) {
  const stat = await filesystem.lstat(target)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${target}`)
  }
  return stat
}

export async function ensureWorkerStagingDirectory({ rootDir, projectId, filesystem = fsp }) {
  const { root, id, target } = assertDirectChild(rootDir, projectId)
  const rootStat = await requireRealDirectory(filesystem, root, 'Worker staging root')

  try {
    await filesystem.mkdir(target, { mode: STAGING_DIRECTORY_MODE })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  let targetStat = await requireRealDirectory(filesystem, target, 'Worker staging project path')
  if (targetStat.gid !== rootStat.gid) {
    await filesystem.chown(target, targetStat.uid, rootStat.gid)
  }
  await filesystem.chmod(target, STAGING_DIRECTORY_MODE)

  targetStat = await requireRealDirectory(filesystem, target, 'Worker staging project path')
  const groupWritable = (targetStat.mode & 0o020) !== 0
  const setgid = (targetStat.mode & 0o2000) !== 0
  if (targetStat.gid !== rootStat.gid || !groupWritable || !setgid) {
    throw new Error(`Worker staging project directory permissions could not be normalized: ${target}`)
  }

  return { projectId: id, path: target, gid: targetStat.gid, mode: targetStat.mode & 0o7777 }
}

export async function normalizeExistingWorkerStagingDirectories({ rootDir, filesystem = fsp }) {
  const root = path.resolve(String(rootDir || ''))
  await requireRealDirectory(filesystem, root, 'Worker staging root')
  const entries = await filesystem.readdir(root, { withFileTypes: true })
  const result = { normalized: [], skipped: [], errors: [] }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      result.skipped.push(entry.name)
      continue
    }
    try {
      result.normalized.push(await ensureWorkerStagingDirectory({ rootDir: root, projectId: entry.name, filesystem }))
    } catch (error) {
      result.errors.push({ name: entry.name, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

export { STAGING_DIRECTORY_MODE }
