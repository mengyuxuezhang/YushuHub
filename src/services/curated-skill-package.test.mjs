import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import { resolveCuratedSkillPackage, sendCuratedSkillPackage } from './curated-skill-package.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-package-path-'))
test.after(() => fs.rm(root, { recursive: true, force: true }))
const bytes = Buffer.from('signed package bytes')
const digest = crypto.createHash('sha256').update(bytes).digest('hex')
const row = { skill_id: 'skill-a', version: '1.0.0', package_path: '/retired/app/data/curated-skills/skill-a/1.0.0/package.zip', package_sha256: digest }
const file = path.join(root, 'skill-a/1.0.0/package.zip')
await fs.mkdir(path.dirname(file), { recursive: true })
await fs.writeFile(file, bytes)

test('uses an existing stored package without changing records', async () => {
  assert.equal(await resolveCuratedSkillPackage({ ...row, package_path: file }), path.resolve(file))
})

test('recovers moved packages by identity and hash, including protected and Windows paths', async () => {
  assert.equal(await resolveCuratedSkillPackage(row, root), await fs.realpath(file))
  assert.equal(await resolveCuratedSkillPackage({ ...row, package_path: 'Z:\\retired\\package.zip' }, root), await fs.realpath(file))
  const protectedFile = path.join(path.dirname(file), 'package.enc')
  await fs.writeFile(protectedFile, bytes)
  assert.equal(await resolveCuratedSkillPackage({ ...row, package_path: '/retired/package.enc', package_sha256: '', manifest_json: JSON.stringify({ encryptedPackageSha256: digest, distributionType: 'protected' }) }, root), await fs.realpath(protectedFile))
})

test('rejects absent, mismatched, unverified and traversal recovery candidates', async () => {
  for (const change of [{ package_sha256: '0'.repeat(64) }, { package_sha256: '' }, { skill_id: '../escape' }, { version: '../escape' }, { package_path: '/old/.env' }, { skill_id: 'missing' }]) {
    await assert.rejects(resolveCuratedSkillPackage({ ...row, ...change }, root))
  }
})

test('rejects fallback symlinks escaping the configured root', async t => {
  const outside = path.join(root, 'outside.zip')
  await fs.writeFile(outside, bytes)
  const bounded = path.join(root, 'bounded')
  const link = path.join(bounded, 'skill-a/1.0.0')
  await fs.mkdir(link, { recursive: true })
  try { await fs.symlink(outside, path.join(link, 'package.zip')) }
  catch (error) { if (error.code === 'EPERM') { t.skip('symlink permission unavailable'); return }; throw error }
  await assert.rejects(resolveCuratedSkillPackage(row, bounded), { code: 'PACKAGE_INTEGRITY' })
})

test('real HTTP downloads retain bytes/manifest, and missing packages return JSON without crashing', async t => {
  const app = express()
  app.get('/ok', (_req, res) => sendCuratedSkillPackage(res, { ...row, package_path: file, manifest_json: '{"skillId":"skill-a"}' }))
  app.get('/missing', (_req, res) => sendCuratedSkillPackage(res, { ...row, skill_id: 'missing-skill' }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}`
  for (const endpoint of ['/missing', '/ok', '/missing', '/ok']) {
    const response = await fetch(base + endpoint)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    if (endpoint === '/ok') {
      assert.equal(response.status, 200)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
      assert.deepEqual(JSON.parse(Buffer.from(response.headers.get('x-agent-skill-manifest'), 'base64')), { skillId: 'skill-a' })
    } else {
      assert.equal(response.status, 404)
      assert.equal((await response.json()).success, false)
      assert.equal(response.headers.get('x-agent-skill-manifest'), null)
    }
  }
})

test('handles sendFile open races and mid-stream errors without unhandled stream events', async () => {
  for (const headersSent of [false, true]) {
    const response = { headersSent, destroyed: false, removeHeader() {}, setHeader() {},
      status(code) { this.code = code; return this }, json(body) { this.body = body },
      destroy() { this.destroyed = true },
      sendFile(_file, _options, callback) { callback(Object.assign(new Error('open failed'), { code: 'ENOENT' })) },
    }
    await sendCuratedSkillPackage(response, { ...row, package_path: file })
    if (headersSent) assert.equal(response.destroyed, true)
    else { assert.equal(response.code, 404); assert.equal(response.body.success, false) }
  }
})
