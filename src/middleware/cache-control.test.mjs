import test from 'node:test'
import assert from 'node:assert/strict'

import { disableDynamicResponseCaching, setNoStoreHeaders } from './cache-control.mjs'

test('dynamic API responses disable caching by default', () => {
  const headers = new Map()
  let continued = false
  disableDynamicResponseCaching(
    { path: '/api/platform-settings' },
    { setHeader(name, value) { headers.set(name.toLowerCase(), value) } },
    () => { continued = true },
  )

  assert.equal(headers.get('cache-control'), 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0')
  assert.equal(headers.get('pragma'), 'no-cache')
  assert.equal(headers.get('expires'), '0')
  assert.equal(headers.get('surrogate-control'), 'no-store')
  assert.equal(continued, true)
})

test('HTML shell headers also bypass intermediary caches', () => {
  const headers = new Map()
  setNoStoreHeaders({ setHeader(name, value) { headers.set(name.toLowerCase(), value) } })
  assert.equal(headers.get('cache-control'), 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0')
  assert.equal(headers.get('pragma'), 'no-cache')
})

test('non-API responses keep their route-specific caching policy', () => {
  const headers = new Map()
  let continued = false
  disableDynamicResponseCaching(
    { path: '/admin/v2/assets/index.js' },
    { setHeader(name, value) { headers.set(name.toLowerCase(), value) } },
    () => { continued = true },
  )

  assert.equal(headers.has('cache-control'), false)
  assert.equal(continued, true)
})
