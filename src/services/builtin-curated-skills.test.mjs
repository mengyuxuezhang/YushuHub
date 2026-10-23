import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cleanupRetiredBuiltinSkills,
  deleteRetiredPackagePath,
  removeLegacyVideoCreationSkill,
  retireLegacyComputerControlSkill,
} from './builtin-curated-skills.mjs'

test('retired package cleanup rejects paths outside the controlled root', async () => {
  await assert.rejects(deleteRetiredPackagePath(process.execPath), /不在受控存储目录/)
})

function connectionFixture({ skills = [], versions = [], distributions = [], failOn = '' } = {}) {
  const calls = []
  const connection = {
    async query(sql, params = []) {
      const text = String(sql)
      calls.push([text, params])
      if (failOn && text.includes(failOn)) throw new Error('fixture failure')
      if (text.includes('GET_LOCK')) return [[{ acquired: 1 }]]
      if (text.startsWith('SELECT id FROM ai_curated_skills WHERE id=')) return [skills]
      if (text.startsWith('SELECT package_path FROM ai_curated_skill_versions')) return [versions]
      if (text.startsWith('SELECT id FROM ai_curated_skill_distributions')) return [distributions]
      if (text.startsWith('SELECT id,current_version_id,status FROM ai_curated_skills')) {
        const computer = skills.find((item) => item.id === 'computer-control')
        return [[computer]]
      }
      return [{}]
    },
    async beginTransaction() { calls.push(['BEGIN']) },
    async commit() { calls.push(['COMMIT']) },
    async rollback() { calls.push(['ROLLBACK']) },
    release() { calls.push(['RELEASE']) },
  }
  return { calls, connection, pool: { getConnection: async () => connection } }
}

test('legacy video cleanup is idempotent when no record exists', async () => {
  const fixture = connectionFixture()
  assert.deepEqual(await removeLegacyVideoCreationSkill(fixture.connection), {
    removed: false,
    skillIds: [],
    packagePaths: [],
  })
  assert.equal(fixture.calls.some(([sql]) => sql === 'BEGIN'), false)
})

test('legacy video cleanup removes all dependencies in a transaction', async () => {
  const fixture = connectionFixture({
    skills: [{ id: 'video-creation' }, { id: 'legacy-copy' }],
    versions: [{ package_path: 'D:/controlled/video.enc' }],
    distributions: [{ id: 'distribution-1' }],
  })
  const result = await removeLegacyVideoCreationSkill(fixture.connection)
  assert.deepEqual(result, {
    removed: true,
    skillIds: ['video-creation', 'legacy-copy'],
    packagePaths: ['D:/controlled/video.enc'],
  })
  const sql = fixture.calls.map(([statement]) => statement)
  const orderedTables = [
    'ai_curated_skill_audiences',
    'ai_curated_skill_installations',
    'ai_curated_skill_distributions',
    'ai_curated_skill_market_placements',
    'ai_curated_skill_targets',
    'ai_curated_skill_versions',
    'ai_curated_skill_events',
    'ai_curated_skills',
  ]
  const positions = orderedTables.map((table) => sql.findIndex((statement) => statement.startsWith(`DELETE FROM ${table}`)))
  assert.ok(positions.every((position) => position >= 0))
  assert.deepEqual([...positions].sort((a, b) => a - b), positions)
  assert.ok(sql.includes('COMMIT'))
})

test('legacy video cleanup rolls back on dependency deletion failure', async () => {
  const fixture = connectionFixture({
    skills: [{ id: 'video-creation' }],
    failOn: 'DELETE FROM ai_curated_skill_versions',
  })
  await assert.rejects(removeLegacyVideoCreationSkill(fixture.connection), /fixture failure/)
  assert.ok(fixture.calls.some(([sql]) => sql === 'ROLLBACK'))
  assert.equal(fixture.calls.some(([sql]) => sql === 'COMMIT'), false)
})

test('central and downstream startup both clean video and do not seed it', async () => {
  const fixture = connectionFixture()
  const result = await cleanupRetiredBuiltinSkills({ pool: fixture.pool, actorId: 'system-test' })
  assert.deepEqual(result.removedVideoCreation, { removed: false, skillIds: [], packagePaths: [] })
  assert.deepEqual(result.retiredComputerControl, { retired: false, reason: 'missing' })
  const sql = fixture.calls.map(([statement]) => statement).join('\n')
  assert.doesNotMatch(sql, /INSERT INTO ai_curated_skills/)
  assert.match(sql, /GET_LOCK/)
  assert.match(sql, /RELEASE_LOCK/)
})

test('computer control retirement remains non-destructive', async () => {
  const fixture = connectionFixture({
    skills: [{ id: 'computer-control', current_version_id: 'computer-v1', status: 'published' }],
  })
  assert.deepEqual(await retireLegacyComputerControlSkill(fixture.connection, 'system-test'), {
    retired: true,
    skillId: 'computer-control',
  })
  const sql = fixture.calls.map(([statement]) => statement).join('\n')
  assert.match(sql, /INSERT IGNORE INTO ai_curated_skill_events/)
  assert.doesNotMatch(sql, /DELETE FROM/)
})
