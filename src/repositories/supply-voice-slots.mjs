import crypto from 'node:crypto'
import { digest, failure, identifier } from '../services/licensing/protocol.mjs'

export const SUPPLY_VOICE_SLOTS_SCHEMA = `CREATE TABLE IF NOT EXISTS supply_voice_slots (
  book VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  root_id VARCHAR(120) NOT NULL,organization_id VARCHAR(120) NOT NULL,subject_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model_id VARCHAR(120) NOT NULL,source VARCHAR(16) NOT NULL,resource_id VARCHAR(64) DEFAULT NULL,state VARCHAR(16) NOT NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,model_snapshot JSON NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,
  PRIMARY KEY(book,id),UNIQUE KEY resource_once(book,resource_id),KEY owner_slots(book,root_id,organization_id,subject_hash,state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`
const parse = value => typeof value === 'string' ? JSON.parse(value) : value
const fields = scope => {
  identifier(scope?.rootId); identifier(scope?.organizationId)
  if (!/^[a-f0-9]{64}$/.test(scope.subjectHash || '')) throw failure('VOICE_SUBJECT_REQUIRED', '须绑定已认证终端主体', 403)
  return [scope.rootId, scope.organizationId, scope.subjectHash]
}
const owned = 'root_id=? AND organization_id=? AND subject_hash=?'
const project = row => ({ requestId: row.id, resourceId: row.resource_id, state: row.state, model: parse(row.model_snapshot), createdAt: Number(row.created_at) })
export function supplyVoiceSlots({ pool, book, now = Date.now }) {
  identifier(book)
  return {
    async assertReady() {
      await pool.query('SELECT 1 FROM supply_voice_slots LIMIT 0')
      const [[unmapped]] = await pool.query("SELECT r.id FROM supply_voice_routing r LEFT JOIN supply_voice_slots s ON s.book=r.book AND s.resource_id=r.resource_id WHERE r.book=? AND r.kind='resource' AND s.id IS NULL LIMIT 1", [book])
      if (unmapped) throw failure('VOICE_SLOT_REVIEW_REQUIRED', '已有未登记总额度的音色路由，须先核对，禁止静默扩额', 409)
    },
    async reserve(scope, model, { requestId, format, bytes }) {
      const owner = fields(scope); identifier(requestId); identifier(model.id)
      if (requestId.length > 80 || !['official', 'custom'].includes(model.source) || model.adapter !== 'minimax.private_voice' || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 20 * 1024 * 1024 || !['wav', 'mp3', 'm4a'].includes(format)) throw failure('VOICE_AUDIO_INVALID', '录音或模型范围无效')
      const fingerprint = digest(JSON.stringify([owner, model.id, model.source, format, crypto.createHash('sha256').update(bytes).digest('hex')]))
      const snapshot = Object.fromEntries(['id', 'source', 'version', 'adapter', 'clientId', 'definitionSource', 'providerModelId', 'bindingHash'].filter(key => model[key] !== undefined).map(key => [key, model[key]]))
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        await connection.query('INSERT INTO supply_voice_locks(book,id) VALUES (?,?) ON DUPLICATE KEY UPDATE id=VALUES(id)', [book, digest(JSON.stringify(['combined-upload-slots', ...owner]))])
        const [[previous]] = await connection.query('SELECT * FROM supply_voice_slots WHERE book=? AND id=? FOR UPDATE', [book, requestId])
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '上传编号已绑定其他录音或主体', 409)
          if (previous.state !== 'held') throw failure('VOICE_UPLOAD_CLOSED', '原上传已清理，请使用新的请求编号', 409)
          await connection.commit(); return project(previous)
        }
        const [[count]] = await connection.query(`SELECT COUNT(*) AS n FROM supply_voice_slots WHERE book=? AND ${owned} AND state='held'`, [book, ...owner])
        if (Number(count.n) >= 20) throw failure('VOICE_QUOTA_EXCEEDED', '官方与自接合计最多保留20个未清理音色，未确认上传也占用额度', 409)
        await connection.query('INSERT INTO supply_voice_slots(book,id,root_id,organization_id,subject_hash,model_id,source,state,fingerprint,model_snapshot,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [book, requestId, ...owner, model.id, model.source, 'held', fingerprint, JSON.stringify(snapshot), now(), now()])
        await connection.commit(); return { requestId, resourceId: null, state: 'held', model: snapshot, createdAt: now() }
      } catch (error) { await connection.rollback().catch(() => {}); throw error } finally { connection.release() }
    },
    async pending(scope) {
      const [rows] = await pool.query(`SELECT * FROM supply_voice_slots WHERE book=? AND ${owned} AND state='held' AND resource_id IS NULL ORDER BY created_at,id LIMIT 20`, [book, ...fields(scope)])
      return rows.map(project)
    },
    async get(scope, requestId) {
      const [[row]] = await pool.query(`SELECT * FROM supply_voice_slots WHERE book=? AND id=? AND ${owned}`, [book, identifier(requestId), ...fields(scope)])
      if (!row) throw failure('VOICE_UPLOAD_NOT_FOUND', '本主体上传记录不存在', 404)
      return project(row)
    },
    async release(scope, resourceId) {
      identifier(resourceId)
      // Caller supplies an authenticated, confirmed deletion result. This is
      // only a capacity adjustment; original routing/audit records are retained.
      await pool.query(`UPDATE supply_voice_slots SET state='released',updated_at=? WHERE book=? AND resource_id=? AND ${owned} AND state='held'`, [now(), book, resourceId, ...fields(scope)])
    },
  }
}
