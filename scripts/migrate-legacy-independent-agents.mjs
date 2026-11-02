import fs from 'node:fs'
import mysql from 'mysql2/promise'
import { migrateLegacyIndependentAgents } from '../src/services/authorization/legacy-independent-agents.mjs'

const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1]
if (!args.includes('--config') || !args.includes('--mapping')) throw new Error('Required: --config protected-db.json --mapping confirmed-identities.json [--apply --expected-digest SHA256]')
const pool = mysql.createPool(JSON.parse(fs.readFileSync(value('--config'), 'utf8')))
try {
  const result = await migrateLegacyIndependentAgents(pool, JSON.parse(fs.readFileSync(value('--mapping'), 'utf8')), { apply: args.includes('--apply'), expectedDigest: args.includes('--expected-digest') ? value('--expected-digest') : undefined })
  console.log(JSON.stringify(result))
} finally { await pool.end() }
