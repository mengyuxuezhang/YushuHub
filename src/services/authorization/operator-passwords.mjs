import crypto from 'node:crypto'
import { equal, failure, secret } from './protocol.mjs'
export function passwordHash(password, salt = secret()) { return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}` }
export function verifyPassword(password, encoded) {
  const [salt, hash] = String(encoded || passwordHash('unused')).split(':')
  return equal(crypto.scryptSync(String(password || '').slice(0, 1024), salt, 64).toString('hex'), hash)
}
export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 || !/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) throw failure('WEAK_PASSWORD', '密码须为12至128位，且包含字母和数字')
  return value
}
export function newTotpSecret() {
  let bits = [...crypto.randomBytes(20)].map(b => b.toString(2).padStart(8, '0')).join('')
  return bits.match(/.{5}/g).map(b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(b, 2)]).join('')
}
