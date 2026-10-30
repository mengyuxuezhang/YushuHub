import { requireAuth, requireClientAuth, requirePermission } from '../middleware/auth.mjs'
import { endpoint } from './license-center.mjs'
import { failure } from '../services/licensing/protocol.mjs'
import { registerClientSupplyBridge } from './client-supply-bridge.mjs'

export const publicSupplyOperation = operation => ({ requestId: operation.requestId, state: operation.state, points: operation.points || null, result: operation.result || null })
export function publicSupplyCatalogRow(row, level) {
  if (level !== 2) return row
  const { supplierCost, ...model } = row.model
  return { ...row, model: { ...model, price: row.supply || model.price } }
}

export function registerAgentSupplyRoutes(app, { runtime, resolveUserContext, client }) {
  if (!runtime) return
  const context = async req => runtime.tenant(req.organizationContext)
  app.get('/api/supply/catalog', requireAuth, requirePermission('pricing_rules.manage'), endpoint(async req => {
    const tenant = await context(req), rows = await (await runtime.service()).list(tenant)
    return rows.map(row => publicSupplyCatalogRow(row, tenant.level))
  }))
  app.post('/api/supply/offers', requireAuth, requirePermission('pricing_rules.manage'), endpoint(async req => (await runtime.service()).configure(await context(req), req.body, req.user.id)))
  app.get('/api/supply/balance', requireAuth, requirePermission('pricing_rules.manage'), endpoint(async req => (await runtime.service()).balance(await context(req))))
  app.post('/api/supply/children/:id/credit', requireAuth, requirePermission('organizations.children.manage'), endpoint(async req => {
    const tenant = await context(req), child = await client.claims(req.params.id)
    if (child.parentId !== tenant.id) throw failure('BINDING_MISMATCH', '只能审核绑定直属二级充值', 403)
    return (await runtime.service()).credit(tenant, child.id, req.body.amount, req.body.requestId, req.body.receipt, req.user.id)
  }))
  const tenantForUser = async req => {
    const context = await resolveUserContext(req.clientUser)
    return runtime.tenant(context)
  }
  registerClientSupplyBridge(app, { runtime, tenantForUser })
  app.get('/api/client/supply/catalog', requireClientAuth, endpoint(async req => {
    const rows = await (await runtime.service()).list(await tenantForUser(req))
    return rows.filter(row => row.sale).map(row => ({ id: row.model.id, name: row.model.name, taskType: row.model.taskType, price: row.sale, pointsPerCny: row.pointsPerCny }))
  }))
  app.post('/api/client/supply/requests', requireClientAuth, endpoint(async req => {
    if (String(req.body.requestId || '').length > 80) throw failure('INVALID_ID', '请求ID不能超过80字符')
    return publicSupplyOperation(await (await runtime.service()).submit(await tenantForUser(req), req.clientUser.id, req.body))
  }))
  app.post('/api/client/supply/requests/:id/recover', requireClientAuth, endpoint(async req => publicSupplyOperation(await (await runtime.service()).recover(await tenantForUser(req), req.clientUser.id, req.params.id))))
}
