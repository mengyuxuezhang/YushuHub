import fs from 'node:fs/promises'
import path from 'node:path'

const codePaths = ['cloud', 'src', 'web', 'docs', 'scripts', 'package.json', 'package-lock.json', '.env.example', '.gitignore', 'install.php']

export async function restoreAdminCodeSnapshot(repoRoot, backupDir) {
  const root = await fs.realpath(repoRoot)
  const backup = await fs.realpath(backupDir)
  if (path.dirname(root) === root || root === backup) throw new Error('Invalid application snapshot paths')
  const pkg = JSON.parse(await fs.readFile(path.join(backup, 'package.json'), 'utf8'))
  if (pkg.name !== 'agent-ai-admin' || !pkg.version) throw new Error('Invalid application snapshot')
  for (const name of codePaths) {
    const source = path.join(backup, name)
    const stat = await fs.lstat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (stat?.isSymbolicLink()) throw new Error(`Application snapshot contains a symlink: ${name}`)
  }
  for (const name of codePaths) {
    await fs.rm(path.join(root, name), { recursive: true, force: true })
    const source = path.join(backup, name)
    if (await fs.lstat(source).catch(() => null)) await fs.cp(source, path.join(root, name), { recursive: true, dereference: false })
  }
  return pkg.version
}
