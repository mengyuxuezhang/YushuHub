import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStatusColumns, compactBuildStatus } from './build-status-view.mjs'
import { remoteBuildMetadataPatch } from './build-record-sync.mjs'

test('multi-megabyte branding is omitted while status, logs and artifact integrity metadata survive', () => {
  const asset = 'data:image/png;base64,' + 'a'.repeat(1_900_000)
  const original = { id: 'test-build', status: 'failed', error: 'compiler failed', claimedBy: 'test-worker', log: 'l'.repeat(110_000), files: [{ name: 'setup.exe', sha256: 'digest' }], brand: { iconUrl: asset, logoUrl: asset, loginLogoUrl: asset, sourceBuildId: 'local', sourceProjectId: 'project', clientMode: 'personal' } }
  const compact = compactBuildStatus(original)
  assert(Buffer.byteLength(JSON.stringify(original)) > 5_700_000)
  assert(Buffer.byteLength(JSON.stringify(compact)) < 111_000)
  assert.equal(compact.brandMetadataOnly, true)
  assert.equal(compact.status, original.status)
  assert.equal(compact.error, original.error)
  assert.equal(compact.log, original.log)
  assert.deepEqual(compact.files, original.files)
  assert.equal(compact.brand.sourceProjectId, 'project')
  assert.equal(original.brand.logoUrl, asset)
})

test('status SQL projects known metadata instead of selecting the entire brand', () => {
  const sql = buildStatusColumns('b.')
  assert(sql.startsWith('b.id, b.project_id'))
  assert(!sql.includes('b.*'))
  assert(sql.includes('JSON_OBJECT('))
  assert(sql.includes("JSON_EXTRACT(b.brand_json, '$.sourceProjectId')"))
  assert(!sql.includes('logoUrl'))
  assert.throws(() => buildStatusColumns('untrusted;'))
})

test('metadata-only refresh does not rewrite a complete local brand or discard its images', () => {
  const local = { version: '3.0.82', brand: { clientMode: 'personal', logoUrl: 'original-image' } }
  const remote = { version: '3.0.82', brandMetadataOnly: true, brand: { clientMode: 'personal', sourceProjectId: 'project' } }
  assert.deepEqual(remoteBuildMetadataPatch(local, remote), {})
  const patch = remoteBuildMetadataPatch({ ...local, brandMetadataMissing: true }, remote)
  assert.equal(patch.brand.logoUrl, 'original-image')
  assert.equal(patch.brand.sourceProjectId, 'project')
  assert.equal(remoteBuildMetadataPatch(local, { ...remote, version: '3.0.83' }).version, '3.0.83')
})
