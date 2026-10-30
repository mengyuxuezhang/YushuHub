import fs from 'node:fs/promises'
import path from 'node:path'
import { failure } from './protocol.mjs'

export async function writeMigrationArtifact(file, value) {
  if (!path.isAbsolute(file)) throw failure('OUTPUT_PATH_REQUIRED', '迁入报告须指定受控目录的绝对路径')
  const parent = await fs.realpath(path.dirname(file))
  for (let current = parent;; current = path.dirname(current)) {
    try { await fs.lstat(path.join(current, '.git')); throw failure('GIT_OUTPUT_FORBIDDEN', '授权回执和经营快照不能写入Git工作区') } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (path.dirname(current) === current) break
  }
  const handle = await fs.open(path.join(parent, path.basename(file)), 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
}
