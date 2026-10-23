import test from 'node:test'
import assert from 'node:assert/strict'
import { VoiceOperationRepository } from './voice-operations.mjs'

// Transactional fake exercises balance effects and retry behavior; MySQL locking
// itself must additionally be verified against an isolated database.
function fixture(balance = 10) {
  const state = { balance, rows: [], ledger: [], voiceOperation: '' }
  let backup
  const query = async (sql, values = []) => {
    if (sql.startsWith('SELECT id FROM ai_model_provider_keys')) return [[{ id: values[0] }]]
    if (sql.startsWith('SELECT id FROM ai_system_voices')) return [values[0] === 'system-voice' && values[1] === 'org' ? [{ id: values[0] }] : []]
    if (sql.startsWith('SELECT * FROM ai_private_voices')) return [[{ id: values[0], active_operation_id: state.voiceOperation }]]
    if (sql.startsWith("UPDATE ai_private_voices SET active_operation_id=''")) { if (state.voiceOperation === values[1]) state.voiceOperation = ''; return [{ affectedRows: 1 }] }
    if (sql.startsWith('UPDATE ai_private_voices SET active_operation_id=?')) { state.voiceOperation = values[0]; return [{ affectedRows: 1 }] }
    if (sql.startsWith('SELECT credit_balance')) return [[{ credit_balance: state.balance }]]
    if (sql.startsWith('SELECT id FROM ai_end_users')) return [[{ id: 'user' }]]
    if (sql.startsWith('SELECT * FROM ai_voice_operations WHERE user_id=')) return [[...state.rows.filter(row => row.user_id === values[0] && row.operation_type === values[1] && row.idempotency_key === values[2])]]
    if (sql.startsWith('SELECT * FROM ai_voice_operations WHERE id=')) return [[...state.rows.filter(row => row.id === values[0] && (values.length === 1 || row.user_id === values[1] && row.organization_id === values[2]))]]
    if (sql.startsWith('UPDATE ai_end_users SET credit_balance=credit_balance-')) { state.balance -= values[0]; return [{ affectedRows: 1 }] }
    if (sql.startsWith('UPDATE ai_end_users SET credit_balance=credit_balance+')) { state.balance += values[0]; return [{ affectedRows: 1 }] }
    if (sql.startsWith('INSERT INTO ai_voice_operations')) {
      const [id, organization_id, user_id, voice_id, operation_type, idempotency_key, input_fingerprint, points_reserved] = values
      state.rows.push({ id, organization_id, user_id, voice_id, operation_type, idempotency_key, input_fingerprint, points_reserved, status: 'pending', points_settled: 0 })
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith("UPDATE ai_voice_operations SET status='running'")) {
      const row = state.rows.find(row => row.id === values[1] && row.user_id === values[2] && row.organization_id === values[3] && row.status === 'pending')
      if (row) row.status = 'running'
      return [{ affectedRows: row ? 1 : 0 }]
    }
    if (sql.startsWith("UPDATE ai_voice_operations SET status='outcome_unknown'")) {
      const row = state.rows.find(row => row.id === values[1]); row.status = 'outcome_unknown'; return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('INSERT INTO ai_credit_ledger')) { state.ledger.push(values); return [{ affectedRows: 1 }] }
    if (sql.startsWith('UPDATE ai_voice_operations SET status=?')) {
      const row = state.rows.find(row => row.id === values[4]); Object.assign(row, { status: values[0], points_settled: values[1], points_reserved: 0, result_json: values[2] }); return [{ affectedRows: 1 }]
    }
    throw new Error(`Unexpected query: ${sql}`)
  }
  const pool = { query, getConnection: async () => ({ query, beginTransaction: async () => { backup = structuredClone(state) }, commit: async () => {}, rollback: async () => Object.assign(state, backup), release: () => {} }) }
  return { state, repo: new VoiceOperationRepository(pool) }
}

const user = { id: 'user', organizationId: 'org' }
const input = { operation: 'activate', voiceId: 'voice', idempotencyKey: 'test-request', points: 4, fingerprint: 'a'.repeat(64) }

test('built-in synthesis reserves and settles once without claiming a private voice', async () => {
  const { repo, state } = fixture()
  const request = { ...input, operation: 'synthesize', voiceId: 'system-voice', voiceCategory: 'system' }
  const first = await repo.reserve(user, request)
  assert.equal((await repo.reserve(user, request)).created, false)
  assert.equal(state.voiceOperation, '')
  await repo.finish(user, first.operation.id, { status: 'succeeded', points: 4 })
  await repo.finish(user, first.operation.id, { status: 'succeeded', points: 4 })
  assert.equal(state.balance, 6)
  assert.equal(state.ledger.length, 1)
})

test('built-in voices reject other channels and deletion before charging', async () => {
  const { repo, state } = fixture()
  const request = { ...input, operation: 'synthesize', voiceId: 'system-voice', voiceCategory: 'system' }
  await assert.rejects(repo.reserve({ ...user, organizationId: 'other' }, request), { code: 'VOICE_NOT_FOUND' })
  await assert.rejects(repo.reserve(user, { ...request, operation: 'delete' }), { code: 'VOICE_INPUT_INVALID' })
  assert.equal(state.balance, 10)
  assert.equal(state.rows.length, 0)
})

test('repeated submission reserves once; repeated completion settles once', async () => {
  const { repo, state } = fixture()
  const first = await repo.reserve(user, input)
  assert.equal((await repo.reserve(user, input)).created, false)
  assert.equal(state.balance, 6)
  assert.equal(await repo.start(user, first.operation.id, 'key'), true)
  assert.equal(await repo.start(user, first.operation.id, 'key'), false)
  await repo.finish(user, first.operation.id, { status: 'succeeded', points: 3 })
  await repo.finish(user, first.operation.id, { status: 'succeeded', points: 3 })
  assert.equal(state.balance, 7)
  assert.equal(state.ledger.length, 1)
})

test('insufficient balance leaves no reservation or task', async () => {
  const { repo, state } = fixture(1)
  await assert.rejects(repo.reserve(user, input), { code: 'ADMIN_CREDITS_EXHAUSTED' })
  assert.equal(state.balance, 1)
  assert.equal(state.rows.length, 0)
})

test('unknown result keeps reservation; confirmed failure releases it once', async () => {
  const { repo, state } = fixture()
  const { operation } = await repo.reserve(user, input)
  await repo.finish(user, operation.id, { status: 'outcome_unknown' })
  assert.equal(state.balance, 6)
  await repo.finish(user, operation.id, { status: 'failed' })
  await repo.finish(user, operation.id, { status: 'failed' })
  assert.equal(state.balance, 10)
  assert.equal(state.ledger.length, 0)
})

test('same idempotency key with changed request is rejected', async () => {
  const { repo, state } = fixture()
  await repo.reserve(user, input)
  await assert.rejects(repo.reserve(user, { ...input, fingerprint: 'b'.repeat(64) }), { code: 'VOICE_IDEMPOTENCY_CONFLICT' })
  assert.equal(state.balance, 6)
})

test('guessed task ID from a different user or channel is not visible', async () => {
  const { repo } = fixture()
  const { operation } = await repo.reserve(user, input)
  await assert.rejects(repo.find({ ...user, id: 'other' }, operation.id), { code: 'VOICE_TASK_NOT_FOUND' })
  await assert.rejects(repo.find({ ...user, organizationId: 'other' }, operation.id), { code: 'VOICE_TASK_NOT_FOUND' })
})

test('different idempotency keys cannot start a second operation on a busy voice', async () => {
  const { repo, state } = fixture()
  const first = await repo.reserve(user, input)
  await assert.rejects(repo.reserve(user, { ...input, operation: 'delete', idempotencyKey: 'delete-request', points: 0 }), { code: 'VOICE_BUSY' })
  assert.equal(state.balance, 6)
  await repo.finish(user, first.operation.id, { status: 'outcome_unknown' })
  await assert.rejects(repo.reserve(user, { ...input, idempotencyKey: 'another-request' }), { code: 'VOICE_BUSY' })
  await repo.finish(user, first.operation.id, { status: 'failed' })
  assert.equal((await repo.reserve(user, { ...input, idempotencyKey: 'another-request' })).created, true)
})
