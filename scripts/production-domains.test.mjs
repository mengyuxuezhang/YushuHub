import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('official distribution defaults use the OKPA production domains', () => {
  const expected = {
    'scripts/pack-zip.ps1': 'https://updates.okpa.cn/agent/ai-admin',
    'scripts/install-agent-ai.sh': 'https://center.okpa.cn',
    'scripts/install-local.sh': 'https://updates.okpa.cn/agent/next-source/latest.json',
    'scripts/install-wizard.mjs': 'https://assets.okpa.cn/upload',
    '.env.example': 'https://updates.okpa.cn/agent/ai-admin/latest.json',
    'src/config/env.mjs': 'https://updates.okpa.cn/agent/next-source/latest.json',
  }

  for (const [file, value] of Object.entries(expected)) {
    assert.match(read(file), new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${file} should contain ${value}`)
  }
})

test('new installations no longer default to the legacy IP or image host', () => {
  const activeDefaults = [
    'scripts/pack-zip.ps1',
    'scripts/install-agent-ai.sh',
    'scripts/install-local.sh',
    'scripts/install-wizard.mjs',
    '.env.example',
    'src/config/env.mjs',
  ].map(read).join('\n')

  assert.doesNotMatch(activeDefaults, /http:\/\/8\.147\.134\.68/)
  assert.doesNotMatch(activeDefaults, /https:\/\/img\.mengyunet\.cn\/upload/)
})

test('tracked nginx config keeps center dynamic and updates read-only', () => {
  const nginx = read('deploy/nginx/okpa-production.conf')
  assert.match(nginx, /server_name center\.okpa\.cn/)
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:7077/)
  assert.match(nginx, /server_name updates\.okpa\.cn/)
  assert.match(nginx, /alias \/www\/wwwroot\/agent-update\//)
  assert.match(nginx, /limit_except GET HEAD/)
  assert.match(nginx, /server_name assets\.okpa\.cn/)
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:23456/)
  assert.match(nginx, /sub_filter "https:\/\/img\.mengyunet\.cn" "https:\/\/assets\.okpa\.cn"/)
})
