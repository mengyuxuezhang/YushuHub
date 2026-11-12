import test from 'node:test'
import assert from 'node:assert/strict'
import { membershipTransaction } from './transaction-retry.mjs'
import { databasePoolLimit } from './pool.mjs'

test('transaction retries release connections, roll back first, and do not leak isolation',async()=>{
  const calls=[];let attempt=0
  const db={async getConnection(){return {async query(q){calls.push(q)},async beginTransaction(){calls.push('begin')},async commit(){calls.push('commit')},async rollback(){calls.push('rollback')},release(){calls.push('release')}}}}
  const result=await membershipTransaction(db,async()=>{if(attempt++===0)throw Object.assign(Error('deadlock'),{code:'ER_LOCK_DEADLOCK'});return 'ok'},{sleep:async()=>{calls.push('backoff')}})
  assert.equal(result,'ok');assert.deepEqual(calls,['SET TRANSACTION ISOLATION LEVEL READ COMMITTED','begin','rollback','release','backoff','SET TRANSACTION ISOLATION LEVEL READ COMMITTED','begin','commit','release'])
})
test('exhausted deadlocks become sanitized 503 and non-lock failures are never replayed',async()=>{
  let calls=0
  const db={async getConnection(){return {async query(){},async beginTransaction(){},async commit(){},async rollback(){},release(){}}}}
  await assert.rejects(membershipTransaction(db,async()=>{calls++;throw Object.assign(Error('raw sql'),{code:'ER_LOCK_DEADLOCK'})},{sleep:async()=>{}}),{statusCode:503,code:'DATABASE_BUSY',message:'服务繁忙，请稍后重试'})
  assert.equal(calls,3);calls=0
  await assert.rejects(membershipTransaction(db,async()=>{calls++;throw Error('unknown commit outcome')},{sleep:async()=>{}}),/unknown commit outcome/)
  assert.equal(calls,1)
})
test('database pool stays at ten by default with bounded opt-in tuning',()=>{
  assert.equal(databasePoolLimit(undefined),10);assert.equal(databasePoolLimit('30'),30)
  for(const v of ['0','600','NaN','2.5'])assert.equal(databasePoolLimit(v),10)
})
