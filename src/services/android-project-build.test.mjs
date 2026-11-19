import test from 'node:test'
import assert from 'node:assert/strict'
import { projectDownloadInfo } from './project-downloads.mjs'

const project = { id: 'brand-two', status: 'enabled', appName: '品牌移动助手', themeColor: '#0E776D', internalSecret: 'private' }

test('exports Android build inputs from an enabled project and the configured HTTPS API host', () => {
  assert.deepEqual(projectDownloadInfo(project, 'https://admin.example.test/partner/').androidBuild, {
    schema: 'agent-mobile-build-v1', projectId: 'brand-two', appName: '品牌移动助手',
    clientApiUrl: 'https://admin.example.test/partner/api/', themeColor: '#0E776D',
  })
  assert.equal(projectDownloadInfo(project, 'https://admin.example.test/api').androidBuild.clientApiUrl,
    'https://admin.example.test/api/')
})

test('never exports disabled projects or an unsafe API endpoint', () => {
  assert.equal(projectDownloadInfo({ ...project, status: 'disabled' }, 'https://admin.example.test').androidBuild, null)
  for (const url of ['http://admin.example.test', 'https://user:password@admin.example.test', 'https://admin.example.test/?x=1']) {
    assert.equal(projectDownloadInfo(project, url).androidBuild, null)
  }
})
