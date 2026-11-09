// Runs once as root to initialize only the named volumes declared by our Compose.
import fs from 'node:fs/promises'
import crypto from 'node:crypto'

for (const directory of ['/fresh-root', '/fresh-app', '/fresh-data', '/fresh-logs', '/fresh-published']) {
  const info = await fs.lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Expected a dedicated volume')
  await fs.chmod(directory, 0o700)
  await fs.chown(directory, directory === '/fresh-root' ? 0 : 1000, directory === '/fresh-root' ? 0 : 1000)
}
for (const file of ['/fresh-root/mysql-root', '/fresh-app/mysql-app']) {
  try {
    const handle = await fs.open(file, 'wx', 0o600)
    try { await handle.writeFile(crypto.randomBytes(32).toString('hex')); await handle.sync() } finally { await handle.close() }
  } catch (e) { if (e.code !== 'EEXIST') throw e }
  const info = await fs.lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(await fs.readFile(file, 'utf8'))) throw new Error('Existing credential file invalid; restore backup')
  await fs.chmod(file, 0o600)
  await fs.chown(file, file.startsWith('/fresh-root') ? 0 : 1000, file.startsWith('/fresh-root') ? 0 : 1000)
}
console.log('Dedicated persistent volumes prepared; existing credentials retained.')
