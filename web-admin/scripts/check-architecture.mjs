import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcRoot = path.join(root, 'src')

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(target) : [target]
  })
}

const sourceFiles = filesUnder(srcRoot).filter((file) => /\.(?:ts|vue|css)$/.test(file))
const violations = []

for (const file of sourceFiles) {
  const relative = path.relative(root, file).replaceAll('\\', '/')
  const content = fs.readFileSync(file, 'utf8')
  const normalizedByteLength = Buffer.byteLength(content.replace(/\r\n/g, '\n'))

  if (/admin\.js|admin\.css|\/admin\/static/.test(content)) violations.push(`${relative}: 新版源码不得引用旧管理端资源`)
  if (relative.startsWith('src/views/') && /\bfetch\s*\(|['"`]\/api\//.test(content)) violations.push(`${relative}: 页面不得直接访问 API，请使用 src/api 领域模块`)
  if (/\b(?:getElementById|querySelector|querySelectorAll)\s*\(/.test(content)) violations.push(`${relative}: 不得使用命令式 DOM 查询驱动新版界面`)
  if (/\bwindow\.(?:alert|prompt|confirm)\s*\(/.test(content)) violations.push(`${relative}: 不得使用浏览器原生弹窗，请使用新版反馈和表单组件`)
  if (relative.startsWith('src/views/') && normalizedByteLength > 16_000) violations.push(`${relative}: 页面视图超过 16 KB，请拆分 composable 和业务组件`)
  if (relative.startsWith('src/components/') && normalizedByteLength > 16_000) violations.push(`${relative}: 业务组件超过 16 KB，请继续按职责拆分`)
  if (relative.startsWith('src/styles/') && relative !== 'src/styles/main.css' && normalizedByteLength > 12_000) violations.push(`${relative}: 样式域超过 12 KB，请按布局或业务域拆分`)
  if (relative === 'src/styles/main.css' && !content.split('\n').filter((line) => line.trim()).every((line) => line.startsWith('@import '))) violations.push(`${relative}: 样式入口只允许组合分域样式文件`)
}

if (violations.length) {
  console.error('Admin architecture check failed:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log(`Admin architecture check passed for ${sourceFiles.length} source files.`)
