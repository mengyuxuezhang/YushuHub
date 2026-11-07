import fs from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { auditAdminDistribution } from '../../scripts/audit-distribution.mjs'

export async function prepareContext(zipPath, output) {
  auditAdminDistribution(zipPath)
  // A fresh destination prevents stale files or hidden credentials entering the context.
  await fs.mkdir(output, { recursive: false })
  const zip = new AdmZip(zipPath)
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName.replaceAll('\\', '/')
    if (!/^(?:cloud|src|web|scripts|docs)\//.test(name) && !['package.json', 'package-lock.json', 'LICENSE'].includes(name)) continue
    const target = path.join(output, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, entry.getData())
  }
  const pkg = JSON.parse(await fs.readFile(path.join(output, 'package.json'), 'utf8'))
  if (pkg.name !== 'agent-ai-admin') throw new Error('Invalid management package')
  return { version: pkg.version }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const [, , zip, output] = process.argv
  if (!zip || !output) throw new Error('Usage: node prepare-context.mjs <audited-release.zip> <new-directory>')
  console.log(await prepareContext(zip, path.resolve(output)))
}
