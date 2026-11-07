// Maintainer-only local artifact creation. Never uploads a catalog or stores its private key.
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : '' }
const input = option('--input'), keyFile = option('--key'), output = option('--output'), keyId = option('--key-id')
if (!input || !keyFile || !output || !/^[A-Za-z0-9_.-]{1,64}$/.test(keyId || '')) throw new Error('Usage: node sign-catalog.mjs --input payload.json --key protected.pem --key-id ID --output catalog.json')
const payload = await fs.readFile(input)
const data = JSON.parse(payload)
if (data.format !== 1 || !Number.isInteger(data.generation) || !data.latest || !Array.isArray(data.releases)) throw new Error('Invalid catalog payload')
if ((await fs.lstat(keyFile)).isSymbolicLink()) throw new Error('Signing key must be a protected regular file')
const handle = await fs.open(keyFile, 'r')
let key
try {
  const stat = await handle.stat()
  if (!stat.isFile() || process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('Signing key permissions must be 0600 or stricter')
  key = crypto.createPrivateKey(await handle.readFile())
} finally { await handle.close() }
if (!['rsa', 'rsa-pss'].includes(key.asymmetricKeyType) || ![3072, 4096].includes(key.asymmetricKeyDetails.modulusLength)) throw new Error('Use a dedicated 3072- or 4096-bit RSA key for update metadata')
const signature = crypto.sign('sha256', payload, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 })
await fs.writeFile(output, JSON.stringify({ algorithm: 'RSA-PSS-SHA256', keyId, payload: payload.toString('base64'), signature: signature.toString('base64') }, null, 2), { mode: 0o600, flag: 'wx' })
console.log(JSON.stringify({ written: true, generation: data.generation, latest: data.latest }))
