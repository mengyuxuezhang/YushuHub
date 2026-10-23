import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

async function copyMissingFiles(sourceDir, targetDir, result) {
  await fs.mkdir(targetDir, { recursive: true })
  const entries = await fs.readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      await copyMissingFiles(sourcePath, targetPath, result)
      continue
    }
    if (!entry.isFile()) continue
    try {
      await fs.copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL)
      result.migratedFiles += 1
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      result.existingFiles += 1
    }
  }
}

export async function migrateLegacyUploadStorage({ legacyDir, uploadDir }) {
  const source = path.resolve(legacyDir)
  const target = path.resolve(uploadDir)
  const result = { source, target, migratedFiles: 0, existingFiles: 0, sourceExists: false }
  if (source === target) return result

  const sourceStat = await fs.stat(source).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (!sourceStat?.isDirectory()) {
    await fs.mkdir(target, { recursive: true })
    return result
  }

  result.sourceExists = true
  await copyMissingFiles(source, target, result)
  return result
}
