// Client-executed functions are completion data, never commands executed by
// the gateway. Provider-hosted tools need their own reviewed billing adapter.
const MAX_FUNCTIONS = 1024
const invalid = () => Object.assign(new Error('文本函数调用参数无效，或包含尚未计费的服务端工具'), { statusCode: 400, code: 'INVALID_CHAT_FUNCTIONS' })
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const name = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/.test(value)

export function assertChatJsonData(value, maxBytes = 1024 * 1024) {
  const pending = [{ value, depth: 0 }]; let nodes = 0
  while (pending.length) {
    const item = pending.pop()
    if (++nodes > 65536 || item.depth > 64) throw invalid()
    const current = item.value
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number') { if (!Number.isFinite(current)) throw invalid(); continue }
    if (!object(current) && !Array.isArray(current)) throw invalid()
    for (const child of Object.values(current)) pending.push({ value: child, depth: item.depth + 1 })
  }
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw invalid()
  return value
}

function functions(input, modern) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input) || input.length > MAX_FUNCTIONS) throw invalid()
  return input.map(tool => {
    if (!object(tool) || (modern && (tool.type !== 'function' || !object(tool.function)))) throw invalid()
    const fn = modern ? tool.function : tool
    if (!name(fn.name) || (fn.description !== undefined && typeof fn.description !== 'string') || (fn.strict !== undefined && typeof fn.strict !== 'boolean')) throw invalid()
    if (fn.parameters !== undefined && fn.parameters !== null) {
      if (!object(fn.parameters) && typeof fn.parameters !== 'boolean') throw invalid()
      assertChatJsonData(fn.parameters)
    }
    return fn
  })
}

export function chatFunctionSchemaRoots(request) {
  const modern = functions(request?.tools, true), legacy = functions(request?.functions, false)
  if (modern.length && legacy.length) throw invalid()
  const all = [...modern, ...legacy]
  if (new Set(all.map(fn => fn.name)).size !== all.length) throw invalid()
  if (request?.parallel_tool_calls !== undefined && typeof request.parallel_tool_calls !== 'boolean') throw invalid()
  if (request?.tool_choice !== undefined && request.tool_choice !== null) {
    const choice = request.tool_choice
    if (typeof choice === 'string') { if (!['auto', 'none', 'required'].includes(choice) || (choice === 'required' && !modern.length)) throw invalid() }
    else if (!object(choice) || choice.type !== 'function' || !object(choice.function) || !modern.some(fn => fn.name === choice.function.name)) throw invalid()
    if (legacy.length) throw invalid()
  }
  if (request?.function_call !== undefined && request.function_call !== null) {
    const choice = request.function_call
    if (typeof choice === 'string') { if (!['auto', 'none'].includes(choice)) throw invalid() }
    else if (!object(choice) || !legacy.some(fn => fn.name === choice.name)) throw invalid()
    if (modern.length || (request.tool_choice !== undefined && request.tool_choice !== null)) throw invalid()
  }
  return new Set(all.map(fn => fn.parameters).filter(object))
}

export function validateChatFunctionMessages(request, { textOnly = false } = {}) {
  const roots = chatFunctionSchemaRoots(request)
  if (!Array.isArray(request.messages) || !request.messages.length || request.messages.length > 4096) throw invalid()
  for (const message of request.messages) {
    if (!object(message) || !['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(message.role)) throw invalid()
    const calls = message.tool_calls
    if (calls !== undefined && calls !== null) {
      if (message.role !== 'assistant' || !Array.isArray(calls) || !calls.length || calls.length > MAX_FUNCTIONS || message.function_call != null) throw invalid()
      const ids = new Set()
      for (const call of calls) {
        if (!object(call) || !name(call.id) || ids.has(call.id) || (call.type !== undefined && call.type !== 'function') || !object(call.function)
          || !name(call.function.name) || typeof call.function.arguments !== 'string') throw invalid()
        ids.add(call.id)
        for (const field of ['extra_content', 'provider_specific_fields']) if (call[field] !== undefined) assertChatJsonData(call[field])
      }
    }
    if (message.function_call != null && (message.role !== 'assistant' || !object(message.function_call) || !name(message.function_call.name) || typeof message.function_call.arguments !== 'string')) throw invalid()
    const hasCall = Boolean(calls?.length || message.function_call)
    if (message.content == null) { if (message.role !== 'assistant' || !hasCall) throw invalid() }
    else if (typeof message.content !== 'string' && (textOnly || !Array.isArray(message.content))) throw invalid()
    if (message.role === 'tool' && !name(message.tool_call_id)) throw invalid()
    if (message.role === 'function' && !name(message.name)) throw invalid()
    for (const field of ['reasoning_content', 'refusal']) if (message[field] != null && typeof message[field] !== 'string') throw invalid()
  }
  return roots
}

// Scope of okpa-v1 remains ordinary text-token consumption. Hosted search,
// audio, caching creation and vendor request overrides are not implicit add-ons.
const textFields = new Set(['model', 'messages', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'n', 'temperature', 'top_p', 'stop', 'seed',
  'frequency_penalty', 'presence_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'user', 'tools', 'tool_choice', 'parallel_tool_calls', 'functions', 'function_call', 'response_format', 'reasoning_effort'])
export function validateTextFunctionRequest(request) {
  if (!object(request) || Object.keys(request).some(key => !textFields.has(key))) throw invalid()
  const roots = validateChatFunctionMessages(request, { textOnly: true })
  const pending = [request]
  while (pending.length) {
    const current = pending.pop()
    if (!current || typeof current !== 'object' || roots.has(current)) continue
    for (const [key, child] of Object.entries(current)) {
      if (['cache_control', 'web_search_options', 'search_parameters', 'enable_search', 'audio', 'modalities'].includes(key)) throw invalid()
      pending.push(child)
    }
  }
  return request
}
