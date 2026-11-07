import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const index = process.argv.indexOf('--output')
const output = process.argv.includes('--deployer-assets') ? path.join(root, 'tools/admin-deployer/assets/admin-upgrade') : index >= 0 ? process.argv[index + 1] : ''
if (!output || !path.isAbsolute(output)) throw new Error('An absolute --output directory is required')
const source = path.join(root, 'tools/upgrade-controller')
const manifest = JSON.parse(await fs.readFile(path.join(source, 'bundle.json'), 'utf8'))
await fs.mkdir(output, { recursive: true })
for (const name of ['bundle.json', ...manifest.files]) {
  if (!/^[a-z][a-z0-9._-]+$/.test(name)) throw new Error('Invalid bundle file')
  await fs.copyFile(path.join(source, name), path.join(output, name))
}
console.log(JSON.stringify({ prepared: true, files: manifest.files.length }))
