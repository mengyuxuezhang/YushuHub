import { migrationHash } from './legacy-import.mjs'
import { collectMigrationProofs } from './migration-snapshot.mjs'
import { verifyLegacyImportReceipt } from './local-legacy-binding.mjs'
import { accountingRuntimeStatus } from './accounting-mode.mjs'

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
  const [[refundTable]] = await connection.query("SELECT COUNT(*) AS present FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='ai_payment_refunds'")
  let cashRefunds = 0, pendingCashRefunds = 0
  if (Number(refundTable.present)) {
    const [[refunds]] = await connection.query("SELECT COUNT(*) AS count,COALESCE(SUM(state IN ('prepared','submitted','processing','unknown')),0) AS pending FROM ai_payment_refunds")
    cashRefunds = Number(refunds.count); pendingCashRefunds = Number(refunds.pending)
  }
  const runtime = await accountingRuntimeStatus(connection)
  const newAccountingHistoryPresent = requests > 0 || entries > 0 || activeHolds > 0 || cashRefunds > 0
  const compatibleVersionRequired = newAccountingHistoryPresent || runtime.centralizedBookPresent
  const preSettlementReviewCandidate = !newAccountingHistoryPresent && rights.equal
  return { schemaVersion: 2, sourceId: snapshot.sourceId, checkedAt: Date.now(), requests, unsettled, entries, activeHolds, cashRefunds, pendingCashRefunds, rights,
    ...runtime, newAccountingHistoryPresent, preSettlementReviewCandidate,
    compatibleVersionRequired, oldModeCandidate: preSettlementReviewCandidate && runtime.legacyRuntimeAllowed, databaseSnapshotRestoreAllowed: false,
    automaticRollbackPerformed: false, authorizesRollback: false,
    instruction: newAccountingHistoryPresent ? '只能回退到兼容新账务的版本，保留现库和新增流水；先核对未结任务和预占。'
      : runtime.centralizedBookPresent ? '尚无新资金记录，但新账务已经初始化，启动保护仍禁止旧计费模式；本工具不解除保护、不恢复数据库。'
        : '仅可作为结算前回退审核候选；仍须确认授权源、单写和服务配置，本工具不批准恢复旧库。' }
}
