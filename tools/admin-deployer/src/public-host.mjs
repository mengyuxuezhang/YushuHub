const publicIpServices = [
  'https://api.ipify.org',
  'https://ipv4.icanhazip.com',
  'https://ifconfig.me/ip'
]

export function isPublicIpv4(value) {
  const parts = String(value || '').trim().split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b, c] = parts
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 192 && b === 0 && c === 0) return false
  return true
}

function validExplicitHost(value) {
  const host = String(value || '').trim().toLowerCase()
  if (isPublicIpv4(host)) return host
  if (/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return host
  throw new Error('AGENT_ADMIN_DEPLOYER_PUBLIC_HOST 必须是公网 IPv4 或有效域名')
}

export async function discoverPublicHost(env = process.env, fetcher = fetch) {
  if (env.AGENT_ADMIN_DEPLOYER_PUBLIC_HOST) return validExplicitHost(env.AGENT_ADMIN_DEPLOYER_PUBLIC_HOST)
  const attempts = publicIpServices.map(async (url) => {
    const response = await fetcher(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'text/plain' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const candidate = (await response.text()).trim()
    if (!isPublicIpv4(candidate)) throw new Error('服务未返回公网 IPv4')
    return candidate
  })
  try { return await Promise.any(attempts) } catch { return '' }
}
