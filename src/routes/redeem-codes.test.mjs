import assert from 'node:assert/strict'
import test from 'node:test'

import { registerRedeemCodeRoutes } from './redeem-codes.mjs'

test('redeem code route forwards explicit fields and authenticated data actor', async () => {
  const routes = []
  const app = {
    get(path, ...handlers) { routes.push({ path, handler: handlers.at(-1) }) },
    post() {}, delete() {},
  }
  const actor = { id: 'agent-a', role: 'agent' }
  let received = null
  registerRedeemCodeRoutes(app, {
    listRedeemCodes: async (filters) => { received = filters; return { items: [], total: 0 } },
  })
  const route = routes.find((item) => item.path === '/api/redeem-codes')
  const req = { query: { search: 'batch-a', searchField: 'batch', status: 'unused' }, dataActor: actor }
  const res = { body: null, status() { return this }, json(value) { this.body = value } }

  await route.handler(req, res)

  assert.deepEqual(received, { ...req.query, actor })
  assert.equal(res.body.success, true)
})
