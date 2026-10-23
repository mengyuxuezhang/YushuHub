import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loadLocalEnvFile } from './load-local-env.mjs'

test('local env is available before path constants are resolved and never overrides process values', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-local-env-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, '.env'), [
    'AI_UPLOAD_DIR="/srv/admin data/uploads"',
    'AI_ADMIN_PORT=7079',
    '# ignored',
    '',
  ].join('\n'))
  const environment = { AI_ADMIN_PORT: '9000' }

  assert.equal(loadLocalEnvFile(root, environment), 1)
  assert.equal(environment.AI_UPLOAD_DIR, '/srv/admin data/uploads')
  assert.equal(environment.AI_ADMIN_PORT, '9000')
})
