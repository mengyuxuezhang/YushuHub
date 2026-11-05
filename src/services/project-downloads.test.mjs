import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectDownloadService, normalizeLatestDownloadFileName, projectDownloadInfo, releasedInstallerUrl } from './project-downloads.mjs'

const released = (file = 'brand-desktop-3.0.83-x64.exe') => ({ status: 'succeeded', releaseStatus: '', releasedAt: '2026-01-01', releaseUrl: 'https://cdn.example.test/releases/brand/', files: ['latest.yml', 'latest.json', file, `${file}.blockmap`] })

test('config accepts a reserved configurable alias and clearing; rejects paths, versions and malformed values', () => {
  assert.equal(normalizeLatestDownloadFileName(' brand-desktop-latest-x64.exe '), 'brand-desktop-latest-x64.exe')
  for (const value of ['', ' ', null, undefined]) assert.equal(normalizeLatestDownloadFileName(value), '')
  for (const value of ['../latest-x64.exe', 'https://x/latest-x64.exe', 'v3.0.83-x64.exe', 'bad/latest-x64.exe', 'bad\\latest-x64.exe', 'x\r\n-latest-x64.exe', 'x-latest-x64.exe?x', 'x'.repeat(128) + '-latest-x64.exe', {}, 12]) {
    assert.throws(() => normalizeLatestDownloadFileName(value))
  }
})

test('project URLs use the management host, including OSS-backed releases; blank disables the entry', () => {
  const project = { id: 'brand', latestDownloadFileName: 'brand-latest-x64.exe' }
  assert.equal(projectDownloadInfo(project, 'https://admin.example.test/').latestDownloadUrl, 'https://admin.example.test/updates/ai/brand/brand-latest-x64.exe')
  assert.equal(projectDownloadInfo({ ...project, latestDownloadFileName: '' }, 'https://admin.example.test').latestDownloadUrl, '')
})

test('release resolver selects x64, encodes filenames and supports configured external storage', () => {
  assert.equal(releasedInstallerUrl(released()), 'https://cdn.example.test/releases/brand/brand-desktop-3.0.83-x64.exe')
  assert.equal(releasedInstallerUrl(released('Brand Setup.exe')), 'https://cdn.example.test/releases/brand/Brand%20Setup.exe')
  assert.equal(releasedInstallerUrl({ ...released(), files: JSON.stringify(released().files) }), releasedInstallerUrl(released()))
  assert.equal(releasedInstallerUrl({ ...released(), files: ['brand-arm64.exe', 'brand-x64.exe'] }), 'https://cdn.example.test/releases/brand/brand-x64.exe')
  assert.equal(releasedInstallerUrl({ ...released(), files: ['brand-arm64.exe'] }), null)
})

test('unpublished, failed, publishing, ambiguous and unsafe artifacts never redirect', () => {
  for (const release of [null, { ...released(), releasedAt: null }, { ...released(), status: 'failed' }, { ...released(), releaseStatus: 'publishing' }, { ...released(), releaseStatus: 'failed' }, { ...released(), files: '{' }, { ...released(), files: ['../bad.exe'] }, { ...released(), files: ['brand-latest-x64.exe'] }, { ...released(), files: ['one.exe', 'two.exe'] }, { ...released(), files: ['a-x64.exe', 'b-x64.exe'] }]) assert.equal(releasedInstallerUrl(release), null)
  for (const releaseUrl of ['javascript:bad', 'https://user:secret@example.test/', 'https://cdn.example.test/?x', 'https://cdn.example.test/#x']) assert.equal(releasedInstallerUrl({ ...released(), releaseUrl }), null)
})

test('the same alias follows subsequent successful publications without caching; rename, disable and cross-project requests fail', async () => {
  let project = { id: 'brand', status: 'enabled', latestDownloadFileName: 'brand-latest-x64.exe' }
  let release = released()
  let lookups = 0
  const service = createProjectDownloadService({ findProject: async id => id === project.id ? project : null, findLatestRelease: async id => { assert.equal(id, 'brand'); lookups++; return release } })
  assert.match(await service.resolve('brand', 'brand-latest-x64.exe'), /3\.0\.83/)
  release = released('brand-desktop-3.0.84-x64.exe')
  assert.match(await service.resolve('brand', 'brand-latest-x64.exe'), /3\.0\.84/)
  assert.equal(await service.resolve('other-brand', 'brand-latest-x64.exe'), null)
  assert.equal(await service.resolve('../brand', 'brand-latest-x64.exe'), null)
  assert.equal(await service.resolve('brand', 'other-latest-x64.exe'), null)
  project = { ...project, status: 'disabled' }
  assert.equal(await service.resolve('brand', 'brand-latest-x64.exe'), null)
  project = { ...project, status: 'enabled', latestDownloadFileName: '' }
  assert.equal(await service.resolve('brand', 'brand-latest-x64.exe'), null)
  assert.equal(lookups, 2)
})
