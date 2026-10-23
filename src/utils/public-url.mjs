function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value
  return String(raw || '').split(',')[0].trim()
}

export function isLoopbackAddress(value) {
  const address = String(value || '').trim().toLowerCase()
  return address === '::1'
    || address === '127.0.0.1'
    || address.startsWith('127.')
    || address === '::ffff:127.0.0.1'
    || address.startsWith('::ffff:127.')
}

function hostnameFromHeader(value) {
  const host = firstHeaderValue(value)
  if (!host || /[\s\\/@]/.test(host)) return ''
  try {
    return new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function upgradeSameHostnameHttpUrl(value, expectedHostname) {
  try {
    const parsed = new URL(String(value || ''))
    if (parsed.protocol !== 'http:' || parsed.hostname.toLowerCase() !== expectedHostname) return String(value || '')
    parsed.protocol = 'https:'
    if (parsed.port === '80') parsed.port = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return String(value || '')
  }
}

function httpsOriginMatchesHostname(value, expectedHostname) {
  const raw = firstHeaderValue(value)
  if (!raw || raw === 'null') return false
  try {
    const origin = new URL(raw)
    return origin.protocol === 'https:' && origin.hostname.toLowerCase() === expectedHostname
  } catch {
    return false
  }
}

/**
 * Return a canonical absolute URL for an upload hosted by this Admin instance.
 * External assets are intentionally left untouched. This allows projects saved
 * before an HTTP -> HTTPS migration to heal when they are read, saved or built.
 */
export function canonicalizePublicUploadUrl(value, publicAdminBaseUrl) {
  const raw = String(value || '').trim()
  if (!raw || /^data:/i.test(raw)) return raw

  let base
  try {
    base = new URL(String(publicAdminBaseUrl || ''))
  } catch {
    return raw
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return raw

  const basePath = base.pathname.replace(/\/$/, '')
  let parsed
  try {
    if (raw.startsWith('/uploads/')) {
      parsed = new URL(`${basePath}${raw}`, base.origin)
    } else {
      parsed = new URL(raw)
    }
  } catch {
    return raw
  }

  const pathname = parsed.pathname
  const isUploadPath = pathname.startsWith('/uploads/')
    || (basePath && pathname.startsWith(`${basePath}/uploads/`))
  if (!isUploadPath || parsed.hostname.toLowerCase() !== base.hostname.toLowerCase()) return raw

  if (base.protocol === 'https:' && parsed.protocol === 'http:') {
    parsed.protocol = 'https:'
    parsed.host = base.host
  }
  return parsed.toString()
}

/**
 * Upgrade stale same-host public HTTP URLs when a local reverse proxy proves that
 * the current authenticated request arrived over HTTPS. Forwarded headers are
 * intentionally ignored for non-loopback peers to prevent header spoofing.
 */
export function resolvePublicUrlsForRequest(req, { adminBaseUrl, updateBaseUrl } = {}) {
  const resolved = {
    adminBaseUrl: String(adminBaseUrl || '').replace(/\/$/, ''),
    updateBaseUrl: String(updateBaseUrl || '').replace(/\/$/, ''),
  }
  if (!req) return resolved

  let configuredAdmin
  try {
    configuredAdmin = new URL(resolved.adminBaseUrl)
  } catch {
    return resolved
  }
  if (configuredAdmin.protocol !== 'http:' && configuredAdmin.protocol !== 'https:') return resolved

  // The documented Nginx config overwrites Host with $host. Prefer it over a
  // client-supplied X-Forwarded-Host and use the latter only when Host is absent.
  const requestHostname = hostnameFromHeader(req.headers?.host || req.headers?.['x-forwarded-host'])
  const configuredHostname = configuredAdmin.hostname.toLowerCase()
  if (!requestHostname || requestHostname !== configuredHostname) return resolved

  const forwardedProto = firstHeaderValue(req.headers?.['x-forwarded-proto']).toLowerCase()
  const trustedProxyHttps = isLoopbackAddress(req.socket?.remoteAddress) && forwardedProto === 'https'
  const directHttps = req.socket?.encrypted === true
  // Browser POST requests carry an Origin header. Restricting it to the already
  // configured hostname means it can prove the scheme without allowing a caller
  // to redirect generated URLs to another host. This covers container proxies
  // whose peer address is not loopback and legacy proxies missing X-Forwarded-Proto.
  const browserSameOriginHttps = httpsOriginMatchesHostname(req.headers?.origin, configuredHostname)
  if (!trustedProxyHttps && !directHttps && !browserSameOriginHttps) return resolved

  resolved.adminBaseUrl = upgradeSameHostnameHttpUrl(resolved.adminBaseUrl, configuredHostname)
  resolved.updateBaseUrl = upgradeSameHostnameHttpUrl(resolved.updateBaseUrl, configuredHostname)
  return resolved
}
