import assert from 'node:assert/strict'
import test from 'node:test'

import { buildNeedsRemoteMetadata, remoteBuildMetadataPatch } from './build-record-sync.mjs'

test('detects historical delegated builds with missing version or client mode', () => {
  assert.equal(buildNeedsRemoteMetadata({ version: '', brand: null }), true)
  assert.equal(buildNeedsRemoteMetadata({ version: '3.0.0', brand: {} }), true)
  assert.equal(buildNeedsRemoteMetadata({ version: '3.0.0', brand: { clientMode: 'personal' } }), false)
})

test('copies authoritative remote metadata while forcing personal mode', () => {
  const patch = remoteBuildMetadataPatch(
    { version: '', brand: { localOnly: 'retained' } },
    { version: '3.0.0-beta.96', brand: { clientMode: 'personal', sourceProjectId: '9999' } },
  )
  assert.deepEqual(patch, {
    version: '3.0.0-beta.96',
    brand: { localOnly: 'retained', clientMode: 'personal', sourceProjectId: '9999' },
  })
})

test('does not erase valid local metadata when remote metadata is absent', () => {
  assert.deepEqual(remoteBuildMetadataPatch(
    { version: '3.0.0', brand: { clientMode: 'personal' } },
    { version: '', brand: null },
  ), {})
})

