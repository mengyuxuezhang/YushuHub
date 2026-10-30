import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
  assert.match(packer, /Remove-Item[^\r\n]*-Recurse -Force/)
  assert.match(packer, /"tmp"/)
  assert.match(packer, /"output"/)
  assert.match(packer, /"web-admin"/)
})

test('Windows packer excludes untracked credentials and keeps the previous ZIP when required files disappear', { skip: process.platform !== 'win32' }, context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-pack-integration-')), source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  context.after(() => {
    const dependencies = path.join(root, 'node_modules')
    if (fs.existsSync(dependencies)) { assert(fs.lstatSync(dependencies).isSymbolicLink()); fs.unlinkSync(dependencies) }
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'admin-pack-integration-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const files = {
    'package.json': JSON.stringify({ name: 'agent-ai-admin', version: '1.2.3', type: 'module' }),
    'package-lock.json': JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } }),
    'cloud/ai-admin/server.mjs': "import '../../src/tracked.mjs'", 'src/tracked.mjs': 'export {}',
    'web/index.html': '<html></html>', 'web/site/index.html': '<html></html>', 'web/styles/admin.css': 'body{}',
    'web/js/admin.js': "import './views/organizations.js'", 'web/js/views/organizations.js': 'export {}',
    'web/admin-v2/index.html': '<script src="/admin/v2/assets/app.js"></script><link href="/admin/v2/assets/app.css">',
    'web/admin-v2/assets/app.js': 'export {}', 'web/admin-v2/assets/app.css': 'body{}',
  }
  for (const [name, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), body) }
  for (const name of ['scripts/pack-zip.ps1', 'scripts/audit-distribution.mjs', 'src/services/self-update-package.mjs']) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.copyFileSync(path.join(source, name), path.join(root, name))
  }
  const run = (binary, args) => execFileSync(binary, args, { cwd: root, windowsHide: true, stdio: 'pipe', timeout: 60000 })
  run('git', ['init', '-q']); run('git', ['-c', 'core.autocrlf=false', 'add', '-f', '-A'])
  fs.symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'junction')
  fs.writeFileSync(path.join(root, '.env'), 'AI_ADMIN_PASSWORD=fictional-private-value')
  fs.writeFileSync(path.join(root, 'src/untracked-private.json'), '{"credential":"fictional-private-value"}')
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/pack-zip.ps1'), '-Version', '1.2.3', '-OutputDir', path.join(root, 'release')]
  run('powershell', args)
  const zipPath = path.join(root, 'release/agent-ai-admin-v1.2.3.zip'), bytes = fs.readFileSync(zipPath), zip = new AdmZip(bytes)
  assert(zip.getEntry('src/tracked.mjs')); assert(zip.getEntry('web/styles/admin.css'))
  assert.equal(zip.getEntry('.env'), null); assert.equal(zip.getEntry('src/untracked-private.json'), null)
  fs.unlinkSync(path.join(root, 'web/styles/admin.css'))
  assert.throws(() => run('powershell', args))
  assert.deepEqual(fs.readFileSync(zipPath), bytes)
})
