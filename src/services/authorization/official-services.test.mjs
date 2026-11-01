import test from 'node:test'
import assert from 'node:assert/strict'
import { officialAuthorization, officialRequest } from './official-services.mjs'
import { officialServicePolicy } from './resource-access.mjs'
test('official services verify purpose and trusted subject before creating business associations', async () => {
  const calls=[],claims={sub:'agent',rootId:'agent',grant:{id:'agent',name:'TEST',level:1,version:2,capabilities:[{key:'builds.create',enabled:true}]}}
  const authorize=officialAuthorization({centerUrl:'https://license.example.test',database:()=>({query:async(...args)=>{calls.push(args)}}),findSupplier:async()=>({id:'agent'}),fetchImpl:async(_url,options)=>{assert.equal(options.redirect,'error');assert.equal(JSON.parse(options.body).audience,'official-build');return new Response(JSON.stringify({success:true,data:claims}))}})
  async function attempt(supplierId,path='/api/center/builds'){let error,continued=false;const req={path,headers:{authorization:'Bearer test-purpose-token'},body:{supplierId}};await authorize(req,{},e=>{error=e;continued=!e});return{req,error,continued}}
  assert.equal((await attempt('forged')).error.code,'ORGANIZATION_MISMATCH');assert.equal(calls.length,0)
  const accepted=await attempt('agent');assert(accepted.continued);assert.equal(accepted.req.centerSupplier.centralAuthorization,true);assert.equal(calls.length,1)
  assert.equal((await attempt('agent','/api/center/builds/job/publish')).error.code,'CAPABILITY_DENIED')
  assert.equal(officialServicePolicy('/api/center/source-version').audience,'official-updates')
  assert.equal(officialServicePolicy('/api/center/curated-skills/demo/versions/1/package').permission,'curated_skills.distribute')
})
test('outgoing official requests replace caller supplied subject and cannot follow redirects or use plaintext endpoints', async () => {
  const client={claims:async()=>({id:'trusted'}),serviceToken:async audience=>{assert.equal(audience,'official-build');return'purpose-token'}}
  const result=await officialRequest({client,config:{url:'https://center.example.test'},pathname:'/api/center/builds',body:{supplierId:'forged',localBuildId:'job'},fetchImpl:async(url,options)=>{assert.equal(String(url),'https://center.example.test/api/center/builds');assert.equal(JSON.parse(options.body).supplierId,'trusted');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer purpose-token');return new Response('{"success":true,"data":{"id":"job"}}')}})
  assert.equal(result.id,'job')
  await assert.rejects(officialRequest({client,config:{url:'http://center.example.test'},pathname:'/api/center/builds'}),{code:'OFFICIAL_HTTPS_REQUIRED'})
})

test('official requests retain an explicitly configured reverse proxy path prefix', async () => {
  const client={claims:async()=>({id:'trusted'}),serviceToken:async()=> 'purpose-token'}
  await officialRequest({client,config:{url:'https://stage.example.test/official/'},pathname:'/api/center/builds',fetchImpl:async(url)=>{assert.equal(url,'https://stage.example.test/official/api/center/builds');return new Response('{"success":true,"data":{}}')}})
})
