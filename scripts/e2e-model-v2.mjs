import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import mysql from 'mysql2/promise'

const base = String(process.env.AI_E2E_BASE_URL || 'http://127.0.0.1:7079').replace(/\/$/, '')
const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`
const ids = { provider: `p253-provider-${stamp}`, vectorModel: `p253-vector-${stamp}`, videoModel: `p253-video-${stamp}` }
let adminCookie = '', clientToken = '', userId = ''
const capabilityIds = [], planIds = [], operationIds = []

const invariant = (value, message) => { if (!value) throw new Error(message) }
async function request(path, { method = 'GET', body, admin = false, client = false } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(admin ? { cookie: adminCookie } : {}), ...(client ? { authorization: `Bearer ${clientToken}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.success === false) throw new Error(`${method} ${path} failed (${response.status}): ${payload.error || 'unknown'}`)
  return { data: payload.data, response }
}

async function waitForRuntime() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { if ((await fetch(`${base}/api/runtime-info`)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('Admin did not recover after restart')
}

async function cleanup() {
  if (!process.env.AI_DB_NAME) return
  const connection = await mysql.createConnection({ host: process.env.AI_DB_HOST, port: Number(process.env.AI_DB_PORT || 3306), user: process.env.AI_DB_USER, password: process.env.AI_DB_PASSWORD, database: process.env.AI_DB_NAME })
  try {
    await connection.beginTransaction()
    if (operationIds.length) await connection.query('DELETE FROM ai_credit_ledger WHERE request_id IN (?)', [operationIds])
    if (userId) {
      await connection.query('DELETE FROM ai_model_operations WHERE user_id=?', [userId])
      await connection.query('DELETE FROM ai_credit_ledger WHERE user_id=?', [userId])
      await connection.query('DELETE FROM ai_end_user_sessions WHERE user_id=?', [userId])
      await connection.query('DELETE FROM ai_end_user_events WHERE user_id=?', [userId])
      await connection.query('DELETE FROM ai_end_users WHERE id=?', [userId])
    }
    await connection.query('DELETE FROM ai_provider_models WHERE provider_id=?', [ids.provider])
    await connection.query('DELETE FROM ai_model_providers WHERE id=?', [ids.provider])
    await connection.commit()
  } catch (error) { await connection.rollback(); throw error }
  finally { await connection.end() }
}

try {
  invariant(process.env.AI_ADMIN_USER && process.env.AI_ADMIN_PASSWORD, 'Admin E2E credentials are unavailable')
  const login = await request('/api/login', { method: 'POST', body: { username: process.env.AI_ADMIN_USER, password: process.env.AI_ADMIN_PASSWORD } })
  adminCookie = String(login.response.headers.get('set-cookie') || '').split(';')[0]
  invariant(adminCookie, 'Admin session cookie missing')

  await request('/api/model-providers', { method: 'POST', admin: true, body: { id: ids.provider, name: `P253 Mock ${stamp}`, baseUrl: 'http://127.0.0.1:9', status: 'enabled' } })
  for (const [id, modelId, modelType] of [[ids.vectorModel, `mock-vector-${stamp}`, 'text'], [ids.videoModel, `mock-video-${stamp}`, 'video']]) {
    await request('/api/provider-models', { method: 'POST', admin: true, body: { id, providerId: ids.provider, modelId, displayName: modelId, modelType, status: 'enabled' } })
  }
  const vectorCapability = (await request('/api/model-capabilities', { method: 'POST', admin: true, body: { providerModelId: ids.vectorModel, taskType: 'embedding', protocolAdapter: 'mock.embeddings', endpoints: { submit: '/mock/embeddings' }, status: 'enabled' } })).data
  const videoCapability = (await request('/api/model-capabilities', { method: 'POST', admin: true, body: { providerModelId: ids.videoModel, taskType: 'video_generation', protocolAdapter: 'mock.video_jobs', endpoints: { submit: '/mock/videos', poll: '/mock/videos/{id}' }, status: 'enabled' } })).data
  capabilityIds.push(vectorCapability.id, videoCapability.id)
  const vectorPlan = (await request('/api/pricing-plans', { method: 'POST', admin: true, body: { capabilityId: vectorCapability.id, taskType: 'embedding', status: 'enabled', components: [
    { meter: 'input_tokens', phase: 'usage', unitSize: 1, salePoints: 1, costAmount: 0.01, costCurrency: 'CNY' },
    { meter: 'vector_inputs', phase: 'usage', unitSize: 1, salePoints: 2, costAmount: 0.02, costCurrency: 'CNY' },
  ] } })).data
  const videoPlan = (await request('/api/pricing-plans', { method: 'POST', admin: true, body: { capabilityId: videoCapability.id, taskType: 'video_generation', status: 'enabled', components: [
    { meter: 'video_seconds', phase: 'usage', unitSize: 1, dimensions: { resolution: '720p' }, salePoints: 3, costAmount: 0.5, costCurrency: 'CNY' },
  ] } })).data
  planIds.push(vectorPlan.id, videoPlan.id)

  const password = randomBytes(18).toString('base64url')
  const username = `p253t${stamp}`.slice(0, 32)
  const user = (await request('/api/end-users', { method: 'POST', admin: true, body: { username, email: `${username}@example.invalid`, displayName: 'P253 E2E', password, status: 'enabled' } })).data
  userId = user.id
  await request(`/api/end-users/${encodeURIComponent(userId)}/credits`, { method: 'POST', admin: true, body: { amount: 1000, note: 'P253 isolated E2E' } })
  await request(`/api/end-users/${encodeURIComponent(userId)}/model-access`, { method: 'POST', admin: true, body: { modelIds: [ids.vectorModel, ids.videoModel] } })
  clientToken = (await request('/api/client/auth/login', { method: 'POST', body: { username, password, deviceId: `p253-${stamp}`, deviceName: 'isolated-e2e', appVersion: '3.0.10' } })).data.token

  const before = (await request('/api/client/credits/me', { client: true })).data.creditBalance
  const vectorInput = { capabilityId: vectorCapability.id, pricingPlanId: vectorPlan.id, operationType: 'embedding', idempotencyKey: `vector_${stamp}`,
    estimatedUsage: [{ meter: 'input_tokens', quantity: 4 }, { meter: 'vector_inputs', quantity: 2 }], request: { inputs: ['hello', 'world'] } }
  const vector = (await request('/api/client/model-tasks', { method: 'POST', client: true, body: vectorInput })).data
  operationIds.push(vector.id)
  invariant(vector.status === 'succeeded' && vector.settledPoints === 8, 'Vector task did not settle expected compound price')
  const duplicate = (await request('/api/client/model-tasks', { method: 'POST', client: true, body: vectorInput })).data
  invariant(duplicate.id === vector.id, 'Idempotent vector retry created another operation')
  const afterVector = (await request('/api/client/credits/me', { client: true })).data.creditBalance
  invariant(Number(before) - Number(afterVector) === 8, 'Idempotent vector task charged more than once')

  const video = (await request('/api/client/model-tasks', { method: 'POST', client: true, body: { capabilityId: videoCapability.id, pricingPlanId: videoPlan.id,
    operationType: 'video_generation', idempotencyKey: `video_${stamp}`, estimatedUsage: [{ meter: 'video_seconds', quantity: 5, dimensions: { resolution: '720p' } }],
    request: { seconds: 5, resolution: '720p' } } })).data
  operationIds.push(video.id)
  invariant(video.status === 'running', 'Video task did not persist an async handle')
  execFileSync('pm2', ['restart', String(process.env.AI_ADMIN_PM2_NAME || 'agent-ai-admin-120-53-230-168-1int7nc'), '--update-env'], { stdio: 'ignore' })
  await waitForRuntime()
  let polled = (await request(`/api/client/model-tasks/${video.id}/poll`, { method: 'POST', client: true })).data
  if (polled.status === 'running') polled = (await request(`/api/client/model-tasks/${video.id}/poll`, { method: 'POST', client: true })).data
  invariant(polled.status === 'succeeded' && polled.settledPoints === 15, 'Video task did not recover and settle after restart')
  console.log(JSON.stringify({ success: true, vector: { idempotent: true, points: 8 }, video: { restartRecovered: true, points: 15 } }))
} finally {
  await cleanup()
}
