import { migrationHash } from './legacy-import.mjs'
import { collectMigrationProofs } from './migration-snapshot.mjs'
import { verifyLegacyImportReceipt } from './local-legacy-binding.mjs'

export function compareMigrationProofs(before, after) {
  const differences = []
  for (const group of new Set([...Object.keys(before), ...Object.keys(after)])) if (migrationHash(before[group]) !== migrationHash(after[group])) differences.push({ group, before: before[group]?.count ?? null, after: after[group]?.count ?? null })
  return { equal: differences.length === 0, differences }
}
export function shadowLegacyAuthorization({ snapshot, mapping, result, publicKeys, proofs, usage, now = Date.now() }) {
  verifyLegacyImportReceipt(result, { snapshot, mapping, publicKeys, now })
  const grant = result.grant, old = snapshot.organizations[0], before = result.receipt.retainedCapabilities
  const after = grant.capabilities.filter(cap => cap.enabled).map(cap => cap.key)
  const missingCapabilities = before.filter(key => !after.includes(key))
  const unreviewedCapabilities = after.filter(key => !before.includes(key) && !result.receipt.addedCapabilities.some(item => item.key === key))
  const rights = compareMigrationProofs(snapshot.proofs, proofs), usageMatches = ['projects', 'builds'].every(kind => usage?.[kind] === old.usage[kind])
  const identitiesMatch = grant.id === mapping.grantId && grant.migration?.localOrganizationId === old.id
  return { schemaVersion: 1, batchId: result.receipt.batchId, snapshotHash: result.receipt.snapshotHash, receiptHash: result.receipt.receiptHash, checkedAt: now,
    identitiesMatch,
    missingCapabilities, unreviewedCapabilities, rights, usageMatches, expectedUsage: old.usage, actualUsage: usage,
    authorizationAndRightsMatch: identitiesMatch && missingCapabilities.length === 0 && unreviewedCapabilities.length === 0 && rights.equal && usageMatches,
    activated: Number.isFinite(grant.activatedAt), active: grant.status === 'enabled' && (!grant.expiresAt || Date.parse(grant.expiresAt) > now),
    cutoverReady: false, remainingChecks: ['model-price-shadow', 'official-resource-scope', 'single-writer-switch', 'rollback-rehearsal', 'seven-day-pilot'] }
}

export async function legacyRollbackStatus(connection, snapshot) {
  const proofs = await collectMigrationProofs(connection), rights = compareMigrationProofs(snapshot.proofs, proofs)
  const [[table]] = await connection.query("SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='accounting_requests'")
  let requests = 0, entries = 0, activeHolds = 0, unsettled = 0
  if (Number(table.count)) {
    const [[row]] = await connection.query("SELECT COUNT(*) AS count,COALESCE(SUM(state<>'settled'),0) AS unsettled FROM accounting_requests WHERE book='commerce-v2'")
    const [[ledger]] = await connection.query("SELECT COUNT(*) AS count FROM accounting_entries WHERE book='commerce-v2'")
    const [[holds]] = await connection.query("SELECT COUNT(*) AS count FROM accounting_holds WHERE book='commerce-v2' AND released=0")
    requests = Number(row.count); unsettled = Number(row.unsettled); entries = Number(ledger.count); activeHolds = Number(holds.count)
  }
  const compatibleVersionRequired = requests > 0 || entries > 0 || activeHolds > 0
  return { schemaVersion: 1, sourceId: snapshot.sourceId, checkedAt: Date.now(), requests, unsettled, entries, activeHolds, rights,
    compatibleVersionRequired, oldModeCandidate: !compatibleVersionRequired && rights.equal, databaseSnapshotRestoreAllowed: !compatibleVersionRequired && rights.equal,
    automaticRollbackPerformed: false, authorizesRollback: false,
    instruction: compatibleVersionRequired ? '只能回退到兼容新账务的版本，保留现库和新增流水；先核对未结任务和预占。' : '仅可作为结算前回退候选；仍须确认授权源、单写和服务配置，不自动恢复旧库。' }
}
