import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const MAX_ZIP_BYTES = 16 * 1024 * 1024
const MAX_FILES = 1000
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 48 * 1024 * 1024

const forbiddenPaths = [
  /(^|\/)\.git(?:\/|$)/i,
  /(^|\/)node_modules(?:\/|$)/i,
  /(^|\/)(?:data|logs|uploads|local-update|tmp|output|\.pack)(?:\/|$)/i,
  /(^|\/)docs\/(?:BUILD_WORKER_HANDOFF|CURRENT_HANDOFF|ARCHITECTURE|RELEASE_RUNBOOK|PRODUCTION_DEPLOYMENT[^/]*)\.md$/i,
  /(^|\/)Agent-Desktop-Next(?:\/|$)/i,
  /(^|\/)desktop\/(?:src|tests|scripts|central-build)(?:\/|$)/i,
  /(^|\/)(?:Cargo\.toml|Cargo\.lock|electron-builder\.[^/]+|ai-worker\.mjs)$/i,
  /\.(?:rs|ts|tsx|map)$/i,
]

const forbiddenContent = [
  { label: 'private repository locator', pattern: /(?:ssh:\/\/|git@[^\s:]+:|\/www\/wwwroot\/git\/)/i },
  { label: 'central worker host', pattern: /(?:120\.53\.230\.168|58\.56\.174\.98)/ },
  { label: 'central worker workspace', pattern: /(?:\/opt\/agent-next-worker|Agent-Desktop-Next-current)/i },
  { label: 'root SSH locator', pattern: /root@[a-z0-9.-]+/i },
  { label: 'private key material', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: 'desktop source marker', pattern: /(?:"name"\s*:\s*"agent-desktop-next"|crates\/codegen\/xai-|@xai-org\/grok-build)/i },
]

const secretAssignment = /^[ \t]*(AI_(?:WORKER_TOKEN|BUILD_CENTER_TOKEN|ADMIN_PASSWORD)|(?:DB_)?PASSWORD)[ \t]*=[ \t]*([^\r\n]*)$/gmi
const allowedExamples = new Set(['', 'change-me-before-run', '<请在创建或重置时复制 token>'])

export function auditAdminDistribution(zipPath) {
  const resolved = path.resolve(zipPath)
  const stat = fs.statSync(resolved)
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ZIP_BYTES) throw new Error('distribution ZIP has an invalid size')
  const entries = new AdmZip(resolved).getEntries()
  if (entries.length === 0 || entries.length > MAX_FILES) throw new Error('distribution ZIP has an invalid entry count')
  const violations = []
  let files = 0
  let totalBytes = 0
  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, '/')
    if (name.startsWith('/') || name.split('/').includes('..')) violations.push(`${name}: unsafe archive path`)
    if (entry.isDirectory) continue
    files += 1
    const size = Number(entry.header.size || 0)
    totalBytes += size
    if (size > MAX_FILE_BYTES) violations.push(`${name}: file exceeds size limit`)
    for (const pattern of forbiddenPaths) if (pattern.test(name)) violations.push(`${name}: forbidden distribution path`)
    if (size > MAX_FILE_BYTES) continue
    const text = entry.getData().toString('utf8')
    if (/\.sh$/i.test(name) && text.includes('\r\n')) violations.push(`${name}: shell script uses CRLF line endings`)
    for (const check of forbiddenContent) if (check.pattern.test(text)) violations.push(`${name}: ${check.label}`)
    for (const match of text.matchAll(secretAssignment)) {
      const value = String(match[2] || '').trim().replace(/^['"]|['"]$/g, '')
      if (!allowedExamples.has(value) && !value.startsWith('$')) violations.push(`${name}: credential value in distribution`)
    }
  }
  if (totalBytes > MAX_TOTAL_BYTES) violations.push('archive: uncompressed size exceeds limit')
  if (violations.length > 0) throw new Error(`Admin distribution isolation audit failed:\n${[...new Set(violations)].join('\n')}`)
  return { files, zipBytes: stat.size, uncompressedBytes: totalBytes, violations: 0 }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const zipPath = process.argv[2]
  if (!zipPath) throw new Error('Usage: node scripts/audit-distribution.mjs <admin.zip>')
  console.log(JSON.stringify(auditAdminDistribution(zipPath)))
}
