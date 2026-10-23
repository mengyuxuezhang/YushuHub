import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-curated-admin-'))
process.env.AI_CURATED_SKILL_ROOT = path.join(tempRoot, 'packages')
process.env.AI_CURATED_SKILL_KEK_PATH = path.join(tempRoot, 'market.key')
process.env.AI_CURATED_SKILL_SIGNING_PRIVATE_PATH = path.join(tempRoot, 'signing-private.pem')
process.env.AI_CURATED_SKILL_SIGNING_PUBLIC_PATH = path.join(tempRoot, 'signing-public.pem')
const service = await import('./curated-skills.mjs')
const { registerCuratedSkillRoutes } = await import('../routes/curated-skills.mjs')
const { setPool } = await import('../db/pool.mjs')
const { PUBLIC_ADMIN_BASE_URL } = await import('../config/env.mjs')

function packageZip(files) {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content))
  return zip.toBuffer()
}

test('protected package is encrypted, signed and decryptable only with wrapped DEK', async () => {
  const plaintext = packageZip({ 'SKILL.md': '---\nname: secret\ndescription: secret workflow\n---\nTOP-SECRET-INSTRUCTION', 'references/guide.md': 'private guide' })
  const result = await service.buildPublishedPackage({
    skill: { id: 'official-secret', name: '官方保护技能', description: '受保护流程', distribution_type: 'protected' },
    version: { version: '1.0.0', min_desktop_version: '1.0.94' }, zipBuffer: plaintext,
  })
  const ciphertext = await fs.readFile(result.packagePath)
  assert.equal(ciphertext.includes(Buffer.from('TOP-SECRET-INSTRUCTION')), false)
  const { signature, ...unsigned } = result.manifest
  const publicKey = await service.getSigningPublicKeyPem()
  assert.equal(crypto.verify(null, Buffer.from(service.canonicalJson(unsigned)), publicKey, Buffer.from(signature, 'base64')), true)
  const dek = await service.unwrapDek(result.encryptedDek)
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, Buffer.from(result.manifest.encryption.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(result.manifest.encryption.authTag, 'base64'))
  assert.deepEqual(Buffer.concat([decipher.update(ciphertext), decipher.final()]), plaintext)
})

test('protected package rejects executable files and traversal paths', () => {
  assert.throws(() => service.inspectSkillZip(packageZip({ 'SKILL.md': 'ok', 'scripts/run.js': 'bad' }), 'protected'), /只允许/)
  assert.throws(() => service.safeEntryName('../SKILL.md'), /不安全路径/)
})

test('published public package can be verified from center and imported with a local signature', async () => {
  const plaintext = packageZip({ 'SKILL.md': '---\nname: public-skill\ndescription: public workflow\n---\n# Public' })
  const skill = { id: 'official-public', name: '官方公开技能', description: '公开流程', distribution_type: 'public' }
  const version = { version: '2.1.0', min_desktop_version: '1.0.95' }
  const publicKey = await service.getSigningPublicKeyPem()
  const published = await service.buildPublishedPackage({ skill, version, zipBuffer: plaintext })
  const imported = await service.importPublishedPackage({
    skill,
    version,
    packageBuffer: await fs.readFile(published.packagePath),
    remoteManifest: published.manifest,
    remotePublicKey: publicKey,
  })
  assert.deepEqual(await fs.readFile(imported.packagePath), plaintext)
  const { signature, ...unsigned } = imported.manifest
  assert.equal(crypto.verify(null, Buffer.from(service.canonicalJson(unsigned)), await service.getSigningPublicKeyPem(), Buffer.from(signature, 'base64')), true)
  await assert.rejects(() => service.importPublishedPackage({
    skill,
    version,
    packageBuffer: Buffer.from('tampered'),
    remoteManifest: published.manifest,
    remotePublicKey: publicKey,
  }), /哈希校验失败/)
})

test('skill catalog exports a public cover and first sync preserves it with the signed package', async () => {
  const skill = { id: 'image-skill', name: '封面技能', description: '图片同步', distribution_type: 'public', cover_url: '/uploads/admin/skill.png', status: 'published' }
  const published = await service.buildPublishedPackage({
    skill, version: { version: '1.0.0' }, zipBuffer: packageZip({ 'SKILL.md': '# Image sync' }),
  })
  const routes = new Map()
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (route, ...handlers) => routes.set(`${method} ${route}`, handlers.at(-1))]))
  registerCuratedSkillRoutes(app, { centerMode: true })
  setPool({ async query(sql) {
    if (sql.startsWith('SELECT s.*, v.id')) return [[{ ...skill, version: '1.0.0', manifest_json: JSON.stringify(published.manifest) }]]
    if (sql.startsWith('SELECT market_type')) return [[{ market_type: 'personal' }]]
    throw new Error(`Unexpected query: ${sql}`)
  } })
  const res = { json(body) { this.body = body } }
  await routes.get('post /api/center/curated-skills/catalog')({ centerSupplier: { id: 'supplier-a' } }, res, (error) => { throw error })
  const catalog = res.body.data
  const expectedCover = `${PUBLIC_ADMIN_BASE_URL}/uploads/admin/skill.png`
  assert.equal(catalog.items[0].coverUrl, expectedCover)
  assert.equal(catalog.signingPublicKey, await service.getSigningPublicKeyPem())

  let persistedCover
  setPool({ async query(sql, params) {
    if (sql.startsWith('SELECT s.id, s.name') || sql.startsWith('SELECT * FROM ai_curated_skills') || sql.includes('SELECT DISTINCT o.legacy_owner_user_id')) return [[]]
    if (sql.startsWith('SELECT id FROM ai_curated_skills')) return [[{ id: skill.id }]]
    if (sql.startsWith('INSERT INTO ai_curated_skills')) { persistedCover = params[6]; return [{ affectedRows: 1 }] }
    if (sql.startsWith('INSERT INTO ai_curated_skill_') || sql.startsWith('INSERT IGNORE INTO ai_curated_skill_distributions') || sql.startsWith('UPDATE ai_curated_skill_')) return [{ affectedRows: 1 }]
    throw new Error(`Unexpected query: ${sql}`)
  } })
  const { syncCenterSkills } = registerCuratedSkillRoutes(app, {
    fetchCenterCatalog: async () => catalog,
    fetchCenterPackage: async () => ({ packageBuffer: await fs.readFile(published.packagePath), manifest: published.manifest }),
  })
  assert.deepEqual(await syncCenterSkills('admin'), { added: 1, updated: 0, removed: 0, skipped: 0, failed: [] })
  assert.equal(persistedCover, expectedCover)
})

test.after(async () => { await fs.rm(tempRoot, { recursive: true, force: true }) })
