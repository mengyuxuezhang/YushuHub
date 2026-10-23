export const selectUpgradePm2Script = String.raw`
const path=require('node:path');
let input='';
process.stdin.on('data',chunk=>input+=chunk).on('end',()=>{
  try {
    const desired=process.argv[1],cwd=process.argv[2];
    const rows=JSON.parse(input),same=rows.filter(row=>row?.pm2_env?.pm_cwd&&path.resolve(row.pm2_env.pm_cwd)===path.resolve(cwd));
    const desiredRow=same.find(row=>row.name===desired);
    const online=same.filter(row=>row?.pm2_env?.status==='online'&&Number(row.pid)>0);
    let selected;
    if(online.length>1) throw new Error('multiple online PM2 processes use the same application directory: '+online.map(row=>row.name).join(', '));
    if(desiredRow?.pm2_env?.status==='online') selected=desiredRow;
    else if(online.length===1) selected=online[0];
    else selected=desiredRow||{name:desired,pid:0,pm2_env:{status:'missing',pm_cwd:cwd}};
    process.stdout.write(JSON.stringify({name:selected.name,pid:Number(selected.pid||0),status:selected.pm2_env.status,legacy:selected.name!==desired}));
  } catch(error) { console.error(error.message); process.exit(1); }
});`

export const verifyAdminRuntimeScript = String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const [name,cwd,portText,expected,oldPidText,publicUrl]=process.argv.slice(1),port=Number(portText),oldPid=Number(oldPidText||0);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function verifyBase(base,diskHtml){
  const response=await fetch(new URL('/admin/v2/',base),{signal:AbortSignal.timeout(5000)});
  if(!response.ok) throw new Error(base+' admin HTML HTTP '+response.status);
  const html=await response.text();
  if(html!==diskHtml) throw new Error(base+' is serving an HTML shell different from the installed release');
  const assets=[...html.matchAll(/(?:src|href)="([^"]+\/assets\/[^"?]+\.(?:js|css))"/g)].map(match=>match[1]);
  if(assets.length<2) throw new Error(base+' HTML does not reference JS and CSS assets');
  for(const asset of assets){
    const item=await fetch(new URL(asset,base),{signal:AbortSignal.timeout(5000)}),type=String(item.headers.get('content-type')||'').toLowerCase();
    if(!item.ok) throw new Error(asset+' HTTP '+item.status);
    if(asset.endsWith('.js')&&!type.includes('javascript')) throw new Error(asset+' returned '+(type||'no content type'));
    if(asset.endsWith('.css')&&!type.includes('text/css')) throw new Error(asset+' returned '+(type||'no content type'));
  }
}
async function once(){
  const rows=JSON.parse(cp.execFileSync('pm2',['jlist'],{encoding:'utf8'})),row=rows.find(item=>item.name===name),pid=Number(row?.pid||0);
  if(row?.pm2_env?.status!=='online'||!pid) throw new Error('PM2 process is not online');
  if(path.resolve(row.pm2_env.pm_cwd||'')!==path.resolve(cwd)) throw new Error('PM2 working directory mismatch');
  if(oldPid&&pid===oldPid) throw new Error('PM2 has not switched to a new PID');
  const sockets=cp.execFileSync('ss',['-ltnp','sport = :'+port],{encoding:'utf8'});
  if(!sockets.includes('pid='+pid+',')) throw new Error('target port is not owned by the restarted PM2 PID');
  const base='http://127.0.0.1:'+port,diskHtml=fs.readFileSync(path.join(cwd,'web','admin-v2','index.html'),'utf8');
  const runtimeResponse=await fetch(base+'/api/runtime-info',{signal:AbortSignal.timeout(4000)});
  if(runtimeResponse.ok){const runtime=await runtimeResponse.json();if(runtime?.data?.version!==expected)throw new Error('running version is '+(runtime?.data?.version||'unknown'));}
  await verifyBase(base,diskHtml);
  if(publicUrl) await verifyBase(publicUrl,diskHtml);
  return pid;
}
(async()=>{let stable=0,last='service did not become ready';for(let attempt=0;attempt<40;attempt++){await wait(1000);try{const pid=await once();stable++;if(stable>=3){console.log('verified_pid='+pid);console.log('verified_version='+expected);return;}}catch(error){stable=0;last=error.message;}}throw new Error(last);})().catch(error=>{console.error(error.message);process.exit(1)});`

export function parseSelectedPm2(value) {
  const parsed = JSON.parse(String(value || '').trim())
  if (!parsed.name) throw new Error('PM2 selection did not return a process name')
  return parsed
}
