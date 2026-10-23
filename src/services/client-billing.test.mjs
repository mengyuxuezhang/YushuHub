import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyClientUsageDebit,
  assertClientModelRequestAllowed,
  getClientCreditState,
} from './client-billing.mjs'

test('client credit state always uses personal billing', async () => {
  assert.deepEqual(await getClientCreditState({ id: 'user-1', creditBalance: 12 }), {
    billingMode: 'personal',
    creditBalance: 12,
    unlimited: false,
  })
})

test('personal account requires a positive credit balance', async () => {
  await assert.rejects(
    () => assertClientModelRequestAllowed({ id: 'user-1', creditBalance: 0 }),
    (error) => error.statusCode === 402 && error.code === 'ADMIN_CREDITS_EXHAUSTED' && error.message === '积分余额不足，请充值后重试',
  )
  assert.equal((await assertClientModelRequestAllowed({ id: 'user-1', creditBalance: 1 })).billingMode, 'personal')
})

test('zero-balance personal account may call a completely free pricing rule', async () => {
  const state = await assertClientModelRequestAllowed(
    { id: 'user-free', creditBalance: 0 },
    { billingType: 'per_request', pointsPerRequest: 0 },
  )
  assert.equal(state.creditBalance, 0)
})

test('usage locks and deducts the personal balance', async () => {
  const queries = []
  const connection = {
    async query(sql, params) {
      queries.push({ sql, params })
      if (sql.startsWith('SELECT credit_balance')) return [[{ credit_balance: 10 }], []]
      return [{ affectedRows: 1 }, []]
    },
  }
  assert.equal(await applyClientUsageDebit(connection, 'user-1', { points: 3 }), null)
  assert.equal(queries.some(({ sql, params }) => sql.startsWith('UPDATE ai_end_users SET credit_balance') && params[0] === 3), true)
})

test('zero-price usage records may settle against a zero balance without an update', async () => {
  const queries = []
  const connection = {
    async query(sql) {
      queries.push(sql)
      if (sql.startsWith('SELECT credit_balance')) return [[{ credit_balance: 0 }], []]
      return [{ affectedRows: 1 }, []]
    },
  }
  await applyClientUsageDebit(connection, 'user-free', { points: 0 })
  assert.equal(queries.some((sql) => sql.startsWith('UPDATE ai_end_users SET credit_balance')), false)
})

test('final usage settles its full charge when it exceeds the remaining balance', async () => {
  const queries = []
  const connection = {
    async query(sql, params) {
      queries.push({ sql, params })
      if (sql.startsWith('SELECT credit_balance')) return [[{ credit_balance: 1 }], []]
      return [{ affectedRows: 1 }, []]
    },
  }
  await applyClientUsageDebit(connection, 'user-1', { points: 2 })
  assert.equal(queries.some(({ sql, params }) => sql.startsWith('UPDATE ai_end_users SET credit_balance') && params[0] === 2), true)
})

test('a non-positive balance after final settlement is blocked on the next paid request', async () => {
  await assert.rejects(
    () => assertClientModelRequestAllowed({ id: 'user-1', creditBalance: -1 }),
    (error) => error.statusCode === 402 && error.code === 'ADMIN_CREDITS_EXHAUSTED' && error.message === '积分余额不足，请充值后重试',
  )
})
