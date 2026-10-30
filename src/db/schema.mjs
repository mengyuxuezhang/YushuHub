import { consolidatePricingPlans } from '../services/pricing-current-plan-migration.mjs'
import crypto from 'node:crypto'
import mysql from 'mysql2/promise'
import { migrateUserUsagePermissions } from '../services/user-usage-permissions.mjs'

let pool
let DB_NAME

const DEFAULT_FREE_PACKAGES = [
  { name: '永久免费', durationDays: 0, bonusPoints: 0, pointsDurationDays: 0, price: 0, originalPrice: 0, showOriginalPrice: false },
]

function normalizeSingleMembershipPackage(value, systemBuiltin = false) {
  let list = []
  try {
    list = Array.isArray(value) ? value : JSON.parse(String(value || '[]'))
  } catch {}
  const item = (Array.isArray(list) ? list[0] : null) || (systemBuiltin ? DEFAULT_FREE_PACKAGES[0] : { name: '会员权益', durationDays: 30 })
  return {
    name: String(item.name || (systemBuiltin ? '永久免费' : '会员权益')).trim().slice(0, 120),
    durationDays: systemBuiltin ? 0 : Math.max(0, Math.floor(Number(item.durationDays ?? item.duration_days ?? 30) || 0)),
    bonusPoints: Math.max(0, Math.round((Number(item.bonusPoints ?? item.bonus_points ?? 0) || 0) * 1_000_000) / 1_000_000),
    pointsDurationDays: Math.max(0, Math.floor(Number(item.pointsDurationDays ?? item.points_duration_days ?? 0) || 0)),
    price: Math.max(0, Math.round((Number(item.price ?? 0) || 0) * 100) / 100),
    originalPrice: Math.max(0, Math.round((Number(item.originalPrice ?? item.original_price ?? 0) || 0) * 100) / 100),
    showOriginalPrice: item.showOriginalPrice === true || item.show_original_price === true || item.showOriginalPrice === '1' || item.show_original_price === '1',
  }
}

function freeMembershipCardId(ownerUserId = 'admin') {
  const ownerId = String(ownerUserId || 'admin').trim() || 'admin'
  if (ownerId === 'admin') return 'free'
  return `free-${crypto.createHash('sha256').update(ownerId).digest('hex').slice(0, 24)}`
}

async function seedAccountFreeMembershipCards() {
  const [owners] = await pool.query('SELECT id FROM ai_users ORDER BY created_at ASC')
  for (const owner of owners) {
    const ownerId = String(owner.id || '').trim()
    if (!ownerId) continue
    await pool.query(
      `INSERT INTO ai_membership_cards (
         id, name, level, discount_percent, discount_modules, redeem_only,
         status, packages_json, description, created_by, system_builtin
       ) VALUES (?, '免费会员', 1, 100, ?, 0, 'enabled', ?, '新注册用户默认分配的基础会员。', ?, 1)
       ON DUPLICATE KEY UPDATE
         status = 'enabled',
         created_by = VALUES(created_by),
         system_builtin = 1`,
      [freeMembershipCardId(ownerId), JSON.stringify([]), JSON.stringify(DEFAULT_FREE_PACKAGES), ownerId],
    )
  }

  for (const owner of owners) {
    const ownerId = String(owner.id || '').trim()
    if (!ownerId || ownerId === 'admin') continue
    await pool.query(
      `UPDATE ai_end_user_memberships m
       JOIN ai_end_users u ON u.id = m.user_id
       LEFT JOIN ai_projects p ON p.id = u.source_project_id
       SET m.card_id = ?, m.created_by = ?
       WHERE m.card_id = 'free'
         AND COALESCE(NULLIF(u.source_agent_id, ''), p.owner_user_id, 'admin') = ?`,
      [freeMembershipCardId(ownerId), ownerId, ownerId],
    )
  }

  const [cards] = await pool.query('SELECT id, packages_json, system_builtin FROM ai_membership_cards')
  for (const card of cards) {
    const membershipPackage = normalizeSingleMembershipPackage(card.packages_json, Boolean(card.system_builtin))
    await pool.query('UPDATE ai_membership_cards SET packages_json = ? WHERE id = ?', [JSON.stringify([membershipPackage]), card.id])
  }
}

async function ensureColumn(table, column, definition) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
     LIMIT 1`,
    [DB_NAME, table, column],
  )
  if (rows.length === 0) {
    try {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    } catch (err) {
      if (err?.code !== 'ER_DUP_FIELDNAME') throw err
    }
  }
}

async function ensureColumnDefinition(table, column, definition) {
  await ensureColumn(table, column, definition)
  await pool.query(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`)
}

async function ensureIndex(table, indexName, definition) {
  const [rows] = await pool.query(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?
     LIMIT 1`,
    [DB_NAME, table, indexName],
  )
  if (rows.length === 0) {
    try {
      await pool.query(`ALTER TABLE ${table} ${definition}`)
    } catch (err) {
      if (err?.code !== 'ER_DUP_KEYNAME') throw err
    }
  }
}

async function seedOrganizationCompatibility({ centerMode = false, supplierId = '', permissionKeys = [] } = {}) {
  const rootId = centerMode ? 'platform' : (String(supplierId || '').trim() || 'local-development')
  const rootName = centerMode ? 'Agent AI 官方平台' : '一级代理根组织'
  const rootLevel = centerMode ? 0 : 1
  const rootDeployment = centerMode ? 'official_center' : 'local'
  await pool.query(
    `INSERT INTO ai_organizations
      (id, external_id, name, organization_type, agent_level, parent_organization_id, root_organization_id,
       business_mode, deployment_mode, runtime_owner_organization_id, legacy_owner_user_id, status)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 'personal', ?, ?, 'admin', 'enabled')
     ON DUPLICATE KEY UPDATE
       external_id=IF(external_id='',VALUES(external_id),external_id),
       name=IF(authorization_version>0,name,VALUES(name)), organization_type=VALUES(organization_type),
       agent_level=VALUES(agent_level), root_organization_id=VALUES(root_organization_id),
       deployment_mode=VALUES(deployment_mode), runtime_owner_organization_id=VALUES(runtime_owner_organization_id),
       legacy_owner_user_id=IF(legacy_owner_user_id='', 'admin', legacy_owner_user_id)`,
    [rootId, rootId, rootName, centerMode ? 'platform' : 'agent', rootLevel, rootId, rootDeployment, rootId],
  )

  const [users] = await pool.query('SELECT id, role, role_template_id, primary_organization_id, status FROM ai_users ORDER BY created_at ASC')
  for (const user of users) {
    const userId = String(user.id || '').trim()
    if (!userId) continue
    if (user.primary_organization_id) {
      const [[existingMember]] = await pool.query(
        'SELECT organization_id FROM ai_organization_members WHERE user_id=? LIMIT 1',
        [userId],
      )
      if (existingMember) continue
    }
    let organizationId = rootId
    let dataScope = centerMode ? 'platform' : 'subtree'
    let isOwner = userId === 'admin' ? 1 : 0
    if (user.role === 'agent') {
      organizationId = `agent-${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24)}`
      dataScope = 'self'
      isOwner = 1
      await pool.query(
        `INSERT INTO ai_organizations
          (id, external_id, name, organization_type, agent_level, parent_organization_id, root_organization_id,
           business_mode, deployment_mode, runtime_owner_organization_id, legacy_owner_user_id, status, created_by_user_id)
          SELECT ?, ?, display_name, 'agent', 2, ?, ?, 'personal', 'inherited', ?, id, status, 'admin'
         FROM ai_users WHERE id=?
         ON DUPLICATE KEY UPDATE name=VALUES(name), parent_organization_id=VALUES(parent_organization_id),
           root_organization_id=VALUES(root_organization_id), runtime_owner_organization_id=VALUES(runtime_owner_organization_id),
           legacy_owner_user_id=VALUES(legacy_owner_user_id), status=VALUES(status)`,
        [organizationId, organizationId, rootId, rootId, rootId, userId],
      )
    }
    await pool.query(
      `INSERT INTO ai_organization_members
        (organization_id, user_id, role_template_id, data_scope, status, is_owner, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'system-migration')
       ON DUPLICATE KEY UPDATE role_template_id=VALUES(role_template_id), data_scope=VALUES(data_scope),
         status=VALUES(status), is_owner=VALUES(is_owner)`,
      [organizationId, userId, user.role_template_id || (user.role === 'admin' ? 'supplier-admin' : 'agent-operator'), dataScope, user.status, isOwner],
    )
    await pool.query('UPDATE ai_users SET primary_organization_id=? WHERE id=? AND (primary_organization_id="" OR primary_organization_id IS NULL)', [organizationId, userId])
  }

  for (const key of [...new Set(['*', ...permissionKeys.filter((item) => !String(item).startsWith('enterprise_'))])]) {
    await pool.query(
      `INSERT IGNORE INTO ai_organization_capabilities
        (organization_id, capability_key, enabled, transferable, limit_value, granted_by_organization_id, granted_by_user_id)
       VALUES (?, ?, 1, ?, 0, ?, 'system-migration')`,
      [rootId, key, key === '*' ? 0 : 1, rootId],
    )
  }
  const [childOrganizations] = await pool.query(
    `SELECT id FROM ai_organizations
     WHERE parent_organization_id=? AND (id LIKE 'agent-%' OR created_by_user_id='system-migration')`,
    [rootId],
  )
  for (const child of childOrganizations) {
    await pool.query(
      `INSERT IGNORE INTO ai_organization_capabilities
        (organization_id, capability_key, enabled, transferable, limit_value, granted_by_organization_id, granted_by_user_id)
       VALUES (?, '*', 1, 0, 0, ?, 'system-migration')`,
      [child.id, rootId],
    )
  }
  await pool.query(
    `DELETE c FROM ai_organization_capabilities c
     JOIN ai_organizations o ON o.id=c.organization_id
     WHERE o.agent_level=2 AND o.id NOT LIKE 'agent-%' AND o.created_by_user_id<>'system-migration'
       AND c.capability_key='*'`,
  )
  await pool.query(
    `UPDATE ai_organization_members m JOIN ai_organizations o ON o.id=m.organization_id
     SET m.data_scope='self'
     WHERE o.agent_level=2 AND m.is_owner=1 AND m.data_scope<>'self'`,
  )
  if (centerMode) {
    const [suppliers] = await pool.query('SELECT id, name, status, business_mode, authorization_version, expires_at FROM ai_center_suppliers')
    for (const supplier of suppliers) {
      await pool.query(
        `INSERT INTO ai_organizations
          (id, external_id, name, organization_type, agent_level, parent_organization_id, root_organization_id,
           business_mode, deployment_mode, runtime_owner_organization_id, authorization_version, status,
           created_by_organization_id, created_by_user_id, expires_at)
          VALUES (?, ?, ?, 'agent', 1, ?, ?, 'personal', 'local', ?, ?, ?, ?, 'system-migration', ?)
          ON DUPLICATE KEY UPDATE name=VALUES(name), business_mode='personal',
           authorization_version=VALUES(authorization_version), status=VALUES(status), expires_at=VALUES(expires_at)`,
        [supplier.id, supplier.id, supplier.name, rootId, rootId, supplier.id,
          Number(supplier.authorization_version || 1), supplier.status, rootId, supplier.expires_at || null],
      )
    }
  }
  return rootId
}

async function seedClientNoticeCapabilities() {
  const [organizations] = await pool.query('SELECT id FROM ai_organizations')
  const connection = await pool.getConnection()
  try {
    for (const organization of organizations) {
      await connection.beginTransaction()
      const [migration] = await connection.query('INSERT IGNORE INTO ai_feature_migrations (migration_key) VALUES (?)', [`client-notices-capabilities-v1:${organization.id}`])
      if (Number(migration.affectedRows || 0) > 0) {
        for (const key of ['client_notices.view', 'client_notices.publish']) {
          await connection.query(`INSERT IGNORE INTO ai_organization_capabilities
            (organization_id,capability_key,enabled,transferable,limit_value,granted_by_organization_id,granted_by_user_id)
            VALUES (?, ?, 1, 1, 0, ?, 'system-migration')`, [organization.id, key, organization.id])
        }
      }
      await connection.commit()
    }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

async function backfillOrganizationOwnership(rootOrganizationId) {
  await pool.query(
    `UPDATE ai_user_groups g
     JOIN ai_user_group_members m ON m.group_id=g.id
     JOIN ai_users u ON u.id=m.user_id
     SET g.organization_id=u.primary_organization_id
     WHERE g.organization_id='' AND u.primary_organization_id<>''`,
  )
  await pool.query('UPDATE ai_user_groups SET organization_id=? WHERE organization_id=""', [rootOrganizationId])
  const ownedTables = [
    'ai_projects', 'ai_builds', 'ai_model_provider_keys', 'ai_end_users', 'ai_membership_cards',
    'ai_end_user_memberships', 'ai_payment_configs', 'ai_payment_orders', 'ai_credit_ledger',
    'ai_redeem_code_batches', 'ai_redeem_codes', 'ai_curated_skills', 'ai_curated_skill_versions',
    'ai_curated_skill_distributions', 'ai_curated_skill_installations', 'ai_curated_skill_events',
    'ai_curated_mcps', 'ai_curated_mcp_versions', 'ai_curated_mcp_distributions', 'ai_curated_mcp_installations',
    'ai_curated_agents', 'ai_curated_agent_distributions', 'ai_curated_agent_installations',
    'ai_model_providers', 'ai_provider_models', 'ai_model_pricing_rules', 'ai_model_upstream_accounts',
    'ai_model_task_capabilities', 'ai_system_voices', 'ai_private_voices', 'ai_voice_operations',
  ]
  for (const table of ownedTables) {
    await ensureColumn(table, 'organization_id', "VARCHAR(64) NOT NULL DEFAULT ''")
    await ensureIndex(table, `idx_${table.replace(/^ai_/, '')}_org`, `ADD INDEX idx_${table.replace(/^ai_/, '')}_org (organization_id)`)
  }

  for (const [table, ownerColumn] of [
    ['ai_projects', 'owner_user_id'], ['ai_builds', 'owner_user_id'], ['ai_model_provider_keys', 'owner_user_id'],
    ['ai_model_upstream_accounts', 'owner_user_id'],
    ['ai_payment_configs', 'owner_user_id'], ['ai_payment_orders', 'owner_user_id'],
    ['ai_curated_skills', 'owner_user_id'], ['ai_curated_skill_distributions', 'owner_user_id'],
    ['ai_curated_skill_installations', 'owner_user_id'], ['ai_curated_skill_events', 'owner_user_id'],
    ['ai_curated_mcps', 'owner_user_id'], ['ai_curated_mcp_distributions', 'owner_user_id'],
    ['ai_curated_mcp_installations', 'owner_user_id'], ['ai_curated_agents', 'owner_user_id'],
    ['ai_curated_agent_distributions', 'owner_user_id'], ['ai_curated_agent_installations', 'owner_user_id'],
  ]) {
    await pool.query(
      `UPDATE ${table} t JOIN ai_organizations o ON o.legacy_owner_user_id=t.${ownerColumn}
       SET t.organization_id=o.id WHERE t.organization_id=''`,
    )
  }
  for (const [table, creatorColumn] of [
    ['ai_membership_cards', 'created_by'], ['ai_end_user_memberships', 'created_by'],
    ['ai_redeem_code_batches', 'created_by'], ['ai_curated_skill_versions', 'created_by'],
    ['ai_curated_mcp_versions', 'created_by'],
  ]) {
    await pool.query(
      `UPDATE ${table} t JOIN ai_organizations o ON o.legacy_owner_user_id=t.${creatorColumn}
       SET t.organization_id=o.id WHERE t.organization_id=''`,
    )
  }
  await pool.query(
    `UPDATE ai_end_users u
     LEFT JOIN ai_projects p ON p.id=u.source_project_id
     JOIN ai_organizations o ON o.legacy_owner_user_id=COALESCE(NULLIF(u.source_agent_id,''), p.owner_user_id, 'admin')
     SET u.organization_id=o.id WHERE u.organization_id=''`,
  )
  for (const table of ['ai_end_user_memberships', 'ai_credit_ledger']) {
    await pool.query(
      `UPDATE ${table} t JOIN ai_end_users u ON u.id=t.user_id
       SET t.organization_id=u.organization_id WHERE t.organization_id='' AND u.organization_id<>''`,
    )
  }
  await pool.query(
    `UPDATE ai_redeem_codes c JOIN ai_redeem_code_batches b ON b.id=c.batch_id
     SET c.organization_id=b.organization_id WHERE c.organization_id='' AND b.organization_id<>''`,
  )
  for (const [table, parentTable, foreignKey] of [
    ['ai_curated_skill_versions', 'ai_curated_skills', 'skill_id'],
    ['ai_curated_mcp_versions', 'ai_curated_mcps', 'mcp_id'],
    ['ai_provider_models', 'ai_model_providers', 'provider_id'],
    ['ai_model_task_capabilities', 'ai_provider_models', 'provider_model_id'],
  ]) {
    await pool.query(
      `UPDATE ${table} t JOIN ${parentTable} p ON p.id=t.${foreignKey}
       SET t.organization_id=p.organization_id WHERE t.organization_id='' AND p.organization_id<>''`,
    )
  }
  await pool.query(
    `UPDATE ai_model_pricing_rules t JOIN ai_model_providers p ON p.id=t.provider_id
     SET t.organization_id=p.organization_id WHERE t.organization_id='' AND p.organization_id<>''`,
  )
  for (const table of ownedTables) {
    await pool.query(`UPDATE ${table} SET organization_id=? WHERE organization_id=''`, [rootOrganizationId])
  }
}

export async function initDatabase(options = {}) {
  const {
    dbHost: DB_HOST,
    dbPort: DB_PORT,
    dbUser: DB_USER,
    dbPassword: DB_PASSWORD,
    dbName,
    adminUser: ADMIN_USER,
    adminPassword: ADMIN_PASSWORD,
    publicUpdateBaseUrl: PUBLIC_UPDATE_BASE_URL,
    defaultPlatformSettings,
    safeUsername,
    hashPassword,
    seedDefaultRoleTemplates,
    seedDefaultModelProviderData,
    setPool,
    centerMode = false,
    supplierId = '',
    permissionKeys = [],
  } = options
  DB_NAME = dbName
  pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: true,
    enableKeepAlive: true,
  })
  if (typeof setPool === 'function') setPool(pool)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_users (
      id VARCHAR(64) PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      display_name VARCHAR(120) NOT NULL,
      role ENUM('admin','agent') NOT NULL DEFAULT 'agent',
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      max_projects INT NOT NULL DEFAULT 0,
      max_builds INT NOT NULL DEFAULT 0,
      password_hash VARCHAR(160) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_organizations (
      id VARCHAR(64) PRIMARY KEY,
      external_id VARCHAR(80) NOT NULL DEFAULT '',
      name VARCHAR(120) NOT NULL,
      organization_type ENUM('platform','agent') NOT NULL DEFAULT 'agent',
      agent_level TINYINT UNSIGNED NOT NULL DEFAULT 2,
      parent_organization_id VARCHAR(64) NULL,
      root_organization_id VARCHAR(64) NOT NULL,
      business_mode ENUM('enterprise','personal','hybrid') NOT NULL DEFAULT 'personal',
      deployment_mode ENUM('official_center','local','inherited') NOT NULL DEFAULT 'inherited',
      runtime_owner_organization_id VARCHAR(64) NOT NULL,
      legacy_owner_user_id VARCHAR(64) NOT NULL DEFAULT '',
      authorization_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      created_by_organization_id VARCHAR(64) NOT NULL DEFAULT '',
      created_by_user_id VARCHAR(64) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uk_ai_organizations_external (external_id),
      KEY idx_ai_organizations_parent (parent_organization_id, status),
      KEY idx_ai_organizations_root (root_organization_id, agent_level, status),
      KEY idx_ai_organizations_runtime (runtime_owner_organization_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumnDefinition('ai_organizations', 'business_mode', "ENUM('enterprise','personal','hybrid') NOT NULL DEFAULT 'personal'")
  await ensureColumn('ai_organizations', 'authorization_version', 'BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER legacy_owner_user_id')
  await ensureColumn('ai_organizations', 'expires_at', 'DATETIME(3) NULL DEFAULT NULL AFTER authorization_version')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_organization_members (
      organization_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      role_template_id VARCHAR(64) NOT NULL DEFAULT '',
      data_scope ENUM('self','children','subtree','platform') NOT NULL DEFAULT 'self',
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      is_owner TINYINT(1) NOT NULL DEFAULT 0,
      created_by VARCHAR(64) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (organization_id, user_id),
      UNIQUE KEY uk_ai_organization_members_user (user_id),
      KEY idx_ai_organization_members_status (organization_id, status),
      CONSTRAINT fk_ai_organization_members_org FOREIGN KEY (organization_id) REFERENCES ai_organizations(id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_organization_members_user FOREIGN KEY (user_id) REFERENCES ai_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_organization_capabilities (
      organization_id VARCHAR(64) NOT NULL,
      capability_key VARCHAR(120) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      transferable TINYINT(1) NOT NULL DEFAULT 0,
      limit_value BIGINT UNSIGNED NOT NULL DEFAULT 0,
      config_json JSON NULL,
      granted_by_organization_id VARCHAR(64) NOT NULL DEFAULT '',
      granted_by_user_id VARCHAR(64) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (organization_id, capability_key),
      KEY idx_ai_organization_capabilities_key (capability_key, enabled),
      CONSTRAINT fk_ai_organization_capabilities_org FOREIGN KEY (organization_id) REFERENCES ai_organizations(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_organization_audit_logs (
      id VARCHAR(64) PRIMARY KEY,
      organization_id VARCHAR(64) NOT NULL,
      actor_user_id VARCHAR(64) NOT NULL DEFAULT '',
      event_type VARCHAR(80) NOT NULL,
      target_type VARCHAR(64) NOT NULL DEFAULT '',
      target_id VARCHAR(64) NOT NULL DEFAULT '',
      detail_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_ai_organization_audit_org (organization_id, created_at),
      KEY idx_ai_organization_audit_target (target_type, target_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_user_groups (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      description VARCHAR(255) NOT NULL DEFAULT '',
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY idx_ai_user_groups_status (status),
      KEY idx_ai_user_groups_sort (sort_order, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_user_groups', 'organization_id', "VARCHAR(64) NOT NULL DEFAULT '' AFTER id")

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_user_group_members (
      group_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (group_id, user_id),
      KEY idx_ai_user_group_members_user (user_id),
      CONSTRAINT fk_ai_user_group_members_group FOREIGN KEY (group_id) REFERENCES ai_user_groups(id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_user_group_members_user FOREIGN KEY (user_id) REFERENCES ai_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_user_group_permissions (
      group_id VARCHAR(64) NOT NULL,
      permission_key VARCHAR(120) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (group_id, permission_key),
      KEY idx_ai_user_group_permissions_key (permission_key),
      CONSTRAINT fk_ai_user_group_permissions_group FOREIGN KEY (group_id) REFERENCES ai_user_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_role_templates (
      id VARCHAR(64) PRIMARY KEY,
      organization_id VARCHAR(64) NOT NULL DEFAULT '',
      name VARCHAR(80) NOT NULL,
      description VARCHAR(255) NOT NULL DEFAULT '',
      base_role ENUM('admin','agent') NOT NULL DEFAULT 'agent',
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      sort_order INT NOT NULL DEFAULT 0,
      system_builtin TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY idx_ai_role_templates_role (base_role, status),
      KEY idx_ai_role_templates_sort (sort_order, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_role_templates', 'organization_id', "VARCHAR(64) NOT NULL DEFAULT '' AFTER id")

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_deleted_builtin_role_templates (
      template_id VARCHAR(64) PRIMARY KEY,
      deleted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_role_template_permissions (
      template_id VARCHAR(64) NOT NULL,
      permission_key VARCHAR(120) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (template_id, permission_key),
      KEY idx_ai_role_template_permissions_key (permission_key),
      CONSTRAINT fk_ai_role_template_permissions_template FOREIGN KEY (template_id) REFERENCES ai_role_templates(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_projects (
      id VARCHAR(64) PRIMARY KEY,
      owner_user_id VARCHAR(64) NOT NULL,
      organization_id VARCHAR(64) NOT NULL DEFAULT '',
      client_mode ENUM('personal','enterprise') NOT NULL DEFAULT 'personal',
      app_name VARCHAR(120) NOT NULL,
      brand_name VARCHAR(120) NOT NULL,
      short_name VARCHAR(120) NOT NULL,
      description VARCHAR(255) NOT NULL DEFAULT '',
      app_id VARCHAR(160) NOT NULL,
      config_dir_name VARCHAR(80) NOT NULL,
      logo_url MEDIUMTEXT NULL,
      contact_qr_url MEDIUMTEXT NULL,
      about_text TEXT NULL,
      official_site_url TEXT NULL,
      docs_url TEXT NULL,
      client_menus JSON NULL,
      theme_color VARCHAR(32) NOT NULL DEFAULT '#2563eb',
      show_github_link TINYINT(1) NOT NULL DEFAULT 0,
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uk_ai_projects_app_id (app_id),
      KEY idx_ai_projects_config_dir_name (config_dir_name),
      KEY idx_ai_projects_owner (owner_user_id),
      CONSTRAINT fk_ai_projects_owner FOREIGN KEY (owner_user_id) REFERENCES ai_users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  const [configDirIndexes] = await pool.query(
    `SHOW INDEX FROM ai_projects WHERE Key_name IN ('uk_ai_projects_config_dir_name', 'idx_ai_projects_config_dir_name')`,
  )
  if (configDirIndexes.some((index) => index.Key_name === 'uk_ai_projects_config_dir_name')) {
    await pool.query('ALTER TABLE ai_projects DROP INDEX uk_ai_projects_config_dir_name')
  }
  if (!configDirIndexes.some((index) => index.Key_name === 'idx_ai_projects_config_dir_name')) {
    await pool.query('ALTER TABLE ai_projects ADD INDEX idx_ai_projects_config_dir_name (config_dir_name)')
  }
  await pool.query("UPDATE ai_projects SET config_dir_name = CONCAT('.', id) WHERE config_dir_name <> CONCAT('.', id)")

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_builds (
      id VARCHAR(64) PRIMARY KEY,
      project_id VARCHAR(64) NOT NULL,
      owner_user_id VARCHAR(64) NOT NULL,
      requested_by VARCHAR(64) NULL,
      version VARCHAR(64) NOT NULL DEFAULT '',
      status ENUM('queued','running','succeeded','failed') NOT NULL DEFAULT 'queued',
      log MEDIUMTEXT NULL,
      error TEXT NULL,
      artifact_dir TEXT NULL,
      public_url TEXT NULL,
      release_url TEXT NULL,
      release_status VARCHAR(32) NOT NULL DEFAULT '',
      release_error TEXT NULL,
      files JSON NULL,
      claimed_by VARCHAR(120) NULL,
      started_at DATETIME(3) NULL,
      finished_at DATETIME(3) NULL,
      released_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY idx_ai_builds_status_created (status, created_at),
      KEY idx_ai_builds_project (project_id),
      KEY idx_ai_builds_owner (owner_user_id),
      CONSTRAINT fk_ai_builds_project FOREIGN KEY (project_id) REFERENCES ai_projects(id),
      CONSTRAINT fk_ai_builds_owner FOREIGN KEY (owner_user_id) REFERENCES ai_users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await ensureColumn('ai_builds', 'release_url', 'TEXT NULL AFTER public_url')
  await ensureColumn('ai_builds', 'release_status', 'VARCHAR(32) NOT NULL DEFAULT \'\' AFTER release_url')
  await ensureColumn('ai_builds', 'release_error', 'TEXT NULL AFTER release_status')
  await ensureColumn('ai_builds', 'released_at', 'DATETIME(3) NULL AFTER finished_at')
  await ensureColumn('ai_builds', 'brand_json', 'JSON NULL AFTER files')
  await ensureColumn('ai_builds', 'transfer_progress', 'JSON NULL AFTER files')
  await ensureColumn('ai_builds', 'remote_build_id', 'VARCHAR(64) NULL AFTER brand_json')
  await ensureColumn('ai_builds', 'center_supplier_id', 'VARCHAR(80) NULL AFTER remote_build_id')
  await ensureColumn('ai_builds', 'center_local_build_id', 'VARCHAR(64) NULL AFTER center_supplier_id')
  await ensureColumn('ai_users', 'max_projects', 'INT NOT NULL DEFAULT 0 AFTER status')
  await ensureColumn('ai_users', 'max_builds', 'INT NOT NULL DEFAULT 0 AFTER max_projects')
  await ensureColumn('ai_users', 'role_template_id', 'VARCHAR(64) NOT NULL DEFAULT "" AFTER role')
  await ensureColumn('ai_users', 'primary_organization_id', "VARCHAR(64) NOT NULL DEFAULT '' AFTER role_template_id")
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_feature_migrations (
      migration_key VARCHAR(120) PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await seedDefaultRoleTemplates()
  await ensureColumnDefinition('ai_projects', 'logo_url', 'MEDIUMTEXT NULL')
  await ensureColumnDefinition('ai_projects', 'icon_url', 'MEDIUMTEXT NULL')
  await ensureColumnDefinition('ai_projects', 'contact_qr_url', 'MEDIUMTEXT NULL')
  await ensureColumnDefinition('ai_projects', 'login_logo_url', 'MEDIUMTEXT NULL')
  await ensureColumnDefinition('ai_projects', 'login_background_url', 'MEDIUMTEXT NULL')
  await ensureColumn('ai_projects', 'login_design', "VARCHAR(24) NOT NULL DEFAULT 'nature' AFTER login_background_url")
  await ensureColumn('ai_projects', 'login_title', 'VARCHAR(160) NOT NULL DEFAULT \'\' AFTER login_background_url')
  await ensureColumn('ai_projects', 'login_subtitle', 'VARCHAR(255) NOT NULL DEFAULT \'\' AFTER login_title')
  await ensureColumn('ai_projects', 'login_hero_title', 'VARCHAR(255) NOT NULL DEFAULT \'\' AFTER login_subtitle')
  await ensureColumn('ai_projects', 'login_hero_subtitle', 'VARCHAR(500) NOT NULL DEFAULT \'\' AFTER login_hero_title')
  await ensureColumn('ai_projects', 'model_tutorial_url', 'TEXT NULL AFTER docs_url')
  await ensureColumn('ai_projects', 'client_menus', 'JSON NULL AFTER model_tutorial_url')
  await ensureColumn('ai_projects', 'client_policy_json', 'JSON NULL')
  await ensureColumn('ai_projects', 'organization_id', "VARCHAR(64) NOT NULL DEFAULT '' AFTER owner_user_id")
  await ensureColumn('ai_projects', 'client_mode', "ENUM('personal','enterprise') NOT NULL DEFAULT 'personal' AFTER organization_id")
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_platform_settings (
      id VARCHAR(64) PRIMARY KEY,
      system_name VARCHAR(120) NOT NULL DEFAULT 'Agent AI',
      system_subtitle VARCHAR(160) NOT NULL DEFAULT 'Admin Console',
      login_title VARCHAR(160) NOT NULL DEFAULT 'Agent AI Admin',
      login_subtitle VARCHAR(255) NOT NULL DEFAULT 'Projects, builds, users, and delivery',
      login_background_url TEXT NULL,
      login_panel_color VARCHAR(32) NOT NULL DEFAULT '#0b2142',
      primary_color VARCHAR(32) NOT NULL DEFAULT '#1677ff',
      logo_text VARCHAR(12) NOT NULL DEFAULT 'Y',
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await pool.query('ALTER TABLE ai_platform_settings MODIFY COLUMN id VARCHAR(64) NOT NULL')
  await pool.query("ALTER TABLE ai_platform_settings MODIFY COLUMN login_panel_color VARCHAR(32) NOT NULL DEFAULT '#0b2142'")
  await ensureColumn('ai_platform_settings', 'login_content_json', 'JSON NULL AFTER login_panel_color')
  await ensureColumn('ai_platform_settings', 'login_crystal_faces_json', 'JSON NULL AFTER logo_text')
  await ensureColumn('ai_platform_settings', 'self_update_manifest_url', 'TEXT NULL AFTER login_crystal_faces_json')
  await ensureColumn('ai_platform_settings', 'build_center_url', 'TEXT NULL AFTER self_update_manifest_url')
  await ensureColumn('ai_platform_settings', 'build_center_supplier_id', 'VARCHAR(80) NULL AFTER build_center_url')
  await ensureColumn('ai_platform_settings', 'build_center_token', 'TEXT NULL AFTER build_center_supplier_id')
  await ensureColumn('ai_platform_settings', 'artifact_storage_mode', 'VARCHAR(24) NOT NULL DEFAULT "local" AFTER build_center_token')
  await ensureColumn('ai_platform_settings', 'oss_access_key_id', 'VARCHAR(160) NULL AFTER artifact_storage_mode')
  await ensureColumn('ai_platform_settings', 'oss_access_key_secret', 'TEXT NULL AFTER oss_access_key_id')
  await ensureColumn('ai_platform_settings', 'oss_bucket', 'VARCHAR(160) NULL AFTER oss_access_key_secret')
  await ensureColumn('ai_platform_settings', 'oss_endpoint', 'VARCHAR(255) NULL AFTER oss_bucket')
  await ensureColumn('ai_platform_settings', 'oss_public_base_url', 'TEXT NULL AFTER oss_endpoint')
  await ensureColumn('ai_platform_settings', 'oss_prefix', 'VARCHAR(255) NULL AFTER oss_public_base_url')
  await ensureColumn('ai_platform_settings', 'model_gateway_base_url', 'TEXT NULL AFTER oss_prefix')
  await ensureColumn('ai_platform_settings', 'model_usage_base_url', 'TEXT NULL AFTER model_gateway_base_url')
  await ensureColumn('ai_platform_settings', 'model_gateway_key', 'TEXT NULL AFTER model_usage_base_url')
  await ensureColumn('ai_platform_settings', 'model_points_per_usd', 'DECIMAL(18,6) NOT NULL DEFAULT 1000 AFTER model_gateway_key')
  await ensureColumn('ai_platform_settings', 'smtp_host', 'VARCHAR(255) NOT NULL DEFAULT "" AFTER model_points_per_usd')
  await ensureColumn('ai_platform_settings', 'smtp_port', 'INT NOT NULL DEFAULT 465 AFTER smtp_host')
  await ensureColumn('ai_platform_settings', 'smtp_secure', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER smtp_port')
  await ensureColumn('ai_platform_settings', 'smtp_user', 'VARCHAR(255) NOT NULL DEFAULT "" AFTER smtp_secure')
  await ensureColumn('ai_platform_settings', 'smtp_pass', 'TEXT NULL AFTER smtp_user')
  await ensureColumn('ai_platform_settings', 'smtp_from_name', 'VARCHAR(120) NOT NULL DEFAULT "Agent AI" AFTER smtp_pass')
  await ensureColumn('ai_platform_settings', 'smtp_from_email', 'VARCHAR(255) NOT NULL DEFAULT "" AFTER smtp_from_name')
  await pool.query(
    `INSERT IGNORE INTO ai_platform_settings (id, system_name, system_subtitle, login_title, login_subtitle, primary_color, logo_text)
     VALUES ('platform', ?, ?, ?, ?, ?, ?)`,
    [
      defaultPlatformSettings.systemName,
      defaultPlatformSettings.systemSubtitle,
      defaultPlatformSettings.loginTitle,
      defaultPlatformSettings.loginSubtitle,
      defaultPlatformSettings.primaryColor,
      defaultPlatformSettings.logoText,
    ],
  )

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_model_providers (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      protocol ENUM('openai-compatible') NOT NULL DEFAULT 'openai-compatible',
      base_url TEXT NOT NULL,
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      timeout_ms INT NOT NULL DEFAULT 120000,
      sort_order INT NOT NULL DEFAULT 0,
      notes VARCHAR(255) NOT NULL DEFAULT '',
      center_sync_hash VARCHAR(64) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY idx_ai_model_providers_status (status),
      KEY idx_ai_model_providers_default (is_default),
      KEY idx_ai_model_providers_sort (sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_model_providers', 'center_sync_hash', 'VARCHAR(64) NOT NULL DEFAULT "" AFTER notes')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_model_upstream_accounts (
      id VARCHAR(64) PRIMARY KEY,
      organization_id VARCHAR(64) NOT NULL DEFAULT '',
      owner_user_id VARCHAR(64) NOT NULL DEFAULT 'admin',
      provider_id VARCHAR(64) NOT NULL,
      name VARCHAR(120) NOT NULL,
      region VARCHAR(64) NOT NULL DEFAULT '',
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      notes VARCHAR(255) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY idx_model_upstream_accounts_scope (organization_id, provider_id, status),
      KEY idx_model_upstream_accounts_owner (owner_user_id, provider_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_model_provider_keys (
      id VARCHAR(64) PRIMARY KEY,
      owner_user_id VARCHAR(64) NOT NULL DEFAULT 'admin',
      provider_id VARCHAR(64) NOT NULL,
      upstream_account_id VARCHAR(64) NOT NULL DEFAULT '',
      provider_model_id VARCHAR(64) NOT NULL DEFAULT '',
      api_key TEXT NOT NULL,
      secret_ciphertext TEXT NULL,
      key_preview VARCHAR(32) NOT NULL DEFAULT '',
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      weight INT NOT NULL DEFAULT 1,
      last_used_at DATETIME(3) NULL,
      success_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
      failure_count INT NOT NULL DEFAULT 0,
      last_error VARCHAR(255) NOT NULL DEFAULT '',
      notes VARCHAR(255) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY idx_ai_model_provider_keys_provider (provider_id),
      KEY idx_ai_model_provider_keys_owner (owner_user_id),
      KEY idx_ai_model_provider_keys_status (status),
      KEY idx_ai_model_provider_keys_rotation (owner_user_id, provider_id, status, last_used_at, failure_count),
      CONSTRAINT fk_ai_model_provider_keys_provider FOREIGN KEY (provider_id) REFERENCES ai_model_providers(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_model_provider_keys', 'owner_user_id', "VARCHAR(64) NOT NULL DEFAULT 'admin' AFTER id")
  await ensureColumn('ai_model_provider_keys', 'upstream_account_id', "VARCHAR(64) NOT NULL DEFAULT '' AFTER provider_id")
  await ensureColumn('ai_model_provider_keys', 'provider_model_id', "VARCHAR(64) NOT NULL DEFAULT '' AFTER provider_id")
  await ensureColumn('ai_model_provider_keys', 'secret_ciphertext', 'TEXT NULL AFTER api_key')
  await ensureColumn('ai_model_provider_keys', 'organization_id', "VARCHAR(64) NOT NULL DEFAULT ''")
  await ensureColumn('ai_model_provider_keys', 'success_count', 'BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER last_used_at')
  await ensureIndex('ai_model_provider_keys', 'idx_ai_model_provider_keys_owner', 'ADD INDEX idx_ai_model_provider_keys_owner (owner_user_id)')
  await ensureIndex('ai_model_provider_keys', 'idx_ai_model_provider_keys_account', 'ADD INDEX idx_ai_model_provider_keys_account (upstream_account_id, status, last_used_at, failure_count)')
  await pool.query(`
    INSERT IGNORE INTO ai_model_upstream_accounts (id, organization_id, owner_user_id, provider_id, name, notes)
    SELECT CONCAT('acct-', LEFT(SHA2(id, 256), 40)),
           organization_id, owner_user_id, provider_id, '待确认上游账号', '既有 Key 独立迁移；未经确认不得与其他 Key 合并'
    FROM ai_model_provider_keys
  `)
  await pool.query(`
    UPDATE ai_model_provider_keys
    SET upstream_account_id = CONCAT('acct-', LEFT(SHA2(id, 256), 40))
    WHERE upstream_account_id = ''
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_provider_models (
      id VARCHAR(64) PRIMARY KEY,
      provider_id VARCHAR(64) NOT NULL,
      model_id VARCHAR(160) NOT NULL,
      display_name VARCHAR(160) NOT NULL,
      description TEXT NULL,
      model_type VARCHAR(32) NOT NULL DEFAULT 'text',
      endpoint_path VARCHAR(255) NOT NULL DEFAULT '',
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      capabilities JSON NULL,
      reasoning_config JSON NULL,
      context_window INT NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      center_sync_hash VARCHAR(64) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uk_ai_provider_models_provider_model (provider_id, model_id),
      KEY idx_ai_provider_models_provider (provider_id),
      KEY idx_ai_provider_models_status (status),
      KEY idx_ai_provider_models_default (is_default),
      CONSTRAINT fk_ai_provider_models_provider FOREIGN KEY (provider_id) REFERENCES ai_model_providers(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_provider_models', 'model_type', "VARCHAR(32) NOT NULL DEFAULT 'text' AFTER display_name")
  await ensureColumn('ai_provider_models', 'description', 'TEXT NULL AFTER display_name')
  await ensureColumn('ai_provider_models', 'endpoint_path', "VARCHAR(255) NOT NULL DEFAULT '' AFTER model_type")
  await ensureColumn('ai_provider_models', 'reasoning_config', 'JSON NULL AFTER capabilities')
  await ensureColumn('ai_provider_models', 'center_sync_hash', 'VARCHAR(64) NOT NULL DEFAULT "" AFTER sort_order')
  await ensureColumn('ai_provider_models', 'organization_id', "VARCHAR(64) NOT NULL DEFAULT ''")
  await ensureColumn('ai_provider_models', 'archived_at', 'DATETIME(3) NULL')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_model_task_capabilities (
      id VARCHAR(64) PRIMARY KEY,
      organization_id VARCHAR(64) NOT NULL DEFAULT '',
      provider_model_id VARCHAR(64) NOT NULL,
      task_type VARCHAR(48) NOT NULL,
      protocol_adapter VARCHAR(64) NOT NULL,
      upstream_account_id VARCHAR(64) NULL,
      connection_role VARCHAR(48) NOT NULL DEFAULT '',
      endpoint_path VARCHAR(255) NOT NULL DEFAULT '',
      config_json JSON NULL,
      config_revision BIGINT NOT NULL DEFAULT 1,
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uk_model_task_capability (provider_model_id, task_type),
      KEY idx_model_task_capabilities_scope (organization_id, task_type, status),
      CONSTRAINT fk_model_task_capabilities_model FOREIGN KEY (provider_model_id) REFERENCES ai_provider_models(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_model_task_capabilities', 'upstream_account_id', 'VARCHAR(64) NULL AFTER protocol_adapter')
  await ensureColumn('ai_model_task_capabilities', 'connection_role', "VARCHAR(48) NOT NULL DEFAULT '' AFTER upstream_account_id")
  await ensureColumn('ai_model_task_capabilities', 'config_revision', 'BIGINT NOT NULL DEFAULT 1 AFTER config_json')
  await pool.query(`UPDATE ai_model_task_capabilities c
    JOIN ai_provider_models m ON m.id=c.provider_model_id
    JOIN ai_model_provider_keys k ON k.provider_id=m.provider_id AND k.organization_id=c.organization_id
      AND k.status='enabled' AND k.secret_ciphertext IS NOT NULL
    JOIN ai_model_upstream_accounts a ON a.id=k.upstream_account_id AND a.status='enabled'
    SET c.upstream_account_id=a.id
    WHERE c.protocol_adapter='minimax.t2a' AND (c.upstream_account_id IS NULL OR c.upstream_account_id='')
      AND (SELECT COUNT(*) FROM ai_model_provider_keys x WHERE x.provider_id=m.provider_id
        AND x.organization_id=c.organization_id AND x.status='enabled' AND x.secret_ciphertext IS NOT NULL)=1`)
  await pool.query(`UPDATE ai_model_task_capabilities c
    JOIN ai_provider_models m ON m.id=c.provider_model_id
    JOIN ai_model_upstream_accounts a ON a.provider_id=m.provider_id AND a.organization_id=c.organization_id
    SET c.upstream_account_id=a.id
    WHERE c.protocol_adapter='minimax.t2a' AND (c.upstream_account_id IS NULL OR c.upstream_account_id='')
      AND (SELECT COUNT(*) FROM ai_model_upstream_accounts x WHERE x.provider_id=m.provider_id AND x.organization_id=c.organization_id)=1`)
  await pool.query(`
    INSERT IGNORE INTO ai_model_task_capabilities
      (id, organization_id, provider_model_id, task_type, protocol_adapter, endpoint_path, config_json, status)
    SELECT CONCAT('cap-', LEFT(SHA2(CONCAT(id, ':', model_type), 256), 40)), organization_id, id,
      CASE model_type WHEN 'text' THEN 'chat' WHEN 'image' THEN 'image_generation'
        WHEN 'video' THEN 'video_generation' WHEN 'audio' THEN 'speech_synthesis'
        WHEN 'search' THEN 'web_search' ELSE model_type END,
      'legacy.compatible',
      endpoint_path, JSON_OBJECT(), status
    FROM ai_provider_models
    WHERE model_type IN ('text', 'image', 'search')
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_model_pricing_rules (
      id VARCHAR(64) PRIMARY KEY,
      organization_id VARCHAR(64) NOT NULL DEFAULT '',
      provider_id VARCHAR(64) NOT NULL,
      provider_model_id VARCHAR(64) NOT NULL,
      billing_type ENUM('per_token','per_request','per_image_resolution') NOT NULL DEFAULT 'per_token',
      input_points_per_m_tokens DECIMAL(18,6) NOT NULL DEFAULT 0,
      output_points_per_m_tokens DECIMAL(18,6) NOT NULL DEFAULT 0,
      points_per_request DECIMAL(18,6) NOT NULL DEFAULT 0,
      resolution_points JSON NULL,
      input_cost_points_per_m_tokens DECIMAL(18,6) NOT NULL DEFAULT 0,
      output_cost_points_per_m_tokens DECIMAL(18,6) NOT NULL DEFAULT 0,
      cost_points_per_request DECIMAL(18,6) NOT NULL DEFAULT 0,
      resolution_cost_points JSON NULL,
      consumption_multiplier DECIMAL(12,6) NOT NULL DEFAULT 1,
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      center_sync_hash VARCHAR(64) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uk_ai_model_pricing_rules_model (provider_model_id),
      KEY idx_ai_model_pricing_rules_provider (provider_id),
      KEY idx_ai_model_pricing_rules_status (status),
      CONSTRAINT fk_ai_model_pricing_rules_provider FOREIGN KEY (provider_id) REFERENCES ai_model_providers(id),
      CONSTRAINT fk_ai_model_pricing_rules_model FOREIGN KEY (provider_model_id) REFERENCES ai_provider_models(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_model_pricing_rules', 'center_sync_hash', 'VARCHAR(64) NOT NULL DEFAULT "" AFTER status')
  await ensureColumnDefinition('ai_model_pricing_rules', 'billing_type', "ENUM('per_token','per_request','per_image_resolution') NOT NULL DEFAULT 'per_token'")
  await ensureColumn('ai_model_pricing_rules', 'resolution_points', 'JSON NULL AFTER points_per_request')
  await ensureColumn('ai_model_pricing_rules', 'input_cost_points_per_m_tokens', 'DECIMAL(18,6) NULL DEFAULT NULL AFTER resolution_points')
  await ensureColumn('ai_model_pricing_rules', 'output_cost_points_per_m_tokens', 'DECIMAL(18,6) NULL DEFAULT NULL AFTER input_cost_points_per_m_tokens')
  await ensureColumn('ai_model_pricing_rules', 'cost_points_per_request', 'DECIMAL(18,6) NULL DEFAULT NULL AFTER output_cost_points_per_m_tokens')
  await ensureColumn('ai_model_pricing_rules', 'resolution_cost_points', 'JSON NULL AFTER cost_points_per_request')
  await ensureColumn('ai_model_pricing_rules', 'consumption_multiplier', 'DECIMAL(12,6) NOT NULL DEFAULT 1 AFTER resolution_cost_points')
  await ensureColumn('ai_model_pricing_rules', 'voice_preview_points', 'DECIMAL(18,6) NULL DEFAULT NULL AFTER points_per_request')
  await ensureColumn('ai_model_pricing_rules', 'voice_activation_points', 'DECIMAL(18,6) NULL DEFAULT NULL AFTER voice_preview_points')
  await ensureColumn('ai_model_pricing_rules', 'voice_points_per_1k_chars', 'DECIMAL(18,6) NULL DEFAULT NULL AFTER voice_activation_points')
  await pool.query(`UPDATE ai_model_pricing_rules SET
    input_cost_points_per_m_tokens = COALESCE(input_cost_points_per_m_tokens, input_points_per_m_tokens),
    output_cost_points_per_m_tokens = COALESCE(output_cost_points_per_m_tokens, output_points_per_m_tokens),
    cost_points_per_request = COALESCE(cost_points_per_request, points_per_request),
    resolution_cost_points = COALESCE(resolution_cost_points, resolution_points, JSON_OBJECT())`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_currency_exchange_rates (
      organization_id VARCHAR(64) NOT NULL DEFAULT '',
      currency CHAR(3) NOT NULL,
      cny_rate DECIMAL(18,8) NOT NULL,
      updated_by VARCHAR(64) NOT NULL DEFAULT '',
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (organization_id, currency)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_model_pricing_rules', 'organization_id', "VARCHAR(64) NOT NULL DEFAULT '' AFTER id")
  await pool.query("INSERT IGNORE INTO ai_currency_exchange_rates (organization_id,currency,cny_rate) VALUES ('','CNY',1)")

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_model_pricing_plans (
      id VARCHAR(64) PRIMARY KEY,
      organization_id VARCHAR(64) NOT NULL DEFAULT '',
      provider_model_id VARCHAR(64) NOT NULL,
      capability_id VARCHAR(64) NOT NULL,
      task_type VARCHAR(48) NOT NULL,
      version INT NOT NULL DEFAULT 1,
      status ENUM('draft','enabled','disabled') NOT NULL DEFAULT 'draft',
      consumption_multiplier DECIMAL(12,6) NOT NULL DEFAULT 1,
      effective_at DATETIME(3) NULL,
      sync_source VARCHAR(24) NOT NULL DEFAULT '',
      center_sync_hash VARCHAR(64) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uk_model_pricing_plan_version (capability_id, version),
      KEY idx_model_pricing_plan_active (organization_id, task_type, status),
      CONSTRAINT fk_model_pricing_plan_model FOREIGN KEY (provider_model_id) REFERENCES ai_provider_models(id) ON DELETE CASCADE,
      CONSTRAINT fk_model_pricing_plan_capability FOREIGN KEY (capability_id) REFERENCES ai_model_task_capabilities(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_model_pricing_plans', 'sync_source', "VARCHAR(24) NOT NULL DEFAULT '' AFTER effective_at")
  await ensureColumn('ai_model_pricing_plans', 'center_sync_hash', "VARCHAR(64) NOT NULL DEFAULT '' AFTER sync_source")
  await ensureColumn('ai_model_pricing_plans', 'consumption_multiplier', 'DECIMAL(12,6) NOT NULL DEFAULT 1 AFTER status')
  await pool.query(`UPDATE ai_model_pricing_plans p JOIN ai_model_pricing_rules r ON r.provider_model_id=p.provider_model_id
    SET p.consumption_multiplier=r.consumption_multiplier WHERE p.consumption_multiplier=1 AND r.consumption_multiplier<>1`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_model_pricing_components (
      id VARCHAR(64) PRIMARY KEY,
      plan_id VARCHAR(64) NOT NULL,
      meter_code VARCHAR(48) NOT NULL,
      charge_phase VARCHAR(32) NOT NULL DEFAULT 'usage',
      unit_size DECIMAL(24,8) NOT NULL DEFAULT 1,
      minimum_units DECIMAL(24,8) NOT NULL DEFAULT 0,
      rounding_mode VARCHAR(16) NOT NULL DEFAULT 'none',
      dimensions_json JSON NULL,
      cost_amount DECIMAL(24,8) NOT NULL DEFAULT 0,
      cost_currency CHAR(3) NOT NULL DEFAULT 'CNY',
      sale_points DECIMAL(24,8) NOT NULL DEFAULT 0,
      metadata_json JSON NULL,
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY idx_model_pricing_components_plan (plan_id, status, sort_order),
      CONSTRAINT fk_model_pricing_component_plan FOREIGN KEY (plan_id) REFERENCES ai_model_pricing_plans(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    INSERT IGNORE INTO ai_model_pricing_plans
      (id,organization_id,provider_model_id,capability_id,task_type,version,status,consumption_multiplier,effective_at)
    SELECT CONCAT('plan-',LEFT(SHA2(CONCAT(r.id,':',c.id,':v2'),256),40)), r.organization_id, r.provider_model_id,
      c.id, c.task_type, 1, IF(r.status='enabled','enabled','disabled'), r.consumption_multiplier, r.created_at
    FROM ai_model_pricing_rules r
    JOIN ai_model_task_capabilities c ON c.provider_model_id=r.provider_model_id
    WHERE c.task_type IN ('chat','image_generation','speech_synthesis','web_search')
      AND NOT EXISTS (SELECT 1 FROM ai_model_pricing_plans existing WHERE existing.capability_id=c.id)
  `)
  await pool.query(`
    UPDATE ai_model_pricing_plans legacy
    JOIN ai_model_pricing_rules r ON r.provider_model_id=legacy.provider_model_id
    JOIN ai_model_pricing_plans newer ON newer.capability_id=legacy.capability_id
      AND newer.version>legacy.version AND newer.status='enabled'
    SET legacy.status='disabled'
    WHERE legacy.id=CONCAT('plan-',LEFT(SHA2(CONCAT(r.id,':',legacy.capability_id,':v2'),256),40))
      AND legacy.status='enabled'
  `)
  await pool.query(`
    INSERT IGNORE INTO ai_model_pricing_components
      (id,plan_id,meter_code,charge_phase,unit_size,cost_amount,cost_currency,sale_points,metadata_json,sort_order)
    SELECT CONCAT('pc-',LEFT(SHA2(CONCAT(p.id,':input'),256),40)), p.id,
      'input_tokens','usage',1000000,0,'CNY',r.input_points_per_m_tokens,
      JSON_OBJECT('migration','legacy_cost_points','value',COALESCE(r.input_cost_points_per_m_tokens,0)),10
    FROM ai_model_pricing_rules r JOIN ai_model_pricing_plans p ON p.provider_model_id=r.provider_model_id AND p.task_type IN ('chat','web_search','rerank')
      AND p.id=CONCAT('plan-',LEFT(SHA2(CONCAT(r.id,':',p.capability_id,':v2'),256),40)) WHERE r.billing_type='per_token'
  `)
  await pool.query(`
    INSERT IGNORE INTO ai_model_pricing_components
      (id,plan_id,meter_code,charge_phase,unit_size,cost_amount,cost_currency,sale_points,metadata_json,sort_order)
    SELECT CONCAT('pc-',LEFT(SHA2(CONCAT(p.id,':output'),256),40)), p.id,
      'output_tokens','usage',1000000,0,'CNY',r.output_points_per_m_tokens,
      JSON_OBJECT('migration','legacy_cost_points','value',COALESCE(r.output_cost_points_per_m_tokens,0)),20
    FROM ai_model_pricing_rules r JOIN ai_model_pricing_plans p ON p.provider_model_id=r.provider_model_id AND p.task_type IN ('chat','web_search','rerank')
      AND p.id=CONCAT('plan-',LEFT(SHA2(CONCAT(r.id,':',p.capability_id,':v2'),256),40)) WHERE r.billing_type='per_token'
  `)
  await pool.query(`
    INSERT IGNORE INTO ai_model_pricing_components
      (id,plan_id,meter_code,charge_phase,unit_size,cost_amount,cost_currency,sale_points,metadata_json,sort_order)
    SELECT CONCAT('pc-',LEFT(SHA2(CONCAT(p.id,':request'),256),40)), p.id,
      'request','request',1,0,'CNY',r.points_per_request,
      JSON_OBJECT('migration','legacy_cost_points','value',COALESCE(r.cost_points_per_request,0)),10
    FROM ai_model_pricing_rules r JOIN ai_model_pricing_plans p ON p.provider_model_id=r.provider_model_id
      AND p.id=CONCAT('plan-',LEFT(SHA2(CONCAT(r.id,':',p.capability_id,':v2'),256),40)) WHERE r.billing_type='per_request'
  `)
  for (const tier of ['1K', '1.5K', '2K']) {
    await pool.query(`
      INSERT IGNORE INTO ai_model_pricing_components
        (id,plan_id,meter_code,charge_phase,unit_size,dimensions_json,cost_amount,cost_currency,sale_points,metadata_json,sort_order)
      SELECT CONCAT('pc-',LEFT(SHA2(CONCAT(p.id,':image:${tier}'),256),40)), p.id,
        'image','usage',1,JSON_OBJECT('resolution',?),0,'CNY',COALESCE(JSON_EXTRACT(r.resolution_points, ?),0),
        JSON_OBJECT('migration','legacy_cost_points','value',COALESCE(JSON_EXTRACT(r.resolution_cost_points, ?),0)),10
      FROM ai_model_pricing_rules r JOIN ai_model_pricing_plans p ON p.provider_model_id=r.provider_model_id AND p.task_type IN ('image_generation','image_edit')
        AND p.id=CONCAT('plan-',LEFT(SHA2(CONCAT(r.id,':',p.capability_id,':v2'),256),40)) WHERE r.billing_type='per_image_resolution'
    `, [tier, `$."${tier}"`, `$."${tier}"`])
  }
  await pool.query(`
    INSERT IGNORE INTO ai_model_pricing_components
      (id,plan_id,meter_code,charge_phase,unit_size,cost_amount,cost_currency,sale_points,metadata_json,sort_order)
    SELECT CONCAT('pc-',LEFT(SHA2(CONCAT(p.id,':voice-preview'),256),40)), p.id,
      'billable_characters','preview',1000,0,'CNY',r.voice_preview_points,JSON_OBJECT('migration','legacy_voice_price'),30
    FROM ai_model_pricing_rules r JOIN ai_model_pricing_plans p ON p.provider_model_id=r.provider_model_id AND p.task_type='speech_synthesis'
      AND p.id=CONCAT('plan-',LEFT(SHA2(CONCAT(r.id,':',p.capability_id,':v2'),256),40)) WHERE r.voice_preview_points IS NOT NULL
  `)
  await pool.query(`
    INSERT IGNORE INTO ai_model_pricing_components
      (id,plan_id,meter_code,charge_phase,unit_size,cost_amount,cost_currency,sale_points,metadata_json,sort_order)
    SELECT CONCAT('pc-',LEFT(SHA2(CONCAT(p.id,':voice-activation'),256),40)), p.id,
      'resource_activation','activation',1,0,'CNY',r.voice_activation_points,JSON_OBJECT('migration','legacy_voice_price'),40
    FROM ai_model_pricing_rules r JOIN ai_model_pricing_plans p ON p.provider_model_id=r.provider_model_id AND p.task_type='speech_synthesis'
      AND p.id=CONCAT('plan-',LEFT(SHA2(CONCAT(r.id,':',p.capability_id,':v2'),256),40)) WHERE r.voice_activation_points IS NOT NULL
  `)
  await pool.query(`
    INSERT IGNORE INTO ai_model_pricing_components
      (id,plan_id,meter_code,charge_phase,unit_size,cost_amount,cost_currency,sale_points,metadata_json,sort_order)
    SELECT CONCAT('pc-',LEFT(SHA2(CONCAT(p.id,':voice-usage'),256),40)), p.id,
      'billable_characters','usage',1000,0,'CNY',r.voice_points_per_1k_chars,JSON_OBJECT('migration','legacy_voice_price'),50
    FROM ai_model_pricing_rules r JOIN ai_model_pricing_plans p ON p.provider_model_id=r.provider_model_id AND p.task_type='speech_synthesis'
      AND p.id=CONCAT('plan-',LEFT(SHA2(CONCAT(r.id,':',p.capability_id,':v2'),256),40)) WHERE r.voice_points_per_1k_chars IS NOT NULL
  `)

  // Older V2 builds re-applied legacy components to every version of a model's
  // plan. Remove only the generated legacy row when an explicit component with
  // the same semantic key exists, preserving both manual prices and audit data.
  await pool.query(`
    DELETE legacy FROM ai_model_pricing_components legacy
    JOIN ai_model_pricing_components explicit_component
      ON explicit_component.plan_id=legacy.plan_id AND explicit_component.id<>legacy.id
      AND explicit_component.meter_code=legacy.meter_code
      AND explicit_component.charge_phase=legacy.charge_phase
      AND COALESCE(explicit_component.dimensions_json,JSON_OBJECT())=COALESCE(legacy.dimensions_json,JSON_OBJECT())
    WHERE legacy.id LIKE 'pc-%' AND explicit_component.id NOT LIKE 'pc-%'
      AND JSON_UNQUOTE(JSON_EXTRACT(legacy.metadata_json,'$.migration')) IN ('legacy_cost_points','legacy_voice_price')
  `)

  await consolidatePricingPlans(pool)
  await ensureIndex('ai_model_pricing_plans', 'uk_pricing_current_capability_org', 'ADD UNIQUE INDEX uk_pricing_current_capability_org (capability_id, organization_id)')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_model_operations (
      id VARCHAR(64) PRIMARY KEY,
      organization_id VARCHAR(64) NOT NULL DEFAULT '',
      user_id VARCHAR(64) NOT NULL,
      capability_id VARCHAR(64) NOT NULL,
      upstream_account_id VARCHAR(64) NOT NULL DEFAULT '',
      task_type VARCHAR(48) NOT NULL,
      operation_type VARCHAR(48) NOT NULL,
      idempotency_key VARCHAR(128) NOT NULL,
      input_fingerprint CHAR(64) NOT NULL,
      adapter_id VARCHAR(64) NOT NULL,
      config_revision BIGINT NOT NULL,
      status ENUM('pending','running','succeeded','failed','outcome_unknown') NOT NULL DEFAULT 'pending',
      job_handle_json JSON NULL,
      pricing_snapshot_json JSON NOT NULL,
      usage_json JSON NULL,
      result_json JSON NULL,
      points_reserved DECIMAL(24,8) NOT NULL DEFAULT 0,
      points_settled DECIMAL(24,8) NOT NULL DEFAULT 0,
      cost_snapshot_json JSON NULL,
      error_kind VARCHAR(48) NOT NULL DEFAULT '',
      error_code VARCHAR(80) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      completed_at DATETIME(3) NULL,
      UNIQUE KEY uk_model_operation_idempotency (user_id, operation_type, idempotency_key),
      KEY idx_model_operations_status (status, updated_at),
      KEY idx_model_operations_scope (organization_id, user_id, created_at),
      KEY idx_model_operations_account (upstream_account_id, status, updated_at),
      CONSTRAINT fk_model_operation_capability FOREIGN KEY (capability_id) REFERENCES ai_model_task_capabilities(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_model_operations', 'upstream_account_id', "VARCHAR(64) NOT NULL DEFAULT '' AFTER capability_id")
  await ensureIndex('ai_model_operations', 'idx_model_operations_account', 'ADD INDEX idx_model_operations_account (upstream_account_id, status, updated_at)')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_system_voices (
      id VARCHAR(64) PRIMARY KEY,
      organization_id VARCHAR(64) NOT NULL DEFAULT '',
      provider_model_id VARCHAR(64) NOT NULL,
      upstream_account_id VARCHAR(64) NOT NULL,
      provider_voice_id VARCHAR(256) NOT NULL,
      display_name VARCHAR(120) NOT NULL,
      description VARCHAR(512) NOT NULL DEFAULT '',
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uk_system_voice_provider_id (upstream_account_id, provider_model_id, provider_voice_id),
      KEY idx_system_voices_scope (organization_id, provider_model_id, status),
      CONSTRAINT fk_system_voices_model FOREIGN KEY (provider_model_id) REFERENCES ai_provider_models(id),
      CONSTRAINT fk_system_voices_account FOREIGN KEY (upstream_account_id) REFERENCES ai_model_upstream_accounts(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_private_voices (
      id VARCHAR(64) PRIMARY KEY,
      organization_id VARCHAR(64) NOT NULL DEFAULT '',
      user_id VARCHAR(64) NOT NULL,
      provider_id VARCHAR(64) NOT NULL,
      provider_model_id VARCHAR(64) NOT NULL,
      upstream_account_id VARCHAR(64) NOT NULL,
      provider_voice_id VARCHAR(256) NOT NULL,
      display_name VARCHAR(120) NOT NULL,
      status ENUM('training','preview_ready','activating','active','outcome_unknown','failed','delete_pending','deleted') NOT NULL DEFAULT 'training',
      active_operation_id VARCHAR(64) NOT NULL DEFAULT '',
      consent_at DATETIME(3) NOT NULL,
      preview_url TEXT NULL,
      expires_at DATETIME(3) NULL,
      activated_at DATETIME(3) NULL,
      deleted_at DATETIME(3) NULL,
      last_error VARCHAR(512) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uk_private_voice_provider_id (upstream_account_id, provider_voice_id),
      KEY idx_private_voices_owner (organization_id, user_id, status),
      CONSTRAINT fk_private_voices_model FOREIGN KEY (provider_model_id) REFERENCES ai_provider_models(id),
      CONSTRAINT fk_private_voices_account FOREIGN KEY (upstream_account_id) REFERENCES ai_model_upstream_accounts(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_voice_operations (
      id VARCHAR(64) PRIMARY KEY,
      organization_id VARCHAR(64) NOT NULL DEFAULT '',
      user_id VARCHAR(64) NOT NULL,
      voice_id VARCHAR(64) NOT NULL DEFAULT '',
      operation_type ENUM('clone','preview','activate','synthesize','delete') NOT NULL,
      idempotency_key VARCHAR(128) NOT NULL,
      input_fingerprint CHAR(64) NOT NULL,
      status ENUM('pending','running','succeeded','failed','outcome_unknown') NOT NULL DEFAULT 'pending',
      provider_key_id VARCHAR(64) NOT NULL DEFAULT '',
      provider_request_id VARCHAR(128) NOT NULL DEFAULT '',
      upstream_file_id VARCHAR(32) NOT NULL DEFAULT '',
      cleanup_pending TINYINT(1) NOT NULL DEFAULT 0,
      points_reserved DECIMAL(18,6) NOT NULL DEFAULT 0,
      points_settled DECIMAL(18,6) NOT NULL DEFAULT 0,
      input_path TEXT NULL,
      result_json JSON NULL,
      error_code VARCHAR(80) NOT NULL DEFAULT '',
      error_message VARCHAR(512) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      completed_at DATETIME(3) NULL,
      UNIQUE KEY uk_voice_operation_idempotency (user_id, operation_type, idempotency_key),
      KEY idx_voice_operations_status (status, updated_at),
      KEY idx_voice_operations_voice (voice_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_workers (
      id VARCHAR(120) PRIMARY KEY,
      status ENUM('online','offline') NOT NULL DEFAULT 'online',
      current_build_id VARCHAR(64) NOT NULL DEFAULT '',
      last_seen_at DATETIME(3) NULL,
      last_claimed_at DATETIME(3) NULL,
      last_completed_at DATETIME(3) NULL,
      metadata_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY idx_ai_workers_last_seen (last_seen_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_center_suppliers (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      notes VARCHAR(500) NOT NULL DEFAULT '',
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      license_type VARCHAR(32) NOT NULL DEFAULT 'partner',
      expires_at DATETIME(3) NULL DEFAULT NULL,
      token_hash VARCHAR(96) NOT NULL,
      token_preview VARCHAR(16) NOT NULL DEFAULT '',
      max_projects INT NOT NULL DEFAULT 0,
      max_builds INT NOT NULL DEFAULT 0,
      build_count INT NOT NULL DEFAULT 0,
      project_registry_initialized TINYINT(1) NOT NULL DEFAULT 0,
      allow_agent_management TINYINT(1) NOT NULL DEFAULT 1,
      allow_supplier_management TINYINT(1) NOT NULL DEFAULT 0,
      allow_platform_settings TINYINT(1) NOT NULL DEFAULT 1,
      allow_custom_brand TINYINT(1) NOT NULL DEFAULT 1,
      allow_custom_api_providers TINYINT(1) NOT NULL DEFAULT 0,
      organization_id VARCHAR(64) NOT NULL DEFAULT '',
      business_mode ENUM('enterprise','personal','hybrid') NOT NULL DEFAULT 'personal',
      authorization_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
      last_seen_at DATETIME(3) NULL,
      last_build_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY idx_ai_center_suppliers_status (status),
      KEY idx_ai_center_suppliers_last_seen (last_seen_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_center_suppliers', 'notes', "VARCHAR(500) NOT NULL DEFAULT '' AFTER name")
  await ensureColumn('ai_center_suppliers', 'license_type', "VARCHAR(32) NOT NULL DEFAULT 'partner' AFTER status")
  await ensureColumn('ai_center_suppliers', 'expires_at', 'DATETIME(3) NULL DEFAULT NULL AFTER license_type')
  await ensureColumn('ai_center_suppliers', 'max_projects', 'INT NOT NULL DEFAULT 0 AFTER token_preview')
  await ensureColumn('ai_center_suppliers', 'project_registry_initialized', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER build_count')
  await ensureColumn('ai_center_suppliers', 'allow_agent_management', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER build_count')
  await ensureColumn('ai_center_suppliers', 'allow_supplier_management', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER allow_agent_management')
  await ensureColumn('ai_center_suppliers', 'allow_platform_settings', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER allow_supplier_management')
  await ensureColumn('ai_center_suppliers', 'allow_custom_brand', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER allow_platform_settings')
  await ensureColumn('ai_center_suppliers', 'allow_custom_api_providers', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER allow_custom_brand')
  await ensureColumn('ai_center_suppliers', 'organization_id', "VARCHAR(64) NOT NULL DEFAULT '' AFTER allow_custom_api_providers")
  await ensureColumnDefinition('ai_center_suppliers', 'business_mode', "ENUM('enterprise','personal','hybrid') NOT NULL DEFAULT 'personal' AFTER organization_id")
  await ensureColumn('ai_center_suppliers', 'authorization_version', 'BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER business_mode')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_center_supplier_projects (
      supplier_id VARCHAR(64) NOT NULL,
      project_id VARCHAR(64) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (supplier_id, project_id),
      KEY idx_ai_center_supplier_projects_project (project_id),
      CONSTRAINT fk_ai_center_supplier_projects_supplier FOREIGN KEY (supplier_id) REFERENCES ai_center_suppliers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_end_users (
      id VARCHAR(64) PRIMARY KEY,
      username VARCHAR(120) NOT NULL UNIQUE,
      display_name VARCHAR(120) NOT NULL,
      password_hash VARCHAR(160) NOT NULL,
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      source_supplier_id VARCHAR(80) NOT NULL DEFAULT '',
      source_agent_id VARCHAR(80) NOT NULL DEFAULT '',
      source_project_id VARCHAR(80) NOT NULL DEFAULT '',
      source_build_id VARCHAR(120) NOT NULL DEFAULT '',
      center_project_id VARCHAR(80) NOT NULL DEFAULT '',
      channel_code VARCHAR(120) NOT NULL DEFAULT '',
      app_version VARCHAR(64) NOT NULL DEFAULT '',
      device_id VARCHAR(160) NOT NULL DEFAULT '',
      device_name VARCHAR(160) NOT NULL DEFAULT '',
      credit_balance DECIMAL(18,6) NOT NULL DEFAULT 0,
      model_gateway_key TEXT NULL,
      model_points_per_usd DECIMAL(18,6) NOT NULL DEFAULT 0,
      last_login_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY idx_ai_end_users_source_supplier (source_supplier_id),
      KEY idx_ai_end_users_source_agent (source_agent_id),
      KEY idx_ai_end_users_source_project (source_project_id),
      KEY idx_ai_end_users_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_end_users', 'email', 'VARCHAR(190) NULL AFTER username')
  await ensureIndex('ai_end_users', 'uk_ai_end_users_email', 'ADD UNIQUE KEY uk_ai_end_users_email (email)')
  await ensureColumn('ai_end_users', 'credit_balance', 'DECIMAL(18,6) NOT NULL DEFAULT 0 AFTER device_name')
  await ensureColumn('ai_end_users', 'model_gateway_key', 'TEXT NULL AFTER credit_balance')
  await ensureColumn('ai_end_users', 'model_points_per_usd', 'DECIMAL(18,6) NOT NULL DEFAULT 0 AFTER model_gateway_key')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_client_notices (
      id VARCHAR(64) PRIMARY KEY,
      source_center_id VARCHAR(64) NULL,
      organization_id VARCHAR(64) NOT NULL DEFAULT '',
      created_by VARCHAR(64) NOT NULL,
      category ENUM('notice','announcement','activity') NOT NULL,
      title VARCHAR(120) NOT NULL,
      summary VARCHAR(240) NOT NULL,
      body TEXT NOT NULL,
      action_label VARCHAR(40) NOT NULL DEFAULT '',
      action_url VARCHAR(2048) NOT NULL DEFAULT '',
      target_type ENUM('all','organization','project','users') NOT NULL DEFAULT 'all',
      target_ids JSON NULL,
      status ENUM('draft','published','revoked') NOT NULL DEFAULT 'draft',
      expires_at DATETIME(3) NULL,
      published_at DATETIME(3) NULL,
      revoked_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY idx_ai_client_notices_org_created (organization_id, created_at),
      UNIQUE KEY uk_ai_client_notices_source_center (source_center_id),
      KEY idx_ai_client_notices_status_published (status, published_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_client_notices', 'source_center_id', 'VARCHAR(64) NULL AFTER id')
  await ensureIndex('ai_client_notices', 'uk_ai_client_notices_source_center', 'ADD UNIQUE KEY uk_ai_client_notices_source_center (source_center_id)')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_client_notice_directory (
      supplier_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      username VARCHAR(120) NOT NULL,
      display_name VARCHAR(120) NOT NULL,
      organization_id VARCHAR(64) NOT NULL DEFAULT '',
      project_id VARCHAR(80) NOT NULL DEFAULT '',
      user_created_at DATETIME(3) NOT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      sync_generation VARCHAR(64) NOT NULL DEFAULT '',
      synced_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (supplier_id,user_id),
      KEY idx_ai_notice_directory_org (organization_id,active),
      KEY idx_ai_notice_directory_project (supplier_id,project_id,active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_client_notice_remote_recipients (
      notice_id VARCHAR(64) NOT NULL,
      supplier_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      read_at DATETIME(3) NULL,
      dismissed_at DATETIME(3) NULL,
      PRIMARY KEY (notice_id,supplier_id,user_id),
      KEY idx_ai_notice_remote_supplier (supplier_id,notice_id),
      CONSTRAINT fk_ai_notice_remote_notice FOREIGN KEY (notice_id) REFERENCES ai_client_notices(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_client_notice_sync_state (
      state_key VARCHAR(80) PRIMARY KEY,
      center_watermark DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_client_notice_recipients (
      notice_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      read_at DATETIME(3) NULL,
      dismissed_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (notice_id, user_id),
      KEY idx_ai_client_notice_recipients_user (user_id, created_at),
      CONSTRAINT fk_ai_client_notice_recipients_notice FOREIGN KEY (notice_id) REFERENCES ai_client_notices(id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_client_notice_recipients_user FOREIGN KEY (user_id) REFERENCES ai_end_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_membership_cards (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      level INT NOT NULL DEFAULT 1,
      background_url MEDIUMTEXT NULL,
      discount_percent DECIMAL(8,3) NOT NULL DEFAULT 100,
      discount_modules JSON NULL,
      redeem_only TINYINT(1) NOT NULL DEFAULT 0,
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      packages_json JSON NULL,
      description MEDIUMTEXT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '',
      system_builtin TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY idx_ai_membership_cards_status (status),
      KEY idx_ai_membership_cards_level (level),
      KEY idx_ai_membership_cards_created_by (created_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_membership_cards', 'background_url', 'MEDIUMTEXT NULL AFTER level')
  await ensureColumn('ai_membership_cards', 'discount_percent', 'DECIMAL(8,3) NOT NULL DEFAULT 100 AFTER background_url')
  await ensureColumn('ai_membership_cards', 'discount_modules', 'JSON NULL AFTER discount_percent')
  await ensureColumn('ai_membership_cards', 'redeem_only', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER discount_modules')
  await ensureColumn('ai_membership_cards', 'packages_json', 'JSON NULL AFTER status')
  await ensureColumn('ai_membership_cards', 'description', 'MEDIUMTEXT NULL AFTER packages_json')
  await ensureColumn('ai_membership_cards', 'created_by', 'VARCHAR(64) NOT NULL DEFAULT "" AFTER description')
  await ensureColumn('ai_membership_cards', 'system_builtin', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER created_by')

  await pool.query(
    `INSERT INTO ai_membership_cards (
       id, name, level, discount_percent, discount_modules, redeem_only,
       status, packages_json, description, created_by, system_builtin
     ) VALUES ('free', '免费会员', 1, 100, ?, 0, 'enabled', ?, '新注册用户默认分配的基础会员。', 'admin', 1)
     ON DUPLICATE KEY UPDATE
       name = IF(system_builtin = 1, name, VALUES(name)),
       status = 'enabled',
       created_by = IF(created_by = '' OR created_by = 'system', 'admin', created_by),
       system_builtin = 1`,
    [JSON.stringify([]), JSON.stringify([{ name: '永久免费', durationDays: 0, bonusPoints: 0, pointsDurationDays: 0, price: 0, originalPrice: 0, showOriginalPrice: false }])],
  )

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_membership_card_model_access (
      card_id VARCHAR(64) NOT NULL,
      provider_model_id VARCHAR(64) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (card_id, provider_model_id),
      KEY idx_ai_membership_card_model_access_model (provider_model_id),
      CONSTRAINT fk_ai_membership_card_model_access_card FOREIGN KEY (card_id) REFERENCES ai_membership_cards(id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_membership_card_model_access_model FOREIGN KEY (provider_model_id) REFERENCES ai_provider_models(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_end_user_memberships (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      card_id VARCHAR(64) NOT NULL,
      package_name VARCHAR(120) NOT NULL DEFAULT '',
      started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      expires_at DATETIME(3) NULL,
      points_expires_at DATETIME(3) NULL,
      status ENUM('active','expired','cancelled') NOT NULL DEFAULT 'active',
      source VARCHAR(32) NOT NULL DEFAULT 'admin',
      created_by VARCHAR(64) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY idx_ai_end_user_memberships_user_status (user_id, status),
      KEY idx_ai_end_user_memberships_card (card_id),
      KEY idx_ai_end_user_memberships_expires (expires_at),
      CONSTRAINT fk_ai_end_user_memberships_user FOREIGN KEY (user_id) REFERENCES ai_end_users(id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_end_user_memberships_card FOREIGN KEY (card_id) REFERENCES ai_membership_cards(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_end_user_memberships', 'package_name', 'VARCHAR(120) NOT NULL DEFAULT "" AFTER card_id')
  await ensureColumn('ai_end_user_memberships', 'points_expires_at', 'DATETIME(3) NULL AFTER expires_at')
  await ensureColumn('ai_end_user_memberships', 'source', 'VARCHAR(32) NOT NULL DEFAULT "admin" AFTER status')
  await ensureColumn('ai_end_user_memberships', 'created_by', 'VARCHAR(64) NOT NULL DEFAULT "" AFTER source')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_payment_configs (
      id VARCHAR(64) PRIMARY KEY,
      owner_user_id VARCHAR(64) NOT NULL,
      provider VARCHAR(24) NOT NULL,
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'disabled',
      public_config_json JSON NULL,
      secret_ciphertext MEDIUMTEXT NULL,
      last_test_status VARCHAR(24) NOT NULL DEFAULT '',
      last_test_message VARCHAR(255) NOT NULL DEFAULT '',
      last_tested_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uk_ai_payment_configs_owner_provider (owner_user_id, provider),
      KEY idx_ai_payment_configs_owner_status (owner_user_id, status),
      CONSTRAINT fk_ai_payment_configs_owner FOREIGN KEY (owner_user_id) REFERENCES ai_users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_payment_orders (
      id VARCHAR(64) PRIMARY KEY,
      order_no VARCHAR(32) NOT NULL,
      owner_user_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      config_id VARCHAR(64) NOT NULL,
      provider VARCHAR(24) NOT NULL,
      payment_mode VARCHAR(24) NOT NULL,
      idempotency_key VARCHAR(80) NOT NULL,
      card_id VARCHAR(64) NOT NULL,
      card_name VARCHAR(120) NOT NULL,
      package_name VARCHAR(120) NOT NULL,
      package_snapshot_json JSON NULL,
      amount_fen BIGINT UNSIGNED NOT NULL,
      currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
      status VARCHAR(24) NOT NULL DEFAULT 'creating',
      provider_trade_no VARCHAR(128) NOT NULL DEFAULT '',
      qr_code MEDIUMTEXT NULL,
      checkout_url MEDIUMTEXT NULL,
      client_ip VARCHAR(64) NOT NULL DEFAULT '',
      fulfillment_membership_id VARCHAR(64) NOT NULL DEFAULT '',
      last_error VARCHAR(500) NOT NULL DEFAULT '',
      expires_at DATETIME(3) NOT NULL,
      paid_at DATETIME(3) NULL,
      fulfilled_at DATETIME(3) NULL,
      closed_at DATETIME(3) NULL,
      last_query_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uk_ai_payment_orders_order_no (order_no),
      UNIQUE KEY uk_ai_payment_orders_user_idempotency (user_id, idempotency_key),
      KEY idx_ai_payment_orders_owner_created (owner_user_id, created_at),
      KEY idx_ai_payment_orders_user_created (user_id, created_at),
      KEY idx_ai_payment_orders_status_expires (status, expires_at),
      KEY idx_ai_payment_orders_provider_trade (provider, provider_trade_no)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_payment_events (
      id VARCHAR(64) PRIMARY KEY,
      provider VARCHAR(24) NOT NULL,
      event_key VARCHAR(128) NOT NULL,
      config_id VARCHAR(64) NOT NULL,
      order_id VARCHAR(64) NOT NULL DEFAULT '',
      payload_json JSON NULL,
      processed_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uk_ai_payment_events_provider_key (provider, event_key),
      KEY idx_ai_payment_events_order (order_id),
      KEY idx_ai_payment_events_config_created (config_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_end_user_model_access (
      user_id VARCHAR(64) NOT NULL,
      provider_model_id VARCHAR(64) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (user_id, provider_model_id),
      KEY idx_ai_end_user_model_access_model (provider_model_id),
      CONSTRAINT fk_ai_end_user_model_access_user FOREIGN KEY (user_id) REFERENCES ai_end_users(id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_end_user_model_access_model FOREIGN KEY (provider_model_id) REFERENCES ai_provider_models(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_end_user_sessions (
      token_hash VARCHAR(96) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      device_id VARCHAR(160) NOT NULL DEFAULT '',
      expires_at DATETIME(3) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_ai_end_user_sessions_user (user_id),
      KEY idx_ai_end_user_sessions_expires (expires_at),
      CONSTRAINT fk_ai_end_user_sessions_user FOREIGN KEY (user_id) REFERENCES ai_end_users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await ensureColumn('ai_end_user_sessions', 'project_id', "VARCHAR(80) NOT NULL DEFAULT ''")

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_end_user_events (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      payload_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_ai_end_user_events_user (user_id),
      KEY idx_ai_end_user_events_type (event_type),
      CONSTRAINT fk_ai_end_user_events_user FOREIGN KEY (user_id) REFERENCES ai_end_users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_end_user_registration_codes (
      id VARCHAR(64) PRIMARY KEY,
      email VARCHAR(190) NOT NULL,
      username VARCHAR(120) NOT NULL,
      code_hash VARCHAR(96) NOT NULL,
      status ENUM('pending','used','expired','disabled') NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 5,
      source_supplier_id VARCHAR(80) NOT NULL DEFAULT '',
      source_agent_id VARCHAR(80) NOT NULL DEFAULT '',
      source_project_id VARCHAR(80) NOT NULL DEFAULT '',
      source_build_id VARCHAR(120) NOT NULL DEFAULT '',
      center_project_id VARCHAR(80) NOT NULL DEFAULT '',
      channel_code VARCHAR(120) NOT NULL DEFAULT '',
      app_version VARCHAR(64) NOT NULL DEFAULT '',
      device_id VARCHAR(160) NOT NULL DEFAULT '',
      device_name VARCHAR(160) NOT NULL DEFAULT '',
      request_ip VARCHAR(64) NOT NULL DEFAULT '',
      expires_at DATETIME(3) NOT NULL,
      used_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY idx_ai_registration_email_created (email, created_at),
      KEY idx_ai_registration_username_created (username, created_at),
      KEY idx_ai_registration_device_created (device_id, created_at),
      KEY idx_ai_registration_ip_created (request_ip, created_at),
      KEY idx_ai_registration_status_expires (status, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_end_user_password_reset_codes (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      email VARCHAR(190) NOT NULL,
      code_hash VARCHAR(96) NOT NULL,
      status ENUM('pending','used','expired','disabled') NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 5,
      source_supplier_id VARCHAR(80) NOT NULL DEFAULT '',
      source_agent_id VARCHAR(80) NOT NULL DEFAULT '',
      source_project_id VARCHAR(80) NOT NULL DEFAULT '',
      source_build_id VARCHAR(120) NOT NULL DEFAULT '',
      center_project_id VARCHAR(80) NOT NULL DEFAULT '',
      channel_code VARCHAR(120) NOT NULL DEFAULT '',
      app_version VARCHAR(64) NOT NULL DEFAULT '',
      device_id VARCHAR(160) NOT NULL DEFAULT '',
      device_name VARCHAR(160) NOT NULL DEFAULT '',
      request_ip VARCHAR(64) NOT NULL DEFAULT '',
      expires_at DATETIME(3) NOT NULL,
      used_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY idx_ai_password_reset_user (user_id),
      KEY idx_ai_password_reset_email_created (email, created_at),
      KEY idx_ai_password_reset_device_created (device_id, created_at),
      KEY idx_ai_password_reset_ip_created (request_ip, created_at),
      KEY idx_ai_password_reset_status_expires (status, expires_at),
      CONSTRAINT fk_ai_password_reset_user FOREIGN KEY (user_id) REFERENCES ai_end_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_credit_ledger (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      change_type VARCHAR(32) NOT NULL,
      points_delta DECIMAL(18,6) NOT NULL,
      balance_after DECIMAL(18,6) NOT NULL,
      cost_usd DECIMAL(18,8) NOT NULL DEFAULT 0,
      upstream_log_id VARCHAR(80) NOT NULL DEFAULT '',
      upstream_quota INT NOT NULL DEFAULT 0,
      model_name VARCHAR(120) NOT NULL DEFAULT '',
      prompt_tokens INT NOT NULL DEFAULT 0,
      completion_tokens INT NOT NULL DEFAULT 0,
      total_tokens INT NOT NULL DEFAULT 0,
      note VARCHAR(255) NOT NULL DEFAULT '',
      request_id VARCHAR(80) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_ai_credit_ledger_user (user_id),
      KEY idx_ai_credit_ledger_created (created_at),
      KEY idx_ai_credit_ledger_upstream (upstream_log_id),
      CONSTRAINT fk_ai_credit_ledger_user FOREIGN KEY (user_id) REFERENCES ai_end_users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_credit_ledger', 'upstream_log_id', 'VARCHAR(80) NOT NULL DEFAULT "" AFTER cost_usd')
  await ensureColumn('ai_credit_ledger', 'upstream_quota', 'INT NOT NULL DEFAULT 0 AFTER upstream_log_id')
  await ensureColumn('ai_credit_ledger', 'provider_id', 'VARCHAR(64) NOT NULL DEFAULT "" AFTER upstream_quota')
  await ensureColumn('ai_credit_ledger', 'provider_name', 'VARCHAR(120) NOT NULL DEFAULT "" AFTER provider_id')
  await ensureColumn('ai_credit_ledger', 'provider_key_id', 'VARCHAR(64) NOT NULL DEFAULT "" AFTER provider_name')
  await ensureColumn('ai_credit_ledger', 'provider_key_preview', 'VARCHAR(32) NOT NULL DEFAULT "" AFTER provider_key_id')
  await ensureColumn('ai_credit_ledger', 'pricing_rule_id', 'VARCHAR(64) NOT NULL DEFAULT "" AFTER provider_key_preview')
  await ensureColumn('ai_credit_ledger', 'billing_type', 'VARCHAR(32) NOT NULL DEFAULT "" AFTER pricing_rule_id')
  await ensureColumn('ai_credit_ledger', 'deduct_status', 'VARCHAR(32) NOT NULL DEFAULT "succeeded" AFTER billing_type')
  await ensureColumn('ai_credit_ledger', 'raw_usage_json', 'JSON NULL AFTER request_id')
  await pool.query(`
    UPDATE ai_model_provider_keys k
    JOIN (
      SELECT provider_key_id, COUNT(*) AS success_count
      FROM ai_credit_ledger
      WHERE provider_key_id <> '' AND change_type = 'consume'
      GROUP BY provider_key_id
    ) usage_totals ON usage_totals.provider_key_id = k.id
    SET k.success_count = usage_totals.success_count
    WHERE k.success_count = 0
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_redeem_code_batches (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      reward_type VARCHAR(32) NOT NULL DEFAULT 'points',
      points DECIMAL(18,6) NOT NULL DEFAULT 0,
      membership_card_id VARCHAR(64) NOT NULL DEFAULT '',
      membership_card_name VARCHAR(120) NOT NULL DEFAULT '',
      membership_package_name VARCHAR(120) NOT NULL DEFAULT '',
      membership_package_json JSON NULL,
      quantity INT NOT NULL DEFAULT 0,
      status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
      expires_at DATETIME(3) NULL,
      note VARCHAR(255) NOT NULL DEFAULT '',
      created_by VARCHAR(64) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_ai_redeem_code_batches_status (status),
      KEY idx_ai_redeem_code_batches_membership_card (membership_card_id),
      KEY idx_ai_redeem_code_batches_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_redeem_code_batches', 'reward_type', 'VARCHAR(32) NOT NULL DEFAULT "points" AFTER name')
  await ensureColumn('ai_redeem_code_batches', 'membership_card_id', 'VARCHAR(64) NOT NULL DEFAULT "" AFTER points')
  await ensureColumn('ai_redeem_code_batches', 'membership_card_name', 'VARCHAR(120) NOT NULL DEFAULT "" AFTER membership_card_id')
  await ensureColumn('ai_redeem_code_batches', 'membership_package_name', 'VARCHAR(120) NOT NULL DEFAULT "" AFTER membership_card_name')
  await ensureColumn('ai_redeem_code_batches', 'membership_package_json', 'JSON NULL AFTER membership_package_name')
  await ensureIndex('ai_redeem_code_batches', 'idx_ai_redeem_code_batches_membership_card', 'ADD KEY idx_ai_redeem_code_batches_membership_card (membership_card_id)')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_redeem_codes (
      id VARCHAR(64) PRIMARY KEY,
      batch_id VARCHAR(64) NOT NULL,
      code_hash VARCHAR(96) NOT NULL UNIQUE,
      code_plain VARCHAR(80) NOT NULL DEFAULT '',
      code_preview VARCHAR(32) NOT NULL DEFAULT '',
      points DECIMAL(18,6) NOT NULL DEFAULT 0,
      status ENUM('unused','used','disabled') NOT NULL DEFAULT 'unused',
      used_by_user_id VARCHAR(64) NOT NULL DEFAULT '',
      used_source_supplier_id VARCHAR(80) NOT NULL DEFAULT '',
      used_source_agent_id VARCHAR(80) NOT NULL DEFAULT '',
      used_source_project_id VARCHAR(80) NOT NULL DEFAULT '',
      used_source_build_id VARCHAR(120) NOT NULL DEFAULT '',
      used_center_project_id VARCHAR(80) NOT NULL DEFAULT '',
      used_channel_code VARCHAR(120) NOT NULL DEFAULT '',
      used_app_version VARCHAR(64) NOT NULL DEFAULT '',
      used_device_id VARCHAR(160) NOT NULL DEFAULT '',
      used_device_name VARCHAR(160) NOT NULL DEFAULT '',
      used_at DATETIME(3) NULL,
      expires_at DATETIME(3) NULL,
      note VARCHAR(255) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_ai_redeem_codes_batch (batch_id),
      KEY idx_ai_redeem_codes_status (status),
      KEY idx_ai_redeem_codes_used_by (used_by_user_id),
      CONSTRAINT fk_ai_redeem_codes_batch FOREIGN KEY (batch_id) REFERENCES ai_redeem_code_batches(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await ensureColumn('ai_redeem_codes', 'code_plain', 'VARCHAR(80) NOT NULL DEFAULT "" AFTER code_hash')
  await ensureColumn('ai_redeem_codes', 'used_source_supplier_id', 'VARCHAR(80) NOT NULL DEFAULT "" AFTER used_by_user_id')
  await ensureColumn('ai_redeem_codes', 'used_source_agent_id', 'VARCHAR(80) NOT NULL DEFAULT "" AFTER used_source_supplier_id')
  await ensureColumn('ai_redeem_codes', 'used_source_project_id', 'VARCHAR(80) NOT NULL DEFAULT "" AFTER used_source_agent_id')
  await ensureColumn('ai_redeem_codes', 'used_source_build_id', 'VARCHAR(120) NOT NULL DEFAULT "" AFTER used_source_project_id')
  await ensureColumn('ai_redeem_codes', 'used_center_project_id', 'VARCHAR(80) NOT NULL DEFAULT "" AFTER used_source_build_id')
  await ensureColumn('ai_redeem_codes', 'used_channel_code', 'VARCHAR(120) NOT NULL DEFAULT "" AFTER used_center_project_id')
  await ensureColumn('ai_redeem_codes', 'used_app_version', 'VARCHAR(64) NOT NULL DEFAULT "" AFTER used_channel_code')
  await ensureColumn('ai_redeem_codes', 'used_device_id', 'VARCHAR(160) NOT NULL DEFAULT "" AFTER used_app_version')
  await ensureColumn('ai_redeem_codes', 'used_device_name', 'VARCHAR(160) NOT NULL DEFAULT "" AFTER used_device_id')
  await ensureIndex('ai_redeem_codes', 'idx_ai_redeem_codes_used_source_project', 'ADD KEY idx_ai_redeem_codes_used_source_project (used_source_project_id)')
  await ensureIndex('ai_redeem_codes', 'idx_ai_redeem_codes_used_device', 'ADD KEY idx_ai_redeem_codes_used_device (used_device_id)')

  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_skills (
    id VARCHAR(64) PRIMARY KEY, slug VARCHAR(80) NOT NULL UNIQUE, name VARCHAR(160) NOT NULL,
    description TEXT NOT NULL, category VARCHAR(80) NOT NULL DEFAULT '', tags_json JSON NULL,
    cover_url TEXT NULL, distribution_type ENUM('public','protected') NOT NULL DEFAULT 'public',
    default_delivery_policy ENUM('market','recommended','auto_install') NOT NULL DEFAULT 'market',
    status ENUM('draft','published','disabled') NOT NULL DEFAULT 'draft', current_version_id VARCHAR(64) NOT NULL DEFAULT '',
    owner_user_id VARCHAR(64) NOT NULL DEFAULT 'admin', source_type ENUM('local','official_sync') NOT NULL DEFAULT 'local',
    source_skill_id VARCHAR(64) NOT NULL DEFAULT '', created_by VARCHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    KEY idx_curated_skills_status (status), KEY idx_curated_skills_owner (owner_user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_skill_versions (
    id VARCHAR(64) PRIMARY KEY, skill_id VARCHAR(64) NOT NULL, version VARCHAR(64) NOT NULL,
    release_notes TEXT NOT NULL, min_desktop_version VARCHAR(64) NOT NULL DEFAULT '', manifest_json JSON NULL,
    package_path TEXT NOT NULL, package_sha256 CHAR(64) NOT NULL DEFAULT '', encrypted_dek_json JSON NULL,
    status ENUM('draft','published','revoked') NOT NULL DEFAULT 'draft', published_at DATETIME(3) NULL,
    created_by VARCHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_curated_skill_version (skill_id, version), KEY idx_curated_versions_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_skill_targets (
    id VARCHAR(64) PRIMARY KEY, skill_id VARCHAR(64) NOT NULL,
    target_type ENUM('all_suppliers','supplier','agent') NOT NULL DEFAULT 'all_suppliers', target_id VARCHAR(80) NOT NULL DEFAULT '',
    status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled', created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), KEY idx_curated_targets_skill (skill_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_skill_distributions (
    id VARCHAR(64) PRIMARY KEY, skill_id VARCHAR(64) NOT NULL, owner_user_id VARCHAR(64) NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 0, selected_version_id VARCHAR(64) NOT NULL DEFAULT '',
    delivery_policy ENUM('market','recommended','auto_install') NOT NULL DEFAULT 'market',
    version_policy ENUM('manual','follow_latest') NOT NULL DEFAULT 'manual',
    status ENUM('available','pending_version','disabled','revoked') NOT NULL DEFAULT 'disabled', configured_by VARCHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_curated_distribution_owner (owner_user_id, skill_id), KEY idx_curated_distribution_skill (skill_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_skill_audiences (
    id VARCHAR(64) PRIMARY KEY, distribution_id VARCHAR(64) NOT NULL,
    audience_type ENUM('all','membership_card','user') NOT NULL DEFAULT 'all', audience_id VARCHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), KEY idx_curated_audience_distribution (distribution_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_skill_installations (
    id VARCHAR(64) PRIMARY KEY, skill_id VARCHAR(64) NOT NULL, version_id VARCHAR(64) NOT NULL,
    distribution_id VARCHAR(64) NOT NULL, owner_user_id VARCHAR(64) NOT NULL, end_user_id VARCHAR(64) NOT NULL,
    device_id_hash CHAR(64) NOT NULL, status ENUM('installed','update_available','removed','blocked') NOT NULL DEFAULT 'installed',
    installed_at DATETIME(3) NULL, last_seen_at DATETIME(3) NULL, updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_curated_installation_device (end_user_id, device_id_hash, skill_id), KEY idx_curated_installation_owner (owner_user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_skill_events (
    id VARCHAR(64) PRIMARY KEY, skill_id VARCHAR(64) NOT NULL DEFAULT '', version_id VARCHAR(64) NOT NULL DEFAULT '',
    owner_user_id VARCHAR(64) NOT NULL DEFAULT '', actor_type VARCHAR(32) NOT NULL DEFAULT 'admin', actor_id VARCHAR(64) NOT NULL DEFAULT '',
    event_type VARCHAR(64) NOT NULL, result VARCHAR(32) NOT NULL DEFAULT 'success', detail_json JSON NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), KEY idx_curated_events_skill (skill_id), KEY idx_curated_events_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_mcps (
    id VARCHAR(64) PRIMARY KEY, name VARCHAR(160) NOT NULL, description TEXT NOT NULL,
    category VARCHAR(80) NOT NULL DEFAULT '', tags_json JSON NULL, icon_url TEXT NULL,
    default_delivery_policy ENUM('market','recommended','auto_install') NOT NULL DEFAULT 'market',
    status ENUM('draft','published','disabled') NOT NULL DEFAULT 'draft', current_version_id VARCHAR(64) NOT NULL DEFAULT '',
    owner_user_id VARCHAR(64) NOT NULL, source_type ENUM('local','official_sync') NOT NULL DEFAULT 'local',
    source_mcp_id VARCHAR(64) NOT NULL DEFAULT '', created_by VARCHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    KEY idx_curated_mcps_status (status), KEY idx_curated_mcps_owner (owner_user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await ensureColumn('ai_curated_mcps', 'source_type', "ENUM('local','official_sync') NOT NULL DEFAULT 'local' AFTER owner_user_id")
  await ensureColumn('ai_curated_mcps', 'source_mcp_id', "VARCHAR(64) NOT NULL DEFAULT '' AFTER source_type")
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_mcp_versions (
    id VARCHAR(64) PRIMARY KEY, mcp_id VARCHAR(64) NOT NULL, version VARCHAR(64) NOT NULL,
    release_notes TEXT NOT NULL, min_desktop_version VARCHAR(64) NOT NULL DEFAULT '', config_json JSON NOT NULL,
    config_sha256 CHAR(64) NOT NULL, status ENUM('draft','published','revoked') NOT NULL DEFAULT 'draft',
    published_at DATETIME(3) NULL, created_by VARCHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_curated_mcp_version (mcp_id, version), KEY idx_curated_mcp_versions_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_mcp_distributions (
    id VARCHAR(64) PRIMARY KEY, mcp_id VARCHAR(64) NOT NULL, owner_user_id VARCHAR(64) NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 0, selected_version_id VARCHAR(64) NOT NULL DEFAULT '',
    delivery_policy ENUM('market','recommended','auto_install') NOT NULL DEFAULT 'market',
    version_policy ENUM('manual','follow_latest') NOT NULL DEFAULT 'manual',
    status ENUM('available','pending_version','disabled','revoked') NOT NULL DEFAULT 'disabled', configured_by VARCHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_curated_mcp_distribution_owner (owner_user_id, mcp_id), KEY idx_curated_mcp_distribution_mcp (mcp_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_mcp_audiences (
    id VARCHAR(64) PRIMARY KEY, distribution_id VARCHAR(64) NOT NULL,
    audience_type ENUM('all','membership_card','user') NOT NULL DEFAULT 'all', audience_id VARCHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), KEY idx_curated_mcp_audience_distribution (distribution_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_mcp_installations (
    id VARCHAR(64) PRIMARY KEY, mcp_id VARCHAR(64) NOT NULL, version_id VARCHAR(64) NOT NULL,
    distribution_id VARCHAR(64) NOT NULL, owner_user_id VARCHAR(64) NOT NULL, end_user_id VARCHAR(64) NOT NULL,
    device_id_hash CHAR(64) NOT NULL, status ENUM('installed','update_available','removed','blocked','failed') NOT NULL DEFAULT 'installed',
    error_code VARCHAR(64) NOT NULL DEFAULT '', installed_at DATETIME(3) NULL, last_seen_at DATETIME(3) NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_curated_mcp_installation_device (end_user_id, device_id_hash, mcp_id), KEY idx_curated_mcp_installation_owner (owner_user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_agents (
    id VARCHAR(64) PRIMARY KEY, name VARCHAR(160) NOT NULL, description TEXT NOT NULL,
    prompt MEDIUMTEXT NOT NULL, icon_url TEXT NULL, version VARCHAR(64) NOT NULL DEFAULT '1.0.0',
    permission_mode ENUM('default','acceptEdits','auto','dontAsk','plan') NOT NULL DEFAULT 'default',
    status ENUM('draft','published','disabled') NOT NULL DEFAULT 'draft', owner_user_id VARCHAR(64) NOT NULL,
    source_type ENUM('local','official_sync') NOT NULL DEFAULT 'local', source_agent_id VARCHAR(64) NOT NULL DEFAULT '',
    created_by VARCHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    KEY idx_curated_agents_status (status), KEY idx_curated_agents_owner (owner_user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await ensureColumn('ai_curated_agents', 'publisher_name', "VARCHAR(120) NOT NULL DEFAULT '' AFTER icon_url")
  await ensureColumn('ai_curated_agents', 'profile_labels_json', "JSON NULL AFTER publisher_name")
  await ensureColumn('ai_curated_agents', 'usage_label', "VARCHAR(80) NOT NULL DEFAULT '' AFTER profile_labels_json")
  await ensureColumn('ai_curated_agents', 'expertise_tags_json', "JSON NULL AFTER usage_label")
  await ensureColumn('ai_curated_agents', 'starter_prompts_json', "JSON NULL AFTER expertise_tags_json")
  await ensureColumn('ai_curated_agents', 'source_type', "ENUM('local','official_sync') NOT NULL DEFAULT 'local' AFTER owner_user_id")
  await ensureColumn('ai_curated_agents', 'source_agent_id', "VARCHAR(64) NOT NULL DEFAULT '' AFTER source_type")
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_agent_dependencies (
    id VARCHAR(64) PRIMARY KEY, agent_id VARCHAR(64) NOT NULL,
    dependency_type ENUM('skill','mcp') NOT NULL, dependency_id VARCHAR(64) NOT NULL,
    required TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_curated_agent_dependency (agent_id, dependency_type, dependency_id),
    KEY idx_curated_agent_dependency_agent (agent_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_agent_distributions (
    id VARCHAR(64) PRIMARY KEY, agent_id VARCHAR(64) NOT NULL, owner_user_id VARCHAR(64) NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 0,
    delivery_policy ENUM('market','recommended','auto_install') NOT NULL DEFAULT 'market',
    status ENUM('available','disabled','blocked') NOT NULL DEFAULT 'disabled', configured_by VARCHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_curated_agent_distribution_owner (owner_user_id, agent_id),
    KEY idx_curated_agent_distribution_agent (agent_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_agent_audiences (
    id VARCHAR(64) PRIMARY KEY, distribution_id VARCHAR(64) NOT NULL,
    audience_type ENUM('all','membership_card','user') NOT NULL DEFAULT 'all', audience_id VARCHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_curated_agent_audience_distribution (distribution_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_agent_installations (
    id VARCHAR(64) PRIMARY KEY, agent_id VARCHAR(64) NOT NULL, distribution_id VARCHAR(64) NOT NULL,
    owner_user_id VARCHAR(64) NOT NULL, end_user_id VARCHAR(64) NOT NULL, device_id_hash CHAR(64) NOT NULL,
    status ENUM('installed','removed','blocked','failed') NOT NULL DEFAULT 'installed', error_code VARCHAR(64) NOT NULL DEFAULT '',
    installed_at DATETIME(3) NULL, last_seen_at DATETIME(3) NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_curated_agent_installation_device (end_user_id, device_id_hash, agent_id),
    KEY idx_curated_agent_installation_owner (owner_user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  await pool.query(`CREATE TABLE IF NOT EXISTS ai_enterprise_tenants (
    id VARCHAR(64) PRIMARY KEY, owner_organization_id VARCHAR(64) NOT NULL,
    name VARCHAR(160) NOT NULL, short_name VARCHAR(80) NOT NULL DEFAULT '',
    business_contact_name VARCHAR(120) NOT NULL DEFAULT '', business_contact_email VARCHAR(190) NOT NULL DEFAULT '',
    ai_brand_name VARCHAR(120) NOT NULL DEFAULT '', logo_url TEXT NULL, project_id VARCHAR(64) NOT NULL DEFAULT '',
    seat_limit INT NOT NULL DEFAULT 1, default_member_device_limit INT NOT NULL DEFAULT 2,
    timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
    status ENUM('pending','enabled','suspended','closed') NOT NULL DEFAULT 'enabled',
    created_by VARCHAR(64) NOT NULL DEFAULT '', updated_by VARCHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    KEY idx_enterprise_tenants_owner (owner_organization_id),
    KEY idx_enterprise_tenants_status (status), KEY idx_enterprise_tenants_project (project_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_enterprise_departments (
    id VARCHAR(64) PRIMARY KEY, enterprise_id VARCHAR(64) NOT NULL,
    parent_department_id VARCHAR(64) NOT NULL DEFAULT '', name VARCHAR(120) NOT NULL,
    path_cache VARCHAR(1024) NOT NULL DEFAULT '', depth INT NOT NULL DEFAULT 0, sort_order INT NOT NULL DEFAULT 0,
    status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled', is_root TINYINT(1) NOT NULL DEFAULT 0,
    created_by VARCHAR(64) NOT NULL DEFAULT '', updated_by VARCHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    KEY idx_enterprise_departments_tenant (enterprise_id),
    KEY idx_enterprise_departments_parent (enterprise_id, parent_department_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_enterprise_members (
    id VARCHAR(64) PRIMARY KEY, enterprise_id VARCHAR(64) NOT NULL, end_user_id VARCHAR(64) NOT NULL,
    department_id VARCHAR(64) NOT NULL DEFAULT '', employee_no VARCHAR(80) NOT NULL DEFAULT '',
    job_title VARCHAR(120) NOT NULL DEFAULT '',
    enterprise_role ENUM('owner','admin','department_admin','auditor','member') NOT NULL DEFAULT 'member',
    managed_department_id VARCHAR(64) NOT NULL DEFAULT '',
    device_limit INT NOT NULL DEFAULT 0,
    status ENUM('invited','enabled','disabled','departed') NOT NULL DEFAULT 'enabled',
    joined_at DATETIME(3) NULL, departed_at DATETIME(3) NULL,
    created_by VARCHAR(64) NOT NULL DEFAULT '', updated_by VARCHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_enterprise_member_user (enterprise_id, end_user_id),
    KEY idx_enterprise_members_department (enterprise_id, department_id),
    KEY idx_enterprise_members_user (end_user_id), KEY idx_enterprise_members_status (enterprise_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_enterprise_sessions (
    token_hash CHAR(64) PRIMARY KEY, enterprise_id VARCHAR(64) NOT NULL, member_id VARCHAR(64) NOT NULL,
    expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_enterprise_sessions_member (member_id), KEY idx_enterprise_sessions_expiry (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_enterprise_member_devices (
    id VARCHAR(64) PRIMARY KEY, enterprise_id VARCHAR(64) NOT NULL, member_id VARCHAR(64) NOT NULL,
    device_id_hash CHAR(64) NOT NULL, device_name VARCHAR(160) NOT NULL DEFAULT '',
    status ENUM('active','revoked') NOT NULL DEFAULT 'active', last_seen_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_enterprise_member_device (member_id, device_id_hash),
    KEY idx_enterprise_devices_tenant (enterprise_id), KEY idx_enterprise_devices_status (member_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_enterprise_quota_policies (
    id VARCHAR(64) PRIMARY KEY, enterprise_id VARCHAR(64) NOT NULL,
    scope_type ENUM('enterprise','department','member') NOT NULL, scope_id VARCHAR(64) NOT NULL DEFAULT '',
    period_type ENUM('day','month') NOT NULL DEFAULT 'month',
    limit_points DECIMAL(18,6) NOT NULL DEFAULT 0, limit_cost_usd DECIMAL(18,8) NOT NULL DEFAULT 0,
    limit_tokens BIGINT NOT NULL DEFAULT 0, enforcement ENUM('block','alert_only') NOT NULL DEFAULT 'alert_only',
    warning_percent INT NOT NULL DEFAULT 80, effective_from DATETIME(3) NULL, effective_to DATETIME(3) NULL,
    status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
    created_by VARCHAR(64) NOT NULL DEFAULT '', updated_by VARCHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_enterprise_quota_scope (enterprise_id, scope_type, scope_id, period_type),
    KEY idx_enterprise_quota_status (enterprise_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_enterprise_experts (
    id VARCHAR(64) PRIMARY KEY, owner_organization_id VARCHAR(64) NOT NULL, curated_agent_id VARCHAR(64) NOT NULL,
    name VARCHAR(160) NOT NULL, summary TEXT NOT NULL, suitable_departments TEXT NOT NULL,
    icon_url TEXT NULL, guide MEDIUMTEXT NOT NULL, status ENUM('draft','enabled','disabled') NOT NULL DEFAULT 'draft',
    created_by VARCHAR(64) NOT NULL DEFAULT '', updated_by VARCHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    KEY idx_enterprise_experts_owner (owner_organization_id), KEY idx_enterprise_experts_agent (curated_agent_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_enterprise_expert_assignments (
    id VARCHAR(64) PRIMARY KEY, enterprise_id VARCHAR(64) NOT NULL, expert_id VARCHAR(64) NOT NULL,
    scope_type ENUM('enterprise','department','member') NOT NULL DEFAULT 'enterprise', scope_id VARCHAR(64) NOT NULL DEFAULT '',
    status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled', assigned_by VARCHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_enterprise_expert_assignment (enterprise_id, expert_id, scope_type, scope_id),
    KEY idx_enterprise_expert_assignments_tenant (enterprise_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_enterprise_expert_events (
    id VARCHAR(64) PRIMARY KEY, enterprise_id VARCHAR(64) NOT NULL, member_id VARCHAR(64) NOT NULL DEFAULT '',
    expert_id VARCHAR(64) NOT NULL DEFAULT '', event_type VARCHAR(64) NOT NULL, request_id VARCHAR(120) NOT NULL DEFAULT '',
    occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_enterprise_expert_events_tenant (enterprise_id, occurred_at),
    KEY idx_enterprise_expert_events_expert (expert_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_enterprise_audit_logs (
    id VARCHAR(64) PRIMARY KEY, owner_organization_id VARCHAR(64) NOT NULL, enterprise_id VARCHAR(64) NOT NULL,
    actor_type VARCHAR(32) NOT NULL DEFAULT 'admin', actor_id VARCHAR(64) NOT NULL DEFAULT '',
    event_type VARCHAR(80) NOT NULL, target_type VARCHAR(64) NOT NULL DEFAULT '', target_id VARCHAR(64) NOT NULL DEFAULT '',
    detail_json JSON NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_enterprise_audit_tenant (enterprise_id, created_at), KEY idx_enterprise_audit_owner (owner_organization_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_agent_market_placements (
    id VARCHAR(64) PRIMARY KEY, curated_agent_id VARCHAR(64) NOT NULL,
    market_type ENUM('personal','enterprise') NOT NULL, display_name VARCHAR(160) NOT NULL DEFAULT '',
    summary TEXT NOT NULL, cover_url TEXT NULL, category VARCHAR(80) NOT NULL DEFAULT '',
    status ENUM('draft','published','withdrawn') NOT NULL DEFAULT 'draft', published_version_id VARCHAR(64) NOT NULL DEFAULT '',
    created_by VARCHAR(64) NOT NULL DEFAULT '', updated_by VARCHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_curated_agent_market (curated_agent_id, market_type), KEY idx_curated_agent_market_status (market_type, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_skill_market_placements (
    id VARCHAR(64) PRIMARY KEY, curated_skill_id VARCHAR(64) NOT NULL,
    market_type ENUM('personal','enterprise') NOT NULL, status ENUM('draft','published','withdrawn') NOT NULL DEFAULT 'published',
    created_by VARCHAR(64) NOT NULL DEFAULT '', updated_by VARCHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_curated_skill_market (curated_skill_id, market_type), KEY idx_curated_skill_market_status (market_type, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_mcp_market_placements (
    id VARCHAR(64) PRIMARY KEY, curated_mcp_id VARCHAR(64) NOT NULL,
    market_type ENUM('personal','enterprise') NOT NULL, status ENUM('draft','published','withdrawn') NOT NULL DEFAULT 'draft',
    created_by VARCHAR(64) NOT NULL DEFAULT '', updated_by VARCHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_curated_mcp_market (curated_mcp_id, market_type), KEY idx_curated_mcp_market_status (market_type, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`INSERT IGNORE INTO ai_curated_agent_market_placements
    (id, curated_agent_id, market_type, display_name, summary, cover_url, category, status, created_by, updated_by)
    SELECT CONCAT('market-', MD5(CONCAT(id, ':personal'))), id, 'personal', name, description, icon_url, '',
      IF(status='published','published','draft'), 'system-migration', 'system-migration' FROM ai_curated_agents`)
  await pool.query(`INSERT IGNORE INTO ai_curated_skill_market_placements
    (id, curated_skill_id, market_type, status, created_by, updated_by)
    SELECT CONCAT('market-', MD5(CONCAT(id, ':personal'))), id, 'personal', IF(status='published','published','draft'),
      'system-migration', 'system-migration' FROM ai_curated_skills`)
  await pool.query(`INSERT IGNORE INTO ai_curated_mcp_market_placements
    (id, curated_mcp_id, market_type, status, created_by, updated_by)
    SELECT CONCAT('market-', MD5(CONCAT(id, ':personal'))), id, 'personal', IF(status='published','published','draft'),
      'system-migration', 'system-migration' FROM ai_curated_mcps`)
  // 企业业务已下线。保留历史表和历史流水，仅清理运行态授权并统一为个人业务。
  await pool.query("UPDATE ai_organizations SET business_mode='personal' WHERE business_mode<>'personal'")
  await pool.query("UPDATE ai_center_suppliers SET business_mode='personal' WHERE business_mode<>'personal'")
  await pool.query("UPDATE ai_projects SET client_mode='personal' WHERE client_mode<>'personal'")
  await pool.query("DELETE FROM ai_organization_capabilities WHERE LEFT(capability_key, 11)='enterprise_'")
  await pool.query("DELETE FROM ai_role_template_permissions WHERE LEFT(permission_key, 11)='enterprise_'")
  await pool.query("DELETE FROM ai_user_group_permissions WHERE LEFT(permission_key, 11)='enterprise_'")
  await pool.query("UPDATE ai_curated_agent_market_placements SET status='withdrawn', updated_by='system-enterprise-retirement' WHERE market_type='enterprise' AND status<>'withdrawn'")
  await pool.query("UPDATE ai_curated_skill_market_placements SET status='withdrawn', updated_by='system-enterprise-retirement' WHERE market_type='enterprise' AND status<>'withdrawn'")
  await pool.query("UPDATE ai_curated_mcp_market_placements SET status='withdrawn', updated_by='system-enterprise-retirement' WHERE market_type='enterprise' AND status<>'withdrawn'")
  await ensureColumn('ai_credit_ledger', 'enterprise_id', 'VARCHAR(64) NOT NULL DEFAULT ""')
  await ensureColumn('ai_credit_ledger', 'enterprise_member_id', 'VARCHAR(64) NOT NULL DEFAULT "" AFTER enterprise_id')
  await ensureColumn('ai_credit_ledger', 'enterprise_department_id', 'VARCHAR(64) NOT NULL DEFAULT "" AFTER enterprise_member_id')
  await ensureColumn('ai_credit_ledger', 'enterprise_expert_id', 'VARCHAR(64) NOT NULL DEFAULT "" AFTER enterprise_department_id')
  await ensureIndex('ai_credit_ledger', 'idx_ledger_usage_request', 'ADD INDEX idx_ledger_usage_request (user_id, request_id, id)')
  await ensureIndex('ai_credit_ledger', 'idx_ledger_usage_date', 'ADD INDEX idx_ledger_usage_date (user_id, change_type, created_at)')
  await ensureIndex('ai_credit_ledger', 'idx_ledger_usage_period', 'ADD INDEX idx_ledger_usage_period (change_type, created_at)')
  await ensureIndex('ai_credit_ledger', 'idx_credit_ledger_enterprise', 'ADD KEY idx_credit_ledger_enterprise (enterprise_id, created_at)')
  await ensureIndex('ai_credit_ledger', 'idx_credit_ledger_enterprise_member', 'ADD KEY idx_credit_ledger_enterprise_member (enterprise_member_id, created_at)')

  await seedDefaultModelProviderData()

  await pool.query(
    `UPDATE ai_builds
     SET release_url = public_url, released_at = COALESCE(finished_at, updated_at)
     WHERE status = 'succeeded' AND released_at IS NULL AND public_url LIKE ?`,
    [`${PUBLIC_UPDATE_BASE_URL.replace(/\/$/, '')}/%`],
  )

  const adminUsername = safeUsername(ADMIN_USER)
  const [rows] = await pool.query('SELECT id FROM ai_users WHERE username = ? LIMIT 1', [adminUsername])
  if (rows.length === 0) {
    const [adminRows] = await pool.query('SELECT id FROM ai_users WHERE id = ? LIMIT 1', ['admin'])
    if (adminRows.length > 0) {
      await pool.query(
        `UPDATE ai_users
         SET username = ?, display_name = ?, role = 'admin', status = 'enabled', password_hash = ?
         WHERE id = ?`,
        [adminUsername, '平台管理员', hashPassword(ADMIN_PASSWORD), 'admin'],
      )
    } else {
      await pool.query(
        `INSERT INTO ai_users (id, username, display_name, role, status, password_hash)
       VALUES (?, ?, ?, 'admin', 'enabled', ?)`,
        ['admin', adminUsername, '平台管理员', hashPassword(ADMIN_PASSWORD)],
      )
    }
  }
  const rootOrganizationId = await seedOrganizationCompatibility({ centerMode, supplierId, permissionKeys })
  await seedClientNoticeCapabilities()
  await migrateUserUsagePermissions(pool)
  await backfillOrganizationOwnership(rootOrganizationId)
  await seedAccountFreeMembershipCards()
  return pool
}
