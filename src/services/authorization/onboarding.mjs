import sync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { connectionFile, validateConnection, decodeConnectionText, checkedKeys, savedConnection } from './connection-config.mjs'
import { createDeploymentClient, emptyDeploymentState } from './deployment-client.mjs'
import { fileStateStore } from '../../repositories/authorization-file-state.mjs'
import { digest, domain, failure, verifyClaims } from './protocol.mjs'

const keyFingerprint = key => crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64')
export function createAuthorizationOnboarding({ root, env = process.env, fetchImpl = fetch, runtimeClient, legacySupplierId = async () => env.AI_BUILD_CENTER_SUPPLIER_ID }) {
  let pending = false
  const current = () => savedConnection(root, env)
  function environmentState() {
    try { return JSON.parse(sync.readFileSync(path.resolve(root, env.AI_LICENSE_STATE_FILE || 'data/deployment-license.json'), 'utf8')) } catch { return null }
  }
  function previousConnection() {
    const saved = current()
    if (!saved && env.AI_AUTHORIZATION_MODE === 'legacy') return null
    const stateFile = saved?.stateFile || path.resolve(root, env.AI_LICENSE_STATE_FILE || 'data/deployment-license.json')
    let state
    try { state = JSON.parse(sync.readFileSync(stateFile, 'utf8')) } catch(e) { if (e.code !== 'ENOENT') throw failure('RECOVERY_STATE_UNREADABLE', '实例状态无法读取，请联系部署人员核对备份', 409) }
    if (!saved && !state?.rootId) return null
    const publicKeys = saved?.publicKeys || (env.AI_LICENSE_PUBLIC_KEYS_FILE ? JSON.parse(sync.readFileSync(env.AI_LICENSE_PUBLIC_KEYS_FILE, 'utf8')) : {})
    return { config: saved || { licenseId: state.rootId, centerUrl: domain(env.AI_LICENSE_CENTER_URL), publicUrl: domain(env.AI_ADMIN_PUBLIC_URL), instanceId: env.AI_LICENSE_INSTANCE_ID, publicKeys, stateFile }, state }
  }
  async function status() {
    const view = state()
    if (view.requiresRestart) return { ...view, authorizationStatus: 'pending' }
    const previous = previousConnection()
    if (!previous) return { ...view, authorizationStatus: 'unconfigured' }
    if (!previous.state?.credential) return { ...view, authorizationStatus: 'invalid', message: '旧实例凭据缺失，请联系授权人员核对备份后恢复。' }
    const config = previous.config
    const client = runtimeClient || createDeploymentClient({ ...config, store: fileStateStore(config.stateFile, emptyDeploymentState()), fetchImpl })
    try {
      const refreshed = await client.refresh(true)
      if (refreshed.stale) return { ...view, authorizationStatus: 'unavailable', message: '暂时无法连接授权中心，请稍后刷新，尚不能确认授权是否失效。' }
      await client.claims()
      return { ...view, authorizationStatus: 'active' }
    } catch(e) {
      return { ...view, authorizationStatus: [401, 403].includes(e.statusCode) ? 'invalid' : 'unavailable', message: [401, 403].includes(e.statusCode) ? '原授权已失效或校验未通过，可粘贴同一部署的新接入信息重新授权。' : '暂时无法核对授权中心，请稍后重试。' }
    }
  }
  async function activate(input) {
    if (pending) throw failure('ONBOARDING_BUSY', '接入正在处理，请勿重复提交', 409)
    pending = true
    try {
      const existing = current()
      const packet = input?.text ? decodeConnectionText(input.text) : input
      const config = validateConnection(packet, env)
      if (existing && existing.licenseId === config.licenseId && existing.instanceId === config.instanceId) {
        const pendingRestart = env.AI_AUTHORIZATION_MODE !== 'center' || env.AI_LICENSE_INSTANCE_ID !== existing.instanceId
        if (!pendingRestart && (await status()).authorizationStatus !== 'active') throw failure('OLD_CONNECTION_INVALID', '这份接入信息属于原连接，请获取重新签发的新接入信息', 409)
        return { activated: true, requiresRestart: pendingRestart, licenseId: existing.licenseId }
      }
      const previous = previousConnection()
      if (previous && (config.centerUrl !== previous.config.centerUrl || config.publicUrl !== previous.config.publicUrl)) throw failure('RECOVERY_BINDING_MISMATCH', '重新授权必须使用原中心及原部署地址', 403)
      if (previous && (!previous.state?.credential || previous.state.rootId !== previous.config.licenseId)) throw failure('RECOVERY_CREDENTIAL_MISSING', '缺少匹配的旧实例凭据，请联系授权人员核对备份后恢复', 409)
      if (!/^[A-Za-z0-9_-]{43}$/.test(packet.activationCode || '')) throw failure('INVALID_CODE', '激活码格式不正确')
      const previousSupplierId = env.AI_AUTHORIZATION_MODE === 'legacy' ? await legacySupplierId() : null
      if (previousSupplierId && config.licenseId !== previousSupplierId) throw failure('ORGANIZATION_MISMATCH', '接入授权与原供应商身份不符，请联系授权人员核对')
      const response = await fetchImpl(config.centerUrl + '/api/license-center/v1/onboarding-keys', { redirect: 'error', signal: AbortSignal.timeout(8000) })
      if (!response.ok) throw failure('CENTER_UNAVAILABLE', '暂时无法核对授权中心，请稍后重试', 503)
      const raw = await response.text(); if (raw.length > 40000) throw failure('INVALID_TRUST_KEYS', '中心公钥响应无效')
      const reply = JSON.parse(raw)
      if (!reply.success || reply.data?.centerUrl !== config.centerUrl) throw failure('INVALID_TRUST_KEYS', '中心地址与接入信息不符')
      if (previous && reply.data.authorizationRecovery !== 1) throw failure('CENTER_UPGRADE_REQUIRED', '授权中心需要升级后才能接续失效授权，原连接保持不变', 409)
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
      const previousBinding = previous ? { grantId: previous.config.licenseId, credential: previous.state.credential, instanceId: previous.config.instanceId, domain: previous.config.publicUrl } : undefined
      const grant = await client.activate(packet.activationCode, previousBinding)
      if (previous && (grant.businessId !== (previous.state.metadata?.businessId || previous.config.licenseId) || !grant.previousLicenseIds?.includes(previous.config.licenseId))) throw failure('RECOVERY_NOT_CONFIRMED', '中心未确认历史业务身份接续，原连接保持不变', 403)
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
  return { activate, state, status }
}
