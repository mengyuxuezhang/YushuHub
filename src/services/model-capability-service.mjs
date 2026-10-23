import { randomUUID } from 'node:crypto'
import { normalizeTaskCapability } from './model-capabilities.mjs'
import { isSystemManagedModelId, SYSTEM_MANAGED_MODEL_IDS } from './image-generation.mjs'

const SYSTEM_MODEL_SQL = SYSTEM_MANAGED_MODEL_IDS.map(() => '?').join(',')

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function publicCapability(row) {
  return {
    id: row.id, organizationId: row.organization_id || '', providerModelId: row.provider_model_id,
    modelId: row.model_id || '', displayName: row.display_name || '', providerId: row.provider_id || '',
    taskType: row.task_type, protocolAdapter: row.protocol_adapter,
    upstreamAccountId: row.upstream_account_id || '', connectionRole: row.connection_role || '',
    endpointPath: row.endpoint_path || '', config: parseJson(row.config_json),
    configRevision: Number(row.config_revision || 1), status: row.status,
    isSystem: isSystemManagedModelId(row.provider_model_id),
  }
}

function normalizeEndpointConfig(descriptor, taskType, input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const allowed = descriptor.endpoints.filter(endpoint => endpoint.taskType === taskType)
  const output = {}
  for (const endpoint of allowed) {
    const value = String(source[endpoint.field] || endpoint.template || '').trim()
    if (!value.startsWith('/') || value.startsWith('//') || /[\\\s]/.test(value)) throw new Error(`${endpoint.field} 端点无效`)
    const placeholders = [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1])
    if (placeholders.some(name => name !== 'id')) throw new Error(`${endpoint.field} 包含不支持的端点变量`)
    output[endpoint.field] = value
  }
  return output
}

export class ModelCapabilityService {
  constructor(pool, manifest) { this.pool = pool; this.manifest = manifest }

  protocols() { return this.manifest.list() }

  async list({ organizationId = '', providerModelId = '', taskType = '' } = {}) {
    const where = [`(c.organization_id=? OR c.provider_model_id IN (${SYSTEM_MODEL_SQL}))`, 'm.archived_at IS NULL']
    const values = [organizationId, ...SYSTEM_MANAGED_MODEL_IDS]
    if (providerModelId) { where.push('c.provider_model_id=?'); values.push(providerModelId) }
    if (taskType) { where.push('c.task_type=?'); values.push(taskType) }
    const [rows] = await this.pool.query(`SELECT c.*,m.model_id,m.display_name,m.provider_id FROM ai_model_task_capabilities c
      JOIN ai_provider_models m ON m.id=c.provider_model_id WHERE ${where.join(' AND ')} ORDER BY m.sort_order,m.display_name,c.task_type`, values)
    return rows.map(publicCapability)
  }

  async save(input, organizationId = '') {
    const normalized = normalizeTaskCapability(input)
    const descriptor = this.manifest.resolve(normalized.protocolAdapter, normalized.taskType)
    const endpoints = normalizeEndpointConfig(descriptor, normalized.taskType, input.endpoints || { submit: normalized.endpointPath })
    const connectionRole = String(input.connectionRole || descriptor.connectionRole || '').trim().slice(0, 48)
    const accountId = String(input.upstreamAccountId || '').trim()
    if (descriptor.requiresCredential && !accountId) throw new Error('此协议必须绑定上游账号')
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [[model]] = await connection.query('SELECT * FROM ai_provider_models WHERE id=? AND archived_at IS NULL AND organization_id=? FOR UPDATE', [input.providerModelId, organizationId])
      if (!model) throw Object.assign(new Error('模型不存在或不属于当前组织'), { statusCode: 404 })
      if (accountId) {
        const [[account]] = await connection.query('SELECT id FROM ai_model_upstream_accounts WHERE id=? AND provider_id=? AND organization_id=? AND status=\'enabled\'', [accountId, model.provider_id, organizationId])
        if (!account) throw new Error('上游账号不存在、已停用或不属于此服务商')
      }
      const [[existing]] = await connection.query('SELECT * FROM ai_model_task_capabilities WHERE provider_model_id=? AND task_type=? FOR UPDATE', [model.id, normalized.taskType])
      const id = existing?.id || randomUUID()
      const revision = Number(existing?.config_revision || 0) + 1
      await connection.query(`INSERT INTO ai_model_task_capabilities
        (id,organization_id,provider_model_id,task_type,protocol_adapter,upstream_account_id,connection_role,endpoint_path,config_json,config_revision,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE protocol_adapter=VALUES(protocol_adapter),
        upstream_account_id=VALUES(upstream_account_id),connection_role=VALUES(connection_role),endpoint_path=VALUES(endpoint_path),
        config_json=VALUES(config_json),config_revision=VALUES(config_revision),status=VALUES(status)`,
      [id, organizationId, model.id, normalized.taskType, normalized.protocolAdapter, accountId || null, connectionRole,
        endpoints.submit || '', JSON.stringify({ endpoints, parameters: input.parameters && typeof input.parameters === 'object' ? input.parameters : {} }), revision, normalized.status])
      await connection.commit()
      return (await this.list({ organizationId, providerModelId: model.id, taskType: normalized.taskType }))[0]
    } catch (error) { await connection.rollback().catch(() => {}); throw error }
    finally { connection.release() }
  }

  async delete(id, organizationId = '') {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [[row]] = await connection.query(`SELECT c.*,m.id AS model_id FROM ai_model_task_capabilities c
        JOIN ai_provider_models m ON m.id=c.provider_model_id WHERE c.id=? AND m.archived_at IS NULL AND c.organization_id=? FOR UPDATE`, [id, organizationId])
      if (!row) throw Object.assign(new Error('模型能力不存在'), { statusCode: 404 })
      if (isSystemManagedModelId(row.model_id)) throw new Error('系统内置图片或音频能力不允许删除，只能编辑')
      const [[plans]] = await connection.query('SELECT COUNT(*) AS total FROM ai_model_pricing_plans WHERE capability_id=?', [id])
      const [[operations]] = await connection.query('SELECT COUNT(*) AS total FROM ai_model_operations WHERE capability_id=?', [id])
      if (Number(plans?.total || 0) || Number(operations?.total || 0)) throw new Error('该能力已绑定计费方案或任务，不能删除')
      await connection.query('DELETE FROM ai_model_task_capabilities WHERE id=?', [id])
      await connection.commit()
      return { id, deleted: true }
    } catch (error) { await connection.rollback().catch(() => {}); throw error }
    finally { connection.release() }
  }
}
