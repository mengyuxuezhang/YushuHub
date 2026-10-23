import assert from 'node:assert/strict'
import test from 'node:test'

import { compareSemanticVersions, isDesktopNextVersion, parseSemanticVersion } from './version.mjs'

test('compares Desktop Next beta versions using SemVer precedence', () => {
  assert.equal(compareSemanticVersions('2.0.0-beta.2', '2.0.0-beta.1'), 1)
  assert.equal(compareSemanticVersions('2.0.0-beta.1', '2.0.0-beta.2'), -1)
})

test('treats a stable release as newer than its prerelease', () => {
  assert.equal(compareSemanticVersions('2.0.0', '2.0.0-beta.2'), 1)
  assert.equal(compareSemanticVersions('2.0.0-beta.2', '2.0.0'), -1)
})

test('ignores build metadata and rejects non-SemVer input', () => {
  assert.equal(compareSemanticVersions('2.0.0+build.2', '2.0.0+build.1'), 0)
  assert.equal(parseSemanticVersion('1.0'), null)
  assert.equal(compareSemanticVersions('legacy', '2.0.0'), null)
})

test('recognizes only the supported Desktop Next source baseline', () => {
  assert.equal(isDesktopNextVersion('2.0.0-beta.2'), true)
  assert.equal(isDesktopNextVersion('2.0.0'), true)
  assert.equal(isDesktopNextVersion('1.0.97'), false)
  assert.equal(isDesktopNextVersion('not-a-version'), false)
})
