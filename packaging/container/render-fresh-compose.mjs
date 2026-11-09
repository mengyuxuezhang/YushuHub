// Maintainer packaging: the agent receives a ready-to-import file, no build steps.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const [image, output] = process.argv.slice(2)
if (!/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image || '') || !output) throw new Error('Usage: node render-fresh-compose.mjs <approved-image@sha256:digest> <new-output.yaml>')
const template = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'compose.fresh.yaml'), 'utf8')
const text = template.replaceAll('${YUSHUHUB_IMAGE:?Use the approved immutable image digest}', image)
  .replace('${YUSHUHUB_INSTALL_TOKEN:?Set a unique 32-128 character installation token}', 'REPLACE_WITH_YOUR_UNIQUE_INSTALL_TOKEN')
  .replace('${YUSHUHUB_PORT:-7077}', '7077')
await fs.writeFile(output, text, { flag: 'wx', mode: 0o600 })
console.log('Created pinned Compose. Replace the installation token before importing; keep the project name and volumes stable.')
