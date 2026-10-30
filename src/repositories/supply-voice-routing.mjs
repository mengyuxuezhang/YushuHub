import { digest, failure, identifier } from '../services/licensing/protocol.mjs'

export const SUPPLY_VOICE_ROUTING_SCHEMA = `CREATE TABLE IF NOT EXISTS supply_voice_routing (
  book VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,kind VARCHAR(16) NOT NULL,
  id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,resource_id VARCHAR(64) NOT NULL,
  root_id VARCHAR(120) NOT NULL,organization_id VARCHAR(120) NOT NULL,subject_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model_id VARCHAR(120) NOT NULL,source VARCHAR(16) NOT NULL,model_snapshot JSON NOT NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,created_at BIGINT NOT NULL,
  PRIMARY KEY(book,kind,id),KEY scoped_models(book,root_id,organization_id,subject_hash,model_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`
const parse = value => typeof value === 'string' ? JSON.parse(value) : value
const fields = scope => {
  for (const key of ['rootId', 'organizationId']) identifier(scope?.[key])
  if (!/^[a-f0-9]{64}$/.test(scope.subjectHash || '')) throw failure('VOICE_SUBJECT_REQUIRED', '须绑定已认证终端主体', 403)
  return [scope.rootId, scope.organizationId, scope.subjectHash]
}
const owned = 'root_id=? AND organization_id=? AND subject_hash=?'
const project = row => ({ resourceId: row.resource_id, model: parse(row.model_snapshot), createdAt: Number(row.created_at) })
export function supplyVoiceRouting({ pool, book, now = Date.now }) {
  identifier(book)
  const api = {
    async assertReady() { await pool.query('SELECT 1 FROM supply_voice_routing LIMIT 0') },
    async remember(scope, resourceId, model, { deleteRequestId, uploadRequestId } = {}) {
      const scopeFields = fields(scope); identifier(resourceId); identifier(model.id)
      if (!['official', 'custom'].includes(model.source) || model.adapter !== 'minimax.private_voice' || !Number.isSafeInteger(model.version)) throw failure('VOICE_ROUTE_INVALID', '音色必须绑定已核定的供货模型')
      const snapshot = Object.fromEntries(['id', 'source', 'version', 'adapter', 'clientId', 'definitionSource', 'providerModelId', 'bindingHash'].filter(key => model[key] !== undefined).map(key => [key, model[key]]))
      const kind = deleteRequestId ? 'delete' : 'resource', id = identifier(deleteRequestId || resourceId)
      if (id.length > 80 || resourceId.length > 64) throw failure('VOICE_ROUTE_INVALID', '音色路由编号无效')
      const fingerprint = digest(JSON.stringify([scopeFields, resourceId, snapshot])), connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        await connection.query('INSERT INTO supply_voice_routing(book,kind,id,resource_id,root_id,organization_id,subject_hash,model_id,source,model_snapshot,fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=VALUES(id)',
          [book, kind, id, resourceId, ...scopeFields, model.id, model.source, JSON.stringify(snapshot), fingerprint, now()])
        const [[row]] = await connection.query('SELECT * FROM supply_voice_routing WHERE book=? AND kind=? AND id=? FOR UPDATE', [book, kind, id])
        const sameResource = kind === 'resource' && row.resource_id === resourceId && row.model_id === model.id && row.source === model.source
          && row.root_id === scope.rootId && row.organization_id === scope.organizationId && row.subject_hash === scope.subjectHash
        if (row.fingerprint !== fingerprint && !sameResource) throw failure('IDEMPOTENCY_CONFLICT', '音色或删除编号已绑定其他原始路由', 409)
        if (uploadRequestId) {
          const [[slot]] = await connection.query(`SELECT * FROM supply_voice_slots WHERE book=? AND id=? AND ${owned} FOR UPDATE`, [book, identifier(uploadRequestId), ...scopeFields])
          if (!slot || slot.state !== 'held' || slot.model_id !== model.id || slot.source !== model.source || (slot.resource_id && slot.resource_id !== resourceId)) throw failure('VOICE_UPLOAD_CLOSED', '原上传额度与资源绑定不匹配', 409)
          await connection.query('UPDATE supply_voice_slots SET resource_id=?,updated_at=? WHERE book=? AND id=?', [resourceId, now(), book, uploadRequestId])
        }
        await connection.commit(); return project(row)
      } catch (error) { await connection.rollback().catch(() => {}); throw error } finally { connection.release() }
    },
    async find(scope, id, kind = 'resource') {
      if (!['resource', 'delete'].includes(kind)) throw failure('VOICE_ROUTE_INVALID', '音色路由类型无效')
      const [[row]] = await pool.query(`SELECT * FROM supply_voice_routing WHERE book=? AND kind=? AND id=? AND ${owned}`, [book, kind, identifier(id), ...fields(scope)])
      if (!row) throw failure('VOICE_NOT_FOUND', '本主体音色路由不存在', 404)
      return project(row)
    },
    async models(scope) {
      const [rows] = await pool.query(`SELECT model_id,source FROM supply_voice_routing WHERE book=? AND kind='resource' AND ${owned} GROUP BY model_id,source LIMIT 1001`, [book, ...fields(scope)])
      if (rows.length > 1000) throw failure('VOICE_HISTORY_LIMIT', '历史模型范围过大，需分批核对', 409)
      return rows.map(row => ({ id: row.model_id, source: row.source }))
    },
  }
  return api
}
