import fs from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { auditAdminDistribution } from '../../scripts/audit-distribution.mjs'
import { fileURLToPath } from 'node:url'

const cloudFiles = new Set(['cloud/ai-admin/server.mjs', 'cloud/ai-admin/ecosystem.config.cjs', 'cloud/ai-admin/db/schema.mjs'])
const runtimeScripts = new Set(['authorization-upgrade-inspect.mjs', 'launch-admin-restart-verifier.mjs',
  'migrate-legacy-independent-agents.mjs', 'reset-admin-password.mjs', 'verify-admin-restart.mjs'])
const archiveDocs = new Set(['ADMIN_RELEASE_ARCHIVE.json', 'AGENT_RELEASE_ARCHIVE.json', 'AGENT_UPDATE_HISTORY.json', 'UPDATE_HISTORY.json'])
const rootFiles = new Set(['package.json', 'package-lock.json', 'LICENSE'])
const required = ['package.json', 'package-lock.json', 'cloud/ai-admin/server.mjs', 'src/db/schema.mjs', 'web/admin-v2/index.html']

function permittedFile(name) {
  if (rootFiles.has(name)) return true
  if (name.startsWith('cloud/')) {
    if (!cloudFiles.has(name)) throw new Error('Unexpected cloud runtime file')
    return true
  }
  if (name.startsWith('src/')) {
    if (!name.endsWith('.mjs') || /(?:^|\/)test(?:\/|\.)|\.test\.mjs$/.test(name)) throw new Error('Unexpected source runtime file')
    return true
  }
  if (name.startsWith('web/')) {
    if (!/\.(?:html|js|css|svg|png|jpe?g|gif|webp|ico|woff2?|ttf)$/.test(name)) throw new Error('Unexpected web runtime file')
    return true
  }
  if (name.startsWith('scripts/')) return runtimeScripts.has(name.slice(8))
  if (name.startsWith('docs/')) return archiveDocs.has(name.slice(5))
  return false
}

function rejectSensitiveEntry(entry) {
  const name = entry.entryName.replaceAll('\\', '/')
  const segments = name.split('/')
  if (segments.some(part => /^(?:data|logs|uploads|node_modules|local-update|\.git)$/i.test(part))
    || (name !== '.env.example' && segments.some(part => part.startsWith('.env')))
    || (segments.length > 1 && segments.some(part => part.startsWith('.')))
    || /\.(?:pem|key|p12|pfx|jks|sqlite|sqlite3|db|sql|bak)$/i.test(name)
    || /(?:^|\/)(?:credentials?|secrets?|passwords?|private[-_]keys?)(?:[._/-]|$)/i.test(name)) {
    throw new Error('Sensitive or persistent file is forbidden in image input')
  }
  const text = entry.getData().toString('utf8')
  if (permittedFile(name) && (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
    || /^\s*AI_[A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET|PRIVATE_KEY)\s*=\s*[^\s#]/m.test(text))) {
    throw new Error('Credential material is forbidden in image input')
  }
  return name
}

export async function prepareContext(zipPath, output) {
  auditAdminDistribution(zipPath)
  const zip = new AdmZip(zipPath)
  const selected = []
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = rejectSensitiveEntry(entry)
    if (permittedFile(name)) selected.push({ name, entry })
  }
  if (required.some(name => !selected.some(item => item.name === name))) throw new Error('Image input is missing required runtime files')
  // Reject all boundary violations before writing any context. Never reuse an old destination.
  await fs.mkdir(output, { recursive: false })
  for (const { name, entry } of selected) {
    const target = path.join(output, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, entry.getData())
  }
  const pkg = JSON.parse(await fs.readFile(path.join(output, 'package.json'), 'utf8'))
  if (pkg.name !== 'agent-ai-admin') throw new Error('Invalid management package')
  return { version: pkg.version }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , zip, output] = process.argv
  if (!zip || !output) throw new Error('Usage: node prepare-context.mjs <audited-release.zip> <new-directory>')
  console.log(await prepareContext(zip, path.resolve(output)))
}
