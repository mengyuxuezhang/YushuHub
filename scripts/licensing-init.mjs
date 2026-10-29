import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { passwordHash } from '../src/services/licensing/operator-auth.mjs'

const directory = path.resolve(process.argv[2] || 'data/licensing'), operator = process.argv[3] || 'operator'
const password = process.env.AI_LICENSE_BOOTSTRAP_PASSWORD
if (!password || password.length < 16) throw new Error('Set AI_LICENSE_BOOTSTRAP_PASSWORD to at least 16 characters; it is not printed or stored in plaintext')
await fs.mkdir(directory, { recursive: true, mode: 0o700 })
const pair = crypto.generateKeyPairSync('ed25519'), id = `key-${crypto.randomBytes(6).toString('hex')}`
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' })
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const bytes = crypto.randomBytes(20); let bits = [...bytes].map(byte => byte.toString(2).padStart(8, '0')).join(''), totpSecret = ''
while (bits.length >= 5) { totpSecret += alphabet[parseInt(bits.slice(0, 5), 2)]; bits = bits.slice(5) }
const files = {
  'private.pem': privateKey,
  'public-keys.json': JSON.stringify({ [id]: publicKey }, null, 2),
  'credential.key': crypto.randomBytes(48).toString('base64url'),
  'operators.json': JSON.stringify([{ id: operator, passwordHash: passwordHash(password), totpSecret }], null, 2),
  'key-id.txt': id,
}
// Fail before writing if any target already exists, preserving existing identities.
for (const file of Object.keys(files)) {
  try { await fs.access(path.join(directory, file)); throw new Error('Target already contains signing material; refusing to overwrite') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(directory, file), content, { mode: 0o600, flag: 'wx' })
console.log(`Key material written to ${directory}. Enroll the operator TOTP secret from the protected operators file using a trusted authenticator.`)
