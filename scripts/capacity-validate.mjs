import assert from 'node:assert/strict'
import fs from 'node:fs'
const read=name=>JSON.parse(fs.readFileSync(new URL('../capacity-results/'+name,import.meta.url)))
const warm=read('results-warm.json')
for(const name of ['100-burst','300-burst','600-sustained','600-slow-reader','600-same-user']){
  const s=warm.results.find(s=>s.name===name)
  assert.equal(s.success,s.n);assert.equal(s.mockPeak,s.n);assert.equal(s.ledgerRows,s.success);assert.equal(s.debitedPoints,s.success)
}
for(const name of ['600-burst','600-large-context']){
  const s=warm.results.find(s=>s.name===name)
  assert(s.failures.every(f=>f.error?.startsWith('connect ECONNREFUSED')))
}
for(const name of ['results-ramp10.json','results-ramp30.json']){
  const s=read(name).results[0]
  assert.equal(s.success,600);assert.equal(s.mockPeak,600);assert.equal(s.failures.length,0)
  assert.equal(s.ledgerRows,600);assert.equal(s.debitedPoints,600)
  assert.equal(s.accounting.uniqueRequests,600);assert.equal(s.accounting.ledgerCount,600)
  assert.equal(Number(s.accounting.balance),5999400);assert.equal(Number(s.accounting.totalDebit),600)
  assert.equal(s.metrics.denied,0)
}
const cold=read('results-cold.json').results[0]
assert.equal(cold.success,10);assert.equal(cold.failures.length,90)
assert(cold.failures.every(f=>f.status===400&&f.error.includes('Deadlock found')))
console.log('Verified complete SSE, active concurrency, accounting, failure classification and egress observations.')
