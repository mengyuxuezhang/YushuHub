// Requires a locally cached mysql:5.7 image. Creates and removes only its own
// temporary container; no credentials, volumes or existing databases are reused.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import mysql from 'mysql2/promise'
import { ImageTaskService, publicImageTask } from '../src/services/image-tasks.mjs'
import { ModelOperationRepository } from '../src/repositories/model-operations.mjs'

const exec = promisify(execFile)
const name = `image-billing-test-${randomBytes(6).toString('hex')}`
const password = randomBytes(24).toString('hex')
let pool, created = false
const docker = (...args) => exec('docker', args, { windowsHide: true, env: { ...process.env, MYSQL_ROOT_PASSWORD: password }, maxBuffer: 1024 * 1024 })
try {
  await docker('run', '-d', '--rm', '--pull=never', '--name', name, '--memory=384m', '--cpus=1', '-e', 'MYSQL_ROOT_PASSWORD', '-e', 'MYSQL_DATABASE=image_task_test', '-p', '127.0.0.1::3306', 'mysql:5.7', '--max-allowed-packet=64M')
  created = true
  const port = Number((await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "3306/tcp") 0).HostPort}}', name)).stdout.trim())
  assert.ok(port > 0)
  const config = { host: '127.0.0.1', port, user: 'root', password, database: 'image_task_test', connectionLimit: 12 }
  let ready = false
  for (let i = 0; i < 90; i++) {
    try { const connection = await mysql.createConnection(config); await connection.end(); ready = true; break } catch { await delay(1000) }
  }
  assert.ok(ready, 'isolated database did not become ready')
  pool = mysql.createPool(config)
  await pool.query("CREATE TABLE ai_end_users (id VARCHAR(64) PRIMARY KEY,organization_id VARCHAR(64) NOT NULL,status VARCHAR(20) NOT NULL,credit_balance DECIMAL(24,8) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")
  await pool.query("CREATE TABLE ai_provider_models (id VARCHAR(64) PRIMARY KEY,status VARCHAR(20),archived_at DATETIME NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci")
  await pool.query("CREATE TABLE ai_model_task_capabilities (id VARCHAR(64) PRIMARY KEY,provider_model_id VARCHAR(64),status VARCHAR(20)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci")
  const schema = await readFile(new URL('../src/db/schema.mjs', import.meta.url), 'utf8')
  const ddl = /CREATE TABLE IF NOT EXISTS ai_model_operations \([\s\S]*?\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci/.exec(schema)?.[0]
  assert.ok(ddl); await pool.query(ddl)
  await pool.query("CREATE TABLE ai_credit_ledger (id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),organization_id VARCHAR(64),change_type VARCHAR(20),points_delta DECIMAL(24,8),balance_after DECIMAL(24,8),request_id VARCHAR(64),billing_type VARCHAR(30),deduct_status VARCHAR(20),note TEXT,raw_usage_json JSON) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")
  await pool.query("INSERT INTO ai_end_users VALUES ('user-a','org-a','enabled',100),('user-b','org-b','enabled',100),('legacy','','enabled',100)")
  await pool.query("INSERT INTO ai_provider_models VALUES ('model','enabled',NULL)")
  await pool.query("INSERT INTO ai_model_task_capabilities VALUES ('cap','model','enabled')")
  const operations = new ModelOperationRepository(pool)
  let calls = 0, status = 200
  const plan = { id: 'plan', capabilityId: 'cap', taskType: 'image_generation', status: 'enabled', components: [{ id: 'one', meter: 'image', unitSize: 1, phase: 'usage', salePoints: 10, costAmount: 0, costCurrency: 'CNY', dimensions: { resolution: '1K' } }] }
  const service = new ImageTaskService({ operations, resolveContext: async () => ({ model: { modelId: 'image-test' }, provider: { id: 'provider', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1' }, key: { apiKey: 'temporary-fixture-only' }, capabilityId: 'cap', configRevision: 1, pricingPlan: plan, pricingRates: { CNY: 1 } }),
    fetchImpl: async () => { calls++; await delay(20); return Response.json({ data: [{ b64_json: 'iVBORw0KGgo=', size: '1024x1024' }] }, { status }) } })
  const user = { id: 'user-a', organizationId: 'org-a' }, other = { id: 'user-b', organizationId: 'org-b' }
  const input = { requestId: 'concurrent-0001', model: 'model', prompt: 'fixture', size: '1024x1024' }
  await Promise.all(Array.from({ length: 12 }, () => service.submit(user, input)))
  const first = await operations.findByRequest(user, 'image_generation', input.requestId)
  assert.equal(first.status, 'succeeded'); assert.equal(calls, 1)
  assert.equal(Number((await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='user-a'"))[0][0].credit_balance), 90)
  assert.equal((await pool.query('SELECT COUNT(*) AS total FROM ai_credit_ledger'))[0][0].total, 1)
  await operations.finish(user, first.id, { status: 'succeeded', points: 10 })
  assert.equal((await pool.query('SELECT COUNT(*) AS total FROM ai_credit_ledger'))[0][0].total, 1)
  await assert.rejects(operations.find(other, first.id), { code: 'MODEL_TASK_NOT_FOUND' })
  await assert.rejects(operations.findByRequest(other, 'image_generation', input.requestId), { code: 'MODEL_TASK_NOT_FOUND' })
  await assert.rejects(service.submit(user, { ...input, prompt: 'changed' }), { code: 'MODEL_TASK_IDEMPOTENCY_CONFLICT' })
  status = 400
  const failed = await service.submit(user, { ...input, requestId: 'known-failure-0001' })
  assert.equal(failed.status, 'failed'); assert.equal(Number(failed.points_reserved), 0)
  assert.equal(Number((await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='user-a'"))[0][0].credit_balance), 90)
  status = 503
  const unknownInput = { ...input, requestId: 'unknown-0000001' }
  const unknown = await service.submit(user, unknownInput); assert.equal(unknown.status, 'outcome_unknown'); assert.equal(Number(unknown.points_reserved), 10)
  const before = calls; await service.submit(user, unknownInput); assert.equal(calls, before)
  status = 200
  const legacy = publicImageTask(await service.submit({ id: 'legacy', organizationId: '' }, input))
  assert.equal(legacy.status, 'succeeded'); assert.equal(legacy.settledPoints, 10)
  assert.equal(JSON.stringify(legacy).includes('temporary-fixture-only'), false)
  console.log(JSON.stringify({ passed: true, checks: ['12-way idempotency', 'single ledger', 'duplicate settlement', 'account isolation', 'input conflict', 'known failure refund', 'unknown reservation and no retry', 'legacy account scope'] }))
} finally {
  await pool?.end()
  if (created) await docker('stop', '--time', '10', name)
}
