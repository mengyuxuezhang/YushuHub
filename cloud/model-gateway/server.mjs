import { createSupplyLedger, emptyLedgerState } from '../../src/services/licensing/ledger.mjs'
import { createModelGateway } from '../../src/services/licensing/gateway.mjs'
import { httpGatewayAdapters } from '../../src/services/licensing/http-adapters.mjs'
import { registerModelGatewayRoutes } from '../../src/routes/model-gateway.mjs'
import { jsonFile, operatorRuntime, serviceApp, serviceDatabase, serviceErrors } from '../../src/services/licensing/runtime.mjs'
import { failure } from '../../src/services/licensing/protocol.mjs'
import { mysqlAccountingStore } from '../../src/repositories/accounting.mjs'
import { migrateSupplyVoiceSchema } from '../../src/repositories/supply-voices.mjs'
import { mysqlStateStore } from '../../src/repositories/licensing-state.mjs'
import { migrateAccounting } from '../../src/services/licensing/accounting-migration.mjs'
import { startAccountingRecovery } from '../../src/services/licensing/accounting-recovery.mjs'
import { createAccountingMonitor } from '../../src/services/licensing/accounting-monitor.mjs'
import { ModelCredentialVault } from '../../src/services/model-credentials.mjs'
import path from 'node:path'
import { privateVoiceStorage } from '../../src/services/licensing/private-voice-runtime.mjs'
import { registerPrivateVoiceGatewayRoutes } from '../../src/routes/private-voice-gateway.mjs'

const { pool } = await serviceDatabase('AI_GATEWAY', emptyLedgerState())
const store = mysqlAccountingStore(pool, 'official-v2', 'ledger')
const operators = mysqlStateStore(pool, 'official-v2-operators', {})
if (process.argv.includes('--migrate')) {
  try {
    await migrateAccounting({ pool, book: 'official-v2', kind: 'ledger', sourceId: 'state-v1', allowImport: process.argv.includes('--import-legacy') })
    await migrateSupplyVoiceSchema(pool)
    console.log('Model gateway accounting schema ready')
  } finally { await pool.end() }
} else {
  await store.assertReady()
  const monitorStore = mysqlStateStore(pool, 'official-v2-monitor', {})
  await monitorStore.read() // Explicit migration is required, never runtime DDL.
  const monitor = createAccountingMonitor({ store: monitorStore, collect: (previous, now) => store.monitoring(previous, now), book: 'official-v2',
    vault: new ModelCredentialVault(process.env.AI_GATEWAY_MONITOR_KEY_FILE || path.resolve('data/gateway-monitor.key')) })
  const centerUrl = new URL(process.env.AI_LICENSE_CENTER_URL)
  if (centerUrl.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && ['localhost', '127.0.0.1'].includes(centerUrl.hostname))) throw new Error('License center requires HTTPS')
  const authorize = async (token, audience) => {
    try {
      const response = await fetch(`${centerUrl.origin}/api/license-center/v1/introspect`, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ audience }), signal: AbortSignal.timeout(8000) })
      const payload = await response.json()
      if (!response.ok || !payload.success) throw failure('LICENSE_REJECTED', '授权中心校验失败', 403)
      return payload.data
    } catch (error) { monitor.reject(); throw error }
  }
  const privateVoiceStore = privateVoiceStorage({ pool, book: 'official-v2', directory: process.env.AI_GATEWAY_PRIVATE_VOICE_DIRECTORY, retentionDays: process.env.AI_GATEWAY_PRIVATE_VOICE_RETENTION_DAYS || 30 })
  if (privateVoiceStore) await privateVoiceStore.assertReady()
  const ledger = createSupplyLedger({ store }), gateway = createModelGateway({ ledger, authorize, models: await jsonFile(process.env.AI_GATEWAY_MODELS_FILE), adapters: httpGatewayAdapters(fetch, { privateVoiceStore }), privateVoiceStore })
  const voiceCleanup = privateVoiceStore && setInterval(() => privateVoiceStore.clean().catch(() => monitor.recoveryError()), 60_000)
  voiceCleanup?.unref()
  const stopRecovery = startAccountingRecovery(ledger, () => monitor.recoveryError())
  monitor.start()
  const app = serviceApp()
  registerModelGatewayRoutes(app, { gateway, ledger, monitor, operators: await operatorRuntime(operators, 'AI_GATEWAY') })
  registerPrivateVoiceGatewayRoutes(app, { gateway })
  serviceErrors(app)
  const server = app.listen(Number(process.env.AI_GATEWAY_PORT || 7082), process.env.AI_GATEWAY_HOST || '127.0.0.1', () => console.log(`Model gateway listening:${server.address().port}`))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(voiceCleanup); stopRecovery(); monitor.stop(); server.close(async () => { await pool.end(); process.exit(0) }) })
}
