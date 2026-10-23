import { normalizeHttpUrl } from './normalize.mjs'

export function alternateHttpProtocolUrl(value) {
  try {
    const parsed = new URL(normalizeHttpUrl(value))
    if (parsed.protocol === 'https:') parsed.protocol = 'http:'
    else if (parsed.protocol === 'http:') parsed.protocol = 'https:'
    else return ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

export async function fetchText(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${url}`)
  return response.text()
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(Number(options.timeoutMs || 8000)),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${url}`)
  return response.json()
}

export function readCookie(req, name) {
  const header = req.headers.cookie || ''
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return ''
}
