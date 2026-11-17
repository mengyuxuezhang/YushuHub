import { SYSTEM_AUDIO_PROVIDER_ID, SYSTEM_AUDIO_MODEL_ID, SYSTEM_AUDIO_ACCOUNT_ID, SYSTEM_AUDIO_PRICING_ID } from './image-generation.mjs'

// Only audio remains platform-managed. Image models are explicitly configured
// by administrators; startup must neither create nor restore their records.
export async function seedBuiltinAudioModels(database) {
  await database.query(`INSERT INTO ai_model_providers
    (id,name,protocol,base_url,status,is_default,timeout_ms,sort_order,notes)
    VALUES (?,?, 'openai-compatible','https://api.minimax.chat','enabled',0,120000,110,?)
    ON DUPLICATE KEY UPDATE name=VALUES(name),protocol=VALUES(protocol),base_url=VALUES(base_url),timeout_ms=VALUES(timeout_ms),notes=VALUES(notes)`,
  [SYSTEM_AUDIO_PROVIDER_ID, 'MiniMax（语音与音色）', '系统内置语音服务；仅需配置唯一 Key，其余参数可编辑但不可删除'])
  await database.query(`INSERT INTO ai_provider_models
    (id,provider_id,model_id,display_name,description,model_type,endpoint_path,status,is_default,capabilities,context_window,sort_order)
    VALUES (?,?,?,'MiniMax Speech 2.8 Turbo','系统内置语音合成与私有音色模型','audio','/v1/t2a_v2','enabled',1,?,0,110)
    ON DUPLICATE KEY UPDATE model_id=VALUES(model_id),display_name=VALUES(display_name),description=VALUES(description),model_type=VALUES(model_type),endpoint_path=VALUES(endpoint_path),capabilities=VALUES(capabilities)`,
  [SYSTEM_AUDIO_MODEL_ID, SYSTEM_AUDIO_PROVIDER_ID, 'speech-2.8-turbo', JSON.stringify(['speech_synthesis','voice_cloning'])])
  await database.query(`INSERT INTO ai_model_upstream_accounts
    (id,organization_id,owner_user_id,provider_id,name,region,status,notes)
    VALUES (?,'','admin',?,'MiniMax 固定语音账号','','enabled','系统内置资源边界，仅需配置唯一 Key，不允许删除')
    ON DUPLICATE KEY UPDATE name=VALUES(name),notes=VALUES(notes)`, [SYSTEM_AUDIO_ACCOUNT_ID, SYSTEM_AUDIO_PROVIDER_ID])
  await database.query(`INSERT INTO ai_model_pricing_rules
    (id,provider_id,provider_model_id,billing_type,points_per_request,voice_preview_points,voice_activation_points,voice_points_per_1k_chars,consumption_multiplier,status)
    VALUES (?,?,?,'per_request',0,3,20,3,1,'enabled')
    ON DUPLICATE KEY UPDATE billing_type=VALUES(billing_type)`, [SYSTEM_AUDIO_PRICING_ID, SYSTEM_AUDIO_PROVIDER_ID, SYSTEM_AUDIO_MODEL_ID])
  const preferredAudioCapabilityId = 'system-capability-minimax-speech'
  await database.query(`INSERT INTO ai_model_task_capabilities
    (id,organization_id,provider_model_id,task_type,protocol_adapter,upstream_account_id,connection_role,endpoint_path,config_json,status)
    VALUES (?,'',?,'speech_synthesis','minimax.t2a',?,'voice','/v1/t2a_v2',JSON_OBJECT(),'enabled')
    ON DUPLICATE KEY UPDATE protocol_adapter=VALUES(protocol_adapter),upstream_account_id=VALUES(upstream_account_id),endpoint_path=VALUES(endpoint_path)`,
  [preferredAudioCapabilityId, SYSTEM_AUDIO_MODEL_ID, SYSTEM_AUDIO_ACCOUNT_ID])
  const [[audioCapability]] = await database.query("SELECT id FROM ai_model_task_capabilities WHERE provider_model_id=? AND task_type='speech_synthesis'", [SYSTEM_AUDIO_MODEL_ID])
  const audioCapabilityId = audioCapability.id
  const preferredAudioPlanId = 'system-plan-minimax-speech'
  await database.query(`INSERT IGNORE INTO ai_model_pricing_plans
    (id,organization_id,provider_model_id,capability_id,task_type,version,status,consumption_multiplier)
    VALUES (?,'',?,?,'speech_synthesis',1,'enabled',1)`, [preferredAudioPlanId, SYSTEM_AUDIO_MODEL_ID, audioCapabilityId])
  const [[audioPlan]] = await database.query('SELECT id FROM ai_model_pricing_plans WHERE capability_id=?', [audioCapabilityId])
  const audioPlanId = audioPlan.id
  for (const item of [
    ['preview','billable_characters','preview',1000,3,10],
    ['activation','resource_activation','activation',1,20,20],
    ['usage','billable_characters','usage',1000,3,30],
  ]) {
    const componentId = `system-pc-minimax-${item[0]}`
    await database.query(`DELETE own FROM ai_model_pricing_components own
      JOIN ai_model_pricing_components existing ON existing.plan_id=own.plan_id AND existing.id<>own.id
        AND existing.meter_code=? AND existing.charge_phase=?
        AND JSON_LENGTH(COALESCE(existing.dimensions_json,JSON_OBJECT()))=0
      WHERE own.id=? AND own.plan_id=?`, [item[1], item[2], componentId, audioPlanId])
    const [[existing]] = await database.query(`SELECT id FROM ai_model_pricing_components
      WHERE plan_id=? AND meter_code=? AND charge_phase=? AND JSON_LENGTH(COALESCE(dimensions_json,JSON_OBJECT()))=0 LIMIT 1`, [audioPlanId, item[1], item[2]])
    if (!existing) await database.query(`INSERT INTO ai_model_pricing_components
      (id,plan_id,meter_code,charge_phase,unit_size,cost_amount,cost_currency,sale_points,status,sort_order)
      VALUES (?,?,?,?,?,0,'CNY',?,'enabled',?)`, [componentId, audioPlanId, item[1], item[2], item[3], item[4], item[5]])
  }
}