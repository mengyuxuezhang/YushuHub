import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'

import {
  CURATED_SKILL_ROOT, CURATED_SKILL_KEK_PATH,
  CURATED_SKILL_SIGNING_PRIVATE_PATH, CURATED_SKILL_SIGNING_PUBLIC_PATH,
} from '../config/paths.mjs'

const MAX_PACKAGE_BYTES = 20 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024
const PROTECTED_FILE = /^(SKILL\.md|references\/[a-zA-Z0-9._/-]+\.(?:md|txt|json))$/i

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function safeEntryName(raw) {
  const name = String(raw || '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..') || name.includes('\0')) {
    throw new Error('技能包包含不安全路径')
  }
  return name
}

export function inspectSkillZip(buffer, distributionType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('请选择技能 ZIP')
  if (buffer.length > MAX_PACKAGE_BYTES) throw new Error('技能 ZIP 不能超过 20 MB')
  const zip = new AdmZip(buffer)
  const files = []
  let uncompressed = 0
  for (const entry of zip.getEntries()) {
    const name = safeEntryName(entry.entryName)
    if (entry.isDirectory) continue
    const mode = (Number(entry.header?.attr || 0) >>> 16) & 0xffff
    if ((mode & 0o170000) === 0o120000) throw new Error('技能包不允许符号链接')
    uncompressed += Number(entry.header?.size || entry.getData().length || 0)
    if (uncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error('技能包解压后不能超过 50 MB')
    if (distributionType === 'protected' && !PROTECTED_FILE.test(name)) {
      throw new Error(`保护技能第一期只允许 SKILL.md 和 references 文本文件：${name}`)
    }
    files.push(name)
  }
  if (!files.some((name) => name === 'SKILL.md')) throw new Error('技能包根目录必须包含 SKILL.md')
  return { zip, files, uncompressedBytes: uncompressed }
}

async function ensureSecretFile(filePath, bytes) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  try { return await fsp.readFile(filePath) } catch {}
  const value = crypto.randomBytes(bytes)
  await fsp.writeFile(filePath, value, { mode: 0o600, flag: 'wx' }).catch(() => {})
  return fsp.readFile(filePath)
}

async function ensureSigningKeys() {
  await fsp.mkdir(path.dirname(CURATED_SKILL_SIGNING_PRIVATE_PATH), { recursive: true })
  if (!fs.existsSync(CURATED_SKILL_SIGNING_PRIVATE_PATH)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
    await fsp.writeFile(CURATED_SKILL_SIGNING_PRIVATE_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' }).catch(() => {})
    await fsp.writeFile(CURATED_SKILL_SIGNING_PUBLIC_PATH, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 }).catch(() => {})
  }
  const privatePem = await fsp.readFile(CURATED_SKILL_SIGNING_PRIVATE_PATH)
  const privateKey = crypto.createPrivateKey(privatePem)
  const publicKey = crypto.createPublicKey(privateKey)
  if (!fs.existsSync(CURATED_SKILL_SIGNING_PUBLIC_PATH)) {
    await fsp.writeFile(CURATED_SKILL_SIGNING_PUBLIC_PATH, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 })
  }
  return { privateKey, publicKey }
}

async function wrapDek(dek) {
  const kek = await ensureSecretFile(CURATED_SKILL_KEK_PATH, 32)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv)
  const encrypted = Buffer.concat([cipher.update(dek), cipher.final()])
  return { algorithm: 'AES-256-GCM', iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') }
}

export async function unwrapDek(wrapped) {
  const kek = await fsp.readFile(CURATED_SKILL_KEK_PATH)
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(wrapped.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(wrapped.authTag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(wrapped.ciphertext, 'base64')), decipher.final()])
}

export async function buildPublishedPackage({ skill, version, zipBuffer }) {
  inspectSkillZip(zipBuffer, skill.distribution_type)
  const contentSha256 = sha256(zipBuffer)
  let packageBuffer = zipBuffer
  let encryptedDek = null
  let encryption = null
  if (skill.distribution_type === 'protected') {
    const dek = crypto.randomBytes(32)
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv)
    packageBuffer = Buffer.concat([cipher.update(zipBuffer), cipher.final()])
    encryption = { algorithm: 'AES-256-GCM', iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') }
    encryptedDek = await wrapDek(dek)
    dek.fill(0)
  }
  const manifest = {
    schemaVersion: 1,
    skillId: skill.id,
    version: version.version,
    distributionType: skill.distribution_type,
    name: skill.name,
    description: skill.description,
    minDesktopVersion: version.min_desktop_version || '',
    contentSha256,
    encryptedPackageSha256: sha256(packageBuffer),
    encryption,
    publishedAt: new Date().toISOString(),
    signatureAlgorithm: 'Ed25519',
  }
  const { privateKey } = await ensureSigningKeys()
  manifest.signature = crypto.sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString('base64')
  const versionDir = path.join(CURATED_SKILL_ROOT, skill.id, version.version)
  await fsp.mkdir(versionDir, { recursive: true })
  const packageName = skill.distribution_type === 'protected' ? 'package.enc' : 'package.zip'
  const tmpPath = path.join(versionDir, `${packageName}.${crypto.randomUUID()}.tmp`)
  const packagePath = path.join(versionDir, packageName)
  await fsp.writeFile(tmpPath, packageBuffer, { flag: 'wx' })
  await fsp.rename(tmpPath, packagePath)
  await fsp.writeFile(path.join(versionDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return { manifest, packagePath, packageSha256: manifest.encryptedPackageSha256, encryptedDek }
}

export async function importPublishedPackage({ skill, version, packageBuffer, remoteManifest, remotePublicKey }) {
  const manifest = { ...(remoteManifest || {}) }
  const signature = String(manifest.signature || '')
  delete manifest.signature
  if (manifest.schemaVersion !== 1 || manifest.skillId !== skill.id || manifest.version !== version.version) throw new Error('中心技能清单与目录不匹配')
  if (manifest.distributionType !== skill.distribution_type || manifest.signatureAlgorithm !== 'Ed25519') throw new Error('中心技能清单类型或签名算法无效')
  if (sha256(packageBuffer) !== manifest.encryptedPackageSha256) throw new Error('中心技能包哈希校验失败')
  const publicKey = crypto.createPublicKey(String(remotePublicKey || ''))
  if (!crypto.verify(null, Buffer.from(canonicalJson(manifest)), publicKey, Buffer.from(signature, 'base64'))) throw new Error('中心技能包签名校验失败')
  if (skill.distribution_type === 'public') {
    inspectSkillZip(packageBuffer, 'public')
    if (sha256(packageBuffer) !== manifest.contentSha256) throw new Error('中心公开技能正文哈希校验失败')
  }
  const { privateKey } = await ensureSigningKeys()
  const localManifest = { ...manifest, signature: crypto.sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString('base64') }
  const versionDir = path.join(CURATED_SKILL_ROOT, skill.id, version.version)
  await fsp.mkdir(versionDir, { recursive: true })
  const packageName = skill.distribution_type === 'protected' ? 'package.enc' : 'package.zip'
  const packagePath = path.join(versionDir, packageName)
  const tmpPath = `${packagePath}.${crypto.randomUUID()}.tmp`
  await fsp.writeFile(tmpPath, packageBuffer, { flag: 'wx' })
  await fsp.rename(tmpPath, packagePath)
  await fsp.writeFile(path.join(versionDir, 'manifest.json'), JSON.stringify(localManifest, null, 2), 'utf8')
  return { manifest: localManifest, packagePath, packageSha256: localManifest.encryptedPackageSha256 }
}

export async function deleteSkillPackages(skillId) {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(String(skillId || ''))) throw new Error('技能 ID 无效')
  await fsp.rm(path.join(CURATED_SKILL_ROOT, skillId), { recursive: true, force: true })
}

export async function getSigningPublicKeyPem() {
  const { publicKey } = await ensureSigningKeys()
  return publicKey.export({ type: 'spki', format: 'pem' }).toString()
}

export async function signCanonicalManifest(value) {
  const manifest = { ...value, signatureAlgorithm: 'Ed25519' }
  const { privateKey } = await ensureSigningKeys()
  return { ...manifest, signature: crypto.sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString('base64') }
}
