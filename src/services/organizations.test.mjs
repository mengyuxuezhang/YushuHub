import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveEffectiveCapabilities, buildOrganizationContext, assertCanManageOrganization } from './organizations.mjs'
test('effective staff capabilities intersect local grants and center package, excluding retired delegation', () => {
  const own = ['projects.manage','payments.manage','organizations.children.manage'].map(key => ({ key, enabled: true }))
  assert.deepEqual(resolveEffectiveCapabilities(own, [{ key:'projects.manage',enabled:true }]).map(c => c.key), ['projects.manage'])
  assert.deepEqual(resolveEffectiveCapabilities([{ key:'*',enabled:true }], own).map(c => c.key), ['projects.manage','payments.manage'])
})
test('staff stay in their own deployment scope and cannot inherit platform scope', async () => {
  const repository = { findOrganizationContextForUser: async () => ({ organization: { id:'own',agentLevel:1,status:'enabled',legacyOwnerUserId:'owner' }, member: { status:'enabled',dataScope:'subtree',isOwner:false,roleTemplateId:'finance' } }), listOrganizationCapabilities: async () => [{ key:'payments.manage', enabled:true }] }
  const context = await buildOrganizationContext({ id:'staff' }, repository)
  assert.equal(context.dataScope,'self'); assert.equal(context.legacyOwnerUserId,'owner'); assert.deepEqual(context.accessibleOrganizationIds,['own'])
  assert.throws(() => assertCanManageOrganization(context,{ id:'other' }), /无权/)
  assert.doesNotThrow(() => assertCanManageOrganization(context,{ id:'own' }))
})
test('unexpected second-level records block activation of an organization context', async () => {
  const repository = { findOrganizationContextForUser: async () => ({ organization: { agentLevel:2 }, member:{} }) }
  await assert.rejects(buildOrganizationContext({ id:'u' }, repository), { code:'SECOND_LEVEL_DATA_FOUND' })
})
