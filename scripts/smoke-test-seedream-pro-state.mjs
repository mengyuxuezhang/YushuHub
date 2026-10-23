import mysql from 'mysql2/promise'

import { loadLocalEnv, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from '../src/config/env.mjs'

loadLocalEnv()

const pool = await mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  charset: 'utf8mb4',
  connectionLimit: 1,
})

try {
  const [[model]] = await pool.query(
    `SELECT id, model_id, display_name, description, model_type, endpoint_path, capabilities, status
       FROM ai_provider_models WHERE id = 'system-model-seedream-pro' LIMIT 1`,
  )
  const [[pricing]] = await pool.query(
    `SELECT id, provider_model_id, billing_type, resolution_points,
            resolution_cost_points, consumption_multiplier, status
       FROM ai_model_pricing_rules WHERE id = 'system-pricing-seedream-pro' LIMIT 1`,
  )
  const [[counts]] = await pool.query(
    `SELECT
      (SELECT COUNT(*) FROM ai_provider_models WHERE id = 'system-model-seedream-lite' OR model_id LIKE 'doubao-seedream-5-0-lite%') AS legacy_models,
      (SELECT COUNT(*) FROM ai_model_pricing_rules WHERE id = 'system-pricing-seedream-lite') AS legacy_pricing,
      (SELECT COUNT(*) FROM ai_end_user_model_access WHERE provider_model_id = 'system-model-seedream-pro') AS user_access,
      (SELECT COUNT(*) FROM ai_membership_card_model_access WHERE provider_model_id = 'system-model-seedream-pro') AS membership_access`,
  )
  console.log(JSON.stringify({
    model: model || null,
    pricing: pricing || null,
    counts: Object.fromEntries(Object.entries(counts || {}).map(([key, value]) => [key, Number(value)])),
  }))
} finally {
  await pool.end()
}
