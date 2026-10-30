import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { digest, failure, identifier } from '../services/licensing/protocol.mjs'
import { inspectVoiceAudio } from '../services/voice-audio.mjs'

const table = (name, columns) => `CREATE TABLE IF NOT EXISTS supply_voice_${name} (${columns}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`
const bookColumn = 'book VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL'
export const SUPPLY_VOICE_SCHEMA = [
  table('locks', `${bookColumn}, id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, PRIMARY KEY(book,id)`),
  table('resources', `${bookColumn}, id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    root_id VARCHAR(120) NOT NULL,organization_id VARCHAR(120) NOT NULL,subject_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    model_id VARCHAR(120) NOT NULL,upload_request_id VARCHAR(80) NOT NULL,input_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(24) NOT NULL,expires_at BIGINT NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,payload JSON NOT NULL,
    PRIMARY KEY(book,id),UNIQUE KEY upload_once(book,organization_id,subject_hash,upload_request_id),
    KEY owner_resources(book,organization_id,subject_hash,status),KEY expiry(book,status,expires_at)`),
  table('jobs', `${bookColumn},id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,resource_id VARCHAR(64) NOT NULL,
    organization_id VARCHAR(120) NOT NULL,subject_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action VARCHAR(24) NOT NULL,state VARCHAR(24) NOT NULL,fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    updated_at BIGINT NOT NULL,payload JSON NOT NULL,PRIMARY KEY(book,id),KEY active_jobs(book,resource_id,state)`),
]
export async function migrateSupplyVoiceSchema(pool) { for (const sql of SUPPLY_VOICE_SCHEMA) await pool.query(sql) }
const parse = value => typeof value === 'string' ? JSON.parse(value) : value
const decode = row => row ? { ...parse(row.payload), id: row.id, status: row.status, expiresAt: Number(row.expires_at), createdAt: Number(row.created_at) } : null
const sha = value => /^[a-f0-9]{64}$/.test(value || '')
function scopeOf(input) {
  const scope = Object.fromEntries(['rootId', 'organizationId', 'subjectHash', 'modelId'].map(key => [key, input?.[key]]))
  for (const key of ['rootId', 'organizationId', 'modelId']) identifier(scope[key])
  if (!sha(scope.subjectHash)) throw failure('VOICE_SUBJECT_REQUIRED', '私有音色必须有已认证终端主体', 403)
  return scope
}
const scopeValues = scope => [scope.rootId, scope.organizationId, scope.subjectHash, scope.modelId]
const ownedWhere = 'root_id=? AND organization_id=? AND subject_hash=? AND model_id=?'
const publicResource = row => ({ id: row.id, modelId: row.modelId, name: row.name || '', category: 'private', status: row.status,
  expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null })

// Explicit SQL migration; no runtime DDL or monetary writes. This repository
// is an internal supplier-execution primitive, not an unauthenticated API.
export function supplyVoiceRepository({ pool, book, directory, inspectAudio = inspectVoiceAudio, now = Date.now }) {
  identifier(book)
  if (book.length > 80 || !path.isAbsolute(directory)) throw new Error('Explicit private voice book and absolute controlled directory required')
  async function transaction(work) {
    const connection = await pool.getConnection()
    let committing = false
    try { await connection.beginTransaction(); const result = await work(connection); committing = true; await connection.commit(); return result }
    catch (error) {
      try { await connection.rollback(); if (!committing) error.voiceTransactionRolledBack = true } catch {}
      throw error
    } finally { connection.release() }
  }
  async function filePath(name) {
    if (!/^[a-f0-9]{12}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.recording$/.test(name) || !name.startsWith(digest(book).slice(0, 12) + '-')) throw failure('VOICE_FILE_INVALID', '录音文件索引无效', 409)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const root = await fs.realpath(directory), file = path.resolve(root, name)
    if (path.dirname(file) !== root) throw failure('VOICE_FILE_INVALID', '录音文件不在受控目录', 409)
    return file
  }
  async function find(connection, scope, id, lock = false) {
    identifier(id)
    const [[row]] = await connection.query(`SELECT * FROM supply_voice_resources WHERE book=? AND id=? AND ${ownedWhere}${lock ? ' FOR UPDATE' : ''}`, [book, id, ...scopeValues(scope)])
    if (!row) throw failure('VOICE_NOT_FOUND', '本主体音色不存在', 404)
    return decode(row)
  }
  async function update(connection, resource, status, expiresAt = resource.expiresAt) {
    const { id, status: ignored, expiresAt: ignoredExpiry, createdAt, ...payload } = resource
    await connection.query('UPDATE supply_voice_resources SET status=?,expires_at=?,updated_at=?,payload=? WHERE book=? AND id=?', [status, expiresAt, now(), JSON.stringify(payload), book, id])
    return { ...resource, status, expiresAt }
  }
  const api = {
    migrate: () => migrateSupplyVoiceSchema(pool),
    async assertReady() { for (const table of ['locks', 'resources', 'jobs']) await pool.query(`SELECT id FROM supply_voice_${table} WHERE book=? LIMIT 0`, [book]) },
    async upload(input, { requestId, format, bytes }) {
      const scope = scopeOf(input); identifier(requestId)
      if (requestId.length > 80 || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 20 * 1024 * 1024 || !['mp3', 'm4a', 'wav'].includes(format)) throw failure('VOICE_AUDIO_INVALID', '录音规格无效')
      const audioHash = crypto.createHash('sha256').update(bytes).digest('hex'), inputHash = digest(JSON.stringify({ ...scope, format, audioHash }))
      const existing = async connection => {
        const [[row]] = await connection.query('SELECT * FROM supply_voice_resources WHERE book=? AND organization_id=? AND subject_hash=? AND upload_request_id=?', [book, scope.organizationId, scope.subjectHash, requestId])
        if (row && row.input_hash !== inputHash) throw failure('IDEMPOTENCY_CONFLICT', '上传编号已用于其他录音或模型', 409)
        return decode(row)
      }
      const previous = await existing(pool)
      if (previous) return publicResource(previous)
      const inspected = await inspectAudio(bytes, format)
      let createdFile
      try {
        return await transaction(async connection => {
          const owner = digest(JSON.stringify([scope.rootId, scope.organizationId, scope.subjectHash]))
          await connection.query('INSERT INTO supply_voice_locks(book,id) VALUES (?,?) ON DUPLICATE KEY UPDATE id=VALUES(id)', [book, owner])
          const concurrent = await existing(connection)
          if (concurrent) return publicResource(concurrent)
          await connection.query("UPDATE supply_voice_resources SET status='expired',updated_at=? WHERE book=? AND root_id=? AND organization_id=? AND subject_hash=? AND status='uploaded' AND expires_at<=?", [now(), book, scope.rootId, scope.organizationId, scope.subjectHash, now()])
          const [[count]] = await connection.query("SELECT COUNT(*) AS n FROM supply_voice_resources WHERE book=? AND root_id=? AND organization_id=? AND subject_hash=? AND status NOT IN ('deleted','expired')", [book, scope.rootId, scope.organizationId, scope.subjectHash])
          if (Number(count.n) >= 20) throw failure('VOICE_QUOTA_EXCEEDED', '最多保留20个未清理私有音色', 409)
          const id = crypto.randomUUID(), name = `${digest(book).slice(0, 12)}-${id}.recording`, file = await filePath(name)
          const handle = await fs.open(file, 'wx', 0o600); createdFile = file
          try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
          const row = { ...scope, id, name: '', sourceFile: name, sourceDeleted: false, format, audioHash, byteLength: bytes.length, durationSec: inspected.duration,
            createdAt: now(), expiresAt: now() + 3_600_000, status: 'uploaded' }
          const { status, expiresAt, createdAt, ...payload } = row
          await connection.query('INSERT INTO supply_voice_resources(book,id,root_id,organization_id,subject_hash,model_id,upload_request_id,input_hash,status,expires_at,created_at,updated_at,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [book, id, ...scopeValues(scope), requestId, inputHash, status, expiresAt, createdAt, now(), JSON.stringify(payload)])
          return publicResource(row)
        })
      } catch (error) {
        // A lost COMMIT reply may mean the row already exists. Keep its file;
        // a same-input retry can recover it. Never destroy a possibly committed
        // recording based only on a connection error.
        if (createdFile && error.voiceTransactionRolledBack === true) await fs.unlink(createdFile).catch(() => {})
        throw error
      }
    },
    async get(input, id) { return find(pool, scopeOf(input), id) },
    async list(input) {
      const scope = scopeOf(input)
      const [rows] = await pool.query(`SELECT * FROM supply_voice_resources WHERE book=? AND ${ownedWhere} AND status NOT IN ('deleted','uploaded','expired') ORDER BY created_at DESC,id LIMIT 100`, [book, ...scopeValues(scope)])
      return rows.map(row => publicResource(decode(row)))
    },
    async source(input, id) {
      const resource = await api.get(input, id)
      if (resource.sourceDeleted || !['uploaded', 'cloning'].includes(resource.status)) throw failure('VOICE_SOURCE_UNAVAILABLE', '原录音不可重新受理', 409)
      const file = await filePath(resource.sourceFile), stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== resource.byteLength) throw failure('VOICE_FILE_INVALID', '原录音文件需核对', 409)
      const bytes = await fs.readFile(file)
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== resource.audioHash) throw failure('VOICE_FILE_INVALID', '原录音摘要不一致', 409)
      return { bytes, format: resource.format }
    },
    async claim(input, id, { requestId, action, inputHash, bindingHash, credentialId, name = '' }) {
      const scope = scopeOf(input); identifier(requestId)
      if (requestId.length > 80 || !sha(inputHash) || !sha(bindingHash) || !['clone', 'activate', 'synthesize', 'delete'].includes(action)
        || typeof name !== 'string' || name.length > 120) throw failure('VOICE_ACTION_INVALID', '音色操作参数无效')
      if (credentialId !== undefined) identifier(credentialId)
      const fingerprint = digest(JSON.stringify({ ...scope, id, action, inputHash, bindingHash, credentialId, name }))
      return transaction(async connection => {
        const resource = await find(connection, scope, id, true)
        const [[previous]] = await connection.query('SELECT * FROM supply_voice_jobs WHERE book=? AND id=? FOR UPDATE', [book, requestId])
        if (previous) {
          if (previous.fingerprint !== fingerprint || previous.organization_id !== scope.organizationId || previous.subject_hash !== scope.subjectHash) throw failure('IDEMPOTENCY_CONFLICT', '音色操作编号冲突', 409)
          return { created: false, resource, job: { ...parse(previous.payload), requestId, action: previous.action, state: previous.state } }
        }
        if (resource.bindingHash && (resource.bindingHash !== bindingHash || resource.credentialId !== credentialId)) throw failure('VOICE_BINDING_CHANGED', '音色必须使用原连接和原凭据', 409)
        const allowed = { clone: ['uploaded'], activate: ['preview_ready'], synthesize: ['active'], delete: ['uploaded', 'preview_ready', 'active', 'unknown', 'failed', 'expired'] }[action]
        if (!allowed.includes(resource.status) || (['clone', 'activate'].includes(action) && resource.expiresAt <= now())) throw failure('VOICE_NOT_READY', '音色状态或有效期不允许此操作', 409)
        const [[running]] = await connection.query("SELECT COUNT(*) AS n FROM supply_voice_jobs WHERE book=? AND resource_id=? AND state IN ('dispatch','unknown')", [book, id])
        if (Number(running.n) && action !== 'synthesize') throw failure('VOICE_BUSY', '音色仍有未核对操作', 409)
        if (action === 'synthesize') {
          const [[unknown]] = await connection.query("SELECT COUNT(*) AS n FROM supply_voice_jobs WHERE book=? AND resource_id=? AND state='unknown'", [book, id])
          if (Number(unknown.n)) throw failure('VOICE_BUSY', '原配音结果未知，请先核对', 409)
        }
        resource.bindingHash ||= bindingHash
        if (credentialId) resource.credentialId ||= credentialId
        if (action === 'clone') { resource.name = name.trim(); resource.providerVoiceId = `Agent${crypto.randomUUID().replaceAll('-', '')}` }
        const claimed = await update(connection, resource, ({ clone: 'cloning', activate: 'activating', synthesize: 'active', delete: 'deleting' })[action])
        const job = { stage: 'dispatch-ready', resourceId: id, previousStatus: resource.status, bindingHash, ...(credentialId ? { credentialId } : {}) }
        await connection.query('INSERT INTO supply_voice_jobs(book,id,resource_id,organization_id,subject_hash,action,state,fingerprint,updated_at,payload) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [book, requestId, id, scope.organizationId, scope.subjectHash, action, 'dispatch', fingerprint, now(), JSON.stringify(job)])
        return { created: true, resource: claimed, job: { ...job, requestId, action, state: 'dispatch' } }
      })
    },
    async finish(input, id, requestId, outcome) {
      const scope = scopeOf(input); identifier(requestId)
      if (!outcome || !['done', 'unknown'].includes(outcome.state) || JSON.stringify(outcome).length > 262144 || (outcome.state === 'done' && (!Array.isArray(outcome.usage) || (outcome.result?.error && outcome.usage.length)))) throw failure('VOICE_OUTCOME_INVALID', '须持久化明确用量或未知状态')
      return transaction(async connection => {
        const resource = await find(connection, scope, id, true)
        const [[row]] = await connection.query('SELECT * FROM supply_voice_jobs WHERE book=? AND id=? AND resource_id=? AND organization_id=? AND subject_hash=? FOR UPDATE', [book, requestId, id, scope.organizationId, scope.subjectHash])
        if (!row) throw failure('VOICE_JOB_NOT_FOUND', '原音色操作不存在', 404)
        const previous = parse(row.payload)
        if (row.state === 'done') {
          if (digest(JSON.stringify(previous.outcome)) !== digest(JSON.stringify(outcome))) throw failure('VOICE_SETTLEMENT_IMMUTABLE', '已确认音色结果不能改写', 409)
          return previous.outcome
        }
        let status = resource.status, expiry = resource.expiresAt
        if (outcome.state === 'done') {
          if (outcome.result?.error) status = row.action === 'clone' ? 'failed' : previous.previousStatus
          else if (row.action === 'clone') { status = 'preview_ready'; expiry = now() + 7 * 86_400_000 }
          else if (row.action === 'activate') { status = 'active'; expiry = 0 }
          else if (row.action === 'delete') { status = 'deleted'; expiry = 0 }
        } else if (row.action !== 'synthesize') status = 'unknown'
        await update(connection, resource, status, expiry)
        await connection.query('UPDATE supply_voice_jobs SET state=?,updated_at=?,payload=? WHERE book=? AND id=?', [outcome.state, now(), JSON.stringify({ ...previous, ...(outcome.state === 'done' ? { stage: 'result-received' } : {}), outcome }), book, requestId])
        return outcome
      })
    },
    async job(input, requestId) {
      const scope = scopeOf(input); identifier(requestId)
      const [[row]] = await pool.query('SELECT * FROM supply_voice_jobs WHERE book=? AND id=? AND organization_id=? AND subject_hash=?', [book, requestId, scope.organizationId, scope.subjectHash])
      if (!row) throw failure('VOICE_JOB_NOT_FOUND', '原主体音色操作不存在', 404)
      await find(pool, scope, row.resource_id)
      return { ...parse(row.payload), requestId, action: row.action, state: row.state, resourceId: row.resource_id }
    },
    async checkpoint(input, id, requestId, patch) {
      const scope = scopeOf(input); identifier(requestId)
      const stages = ['dispatch-ready', 'file-uploaded', 'submitted', 'result-received', 'cleanup-pending', 'clean']
      if (!patch || Object.keys(patch).some(key => !['stage', 'upstreamFileId', 'cleanupPending'].includes(key))
        || (patch.stage !== undefined && !stages.includes(patch.stage)) || (patch.upstreamFileId !== undefined && (typeof patch.upstreamFileId !== 'string' || !/^\d{1,20}$/.test(patch.upstreamFileId)))
        || (patch.cleanupPending !== undefined && typeof patch.cleanupPending !== 'boolean')) throw failure('VOICE_CHECKPOINT_INVALID', '上游文件或阶段标记无效')
      return transaction(async connection => {
        await find(connection, scope, id, true)
        const [[row]] = await connection.query('SELECT * FROM supply_voice_jobs WHERE book=? AND id=? AND resource_id=? AND organization_id=? AND subject_hash=? FOR UPDATE', [book, requestId, id, scope.organizationId, scope.subjectHash])
        if (!row) throw failure('VOICE_JOB_NOT_FOUND', '原音色操作不存在', 404)
        const previous = parse(row.payload)
        if (row.state !== 'done' && ((patch.stage !== undefined && stages.indexOf(patch.stage) >= stages.indexOf('cleanup-pending')) || patch.cleanupPending === false)) throw failure('VOICE_CHECKPOINT_INVALID', '结果未知时不能提前清理供应商文件', 409)
        if (patch.upstreamFileId && !previous.upstreamFileId && patch.cleanupPending !== true) throw failure('VOICE_CHECKPOINT_INVALID', '首次登记供应商文件必须保留清理标记', 409)
        if ((patch.stage !== undefined && stages.indexOf(patch.stage) < stages.indexOf(previous.stage))
          || (patch.upstreamFileId !== undefined && ((previous.upstreamFileId && patch.upstreamFileId !== previous.upstreamFileId) || (row.state === 'done' && !previous.upstreamFileId)))) throw failure('VOICE_CHECKPOINT_IMMUTABLE', '原上游文件和已受理阶段不能替换或倒退', 409)
        const next = { ...previous, ...patch }
        await connection.query('UPDATE supply_voice_jobs SET updated_at=?,payload=? WHERE book=? AND id=?', [now(), JSON.stringify(next), book, requestId])
        return { ...next, requestId, action: row.action, state: row.state }
      })
    },
    async releaseSource(input, id) {
      const scope = scopeOf(input), resource = await api.get(scope, id)
      if (!['preview_ready', 'active', 'deleted', 'failed', 'expired'].includes(resource.status)) throw failure('VOICE_BUSY', '原录音尚需核对，不能清理', 409)
      await fs.unlink(await filePath(resource.sourceFile)).catch(error => { if (error.code !== 'ENOENT') throw error })
      await transaction(async connection => { const current = await find(connection, scope, id, true); current.sourceDeleted = true; await update(connection, current, current.status) })
    },
    async pruneExpiredUploads() {
      const [rows] = await pool.query("SELECT * FROM supply_voice_resources WHERE book=? AND status IN ('uploaded','expired') AND expires_at<=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.sourceDeleted'))='false' ORDER BY expires_at,id LIMIT 50", [book, now()])
      let cleaned = 0
      for (const row of rows) {
        const scope = scopeOf({ rootId: row.root_id, organizationId: row.organization_id, subjectHash: row.subject_hash, modelId: row.model_id })
        const expired = await transaction(async connection => {
          const current = await find(connection, scope, row.id, true)
          if (!['uploaded', 'expired'].includes(current.status) || current.expiresAt > now()) return false
          await update(connection, current, 'expired'); return true
        })
        if (expired) { await api.releaseSource(scope, row.id); cleaned++ }
      }
      return { cleaned }
    },
    async pruneSafeSources() {
      const [rows] = await pool.query("SELECT * FROM supply_voice_resources WHERE book=? AND status IN ('preview_ready','active','deleted','failed','expired') AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.sourceDeleted'))='false' ORDER BY created_at,id LIMIT 50", [book])
      let cleaned = 0
      for (const row of rows) {
        const scope = scopeOf({ rootId: row.root_id, organizationId: row.organization_id, subjectHash: row.subject_hash, modelId: row.model_id })
        try { await api.releaseSource(scope, row.id); cleaned++ } catch (error) { if (error.code !== 'VOICE_BUSY') throw error }
      }
      return { cleaned }
    },
  }
  return api
}
