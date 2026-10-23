export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface ApiEnvelope<T> {
  success: boolean
  data: T
  error?: string
}

const DATABASE_ERROR_PATTERNS = [
  /duplicate entry/i,
  /doesn't have a default value/i,
  /column .* cannot be null/i,
  /sql syntax/i,
]

export function toUserMessage(error: unknown): string {
  const fallback = '操作未完成，请稍后重试'
  if (!(error instanceof Error)) return fallback
  if (DATABASE_ERROR_PATTERNS.some((pattern) => pattern.test(error.message))) {
    return '数据保存失败，系统已记录问题，请刷新后重试'
  }
  if (error.name === 'AbortError') return '请求超时，请检查网络后重试'
  return error.message || fallback
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 30_000)

  try {
    const headers = new Headers(init.headers)
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    const response = await fetch(path, {
      ...init,
      cache: init.cache ?? 'no-store',
      headers,
      credentials: 'same-origin',
      signal: init.signal ?? controller.signal,
    })
    const contentType = response.headers.get('content-type') || ''
    const payload = contentType.includes('application/json')
      ? await response.json() as ApiEnvelope<T>
      : null

    if (!response.ok || !payload?.success) {
      throw new ApiError(payload?.error || `请求失败（${response.status}）`, response.status, payload)
    }
    return payload.data
  } finally {
    window.clearTimeout(timeout)
  }
}
