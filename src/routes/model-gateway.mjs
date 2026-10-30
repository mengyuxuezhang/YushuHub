import { bearer, endpoint } from './license-center.mjs'
import { scheduleSupplyPrice } from '../services/licensing/pricing.mjs'
import { failure } from '../services/licensing/protocol.mjs'
import { sseWriter } from '../services/licensing/streaming.mjs'

export function registerModelGatewayRoutes(app, { gateway, ledger, operators, monitor }) {
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
  if (monitor) {
    app.get(`${base}/operator/monitor`, endpoint(() => monitor.state()))
    app.put(`${base}/operator/monitor/config`, endpoint(req => monitor.configure(req.body, req.operator)))
    app.post(`${base}/operator/monitor/test`, endpoint(req => monitor.test(req.body.requestId, req.operator)))
  }
  app.post(`${base}/operator/requests/:id/resolve`, endpoint(req => gateway.reconcile(req.params.id, req.body, req.operator)))
  app.post(`${base}/operator/prices/:id`, endpoint(req => scheduleSupplyPrice(ledger.store, req.params.id, req.body, req.operator)))
  app.get(`${base}/catalog`, endpoint(req => gateway.catalog(bearer(req))))
  app.get(`${base}/balance`, endpoint(req => gateway.balance(bearer(req))))
  app.post(`${base}/requests`, endpoint(req => gateway.submit(bearer(req), req.body)))
  app.post(`${base}/requests/stream`, async (req, res, next) => {
    const writer = sseWriter(res)
    let chunks = 0
    try {
      if (req.body.request?.stream !== true) throw failure('STREAM_REQUIRED', '流式入口需要stream=true')
      const operation = await gateway.submit(bearer(req), req.body, {
        onAccepted: ({ requestId }) => { res.setHeader('X-Request-Id', requestId); writer.open() },
        onChunk: chunk => { chunks++; return writer.event('chunk', chunk) },
      })
      if (!writer.opened && !res.destroyed) res.setHeader('X-Request-Id', operation.requestId)
      writer.event('operation', { requestId: operation.requestId, state: operation.state, usage: operation.usage,
        ...(!chunks ? { result: operation.result } : {}) }); writer.end()
    } catch (error) {
      if (writer.opened) { writer.event('error', { code: error.code || 'SUPPLY_UNAVAILABLE', error: '流式请求需要查询原编号核对' }); writer.end() }
      else next(error)
    }
  })
  app.get(`${base}/requests/:id`, endpoint(req => gateway.status(bearer(req), req.params.id)))
  app.post(`${base}/requests/:id/poll`, endpoint(req => gateway.status(bearer(req), req.params.id, true)))
  app.post(`${base}/requests/:id/ack`, endpoint(req => gateway.acknowledge(bearer(req), req.params.id)))
  app.get(`${base}/recovery/requests/:id`, endpoint(req => gateway.recover(bearer(req), req.params.id)))
  app.post(`${base}/recovery/requests/:id/poll`, endpoint(req => gateway.recover(bearer(req), req.params.id, true)))
  app.post(`${base}/recovery/requests/:id/ack`, endpoint(req => gateway.acknowledgeRecovery(bearer(req), req.params.id)))
}
