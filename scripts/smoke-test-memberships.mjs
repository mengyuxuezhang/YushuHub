import assert from 'node:assert/strict'
import { ensureAccountFreeMembership, ensureFreeMembershipFallback, freeMembershipCardId, grantMembershipBenefits } from '../src/services/memberships.mjs'

assert.equal(freeMembershipCardId('admin'), 'free')
assert.equal(freeMembershipCardId('agent-a'), freeMembershipCardId('agent-a'))
assert.notEqual(freeMembershipCardId('agent-a'), freeMembershipCardId('agent-b'))
console.log('PASS: free membership card IDs are stable and isolated by account')

let ensuredFreePackages = null
const freeCardDatabase = {
  async query(sql, params = []) {
      if (sql.includes('FROM ai_payment_refunds')) return [[], []]
    if (sql.startsWith('SELECT packages_json FROM ai_membership_cards')) {
      return [[{ packages_json: JSON.stringify([
        { name: '基础会员', durationDays: 30, bonusPoints: 20, pointsDurationDays: 90, price: 0 },
        { name: '不应保留的第二套餐', durationDays: 365, bonusPoints: 999 },
      ]) }], []]
    }
    if (sql.startsWith('INSERT INTO ai_membership_cards')) {
      ensuredFreePackages = JSON.parse(params[2])
      return [{ affectedRows: 1 }, []]
    }
    throw new Error(`Unexpected free-card SQL: ${sql}`)
  },
}
await ensureAccountFreeMembership('agent-a', freeCardDatabase)
assert.equal(ensuredFreePackages.length, 1)
assert.equal(ensuredFreePackages[0].durationDays, 0)
assert.equal(ensuredFreePackages[0].bonusPoints, 20)
assert.equal(ensuredFreePackages[0].pointsDurationDays, 90)
console.log('PASS: built-in free membership is normalized to one permanent entitlement without losing configured signup points')

function fakeDatabase({ balance = 0, activeMembershipId = '' } = {}) {
  const state = { balance, activeMembershipId, queries: [], committed: false, rolledBack: false }
  const conn = {
    async beginTransaction() {},
    async commit() { state.committed = true },
    async rollback() { state.rolledBack = true },
    release() {},
    async query(sql, params = []) {
      if (sql.includes('FROM ai_payment_refunds')) return [[], []]
      state.queries.push({ sql, params })
      if (sql.includes('SELECT id, credit_balance FROM ai_end_users')) return [[{ id: params[0], credit_balance: state.balance }], []]
      if (sql.includes('SELECT id FROM ai_end_user_memberships')) {
        return [state.activeMembershipId ? [{ id: state.activeMembershipId }] : [], []]
      }
      if (sql.startsWith('INSERT INTO ai_end_user_memberships')) {
        state.activeMembershipId = params[0]
        return [{ affectedRows: 1 }, []]
      }
      if (sql.startsWith('UPDATE ai_end_users SET credit_balance = credit_balance +')) {
        state.balance += Number(params[0] || 0)
        return [{ affectedRows: 1 }, []]
      }
      if (sql.includes('SELECT credit_balance FROM ai_end_users')) return [[{ credit_balance: state.balance }], []]
      return [{ affectedRows: 1 }, []]
    },
  }
  return { state, database: { async getConnection() { return conn } } }
}

const registration = fakeDatabase()
const granted = await grantMembershipBenefits({
  userId: 'end-user-1',
  card: { id: 'free-agent-a', name: '免费会员' },
  membershipPackage: { name: '永久免费', durationDays: 0, bonusPoints: 20, pointsDurationDays: 0 },
  source: 'register',
  createdBy: 'agent-a',
  keepExisting: true,
  database: registration.database,
})
assert.equal(granted.bonusPoints, 20)
assert.equal(granted.balanceAfter, 20)
assert.equal(registration.state.committed, true)
assert.equal(registration.state.rolledBack, false)
assert.equal(registration.state.queries.filter((item) => item.sql.startsWith('INSERT INTO ai_end_user_memberships')).length, 1)
assert.equal(registration.state.queries.filter((item) => item.sql.includes('INSERT INTO ai_credit_ledger')).length, 1)
console.log('PASS: registration membership grants package points and writes one ledger entry')

const existing = fakeDatabase({ balance: 20, activeMembershipId: 'mem-existing' })
const skipped = await grantMembershipBenefits({
  userId: 'end-user-1',
  card: { id: 'free-agent-a', name: '免费会员' },
  membershipPackage: { name: '永久免费', bonusPoints: 20 },
  source: 'register',
  createdBy: 'agent-a',
  keepExisting: true,
  database: existing.database,
})
assert.equal(skipped.existing, true)
assert.equal(skipped.bonusPoints, 0)
assert.equal(existing.state.queries.some((item) => item.sql.startsWith('INSERT INTO ai_end_user_memberships')), false)
assert.equal(existing.state.queries.some((item) => item.sql.includes('INSERT INTO ai_credit_ledger')), false)
console.log('PASS: retrying default assignment does not grant points twice')

function fallbackDatabase() {
  const state = { active: { id: 'expired-paid-membership', expires_at: '2020-01-01 00:00:00' }, expiredUpdates: 0, membershipInserts: 0, creditWrites: 0, ledgerWrites: 0, committed: 0, rolledBack: 0 }
  const freePackage = { name: '基础会员', durationDays: 0, bonusPoints: 20, pointsDurationDays: 0, price: 0 }
  const conn = {
    async beginTransaction() {},
    async commit() { state.committed += 1 },
    async rollback() { state.rolledBack += 1 },
    release() {},
    async query(sql, params = []) {
      if (sql.includes('FROM ai_payment_refunds')) return [[], []]
      if (sql.startsWith('SELECT id FROM ai_end_users')) return [[{ id: params[0] }], []]
      if (sql.startsWith('UPDATE ai_end_user_memberships') && sql.includes("status = 'expired'")) {
        state.expiredUpdates += 1
        if (state.active?.expires_at) state.active = null
        return [{ affectedRows: 1 }, []]
      }
      if (sql.includes('SELECT * FROM ai_end_user_memberships')) return [state.active ? [{ ...state.active }] : [], []]
      if (sql.includes('SELECT id, name, packages_json FROM ai_membership_cards')) {
        return [[{ id: freeMembershipCardId('agent-a'), name: '免费会员', packages_json: JSON.stringify([freePackage]) }], []]
      }
      if (sql.startsWith('INSERT INTO ai_end_user_memberships')) {
        state.membershipInserts += 1
        state.active = { id: params[0], user_id: params[1], card_id: params[2], package_name: params[3], status: 'active', source: 'fallback' }
        return [{ affectedRows: 1 }, []]
      }
      if (sql.includes('ai_end_users SET credit_balance')) state.creditWrites += 1
      if (sql.includes('INSERT INTO ai_credit_ledger')) state.ledgerWrites += 1
      return [{ affectedRows: 1 }, []]
    },
  }
  return {
    state,
    database: {
      async query(sql, params = []) {
      if (sql.includes('FROM ai_payment_refunds')) return [[], []]
        if (sql.startsWith('SELECT packages_json FROM ai_membership_cards')) return [[{ packages_json: JSON.stringify([freePackage]) }], []]
        if (sql.startsWith('INSERT INTO ai_membership_cards')) return [{ affectedRows: 1 }, []]
        throw new Error(`Unexpected fallback database SQL: ${sql} / ${params.join(',')}`)
      },
      async getConnection() { return conn },
    },
  }
}

const fallback = fallbackDatabase()
const restored = await ensureFreeMembershipFallback({ userId: 'end-user-1', ownerUserId: 'agent-a', database: fallback.database })
assert.equal(restored.source, 'fallback')
assert.equal(restored.expires_at, null)
assert.equal(fallback.state.membershipInserts, 1)
assert.equal(fallback.state.creditWrites, 0)
assert.equal(fallback.state.ledgerWrites, 0)
const restoredAgain = await ensureFreeMembershipFallback({ userId: 'end-user-1', ownerUserId: 'agent-a', database: fallback.database })
assert.equal(restoredAgain.existing, true)
assert.equal(fallback.state.membershipInserts, 1)
assert.equal(fallback.state.rolledBack, 0)
console.log('PASS: expired memberships fall back idempotently to permanent free membership without re-granting signup points')
