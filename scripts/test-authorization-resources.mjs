import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import pathModule from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import mysql from 'mysql2/promise'
import AdmZip from 'adm-zip'
import { mysqlStateStore } from '../src/repositories/licensing-state.mjs'
import { BASE_PACKAGES } from '../src/services/licensing/packages.mjs'
import { createOperatorAuth, passwordHash, totp } from '../src/services/licensing/operator-auth.mjs'
import { createLicenseCenter, emptyCenterState } from '../src/services/licensing/center.mjs'
import { migrateAccounting } from '../src/services/licensing/accounting-migration.mjs'
import { emptyResourceIntents } from '../src/services/licensing/resource-runtime.mjs'
import { emptyCustomDefinitions } from '../src/services/licensing/custom-definitions.mjs'
import { emptyPriceNotificationState } from '../src/services/licensing/price-notifications.mjs'
import { registerLicenseCenterRoutes } from '../src/routes/license-center.mjs'
import { serviceApp, serviceErrors } from '../src/services/licensing/runtime.mjs'
import { hashPassword } from '../src/utils/crypto.mjs'
import { mysqlAccountingStore } from '../src/repositories/accounting.mjs'
import { createAgentCommerce, sqlUserBank } from '../src/services/licensing/commerce.mjs'
import { readLegacyDeploymentSnapshot, collectMigrationProofs } from '../src/services/licensing/migration-snapshot.mjs'
import { applyLocalLegacyBinding } from '../src/services/licensing/local-legacy-binding.mjs'
import { shadowLegacyAuthorization, legacyRollbackStatus } from '../src/services/licensing/migration-safety.mjs'
import { previewOfficialLegacyScope, applyOfficialLegacyScope } from '../src/services/licensing/official-legacy-scope.mjs'
import { canonicalJson } from '../src/services/curated-skills.mjs'
// Invoked by the disposable MySQL runner. Boot both real admin processes with
// fictional resources; never inherit a deployment database or paid model route.
if (!process.env.LICENSING_TEST_DB) throw new Error('Run through npm run test:licensing:mysql with its disposable database')
const config=JSON.parse(process.env.LICENSING_TEST_DB)
assert.equal(config.host,'127.0.0.1');assert(Number.isInteger(config.port) && config.port>0)
const root=fileURLToPath(new URL('..',import.meta.url)), dir=await fs.mkdtemp(pathModule.join(os.tmpdir(),'yushu-resources-')), suffix=crypto.randomBytes(5).toString('hex')
const names=['local','official','center'].map(n=>`yushu_resources_${n}_${suffix}`), admin=await mysql.createConnection(config)
const createdNames=[]
let centerServer, localPool, officialPool, centerPool, center, credential, completed=false
const password=crypto.randomBytes(24).toString('hex'), processes={}, logs={}
await fs.mkdir(dir,{recursive:true,mode:0o700})
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
const ports={local:await freePort(),official:await freePort()}, urls=Object.fromEntries(Object.entries(ports).map(([n,p])=>[n,`http://127.0.0.1:${p}`]))
let centerUrl, envLocal
async function stop(n){const p=processes[n];if(p&&p.exitCode===null){p.kill('SIGTERM');await new Promise(r=>p.once('exit',r))}delete processes[n];if(logs[n])await fs.writeFile(`${dir}/${n}.log`,logs[n],{mode:0o600})}
async function start(n,mode,extra={}){
 logs[n]='';const p=spawn(process.execPath,['cloud/ai-admin/server.mjs'],{cwd:root,env:{...process.env,NODE_ENV:'test',AI_AUTHORIZATION_MODE:mode,AI_OFFICIAL_AUTHORIZATION_MODE:'legacy',AI_CENTER_SUPPLIER_MANAGEMENT:'0',AI_AGENT_CUSTOM_MODELS_FILE:'',AI_MODEL_GATEWAY_URL:'',AI_ADMIN_PORT:String(ports[n]),AI_ADMIN_HOST:'127.0.0.1',AI_ADMIN_PUBLIC_URL:`https://resources-${n}.example.com`,AI_ADMIN_PASSWORD:password,AI_DB_HOST:config.host,AI_DB_PORT:String(config.port),AI_DB_USER:config.user,AI_DB_PASSWORD:config.password,AI_DB_NAME:names[n==='local'?0:1],AI_BUILD_CENTER_URL:'',AI_BUILD_CENTER_TOKEN:'',AI_BUILD_CENTER_SUPPLIER_ID:'',AI_LICENSE_STATE_FILE:`${dir}/${n}-deployment.json`,AI_CURATED_SKILL_ROOT:`${dir}/${n}-skills`,AI_CURATED_SKILL_KEK_PATH:`${dir}/${n}-kek`,AI_CURATED_SKILL_SIGNING_PRIVATE_PATH:`${dir}/${n}-signing-private.pem`,AI_CURATED_SKILL_SIGNING_PUBLIC_PATH:`${dir}/${n}-signing-public.pem`,AI_UPLOAD_DIR:`${dir}/${n}-uploads`,AI_MODEL_CREDENTIAL_KEY_PATH:`${dir}/${n}-model-credentials.key`,AI_PRICE_NOTIFICATIONS_KEY_FILE:`${dir}/${n}-notifications.key`,...extra},stdio:['ignore','pipe','pipe'],windowsHide:true})
 processes[n]=p;p.stdout.on('data',b=>logs[n]+=String(b));p.stderr.on('data',b=>logs[n]+=String(b))
 for(let i=0;i<120;i++){if(p.exitCode!==null){await stop(n);throw Error(`${n} stopped; protected log retained`)}try{if((await fetch(urls[n]+'/api/runtime-info')).ok)return}catch{}await new Promise(r=>setTimeout(r,500))}throw Error('startup timed out')
}
async function request(n,path,body,method=body===undefined?'GET':'POST',auth=''){
 const response=await fetch(urls[n]+path,{method,headers:{...(body instanceof FormData?{}:{'Content-Type':'application/json'}),...(auth.startsWith('Bearer ')?{Authorization:auth}:auth?{Cookie:auth}:{})},...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)})})
 const data=response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer())
 return {status:response.status,headers:response.headers,...(Buffer.isBuffer(data)?{binary:data}:data)}
}
function ok(r){assert.equal(r.success,true,JSON.stringify({status:r.status,error:r.error,code:r.code}));return r.data}
async function login(n,username='admin',pwd=password){const c=ok(await request(n,'/api/login/captcha'));const svg=Buffer.from(c.imageDataUrl.split(',')[1],'base64').toString();const answer=[...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(m=>m[1]).join('');const r=await request(n,'/api/login',{username,password:pwd,challengeId:c.challengeId,captchaAnswer:answer});ok(r);return r.headers.get('set-cookie').split(';')[0]}
const ids={skill:`resource-skill-${suffix}`,mcp:`resource-mcp-${suffix}`,agent:`resource-agent-${suffix}`}, marker=`PRIVATE_PROOF_${crypto.randomBytes(18).toString('hex')}`
async function uploadSkill(cookie,version){const zip=new AdmZip();zip.addFile('SKILL.md',Buffer.from(`---\nname: fixture\ndescription: controlled test\n---\n${marker}`));const form=new FormData();form.append('package',new Blob([zip.toBuffer()],{type:'application/zip'}),'test.zip');form.append('version',version);const v=ok(await request('official',`/api/curated-skills/${ids.skill}/versions`,form,'POST',cookie));ok(await request('official',`/api/curated-skills/${ids.skill}/versions/${v.id}/publish`,{},'POST',cookie));return v.id}
async function sync(cookie){for(const kind of ['skill','mcp','agent']){const data=ok(await request('local',`/api/curated-${kind}-sync`,{},'POST',cookie));assert.deepEqual(data.failed,[])} }
async function clientLogin(id,owner,organization){const pwd=crypto.randomBytes(20).toString('hex'),device=`device-${id}`;await localPool.query("INSERT INTO ai_end_users(id,username,display_name,password_hash,status,source_agent_id,organization_id,device_id) VALUES (?,?,?,?,'enabled',?,?,?)",[id,id,id,hashPassword(pwd),owner,organization,device]);const c=ok(await request('local','/api/client/auth/login-captcha'));const svg=Buffer.from(c.imageDataUrl.split(',')[1],'base64').toString();const answer=[...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(m=>m[1]).join('');const data=ok(await request('local','/api/client/auth/login',{username:id,password:pwd,deviceId:device,deviceName:'isolated',appVersion:'9.0.0',challengeId:c.challengeId,captchaAnswer:answer}));return {auth:`Bearer ${data.token}`,device}}
const path=version=>`/api/client/skill-market/${ids.skill}/versions/${version}`
try{
 for(const name of names){await admin.query('CREATE DATABASE ??',[name]);createdNames.push(name)}
 localPool=mysql.createPool({...config,database:names[0]});officialPool=mysql.createPool({...config,database:names[1]});centerPool=mysql.createPool({...config,database:names[2]})
 const store=mysqlStateStore(centerPool,'state-v1',emptyCenterState());await store.migrate();const keys=crypto.generateKeyPairSync('ed25519'),publicKeys={test:keys.publicKey.export({type:'spki',format:'pem'})}
 center=createLicenseCenter({store,privateKey:keys.privateKey,publicKeys,keyId:'test',credentialKey:crypto.randomBytes(32)})
 const centerOperators=createOperatorAuth({store,operators:[{id:'fixture-operator',passwordHash:passwordHash(password),totpSecret:'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'}]});const app=serviceApp();registerLicenseCenterRoutes(app,{center,operators:centerOperators});serviceErrors(app);centerServer=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});centerUrl=`http://127.0.0.1:${centerServer.address().port}`
 await fs.writeFile(dir+'/public-keys.json',JSON.stringify(publicKeys),{mode:0o600})
 const operatorLogin=await fetch(centerUrl+'/api/license-center/v1/operator/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'fixture-operator',password,code:totp('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',Math.floor(Date.now()/30000))})})
 const operatorSession=await operatorLogin.json();assert(operatorSession.success);await fs.writeFile(dir+'/operator-token',operatorSession.data.token,{mode:0o600})
 const runTransfer=async(...args)=>{const out=await promisify(execFile)(process.execPath,['scripts/authorization-transfer.mjs',...args],{cwd:root,windowsHide:true,env:{...process.env,NODE_ENV:'test',AI_AUTH_TRANSFER_DB_HOST:config.host,AI_AUTH_TRANSFER_DB_PORT:String(config.port),AI_AUTH_TRANSFER_DB_USER:config.user,AI_AUTH_TRANSFER_DB_PASSWORD:config.password,AI_AUTH_TRANSFER_DB_NAME:names[args[0].startsWith('official-')?1:0],AI_AUTHORIZATION_MIGRATION:'approved',AI_AUTH_TRANSFER_PUBLIC_KEYS_FILE:dir+'/public-keys.json',AI_AUTH_TRANSFER_MAINTENANCE:'1',AI_AUTH_TRANSFER_PUBLIC_URL:'https://resources-local.example.com',AI_AUTH_TRANSFER_INSTANCE_ID:'resource-instance',AI_AUTH_TRANSFER_CENTER_URL:centerUrl,AI_AUTH_TRANSFER_OPERATOR_TOKEN_FILE:dir+'/operator-token'}});assert(!out.stdout.includes(password));return out}

 await start('official','legacy',{AI_OFFICIAL_AUTHORIZATION_MODE:'center',AI_CENTER_SUPPLIER_MANAGEMENT:'1',AI_LICENSE_CENTER_URL:centerUrl})
 await start('local','legacy');await stop('local')
 await localPool.query(await fs.readFile(root+'/src/db/authorization-local.sql','utf8'));await migrateAccounting({pool:localPool,book:'commerce-v2',kind:'commerce',sourceId:'commerce-v1'})
 await mysqlStateStore(localPool,'local-resources-v1',emptyResourceIntents()).migrate();await mysqlStateStore(localPool,'commerce-v2-price-notifications',emptyPriceNotificationState()).migrate();await mysqlStateStore(localPool,'commerce-v2-custom-definitions',emptyCustomDefinitions()).migrate()
 envLocal={AI_LICENSE_CENTER_URL:centerUrl,AI_LICENSE_INSTANCE_ID:'resource-instance',AI_LICENSE_PUBLIC_KEYS_FILE:dir+'/public-keys.json',AI_BUILD_CENTER_URL:urls.official}
 const [[legacyOrganization]]=await localPool.query('SELECT id FROM ai_organizations WHERE agent_level=1')
 await localPool.query("INSERT INTO ai_model_providers(id,name,base_url,organization_id) VALUES ('legacy-provider','虚构旧供应商','https://legacy-provider.example/v1',?)",[legacyOrganization.id])
 await localPool.query("INSERT INTO ai_provider_models(id,provider_id,model_id,display_name,organization_id,context_window) VALUES ('legacy-model','legacy-provider','legacy-model-client','虚构旧文本',?,100)",[legacyOrganization.id])
 await localPool.query("INSERT INTO ai_model_task_capabilities(id,provider_model_id,organization_id,task_type,protocol_adapter) VALUES ('legacy-capability','legacy-model',?,'chat','legacy.compatible')",[legacyOrganization.id])
 await localPool.query("INSERT INTO ai_model_pricing_plans(id,provider_model_id,capability_id,organization_id,task_type,status) VALUES ('legacy-plan','legacy-model','legacy-capability',?,'chat','enabled')",[legacyOrganization.id])
 for(const [meter,points]of [['input_tokens','10'],['output_tokens','20']])await localPool.query("INSERT INTO ai_model_pricing_components(id,plan_id,meter_code,charge_phase,unit_size,sale_points,cost_amount,metadata_json) VALUES (?,'legacy-plan',?,'usage',1000000,?,0,?)",[`legacy-${meter}`,meter,points,JSON.stringify({migration:'legacy_cost_points',value:'3',secret:'fictional-metadata-must-not-export'})])
 for(const [pool,id,organization]of [[localPool,'legacy-project',legacyOrganization.id],[officialPool,'resources-root-legacy-project','']])await pool.query("INSERT INTO ai_projects(id,owner_user_id,organization_id,app_name,brand_name,short_name,app_id,config_dir_name) VALUES (?,'admin',?,'虚构历史项目','虚构品牌','虚构',?,?)",[id,organization,`test.${id}`,`.${id}`])
 await localPool.query("INSERT INTO ai_builds(id,project_id,owner_user_id,organization_id,status,remote_build_id) VALUES ('legacy-build','legacy-project','admin',?,'succeeded','legacy-remote')",[legacyOrganization.id])
 await officialPool.query("INSERT INTO ai_center_suppliers(id,name,token_hash) VALUES ('resources-root','虚构历史供货','unusable-test-token')")
 await officialPool.query("INSERT INTO ai_builds(id,project_id,owner_user_id,organization_id,status,center_supplier_id,center_local_build_id) VALUES ('legacy-remote','resources-root-legacy-project','admin','','succeeded','resources-root','legacy-build')")
 const profile={sourceId:'resource-legacy-source',oldOrganizationId:legacyOrganization.id,legacySupplierId:'resources-root',status:'enabled',expiresAt:null,allowCustomApiProviders:true,domain:'https://resources-local.example.com',instanceId:'resource-instance',cumulativeBuilds:1,
 capabilities:BASE_PACKAGES['first-custom'].capabilities.map(cap=>({...cap,limitValue:cap.key==='projects.manage'?1:cap.key==='builds.create'?10:0}))}
 await fs.writeFile(dir+'/profile.json',JSON.stringify(profile),{mode:0o600});await runTransfer('export',dir+'/profile.json',dir+'/snapshot.json');const snapshot=JSON.parse(await fs.readFile(dir+'/snapshot.json','utf8'))
 assert.equal(JSON.stringify(snapshot).includes('password_hash'),false);assert.equal(JSON.stringify(snapshot).includes('model_gateway_key'),false)
 const alternateDecoder=mysql.createPool({...config,database:names[0],timezone:'+08:00',decimalNumbers:true,supportBigNumbers:false})
 try{assert.deepEqual(await collectMigrationProofs(alternateDecoder),snapshot.proofs)}finally{await alternateDecoder.end()}
 assert(snapshot.proofs.orders.tables.some(table=>table.table==='ai_payment_fulfillments'))
 const receiptProbe=await localPool.getConnection()
 try{
  await receiptProbe.beginTransaction()
  await receiptProbe.query('INSERT INTO ai_payment_fulfillments(order_id,owner_user_id,user_id,membership_id,points,fingerprint,payload) VALUES (?,?,?,?,?,?,?)',['fixture-order-proof','admin','fixture-user','fixture-membership','0','0'.repeat(64),'{}'])
  assert.notEqual((await collectMigrationProofs(receiptProbe)).orders.hash,snapshot.proofs.orders.hash)
  await receiptProbe.query("INSERT INTO ai_payment_refunds(order_id,id,owner_user_id,user_id,command_id,fingerprint,state,next_retry_at,lease_until,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,'unknown',0,0,0,'{}',1,1)",['fixture-cash-order','R-fixture-cash','admin','fixture-user','fixture-cash-command','0'.repeat(64)])
  const cashRollback=await legacyRollbackStatus(receiptProbe,snapshot)
  assert.equal(cashRollback.cashRefunds,1);assert.equal(cashRollback.pendingCashRefunds,1);assert.equal(cashRollback.compatibleVersionRequired,true);assert.equal(cashRollback.databaseSnapshotRestoreAllowed,false)
  assert.equal((await readLegacyDeploymentSnapshot(receiptProbe,profile)).blockers.pendingPaymentRefunds,1)
 }finally{await receiptProbe.rollback();receiptProbe.release()}
 const transferManifest={batchId:'resource-legacy-import',snapshot,mapping:{oldOrganizationId:legacyOrganization.id,grantId:'resources-root',packageId:'first-custom',packageVersion:1,domain:profile.domain,instanceId:profile.instanceId,officialModelIds:[],unlimitedExpiryReview:'隔离历史无限期核验'}}
 const importPreview=await center.previewLegacyImport(transferManifest),imported=await center.importLegacy({...transferManifest,previewDigest:importPreview.previewDigest},'test')
 await localPool.query('UPDATE ai_organizations SET name=? WHERE id=?',['虚构采集后变更',legacyOrganization.id])
 await assert.rejects(applyLocalLegacyBinding({pool:localPool,...transferManifest,result:imported,publicKeys,maintenance:true,publicUrl:profile.domain,instanceId:profile.instanceId}),{code:'SOURCE_CHANGED'})
 await localPool.query('UPDATE ai_organizations SET name=? WHERE id=?',[snapshot.organizations[0].name,legacyOrganization.id])
 await fs.writeFile(dir+'/mapping.json',JSON.stringify({batchId:transferManifest.batchId,mapping:transferManifest.mapping}),{mode:0o600});await runTransfer('manifest',dir+'/snapshot.json',dir+'/mapping.json',dir+'/transfer.json');assert.deepEqual(JSON.parse(await fs.readFile(dir+'/transfer.json','utf8')),transferManifest);await fs.writeFile(dir+'/import-receipt.json',JSON.stringify(imported),{mode:0o600})
 await runTransfer('bind-local',dir+'/transfer.json',dir+'/import-receipt.json',dir+'/binding.json');const binding=JSON.parse(await fs.readFile(dir+'/binding.json','utf8'))

 assert.equal(binding.identitiesPreserved,true);assert.equal(binding.cutoverReady,false)
 const shadow=shadowLegacyAuthorization({...transferManifest,result:imported,publicKeys,proofs:await collectMigrationProofs(localPool),usage:(await center.preview('resources-root',{expectedVersion:1})).usage})
 assert.equal(shadow.authorizationAndRightsMatch,true,JSON.stringify(shadow));assert.equal(shadow.cutoverReady,false)
 await runTransfer('shadow',dir+'/transfer.json',dir+'/shadow.json');assert.equal(JSON.parse(await fs.readFile(dir+'/shadow.json','utf8')).authorizationAndRightsMatch,true)
 await runTransfer('rollback-check',dir+'/snapshot.json',dir+'/rollback.json');assert.equal(JSON.parse(await fs.readFile(dir+'/rollback.json','utf8')).databaseSnapshotRestoreAllowed,true)
 const officialScopeInput={pool:officialPool,...transferManifest,result:imported,publicKeys}
 await runTransfer('receipt',dir+'/transfer.json',dir+'/readonly-receipt.json');assert.equal(JSON.parse(await fs.readFile(dir+'/readonly-receipt.json','utf8')).activationCode,null)
 const priceReviews=[{sourcePlanId:'legacy-plan',pointsPerCny:'10',conversionReview:'虚构旧积分比例核定',costReview:'虚构独立人民币成本核定',costComponents:['request','input_tokens','cached_tokens','output_tokens'].map(meter=>({meter,phase:meter==='request'?'request':'usage',unitSize:meter==='request'?'1':'1000000',amount:'0.1',rounding:'none',minimumUnits:'0'}))}]
 await fs.writeFile(dir+'/price-reviews.json',JSON.stringify(priceReviews),{mode:0o600})
 await assert.rejects(runTransfer('model-preview',dir+'/transfer.json',dir+'/readonly-receipt.json',dir+'/price-reviews.json',dir+'/model-preview.json')) // Built-in official/private capabilities still require explicit mapping/adapters.
 const modelReview=JSON.parse(await fs.readFile(dir+'/model-preview.json','utf8'));assert.equal(modelReview.databaseChanged,false);assert.equal(modelReview.cutoverReady,false)
 const oldText=modelReview.models.find(item=>item.modelId==='legacy-model');assert.equal(oldText.action,'candidate-awaiting-runtime-shadow');assert.equal(oldText.proposal.sale.components.find(item=>item.meter==='cached_tokens').amount,'1.000000')
 assert(modelReview.blockers.length>0);assert.equal(JSON.stringify(modelReview).includes('fictional-metadata-must-not-export'),false)
 await localPool.query("UPDATE ai_currency_exchange_rates SET cny_rate=2 WHERE currency='CNY'")
 await assert.rejects(runTransfer('model-preview',dir+'/transfer.json',dir+'/readonly-receipt.json',dir+'/price-reviews.json',dir+'/changed-model-preview.json'))
 await assert.rejects(fs.access(dir+'/changed-model-preview.json'))
 await localPool.query("UPDATE ai_currency_exchange_rates SET cny_rate=1 WHERE currency='CNY'")
 await runTransfer('official-preview',dir+'/transfer.json',dir+'/readonly-receipt.json',dir+'/official-preview.json')
 const officialPreview=JSON.parse(await fs.readFile(dir+'/official-preview.json','utf8'));assert.equal(officialPreview.changes.length,2);assert.deepEqual(officialPreview.blockers,[])
 await assert.rejects(applyOfficialLegacyScope({...officialScopeInput,previewDigest:officialPreview.previewDigest,maintenance:false}),{code:'MAINTENANCE_REQUIRED'})
 await officialPool.query("UPDATE ai_projects SET organization_id='another-agent' WHERE id='resources-root-legacy-project'")
 const conflict=await previewOfficialLegacyScope(officialScopeInput);assert(conflict.blockers.some(item=>item.code==='OTHER_ORGANIZATION'))
 await assert.rejects(applyOfficialLegacyScope({...officialScopeInput,previewDigest:conflict.previewDigest,maintenance:true}),{code:'OFFICIAL_SCOPE_BLOCKED'})
 assert.equal((await officialPool.query("SELECT organization_id FROM ai_builds WHERE id='legacy-remote'"))[0][0].organization_id,'')
 await officialPool.query("UPDATE ai_projects SET organization_id='' WHERE id='resources-root-legacy-project'")
 await officialPool.query("UPDATE ai_builds SET center_local_build_id='unreviewed-build' WHERE id='legacy-remote'")
 await assert.rejects(applyOfficialLegacyScope({...officialScopeInput,previewDigest:officialPreview.previewDigest,maintenance:true}),{code:'OFFICIAL_SOURCE_CHANGED'})
 await officialPool.query("UPDATE ai_builds SET center_local_build_id='legacy-build' WHERE id='legacy-remote'")
 await Promise.all(['a','b'].map(label=>runTransfer('official-apply',dir+'/transfer.json',dir+'/readonly-receipt.json',dir+'/official-preview.json',dir+`/official-result-${label}.json`)))
 const officialResults=await Promise.all(['a','b'].map(async label=>JSON.parse(await fs.readFile(dir+`/official-result-${label}.json`,'utf8'))));assert.equal(officialResults.filter(item=>item.alreadyApplied).length,1)
 assert.equal((await previewOfficialLegacyScope(officialScopeInput)).changes.length,0)

 const grant={code:imported.activationCode}

 await start('local','center',envLocal);let rootCookie=await login('local');ok(await request('local','/api/authorization/activate',{code:grant.code},'POST',rootCookie));rootCookie=await login('local')
 credential=JSON.parse(await fs.readFile(dir+'/local-deployment.json','utf8')).credential
 const sub=await center.issue({id:'resources-child',name:'虚构资源二级',packageId:'second',parentId:'resources-root',expiresAt:null},'test')
 const invitation=ok(await request('local','/api/authorization/children/activate',{code:sub.code,username:'resource_child'},'POST',rootCookie)).invitation
 const childPwd=crypto.randomBytes(20).toString('hex');ok(await request('local','/api/authorization/invitation',{invitation,password:childPwd}));let childCookie=await login('local','resource_child',childPwd)
 const repeatedBinding=await applyLocalLegacyBinding({pool:localPool,...transferManifest,result:await center.legacyImportReceipt(transferManifest.batchId),publicKeys,maintenance:true,publicUrl:profile.domain,instanceId:profile.instanceId});assert.equal(repeatedBinding.alreadyApplied,true);assert.equal((await legacyRollbackStatus(localPool,snapshot)).databaseSnapshotRestoreAllowed,false)
 const [[childOwner]]=await localPool.query("SELECT legacy_owner_user_id FROM ai_organizations WHERE external_id='resources-child'");const [[rootOrg]]=await localPool.query("SELECT id,legacy_owner_user_id FROM ai_organizations WHERE external_id='resources-root'");assert(childOwner)
 const oldBuilds=ok(await request('official','/api/center/builds/status',{buildIds:['legacy-remote']},'POST',`Bearer ${(await center.serviceToken(credential,'official-build')).token}`));assert.equal(oldBuilds.length,1)
 const hiddenBuilds=ok(await request('official','/api/center/builds/status',{buildIds:['legacy-remote']},'POST',`Bearer ${(await center.serviceToken(credential,'official-build','resources-child')).token}`));assert.equal(hiddenBuilds.length,0)
 // Configure existing model/key management and review its new supply definition
 // through real HTTP, with no center preregistration of local model identities.
 const provider=ok(await request('local','/api/model-providers',{id:'review-provider',name:'虚构自接供应商',baseUrl:'https://review-provider.example/v1'},'POST',rootCookie))
 const localModel=ok(await request('local','/api/provider-models',{providerId:provider.id,modelId:'vendor-reviewed',displayName:'虚构审核文本',modelType:'text',contextWindow:100},'POST',rootCookie))
 ok(await request('local',`/api/model-providers/${provider.id}/keys`,{apiKey:'fictional-review-key',providerModelId:localModel.id},'POST',rootCookie))
 const review=ok(await request('local','/api/supply/custom-models',undefined,'GET',rootCookie)), candidate=review.candidates.find(item=>item.id===localModel.id)
 assert(candidate);assert.equal(JSON.stringify(review).includes('fictional-review-key'),false);assert.equal(JSON.stringify(review).includes('review-provider.example'),false)
 const reviewInput={providerModelId:localModel.id,expectedRevision:0,adapter:'openai.chat',status:'enabled',currency:'CNY',memo:'虚构报价审核',contextWindow:100,maxOutputTokens:5,clientId:'vendor-reviewed',costComponents:candidate.costComponents.map(item=>({...item,amount:'0.1'})),organizationId:'forged-child'}
 assert.equal(ok(await request('local','/api/supply/custom-models',reviewInput,'PUT',rootCookie)).revision,1)
 assert.equal((await request('local','/api/supply/custom-models',reviewInput,'PUT',rootCookie)).status,409)
 assert.equal((await request('local','/api/supply/custom-models',undefined,'GET',childCookie)).status,403)
 ok(await request('local','/api/supply/offers',{modelId:localModel.id,expectedVersion:0,enabled:true,pointsPerCny:'1',saleMarkup:[{meter:'request',phase:'request',amount:'1'}],supplyMarkup:[{meter:'request',phase:'request',amount:'0.5'}]},'POST',rootCookie))
 const inherited=ok(await request('local','/api/supply/catalog',undefined,'GET',childCookie));assert(inherited.some(row=>row.model.id===localModel.id))
 assert.equal(JSON.stringify(inherited).includes('supplierCost'),false);assert.equal(JSON.stringify(inherited).includes('review-provider.example'),false)
 const officialCookie=await login('official')
 ok(await request('official','/api/curated-skills',{id:ids.skill,name:'隔离保护技能',distributionType:'protected'},'POST',officialCookie));await uploadSkill(officialCookie,'1.0.0')
 ok(await request('official','/api/curated-mcps',{id:ids.mcp,name:'隔离MCP'},'POST',officialCookie));const mcpVersion=ok(await request('official',`/api/curated-mcps/${ids.mcp}/versions`,{version:'1.0.0',config:{transport:'remote',url:'https://example.com/mcp'}},'POST',officialCookie));ok(await request('official',`/api/curated-mcps/${ids.mcp}/versions/${mcpVersion.id}/publish`,{},'POST',officialCookie))
 ok(await request('official','/api/curated-agents',{id:ids.agent,name:'隔离依赖专家',description:'测试用途',prompt:'test instruction',skillIds:[ids.skill],mcpIds:[ids.mcp]},'POST',officialCookie));ok(await request('official',`/api/curated-agents/${ids.agent}/publish`,{},'POST',officialCookie))
 await sync(rootCookie)
 for(const [kind,id] of Object.entries(ids))ok(await request('local',`/api/curated-${kind}-distributions/${id}`,{enabled:true,versionPolicy:'follow_latest',audienceType:'all'},'PUT',childCookie))
 const childUser=await clientLogin(`child-user-${suffix}`,childOwner.legacy_owner_user_id,'resources-child'), rootUser=await clientLogin(`root-user-${suffix}`,rootOrg.legacy_owner_user_id,rootOrg.id)
 for(const kind of ['skill','mcp','agent'])assert(ok(await request('local',`/api/client/${kind}-market`,undefined,'GET',childUser.auth)).items.some(x=>x.id===ids[kind]))
 const download=await request('local',path('1.0.0')+'/package',undefined,'GET',childUser.auth);assert.equal(download.status,200);assert(download.binary);assert(!download.binary.includes(Buffer.from(marker)))
 const manifest=JSON.parse(Buffer.from(download.headers.get('x-agent-skill-manifest'),'base64').toString()), unsigned={...manifest};delete unsigned.signature
 const signing=ok(await request('local','/api/client/skill-market/signing-key',undefined,'GET',childUser.auth));assert(crypto.verify(null,Buffer.from(canonicalJson(unsigned)),crypto.createPublicKey(signing.publicKey),Buffer.from(manifest.signature,'base64')))
 const leaseBody={deviceId:childUser.device,appVersion:'9.0.0',manifestSha256:crypto.createHash('sha256').update(canonicalJson(manifest)).digest('hex'),organizationId:'resources-root'}
 assert.equal((await request('local',path('1.0.0')+'/lease',{...leaseBody,deviceId:'wrong'},'POST',childUser.auth)).status,403)
 const lease=ok(await request('local',path('1.0.0')+'/lease',leaseBody,'POST',childUser.auth));const decipher=crypto.createDecipheriv('aes-256-gcm',Buffer.from(lease.contentKey,'base64'),Buffer.from(manifest.encryption.iv,'base64'));decipher.setAuthTag(Buffer.from(manifest.encryption.authTag,'base64'));const plaintext=Buffer.concat([decipher.update(download.binary),decipher.final()]);assert(new AdmZip(plaintext).readAsText('SKILL.md').includes(marker));assert.equal(crypto.createHash('sha256').update(plaintext).digest('hex'),manifest.contentSha256)
 const [[audit]]=await officialPool.query("SELECT actor_id,detail_json FROM ai_curated_skill_events WHERE event_type='center_lease_issued' AND skill_id=? ORDER BY created_at DESC LIMIT 1",[ids.skill]);assert.equal(audit.actor_id,'resources-child')
 ok(await request('local',`/api/client/skill-market/${ids.skill}/installations`,{deviceId:childUser.device,status:'installed'},'POST',childUser.auth))
 assert(ok(await request('local',`/api/curated-skill-distributions/${ids.skill}/installations`,undefined,'GET',childCookie)).some(x=>x.end_user_id===`child-user-${suffix}`))
 // Local opt-out survives upstream new version, withdrawal and restoration.
 for(const [kind,id] of Object.entries(ids))ok(await request('local',`/api/curated-${kind}-distributions/${id}`,{enabled:false,versionPolicy:'follow_latest',audienceType:'all'},'PUT',childCookie))
 await uploadSkill(officialCookie,'1.0.1');await sync(rootCookie)
 for(const kind of ['skill','mcp','agent'])assert(!ok(await request('local',`/api/client/${kind}-market`,undefined,'GET',childUser.auth)).items.some(x=>x.id===ids[kind]))
 for(const [kind,id] of Object.entries(ids))ok(await request('official',`/api/curated-${kind}s/${id}/status`,{status:'disabled'},'PATCH',officialCookie))
 await sync(rootCookie)
 for(const [kind,id] of Object.entries(ids))ok(await request('official',`/api/curated-${kind}s/${id}/status`,{status:'published'},'PATCH',officialCookie))
 await sync(rootCookie)
 for(const kind of ['skill','mcp','agent'])assert(!ok(await request('local',`/api/client/${kind}-market`,undefined,'GET',childUser.auth)).items.some(x=>x.id===ids[kind]))
 for(const [kind,id] of Object.entries(ids))ok(await request('local',`/api/curated-${kind}-distributions/${id}`,{enabled:true,versionPolicy:'follow_latest',audienceType:'all'},'PUT',childCookie))
 // Child capability change keeps root usable and blocks required expert dependencies.
 const reduced={...BASE_PACKAGES.second,version:2,capabilities:BASE_PACKAGES.second.capabilities.map(c=>c.key==='curated_skills.distribute'?{...c,enabled:false}:c)};await center.publishPackage(reduced,'test')
 const patch={expectedVersion:1,packageId:'second',packageVersion:2};const preview=await center.preview('resources-child',patch);await center.update('resources-child',{...patch,previewDigest:preview.previewDigest},'test')
 await stop('local');let cache=JSON.parse(await fs.readFile(dir+'/local-deployment.json','utf8'));cache.checkedAt=0;await fs.writeFile(dir+'/local-deployment.json',JSON.stringify(cache),{mode:0o600});await start('local','center',envLocal)
 assert.equal((await request('local','/api/client/skill-market',undefined,'GET',childUser.auth)).status,403)
 assert.equal((await request('local',path('1.0.1')+'/lease',{...leaseBody,manifestSha256:undefined},'POST',childUser.auth)).status,403)
 assert(!ok(await request('local','/api/client/agent-market',undefined,'GET',childUser.auth)).items.some(x=>x.id===ids.agent))
 assert.equal((await request('local','/api/client/mcp-market',undefined,'GET',childUser.auth)).status,200)
 assert.equal((await request('local','/api/client/skill-market',undefined,'GET',rootUser.auth)).status,200)
 const token=(await center.serviceToken(credential,'official-resources','resources-child')).token
 assert.equal((await request('official',`/api/center/curated-skills/${ids.skill}/versions/1.0.1/lease`,{deviceIdHash:'a'.repeat(64),endUserHash:'b'.repeat(64),nonce:crypto.randomUUID()},'POST',`Bearer ${token}`)).status,403)
 // Restore the same identity after central suspension and verify isolation.
 await localPool.query("UPDATE ai_organizations SET status='disabled' WHERE id=?",[rootOrg.id])
 const pausedCookie=await login('local');await request('local','/api/license',undefined,'GET',pausedCookie)
 const [[pausedRoot]]=await localPool.query('SELECT status FROM ai_organizations WHERE id=?',[rootOrg.id]);assert.equal(pausedRoot.status,'disabled')
 assert.equal((await request('local','/api/client/mcp-market',undefined,'GET',childUser.auth)).status,403)
 await localPool.query("UPDATE ai_organizations SET status='enabled' WHERE id=?",[rootOrg.id])
 const [[refundUser]]=await localPool.query('SELECT id,organization_id FROM ai_end_users WHERE id=?',[`child-user-${suffix}`])
 assert(refundUser)
 await localPool.query('UPDATE ai_end_users SET credit_balance=10 WHERE id=?',[refundUser.id])
 const refundStore=mysqlAccountingStore(localPool,'commerce-v2','commerce'), refundPrice={version:1,components:[{meter:'request',phase:'request',amount:'1',unitSize:'1'}]},refundUsage=[{meter:'request',phase:'request',quantity:'1'}]
 const fakeCommerce=createAgentCommerce({store:refundStore,rootId:'resources-root',userBank:sqlUserBank(),catalog:async()=>[{id:'fictional-refund-model',source:'custom',price:refundPrice,supplierCost:refundPrice,prepare:async request=>({request,upperUsage:refundUsage})}],invoke:async()=>({state:'done',usage:refundUsage})})
 await fakeCommerce.configure({id:'resources-root',level:1},{modelId:'fictional-refund-model',expectedVersion:0,enabled:true,pointsPerCny:'1',saleMarkup:[],supplyMarkup:[]},'fixture')
 await fakeCommerce.configure({id:'resources-child',level:2},{modelId:'fictional-refund-model',expectedVersion:0,enabled:true,pointsPerCny:'1',saleMarkup:[]},'fixture')
 await fakeCommerce.credit({id:'resources-root',level:1},'resources-child','10','fixture-refund-funds','fictional-refund-receipt','fixture')
 await fakeCommerce.submit({id:'resources-child',level:2},refundUser.id,{requestId:'inactive-refund-call',modelId:'fictional-refund-model',request:{}})
 await center.update('resources-child',{expectedVersion:2,status:'suspended'},'test')
 async function restartLocal(){await stop('local');const state=JSON.parse(await fs.readFile(dir+'/local-deployment.json','utf8'));state.checkedAt=0;await fs.writeFile(dir+'/local-deployment.json',JSON.stringify(state),{mode:0o600});await start('local','center',envLocal)}
 await restartLocal()
 assert.equal((await request('local','/api/client/mcp-market',undefined,'GET',childUser.auth)).status,403)
 assert.equal((await request('local','/api/client/mcp-market',undefined,'GET',rootUser.auth)).status,200)
 childCookie=await login('local','resource_child',childPwd)
 const refundInput={commandId:'inactive-refund-command',reason:'虚构暂停后退积分验收',organizationId:rootOrg.id}
 const refunded=ok(await request('local','/api/supply/requests/inactive-refund-call/refund-points',refundInput,'POST',childCookie));assert.equal(refunded.points,'1.000000');assert.equal(refunded.cashRefunded,false)
 assert.equal(ok(await request('local','/api/supply/requests/inactive-refund-call/refund-points',refundInput,'POST',childCookie)).entry.id,refunded.entry.id)
 rootCookie=await login('local')
 assert.equal((await request('local','/api/supply/requests/inactive-refund-call/refund-points',{...refundInput,commandId:'root-cannot-refund-child'},'POST',rootCookie)).status,404)
 assert.equal(String((await localPool.query('SELECT credit_balance FROM ai_end_users WHERE id=?',[refundUser.id]))[0][0].credit_balance),'10.000000')
 assert.equal((await refundStore.read()).wallets['resources-child'].balance,'9.000000')
 await center.update('resources-child',{expectedVersion:3,status:'enabled'},'test')
 const restore={expectedVersion:4,packageId:'second',packageVersion:1}, restorePreview=await center.preview('resources-child',restore)
 await center.update('resources-child',{...restore,previewDigest:restorePreview.previewDigest},'test')
 await restartLocal()
 assert(ok(await request('local','/api/client/skill-market',undefined,'GET',childUser.auth)).items.some(x=>x.id===ids.skill))
 assert(ok(await request('local','/api/client/agent-market',undefined,'GET',childUser.auth)).items.some(x=>x.id===ids.agent))
 const report={actualOfficialAndLocalProcesses:true,legacySnapshotAndSignedImport:true,exportBindShadowRollbackCli:true,officialScopeBackfillCli:true,oldBuildReadableByRootOnly:true,legacyPriceReviewCli:true,cachedLegacyPricePreserved:true,sourcePriceMutationRejected:true,sourceMutationRejected:true,localIdentityAndRightsPreserved:true,repeatedBindingNoReset:true,businessPauseSurvivesLicenseSync:true,customSupplyReviewHttp:true,noLocalModelPreregistration:true,existingKeyPoolCrud:true,legacyTokenUnconfigured:true,threeResourceCatalogs:true,childProtectedLeaseIdentity:true,signedEncryptedPackage:true,authenticatedDecryption:true,installationReport:true,wrongDeviceDenied:true,optOutSurvivesNewVersionAndWithdrawal:true,childCapabilityRevocation:true,requiredExpertDependencyRevocation:true,rootNotAffected:true,parentBusinessStop:true,suspensionAndExplicitRestoration:true,inactiveTerminalRefundHttp:true,terminalRefundDoesNotCreditSupply:true,paidSupplierCalls:0,productionChanged:false}
 await fs.writeFile(dir+'/report.json',JSON.stringify(report,null,2),{mode:0o600});console.log('Resource HTTP regression: '+JSON.stringify(report));completed=true
}finally{
 await stop('local');await stop('official');if(centerServer){centerServer.closeAllConnections();await new Promise(r=>centerServer.close(r))}
 await localPool?.end();await officialPool?.end();await centerPool?.end();for(const name of createdNames){assert.match(name,/^yushu_resources_(local|official|center)_[a-f0-9]{10}$/);await admin.query('DROP DATABASE IF EXISTS ??',[name])}await admin.end();console.log('Only newly created resource acceptance databases removed.');if(completed){assert(pathModule.resolve(dir).startsWith(pathModule.resolve(os.tmpdir())+pathModule.sep));await fs.rm(dir,{recursive:true,force:true})}else{console.log('Protected failure logs: '+dir)}
}
