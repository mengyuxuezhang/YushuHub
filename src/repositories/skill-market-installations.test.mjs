import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { setPool } from '../db/pool.mjs'
import { installedSkillVersions } from './skill-market-installations.mjs'

test('current authenticated device and user determine installation state; other records remain intact', async () => {
  const hash = value => createHash('sha256').update(value).digest('hex')
  const records = [
    { user:'u', device:hash('old-device'), skill:'skill-a', status:'installed', version:'1.0.0' },
    { user:'u', device:hash('this-device'), skill:'skill-a', status:'removed', version:'1.0.0' },
    { user:'other-user', device:hash('this-device'), skill:'skill-a', status:'installed', version:'1.0.0' },
    { user:'u', device:hash('this-device'), skill:'skill-b', status:'blocked', version:'1.0.0' },
  ]
  setPool({ async query(sql, [user, device, ...ids]) {
    assert.match(sql, /i.end_user_id=\? AND i.device_id_hash=\? AND i.status IN \('installed','update_available'\)/)
    assert.match(sql, /i.skill_id IN \(/)
    return [records.filter(r => r.user===user && r.device===device && ids.includes(r.skill) && ['installed','update_available'].includes(r.status)).map(r => ({skill_id:r.skill,version:r.version}))]
  } })
  const current = {id:'u',sessionDeviceId:'this-device'}
  assert.equal((await installedSkillVersions(current,['skill-a','skill-b'])).size,0)
  assert.equal((await installedSkillVersions({id:'u',sessionDeviceId:'old-device'},['skill-a'])).get('skill-a'),'1.0.0')
  records[1].status='installed'
  assert.equal((await installedSkillVersions(current,['skill-a'])).get('skill-a'),'1.0.0')
  records[1].status='update_available'
  assert.equal((await installedSkillVersions(current,['skill-a'])).get('skill-a'),'1.0.0')
  records[1].status='removed'
  assert.equal((await installedSkillVersions(current,['skill-a'])).size,0)
  assert.equal(records[0].status,'installed')
  assert.equal(records[2].status,'installed')
})

test('legacy unbound sessions and empty catalogs do not borrow another device installation', async () => {
  setPool({query(){throw Error('must not query unbound device or empty catalog')}})
  assert.equal((await installedSkillVersions({id:'u'},['skill-a'])).size,0)
  assert.equal((await installedSkillVersions({id:'u',sessionDeviceId:''},['skill-a'])).size,0)
  assert.equal((await installedSkillVersions({id:'u',sessionDeviceId:'d'},[])).size,0)
})
