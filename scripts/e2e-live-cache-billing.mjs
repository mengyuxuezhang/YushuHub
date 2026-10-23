import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'

import { loadLocalEnv, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from '../src/config/env.mjs'
import { normalizeTokenUsage, quotePricing, tokenUsageEvents } from '../src/services/compound-pricing.mjs'
import { hashPassword } from '../src/utils/crypto.mjs'

loadLocalEnv()
const baseUrl = String(process.env.ADMIN_BASE_URL || 'http://127.0.0.1:7079').replace(/\/$/, '')
const providerModelId = process.env.E2E_TEXT_MODEL_ID || 'deepseek-deepseek-v4-flash-vision-exp'
const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`
const userId = randomUUID(), planId = randomUUID()
const username = `cache-e2e-${stamp}`.slice(0, 48), password = `Cache-${randomBytes(18).toString('base64url')}!`
let pool, token = '', previousPlanId = '', capabilityId = ''

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, { method: options.method || 'GET', headers: {
    accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}),
  }, body: options.body ? JSON.stringify(options.body) : undefined })
  const text = await response.text(); let value
  try { value = JSON.parse(text) } catch { value = text }
  if (!response.ok || value?.success === false) throw new Error(`${pathname} (${response.status}): ${value?.error || text}`)
  return value
}

try {
  pool = await mysql.createPool({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME, charset: 'utf8mb4', connectionLimit: 2 })
  const [[model]] = await pool.query(`SELECT m.*,k.owner_user_id FROM ai_provider_models m
    JOIN ai_model_provider_keys k ON k.provider_id=m.provider_id AND k.status='enabled'
    WHERE m.id=? AND m.status='enabled' LIMIT 1`, [providerModelId])
  assert(model, 'funded text model is unavailable')
  const [[capability]] = await pool.query("SELECT id FROM ai_model_task_capabilities WHERE provider_model_id=? AND task_type='chat'", [model.id])
  assert(capability, 'text capability is unavailable'); capabilityId = capability.id
  const [[active]] = await pool.query("SELECT * FROM ai_model_pricing_plans WHERE capability_id=? AND status='enabled' ORDER BY version DESC LIMIT 1", [capabilityId])
  assert(active, 'active text pricing plan is unavailable'); previousPlanId = active.id
  const [sourceComponents] = await pool.query('SELECT * FROM ai_model_pricing_components WHERE plan_id=? ORDER BY sort_order,id', [active.id])
  const input = sourceComponents.find(item => item.meter_code === 'input_tokens')
  const output = sourceComponents.find(item => item.meter_code === 'output_tokens')
  assert(input && output, 'active text plan must contain input and output Token prices')
  const [[latest]] = await pool.query('SELECT MAX(version) AS version FROM ai_model_pricing_plans WHERE capability_id=?', [capabilityId])
  await pool.query("UPDATE ai_model_pricing_plans SET status='disabled' WHERE capability_id=? AND status='enabled'", [capabilityId])
  await pool.query(`INSERT INTO ai_model_pricing_plans
    (id,organization_id,provider_model_id,capability_id,task_type,version,status,consumption_multiplier)
    VALUES (?,?,?,?, 'chat',?,'enabled',?)`, [planId, model.organization_id || '', model.id, capabilityId, Number(latest.version || 0) + 1, Number(active.consumption_multiplier || 1)])
  for (const [meter, row, saleFactor, order] of [['input_tokens', input, 1, 10], ['cached_tokens', input, 0.5, 20], ['output_tokens', output, 1, 30]]) {
    await pool.query(`INSERT INTO ai_model_pricing_components
      (id,plan_id,meter_code,charge_phase,unit_size,minimum_units,rounding_mode,dimensions_json,cost_amount,cost_currency,sale_points,status,sort_order)
      VALUES (?,?,?,'usage',?,0,'none',JSON_OBJECT(),?,?,?,'enabled',?)`,
    [randomUUID(), planId, meter, row.unit_size, Number(row.cost_amount || 0) * saleFactor, row.cost_currency, Number(row.sale_points || 0) * saleFactor, order])
  }
  await pool.query(`INSERT INTO ai_end_users
    (id,username,email,display_name,password_hash,status,source_agent_id,app_version,device_id,device_name,credit_balance,organization_id)
    VALUES (?,?,?,?,?,'enabled',?,'3.0.10',?,'缓存计费真实联调',100,?)`,
  [userId, username, `${username}@example.invalid`, '缓存计费真实联调', hashPassword(password), model.owner_user_id, `cache-${stamp}`, model.organization_id || ''])
  await pool.query('INSERT INTO ai_end_user_model_access (user_id,provider_model_id) VALUES (?,?)', [userId, model.id])
  token = String((await request('/api/client/auth/login', { method: 'POST', body: { username, password, deviceId: `cache-${stamp}`, deviceName: '缓存计费真实联调', appVersion: '3.0.10' } }))?.data?.token || '')
  assert(token)
  const stablePrefix = `以下是用于验证服务端前缀缓存计费的固定上下文。${'这段内容必须保持完全一致，用来触发上游前缀缓存。'.repeat(220)}`
  let usage, response
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    response = await request('/api/client/model/v1/chat/completions', { method: 'POST', body: {
      model: model.model_id, stream: false, max_tokens: 24,
      messages: [{ role: 'system', content: stablePrefix }, { role: 'user', content: `只回复数字 ${attempt}` }],
    } })
    usage = normalizeTokenUsage(response.usage || {})
    if (usage.cachedTokens > 0) break
  }
  assert(usage?.cachedTokens > 0, `upstream did not report a cache hit after retries: ${JSON.stringify(response?.usage || {})}`)
  const plan = { id: planId, taskType: 'chat', version: Number(latest.version || 0) + 1, status: 'enabled', components: [
    { meter: 'input_tokens', phase: 'usage', unitSize: Number(input.unit_size), costAmount: Number(input.cost_amount), costCurrency: input.cost_currency, salePoints: Number(input.sale_points) },
    { meter: 'cached_tokens', phase: 'usage', unitSize: Number(input.unit_size), costAmount: Number(input.cost_amount) * 0.5, costCurrency: input.cost_currency, salePoints: Number(input.sale_points) * 0.5 },
    { meter: 'output_tokens', phase: 'usage', unitSize: Number(output.unit_size), costAmount: Number(output.cost_amount), costCurrency: output.cost_currency, salePoints: Number(output.sale_points) },
  ] }
  const expected = quotePricing(plan, tokenUsageEvents(plan, response.usage).events)
  const [ledger] = await pool.query("SELECT points_delta,raw_usage_json FROM ai_credit_ledger WHERE user_id=? AND change_type='consume' ORDER BY created_at DESC LIMIT 1", [userId])
  assert.equal(ledger.length, 1, 'billing ledger is missing')
  assert.equal(Math.abs(Number(ledger[0].points_delta)), Math.max(0.000001, expected.points))
  console.log(JSON.stringify({ success: true, model: model.model_id, usage, upstreamUsage: response.usage, expectedPoints: expected.points,
    chargedPoints: Math.abs(Number(ledger[0].points_delta)), lines: expected.lines.map(item => ({ meter: item.meter, quantity: item.quantity, salePoints: item.salePoints })) }))
} finally {
  if (pool) {
    for (const table of ['ai_end_user_sessions','ai_end_user_events','ai_end_user_model_access','ai_credit_ledger']) await pool.query(`DELETE FROM ${table} WHERE user_id=?`, [userId]).catch(() => {})
    await pool.query('DELETE FROM ai_end_users WHERE id=?', [userId]).catch(() => {})
    if (previousPlanId) await pool.query("UPDATE ai_model_pricing_plans SET status='enabled' WHERE id=?", [previousPlanId]).catch(() => {})
    await pool.query('DELETE FROM ai_model_pricing_plans WHERE id=?', [planId]).catch(() => {})
    await pool.end().catch(() => {})
  }
}
