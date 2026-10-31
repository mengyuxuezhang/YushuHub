import crypto from 'node:crypto'
import { createAccountingMonitor, emptyMonitorState, enqueueOperationalNotice } from './accounting-monitor.mjs'
import { identifier, verifyClaims } from './protocol.mjs'

export const emptyAvailabilityState = () => ({ ...emptyMonitorState(), availability: null })
const checkNames = new Set(['center-health', 'gateway-health', 'center-refresh', 'certificate', 'service-token', 'gateway-catalog', 'newapi', 'first-instance', 'probe'])
function origin(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error('HTTPS service origin required')
  return url.origin
}
async function json(response) {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Missing response')
  const parts = []; let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break
      size += value.length; if (size > 262144) { await reader.cancel(); throw new Error('Oversized response') }
      parts.push(value)
    }
  } finally { reader.releaseLock() }
  const result = JSON.parse(Buffer.concat(parts).toString('utf8'))
  if (!response.ok || result.success !== true) throw new Error('Service check rejected')
  return result.data ?? result
}

// A dedicated grant has no model access. Refresh/catalog check the real DB and
// authorization path without inference, money writes or operator credentials.
export async function checkAuthorizationAvailability(config, { fetchImpl = fetch, now = Date.now } = {}) {
  const center = origin(config.centerOrigin), gateway = origin(config.gatewayOrigin), failed = []
  identifier(config.grantId); identifier(config.instanceId)
  const call = async (url, token, body) => json(await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  async function check(name, action) {
    try { return { value: await action(), ok: true } } catch { failed.push(name); return { ok: false } }
  }
  await Promise.all([
    check('center-health', () => call(center + '/health')),
    check('gateway-health', () => call(gateway + '/health')),
    ...(config.newApiSettlementKey ? [check('newapi', () => call(gateway + '/api/okpa/v1/events', config.newApiSettlementKey))] : []),
    ...(config.firstHealthUrl ? [check('first-instance', async () => {
      const url = new URL(config.firstHealthUrl)
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port)) || url.username || url.password || url.search || url.hash) throw new Error('Invalid health URL')
      return call(url.href)
    })] : []),
  ])
  const refresh = await check('center-refresh', () => call(center + '/api/license-center/v1/refresh', config.credential, {}))
  if (refresh.ok) {
    const certificate = await check('certificate', async () => {
      const grant = refresh.value.grants?.find(row => row.id === config.grantId)
      const claims = verifyClaims(grant?.certificate, { keys: config.publicKeys, audience: 'deployment', instanceId: config.instanceId, now: now() })
      if (claims.id !== config.grantId || claims.level !== 1 || claims.domain !== config.publicUrl || claims.modelIds?.length !== 0) throw new Error('Observer binding or scope changed')
    })
    if (certificate.ok) {
      const service = await check('service-token', async () => {
        const result = await call(center + '/api/license-center/v1/service-token', config.credential, { audience: 'official-models', organizationId: config.grantId })
        const claims = verifyClaims(result.token, { keys: config.publicKeys, audience: 'official-models', instanceId: config.instanceId, now: now() })
        if (claims.sub !== config.grantId || claims.rootId !== config.grantId || claims.modelIds?.length !== 0) throw new Error('Observer service scope changed')
        return result.token
      })
      if (service.ok) await check('gateway-catalog', async () => {
        const catalog = await call(gateway + '/api/model-gateway/v1/catalog', service.value)
        if (!Array.isArray(catalog) || catalog.length) throw new Error('Observer must have no model access')
      })
    }
  }
  return { healthy: failed.length === 0, failed: failed.sort(), checkedAt: now() }
}

// Reuse the existing encrypted Webhook configuration and persistent delivery
// queue; this monitor never invents or reports accounting audit measurements.
export function createAvailabilityMonitor({ store, vault, label, check, fetchImpl = fetch, now = Date.now, failureThreshold = 2 }) {
  identifier(label)
  if (!Number.isSafeInteger(failureThreshold) || failureThreshold < 1 || failureThreshold > 10) throw new Error('Invalid failure threshold')
  const delivery = createAccountingMonitor({ store, vault, book: `availability:${label}`, fetchImpl, now,
    collect: async () => { throw new Error('Availability is not a financial collector') } })
  let running = false
  return {
    configure: (input, actor) => delivery.configure(input, actor),
    async state() { const value = await store.read(); return { ...(await delivery.state()), availability: value.availability } },
    async tick() {
      if (running) return
      running = true
      try {
        let result
        try {
          result = await check()
          if (typeof result?.healthy !== 'boolean' || !Array.isArray(result.failed) || result.failed.length > checkNames.size || result.failed.some(name => !checkNames.has(name))
            || result.healthy !== (result.failed.length === 0)) throw new Error('Invalid probe result')
        } catch { result = { healthy: false, failed: ['probe'] } }
        const timestamp = now()
        await store.transaction(state => {
          const old = state.availability || { startedAt: timestamp, generation: 0, firing: false, consecutiveFailures: 0, history: [] }
          const consecutiveFailures = result.healthy ? 0 : Math.min(10080, old.consecutiveFailures + 1)
          const firing = result.healthy ? false : old.firing || consecutiveFailures >= failureThreshold
          let generation = old.generation
          if (old.firing !== firing) {
            generation++
            enqueueOperationalNotice(state, { id: crypto.createHash('sha256').update(`${label}:availability:${generation}`).digest('hex'), kind: firing ? 'firing' : 'resolved',
              text: `【${firing ? '存活告警' : '存活恢复'}】${label}；失败检查=${result.failed.join(',') || '无'}；不包含财务核对结果。` }, timestamp)
          }
          state.availability = { startedAt: old.startedAt, checkedAt: timestamp, generation, firing, consecutiveFailures,
            healthy: result.healthy, failed: result.failed, history: [...old.history.slice(-10079), { at: timestamp, healthy: result.healthy, failed: result.failed }] }
        })
        await delivery.drain()
        return (await store.read()).availability
      } finally { running = false }
    },
  }
}
