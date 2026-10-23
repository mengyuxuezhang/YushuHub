import { ModelInvocationError } from './errors.mjs'

function assertAdapter(adapter) {
  if (!adapter || !/^[a-z][a-z0-9_.-]{1,63}$/.test(adapter.id || '') || typeof adapter.supports !== 'function' || typeof adapter.submit !== 'function') {
    throw new Error('协议适配器无效')
  }
}

export class ProtocolAdapterRegistry {
  #adapters = new Map()
  #manifest

  constructor(manifest, adapters = []) {
    this.#manifest = manifest
    for (const adapter of adapters) {
      assertAdapter(adapter)
      if (this.#adapters.has(adapter.id)) throw new Error(`协议适配器重复：${adapter.id}`)
      this.#adapters.set(adapter.id, Object.freeze(adapter))
    }
  }

  resolve(capability) {
    if (!capability || capability.status !== 'enabled') throw new ModelInvocationError('configuration', '模型任务能力未启用')
    const taskType = String(capability.taskType || capability.task_type || '')
    const protocolId = String(capability.protocolAdapter || capability.protocol_adapter || '')
    this.#manifest.resolve(protocolId, taskType)
    const adapter = this.#adapters.get(protocolId)
    if (!adapter || !adapter.supports(taskType)) throw new ModelInvocationError('adapter_not_found', `协议 ${protocolId} 尚未实现任务 ${taskType}`)
    return adapter
  }
}

export function completed(result, usage = []) {
  return Object.freeze({ state: 'done', result, usage: Object.freeze([...usage]) })
}

export function pending(job, usage = []) {
  const safe = {
    adapterId: String(job?.adapterId || ''),
    configRevision: Number(job?.configRevision || 0),
    remoteId: String(job?.remoteId || ''),
    pollState: job?.pollState && typeof job.pollState === 'object' ? job.pollState : {},
  }
  if (!safe.adapterId || !Number.isSafeInteger(safe.configRevision) || safe.configRevision < 1 || !safe.remoteId) throw new Error('异步任务句柄无效')
  const serialized = JSON.stringify(safe)
  if (/api[_-]?key|authorization|credential|https?:\/\//i.test(serialized)) throw new Error('异步任务句柄包含敏感连接信息')
  return Object.freeze({ state: 'pending', job: Object.freeze(safe), usage: Object.freeze([...usage]) })
}

export class ModelInvocationService {
  constructor(registry) { this.registry = registry }

  async submit(context, capability, request) {
    const adapter = this.registry.resolve(capability)
    return adapter.submit(context, request, capability)
  }

  async poll(context, capability, job) {
    const adapter = this.registry.resolve(capability)
    const revision = Number(capability.configRevision || capability.config_revision || 1)
    if (job.adapterId !== adapter.id || job.configRevision !== revision) throw new ModelInvocationError('configuration', '模型协议或连接配置已变化，不能继续轮询旧任务')
    if (typeof adapter.poll !== 'function') throw new ModelInvocationError('unsupported_task', '该协议不支持异步任务查询')
    return adapter.poll(context, job, capability)
  }
}
