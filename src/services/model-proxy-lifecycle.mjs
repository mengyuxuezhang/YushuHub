const DOWNSTREAM_ABORT_REASONS = new Set(['client_request_aborted', 'downstream_closed'])

export function isDownstreamAbortReason(reason) {
  return DOWNSTREAM_ABORT_REASONS.has(String(reason || ''))
}

export function createModelProxyLifecycle({ req, res, timeoutMs, onAbort, idleTimeoutMs = 180000, maxDurationMs = 900000 }) {
  const controller = new AbortController()
  const normalizedTimeoutMs = Math.max(10, Number(timeoutMs || 120000))
  let abortReason = ''
  let headerTimer = null
  let idleTimer = null
  let totalTimer = null

  const abort = (reason) => {
    if (controller.signal.aborted) return
    abortReason = String(reason || 'aborted')
    if (headerTimer) clearTimeout(headerTimer)
    if (idleTimer) clearTimeout(idleTimer)
    if (totalTimer) clearTimeout(totalTimer)
    controller.abort(new Error(abortReason))
    onAbort?.(abortReason)
  }

  const onRequestAborted = () => abort('client_request_aborted')
  const onResponseClose = () => {
    if (!res.writableEnded) abort('downstream_closed')
  }

  req.once('aborted', onRequestAborted)
  res.once('close', onResponseClose)
  headerTimer = setTimeout(() => abort('provider_headers_timeout'), normalizedTimeoutMs)
  totalTimer = setTimeout(() => abort('model_duration_timeout'), maxDurationMs)
  totalTimer.unref?.()
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer)
    if (!controller.signal.aborted) {
      idleTimer = setTimeout(() => abort('model_stream_idle_timeout'), idleTimeoutMs)
      idleTimer.unref?.()
    }
  }

  return {
    signal: controller.signal,
    get abortReason() {
      return abortReason
    },
    clearHeaderTimeout() {
      if (headerTimer) clearTimeout(headerTimer)
      headerTimer = null
      touch()
    },
    touch,
    cleanup() {
      if (headerTimer) clearTimeout(headerTimer)
      headerTimer = null
      clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      req.removeListener('aborted', onRequestAborted)
      res.removeListener('close', onResponseClose)
    },
  }
}
