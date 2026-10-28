import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeReleaseHistory, readAgentReleaseHistory } from './release-history.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('fills sparse manifests with 50 actual versions, excludes future versions and duplicates', () => {
  const entries = Array.from({ length: 60 }, (_, i) => ({ version: `3.0.${60 - i}`, releaseNotes: `Release ${60 - i}` }))
  const history = mergeReleaseHistory({ version: '3.0.55', releaseNotes: 'Authoritative notes' }, entries.slice(0, 10), entries)
  assert.equal(history.length, 50)
  assert.equal(history[0].version, '3.0.55')
  assert.equal(history[0].releaseNotes, 'Authoritative notes')
  assert.equal(history[49].version, '3.0.6')
  assert.equal(new Set(history.map((item) => item.version)).size, 50)
})

test('preserves accumulated releases after a rolling source manifest drops older entries', () => {
  const previous = mergeReleaseHistory({ version: '3.0.55' }, [], Array.from({ length: 55 }, (_, i) => ({ version: `3.0.${55 - i}` })))
  const next = mergeReleaseHistory({ version: '3.0.56' }, [{ version: '3.0.55' }], previous)
  assert.equal(next.length, 50)
  assert.equal(next.at(-1).version, '3.0.7')
})

test('full history retains every known version while the default update contract stays bounded', () => {
  const entries = Array.from({ length: 126 }, (_, i) => ({ version: `1.0.${i}`, publishedAt: '2026-08-01T00:00:00Z', releaseNotes: `Release ${i}` }))
  const current = { version: '1.0.125', releaseNotes: 'Authoritative current notes' }
  const full = mergeReleaseHistory(current, [...entries.slice(-10), { version: '1.0.126' }, { version: 'not-a-version' }], entries, Infinity)
  assert.equal(full.length, 126)
  assert.equal(full.at(-1).version, '1.0.0')
  assert.equal(full[0].releaseNotes, current.releaseNotes)
  assert.equal(mergeReleaseHistory(current, entries).length, 50)
  const next = mergeReleaseHistory({ version: '1.0.126' }, [], full, Infinity)
  assert.equal(next.length, 127)
})

test('Agent timeline combines the rolling feed, accumulated archive and bundled history without future releases', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-timeline-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'docs'))
  fs.mkdirSync(path.join(root, 'data'))
  fs.writeFileSync(path.join(root, 'docs', 'AGENT_UPDATE_HISTORY.json'), JSON.stringify([{ version: '3.0.0', releaseNotes: 'First' }, { version: '3.0.3', releaseNotes: 'Future' }]))
  fs.writeFileSync(path.join(root, 'data', 'agent-release-history.json'), JSON.stringify([{ version: '3.0.1', releaseNotes: 'Cached' }]))
  const history = readAgentReleaseHistory({ version: '3.0.2', releaseNotes: 'Latest', history: [{ version: '3.0.1', releaseNotes: 'Source notes' }] }, root)
  assert.deepEqual(history.map(item => item.version), ['3.0.2', '3.0.1', '3.0.0'])
  assert.equal(history[1].releaseNotes, 'Source notes')
})
