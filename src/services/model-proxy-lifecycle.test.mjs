import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createModelProxyLifecycle, isDownstreamAbortReason } from './model-proxy-lifecycle.mjs'

function createRequestPair() {
  const req = new EventEmitter()
  const res = new EventEmitter()
  res.writableEnded = false
  return { req, res }
}

test('aborts the upstream request when the downstream response closes early', () => {
  const { req, res } = createRequestPair()
  const lifecycle = createModelProxyLifecycle({ req, res, timeoutMs: 60000 })

  res.emit('close')

  assert.equal(lifecycle.signal.aborted, true)
  assert.equal(lifecycle.abortReason, 'downstream_closed')
  assert.equal(isDownstreamAbortReason(lifecycle.abortReason), true)
  lifecycle.cleanup()
})

test('does not abort after a normal completed response', () => {
  const { req, res } = createRequestPair()
  const lifecycle = createModelProxyLifecycle({ req, res, timeoutMs: 60000 })
  res.writableEnded = true

  res.emit('close')

  assert.equal(lifecycle.signal.aborted, false)
  lifecycle.cleanup()
})

test('clearing the header timeout keeps a streaming request alive', async () => {
  const { req, res } = createRequestPair()
  const lifecycle = createModelProxyLifecycle({ req, res, timeoutMs: 10 })
  lifecycle.clearHeaderTimeout()

  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(lifecycle.signal.aborted, false)
  lifecycle.cleanup()
})

test('aborts when the provider does not return headers before its timeout', async () => {
  const { req, res } = createRequestPair()
  const lifecycle = createModelProxyLifecycle({ req, res, timeoutMs: 10 })

  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(lifecycle.signal.aborted, true)
  assert.equal(lifecycle.abortReason, 'provider_headers_timeout')
  assert.equal(isDownstreamAbortReason(lifecycle.abortReason), false)
  lifecycle.cleanup()
})
