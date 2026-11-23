import assert from 'node:assert/strict'
import test from 'node:test'

import { preserveConfiguredSecret, resolveBuildCenterSettingsUpdate, sanitizePublicPlatformSettings, withEffectiveBuildCenterSettings } from './platform-secrets.mjs'

test('blank masked secret preserves the configured value', () => {
  assert.equal(preserveConfiguredSecret('', 'secret-value', true), 'secret-value')
  assert.equal(preserveConfiguredSecret(undefined, 'secret-value', true), 'secret-value')
})

test('submitted secret replaces the configured value', () => {
  assert.equal(preserveConfiguredSecret(' replacement ', 'secret-value', true), 'replacement')
})

test('disabling the dependent configuration clears the secret', () => {
  assert.equal(preserveConfiguredSecret('', 'secret-value', false), '')
})

test('public platform settings expose branding only', () => {
  assert.deepEqual(sanitizePublicPlatformSettings({
    systemName: 'OKPA',
    primaryColor: '#123456',
    loginContent: { panelTitle: '登录' },
    smtpHost: 'smtp.example.com',
    smtpPassPreview: 'secret',
    modelGatewayBaseUrl: 'https://private.example.com',
    buildCenterTokenPreview: 'token',
  }), {
    systemName: 'OKPA',
    primaryColor: '#123456',
    loginContent: { panelTitle: '登录' },
  })
})

test('effective build center status uses environment fallback without replacing editable database fields', () => {
  const result = withEffectiveBuildCenterSettings({ buildCenterUrl: '', buildCenterSupplierId: '', buildCenterToken: '' }, {
    url: 'https://center.okpa.cn', supplierId: 'supplier-a', token: 'secret-token',
  })

  assert.equal(result.buildCenterConfigured, true)
  assert.equal(result.buildCenterConfigSource, 'environment')
  assert.equal(result.effectiveBuildCenterUrl, 'https://center.okpa.cn')
  assert.equal(result.effectiveBuildCenterSupplierId, 'supplier-a')
  assert.equal(result.buildCenterTokenConfigured, true)
  assert.equal(result.buildCenterUrl, '')
  assert.equal(result.buildCenterSupplierId, '')
  assert.equal(result.buildCenterToken, '')
})

test('effective build center status identifies mixed and incomplete configurations', () => {
  const mixed = withEffectiveBuildCenterSettings({ buildCenterUrl: 'https://custom.example.com' }, {
    supplierId: 'supplier-a', token: 'secret-token',
  })
  assert.equal(mixed.buildCenterConfigured, true)
  assert.equal(mixed.buildCenterConfigSource, 'mixed')

  const incomplete = withEffectiveBuildCenterSettings({}, { url: 'https://center.okpa.cn', supplierId: 'supplier-a' })
  assert.equal(incomplete.buildCenterConfigured, false)
  assert.equal(incomplete.buildCenterConfigSource, 'none')
})

const legacyCenter = ({ url, supplierId, token }) => ({ url, supplierId, token, enabled: Boolean(url && supplierId && token) })

test('saving storage preserves an unchanged build center with missing legacy credentials', () => {
  const existing = { buildCenterUrl: 'https://center.example.com', buildCenterSupplierId: '', buildCenterToken: '' }
  const input = { buildCenterUrl: existing.buildCenterUrl, buildCenterToken: '', artifactStorageMode: 'oss' }
  assert.deepEqual(resolveBuildCenterSettingsUpdate(input, existing, {}, legacyCenter), {
    url: existing.buildCenterUrl, supplierId: '', token: '',
  })
})

test('editing the center can use environment credentials without copying them into database settings', () => {
  const existing = { buildCenterUrl: '', buildCenterSupplierId: '', buildCenterToken: '' }
  const environment = { supplierId: 'worker-a', token: 'fixture-token' }
  assert.deepEqual(resolveBuildCenterSettingsUpdate({ buildCenterUrl: 'https://center.example.com/' }, existing, environment, legacyCenter), {
    url: 'https://center.example.com', supplierId: '', token: '',
  })
  assert.throws(() => resolveBuildCenterSettingsUpdate({ buildCenterUrl: 'https://center.example.com' }, existing, {}, legacyCenter), /供应商 ID 和 Token/)
})
