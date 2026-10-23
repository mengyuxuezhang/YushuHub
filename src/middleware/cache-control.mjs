export function disableDynamicResponseCaching(req, res, next) {
  const requestPath = String(req.path || '')
  if (requestPath === '/api' || requestPath.startsWith('/api/')) {
    setNoStoreHeaders(res)
  }
  next()
}

export function setNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.setHeader('Surrogate-Control', 'no-store')
}
