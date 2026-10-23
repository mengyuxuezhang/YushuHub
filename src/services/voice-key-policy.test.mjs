import assert from 'node:assert/strict'
import test from 'node:test'
import { assertManagedVoiceKeyWriteAllowed, assertManagedVoiceKeyDeletionAllowed } from './voice-key-policy.mjs'

const connection = ({ key = null, capability = null, resource = null } = {}) => ({ query: async sql => [[
  sql.includes('ai_model_task_capabilities') ? capability : sql.includes('AS voices') ? resource : key,
].filter(Boolean)] })

test('MiniMax permits one key and protects replacements', async () => {
  await assertManagedVoiceKeyWriteAllowed(connection({ capability: { id: 'capability' } }), 'provider', undefined, 'new-secret')
  const database = connection({ key: { id: 'managed-key', upstream_account_id: 'account' }, capability: { id: 'capability' }, resource: { voices: 0, operations: 0 } })
  await assert.rejects(assertManagedVoiceKeyWriteAllowed(database, 'provider', undefined, 'new-secret'), { statusCode: 409 })
  await assert.rejects(assertManagedVoiceKeyWriteAllowed(database, 'provider', 'managed-key', 'replacement-secret'), { statusCode: 409 })
  await assertManagedVoiceKeyWriteAllowed(database, 'provider', 'managed-key', 'replacement-secret', 'admin', true)
  await assertManagedVoiceKeyWriteAllowed(database, 'provider', 'managed-key', '')
})

test('MiniMax replacement is blocked while resources remain', async () => {
  const database = connection({ key: { id: 'key', upstream_account_id: 'account' }, capability: { id: 'capability' }, resource: { voices: 1, operations: 0 } })
  await assert.rejects(assertManagedVoiceKeyWriteAllowed(database, 'provider', 'key', 'replacement', 'admin', true), { statusCode: 409 })
})

test('ordinary provider retains key-pool management', async () => {
  await assertManagedVoiceKeyWriteAllowed(connection(), 'ordinary-provider', undefined, 'new-secret')
  await assertManagedVoiceKeyWriteAllowed(connection(), 'ordinary-provider', 'key', 'replacement')
})

test('keys backing private voices cannot be deleted', async () => {
  await assert.rejects(assertManagedVoiceKeyDeletionAllowed(connection({ key: { id: 'private-voice' } }), 'key', 'owner'), { statusCode: 409 })
  await assertManagedVoiceKeyDeletionAllowed(connection(), 'key', 'owner')
})

test('pending voice work and uploaded samples keep their credentials protected', async () => {
  const database = { query: async sql => [sql.includes('ai_voice_operations') ? [{ id: 'cleanup-task' }] : []] }
  await assert.rejects(assertManagedVoiceKeyDeletionAllowed(database, 'key', 'owner'), { statusCode: 409 })
})
