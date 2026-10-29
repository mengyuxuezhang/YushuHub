import { bearer, endpoint } from './license-center.mjs'
import { scheduleSupplyPrice } from '../services/licensing/pricing.mjs'

export function registerModelGatewayRoutes(app, { gateway, ledger, operators }) {
  const base = '/api/model-gateway/v1'
  app.post(`${base}/operator/login`, endpoint(req => operators.login(req.body, req.ip)))
  app.post(`${base}/operator/logout`, endpoint(req => operators.logout(bearer(req))))
  app.use(`${base}/operator`, async (req, _res, next) => {
    try { req.operator = await operators.authenticate(bearer(req)); next() } catch (error) { next(error) }
  })
  app.post(`${base}/operator/wallets`, endpoint(req => ledger.open(req.body.organizationId, req.body.organizationId)))
  app.post(`${base}/operator/wallets/:id/credit`, endpoint(req => ledger.credit(req.params.id, req.body.amount, req.body.requestId, req.operator, req.body.receipt)))
  app.post(`${base}/operator/wallets/:id/reverse`, endpoint(req => ledger.reverse(req.params.id, req.body.entryId, req.body.requestId, req.operator, req.body.reason)))
  app.get(`${base}/operator/reconciliation`, endpoint(() => ledger.reconciliation()))
  app.post(`${base}/operator/requests/:id/resolve`, endpoint(req => gateway.reconcile(req.params.id, req.body, req.operator)))
  app.post(`${base}/operator/prices/:id`, endpoint(req => scheduleSupplyPrice(ledger.store, req.params.id, req.body, req.operator)))
  app.get(`${base}/catalog`, endpoint(req => gateway.catalog(bearer(req))))
  app.get(`${base}/balance`, endpoint(req => gateway.balance(bearer(req))))
  app.post(`${base}/requests`, endpoint(req => gateway.submit(bearer(req), req.body)))
  app.get(`${base}/requests/:id`, endpoint(req => gateway.status(bearer(req), req.params.id)))
  app.post(`${base}/requests/:id/poll`, endpoint(req => gateway.status(bearer(req), req.params.id, true)))
  app.post(`${base}/requests/:id/ack`, endpoint(req => gateway.acknowledge(bearer(req), req.params.id)))
}
