import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { compareSemanticVersions } from '../utils/version.mjs'

const ACTIVE = new Set(['accepted', 'requested', 'pulling', 'prepared', 'draining', 'stopped', 'starting', 'verifying', 'rolling_back'])
export const isContainerDeployment = (env = process.env) => env.AI_ADMIN_DEPLOYMENT_MODE === 'docker'

export function controllerRequest(endpoint, { method = 'GET', operationId, env = process.env } = {}) {
  const socketPath = env.AI_ADMIN_UPGRADE_SOCKET || '/run/yushuhub-upgrade.sock'
  const instance = env.AI_ADMIN_UPGRADE_INSTANCE_ID
  if (!path.isAbsolute(socketPath) || !/^[a-z][a-z0-9-]{0,47}$/.test(instance || '')) throw new Error('独立升级服务尚未绑定此实例，请使用部署工具检查连接')
  if (!['/v1/status', '/v1/upgrade', '/v1/rollback', '/v1/recover'].includes(endpoint)) throw new Error('不支持的升级操作')
  return new Promise((resolve, reject) => {
    const body = method === 'POST' ? JSON.stringify({ operationId: operationId || crypto.randomUUID() }) : ''
    const request = http.request({ socketPath, path: endpoint, method,
      headers: { 'X-Yushuhub-Instance': instance, 'content-type': 'application/json', ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
    }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        text += chunk
        if (text.length > 131072) request.destroy(new Error('升级状态响应过大'))
      })
      response.on('end', () => {
        let result
        try { result = JSON.parse(text) } catch { return reject(new Error('独立升级服务返回无效状态')) }
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(response.statusCode === 409 ? '已有升级任务或实例绑定不一致，请检查独立升级工具' : '独立升级服务暂不可用，请使用部署工具查看任务'))
        if (method === 'GET' && (result.protocolVersion !== 1 || result.instanceId !== instance)) return reject(new Error('独立升级服务的实例身份不匹配'))
        resolve(result)
      })
    })
    request.setTimeout(12000, () => request.destroy(new Error('独立升级服务响应超时，任务可能仍在进行，请重新检测状态')))
    request.on('error', () => reject(new Error('独立升级服务连接中断，任务可能仍在进行，请重新检测状态或使用部署工具恢复')))
    request.end(body)
  })
}

export async function getControllerUpdateStatus({ runningVersion, env = process.env, request = controllerRequest } = {}) {
  const value = await request('/v1/status', { env })
  const task = value.transaction || {}
  const mismatch = Boolean(value.currentVersion && value.currentVersion !== runningVersion)
  return { deploymentMode: 'docker', enabled: value.configured, configured: value.configured,
    currentVersion: runningVersion, runningVersion, diskVersion: runningVersion,
    controllerVersion: value.currentVersion || '', versionMismatch: mismatch,
    latestVersion: value.latestVersion || '', updateAvailable: (compareSemanticVersions(value.latestVersion, runningVersion) || 0) > 0,
    inProgress: ACTIVE.has(task.stage), upgradeTask: task,
    releaseNotes: value.releaseNotes || '', publishedAt: value.publishedAt || '', history: value.history || [],
    sourceWarning: value.sourceWarning ? '更新源暂不可用，当前使用最近验证过的版本清单' : '',
    manifestUrl: '', envManifestUrl: '', lastLog: task.error ? `任务状态：${task.stage}\n错误代码：${task.error}` : `任务状态：${task.stage || '尚未提交'}${task.operationId ? '\n任务编号：' + task.operationId : ''}`,
  }
}

export async function submitControllerUpgrade({ runningVersion, action = 'upgrade', env = process.env, request = controllerRequest } = {}) {
  if (!['upgrade', 'rollback', 'recover'].includes(action)) throw new Error('不支持的升级操作')
  const status = await getControllerUpdateStatus({ runningVersion, env, request })
  const result = await request('/v1/' + action, { method: 'POST', env })
  return { ...status,
    inProgress: true, upgradeTask: { ...result }, message: '升级任务已提交，服务将短暂中断，请在恢复后核对任务结果' }
}
