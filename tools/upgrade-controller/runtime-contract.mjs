// Pure file reads; never imports application modules or opens a database.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const root = path.resolve(process.argv.at(-1))
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const read = relative => fs.readFileSync(path.join(root, relative))
const migrations = new Map()
function add(relative) {
  const absolute = path.resolve(root, relative)
  if (!absolute.startsWith(root + path.sep)) throw Error('Migration import outside package')
  relative = path.relative(root, absolute).replaceAll(path.sep, '/')
  if (migrations.has(relative)) return
  const text = read(relative).toString('utf8')
  migrations.set(relative, text)
  for (const match of text.matchAll(/from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[1] || match[2] || match[3]
    if (specifier.startsWith('.')) add(path.join(path.dirname(relative), specifier))
  }
}
function walk(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = directory + '/' + entry.name
    if (entry.isDirectory()) walk(relative)
    else if (/\.mjs$/.test(entry.name) && /migration|retirement/.test(entry.name) && !/\.test\.mjs$/.test(entry.name)) add(relative)
  }
}
add('src/db/schema.mjs')
walk('src')
const server = read('cloud/ai-admin/server.mjs').toString('utf8')
const start = server.indexOf('const updateEnvMigration =')
const end = server.indexOf('let storageCleanupRunning =', start)
if (start < 0 || end < start) throw Error('Unrecognized startup migration contract')
migrations.set('startup-migrations', server.slice(start, end))
const migrationBytes = JSON.stringify([...migrations].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
console.log(JSON.stringify({ version: JSON.parse(read('package.json')).version,
  htmlSha256: hash(read('web/admin-v2/index.html')), schemaSha256: hash(read('src/db/schema.mjs')),
  migrationSha256: hash(migrationBytes) }))
