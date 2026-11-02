import { failure } from './protocol.mjs'
// Forward only bounded, public request challenges. No signing key belongs here.
export function desktopProofHeaders(headers) {
  const nonce = headers['x-okpa-proof-nonce'], hash = headers['x-okpa-request-hash']
  if (nonce === undefined && hash === undefined) return {}
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw failure('INVALID_PROOF_CHALLENGE', '客户端来源校验参数无效')
  return { 'x-okpa-proof-nonce': nonce, 'x-okpa-request-hash': hash }
}
