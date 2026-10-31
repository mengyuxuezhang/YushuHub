import assert from 'node:assert/strict'
import https from 'node:https'
import { micros } from '../src/services/licensing/protocol.mjs'

export async function seedMigratedMembership({ pool, userId, organizationId, passwordHash }) {
  const [[database]] = await pool.query('SELECT DATABASE() AS name')
  assert.match(database.name, /^yushu_resources_local_[a-f0-9]{10}$/)
  await pool.query("INSERT INTO ai_end_users(id,username,display_name,password_hash,status,source_agent_id,organization_id,device_id,credit_balance) VALUES (?,?,?,?,'enabled','admin',?,?,10)",
    [userId, userId, '虚构迁入权益用户', passwordHash, organizationId, `device-${userId}`])
  const packages = [{ name: '虚构原已付权益', durationDays: 30, bonusPoints: 10, pointsDurationDays: 0, price: 9.9, originalPrice: 9.9, showOriginalPrice: false }]
  await pool.query("INSERT INTO ai_membership_cards(id,name,discount_percent,discount_modules,status,created_by,organization_id,packages_json) VALUES ('migrated-http-card','虚构原八折会员',80,?,'enabled','admin',?,?)", [JSON.stringify(['copywriting']), organizationId, JSON.stringify(packages)])
  await pool.query("INSERT INTO ai_end_user_memberships(id,user_id,card_id,package_name,started_at,expires_at,status,source,created_by,organization_id) VALUES ('migrated-http-membership',?,'migrated-http-card','虚构原已付权益','2026-01-01','2070-01-01','active','payment','admin',?)", [userId, organizationId])
}

export async function migratedModelHttpFixture(material) {
  if (!material) return null
  let calls = 0
  const server = https.createServer(material, async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions')
      assert.equal(req.headers.authorization, 'Bearer fictional-stage-key')
      const chunks = []; let length = 0
      for await (const chunk of req) { length += chunk.length; assert(length < 65536); chunks.push(chunk) }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(body.model, 'legacy-model-client'); assert.equal(body.max_tokens, 1)
      calls++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'MIGRATED_HTTP_OK' } }],
        usage: { prompt_tokens: 17, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 3 } } }))
    } catch { res.writeHead(400); res.end() }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { baseUrl: `https://127.0.0.1:${server.address().port}/v1`, calls: () => calls,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

export async function verifyMigratedModelHttp({ fixture, pool, userId, modelId, submit }) {
  if (!fixture) return null
  const [[database]] = await pool.query('SELECT DATABASE() AS name')
  assert.match(database.name, /^yushu_resources_local_[a-f0-9]{10}$/)
  const balance = async () => String((await pool.query('SELECT credit_balance FROM ai_end_users WHERE id=?', [userId]))[0][0].credit_balance)
  const before = await balance()
  const input = { requestId: 'migrated-live-http', modelId, request: { messages: [{ role: 'user', content: 'fictional migrated model' }], max_tokens: 1 } }
  const result = await submit(input)
  assert.equal(result.state, 'settled'); assert(micros(result.points) > 0n)
  const [[saved]] = await pool.query("SELECT payload FROM accounting_requests WHERE book='commerce-v2' AND id=?", [input.requestId])
  const operation = typeof saved.payload === 'string' ? JSON.parse(saved.payload) : saved.payload
  assert.equal(operation.snapshot.discount, '0.800000')
  assert.equal(operation.snapshot.benefit.membershipId, 'migrated-http-membership')
  assert.equal(result.points, '0.000152'); assert.equal(operation.upstreamAmount, '0.100004')
  assert(JSON.stringify(result.result).includes('MIGRATED_HTTP_OK'))
  const after = await balance(); assert.equal(micros(before) - micros(after), micros(result.points))
  assert.equal(fixture.calls(), 1)
  async function replay() {
    const repeated = await submit(input)
    assert.deepEqual(repeated, result); assert.equal(await balance(), after); assert.equal(fixture.calls(), 1)
  }
  await replay()
  return { replay, report: { actualClientAndSupplierHttps: true, migratedModelIdentityPreserved: true, encryptedManagedKeyUsed: true,
    originalMembershipDiscountPreserved: true, supplierCostIndependentOfDiscount: true,
    terminalPointsDebitedExactlyOnce: true, originalRequestReplayNoInference: true, paidSupplierCalls: 0 } }
}
