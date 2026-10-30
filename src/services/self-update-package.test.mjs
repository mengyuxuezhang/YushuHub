import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { validateSelfUpdateArchive, validateSelfUpdatePackage } from './self-update-package.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yushu-update-package-'))
  t.after(async () => {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'yushu-update-package-'))
    await fs.rm(root, { recursive: true, force: true })
  })
  const files = {
    'package.json': JSON.stringify({ name: 'agent-ai-admin', version: '1.2.3' }),
    'package-lock.json': JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } }),
    'cloud/ai-admin/server.mjs': "import '../../src/helper.mjs'",
    'src/helper.mjs': "throw new Error('Candidate code must never execute during inspection')",
    'web/index.html': '<html></html>', 'web/site/index.html': '<html></html>', 'web/styles/admin.css': 'body{}',
    'web/js/admin.js': "import './views/organizations.js'", 'web/js/views/organizations.js': 'export {}',
    'web/admin-v2/index.html': '<script src="/admin/v2/assets/app.js"></script><link href="/admin/v2/assets/app.css">',
    'web/admin-v2/assets/app.js': 'export {}', 'web/admin-v2/assets/app.css': 'body{}',
  }
  for (const [name, body] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), body) }
  return root
}

test('update package preflight reads the startup graph and frontend assets without running candidate code', async t => {
  const root = await fixture(t), result = await validateSelfUpdatePackage(root, { expectedVersion: '1.2.3' })
  assert.equal(result.version, '1.2.3'); assert.equal(result.frontendAssets, 2); assert(result.inspectedFiles >= 12)
})
test('incomplete update package is refused before installed application files need replacing', async t => {
  const root = await fixture(t)
  await fs.unlink(path.join(root, 'web/styles/admin.css'))
  await assert.rejects(validateSelfUpdatePackage(root), /缺少必要文件/)
  assert.equal(await fs.readFile(path.join(root, 'package.json'), 'utf8'), JSON.stringify({ name: 'agent-ai-admin', version: '1.2.3' }))
})
test('preflight follows reexports and refuses missing module and fingerprint targets', async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'src/helper.mjs'), "export { value } from './missing.mjs'")
  await assert.rejects(validateSelfUpdatePackage(root), /缺少必要文件/)
  await fs.writeFile(path.join(root, 'src/helper.mjs'), 'export {}')
  await fs.unlink(path.join(root, 'web/admin-v2/assets/app.js'))
  await assert.rejects(validateSelfUpdatePackage(root), /缺少必要文件/)
})
test('preflight rejects version drift and module traversal outside the extracted application', async t => {
  const root = await fixture(t)
  await assert.rejects(validateSelfUpdatePackage(root, { expectedVersion: '1.2.4' }), /版本/)
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version: '1.2.4', packages: { '': { version: '1.2.4' } } }))
  await assert.rejects(validateSelfUpdatePackage(root), /锁文件版本/)
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } }))
  await fs.writeFile(path.join(root, 'src/helper.mjs'), "import '../../outside-package.mjs'")
  await assert.rejects(validateSelfUpdatePackage(root), /超出应用目录/)
})
test('preflight refuses a linked startup dependency instead of reading a substitute file', async t => {
  const root = await fixture(t), helper = path.join(root, 'src/helper.mjs')
  await fs.unlink(helper)
  try { await fs.symlink(path.join(root, 'web/js/views/organizations.js'), helper, 'file') }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('OS does not allow test symlink creation'); throw error }
  await assert.rejects(validateSelfUpdatePackage(root), /符号链接/)
})
test('update package cannot carry deployment credentials or overwrite persistent business data', async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, '.env'), 'AI_ADMIN_PASSWORD=fictional-test-only')
  await assert.rejects(validateSelfUpdatePackage(root), /不能覆盖部署配置/)
  await fs.unlink(path.join(root, '.env'))
  await fs.mkdir(path.join(root, 'data'))
  await fs.writeFile(path.join(root, 'data/preserved.txt'), 'fictional business record')
  await assert.rejects(validateSelfUpdatePackage(root), /业务数据/)
  assert.equal(await fs.readFile(path.join(root, 'data/preserved.txt'), 'utf8'), 'fictional business record')
})
test('archive paths and link entries are rejected before extraction can touch any installed files', async t => {
  const root = await fixture(t), file = path.join(root, 'candidate.zip'), normal = new AdmZip()
  normal.addFile('package.json', Buffer.from('{}')); normal.writeZip(file)
  assert.equal((await validateSelfUpdateArchive(file)).inspectedEntries, 1)
  for (const entries of [
    [['../outside.txt', 0]], [['/outside.txt', 0]], [['C:/outside.txt', 0]], [['.env', 0]], [['data/customer.txt', 0]],
    [['src/linked.mjs', (0o120777 << 16) >>> 0]], [['src/Thing.mjs', 0], ['src/thing.mjs', 0]],
  ]) {
    const zip = new AdmZip()
    for (const [index, [name, attr]] of entries.entries()) {
      const original = `entry-${index}`; zip.addFile(original, Buffer.from('fictional archive test'))
      const entry = zip.getEntry(original); entry.entryName = name; entry.attr = attr
    }
    zip.writeZip(file)
    await assert.rejects(validateSelfUpdateArchive(file), /更新包/)
  }
})
