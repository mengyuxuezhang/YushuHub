import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { digest, failure, identifier } from '../services/licensing/protocol.mjs'

export const SUPPLY_VOICE_ARTIFACT_SCHEMA = `CREATE TABLE IF NOT EXISTS supply_voice_artifacts (
  book VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  root_id VARCHAR(120) NOT NULL,organization_id VARCHAR(120) NOT NULL,subject_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model_id VARCHAR(120) NOT NULL,resource_id VARCHAR(64) NOT NULL,request_id VARCHAR(80) NOT NULL,kind VARCHAR(16) NOT NULL,
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,byte_length INT UNSIGNED NOT NULL,
  created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,deleted_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(book,id),KEY resource_artifacts(book,resource_id,created_at),KEY artifact_expiry(book,deleted_at,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`
const fields = input => {
  for (const value of [input?.rootId, input?.organizationId, input?.modelId]) identifier(value)
  if (typeof input.subjectHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.subjectHash)) throw failure('VOICE_SUBJECT_REQUIRED', '音频必须有已认证终端主体', 403)
  return [input.rootId, input.organizationId, input.subjectHash, input.modelId]
}
const ownerWhere = 'root_id=? AND organization_id=? AND subject_hash=? AND model_id=?'
export function privateVoiceArtifactId(book, scope, resourceId, requestId, kind) {
  for (const value of [book, scope.rootId, scope.organizationId, scope.modelId, resourceId, requestId]) identifier(value)
  if (!/^[a-f0-9]{64}$/.test(scope.subjectHash || '') || !['preview', 'speech'].includes(kind)) throw failure('VOICE_ARTIFACT_INVALID', '音频主体或类型无效')
  return `va-${digest(JSON.stringify([book, ...fields(scope), resourceId, requestId, kind]))}`
}
const publicArtifact = row => ({ artifactId: row.id, audioSha256: row.content_hash, byteLength: Number(row.byte_length), mimeType: 'audio/mpeg', expiresAt: Number(row.expires_at) })

export function supplyVoiceArtifacts({ pool, voices, book, directory, retentionMs = 30 * 86_400_000, now = Date.now }) {
  identifier(book)
  if (book.length > 80 || !path.isAbsolute(directory) || !Number.isSafeInteger(retentionMs) || retentionMs < 86_400_000 || retentionMs > 365 * 86_400_000) throw new Error('Controlled artifact directory and 1-365 day retention required')
  async function fileFor(id) {
    if (!/^va-[a-f0-9]{64}$/.test(id)) throw failure('VOICE_ARTIFACT_INVALID', '音频索引无效')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const root = await fs.realpath(directory), file = path.resolve(root, `${digest(book).slice(0, 12)}-${id.slice(3)}.mp3`)
    if (path.dirname(file) !== root) throw failure('VOICE_ARTIFACT_INVALID', '音频不在受控目录')
    return file
  }
  async function verifiedBytes(row) {
    const file = await fileFor(row.id), stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Number(row.byte_length)) throw failure('VOICE_ARTIFACT_INVALID', '音频文件需要核对', 409)
    const bytes = await fs.readFile(file)
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== row.content_hash) throw failure('VOICE_ARTIFACT_INVALID', '音频摘要不一致', 409)
    return bytes
  }
  async function remove(row) {
    await fs.unlink(await fileFor(row.id)).catch(error => { if (error.code !== 'ENOENT') throw error })
    await pool.query('UPDATE supply_voice_artifacts SET deleted_at=? WHERE book=? AND id=? AND deleted_at=0', [now(), book, row.id])
  }
  return {
    async save(scope, resourceId, requestId, kind, bytes) {
      const id = privateVoiceArtifactId(book, scope, resourceId, requestId, kind)
      const job = await voices.job(scope, requestId)
      if (job.resourceId !== resourceId || (kind === 'preview' ? job.action !== 'clone' : !['activate', 'synthesize'].includes(job.action))) throw failure('VOICE_ARTIFACT_SCOPE_DENIED', '音频不属于原音色操作', 403)
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 20 * 1024 * 1024) throw failure('VOICE_ARTIFACT_INVALID', '音频大小无效')
      const hash = crypto.createHash('sha256').update(bytes).digest('hex'), connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const [[resource]] = await connection.query(`SELECT id,status FROM supply_voice_resources WHERE book=? AND id=? AND ${ownerWhere} FOR UPDATE`, [book, resourceId, ...fields(scope)])
        if (!resource || resource.status === 'deleted') throw failure('VOICE_NOT_FOUND', '原音色不存在或已删除', 404)
        const [[previous]] = await connection.query('SELECT * FROM supply_voice_artifacts WHERE book=? AND id=? FOR UPDATE', [book, id])
        if (previous) {
          if (previous.content_hash !== hash || Number(previous.byte_length) !== bytes.length) throw failure('VOICE_ARTIFACT_CONFLICT', '原音频内容不能替换', 409)
          if (Number(previous.deleted_at) || Number(previous.expires_at) <= now()) throw failure('VOICE_ARTIFACT_EXPIRED', '原音频已清理，不重新受理付费生成', 410)
          try { await verifiedBytes(previous) } catch (error) {
            if (!['ENOENT', 'VOICE_ARTIFACT_INVALID'].includes(error.code)) throw error
            // The immutable database digest authenticates these replacement
            // bytes. Repair storage only; never regenerate a paid inference.
            const file = await fileFor(id), temporary = `${file}.repair-${crypto.randomUUID()}`
            let created = false
            try {
              const handle = await fs.open(temporary, 'wx', 0o600); created = true
              try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
              await fs.rename(temporary, file)
            } finally { if (created) await fs.unlink(temporary).catch(() => {}) }
            await verifiedBytes(previous)
          }
          await connection.rollback(); return publicArtifact(previous)
        }
        const file = await fileFor(id)
        try {
          const handle = await fs.open(file, 'wx', 0o600)
          try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
          // Recover a possibly committed file after a lost reply; never replace
          // different content or unlink it based only on transaction failure.
          await verifiedBytes({ id, content_hash: hash, byte_length: bytes.length })
        }
        const row = { id, content_hash: hash, byte_length: bytes.length, expires_at: now() + retentionMs }
        await connection.query('INSERT INTO supply_voice_artifacts(book,id,root_id,organization_id,subject_hash,model_id,resource_id,request_id,kind,content_hash,byte_length,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [book, id, ...fields(scope), resourceId, requestId, kind, hash, bytes.length, now(), row.expires_at])
        await connection.commit(); return publicArtifact(row)
      } catch (error) { await connection.rollback().catch(() => {}); throw error } finally { connection.release() }
    },
    async read(scope, id) {
      if (!/^va-[a-f0-9]{64}$/.test(id)) throw failure('VOICE_ARTIFACT_INVALID', '音频索引无效')
      const [[row]] = await pool.query(`SELECT * FROM supply_voice_artifacts WHERE book=? AND id=? AND ${ownerWhere}`, [book, id, ...fields(scope)])
      if (!row) throw failure('VOICE_ARTIFACT_NOT_FOUND', '本主体音频不存在', 404)
      const resource = await voices.get(scope, row.resource_id), job = await voices.job(scope, row.request_id)
      if (resource.status === 'deleted' || Number(row.deleted_at) || Number(row.expires_at) <= now()) throw failure('VOICE_ARTIFACT_EXPIRED', '原音频已清理，不重新受理付费生成', 410)
      if (job.state !== 'done' || job.outcome?.state !== 'done' || job.outcome.result?.error) throw failure('VOICE_ARTIFACT_PENDING', '原音频任务尚未确认', 409)
      return { ...publicArtifact(row), bytes: await verifiedBytes(row) }
    },
    async purgeResource(scope, resourceId) {
      const resource = await voices.get(scope, resourceId)
      if (resource.status !== 'deleted') throw failure('VOICE_BUSY', '音色尚未完成删除，保留音频供核对', 409)
      const [rows] = await pool.query(`SELECT * FROM supply_voice_artifacts WHERE book=? AND resource_id=? AND ${ownerWhere} AND deleted_at=0`, [book, resourceId, ...fields(scope)])
      for (const row of rows) await remove(row)
      return { cleaned: rows.length }
    },
    async pruneExpired() {
      const [rows] = await pool.query("SELECT a.* FROM supply_voice_artifacts a JOIN supply_voice_resources r ON r.book=a.book AND r.id=a.resource_id WHERE a.book=? AND a.deleted_at=0 AND (a.expires_at<=? OR r.status='deleted') ORDER BY a.expires_at,a.id LIMIT 50", [book, now()])
      for (const row of rows) await remove(row)
      return { cleaned: rows.length }
    },
  }
}
