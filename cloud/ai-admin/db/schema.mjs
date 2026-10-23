import crypto from 'node:crypto'
import mysql from 'mysql2/promise'

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
    CREATE TABLE IF NOT EXISTS ai_deleted_builtin_role_templates (
      template_id VARCHAR(64) PRIMARY KEY,
      deleted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_projects (
      id VARCHAR(64) PRIMARY KEY,
      owner_user_id VARCHAR(64) NOT NULL,
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
    CREATE TABLE IF NOT EXISTS ai_model_provider_keys (
      id VARCHAR(64) PRIMARY KEY,
      owner_user_id VARCHAR(64) NOT NULL DEFAULT 'admin',
      provider_id VARCHAR(64) NOT NULL,
      api_key TEXT NOT NULL,
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
  await ensureColumn('ai_model_provider_keys', 'success_count', 'BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER last_used_at')
  await ensureIndex('ai_model_provider_keys', 'idx_ai_model_provider_keys_owner', 'ADD INDEX idx_ai_model_provider_keys_owner (owner_user_id)')

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_model_pricing_rules (
      id VARCHAR(64) PRIMARY KEY,
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
  await pool.query(`UPDATE ai_model_pricing_rules SET
    input_cost_points_per_m_tokens = COALESCE(input_cost_points_per_m_tokens, input_points_per_m_tokens),
    output_cost_points_per_m_tokens = COALESCE(output_cost_points_per_m_tokens, output_points_per_m_tokens),
    cost_points_per_request = COALESCE(cost_points_per_request, points_per_request),
    resolution_cost_points = COALESCE(resolution_cost_points, resolution_points, JSON_OBJECT())`)

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
    id VARCHAR(64) PRIMARY KEY, skill_id VARCHAR(64) NOT NULL, target_type ENUM('all_suppliers','supplier','agent') NOT NULL DEFAULT 'all_suppliers', target_id VARCHAR(80) NOT NULL DEFAULT '', status ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled', created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), KEY idx_curated_targets_skill (skill_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_skill_distributions (
    id VARCHAR(64) PRIMARY KEY, skill_id VARCHAR(64) NOT NULL, owner_user_id VARCHAR(64) NOT NULL, enabled TINYINT(1) NOT NULL DEFAULT 0, selected_version_id VARCHAR(64) NOT NULL DEFAULT '', delivery_policy ENUM('market','recommended','auto_install') NOT NULL DEFAULT 'market', version_policy ENUM('manual','follow_latest') NOT NULL DEFAULT 'manual', status ENUM('available','pending_version','disabled','revoked') NOT NULL DEFAULT 'disabled', configured_by VARCHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE KEY uk_curated_distribution_owner (owner_user_id, skill_id), KEY idx_curated_distribution_skill (skill_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_skill_audiences (id VARCHAR(64) PRIMARY KEY, distribution_id VARCHAR(64) NOT NULL, audience_type ENUM('all','membership_card','user') NOT NULL DEFAULT 'all', audience_id VARCHAR(64) NOT NULL DEFAULT '', created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), KEY idx_curated_audience_distribution (distribution_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_skill_installations (id VARCHAR(64) PRIMARY KEY, skill_id VARCHAR(64) NOT NULL, version_id VARCHAR(64) NOT NULL, distribution_id VARCHAR(64) NOT NULL, owner_user_id VARCHAR(64) NOT NULL, end_user_id VARCHAR(64) NOT NULL, device_id_hash CHAR(64) NOT NULL, status ENUM('installed','update_available','removed','blocked') NOT NULL DEFAULT 'installed', installed_at DATETIME(3) NULL, last_seen_at DATETIME(3) NULL, updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE KEY uk_curated_installation_device (end_user_id, device_id_hash, skill_id), KEY idx_curated_installation_owner (owner_user_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_curated_skill_events (id VARCHAR(64) PRIMARY KEY, skill_id VARCHAR(64) NOT NULL DEFAULT '', version_id VARCHAR(64) NOT NULL DEFAULT '', owner_user_id VARCHAR(64) NOT NULL DEFAULT '', actor_type VARCHAR(32) NOT NULL DEFAULT 'admin', actor_id VARCHAR(64) NOT NULL DEFAULT '', event_type VARCHAR(64) NOT NULL, result VARCHAR(32) NOT NULL DEFAULT 'success', detail_json JSON NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), KEY idx_curated_events_skill (skill_id), KEY idx_curated_events_created (created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

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
  await seedAccountFreeMembershipCards()
  return pool
}
