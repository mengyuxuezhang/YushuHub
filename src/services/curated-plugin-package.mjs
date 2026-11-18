import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'

const identifier = /^[a-z][a-z0-9-]{1,63}$/
const formatVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const allowedPath = /^(?:\.claude-plugin\/plugin\.json|market\.json|skills\/[a-z][a-z0-9-]{1,63}\/SKILL\.md)$/
const maxFileBytes = 64 * 1024
const maxFiles = 22

async function readPackageFiles(root, directory = '', files = new Map()) {
  for (const item of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = directory ? directory + '/' + item.name : item.name
    const source = path.join(root, relative)
    const stat = await lstat(source)
    if (stat.isDirectory() && /^(?:\.claude-plugin|skills(?:\/[a-z][a-z0-9-]{1,63})?)$/.test(relative)) {
      await readPackageFiles(root, relative, files)
    } else {
      if (!stat.isFile() || !allowedPath.test(relative)) throw new Error('不支持的插件包文件：' + relative)
      if (files.size >= maxFiles || stat.size > maxFileBytes) throw new Error('插件包超过资源上限')
      const content = await readFile(source)
      if (content.length > maxFileBytes) throw new Error('插件文件超过资源上限')
      files.set(relative, content)
    }
  }
  return files
}

function readJson(files, name, keys) {
  const data = JSON.parse(files.get(name)?.toString('utf8') || 'null')
  if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).some(key => !keys.includes(key))) {
    throw new Error('插件清单字段无效：' + name)
  }
  return data
}

function publicUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('插件文档必须使用不含凭据的 HTTPS 地址')
  }
  return url.href
}

// First-party resource construction. The initial format contains only
// declarative metadata and original Markdown skills.
export async function buildCuratedPluginPackage(root) {
  if (!(await lstat(root)).isDirectory()) throw new Error('插件包根目录无效')
  const files = await readPackageFiles(root)
  const manifest = readJson(files, '.claude-plugin/plugin.json', ['name', 'version', 'description', 'homepage'])
  const market = readJson(files, 'market.json', ['schemaVersion', 'title', 'cli', 'documentation'])
  if (typeof manifest.name !== 'string' || !identifier.test(manifest.name) || !formatVersion.test(manifest.version) ||
      typeof manifest.description !== 'string' || !manifest.description.trim() || manifest.description.length > 240 ||
      market.schemaVersion !== 1 || typeof market.title !== 'string' || !market.title.trim() || market.title.length > 64 ||
      typeof market.cli !== 'string' || !identifier.test(market.cli)) throw new Error('插件元数据无效')
  const documentation = publicUrl(market.documentation)
  publicUrl(manifest.homepage)
  const skills = []
  const zip = new AdmZip()
  for (const [name, content] of [...files].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (name.startsWith('skills/')) {
      const skill = name.split('/')[1]
      const frontmatter = /^---\r?\nname: ([a-z][a-z0-9-]{1,63})\r?\ndescription: [^\r\n]+\r?\n---\r?\n/.exec(content.toString('utf8'))
      if (frontmatter?.[1] !== skill) throw new Error('技能清单与目录不一致：' + name)
      skills.push(skill)
    }
    const entry = zip.addFile(name, content, '', 0o644)
    entry.header.time = new Date(2020, 0, 1)
  }
  if (!skills.length) throw new Error('插件须至少包含一个技能')
  const bytes = zip.toBuffer()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return {
    bytes,
    sha256,
    plugin: { id: manifest.name, version: manifest.version, title: market.title, description: manifest.description, cli: market.cli, documentation, skills },
  }
}
