import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import mysql from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { initDatabase } from '../db/schema.mjs'
import { setPool } from '../db/pool.mjs'
import { setAuthDependencies } from '../middleware/auth.mjs'
import { registerVendorCostRoutes } from '../routes/vendor-cost.mjs'
import { migrateVendorCosts, historicalTaskCost, settledCost, directCallCost } from '../services/vendor-cost.mjs'
import { quotePricing, usageEvent } from '../services/compound-pricing.mjs'
import { ModelOperationRepository } from './model-operations.mjs'
import { VoiceOperationRepository } from './voice-operations.mjs'
import { costQuery } from './vendor-cost.mjs'

const events = [usageEvent('request', 1, { phase: 'request' })]
const plan = {
  id: 'plan',
  version: 1,
  taskType: 'chat',
  components: [
    {
      id: 'request',
      meter: 'request',
      phase: 'request',
      unitSize: 1,
      costAmount: 2,
      costCurrency: 'USD',
      salePoints: 0,
    },
  ],
}
const rates = { USD: 7, CNY: 1 }
test('vendor costs use recorded rates and price, including free-to-user calls and explicit zero', () => {
  const quote = quotePricing(plan, events, rates)
  const ctx = { pricingPlan: plan, pricingRates: rates }
  assert.equal(directCallCost(ctx, { compoundQuote: quote }, {}).cny, 14)
  assert.equal(directCallCost({ ...ctx, pricingPlan: null }, { compoundQuote: quote }, {}), null)
  const tokenPlan = {
    ...plan,
    components: [
      { ...plan.components[0], meter: 'input_tokens', phase: 'usage', unitSize: 1000000, costAmount: 0.1 },
    ],
  }
  const tokenQuote = quotePricing(tokenPlan, [usageEvent('input_tokens', 1)], rates)
  assert.equal(directCallCost({ ...ctx, pricingPlan: tokenPlan }, { compoundQuote: tokenQuote }, {}), null)
  assert.equal(
    directCallCost({ ...ctx, pricingPlan: tokenPlan }, { compoundQuote: tokenQuote }, { prompt_tokens: 1 }).cny,
    0.0000007,
  )
  assert.equal(quote.points, 0)
  assert.equal(settledCost(quote, rates).cny, 14)
  const row = { pricing_snapshot_json: { plan, exchangeRates: rates }, usage_json: events }
  assert.equal(historicalTaskCost(row).cny, 14)
  assert.equal(historicalTaskCost({ ...row, cost_snapshot_json: { CNY: 0 } }).cny, 0)
  assert.equal(historicalTaskCost({ cost_snapshot_json: { USD: 2 } }), null)
  assert.equal(historicalTaskCost({ cost_usd: 0 }), null)
  assert.equal(costQuery({ month: '2026-11' }).end, Date.parse('2026-12-01T00:00:00+08:00') / 1000)
  assert.throws(() => costQuery({ month: '2026-13' }))
})

test(
  'department assignment and scoped monthly reconciliation on a disposable database',
  { skip: !process.env.TEST_VENDOR_COST_MYSQL_URL },
  async () => {
    const url = new URL(process.env.TEST_VENDOR_COST_MYSQL_URL)
    const admin = await mysql.createConnection(url.href)
    const name = 'test_vendor_cost_' + randomUUID().replaceAll('-', '')
    let pool, server
    try {
      await admin.query('CREATE DATABASE ?? CHARACTER SET utf8mb4', [name])
      const options = {
        dbName: name,
        dbHost: url.hostname,
        dbPort: Number(url.port),
        dbUser: url.username,
        dbPassword: url.password,
        adminUser: 'fixture',
        adminPassword: 'fixture',
        safeUsername: (v) => v,
        hashPassword: () => 'fixture',
        publicUpdateBaseUrl: 'https://example.invalid',
        defaultPlatformSettings: {
          systemName: 'test',
          systemSubtitle: 'test',
          loginTitle: 'test',
          loginSubtitle: 'test',
          primaryColor: '#123456',
          logoText: 'test',
        },
        seedDefaultRoleTemplates: async () => {},
        seedDefaultModelProviderData: async () => {},
        setPool: (p) => {
          pool = p
          setPool(p)
        },
      }
      await initDatabase(options)
      const [[org]] = await pool.query('SELECT id FROM ai_organizations LIMIT 1')
      await pool.query(
        "INSERT INTO ai_organizations (id,name,root_organization_id,runtime_owner_organization_id) VALUES ('foreign','外部组织','foreign','foreign')",
      )
      await pool.query(
        "INSERT INTO ai_end_users (id,organization_id,username,display_name,password_hash) VALUES ('alice',?,'alice','甲','x'),('bob','foreign','bob','乙','x')",
        [org.id],
      )
      const [[user]] = await pool.query("SELECT cost_department_id FROM ai_end_users WHERE id='alice'")
      assert.equal(user.cost_department_id, 'default')
      let keys = ['end_users.manage']
      const actor = {
        id: 'operator',
        organizationContext: { organizationId: org.id, accessibleOrganizationIds: [org.id] },
      }
      setAuthDependencies({ getUserBySession: async () => actor, getEffectivePermissionKeys: async () => keys })
      const app = express()
      app.use(express.json())
      registerVendorCostRoutes(app)
      server = app.listen(0, '127.0.0.1')
      await new Promise((r) => server.once('listening', r))
      const base = 'http://127.0.0.1:' + server.address().port + '/api/'
      const save = (body) =>
        fetch(base + 'cost-departments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ organizationId: org.id, ...body }),
        })
      assert.equal((await save({ name: '设计部' })).status, 200)
      const [departments] = await pool.query('SELECT id FROM ai_cost_departments')
      const id = departments[0].id
      assert.equal((await save({ id, userIds: ['alice', 'bob'] })).status, 403)
      assert.equal((await save({ id, userIds: ['alice'] })).status, 200)
      async function call(
        key,
        who,
        organization,
        dept,
        cost,
        kind,
        source,
        requestId = key,
        date = '2026-11-10T12:00:00+08:00',
      ) {
        await pool.query(
          `INSERT INTO ai_credit_ledger (id,user_id,organization_id,change_type,points_delta,balance_after,request_id,cost_department_id,vendor_cost,call_kind,client_source,created_at,raw_usage_json)
        VALUES (?,?,?,'consume',0,0,?,?,?,?,?,FROM_UNIXTIME(?),?)`,
          [
            key,
            who,
            organization,
            requestId,
            dept,
            cost == null ? null : JSON.stringify({ cny: cost }),
            kind,
            source,
            Date.parse(date) / 1000,
            kind === 'image' ? '{"generated_images":3}' : null,
          ],
        )
      }
      await call('first', 'alice', org.id, 'default', 14, 'text', 'desktop', 'first', '2026-11-01T00:00:00+08:00')
      await call('image', 'alice', org.id, id, 3, 'image', 'android')
      await call('repeat', 'alice', org.id, id, 3, 'image', 'android', 'image')
      await call('old', 'alice', org.id, null, null, 'text', 'unknown')
      await call('zero', 'alice', org.id, id, 0, 'text', 'admin')
      await call('outside', 'alice', org.id, id, 80, 'text', 'desktop', 'outside', '2026-12-01T00:00:00+08:00')
      await call('foreign', 'bob', 'foreign', 'default', 100, 'audio', 'desktop')
      const report = (method, filters = '') =>
        fetch(base + 'reports/vendor-cost/' + method + '?month=2026-11' + filters)
      assert.equal((await report('overview')).status, 403)
      keys = ['vendor_cost.view']
      const rows = (await (await report('calls')).json()).data
      const groups = (await (await report('overview')).json()).data
      const members = (
        await (await report('members', '&department=' + encodeURIComponent(org.id + '/' + id))).json()
      ).data
      assert.equal(members.length, 1)
      assert.equal(members[0].userId, 'alice')
      assert.equal(Number(members[0].amount), 3)
      assert.equal(Number(members[0].calls), 2)
      assert.equal((await report('members')).status, 400)
      assert.equal(rows.length, 4)
      assert.equal(
        groups.reduce((s, g) => s + Number(g.known), 0),
        3,
      )
      assert.equal(
        rows.reduce((s, c) => s + Number(c.amount), 0),
        17,
      )
      assert.equal(
        groups.reduce((s, g) => s + Number(g.amount), 0),
        17,
      )
      assert.equal(rows.find((c) => c.id === 'old').departmentName, '历史未记录')
      assert.equal(rows.find((c) => c.id === 'first').departmentName, '默认部门')
      const image = (
        await (
          await report(
            'calls',
            '&department=' + encodeURIComponent(org.id + '/' + id) + '&source=android&type=image',
          )
        ).json()
      ).data
      assert.equal(image.length, 1)
      assert.equal(Number(image[0].images), 3)
      assert.equal((await save({ id, disabled: true })).status, 403)
      keys = ['end_users.manage']
      assert.equal((await save({ id, disabled: true })).status, 200)
      const [[moved]] = await pool.query("SELECT cost_department_id FROM ai_end_users WHERE id='alice'")
      assert.equal(moved.cost_department_id, 'default')
      // Run the actual reserve/finish paths, move the user while both jobs are running,
      // then replay settlement to verify that the ledger keeps one row per invocation.
      await pool.query(
        "INSERT INTO ai_model_providers (id,name,base_url) VALUES ('svc','fixture','https://example.invalid')",
      )
      await pool.query(
        "INSERT INTO ai_provider_models (id,provider_id,model_id,display_name) VALUES ('model','svc','m','m')",
      )
      await pool.query(
        "INSERT INTO ai_model_task_capabilities (id,provider_model_id,task_type,protocol_adapter) VALUES ('cap','model','chat','test')",
      )
      const endUser = { id: 'alice', organizationId: org.id, ledgerClientSource: 'android' }
      const modelOps = new ModelOperationRepository(pool),
        voiceOps = new VoiceOperationRepository(pool)
      const snapshot = { plan, exchangeRates: rates }
      const input = {
        capabilityId: 'cap',
        taskType: 'chat',
        operationType: 'chat',
        adapterId: 'test',
        configRevision: 1,
        idempotencyKey: 'test-model-request',
        fingerprint: 'a'.repeat(64),
        pricingSnapshot: snapshot,
        points: 0,
        clientSource: 'desktop',
      }
      const model = await modelOps.reserve(endUser, input)
      assert.equal((await modelOps.reserve(endUser, input)).created, false)
      const voice = await voiceOps.reserve(endUser, {
        operation: 'clone',
        idempotencyKey: 'test-voice-request',
        fingerprint: 'b'.repeat(64),
        points: 0,
      })
      await pool.query("INSERT INTO ai_cost_departments (id,organization_id,name) VALUES ('newteam',?,'技术')", [
        org.id,
      ])
      await save({ id: 'newteam', userIds: ['alice'] })
      const firstQuote = settledCost(quotePricing(plan, events, rates), rates)
      const finish = {
        status: 'succeeded',
        points: 0,
        vendorCost: firstQuote,
        usage: events,
        costSnapshot: { USD: 2 },
      }
      await modelOps.finish(endUser, model.operation.id, finish)
      await modelOps.finish(endUser, model.operation.id, finish)
      await voiceOps.finish(endUser, voice.operation.id, finish)
      await voiceOps.finish(endUser, voice.operation.id, finish)
      const [settled] = await pool.query(
        'SELECT request_id,vendor_cost,cost_department_id,cost_used_at FROM ai_credit_ledger WHERE request_id IN (?)',
        [[model.operation.id, voice.operation.id]],
      )
      assert.equal(settled.length, 2)
      for (const item of settled) {
        assert.equal(item.cost_department_id, 'default')
        assert.equal(
          (typeof item.vendor_cost === 'string' ? JSON.parse(item.vendor_cost) : item.vendor_cost).cny,
          14,
        )
        assert.ok(item.cost_used_at)
      }
      const nextPlan = { ...plan, components: [{ ...plan.components[0], costAmount: 3 }] }
      const later = await modelOps.reserve(endUser, {
        ...input,
        idempotencyKey: 'second-model-request',
        pricingSnapshot: { plan: nextPlan, exchangeRates: rates },
      })
      await modelOps.finish(endUser, later.operation.id, {
        ...finish,
        costSnapshot: { USD: 3 },
        vendorCost: settledCost(quotePricing(nextPlan, events, rates), rates),
      })
      const [[after]] = await pool.query(
        'SELECT vendor_cost,cost_department_id FROM ai_credit_ledger WHERE request_id=?',
        [later.operation.id],
      )
      assert.equal(after.cost_department_id, 'newteam')
      assert.equal(
        (typeof after.vendor_cost === 'string' ? JSON.parse(after.vendor_cost) : after.vendor_cost).cny,
        21,
      )
      await pool.query('UPDATE ai_credit_ledger SET vendor_cost=NULL,cost_department_id=NULL WHERE request_id=?', [
        model.operation.id,
      ])
      await pool.query("DELETE FROM ai_feature_migrations WHERE migration_key='vendor-cost-history-v1'")
      await migrateVendorCosts(pool)
      const [[historical]] = await pool.query(
        'SELECT vendor_cost,cost_department_id FROM ai_credit_ledger WHERE request_id=?',
        [model.operation.id],
      )
      assert.equal(
        (typeof historical.vendor_cost === 'string' ? JSON.parse(historical.vendor_cost) : historical.vendor_cost)
          .cny,
        14,
      )
      assert.equal(historical.cost_department_id, null)
      // Simulate old registered users with no department column prior to the upgrade.
      await pool.query('ALTER TABLE ai_end_users DROP COLUMN cost_department_id')
      await pool.end()
      pool = null
      await initDatabase(options)
      const [upgraded] = await pool.query('SELECT cost_department_id FROM ai_end_users')
      assert.equal(upgraded.length, 2)
      assert.ok(upgraded.every((user) => user.cost_department_id === 'default'))
    } finally {
      if (server) await new Promise((r) => server.close(r))
      if (pool) await pool.end()
      await admin.query('DROP DATABASE IF EXISTS ??', [name])
      await admin.end()
    }
  },
)
