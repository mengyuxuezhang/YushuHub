import path from 'node:path'

export function normalizeHttpUrl(value, fallback = '') {
  const raw = String(value || fallback || '').trim()
  if (!raw) return ''
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  return withProtocol.replace(/\/$/, '')
}

export function normalizeOssEndpoint(value) {
  return String(value || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

export function trimSlashes(value) {
  return String(value || '').trim().replace(/^\/+|\/+$/g, '')
}

export function normalizeArtifactStorageMode(value) {
  return String(value || '').trim() === 'oss' ? 'oss' : 'local'
}

export function normalizeOssPublicBaseUrl({ bucket, endpoint, publicBaseUrl }) {
  const raw = String(publicBaseUrl || '').trim()
  if (raw) return normalizeHttpUrl(raw)
  const normalizedBucket = String(bucket || '').trim()
  const normalizedEndpoint = normalizeOssEndpoint(endpoint)
  return normalizedBucket && normalizedEndpoint ? `https://${normalizedBucket}.${normalizedEndpoint}` : ''
}

export function publicPathFromBaseUrl(baseUrl) {
  try {
    const parsed = new URL(normalizeHttpUrl(baseUrl))
    return decodeURIComponent(parsed.pathname).replace(/\/+$/, '')
  } catch {
    return ''
  }
}

export function normalizeSourceText(value, max = 120) {
  return String(value || '').trim().slice(0, max)
}
