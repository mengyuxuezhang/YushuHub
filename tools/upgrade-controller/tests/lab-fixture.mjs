// Disposable integration fixture only. Refuses all non-fixture databases.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const [root, action, phase = 'before'] = process.argv.slice(2)
if (!root || !['seed', 'check'].includes(action) || !['before', 'after'].includes(phase)) throw Error('Invalid fixture command')
await import(pathToFileURL(path.join(root, 'src/config/paths.mjs')).href)
const env = process.env
if (env.AI_DB_NAME !== 'fixture_controller' || env.AI_DB_PASSWORD !== 'fixture-only-local') throw Error('Disposable database required')
const mysql = createRequire(path.join(root, 'package.json'))('mysql2/promise')
const sql = await mysql.createConnection({ host: env.AI_DB_HOST, port: Number(env.AI_DB_PORT), user: env.AI_DB_USER, password: env.AI_DB_PASSWORD, database: env.AI_DB_NAME })
const { ModelCredentialVault } = await import(pathToFileURL(path.join(root, 'src/services/model-credentials.mjs')).href)
const vault = new ModelCredentialVault(path.join(root, 'data/model-credentials.key'))
const id = 'docker-fixture-' + phase
try {
  if (action === 'seed') {
    const [[org]] = await sql.query("SELECT primary_organization_id id FROM ai_users WHERE id='admin'")
    const ciphertext = await vault.seal('fixture-not-a-real-key-' + phase, id)
    await sql.beginTransaction()
    await sql.query('INSERT INTO ai_model_providers (id,name,base_url,organization_id) VALUES (?,?,?,?)', [id, id, 'https://fixture.invalid/v1', org.id])
    await sql.query('INSERT INTO ai_model_provider_keys (id,owner_user_id,provider_id,upstream_account_id,api_key,secret_ciphertext,organization_id) VALUES (?,\'admin\',?,?,\'\',?,?)', [id, id, id, ciphertext, org.id])
    await sql.query("INSERT INTO ai_end_users (id,username,display_name,password_hash,source_agent_id,organization_id,credit_balance) VALUES (?,?,?,'fixture-hash','admin',?,123.456789)", [id, id, '虚构迁移验收用户', org.id])
    await sql.query("INSERT INTO ai_end_user_memberships (id,user_id,card_id,package_name) VALUES (?,?,'free','虚构迁移验收会员')", [id, id])
    await sql.query("INSERT INTO ai_credit_ledger (id,user_id,change_type,points_delta,balance_after) VALUES (?,?,'recharge',123.456789,123.456789)", [id, id])
    await sql.query("INSERT INTO ai_payment_orders (id,order_no,owner_user_id,user_id,config_id,provider,payment_mode,idempotency_key,card_id,card_name,package_name,amount_fen,status,expires_at) VALUES (?,?,'admin',?,'fixture-only','wechat','native',?,'free','TEST','TEST',100,'fulfilled',DATE_ADD(NOW(),INTERVAL 1 DAY))", [id, id, id, id])
    await sql.commit()
    await fs.writeFile(path.join(root, 'data', id + '.txt'), 'persistent-fixture-' + phase)
  }
  const [[user]] = await sql.query('SELECT credit_balance FROM ai_end_users WHERE id=?', [id])
  assert.equal(user.credit_balance, '123.456789')
  const [[ledger]] = await sql.query('SELECT points_delta,balance_after FROM ai_credit_ledger WHERE id=?', [id])
  assert.equal(ledger.points_delta, '123.456789')
  assert.equal(ledger.balance_after, '123.456789')
  const [[order]] = await sql.query('SELECT status,amount_fen FROM ai_payment_orders WHERE id=?', [id])
  assert.equal(order.status, 'fulfilled')
  assert.equal(order.amount_fen, 100)
  const [[membership]] = await sql.query('SELECT package_name FROM ai_end_user_memberships WHERE id=?', [id])
  assert.equal(membership.package_name, '虚构迁移验收会员')
  const [[key]] = await sql.query('SELECT secret_ciphertext FROM ai_model_provider_keys WHERE id=?', [id])
  assert.equal(await vault.unseal(key.secret_ciphertext, id), 'fixture-not-a-real-key-' + phase)
  assert.equal(await fs.readFile(path.join(root, 'data', id + '.txt'), 'utf8'), 'persistent-fixture-' + phase)
  assert.equal(env.AI_LICENSE_INSTANCE_ID, 'fixture-stable-instance')
  const base = 'http://127.0.0.1:' + env.AI_ADMIN_PORT
  const challenge = (await (await fetch(base + '/api/login/captcha')).json()).data
  const svg = Buffer.from(challenge.imageDataUrl.split(',')[1], 'base64').toString()
  const captchaAnswer = [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(match => match[1]).join('')
  const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: env.AI_ADMIN_USER, password: env.AI_ADMIN_PASSWORD, challengeId: challenge.challengeId, captchaAnswer }) })
  assert.equal(response.status, 200)
  console.log(JSON.stringify({ phase, user: true, order: true, credits: true, membership: true, file: true, decryptedKey: true, instanceConfiguration: true, adminLogin: true }))
} finally {
  await sql.end()
}
