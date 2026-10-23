import { modelServiceScopeWhere } from '../services/model-service-scope.mjs'

export async function queryModelProviders(pool, actor = null, scope = null) {
  const orgFilter = modelServiceScopeWhere(scope, 'p')
  const [rows] = await pool.query(`SELECT p.*,
    (SELECT COUNT(*) FROM ai_model_provider_keys k WHERE k.provider_id=p.id AND k.owner_user_id=?) AS key_count,
    (SELECT COUNT(*) FROM ai_provider_models m WHERE m.provider_id=p.id AND m.archived_at IS NULL) AS model_count,
    EXISTS(SELECT 1 FROM ai_provider_models vm JOIN ai_model_task_capabilities vc ON vc.provider_model_id=vm.id
      WHERE vm.provider_id=p.id AND vm.archived_at IS NULL AND vc.protocol_adapter='minimax.t2a') AS has_managed_voice
    FROM ai_model_providers p
    ${orgFilter.clause ? `WHERE ${orgFilter.clause}` : ''}
    ORDER BY p.sort_order ASC,p.created_at ASC`, [actor?.id || 'admin', ...orgFilter.params])
  return rows
}
