import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MODEL_PROVIDER_AUTH_FAILED,
  classifyProviderHttpError,
  classifyProviderTransportError,
} from './model-proxy-errors.mjs'

test('maps provider authentication failures away from client session auth', () => {
  assert.deepEqual(classifyProviderHttpError(401), {
    status: 502,
    code: MODEL_PROVIDER_AUTH_FAILED,
    message: '模型服务认证失败，请联系管理员检查模型配置',
  })
  assert.equal(classifyProviderHttpError(429), null)
})

test('maps provider fetch failures to a retryable gateway status', () => {
  assert.deepEqual(classifyProviderTransportError(new TypeError('fetch failed')), {
    status: 502,
    message: '模型供应商暂时不可连接，请稍后重试或切换模型',
  })
})

test('maps provider header timeouts to gateway timeout', () => {
  assert.deepEqual(classifyProviderTransportError(new Error('aborted'), 'provider_headers_timeout'), {
    status: 504,
    message: '模型供应商响应超时，请稍后重试或切换模型',
  })
})

test('recognizes undici transport causes without exposing diagnostics', () => {
  const error = new TypeError('request failed', { cause: { code: 'UND_ERR_SOCKET' } })
  assert.equal(classifyProviderTransportError(error)?.status, 502)
})

test('leaves business and validation failures unchanged', () => {
  assert.equal(classifyProviderTransportError(new Error('当前模型不存在')), null)
})
