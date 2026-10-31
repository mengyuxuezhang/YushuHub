import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'

export async function readTestHttpsMaterial(env = process.env) {
  if (env.LICENSING_TEST_HTTPS !== '1') return null
  const read = async name => {
    const file = env[name]
    assert(file && path.isAbsolute(file), `Explicit absolute ${name} required`)
    const stat = await fs.stat(file); assert(stat.isFile() && stat.size > 0 && stat.size < 65536)
    return fs.readFile(file)
  }
  assert(env.NODE_EXTRA_CA_CERTS && env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'Use a scoped test CA; TLS verification must stay enabled')
  return { key: await read('LICENSING_TEST_HTTPS_KEY'), cert: await read('LICENSING_TEST_HTTPS_CERT'), minVersion: 'TLSv1.2' }
}

export async function startTestHttpsProxy(material, targetPort) {
  assert(Number.isSafeInteger(targetPort) && targetPort > 0 && targetPort < 65536)
  const server = https.createServer(material, (req, res) => {
    const upstream = http.request({ host: '127.0.0.1', port: targetPort, path: req.url, method: req.method,
      headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host } }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { url: `https://127.0.0.1:${server.address().port}`,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

export async function verifyTestHttpsBoundary(url) {
  const response = await fetch(url, { redirect: 'error' }); await response.body?.cancel()
  async function denied(options, pattern) {
    return new Promise((resolve, reject) => {
      const request = https.get(url, { agent: false, ...options }, res => { res.resume(); reject(new Error('Untrusted TLS boundary was accepted')) })
      request.setTimeout(5000, () => request.destroy(new Error('TLS rejection probe timed out')))
      request.once('error', error => pattern.test(error.code || '') ? resolve() : reject(new Error('Unexpected TLS rejection result')))
    })
  }
  await denied({ ca: [] }, /CERT|ISSUER|SELF_SIGNED/)
  await denied({ servername: 'untrusted-host.example.test' }, /^ERR_TLS_CERT_ALTNAME_INVALID$/)
  return { trustedChainAccepted: true, untrustedCertificateDenied: true, wrongHostnameDenied: true }
}
