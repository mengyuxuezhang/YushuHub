import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { setAuthDependencies } from '../middleware/auth.mjs'
import { registerUserUsageReportRoutes } from './user-usage-report.mjs'

test('all report endpoints require login and live view permission; export also requires export permission', async () => {
  let actor=null, keys=[]
  const received=[]
  setAuthDependencies({getUserBySession:async()=>actor,getEffectivePermissionKeys:async()=>keys})
  const service=Object.fromEntries(['overview','users','options','detail','export'].map(name=>[name,async(user)=>{received.push(user);return name==='export'?'csv':{}}]))
  const app=express(); registerUserUsageReportRoutes(app,{service})
  const server=app.listen(0,'127.0.0.1')
  await new Promise(resolve=>server.once('listening',resolve))
  const url=`http://127.0.0.1:${server.address().port}/api/reports/user-usage`
  try {
    for (const path of ['/overview','/users','/options','/users/u','/export']) assert.equal((await fetch(url+path)).status,401)
    actor={id:'operator',organizationContext:{organizationId:'a'}}
    for (const path of ['/overview','/users','/options','/users/u','/export']) assert.equal((await fetch(url+path)).status,403)
    keys=['user_usage.view']
    assert.equal((await fetch(url+'/users/u')).status,200)
    assert.equal(received.at(-1),actor)
    assert.equal((await fetch(url+'/export')).status,403)
    keys.push('user_usage.export')
    assert.match((await fetch(url+'/export')).headers.get('content-type'),/text\/csv/)
    keys=[]
    assert.equal((await fetch(url+'/users/u')).status,403)
    assert.equal((await fetch(url+'/export')).status,403)
  } finally { await new Promise(resolve=>server.close(resolve)) }
})
