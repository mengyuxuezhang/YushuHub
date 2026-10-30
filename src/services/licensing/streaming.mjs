import { failure } from './protocol.mjs'

// Incremental SSE parser shared by the provider stream and the private gateway
// hop. Limits apply even when the downstream reader has disconnected.
export async function readSse(response, receive, { maxBytes = 48 * 1024 * 1024, maxFrame = 1024 * 1024 } = {}) {
  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    await response.body?.cancel().catch(() => {})
    throw failure('INVALID_STREAM', '上游没有返回有效事件流', 502)
  }
  const reader = response.body?.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  if (!reader) throw failure('INVALID_STREAM', '上游事件流不可用', 502)
  let buffer = '', data = [], event = 'message', bytes = 0, frames = 0, frameBytes = 0, complete = false
  async function line(value) {
    if (value === '') {
      if (data.length) {
        if (++frames > 50_000) throw failure('STREAM_LIMIT', '上游事件流超过限制', 502)
        await receive({ event, data: data.join('\n') })
      }
      data = []; event = 'message'; frameBytes = 0
      return
    }
    frameBytes += Buffer.byteLength(value)
    if (frameBytes > maxFrame) throw failure('STREAM_LIMIT', '上游事件过大', 502)
    if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''))
    else if (value.startsWith('event:')) event = value.slice(6).trim()
  }
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) { buffer += decoder.decode(); break }
      bytes += next.value.byteLength
      if (bytes > maxBytes) throw failure('STREAM_LIMIT', '上游事件流超过限制', 502)
      buffer += decoder.decode(next.value, { stream: true })
      let index
      while ((index = buffer.search(/[\r\n]/)) >= 0) {
        if (buffer[index] === '\r' && index === buffer.length - 1) break
        const value = buffer.slice(0, index), count = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1
        buffer = buffer.slice(index + count); await line(value)
      }
      if (Buffer.byteLength(buffer) + frameBytes > maxFrame) throw failure('STREAM_LIMIT', '上游事件过大', 502)
    }
    let index
    while ((index = buffer.search(/[\r\n]/)) >= 0) {
      const value = buffer.slice(0, index), count = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1
      buffer = buffer.slice(index + count); await line(value)
    }
    // An unterminated final event is not a complete protocol message.
    if (buffer || data.length) throw failure('TRUNCATED_STREAM', '上游事件流不完整，需要对账', 502)
    complete = true
  } finally {
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function emitChunk(callback, chunk) {
  // Delivery failure cannot change the supplier outcome or release money.
  try { await callback?.(chunk) } catch { /* continue draining bounded upstream */ }
}

export function chatStreamCollector() {
  let usage, metadata, content = '', reasoning = '', refusal = '', finish, size = 0
  return {
    add(value) {
      if (value.error || !Array.isArray(value.choices) || value.choices.length > 1 || typeof value.id !== 'string' || value.id.length > 256
        || typeof value.model !== 'string' || value.model.length > 256 || !Number.isSafeInteger(value.created)) throw failure('INVALID_STREAM', '上游文本事件无效', 502)
      if (metadata && (metadata.id !== value.id || metadata.model !== value.model)) throw failure('INVALID_STREAM', '上游请求身份发生变化', 502)
      metadata ||= { id: value.id, created: value.created, model: value.model }
      const choices = value.choices.map(choice => {
        if (choice.index !== 0 || !choice.delta || choice.delta.tool_calls || choice.delta.function_call) throw failure('UNSUPPORTED_STREAM', '该事件不属于纯文本流', 502)
        const delta = {}
        for (const key of ['role', 'content', 'reasoning_content', 'refusal']) if (choice.delta[key] !== undefined && choice.delta[key] !== null) {
          if (typeof choice.delta[key] !== 'string') throw failure('INVALID_STREAM', '文本增量无效', 502)
          delta[key] = choice.delta[key]; size += Buffer.byteLength(delta[key])
        }
        if (size > 8 * 1024 * 1024) throw failure('STREAM_LIMIT', '文本结果超过存储限制', 502)
        content += delta.content || ''; reasoning += delta.reasoning_content || ''; refusal += delta.refusal || ''
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          if (typeof choice.finish_reason !== 'string' || choice.finish_reason.length > 80) throw failure('INVALID_STREAM', '结束原因无效', 502)
          finish = choice.finish_reason
        }
        return { index: 0, delta, finish_reason: choice.finish_reason || null }
      })
      if (value.usage) {
        const u = value.usage, cached = u.prompt_tokens_details?.cached_tokens || 0
        if (!Number.isSafeInteger(u.prompt_tokens) || u.prompt_tokens < 0 || !Number.isSafeInteger(u.completion_tokens) || u.completion_tokens < 0
          || !Number.isSafeInteger(cached) || cached < 0 || cached > u.prompt_tokens) throw failure('INVALID_USAGE', '上游流式用量无效', 502)
        usage = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.prompt_tokens + u.completion_tokens,
          prompt_tokens_details: { cached_tokens: cached } }
      }
      return { ...metadata, object: 'chat.completion.chunk', choices, ...(value.usage ? { usage } : {}) }
    },
    result() {
      if (!finish || !usage) throw failure('TRUNCATED_STREAM', '上游缺少结束原因或最终用量，需要对账', 502)
      return { ...metadata, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content,
        ...(reasoning ? { reasoning_content: reasoning } : {}), ...(refusal ? { refusal } : {}) }, finish_reason: finish }], usage }
    },
  }
}

export async function readChatStream(response, onChunk) {
  let done = false
  const collector = chatStreamCollector()
  await readSse(response, async frame => {
    if (frame.event !== 'message') throw failure('INVALID_STREAM', '上游事件类型不受支持', 502)
    if (frame.data === '[DONE]') { if (done) throw failure('INVALID_STREAM', '上游结束标记重复', 502); done = true; return }
    if (done) throw failure('INVALID_STREAM', '上游结束后仍有数据', 502)
    await emitChunk(onChunk, collector.add(JSON.parse(frame.data)))
  })
  if (!done) throw failure('TRUNCATED_STREAM', '上游缺少结束标记，需要对账', 502)
  return collector.result()
}

// Lazy headers preserve normal HTTP errors before acceptance. A slow/closed
// socket is detached, while the owning request continues bounded settlement.
export function sseWriter(res) {
  let opened = false, closed = false, timer
  const detach = () => { closed = true; clearInterval(timer) }
  res.on('close', detach); res.on('error', detach)
  const writer = {
    get opened() { return opened },
    open() {
      if (opened || closed || res.destroyed) return
      opened = true; res.status(200); res.type('text/event-stream')
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders?.()
      res.write(': accepted\n\n')
      timer = setInterval(() => writer.write(': keepalive\n\n'), 15_000); timer.unref()
    },
    write(text) {
      if (closed || res.destroyed) return false
      writer.open()
      try {
        if (res.writableLength > 1024 * 1024 || Buffer.byteLength(text) > 1024 * 1024) { detach(); res.destroy(); return false }
        res.write(text); return true
      } catch { detach(); return false }
    },
    event(event, data) { return writer.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) },
    chunk(data) { return writer.write(`data: ${JSON.stringify(data)}\n\n`) },
    end(done = false) { if (!closed) { if (done) writer.write('data: [DONE]\n\n'); res.end() }; detach() },
  }
  return writer
}
