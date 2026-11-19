import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { ANDROID_APK, ANDROID_SOURCE, androidBuildArtifacts, androidUpdateManifest, validAndroidBuildMetadata } from './android-build-artifacts.mjs'

async function fileSha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export function createAndroidReleaseStarter({ authorize, begin, finish, readBuild, publish, log }) {
  return async function startAndroidRelease(build, actor) {
    await authorize(build, actor)
    const files = androidBuildArtifacts(build.files)
    if (build.status !== 'succeeded' || !files.length || !(build.publicUrl || build.artifactDir)) {
      throw new Error('Android APK 和对应源码均构建完成后才可推送')
    }
    const attempt = randomUUID()
    if (!await begin(build.id, { status: 'publishing', attempt, started: Date.now() })) return readBuild(build.id)
    setImmediate(async () => {
      try {
        const current = await readBuild(build.id)
        await authorize(current, actor)
        const artifact = await publish(current, files)
        const release = { ...artifact, status: 'published', publishedAt: new Date().toISOString() }
        if (!androidUpdateManifest(release)) throw new Error('Android 发布信息无效')
        await finish(build.id, attempt, release)
        await log(build.id, '[admin] Android 正式包及源码已推送\n').catch(() => {})
      } catch {
        await finish(build.id, attempt, { status: 'failed', error: 'Android 推送失败，请检查存储及产物后重试' }).catch(() => {})
        await log(build.id, '[admin] Android 推送失败\n').catch(() => {})
      }
    })
    return readBuild(build.id)
  }
}

export function createAndroidArtifactPublisher({ readSettings, readOssConfig, publicRoot, publicBaseUrl, temporary, copyBuildFile, uploadFile, canAccessFile }) {
  return async function publish(build, files) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(build.id) || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(build.projectId)) {
      throw new Error('Android 发布标识无效')
    }
    const settings = await readSettings()
    const oss = readOssConfig(settings)
    const useOss = settings.artifactStorageMode === 'oss'
    if (useOss && !oss.enabled) throw new Error('OSS 配置不完整')
    const relative = `android/${build.projectId}/${build.id}`
    const target = path.join(publicRoot, ...relative.split('/'))
    await mkdir(temporary, { recursive: true })
    const staging = await mkdtemp(path.join(temporary, 'release-'))
    const names = [ANDROID_APK, ANDROID_SOURCE]
    try {
      const [apk, source, metadataFile] = files
      await copyBuildFile(build, metadataFile, staging)
      const metadataPath = path.join(staging, metadataFile)
      if ((await stat(metadataPath)).size > 4096) throw new Error('Android 版本信息异常')
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
      if (!validAndroidBuildMetadata(metadata)) throw new Error('Android 版本信息无效')
      for (const [index, file] of [apk, source].entries()) {
        await copyBuildFile(build, file, staging)
        const size = (await stat(path.join(staging, file))).size
        if (!size) throw new Error('Android 产物为空')
        await rename(path.join(staging, file), path.join(staging, names[index]))
      }
      const stagedApk = path.join(staging, ANDROID_APK)
      const { version, versionCode, size, sha256 } = metadata
      if ((await stat(stagedApk)).size !== size || await fileSha256(stagedApk) !== sha256) {
        throw new Error('Android APK 校验失败')
      }
      let url
      if (useOss) {
        const prefix = [oss.prefix, 'ai', relative].filter(Boolean).join('/')
        for (const name of names) await uploadFile(oss, path.join(staging, name), `${prefix}/${name}`)
        url = `${oss.publicBaseUrl.replace(/\/$/, '')}/${prefix}/`
      } else {
        await mkdir(path.dirname(target), { recursive: true })
        // Each build has its own immutable directory. A retry can reuse a prior complete copy.
        if ((await Promise.all(names.map((name) => stat(path.join(target, name)).catch(() => null)))).every((item) => item?.size)) {
          if (await fileSha256(path.join(target, ANDROID_APK)) !== sha256) throw new Error('Android 正式包与当前构建产物不一致')
        } else {
          const localStage = await mkdtemp(path.join(path.dirname(target), '.android-stage-'))
          try {
            for (const name of names) await copyFile(path.join(staging, name), path.join(localStage, name))
            await rename(localStage, target)
          } finally { await rm(localStage, { recursive: true, force: true }) }
        }
        url = `${publicBaseUrl.replace(/\/$/, '')}/${relative}/`
      }
      for (const name of names) if (!await canAccessFile({ publicUrl: url }, name)) throw new Error('Android 正式产物不可访问')
      return { url, version, versionCode, size, sha256 }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
}
