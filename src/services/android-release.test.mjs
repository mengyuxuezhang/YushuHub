import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAndroidArtifactPublisher, createAndroidReleaseStarter } from './android-release.mjs'

test('publishing Android requires both matching artifacts and leaves the desktop release untouched', async () => {
  const row = { id: 'build', status: 'succeeded', releasedAt: null, publicUrl: 'https://example.test/preview/',
    files: ['desktop.exe', 'latest.yml', 'android-demo-arm64.apk', 'android-demo-source.zip', 'android-demo-update.json'] }
  let pending
  let completed
  const done = new Promise(resolve => { completed = resolve })
  const starter = createAndroidReleaseStarter({
    authorize: async () => {},
    begin: async (id, state) => { assert.equal(id, row.id); if (pending) return false; pending = state; return true },
    finish: async (id, attempt, state) => { assert.equal(attempt, pending.attempt); completed(state) },
    readBuild: async () => row,
    publish: async (build, files) => {
      assert.equal(build, row)
      assert.deepEqual(files, ['android-demo-arm64.apk', 'android-demo-source.zip', 'android-demo-update.json'])
      return { url: 'https://example.test/android/build/', version: '0.1.3', versionCode: 11190123, size: 8192, sha256: 'a'.repeat(64) }
    },
    log: async () => {},
  })
  await assert.rejects(starter({ ...row, files: row.files.filter(name => !name.endsWith('-source.zip')) }), /对应源码/)
  await assert.rejects(starter({ ...row, files: row.files.slice(0, -1) }), /对应源码/)
  assert.equal(await starter(row), row)
  await starter(row)
  const result = await done
  assert.equal(result.status, 'published')
  assert.equal(row.releasedAt, null)
})

test('local Android publication checks APK contents and preserves the existing immutable release', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'test-android-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const publicRoot = path.join(root, 'public')
  const names = ['android-demo-arm64.apk', 'android-demo-source.zip', 'android-demo-update.json']
  const files = { [names[0]]: 'a demo APK', [names[1]]: 'matching demo source' }
  const sha256 = createHash('sha256').update(files[names[0]]).digest('hex')
  const metadata = { version: '0.1.3', versionCode: 11190123, size: files[names[0]].length, sha256 }
  files[names[2]] = JSON.stringify(metadata)
  const publish = createAndroidArtifactPublisher({
    readSettings: async () => ({ artifactStorageMode: 'local' }), readOssConfig: () => ({}),
    publicRoot, publicBaseUrl: 'https://example.test/updates/ai/', temporary: path.join(root, 'staging'),
    copyBuildFile: async (_build, file, target) => writeFile(path.join(target, file), files[file]),
    canAccessFile: async () => true,
  })
  const build = { id: 'demo', projectId: 'brand' }
  const release = await publish(build, names)
  assert.deepEqual(release, { ...metadata, url: 'https://example.test/updates/ai/android/brand/demo/' })
  const target = path.join(publicRoot, 'android', 'brand', 'demo')
  assert.deepEqual((await readdir(target)).sort(), ['android-arm64.apk', 'android-source.zip'])
  assert.deepEqual(await publish(build, names), release)
  files[names[0]] = 'another demo APK'
  await assert.rejects(publish(build, names), /APK 校验失败/)
  assert.equal(await readFile(path.join(target, 'android-arm64.apk'), 'utf8'), 'a demo APK')
})

test('shared Android source publication stores only APK and branding together', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'test-android-shared-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const names = ['android-demo-arm64.apk', 'android-demo-brand.zip', 'android-demo-update.json']
  const apk = 'demo signed APK'
  const brand = 'small brand archive'
  const sourceRevision = 'b'.repeat(40)
  const build = { id: 'demo', projectId: 'brand', target: 'android', version: '0.1.5', sourceRevision }
  const sha = value => createHash('sha256').update(value).digest('hex')
  const metadata = { version: '0.1.5', versionCode: 11230123, size: apk.length,
    sha256: sha(apk), sourceRevision, brandSha256: sha(brand) }
  const payload = { [names[0]]: apk, [names[1]]: brand, [names[2]]: JSON.stringify(metadata) }
  const publicRoot = path.join(root, 'public')
  const uploads = []
  let available = true
  let storage = 'local'
  const publish = createAndroidArtifactPublisher({
    readSettings: async () => ({ artifactStorageMode: storage }),
    readOssConfig: () => ({ enabled: true, prefix: 'releases', publicBaseUrl: 'https://cdn.example.test' }),
    publicRoot, publicBaseUrl: 'https://example.test/updates/ai/', temporary: path.join(root, 'staging'),
    copyBuildFile: async (_build, file, target) => writeFile(path.join(target, file), payload[file]),
    canAccessFile: async () => true,
    uploadFile: async (_oss, filename, key) => uploads.push([key, await readFile(filename, 'utf8')]),
    sourceRepository: 'example/mobile',
    sourceAvailable: async (url) => {
      assert.equal(url, 'https://codeload.github.com/example/mobile/zip/' + sourceRevision)
      return available
    },
  })
  const local = await publish(build, names)
  assert.equal(local.sourceRepository, 'example/mobile')
  assert.equal(local.sourceRevision, sourceRevision)
  assert.deepEqual((await readdir(path.join(publicRoot, 'android', 'brand', 'demo'))).sort(), ['android-arm64.apk', 'android-brand.zip'])
  storage = 'oss'
  const oss = await publish(build, names)
  assert.equal(oss.url, 'https://cdn.example.test/releases/ai/android/brand/demo/')
  assert.deepEqual(uploads, [
    ['releases/ai/android/brand/demo/android-arm64.apk', apk],
    ['releases/ai/android/brand/demo/android-brand.zip', brand],
  ])
  uploads.length = 0
  await assert.rejects(publish({ ...build, sourceRevision: 'c'.repeat(40) }, names), /校验信息无效/)
  available = false
  await assert.rejects(publish(build, names), /尚未在公开 GitHub 仓库提供/)
  available = true
  payload[names[1]] = 'different brand archive'
  await assert.rejects(publish(build, names), /品牌配置包校验失败/)
  assert.deepEqual(uploads, [])
})
