import { randomUUID } from 'node:crypto'
import { MiniMaxAdapter } from './minimax-adapter.mjs'

const fail = message => Object.assign(new Error(message), { statusCode: 400 })
const organization = actor => {
  const id = actor?.organizationContext?.organizationId
  if (!id) throw Object.assign(new Error('组织信息不可用'), { statusCode: 403 })
  return id
}

export class VoiceConfigurationService {
  constructor(pool, vault, adapter = new MiniMaxAdapter()) { this.pool = pool; this.vault = vault; this.adapter = adapter }
  async list(actor) {
    const org = organization(actor)
    const [accounts] = await this.pool.query(`SELECT a.id,a.provider_id AS providerId,a.name,a.region,a.status,
      (SELECT COUNT(*) FROM ai_model_provider_keys k WHERE k.upstream_account_id=a.id AND k.secret_ciphertext IS NOT NULL AND k.status='enabled') AS keyCount
      ,(SELECT k.key_preview FROM ai_model_provider_keys k WHERE k.upstream_account_id=a.id AND k.secret_ciphertext IS NOT NULL LIMIT 1) AS keyPreview
      FROM ai_model_upstream_accounts a WHERE a.organization_id=? ORDER BY a.created_at`, [org])
    const [models] = await this.pool.query(`SELECT m.id,m.display_name AS name,m.model_id AS modelId,m.provider_id AS providerId,
      c.protocol_adapter AS adapter,c.status AS capabilityStatus,
      r.voice_preview_points AS previewPoints,r.voice_activation_points AS activationPoints,r.voice_points_per_1k_chars AS synthesisPoints
      FROM ai_provider_models m
      LEFT JOIN ai_model_task_capabilities c ON c.provider_model_id=m.id AND c.task_type='speech_synthesis'
      LEFT JOIN ai_model_pricing_rules r ON r.provider_model_id=m.id
      WHERE m.organization_id=? AND m.model_type='audio' ORDER BY m.created_at`, [org])
    return { accounts, models }
  }
  async createAccount(actor, input) {
    const org = organization(actor)
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw fail('请输入上游账号名称')
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [[provider]] = await connection.query('SELECT id FROM ai_model_providers WHERE id=? AND organization_id=? FOR UPDATE', [input.providerId, org])
      if (!provider) throw fail('服务商不存在或不属于当前组织')
      const [[existing]] = await connection.query('SELECT id FROM ai_model_upstream_accounts WHERE provider_id=? AND organization_id=? LIMIT 1', [provider.id, org])
      if (existing) throw fail('MiniMax 仅支持一个上游账号和一个 Key，请使用已有配置')
      const id = randomUUID()
      await connection.query(`INSERT INTO ai_model_upstream_accounts (id,organization_id,owner_user_id,provider_id,name,region)
        VALUES (?,?,?,?,?,?)`, [id, org, actor.organizationContext.legacyOwnerUserId || actor.id, provider.id, input.name.trim(), String(input.region || '').slice(0, 64)])
      await connection.commit()
      return { id }
    } catch (error) { await connection.rollback(); throw error }
    finally { connection.release() }
  }
  async addKey(actor, accountId, input) {
    const org = organization(actor)
    if (input.confirmSameAccount !== true || typeof input.key !== 'string' || input.key.trim().length < 8 || input.key.length > 16384) throw fail('请填写 Key，并确认已了解更换 Key 可能导致已训练音色不可用')
    const [[account]] = await this.pool.query(`SELECT a.*,p.base_url,p.timeout_ms FROM ai_model_upstream_accounts a
      JOIN ai_model_providers p ON p.id=a.provider_id WHERE a.id=? AND a.organization_id=? AND p.organization_id=?`, [accountId, org, org])
    if (!account) throw fail('上游账号不存在')
    const [voices] = await this.pool.query("SELECT provider_voice_id,status FROM ai_private_voices WHERE upstream_account_id=? AND status NOT IN ('deleted','failed')", [accountId])
    if (voices.length) throw fail('该账号已有私有音色，不能添加或覆盖 Key。请勿更换 MiniMax 账号，以免音色不可用')
    const connection = { baseUrl: account.base_url, timeoutMs: account.timeout_ms, apiKey: input.key.trim() }
    // Probe using the new Key, without creating or charging any voice resource.
    await this.adapter.systemVoices(connection)
    const id = randomUUID()
    const encrypted = await this.vault.seal(input.key.trim(), accountId)
    const transaction = await this.pool.getConnection()
    try {
      await transaction.beginTransaction()
      await transaction.query('SELECT id FROM ai_model_providers WHERE id=? FOR UPDATE', [account.provider_id])
      const [[existing]] = await transaction.query('SELECT id FROM ai_model_provider_keys WHERE provider_id=? AND organization_id=? LIMIT 1', [account.provider_id, org])
      if (existing) throw fail('MiniMax 仅支持一个 Key，不参与轮询。已有 Key 时不能重复添加')
      await transaction.query(`INSERT INTO ai_model_provider_keys
      (id,owner_user_id,organization_id,provider_id,upstream_account_id,api_key,secret_ciphertext,key_preview,status)
      VALUES (?,?,?,?,?,'',?,?,'enabled')`, [id, account.owner_user_id, org, account.provider_id, accountId, encrypted, `••••${input.key.trim().slice(-4)}`])
      await transaction.commit()
    } catch (error) { await transaction.rollback(); throw error }
    finally { transaction.release() }
    return { id, keyPreview: `••••${input.key.trim().slice(-4)}` }
  }
  async configureModel(actor, input) {
    const org = organization(actor)
    if (input.adapter !== 'minimax.t2a') throw fail('请选择 MiniMax 语音协议')
    for (const value of [input.previewPoints, input.activationPoints, input.synthesisPoints]) {
      if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9)) throw fail('价格必须为空或非负数字')
    }
    const [[model]] = await this.pool.query("SELECT id,provider_id FROM ai_provider_models WHERE id=? AND organization_id=? AND model_type='audio'", [input.modelId, org])
    if (!model) throw fail('请选择当前组织的音频模型')
    const [accounts] = await this.pool.query(`SELECT DISTINCT a.id FROM ai_model_upstream_accounts a
      JOIN ai_model_provider_keys k ON k.upstream_account_id=a.id AND k.organization_id=a.organization_id
      WHERE a.organization_id=? AND a.provider_id=? AND a.status='enabled'
      AND k.provider_id=a.provider_id AND k.status='enabled' AND k.secret_ciphertext IS NOT NULL`, [org, model.provider_id])
    if (!accounts.length) throw fail('请先为 MiniMax 固定上游账号配置可用 Key')
    if (accounts.length > 1) throw fail('MiniMax 仅允许一个启用中的语音 Key，请先停用重复凭据')
    const account = accounts[0]
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [[rule]] = await connection.query('SELECT id FROM ai_model_pricing_rules WHERE provider_model_id=? FOR UPDATE', [model.id])
      if (!rule) throw fail('请先在计费规则中为此模型创建规则')
      await connection.query(`INSERT INTO ai_model_task_capabilities
        (id,organization_id,provider_model_id,task_type,protocol_adapter,upstream_account_id,endpoint_path,status)
        VALUES (?,?,?,'speech_synthesis','minimax.t2a',?,'/v1/t2a_v2',?)
        ON DUPLICATE KEY UPDATE protocol_adapter=VALUES(protocol_adapter),upstream_account_id=VALUES(upstream_account_id),endpoint_path=VALUES(endpoint_path),config_revision=config_revision+1,status=VALUES(status)`,
      [randomUUID(), org, model.id, account.id, input.enabled === true ? 'enabled' : 'disabled'])
      await connection.query(`UPDATE ai_model_pricing_rules SET voice_preview_points=?,voice_activation_points=?,voice_points_per_1k_chars=? WHERE id=?`,
      [input.previewPoints ?? null, input.activationPoints ?? null, input.synthesisPoints ?? null, rule.id])
      await connection.commit()
      return { id: model.id }
    } catch (error) { await connection.rollback(); throw error }
    finally { connection.release() }
  }
}
