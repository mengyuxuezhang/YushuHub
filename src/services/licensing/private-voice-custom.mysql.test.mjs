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
import { ModelCredentialVault } from '../model-credentials.mjs'

for (const mode of ['file', 'keypool']) test(`real MySQL ${mode} private voice client lifecycle recovers immutable actual usage after lost local completion without a live definition or Key`, { skip: !process.env.LICENSING_TEST_DB }, async () => {
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
    await fs.writeFile(file, JSON.stringify(mode === 'file' ? [model] : []), { mode: 0o600 })
    const secrets = mode === 'file' ? [model.apiKey] : ['fictional-pool-a', 'fictional-pool-b']
    if (mode === 'keypool') {
      await pool.query('CREATE TABLE ai_organizations(id VARCHAR(64) PRIMARY KEY,external_id VARCHAR(64),agent_level INT,status VARCHAR(16),legacy_owner_user_id VARCHAR(64))')
      await pool.query('CREATE TABLE ai_model_providers(id VARCHAR(64) PRIMARY KEY,organization_id VARCHAR(64),status VARCHAR(16),base_url VARCHAR(255))')
      await pool.query('CREATE TABLE ai_provider_models(id VARCHAR(64) PRIMARY KEY,provider_id VARCHAR(64),organization_id VARCHAR(64),model_id VARCHAR(120),model_type VARCHAR(16),display_name VARCHAR(120),endpoint_path VARCHAR(120),context_window INT,status VARCHAR(16),archived_at DATETIME)')
      await pool.query('CREATE TABLE ai_model_upstream_accounts(id VARCHAR(64) PRIMARY KEY,provider_id VARCHAR(64),organization_id VARCHAR(64),status VARCHAR(16))')
      await pool.query('CREATE TABLE ai_model_provider_keys(id VARCHAR(64) PRIMARY KEY,provider_id VARCHAR(64),provider_model_id VARCHAR(64),organization_id VARCHAR(64),owner_user_id VARCHAR(64),upstream_account_id VARCHAR(64),status VARCHAR(16),secret_ciphertext TEXT,api_key TEXT,last_used_at DATETIME(3),failure_count INT,created_at DATETIME(3))')
      await pool.query('CREATE TABLE ai_system_voices(id VARCHAR(64) PRIMARY KEY,organization_id VARCHAR(64),provider_model_id VARCHAR(64),upstream_account_id VARCHAR(64),provider_voice_id VARCHAR(120),display_name VARCHAR(120),status VARCHAR(16))')
      await pool.query("INSERT INTO ai_organizations VALUES ('custom-local-root',?,1,'enabled','custom-owner')", [root.id])
      await pool.query("INSERT INTO ai_model_providers VALUES ('custom-provider','custom-local-root','enabled',?)", [model.baseUrl])
      await pool.query("INSERT INTO ai_provider_models VALUES (?,'custom-provider','custom-local-root',?,'audio','虚构密钥池音色','/v1/t2a_v2',10000,'enabled',NULL)", [model.id, model.model])
      const vault = new ModelCredentialVault(path.join(dir, 'credentials.key'))
      for (const [index, letter] of ['a', 'b'].entries()) {
        await pool.query("INSERT INTO ai_model_upstream_accounts VALUES (?,'custom-provider','custom-local-root','enabled')", [`account-${letter}`])
        await pool.query("INSERT INTO ai_model_provider_keys VALUES (?,'custom-provider',?,'custom-local-root','custom-owner',?,'enabled',?,NULL,NULL,0,?)", [`key-${letter}`, model.id, `account-${letter}`, await vault.seal(secrets[index], `account-${letter}`), `2026-01-0${index + 1} 00:00:00`])
      }
    }
    const counts = { uploads: 0, clones: 0, syntheses: 0, deletes: 0, fileDeletes: 0, fileLists: 0, vendorRequests: 0 }, accounts = new Map(secrets.map(secret => [secret, new Set()])), files = new Map(secrets.map(secret => [secret, new Map()]))
    let missingUsage = false, clock = Date.now(), failFileDelete = true, loseFileDeleteReply = true, loseFileUploadReply = false, failFileList = false, rejectVendor = false
    const ok = value => Response.json({ base_resp: { status_code: 0 }, ...value })
    const fetchImpl = async (url, options = {}) => {
      const parsed = new URL(url)
      if (parsed.hostname === 'minimax-algeng-chat-tts.oss-accelerate.aliyuncs.com') return new Response('fictional custom preview')
      assert.equal(parsed.hostname, 'custom-voice.example.com')
      counts.vendorRequests++
      if (rejectVendor) return new Response('simulated invalid vendor credential', { status: 401 })
      const secret = options.headers.authorization?.replace(/^Bearer /, ''), voices = accounts.get(secret)
      assert(voices, 'Only the original simulated account may access its voice')
      const accountFiles = files.get(secret)
      if (parsed.pathname === '/v1/files/upload') {
        counts.uploads++; const fileId = String(9_000_000_000_000_000_000n + BigInt(counts.uploads)), file = options.body.get('file')
        accountFiles.set(fileId, { file_id: fileId, filename: file.name, bytes: file.size, created_at: Math.floor(clock / 1000), purpose: 'voice_clone' })
        if (loseFileUploadReply) { loseFileUploadReply = false; failFileList = true; throw new Error('simulated supplier upload reply loss') }
        return ok({ file: { file_id: fileId } })
      }
      if (parsed.pathname === '/v1/files/list') { counts.fileLists++; if (failFileList) { failFileList = false; throw new Error('simulated list outage') }; assert.equal(options.method, 'GET'); return ok({ files: [...accountFiles.values()] }) }
      if (parsed.pathname === '/v1/files/delete') {
        counts.fileDeletes++; const fileId = /"file_id":(\d+)/.exec(options.body)?.[1]; assert(fileId); assert.equal(JSON.parse(options.body).purpose, 'voice_clone')
        if (failFileDelete) { failFileDelete = false; throw new Error('simulated file deletion before acceptance') }
        accountFiles.delete(fileId)
        if (loseFileDeleteReply) { loseFileDeleteReply = false; throw new Error('simulated file deletion reply loss') }
        return ok({})
      }
      const body = JSON.parse(options.body)
      if (parsed.pathname === '/v1/voice_clone') { counts.clones++; voices.add(body.voice_id); return ok({ input_sensitive: false, demo_audio: `https://minimax-algeng-chat-tts.oss-accelerate.aliyuncs.com/${body.voice_id}.mp3`, ...(missingUsage ? {} : { extra_info: { usage_characters: 4, audio_length: 1000 } }) }) }
      if (parsed.pathname === '/v1/t2a_v2') { counts.syntheses++; assert(voices.has(body.voice_setting.voice_id)); return ok({ data: { audio: '494433ff', status: 2 }, extra_info: { usage_characters: body.text === '你好' ? 4 : [...body.text].length, audio_length: 1000 } }) }
      if (parsed.pathname === '/v1/get_voice') return ok({ voice_cloning: [...voices].map(voice_id => ({ voice_id })) })
      if (parsed.pathname === '/v1/delete_voice') { counts.deletes++; voices.delete(body.voice_id); return ok({}) }
      throw new Error('Unexpected simulated custom voice endpoint')
    }
    const make = () => agentCommerceRuntime({ client: { claims: async () => root, recoveryIdentity: async () => root }, database: () => pool, fetchImpl, benefits: async () => ({ discount: '1' }), inspectPrivateVoiceAudio: async () => ({ duration: 10 }), now: () => clock,
      env: { AI_AGENT_CUSTOM_MODELS_FILE: file, AI_SUPPLY_PRIVATE_VOICE_ENABLED: '1', AI_SUPPLY_PRIVATE_VOICE_DIRECTORY: path.join(dir, 'storage'), AI_MODEL_CREDENTIAL_KEY_PATH: path.join(dir, 'credentials.key'), AI_PRICE_NOTIFICATIONS_KEY_FILE: path.join(dir, 'price.key'), AI_ACCOUNTING_MONITOR_KEY_FILE: path.join(dir, 'monitor.key') } })
    runtime = make()
    if (mode === 'keypool') await runtime.customReview.save(root, { providerModelId: model.id, clientId: model.clientId, expectedRevision: 0, status: 'enabled', adapter: model.adapter, currency: 'CNY', memo: '虚构密钥池私有音色成本审核', allowedVoiceIds: [], costComponents: model.supplierCost.components }, 'custom-owner')
    setAuthDependencies({ getEndUserByToken: async token => ['custom-voice-client', 'custom-voice-peer'].includes(token) ? { id: token === 'custom-voice-client' ? 'custom-voice-user' : 'custom-voice-other', status: 'enabled' } : null, getClientAuthorization: async () => true })
    const app = serviceApp(); registerClientVoiceSupplyRoutes(app, { runtime: { get privateVoiceReady() { return runtime.privateVoiceReady }, service: (...args) => runtime.service(...args), privateVoice: (...args) => runtime.privateVoice(...args), privateVoiceRoute: (...args) => runtime.privateVoiceRoute(...args), privateVoiceInventory: (...args) => runtime.privateVoiceInventory(...args), privateVoiceWarnings: (...args) => runtime.privateVoiceWarnings(...args) }, tenantForUser: async () => child }); serviceErrors(app)
    server = await new Promise(resolve => { const result = app.listen(0, '127.0.0.1', () => resolve(result)) })
    const request = (route = '', body, token = 'custom-voice-client') => fetch(`http://127.0.0.1:${server.address().port}/api/client/voices${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) })
    let service = await runtime.service()
    const markup = components.filter(item => item.meter !== 'request').map(({ meter, phase }) => ({ meter, phase, amount: mode === 'file' ? '1' : meter === 'resource_activation' ? '8' : '3' }))
    await service.configure(root, { modelId: model.id, expectedVersion: 0, enabled: true, pointsPerCny: '1', saleMarkup: markup, supplyMarkup: markup }, 'root-owner')
    await service.configure(child, { modelId: model.id, expectedVersion: 0, enabled: true, pointsPerCny: '1', saleMarkup: markup.map(item => ({ ...item, amount: '1' })) }, 'child-owner')
    await service.credit(root, child.id, '100', 'custom-voice-credit', 'fictional-custom-voice-receipt', 'root-owner')
    const recording = requestId => { const form = new FormData(); form.set('audio', new Blob(['fictional custom recording']), 'recording.wav'); for (const [key, value] of Object.entries({ idempotencyKey: requestId, modelId: model.clientId, name: '虚构自接音色', text: '你好', consent: 'true', confirmedPoints: '16' })) form.set(key, value); return form }
    const cloned = await request('/train', recording('custom-voice-clone')); assert.equal(cloned.status, 200)
    const clone = (await cloned.json()).data; assert.equal(clone.status, 'succeeded'); assert.equal(clone.settledPoints, 16)
    let originalKey
    if (mode === 'keypool') { const [[resource]] = await pool.query("SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,'$.credentialId')) AS credential FROM supply_voice_resources WHERE book='commerce-v2' AND id=?", [clone.voiceId]); originalKey = resource.credential; assert.equal(originalKey, 'key-a') }
    assert.equal([...files.values()].reduce((sum, value) => sum + value.size, 0), 1)
    const walletBeforeCleanup = (await service.balance(child)).wallet
    let originalCipher
    if (mode === 'file') { runtime.stop(); await fs.writeFile(file, JSON.stringify([{ ...model, apiKey: 'fictional-wrong-account-key' }])); runtime = make() }
    else {
      const [[key]] = await pool.query('SELECT secret_ciphertext FROM ai_model_provider_keys WHERE id=?', [originalKey]); originalCipher = key.secret_ciphertext
      const vault = new ModelCredentialVault(path.join(dir, 'credentials.key'))
      await pool.query('UPDATE ai_model_provider_keys SET secret_ciphertext=? WHERE id=?', [await vault.seal('fictional-wrong-account-key', 'account-a'), originalKey])
    }
    clock += 60_001; assert.equal((await runtime.cleanPrivateFiles()).blocked, 1); assert.equal(counts.fileDeletes, 1)
    if (mode === 'file') { runtime.stop(); await fs.writeFile(file, JSON.stringify([model])); runtime = make() }
    else await pool.query('UPDATE ai_model_provider_keys SET secret_ciphertext=? WHERE id=?', [originalCipher, originalKey])
    clock += 60_001; assert.equal((await runtime.cleanPrivateFiles()).cleaned, 1); clock = Date.now()
    assert.deepEqual((await service.balance(child)).wallet, walletBeforeCleanup)
    assert.equal([...files.values()].reduce((sum, value) => sum + value.size, 0), 0); assert.equal(counts.clones, 1)
    assert.equal(counts.fileDeletes, 2)
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
    runtime.stop(); await fs.writeFile(file, '[]')
    if (mode === 'keypool') await pool.query("UPDATE ai_model_provider_keys SET status='disabled'")
    runtime = make(); service = await runtime.service({ recovery: true })
    const settled = await service.recover(child, 'custom-voice-user', 'custom-voice-recover'); assert.equal(settled.state, 'settled'); assert.equal(settled.points, '16.000000'); assert.equal(settled.upstreamAmount, '4.000000')
    await service.recover(child, 'custom-voice-user', 'custom-voice-recover'); assert.equal(counts.clones, before + 1)
    assert.equal((await service.balance(child)).wallet.balance, '47.000000')
    assert.equal(String((await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='custom-voice-user'"))[0][0].credit_balance), '31.000000')
    runtime.stop(); await fs.writeFile(file, JSON.stringify(mode === 'file' ? [model] : []))
    if (mode === 'keypool') await pool.query("UPDATE ai_model_provider_keys SET status='enabled'")
    runtime = make(); service = await runtime.service()
    loseFileUploadReply = true
    const callsBeforeUploadLoss = counts.clones, failedUpload = await request('/train', recording('custom-upload-unknown'))
    assert.equal(failedUpload.status, 200); assert.equal((await failedUpload.json()).data.status, 'failed'); assert.equal(counts.clones, callsBeforeUploadLoss)
    const [[beforeFileProof]] = await pool.query("SELECT payload FROM supply_voice_jobs WHERE book='commerce-v2' AND id='custom-upload-unknown'")
    const fileJob = typeof beforeFileProof.payload === 'string' ? JSON.parse(beforeFileProof.payload) : beforeFileProof.payload
    assert.equal(fileJob.upstreamFileId, undefined); assert.equal(fileJob.cleanupPending, true)
    clock += 60_001; assert.equal((await runtime.cleanPrivateFiles()).cleaned, 1); clock = Date.now()
    const [[afterFileProof]] = await pool.query("SELECT payload FROM supply_voice_jobs WHERE book='commerce-v2' AND id='custom-upload-unknown'")
    const recoveredFileJob = typeof afterFileProof.payload === 'string' ? JSON.parse(afterFileProof.payload) : afterFileProof.payload
    assert.equal(recoveredFileJob.cleanupPending, false); assert.equal(recoveredFileJob.fileRecovery.source, 'minimax-files-list')
    assert.equal(counts.clones, callsBeforeUploadLoss); assert.equal((await service.balance(child)).wallet.balance, '47.000000')
    assert.equal(String((await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='custom-voice-user'"))[0][0].credit_balance), '31.000000')
    rejectVendor = true
    const rejectedUpload = await request('/train', recording('custom-rejected-upload')); assert.equal(rejectedUpload.status, 200)
    const rejectedVoice = (await rejectedUpload.json()).data; assert.equal(rejectedVoice.status, 'failed'); assert.equal(rejectedVoice.settledPoints, 0)
    const [[rejectedRecord]] = await pool.query("SELECT payload FROM supply_voice_jobs WHERE book='commerce-v2' AND id='custom-rejected-upload'")
    const rejectedJob = typeof rejectedRecord.payload === 'string' ? JSON.parse(rejectedRecord.payload) : rejectedRecord.payload
    assert.equal(rejectedJob.paidDispatch, false); assert.equal(rejectedJob.cleanupPending, false)
    const beforeLocalDeletion = counts.vendorRequests
    for (let repeat = 0; repeat < 2; repeat++) {
      const deleted = await request('/delete', { voiceId: rejectedVoice.voiceId, idempotencyKey: 'delete-rejected-upload' }); assert.equal(deleted.status, 200)
      assert.equal((await deleted.json()).data.status, 'succeeded')
    }
    assert.equal(counts.vendorRequests, beforeLocalDeletion); assert.equal((await service.balance(child)).wallet.balance, '47.000000')
    rejectVendor = false
    missingUsage = true
    const unknown = await request('/train', recording('custom-voice-unknown')); assert.equal(unknown.status, 200); assert.equal((await unknown.json()).data.status, 'outcome_unknown')
    const calls = counts.clones; await service.recover(child, 'custom-voice-user', 'custom-voice-unknown'); assert.equal(counts.clones, calls)
    assert.equal((await service.balance(child)).wallet.reserved, '12.000000')
    assert.equal(String((await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='custom-voice-user'"))[0][0].credit_balance), '15.000000')
    const filesBeforeUnknown = counts.fileDeletes
    clock += 60_001; assert.equal((await runtime.cleanPrivateFiles()).cleaned, 0); clock = Date.now()
    assert.equal(counts.fileDeletes, filesBeforeUnknown); assert.equal([...files.values()].reduce((sum, value) => sum + value.size, 0), 1)
    const catalog = (await (await request()).json()).data
    assert.equal(JSON.stringify(catalog).includes(model.apiKey), false); assert.equal(JSON.stringify(catalog).includes('upstream-custom-speech'), false)
    for (const secret of secrets) assert.equal(JSON.stringify(catalog).includes(secret), false)
    if (mode === 'keypool') {
      await pool.query("UPDATE ai_model_provider_keys SET status='disabled' WHERE id=?", [originalKey])
      const beforeDenied = counts.syntheses
      assert.equal((await request('/synthesize', { modelId: model.clientId, voiceId: clone.voiceId, text: 'abc', idempotencyKey: 'custom-disabled-voice' })).status, 409)
      assert.equal(counts.syntheses, beforeDenied); assert.equal(await runtime.store.readRequest('custom-disabled-voice'), null)
    }
    assert.equal((await request('/delete', { voiceId: clone.voiceId, idempotencyKey: 'custom-voice-delete' })).status, 200)
    assert.equal((await (await request('/tasks/custom-voice-delete')).json()).data.status, 'succeeded')
    auditAccounting(await runtime.store.read(), 'commerce')
  } finally {
    runtime?.stop(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await pool?.end(); if (created) { assert(/^yushu_voice_custom_[a-f0-9]{10}$/.test(name)); await admin.query('DROP DATABASE ??', [name]) }; await admin.end()
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive: true, force: true })
  }
})
