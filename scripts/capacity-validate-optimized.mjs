import assert from 'node:assert/strict'
import fs from 'node:fs'
const read=name=>JSON.parse(fs.readFileSync(new URL('../capacity-results/'+name,import.meta.url)))
const warm=read('results-optimized-warm.json')
for(const s of warm.results){
  assert.equal(s.ledgerRows,s.success);assert.equal(s.debitedPoints,s.success);assert.equal(s.keySuccessDelta,s.success)
  if(s.name==='600-large-context'){
    assert(s.failures.length>0);assert(s.failures.every(f=>f.status===429&&f.error.includes('MODEL_CAPACITY_EXHAUSTED')))
  }else if(s.name==='600-same-user'){
    assert.equal(s.success,8);assert.equal(s.failures.length,592);assert(s.failures.every(f=>f.status===429&&f.error.includes('MODEL_USER_CONCURRENCY_LIMIT')))
  }else assert.equal(s.success,s.n)
  if(s.name==='600-sustained')assert.equal(s.mockPeak,600)
  if(s.name==='600-slow-reader')assert(s.metrics.writablePeak<=128*1024)
}
for(const file of ['results-optimized-cold.json','results-optimized-expired.json','results-optimized-rate.json']){
  const report=read(file)
  for(const [index,s] of report.results.entries()){
    assert.equal(s.success,600);assert.equal(s.mockPeak,600);assert.equal(s.failures.length,0)
    assert.equal(s.ledgerRows,600);assert.equal(s.debitedPoints,600);assert.equal(s.keySuccessDelta,600)
    const count=(index+1)*600
    assert.equal(s.accounting.ledgerCount,count);assert.equal(s.accounting.uniqueRequests,count)
    assert.equal(Number(s.accounting.balance),6000000-count);assert.equal(Number(s.accounting.totalDebit),count)
    assert.equal(s.accounting.activeMemberships,600);assert.equal(s.accounting.maxActiveMembershipsPerUser,1)
    assert.equal(s.metrics.denied,0)
  }
}
console.log('PASS: 600-way SSE/accounting/membership idempotency, bounded slow writes, and expected admission rejection.')
