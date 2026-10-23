import fsp from 'node:fs/promises'

const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_MAX_ATTEMPTS = 3

export async function downloadBuildArtifact({
  url,
  targetPath,
  fileName = '',
  onProgress = null,
  fetchImpl = fetch,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  const partPath = `${targetPath}.part`
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let offset = await fileSize(partPath)
    const controller = new AbortController()
    let idleTimer = null
    let idleTimedOut = false
    const armIdleTimeout = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimedOut = true
        controller.abort()
      }, idleTimeoutMs)
    }
    armIdleTimeout()

    let output = null
    try {
      const headers = { 'Accept-Encoding': 'identity', ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}) }
      const response = await fetchImpl(url, { headers, signal: controller.signal })
      armIdleTimeout()

      if (response.status === 416 && offset > 0) {
        const total = contentRangeTotal(response.headers.get('content-range'))
        if (total === offset) {
          await fsp.rename(partPath, targetPath)
          if (onProgress) await onProgress({ fileName, transferredBytes: total, totalBytes: total, percent: 100, done: true })
          clearTimeout(idleTimer)
          return
        }
        await fsp.rm(partPath, { force: true })
        throw new Error('远端产物长度已变化，已重新开始下载')
      }
      if (response.status !== 200 && response.status !== 206) throw new Error(`HTTP ${response.status}`)

      const range = parseContentRange(response.headers.get('content-range'))
      const canResume = offset > 0 && response.status === 206 && range?.start === offset
      if (!canResume) offset = 0
      const totalBytes = range?.total || (Number(response.headers.get('content-length') || 0) + offset)
      if (!response.body) throw new Error('远端产物响应为空')

      output = await fsp.open(partPath, canResume ? 'a' : 'w')
      let transferredBytes = offset
      let lastNotifiedAt = 0
      let lastPercent = totalBytes > 0 ? Math.floor((transferredBytes / totalBytes) * 100) : 0

      for await (const value of response.body) {
        armIdleTimeout()
        const chunk = Buffer.from(value)
        transferredBytes += chunk.length
        await output.write(chunk)
        const percent = totalBytes > 0 ? Math.min(99, Math.floor((transferredBytes / totalBytes) * 100)) : 0
        const now = Date.now()
        if (onProgress && (now - lastNotifiedAt >= 1000 || percent - lastPercent >= 5)) {
          lastNotifiedAt = now
          lastPercent = percent
          await onProgress({ fileName, transferredBytes, totalBytes, percent, done: false })
        }
      }
      await output.close()
      output = null
      clearTimeout(idleTimer)

      const completedBytes = await fileSize(partPath)
      if (totalBytes > 0 && completedBytes !== totalBytes) throw new Error(`下载长度不完整：expected ${totalBytes}, got ${completedBytes}`)
      await fsp.rename(partPath, targetPath)
      if (onProgress) await onProgress({ fileName, transferredBytes: completedBytes, totalBytes: totalBytes || completedBytes, percent: 100, done: true })
      return
    } catch (error) {
      clearTimeout(idleTimer)
      await output?.close().catch(() => {})
      lastError = idleTimedOut ? new Error(`下载连续 ${Math.ceil(idleTimeoutMs / 1000)} 秒没有收到数据`) : error
    }
  }

  throw lastError || new Error('下载构建产物失败')
}

async function fileSize(filePath) {
  try {
    return (await fsp.stat(filePath)).size
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || '').trim())
  if (!match || match[3] === '*') return null
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) }
}

function contentRangeTotal(value) {
  const match = /^bytes\s+\*\/(\d+)$/i.exec(String(value || '').trim())
  return match ? Number(match[1]) : 0
}
