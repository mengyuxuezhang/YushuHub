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
