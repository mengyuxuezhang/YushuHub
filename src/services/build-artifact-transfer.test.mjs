import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { downloadBuildArtifact } from './build-artifact-transfer.mjs'

test('resumes a partial artifact after an idle timeout', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'admin-artifact-resume-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const payload = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')
  const ranges = []
  let requestCount = 0
  const server = http.createServer((request, response) => {
    requestCount += 1
    ranges.push(request.headers.range || '')
    if (requestCount === 1) {
      response.writeHead(200, { 'content-length': payload.length })
      response.write(payload.subarray(0, 8))
      return
    }
    const start = Number(/^bytes=(\d+)-$/.exec(request.headers.range || '')?.[1] || 0)
    response.writeHead(206, {
      'content-length': payload.length - start,
      'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
    })
    response.end(payload.subarray(start))
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const targetPath = path.join(root, 'artifact.exe')
  const progress = []
  await downloadBuildArtifact({
    url: `http://127.0.0.1:${server.address().port}/artifact.exe`,
    targetPath,
    fileName: 'artifact.exe',
    idleTimeoutMs: 500,
    maxAttempts: 2,
    onProgress: (item) => progress.push(item),
  })

  assert.deepEqual(await readFile(targetPath), payload)
  assert.equal(ranges[0], '')
  assert.equal(ranges[1], 'bytes=8-')
  assert.equal(progress.at(-1)?.done, true)
})

test('restarts cleanly when a server ignores the Range header', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'admin-artifact-range-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const payload = Buffer.from('complete-artifact')
  const targetPath = path.join(root, 'artifact.exe')
  await writeFile(`${targetPath}.part`, Buffer.from('stale'))
  const ranges = []
  const server = http.createServer((request, response) => {
    ranges.push(request.headers.range || '')
    response.writeHead(200, { 'content-length': payload.length })
    response.end(payload)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  await downloadBuildArtifact({
    url: `http://127.0.0.1:${server.address().port}/artifact.exe`,
    targetPath,
    idleTimeoutMs: 1000,
  })

  assert.equal(ranges[0], 'bytes=5-')
  assert.deepEqual(await readFile(targetPath), payload)
})
