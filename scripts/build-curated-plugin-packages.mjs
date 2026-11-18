import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildCuratedPluginPackage } from '../src/services/curated-plugin-package.mjs'

const output = path.resolve(process.argv[2] || 'release/curated-plugins')
await mkdir(output, { recursive: true })
for (const id of ['github', 'feishu', 'wecom', 'dingtalk']) {
  const { bytes, sha256, plugin } = await buildCuratedPluginPackage(
    path.join(import.meta.dirname, '../src/resources/curated-plugins', id),
  )
  const file = plugin.id + '-' + plugin.version + '.zip'
  await writeFile(path.join(output, file), bytes, { flag: 'wx' })
  console.log(JSON.stringify({ ...plugin, file, bytes: bytes.length, sha256 }))
}
