import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import mysql from 'mysql2/promise'

import { loadLocalEnv, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from '../src/config/env.mjs'
import { hashPassword } from '../src/utils/crypto.mjs'

loadLocalEnv()

const baseUrl = String(process.env.ADMIN_BASE_URL || 'http://127.0.0.1:7079').replace(/\/$/, '')
const retainEvidence = process.env.E2E_RETAIN_EVIDENCE === '1'
const suffix = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`
const userId = crypto.randomUUID()
const username = `seedream-pro-e2e-${suffix}`
const password = crypto.randomBytes(24).toString('base64url')
const deviceId = `seedream-pro-e2e-${suffix}`
let pool
let token = ''

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options)
  const text = await response.text()
  let value
  try { value = text ? JSON.parse(text) : null } catch { value = text }
  if (!response.ok || value?.success === false) {
    throw new Error(`${options.method || 'GET'} ${pathname} failed (${response.status}): ${String(value?.error?.message || value?.error || text).slice(0, 800)}`)
  }
  return value
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${token}`, ...extra }
}

async function cleanup() {
  if (!pool || retainEvidence) return
  for (const table of ['ai_end_user_sessions', 'ai_end_user_events', 'ai_end_user_model_access', 'ai_credit_ledger']) {
    await pool.query(`DELETE FROM ${table} WHERE user_id = ?`, [userId]).catch(() => {})
  }
  await pool.query('DELETE FROM ai_end_users WHERE id = ?', [userId]).catch(() => {})
}

try {
  pool = await mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    charset: 'utf8mb4',
    connectionLimit: 2,
  })

  const [[context]] = await pool.query(
    `SELECT m.id AS provider_model_id, m.model_id, m.organization_id,
            p.id AS provider_id, k.owner_user_id
       FROM ai_provider_models m
       JOIN ai_model_providers p ON p.id = m.provider_id AND p.status = 'enabled'
       JOIN ai_model_provider_keys k ON k.provider_id = p.id AND k.status = 'enabled'
      WHERE m.id = 'system-model-seedream-pro' AND m.status = 'enabled'
      ORDER BY k.created_at ASC LIMIT 1`,
  )
  assert(context, 'Seedream Pro enabled model/provider/key context is missing')
  assert.equal(context.model_id, 'doubao-seedream-5-0-pro-260628')

  await pool.query(
    `INSERT INTO ai_end_users
      (id, username, email, display_name, password_hash, status, source_agent_id,
       app_version, device_id, device_name, credit_balance, organization_id)
     VALUES (?, ?, ?, ?, ?, 'enabled', ?, '3.0.0-beta.11', ?, 'Seedream Pro E2E', 100, ?)`,
    [userId, username, `${username}@example.invalid`, username, hashPassword(password), context.owner_user_id, deviceId, context.organization_id || ''],
  )

  const login = await request('/api/client/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceId, deviceName: 'Seedream Pro E2E', appVersion: '3.0.0-beta.11' }),
  })
  token = String(login?.data?.token || '')
  assert(token, 'client login token is missing')

  const catalog = await request('/api/client/model/models', { headers: authHeaders() })
  const model = catalog?.data?.models?.find((item) => item.id === context.model_id)
  assert(model, 'Seedream Pro is absent from the client catalog')
  assert.deepEqual(model.pricing?.resolutionPoints, { '1K': 10, '1.5K': 10, '2K': 20 })
  assert.equal('resolutionCostPoints' in (model.pricing || {}), false)

  const first = await request('/api/client/images/generate', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: context.model_id,
      prompt: '一只白色陶瓷咖啡杯放在浅木桌上，柔和自然光，产品摄影，画面简洁，不含文字',
      size: '1K',
      outputFormat: 'jpeg',
      watermark: false,
    }),
  })
  assert.equal(first?.data?.model, context.model_id)
  assert.equal(first?.data?.images?.length, 1)
  assert.equal(first?.data?.billing?.points, 10)
  assert.equal(first?.data?.billing?.tierCounts?.['1K'], 1)

  const firstUrl = String(first.data.images[0].url || '')
  assert(firstUrl, '1K response did not contain an image URL')
  const referenceResponse = await fetch(firstUrl)
  assert(referenceResponse.ok, `failed to download generated reference image (${referenceResponse.status})`)
  const referenceBytes = Buffer.from(await referenceResponse.arrayBuffer())
  assert(referenceBytes.length > 0 && referenceBytes.length <= 12 * 1024 * 1024, 'generated reference image violates the local 12MB limit')
  const referenceMime = String(referenceResponse.headers.get('content-type') || 'image/jpeg').split(';', 1)[0]
  const referenceImage = `data:${referenceMime};base64,${referenceBytes.toString('base64')}`

  const second = await request('/api/client/images/generate', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: context.model_id,
      prompt: '保留杯子的造型，把背景改成干净的深蓝色摄影棚背景，柔和轮廓光，不含文字',
      size: '2K',
      outputFormat: 'png',
      watermark: false,
      referenceImages: [referenceImage],
    }),
  })
  assert.equal(second?.data?.model, context.model_id)
  assert.equal(second?.data?.images?.length, 1)
  assert.equal(second?.data?.billing?.points, 20)
  assert.equal(second?.data?.billing?.tierCounts?.['2K'], 1)

  const credits = await request('/api/client/credits/me', { headers: authHeaders() })
  const ledger = await request('/api/client/credits/ledger?limit=10', { headers: authHeaders() })
  const rows = Array.isArray(ledger?.data) ? ledger.data : ledger?.data?.items || []
  const imageRows = rows.filter((row) => row.modelName === context.model_id && row.changeType === 'consume')
  assert.equal(Number(credits?.data?.creditBalance), 70)
  assert.deepEqual(imageRows.map((row) => Number(row.pointsDelta)).sort((a, b) => a - b), [-20, -10])

  console.log(JSON.stringify({
    success: true,
    userId,
    modelId: context.model_id,
    catalogPricing: model.pricing,
    calls: [
      { size: '1K', format: 'jpeg', billedPoints: first.data.billing.points, actualSizes: first.data.usage.image_sizes, requestId: first.data.requestId },
      { size: '2K', format: 'png', references: 1, billedPoints: second.data.billing.points, actualSizes: second.data.usage.image_sizes, requestId: second.data.requestId },
    ],
    balanceBefore: 100,
    balanceAfter: Number(credits.data.creditBalance),
    ledgerDeltas: imageRows.map((row) => Number(row.pointsDelta)),
    retained: retainEvidence,
  }, null, 2))
} finally {
  await cleanup()
  await pool?.end().catch(() => {})
}
