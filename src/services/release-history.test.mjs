import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeReleaseHistory } from './release-history.mjs'

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
