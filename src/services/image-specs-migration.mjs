import { imageSpecTemplate } from './image-model-specs.mjs'
import { SEEDREAM_MODEL_IDENTIFIERS } from './image-generation.mjs'

// One-time materialization of the old catalog defaults. New requests and new
// models never select a protocol by model name. Existing explicit config wins.
export async function backfillImageSpecs(pool) {
  const [rows] = await pool.query(`SELECT c.id,c.config_json,m.model_id FROM ai_model_task_capabilities c
    JOIN ai_provider_models m ON m.id=c.provider_model_id
    WHERE c.task_type='image_generation' AND c.protocol_adapter='openai.images'
      AND JSON_EXTRACT(c.config_json,'$.image') IS NULL`)
  for (const row of rows) {
    const config = typeof row.config_json === 'string' ? JSON.parse(row.config_json) : row.config_json || {}
    const image = imageSpecTemplate(SEEDREAM_MODEL_IDENTIFIERS.includes(row.model_id) ? 'seedream' : 'openai')
    await pool.query(`UPDATE ai_model_task_capabilities SET config_json=?,config_revision=config_revision+1
      WHERE id=? AND JSON_EXTRACT(config_json,'$.image') IS NULL`, [JSON.stringify({ ...config, image }), row.id])
  }
}

// Retire only the explicitly removed surcharge. Historical operation snapshots
// and the remaining model prices are immutable under this migration.
export async function retireImageReferencePricing(pool) {
  await pool.query(`UPDATE ai_model_pricing_components c JOIN ai_model_pricing_plans p ON p.id=c.plan_id
    SET c.status='disabled' WHERE p.task_type IN ('image_generation','image_edit')
      AND c.meter_code='additional_input_images' AND c.status<>'disabled'`)
}
