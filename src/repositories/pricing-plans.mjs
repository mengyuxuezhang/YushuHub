import { randomUUID } from 'node:crypto'
import { isSystemManagedModelId, SYSTEM_MANAGED_MODEL_IDS } from '../services/image-generation.mjs'
import { normalizeConsumptionMultiplier } from '../services/model-pricing.mjs'

const SYSTEM_MODEL_SQL = SYSTEM_MANAGED_MODEL_IDS.map(() => '?').join(',')
const systemScope = (organizationId, organizationColumn = 'p.organization_id', modelColumn = 'p.provider_model_id') => ({
  clause: `(${organizationColumn}=? OR ${modelColumn} IN (${SYSTEM_MODEL_SQL}))`,
  values: [organizationId, ...SYSTEM_MANAGED_MODEL_IDS],
})

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function componentRow(row) {
  return {
    id: row.id,
    meter: row.meter_code,
    phase: row.charge_phase,
    unitSize: Number(row.unit_size),
    minimumUnits: Number(row.minimum_units),
    rounding: row.rounding_mode,
    dimensions: parseJson(row.dimensions_json),
    costAmount: Number(row.cost_amount),
    costCurrency: row.cost_currency,
    salePoints: Number(row.sale_points),
    metadata: parseJson(row.metadata_json),
    status: row.status,
    consumptionMultiplier: Number(row.consumption_multiplier ?? 1),
    sortOrder: Number(row.sort_order || 0),
  }
}

function planRow(row, components = []) {
  return {
    id: row.id,
    organizationId: row.organization_id || '',
    providerId: row.provider_id || '',
    providerName: row.provider_name || '',
    providerModelId: row.provider_model_id,
    modelId: row.model_id || '',
    displayName: row.display_name || '',
    capabilityId: row.capability_id,
    taskType: row.task_type,
    version: Number(row.version),
    status: row.status,
    consumptionMultiplier: normalizeConsumptionMultiplier(row.consumption_multiplier, 1),
    effectiveAt: row.effective_at,
    isProtected: row.sync_source === 'center' || isSystemManagedModelId(row.provider_model_id),
    components,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class PricingPlanRepository {
  constructor(pool) { this.pool = pool }

  async list({ organizationId = '', taskType = '', providerId = '' } = {}) {
    const scope = systemScope(organizationId)
    const where = [scope.clause, 'm.archived_at IS NULL']
    const values = [...scope.values]
    if (taskType) { where.push('p.task_type=?'); values.push(taskType) }
    if (providerId) { where.push('m.provider_id=?'); values.push(providerId) }
    const [plans] = await this.pool.query(`SELECT p.*,m.model_id,m.display_name,m.provider_id,v.name AS provider_name
      FROM ai_model_pricing_plans p JOIN ai_provider_models m ON m.id=p.provider_model_id
      JOIN ai_model_providers v ON v.id=m.provider_id WHERE ${where.join(' AND ')}
      ORDER BY p.task_type,m.sort_order,m.display_name,p.version DESC`, values)
    if (!plans.length) return []
    const [components] = await this.pool.query('SELECT * FROM ai_model_pricing_components WHERE plan_id IN (?) ORDER BY sort_order,id', [plans.map(row => row.id)])
    const grouped = new Map()
    for (const row of components) grouped.set(row.plan_id, [...(grouped.get(row.plan_id) || []), row])
    return plans.map(row => planRow(row, (grouped.get(row.id) || []).map(componentRow)))
  }

  async find(id, organizationId = '') {
    const scope = systemScope(organizationId)
    const [rows] = await this.pool.query(`SELECT p.*,m.model_id,m.display_name,m.provider_id,v.name AS provider_name
      FROM ai_model_pricing_plans p JOIN ai_provider_models m ON m.id=p.provider_model_id
      JOIN ai_model_providers v ON v.id=m.provider_id WHERE p.id=? AND m.archived_at IS NULL AND ${scope.clause} LIMIT 1`, [id, ...scope.values])
    if (!rows[0]) return null
    const [components] = await this.pool.query('SELECT * FROM ai_model_pricing_components WHERE plan_id=? ORDER BY sort_order,id', [id])
    return planRow(rows[0], components.map(componentRow))
  }

  async findActiveByCapability(capabilityId, organizationId = '') {
    const [rows] = await this.pool.query(`SELECT id FROM ai_model_pricing_plans
      WHERE capability_id=? AND (organization_id=? OR (organization_id='' AND provider_model_id IN (${SYSTEM_MODEL_SQL})))
        AND status='enabled' AND (effective_at IS NULL OR effective_at<=CURRENT_TIMESTAMP(3))
      ORDER BY (organization_id=?) DESC,version DESC LIMIT 1`, [capabilityId, organizationId, ...SYSTEM_MANAGED_MODEL_IDS, organizationId])
    return rows[0] ? this.find(rows[0].id, organizationId) : null
  }

  async save(input, normalized, organizationId = '') {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const scope = systemScope(organizationId, 'c.organization_id', 'c.provider_model_id')
      const [[capability]] = await connection.query(`SELECT c.*,m.provider_id FROM ai_model_task_capabilities c
        JOIN ai_provider_models m ON m.id=c.provider_model_id WHERE c.id=? AND m.archived_at IS NULL AND ${scope.clause} FOR UPDATE`, [input.capabilityId, ...scope.values])
      if (!capability || capability.task_type !== normalized.taskType) throw Object.assign(new Error('模型能力不存在或任务类型不匹配'), { statusCode: 404 })
      const planOrganizationId = isSystemManagedModelId(capability.provider_model_id) ? '' : organizationId
      const sourcePlanId = String(input.sourcePlanId || '').trim()
      const [[current]] = await connection.query('SELECT id FROM ai_model_pricing_plans WHERE capability_id=? AND organization_id=? FOR UPDATE', [capability.id, planOrganizationId])
      if (sourcePlanId && current?.id !== sourcePlanId) throw Object.assign(new Error('待编辑的计费方案不存在'), { statusCode: 404 })
      let id = sourcePlanId || current?.id
      if (id) {
        const [[existing]] = await connection.query(`SELECT id FROM ai_model_pricing_plans
          WHERE id=? AND capability_id=? AND organization_id=? FOR UPDATE`, [id, capability.id, planOrganizationId])
        if (!existing) throw Object.assign(new Error('待编辑的计费方案不存在或不属于当前模型能力'), { statusCode: 404 })
        if (normalized.status === 'enabled') await connection.query("UPDATE ai_model_pricing_plans SET status='disabled' WHERE capability_id=? AND organization_id=? AND id<>? AND status='enabled'", [capability.id, planOrganizationId, id])
        await connection.query(`UPDATE ai_model_pricing_plans SET status=?,consumption_multiplier=?,effective_at=? WHERE id=?`,
          [normalized.status, normalized.consumptionMultiplier, input.effectiveAt || null, id])
        await connection.query('DELETE FROM ai_model_pricing_components WHERE plan_id=?', [id])
      } else {
        id = randomUUID()
        const version = 1
        if (normalized.status === 'enabled') await connection.query("UPDATE ai_model_pricing_plans SET status='disabled' WHERE capability_id=? AND organization_id=? AND status='enabled'", [capability.id, planOrganizationId])
        await connection.query(`INSERT INTO ai_model_pricing_plans
          (id,organization_id,provider_model_id,capability_id,task_type,version,status,consumption_multiplier,effective_at)
          VALUES (?,?,?,?,?,?,?,?,?)`, [id, planOrganizationId, capability.provider_model_id, capability.id, normalized.taskType, version, normalized.status, normalized.consumptionMultiplier, input.effectiveAt || null])
      }
      for (const [index, item] of normalized.components.entries()) {
        await connection.query(`INSERT INTO ai_model_pricing_components
          (id,plan_id,meter_code,charge_phase,unit_size,minimum_units,rounding_mode,dimensions_json,cost_amount,cost_currency,sale_points,metadata_json,status,sort_order)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [randomUUID(), id, item.meter, item.phase, item.unitSize, item.minimumUnits, item.rounding,
          JSON.stringify(item.dimensions), item.costAmount, item.costCurrency, item.salePoints, JSON.stringify(input.components?.[index]?.metadata || {}), item.status, index * 10])
      }
      await connection.commit()
      return this.find(id, organizationId)
    } catch (error) {
      await connection.rollback().catch(() => {})
      throw error
    } finally { connection.release() }
  }

  async setStatus(id, status, organizationId = '') {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const scope = systemScope(organizationId)
      const [[row]] = await connection.query(`SELECT p.* FROM ai_model_pricing_plans p JOIN ai_provider_models m ON m.id=p.provider_model_id WHERE p.id=? AND m.archived_at IS NULL AND ${scope.clause} FOR UPDATE`, [id, ...scope.values])
      if (!row) throw Object.assign(new Error('计费方案不存在'), { statusCode: 404 })
      if (status === 'enabled') await connection.query("UPDATE ai_model_pricing_plans SET status='disabled' WHERE capability_id=? AND organization_id=? AND status='enabled'", [row.capability_id, row.organization_id || ''])
      await connection.query('UPDATE ai_model_pricing_plans SET status=? WHERE id=?', [status, id])
      await connection.commit()
      return this.find(id, organizationId)
    } catch (error) { await connection.rollback().catch(() => {}); throw error }
    finally { connection.release() }
  }

  async delete(id, organizationId = '') {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const scope = systemScope(organizationId)
      const [[row]] = await connection.query(`SELECT p.*,m.model_type FROM ai_model_pricing_plans p
        JOIN ai_provider_models m ON m.id=p.provider_model_id WHERE p.id=? AND m.archived_at IS NULL AND ${scope.clause} FOR UPDATE`, [id, ...scope.values])
      if (!row) throw Object.assign(new Error('计费方案不存在'), { statusCode: 404 })
      if (row.status === 'enabled') throw new Error('生效中的计费方案不能删除，请先停用')
      if (row.sync_source === 'center' || isSystemManagedModelId(row.provider_model_id)) {
        throw new Error('系统内置图片或音频计费方案不允许删除，可直接编辑报价')
      }
      const [[usage]] = await connection.query(`SELECT COUNT(*) AS total FROM ai_model_operations
        WHERE capability_id=? AND JSON_UNQUOTE(JSON_EXTRACT(pricing_snapshot_json,'$.plan.id'))=?`, [row.capability_id, id])
      if (Number(usage?.total || 0)) throw new Error('该计费方案已有结算记录，为保证审计完整不能删除')
      await connection.query('DELETE FROM ai_model_pricing_plans WHERE id=?', [id])
      await connection.commit()
      return { id, deleted: true }
    } catch (error) { await connection.rollback().catch(() => {}); throw error }
    finally { connection.release() }
  }

  async rates(organizationId = '') {
    const [rows] = await this.pool.query('SELECT currency,cny_rate,updated_at FROM ai_currency_exchange_rates WHERE organization_id=? ORDER BY currency', [organizationId])
    return rows.map(row => ({ currency: row.currency, cnyRate: Number(row.cny_rate), updatedAt: row.updated_at }))
  }

  async saveRate(currency, cnyRate, actorId, organizationId = '') {
    await this.pool.query(`INSERT INTO ai_currency_exchange_rates (organization_id,currency,cny_rate,updated_by) VALUES (?,?,?,?)
      ON DUPLICATE KEY UPDATE cny_rate=VALUES(cny_rate),updated_by=VALUES(updated_by)`, [organizationId, currency, cnyRate, actorId])
    return this.rates(organizationId)
  }
}
