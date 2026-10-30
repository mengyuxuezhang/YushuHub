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
import { readLegacyDeploymentSnapshot, collectMigrationProofs } from '../src/services/licensing/migration-snapshot.mjs'
import { applyLocalLegacyBinding } from '../src/services/licensing/local-legacy-binding.mjs'
import { shadowLegacyAuthorization, legacyRollbackStatus } from '../src/services/licensing/migration-safety.mjs'
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
 const runTransfer=async(...args)=>{const out=await promisify(execFile)(process.execPath,['scripts/authorization-transfer.mjs',...args],{cwd:root,windowsHide:true,env:{...process.env,NODE_ENV:'test',AI_AUTH_TRANSFER_DB_HOST:config.host,AI_AUTH_TRANSFER_DB_PORT:String(config.port),AI_AUTH_TRANSFER_DB_USER:config.user,AI_AUTH_TRANSFER_DB_PASSWORD:config.password,AI_AUTH_TRANSFER_DB_NAME:names[0],AI_AUTHORIZATION_MIGRATION:'approved',AI_AUTH_TRANSFER_PUBLIC_KEYS_FILE:dir+'/public-keys.json',AI_AUTH_TRANSFER_MAINTENANCE:'1',AI_AUTH_TRANSFER_PUBLIC_URL:'https://resources-local.example.com',AI_AUTH_TRANSFER_INSTANCE_ID:'resource-instance',AI_AUTH_TRANSFER_CENTER_URL:centerUrl,AI_AUTH_TRANSFER_OPERATOR_TOKEN_FILE:dir+'/operator-token'}});assert(!out.stdout.includes(password));return out}

 await start('official','legacy',{AI_OFFICIAL_AUTHORIZATION_MODE:'center',AI_CENTER_SUPPLIER_MANAGEMENT:'1',AI_LICENSE_CENTER_URL:centerUrl})
 await start('local','legacy');await stop('local')
 await localPool.query(await fs.readFile(root+'/src/db/authorization-local.sql','utf8'));await migrateAccounting({pool:localPool,book:'commerce-v2',kind:'commerce',sourceId:'commerce-v1'})
 await mysqlStateStore(localPool,'local-resources-v1',emptyResourceIntents()).migrate();await mysqlStateStore(localPool,'commerce-v2-price-notifications',emptyPriceNotificationState()).migrate();await mysqlStateStore(localPool,'commerce-v2-custom-definitions',emptyCustomDefinitions()).migrate()
 envLocal={AI_LICENSE_CENTER_URL:centerUrl,AI_LICENSE_INSTANCE_ID:'resource-instance',AI_LICENSE_PUBLIC_KEYS_FILE:dir+'/public-keys.json',AI_BUILD_CENTER_URL:urls.official}
 const [[legacyOrganization]]=await localPool.query('SELECT id FROM ai_organizations WHERE agent_level=1')
 const profile={sourceId:'resource-legacy-source',oldOrganizationId:legacyOrganization.id,legacySupplierId:'resources-root',status:'enabled',expiresAt:null,allowCustomApiProviders:true,domain:'https://resources-local.example.com',instanceId:'resource-instance',cumulativeBuilds:0,
 capabilities:BASE_PACKAGES['first-custom'].capabilities.map(cap=>({...cap,limitValue:cap.key==='projects.manage'?1:cap.key==='builds.create'?10:0}))}
 await fs.writeFile(dir+'/profile.json',JSON.stringify(profile),{mode:0o600});await runTransfer('export',dir+'/profile.json',dir+'/snapshot.json');const snapshot=JSON.parse(await fs.readFile(dir+'/snapshot.json','utf8'))
 assert.equal(JSON.stringify(snapshot).includes('password_hash'),false);assert.equal(JSON.stringify(snapshot).includes('model_gateway_key'),false)
 const alternateDecoder=mysql.createPool({...config,database:names[0],timezone:'+08:00',decimalNumbers:true,supportBigNumbers:false})
 try{assert.deepEqual(await collectMigrationProofs(alternateDecoder),snapshot.proofs)}finally{await alternateDecoder.end()}
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

 const grant={code:imported.activationCode}

 await start('local','center',envLocal);let rootCookie=await login('local');ok(await request('local','/api/authorization/activate',{code:grant.code},'POST',rootCookie));rootCookie=await login('local')
 credential=JSON.parse(await fs.readFile(dir+'/local-deployment.json','utf8')).credential
 const sub=await center.issue({id:'resources-child',name:'虚构资源二级',packageId:'second',parentId:'resources-root',expiresAt:null},'test')
 const invitation=ok(await request('local','/api/authorization/children/activate',{code:sub.code,username:'resource_child'},'POST',rootCookie)).invitation
 const childPwd=crypto.randomBytes(20).toString('hex');ok(await request('local','/api/authorization/invitation',{invitation,password:childPwd}));let childCookie=await login('local','resource_child',childPwd)
 const repeatedBinding=await applyLocalLegacyBinding({pool:localPool,...transferManifest,result:await center.legacyImportReceipt(transferManifest.batchId),publicKeys,maintenance:true,publicUrl:profile.domain,instanceId:profile.instanceId});assert.equal(repeatedBinding.alreadyApplied,true);assert.equal((await legacyRollbackStatus(localPool,snapshot)).databaseSnapshotRestoreAllowed,false)
 const [[childOwner]]=await localPool.query("SELECT legacy_owner_user_id FROM ai_organizations WHERE external_id='resources-child'");const [[rootOrg]]=await localPool.query("SELECT id,legacy_owner_user_id FROM ai_organizations WHERE external_id='resources-root'");assert(childOwner)
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
 await center.update('resources-child',{expectedVersion:2,status:'suspended'},'test')
 async function restartLocal(){await stop('local');const state=JSON.parse(await fs.readFile(dir+'/local-deployment.json','utf8'));state.checkedAt=0;await fs.writeFile(dir+'/local-deployment.json',JSON.stringify(state),{mode:0o600});await start('local','center',envLocal)}
 await restartLocal()
 assert.equal((await request('local','/api/client/mcp-market',undefined,'GET',childUser.auth)).status,403)
 assert.equal((await request('local','/api/client/mcp-market',undefined,'GET',rootUser.auth)).status,200)
 await center.update('resources-child',{expectedVersion:3,status:'enabled'},'test')
 const restore={expectedVersion:4,packageId:'second',packageVersion:1}, restorePreview=await center.preview('resources-child',restore)
 await center.update('resources-child',{...restore,previewDigest:restorePreview.previewDigest},'test')
 await restartLocal()
 assert(ok(await request('local','/api/client/skill-market',undefined,'GET',childUser.auth)).items.some(x=>x.id===ids.skill))
 assert(ok(await request('local','/api/client/agent-market',undefined,'GET',childUser.auth)).items.some(x=>x.id===ids.agent))
 const report={actualOfficialAndLocalProcesses:true,legacySnapshotAndSignedImport:true,exportBindShadowRollbackCli:true,sourceMutationRejected:true,localIdentityAndRightsPreserved:true,repeatedBindingNoReset:true,businessPauseSurvivesLicenseSync:true,customSupplyReviewHttp:true,noLocalModelPreregistration:true,existingKeyPoolCrud:true,legacyTokenUnconfigured:true,threeResourceCatalogs:true,childProtectedLeaseIdentity:true,signedEncryptedPackage:true,authenticatedDecryption:true,installationReport:true,wrongDeviceDenied:true,optOutSurvivesNewVersionAndWithdrawal:true,childCapabilityRevocation:true,requiredExpertDependencyRevocation:true,rootNotAffected:true,parentBusinessStop:true,suspensionAndExplicitRestoration:true,paidSupplierCalls:0,productionChanged:false}
 await fs.writeFile(dir+'/report.json',JSON.stringify(report,null,2),{mode:0o600});console.log('Resource HTTP regression: '+JSON.stringify(report));completed=true
}finally{
 await stop('local');await stop('official');if(centerServer){centerServer.closeAllConnections();await new Promise(r=>centerServer.close(r))}
 await localPool?.end();await officialPool?.end();await centerPool?.end();for(const name of createdNames){assert.match(name,/^yushu_resources_(local|official|center)_[a-f0-9]{10}$/);await admin.query('DROP DATABASE IF EXISTS ??',[name])}await admin.end();console.log('Only newly created resource acceptance databases removed.');if(completed){assert(pathModule.resolve(dir).startsWith(pathModule.resolve(os.tmpdir())+pathModule.sep));await fs.rm(dir,{recursive:true,force:true})}else{console.log('Protected failure logs: '+dir)}
}
