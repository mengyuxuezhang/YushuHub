import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { agentCommerceRuntime } from './commerce-runtime.mjs'
import { serviceApp, serviceErrors } from './runtime.mjs'
import { migrateAccounting, auditAccounting } from './accounting-migration.mjs'
import { migrateSupplyVoiceSchema } from '../../repositories/supply-voices.mjs'
import { mysqlStateStore } from '../../repositories/licensing-state.mjs'
import { emptyCustomDefinitions } from './custom-definitions.mjs'
import { registerClientVoiceSupplyRoutes } from '../../routes/client-voice-supply.mjs'
import { setAuthDependencies } from '../../middleware/auth.mjs'

test('real MySQL custom private voice client lifecycle recovers immutable actual usage after lost local completion without a live definition or Key', { skip: !process.env.LICENSING_TEST_DB }, async () => {
  const { gatewayDatabase, licenseDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1') throw new Error('Disposable local database required')
  const name = `yushu_voice_custom_${crypto.randomBytes(5).toString('hex')}`, admin = await mysql.createConnection(config)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-custom-')), file = path.join(dir, 'models.json')
  let pool, runtime, server, created = false
  try {
    await admin.query('CREATE DATABASE ??', [name]); created = true; pool = mysql.createPool({ ...config, database: name, connectionLimit: 12 })
    await pool.query('CREATE TABLE ai_end_users(id VARCHAR(64) PRIMARY KEY,status VARCHAR(16),credit_balance DECIMAL(18,6),organization_id VARCHAR(64))')
    await pool.query('CREATE TABLE ai_credit_ledger(id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),change_type VARCHAR(32),points_delta DECIMAL(18,6),balance_after DECIMAL(18,6),model_name VARCHAR(120),note VARCHAR(255),request_id VARCHAR(80))')
    await pool.query("INSERT INTO ai_end_users VALUES ('custom-voice-user','enabled',100,'custom-local-child')")
    await migrateAccounting({ pool, book: 'commerce-v2', kind: 'commerce', sourceId: 'empty-custom-voice' }); await migrateSupplyVoiceSchema(pool)
    await mysqlStateStore(pool, 'commerce-v2-custom-definitions', emptyCustomDefinitions()).migrate()
    const root = { id: 'custom-voice-root', level: 1, modelMode: 'custom' }, child = { id: 'custom-voice-child', level: 2 }
    const components = [{ meter: 'request', phase: 'request', unitSize: '1', amount: '0' }, ...['preview', 'activation', 'usage'].map(phase => ({ meter: 'billable_characters', phase, unitSize: '1', amount: '2' })), { meter: 'resource_activation', phase: 'activation', unitSize: '1', amount: '7' }]
    const model = { id: 'custom-voice-model', clientId: 'custom-speech', version: 1, status: 'enabled', adapter: 'minimax.private_voice', taskType: 'speech_synthesis', model: 'upstream-custom-speech', baseUrl: 'https://custom-voice.example.com', apiKey: 'fictional-custom-voice-key', allowedVoiceIds: [],
      price: { version: 1, currency: 'CNY', components }, supplierCost: { version: 1, currency: 'CNY', components: components.map(item => ({ ...item, amount: item.meter === 'request' ? '0' : item.meter === 'resource_activation' ? '5' : '1' })) } }
    await fs.writeFile(file, JSON.stringify([model]), { mode: 0o600 })
    const counts = { uploads: 0, clones: 0, syntheses: 0, deletes: 0 }, voices = new Set()
    let missingUsage = false
    const ok = value => Response.json({ base_resp: { status_code: 0 }, ...value })
    const fetchImpl = async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.hostname === 'minimax-algeng-chat-tts.oss-accelerate.aliyuncs.com') return new Response('fictional custom preview')
      assert.equal(parsed.hostname, 'custom-voice.example.com')
      assert.equal(options.headers.authorization, 'Bearer fictional-custom-voice-key')
      if (parsed.pathname === '/v1/files/upload') { counts.uploads++; return ok({ file: { file_id: String(9_000_000_000_000_000_000n + BigInt(counts.uploads)) } }) }
      if (parsed.pathname === '/v1/files/delete') return ok({})
      const body = JSON.parse(options.body)
      if (parsed.pathname === '/v1/voice_clone') { counts.clones++; voices.add(body.voice_id); return ok({ input_sensitive: false, demo_audio: `https://minimax-algeng-chat-tts.oss-accelerate.aliyuncs.com/${body.voice_id}.mp3`, ...(missingUsage ? {} : { extra_info: { usage_characters: 4, audio_length: 1000 } }) }) }
      if (parsed.pathname === '/v1/t2a_v2') { counts.syntheses++; assert(voices.has(body.voice_setting.voice_id)); return ok({ data: { audio: '494433ff', status: 2 }, extra_info: { usage_characters: body.text === '你好' ? 4 : [...body.text].length, audio_length: 1000 } }) }
      if (parsed.pathname === '/v1/get_voice') return ok({ voice_cloning: [...voices].map(voice_id => ({ voice_id })) })
      if (parsed.pathname === '/v1/delete_voice') { counts.deletes++; voices.delete(body.voice_id); return ok({}) }
      throw new Error('Unexpected simulated custom voice endpoint')
    }
    const make = () => agentCommerceRuntime({ client: { claims: async () => root, recoveryIdentity: async () => root }, database: () => pool, fetchImpl, benefits: async () => ({ discount: '1' }), inspectPrivateVoiceAudio: async () => ({ duration: 10 }),
      env: { AI_AGENT_CUSTOM_MODELS_FILE: file, AI_SUPPLY_PRIVATE_VOICE_ENABLED: '1', AI_SUPPLY_PRIVATE_VOICE_DIRECTORY: path.join(dir, 'storage'), AI_MODEL_CREDENTIAL_KEY_PATH: path.join(dir, 'credentials.key'), AI_PRICE_NOTIFICATIONS_KEY_FILE: path.join(dir, 'price.key'), AI_ACCOUNTING_MONITOR_KEY_FILE: path.join(dir, 'monitor.key') } })
    runtime = make()
    setAuthDependencies({ getEndUserByToken: async token => ['custom-voice-client', 'custom-voice-peer'].includes(token) ? { id: token === 'custom-voice-client' ? 'custom-voice-user' : 'custom-voice-other', status: 'enabled' } : null, getClientAuthorization: async () => true })
    const app = serviceApp(); registerClientVoiceSupplyRoutes(app, { runtime: { get privateVoiceReady() { return runtime.privateVoiceReady }, service: (...args) => runtime.service(...args), privateVoice: (...args) => runtime.privateVoice(...args), privateVoiceRoute: (...args) => runtime.privateVoiceRoute(...args), privateVoiceInventory: (...args) => runtime.privateVoiceInventory(...args) }, tenantForUser: async () => child }); serviceErrors(app)
    server = await new Promise(resolve => { const result = app.listen(0, '127.0.0.1', () => resolve(result)) })
    const request = (route = '', body, token = 'custom-voice-client') => fetch(`http://127.0.0.1:${server.address().port}/api/client/voices${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) })
    let service = await runtime.service()
    const markup = components.filter(item => item.meter !== 'request').map(({ meter, phase }) => ({ meter, phase, amount: '1' }))
    await service.configure(root, { modelId: model.id, expectedVersion: 0, enabled: true, pointsPerCny: '1', saleMarkup: markup, supplyMarkup: markup }, 'root-owner')
    await service.configure(child, { modelId: model.id, expectedVersion: 0, enabled: true, pointsPerCny: '1', saleMarkup: markup }, 'child-owner')
    await service.credit(root, child.id, '100', 'custom-voice-credit', 'fictional-custom-voice-receipt', 'root-owner')
    const recording = requestId => { const form = new FormData(); form.set('audio', new Blob(['fictional custom recording']), 'recording.wav'); for (const [key, value] of Object.entries({ idempotencyKey: requestId, modelId: model.clientId, name: '虚构自接音色', text: '你好', consent: 'true', confirmedPoints: '16' })) form.set(key, value); return form }
    const cloned = await request('/train', recording('custom-voice-clone')); assert.equal(cloned.status, 200)
    const clone = (await cloned.json()).data; assert.equal(clone.status, 'succeeded'); assert.equal(clone.settledPoints, 16)
    await request('/train', recording('custom-voice-clone')); assert.equal(counts.clones, 1)
    assert.equal((await request(`/${clone.voiceId}/preview`)).status, 200)
    assert.equal((await request(`/${clone.voiceId}/preview`, undefined, 'custom-voice-peer')).status, 404)
    const activated = await request('/activate', { voiceId: clone.voiceId, idempotencyKey: 'custom-voice-activate', confirmedPoints: 25 }); assert.equal(activated.status, 200); assert.equal((await activated.json()).data.settledPoints, 25)
    const spoken = await request('/synthesize', { modelId: model.clientId, voiceId: clone.voiceId, text: 'abc', idempotencyKey: 'custom-voice-synthesis' }); assert.equal(spoken.status, 200); assert.equal((await spoken.json()).data.settledPoints, 12)
    assert.equal((await request('/tasks/custom-voice-synthesis/audio')).status, 200)
    assert.equal((await service.balance(child)).wallet.balance, '59.000000')
    assert.equal(String((await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='custom-voice-user'"))[0][0].credit_balance), '47.000000')
    const before = counts.clones, original = runtime.store.scopeTransaction.bind(runtime.store); let failCompletion = true
    runtime.store.scopeTransaction = (scope, work) => original(scope, async (state, connection) => {
      const result = await work(state, connection)
      if (scope.requestId === 'custom-voice-recover' && state.requests[scope.requestId]?.state === 'settled' && failCompletion) { failCompletion = false; throw new Error('simulated lost local completion before commit') }
      return result
    })
    const recovering = await request('/train', recording('custom-voice-recover')); assert.equal(recovering.status, 200); assert.equal((await recovering.json()).data.status, 'outcome_unknown')
    assert.equal(counts.clones, before + 1)
    await runtime.store.scopeTransaction({ requestId: 'custom-voice-recover' }, state => { delete state.requests['custom-voice-recover'].job })
    assert((await runtime.store.pending()).some(operation => operation.requestId === 'custom-voice-recover'))
    runtime.stop(); await fs.writeFile(file, '[]'); runtime = make(); service = await runtime.service({ recovery: true })
    const settled = await service.recover(child, 'custom-voice-user', 'custom-voice-recover'); assert.equal(settled.state, 'settled'); assert.equal(settled.points, '16.000000'); assert.equal(settled.upstreamAmount, '4.000000')
    await service.recover(child, 'custom-voice-user', 'custom-voice-recover'); assert.equal(counts.clones, before + 1)
    assert.equal((await service.balance(child)).wallet.balance, '47.000000')
    assert.equal(String((await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='custom-voice-user'"))[0][0].credit_balance), '31.000000')
    runtime.stop(); await fs.writeFile(file, JSON.stringify([model])); runtime = make(); service = await runtime.service()
    missingUsage = true
    const unknown = await request('/train', recording('custom-voice-unknown')); assert.equal(unknown.status, 200); assert.equal((await unknown.json()).data.status, 'outcome_unknown')
    const calls = counts.clones; await service.recover(child, 'custom-voice-user', 'custom-voice-unknown'); assert.equal(counts.clones, calls)
    assert.equal((await service.balance(child)).wallet.reserved, '12.000000')
    assert.equal(String((await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='custom-voice-user'"))[0][0].credit_balance), '15.000000')
    const catalog = (await (await request()).json()).data
    assert.equal(JSON.stringify(catalog).includes(model.apiKey), false); assert.equal(JSON.stringify(catalog).includes('upstream-custom-speech'), false)
    assert.equal((await request('/delete', { voiceId: clone.voiceId, idempotencyKey: 'custom-voice-delete' })).status, 200)
    assert.equal((await (await request('/tasks/custom-voice-delete')).json()).data.status, 'succeeded')
    auditAccounting(await runtime.store.read(), 'commerce')
  } finally {
    runtime?.stop(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await pool?.end(); if (created) { assert(/^yushu_voice_custom_[a-f0-9]{10}$/.test(name)); await admin.query('DROP DATABASE ??', [name]) }; await admin.end()
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive: true, force: true })
  }
})
