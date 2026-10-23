import { randomUUID } from 'node:crypto'
import { assertModelServiceRecordInScope } from './model-service-scope.mjs'
import { syncAutomaticModelCapability } from './model-management-defaults.mjs'

function conflict(message) { return Object.assign(new Error(message), { statusCode: 409 }) }

// A deleted model is an archived identity, retained by billing and task history.
// Re-adding the same upstream model restores that identity, not its old grants
// or prices. Resolve by the database's unique provider/model pair, rather than
// assuming a regenerated slug still equals the original internal primary key.
export async function saveProviderModelRecord(pool, model, scope) {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [[byName]] = await conn.query(
      'SELECT * FROM ai_provider_models WHERE provider_id=? AND model_id=? FOR UPDATE',
      [model.provider.id, model.modelId],
    )
    const [[byId]] = await conn.query('SELECT * FROM ai_provider_models WHERE id=? FOR UPDATE', [model.id])
    if (byName && model.explicitId && byName.id !== model.id) {
      throw conflict('该服务商已存在相同上游模型 ID，请刷新模型列表后编辑')
    }
    // Generated slugs may collide after lowercasing, escaping or truncation.
    // Such a collision must never overwrite a different model's history.
    const previous = byName || (model.explicitId ? byId : null)
    const id = previous?.id || (byId ? randomUUID() : model.id)
    if (previous) {
      assertModelServiceRecordInScope(previous, scope, '模型')
      if (previous.provider_id !== model.provider.id) throw conflict('不能通过模型标识更换服务商，请在目标服务商下新增模型')
      if (previous.archived_at) {
        if (!byName) throw conflict('请使用已删除模型原来的服务商和上游模型 ID重新添加')
        if ((previous.model_type || 'text') !== model.modelType) throw conflict('重新添加已删除模型时须保持原模型类型，避免改变历史记录的含义')
      }
    }
    const organizationId = previous?.organization_id ?? model.provider.organizationId ?? ''
    if (model.isDefault) await conn.query('UPDATE ai_provider_models SET is_default=0 WHERE provider_id=? AND id<>?', [model.provider.id, id])
    await conn.query(`INSERT INTO ai_provider_models
      (id,provider_id,model_id,display_name,description,model_type,endpoint_path,status,is_default,capabilities,reasoning_config,context_window,sort_order,organization_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        model_id=VALUES(model_id),display_name=VALUES(display_name),description=VALUES(description),
        model_type=VALUES(model_type),endpoint_path=VALUES(endpoint_path),status=VALUES(status),
        is_default=VALUES(is_default),capabilities=VALUES(capabilities),reasoning_config=VALUES(reasoning_config),
        context_window=VALUES(context_window),sort_order=VALUES(sort_order),archived_at=NULL`, [
      id, model.provider.id, model.modelId, model.displayName, model.description, model.modelType,
      model.endpointPath, model.status, model.isDefault ? 1 : 0, JSON.stringify(model.capabilities),
      JSON.stringify(model.reasoning), model.contextWindow, model.sortOrder, organizationId,
    ])
    await syncAutomaticModelCapability(conn, {
      modelId: id, providerId: model.provider.id, modelType: model.modelType,
      organizationId, status: model.status,
    })
    await conn.commit()
    return id
  } catch (error) {
    await conn.rollback().catch(() => {})
    throw error
  } finally { conn.release() }
}
