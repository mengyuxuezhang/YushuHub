import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { makeDirectUploadService, makeOssUploadGrant, makeR2UploadGrant, normalizeR2ReleaseConfig, putR2ReleaseObject,
  probeR2DevelopmentArtifact, readBuildR2, sameBucketBuildPrefix, validateUploadGrant, validUploadFiles, verifyDirectArtifact } from './direct-build-artifacts.mjs'

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
  assert.equal(plan.uploads[0].headers['x-amz-security-token'], undefined)
  const url = new URL(plan.uploads[0].url)
  assert.equal(url.pathname, '/fixture-bucket/' + grant.prefix + '/' + files[0].name)
  assert(url.searchParams.get('X-Amz-SignedHeaders').includes('content-md5'))
  assert.equal(url.searchParams.get('X-Amz-Security-Token'), grant.sessionToken)
  const location = await service.accept(center, { provider: 'r2', nonce: plan.nonce, files }, names)
  assert.equal(sameBucketBuildPrefix(config, { ...build, ...location }), grant.prefix)
  assert(requests.every(({ target, options }) => target.searchParams.get('X-Amz-Security-Token') === grant.sessionToken &&
    options.headers['x-amz-security-token'] === undefined))
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

test('R2 artifact verification recovers from a nested connection timeout and an HTTP gateway timeout', async () => {
  const file = files[0]
  const sent = []
  const fetchHead = async (_url, options) => {
    sent.push(options)
    if (sent.length === 1) {
      const timeout = Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' })
      throw new TypeError('fetch failed', { cause: new AggregateError([timeout]) })
    }
    if (sent.length === 2) return new Response(null, { status: 504 })
    return new Response(null, { headers: { 'content-length': String(file.size), 'x-amz-meta-sha256': file.sha256 } })
  }
  await verifyDirectArtifact(r2.endpoint, file, 'r2', fetchHead)
  assert.equal(sent.length, 3)
  assert.equal(new Set(sent.map(options => options.signal)).size, 3)
  assert(sent.every(options => options.method === 'HEAD' && options.headers['accept-encoding'] === 'identity'))
})

test('artifact verification rejects invalid metadata immediately and leaves OSS timeouts to its existing callers', async () => {
  let calls = 0
  await assert.rejects(verifyDirectArtifact(r2.endpoint, files[0], 'r2', async () => {
    calls++
    return new Response(null, { headers: { 'content-length': String(files[0].size), 'x-amz-meta-sha256': files[1].sha256 } })
  }), /产物校验失败/)
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(verifyDirectArtifact(oss.publicBaseUrl, files[0], 'oss', async () => {
    calls++
    throw Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' })
  }), /产物校验失败/)
  assert.equal(calls, 1)
})

test('R2 public probe retries connection timeouts and bounds the HEAD fallback to a byte range', async () => {
  const sent = []
  const probe = async (_url, options) => {
    sent.push(options)
    if (sent.length === 1) throw Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })
    return new Response(null, { status: sent.length === 2 ? 405 : 206 })
  }
  assert.equal(await probeR2DevelopmentArtifact(r2.publicBaseUrl, probe), null)
  assert.equal(sent.length, 0)
  const url = 'https://pub-' + 'b'.repeat(32) + '.r2.dev/build/installer.exe'
  assert.equal(await probeR2DevelopmentArtifact(url, probe), true)
  assert.deepEqual(sent.map(request => request.method), ['HEAD', 'HEAD', 'GET'])
  assert.equal(sent[2].headers.range, 'bytes=0-0')
  let calls = 0
  assert.equal(await probeR2DevelopmentArtifact(url, async () => {
    calls++
    return new Response(null, { status: 404 })
  }), false)
  assert.equal(calls, 1)
})

test('R2 publishing retries transient object copies without replaying a streamed upload', async () => {
  let attempts = 0
  const headers = { 'x-amz-copy-source': '/fixture-bucket/files/installer.exe' }
  await putR2ReleaseObject(r2, 'files/release.exe', { headers }, async (_url, options) => {
    attempts++
    assert.equal(options.headers['content-length'], '0')
    if (attempts === 1) throw Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })
    return new Response('<CopyObjectResult></CopyObjectResult>')
  })
  assert.equal(attempts, 2)
  attempts = 0
  await assert.rejects(putR2ReleaseObject(r2, 'files/release.exe', { body: new Blob(['test']), headers: { 'content-length': '4' } },
    async () => { attempts++; throw Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }) }), /超时/)
  assert.equal(attempts, 1)
})

test('R2 public development URLs support downloads from the bucket origin', () => {
  const publicBaseUrl = 'https://pub-' + 'b'.repeat(32) + '.r2.dev'
  const config = normalizeR2ReleaseConfig({ ...r2, publicBaseUrl: publicBaseUrl + '/' })
  assert.equal(config.enabled, true)
  assert.equal(config.publicBaseUrl, publicBaseUrl)
  const grant = makeR2UploadGrant(config, build)
  assert.equal(new URL(grant.publicUrl).origin, publicBaseUrl)
  assert.deepEqual(validateUploadGrant(grant, build.projectId, build.id), grant)
  for (const invalidUrl of [publicBaseUrl + '/installer.apk', publicBaseUrl + './installer.apk', publicBaseUrl + '?download=1', r2.endpoint]) {
    assert.equal(normalizeR2ReleaseConfig({ ...r2, publicBaseUrl: invalidUrl }).enabled, false)
  }
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
