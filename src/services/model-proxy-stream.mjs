function closedError() { return new Error('downstream_closed') }

export function waitForModelDrain(res, signal) {
  if (signal.aborted || res.destroyed || res.writableEnded) return Promise.reject(signal.reason || closedError())
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.removeListener('drain', drained)
      res.removeListener('close', closed)
      res.removeListener('error', failed)
      signal.removeEventListener('abort', aborted)
    }
    const drained = () => { cleanup(); resolve() }
    const failed = error => { cleanup(); reject(error) }
    const closed = () => failed(closedError())
    const aborted = () => failed(signal.reason || closedError())
    res.once('drain', drained); res.once('close', closed); res.once('error', failed)
    signal.addEventListener('abort', aborted, { once: true })
    // Covers a close/abort that occurred while handlers were being installed.
    if (signal.aborted || res.destroyed || res.writableEnded) aborted()
  })
}

// Metadata parsing never changes the bytes forwarded to Desktop (including signed frames).
export async function forwardModelStream(upstream, res, lifecycle, maxMetadataLine = 1024 * 1024) {
  const reader = upstream.body?.getReader()
  let usage = null, requestId = upstream.headers.get('x-request-id') || ''
  if (!reader) return { usage, requestId }
  const decoder = new TextDecoder()
  let line = '', discard = false, complete = false
  const parse = value => {
    const trimmed = value.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return
    try { const event = JSON.parse(data); if (event.usage) usage = event.usage; if (event.id) requestId = String(event.id) } catch {}
  }
  try {
    while (true) {
      lifecycle.signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      lifecycle.touch()
      if (res.destroyed || res.writableEnded) throw closedError()
      if (!res.write(Buffer.from(value))) {
        try { await waitForModelDrain(res, lifecycle.signal) }
        catch (error) {
          if (['model_stream_idle_timeout', 'model_duration_timeout'].includes(lifecycle.abortReason)) {
            throw Object.assign(new Error('下游读取超时', { cause: error }), { code: 'MODEL_DOWNSTREAM_STALLED' })
          }
          throw error
        }
      }
      // Bound observation memory even for an oversized/non-newline provider frame.
      const pieces = decoder.decode(value, { stream: true }).split('\n')
      for (let i = 0; i < pieces.length; i++) {
        if (!discard) {
          if (line.length + pieces[i].length > maxMetadataLine) { discard = true; line = '' }
          else line += pieces[i]
        }
        if (i < pieces.length - 1) { if (!discard) parse(line); line = ''; discard = false }
      }
    }
    lifecycle.signal.throwIfAborted()
    if (!discard) parse(line + decoder.decode())
    complete = true
    return { usage, requestId }
  } finally {
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
