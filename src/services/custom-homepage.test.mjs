import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import AdmZip from 'adm-zip'

import { createCustomHomepageService, customHomepageShell } from './custom-homepage.mjs'
import { createHomepagePresentation } from './custom-homepage-seo.mjs'

async function fixture(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-homepage-'))
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }))
  const service = createCustomHomepageService({
    rootDir,
    siteDir: path.join(rootDir, 'site'),
    configPath: path.join(rootDir, 'config.json'),
  })
  await service.initialize()
  return { rootDir, service }
}

test('single-file homepage persists enable state and can return to official page', async (t) => {
  const { rootDir, service } = await fixture(t)
  assert.deepEqual(service.status().configured, false)

  const published = await service.deployHtml('<!doctype html><h1>Agent site</h1>')
  assert.equal(published.enabled, true)
  assert.equal(published.configured, true)
  assert.equal(published.sourceName, '在线 HTML')
  assert.match(await fs.readFile(path.join(rootDir, 'site', 'index.html'), 'utf8'), /Agent site/)

  await service.setEnabled(false)
  assert.equal(service.isEnabled(), false)
  const restarted = createCustomHomepageService({ rootDir, siteDir: path.join(rootDir, 'site'), configPath: path.join(rootDir, 'config.json') })
  assert.equal((await restarted.initialize()).enabled, false)
  assert.equal(restarted.status().configured, true)

  await restarted.reset()
  assert.equal(restarted.status().configured, false)
  assert.equal(await fs.stat(path.join(rootDir, 'site')).catch(() => null), null)
})

test('ZIP publisher accepts one project wrapper and preserves relative assets', async (t) => {
  const { rootDir, service } = await fixture(t)
  const zip = new AdmZip()
  zip.addFile('ai-page/index.html', Buffer.from('<link rel="stylesheet" href="assets/app.css">'))
  zip.addFile('ai-page/assets/app.css', Buffer.from('body{color:#111}'))

  const status = await service.deployZip(zip.toBuffer(), 'ai-page.zip')
  assert.equal(status.fileCount, 2)
  assert.equal(status.sourceName, 'ai-page.zip')
  assert.equal(await fs.readFile(path.join(rootDir, 'site', 'assets', 'app.css'), 'utf8'), 'body{color:#111}')
})

test('ZIP publisher rejects archives without a deployable index and keeps current site', async (t) => {
  const { rootDir, service } = await fixture(t)
  await service.deployHtml('<h1>current</h1>')
  const zip = new AdmZip()
  zip.addFile('assets/app.js', Buffer.from('console.log(1)'))

  await assert.rejects(() => service.deployZip(zip.toBuffer(), 'broken.zip'), /index\.html/)
  assert.equal(await fs.readFile(path.join(rootDir, 'site', 'index.html'), 'utf8'), '<h1>current</h1>')
})

test('custom homepage shell isolates user code from the management origin', () => {
  const shell = customHomepageShell()
  assert.match(shell, /src="\/_custom-homepage\/"/)
  assert.match(shell, /sandbox="allow-scripts/)
  assert.doesNotMatch(shell, /allow-same-origin/)
})

test('outer page copies static brand SEO and rewrites package icons without running scripts', () => {
  const { shell, files } = createHomepagePresentation(`<!doctype html><html><head>
    <title>梦羽 &amp; Agent</title>
    <link rel="icon" type="image/png" href="tubiao.png?v=2" onerror="alert(1)">
    <link rel="canonical" href="https://example.com/">
    <meta name="description" content="真实创作 &amp; 自动化">
    <meta property="og:image" content="https://example.com/_custom-homepage/tubiao.png">
    <script>throw new Error('never execute')</script>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"梦羽 Agent","url":"https://example.com/"}</script>
    </head></html>`)
  assert.match(shell, /<title>梦羽 &amp; Agent<\/title>/)
  assert.match(shell, /href="\/_custom-homepage\/tubiao.png\?v=2"/)
  assert.match(shell, /name="description" content="真实创作 &amp; 自动化"/)
  assert.match(shell, /application\/ld\+json/)
  assert.doesNotMatch(shell, /onerror|throw new Error|allow-same-origin|<title>首页/)
  assert.match(files['sitemap.xml'].content, /<loc>https:\/\/example.com\/<\/loc>/)
  assert.match(files['robots.txt'].content, /Sitemap: https:\/\/example.com\/sitemap.xml/)
})

test('outer metadata rejects executable URLs, traversal and HTML attribute injection', () => {
  const { shell } = createHomepagePresentation(`<head><title>&lt;img src=x onerror=alert(1)&gt;</title>
    <script>const fake = '<meta name="description" content="fake">';</script>
    <link rel="icon" href="java&#x73;cript:alert(1)"><link rel="apple-touch-icon" href="../admin">
    <meta http-equiv="refresh" content="0;url=https://evil.example">
    <meta name="description" content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;" onload="alert(2)"></head>`)
  assert.doesNotMatch(shell, /href="(?:javascript|.*admin)|http-equiv|content="fake"|onload=|<script>alert|<img src=x/)
  assert.match(shell, /&lt;img/)
})

test('published metadata refreshes on upload and restart, and SEO files stop when disabled', async t => {
  const { rootDir, service } = await fixture(t)
  await service.deployHtml('<head><title>First brand</title><link rel="canonical" href="https://example.com/"></head>')
  assert.match(service.renderShell(), /<title>First brand<\/title>/)
  assert.ok(service.publicSeoFile('sitemap.xml'))
  assert.equal(service.publicSeoFile('../config.json'), null)
  await service.setEnabled(false)
  assert.equal(service.publicSeoFile('sitemap.xml'), null)
  await service.deployHtml('<head><title>New brand</title><link rel="icon" href="new.png"></head>')
  assert.match(service.renderShell(), /<title>New brand<\/title>/)
  assert.doesNotMatch(service.renderShell(), /First brand/)
  assert.equal(service.publicSeoFile('sitemap.xml'), null)
  const restarted = createCustomHomepageService({ rootDir, siteDir: path.join(rootDir, 'site'), configPath: path.join(rootDir, 'config.json') })
  await restarted.initialize()
  assert.match(restarted.renderShell(), /href="\/_custom-homepage\/new.png"/)
  await restarted.reset()
  assert.doesNotMatch(restarted.renderShell(), /New brand/)
})

test('independent downstream deployments keep their own brand, icon and domain', async t => {
  const { service: agencyA } = await fixture(t)
  const { service: agencyB } = await fixture(t)
  await agencyA.deployHtml('<head><title>星河助手官网</title><link rel="icon" href="star.png"><link rel="canonical" href="https://agency-a.example/"><meta property="og:site_name" content="星河助手"></head>')
  await agencyB.deployHtml('<head><title>青禾智能工作台</title><link rel="icon" href="leaf.svg"><link rel="canonical" href="https://agency-b.example/"><meta property="og:site_name" content="青禾智能"></head>')
  assert.match(agencyA.renderShell(), /<title>星河助手官网<\/title>/)
  assert.match(agencyA.renderShell(), /href="\/_custom-homepage\/star.png"/)
  assert.doesNotMatch(agencyA.renderShell(), /青禾|agency-b|梦羽|mengyulab/)
  assert.match(agencyA.publicSeoFile('sitemap.xml').content, /https:\/\/agency-a.example\//)
  assert.match(agencyB.renderShell(), /<title>青禾智能工作台<\/title>/)
  assert.match(agencyB.renderShell(), /href="\/_custom-homepage\/leaf.svg"/)
  assert.doesNotMatch(agencyB.renderShell(), /星河|agency-a|梦羽|mengyulab/)
  assert.match(agencyB.publicSeoFile('robots.txt').content, /https:\/\/agency-b.example\/sitemap.xml/)
  await agencyA.reset()
  assert.match(agencyB.renderShell(), /青禾智能工作台/)
  assert.doesNotMatch(customHomepageShell(), /梦羽|mengyulab|tubiao|星河|青禾/)
})
