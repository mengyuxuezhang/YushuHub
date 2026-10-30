import { LICENSING_SCHEMA } from '../../repositories/licensing-state.mjs'
import { domain, failure, verifyClaims } from './protocol.mjs'
import { migrationHash } from './legacy-import.mjs'
import { readLegacyDeploymentSnapshot } from './migration-snapshot.mjs'

const book = 'legacy-authorization-bindings-v1'
export function verifyLegacyImportReceipt(result, { publicKeys, snapshot, mapping, now = Date.now() }) {
  const claims = verifyClaims(result.attestation, { keys: publicKeys, audience: 'legacy-import', now })
  const { receiptHash, ...payload } = result.receipt
  if (migrationHash(payload) !== receiptHash || claims.receiptHash !== receiptHash || claims.snapshotHash !== migrationHash(snapshot)
    || claims.grantHash !== migrationHash(result.grant)
    || claims.mappingHash !== migrationHash(mapping) || claims.grantId !== mapping.grantId || claims.localOrganizationId !== mapping.oldOrganizationId
    || claims.domain !== domain(mapping.domain) || claims.instanceId !== mapping.instanceId || payload.batchId !== claims.batchId) throw failure('IMPORT_RECEIPT_MISMATCH', '迁入回执、快照、映射或当前实例绑定不一致', 409)
  return claims
}

// Explicit tool only, not called by app startup. Does not create a license,
// change balances/roles, flip runtime mode or approve production cutover.
export async function applyLocalLegacyBinding({ pool, snapshot, mapping, result, publicKeys, maintenance, publicUrl, instanceId, now = Date.now() }) {
  if (!maintenance) throw failure('MAINTENANCE_REQUIRED', '停止经营写入并显式声明维护状态后再绑定', 409)
  const claims = verifyLegacyImportReceipt(result, { publicKeys, snapshot, mapping, now })
  if (domain(publicUrl) !== claims.domain || instanceId !== claims.instanceId) throw failure('BINDING_MISMATCH', '目标部署参数与签名绑定不符', 409)
  // Explicit migration initializes only its own state record.
  await pool.query(LICENSING_SCHEMA)
  await pool.query('INSERT IGNORE INTO licensing_state(id,document) VALUES (?,?)', [book, JSON.stringify({ receipts: {} })])
  const connection = await pool.getConnection()
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await connection.beginTransaction()
    const [[saved]] = await connection.query('SELECT document FROM licensing_state WHERE id=? FOR UPDATE', [book])
    const state = typeof saved.document === 'string' ? JSON.parse(saved.document) : saved.document, previous = state.receipts[claims.batchId]
    if (previous) {
      if (previous.receiptHash !== claims.receiptHash) throw failure('IDEMPOTENCY_CONFLICT', '本地批次已用于其他迁入回执', 409)
      await connection.rollback(); return { ...previous, alreadyApplied: true, cutoverReady: false }
    }
    const old = snapshot.organizations[0]
    const [[organization]] = await connection.query('SELECT id,external_id,agent_level FROM ai_organizations WHERE id=? FOR UPDATE', [old.id])
    if (!organization || organization.agent_level !== 1 || organization.external_id !== old.localExternalId) throw failure('BINDING_MISMATCH', '本地原组织身份已变化，不覆盖现有绑定', 409)
    const profile = { sourceId: snapshot.sourceId, oldOrganizationId: old.id, legacySupplierId: old.legacySupplierId, status: old.status, expiresAt: old.expiresAt,
      allowCustomApiProviders: old.allowCustomApiProviders, domain: old.domain, instanceId: old.instanceId, capabilities: snapshot.capabilities, cumulativeBuilds: old.usage.builds }
    const current = await readLegacyDeploymentSnapshot(connection, profile, snapshot.capturedAt)
    if (migrationHash(current) !== claims.snapshotHash) throw failure('SOURCE_CHANGED', '采集后组织、资源或用户权益已变化，须重新核对，禁止覆盖', 409)
    if (Object.values(current.blockers).some(value => value !== 0)) throw failure('LEGACY_WORK_PENDING', '旧构建或模型任务尚未结束/核对，不能转入新调用入口', 409)
    await connection.query('UPDATE ai_organizations SET external_id=?,authorization_version=? WHERE id=?', [claims.grantId, claims.grantVersion, old.id])
    const receipt = { batchId: claims.batchId, receiptHash: claims.receiptHash, snapshotHash: claims.snapshotHash, oldOrganizationId: old.id, grantId: claims.grantId, appliedAt: now,
      identitiesPreserved: true, balancesUnchanged: true, runtimeModeChanged: false,
      remainingChecks: ['model-price-shadow', 'official-resource-scope', 'single-writer-switch', 'rollback-rehearsal', 'seven-day-pilot'] }
    state.receipts[claims.batchId] = receipt
    await connection.query('UPDATE licensing_state SET document=?,revision=revision+1 WHERE id=?', [JSON.stringify(state), book])
    await connection.commit()
    return { ...receipt, alreadyApplied: false, cutoverReady: false }
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}
