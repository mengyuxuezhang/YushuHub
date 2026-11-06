import sync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { connectionFile, validateConnection, decodeConnectionText, checkedKeys, savedConnection } from './connection-config.mjs'
import { createDeploymentClient, emptyDeploymentState } from './deployment-client.mjs'
import { fileStateStore } from '../../repositories/authorization-file-state.mjs'
import { digest, failure, verifyClaims } from './protocol.mjs'

const keyFingerprint = key => crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64')
export function createAuthorizationOnboarding({ root, env = process.env, fetchImpl = fetch, legacySupplierId = async () => env.AI_BUILD_CENTER_SUPPLIER_ID }) {
  let pending = false
  const current = () => savedConnection(root, env)
  function environmentState() {
    try { return JSON.parse(sync.readFileSync(path.resolve(root, env.AI_LICENSE_STATE_FILE || 'data/deployment-license.json'), 'utf8')) } catch { return null }
  }
  async function activate(input) {
    if (pending) throw failure('ONBOARDING_BUSY', '接入正在处理，请勿重复提交', 409)
    pending = true
    try {
      const existing = current()
      if (existing) return { activated: true, requiresRestart: env.AI_AUTHORIZATION_MODE !== 'center' || env.AI_LICENSE_INSTANCE_ID !== existing.instanceId, licenseId: existing.licenseId }
      const packet = input?.text ? decodeConnectionText(input.text) : input
      const config = validateConnection(packet, env)
      if (!/^[A-Za-z0-9_-]{43}$/.test(packet.activationCode || '')) throw failure('INVALID_CODE', '激活码格式不正确')
      const previousSupplierId = env.AI_AUTHORIZATION_MODE === 'legacy' ? await legacySupplierId() : null
      if (previousSupplierId && config.licenseId !== previousSupplierId) throw failure('ORGANIZATION_MISMATCH', '接入授权与原供应商身份不符，请联系授权人员核对')
      if ((env.AI_AUTHORIZATION_MODE || 'center') === 'center' && environmentState()?.rootId) throw failure('ALREADY_CONFIGURED', '已有中心实例，请使用续期或部署迁移', 409)
      const response = await fetchImpl(config.centerUrl + '/api/license-center/v1/onboarding-keys', { redirect: 'error', signal: AbortSignal.timeout(8000) })
      if (!response.ok) throw failure('CENTER_UNAVAILABLE', '暂时无法核对授权中心，请稍后重试', 503)
      const raw = await response.text(); if (raw.length > 40000) throw failure('INVALID_TRUST_KEYS', '中心公钥响应无效')
      const reply = JSON.parse(raw)
      if (!reply.success || reply.data?.centerUrl !== config.centerUrl) throw failure('INVALID_TRUST_KEYS', '中心地址与接入信息不符')
      const trustedKeys = checkedKeys(reply.data.publicKeys)
      for (const [id, key] of Object.entries(config.publicKeys)) if (!Object.hasOwn(trustedKeys, id) || keyFingerprint(key) !== keyFingerprint(trustedKeys[id])) throw failure('INVALID_TRUST_KEYS', '接入公钥与可信中心不一致')
      if (input?.text) {
        if (packet.format !== 'yushu-authorization-connection' || packet.version !== 1) throw failure('INVALID_CONNECTION', '不支持的接入信息版本')
        const proof = verifyClaims(packet.proof, { keys: trustedKeys, audience: 'authorization-onboarding', instanceId: config.instanceId })
        if (proof.sub !== config.licenseId || proof.origin !== config.publicUrl || proof.centerUrl !== config.centerUrl || proof.codeDigest !== digest(packet.activationCode)) throw failure('INVALID_CONNECTION', '接入信息已被修改，请重新向授权人员获取')
      }
      const directory = path.join(root, 'data', 'authorization-onboarding')
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const stateFile = path.join(directory, crypto.createHash('sha256').update(config.centerUrl+'|'+config.instanceId).digest('hex')+'.json')
      const client = createDeploymentClient({ centerUrl: config.centerUrl, publicUrl: config.publicUrl, instanceId: config.instanceId, publicKeys: trustedKeys, fetchImpl, store: fileStateStore(stateFile, emptyDeploymentState()) })
      const grant = await client.activate(packet.activationCode)
      if (grant.id !== config.licenseId) throw failure('ORGANIZATION_MISMATCH', '激活结果与授权主体不符', 403)
      const target = connectionFile(root), temporary = target+'.'+crypto.randomUUID()+'.tmp'
      try { await fs.writeFile(temporary, JSON.stringify({ ...config, publicKeys: trustedKeys }), { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, target) }
      finally { await fs.rm(temporary, { force: true }) }
      return { activated: true, requiresRestart: true, licenseId: grant.id }
    } catch (error) {
      if (error.code && error.statusCode) throw error
      throw failure('ONBOARDING_FAILED', '接入未完成，原授权配置保持不变，请检查网络和接入信息后重试', 502)
    } finally { pending = false }
  }
  function state() {
    const configured = current()
    const active = !configured && (env.AI_AUTHORIZATION_MODE || 'center') === 'center' ? environmentState() : null
    const config = configured || (active?.rootId ? {
      licenseId: active.rootId, centerUrl: env.AI_LICENSE_CENTER_URL,
      publicUrl: env.AI_ADMIN_PUBLIC_URL, instanceId: env.AI_LICENSE_INSTANCE_ID,
    } : null)
    const connection = config ? {
      centerUrl: config.centerUrl, publicUrl: config.publicUrl,
      instanceId: config.instanceId, licenseId: config.licenseId,
    } : null
    return {
      configured: Boolean(config), connection,
      requiresRestart: Boolean(configured && (env.AI_AUTHORIZATION_MODE !== 'center' || env.AI_LICENSE_INSTANCE_ID !== config.instanceId)),
    }
  }
  return { activate, state }
}
