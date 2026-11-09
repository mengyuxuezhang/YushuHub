// Release-builder only: export tracked runtime files from one immutable Git commit.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import AdmZip from 'adm-zip'
import { permittedFile } from './prepare-context.mjs'
import { auditAdminDistribution } from '../../scripts/audit-distribution.mjs'

const [revision, destination] = process.argv.slice(2)
if (!/^[a-f0-9]{40}$/.test(revision || '') || !destination) throw new Error('Usage: node prepare-fresh-context.mjs <full-commit-sha> <new-context-directory>')
const archived = new AdmZip(execFileSync('git', ['archive', '--format=zip', revision], { maxBuffer: 64 * 1024 * 1024 }))
const selected = new AdmZip(), inputs = []
const extras = new Set(['packaging/container/prepare-fresh.mjs', 'packaging/container/fresh-entrypoint.mjs'])
for (const entry of archived.getEntries()) {
  if (entry.isDirectory || /(?:^|\/)test(?:\/|\.)|\.test\.mjs$/.test(entry.entryName)) continue
  let allowed = extras.has(entry.entryName)
  try { allowed ||= permittedFile(entry.entryName) } catch { continue }
  if (!allowed) continue
  const raw = entry.getData()
  selected.addFile(entry.entryName, raw)
  inputs.push({ path: entry.entryName, sha256: crypto.createHash('sha256').update(raw).digest('hex') })
}
for (const required of [...extras, 'web/admin-v2/install/index.html', 'src/services/fresh-install.mjs']) if (!inputs.some(row => row.path === required)) throw new Error('Missing fresh-install runtime input: ' + required)
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'fresh-image-audit-'))
try {
  const zip = path.join(scratch, 'runtime.zip'); selected.writeZip(zip)
  auditAdminDistribution(zip)
  await fs.mkdir(destination, { recursive: false })
  for (const entry of selected.getEntries()) {
    const target = path.join(destination, entry.entryName)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, entry.getData())
  }
  await fs.writeFile(path.join(destination, 'image-inputs.json'), JSON.stringify({ revision, inputs }, null, 2))
  console.log(JSON.stringify({ revision, files: inputs.length, destination }))
} finally { await fs.rm(scratch, { recursive: true, force: true }) }
