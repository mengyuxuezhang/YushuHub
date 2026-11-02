import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { registerOrganizationRoutes } from './organizations.mjs'
import { setAuthDependencies } from '../middleware/auth.mjs'
test('HTTP retired delegation endpoints are absent and employee reads stay scoped to the session organization', async () => {
  const context={ organizationId:'own',organizationLevel:1,organizationStatus:'enabled',memberStatus:'enabled',dataScope:'self',capabilityKeys:['organizations.view'],capabilities:[{key:'*',enabled:true}] }
  setAuthDependencies({ getUserBySession:async()=>({ id:'staff',organizationContext:context }),getEffectivePermissionKeys:async()=>['organizations.view'],permissionByKey:()=>null })
  const app=express();app.use(express.json())
  registerOrganizationRoutes(app,{ permissionByKey:key=>key==='payments.manage'?{name:'支付管理'}:null, repository:{ findOrganizationById:async id=>({ id }),listOrganizationCapabilities:async()=>[{ key:'*',enabled:true },{ key:'payments.manage',enabled:true }] } })
  app.use((err,_req,res,_next)=>res.status(err.statusCode||500).json({ error:err.message }))
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`
  try {
    for(const path of ['/api/organizations/children','/api/organizations/children/child','/api/organizations/children/child/reset-password']) {
      for(const method of ['GET','POST','PATCH','DELETE']) assert.equal((await fetch(base+path,{ method })).status,404)
    }
    const own=await fetch(base+'/api/organizations/own/capabilities');assert.equal(own.status,200)
    assert.deepEqual((await own.json()).data.map(c=>c.name),['全部权限','支付管理'])
    assert.equal((await fetch(base+'/api/organizations/other/capabilities')).status,403)
    const current=await fetch(base+'/api/organizations/context');assert.equal(current.status,200)
    assert.equal((await current.json()).data.capabilities[0].name,'全部权限')
  } finally { server.closeAllConnections();await new Promise(r=>server.close(r)) }
})
