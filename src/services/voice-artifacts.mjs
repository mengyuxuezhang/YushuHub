import { mkdir, writeFile, rename, readFile, readdir, lstat, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export class VoiceArtifactStore {
  constructor(root) { this.root = path.resolve(root) }
  file(id) {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id)) throw new Error('VOICE_ARTIFACT_INVALID')
    return path.join(this.root, `${id}.mp3`)
  }
  async save(id, bytes) {
    const target = this.file(id)
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('VOICE_ARTIFACT_INVALID')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
      await rename(temporary, target)
    } finally { await rm(temporary, { force: true }) }
  }
  async read(id) {
    const file = this.file(id)
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 20 * 1024 * 1024) throw new Error('VOICE_ARTIFACT_INVALID')
    return readFile(file)
  }
  async remove(id) { await rm(this.file(id), { force: true }) }
  async cleanExpired(now = Date.now(), retentionMs = 7 * 24 * 60 * 60 * 1000) {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.mp3(?:\.[0-9a-f-]{36}\.tmp)?$/.test(entry.name)) continue
      const file = path.join(this.root, entry.name)
      const info = await lstat(file)
      if (info.isFile() && now - info.mtimeMs >= retentionMs) await rm(file, { force: true })
    }
  }
}
