import assert from 'node:assert/strict'
import test from 'node:test'

import { clientScopedCreditLedgerPage, registerClientApiRoutes } from './client-api.mjs'

test('client ledger aggregate never exposes another account consumption total', () => {
  assert.deepEqual(clientScopedCreditLedgerPage({
    items: [{ id: 'registration-credit', changeType: 'recharge', pointsDelta: 50 }],
    total: 1,
    filteredConsumed: 0,
    totalConsumed: 282.229701,
  }), {
    items: [{ id: 'registration-credit', changeType: 'recharge', pointsDelta: 50 }],
    total: 1,
    filteredConsumed: 0,
    totalConsumed: 0,
  })
})

function createRouteHarness(overrides = {}) {
  const routes = new Map()
  const app = {
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers.at(-1)) },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers.at(-1)) },
  }
  const calls = { success: 0, failure: 0, deduct: 0, usageFailure: [] }
  const context = {
    provider: { id: 'provider-1', name: 'Provider', baseUrl: 'https://provider.example', timeoutMs: 30000 },
    model: { id: 'model-1', modelId: 'search-1', modelType: 'search' },
    key: { id: 'key-1', apiKey: 'secret' },
    pricingRule: { billingType: 'per_request' },
    endpointPath: '/search',
  }
  registerClientApiRoutes(app, {
    findEndUserById: async () => ({ id: 'user-1', creditBalance: 10 }),
    listClientModelCatalog: async () => ({ models: [], searchModels: [] }),
    resolveModelProxyContext: async () => context,
    deductCreditsForLocalUsage: async () => { calls.deduct += 1 },
    recordModelKeySuccess: async () => { calls.success += 1 },
    recordModelKeyFailure: async () => { calls.failure += 1 },
    recordModelKeyUsageFailure: async (...args) => { calls.usageFailure.push(args) },
    assertClientModelRequestAllowed: async (user) => {
      if (Number(user?.creditBalance || 0) <= 0) throw Object.assign(new Error('积分余额不足，请充值后重试'), { statusCode: 402, code: 'ADMIN_CREDITS_EXHAUSTED' })
    },
    ...overrides,
  })
  return {
    captchaHandler: routes.get('GET /api/client/auth/login-captcha'),
    loginHandler: routes.get('POST /api/client/auth/login'),
    handler: routes.get('POST /api/client/model/search'),
    chatHandler: routes.get('POST /api/client/model/v1/chat/completions'),
    imageHandler: routes.get('POST /api/client/images/generate'),
    modelCatalogHandler: routes.get('GET /api/client/model/models'),
    calls,
  }
}

test('client login cannot reach password verification without a valid captcha', async () => {
  const calls = []
  const { loginHandler } = createRouteHarness({
    loginProtection: {
      assertLoginAllowed: () => calls.push('allowed'),
      verifyCaptcha: () => { throw Object.assign(new Error('验证码无效'), { name: 'LoginProtectionError' }) },
      recordFailure: () => { calls.push('failure'); return 0 },
    },
    loginEndUser: async () => { calls.push('password'); return {} },
  })
  const res = createResponse()
  await loginHandler({ body: { username: 'target', password: 'guess' }, headers: {}, socket: {} }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(calls.includes('password'), false)
})

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    headersSent: false,
    destroyed: false,
    writable: true,
    writableEnded: false,
    once() {},
    removeListener() {},
    status(code) { this.statusCode = code; return this },
    setHeader(name, value) { this.headers[name] = value },
    json(payload) { this.payload = payload; this.headersSent = true; return this },
    send(payload) { this.payload = payload; this.headersSent = true; return this },
    write(payload) { this.payload = `${this.payload || ''}${String(payload)}`; this.headersSent = true; return true },
    end() { this.headersSent = true; this.writable = false; this.writableEnded = true },
  }
}

test('records one successful Key use after a completed provider request', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    code: 200,
    log_id: 'request-1',
    data: { webPages: { value: [{ name: 'Result', url: 'https://example.com' }] } },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const { handler, calls } = createRouteHarness()
  const res = createResponse()

  await handler({ clientUser: { id: 'user-1' }, body: { query: 'Agent' } }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.payload.success, true)
  assert.deepEqual(calls, { success: 1, failure: 0, deduct: 1, usageFailure: [] })
})

test('records a failed Key use without incrementing success', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ message: 'rate limited' }), {
    status: 429,
    headers: { 'content-type': 'application/json' },
  }))
  const { handler, calls } = createRouteHarness()
  const res = createResponse()

  await handler({ clientUser: { id: 'user-1' }, body: { query: 'Agent' } }, res)

  assert.equal(res.statusCode, 429)
  assert.equal(res.payload.success, false)
  assert.equal(calls.success, 0)
  assert.equal(calls.failure, 1)
  assert.equal(calls.deduct, 0)
  assert.equal(calls.usageFailure.length, 1)
  assert.equal(calls.usageFailure[0][0], 'user-1')
  assert.match(calls.usageFailure[0][3], /HTTP 429.*rate limited/)
})

test('model search proceeds after the billing guard allows the request', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    code: 200,
    log_id: 'request-1',
    data: { webPages: { value: [] } },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const { handler, calls } = createRouteHarness({
    findEndUserById: async () => ({ id: 'personal-user', creditBalance: 1 }),
    assertClientModelRequestAllowed: async () => ({ billingMode: 'personal', unlimited: false }),
  })
  const res = createResponse()

  await handler({ clientUser: { id: 'personal-user' }, body: { query: 'Agent' } }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.payload.success, true)
  assert.deepEqual(calls, { success: 1, failure: 0, deduct: 1, usageFailure: [] })
})

test('personal chat starts and settles after billing approval', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    id: 'personal-chat-1',
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const textContext = {
    provider: { id: 'provider-1', name: 'Provider', baseUrl: 'https://provider.example', timeoutMs: 30000 },
    model: { id: 'model-1', modelId: 'text-1', modelType: 'text' },
    key: { id: 'key-1', apiKey: 'secret' },
    pricingRule: { billingType: 'per_request' },
    endpointPath: '/chat/completions',
  }
  const { chatHandler, calls } = createRouteHarness({
    findEndUserById: async () => ({ id: 'personal-user', creditBalance: 1 }),
    assertClientModelRequestAllowed: async () => ({ billingMode: 'personal', unlimited: false }),
    resolveModelProxyContext: async () => textContext,
  })
  const res = createResponse()

  await chatHandler({
    clientUser: { id: 'personal-user' },
    body: { model: 'text-1', messages: [{ role: 'user', content: 'hello' }] },
    headers: {},
    once() {},
    removeListener() {},
    destroyed: false,
  }, res)

  assert.equal(res.statusCode, 200)
  assert.match(String(res.payload), /personal-chat-1/)
  assert.deepEqual(calls, { success: 1, failure: 0, deduct: 1, usageFailure: [] })
})

test('personal search still returns a stable 402 when credits are exhausted', async () => {
  const { handler, calls } = createRouteHarness({
    findEndUserById: async () => ({ id: 'personal-user', creditBalance: 0 }),
  })
  const res = createResponse()

  await handler({ clientUser: { id: 'personal-user' }, body: { query: 'Agent' } }, res)

  assert.equal(res.statusCode, 402)
  assert.equal(res.headers['X-Agent-Error-Code'], 'ADMIN_CREDITS_EXHAUSTED')
  assert.equal(res.payload.code, 'ADMIN_CREDITS_EXHAUSTED')
  assert.deepEqual(calls, { success: 0, failure: 0, deduct: 0, usageFailure: [] })
})

test('client model catalog returns one deterministic entry per model ID', async () => {
  const { modelCatalogHandler } = createRouteHarness({
    listClientModelCatalog: async () => ({
      models: [
        { id: 'duplicate', name: 'Incomplete', configured: true, contextWindow: 0 },
        { id: 'duplicate', name: 'Usable', configured: true, contextWindow: 100000 },
      ],
      searchModels: [
        { id: 'search-1', name: 'First', configured: false },
        { id: 'search-1', name: 'Configured', configured: true },
      ],
      defaultModelId: 'duplicate',
      configured: true,
      searchConfigured: true,
    }),
  })
  const res = createResponse()

  await modelCatalogHandler({ clientUser: { id: 'user-1' } }, res)

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.payload.data.models, [
    { id: 'duplicate', name: 'Usable', configured: true, contextWindow: 100000 },
  ])
  assert.deepEqual(res.payload.data.searchModels, [
    { id: 'search-1', name: 'Configured', configured: true },
  ])
})

test('image generation route returns provider data after the billing guard allows it', async () => {
  const generateCalls = []
  const { imageHandler } = createRouteHarness({
    findEndUserById: async () => ({ id: 'personal-user', creditBalance: 10 }),
    assertClientModelRequestAllowed: async () => ({ billingMode: 'personal', unlimited: false }),
    generateImageForClient: async (userId, input) => {
      generateCalls.push({ userId, input })
      return {
        model: 'doubao-seedream-5-0-pro-260628',
        providerId: 'provider-1',
        providerName: 'Provider',
        images: [{ index: 0, url: 'https://example.com/a.jpeg', size: '2048x2048' }],
        usage: { generated_images: 1, output_tokens: 16384, total_tokens: 16384, image_sizes: ['2048x2048'] },
        requestId: 'img-1',
        billing: { billingType: 'per_image_resolution', tierCounts: { '2K': 1 }, generatedImages: 1, points: 10 },
      }
    },
  })
  const res = createResponse()

  await imageHandler({ clientUser: { id: 'personal-user' }, body: { prompt: 'a cat', size: '2K' } }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.payload.success, true)
  assert.equal(res.payload.data.images[0].size, '2048x2048')
  assert.equal(res.payload.data.billing.points, 10)
  assert.deepEqual(generateCalls, [{ userId: 'personal-user', input: { prompt: 'a cat', size: '2K' } }])
})

test('image generation route surfaces a stable 402 when credits are exhausted', async () => {
  const { imageHandler, calls } = createRouteHarness({
    findEndUserById: async () => ({ id: 'personal-user', creditBalance: 0 }),
  })
  const res = createResponse()

  await imageHandler({ clientUser: { id: 'personal-user' }, body: { prompt: 'a cat' } }, res)

  assert.equal(res.statusCode, 402)
  assert.equal(res.headers['X-Agent-Error-Code'], 'ADMIN_CREDITS_EXHAUSTED')
  assert.equal(res.payload.code, 'ADMIN_CREDITS_EXHAUSTED')
  assert.deepEqual(calls, { success: 0, failure: 0, deduct: 0, usageFailure: [] })
})

test('image generation route maps provider failures to 502 with provider message', async () => {
  const { imageHandler } = createRouteHarness({
    findEndUserById: async () => ({ id: 'personal-user', creditBalance: 10 }),
    assertClientModelRequestAllowed: async () => ({ billingMode: 'personal', unlimited: false }),
    generateImageForClient: async () => {
      throw Object.assign(new Error('upstream exploded'), { statusCode: 502 })
    },
  })
  const res = createResponse()

  await imageHandler({ clientUser: { id: 'personal-user' }, body: { prompt: 'a cat' } }, res)

  assert.equal(res.statusCode, 502)
  assert.equal(res.payload.success, false)
  assert.equal(res.payload.error, 'upstream exploded')
})
