import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { prepareContext } from './prepare-context.mjs'

function fixture(extra = {}) {
  const zip = new AdmZip()
  for (const [name, text] of Object.entries({
    'package.json': JSON.stringify({ name: 'agent-ai-admin', version: '1.2.3' }),
    'package-lock.json': '{}', 'cloud/ai-admin/server.mjs': 'export {}',
    'src/db/schema.mjs': 'export {}', 'web/admin-v2/index.html': '<html></html>', ...extra,
  })) zip.addFile(name, Buffer.from(text))
  return zip.toBuffer()
}

test('accepts only the explicit runtime projection and never copies development scripts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-context-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'input.zip'), fixture({ 'scripts/smoke-test-frontend.mjs': 'export {}', '.github/workflows/check.yml': 'name: fixture' }))
  await prepareContext(path.join(root, 'input.zip'), path.join(root, 'context'))
  await assert.rejects(fs.stat(path.join(root, 'context/scripts/smoke-test-frontend.mjs')))
  assert.equal((await fs.readFile(path.join(root, 'context/package.json'), 'utf8')).includes('agent-ai-admin'), true)
})

for (const name of ['cloud/.env', 'cloud/.env.production', 'src/local/credentials.json', 'web/private.key', 'web/hidden.sqlite', 'src/unreviewed.json']) {
  test(`rejects ${name} before creating context`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-context-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    await fs.writeFile(path.join(root, 'input.zip'), fixture({ [name]: 'AI_DB_PASSWORD=FICTIONAL_SECRET' }))
    await assert.rejects(prepareContext(path.join(root, 'input.zip'), path.join(root, 'context')))
    await assert.rejects(fs.stat(path.join(root, 'context')))
  })
}
