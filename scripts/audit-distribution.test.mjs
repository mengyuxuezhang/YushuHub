import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'

import { auditAdminDistribution } from './audit-distribution.mjs'

function fixture(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-distribution-'))
  const file = path.join(root, 'admin.zip')
  const zip = new AdmZip()
  for (const [name, body] of Object.entries(entries)) zip.addFile(name, Buffer.from(body))
  zip.writeZip(file)
  return { file, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('accepts a minimal Admin-only supplier distribution', (context) => {
  const item = fixture({
    'package.json': '{"name":"agent-ai-admin"}',
    '.env.example': 'AI_WORKER_TOKEN=change-me-before-run\nAI_BUILD_CENTER_TOKEN=\n',
    'src/server.mjs': 'export const service = "admin"',
  })
  context.after(item.cleanup)
  const result = auditAdminDistribution(item.file)
  assert.equal(result.files, 3)
  assert.equal(result.violations, 0)
})

test('rejects desktop source, private infrastructure and credential material', (context) => {
  const cases = [
    ['desktop/src/main/index.ts', 'export {}'],
    ['docs/BUILD_WORKER_HANDOFF.md', 'internal'],
    ['src/config.mjs', 'const repo = "ssh://root@example.com/www/wwwroot/git/private.git"'],
    ['src/worker.mjs', 'const host = "120.53.230.168"'],
    ['.env.example', 'AI_BUILD_CENTER_TOKEN=real-secret-value'],
  ]
  for (const [name, body] of cases) {
    const item = fixture({ 'package.json': '{"name":"agent-ai-admin"}', [name]: body })
    context.after(item.cleanup)
    assert.throws(() => auditAdminDistribution(item.file), /isolation audit failed/)
  }
})

test('rejects Linux shell installers with Windows CRLF line endings', (context) => {
  const item = fixture({
    'package.json': '{"name":"agent-ai-admin"}',
    'scripts/install-local.sh': '#!/usr/bin/env bash\r\nset -euo pipefail\r\n',
  })
  context.after(item.cleanup)
  assert.throws(() => auditAdminDistribution(item.file), /shell script uses CRLF line endings/)
})

test('network installer verifies the published checksum and package identity', () => {
  const installer = fs.readFileSync(new URL('./install-agent-ai.sh', import.meta.url), 'utf8')
  assert.match(installer, /PACKAGE_SHA256/)
  assert.match(installer, /ACTUAL_SHA256/)
  assert.match(installer, /安装包 SHA-256 校验失败/)
  assert.match(installer, /pkg\.name !== 'agent-ai-admin'/)
  assert.match(installer, /与清单版本 .* 不一致/)
})

test('packaging removes dependency directories from nested workspaces', () => {
  const packer = fs.readFileSync(new URL('./pack-zip.ps1', import.meta.url), 'utf8')
  assert.match(packer, /\.Name -eq 'node_modules'/)
  assert.match(packer, /Remove-Item -Recurse -Force/)
  assert.match(packer, /"tmp"/)
  assert.match(packer, /"output"/)
  assert.match(packer, /"web-admin"/)
})
