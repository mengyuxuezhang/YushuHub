import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalizePublicUploadUrl,
  isLoopbackAddress,
  resolvePublicUrlsForRequest,
} from './public-url.mjs'

const configured = {
  adminBaseUrl: 'http://ai.cnjiading.com',
  updateBaseUrl: 'http://ai.cnjiading.com/updates/ai',
}

function request(headers = {}, remoteAddress = '127.0.0.1') {
  return { headers, socket: { remoteAddress } }
}

test('recognizes IPv4 and IPv6 loopback addresses', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('10.0.0.2'), false)
})

test('upgrades stale same-host public URLs for a trusted HTTPS reverse proxy', () => {
  const result = resolvePublicUrlsForRequest(request({
    host: 'ai.cnjiading.com',
    'x-forwarded-proto': 'https',
  }), configured)

  assert.equal(result.adminBaseUrl, 'https://ai.cnjiading.com')
  assert.equal(result.updateBaseUrl, 'https://ai.cnjiading.com/updates/ai')
})

test('uses the first standard forwarded value and forwarded host', () => {
  const result = resolvePublicUrlsForRequest(request({
    'x-forwarded-host': 'ai.cnjiading.com, internal.invalid',
    'x-forwarded-proto': 'https, http',
  }), configured)

  assert.equal(result.adminBaseUrl, 'https://ai.cnjiading.com')
})

test('prefers the proxy-controlled Host header over X-Forwarded-Host', () => {
  const result = resolvePublicUrlsForRequest(request({
    host: 'internal.example',
    'x-forwarded-host': 'ai.cnjiading.com',
    'x-forwarded-proto': 'https',
  }), configured)

  assert.deepEqual(result, configured)
})

test('ignores spoofed forwarded headers from a non-loopback peer', () => {
  const result = resolvePublicUrlsForRequest(request({
    host: 'ai.cnjiading.com',
    'x-forwarded-proto': 'https',
  }, '203.0.113.8'), configured)

  assert.deepEqual(result, configured)
})

test('accepts a same-host HTTPS browser origin behind a non-loopback container proxy', () => {
  const result = resolvePublicUrlsForRequest(request({
    host: 'ai.cnjiading.com',
    origin: 'https://ai.cnjiading.com',
  }, '172.18.0.4'), configured)

  assert.equal(result.adminBaseUrl, 'https://ai.cnjiading.com')
  assert.equal(result.updateBaseUrl, 'https://ai.cnjiading.com/updates/ai')
})

test('accepts a direct TLS connection without forwarded headers', () => {
  const req = request({ host: 'ai.cnjiading.com' }, '203.0.113.8')
  req.socket.encrypted = true
  const result = resolvePublicUrlsForRequest(req, configured)

  assert.equal(result.adminBaseUrl, 'https://ai.cnjiading.com')
})

test('does not trust an HTTPS browser origin for another hostname', () => {
  const result = resolvePublicUrlsForRequest(request({
    host: 'ai.cnjiading.com',
    origin: 'https://attacker.example',
  }, '172.18.0.4'), configured)

  assert.deepEqual(result, configured)
})

test('does not upgrade when the request host differs from configuration', () => {
  const result = resolvePublicUrlsForRequest(request({
    host: 'attacker.example',
    'x-forwarded-proto': 'https',
  }), configured)

  assert.deepEqual(result, configured)
})

test('does not infer HTTPS support for a different update hostname', () => {
  const result = resolvePublicUrlsForRequest(request({
    host: 'ai.cnjiading.com',
    'x-forwarded-proto': 'https',
  }), {
    ...configured,
    updateBaseUrl: 'http://downloads.example/updates/ai',
  })

  assert.equal(result.adminBaseUrl, 'https://ai.cnjiading.com')
  assert.equal(result.updateBaseUrl, 'http://downloads.example/updates/ai')
})

test('upgrades a stale same-host update URL when the Admin URL is already HTTPS', () => {
  const result = resolvePublicUrlsForRequest(request({
    host: 'ai.cnjiading.com',
    'x-forwarded-proto': 'https',
  }), {
    adminBaseUrl: 'https://ai.cnjiading.com',
    updateBaseUrl: 'http://ai.cnjiading.com/updates/ai',
  })

  assert.equal(result.adminBaseUrl, 'https://ai.cnjiading.com')
  assert.equal(result.updateBaseUrl, 'https://ai.cnjiading.com/updates/ai')
})

test('canonicalizes relative and historical same-host upload URLs to HTTPS', () => {
  assert.equal(
    canonicalizePublicUploadUrl('/uploads/user/logo.png', 'https://ai.cnjiading.com'),
    'https://ai.cnjiading.com/uploads/user/logo.png',
  )
  assert.equal(
    canonicalizePublicUploadUrl('http://ai.cnjiading.com/uploads/user/logo.png?rev=1', 'https://ai.cnjiading.com'),
    'https://ai.cnjiading.com/uploads/user/logo.png?rev=1',
  )
})

test('does not rewrite external assets or downgrade existing HTTPS uploads', () => {
  assert.equal(
    canonicalizePublicUploadUrl('http://cdn.example/uploads/logo.png', 'https://ai.cnjiading.com'),
    'http://cdn.example/uploads/logo.png',
  )
  assert.equal(
    canonicalizePublicUploadUrl('https://ai.cnjiading.com/uploads/logo.png', 'http://ai.cnjiading.com'),
    'https://ai.cnjiading.com/uploads/logo.png',
  )
})
