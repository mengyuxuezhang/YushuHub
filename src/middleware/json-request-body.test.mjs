import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { createJsonRequestBodyParser } from './json-request-body.mjs'

test('accepts a 19 MiB model request, rejects over 20 MiB, and retains payment raw bytes', async () => {
  const app = express(); app.use(createJsonRequestBodyParser())
  app.post('/api/client/model/v1/chat/completions', (req, res) => res.json({ length: req.body.messages[0].content.length }))
  app.post('/api/payment-notify/wechat/test', (req, res) => res.json({ raw: req.rawBody }))
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ type: error.type }))
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    for (const [mib, expected] of [[19, 200], [21, 413]]) {
      const response = await fetch(`${base}/api/client/model/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'a'.repeat(mib * 1024 * 1024) }] }) })
      assert.equal(response.status, expected)
      if (expected === 200) assert.equal((await response.json()).length, mib * 1024 * 1024)
      else assert.equal((await response.json()).type, 'entity.too.large')
    }
    const raw = '{ "id": "payment-fixture" }'
    const response = await fetch(`${base}/api/payment-notify/wechat/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })
    assert.equal((await response.json()).raw, raw)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
