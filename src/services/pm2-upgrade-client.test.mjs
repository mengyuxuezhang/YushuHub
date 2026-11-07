import test from 'node:test'
import assert from 'node:assert/strict'
import { selectPm2UpgradeRecord } from './pm2-upgrade-client.mjs'

test('PM2 status uses root event ordering across HTTP and CLI', () => {
  const http = { operationId: 'old-http', stage: 'rolled_back', eventSequence: 10 }
  const cli = { operationId: 'new-cli', stage: 'committed', eventSequence: 20 }
  assert.equal(selectPm2UpgradeRecord(cli, http), cli)
  const newerHttp = { ...http, operationId: 'new-http', eventSequence: 30 }
  assert.equal(selectPm2UpgradeRecord(cli, newerHttp), newerHttp)
  const activeCli = { ...cli, stage: 'verifying' }
  assert.equal(selectPm2UpgradeRecord(activeCli, newerHttp), activeCli)
})

test('legacy undated requests cannot hide CLI terminal results', () => {
  const cli = { operationId: 'cli', stage: 'committed', updatedAt: '2026-11-07T12:00:00+00:00' }
  assert.equal(selectPm2UpgradeRecord(cli, { operationId: 'old', stage: 'failed' }), cli)
  assert.equal(selectPm2UpgradeRecord(cli, { stage: 'failed', updatedAt: '2026-11-07T11:00:00+00:00' }), cli)
  const newer = { stage: 'failed', updatedAt: '2026-11-07T13:00:00+00:00' }
  assert.equal(selectPm2UpgradeRecord(cli, newer), newer)
})
