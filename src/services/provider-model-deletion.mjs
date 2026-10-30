import { assertNotSystemImageRecord } from './image-generation.mjs'
import { assertModelServiceRecordInScope } from './model-service-scope.mjs'
import { assertSupplyVoiceMutationAllowed } from './licensing/private-voice-binding.mjs'

// Retain parent rows for voice, task and billing audit references.
export async function deleteProviderModel(pool, id, scope) {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [[model]] = await conn.query('SELECT * FROM ai_provider_models WHERE id=? FOR UPDATE', [id])
    if (!model) throw Object.assign(new Error('模型不存在'), { statusCode: 404 })
    assertNotSystemImageRecord(id, '该模型')
    assertModelServiceRecordInScope(model, scope, '模型')
    if (!model.archived_at) {
      await assertSupplyVoiceMutationAllowed(conn, { modelId: id })
      const [[voice]] = await conn.query("SELECT id FROM ai_private_voices WHERE provider_model_id=? AND status<>'deleted' LIMIT 1", [id])
      if (voice) throw Object.assign(new Error('该模型仍关联私有音色，请先删除关联音色后再删除模型'), { statusCode: 409 })
      const [[pending]] = await conn.query(`SELECT
        (SELECT COUNT(*) FROM ai_model_operations o JOIN ai_model_task_capabilities c ON c.id=o.capability_id
          WHERE c.provider_model_id=? AND o.status NOT IN ('succeeded','failed')) AS tasks,
        (SELECT COUNT(*) FROM ai_voice_operations o JOIN ai_private_voices v ON v.id=o.voice_id
          WHERE v.provider_model_id=? AND (o.status NOT IN ('succeeded','failed') OR o.cleanup_pending=1)) AS voices`, [id, id])
      if (Number(pending?.tasks) || Number(pending?.voices)) throw Object.assign(new Error('该模型仍有待处理任务或录音待清理，请完成清理后再删除'), { statusCode: 409 })
      await conn.query('DELETE FROM ai_end_user_model_access WHERE provider_model_id=?', [id])
      await conn.query('DELETE FROM ai_membership_card_model_access WHERE provider_model_id=?', [id])
      for (const table of ['ai_model_task_capabilities', 'ai_model_pricing_rules', 'ai_model_pricing_plans', 'ai_system_voices']) {
        await conn.query(`UPDATE ${table} SET status='disabled' WHERE provider_model_id=?`, [id])
      }
      await conn.query("UPDATE ai_provider_models SET status='disabled',is_default=0,archived_at=CURRENT_TIMESTAMP(3) WHERE id=?", [id])
    }
    await conn.commit()
    return { id, deleted: true }
  } catch (error) {
    await conn.rollback().catch(() => {})
    throw error
  } finally { conn.release() }
}
