import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createModelCapacity, MODEL_CHAT_PATH } from './model-capacity.mjs'

function pair(length = '50', path = MODEL_CHAT_PATH, encoding = 'identity') {
  const req = Object.assign(new EventEmitter(), { method: 'POST', path, headers: { 'content-length': length, 'content-encoding': encoding } })
  const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, setHeader(k,v) {this.headers[k]=v}, status(s) {this.statusCode=s;return this}, json(v) {this.payload=v;return this} })
  return {req,res}
}
test('admission bounds requests and releases exactly once on close/finish/abort', () => {
  const limit=createModelCapacity({maxRequests:1,maxBytes:100})
  const a=pair(), b=pair();let entered=0
  limit.admit(a.req,a.res,()=>entered++)
  limit.admit(b.req,b.res,()=>entered++)
  assert.equal(entered,1);assert.equal(b.res.statusCode,429);assert.equal(b.res.headers['Retry-After'],'1')
  a.res.emit('close');a.res.emit('finish');a.req.emit('aborted')
  assert.deepEqual(limit.snapshot(),{active:0,bytes:0,users:0,providers:0})
  assert.equal(a.req.listenerCount('aborted'),0)
})
test('Express case-insensitive and trailing slash aliases cannot bypass the budget', () => {
  const c=createModelCapacity({maxBytes:10})
  const p=pair('50',MODEL_CHAT_PATH.toUpperCase()+'/')
  c.admit(p.req,p.res,()=>assert.fail('must reject'))
  assert.equal(p.res.statusCode,429)
})
test('unknown and compressed inputs reserve decompressed body allowance', () => {
  for(const p of [pair(undefined),pair('10',MODEL_CHAT_PATH,'gzip')]) {
    delete p.req.headers['content-length']
    const c=createModelCapacity({maxBytes:1024})
    c.admit(p.req,p.res,()=>assert.fail('must reserve full limit'))
    assert.equal(p.res.statusCode,429)
  }
})
test('user/provider budgets are separate and fully reclaimed without unbounded maps', () => {
  const c=createModelCapacity({perUser:1,perProvider:1})
  const u=c.acquireUser('u'),p=c.acquireProvider('p')
  assert.throws(()=>c.acquireUser('u'),{code:'MODEL_USER_CONCURRENCY_LIMIT'})
  assert.throws(()=>c.acquireProvider('p'),{code:'MODEL_PROVIDER_CONCURRENCY_LIMIT'})
  const other=c.acquireUser('other');other();u();u();p()
  assert.equal(c.snapshot().users,0);assert.equal(c.snapshot().providers,0)
})
