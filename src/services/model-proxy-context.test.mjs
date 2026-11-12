import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelProxyContextResolver } from './model-proxy-context.mjs'

function harness() {
  const calls=[],user={id:'u',organizationId:'org',sourceAgentId:'owner'}
  let allowed=null,enabled=true,selected=0
  const db={async query(sql,params){
    calls.push({sql,params})
    if(sql.includes('FROM ai_provider_models m'))return [[{id:'m',provider_id:'p',model_id:'text',organization_id:'org',model_type:'text',base_url:'https://provider.example/v1'}]]
    if(sql.includes('SELECT k.*'))return [enabled?[{id:'key',api_key:'secret',key_preview:'preview'}]:[]]
    if(sql.includes('SELECT id FROM ai_model_task_capabilities'))return [[]]
    return [{affectedRows:1}]
  }}
  const resolve=createModelProxyContextResolver({db:()=>db,findEndUserById:async()=>{selected++;return user},
    keyOwnerUserIdForEndUser:async(id,known)=>{assert.equal(known.id,id);return known.sourceAgentId},
    allowedProviderModelIdSetForUser:async(id,owner)=>{assert.equal(owner,'owner');return allowed},
    normalizeProviderModelType:x=>x,normalizeModelProvider:r=>({id:r.id,name:'P',baseUrl:r.base_url}),
    normalizeProviderModel:r=>({id:r.id,modelId:r.model_id,modelType:r.model_type,organizationId:r.organization_id}),
    getSupplierLicense:async()=>({verified:true}),normalizeModelEndpointPath:()=>'/chat/completions',
    materializeModelProviderKey:async k=>k,listModelPricingRules:async()=>[{providerModelId:'m',status:'enabled'}],
    pricingPlanRepository:{},effectiveGatewayPricingRule:r=>r,previewSecret:()=>assert.fail('existing preview should be used')})
  return {resolve,calls,user,reads:()=>selected,deny:()=>{allowed=new Set()},disable:()=>{enabled=false}}
}
test('model lookup narrows by organization/type/model and reuses only matching authenticated identity',async()=>{
  const h=harness()
  await h.resolve('text','u','text',{endUser:h.user})
  assert.equal(h.reads(),0)
  const q=h.calls.find(q=>q.sql.includes('FROM ai_provider_models m'))
  assert.match(q.sql,/m.organization_id = \?/);assert.match(q.sql,/m.model_id = \?/);assert.deepEqual(q.params,['org','text','text'])
  await h.resolve('text','u','text',{endUser:{id:'other'}});assert.equal(h.reads(),1)
})
test('revoked permissions and disabled keys are reevaluated on the very next request',async()=>{
  const h=harness();await h.resolve('text','u','text',{endUser:h.user})
  h.disable();await assert.rejects(h.resolve('text','u','text',{endUser:h.user}),/暂无适用于该模型/)
  h.deny();await assert.rejects(h.resolve('text','u','text',{endUser:h.user}),/无权使用/)
})

test('SQL collation cannot turn a differently cased model ID into an authorized alias',async()=>{
  const h=harness();await assert.rejects(h.resolve('TEXT','u','text',{endUser:h.user}),/未启用/)
  assert(!h.calls.some(q=>q.sql.includes('SELECT k.*')))
})
