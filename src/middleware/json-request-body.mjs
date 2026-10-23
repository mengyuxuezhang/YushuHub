import express from 'express'

// Match Desktop's bounded local model proxy; include image data in the same budget.
export const JSON_REQUEST_BODY_LIMIT = '20mb'
export function createJsonRequestBodyParser() {
  return express.json({
    limit: JSON_REQUEST_BODY_LIMIT,
    verify(req, _res, buffer) {
      if (String(req.originalUrl || '').startsWith('/api/payment-notify/wechat/')) {
        req.rawBody = buffer.toString('utf8')
      }
    },
  })
}
