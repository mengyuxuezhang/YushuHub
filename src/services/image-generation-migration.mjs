import {
  LEGACY_SYSTEM_IMAGE_MODEL_ID,
  LEGACY_SYSTEM_IMAGE_PRICING_ID,
  SYSTEM_IMAGE_MODEL_ID,
  SYSTEM_IMAGE_PRICING_ID,
} from './image-generation.mjs'

function parseMapping(value) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(String(value || '{}')) || {} } catch { return {} }
}

export function migrateLegacyResolutionMapping(value) {
  const old = parseMapping(value)
  return {
    '1K': Number(old['2K'] || 0),
    '1.5K': Number(old['2K'] || 0),
    '2K': Number(old['3K'] || 0),
  }
}

export async function migrateLegacySystemImageRecords(database) {
  const conn = await database.getConnection()
  try {
    await conn.beginTransaction()
    const [legacyPricingRows] = await conn.query(
      'SELECT * FROM ai_model_pricing_rules WHERE id = ? LIMIT 1',
      [LEGACY_SYSTEM_IMAGE_PRICING_ID],
    )
    const [newPricingRows] = await conn.query(
      'SELECT id FROM ai_model_pricing_rules WHERE id = ? LIMIT 1',
      [SYSTEM_IMAGE_PRICING_ID],
    )
    const legacyPricing = legacyPricingRows[0]
    if (legacyPricing && !newPricingRows.length) {
      const sale = migrateLegacyResolutionMapping(legacyPricing.resolution_points)
      const cost = migrateLegacyResolutionMapping(legacyPricing.resolution_cost_points ?? legacyPricing.resolution_points)
      await conn.query(
        `INSERT INTO ai_model_pricing_rules
          (id, provider_id, provider_model_id, billing_type, resolution_points, resolution_cost_points, consumption_multiplier, status, organization_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          SYSTEM_IMAGE_PRICING_ID,
          legacyPricing.provider_id,
          SYSTEM_IMAGE_MODEL_ID,
          'per_image_resolution',
          JSON.stringify(sale),
          JSON.stringify(cost),
          legacyPricing.consumption_multiplier ?? 1,
          legacyPricing.status || 'enabled',
          legacyPricing.organization_id || '',
        ],
      )
    }

    for (const table of ['ai_end_user_model_access', 'ai_membership_card_model_access']) {
      const ownerColumn = table === 'ai_end_user_model_access' ? 'user_id' : 'card_id'
      await conn.query(
        `INSERT IGNORE INTO ${table} (${ownerColumn}, provider_model_id)
         SELECT ${ownerColumn}, ? FROM ${table} WHERE provider_model_id = ?`,
        [SYSTEM_IMAGE_MODEL_ID, LEGACY_SYSTEM_IMAGE_MODEL_ID],
      )
      await conn.query(`DELETE FROM ${table} WHERE provider_model_id = ?`, [LEGACY_SYSTEM_IMAGE_MODEL_ID])
    }
    await conn.query('DELETE FROM ai_model_pricing_rules WHERE id = ? OR provider_model_id = ?', [LEGACY_SYSTEM_IMAGE_PRICING_ID, LEGACY_SYSTEM_IMAGE_MODEL_ID])
    await conn.query('DELETE FROM ai_provider_models WHERE id = ?', [LEGACY_SYSTEM_IMAGE_MODEL_ID])
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}
