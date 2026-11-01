import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { registerOrganizationRoutes } from './organizations.mjs'
import { setAuthDependencies } from '../middleware/auth.mjs'
test('HTTP retired delegation endpoints are absent and employee reads stay scoped to the session organization', async () => {
  const context={ organizationId:'own',organizationLevel:1,organizationStatus:'enabled',memberStatus:'enabled',dataScope:'self',capabilityKeys:['organizations.view'],capabilities:[] }
  setAuthDependencies({ getUserBySession:async()=>({ id:'staff',organizationContext:context }),getEffectivePermissionKeys:async()=>['organizations.view'],permissionByKey:()=>null })
  const app=express();app.use(express.json())
  registerOrganizationRoutes(app,{ repository:{ findOrganizationById:async id=>({ id }),listOrganizationCapabilities:async()=>[{ key:'payments.manage',enabled:true }] } })
  app.use((err,_req,res,_next)=>res.status(err.statusCode||500).json({ error:err.message }))
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`
  try {
    for(const path of ['/api/organizations/children','/api/organizations/children/child','/api/organizations/children/child/reset-password']) {
      for(const method of ['GET','POST','PATCH','DELETE']) assert.equal((await fetch(base+path,{ method })).status,404)
    }
    assert.equal((await fetch(base+'/api/organizations/own/capabilities')).status,200)
    assert.equal((await fetch(base+'/api/organizations/other/capabilities')).status,403)
    assert.equal((await fetch(base+'/api/organizations/context')).status,200)
  } finally { server.closeAllConnections();await new Promise(r=>server.close(r)) }
})
