import test from 'node:test'
import assert from 'node:assert/strict'
import { createResourceCoordinator, emptyResourceIntents, buildResourceIdentity } from './resource-runtime.mjs'
import { memoryStateStore } from '../../repositories/authorization-state.mjs'

function fixture() {
  const store = memoryStateStore(emptyResourceIntents()), rows = new Map(), reservations = new Map()
  let failConfirm = false, writes = 0
  const remote = async (action, kind, id) => {
    const key = `${kind}:${id}`
    if (action === 'reserve') { if (!reservations.has(key)) reservations.set(key, { reservationId: key, confirmed: false }); return reservations.get(key) }
    if (action === 'status') return reservations.get(key)
    if (action === 'confirm') { if (failConfirm) throw Error('TEST disconnected'); reservations.get(key).confirmed = true; return reservations.get(key) }
    reservations.delete(key); return { released: true }
  }
  const create = () => createResourceCoordinator({ store, remote, resolveOrganization: async id => ({ id }), exists: async (kind, id) => rows.has(`${kind}:${id}`), readBuild: async id => rows.get(`builds:${id}`) })
  return { create, rows, reservations, store, failConfirm: value => { failConfirm = value }, write: (kind,id) => async () => { writes++; const row = { id }; rows.set(`${kind}:${id}`,row); return row }, get writes() { return writes } }
}
test('a restarted resource coordinator confirms committed builds without repeating business writes or admissions', async () => {
  const f=fixture(); f.failConfirm(true)
  await f.create().build('build-one','org','same-request',f.write('builds','build-one'))
  assert.equal((await f.store.read()).intents['builds:build-one'].state,'confirming')
  f.failConfirm(false); const restarted=f.create(); await restarted.flush()
  assert.equal(f.reservations.get('builds:build-one').confirmed,true)
  await restarted.build('build-one','org','same-request',f.write('builds','build-one'))
  assert.equal(f.writes,1); assert.equal(f.reservations.size,1)
  await assert.rejects(restarted.build('build-one','org','changed-request',f.write('builds','build-one')),{code:'RESOURCE_OWNER_CONFLICT'})
})
test('unaccepted writes release their reservation while accepted build attempts cannot be recreated', async () => {
  const f=fixture(), runtime=f.create()
  await assert.rejects(runtime.build('failed','org','request',async()=>{throw Error('TEST rejected before write')}))
  assert.equal(f.reservations.size,1); await runtime.flush(); assert.equal(f.reservations.size,0)
  await assert.rejects(runtime.build('failed','org','request',f.write('builds','failed')),{code:'RESOURCE_CANCELLED'})
})
test('project deletion commits locally before releasing remote capacity and cannot cross organization', async () => {
  const f=fixture(),runtime=f.create(); await runtime.project('project','org',f.write('projects','project'))
  await assert.rejects(runtime.removeProject('project','other',async()=>{}),{code:'RESOURCE_OWNER_CONFLICT'})
  await runtime.removeProject('project','org',async()=>{ assert(f.reservations.has('projects:project')); f.rows.delete('projects:project'); return {deleted:true} })
  assert.equal(f.reservations.size,0)
})
test('build idempotency keys include the trusted organization and bind project/version/actor', () => {
  const a=buildResourceIdentity({id:'project',organizationId:'own'},'staff','v1','request')
  assert.equal(a.id,buildResourceIdentity({id:'project',organizationId:'own'},'staff','v1','request').id)
  assert.notEqual(a.id,buildResourceIdentity({id:'project',organizationId:'other'},'staff','v1','request').id)
  assert.notEqual(a.fingerprint,buildResourceIdentity({id:'other-project',organizationId:'own'},'staff','v1','request').fingerprint)
})
