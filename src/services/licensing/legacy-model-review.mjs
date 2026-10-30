import { SYSTEM_MANAGED_MODEL_IDS } from '../image-generation.mjs'
import { decimal, failure, micros } from './protocol.mjs'
import { componentKey, publicSupplyPlan, validateSupplyPrice } from './pricing.mjs'
import { migrationHash } from './legacy-import.mjs'
import { verifyLegacyImportReceipt } from './local-legacy-binding.mjs'
import { collectMigrationProofs } from './migration-snapshot.mjs'
import { consumptionFactor } from './benefits.mjs'

const parse = value => typeof value === 'string' ? JSON.parse(value) : value
const reason = value => typeof value === 'string' && value.trim().length >= 3 && value.length <= 500
const supported = { chat: ['request', 'input_tokens', 'cached_tokens', 'output_tokens'], web_search: ['request'], image_generation: ['request', 'image'], speech_synthesis: ['request', 'billable_characters'] }
function sourceDecimal(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw failure('LEGACY_PRECISION_REVIEW_REQUIRED', '旧十进制字段须按原始文本核对')
  const normalized = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
  try { return decimal(micros(normalized)) } catch { throw failure('LEGACY_PRECISION_REVIEW_REQUIRED', '旧8位计价含无法以6位准确表示的值，须审核单位，禁止静默截断', 409) }
}
function dividePoints(points, conversion) {
  const numerator = micros(sourceDecimal(points)) * 1_000_000n, denominator = micros(conversion)
  if (denominator <= 0n || numerator < 0n) throw failure('INVALID_CONVERSION', '积分比例须为正，旧售价须非负')
  if (numerator % denominator) throw failure('NONREPRESENTABLE_CNY', '旧积分价按核定比例不能精确表示为6位人民币，须明确调整计量单位或核价，不能静默舍入', 409)
  return decimal(numerator / denominator)
}

// Return a review candidate, never install an offer or infer money from old
// cost-points metadata. These amounts preserve undiscounted component rates;
// legacy nearest rounding vs supply ceil rounding still needs usage shadowing.
export function legacyPriceProposal(plan, review) {
  if (!supported[plan.taskType]) throw failure('UNSUPPORTED_LEGACY_TASK', '旧任务类型尚无供货适配器，不得静默隐藏', 409)
  if (!reason(review?.conversionReview) || !reason(review?.costReview) || typeof review.pointsPerCny !== 'string') throw failure('PRICE_REVIEW_REQUIRED', '须分别审核积分兑换比例和真实人民币成本')
  if (micros(review.pointsPerCny) <= 0n) throw failure('INVALID_CONVERSION', '积分兑换比例须为正')
  const components = plan.components.filter(item => item.status === 'enabled').map(item => ({ meter: item.meter, phase: item.phase,
    dimensions: item.dimensions || {}, unitSize: sourceDecimal(item.unitSize), rounding: item.rounding, minimumUnits: sourceDecimal(item.minimumUnits || '0'),
    amount: dividePoints(item.salePoints, review.pointsPerCny) }))
  if (!components.length || components.some(item => !supported[plan.taskType].includes(item.meter) || item.phase !== (item.meter === 'request' ? 'request' : 'usage'))) throw failure('UNSUPPORTED_LEGACY_METER', '旧预览/激活或其他计量项须先适配，不能丢弃', 409)
  // Old text plans without a cache component charge cached input at the normal
  // input rate. The new adapter separates both events; preserve that rate.
  if (plan.taskType === 'chat' && !components.some(item => item.meter === 'cached_tokens')) {
    const input = components.filter(item => item.meter === 'input_tokens')
    components.push(...input.map(item => ({ ...item, meter: 'cached_tokens' })))
  }
  for (const meter of supported[plan.taskType]) if (!components.some(item => item.meter === meter)) components.push({ meter,
    phase: meter === 'request' ? 'request' : 'usage', unitSize: ['input_tokens', 'cached_tokens', 'output_tokens'].includes(meter) ? '1000000' : '1', rounding: 'none', minimumUnits: '0', amount: '0.000000' })
  const sale = publicSupplyPlan(validateSupplyPrice({ version: 1, currency: 'CNY', components })), cost = publicSupplyPlan(validateSupplyPrice({ version: 1, currency: 'CNY', components: review.costComponents }))
  const structure = items => items.map(item => [componentKey(item), decimal(micros(item.unitSize)), item.rounding, decimal(micros(item.minimumUnits || '0'))]).sort(([a], [b]) => a.localeCompare(b))
  if (migrationHash(structure(cost.components)) !== migrationHash(structure(sale.components))) throw failure('COST_METER_MISMATCH', '成本须显式覆盖与迁入售价相同的全部计量结构')
  return { providerModelId: plan.providerModelId, sourcePlanId: plan.id, taskType: plan.taskType, pointsPerCny: decimal(micros(review.pointsPerCny)),
    consumptionMultiplier: consumptionFactor(plan.consumptionMultiplier), sale, supplierCost: cost,
    zeroBase: { ...sale, components: sale.components.map(item => ({ ...item, amount: '0.000000' })) },
    saleMarkup: sale.components.map(({ meter, phase, dimensions, amount }) => ({ meter, phase, dimensions, amount })),
    conversionReview: review.conversionReview.trim(), costReview: review.costReview.trim(),
    requiresUsageShadow: true, adapterNotValidated: true, roundingReview: '旧方案逐项四舍五入；新供货逐项向上取6位、再换算积分，须核对边界用量及会员优惠，不保证微积分尾差相等。' }
}

export async function reviewLegacyModels(connection, { snapshot, mapping, result, publicKeys, reviews = [] }) {
  const claims = verifyLegacyImportReceipt(result, { snapshot, mapping, publicKeys })
  if (!Array.isArray(reviews) || reviews.some(row => !row || typeof row.sourcePlanId !== 'string') || new Set(reviews.map(row => row.sourcePlanId)).size !== reviews.length) throw failure('DUPLICATE_PRICE_REVIEW', '价格审核应按原方案ID唯一列出')
  const proofs = await collectMigrationProofs(connection)
  if (!snapshot.proofs.modelRouting) throw failure('MODEL_ROUTING_PROOF_REQUIRED', '原快照缺少模型连接/绑定摘要，须从受控源重新采集并审核，不能假定模型身份不变', 409)
  if (['modelPrices', 'modelRouting'].some(group => migrationHash(proofs[group]) !== migrationHash(snapshot.proofs[group]))) throw failure('SOURCE_CHANGED', '原模型、路由、绑定、价格或汇率已变化，须重新核对', 409)
  const oldId = snapshot.organizations[0].id
  const [models] = await connection.query(`SELECT m.id,m.model_id AS clientId,m.model_type AS modelType,m.status,m.organization_id AS organizationId,m.archived_at AS archivedAt,
    p.organization_id AS providerOrganizationId,p.status AS providerStatus FROM ai_provider_models m JOIN ai_model_providers p ON p.id=m.provider_id
    WHERE m.organization_id=? OR m.id IN (?) ORDER BY m.id`, [oldId, SYSTEM_MANAGED_MODEL_IDS])
  const [capabilities] = await connection.query('SELECT id,provider_model_id AS modelId,task_type AS taskType,status,organization_id AS organizationId FROM ai_model_task_capabilities ORDER BY id')
  const [plans] = await connection.query(`SELECT id,provider_model_id AS providerModelId,capability_id AS capabilityId,task_type AS taskType,status,organization_id AS organizationId,
    CAST(version AS CHAR) AS version,CAST(consumption_multiplier AS CHAR) AS consumptionMultiplier,CAST(effective_at AS CHAR) AS effectiveAt
    FROM ai_model_pricing_plans ORDER BY version DESC,id`)
  const [raw] = await connection.query(`SELECT plan_id AS planId,meter_code AS meter,charge_phase AS phase,CAST(unit_size AS CHAR) AS unitSize,
    CAST(minimum_units AS CHAR) AS minimumUnits,rounding_mode AS rounding,dimensions_json AS dimensions,CAST(sale_points AS CHAR) AS salePoints,
    CAST(cost_amount AS CHAR) AS costAmount,cost_currency AS costCurrency,metadata_json AS metadata,status FROM ai_model_pricing_components ORDER BY sort_order,id`)
  const components = raw.map(({ metadata, ...row }) => ({ ...row, dimensions: parse(row.dimensions) || {}, legacyCostPlaceholder: parse(metadata)?.migration === 'legacy_cost_points' }))
  const report = [], blockers = [], used = new Set()
  for (const model of models) {
    if (model.archivedAt || model.status !== 'enabled' || model.providerStatus !== 'enabled') { report.push({ ...model, action: 'preserve-disabled' }); continue }
    const active = capabilities.filter(cap => cap.modelId === model.id && cap.status === 'enabled' && (cap.organizationId === oldId || SYSTEM_MANAGED_MODEL_IDS.includes(model.id)))
    if (!active.length) blockers.push({ modelId: model.id, code: 'MISSING_ACTIVE_CAPABILITY' })
    for (const capability of active) {
      const candidates = plans.filter(plan => plan.capabilityId === capability.id && plan.status === 'enabled'
        && (plan.organizationId === oldId || (plan.organizationId === '' && SYSTEM_MANAGED_MODEL_IDS.includes(model.id)))
        && (!plan.effectiveAt || Date.parse(plan.effectiveAt.replace(' ', 'T') + 'Z') <= snapshot.capturedAt))
      candidates.sort((a, b) => Number(b.organizationId === oldId) - Number(a.organizationId === oldId) || Number(b.version) - Number(a.version))
      const selected = candidates[0]
      const row = { modelId: model.id, clientId: model.clientId, taskType: capability.taskType, sourcePlanId: selected?.id || null, action: 'review-required' }
      report.push(row)
      if (!selected) { blockers.push({ ...row, code: 'MISSING_ACTIVE_PLAN' }); continue }
      const plan = { ...selected, components: components.filter(item => item.planId === selected.id) }
      row.sourcePlan = plan
      if (!supported[capability.taskType]) { blockers.push({ ...row, sourcePlan: undefined, code: 'UNSUPPORTED_LEGACY_TASK' }); continue }
      if (result.grant.modelMode !== 'custom' || model.organizationId !== oldId || model.providerOrganizationId !== oldId) {
        blockers.push({ ...row, sourcePlan: undefined, code: 'OFFICIAL_MODEL_MAPPING_REQUIRED' }); continue
      }
      const review = reviews.find(item => item.sourcePlanId === plan.id)
      if (!review) { blockers.push({ ...row, sourcePlan: undefined, code: 'PRICE_REVIEW_REQUIRED' }); continue }
      used.add(review.sourcePlanId)
      try { row.proposal = legacyPriceProposal(plan, review); row.action = 'candidate-awaiting-runtime-shadow' }
      catch (error) { blockers.push({ ...row, sourcePlan: undefined, code: error.code || 'INVALID_PRICE_REVIEW' }) }
    }
  }
  for (const review of reviews) if (!used.has(review.sourcePlanId)) blockers.push({ sourcePlanId: review.sourcePlanId, code: 'UNMATCHED_PRICE_REVIEW' })
  return { schemaVersion: 1, batchId: claims.batchId, grantId: claims.grantId, snapshotHash: claims.snapshotHash, sourceModelCount: models.length,
    models: report, blockers, previewDigest: migrationHash({ report, blockers, snapshotHash: claims.snapshotHash }), databaseChanged: false,
    cutoverReady: false, remainingChecks: ['review-and-install-definitions-offers', 'usage-rounding-benefit-shadow', 'single-writer-switch', 'rollback-rehearsal', 'seven-day-pilot'] }
}
