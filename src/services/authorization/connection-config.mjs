import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { domain, failure } from './protocol.mjs'

export const connectionFile = root => path.join(root, 'data', 'authorization-connection.json')
export function checkedKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).length > 8) throw failure('INVALID_TRUST_KEYS', '签名公钥格式不正确')
  for (const [id, pem] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id) || typeof pem !== 'string' || pem.length > 4096 || !pem.includes('BEGIN PUBLIC KEY')) throw failure('INVALID_TRUST_KEYS', '签名公钥格式不正确')
    try { if (crypto.createPublicKey(pem).asymmetricKeyType !== 'ed25519') throw Error() } catch { throw failure('INVALID_TRUST_KEYS', '需要有效的Ed25519公钥') }
  }
  return value
}
export function validateConnection(value, env = process.env) {
  if (!value || typeof value !== 'object') throw failure('INVALID_CONNECTION', '请粘贴完整授权接入信息')
  const centerUrl = domain(value.centerUrl), publicUrl = domain(value.publicUrl)
  const trusted = (env.AI_AUTHORIZATION_TRUSTED_CENTERS || 'https://license.okpa.cn').split(',').map(v => domain(v.trim()))
  if (!trusted.includes(centerUrl)) throw failure('UNTRUSTED_CENTER', '该授权中心不在服务器信任列表中')
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(value.instanceId || '') || !/^[A-Za-z0-9_.:-]{1,64}$/.test(value.licenseId || '')) throw failure('INVALID_CONNECTION', '实例或授权编号不正确')
  return { centerUrl, publicUrl, instanceId: value.instanceId, licenseId: value.licenseId, publicKeys: checkedKeys(value.publicKeys) }
}
export function decodeConnectionText(text) {
  if (typeof text !== 'string' || text.length > 32000) throw failure('INVALID_CONNECTION', '接入信息为空或过长')
  try {
    const raw = text.trim()
    if (raw.startsWith('YUSHU1.')) { const body = raw.slice(7); if (!/^[A-Za-z0-9_-]+$/.test(body)) throw Error(); return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) }
    return JSON.parse(raw)
  } catch { throw failure('INVALID_CONNECTION', '接入信息不完整，请重新复制整段内容') }
}
export function savedConnection(root, env = process.env) {
  let value
  try { value = JSON.parse(fs.readFileSync(connectionFile(root), 'utf8')) } catch(e) { if(e.code === 'ENOENT') return null; throw e }
  const checked = validateConnection(value, env)
  const stateFile = path.join(root, 'data', 'authorization-onboarding', crypto.createHash('sha256').update(checked.centerUrl+'|'+checked.instanceId).digest('hex')+'.json')
  return { ...checked, stateFile }
}
export function applySavedConnection(root, env = process.env) {
  const config = savedConnection(root, env)
  if (!config) return
  Object.assign(env, { AI_AUTHORIZATION_MODE: 'center', AI_LICENSE_CENTER_URL: config.centerUrl, AI_LICENSE_INSTANCE_ID: config.instanceId, AI_ADMIN_PUBLIC_URL: config.publicUrl, AI_LICENSE_STATE_FILE: config.stateFile })
  if (!env.AI_BUILD_CENTER_URL) env.AI_BUILD_CENTER_URL = 'https://center.okpa.cn'
}
