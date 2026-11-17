// New disposable database only. Uses a cached image, no supplier requests.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import mysql from 'mysql2/promise'
import { seedBuiltinAudioModels } from '../src/services/builtin-model-seeding.mjs'
import { deleteProviderModel } from '../src/services/provider-model-deletion.mjs'
import { PricingPlanRepository } from '../src/repositories/pricing-plans.mjs'
import { ModelCapabilityService } from '../src/services/model-capability-service.mjs'

const exec = promisify(execFile), name = `removable-images-${randomBytes(6).toString('hex')}`, password = randomBytes(24).toString('hex')
const docker = (...args) => exec('docker', args, { windowsHide: true, env: { ...process.env, MYSQL_ROOT_PASSWORD: password } })
let pool, created = false
try {
  await docker('run', '-d', '--rm', '--pull=never', '--name', name, '--memory=384m', '--cpus=1', '-e', 'MYSQL_ROOT_PASSWORD', '-e', 'MYSQL_DATABASE=removable_images', '-p', '127.0.0.1::3306', 'mysql:5.7')
  created = true
  const port = Number((await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "3306/tcp") 0).HostPort}}', name)).stdout.trim())
  pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password, database: 'removable_images', connectionLimit: 2 })
  let ready = false
  for (let i = 0; i < 90; i++) { try { await pool.query('SELECT 1'); ready = true; break } catch { await delay(1000) } }
  assert.ok(ready)
  const schema = await readFile(new URL('../src/db/schema.mjs', import.meta.url), 'utf8')
  const ddls = new Map([...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \([\s\S]*?\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci/g)].map(match => [match[1], match[0]]))
  const tables = new Set()
  async function table(id) {
    if (tables.has(id)) return
    const ddl = ddls.get(id); assert.ok(ddl, id)
    tables.add(id)
    for (const ref of ddl.matchAll(/REFERENCES (\w+)\s*\(/g)) await table(ref[1])
    await pool.query(ddl)
  }
  for (const id of ['ai_model_providers','ai_provider_models','ai_model_upstream_accounts','ai_model_pricing_rules','ai_model_task_capabilities','ai_model_pricing_plans','ai_model_pricing_components','ai_private_voices','ai_model_operations','ai_voice_operations','ai_end_user_model_access','ai_membership_card_model_access','ai_system_voices']) await table(id)
  for (const id of ['ai_model_providers','ai_provider_models','ai_model_pricing_rules']) {
    const [columns] = await pool.query(`SHOW COLUMNS FROM ${id} LIKE 'organization_id'`)
    if (!columns.length) await pool.query(`ALTER TABLE ${id} ADD organization_id VARCHAR(64) NOT NULL DEFAULT ''`)
  }
  await pool.query('ALTER TABLE ai_provider_models ADD archived_at DATETIME(3) NULL')
  // These voice fields are added by normal schema migrations after CREATE TABLE.
  for (const [column, definition] of Object.entries({ voice_preview_points: 'DECIMAL(18,6) NULL DEFAULT NULL', voice_activation_points: 'DECIMAL(18,6) NULL DEFAULT NULL', voice_points_per_1k_chars: 'DECIMAL(18,6) NULL DEFAULT NULL', consumption_multiplier: 'DECIMAL(12,6) NOT NULL DEFAULT 1' })) {
    const [columns] = await pool.query(`SHOW COLUMNS FROM ai_model_pricing_rules LIKE '${column}'`)
    if (!columns.length) await pool.query(`ALTER TABLE ai_model_pricing_rules ADD ${column} ${definition}`)
  }
  await seedBuiltinAudioModels(pool)
  const [[fresh]] = await pool.query("SELECT COUNT(*) AS total FROM ai_provider_models WHERE model_type='image'")
  assert.equal(Number(fresh.total), 0)
  await pool.query("INSERT INTO ai_model_providers(id,name,base_url,status,notes) VALUES ('system-image-volcengine-ark','Custom image provider','https://images.example.invalid/v1','disabled','Operator notes')")
  await pool.query("INSERT INTO ai_provider_models(id,provider_id,model_id,display_name,model_type,endpoint_path,status) VALUES ('system-model-seedream-pro','system-image-volcengine-ark','doubao-seedream-5-0-pro-260628','Custom display name','image','/custom/images','disabled')")
  await pool.query("INSERT INTO ai_model_task_capabilities(id,provider_model_id,task_type,protocol_adapter,endpoint_path) VALUES ('image-cap','system-model-seedream-pro','image_generation','openai.images','/custom/images')")
  await pool.query("INSERT INTO ai_model_pricing_plans(id,provider_model_id,capability_id,task_type,status) VALUES ('image-plan','system-model-seedream-pro','image-cap','image_generation','disabled')")
  const snapshot = async () => (await pool.query("SELECT m.display_name,m.endpoint_path,m.status,p.base_url,p.notes,p.status AS provider_status FROM ai_provider_models m JOIN ai_model_providers p ON p.id=m.provider_id WHERE m.id='system-model-seedream-pro'"))[0]
  const before = await snapshot(); await seedBuiltinAudioModels(pool); assert.deepEqual(await snapshot(), before)
  const plans = await new PricingPlanRepository(pool).list({ organizationId: '', taskType: 'image_generation' })
  assert.equal(plans.find(plan => plan.id === 'image-plan').isProtected, false)
  const capabilities = await new ModelCapabilityService(pool, {}).list({ organizationId: '', providerModelId: 'system-model-seedream-pro' })
  assert.equal(capabilities[0].isSystem, false)
  await pool.query(`INSERT INTO ai_model_operations(id,user_id,capability_id,task_type,operation_type,idempotency_key,input_fingerprint,adapter_id,config_revision,pricing_snapshot_json,status)
    VALUES ('image-history','fixture-user','image-cap','image_generation','image_generation','fixture-request',REPEAT('a',64),'openai.images',1,JSON_OBJECT(),'outcome_unknown')`)
  await assert.rejects(deleteProviderModel(pool, 'system-model-seedream-pro', { platformScope: true }), { statusCode: 409 })
  await pool.query("UPDATE ai_model_operations SET status='succeeded',points_settled=10 WHERE id='image-history'")
  assert.equal((await deleteProviderModel(pool, 'system-model-seedream-pro', { platformScope: true })).deleted, true)
  await seedBuiltinAudioModels(pool)
  const [[hidden]] = await pool.query("SELECT COUNT(*) AS total FROM ai_provider_models WHERE id='system-model-seedream-pro' AND archived_at IS NULL")
  assert.equal(Number(hidden.total), 0)
  const [[history]] = await pool.query("SELECT status,points_settled FROM ai_model_operations WHERE id='image-history'")
  assert.equal(history.status, 'succeeded'); assert.equal(Number(history.points_settled), 10)
  const [[plan]] = await pool.query("SELECT status FROM ai_model_pricing_plans WHERE id='image-plan'"); assert.equal(plan.status, 'disabled')
  const [[audio]] = await pool.query("SELECT COUNT(*) AS total FROM ai_provider_models WHERE id='system-model-minimax-speech' AND archived_at IS NULL"); assert.equal(Number(audio.total), 1)
  console.log(JSON.stringify({ passed: true, checks: ['fresh installation has no image defaults','startup preserves edited image configuration','former image plan and capability are ordinary','pending image task prevents deletion','removed model stays archived on startup','historical task and points remain','audio defaults preserved'], supplierCalls: 0 }))
} finally { await pool?.end(); if (created) await docker('stop', '--time', '10', name).catch(() => {}) }
