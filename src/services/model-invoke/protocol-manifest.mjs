export const MODEL_TASK_TYPES = Object.freeze([
  'chat',
  'image_generation',
  'image_edit',
  'speech_synthesis',
  'speech_recognition',
  'video_generation',
  'embedding',
  'rerank',
  'web_search',
])

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const ENDPOINT_FIELDS = new Set(['submit', 'poll', 'content'])

function text(value, label, pattern, max = 128) {
  const result = String(value || '').trim()
  if (!result || result.length > max || (pattern && !pattern.test(result))) throw new Error(`${label}无效`)
  return result
}

export function normalizeProtocolDescriptor(input = {}) {
  const id = text(input.id, '协议 ID', /^[a-z][a-z0-9_.-]+$/, 64)
  const tasks = [...new Set(Array.isArray(input.tasks) ? input.tasks.map(String) : [])]
  if (!tasks.length || tasks.some(task => !MODEL_TASK_TYPES.includes(task))) throw new Error(`协议 ${id} 的任务类型无效`)
  const transport = ['http', 'websocket', 'sdk'].includes(input.transport) ? input.transport : 'http'
  const executor = ['sync', 'async_job', 'stream', 'session'].includes(input.executor) ? input.executor : 'sync'
  const endpoints = (Array.isArray(input.endpoints) ? input.endpoints : []).map(endpoint => {
    const taskType = text(endpoint.taskType, '端点任务类型', null, 48)
    const field = text(endpoint.field, '端点用途', null, 24)
    const method = text(endpoint.method || 'POST', 'HTTP 方法', null, 8).toUpperCase()
    const template = String(endpoint.template || '').trim()
    if (!tasks.includes(taskType) || !ENDPOINT_FIELDS.has(field) || !HTTP_METHODS.has(method)) throw new Error(`协议 ${id} 的端点声明无效`)
    if (transport !== 'sdk' && (!template.startsWith('/') || template.startsWith('//') || /[\\\s]/.test(template))) throw new Error(`协议 ${id} 的端点模板无效`)
    return Object.freeze({ taskType, field, method, template })
  })
  if (transport !== 'sdk' && tasks.some(task => !endpoints.some(endpoint => endpoint.taskType === task && endpoint.field === 'submit'))) {
    throw new Error(`协议 ${id} 缺少提交端点`)
  }
  return Object.freeze({ id, tasks: Object.freeze(tasks), transport, executor, requiresCredential: input.requiresCredential !== false, connectionRole: String(input.connectionRole || ''), endpoints: Object.freeze(endpoints) })
}

export class ProtocolManifestRegistry {
  #descriptors = new Map()

  constructor(descriptors = []) {
    for (const input of descriptors) {
      const descriptor = normalizeProtocolDescriptor(input)
      if (this.#descriptors.has(descriptor.id)) throw new Error(`协议 ID 重复：${descriptor.id}`)
      this.#descriptors.set(descriptor.id, descriptor)
    }
  }

  resolve(protocolId, taskType) {
    const descriptor = this.#descriptors.get(String(protocolId || ''))
    if (!descriptor || !descriptor.tasks.includes(taskType)) throw new Error(`协议 ${protocolId || '-'} 不支持任务 ${taskType || '-'}`)
    return descriptor
  }

  list() { return [...this.#descriptors.values()] }
}

export const BUILTIN_PROTOCOLS = Object.freeze([
  normalizeProtocolDescriptor({ id: 'openai.chat_text', tasks: ['chat'], executor: 'stream', endpoints: [{ taskType: 'chat', field: 'submit', method: 'POST', template: '/chat/completions' }] }),
  normalizeProtocolDescriptor({ id: 'openai.images', tasks: ['image_generation', 'image_edit'], endpoints: [
    { taskType: 'image_generation', field: 'submit', method: 'POST', template: '/images/generations' },
    { taskType: 'image_edit', field: 'submit', method: 'POST', template: '/images/edits' },
  ] }),
  normalizeProtocolDescriptor({ id: 'minimax.t2a', tasks: ['speech_synthesis'], endpoints: [{ taskType: 'speech_synthesis', field: 'submit', method: 'POST', template: '/v1/t2a_v2' }] }),
  normalizeProtocolDescriptor({ id: 'mock.video_jobs', tasks: ['video_generation'], executor: 'async_job', requiresCredential: false, endpoints: [
    { taskType: 'video_generation', field: 'submit', method: 'POST', template: '/mock/videos' },
    { taskType: 'video_generation', field: 'poll', method: 'GET', template: '/mock/videos/{id}' },
  ] }),
  normalizeProtocolDescriptor({ id: 'mock.embeddings', tasks: ['embedding'], requiresCredential: false, endpoints: [{ taskType: 'embedding', field: 'submit', method: 'POST', template: '/mock/embeddings' }] }),
])

// Presets only prefill configuration. Runtime dispatch never reads this table.
export const PROTOCOL_PRESETS = Object.freeze({
  openai: Object.freeze({ chat: 'openai.chat_text', image_generation: 'openai.images', image_edit: 'openai.images' }),
  minimax: Object.freeze({ speech_synthesis: 'minimax.t2a' }),
})
