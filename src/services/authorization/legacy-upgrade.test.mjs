import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectLegacyUpgrade } from './legacy-upgrade.mjs'
import { createSupplierLicenseService } from '../supplier-license.mjs'

test('legacy detection requires old update backup and existing upstream identity and never overrides center state', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-proof-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const workDir=path.join(root,'data','self-update'), backup=path.join(workDir,'backups','backup-1.9.57-123456-deadbeef');fs.mkdirSync(backup,{recursive:true});fs.writeFileSync(path.join(backup,'package.json'),JSON.stringify({version:'1.9.57'}))
 let ended=0;const connect=async()=>({query:async q=>q.startsWith('SHOW TABLES')?[[{}]]:q.startsWith('SHOW COLUMNS')?[[{Field:'id'},{Field:'build_center_url'},{Field:'build_center_supplier_id'},{Field:'build_center_token'}]]:[[{build_center_url:'https://example.test',build_center_supplier_id:'fixture',build_center_token:'fixture'}]],end:async()=>{ended++}})
 const base={root,workDir,env:{},database:{},connect};assert.equal(await detectLegacyUpgrade(base),true);assert.equal(ended,1)
 assert.equal(await detectLegacyUpgrade({...base,env:{AI_AUTHORIZATION_MODE:'center'}}),false)
 assert.equal(await detectLegacyUpgrade({...base,env:{AI_LICENSE_CENTER_URL:'https://example.test'}}),false)
 fs.writeFileSync(path.join(root,'data','deployment-license.json'),'{}');assert.equal(await detectLegacyUpgrade(base),false)
 fs.rmSync(path.join(root,'data','deployment-license.json'));fs.rmSync(backup,{recursive:true});assert.equal(await detectLegacyUpgrade(base),false)
})
test('auto legacy mode never grants defaults after connection disappears',async()=>{
 const service=createSupplierLicenseService({defaults:{status:'enabled'},getConfig:async()=>({enabled:false}),requireConfigured:true})
 const value=await service.getSupplierLicense();assert.equal(value.verified,false);assert.equal(value.status,'disabled')
})
