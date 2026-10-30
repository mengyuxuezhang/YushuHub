import { ModelCredentialVault, sealModelCredential, unsealModelCredential } from './model-credentials.mjs'

const unconfirmed = () => Object.assign(new Error('模型主密钥缺失或与原凭据不匹配，请恢复原密钥备份；不能创建替代密钥继续写入'), { code: 'MODEL_MASTER_KEY_UNCONFIRMED', statusCode: 503 })

// Provider secrets share one deployment master. Unlike an empty notification
// channel, an existing provider pool must never silently start a new key lineage.
export function createProviderCredentialVault({ keyFile, database }) {
  if (typeof database !== 'function') throw new Error('A lazy provider database is required')
  const vault = new ModelCredentialVault(keyFile)
  async function existingKey(connection) {
    const [samples] = await (connection || database()).query(`SELECT secret_ciphertext,upstream_account_id FROM ai_model_provider_keys
      WHERE secret_ciphertext IS NOT NULL AND secret_ciphertext<>'' ORDER BY id LIMIT 20`)
    if (!samples.length) return null
    let pinned
    try { pinned = await vault.key(false) } catch { throw unconfirmed() }
    for (const sample of samples) {
      try { await unsealModelCredential(sample.secret_ciphertext, sample.upstream_account_id, async () => pinned); return pinned }
      catch { /* A damaged sample cannot authorize replacement; try the bounded remaining samples. */ }
    }
    throw unconfirmed()
  }
  const key = async (create = false, { connection } = {}) => create ? await existingKey(connection) || vault.key(true) : vault.key(false)
  return {
    key,
    async assertWritable({ connection } = {}) { await existingKey(connection) },
    seal(secret, accountId, { connection } = {}) { return sealModelCredential(secret, accountId, () => key(true, { connection })) },
    unseal: (value, accountId) => vault.unseal(value, accountId),
  }
}
