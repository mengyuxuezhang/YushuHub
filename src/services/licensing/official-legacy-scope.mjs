import { LICENSING_SCHEMA } from '../../repositories/licensing-state.mjs'
import { safeProjectId } from '../../utils/slug.mjs'
import { officialCenterProjectId } from './build-scopes.mjs'
import { failure } from './protocol.mjs'
import { migrationHash } from './legacy-import.mjs'
import { verifyLegacyImportReceipt } from './local-legacy-binding.mjs'

const book = 'legacy-official-scopes-v1'
// Match the existing official center's project naming rule. Do not rename
// historical records or infer ownership from this lossy slug alone.
const projectId = (supplier, local) => officialCenterProjectId(supplier, safeProjectId(local))

async function inspect(connection, { snapshot, mapping, result, publicKeys }, lock = false) {
  const claims = verifyLegacyImportReceipt(result, { snapshot, mapping, publicKeys })
  const supplierId = snapshot.organizations[0].legacySupplierId
  if (!supplierId || supplierId !== claims.grantId) throw failure('OFFICIAL_SUPPLIER_MISMATCH', '须保留并核验旧官方供应商身份', 409)
  const suffix = lock ? ' FOR UPDATE' : ''
  const [[supplier]] = await connection.query('SELECT id FROM ai_center_suppliers WHERE id=?' + suffix, [supplierId])
  if (!supplier) throw failure('OFFICIAL_SUPPLIER_MISSING', '目标官方库没有原供应商，不自动创建或认领', 409)
  const [rows] = await connection.query('SELECT id,project_id,center_local_build_id,organization_id,status FROM ai_builds WHERE center_supplier_id=? ORDER BY id' + suffix, [supplierId])
  const localRemote = new Map(), candidates = new Map(), blockers = [], changes = []
  for (const local of snapshot.builds) {
    if (!local.remoteBuildId) continue
    if (localRemote.has(local.remoteBuildId)) throw failure('DUPLICATE_REMOTE_BUILD', '原本地记录重复引用同一官方构建', 409)
    localRemote.set(local.remoteBuildId, local)
    const expectedProject = projectId(supplierId, local.projectId)
    if (candidates.has(expectedProject) && candidates.get(expectedProject) !== local.projectId) throw failure('PROJECT_SLUG_COLLISION', '旧项目映射发生碰撞，须人工核对', 409)
    candidates.set(expectedProject, local.projectId)
    const row = rows.find(item => item.id === local.remoteBuildId)
    if (!row || row.center_local_build_id !== local.id || row.project_id !== expectedProject) { blockers.push({ kind: 'build', id: local.remoteBuildId, code: 'SOURCE_LINK_MISMATCH' }); continue }
    if (['queued', 'running'].includes(row.status)) blockers.push({ kind: 'build', id: row.id, code: 'BUILD_IN_PROGRESS' })
    if (row.organization_id && row.organization_id !== claims.grantId) blockers.push({ kind: 'build', id: row.id, code: 'OTHER_ORGANIZATION' })
    else if (!row.organization_id) changes.push({ kind: 'build', id: row.id, before: row.organization_id, after: claims.grantId })
  }
  for (const row of rows) if (!localRemote.has(row.id) && row.organization_id !== claims.grantId) blockers.push({ kind: 'build', id: row.id, code: 'UNMATCHED_OFFICIAL_HISTORY' })
  for (const local of snapshot.projects) {
    const id = projectId(supplierId, local.id)
    if (candidates.has(id) && candidates.get(id) !== local.id) throw failure('PROJECT_SLUG_COLLISION', '旧项目映射发生碰撞，须人工核对', 409)
    candidates.set(id, local.id)
  }
  const projects = []
  for (const [id, localId] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    const [[row]] = await connection.query('SELECT id,organization_id FROM ai_projects WHERE id=?' + suffix, [id])
    if (!row) {
      if (rows.some(build => build.project_id === id)) blockers.push({ kind: 'project', id, code: 'PROJECT_MISSING' })
      continue // A local project never submitted to the center needs no backfill.
    }
    const [references] = await connection.query('SELECT id,center_supplier_id,center_local_build_id,organization_id FROM ai_builds WHERE project_id=? ORDER BY id' + suffix, [id])
    const [[registered]] = await connection.query('SELECT project_id FROM ai_center_supplier_projects WHERE supplier_id=? AND project_id=?' + suffix, [supplierId, localId])
    const hasMatchedBuild = references.some(build => localRemote.get(build.id)?.id === build.center_local_build_id)
    projects.push({ ...row, localId, registered: Boolean(registered), references })
    if ((!registered && !hasMatchedBuild) || references.some(build => build.center_supplier_id !== supplierId)) blockers.push({ kind: 'project', id, code: 'PROJECT_OWNERSHIP_UNPROVEN' })
    else if (row.organization_id && row.organization_id !== claims.grantId) blockers.push({ kind: 'project', id, code: 'OTHER_ORGANIZATION' })
    else if (!row.organization_id) changes.push({ kind: 'project', id, before: row.organization_id, after: claims.grantId })
  }
  const impact = { schemaVersion: 1, batchId: claims.batchId, grantId: claims.grantId, receiptHash: claims.receiptHash,
    sourceId: snapshot.sourceId, supplierId, snapshotHash: claims.snapshotHash, changes, blockers,
    officialBuildCount: rows.length, matchedRemoteBuildCount: localRemote.size, reviewedProjectCount: projects.length,
    inventoryHash: migrationHash({ rows, projects }), cutoverReady: false }
  return { ...impact, previewDigest: migrationHash(impact) }
}

export async function previewOfficialLegacyScope({ pool, ...input }) {
  const connection = await pool.getConnection()
  try { await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await connection.query('SET TRANSACTION READ ONLY'); await connection.beginTransaction(); const report = await inspect(connection, input); await connection.commit(); return report }
  catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}

export async function applyOfficialLegacyScope({ pool, previewDigest, maintenance, ...input }) {
  if (!maintenance) throw failure('MAINTENANCE_REQUIRED', '先停止官方构建受理及相关写入，再执行范围补齐', 409)
  // Explicit migration only. No changes to builds, quotas, artifacts or tokens
  // occur during normal server startup.
  await pool.query(LICENSING_SCHEMA)
  await pool.query('INSERT IGNORE INTO licensing_state(id,document) VALUES (?,?)', [book, JSON.stringify({ receipts: {} })])
  const connection = await pool.getConnection()
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await connection.beginTransaction()
    const [[saved]] = await connection.query('SELECT document FROM licensing_state WHERE id=? FOR UPDATE', [book])
    const state = typeof saved.document === 'string' ? JSON.parse(saved.document) : saved.document
    const claims = verifyLegacyImportReceipt(input.result, input)
    const previous = state.receipts[claims.batchId]
    if (previous) {
      if (previous.receiptHash !== claims.receiptHash || previous.previewDigest !== previewDigest) throw failure('IDEMPOTENCY_CONFLICT', '范围补齐批次已用于不同审核', 409)
      await connection.rollback(); return { ...previous, alreadyApplied: true }
    }
    const report = await inspect(connection, input, true)
    if (report.previewDigest !== previewDigest) throw failure('OFFICIAL_SOURCE_CHANGED', '官方记录已变化，须重新预览并审核', 409)
    if (report.blockers.length) throw failure('OFFICIAL_SCOPE_BLOCKED', '存在归属冲突或未核对记录，禁止部分补齐', 409)
    for (const change of report.changes) {
      const table = change.kind === 'build' ? 'ai_builds' : 'ai_projects'
      await connection.query(`UPDATE ${table} SET organization_id=? WHERE id=?`, [change.after, change.id])
    }
    const receipt = { batchId: claims.batchId, receiptHash: claims.receiptHash, previewDigest, grantId: claims.grantId,
      appliedAt: Date.now(), changes: report.changes, cutoverReady: false, credentialsChanged: false, artifactsChanged: false, quotasChanged: false }
    state.receipts[claims.batchId] = receipt
    await connection.query('UPDATE licensing_state SET document=?,revision=revision+1 WHERE id=?', [JSON.stringify(state), book])
    await connection.commit(); return { ...receipt, alreadyApplied: false }
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}
