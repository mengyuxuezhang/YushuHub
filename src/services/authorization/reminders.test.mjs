import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { memoryStateStore } from '../../repositories/authorization-state.mjs'
import { createReminderDispatcher } from './reminders.mjs'
test('webhook notifications retry durably, deduplicate acknowledged events, and reload the controlled target file', async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'license-notices-')),targetFile=path.join(directory,'target.json')
  let timestamp=1000,reject=true;const calls=[]
  const store=memoryStateStore({notices:{event:{id:'event-id',grantId:'fictional',days:1,expiresAt:'2035-01-01'}}})
  const dispatch=createReminderDispatcher({center:{reminders:async()=>{}},store,targetFile,now:()=>timestamp,fetchImpl:async(url,options)=>{calls.push({url:String(url),options});if(reject)throw Error('TEST offline');return new Response('{"code":0}')}})
  try {
    await fs.writeFile(targetFile,JSON.stringify({enabled:true,url:'https://first.example.test/hook'}));await dispatch();await dispatch();assert.equal(calls.length,1)
    await fs.writeFile(targetFile,JSON.stringify({enabled:true,url:'https://second.example.test/hook'}));timestamp+=300_001;reject=false;await dispatch();await dispatch()
    assert.equal(calls.length,2);assert.equal(calls[1].url,'https://second.example.test/hook');assert.equal(calls[1].options.redirect,'error');assert.equal(calls[1].options.headers['Idempotency-Key'],'event-id')
    assert.equal((await store.read()).notices.event.deliveredAt,timestamp)
  } finally { await fs.unlink(targetFile);await fs.rmdir(directory) }
})
