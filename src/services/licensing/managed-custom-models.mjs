import { selectEligibleModelKeys } from '../model-key-scope.mjs'
import { digest, failure, identifier, micros } from './protocol.mjs'
import { validateSupplyPrice } from './pricing.mjs'

const types = { 'openai.chat': 'text', 'openai.images': 'image', 'bocha.search': 'search', 'minimax.speech': 'audio', 'minimax.speech_async': 'audio' }
const tasks = { text: 'chat', image: 'image_generation', search: 'web_search', audio: 'speech_synthesis' }
// A reviewed supply definition references an existing model identity. Credentials
// stay in the original encrypted key pool; they never enter the public catalog.
export function managedCustomModels({ pool, materializeKey }) {
  async function resolve(definition, root, { credentials = false, credentialId, recovery = false } = {}) {
    if (!definition.providerModelId) return definition
    if (!recovery && (root.level !== 1 || root.modelMode !== 'custom')) throw failure('MODEL_FIXED', '只有自定义一级可以使用本地模型配置', 403)
    if (recovery && (!credentials || !credentialId)) throw failure('RECONCILIATION_REQUIRED', '恢复必须绑定原凭据', 409)
    identifier(definition.providerModelId)
    if (definition.id !== definition.providerModelId) throw failure('MODEL_IDENTITY_MISMATCH', '密钥池供货ID须沿用原模型内部ID，保留既有用户模型授权', 409)
    // All managed resale amounts live in the existing versioned offer UI, so
    // changing a connection file cannot silently raise a downstream base price.
    if (validateSupplyPrice(definition.price).components.some(item => micros(item.amount) !== 0n)) throw failure('MANAGED_PRICE_REQUIRED', '密钥池模型基准金额须为0，实际售价和供货价在分级定价界面配置')
    if (!types[definition.adapter] || definition.taskType !== tasks[types[definition.adapter]] || definition.keyEnv || definition.baseUrl || definition.model || definition.apiKey) throw failure('INVALID_MODEL_BINDING', '密钥池模型须使用本地定义的模型和连接，不能同时覆盖连接或凭据')
    const [organizations] = await pool.query(`SELECT id,legacy_owner_user_id FROM ai_organizations WHERE external_id=? AND agent_level=1${recovery ? '' : " AND status='enabled'"}`, [root.id])
    if (organizations.length !== 1 || !organizations[0].legacy_owner_user_id) throw failure('MODEL_SCOPE_UNRESOLVED', '一级模型归属需先核对迁入', 409)
    const organization = organizations[0]
    const [[row]] = await pool.query(`SELECT m.id,m.model_id,m.display_name,m.model_type,m.endpoint_path,m.context_window,p.id AS provider_id,p.base_url
      FROM ai_provider_models m JOIN ai_model_providers p ON p.id=m.provider_id
      WHERE m.id=? AND m.organization_id=? AND p.organization_id=?${recovery ? '' : " AND m.archived_at IS NULL AND m.status='enabled' AND p.status='enabled'"}`,
    [definition.providerModelId, organization.id, organization.id])
    if (!row || (row.model_type || 'text') !== types[definition.adapter]) throw failure('MODEL_UNAVAILABLE', '本地模型已停用、删除或不属于当前一级', 403)
    const expectedEndpoint = { 'openai.chat': '/chat/completions', 'openai.images': '/images/generations', 'bocha.search': '/web-search', 'minimax.speech': '/v1/t2a_v2', 'minimax.speech_async': '/v1/t2a_async_v2' }[definition.adapter]
    if (row.endpoint_path && row.endpoint_path !== expectedEndpoint && !(definition.adapter === 'minimax.speech_async' && row.endpoint_path === '/v1/t2a_v2')) throw failure('UNSUPPORTED_MODEL_ENDPOINT', '此模型接口需适配后才能进入供货链路', 409)
    let origin
    try { origin = new URL(row.base_url) } catch { throw failure('INVALID_UPSTREAM', '供货模型连接地址无效') }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) throw failure('INVALID_UPSTREAM', '供货模型连接必须使用无凭据的HTTPS地址')
    if (definition.adapter === 'openai.chat' && (!Number.isSafeInteger(definition.contextWindow) || definition.contextWindow > Number(row.context_window))) throw failure('UNBOUNDED_REQUEST', '供货上下文上限不能超过本地模型已核定容量')
    const result = { ...definition, name: definition.name || row.display_name, clientId: definition.clientId || row.model_id, model: row.model_id, baseUrl: row.base_url,
      bindingHash: digest(JSON.stringify([definition.id, definition.version, definition.adapter, definition.providerModelId, row.provider_id, row.model_id, row.base_url, row.endpoint_path, row.context_window, organization.id])) }
    if (!credentials) return result
    let key
    if (credentialId) {
      const [[original]] = await pool.query(`SELECT k.* FROM ai_model_provider_keys k JOIN ai_model_upstream_accounts a ON a.id=k.upstream_account_id
        WHERE k.id=? AND k.provider_id=? AND k.organization_id=? AND k.owner_user_id=? AND k.status='enabled'
        AND (COALESCE(k.provider_model_id,'')='' OR k.provider_model_id=?) AND a.provider_id=k.provider_id AND a.organization_id=k.organization_id AND a.status='enabled'`,
      [identifier(credentialId), row.provider_id, organization.id, organization.legacy_owner_user_id, row.id])
      key = original
    } else {
      const keys = await selectEligibleModelKeys(pool, { providerId: row.provider_id, providerModelId: row.id, organizationId: organization.id, ownerUserId: organization.legacy_owner_user_id, activeAccountsOnly: true })
      key = keys[0]
    }
    if (!key) throw failure('MODEL_CREDENTIAL_UNAVAILABLE', '一级密钥池没有适用于该模型的启用凭据', 409)
    const materialized = await materializeKey(key)
    if (!materialized?.api_key) throw failure('MODEL_CREDENTIAL_UNAVAILABLE', '一级模型凭据不可用', 409)
    return { ...result, credentialId: key.id, apiKey: materialized.api_key }
  }
  return { resolve,
    async used(id) { await pool.query('UPDATE ai_model_provider_keys SET last_used_at=CURRENT_TIMESTAMP(3) WHERE id=?', [identifier(id)]) },
  }
}
