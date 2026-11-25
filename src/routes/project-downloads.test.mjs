import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { desktopUpdatePaths, registerProjectDownloadRoutes } from './project-downloads.mjs'
import { createProjectDownloadService, desktopUpdateBaseUrl } from '../services/project-downloads.mjs'

test('public GET/HEAD alias redirects to the current formal release without auth or cache; normal files still reach static serving', async t => {
  let file = 'brand-3.0.83-x64.exe'
  let android = 'https://cdn.example.test/brand/android'
  let signed = null
  let pinned = null
  const downloads = createProjectDownloadService({
    findProject: async id => id === 'brand' ? {
      status: 'enabled', latestDownloadFileName: 'brand-latest-x64.exe',
      menus: [{ key: 'android-download', type: 'external', url: android, visible: true }],
    } : null,
    findLatestRelease: async () => ({ status: 'succeeded', releaseStatus: '', releasedAt: '2026-01-01', releaseUrl: 'https://cdn.example.test/brand/', files: [file] }),
    findLatestAndroidRelease: async () => signed,
    findPublishedAndroidRelease: async (project, id) => project === 'brand' && id === pinned?.buildId ? pinned : null,
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
  pinned = signed = { status: 'published', buildId: 'published-legacy', url: 'https://cdn.example.test/brand/build', version: '0.1.3',
    versionCode: 11191420, publishedAt: '2026-11-19T06:20:00.000Z', size: 8192, sha256: 'a'.repeat(64) }
  assert.deepEqual(await (await request('/api/client/android-download/brand')).json(), { available: true })
  const legacyPage = await (await request('/api/client/android-download/brand/file')).text()
  assert.match(legacyPage, /source\/published-legacy">对应版本源码与许可/)
  assert.match(legacyPage, /apk\/published-legacy/)
  assert.equal((await request('/api/client/android-download/brand/source/published-legacy')).headers.get('location'), 'https://cdn.example.test/brand/build/android-source.zip')
  assert.ok(legacyPage.includes('href="https://github.com/mengyuxuezhang/Agent-Mobile"'))
  assert.equal((await request('/api/client/android-download/brand/apk')).headers.get('location'), 'https://cdn.example.test/brand/build/android-arm64.apk')
  assert.equal((await request('/api/client/android-download/brand/source')).headers.get('location'), 'https://cdn.example.test/brand/build/android-source.zip')
  const manifest = await request('/api/client/android-download/brand/update.json')
  assert.match(manifest.headers.get('cache-control'), /no-store/)
  assert.deepEqual(await manifest.json(), { schema: 1, version: '0.1.3+11191420', tag: 'v0.1.3', publishedAt: signed.publishedAt,
    assets: { arm64: { name: 'android-arm64.apk', url: 'https://cdn.example.test/brand/build/android-arm64.apk', size: 8192, sha256: signed.sha256 } } })
  assert.equal((await request('/api/client/android-download/other/update.json')).status, 404)
  pinned = signed = { ...signed, buildId: 'published-one', sourceRepository: 'org/mobile', sourceRevision: 'b'.repeat(40) }
  const page = await (await request('/api/client/android-download/brand/file')).text()
  assert.match(page, /<small><a href="[^"]*source\/published-one">对应版本源码与许可/)
  assert.match(page, /apk\/published-one/)
  assert.ok(page.includes('href="https://github.com/org/mobile"'))
  signed = { ...signed, buildId: 'published-two', sourceRevision: 'c'.repeat(40) }
  const sourcePage = await (await request('/api/client/android-download/brand/source/published-one')).text()
  assert.ok(sourcePage.includes('https://github.com/org/mobile/tree/' + 'b'.repeat(40)))
  assert.ok(sourcePage.includes('https://cdn.example.test/brand/build/android-brand.zip'))
  assert.equal((await request('/api/client/android-download/brand/apk/published-one')).headers.get('location'), 'https://cdn.example.test/brand/build/android-arm64.apk')
  assert.equal((await request('/api/client/android-download/brand/source/wrong-build')).status, 404)
})

test('desktop and Android update URLs survive local, R2 and OSS releases and preserve versioned downloads', async t => {
  let desktop
  let android
  const releases = new Map()
  const app = express()
  const paths = desktopUpdatePaths('/old/downloads/')
  registerProjectDownloadRoutes(app, {
    desktopPaths: paths,
    downloads: createProjectDownloadService({
      findProject: async id => id === 'brand' ? { status: 'enabled' } : null,
      findLatestRelease: async () => desktop,
      findPublishedDesktopFile: async (_project, file) => releases.get(file),
      findLatestAndroidRelease: async () => android,
    }),
  })
  app.get('/updates/ai/brand/:fileName', (req, res) => res.send('local ' + req.params.fileName))
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const fixed = desktopUpdateBaseUrl(base, 'brand')
  const mobileFeed = `${base}/api/client/android-download/brand/update.json`
  const request = (url, method = 'GET') => fetch(url, { method, redirect: 'manual' })

  for (const [index, desktopLocation, androidLocation] of [
    [101, fixed, 'https://admin.example.com/updates/ai/android/brand/build-101/'],
    [102, 'https://test-bucket.r2.dev/ai/brand/', 'https://test-bucket.r2.dev/ai/android/brand/build-102/'],
    [103, 'https://test.oss.example.com/ai/brand/', 'https://test.oss.example.com/ai/android/brand/build-103/'],
    [104, fixed, 'https://admin.example.com/updates/ai/android/brand/build-104/'],
  ]) {
    const exe = `brand-desktop-3.0.${index}-x64.exe`
    const packageFiles = [exe, exe + '.blockmap']
    desktop = { status: 'succeeded', releasedAt: 'date', releaseUrl: desktopLocation, files: ['latest.yml', 'latest.json', ...packageFiles] }
    for (const file of packageFiles) releases.set(file, desktop)
    android = { status: 'published', version: `0.1.${index}`, versionCode: index, url: androidLocation, size: 50, sha256: 'a'.repeat(64) }
    for (const file of desktop.files) {
      const canonical = await request(fixed + file, file.endsWith('.blockmap') ? 'HEAD' : 'GET')
      assert.match(canonical.headers.get('cache-control'), /no-store/)
      if (desktopLocation === fixed) {
        assert.equal(canonical.status, 200)
      } else {
        assert.equal(canonical.status, 302)
        assert.equal(canonical.headers.get('location'), desktopLocation + file)
      }
      for (const legacy of ['/agent/ai/brand/', '/old/downloads/brand/']) {
        const result = await request(base + legacy + file)
        assert.equal(result.status, 302)
        assert.equal(result.headers.get('location'), desktopLocation + file)
      }
    }
    const manifest = await request(mobileFeed)
    assert.match(manifest.headers.get('cache-control'), /no-store/)
    const json = await manifest.json()
    assert.equal(json.version, `0.1.${index}+${index}`)
    assert.equal(json.assets.arm64.url, androidLocation + 'android-arm64.apk')
    const apk = await request(`${base}/api/client/android-download/brand/apk`, 'HEAD')
    assert.equal(apk.headers.get('location'), json.assets.arm64.url)
  }

  const inProgress = await request(fixed + 'brand-desktop-3.0.102-x64.exe.blockmap')
  assert.equal(inProgress.headers.get('location'), 'https://test-bucket.r2.dev/ai/brand/brand-desktop-3.0.102-x64.exe.blockmap')
})
