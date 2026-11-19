import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerProjectDownloadRoutes } from './project-downloads.mjs'
import { createProjectDownloadService } from '../services/project-downloads.mjs'

test('public GET/HEAD alias redirects to the current formal release without auth or cache; normal files still reach static serving', async t => {
  let file = 'brand-3.0.83-x64.exe'
  let android = 'https://cdn.example.test/brand/android'
  let signed = null
  const downloads = createProjectDownloadService({
    findProject: async id => id === 'brand' ? {
      status: 'enabled', latestDownloadFileName: 'brand-latest-x64.exe',
      menus: [{ key: 'android-download', type: 'external', url: android, visible: true }],
    } : null,
    findLatestRelease: async () => ({ status: 'succeeded', releaseStatus: '', releasedAt: '2026-01-01', releaseUrl: 'https://cdn.example.test/brand/', files: [file] }),
    findLatestAndroidRelease: async () => signed,
  })
  const app = express()
  registerProjectDownloadRoutes(app, { downloads })
  app.get('/updates/ai/:projectId/:fileName', (_req, res) => res.send('static artifact'))
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (path, method = 'GET') => fetch(`${base}${path}`, { method, redirect: 'manual' })
  for (const prefix of ['/updates/ai', '/agent/ai']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await request(`${prefix}/brand/brand-latest-x64.exe`, method)
      assert.equal(response.status, 302)
      assert.equal(response.headers.get('location'), 'https://cdn.example.test/brand/brand-3.0.83-x64.exe')
      assert.match(response.headers.get('cache-control'), /no-store/)
      if (method === 'HEAD') assert.equal(await response.text(), '')
    }
  }
  file = 'brand-3.0.84-x64.exe'
  assert.match((await request('/updates/ai/brand/brand-latest-x64.exe')).headers.get('location'), /3\.0\.84/)
  assert.equal(await (await request('/updates/ai/brand/brand-3.0.83-x64.exe')).text(), 'static artifact')
  for (const path of ['/updates/ai/brand/old-latest-x64.exe', '/updates/ai/other/brand-latest-x64.exe']) {
    const response = await request(path)
    assert.equal(response.status, 404)
    assert.match(response.headers.get('cache-control'), /no-store/)
    assert.equal(response.headers.get('location'), null)
  }
  file = ''
  assert.equal((await request('/updates/ai/brand/brand-latest-x64.exe')).status, 404)
  assert.deepEqual(await (await request('/api/client/android-download/brand')).json(), { available: true })
  const download = await request('/api/client/android-download/brand/file')
  assert.equal((await request('/api/client/android-download/brand/update.json')).status, 404)
  assert.equal(download.status, 302)
  assert.equal(download.headers.get('location'), android)
  assert.match(download.headers.get('cache-control'), /no-store/)
  android = 'https://cdn.example.test/brand/android/v2'
  assert.equal((await request('/api/client/android-download/brand/file')).headers.get('location'), android)
  android = 'http://cdn.example.test/brand/android'
  assert.deepEqual(await (await request('/api/client/android-download/brand')).json(), { available: false })
  assert.equal((await request('/api/client/android-download/brand/file')).status, 404)
  assert.equal((await request('/api/client/android-download/other/file')).status, 404)
  signed = { status: 'publishing', url: 'https://cdn.example.test/brand/build' }
  assert.deepEqual(await (await request('/api/client/android-download/brand')).json(), { available: false })
  signed = { status: 'published', url: 'https://cdn.example.test/brand/build', version: '0.1.3',
    versionCode: 11191420, publishedAt: '2026-11-19T06:20:00.000Z', size: 8192, sha256: 'a'.repeat(64) }
  assert.deepEqual(await (await request('/api/client/android-download/brand')).json(), { available: true })
  assert.match(await (await request('/api/client/android-download/brand/file')).text(), /下载对应源码/)
  assert.equal((await request('/api/client/android-download/brand/apk')).headers.get('location'), 'https://cdn.example.test/brand/build/android-arm64.apk')
  assert.equal((await request('/api/client/android-download/brand/source')).headers.get('location'), 'https://cdn.example.test/brand/build/android-source.zip')
  const manifest = await request('/api/client/android-download/brand/update.json')
  assert.match(manifest.headers.get('cache-control'), /no-store/)
  assert.deepEqual(await manifest.json(), { schema: 1, version: '0.1.3+11191420', tag: 'v0.1.3', publishedAt: signed.publishedAt,
    assets: { arm64: { name: 'android-arm64.apk', url: 'https://cdn.example.test/brand/build/android-arm64.apk', size: 8192, sha256: signed.sha256 } } })
  assert.equal((await request('/api/client/android-download/other/update.json')).status, 404)
})
