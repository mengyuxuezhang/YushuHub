import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { forwardModelStream, waitForModelDrain } from './model-proxy-stream.mjs'

function destination(write=()=>true) {
  const r=new EventEmitter();r.destroyed=false;r.writableEnded=false;r.write=write;return r
}
function lifecycle(){return {signal:new AbortController().signal,touch(){}}}
test('SSE bytes and signatures pass unchanged with split UTF8/frames and final usage',async()=>{
  const text='data: {"id":"proof-id","choices":[{"delta":{"content":"你好"}}],"okpa_proof":"fixture"}\r\n\r\ndata: {"usage":{"total_tokens":3}}'
  const bytes=Buffer.from(text),out=[]
  const body=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.subarray(i,i+7));c.close()}})
  const result=await forwardModelStream({body,headers:new Headers()},destination(b=>{out.push(b);return true}),lifecycle())
  assert.equal(Buffer.concat(out).toString(),text);assert.equal(result.requestId,'proof-id');assert.equal(result.usage.total_tokens,3)
})
test('backpressure stops upstream reads until drain and removes listeners',async()=>{
  let reads=0;const out=destination(()=>false)
  const reader={async read(){return ++reads===1?{value:Buffer.from('data: {}\n')}:{done:true}},async cancel(){},releaseLock(){}}
  const pending=forwardModelStream({body:{getReader:()=>reader},headers:new Headers()},out,lifecycle())
  await new Promise(r=>setImmediate(r));assert.equal(reads,1)
  out.emit('drain');await pending;assert.equal(reads,2)
  for(const name of ['close','drain','error'])assert.equal(out.listenerCount(name),0)
})
test('close or abort during drain rejects promptly and cancels upstream reader',async()=>{
  for(const abort of [false,true]){
    const out=destination(()=>false),controller=new AbortController();let cancelled=0
    const reader={async read(){return {value:Buffer.from('data: {}\n')}},async cancel(){cancelled++},releaseLock(){}}
    const p=forwardModelStream({body:{getReader:()=>reader},headers:new Headers()},out,{signal:controller.signal,touch(){}})
    await new Promise(r=>setImmediate(r))
    if(abort)controller.abort(Error('timeout'));else out.emit('close')
    await assert.rejects(p);assert.equal(cancelled,1);assert.equal(out.listenerCount('drain'),0)
  }
})
test('oversized metadata lines are passed through without retaining an unbounded parser buffer',async()=>{
  const content='data: '+ 'x'.repeat(10000)+'\ndata: {"usage":{"total_tokens":4}}\n'
  const out=[]
  const response=new Response(content,{headers:{'content-type':'text/event-stream'}})
  const result=await forwardModelStream(response,destination(b=>{out.push(b);return true}),lifecycle(),1024)
  assert.equal(Buffer.concat(out).toString(),content);assert.equal(result.usage.total_tokens,4)
})
test('an already aborted drain never leaves handlers behind',async()=>{
  const controller=new AbortController();controller.abort()
  const out=destination();await assert.rejects(waitForModelDrain(out,controller.signal));assert.equal(out.listenerCount('drain'),0)
})

test('a deadline spent waiting on a slow downstream is not classified as provider failure',async()=>{
  const controller=new AbortController(),out=destination(()=>false)
  const reader={async read(){return {value:Buffer.from('data: {}\n')}},async cancel(){},releaseLock(){}}
  const life={signal:controller.signal,touch(){},abortReason:'model_stream_idle_timeout'}
  const pending=forwardModelStream({body:{getReader:()=>reader},headers:new Headers()},out,life)
  await new Promise(r=>setImmediate(r));controller.abort(Error('deadline'))
  await assert.rejects(pending,{code:'MODEL_DOWNSTREAM_STALLED'})
  assert.equal(out.listenerCount('drain'),0)
})
