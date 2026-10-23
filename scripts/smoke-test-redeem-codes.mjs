import assert from 'node:assert/strict'

import {
  generateRedeemCodes,
  normalizeRedeemRewardType,
  redeemCodeForEndUser,
  setRedeemCodeDependencies,
} from '../src/services/redeem-codes.mjs'

function compactSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim()
}

function createGenerationDatabase({ membershipCard = null } = {}) {
  const state = {
    cardQueries: [],
    freeCardEnsures: 0,
    batchInserts: [],
    codeInserts: [],
    began: false,
    committed: false,
    rolledBack: false,
    released: false,
  }

  const conn = {
    async beginTransaction() { state.began = true },
    async commit() { state.committed = true },
    async rollback() { state.rolledBack = true },
    release() { state.released = true },
    async query(sql, params = []) {
      const normalized = compactSql(sql)
      if (normalized.includes('FROM ai_membership_cards')) {
        state.cardQueries.push({ sql: normalized, params })
        const belongsToActor = membershipCard
          && params[0] === membershipCard.id
          && params[1] === membershipCard.created_by
        return [belongsToActor ? [membershipCard] : [], []]
      }
      if (normalized.startsWith('INSERT INTO ai_redeem_code_batches')) {
        state.batchInserts.push({ sql: normalized, params })
        return [{ affectedRows: 1 }, []]
      }
      if (normalized.startsWith('INSERT INTO ai_redeem_codes')) {
        state.codeInserts.push({ sql: normalized, params })
        return [{ affectedRows: 1 }, []]
      }
      throw new Error(`Unexpected generation SQL: ${normalized}`)
    },
  }

  return {
    state,
    database: {
      async query(sql, params = []) {
        const normalized = compactSql(sql)
        if (normalized.startsWith('SELECT packages_json FROM ai_membership_cards')) return [[], []]
        if (normalized.startsWith('INSERT INTO ai_membership_cards')) {
          state.freeCardEnsures += 1
          return [{ affectedRows: 1 }, []]
        }
        throw new Error(`Unexpected database SQL: ${normalized}`)
      },
      async getConnection() { return conn },
    },
  }
}

assert.equal(normalizeRedeemRewardType(undefined), 'points')
assert.equal(normalizeRedeemRewardType('points'), 'points')
assert.equal(normalizeRedeemRewardType('legacy-value'), 'points')
assert.equal(normalizeRedeemRewardType('MEMBERSHIP'), 'membership')
console.log('PASS: missing or legacy reward types remain points codes')

const pointsGeneration = createGenerationDatabase()
const pointsCreated = await generateRedeemCodes(
  { points: 20, quantity: 2, name: '20 points' },
  { id: 'agent-a', username: 'agent-a', role: 'agent' },
  pointsGeneration.database,
)
assert.equal(pointsCreated.batch.rewardType, 'points')
assert.equal(pointsCreated.batch.points, 20)
assert.equal(pointsCreated.batch.membershipCardId, '')
assert.equal(pointsCreated.codes.length, 2)
assert.equal(pointsGeneration.state.batchInserts.length, 1)
assert.equal(pointsGeneration.state.batchInserts[0].params[2], 'points')
assert.equal(pointsGeneration.state.batchInserts[0].params[3], 20)
assert.equal(pointsGeneration.state.codeInserts.length, 2)
assert.deepEqual(pointsGeneration.state.codeInserts.map((item) => item.params[5]), [20, 20])
assert.equal(pointsGeneration.state.began, true)
assert.equal(pointsGeneration.state.committed, true)
assert.equal(pointsGeneration.state.rolledBack, false)
assert.equal(pointsGeneration.state.released, true)
console.log('PASS: points code generation preserves the existing batch and code contract')

const membershipCard = {
  id: 'gold-card',
  name: 'Gold Membership',
  created_by: 'agent-a',
  packages_json: JSON.stringify([
    {
      name: 'Monthly',
      duration_days: '30',
      bonus_points: '5.5',
      points_duration_days: '60',
      price: '99',
      original_price: '129',
      show_original_price: '1',
    },
    { name: 'Annual', durationDays: 365, bonusPoints: 100 },
  ]),
}

const deniedGeneration = createGenerationDatabase({ membershipCard })
await assert.rejects(
  generateRedeemCodes(
    { rewardType: 'membership', membershipCardId: 'gold-card' },
    { id: 'agent-b', role: 'agent' },
    deniedGeneration.database,
  ),
  /不属于当前账号/,
)
assert.deepEqual(deniedGeneration.state.cardQueries[0].params, ['gold-card', 'agent-b'])
assert.equal(deniedGeneration.state.batchInserts.length, 0)
console.log('PASS: membership code generation enforces card ownership by management account')

const membershipGeneration = createGenerationDatabase({ membershipCard })
const membershipCreated = await generateRedeemCodes(
  {
    rewardType: 'membership',
    membershipCardId: 'gold-card',
    quantity: 2,
    note: 'membership sale',
  },
  { id: 'agent-a', username: 'agent-a', role: 'agent' },
  membershipGeneration.database,
)
assert.equal(membershipCreated.batch.rewardType, 'membership')
assert.equal(membershipCreated.batch.points, 0)
assert.equal(membershipCreated.batch.membershipCardId, 'gold-card')
assert.equal(membershipCreated.batch.membershipCardName, 'Gold Membership')
assert.equal(membershipCreated.batch.membershipPackageName, 'Monthly')
assert.deepEqual(membershipCreated.batch.membershipPackage, {
  name: 'Monthly',
  durationDays: 30,
  bonusPoints: 5.5,
  pointsDurationDays: 60,
  price: 99,
  originalPrice: 129,
  showOriginalPrice: true,
})
assert.equal(membershipCreated.codes.length, 2)
assert.deepEqual(membershipGeneration.state.cardQueries[0].params, ['gold-card', 'agent-a'])
assert.equal(membershipGeneration.state.batchInserts[0].params[2], 'membership')
assert.equal(membershipGeneration.state.batchInserts[0].params[3], 0)
assert.equal(membershipGeneration.state.batchInserts[0].params[4], 'gold-card')
assert.equal(membershipGeneration.state.batchInserts[0].params[6], 'Monthly')
assert.deepEqual(JSON.parse(membershipGeneration.state.batchInserts[0].params[7]), membershipCreated.batch.membershipPackage)
assert.deepEqual(membershipGeneration.state.codeInserts.map((item) => item.params[5]), [0, 0])
assert.equal(membershipGeneration.state.committed, true)
console.log('PASS: membership code generation automatically stores the card\'s single account-owned entitlement snapshot')

function createRedeemDatabase({ codeRow, card = null, startingBalance = 0, activeMembershipId = '' } = {}) {
  const state = {
    balance: startingBalance,
    activeMembershipId,
    createdMembershipId: '',
    ledgerInserts: [],
    codeUpdates: [],
    membershipCancellations: 0,
    began: false,
    committed: false,
    rolledBack: false,
    released: false,
  }

  const conn = {
    async beginTransaction() { state.began = true },
    async commit() { state.committed = true },
    async rollback() { state.rolledBack = true },
    release() { state.released = true },
    async query(sql, params = []) {
      const normalized = compactSql(sql)
      if (normalized.includes('FROM ai_redeem_codes c')) return [[codeRow], []]
      if (normalized.includes('FROM ai_membership_cards')) return [card ? [card] : [], []]
      if (normalized.startsWith('SELECT id, status FROM ai_end_users')) {
        return [[{ id: params[0], status: 'enabled' }], []]
      }
      if (normalized.startsWith('SELECT id, credit_balance FROM ai_end_users')) {
        return [[{ id: params[0], credit_balance: state.balance }], []]
      }
      if (normalized.startsWith('SELECT id FROM ai_end_user_memberships')) {
        return [state.activeMembershipId ? [{ id: state.activeMembershipId }] : [], []]
      }
      if (normalized.startsWith('UPDATE ai_end_user_memberships SET status = "cancelled"')) {
        state.membershipCancellations += 1
        state.activeMembershipId = ''
        return [{ affectedRows: 1 }, []]
      }
      if (normalized.startsWith('INSERT INTO ai_end_user_memberships')) {
        state.createdMembershipId = params[0]
        state.activeMembershipId = params[0]
        return [{ affectedRows: 1 }, []]
      }
      if (normalized.startsWith('SELECT credit_balance FROM ai_end_users')) {
        return [[{ credit_balance: state.balance }], []]
      }
      if (normalized.startsWith('UPDATE ai_end_users SET credit_balance = credit_balance +')) {
        state.balance += Number(params[0] || 0)
        return [{ affectedRows: 1 }, []]
      }
      if (normalized.startsWith('INSERT INTO ai_credit_ledger')) {
        state.ledgerInserts.push({ sql: normalized, params })
        return [{ affectedRows: 1 }, []]
      }
      if (normalized.startsWith('UPDATE ai_redeem_codes')) {
        state.codeUpdates.push({ sql: normalized, params })
        return [{ affectedRows: 1 }, []]
      }
      throw new Error(`Unexpected redemption SQL: ${normalized}`)
    },
  }

  return {
    state,
    database: { async getConnection() { return conn } },
  }
}

const legacyPointsDatabase = createRedeemDatabase({
  startingBalance: 10,
  codeRow: {
    id: 'legacy-code-id',
    batch_status: 'enabled',
    status: 'unused',
    points: 20,
    code_preview: 'LEGACY20',
    // Old batches do not have a reward_type value.
    reward_type: null,
  },
})
let legacyLedgerCall = null
setRedeemCodeDependencies({
  findEndUserById: async () => ({ id: 'end-user-1', status: 'enabled', creditBalance: legacyPointsDatabase.state.balance }),
  findEndUserWithMembershipById: async () => ({ id: 'end-user-1', status: 'enabled', creditBalance: legacyPointsDatabase.state.balance }),
  keyOwnerUserIdForEndUser: async () => 'agent-a',
  appendCreditLedger: async (_conn, userId, entry) => { legacyLedgerCall = { userId, entry } },
  sanitizeEndUser: (user) => ({ ...user }),
})
const legacyPointsResult = await redeemCodeForEndUser(
  'end-user-1',
  ' ai-legacy-20 ',
  { sourceProjectId: 'desktop-project' },
  legacyPointsDatabase.database,
)
assert.equal(legacyPointsResult.redeemType, 'points')
assert.equal(legacyPointsResult.rewardType, 'points')
assert.equal(legacyPointsResult.points, 20)
assert.equal(legacyPointsResult.creditBalance, 30)
assert.equal(legacyPointsResult.membership, null)
assert.match(legacyPointsResult.message, /20.*积分/)
assert.equal(legacyLedgerCall.userId, 'end-user-1')
assert.equal(legacyLedgerCall.entry.pointsDelta, 20)
assert.equal(legacyLedgerCall.entry.requestId, 'legacy-code-id')
assert.equal(legacyPointsDatabase.state.codeUpdates.length, 1)
assert.equal(legacyPointsDatabase.state.committed, true)
assert.equal(legacyPointsDatabase.state.rolledBack, false)
console.log('PASS: legacy points codes redeem through the unchanged client contract')

const membershipCodeRow = {
  id: 'membership-code-id',
  batch_status: 'enabled',
  batch_created_by: 'agent-a',
  status: 'unused',
  points: 0,
  reward_type: 'membership',
  membership_card_id: 'gold-card',
  membership_card_name: 'Gold Membership',
  membership_package_name: 'Monthly',
  membership_package_json: JSON.stringify({
    name: 'Monthly',
    durationDays: 30,
    bonusPoints: 5,
    pointsDurationDays: 60,
    price: 99,
  }),
}
const crossTenantMembershipDatabase = createRedeemDatabase({
  startingBalance: 7,
  card: { id: 'gold-card', name: 'Current Gold Name', status: 'enabled', created_by: 'agent-a' },
  codeRow: membershipCodeRow,
})
setRedeemCodeDependencies({
  findEndUserById: async () => ({ id: 'end-user-other-agent', status: 'enabled', creditBalance: 7 }),
  keyOwnerUserIdForEndUser: async () => 'agent-b',
  appendCreditLedger: async () => {},
  sanitizeEndUser: (user) => ({ ...user }),
})
await assert.rejects(
  redeemCodeForEndUser('end-user-other-agent', 'AI-MEMBER-MONTH', {}, crossTenantMembershipDatabase.database),
  /不适用于当前账号所属渠道/,
)
assert.equal(crossTenantMembershipDatabase.state.createdMembershipId, '')
assert.equal(crossTenantMembershipDatabase.state.codeUpdates.length, 0)
assert.equal(crossTenantMembershipDatabase.state.rolledBack, true)
console.log('PASS: membership codes cannot cross management-account ownership boundaries')

const membershipRedeemDatabase = createRedeemDatabase({
  startingBalance: 7,
  activeMembershipId: 'old-membership-id',
  card: { id: 'gold-card', name: 'Current Gold Name', status: 'enabled', created_by: 'agent-a' },
  codeRow: membershipCodeRow,
})
let membershipAppendLedgerCalls = 0
setRedeemCodeDependencies({
  findEndUserById: async () => ({ id: 'end-user-2', status: 'enabled', creditBalance: membershipRedeemDatabase.state.balance }),
  findEndUserWithMembershipById: async () => ({
    id: 'end-user-2',
    status: 'enabled',
    creditBalance: membershipRedeemDatabase.state.balance,
    membership: {
      id: membershipRedeemDatabase.state.createdMembershipId,
      cardId: 'gold-card',
      cardName: 'Gold Membership',
      packageName: 'Monthly',
      status: 'active',
    },
  }),
  keyOwnerUserIdForEndUser: async () => 'agent-a',
  appendCreditLedger: async () => { membershipAppendLedgerCalls += 1 },
  sanitizeEndUser: (user) => ({ ...user }),
})
const membershipResult = await redeemCodeForEndUser(
  'end-user-2',
  'AI-MEMBER-MONTH',
  { deviceId: 'desktop-device' },
  membershipRedeemDatabase.database,
)
assert.equal(membershipResult.redeemType, 'membership')
assert.equal(membershipResult.rewardType, 'membership')
assert.equal(membershipResult.points, 5)
assert.equal(membershipResult.creditBalance, 12)
assert.equal(membershipResult.membership.cardId, 'gold-card')
assert.equal(membershipResult.membership.cardName, 'Gold Membership')
assert.equal(membershipResult.membership.packageName, 'Monthly')
assert.match(membershipResult.message, /Gold Membership.*Monthly/)
assert.equal(membershipRedeemDatabase.state.membershipCancellations, 1)
assert.ok(membershipRedeemDatabase.state.createdMembershipId.startsWith('mem-'))
assert.equal(membershipRedeemDatabase.state.ledgerInserts.length, 1)
assert.equal(membershipRedeemDatabase.state.ledgerInserts[0].params[2], 'redeem')
assert.equal(membershipRedeemDatabase.state.ledgerInserts[0].params[3], 5)
assert.equal(membershipRedeemDatabase.state.ledgerInserts[0].params[4], 12)
assert.equal(membershipRedeemDatabase.state.ledgerInserts[0].params[6], 'membership-code-id')
assert.equal(membershipAppendLedgerCalls, 0)
assert.equal(membershipRedeemDatabase.state.codeUpdates.length, 1)
assert.equal(membershipRedeemDatabase.state.committed, true)
assert.equal(membershipRedeemDatabase.state.rolledBack, false)
assert.equal(membershipRedeemDatabase.state.released, true)
console.log('PASS: membership codes replace active membership, grant snapshot points, and return membership details')
