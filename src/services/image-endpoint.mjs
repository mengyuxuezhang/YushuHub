export function normalizeImageEndpoint(value) {
  const path = String(value || '/images/generations').trim()
  if (path.length > 255 || !/^\/(?:[A-Za-z0-9._~-]+\/?)+$/.test(path) || path.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('图片端点须为相对服务商Base URL的路径，例如 /images/generations，不包含域名、查询参数或凭据')
  }
  return path
}
