import test from 'node:test'
import assert from 'node:assert/strict'
import { VoiceDeletionService } from './voice-deletion.mjs'

function fixture({ status = 'failed', error = null, active = null, history = [] } = {}) {
  const voice = { id: 'voice-one', user_id: 'user-one', organization_id: 'org-one', upstream_account_id: 'account-one', provider_id: 'provider-one', provider_voice_id: 'upstream-one', status, active_operation_id: active?.id || '' }
  const ops = active ? [active] : [], calls = []
  const query = async (sql, a = []) => {
    calls.push(sql)
    if (sql.startsWith('SELECT * FROM ai_private_voices')) return [[...(a[1] === voice.organization_id ? [voice] : [])]]
    if (sql.includes("operation_type='delete' AND idempotency_key")) return [[...ops.filter(o => o.idempotency_key === a[1])]]
    if (sql.startsWith('SELECT * FROM ai_voice_operations WHERE id=')) return [[...ops.filter(o => o.id === a[0])]]
    if (sql.startsWith('SELECT operation_type,status,error_code')) return [history]
    if (sql.startsWith('SELECT k.*')) return [[{ id: 'key-one', secret_ciphertext: 'encrypted', base_url: 'https://api.minimaxi.com' }]]
    if (sql.startsWith('INSERT INTO ai_voice_operations')) { ops.push({ id: a[0], user_id: a[2], voice_id: a[3], idempotency_key: a[4], input_fingerprint: a[5], organization_id: a[1], status: 'running', operation_type: 'delete' }); return [{ affectedRows: 1 }] }
    if (sql.startsWith("UPDATE ai_private_voices SET status='delete_pending'")) { voice.status = 'delete_pending'; voice.active_operation_id = a[0]; return [{ affectedRows: 1 }] }
    if (sql.startsWith('SELECT id,upstream_file_id')) return [[]]
    if (sql.startsWith('UPDATE ai_private_voices SET status=?')) { voice.status = a[0]; voice.active_operation_id = a[1]; return [{ affectedRows: 1 }] }
    if (sql.startsWith('UPDATE ai_voice_operations SET status=?')) { Object.assign(ops.find(o => o.id === a[3]), { status: a[0] }); return [{ affectedRows: 1 }] }
    if (sql.startsWith("UPDATE ai_voice_operations SET status='running'")) { ops.find(o => o.id === a[0]).status = 'running'; return [{ affectedRows: 1 }] }
    throw Error(sql)
  }
  const pool = { query, getConnection: async () => ({ query, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} }) }
  const service = new VoiceDeletionService({ pool, vault: { unseal: async () => 'secret' }, artifacts: { remove: async () => calls.push('artifact-removed') }, adapter: { deleteVoiceIfPresent: async () => { calls.push('upstream'); if (error) throw error } } })
  return { service, voice, ops, calls }
}
const user = { id: 'user-one', organizationId: 'org-one' }
const input = { voiceId: 'voice-one', idempotencyKey: 'request-one' }
test('failed and active voices can be removed without model authorization or balance mutation', async () => {
  for (const status of ['failed', 'active', 'preview_ready']) {
    const f = fixture({ status }); const result = await f.service.deleteForUser(user, input)
    assert.equal(result.status, 'succeeded'); assert.equal(f.voice.status, 'deleted')
    assert.ok(!f.calls.some(sql => /credit_balance|ai_credit_ledger/.test(sql)))
    await f.service.deleteForUser(user, input)
    assert.equal(f.calls.filter(c => c === 'upstream').length, 1)
  }
})
test('user and organization ownership reject guessed IDs before upstream access', async () => {
  for (const other of [{ ...user, id: 'other' }, { ...user, organizationId: 'other' }]) {
    const f = fixture(); await assert.rejects(f.service.deleteForUser(other, input), { code: 'VOICE_NOT_FOUND' }); assert.ok(!f.calls.includes('upstream'))
  }
})
test('known rejection retains voice and allows a fresh request', async () => {
  const f = fixture({ error: Object.assign(Error('rejected'), { code: 'MINIMAX_AUTH_FAILED', outcomeUnknown: false }) })
  assert.equal((await f.service.deleteForUser(user, input)).status, 'failed'); assert.equal(f.voice.status, 'failed'); assert.equal(f.voice.active_operation_id, '')
})
test('unknown deletion can reconcile on retry even with a fresh client request token', async () => {
  const active = { id: 'operation-one', operation_type: 'delete', status: 'outcome_unknown', voice_id: 'voice-one' }
  const f = fixture({ status: 'delete_pending', active }); assert.equal((await f.service.deleteForUser(user, input)).status, 'succeeded'); assert.equal(f.ops.length, 1)
})
test('running and uncertain paid work remain protected', async () => {
  const f = fixture({ active: { id: 'operation-one', operation_type: 'activate', status: 'outcome_unknown' } })
  await assert.rejects(f.service.deleteForUser(user, input), { code: 'VOICE_BUSY' }); assert.ok(!f.calls.includes('upstream'))
})
test('proven rejected training can be cleared locally without unusable upstream credentials', async () => {
  const f = fixture({ history: [{ operation_type: 'clone', status: 'failed', error_code: 'MINIMAX_PROVIDER_REJECTED', cleanup_pending: 0 }] })
  assert.equal((await f.service.deleteForUser(user, input)).status, 'succeeded')
  assert.ok(!f.calls.includes('upstream'))
})
test('failure after upstream success and pending sample cleanup require upstream verification', async () => {
  for (const history of [[{ operation_type: 'clone', status: 'failed', error_code: 'MINIMAX_INVALID_RESPONSE', cleanup_pending: 0 }], [{ operation_type: 'clone', status: 'failed', error_code: 'MINIMAX_PROVIDER_REJECTED', cleanup_pending: 1 }]]) {
    const f = fixture({ history }); await f.service.deleteForUser(user, input); assert.ok(f.calls.includes('upstream'))
  }
})
