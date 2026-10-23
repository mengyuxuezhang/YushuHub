import { createHash, randomUUID } from 'node:crypto'
import { normalizePricingPlan } from './compound-pricing.mjs'
import { normalizeTaskCapability } from './model-capabilities.mjs'
import { validatePricingForTask } from './pricing-plans.mjs'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const parse = (value, fallback = {}) => { if (value && typeof value === 'object') return value; try { return JSON.parse(String(value || '')) } catch { return fallback } }

// Accept older centers while keeping one quote per capability locally.
export function currentPricingPlans(plans) {
  const current = new Map()
  for (const item of plans) {
    const previous = current.get(item.capabilityId)
    if (!previous || (item.status === 'enabled' && previous.status !== 'enabled')
      || ((item.status === 'enabled') === (previous.status === 'enabled')
        && (Number(item.version) > Number(previous.version)
          || (Number(item.version) === Number(previous.version) && String(item.id) > String(previous.id))))) current.set(item.capabilityId, item)
  }
  return [...current.values()]
}

export class ModelServiceV2Sync {
  constructor(pool, manifest) { this.pool = pool; this.manifest = manifest }

  async exportPacket() {
    const [capabilities] = await this.pool.query(`SELECT id,provider_model_id,task_type,protocol_adapter,connection_role,endpoint_path,config_json,config_revision,status
      FROM ai_model_task_capabilities WHERE provider_model_id IN (SELECT id FROM ai_provider_models WHERE archived_at IS NULL) ORDER BY provider_model_id,task_type`)
    const [plans] = await this.pool.query(`SELECT id,provider_model_id,capability_id,task_type,version,status,consumption_multiplier,effective_at FROM ai_model_pricing_plans
      WHERE status IN ('enabled','draft') AND provider_model_id IN (SELECT id FROM ai_provider_models WHERE archived_at IS NULL) ORDER BY capability_id,version`)
    const [components] = plans.length ? await this.pool.query(`SELECT id,plan_id,meter_code,charge_phase,unit_size,minimum_units,rounding_mode,dimensions_json,
      cost_amount,cost_currency,sale_points,metadata_json,status,sort_order FROM ai_model_pricing_components WHERE plan_id IN (?) ORDER BY plan_id,sort_order,id`, [plans.map(item => item.id)]) : [[]]
    const packet = {
      schemaVersion: 2,
      capabilities: capabilities.map(row => ({ id: row.id, providerModelId: row.provider_model_id, taskType: row.task_type, protocolAdapter: row.protocol_adapter,
        connectionRole: row.connection_role || '', endpointPath: row.endpoint_path || '', config: parse(row.config_json), configRevision: Number(row.config_revision || 1), status: row.status })),
      pricingPlans: plans.map(row => ({ id: row.id, providerModelId: row.provider_model_id, capabilityId: row.capability_id, taskType: row.task_type,
        version: Number(row.version), status: row.status, consumptionMultiplier: Number(row.consumption_multiplier ?? 1), effectiveAt: row.effective_at,
        components: components.filter(item => item.plan_id === row.id).map(item => ({ id: item.id, meter: item.meter_code, phase: item.charge_phase,
          unitSize: Number(item.unit_size), minimumUnits: Number(item.minimum_units), rounding: item.rounding_mode, dimensions: parse(item.dimensions_json),
          costAmount: Number(item.cost_amount), costCurrency: item.cost_currency, salePoints: Number(item.sale_points), metadata: parse(item.metadata_json), status: item.status, sortOrder: Number(item.sort_order) })) })),
    }
    return { ...packet, revision: digest(packet) }
  }

  async apply(packet) {
    if (!packet || Number(packet.schemaVersion) !== 2 || !Array.isArray(packet.capabilities) || !Array.isArray(packet.pricingPlans)) throw new Error('模型服务 V2 数据包无效')
    const expectedRevision = digest({ schemaVersion: 2, capabilities: packet.capabilities, pricingPlans: packet.pricingPlans })
    if (packet.revision && packet.revision !== expectedRevision) throw new Error('模型服务 V2 数据包校验失败')
    const capabilities = packet.capabilities.map(item => ({ ...normalizeTaskCapability(item), ...item }))
    for (const item of capabilities) this.manifest.resolve(item.protocolAdapter, item.taskType)
    const plans = currentPricingPlans(packet.pricingPlans).map(item => ({ source: item, normalized: validatePricingForTask(normalizePricingPlan(item)) }))
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const capabilityIds = new Map()
      const archivedCapabilities = new Set()
      for (const item of capabilities) {
        const [[model]] = await connection.query('SELECT id,organization_id,archived_at FROM ai_provider_models WHERE id=? FOR UPDATE', [item.providerModelId])
        if (!model) throw new Error(`V2 能力引用的模型不存在：${item.providerModelId}`)
        if (model.archived_at) { archivedCapabilities.add(String(item.id)); continue }
        const descriptor = this.manifest.resolve(item.protocolAdapter, item.taskType)
        const [[existing]] = await connection.query('SELECT id,upstream_account_id FROM ai_model_task_capabilities WHERE provider_model_id=? AND task_type=? FOR UPDATE', [model.id, item.taskType])
        const id = existing?.id || String(item.id || randomUUID())
        if (descriptor.requiresCredential && !existing?.upstream_account_id) item.status = 'disabled'
        await connection.query(`INSERT INTO ai_model_task_capabilities
          (id,organization_id,provider_model_id,task_type,protocol_adapter,connection_role,endpoint_path,config_json,config_revision,status)
          VALUES (?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE protocol_adapter=VALUES(protocol_adapter),connection_role=VALUES(connection_role),
          endpoint_path=VALUES(endpoint_path),config_json=VALUES(config_json),config_revision=GREATEST(config_revision,VALUES(config_revision)),status=VALUES(status)`,
        [id, model.organization_id || '', model.id, item.taskType, item.protocolAdapter, String(item.connectionRole || '').slice(0, 48), String(item.endpointPath || '').slice(0, 255),
          JSON.stringify(item.config || {}), Number(item.configRevision || 1), item.status === 'disabled' ? 'disabled' : 'enabled'])
        capabilityIds.set(String(item.id), id)
      }
      const incomingPlanIds = []
      for (const { source, normalized } of plans) {
        if (archivedCapabilities.has(String(source.capabilityId))) continue
        const localCapabilityId = capabilityIds.get(String(source.capabilityId))
        if (!localCapabilityId) throw new Error(`V2 计费方案引用的能力不存在：${source.capabilityId}`)
        const [[capability]] = await connection.query('SELECT organization_id,provider_model_id,task_type FROM ai_model_task_capabilities WHERE id=?', [localCapabilityId])
        if (!capability || capability.task_type !== normalized.taskType || capability.provider_model_id !== source.providerModelId) throw new Error('V2 计费方案与任务能力不匹配')
        const [[existingPlan]] = await connection.query('SELECT id,sync_source FROM ai_model_pricing_plans WHERE capability_id=? AND organization_id=? FOR UPDATE', [localCapabilityId, capability.organization_id || ''])
        if (existingPlan && existingPlan.sync_source !== 'center') throw new Error(`V2 计费方案与本地方案冲突：${source.providerModelId}`)
        const id = existingPlan?.id || String(source.id || randomUUID())
        incomingPlanIds.push(id)
        const hash = digest(source)
        await connection.query(`INSERT INTO ai_model_pricing_plans
          (id,organization_id,provider_model_id,capability_id,task_type,version,status,consumption_multiplier,effective_at,sync_source,center_sync_hash)
          VALUES (?,?,?,?,?,?,?,?,?, 'center',?) ON DUPLICATE KEY UPDATE status=VALUES(status),consumption_multiplier=VALUES(consumption_multiplier),effective_at=VALUES(effective_at),center_sync_hash=VALUES(center_sync_hash)`,
        [id, capability.organization_id || '', source.providerModelId, localCapabilityId, normalized.taskType, normalized.version, normalized.status, normalized.consumptionMultiplier, source.effectiveAt || null, hash])
        if (normalized.status === 'enabled') await connection.query("UPDATE ai_model_pricing_plans SET status='disabled' WHERE capability_id=? AND id<>? AND status='enabled'", [localCapabilityId, id])
        await connection.query('DELETE FROM ai_model_pricing_components WHERE plan_id=?', [id])
        for (const [index, component] of normalized.components.entries()) await connection.query(`INSERT INTO ai_model_pricing_components
          (id,plan_id,meter_code,charge_phase,unit_size,minimum_units,rounding_mode,dimensions_json,cost_amount,cost_currency,sale_points,metadata_json,status,sort_order)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [source.components?.[index]?.id || randomUUID(), id, component.meter, component.phase, component.unitSize,
          component.minimumUnits, component.rounding, JSON.stringify(component.dimensions), component.costAmount, component.costCurrency, component.salePoints,
          JSON.stringify(source.components?.[index]?.metadata || {}), component.status, Number(source.components?.[index]?.sortOrder ?? index * 10)])
      }
      if (incomingPlanIds.length) await connection.query("UPDATE ai_model_pricing_plans SET status='disabled' WHERE sync_source='center' AND id NOT IN (?)", [incomingPlanIds])
      else await connection.query("UPDATE ai_model_pricing_plans SET status='disabled' WHERE sync_source='center'")
      await connection.commit()
      return { schemaVersion: 2, revision: String(packet.revision || expectedRevision), capabilities: capabilities.length, pricingPlans: plans.length }
    } catch (error) { await connection.rollback().catch(() => {}); throw error }
    finally { connection.release() }
  }
}
