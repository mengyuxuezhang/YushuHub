import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ModelCredentialVault } from './model-credentials.mjs'

test('credential survives restart and cannot be rebound to another upstream account', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-vault-test-'))
  try {
    const keyFile = path.join(dir, 'key')
    const encrypted = await new ModelCredentialVault(keyFile).seal('private-test-key', 'account-a')
    assert.equal(encrypted.includes('private-test-key'), false)
    assert.equal(await new ModelCredentialVault(keyFile).unseal(encrypted, 'account-a'), 'private-test-key')
    await assert.rejects(new ModelCredentialVault(keyFile).unseal(encrypted, 'account-b'))
    await assert.rejects(new ModelCredentialVault(path.join(dir, 'missing')).unseal(encrypted, 'account-a'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
