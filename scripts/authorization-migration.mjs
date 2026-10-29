import fs from 'node:fs/promises'
import { auditLegacyAuthorization, compareMigration } from '../src/services/licensing/migration.mjs'

const [command, inputFile, secondFile] = process.argv.slice(2)
if (!['audit', 'compare'].includes(command) || !inputFile || (command === 'compare' && !secondFile)) throw new Error('Usage: node scripts/authorization-migration.mjs audit snapshot.json | compare before.json after.json')
const before = JSON.parse(await fs.readFile(inputFile, 'utf8'))
const report = command === 'audit' ? auditLegacyAuthorization(before) : compareMigration(before, JSON.parse(await fs.readFile(secondFile, 'utf8')))
console.log(JSON.stringify(report, null, 2))
if ((command === 'audit' && !report.ready) || (command === 'compare' && !report.matches)) process.exitCode = 2
