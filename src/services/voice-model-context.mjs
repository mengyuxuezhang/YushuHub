import { selectEligibleModelKeys } from './model-key-scope.mjs'
import { ModelAdapterRegistry } from './model-capabilities.mjs'
import { MiniMaxAdapter } from './minimax-adapter.mjs'
import { voicePricingSummary } from './compound-pricing.mjs'

const error = (message, code = 'VOICE_MODEL_UNAVAILABLE', statusCode = 409) => Object.assign(new Error(message), { code, statusCode })

export class VoiceModelContext {
  constructor({ pool, vault, allowedModels, pricingPlans = null, adapter = new MiniMaxAdapter() }) {
    this.pool = pool
    this.vault = vault
    this.allowedModels = allowedModels
    this.pricingPlans = pricingPlans
    this.registry = new ModelAdapterRegistry().register('minimax.t2a', 'speech_synthesis', adapter)
  }
  async models(user) {
    if (!user?.id || !user.organizationId) throw error('账号不可用', 'VOICE_AUTH_REQUIRED', 403)
    const allowed = await this.allowedModels(user.id)
    const [rows] = await this.pool.query(`SELECT m.id,m.model_id,m.display_name,c.id AS capability_id,c.protocol_adapter,c.endpoint_path,c.status,
      r.voice_preview_points,r.voice_activation_points,r.voice_points_per_1k_chars
      FROM ai_provider_models m JOIN ai_model_providers p ON p.id=m.provider_id
      JOIN ai_model_task_capabilities c ON c.provider_model_id=m.id AND c.task_type='speech_synthesis'
      LEFT JOIN ai_model_pricing_rules r ON r.provider_model_id=m.id AND r.status='enabled'
      WHERE m.organization_id=? AND p.organization_id=? AND c.organization_id=?
      AND m.status='enabled' AND p.status='enabled' AND c.status='enabled'`,
    [user.organizationId, user.organizationId, user.organizationId])
    return Promise.all(rows.filter(row => (!allowed || allowed.has(row.id)) && row.protocol_adapter === 'minimax.t2a').map(async row => {
      const plan = this.pricingPlans ? await this.pricingPlans.findActiveByCapability(row.capability_id, user.organizationId) : null
      const summary = plan ? voicePricingSummary(plan) : { preview: row.voice_preview_points == null ? null : Number(row.voice_preview_points), activation: row.voice_activation_points == null ? null : Number(row.voice_activation_points), per1000Characters: row.voice_points_per_1k_chars == null ? null : Number(row.voice_points_per_1k_chars) }
      return { id: row.id, name: row.display_name, task: 'speech_synthesis', parameters: { speed: { min: 0.5, max: 2 }, maxCharacters: 10000 }, prices: { ...summary, previewPer1000Characters: plan && summary.preview != null ? summary.preview * 2 : null } }
    }))
  }
  async resolve(user, modelId, accountId) {
    if (!(await this.models(user)).some(model => model.id === modelId)) throw error('模型不存在或未授权', 'VOICE_MODEL_UNAVAILABLE', 404)
    const [[model]] = await this.pool.query(`SELECT m.*,p.base_url,p.timeout_ms,c.id AS capability_id,c.config_revision,c.protocol_adapter,c.upstream_account_id,c.status AS capability_status,
      r.voice_preview_points,r.voice_activation_points,r.voice_points_per_1k_chars,r.status AS pricing_status
      FROM ai_provider_models m JOIN ai_model_providers p ON p.id=m.provider_id
      JOIN ai_model_task_capabilities c ON c.provider_model_id=m.id AND c.task_type='speech_synthesis'
      LEFT JOIN ai_model_pricing_rules r ON r.provider_model_id=m.id WHERE m.id=? AND m.organization_id=?`, [modelId, user.organizationId])
    if (!model) throw error('模型不可用')
    const effectiveAccountId = String(model.upstream_account_id || accountId || '')
    if (!effectiveAccountId) throw error('语音能力尚未绑定上游账号', 'VOICE_ACCOUNT_UNAVAILABLE')
    if (accountId && accountId !== effectiveAccountId) throw error('音色必须使用模型能力绑定的上游账号', 'VOICE_ACCOUNT_MISMATCH')
    const keys = await selectEligibleModelKeys(this.pool, { providerId: model.provider_id, providerModelId: model.id,
      organizationId: user.organizationId, upstreamAccountId: effectiveAccountId, encryptedOnly: true, limit: 2 })
    const key = keys[0]
    if (keys.length > 1) throw error('MiniMax 仅支持单 Key，请由管理员整理重复配置', 'VOICE_MULTIPLE_KEYS')
    if (!key) throw error('该上游账号尚未配置适用于此模型的可用加密凭据', 'VOICE_KEY_UNAVAILABLE')
    const adapter = this.registry.resolve({ taskType: 'speech_synthesis', protocolAdapter: model.protocol_adapter, status: model.capability_status })
    const apiKey = await this.vault.unseal(key.secret_ciphertext, key.upstream_account_id)
    await this.pool.query('UPDATE ai_model_provider_keys SET last_used_at=CURRENT_TIMESTAMP(3) WHERE id=?', [key.id])
    const [pricingPlan, rateRows] = this.pricingPlans ? await Promise.all([this.pricingPlans.findActiveByCapability(model.capability_id, user.organizationId), this.pricingPlans.rates(user.organizationId)]) : [null, []]
    return { adapter, modelId: model.id, upstreamModel: model.model_id, providerId: model.provider_id, accountId: key.upstream_account_id, keyId: key.id,
      connection: { baseUrl: model.base_url, timeoutMs: model.timeout_ms, apiKey },
      pricingPlan, pricingRates: Object.fromEntries(rateRows.map(item => [item.currency, item.cnyRate])),
      pricing: { status: model.pricing_status, voice_preview_points: model.voice_preview_points, voice_activation_points: model.voice_activation_points, voice_points_per_1k_chars: model.voice_points_per_1k_chars } }
  }
}
