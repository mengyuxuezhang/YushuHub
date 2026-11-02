import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import express from 'express'
import mysql from 'mysql2/promise'
import AdmZip from 'adm-zip'
import { ModelServiceV2Sync } from '../src/services/model-service-v2-sync.mjs'
import { ModelCredentialVault } from '../src/services/model-credentials.mjs'

// Integration tests load the independently maintained center, never a bundled signing server.
const centerRoot = path.resolve(process.env.AI_LICENSE_CENTER_SOURCE || fileURLToPath(new URL('../../YushuLicenseCenter/', import.meta.url)))
if (!fs.existsSync(path.join(centerRoot,'package.json'))) throw new Error('Install YushuLicenseCenter separately and set AI_LICENSE_CENTER_SOURCE')
const centerModule = file => import(pathToFileURL(path.join(centerRoot,file)).href)
const { mysqlStateStore } = await centerModule('src/repositories/authorization-state.mjs')
const { createLicenseCenter, emptyCenterState } = await centerModule('src/services/authorization/center.mjs')
const { createOperatorAuth, passwordHash, totp } = await centerModule('src/services/authorization/operator-auth.mjs')
const { registerLicenseCenterRoutes } = await centerModule('src/routes/license-center.mjs')

// Explicit disposable DB credentials only. Never infer credentials from a live deployment.
if (!process.env.AI_DIRECT_TEST_DB_CONFIG) throw new Error('AI_DIRECT_TEST_DB_CONFIG must name a protected disposable MySQL configuration file')
const config = JSON.parse(fs.readFileSync(process.env.AI_DIRECT_TEST_DB_CONFIG, 'utf8'))
const root = fileURLToPath(new URL('../', import.meta.url)), temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-newapi-test-'))
const stamp = crypto.randomBytes(5).toString('hex'), agentDb = `direct_test_agent_${stamp}`, centerDb = `direct_test_center_${stamp}`
const admin = mysql.createPool(config), children = [], handles = []
const pools = [], servers = []
const listen = async app => { const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise(r => server.once('listening', r)); return `http://127.0.0.1:${server.address().port}` }
async function stop(child) { if (child.exitCode === null && !child.signalCode) { const exited = new Promise(r => child.once('exit', r)); if (child.kill()) await exited } }
let centerUrl, publicKeyFile, preloadFile, agentUrl, cookie = '', agent, lastLog, lastEnv
const password = crypto.randomBytes(24).toString('hex')
async function launch(source, mode) {
  const log = path.join(temporary, `agent-${children.length}.log`); lastLog = log
  const descriptor = fs.openSync(log, 'a'); handles.push(descriptor)
  const port = await new Promise(resolve => { const server = express().listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)) }) })
  const env = { ...process.env, NODE_ENV: 'test', AI_AUTHORIZATION_MODE: mode, AI_ADMIN_PORT: String(port), AI_ADMIN_HOST: '127.0.0.1', AI_ADMIN_PUBLIC_URL: 'https://agent.example.test', AI_ADMIN_USER: 'admin', AI_ADMIN_PASSWORD: password,
    AI_DB_HOST: config.host, AI_DB_PORT: String(config.port), AI_DB_USER: config.user, AI_DB_PASSWORD: config.password, AI_DB_NAME: agentDb,
    AI_LICENSE_CENTER_URL: centerUrl, AI_LICENSE_INSTANCE_ID: 'test-instance', AI_LICENSE_PUBLIC_KEYS_FILE: publicKeyFile, AI_LICENSE_STATE_FILE: path.join(temporary, 'license.json'),
    AI_MODEL_CREDENTIAL_KEY_PATH: path.join(temporary, 'model.key'), AI_PAYMENT_SECRET_FILE: path.join(temporary, 'payment.key'), AI_UPLOAD_DIR: path.join(temporary, 'uploads'),
    AI_UPDATE_ROOT: path.join(temporary, 'updates'), AI_PREVIEW_BASE_URL: 'https://preview.example.test', AI_SOURCE_VERSION_URL: centerUrl + '/mock-version', AI_BUILD_CENTER_URL: '', AI_WORKER_TOKEN: '',
    NODE_OPTIONS: `--import ${pathToFileURL(preloadFile).href}` }
  lastEnv=env
  const child = spawn(process.execPath, ['cloud/ai-admin/server.mjs'], { cwd: source, env, stdio: ['ignore', descriptor, descriptor], windowsHide: true }); children.push(child)
  agentUrl = `http://127.0.0.1:${port}`
  for (let i = 0; i < 160; i++) {
    if (child.exitCode !== null) throw new Error('Isolated agent startup failed; inspect ' + log)
    try { if ((await fetch(agentUrl + '/api/runtime-info')).ok) return child } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('Isolated agent startup timed out; inspect ' + log)
}
async function request(url, body, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...options.headers }, ...(body === undefined ? {} : { method: options.method || 'POST', body: JSON.stringify(body) }) })
  const payload = await response.json().catch(() => ({}))
  return { response, payload, data: payload.data }
}
async function login() {
  const challenge = (await request(agentUrl + '/api/login/captcha')).data
  const svg = Buffer.from(challenge.imageDataUrl.split(',')[1], 'base64').toString()
  const captchaAnswer = [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(match => match[1]).join('')
  const result = await request(agentUrl + '/api/login', { username: 'admin', password, challengeId: challenge.challengeId, captchaAnswer })
  assert.equal(result.response.status, 200, JSON.stringify(result.payload)); cookie = result.response.headers.getSetCookie()[0].split(';')[0]
}
try {
  for (const name of [agentDb, centerDb]) await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  const business = mysql.createPool({ ...config, database: agentDb }), central = mysql.createPool({ ...config, database: centerDb }); pools.push(business, central)
  const store = mysqlStateStore(central, 'single-agent-v1', emptyCenterState()); await store.migrate()
  const keys = crypto.generateKeyPairSync('ed25519'), publicKeys = { test: keys.publicKey.export({ type: 'spki', format: 'pem' }) }
  publicKeyFile = path.join(temporary, 'public.json'); fs.writeFileSync(publicKeyFile, JSON.stringify(publicKeys))
  const center = createLicenseCenter({ store, privateKey: keys.privateKey, publicKeys, keyId: 'test', credentialKey: crypto.randomBytes(48) })
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', operators = createOperatorAuth({ store, operators: [{ id: 'test-operator', passwordHash: passwordHash(password), totpSecret: secret }] })
  const app = express(); app.use(express.json()); registerLicenseCenterRoutes(app, { center, operators }); app.get('/mock-version', (_req, res) => res.json({ version: '1.9.59' }))
  app.use('/license-center',express.static(path.join(centerRoot,'web','license-center')))
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, code: err.code, error: err.message })); centerUrl = await listen(app)
  assert.equal((await fetch(centerUrl+'/license-center/')).status,200)
  const operator = await request(centerUrl + '/api/license-center/v1/operator/login', { username: 'test-operator', password, code: totp(secret, Math.floor(Date.now() / 30_000)) })
  assert.equal(operator.response.status, 200); const operatorHeaders = { Authorization: 'Bearer ' + operator.data.token }
  assert.equal((await request(centerUrl + '/api/license-center/v1/operator/state')).response.status, 401)
  let providerCalls = 0, escapedCalls = 0, redirect = false, insufficient = false
  const mock = express(); mock.use(express.json()); mock.post('/v1/chat/completions', (req, res) => { providerCalls++; assert.equal(req.headers.authorization, 'Bearer sk-test-owned-new-api'); if (redirect) return res.redirect(307, '/escaped'); if (insufficient) return res.status(402).json({error:{message:'insufficient quota',code:'insufficient_quota'}}); res.json({ id: 'test', choices: [{ message: { role: 'assistant', content: 'TEST ONLY' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }) }); mock.all('/escaped', (_req, res) => { escapedCalls++; res.sendStatus(500) }); const mockUrl = await listen(mock)
  preloadFile = path.join(temporary, 'mock-fetch.mjs'); fs.writeFileSync(preloadFile, `const original = globalThis.fetch; globalThis.fetch = (url, options = {}) => { const u = String(url); if (u === 'https://api.okpa.cn/v1/chat/completions') { if (options.redirect !== 'error') throw Error('REDIRECT_POLICY_MISSING'); return original(${JSON.stringify(mockUrl)} + '/v1/chat/completions', options) } if (options.headers?.Authorization?.includes('sk-test-') || options.headers?.authorization?.includes('sk-test-')) throw Error('KEY_DESTINATION_DENIED'); return original(url, options) }`)
  // Boot the real mainline code, then upgrade its database and retained key file.
  const zip = path.join(temporary, 'baseline.zip'), baseline = path.join(temporary, 'baseline')
  if (process.env.AI_DIRECT_TEST_BASELINE_ZIP) fs.copyFileSync(process.env.AI_DIRECT_TEST_BASELINE_ZIP, zip)
  else { const archived = spawnSync('git', ['archive', '--format=zip', '--output=' + zip, '2aab87dfba33f793300907f9f5bdb35d49bb79fd'], { cwd: root, windowsHide: true }); assert.equal(archived.status, 0) }
  new AdmZip(zip).extractAllTo(baseline); fs.symlinkSync(path.join(root, 'node_modules'), path.join(baseline, 'node_modules'), 'junction')
  agent = await launch(baseline, 'legacy'); await login()
  const [[org]] = await business.query('SELECT primary_organization_id AS id FROM ai_users WHERE id=\'admin\'')
  assert.ok(org.id)
  await business.query("UPDATE ai_organizations SET name='Existing business',external_id='legacy-external-id' WHERE id=?", [org.id])
  const vault = new ModelCredentialVault(path.join(temporary, 'model.key')), encrypted = await vault.seal('sk-test-old-third-party', 'test-account')
  for (const [id, type] of [['test-text','text'],['test-image','image'],['test-audio','audio'],['test-search','search']]) {
    await business.query('INSERT INTO ai_model_providers (id,name,base_url,organization_id) VALUES (?,?,?,?)', [id,id,'https://original.example.test/v1',org.id])
    await business.query('INSERT INTO ai_provider_models (id,provider_id,model_id,display_name,model_type,organization_id) VALUES (?,?,?,?,?,?)', [id,id,id,id,type,org.id])
  }
  await business.query("INSERT INTO ai_model_providers (id,name,base_url,organization_id) VALUES ('test-duplicate','Duplicate','https://original.example.test/v1',?)", [org.id])
  await business.query("INSERT INTO ai_provider_models (id,provider_id,model_id,display_name,model_type,organization_id) VALUES ('test-duplicate','test-duplicate','test-text','Duplicate','text',?)", [org.id])
  await business.query("INSERT INTO ai_model_provider_keys (id,owner_user_id,provider_id,upstream_account_id,api_key,secret_ciphertext,organization_id) VALUES ('test-old-key','admin','test-text','test-account','',?,?)", [encrypted,org.id])
  const [before] = await business.query("SELECT k.id,k.provider_id,p.base_url,k.secret_ciphertext FROM ai_model_provider_keys k JOIN ai_model_providers p ON p.id=k.provider_id WHERE k.id='test-old-key'")
  await business.query("INSERT INTO ai_end_users (id,username,display_name,password_hash,source_agent_id,organization_id,credit_balance) VALUES ('test-user','fictional','TEST','test-only-hash','admin',?,123.456789)",[org.id])
  await business.query("INSERT INTO ai_end_user_memberships (id,user_id,card_id,package_name) VALUES ('test-membership','test-user','free','TEST retained')")
  await business.query("INSERT INTO ai_credit_ledger (id,user_id,change_type,points_delta,balance_after) VALUES ('test-ledger','test-user','recharge',123.456789,123.456789)")
  await business.query("INSERT INTO ai_payment_orders (id,order_no,owner_user_id,user_id,config_id,provider,payment_mode,idempotency_key,card_id,card_name,package_name,amount_fen,status,expires_at) VALUES ('test-order','test-order-no','admin','test-user','test-only','wechat','native','test-order-key','free','TEST','TEST',100,'fulfilled',DATE_ADD(NOW(),INTERVAL 1 DAY))")
  const inspectConfig=path.join(temporary,'inspect-db.json'),reportFile=path.join(temporary,'upgrade-report.json');fs.writeFileSync(inspectConfig,JSON.stringify({...config,database:agentDb}))
  const inspected=spawnSync(process.execPath,['scripts/authorization-upgrade-inspect.mjs',inspectConfig,reportFile],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(inspected.status,0,inspected.stderr)
  assert.equal(JSON.parse(fs.readFileSync(reportFile,'utf8')).terminalPoints,'123.456789')
  await stop(agent); cookie = ''; agent = await launch(root, 'legacy'); await login()
  assert.equal((await request(agentUrl + '/api/license')).data.verified, true)
  const [[retainedOrganization]] = await business.query('SELECT name,external_id FROM ai_organizations WHERE id=?', [org.id])
  assert.equal(retainedOrganization.name,'Existing business'); assert.equal(retainedOrganization.external_id,'legacy-external-id')
  const [[rights]]=await business.query("SELECT credit_balance FROM ai_end_users WHERE id='test-user'");assert.equal(String(rights.credit_balance),'123.456789')
  const [[order]]=await business.query("SELECT status,amount_fen FROM ai_payment_orders WHERE id='test-order'");assert.equal(order.status,'fulfilled');assert.equal(Number(order.amount_fen),100)
  const [[membership]]=await business.query("SELECT card_id FROM ai_end_user_memberships WHERE id='test-membership'");assert.equal(membership.card_id,'free')
  const [[preserved]] = await business.query("SELECT secret_ciphertext FROM ai_model_provider_keys WHERE id='test-old-key'")
  assert.equal(preserved.secret_ciphertext, encrypted); assert.equal(await vault.unseal(preserved.secret_ciphertext,'test-account'),'sk-test-old-third-party'); assert.equal(before.length,1)
  await stop(agent); cookie = ''; agent = await launch(root, 'center'); await login()
  assert.equal((await request(agentUrl + '/api/license')).data.verified,false)
  const issued = await request(centerUrl + '/api/license-center/v1/operator/grants', { id: 'test-agent', name: 'TEST', domain: 'https://agent.example.test', modelMode: 'fixed', packageId: 'standard', expiresAt: null }, { headers: operatorHeaders })
  assert.equal(issued.response.status,200)
  assert.equal((await request(agentUrl + '/api/authorization/activate', { code: issued.data.code })).response.status,200)
  assert.equal((await request(agentUrl + '/api/authorization/activate', { code: issued.data.code })).response.status,200)
  const conflict = await request(agentUrl + '/api/authorization/fixed-text/preview'); assert.equal(conflict.data.conflicts.length,1)
  assert.equal((await request(agentUrl + '/api/authorization/fixed-text/configure', { previewDigest: conflict.data.previewDigest })).response.status,409)
  const [[unmoved]] = await business.query("SELECT provider_id FROM ai_provider_models WHERE id='test-text'"); assert.equal(unmoved.provider_id,'test-text')
  const disabled = await fetch(agentUrl + '/api/provider-models/test-duplicate', { method:'DELETE',headers:{Cookie:cookie} }); assert.equal(disabled.status,200)
  const preview = await request(agentUrl + '/api/authorization/fixed-text/preview'); assert.equal(preview.response.status,200,JSON.stringify(preview.payload)); assert(preview.data.models.some(m => m.id==='test-text')); assert.equal(preview.data.copiesOldKeys,false)
  assert.deepEqual(preview.data.retainedDisabledModels.map(m=>m.id),['test-duplicate'])
  assert.equal((await request(agentUrl + '/api/authorization/fixed-text/configure', { previewDigest: preview.data.previewDigest })).response.status,200)
  const [models] = await business.query("SELECT id,provider_id FROM ai_provider_models WHERE id LIKE 'test-%'")
  for (const row of models) assert.equal(row.provider_id,row.id==='test-text'?'system-text-okpa':row.id)
  assert.equal((await request(agentUrl + '/api/provider-models/test-duplicate/enable',{})).payload.success,false)
  assert.equal((await request(agentUrl + '/api/model-providers', { id:'forged',name:'forged',baseUrl:'https://evil.invalid' })).payload.success,false)
  const [[old]] = await business.query("SELECT secret_ciphertext,provider_id FROM ai_model_provider_keys WHERE id='test-old-key'"); assert.equal(old.secret_ciphertext,encrypted); assert.equal(old.provider_id,'test-text')
  assert.equal((await request(agentUrl + '/api/organizations/children', { name:'forged' })).response.status,404)
  assert.equal((await request(agentUrl + '/api/organizations/'+org.id+'/members')).response.status,200)
  const keyResult = await request(agentUrl + '/api/model-providers/system-text-okpa/keys', { apiKey:'sk-test-owned-new-api' }); assert.equal(keyResult.response.status,200,JSON.stringify(keyResult.payload))
  assert(!JSON.stringify(keyResult.payload).includes('sk-test-owned-new-api'))
  await business.query("UPDATE ai_model_providers SET base_url='https://evil.invalid/v1' WHERE id='system-text-okpa'")
  const testBody = { providerId:'system-text-okpa',modelId:'test-text',modelType:'text',endpointPath:'/chat/completions' }
  const connected = await request(agentUrl + '/api/provider-models/test',testBody); assert.equal(connected.response.status,200,JSON.stringify(connected.payload)); assert.equal(providerCalls,1)
  assert.equal((await request(agentUrl + '/api/provider-models/test',{ ...testBody,endpointPath:'https://evil.invalid/chat' })).payload.success,false)
  assert.equal(providerCalls,1)
  redirect=true; assert.equal((await request(agentUrl + '/api/provider-models/test',testBody)).payload.success,false); redirect=false
  assert.equal(escapedCalls,0); assert.equal(providerCalls,2)
  const userToken='test-only-client-token';await business.query("INSERT INTO ai_end_user_sessions (token_hash,user_id,device_id,expires_at) VALUES (?,'test-user','test-device',DATE_ADD(NOW(),INTERVAL 1 DAY))",[crypto.createHash('sha256').update(userToken).digest('hex')])
  await business.query("INSERT INTO ai_model_pricing_rules (id,provider_id,provider_model_id,billing_type,points_per_request,organization_id) VALUES ('test-price','system-text-okpa','test-text','per_request',2,?)",[org.id])
  const chat=()=>request(agentUrl+'/api/client/model/v1/chat/completions',{model:'test-text',messages:[{role:'user',content:'TEST'}],stream:false},{headers:{Authorization:'Bearer '+userToken}})
  const called=await chat();assert.equal(called.response.status,200,JSON.stringify(called.payload))
  const [[charged]]=await business.query("SELECT credit_balance FROM ai_end_users WHERE id='test-user'");assert.equal(String(charged.credit_balance),'121.456789')
  insufficient=true;const denied=await chat();insufficient=false;assert.notEqual(denied.response.status,200)
  const [[unchanged]]=await business.query("SELECT credit_balance FROM ai_end_users WHERE id='test-user'");assert.equal(String(unchanged.credit_balance),String(charged.credit_balance))
  const [[textCapability]]=await business.query("SELECT id FROM ai_model_task_capabilities WHERE provider_model_id='test-text' AND task_type='chat'")
  await business.query("INSERT INTO ai_model_pricing_plans (id,organization_id,provider_model_id,capability_id,task_type,status,sync_source) VALUES ('test-retained-text-plan',?,'test-text',?,'chat','enabled','center')",[org.id,textCapability.id])
  await new ModelServiceV2Sync(business,{}).apply({schemaVersion:2,capabilities:[],pricingPlans:[]},{cleanupModelIds:['test-image','test-audio','test-search']})
  const [[retainedPlan]]=await business.query("SELECT status FROM ai_model_pricing_plans WHERE id='test-retained-text-plan'");assert.equal(retainedPlan.status,'enabled')
  const [legacyKeys] = await business.query("SELECT id FROM ai_model_provider_keys WHERE provider_id='test-text'"); assert.equal(legacyKeys.length,1)
  const credential = JSON.parse(fs.readFileSync(path.join(temporary,'license.json'),'utf8')).credential
  const token = (await center.serviceToken(credential,'official-build')).token
  const projects = await Promise.all(Array.from({length:5},(_,i)=>request(agentUrl+'/api/projects',{id:'test-project-'+i,appName:'TEST '+i,brandName:'TEST'})))
  assert.equal(projects.filter(r=>r.payload.success).length,3,JSON.stringify(projects.map(r=>r.payload)))
  const project = projects.find(r=>r.payload.success).data
  const build = await request(agentUrl+'/api/builds',{projectId:project.id,version:'test-only',requestId:'test-idempotent-build'})
  assert.equal(build.response.status,200,JSON.stringify(build.payload))
  const repeat = await request(agentUrl+'/api/builds',{projectId:project.id,version:'test-only',requestId:'test-idempotent-build'})
  assert.equal(repeat.data.id,build.data.id)
  const usedBefore=(await center.resourceUsage(token)).builds.used;assert.equal(usedBefore,1)
  const reservations = await Promise.allSettled(Array.from({length:12},(_,i)=>center.resource(token,{kind:'builds',resourceId:'parallel-build-'+i})))
  assert.equal(reservations.filter(r=>r.status==='fulfilled').length,10-usedBefore)
  assert.equal((await center.resourceUsage(token)).builds.used,10)
  const saved = (await center.list()).grants[0], patch = { expectedVersion:saved.version,modelMode:'custom' }, previewChange = await center.preview(saved.id,patch)
  await center.update(saved.id,{...patch,previewDigest:previewChange.previewDigest},'test-operator')
  await request(agentUrl + '/api/license?force=1')
  assert.equal((await request(agentUrl + '/api/model-providers',{id:'custom-test',name:'custom',baseUrl:'https://custom.example.test/v1'})).response.status,200)
  const customToken=(await center.serviceToken(credential,'official-build')).token;assert.equal((await center.resourceUsage(customToken)).builds.used,10)
  console.log('PASS: fixed text ignores DB URL tampering, keys stay private, arbitrary endpoints and redirects are blocked; concurrent MySQL quota and custom-provider mode pass')
  await stop(agent)
  await business.query("INSERT INTO ai_organizations (id,external_id,name,agent_level,root_organization_id,runtime_owner_organization_id) VALUES ('unexpected-second','unexpected-second','TEST SECOND',2,?,?)",[org.id,org.id])
  const blockedLog=path.join(temporary,'unexpected-second.log'),blockedFd=fs.openSync(blockedLog,'a');handles.push(blockedFd)
  const blocked=spawn(process.execPath,['cloud/ai-admin/server.mjs'],{cwd:root,env:lastEnv,stdio:['ignore',blockedFd,blockedFd],windowsHide:true});children.push(blocked)
  await new Promise(r=>blocked.once('exit',r));assert.notEqual(blocked.exitCode,0);assert(fs.readFileSync(blockedLog,'utf8').includes('SECOND_LEVEL_DATA_FOUND'))
  const [[retainedSecond]]=await business.query("SELECT agent_level FROM ai_organizations WHERE id='unexpected-second'");assert.equal(Number(retainedSecond.agent_level),2)
  const rejectedReport=spawnSync(process.execPath,['scripts/authorization-upgrade-inspect.mjs',inspectConfig,path.join(temporary,'rejected-report.json')],{cwd:root,encoding:'utf8',windowsHide:true});assert.notEqual(rejectedReport.status,0)
  console.log('PASS: unexpected second-level data blocks preflight and startup without conversion or deletion')
  console.log('PASS: real mainline upgrade, explicit legacy bridge, single-agent activation, fixed preview, encrypted key retention and independent non-text providers')
  console.log('PASS: real MySQL center MFA and isolated license/agent databases')
  console.log(`TEST artifacts: ${temporary}; mock calls=${providerCalls}, escaped=${escapedCalls}`)
} catch (error) { console.error('TEST failed:', error.message, '; private agent log:', lastLog); process.exitCode = 1 }
finally {
  for (const child of children) await stop(child)
  for (const server of servers) { server.closeAllConnections(); await new Promise(r => server.close(r)) }
  for (const pool of pools) await pool.end()
  for (const name of [agentDb,centerDb]) await admin.query(`DROP DATABASE IF EXISTS \`${name}\``)
  await admin.end(); for (const handle of handles) fs.closeSync(handle)
}
