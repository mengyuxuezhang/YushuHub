import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { fileURLToPath } from 'node:url'
import { createLicenseCenter, emptyCenterState } from '../../src/services/licensing/center.mjs'
import { jsonFile, operatorRuntime, serviceApp, serviceDatabase, serviceErrors } from '../../src/services/licensing/runtime.mjs'
import { registerLicenseCenterRoutes } from '../../src/routes/license-center.mjs'
import { licenseNotifications } from '../../src/services/licensing/license-notifications.mjs'
import { ModelCredentialVault } from '../../src/services/model-credentials.mjs'

const { pool, store } = await serviceDatabase('AI_LICENSE', emptyCenterState())
if (process.argv.includes('--migrate')) {
  await store.migrate(); await pool.end()
  console.log('License center schema ready')
} else {
  const center = createLicenseCenter({ store, privateKey: await fs.readFile(process.env.AI_LICENSE_PRIVATE_KEY_FILE, 'utf8'),
    publicKeys: await jsonFile(process.env.AI_LICENSE_PUBLIC_KEYS_FILE), keyId: process.env.AI_LICENSE_KEY_ID,
    credentialKey: await fs.readFile(process.env.AI_LICENSE_CREDENTIAL_KEY_FILE, 'utf8') })
  const app = serviceApp()
  const notifications = licenseNotifications({ center, store, vault: new ModelCredentialVault(process.env.AI_LICENSE_NOTIFICATION_KEY_FILE || path.resolve('data/license-notifications.key')) })
  registerLicenseCenterRoutes(app, { center, operators: await operatorRuntime(store, 'AI_LICENSE'), notifications })
  const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/license-center')
  app.use('/license-center', express.static(web, { index: 'license-center.html' }))
  serviceErrors(app)
  const server = app.listen(Number(process.env.AI_LICENSE_PORT || 7081), process.env.AI_LICENSE_HOST || '127.0.0.1', () => console.log('License center listening'))
  notifications.start()
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { notifications.stop(); server.close(async () => { await pool.end(); process.exit(0) }) })
}
