import { db } from '../db/pool.mjs'
import { pluginPresentation } from '../services/plugin-presentation.mjs'

const query = (...args) => db().query(...args)

const effectiveGrants = `(
  SELECT project_id,plugin_id,version FROM ai_plugin_grants
  UNION ALL
  SELECT p.id,o.plugin_id,o.version FROM ai_projects p CROSS JOIN ai_plugin_official o
  WHERE p.status='enabled'
    AND NOT EXISTS (SELECT 1 FROM ai_plugin_grants g WHERE g.project_id=p.id AND g.plugin_id=o.plugin_id)
    AND NOT EXISTS (SELECT 1 FROM ai_plugin_official_exclusions e WHERE e.project_id=p.id AND e.plugin_id=o.plugin_id)
)`
const publicVersion = (row, includePresentation) => ({
  ...(typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata),
  sha256: row.sha256,
  size: row.size,
  ...(includePresentation ? { presentation: pluginPresentation(row.plugin_id, row.presentation) } : {}),
})

export const pluginMarket = {
  async overview() {
    const [[versions], [grants], [projects], [counts]] = await Promise.all([
      query('SELECT v.plugin_id,v.version,v.metadata,v.sha256,v.size,COALESCE(p.presentation,o.presentation) AS presentation FROM ai_plugin_versions v LEFT JOIN ai_plugin_profiles p ON p.plugin_id=v.plugin_id LEFT JOIN ai_plugin_official o ON o.plugin_id=v.plugin_id ORDER BY v.created_at DESC'),
      query(`SELECT project_id,plugin_id,version FROM ${effectiveGrants} g ORDER BY project_id,plugin_id`),
      query("SELECT id, app_name AS name FROM ai_projects WHERE status='enabled' ORDER BY app_name, id"),
      query("SELECT plugin_id, version, project_id, COUNT(*) AS count FROM ai_plugin_installations WHERE state='installed' GROUP BY plugin_id, version, project_id"),
    ])
    return { versions: versions.map(row => publicVersion(row, true)), grants, projects, counts }
  },
  async publish({ bytes, plugin, sha256 }, actor) {
    await query(`INSERT INTO ai_plugin_versions (plugin_id,version,metadata,sha256,size,package_bytes,created_by)
      VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE sha256=ai_plugin_versions.sha256`,
    [plugin.id, plugin.version, JSON.stringify(plugin), sha256, bytes.length, bytes, actor])
    const [[row]] = await query('SELECT sha256 FROM ai_plugin_versions WHERE plugin_id=? AND version=?', [plugin.id, plugin.version])
    return row.sha256 === sha256
  },
  async grant(projectId, pluginId, version, actor) {
    const [result] = await query(`INSERT INTO ai_plugin_grants (project_id,plugin_id,version,updated_by)
      SELECT p.id,v.plugin_id,v.version,? FROM ai_projects p JOIN ai_plugin_versions v ON v.plugin_id=? AND v.version=?
      WHERE p.id=? AND p.status='enabled'
      ON DUPLICATE KEY UPDATE version=VALUES(version),updated_by=VALUES(updated_by)`, [actor, pluginId, version, projectId])
    // A repeat save may not change the row.
    if (result.affectedRows) return true
    const [[existing]] = await query(`SELECT g.version FROM ai_plugin_grants g JOIN ai_projects p ON p.id=g.project_id
      WHERE g.project_id=? AND g.plugin_id=? AND p.status='enabled'`, [projectId, pluginId])
    return existing?.version === version
  },
  async revoke(projectId, pluginId) {
    const connection = await db().getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(`INSERT IGNORE INTO ai_plugin_official_exclusions (project_id,plugin_id)
        SELECT p.id,? FROM ai_projects p WHERE p.id=? AND EXISTS (SELECT 1 FROM ai_plugin_official WHERE plugin_id=?)`, [pluginId, projectId, pluginId])
      await connection.query('DELETE FROM ai_plugin_grants WHERE project_id=? AND plugin_id=?', [projectId, pluginId])
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally { connection.release() }
  },
  async officialCatalog() {
    const [rows] = await query(`SELECT v.plugin_id,v.metadata,v.sha256,v.size,COALESCE(p.presentation,o.presentation) AS presentation
      FROM ai_plugin_official o JOIN ai_plugin_versions v ON v.plugin_id=o.plugin_id AND v.version=o.version
      LEFT JOIN ai_plugin_profiles p ON p.plugin_id=o.plugin_id ORDER BY o.plugin_id`)
    return rows.map(row => publicVersion(row, true))
  },
  async officialPackage(id, version) {
    const [[row]] = await query(`SELECT v.package_bytes FROM ai_plugin_official o
      JOIN ai_plugin_versions v ON v.plugin_id=o.plugin_id AND v.version=o.version
      WHERE o.plugin_id=? AND o.version=?`, [id, version])
    return row?.package_bytes
  },
  async setOfficialVersion(id, version) {
    if (!version) {
      await query('DELETE FROM ai_plugin_official WHERE plugin_id=?', [id])
      return true
    }
    await query(`INSERT INTO ai_plugin_official (plugin_id,version)
      SELECT plugin_id,version FROM ai_plugin_versions WHERE plugin_id=? AND version=?
      ON DUPLICATE KEY UPDATE version=VALUES(version)`, [id, version])
    const [[selected]] = await query('SELECT version FROM ai_plugin_official WHERE plugin_id=?', [id])
    return selected?.version === version
  },
  async replaceOfficialCatalog(items) {
    const connection = await db().getConnection()
    try {
      await connection.beginTransaction()
      await connection.query('DELETE FROM ai_plugin_official')
      for (const item of items) {
        await connection.query('INSERT INTO ai_plugin_official (plugin_id,version,presentation) VALUES (?,?,?)',
          [item.id, item.version, JSON.stringify(item.presentation)])
      }
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally { connection.release() }
  },
  async catalog(projectId, includePresentation = false) {
    const [rows] = await query(`SELECT v.plugin_id,v.metadata,v.sha256,v.size,COALESCE(p.presentation,o.presentation) AS presentation FROM ${effectiveGrants} g
      JOIN ai_plugin_versions v ON v.plugin_id=g.plugin_id AND v.version=g.version
      LEFT JOIN ai_plugin_profiles p ON p.plugin_id=g.plugin_id
      LEFT JOIN ai_plugin_official o ON o.plugin_id=g.plugin_id
      WHERE g.project_id=? ORDER BY g.plugin_id`, [projectId])
    return rows.map(row => publicVersion(row, includePresentation))
  },
  async savePresentation(pluginId, presentation, actor) {
    const [result] = await query(`INSERT INTO ai_plugin_profiles (plugin_id,presentation,updated_by)
      SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM ai_plugin_versions WHERE plugin_id=?)
      ON DUPLICATE KEY UPDATE presentation=VALUES(presentation),updated_by=VALUES(updated_by)`,
    [pluginId, JSON.stringify(presentation), actor, pluginId])
    if (result.affectedRows) return true
    const [[existing]] = await query('SELECT plugin_id FROM ai_plugin_profiles WHERE plugin_id=?', [pluginId])
    return Boolean(existing)
  },
  async download(projectId, pluginId, version) {
    const [[row]] = await query(`SELECT v.package_bytes FROM ${effectiveGrants} g
      JOIN ai_plugin_versions v ON v.plugin_id=g.plugin_id AND v.version=g.version
      WHERE g.project_id=? AND g.plugin_id=? AND g.version=?`, [projectId, pluginId, version])
    return row?.package_bytes
  },
  async report(projectId, userId, installationId, pluginId, version, state) {
    const [result] = await query(`INSERT INTO ai_plugin_installations (project_id,user_id,installation_id,plugin_id,version,state)
      SELECT ?,?,?,?,?,? FROM ai_plugin_versions v WHERE v.plugin_id=? AND v.version=?
      AND (?='removed' OR EXISTS (SELECT 1 FROM ${effectiveGrants} g WHERE g.project_id=? AND g.plugin_id=v.plugin_id AND g.version=v.version))
      ON DUPLICATE KEY UPDATE version=VALUES(version),state=VALUES(state),updated_at=CURRENT_TIMESTAMP(3)`,
    [projectId, userId, installationId, pluginId, version, state, pluginId, version, state, projectId])
    if (result.affectedRows) return true
    const [[existing]] = await query(`SELECT i.state FROM ai_plugin_installations i
      WHERE i.project_id=? AND i.user_id=? AND i.installation_id=? AND i.plugin_id=? AND i.version=?
      AND (?='removed' OR EXISTS (SELECT 1 FROM ${effectiveGrants} g WHERE g.project_id=i.project_id AND g.plugin_id=i.plugin_id AND g.version=i.version))`,
    [projectId, userId, installationId, pluginId, version, state])
    return existing?.state === state
  },
}
