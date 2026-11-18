export async function ensurePluginMarketSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_plugin_versions (
    plugin_id VARCHAR(64) NOT NULL, version VARCHAR(64) NOT NULL,
    metadata JSON NOT NULL, sha256 CHAR(64) NOT NULL, size INT UNSIGNED NOT NULL, package_bytes MEDIUMBLOB NOT NULL,
    created_by VARCHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (plugin_id, version)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_plugin_grants (
    project_id VARCHAR(64) NOT NULL, plugin_id VARCHAR(64) NOT NULL, version VARCHAR(64) NOT NULL, updated_by VARCHAR(64) NOT NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (project_id, plugin_id),
    FOREIGN KEY (project_id) REFERENCES ai_projects(id) ON DELETE CASCADE,
    FOREIGN KEY (plugin_id, version) REFERENCES ai_plugin_versions(plugin_id, version)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_plugin_installations (
    project_id VARCHAR(64) NOT NULL, user_id VARCHAR(64) NOT NULL, installation_id CHAR(36) NOT NULL, plugin_id VARCHAR(64) NOT NULL,
    version VARCHAR(64) NOT NULL, state ENUM('installed','removed') NOT NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (project_id, user_id, installation_id, plugin_id),
    FOREIGN KEY (project_id) REFERENCES ai_projects(id) ON DELETE CASCADE,
    FOREIGN KEY (plugin_id, version) REFERENCES ai_plugin_versions(plugin_id, version)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
}
