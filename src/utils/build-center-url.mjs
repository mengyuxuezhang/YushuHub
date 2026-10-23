export function normalizeSecureBuildCenterUrl(value, {
  allowEmpty = true,
} = {}) {
  const raw = String(value || '').trim()
  if (!raw) {
    if (allowEmpty) return ''
    throw new Error('官方构建中心 URL 不能为空')
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('官方构建中心地址必须是有效的 HTTP(S) URL')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('官方构建中心地址不得包含凭据、查询参数或片段')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('官方构建中心地址只支持 HTTP 或 HTTPS')
  }
  if (url.port === '22') throw new Error('官方构建中心地址不得指向 SSH 端口')
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}
