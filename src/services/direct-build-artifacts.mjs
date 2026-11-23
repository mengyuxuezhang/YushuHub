import { createHash, createHmac, randomBytes } from 'node:crypto'
import { Agent, request } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'
import { AwsClient } from 'aws4fetch'
import { androidBuildArtifacts, isAndroidBuildArtifact } from './android-build-artifacts.mjs'

const MAX_BYTES = 4 * 1024 ** 3
const OSS_HOST = /^[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/
const BUILD_ID = /^[A-Za-z0-9_-]{1,120}$/
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/
const PREFIX_PART = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,239}$/
const SHA256 = /^[a-f0-9]{64}$/
const MD5 = /^[a-zA-Z0-9+/]{22}==$/
const R2_DIR = /^r2-build\/[A-Za-z0-9_-]{1,120}\/[a-f0-9]{32}$/
const r2VerificationAgent = new Agent({ keepAlive: true, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 1_800 })
const r2TransientErrors = new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT'])
export const privateUploadField = '__directArtifactUpload'

function httpsUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash ? url : null
  } catch {
    return null
  }
}

export function artifactObjectUrl(base, name) {
  return new URL(encodeURIComponent(name), base).href
}

function buildObjectPrefix(config, build) {
  return [config.prefix, 'ai-staging', '_platform-builds', build.projectId, build.id].filter(Boolean).join('/')
}

function buildUploadLocation(config, build) {
  if (!config.enabled || !BUILD_ID.test(build.id) || !BUILD_ID.test(build.projectId)) return null
  const base = httpsUrl(config.publicBaseUrl)
  const prefix = buildObjectPrefix(config, build) + '/' + randomBytes(16).toString('hex')
  if (!base || prefix.split('/').some(part => !PREFIX_PART.test(part))) return null
  return { prefix, publicUrl: base.href.replace(/\/+$/, '') + '/' + prefix + '/' }
}

export function makeOssUploadGrant(config, build, now = Date.now()) {
  const location = buildUploadLocation(config, build)
  const bucketUrl = httpsUrl('https://' + config.bucket + '.' + config.endpoint + '/')
  if (!location || !bucketUrl || !OSS_HOST.test(bucketUrl.hostname)) return null
  const expires = now + 12 * 60 * 60 * 1000
  const policy = Buffer.from(JSON.stringify({ expiration: new Date(expires).toISOString(), conditions: [
    { bucket: config.bucket },
    ['starts-with', '$key', location.prefix + '/'],
    ['content-length-range', 1, MAX_BYTES],
    ['eq', '$x-oss-forbid-overwrite', 'true'],
    ['starts-with', '$x-oss-meta-sha256', ''],
  ] })).toString('base64')
  const Signature = createHmac('sha1', config.accessKeySecret).update(policy).digest('base64')
  return { provider: 'oss', ...location, url: bucketUrl.href, expires,
    fields: { OSSAccessKeyId: config.accessKeyId, policy, Signature, 'x-oss-forbid-overwrite': 'true' } }
}

export function makeR2UploadGrant(config, build, now = Date.now()) {
  const location = buildUploadLocation(config, build)
  if (!location) return null
  const url = r2Endpoint(config.endpoint)
  const issued = Math.floor(now / 1000)
  const expiration = issued + 12 * 60 * 60
  const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url')
  const claims = { sub: url.hostname.split('.')[0], iss: config.accessKeyId, aud: url.hostname,
    iat: issued, exp: expiration, bucket: config.bucket, actions: ['PutObject', 'HeadObject'],
    paths: { prefixPaths: [location.prefix + '/'], objectPaths: [] } }
  const payload = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode(claims)
  const jwt = payload + '.' + createHmac('sha256', config.secretAccessKey).update(payload).digest('base64url')
  return { provider: 'r2', ...location, endpoint: url.href, bucket: config.bucket, accessKeyId: config.accessKeyId,
    expires: expiration * 1000, sessionToken: Buffer.from('jwt/' + jwt).toString('base64') }
}

export function validateUploadGrant(grant, projectId, localId) {
  if (typeof projectId !== 'string' || typeof localId !== 'string' || !BUILD_ID.test(projectId) || !BUILD_ID.test(localId)) return null
  if (grant?.provider === 'shared-r2') return { provider: 'shared-r2' }
  const base = httpsUrl(grant?.publicUrl)
  const parts = typeof grant?.prefix === 'string' ? grant.prefix.split('/') : []
  if (!base || !parts.every(part => PREFIX_PART.test(part))
    || parts.slice(-5, -1).join('/') !== ['ai-staging', '_platform-builds', projectId, localId].join('/')
    || !/^[a-f0-9]{32}$/.test(parts.at(-1)) || !base.pathname.endsWith('/' + grant.prefix + '/')
    || !Number.isSafeInteger(grant.expires) || grant.expires > Date.now() + 13 * 60 * 60 * 1000) return null
  const location = { prefix: grant.prefix, publicUrl: base.href, expires: grant.expires }
  if (grant.provider === 'r2') {
    const endpoint = r2Endpoint(grant.endpoint)
    if (!endpoint || !validR2Bucket(grant.bucket) || typeof grant.accessKeyId !== 'string' ||
      !/^[a-zA-Z0-9]{1,160}$/.test(grant.accessKeyId) || typeof grant.sessionToken !== 'string' ||
      !/^[A-Za-z0-9+/=]{1,4096}$/.test(grant.sessionToken)) return null
    const encoded = Buffer.from(grant.sessionToken, 'base64').toString()
    if (!/^jwt\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(encoded)) return null
    try {
      const claims = JSON.parse(Buffer.from(encoded.split('.')[1], 'base64url').toString())
      if (claims.bucket !== grant.bucket || claims.aud !== endpoint.hostname || claims.iss !== grant.accessKeyId
        || claims.sub !== endpoint.hostname.split('.')[0] || claims.exp * 1000 !== grant.expires
        || claims.actions?.join() !== 'PutObject,HeadObject' || claims.scope
        || claims.paths?.prefixPaths?.join() !== grant.prefix + '/' || claims.paths?.objectPaths?.length !== 0) return null
    } catch { return null }
    return { provider: 'r2', ...location, endpoint: endpoint.href, bucket: grant.bucket,
      accessKeyId: grant.accessKeyId, sessionToken: grant.sessionToken }
  }
  const url = httpsUrl(grant.url)
  if (grant.provider !== 'oss' || !url || !OSS_HOST.test(url.hostname) || url.pathname !== '/') return null
  const { OSSAccessKeyId, policy, Signature } = grant.fields || {}
  if (![OSSAccessKeyId, policy, Signature].every(value => typeof value === 'string' && /^[A-Za-z0-9+/=]{1,4096}$/.test(value))) return null
  return { provider: 'oss', ...location, url: url.href,
    fields: { OSSAccessKeyId, policy, Signature, 'x-oss-forbid-overwrite': 'true' } }
}

export function sameBucketBuildPrefix(config, build) {
  const base = httpsUrl(config.publicBaseUrl)
  const current = httpsUrl(build.publicUrl)
  if (!base || !current || base.origin !== current.origin) return null
  const key = buildObjectPrefix(config, build)
  const root = base.pathname.replace(/\/+$/, '') + '/' + key + '/'
  if (config.provider === 'r2' && current.pathname === root) return key
  if (!current.pathname.startsWith(root) || !/^[a-f0-9]{32}\/$/.test(current.pathname.slice(root.length))) return null
  return key + '/' + current.pathname.slice(root.length, -1)
}

export function validUploadFiles(files, target) {
  if (target !== 'android' && target !== 'desktop') return false
  if (!Array.isArray(files) || !files.length || files.length > 10 || !files.every(file =>
    typeof file?.name === 'string' && FILE_NAME.test(file.name) && Number.isSafeInteger(file.size) &&
    file.size > 0 && file.size <= MAX_BYTES && typeof file.sha256 === 'string' && SHA256.test(file.sha256) &&
    typeof file.md5 === 'string' && MD5.test(file.md5))) return false
  const names = files.map(file => file.name)
  if (new Set(names).size !== names.length) return false
  if (target === 'android') return names.length === 3 && androidBuildArtifacts(names).length === 3
  const installer = names.find(name => name.endsWith('.exe'))
  if (!installer || ![installer + '.blockmap', 'latest.yml', 'latest.json'].every(name => names.includes(name))) return false
  return names.length === 4 && !names.some(isAndroidBuildArtifact)
}

export function r2Directory(buildId, nonce) {
  const value = 'r2-build/' + buildId + '/' + nonce
  return R2_DIR.test(value) ? value : null
}

function r2Endpoint(value) {
  const url = httpsUrl(value)
  return url && url.pathname === '/' && /^[a-f0-9]{32}(?:\.(?:eu|fedramp|us))?\.r2\.cloudflarestorage\.com$/.test(url.hostname) ? url : null
}

export function validR2Bucket(bucket) {
  return typeof bucket === 'string' && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
}

export function normalizeR2ReleaseConfig(config = {}) {
  const endpoint = r2Endpoint(config.endpoint)?.href || ''
  const publicUrl = httpsUrl(config.publicBaseUrl)
  const host = publicUrl?.hostname.replace(/\.$/, '') || ''
  const developmentDomain = /(?:^|\.)r2\.dev$/.test(host)
  const validDevelopmentUrl = developmentDomain && /^pub-[a-f0-9]{32}\.r2\.dev$/.test(publicUrl.hostname) && publicUrl.pathname === '/'
  const validCustomUrl = publicUrl && !developmentDomain && !/(?:^|\.)r2\.cloudflarestorage\.com$/.test(host)
  const publicBaseUrl = validDevelopmentUrl || validCustomUrl ? publicUrl.href.replace(/\/+$/, '') : ''
  const prefix = String(config.prefix || '').trim().replace(/^\/+|\/+$/g, '')
  const enabled = Boolean(endpoint && publicBaseUrl && validR2Bucket(config.bucket) && /^[a-zA-Z0-9]{1,160}$/.test(config.accessKeyId || '')
    && (config.secretAccessKey || config.encryptedSecret) && (!prefix || prefix.split('/').every(part => PREFIX_PART.test(part))))
  return { ...config, provider: 'r2', endpoint, publicBaseUrl, prefix, enabled }
}

function createR2ObjectSigner({ endpoint, bucket, accessKeyId, secretAccessKey, sessionToken }) {
  if (![endpoint, bucket, accessKeyId, secretAccessKey].some(Boolean)) return null
  const url = r2Endpoint(endpoint)
  if (!url || !validR2Bucket(bucket) || !accessKeyId || !secretAccessKey) {
    throw new Error('Cloudflare R2 配置不完整')
  }
  const client = new AwsClient({ accessKeyId, secretAccessKey, sessionToken, service: 's3', region: 'auto' })
  return async (key, method, headers = {}) => {
    const parts = key.split('/')
    if (!parts.every(part => PREFIX_PART.test(part))) throw new Error('R2 产物路径无效')
    const object = new URL(bucket + '/' + parts.map(encodeURIComponent).join('/'), url)
    object.searchParams.set('X-Amz-Expires', '3600')
    return (await client.sign(object.href, { method, headers, aws: { signQuery: true, allHeaders: true } })).url
  }
}

function delegatedR2Signer(grant) {
  const jwt = Buffer.from(grant.sessionToken, 'base64').toString().slice(4)
  const sign = createR2ObjectSigner({ ...grant, secretAccessKey: createHash('sha256').update(jwt).digest('hex') })
  return (_directory, name, method, headers) => sign(grant.prefix + '/' + name, method, headers)
}

export async function verifyR2ReleaseObject(config, key, file) {
  const sign = createR2ObjectSigner(config)
  await verifyDirectArtifact(await sign(key, 'HEAD'), file, 'r2')
}

export function readBuildR2(env = process.env) {
  const sign = createR2ObjectSigner({ endpoint: env.AI_BUILD_R2_ENDPOINT, bucket: env.AI_BUILD_R2_BUCKET,
    accessKeyId: env.AI_BUILD_R2_ACCESS_KEY_ID, secretAccessKey: env.AI_BUILD_R2_SECRET_ACCESS_KEY })
  return sign && ((directory, name, method, headers) => {
    if (!R2_DIR.test(directory) || !FILE_NAME.test(name)) throw new Error('R2 构建产物路径无效')
    return sign(directory + '/' + name, method, headers)
  })
}

export async function putR2ReleaseObject(config, key, { body, headers }, fetchImpl = fetch) {
  const sign = createR2ObjectSigner(config)
  const url = await sign(key, 'PUT', headers)
  const response = await fetchImpl(url, { method: 'PUT', headers, body, redirect: 'error', signal: AbortSignal.timeout(900_000) })
    .catch(() => null)
  if (!response?.ok) throw new Error('R2 写入失败' + (response ? ' HTTP ' + response.status : ''))
  if (headers['x-amz-copy-source']) {
    const copyResult = await response.text()
    if (!/<CopyObjectResult[ >]/.test(copyResult) || /<Error[ >]/.test(copyResult)) throw new Error('R2 服务端复制失败')
  } else {
    await response.body?.cancel()
  }
}

export function r2UploadHeaders(file) {
  const contentType = file.name.endsWith('.json') ? 'application/json' : file.name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream'
  return { 'content-md5': file.md5, 'content-length': String(file.size), 'content-type': contentType,
    'x-amz-meta-sha256': file.sha256, 'if-none-match': '*' }
}

function requestR2Head(url, { method, headers, signal }) {
  return new Promise((resolve, reject) => {
    const head = request(url, { method, headers, signal, agent: r2VerificationAgent }, response => {
      response.resume()
      resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: new Headers(response.headers) })
    })
    head.once('error', reject)
    head.end()
  })
}

function isTransientR2Error(error) {
  return r2TransientErrors.has(error?.code) || error?.name === 'TimeoutError' ||
    Boolean(error?.errors?.some(isTransientR2Error) || (error?.cause && isTransientR2Error(error.cause)))
}

export async function verifyDirectArtifact(url, file, provider, fetchImpl, headers = {}) {
  // Object stores can compress JSON on demand and omit its original size from HEAD.
  const requestHeaders = { ...headers, 'accept-encoding': 'identity' }
  const isR2 = provider === 'r2'
  const send = fetchImpl ?? (isR2 ? requestR2Head : fetch)
  let response
  for (let attempt = 1; ; attempt++) {
    let retry
    try {
      response = await send(url, { method: 'HEAD', headers: requestHeaders, redirect: 'error', signal: AbortSignal.timeout(15_000) })
      retry = response.status === 408 || response.status === 504
    } catch (error) {
      response = null
      retry = isR2 && isTransientR2Error(error)
    }
    if (!isR2 || !retry || attempt === 3) break
    await delay(attempt * 250)
  }
  const digest = response?.headers.get(provider === 'r2' ? 'x-amz-meta-sha256' : 'x-oss-meta-sha256')
  if (!response?.ok || Number(response.headers.get('content-length')) !== file.size || digest !== file.sha256) {
    throw new Error('对象存储产物校验失败：' + file.name)
  }
}

export function makeDirectUploadService({ readGrant, readR2 = readBuildR2, fetchImpl }) {
  return {
    async plan(build, files) {
      const grant = await readGrant(build)
      const signR2 = grant?.provider === 'r2' ? delegatedR2Signer(grant) : grant?.provider === 'shared-r2' ? readR2() : null
      if (grant?.provider !== 'oss' && !signR2) return null
      if (!validUploadFiles(files, build.target)) throw new Error('直传构建产物清单无效')
      if (grant?.expires && grant.expires < Date.now() + 60_000) throw new Error('对象存储上传授权已过期，请重试构建')
      if (grant?.provider === 'oss') {
        return { provider: 'oss', url: grant.url, prefix: grant.prefix, fields: grant.fields }
      }
      const nonce = grant?.prefix?.split('/').at(-1) || randomBytes(16).toString('hex')
      const directory = r2Directory(build.id, nonce)
      const uploads = await Promise.all(files.map(async file => {
        const headers = r2UploadHeaders(file)
        return { name: file.name, headers, url: await signR2(directory, file.name, 'PUT', headers) }
      }))
      return { provider: 'r2', nonce, uploads }
    },
    async accept(build, receipt, names) {
      const files = receipt?.files
      if (!validUploadFiles(files, build.target) || files.length !== names.length || files.some((file, i) => file.name !== names[i])) {
        throw new Error('直传构建回执与产物清单不一致')
      }
      const grant = await readGrant(build)
      if (receipt.provider === 'oss' && grant?.provider === 'oss') {
        const bucketPrefix = new URL(grant.prefix + '/', grant.url)
        await Promise.all(files.map(file => verifyDirectArtifact(artifactObjectUrl(bucketPrefix, file.name), file, 'oss', fetchImpl)))
        return { publicUrl: grant.publicUrl, artifactDir: '' }
      }
      if (receipt.provider === 'r2' && grant?.provider === 'r2' && grant.prefix.endsWith('/' + receipt.nonce)) {
        const sign = delegatedR2Signer(grant)
        await Promise.all(files.map(async file => verifyDirectArtifact(await sign(null, file.name, 'HEAD'), file, 'r2', fetchImpl)))
        return { publicUrl: grant.publicUrl, artifactDir: '' }
      }
      const directory = receipt.provider === 'r2' ? r2Directory(build.id, receipt.nonce) : null
      const signR2 = grant?.provider === 'shared-r2' && directory ? readR2() : null
      if (!signR2) throw new Error('直传构建回执与存储配置不一致')
      await Promise.all(files.map(async file => verifyDirectArtifact(await signR2(directory, file.name, 'HEAD'), file, 'r2', fetchImpl)))
      return { publicUrl: '', artifactDir: directory }
    },
    async downloadUrls(build) {
      if (build.status !== 'succeeded' || !R2_DIR.test(build.artifactDir)) return null
      const signR2 = readR2()
      if (!signR2) throw new Error('R2 构建暂存配置不可用')
      return Object.fromEntries(await Promise.all(build.files.map(async name => [name, await signR2(build.artifactDir, name, 'GET')])))
    },
  }
}
