import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelKeyUsageMarker } from './model-key-usage.mjs'
test('sole-Key recency is coalesced, while rotating Keys retain every selection update', async () => {
  let writes=0,time=0
  const mark=createModelKeyUsageMarker({now:()=>time}),db={async query(){writes++}}
  await Promise.all(Array.from({length:600},()=>mark(db,'key')))
  assert.equal(writes,1)
  time=1000;await mark(db,'key');assert.equal(writes,2)
  await Promise.all(Array.from({length:10},()=>mark(db,'key',true)))
  assert.equal(writes,12)
})
test('a failed recency update can be retried rather than cached as success',async()=>{
  let writes=0;const db={async query(){if(++writes===1)throw Error('temporary')}}
  const mark=createModelKeyUsageMarker()
  await assert.rejects(mark(db,'key'));await mark(db,'key');assert.equal(writes,2)
})
