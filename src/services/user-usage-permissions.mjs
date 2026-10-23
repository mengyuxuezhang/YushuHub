// Grant report permissions once, inheriting existing operational authority.
// Revocations after this migration remain authoritative on later startups.
export async function migrateUserUsagePermissions(pool) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [migration] = await connection.query("INSERT IGNORE INTO ai_feature_migrations (migration_key) VALUES ('user-usage-permissions-v1')")
    if (migration.affectedRows) {
      for (const key of ['user_usage.view', 'user_usage.export']) {
        await connection.query(`INSERT IGNORE INTO ai_role_template_permissions (template_id,permission_key)
          SELECT DISTINCT p.template_id,? FROM ai_role_template_permissions p
          JOIN ai_role_templates t ON t.id=p.template_id
          WHERE t.system_builtin=1 AND p.permission_key IN ('end_users.manage','credits.manage')`, [key])
      }
    }
    const [organizations] = await connection.query('SELECT id FROM ai_organizations')
    for (const organization of organizations) {
      const [applied] = await connection.query('INSERT IGNORE INTO ai_feature_migrations (migration_key) VALUES (?)', [`user-usage-capabilities-v1:${organization.id}`])
      if (!applied.affectedRows) continue
      for (const key of ['user_usage.view', 'user_usage.export']) {
        await connection.query(`INSERT IGNORE INTO ai_organization_capabilities
          (organization_id,capability_key,enabled,transferable,limit_value,granted_by_organization_id,granted_by_user_id)
          SELECT organization_id,?,enabled,transferable,0,granted_by_organization_id,'system-migration'
          FROM ai_organization_capabilities WHERE organization_id=? AND capability_key IN ('credits.manage','end_users.manage')
          ORDER BY enabled DESC,transferable DESC LIMIT 1`, [key,organization.id])
      }
    }
    await connection.commit()
  } catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
}
