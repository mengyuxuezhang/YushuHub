import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { ModelCredentialVault } from './model-credentials.mjs'
import { createProviderCredentialVault } from './model-credential-safety.mjs'

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yushu-provider-master-')), keyFile = path.join(directory, 'master')
  t.after(async () => { assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'yushu-provider-master-')); await fs.rm(directory, { recursive: true, force: true }) })
  const samples = [], connection = { async query() { return [samples] } }
  return { keyFile, samples, connection, vault: createProviderCredentialVault({ keyFile, database: () => connection }) }
}
test('provider vault initializes an empty pool then preserves the original master across credential additions', async t => {
  const { keyFile, samples, vault } = await setup(t)
  await vault.assertWritable(); await assert.rejects(fs.stat(keyFile), { code: 'ENOENT' })
  const first = await vault.seal('original-test-secret', 'account-a'), master = await fs.readFile(keyFile)
  samples.push({ secret_ciphertext: first, upstream_account_id: 'account-a' })
  const second = await vault.seal('another-test-secret', 'account-b')
  assert.equal(await vault.unseal(first, 'account-a'), 'original-test-secret'); assert.equal(await vault.unseal(second, 'account-b'), 'another-test-secret')
  assert.deepEqual(await fs.readFile(keyFile), master)
})
test('missing provider master cannot be replaced while original ciphertext still exists', async t => {
  const { keyFile, samples, vault } = await setup(t), encrypted = await vault.seal('original-test-secret', 'account-a')
  samples.push({ secret_ciphertext: encrypted, upstream_account_id: 'account-a' })
  const parked = keyFile + '.backup'; await fs.rename(keyFile, parked)
  await assert.rejects(vault.assertWritable(), { code: 'MODEL_MASTER_KEY_UNCONFIRMED' })
  await assert.rejects(vault.seal('replacement-test-secret', 'account-b'), { code: 'MODEL_MASTER_KEY_UNCONFIRMED' })
  await assert.rejects(vault.key(true), { code: 'MODEL_MASTER_KEY_UNCONFIRMED' })
  await assert.rejects(fs.stat(keyFile), { code: 'ENOENT' })
  await fs.rename(parked, keyFile)
  assert.equal(await vault.unseal(encrypted, 'account-a'), 'original-test-secret')
  assert.equal(await vault.unseal(await vault.seal('replacement-test-secret', 'account-b'), 'account-b'), 'replacement-test-secret')
})
test('a substituted master and damaged samples never authorize a new credential lineage', async t => {
  const { keyFile, samples, vault } = await setup(t), encrypted = await vault.seal('original-test-secret', 'account-a'), original = await fs.readFile(keyFile)
  samples.push({ secret_ciphertext: encrypted, upstream_account_id: 'account-a' })
  const wrong = crypto.randomBytes(32); await fs.writeFile(keyFile, wrong)
  await assert.rejects(vault.seal('new-test-secret', 'account-b'), { code: 'MODEL_MASTER_KEY_UNCONFIRMED' }); assert.deepEqual(await fs.readFile(keyFile), wrong)
  await fs.writeFile(keyFile, original)
  samples.unshift({ secret_ciphertext: 'broken-envelope', upstream_account_id: 'damaged-account' })
  assert.equal(await vault.unseal(await vault.seal('new-test-secret', 'account-b'), 'account-b'), 'new-test-secret')
  samples.pop()
  await assert.rejects(vault.seal('new-test-secret', 'account-b'), { code: 'MODEL_MASTER_KEY_UNCONFIRMED' })
})
test('provider key writes use their existing SQL transaction without opening a second pool connection', async t => {
  const { keyFile, samples, connection } = await setup(t)
  const first = await new ModelCredentialVault(keyFile).seal('original-test-secret', 'account-a')
  samples.push({ secret_ciphertext: first, upstream_account_id: 'account-a' })
  const vault = createProviderCredentialVault({ keyFile, database: () => { throw new Error('must use original transaction') } })
  const encrypted = await vault.seal('new-test-secret', 'account-b', { connection })
  assert.equal(await vault.unseal(encrypted, 'account-b'), 'new-test-secret')
})
