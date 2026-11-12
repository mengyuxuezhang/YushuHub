import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = server => new Promise(resolve => server.close(resolve))

test('isolated observer guards egress/database, authenticates metrics and routes only synthetic upstream traffic', async () => {
  let calls = 0
  const upstream = http.createServer((req, res) => { calls++;res.end('synthetic') })
  const mockPort = await listen(upstream)
  const reserve = http.createServer(), port = await listen(reserve);await close(reserve)
  const program = `
    import assert from 'node:assert/strict';import http from 'node:http';import mysql from 'mysql2/promise';
    const base='http://127.0.0.1:'+process.env.CAPACITY_METRICS_PORT;
    assert.equal((await fetch(base+'/snapshot')).status,403);
    const headers={'x-capacity-token':process.env.CAPACITY_METRICS_TOKEN};
    await fetch(base+'/reset',{method:'POST',headers});
    assert.throws(()=>fetch('https://never-contact.invalid'),/CAPACITY_EGRESS_DENIED/);
    assert.throws(()=>mysql.createPool({host:'remote.invalid',database:'capacity_test'}),/CAPACITY_DB_GUARD/);
    assert.throws(()=>mysql.createPool({host:'127.0.0.1',database:'real_database'}),/CAPACITY_DB_GUARD/);
    assert.equal(await (await fetch('http://127.0.0.1:1/v1/chat/completions',{method:'POST',body:'{}'})).text(),'synthetic');
    const server=http.createServer((req,res)=>{res.write('unchanged');res.end()});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const reply=await fetch('http://127.0.0.1:'+server.address().port+'/api/client/model/v1/chat/completions',{method:'POST',headers:{'x-capacity-sent-at':String(Date.now())}});
    assert.equal(await reply.text(),'unchanged');
    const metrics=await (await fetch(base+'/snapshot',{headers})).json();
    assert.equal(metrics.denied,1);assert.equal(metrics.httpIngress.n,1);assert.equal(metrics.firstWrite.n,1);
    server.closeAllConnections();await new Promise(r=>server.close(r));
    const {closeCapacityObserver}=await import('./scripts/capacity-preload.mjs');await closeCapacityObserver();
    console.log('observer verified');
  `
  try {
    const result = await exec(process.execPath, ['--import', new URL('./capacity-preload.mjs', import.meta.url).href, '--input-type=module', '-e', program], {
      cwd: new URL('../', import.meta.url), timeout: 10000, windowsHide: true,
      env: { ...process.env, CAPACITY_METRICS_PORT: String(port), CAPACITY_METRICS_TOKEN: 'synthetic-test-token', CAPACITY_MOCK_ORIGIN: 'http://127.0.0.1:1', CAPACITY_UPSTREAM_PORTS: String(mockPort) },
    })
    assert.match(result.stdout, /observer verified/);assert.equal(calls,1)
  } finally { upstream.closeAllConnections();await close(upstream) }
})
