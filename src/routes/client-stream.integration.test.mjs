import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { registerClientApiRoutes } from './client-api.mjs'
import { setAuthDependencies } from '../middleware/auth.mjs'

const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const listen=server=>new Promise(r=>server.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${server.address().port}`)))
async function fixture(t) {
  const counts={deduct:0,success:0,failure:0,failedUsage:0,active:0}
  const provider=http.createServer(async(req,res)=>{
    for await(const _ of req) {}
    counts.active++
    res.on('close',()=>{counts.active--})
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.write('data: {"id":"synthetic","choices":[{"delta":{"content":"hello"}}]}\n\n')
    // Intentionally no more output: cancellation or idle timeout must stop this request.
  })
  const providerUrl=await listen(provider)
  setAuthDependencies({getEndUserByToken:async()=>({id:'stream-test',creditBalance:100,status:'enabled'})})
  const app=express();app.use(express.json())
  registerClientApiRoutes(app,{
    resolveModelProxyContext:async()=>({provider:{id:'local',name:'Synthetic',baseUrl:providerUrl},model:{modelId:'text',modelType:'text'},key:{id:'key',apiKey:'synthetic'},pricingRule:{}}),
    assertClientModelRequestAllowed:async()=>{},deductCreditsForLocalUsage:async()=>{counts.deduct++},
    recordModelKeySuccess:async()=>{counts.success++},recordModelKeyFailure:async()=>{counts.failure++},
    recordModelKeyUsageFailure:async()=>{counts.failedUsage++},
  })
  const admin=http.createServer(app),base=await listen(admin)
  t.after(async()=>{admin.closeAllConnections();provider.closeAllConnections();await Promise.all([new Promise(r=>admin.close(r)),new Promise(r=>provider.close(r))])})
  const request=signal=>fetch(base+'/api/client/model/v1/chat/completions',{method:'POST',signal,headers:{Authorization:'Bearer synthetic','content-type':'application/json'},body:JSON.stringify({model:'text',stream:true})})
  return {request,counts}
}
test('real HTTP disconnect cancels provider stream without deducting or penalizing the Key',async(t)=>{
  const {request,counts}=await fixture(t),controller=new AbortController()
  const response=await request(controller.signal),reader=response.body.getReader()
  assert.equal((await reader.read()).done,false);controller.abort()
  await reader.cancel().catch(()=>{})
  for(let i=0;i<60&&counts.active;i++)await sleep(10)
  assert.equal(counts.active,0);assert.equal(counts.failure,0);assert.equal(counts.deduct,0);assert.equal(counts.failedUsage,0)
})
test('real provider idle stream terminates without a success charge',async(t)=>{
  const previous=process.env.AI_MODEL_STREAM_IDLE_TIMEOUT_MS
  process.env.AI_MODEL_STREAM_IDLE_TIMEOUT_MS='80'
  t.after(()=>{if(previous===undefined)delete process.env.AI_MODEL_STREAM_IDLE_TIMEOUT_MS;else process.env.AI_MODEL_STREAM_IDLE_TIMEOUT_MS=previous})
  const {request,counts}=await fixture(t)
  const response=await request(),body=await response.text()
  assert(!body.includes('[DONE]'))
  for(let i=0;i<60&&counts.active;i++)await sleep(10)
  assert.equal(counts.active,0);assert.equal(counts.deduct,0);assert.equal(counts.success,0)
  assert.equal(counts.failure,1);assert.equal(counts.failedUsage,1)
})
