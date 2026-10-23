import fs from 'node:fs'
import path from 'node:path'

export function loadLocalEnvFile(repoRoot, environment = process.env) {
  const envPath = path.join(repoRoot, '.env')
  if (!fs.existsSync(envPath)) return 0
  let loaded = 0
  const raw = fs.readFileSync(envPath, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key in environment) continue
    environment[key] = value
    loaded += 1
  }
  return loaded
}
