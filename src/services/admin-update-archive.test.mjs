import test from 'node:test'
import assert from 'node:assert/strict'
import AdmZip from 'adm-zip'
import { validateAdminUpdateArchive } from './admin-update-archive.mjs'

function archive() {
  const zip = new AdmZip()
  zip.addFile('package.json', Buffer.from(JSON.stringify({ name: 'agent-ai-admin', version: '1.9.62' })))
  zip.addFile('cloud/ai-admin/server.mjs', Buffer.from('fixture'))
  return zip
}
test('accepts application archives and refuses runtime state and secrets before extraction', () => {
  assert.equal(validateAdminUpdateArchive(archive().toBuffer()).version, '1.9.62')
  for (const name of ['.env', 'src/.env', 'data/secret.json', 'web/uploads/photo.png']) {
    const zip = archive(); zip.addFile(name, Buffer.from('fixture'))
    assert.throws(() => validateAdminUpdateArchive(zip.toBuffer()), /Unsupported application archive path/)
  }
})
test('rejects symlinks before unzip can traverse them', () => {
  const zip = archive(); zip.addFile('src/link', Buffer.from('/outside'))
  zip.getEntry('src/link').attr = (0xa1ff << 16) >>> 0
  assert.throws(() => validateAdminUpdateArchive(zip.toBuffer()), /link or special file/)
})
