import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerProjectDownloadRoutes } from './project-downloads.mjs'
import { createProjectDownloadService } from '../services/project-downloads.mjs'

test('public GET/HEAD alias redirects to the current formal release without auth or cache; normal files still reach static serving', async t => {
  let file = 'brand-3.0.83-x64.exe'
  const downloads = createProjectDownloadService({
    findProject: async id => id === 'brand' ? { status: 'enabled', latestDownloadFileName: 'brand-latest-x64.exe' } : null,
    findLatestRelease: async () => ({ status: 'succeeded', releaseStatus: '', releasedAt: '2026-01-01', releaseUrl: 'https://cdn.example.test/brand/', files: [file] }),
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
})
