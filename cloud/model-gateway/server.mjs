import { createSupplyLedger, emptyLedgerState } from '../../src/services/licensing/ledger.mjs'
import { createModelGateway } from '../../src/services/licensing/gateway.mjs'
import { httpGatewayAdapters } from '../../src/services/licensing/http-adapters.mjs'
import { registerModelGatewayRoutes } from '../../src/routes/model-gateway.mjs'
import { jsonFile, operatorRuntime, serviceApp, serviceDatabase, serviceErrors } from '../../src/services/licensing/runtime.mjs'
import { failure } from '../../src/services/licensing/protocol.mjs'

const { pool, store } = await serviceDatabase('AI_GATEWAY', emptyLedgerState())
if (process.argv.includes('--migrate')) {
  await store.migrate(); await pool.end(); console.log('Model gateway schema ready')
} else {
  const centerUrl = new URL(process.env.AI_LICENSE_CENTER_URL)
  if (centerUrl.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && ['localhost', '127.0.0.1'].includes(centerUrl.hostname))) throw new Error('License center requires HTTPS')
  const authorize = async (token, audience) => {
    const response = await fetch(`${centerUrl.origin}/api/license-center/v1/introspect`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ audience }), signal: AbortSignal.timeout(8000) })
    const payload = await response.json()
    if (!response.ok || !payload.success) throw failure('LICENSE_REJECTED', '授权中心校验失败', 403)
    return payload.data
  }
  const ledger = createSupplyLedger({ store }), gateway = createModelGateway({ ledger, authorize, models: await jsonFile(process.env.AI_GATEWAY_MODELS_FILE), adapters: httpGatewayAdapters() })
  const app = serviceApp()
  registerModelGatewayRoutes(app, { gateway, ledger, operators: await operatorRuntime(store, 'AI_GATEWAY') })
  serviceErrors(app)
  const server = app.listen(Number(process.env.AI_GATEWAY_PORT || 7082), process.env.AI_GATEWAY_HOST || '127.0.0.1', () => console.log('Model gateway listening'))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await pool.end(); process.exit(0) }))
}
