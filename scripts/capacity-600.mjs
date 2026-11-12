// Disposable local MySQL, real Admin HTTP/auth/model/billing path, synthetic upstream only.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { ModelCredentialVault } from '../src/services/model-credentials.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const artifact = path.join(root, 'capacity-results'); fs.mkdirSync(artifact, { recursive: true })
const stamp = Date.now().toString(36), container = `yushu-capacity-${stamp}`, database = `capacity_${stamp}`
const password = crypto.randomBytes(24).toString('hex')
const sleep = ms => new Promise(r=>setTimeout(r,ms))
const docker = args => { const p=spawnSync('docker',args,{encoding:'utf8',windowsHide:true}); if(p.status) throw Error(p.stderr); return p.stdout.trim() }
const listen = server => new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)))
const freePort = async()=>{const s=http.createServer(); const p=await listen(s); await new Promise(r=>s.close(r)); return p}
let pool, child, mock, logHandle, stage = {}, active = 0, mockPeak = 0, sequence = 0
const ipc = command => new Promise((resolve,reject)=>{
  const id=crypto.randomUUID(), timeout=setTimeout(()=>reject(Error('IPC timeout')),10000)
  const callback=msg=>{if(msg.id===id){clearTimeout(timeout);child.off('message',callback);resolve(msg)}}
  child.on('message',callback);child.send({command,id})
})
const percentile = values => {const a=[...values].sort((a,b)=>a-b);return {p50:a[Math.floor(a.length*.5)]||0,p95:a[Math.floor(a.length*.95)]||0,p99:a[Math.floor(a.length*.99)]||0,max:a.at(-1)||0}}
const results=[]
const driverDelay=monitorEventLoopDelay({resolution:20});driverDelay.enable()
try {
  const dbPort=await freePort(), port=await freePort()
  docker(['run','-d','--name',container,'--memory=1g','--cpus=2','-p',`127.0.0.1:${dbPort}:3306`,'-e',`MYSQL_ROOT_PASSWORD=${password}`,'-e',`MYSQL_DATABASE=${database}`,'mysql:8.4','--innodb-buffer-pool-size=256M','--max-connections=80'])
  const config={host:'127.0.0.1',port:dbPort,user:'root',password,database,connectionLimit:3}
  for(let i=0;i<120;i++){try{pool=mysql.createPool(config);await pool.query('SELECT 1');break}catch{await pool?.end();pool=null;await sleep(500)}}
  if(!pool) throw Error('Disposable MySQL unavailable')
  mock=http.createServer(async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return}
    const incoming=[];for await(const b of req) incoming.push(b)
    const body=JSON.parse(Buffer.concat(incoming));const s={...stage};const id=`mock-${++sequence}`
    active++;mockPeak=Math.max(mockPeak,active)
    let closed=false;res.on('close',()=>{closed=true;active--})
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'})
    const frame=n=>`data: ${JSON.stringify({id,choices:[{delta:{content:'x'.repeat(s.chunkBytes||100)},index:0}]})}\n\n`
    const count=s.chunks||60, interval=(s.durationMs||15000)/count
    for(let n=0;n<count&&!closed;n++){
      if(!res.write(frame(n))) await new Promise(resolve=>{
        const done=()=>{res.off('drain',done);res.off('close',done);resolve()}
        res.once('drain',done);res.once('close',done)
      })
      await sleep(interval)
    }
    if(!closed) res.end(`data: ${JSON.stringify({id,choices:[],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}})}\n\ndata: [DONE]\n\n`)
  })
  const mockPort=await listen(mock)
  logHandle=fs.openSync(path.join(artifact,'server.log'),'a')
  const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,TMP:process.env.TMP,
    NODE_ENV:'test',AI_AUTHORIZATION_MODE:'legacy',AI_CENTER_SUPPLIER_MANAGEMENT:'1',AI_OFFICIAL_AUTHORIZATION_MODE:'legacy',
    AI_ADMIN_HOST:'127.0.0.1',AI_ADMIN_PORT:String(port),AI_ADMIN_USER:'admin',AI_ADMIN_PASSWORD:password,
    AI_ADMIN_PUBLIC_URL:'https://capacity.invalid',AI_DB_HOST:'127.0.0.1',AI_DB_PORT:String(dbPort),AI_DB_USER:'root',AI_DB_PASSWORD:password,AI_DB_NAME:database,
    AI_SOURCE_VERSION:'capacity-test',AI_SOURCE_VERSION_URL:`http://127.0.0.1:${mockPort}/version`,
    AI_ADMIN_UPDATE_MANIFEST_URL:`http://127.0.0.1:${mockPort}/updates`,AI_BUILD_CENTER_URL:'',AI_WORKER_TOKEN:'',
    CAPACITY_POOL_SIZE:process.env.CAPACITY_POOL_SIZE || '',
    AI_UPDATE_ROOT:path.join(artifact,'updates'),AI_PREVIEW_ROOT:path.join(artifact,'preview'),AI_MODEL_CREDENTIAL_KEY_PATH:path.join(artifact,'model.key'),AI_PAYMENT_SECRET_FILE:path.join(artifact,'payment.key')}
  child=spawn(process.execPath,['--max-old-space-size=768','--import','./scripts/capacity-preload.mjs','cloud/ai-admin/server.mjs'],{cwd:root,env,stdio:['ignore',logHandle,logHandle,'ipc'],windowsHide:true})
  const base=`http://127.0.0.1:${port}`
  let ready=false
  for(let i=0;i<160;i++){if(child.exitCode!==null)throw Error('Admin exited: '+fs.readFileSync(path.join(artifact,'server.log'),'utf8').slice(-3500));try{if((await fetch(base+'/api/runtime-info')).ok){ready=true;break}}catch{}await sleep(250)}
  if(!ready)throw Error('Admin readiness timeout')
  const [[org]]=await pool.query("SELECT primary_organization_id AS id FROM ai_users WHERE id='admin'")
  await pool.query("INSERT INTO ai_model_providers(id,name,base_url,organization_id) VALUES('capacity-provider','Synthetic loopback',?,?)",[`http://127.0.0.1:${mockPort}/v1`,org.id])
  await pool.query("INSERT INTO ai_provider_models(id,provider_id,model_id,display_name,model_type,organization_id) VALUES('capacity-model','capacity-provider','capacity-model','Synthetic','text',?)",[org.id])
  const vault=new ModelCredentialVault(env.AI_MODEL_CREDENTIAL_KEY_PATH),cipher=await vault.seal('synthetic-no-value-key','capacity-account')
  await pool.query("INSERT INTO ai_model_upstream_accounts(id,organization_id,provider_id,name) VALUES('capacity-account',?,'capacity-provider','Synthetic')",[org.id])
  await pool.query("INSERT INTO ai_model_provider_keys(id,provider_id,organization_id,upstream_account_id,api_key,secret_ciphertext) VALUES('capacity-key','capacity-provider',?,'capacity-account','',?)",[org.id,cipher])
  await pool.query("INSERT INTO ai_model_pricing_rules(id,provider_id,provider_model_id,billing_type,points_per_request,organization_id) VALUES('capacity-price','capacity-provider','capacity-model','per_request',1,?)",[org.id])
  const tokens=Array.from({length:600},(_,i)=>`synthetic-user-${i}-${stamp}`)
  if (!process.env.CAPACITY_COLD) await pool.query("INSERT INTO ai_membership_cards(id,name,created_by) VALUES('capacity-card','Synthetic active membership','admin')")
  for(let i=0;i<600;i++){
    await pool.query("INSERT INTO ai_end_users(id,username,display_name,password_hash,source_agent_id,organization_id,credit_balance) VALUES(?,?,?,'test-only','admin',?,10000)",[`capacity-user-${i}`,`capacity-user-${i}`,'Synthetic',org.id])
    await pool.query("INSERT INTO ai_end_user_sessions(token_hash,user_id,expires_at) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 1 DAY))",[crypto.createHash('sha256').update(tokens[i]).digest('hex'),`capacity-user-${i}`])
    if (!process.env.CAPACITY_COLD) await pool.query("INSERT INTO ai_end_user_memberships(id,user_id,card_id,package_name,created_by,expires_at) VALUES(?,?,'capacity-card','Synthetic','admin',?)",[`capacity-member-${i}`,`capacity-user-${i}`,process.env.CAPACITY_EXPIRED?'2020-01-01 00:00:00':null])
  }
  const request = (i,s)=>new Promise(resolve=>{
    const started=performance.now();let first=0,bytes=0,text='',error=''
    const body=JSON.stringify({model:'capacity-model',stream:true,messages:[{role:'user',content:'Benchmark '+ 'x'.repeat(s.inputBytes||1024)}]})
    const req=http.request(base+'/api/client/model/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${tokens[s.sameUser?0:i]}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
      res.on('data',b=>{first||=performance.now()-started;bytes+=b.length;if(text.length<4096)text+=b.toString();if(b.includes(Buffer.from('[DONE]')))text+='[DONE]';})
      if(s.slow){res.pause();setTimeout(()=>res.resume(),s.slow)}
      res.on('end',()=>resolve({status:res.statusCode,firstMs:first,totalMs:performance.now()-started,bytes,done:text.includes('[DONE]'),error:res.statusCode===200?'':text.slice(0,300)}))
      res.on('error',e=>resolve({status:0,error:e.message}))
    });req.setTimeout(150000,()=>req.destroy(Error('test timeout')));req.on('error',e=>resolve({status:0,error:e.message}));req.end(body)
  })
  const stages=process.env.CAPACITY_QUICK ? [{name:'smoke',n:1,durationMs:1000}] : [
    {name:'100-burst',n:100,durationMs:15000},
    {name:'300-burst',n:300,durationMs:15000},
    {name:'600-burst',n:600,durationMs:15000},
    {name:'600-sustained',n:600,durationMs:60000,chunks:240},
    {name:'600-large-context',n:600,durationMs:15000,inputBytes:256*1024},
    {name:'600-slow-reader',n:600,durationMs:6000,chunks:16,chunkBytes:32768,slow:15000},
    {name:'600-same-user',n:600,durationMs:15000,sameUser:true},
  ]
  const selected=stages.filter(s=>!process.env.CAPACITY_CASE || s.name===process.env.CAPACITY_CASE)
  for(const s of Array.from({length:Number(process.env.CAPACITY_REPEAT||1)},(_,round)=>selected.map(s=>({...s,round:round+1}))).flat()){
    if(process.env.CAPACITY_TEXT_RATE) Object.assign(s,{durationMs:30000,chunks:600,chunkBytes:256})
    stage=s;mockPeak=0;driverDelay.reset();await ipc('reset')
    const [[before]]=await pool.query("SELECT COUNT(*) AS n,COALESCE(SUM(-points_delta),0) AS points,(SELECT success_count FROM ai_model_provider_keys WHERE id='capacity-key') AS keySuccess FROM ai_credit_ledger WHERE change_type='consume'")
    const t=Date.now(),responses=await Promise.all(Array.from({length:s.n},async(_,i)=>{
      if(process.env.CAPACITY_RAMP) await sleep(Math.floor(i/50)*100)
      return request(i,s)
    }))
    let after
    for(let i=0;i<120;i++){[[after]]=await pool.query("SELECT COUNT(*) AS n,COALESCE(SUM(-points_delta),0) AS points,(SELECT success_count FROM ai_model_provider_keys WHERE id='capacity-key') AS keySuccess FROM ai_credit_ledger WHERE change_type='consume'");const target=responses.filter(r=>r.status===200&&r.done).length;if(after.n-before.n>=target&&Number(after.keySuccess)-Number(before.keySuccess)>=target)break;await sleep(250)}
    const metrics=await ipc('report')
    const [[accounting]]=await pool.query("SELECT (SELECT SUM(credit_balance) FROM ai_end_users WHERE id LIKE 'capacity-user-%') AS balance,(SELECT COUNT(DISTINCT request_id) FROM ai_credit_ledger WHERE change_type='consume') AS uniqueRequests,(SELECT COUNT(*) FROM ai_credit_ledger WHERE change_type='consume') AS ledgerCount,(SELECT COALESCE(SUM(-points_delta),0) FROM ai_credit_ledger WHERE change_type='consume') AS totalDebit,(SELECT COUNT(*) FROM ai_end_user_memberships WHERE status='active') AS activeMemberships,(SELECT MAX(n) FROM (SELECT COUNT(*) n FROM ai_end_user_memberships WHERE status='active' GROUP BY user_id) m) AS maxActiveMembershipsPerUser")
    const result={...s,driverEventLoopP99Ms:driverDelay.percentile(99)/1e6,ramp:process.env.CAPACITY_RAMP?'50 connections per 100ms':'instant burst',accounting,elapsedMs:Date.now()-t,mockPeak,success:responses.filter(r=>r.status===200&&r.done).length,failures:responses.filter(r=>r.status!==200||!r.done),
      firstByteMs:percentile(responses.map(r=>r.firstMs||0)),totalMs:percentile(responses.map(r=>r.totalMs||0)),bytes:responses.reduce((a,r)=>a+(r.bytes||0),0),
      ledgerRows:after.n-before.n,debitedPoints:Number(after.points)-Number(before.points),keySuccessDelta:Number(after.keySuccess)-Number(before.keySuccess),metrics}
    results.push(result);fs.writeFileSync(path.join(artifact,process.env.CAPACITY_REPORT || 'results.json'),JSON.stringify({baseline:'78df029',membershipFixture:process.env.CAPACITY_COLD?'absent-fallback':'active',host:{cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,totalMemoryGiB:os.totalmem()/1073741824,node:process.version,platform:process.platform},db:`MySQL8.4 Docker, 2 CPU / 1GiB; pool=${process.env.CAPACITY_POOL_SIZE||10}`,results},null,2))
    console.log(JSON.stringify({stage:s.name,success:result.success,failures:result.failures.length,mockPeak,firstP95:result.firstByteMs.p95,totalP95:result.totalMs.p95,ledgerRows:result.ledgerRows,points:result.debitedPoints,rssPeak:metrics.peakRssMiB,queuePeak:metrics.queuePeak,eventLoopP99:metrics.eventLoopP99Ms}))
    await sleep(1000)
  }
} finally {
  if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done}
  if(logHandle)fs.closeSync(logHandle)
  mock?.closeAllConnections();await new Promise(r=>mock?mock.close(r):r())
  await pool?.end()
  // Stop only the uniquely named container created above. Preserve test data for inspection.
  spawnSync('docker',['stop','-t','5',container],{windowsHide:true,stdio:'ignore'})
  console.log('Stopped isolated Admin/mock/MySQL. Artifacts: '+artifact+'; DB container: '+container)
}
