import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const root = fileURLToPath(new URL('../', import.meta.url))
const repository = path.resolve(root, '../..')
const argument = process.argv.indexOf('--output')
const output = path.resolve(argument >= 0 ? process.argv[argument + 1] : path.join(root, 'dist'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('A release version is required')
const zip = new AdmZip()
function add(name, contents, executable = false) {
  if (/\.(?:mjs|json|md|sh)$/.test(name)) contents = Buffer.from(contents.toString('utf8').replaceAll('\r\n', '\n'))
  zip.addFile(name, contents)
  const entry = zip.getEntry(name)
  entry.header.time = new Date(2020, 0, 1, 0, 0, 0)
  entry.attr = ((executable ? 0o100755 : 0o100644) << 16) >>> 0
}
function directory(dir) {
  for (const item of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = `${dir}/${item.name}`
    if (item.isSymbolicLink()) throw new Error(`Unexpected symlink: ${name}`)
    if (item.isDirectory()) directory(name)
    else if (item.isFile() && !item.name.endsWith('.test.mjs')) add(name, fs.readFileSync(path.join(root, name)))
  }
}
directory('src')
directory('assets')
for (const name of ['package.json', 'package-lock.json', 'README.md', 'SERVER_README.md', 'start-server.sh']) {
  let bytes = fs.readFileSync(path.join(root, name))
  if (name.endsWith('.sh')) bytes = Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'))
  if (name.endsWith('.md')) bytes = Buffer.from(bytes.toString('utf8').replaceAll('../../docs/ADMIN_UPDATE_REPAIR.md', 'docs/ADMIN_UPDATE_REPAIR.md'))
  add(name, bytes, name.endsWith('.sh'))
}
add('docs/ADMIN_UPDATE_REPAIR.md', fs.readFileSync(path.join(repository, 'docs/ADMIN_UPDATE_REPAIR.md')))
fs.mkdirSync(output, { recursive: true })
const filename = `Agent-AI-Admin-Deployer-Server-Linux-v${pkg.version}.zip`
const destination = path.join(output, filename)
const bytes = zip.toBuffer()
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
if (fs.existsSync(destination) && !fs.readFileSync(destination).equals(bytes)) throw new Error('Refusing to overwrite a different versioned package')
fs.writeFileSync(destination, bytes)
const installer = path.join(root, 'install-server.sh')
let script = fs.readFileSync(installer, 'utf8').replaceAll('\r\n', '\n')
script = script.replace(/^DEPLOYER_VERSION=".*"$/m, `DEPLOYER_VERSION="${pkg.version}"`)
  .replace(/^DEPLOYER_ZIP_URL=".*"$/m, `DEPLOYER_ZIP_URL="https://updates.okpa.cn/agent/ai-admin/deployer/${filename}"`)
  .replace(/^DEPLOYER_ZIP_SHA256=".*"$/m, `DEPLOYER_ZIP_SHA256="${sha256}"`)
fs.writeFileSync(installer, script)
console.log(JSON.stringify({ version: pkg.version, path: destination, sha256, bytes: bytes.length, entries: zip.getEntries().length }))
