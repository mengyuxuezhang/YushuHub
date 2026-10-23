import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'

// A separate key file is retained with deployment data and never synchronized.
export class ModelCredentialVault {
  constructor(keyFile) { this.keyFile = keyFile }
  async key(create = false) {
    try {
      const key = await readFile(this.keyFile)
      if (key.length !== 32) throw new Error('模型凭据加密密钥无效')
      return key
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw new Error('模型凭据密钥不可用，请恢复密钥备份')
      await mkdir(path.dirname(this.keyFile), { recursive: true, mode: 0o700 })
      const key = randomBytes(32)
      let handle
      try {
        handle = await open(this.keyFile, 'wx', 0o600)
        await handle.writeFile(key)
        await handle.sync()
      } catch (error) {
        if (error.code === 'EEXIST') return this.key(false)
        throw error
      } finally { await handle?.close() }
      return key
    }
  }
  async seal(secret, accountId) {
    if (typeof secret !== 'string' || !secret.trim() || secret.length > 16384 || !accountId) throw new Error('模型凭据无效')
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', await this.key(true), nonce)
    cipher.setAAD(Buffer.from(accountId))
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    return ['v1', nonce.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.')
  }
  async unseal(value, accountId) {
    const [version, nonce, tag, ciphertext, extra] = String(value).split('.')
    if (version !== 'v1' || !nonce || !tag || !ciphertext || extra) throw new Error('模型凭据密文无效')
    try {
      const decipher = createDecipheriv('aes-256-gcm', await this.key(false), Buffer.from(nonce, 'base64'))
      decipher.setAAD(Buffer.from(accountId))
      decipher.setAuthTag(Buffer.from(tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8')
    } catch { throw new Error('模型凭据无法解密，请检查账号绑定与密钥备份') }
  }
}
