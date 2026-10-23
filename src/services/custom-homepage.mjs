import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import AdmZip from 'adm-zip'
import { createHomepagePresentation } from './custom-homepage-seo.mjs'

export const CUSTOM_HOMEPAGE_LIMITS = Object.freeze({
  archiveBytes: 50 * 1024 * 1024,
  extractedBytes: 200 * 1024 * 1024,
  files: 2_000,
  htmlBytes: 2 * 1024 * 1024,
})

const DEFAULT_CONFIG = Object.freeze({ enabled: false, updatedAt: '', sourceName: '', fileCount: 0, totalBytes: 0 })

function publicStatus(config, hasCustomSite) {
  return {
    enabled: Boolean(config.enabled && hasCustomSite),
    configured: hasCustomSite,
    updatedAt: String(config.updatedAt || ''),
    sourceName: String(config.sourceName || ''),
    fileCount: Number(config.fileCount || 0),
    totalBytes: Number(config.totalBytes || 0),
    limits: CUSTOM_HOMEPAGE_LIMITS,
    previewUrl: hasCustomSite ? '/_custom-homepage/' : '',
  }
}

function safeEntryName(value) {
  const raw = String(value || '').replaceAll('\\', '/')
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[a-z]:/i.test(raw)) throw new Error('压缩包包含非法文件路径')
  const parts = raw.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '..')) throw new Error('压缩包包含越界文件路径')
  return parts.join('/')
}

function usefulZipEntries(buffer) {
  let entries
  try {
    entries = new AdmZip(buffer).getEntries()
  } catch {
    throw new Error('无法读取 ZIP，请确认上传的是有效站点压缩包')
  }
  const files = entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => ({ entry, name: safeEntryName(entry.entryName), size: Number(entry.header?.size || 0) }))
    .filter(({ name }) => !name.startsWith('__MACOSX/') && !name.endsWith('/.DS_Store') && name !== '.DS_Store')
  if (!files.length) throw new Error('ZIP 中没有可发布的站点文件')
  if (files.length > CUSTOM_HOMEPAGE_LIMITS.files) throw new Error(`站点文件不能超过 ${CUSTOM_HOMEPAGE_LIMITS.files} 个`)
  const declaredBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (declaredBytes > CUSTOM_HOMEPAGE_LIMITS.extractedBytes) throw new Error('站点解压后不能超过 200 MB')

  const names = files.map((file) => file.name)
  let prefix = ''
  if (!names.includes('index.html')) {
    const root = names[0].split('/')[0]
    if (!names.every((name) => name.startsWith(`${root}/`)) || !names.includes(`${root}/index.html`)) {
      throw new Error('站点必须包含根目录 index.html，或仅包含一个带 index.html 的顶层目录')
    }
    prefix = `${root}/`
  }

  const seen = new Set()
  return files.map((file) => {
    const name = prefix ? file.name.slice(prefix.length) : file.name
    if (!name) throw new Error('压缩包文件路径无效')
    const duplicateKey = name.toLocaleLowerCase('en-US')
    if (seen.has(duplicateKey)) throw new Error(`压缩包包含重复文件：${name}`)
    seen.add(duplicateKey)
    return { ...file, name }
  })
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(temporaryPath, filePath)
}

export function customHomepageShell(html = '') {
  return createHomepagePresentation(html).shell
}

export function createCustomHomepageService({ rootDir, siteDir, configPath }) {
  let config = { ...DEFAULT_CONFIG }
  let hasCustomSite = false
  let presentation = createHomepagePresentation()

  async function readPresentation(directory) {
    const file = await fs.open(path.join(directory, 'index.html'), 'r')
    try {
      const buffer = Buffer.alloc(CUSTOM_HOMEPAGE_LIMITS.htmlBytes)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      return createHomepagePresentation(buffer.subarray(0, bytesRead).toString('utf8'))
    } finally { await file.close() }
  }

  async function initialize() {
    await fs.mkdir(rootDir, { recursive: true })
    try {
      config = { ...DEFAULT_CONFIG, ...JSON.parse(await fs.readFile(configPath, 'utf8')) }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    hasCustomSite = Boolean((await fs.stat(path.join(siteDir, 'index.html')).catch(() => null))?.isFile())
    if (hasCustomSite) presentation = await readPresentation(siteDir)
    return status()
  }

  function status() {
    return publicStatus(config, hasCustomSite)
  }

  function isEnabled() {
    return Boolean(config.enabled && hasCustomSite)
  }

  async function replaceSite(writeStaging, metadata) {
    await fs.mkdir(rootDir, { recursive: true })
    const id = crypto.randomUUID()
    const stagingDir = path.join(rootDir, `.staging-${id}`)
    const previousDir = path.join(rootDir, `.previous-${id}`)
    let movedCurrent = false
    try {
      await fs.mkdir(stagingDir, { recursive: true })
      const summary = await writeStaging(stagingDir)
      const indexStat = await fs.stat(path.join(stagingDir, 'index.html')).catch(() => null)
      if (!indexStat?.isFile()) throw new Error('站点缺少 index.html')
      const nextPresentation = await readPresentation(stagingDir)
      const currentStat = await fs.stat(siteDir).catch(() => null)
      if (currentStat) {
        await fs.rename(siteDir, previousDir)
        movedCurrent = true
      }
      await fs.rename(stagingDir, siteDir)
      config = {
        enabled: true,
        updatedAt: new Date().toISOString(),
        sourceName: metadata.sourceName,
        fileCount: summary.fileCount,
        totalBytes: summary.totalBytes,
      }
      hasCustomSite = true
      await writeJsonAtomic(configPath, config)
      presentation = nextPresentation
      if (movedCurrent) await fs.rm(previousDir, { recursive: true, force: true })
      return status()
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      if (movedCurrent && !await fs.stat(siteDir).catch(() => null)) await fs.rename(previousDir, siteDir).catch(() => {})
      throw error
    }
  }

  async function deployZip(buffer, sourceName = 'custom-homepage.zip') {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('请选择要上传的 ZIP 文件')
    if (buffer.length > CUSTOM_HOMEPAGE_LIMITS.archiveBytes) throw new Error('ZIP 文件不能超过 50 MB')
    const files = usefulZipEntries(buffer)
    return replaceSite(async (stagingDir) => {
      let totalBytes = 0
      for (const file of files) {
        const targetPath = path.resolve(stagingDir, ...file.name.split('/'))
        if (!targetPath.startsWith(`${path.resolve(stagingDir)}${path.sep}`)) throw new Error('压缩包包含越界文件路径')
        const data = file.entry.getData()
        totalBytes += data.length
        if (totalBytes > CUSTOM_HOMEPAGE_LIMITS.extractedBytes) throw new Error('站点解压后不能超过 200 MB')
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        await fs.writeFile(targetPath, data)
      }
      return { fileCount: files.length, totalBytes }
    }, { sourceName: String(sourceName || 'custom-homepage.zip').slice(0, 180) })
  }

  async function deployHtml(html) {
    const source = String(html || '')
    const size = Buffer.byteLength(source)
    if (!source.trim()) throw new Error('请粘贴完整的 HTML 页面代码')
    if (size > CUSTOM_HOMEPAGE_LIMITS.htmlBytes) throw new Error('单文件 HTML 不能超过 2 MB')
    return replaceSite(async (stagingDir) => {
      await fs.writeFile(path.join(stagingDir, 'index.html'), source, 'utf8')
      return { fileCount: 1, totalBytes: size }
    }, { sourceName: '在线 HTML' })
  }

  async function setEnabled(enabled) {
    if (enabled && !hasCustomSite) throw new Error('请先上传或粘贴一个自定义首页')
    config = { ...config, enabled: Boolean(enabled), updatedAt: new Date().toISOString() }
    await writeJsonAtomic(configPath, config)
    return status()
  }

  async function reset() {
    await fs.rm(siteDir, { recursive: true, force: true })
    config = { ...DEFAULT_CONFIG }
    hasCustomSite = false
    presentation = createHomepagePresentation()
    await writeJsonAtomic(configPath, config)
    return status()
  }

  return { initialize, status, isEnabled, deployZip, deployHtml, setEnabled, reset,
    renderShell: () => presentation.shell,
    publicSeoFile: name => isEnabled() ? presentation.files[name] || null : null,
  }
}
