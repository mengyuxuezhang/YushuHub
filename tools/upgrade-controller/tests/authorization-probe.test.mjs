import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { signClaims } from '../../../src/services/authorization/protocol.mjs'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const probe = fileURLToPath(new URL('../authorization-probe.mjs', import.meta.url))

test('offline center proof verifies signature, identity, validity and cache without exporting credentials', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-identity-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.cp(path.join(repository, 'src'), path.join(root, 'src'), { recursive: true })
  await fs.mkdir(path.join(root, 'data'))
  // Isolate signature/cache behavior from database/network behavior in this unit test.
  await fs.mkdir(path.join(root, 'node_modules/mysql2'), { recursive: true })
  await fs.writeFile(path.join(root, 'node_modules/mysql2/promise.js'), 'module.exports={createConnection:async()=>({query:async()=>[[{bytes:0}]],end:async()=>{}})}')
  const keys = crypto.generateKeyPairSync('ed25519')
  const publicKeys = { fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }) }
  await fs.writeFile(path.join(root, 'keys.json'), JSON.stringify(publicKeys))
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AI_')))
  const config = `AI_AUTHORIZATION_MODE=center\nAI_LICENSE_CENTER_URL=https://center.fixture.invalid\nAI_ADMIN_PUBLIC_URL=https://agent.fixture.invalid\nAI_LICENSE_INSTANCE_ID=fixture-stable\nAI_LICENSE_PUBLIC_KEYS_FILE=${path.join(root, 'keys.json')}\n`
  await fs.writeFile(path.join(root, '.env'), config)
  const credential = crypto.randomBytes(32).toString('base64url')
  const claims = { aud: 'deployment', id: 'fixture-license', instanceId: 'fixture-stable', level: 1, hierarchy: 'single',
    domain: 'https://agent.fixture.invalid', modelMode: 'custom', iat: Date.now(), exp: Date.now() + 600_000 }
  const state = extra => ({ rootId: claims.id, credential, certificate: signClaims(claims, { privateKey: keys.privateKey, keyId: 'fixture' }),
    checkedAt: Date.now(), rejected: false, ...extra })
  async function run(record, expected) {
    await fs.writeFile(path.join(root, 'data/deployment-license.json'), JSON.stringify(record))
    const before = await fs.stat(path.join(root, 'data/deployment-license.json'))
    const result = spawnSync(process.execPath, [probe, root], { encoding: 'utf8', env: environment })
    assert.equal(result.status, expected ? 0 : 1)
    const output = JSON.parse(result.stdout)
    assert.equal(output.verified, expected)
    assert.equal(result.stdout.includes(credential), false)
    assert.equal(result.stdout.includes(record.certificate), false)
    assert.equal((await fs.stat(path.join(root, 'data/deployment-license.json'))).mtimeMs, before.mtimeMs)
  }
  await run(state(), true)
  await run(state({ rootId: 'wrong-license' }), false)
  await run(state({ rejected: true }), false)
  await run(state({ checkedAt: Date.now() - 86_400_001 }), false)
  await run(state({ certificate: 'bad.signed.token' }), false)
  await fs.writeFile(path.join(root, '.env'), config.replace('AI_LICENSE_INSTANCE_ID=fixture-stable', 'AI_LICENSE_INSTANCE_ID=different-instance'))
  await run(state(), false)
})
