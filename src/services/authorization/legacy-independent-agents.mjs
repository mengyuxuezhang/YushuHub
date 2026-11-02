import { createHash, randomUUID } from 'node:crypto'
import { failure } from './protocol.mjs'

// Only for operator-confirmed legacy first-level identities attached to the
// platform. This is not a second-level conversion or general reparenting API.
export async function migrateLegacyIndependentAgents(pool, mapping, { apply = false, expectedDigest, actor = 'operator-migration' } = {}) {
  if (!Array.isArray(mapping) || !mapping.length || mapping.length > 100 || new Set(mapping.map(x => x.id)).size !== mapping.length
    || mapping.some(x => typeof x.id !== 'string' || !x.id || typeof x.expectedName !== 'string' || !x.expectedName)) throw failure('INVALID_MAPPING', '需要明确且唯一的组织ID及已核对名称')
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const entries = []
    for (const item of [...mapping].sort((a, b) => a.id.localeCompare(b.id))) {
      const [[row]] = await connection.query('SELECT * FROM ai_organizations WHERE id=? FOR UPDATE', [item.id])
      if (!row || row.name !== item.expectedName) throw failure('MAPPING_CHANGED', '组织不存在或名称已变化，请重新核对', 409)
      const [[parent]] = await connection.query('SELECT agent_level FROM ai_organizations WHERE id=? FOR UPDATE', [row.parent_organization_id])
      const [[child]] = await connection.query('SELECT COUNT(*) n FROM ai_organizations WHERE parent_organization_id=?', [row.id])
      if (Number(parent?.agent_level) !== 0 || Number(child.n) || ![1, 2].includes(Number(row.agent_level))) throw failure('INVALID_LEGACY_IDENTITY', '仅支持无下级且直接归平台的已确认一级主体', 409)
      if (Number(row.agent_level) === 1 && (row.deployment_mode !== 'local' || row.runtime_owner_organization_id !== row.id)) throw failure('MAPPING_CHANGED', '已迁移主体的部署身份不一致', 409)
      entries.push({ id: row.id, name: row.name, before: { agentLevel: Number(row.agent_level), deploymentMode: row.deployment_mode, runtimeOwner: row.runtime_owner_organization_id }, after: { agentLevel: 1, deploymentMode: 'local', runtimeOwner: row.id } })
    }
    const previewDigest = createHash('sha256').update(JSON.stringify(entries)).digest('hex')
    if (apply && expectedDigest !== previewDigest) throw failure('PREVIEW_CHANGED', '须使用本次预检摘要确认迁移', 409)
    let changed = 0
    if (apply) for (const entry of entries) {
      if (entry.before.agentLevel === 1) continue
      await connection.query("UPDATE ai_organizations SET agent_level=1,deployment_mode='local',runtime_owner_organization_id=? WHERE id=? AND agent_level=2", [entry.id, entry.id])
      await connection.query("INSERT INTO ai_organization_audit_logs (id,organization_id,actor_user_id,event_type,target_type,target_id,detail_json) VALUES (?,?,?,'legacy_first_level_confirmed','organization',?,?)", [randomUUID(), entry.id, actor, entry.id, JSON.stringify(entry)])
      changed++
    }
    if (apply) await connection.commit()
    else await connection.rollback()
    return { applied: apply, previewDigest, changed, entries, preservesIdsAndBusinessData: true }
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}
