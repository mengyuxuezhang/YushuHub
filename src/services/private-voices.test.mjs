import test from 'node:test';
import assert from 'node:assert/strict';
import { PrivateVoiceService } from './private-voices.mjs';

function fixture({category='system',account='account-one',provider='provider-one'}={}) {
 const calls=[];
 const service=new PrivateVoiceService({
  contexts:{async resolve(user,model,accountId){calls.push(['resolve',model,accountId]);return {accountId:account,providerId:provider,keyId:'key',upstreamModel:'speech-test',connection:{},pricing:{status:'enabled',voice_points_per_1k_chars:1},adapter:{async invoke(connection,input){calls.push(['invoke',input]);return {bytes:Buffer.from('audio'),characters:5,durationSec:1}}}}}},
  operations:{async reserve(user,input){calls.push(['reserve',input]);return {created:true,operation:{id:'operation'}}},async start(){return true},async finish(user,id,input){return {id,voice_id:'voice-one',operation_type:'synthesize',status:input.status,points_reserved:1,points_settled:input.points||0}}},
  artifacts:{async save(){calls.push(['save'])}},
 });
 service.usableVoice=async()=>({category,row:{id:'voice-one',provider_model_id:'model-one',upstream_account_id:'account-one',provider_voice_id:'upstream-voice',status:category==='system'?'enabled':'active',...(category==='private'?{provider_id:'provider-one'}:{})}});
 return {service,calls};
}
const input={modelId:'model-one',voiceId:'voice-one',text:'Hello',speed:1,idempotencyKey:'unique-request'};
test('built-in voices synthesize using their bound account without a private provider field',async()=>{
 const {service,calls}=fixture();const result=await service.synthesize({id:'user-one'},input);
 assert.equal(result.status,'succeeded');assert.deepEqual(calls.find(c=>c[0]==='invoke')[1],{model:'speech-test',voiceId:'upstream-voice',text:'Hello',speed:1});
});
for(const scenario of [{account:'wrong-account'},{category:'private',provider:'wrong-provider'}]) test(`rejects mismatched voice ownership before billing: ${JSON.stringify(scenario)}`,async()=>{
 const {service,calls}=fixture(scenario);await assert.rejects(service.synthesize({id:'user-one'},input),{code:'VOICE_ACCOUNT_MISMATCH'});assert.ok(!calls.some(c=>c[0]==='reserve'||c[0]==='invoke'));
});
test('rejects a different model before billing or provider lookup',async()=>{
 const {service,calls}=fixture();await assert.rejects(service.synthesize({id:'user-one'},{...input,modelId:'model-two'}),{code:'VOICE_ACCOUNT_MISMATCH'});assert.equal(calls.length,0);
});

test('missing upstream credentials cannot hide private voices from cleanup', async () => {
 const service = new PrivateVoiceService({ pool: { query: async sql => sql.includes('ai_private_voices') ? [[{ id: 'private-one', status: 'failed', provider_model_id: 'model-one' }]] : [[]] }, contexts: { models: async () => [{ id: 'model-one' }] } });
 service.syncSystemVoices = async () => { throw Error('unavailable') };
 const result = await service.list({ id: 'user-one', organizationId: 'org-one' });
 assert.equal(result.voices[0].id, 'private-one'); assert.equal(result.warnings[0].code, 'VOICE_CATALOG_UNAVAILABLE');
});
