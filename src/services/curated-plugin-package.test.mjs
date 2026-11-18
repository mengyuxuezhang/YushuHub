import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { buildCuratedPluginPackage } from './curated-plugin-package.mjs'

const resources = path.resolve(import.meta.dirname, '../resources/curated-plugins')

test('the four integration sources produce reproducible native plugin ZIPs', async () => {
  for (const id of ['github', 'feishu', 'wecom', 'dingtalk']) {
    const directory = path.join(resources, id)
    const result = await buildCuratedPluginPackage(directory)
    assert.equal(result.plugin.id, id)
    assert.deepEqual(result.plugin.skills, [id])
    assert.deepEqual(new AdmZip(result.bytes).getEntries().map(entry => entry.entryName), [
      '.claude-plugin/plugin.json', 'market.json', 'skills/' + id + '/SKILL.md',
    ])
    assert.equal(result.sha256, (await buildCuratedPluginPackage(directory)).sha256)
  }
})

test('unexpected executable files and mismatched skill names are rejected', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'curated-plugin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp(path.join(resources, 'github'), root, { recursive: true })
  const script = path.join(root, 'skills/github/start.cmd')
  await writeFile(script, 'echo example')
  await assert.rejects(buildCuratedPluginPackage(root), /不支持的插件包文件/)
  await rm(script)
  await writeFile(path.join(root, 'skills/github/SKILL.md'), '---\nname: other\ndescription: example\n---\n')
  await assert.rejects(buildCuratedPluginPackage(root), /技能清单与目录不一致/)
})
