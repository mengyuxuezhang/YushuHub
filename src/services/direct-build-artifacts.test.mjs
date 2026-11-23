import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { makeDirectUploadService, makeOssUploadGrant, makeR2UploadGrant, normalizeR2ReleaseConfig, putR2ReleaseObject,
  readBuildR2, sameBucketBuildPrefix, validateUploadGrant, validUploadFiles } from './direct-build-artifacts.mjs'

const build = { id: 'local-build', projectId: 'brand-one', target: 'android' }
const center = { ...build, id: 'center-build', centerSupplierId: 'supplier' }
const names = ['android-center-build-arm64.apk', 'android-center-build-brand.zip', 'android-center-build-update.json']
const files = names.map(name => ({
  name, size: Buffer.byteLength(name),
  sha256: createHash('sha256').update(name).digest('hex'), md5: createHash('md5').update(name).digest('base64'),
}))
const r2 = {
  endpoint: 'https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com',
  bucket: 'fixture-bucket', accessKeyId: 'fixturekey', secretAccessKey: 'fixture-only-secret',
  publicBaseUrl: 'https://downloads.example.test/files', prefix: 'releases',
}
const oss = { enabled: true, endpoint: 'oss-cn-hangzhou.aliyuncs.com', bucket: 'fixture-bucket',
  accessKeyId: 'fixturekey', accessKeySecret: 'fixture-only-secret', publicBaseUrl: 'https://downloads.example.test', prefix: 'releases' }

function objectHead(provider, requests) {
  return async (url, options) => {
    const target = new URL(url)
    const file = files.find(item => target.pathname.endsWith('/' + item.name))
    requests.push({ target, options })
    const digestHeader = provider === 'oss' ? 'x-oss-meta-sha256' : 'x-amz-meta-sha256'
    if (file?.name.endsWith('.json') && options.headers['accept-encoding'] !== 'identity') {
      return new Response(null, { headers: { 'content-encoding': 'gzip', [digestHeader]: file.sha256 } })
    }
    return new Response(null, { status: file ? 200 : 404,
      headers: file ? { 'content-length': String(file.size), [digestHeader]: file.sha256 } : {} })
  }
}

test('Aliyun OSS grants are restricted to the submitting project and build and verified on the bucket host', async () => {
  const grant = makeOssUploadGrant(oss, build)
  assert(grant)
  const validated = validateUploadGrant(grant, build.projectId, build.id)
  assert.deepEqual(validated, grant)
  assert.equal(validateUploadGrant(grant, 'other-brand', build.id), null)
  assert.equal(validateUploadGrant({ ...grant, url: 'https://unknown.example.test/' }, build.projectId, build.id), null)
  const policy = JSON.parse(Buffer.from(grant.fields.policy, 'base64'))
  assert.deepEqual(policy.conditions[1], ['starts-with', '$key', grant.prefix + '/'])
  assert.equal(JSON.stringify(grant).includes(oss.accessKeySecret), false)
  const requests = []
  const service = makeDirectUploadService({ readGrant: async () => validated, fetchImpl: objectHead('oss', requests) })
  assert.equal((await service.plan(center, files)).prefix, grant.prefix)
  await assert.rejects(service.accept(center, { provider: 'oss', files }, [...names].reverse()), /回执/)
  const receipt = await service.accept(center, { provider: 'oss', files }, names)
  assert.equal(sameBucketBuildPrefix(oss, { ...build, ...receipt }), grant.prefix)
  assert(requests.every(({ target, options }) => target.hostname === 'fixture-bucket.oss-cn-hangzhou.aliyuncs.com' && options.redirect === 'error'))
})

test('agent R2 delegates only object upload and verification in the assigned prefix and does not expose the parent secret', async () => {
  const config = normalizeR2ReleaseConfig(r2)
  const grant = makeR2UploadGrant(config, build)
  const encoded = Buffer.from(grant.sessionToken, 'base64').toString()
  const claims = JSON.parse(Buffer.from(encoded.split('.')[1], 'base64url'))
  assert.deepEqual(claims.paths.prefixPaths, [grant.prefix + '/'])
  assert.deepEqual(claims.actions, ['PutObject', 'HeadObject'])
  assert(!JSON.stringify(grant).includes(r2.secretAccessKey))
  assert.equal(validateUploadGrant({ ...grant, bucket: 'other-bucket' }, build.projectId, build.id), null)
  const requests = []
  const service = makeDirectUploadService({ readGrant: async () => validateUploadGrant(grant, build.projectId, build.id), fetchImpl: objectHead('r2', requests) })
  const plan = await service.plan(center, files)
  assert.equal(plan.uploads[0].headers['if-none-match'], '*')
  assert.equal(plan.uploads[0].headers['x-amz-security-token'], grant.sessionToken)
  const url = new URL(plan.uploads[0].url)
  assert.equal(url.pathname, '/fixture-bucket/' + grant.prefix + '/' + files[0].name)
  assert(url.searchParams.get('X-Amz-SignedHeaders').includes('content-md5'))
  assert(url.searchParams.get('X-Amz-SignedHeaders').includes('x-amz-security-token'))
  const location = await service.accept(center, { provider: 'r2', nonce: plan.nonce, files }, names)
  assert.equal(sameBucketBuildPrefix(config, { ...build, ...location }), grant.prefix)
  assert(requests.every(({ options }) => options.headers['x-amz-security-token'] === grant.sessionToken))
})

test('private shared R2 supplies authenticated download links without a public origin or a legacy-job rewrite', async () => {
  const sign = readBuildR2({ AI_BUILD_R2_ENDPOINT: r2.endpoint, AI_BUILD_R2_BUCKET: r2.bucket,
    AI_BUILD_R2_ACCESS_KEY_ID: r2.accessKeyId, AI_BUILD_R2_SECRET_ACCESS_KEY: r2.secretAccessKey })
  const requests = []
  const readGrant = async item => item.centerSupplierId ? { provider: 'shared-r2' } : null
  const service = makeDirectUploadService({ readGrant, readR2: () => sign, fetchImpl: objectHead('r2', requests) })
  assert.equal(await service.plan(build, files), null)
  const plan = await service.plan(center, files)
  const result = await service.accept(center, { provider: 'r2', nonce: plan.nonce, files }, names)
  assert.equal(result.publicUrl, '')
  assert.match(result.artifactDir, /^r2-build\/center-build\//)
  const downloads = await service.downloadUrls({ ...center, ...result, status: 'succeeded', files: names })
  assert.deepEqual(Object.keys(downloads), names)
  assert(Object.values(downloads).every(url => new URL(url).searchParams.has('X-Amz-Signature')))
  assert.equal(requests.length, 3)
})

test('both manifests reject unsafe names, mixed platforms and invalid objects', async () => {
  const desktop = ['installer.exe', 'installer.exe.blockmap', 'latest.json', 'latest.yml'].map(name => ({ ...files[0], name }))
  assert(validUploadFiles(files, 'android'))
  assert(validUploadFiles(desktop, 'desktop'))
  assert(!validUploadFiles([...desktop, files[0]], 'desktop'))
  assert(!validUploadFiles(files.map(file => ({ ...file, size: 0 })), 'android'))
  assert(!validUploadFiles([...desktop.slice(0, 3), { ...desktop[3], name: '../latest.yml' }], 'desktop'))
  assert(!normalizeR2ReleaseConfig({ ...r2, publicBaseUrl: 'https://pub-example.r2.dev' }).enabled)
  await assert.rejects(putR2ReleaseObject(r2, 'files/asset.exe', { headers: { 'x-amz-copy-source': '/fixture-bucket/files/test.exe' } },
    async () => new Response('<Error><Code>Failure</Code></Error>')), /复制失败/)
})
