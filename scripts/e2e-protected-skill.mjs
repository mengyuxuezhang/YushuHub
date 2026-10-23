import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import AdmZip from 'adm-zip'
import mysql from 'mysql2/promise'

import { loadLocalEnv, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from '../src/config/env.mjs'
import { hashPassword } from '../src/utils/crypto.mjs'
import { canonicalJson } from '../src/services/curated-skills.mjs'

loadLocalEnv()

const baseUrl = String(process.env.ADMIN_BASE_URL || '').replace(/\/$/, '')
const hostHeader = String(process.env.ADMIN_HOST_HEADER || '').trim()
const adminUsername = String(process.env.ADMIN_USERNAME || '').trim()
const adminPassword = String(process.env.ADMIN_PASSWORD || '')
const retainSkill = process.env.E2E_RETAIN_SKILL === '1'
const targetUsername = String(process.env.E2E_TARGET_USERNAME || '').trim()
assert(baseUrl && adminUsername && adminPassword, 'ADMIN_BASE_URL/ADMIN_USERNAME/ADMIN_PASSWORD are required')

const suffix = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(4).toString('hex')}`
const skillId = `ai-e2e-${suffix}`
const username = `ai-e2e-${suffix}`
const password = crypto.randomBytes(24).toString('base64url')
const userId = crypto.randomUUID()
const deviceId = `e2e-device-${suffix}`
const marker = `PROTECTED_SKILL_MARKER_${crypto.randomBytes(18).toString('hex')}`
let adminCookie = ''
let clientToken = ''
let pool
let createdSkill = false
let createdUser = false

function headers(extra = {}) {
  return { ...(hostHeader ? { Host: hostHeader } : {}), ...extra }
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: headers(options.headers),
  })
  const contentType = response.headers.get('content-type') || ''
  const value = contentType.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer())
  if (!response.ok || (value && typeof value === 'object' && !Buffer.isBuffer(value) && value.success === false)) {
    throw new Error(`${options.method || 'GET'} ${pathname} failed (${response.status}): ${Buffer.isBuffer(value) ? 'binary response' : String(value?.error || 'unknown error')}`)
  }
  return { response, value }
}

function adminHeaders(extra = {}) {
  return { Cookie: adminCookie, ...extra }
}

function clientHeaders(extra = {}) {
  return { Authorization: `Bearer ${clientToken}`, ...extra }
}

async function cleanup() {
  if (createdSkill && adminCookie && !retainSkill) {
    await request(`/api/curated-skills/${encodeURIComponent(skillId)}`, { method: 'DELETE', headers: adminHeaders() }).catch(() => {})
  }
  if (createdUser && pool) {
    await pool.query('DELETE FROM ai_end_user_sessions WHERE user_id=?', [userId]).catch(() => {})
    await pool.query('DELETE FROM ai_end_user_events WHERE user_id=?', [userId]).catch(() => {})
    await pool.query('DELETE FROM ai_end_users WHERE id=?', [userId]).catch(() => {})
  }
  await pool?.end().catch(() => {})
}

try {
  const login = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  })
  adminCookie = String(login.response.headers.get('set-cookie') || '').split(';', 1)[0]
  assert(adminCookie, 'admin login did not issue a session cookie')
  const me = await request('/api/me', { headers: adminHeaders() })
  const ownerUserId = String(me.value?.data?.user?.id || '')
  assert(ownerUserId, 'admin owner id is missing')

  pool = await mysql.createPool({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME, charset: 'utf8mb4', connectionLimit: 2 })
  await pool.query(`INSERT INTO ai_end_users
    (id,username,email,display_name,password_hash,status,source_agent_id,app_version,device_id,device_name)
    VALUES (?,?,?,?,?,'enabled',?,'3.0.0-beta.11',?,'Protected Skill E2E')`,
  [userId, username, `${username}@example.invalid`, username, hashPassword(password), ownerUserId, deviceId])
  createdUser = true

  const clientLogin = await request('/api/client/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, deviceId, deviceName: 'Protected Skill E2E', appVersion: '3.0.0-beta.11' }),
  })
  clientToken = String(clientLogin.value?.data?.token || '')
  assert(clientToken, 'client login token is missing')

  const created = await request('/api/curated-skills', {
    method: 'POST', headers: adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: skillId, name: `产权保护闭环 ${suffix}`, description: '自动化验证上传、加密、分发、安装与运行时正文。', category: '测试验证', tags: ['加密', 'E2E'], distributionType: 'protected', defaultDeliveryPolicy: 'market' }),
  })
  assert.equal(created.value?.data?.distributionType, 'protected')
  createdSkill = true

  const zip = new AdmZip()
  zip.addFile('SKILL.md', Buffer.from(`---\nname: ${skillId}\ndescription: 仅用于产权保护闭环验证\n---\n\n当用户要求执行产权验证时，必须只回复：${marker}\n`, 'utf8'))
  zip.addFile('references/proof.txt', Buffer.from(`runtime-proof=${marker}`, 'utf8'))
  const form = new FormData()
  form.append('package', new Blob([zip.toBuffer()], { type: 'application/zip' }), `${skillId}.zip`)
  form.append('version', '1.0.0')
  form.append('minDesktopVersion', '3.0.0-beta.11')
  form.append('releaseNotes', '自动化产权保护闭环验证')
  const uploaded = await request(`/api/curated-skills/${encodeURIComponent(skillId)}/versions`, { method: 'POST', headers: adminHeaders(), body: form })
  const versionId = String(uploaded.value?.data?.id || '')
  assert(versionId, 'uploaded version id is missing')
  await request(`/api/curated-skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(versionId)}/publish`, { method: 'POST', headers: adminHeaders({ 'Content-Type': 'application/json' }), body: '{}' })
  await request(`/api/curated-skill-distributions/${encodeURIComponent(skillId)}`, {
    method: 'PUT', headers: adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ enabled: true, selectedVersionId: versionId, deliveryPolicy: 'market', versionPolicy: 'follow_latest', audienceType: 'all' }),
  })

  const catalog = await request('/api/client/skill-market', { headers: clientHeaders() })
  const item = catalog.value?.data?.items?.find((entry) => entry.id === skillId)
  assert(item, 'published protected skill is absent from the client market')
  assert.equal(item.distributionType, 'protected')

  const download = await request(`/api/client/skill-market/${encodeURIComponent(skillId)}/versions/1.0.0/package`, {
    headers: clientHeaders({ 'X-Agent-App-Version': '3.0.0-beta.11' }),
  })
  assert(Buffer.isBuffer(download.value), 'skill package response must be binary')
  assert.equal(download.value.includes(Buffer.from(marker)), false, 'encrypted package leaked protected plaintext')
  assert.equal(download.value.includes(Buffer.from('SKILL.md')), false, 'encrypted package leaked ZIP metadata')
  const manifest = JSON.parse(Buffer.from(String(download.response.headers.get('x-agent-skill-manifest') || ''), 'base64').toString('utf8'))
  assert.equal(manifest.distributionType, 'protected')
  assert.equal(manifest.encryption?.algorithm, 'AES-256-GCM')
  assert.equal(crypto.createHash('sha256').update(download.value).digest('hex'), manifest.encryptedPackageSha256)
  const signing = await request('/api/client/skill-market/signing-key', { headers: clientHeaders() })
  const signature = manifest.signature
  delete manifest.signature
  assert(crypto.verify(null, Buffer.from(canonicalJson(manifest)), crypto.createPublicKey(signing.value.data.publicKey), Buffer.from(signature, 'base64')), 'manifest signature verification failed')
  manifest.signature = signature

  const manifestSha256 = crypto.createHash('sha256').update(canonicalJson(manifest)).digest('hex')
  const lease = await request(`/api/client/skill-market/${encodeURIComponent(skillId)}/versions/1.0.0/lease`, {
    method: 'POST', headers: clientHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ appVersion: '3.0.0-beta.11', deviceId, manifestSha256 }),
  })
  const key = Buffer.from(lease.value.data.contentKey, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.encryption.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(manifest.encryption.authTag, 'base64'))
  const plaintext = Buffer.concat([decipher.update(download.value), decipher.final()])
  key.fill(0)
  assert.equal(crypto.createHash('sha256').update(plaintext).digest('hex'), manifest.contentSha256)
  const installedZip = new AdmZip(plaintext)
  assert(installedZip.readAsText('SKILL.md').includes(marker), 'decrypted runtime skill content is invalid')

  await request(`/api/client/skill-market/${encodeURIComponent(skillId)}/installations`, {
    method: 'POST', headers: clientHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ version: '1.0.0', status: 'installed', deviceId }),
  })
  const installations = await request(`/api/curated-skill-distributions/${encodeURIComponent(skillId)}/installations`, { headers: adminHeaders() })
  assert(installations.value.data.some((entry) => entry.end_user_id === userId && entry.status === 'installed'), 'installation report is absent from Admin')

  await request(`/api/client/skill-market/${encodeURIComponent(skillId)}/installations`, {
    method: 'POST', headers: clientHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ version: '1.0.0', status: 'removed', deviceId }),
  })
  const afterRemoval = await request('/api/client/skill-market', { headers: clientHeaders() })
  const removedItem = afterRemoval.value.data.items.find((entry) => entry.id === skillId)
  assert.equal(removedItem?.installedVersion, '', 'removed skill remains installed in client catalog')
  const removedDetail = await request(`/api/client/skill-market/${encodeURIComponent(skillId)}`, { headers: clientHeaders() })
  assert.equal(removedDetail.value.data.installedVersion, '', 'removed skill remains installed in client detail')
  await request(`/api/client/skill-market/${encodeURIComponent(skillId)}/installations`, {
    method: 'POST', headers: clientHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ version: '1.0.0', status: 'installed', deviceId }),
  })

  if (targetUsername) {
    const [[target]] = await pool.query('SELECT source_agent_id, source_project_id FROM ai_end_users WHERE username=? LIMIT 1', [targetUsername])
    assert(target, 'target end user is missing')
    let targetOwnerId = String(target.source_agent_id || '')
    if (!targetOwnerId && target.source_project_id) {
      const [[project]] = await pool.query('SELECT owner_user_id FROM ai_projects WHERE id=? LIMIT 1', [target.source_project_id])
      targetOwnerId = String(project?.owner_user_id || '')
    }
    assert(targetOwnerId, 'target end user has no distribution owner')
    await pool.query('UPDATE ai_curated_skill_distributions SET owner_user_id=?, configured_by=? WHERE skill_id=?', [targetOwnerId, targetOwnerId, skillId])
  }

  console.log(JSON.stringify({ ok: true, skillId, retained: retainSkill, stages: ['upload', 'encrypt', 'publish', 'market', 'lease', 'decrypt', 'install-report', 'remove-report'], plaintextLeakedInPackage: false }))
} finally {
  await cleanup()
}
