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

test('stream idle deadline is refreshed by progress and cleanup releases all handlers', async()=>{
  const {req,res}=createRequestPair()
  const life=createModelProxyLifecycle({req,res,timeoutMs:1000,idleTimeoutMs:40})
  life.clearHeaderTimeout();await new Promise(r=>setTimeout(r,20));life.touch()
  await new Promise(r=>setTimeout(r,25));assert.equal(life.signal.aborted,false)
  await new Promise(r=>setTimeout(r,30));assert.equal(life.abortReason,'model_stream_idle_timeout')
  life.cleanup();assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0)
})
test('maximum duration cannot be prolonged indefinitely by active output',async()=>{
  const {req,res}=createRequestPair()
  const life=createModelProxyLifecycle({req,res,timeoutMs:1000,idleTimeoutMs:1000,maxDurationMs:20})
  life.clearHeaderTimeout();life.touch()
  await new Promise(r=>setTimeout(r,40));assert.equal(life.abortReason,'model_duration_timeout');life.cleanup()
})
