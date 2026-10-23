export const MODEL_TASKS = Object.freeze(['chat', 'image_generation', 'image_edit', 'speech_synthesis', 'speech_recognition', 'video_generation', 'embedding', 'rerank', 'web_search'])

export function normalizeTaskCapability(input = {}) {
  const task = String(input.taskType || '')
  const adapter = String(input.protocolAdapter || '')
  if (!MODEL_TASKS.includes(task)) throw new Error('不支持的模型任务能力')
  if (!adapter || !/^[a-z][a-z0-9_.-]{1,63}$/.test(adapter)) throw new Error('请选择明确的协议适配器')
  const endpointPath = String(input.endpointPath || '').trim()
  if (endpointPath && (!endpointPath.startsWith('/') || endpointPath.startsWith('//') || /[?#\\\s]/.test(endpointPath))) throw new Error('模型端点路径无效')
  return { taskType: task, protocolAdapter: adapter, endpointPath, status: input.status === 'disabled' ? 'disabled' : 'enabled' }
}

// Model names never participate in protocol selection.
export class ModelAdapterRegistry {
  #adapters = new Map()
  register(protocol, task, adapter) {
    const key = `${protocol}:${task}`
    if (this.#adapters.has(key)) throw new Error('协议适配器已注册')
    if (!MODEL_TASKS.includes(task) || typeof adapter?.invoke !== 'function') throw new Error('协议适配器无效')
    this.#adapters.set(key, adapter)
    return this
  }
  resolve(capability) {
    if (capability?.status !== 'enabled') throw new Error('模型任务能力未启用')
    const adapter = this.#adapters.get(`${capability.protocolAdapter}:${capability.taskType}`)
    if (!adapter) throw new Error('该任务尚未配置可执行的协议适配器')
    return adapter
  }
}

export function assertVoiceOwnership(voice, user, accountId) {
  if (!voice || !user?.id || !user.organizationId || voice.user_id !== user.id || voice.organization_id !== user.organizationId) {
    throw Object.assign(new Error('音色不存在或不可用'), { statusCode: 404, code: 'VOICE_NOT_FOUND' })
  }
  if (accountId && voice.upstream_account_id !== accountId) {
    throw Object.assign(new Error('音色必须使用创建它的上游账号'), { statusCode: 409, code: 'VOICE_ACCOUNT_MISMATCH' })
  }
  return voice
}

export function voicePrice(rule, operation, characters = 0) {
  const field = operation === 'clone' ? 'voice_preview_points' : operation === 'activate' ? 'voice_activation_points' : 'voice_points_per_1k_chars'
  if (!rule || rule.status !== 'enabled' || rule[field] == null || rule[field] === '' || !Number.isFinite(Number(rule[field])) || Number(rule[field]) < 0) {
    throw Object.assign(new Error('后台尚未配置此项语音价格'), { statusCode: 409, code: 'VOICE_PRICE_UNCONFIGURED' })
  }
  if (!Number.isSafeInteger(characters) || characters < 0) throw new Error('语音字符用量无效')
  return Math.ceil(Number(rule[field]) * (operation === 'clone' || operation === 'activate' ? 1 : characters / 1000) * 1e6) / 1e6
}
