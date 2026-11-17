import test from 'node:test'
import assert from 'node:assert/strict'
import { imageSpecTemplate, normalizeImageSpecs, selectImageSpec, outputImageSpec } from './image-model-specs.mjs'
import { backfillImageSpecs, retireImageReferencePricing } from './image-specs-migration.mjs'
import { assertImagePlan, imageBillingEvents, imageTokenEvents } from './image-task-billing.mjs'
import { quotePricing } from './compound-pricing.mjs'

const component = (meter, salePoints = 100, dimensions = {}) => ({ meter, salePoints, dimensions, phase: meter === 'request' ? 'request' : 'usage', unitSize: meter.includes('tokens') ? 1000000 : 1, status: 'enabled', costCurrency: 'CNY', costAmount: 0 })
const plan = components => ({ taskType: 'image_generation', status: 'enabled', components })
const config = () => ({ ...imageSpecTemplate(), usage: 'openai' })
test('specs are model-owned: defaults, 4K, small images and arbitrary named billing tiers', () => {
  const c = normalizeImageSpecs({ ...config(), defaultSize: '4096x4096', specs: [{size:'4096x4096',resolution:'4K',aspectRatio:'1:1'},{size:'512x512',resolution:'preview',aspectRatio:'1:1'}] })
  assert.equal(selectImageSpec(c,'auto').size, '4096x4096')
  assert.equal(selectImageSpec(c).resolution, '4K')
  assert.throws(()=>selectImageSpec(c,'2K'), /不支持/)
  assert.equal(selectImageSpec(c,'512x512').resolution, 'preview')
})
for (const patch of [{defaultSize:'4K'},{specs:[]},{maxReferences:1},{usage:'guess'},{tokenBudget:{input:0,output:1}},{quality:'invented'},{specs:[{size:'16384x16384',resolution:'4K'}]},{specs:[{size:'1024x1024',resolution:'1K'},{size:'1024x1024',resolution:'2K'}]}]) test(`invalid config is rejected: ${JSON.stringify(patch)}`,()=>assert.throws(()=>normalizeImageSpecs({...config(),...patch})))
test('reference protocol is explicit and not guessed from a model name',()=> {
  assert.equal(normalizeImageSpecs(imageSpecTemplate('seedream')).maxReferences,10)
  assert.throws(()=>normalizeImageSpecs({...config(),maxReferences:2}),/参考图/)
})
test('migration only materializes missing defaults, preserving endpoints and parameters',async()=> {
  const calls=[]
  const pool={query:async(sql,values)=>{calls.push({sql,values});return sql.startsWith('SELECT') ? [[{id:'old',model_id:'doubao-seedream-5-0-pro-260628',config_json:{endpoints:{submit:'/custom'},parameters:{keep:true}}}]] : [{}]}}
  await backfillImageSpecs(pool)
  const saved=JSON.parse(calls[1].values[0]);assert.equal(saved.endpoints.submit,'/custom');assert.equal(saved.parameters.keep,true);assert.equal(saved.image.adapter,'seedream');assert.match(calls[1].sql,/IS NULL/)
})
test('mode is exclusive and resolution coverage follows configured specs',()=> {
  assert.equal(assertImagePlan(plan([component('request')]),config()),'request')
  assert.throws(()=>assertImagePlan(plan([component('request'),component('image')]),config()),/一种/)
  assert.throws(()=>assertImagePlan(plan([component('additional_input_images')]),config()),/参考图/)
  assert.throws(()=>assertImagePlan(plan([component('image',1,{resolution:'1K'})]),config()),/全部/)
  assert.equal(assertImagePlan(plan([component('image',1,{resolution:'1K'}),component('image',2,{resolution:'1.5K'})]),config()),'resolution')
})
test('basic tokens charge actual aggregate input/output, with no per-reference addition',()=> {
  const p=plan([component('input_tokens',100),component('output_tokens',200)])
  const events=imageTokenEvents(p,{input_tokens:100,output_tokens:200,total_tokens:300})
  assert.equal(quotePricing(p,events).points,0.05)
  assert.ok(imageBillingEvents(p,config(),config().specs[0],null,true).length)
  assert.throws(()=>assertImagePlan(p,imageSpecTemplate()),/可靠Token/)
})
test('detailed tokens distinguish text/image/cache without double charging',()=> {
  const p=plan([component('input_tokens',100,{modality:'text'}),component('input_tokens',200,{modality:'image'}),component('cached_tokens',10,{modality:'text'}),component('cached_tokens',20,{modality:'image'}),component('output_tokens',300)])
  const raw={input_tokens:1000,output_tokens:100,input_tokens_details:{text_tokens:400,image_tokens:600,cached_tokens:300,cached_tokens_details:{text_tokens:100,image_tokens:200}}}
  const events=imageTokenEvents(p,raw)
  assert.equal(quotePricing(p,events).points,0.145)
  const estimate=quotePricing(p,imageBillingEvents(p,config(),config().specs[0],null,true))
  assert.ok(estimate.points>0.145)
  assert.throws(()=>imageTokenEvents(p,{...raw,input_tokens_details:{text_tokens:400,image_tokens:600,cached_tokens:300}}),/明细/)
})
for (const usage of [{},{input_tokens:0},{input_tokens:10,output_tokens:-1},{input_tokens:'10',output_tokens:1},{input_tokens:1,output_tokens:2,total_tokens:4},{input_tokens:1,output_tokens:2,input_tokens_details:{text_tokens:5,image_tokens:0}},{input_tokens:1,output_tokens:2,input_tokens_details:{cached_tokens:2}}]) test(`unreliable token usage is never billed as free success: ${JSON.stringify(usage)}`,()=>assert.throws(()=>imageTokenEvents(plan([component('input_tokens'),component('output_tokens')]),usage)))

test('explicit OpenAI usage aliases are supported and conflicting counts are rejected',()=>{
 const p=plan([component('input_tokens'),component('output_tokens')]);
 assert.equal(quotePricing(p,imageTokenEvents(p,{prompt_tokens:100,completion_tokens:200,total_tokens:300})).points,0.03);
 assert.throws(()=>imageTokenEvents(p,{input_tokens:100,prompt_tokens:200,output_tokens:20}),/别名/);
})

test('retirement only disables legacy image reference components, leaving snapshots and other prices unchanged',async()=>{
 const calls=[];await retireImageReferencePricing({query:async(sql)=>{calls.push(sql);return [{}]}});assert.equal(calls.length,1);assert.match(calls[0],/c.meter_code='additional_input_images'/);assert.match(calls[0],/image_generation/);assert.doesNotMatch(calls[0],/DELETE|pricing_snapshot|ai_model_operations/);
})

test('tier request and returned pixel dimensions resolve through model-specific bounds',()=>{
 const config=normalizeImageSpecs(imageSpecTemplate('seedream'));
 assert.equal(outputImageSpec(config,selectImageSpec(config,'2K'),'2048x2048').resolution,'2K');
 assert.throws(()=>outputImageSpec(config,selectImageSpec(config,'2K'),'4096x4096'),/不符合/);
 assert.throws(()=>outputImageSpec(config,selectImageSpec(config,'1K'),'2048x2048'),/不符合/);
})

test('compatible gateways may explicitly declare resolution aliases without a model-name heuristic',()=>{
 const c=normalizeImageSpecs({...config(),defaultSize:'4K',specs:[{size:'4K',resolution:'4K',aspectRatio:'auto',minPixels:8000000,maxPixels:20000000}]});
 assert.equal(selectImageSpec(c,'auto').size,'4K');assert.equal(outputImageSpec(c,c.specs[0],'4096x4096').resolution,'4K');
})
