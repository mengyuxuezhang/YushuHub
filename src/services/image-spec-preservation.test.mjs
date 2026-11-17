import assert from 'node:assert/strict'
import test from 'node:test'
import { syncAutomaticModelCapability } from './model-management-defaults.mjs'
import { imageSpecTemplate } from './image-model-specs.mjs'
test('editing model metadata preserves explicit image specs, quality and unrelated capability settings',async()=>{
 const previous={endpoints:{submit:'/before',lookup:'/lookup'},parameters:{keep:true},image:{...imageSpecTemplate(),quality:'low',defaultSize:'1024x1024'}};let saved
 const connection={query:async(sql,values)=>{
  if(sql.includes('SELECT c.upstream_account_id AS id'))return [[{id:'account'}]]
  if(sql.includes('SELECT id,config_revision,config_json'))return [[{id:'cap',config_revision:4,config_json:JSON.stringify(previous)}]]
  if(sql.startsWith('INSERT INTO ai_model_task_capabilities'))saved=JSON.parse(values[7])
  return [[]]
 }}
 await syncAutomaticModelCapability(connection,{modelId:'model',providerId:'provider',modelType:'image',organizationId:'org',endpointPath:'/custom/images'})
 assert.deepEqual(saved.image,previous.image);assert.deepEqual(saved.parameters,{keep:true});assert.equal(saved.endpoints.lookup,'/lookup');assert.equal(saved.endpoints.submit,'/custom/images')
})
