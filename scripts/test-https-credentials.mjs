import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export async function createTestHttpsCredentials({ directory = os.tmpdir(), openssl = process.env.LICENSING_TEST_OPENSSL || 'openssl' } = {}) {
  const base = await fs.realpath(directory), root = await fs.mkdtemp(path.join(base, 'yushu-test-tls-'))
  await fs.chmod(root, 0o700)
  const file = name => path.join(root, name)
  async function cleanup() {
    assert(path.isAbsolute(root) && path.dirname(root) === base && /^yushu-test-tls-[A-Za-z0-9]+$/.test(path.basename(root)))
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false); assert.equal(await fs.realpath(root), root)
    await fs.rm(root, { recursive: true, force: true })
  }
  const command = args => promisify(execFile)(openssl, args, { windowsHide: true })
  try {
    await fs.writeFile(file('root.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=v3_ca\nprompt=no\n[dn]\nCN=Yushu Isolated Acceptance CA\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always,issuer\n', { mode: 0o600 })
    await fs.writeFile(file('extensions.cnf'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n', { mode: 0o600 })
    await command(['req', '-x509', '-config', file('root.cnf'), '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-keyout', file('ca.key'), '-out', file('ca.crt')])
    await command(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=localhost', '-keyout', file('server.key'), '-out', file('server.csr')])
    await command(['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.crt'), '-CAkey', file('ca.key'), '-CAcreateserial', '-out', file('server.crt'), '-days', '2', '-sha256', '-extfile', file('extensions.cnf')])
    await command(['verify', '-CAfile', file('ca.crt'), file('server.crt')])
    await Promise.all(['ca.key', 'server.key'].map(name => fs.chmod(file(name), 0o600)))
    return { env: { NODE_EXTRA_CA_CERTS: file('ca.crt'), LICENSING_TEST_HTTPS: '1', LICENSING_TEST_HTTPS_KEY: file('server.key'), LICENSING_TEST_HTTPS_CERT: file('server.crt') }, cleanup }
  } catch {
    await cleanup()
    throw new Error('Isolated HTTPS fixture generation failed; a working OpenSSL executable is required')
  }
}
