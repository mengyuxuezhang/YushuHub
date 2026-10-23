import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { repoRoot } from '../config/paths.mjs'
import { appendSelfUpdateLog } from './log.mjs'

export async function downloadFile(url, filePath) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} while downloading ${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  await fsp.writeFile(filePath, buffer)
  return buffer.length
}

export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

export async function copyDir(source, target, options = {}) {
  const skipNames = new Set(options.skipNames || [])
  await fsp.mkdir(target, { recursive: true })
  const entries = await fsp.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (skipNames.has(entry.name)) continue
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)
    if (entry.isDirectory()) {
      await copyDir(sourcePath, targetPath, options)
    } else if (entry.isFile()) {
      await fsp.mkdir(path.dirname(targetPath), { recursive: true })
      await fsp.copyFile(sourcePath, targetPath)
    }
  }
}

export async function removeIfExists(targetPath) {
  await fsp.rm(targetPath, { recursive: true, force: true })
}

export async function runCommand(command, args, options = {}) {
  await appendSelfUpdateLog(`$ ${command} ${args.join(' ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: { ...process.env, ...(options.env || {}) },
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', async (chunk) => {
      const text = chunk.toString()
      output += text
      if (options.logOutput !== false) await appendSelfUpdateLog(text.trimEnd()).catch(() => {})
    })
    child.stderr.on('data', async (chunk) => {
      const text = chunk.toString()
      output += text
      if (options.logOutput !== false) await appendSelfUpdateLog(text.trimEnd()).catch(() => {})
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`${command} exited with code ${code}\n${output.slice(-4000)}`))
    })
  })
}

export function icoContainsSize(buffer, requiredSize) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6) return false
  const reserved = buffer.readUInt16LE(0)
  const type = buffer.readUInt16LE(2)
  const count = buffer.readUInt16LE(4)
  if (reserved !== 0 || type !== 1 || count <= 0) return false
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16
    if (offset + 16 > buffer.length) return false
    const width = buffer[offset] || 256
    const height = buffer[offset + 1] || 256
    if (width >= requiredSize && height >= requiredSize) return true
  }
  return false
}

export function mimeFromAssetPath(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
  }
  return map[ext] || ''
}
