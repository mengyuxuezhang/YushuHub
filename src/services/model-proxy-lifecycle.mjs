const DOWNSTREAM_ABORT_REASONS = new Set(['client_request_aborted', 'downstream_closed'])

export function isDownstreamAbortReason(reason) {
  return DOWNSTREAM_ABORT_REASONS.has(String(reason || ''))
}

export function createModelProxyLifecycle({ req, res, timeoutMs, onAbort }) {
  const controller = new AbortController()
  const normalizedTimeoutMs = Math.max(10, Number(timeoutMs || 120000))
  let abortReason = ''
  let headerTimer = null

  const abort = (reason) => {
    if (controller.signal.aborted) return
    abortReason = String(reason || 'aborted')
    if (headerTimer) clearTimeout(headerTimer)
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

  return {
    signal: controller.signal,
    get abortReason() {
      return abortReason
    },
    clearHeaderTimeout() {
      if (headerTimer) clearTimeout(headerTimer)
      headerTimer = null
    },
    cleanup() {
      if (headerTimer) clearTimeout(headerTimer)
      headerTimer = null
      req.removeListener('aborted', onRequestAborted)
      res.removeListener('close', onResponseClose)
    },
  }
}
