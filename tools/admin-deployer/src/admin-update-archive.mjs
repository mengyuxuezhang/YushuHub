import AdmZip from 'adm-zip'

// Also shipped with the standalone deployer; its tests enforce identical copies.
export const adminCodePaths = ['cloud', 'src', 'web', 'docs', 'scripts', 'deploy', '.github', '.gitattributes', 'AGENTS.md', 'COMMERCIAL_LICENSE.md', 'CONTRIBUTING.md', 'LICENSE', 'README.md', 'SECURITY.md', 'package.json', 'package-lock.json', '.env.example', '.gitignore', 'install.php']

export function validateAdminUpdateArchive(buffer) {
  const entries = new AdmZip(buffer).getEntries()
  if (!entries.length || entries.length > 10000) throw new Error('Invalid application archive entry count')
  const seen = new Set()
  let total = 0
  for (const entry of entries) {
    const name = entry.entryName
    const parts = name.replace(/\/$/, '').split('/')
    const mode = (entry.attr >>> 16) & 0xf000
    if (name.includes('\\') || name.includes('\0') || parts.some(part => !part || part === '.' || part === '..') || !adminCodePaths.includes(parts[0]) || parts.some(part => ['.env', '.git', 'node_modules', 'data', 'logs', 'uploads', 'updates'].includes(part))) throw new Error(`Unsupported application archive path: ${name}`)
    if (seen.has(name)) throw new Error(`Duplicate application archive path: ${name}`)
    seen.add(name)
    if (mode && mode !== 0x8000 && mode !== 0x4000) throw new Error(`Application archive contains a link or special file: ${name}`)
    total += Number(entry.header.size)
    if (entry.header.size > 32 * 1024 * 1024 || total > 256 * 1024 * 1024) throw new Error('Application archive exceeds extraction limits')
  }
  const pkgEntry = entries.find(entry => entry.entryName === 'package.json' && !entry.isDirectory)
  if (!pkgEntry) throw new Error('Application archive is missing package.json')
  const pkg = JSON.parse(pkgEntry.getData().toString('utf8'))
  if (pkg.name !== 'agent-ai-admin' || !/^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid application archive identity or version')
  return pkg
}
