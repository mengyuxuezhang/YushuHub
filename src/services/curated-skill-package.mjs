import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CURATED_SKILL_ROOT } from '../config/paths.mjs'
import { parseJson } from '../utils/parse.mjs'

const missing = error => ['ENOENT', 'ENOTDIR'].includes(error?.code)
const packageError = code => Object.assign(new Error('技能包暂不可用，请联系管理员检查技能文件'), { code })

async function regularFile(file) {
  const stat = await fs.stat(file)
  if (!stat.isFile()) throw packageError('ENOENT')
}

// Stored absolute paths can outlive an application-directory migration. Only
// recover the same skill/version under the configured root, with matching bytes.
export async function resolveCuratedSkillPackage(row, root = CURATED_SKILL_ROOT) {
  const stored = String(row.package_path || '')
  if (stored) {
    try { await regularFile(stored); return path.resolve(stored) }
    catch (error) { if (!missing(error)) throw error }
  }
  const manifest = parseJson(row.manifest_json, {}) || {}
  const skillId = String(row.skill_id || '')
  const version = String(row.version || '')
  const name = stored.replace(/\\/g, '/').split('/').at(-1)
    || (manifest.distributionType === 'protected' ? 'package.enc' : 'package.zip')
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(skillId)
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
    || !['package.zip', 'package.enc'].includes(name)) throw packageError('ENOENT')
  const expected = String(row.package_sha256 || manifest.encryptedPackageSha256 || '')
  if (!/^[a-f0-9]{64}$/.test(expected)) throw packageError('PACKAGE_INTEGRITY')
  const rootPath = await fs.realpath(root)
  const file = await fs.realpath(path.join(rootPath, skillId, version, name))
  const relative = path.relative(rootPath, file)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw packageError('PACKAGE_INTEGRITY')
  await regularFile(file)
  const bytes = await fs.readFile(file)
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw packageError('PACKAGE_INTEGRITY')
  return file
}

function failDownload(res, error) {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) { res.destroy(); return }
  res.removeHeader('X-Agent-Skill-Manifest')
  res.removeHeader('Content-Length')
  res.removeHeader('Content-Type')
  res.setHeader('Cache-Control', 'private, no-store')
  res.status(missing(error) || error?.status === 404 ? 404 : 503)
    .json({ success: false, error: '技能包暂不可用，请联系管理员检查技能文件' })
}

export async function sendCuratedSkillPackage(res, row) {
  let file
  try { file = await resolveCuratedSkillPackage(row) }
  catch (error) { failDownload(res, error); return }
  // Express handles file-open/stream errors, including deletion after resolution
  // and client disconnects. Never pipe a ReadStream without an error listener.
  await new Promise(resolve => {
    res.sendFile(file, { headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'private, no-store',
      'X-Agent-Skill-Manifest': Buffer.from(JSON.stringify(parseJson(row.manifest_json, null))).toString('base64'),
    } }, error => {
      if (error) failDownload(res, error)
      resolve()
    })
  })
}
