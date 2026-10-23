import assert from 'node:assert/strict'
import test from 'node:test'

import { flattenPermissionCatalog } from './permission-catalog.mjs'
import { LOCAL_PERMISSION_CATALOG } from '../config/constants.mjs'

test('flattens every permission while retaining its Chinese group', () => {
  assert.deepEqual(flattenPermissionCatalog([
    { group: '企业业务', permissions: [{ key: 'enterprise.manage', name: '企业管理' }] },
    { group: '个人业务', permissions: [{ key: 'users.manage', name: '用户管理' }, { key: 'credits.manage', name: '积分管理' }] },
  ]), [
    { key: 'enterprise.manage', name: '企业管理', group: '企业业务' },
    { key: 'users.manage', name: '用户管理', group: '个人业务' },
    { key: 'credits.manage', name: '积分管理', group: '个人业务' },
  ])
})

test('ignores malformed permission groups instead of creating undefined checkbox values', () => {
  assert.deepEqual(flattenPermissionCatalog([{ group: '空分组' }, null]), [])
})

test('keeps deprecated compatibility permissions out of the management UI', () => {
  assert.deepEqual(flattenPermissionCatalog([{
    group: '企业业务',
    permissions: [
      { key: 'enterprise_experts.manage', name: '企业专家管理', deprecated: true },
      { key: 'enterprise_members.manage', name: '企业成员管理' },
    ],
  }]), [{ key: 'enterprise_members.manage', name: '企业成员管理', group: '企业业务' }])
})

test('model permissions mirror the simplified management navigation', () => {
  const modelPermissions = flattenPermissionCatalog(LOCAL_PERMISSION_CATALOG)
    .filter((item) => item.group === '模型服务')
  assert.deepEqual(modelPermissions.map((item) => [item.key, item.name]), [
    ['model_providers.manage', '服务商管理'],
    ['model_keys.manage', 'Key 池管理'],
    ['provider_models.manage', '模型管理'],
    ['pricing_rules.manage', '计费中心'],
  ])
  assert.equal(modelPermissions.some((item) => /上游账号|任务能力/.test(item.name)), false)
})
