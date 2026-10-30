import { requireAuth, requireClientAuth, requirePermission, requireAnyPermission } from '../middleware/auth.mjs'
import { endpoint } from './license-center.mjs'
import { failure } from '../services/licensing/protocol.mjs'
import { registerClientSupplyBridge } from './client-supply-bridge.mjs'
import { publicSupplyPlan } from '../services/licensing/pricing.mjs'

export const publicSupplyOperation = operation => ({ requestId: operation.requestId, state: operation.state, points: operation.points || null, result: operation.result || null })
export function publicSupplyCatalogRow(row, level) {
  if (level !== 2) return { ...row, model: { ...row.model, supplierCost: publicSupplyPlan(row.model.supplierCost) }, sale: publicSupplyPlan(row.sale), supply: publicSupplyPlan(row.supply) }
  const { supplierCost, nextPrices, ...model } = row.model
  return { ...row, model: { ...model, price: publicSupplyPlan(row.supply || model.price) }, sale: publicSupplyPlan(row.sale), supply: publicSupplyPlan(row.supply),
    priceNotices: (row.priceNotices || []).map(({ effectiveAt, sale, pointsPerCny, consumptionMultiplier }) => ({ effectiveAt, sale: publicSupplyPlan(sale), pointsPerCny, consumptionMultiplier })) }
}

export function registerAgentSupplyRoutes(app, { runtime, resolveUserContext, client, repository }) {
  if (!runtime) return
  const context = async req => runtime.tenant(req.organizationContext)
  app.get('/api/supply/catalog', requireAuth, requirePermission('pricing_rules.manage'), endpoint(async req => {
    const tenant = await context(req), rows = await (await runtime.service()).list(tenant)
    return rows.map(row => publicSupplyCatalogRow(row, tenant.level))
  }))
  app.post('/api/supply/offers', requireAuth, requirePermission('pricing_rules.manage'), endpoint(async req => (await runtime.service()).configure(await context(req), req.body, req.user.id)))
  app.get('/api/supply/balance', requireAuth, requireAnyPermission(['pricing_rules.manage', 'credits.manage']), endpoint(async req => (await runtime.service({ recovery: true })).balance(await runtime.recordTenant(req.organizationContext))))
  app.post('/api/supply/children/:id/reverse', requireAuth, requirePermission('credits.manage'), endpoint(async req => {
    const local = req.organizationContext
    if (local.organizationLevel !== 1 || !local.isOwner || local.memberStatus !== 'enabled') throw failure('OWNER_REQUIRED', '供货冲正须由所属一级组织所有者操作', 403)
    const child = await repository.findOrganizationById(req.params.id)
    if (!child || child.agentLevel !== 2 || child.parentOrganizationId !== local.organizationId) throw failure('NOT_FOUND', '直属二级不存在', 404)
    const tenant = await runtime.recordTenant(local)
    return (await runtime.service({ recovery: true })).reverse(tenant, child.externalId || child.id, req.body.entryId, req.body.requestId, req.body.reason, req.user.id)
  }))
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
    return rows.filter(row => row.sale).map(row => ({ id: row.model.id, name: row.model.name, taskType: row.model.taskType, price: publicSupplyPlan(row.sale), pointsPerCny: row.pointsPerCny,
      priceNotices: (row.priceNotices || []).map(({ effectiveAt, sale, pointsPerCny, consumptionMultiplier }) => ({ effectiveAt, price: publicSupplyPlan(sale), pointsPerCny, consumptionMultiplier })) }))
  }))
  app.post('/api/client/supply/requests', requireClientAuth, endpoint(async req => {
    if (String(req.body.requestId || '').length > 80) throw failure('INVALID_ID', '请求ID不能超过80字符')
    return publicSupplyOperation(await (await runtime.service()).submit(await tenantForUser(req), req.clientUser.id, req.body))
  }))
  app.post('/api/client/supply/requests/:id/recover', requireClientAuth, endpoint(async req => publicSupplyOperation(await (await runtime.service()).recover(await tenantForUser(req), req.clientUser.id, req.params.id))))
}
