import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeSecureBuildCenterUrl } from './build-center-url.mjs'

test('accepts HTTPS and HTTP build centers on public, private and loopback hosts', () => {
  assert.equal(normalizeSecureBuildCenterUrl('https://build.example.com/api/'), 'https://build.example.com/api')
  assert.equal(normalizeSecureBuildCenterUrl('http://build.example.com/api/'), 'http://build.example.com/api')
  assert.equal(normalizeSecureBuildCenterUrl('http://8.147.134.68/ai-admin/'), 'http://8.147.134.68/ai-admin')
  assert.equal(normalizeSecureBuildCenterUrl('http://10.0.0.8:7077/api'), 'http://10.0.0.8:7077/api')
  assert.equal(normalizeSecureBuildCenterUrl('http://127.0.0.1:7467'), 'http://127.0.0.1:7467')
  assert.equal(normalizeSecureBuildCenterUrl('http://localhost:7467/'), 'http://localhost:7467')
})

test('rejects unsupported protocols, SSH endpoints, embedded credentials and URL smuggling fields', () => {
  for (const value of [
    'ssh://build.example.com',
    'ftp://build.example.com',
    'https://user:secret@build.example.com',
    'https://build.example.com:22',
    'https://build.example.com/?worker=direct',
    'https://build.example.com/#secret',
  ]) {
    assert.throws(() => normalizeSecureBuildCenterUrl(value))
  }
})

test('does not require the legacy HTTP origin allowlist', () => {
  assert.equal(
    normalizeSecureBuildCenterUrl('http://build.example.com/ai-admin', {
      insecureHttpOrigins: 'invalid legacy value',
    }),
    'http://build.example.com/ai-admin',
  )
})
