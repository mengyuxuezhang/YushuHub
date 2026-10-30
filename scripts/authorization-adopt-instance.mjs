import fs from 'node:fs/promises'
import path from 'node:path'
import { fileStateStore } from '../src/repositories/licensing-file-state.mjs'
import { createDeploymentLicenseClient, emptyDeploymentState } from '../src/services/licensing/deployment-client.mjs'

// Run with the target instance stopped. Explicit environment only: never load
// a production .env by accident or print the credential/cache contents.
for (const name of ['AI_LICENSE_STATE_FILE', 'AI_LICENSE_INSTANCE_CREDENTIAL_FILE', 'AI_LICENSE_PUBLIC_KEYS_FILE', 'AI_LICENSE_INSTANCE_ID', 'AI_LICENSE_CENTER_URL', 'AI_ADMIN_PUBLIC_URL']) {
  if (!process.env[name]) throw new Error(`Explicit ${name} is required`)
}
const client = createDeploymentLicenseClient({
  store: fileStateStore(path.resolve(process.env.AI_LICENSE_STATE_FILE), emptyDeploymentState()),
  centerUrl: process.env.AI_LICENSE_CENTER_URL, instanceId: process.env.AI_LICENSE_INSTANCE_ID, publicUrl: process.env.AI_ADMIN_PUBLIC_URL,
  publicKeys: JSON.parse(await fs.readFile(process.env.AI_LICENSE_PUBLIC_KEYS_FILE, 'utf8')),
})
await client.adoptCredential((await fs.readFile(process.env.AI_LICENSE_INSTANCE_CREDENTIAL_FILE, 'utf8')).trim())
console.log('Verified instance credential adopted; organization identity retained. Start only the selected accounting writer.')
