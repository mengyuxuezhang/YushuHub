import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(process.cwd(), 'cloud/ai-admin/server.mjs'), 'utf8')

// The registration-code endpoint once crashed at runtime with
// "assertProjectAllowsSelfRegistration is not defined" after the enterprise
// retirement refactor dropped the helper but kept the call site. Syntax-only
// gates cannot catch that class of bug, so guard it statically here.
test('registration code flow no longer references removed helpers', () => {
  assert.equal(source.includes('assertProjectAllowsSelfRegistration'), false)
})

test('SMTP settings validation keeps a readable Chinese error message', () => {
  assert.equal(source.includes('邮件服务的 SMTP Host、端口、账号、密码和发件邮箱必须填写完整'), true)
  assert.equal(source.includes('閭欢鏈嶅姟'), false)
})

test('central worker claims prepare the normalized project staging directory', () => {
  assert.equal(source.includes("ensureWorkerStagingDirectory({ rootDir: PUBLIC_PREVIEW_ROOT, projectId: build.projectId })"), true)
  assert.equal(source.includes('projectId: build.project_id'), false)
})

test('server.mjs does not call bare functions that are never defined or imported', () => {
  const defined = new Set()
  for (const match of source.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) defined.add(match[1])
  for (const match of source.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(match[1])
  for (const match of source.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+\{([^}]+)\}\s*=/g)) {
    for (const item of match[1].split(',')) defined.add(item.trim().split(/\s*:\s*/).pop().trim())
  }
  for (const match of source.matchAll(/(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g)) defined.add(match[1])
  for (const match of source.matchAll(/import\s+\{([^}]+)\}\s+from/g)) {
    for (const item of match[1].split(',')) defined.add(item.trim().split(/\s+as\s+/).pop().trim())
  }
  const globals = new Set([
    'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask',
    'URL', 'URLSearchParams', 'AbortController', 'Blob', 'Buffer', 'process', 'console',
    'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Promise',
    'Map', 'Set', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Symbol', 'BigInt', 'Intl',
    'crypto', 'performance', 'structuredClone', 'resolve', 'reject', 'onProgress',
  ])
  const offenders = new Set()
  for (const match of source.matchAll(/(?<![\w$.])await\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1]
    if (globals.has(name) || defined.has(name)) continue
    offenders.add(name)
  }
  assert.deepEqual([...offenders].sort(), [])
})
