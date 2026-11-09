// Explicit browser smoke test. Uses a separate headless profile and mocked operations.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'

const executable = process.env.ADMIN_TEST_CHROME
if (!executable) throw new Error('Set ADMIN_TEST_CHROME to a Chrome/Chromium executable')
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-repair-browser-'))
const chrome = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let socket
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser startup timed out')), 15000)
    chrome.on('error', error => { clearTimeout(timer); reject(error) })
    let output = ''
    chrome.stderr.on('data', data => { output += data; const found = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (found) { clearTimeout(timer); resolve(found[1]) } })
  })
  const base = endpoint.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '')
  const target = await (await fetch(`${base}/json/new?${encodeURIComponent('http://127.0.0.1:47831/?t=repair-ui-fixture')}`, { method: 'PUT' })).json()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  const pending = new Map(); let id = 0
  socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id) { const p = pending.get(message.id); pending.delete(message.id); message.error ? p.reject(message.error) : p.resolve(message.result) } }
  const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 1100, deviceScaleFactor: 1, mobile: false })
  for (let attempt = 0; attempt < 30; attempt++) { if (await evaluate('Boolean(document.querySelector("#maintForm"))')) break; await new Promise(resolve => setTimeout(resolve, 100)) }
  const result = await evaluate(`(async()=>{
    document.querySelector('[data-tab="maint"]').click();
    const form=document.querySelector('#maintForm');
    for(const [name,value] of Object.entries({host:'192.0.2.10',username:'root',password:'fixture-only',appDir:'/srv/fixture-admin',publicUrl:'https://admin.example.com'})) {form.elements[name].value=value;form.elements[name].dispatchEvent(new Event('input',{bubbles:true}));}
    window.operations=[];
    window.fetch=async(_url,options)=>{const input=JSON.parse(options.body);window.operations.push(input);return new Response(input.action==='repair-plan'?'实例：fixture；重装依赖，重启并验证\\nrepair_plan='+ 'a'.repeat(64)+'\\n退出码: 0\\n':'修复已通过验证\\n退出码: 0\\n');};
    const wait=async()=>{for(let i=0;i<50;i++){if(!document.querySelector('[data-action="repair"]').disabled)return;await new Promise(r=>setTimeout(r,10));}throw Error('UI action timed out');};
    document.querySelector('[data-action="repair"]').click();await wait();
    if(window.operations.length!==0)throw Error('Repair executed without preview');
    document.querySelector('[data-action="repair-plan"]').click();await wait();
    document.querySelector('[data-action="repair"]').click();await wait();
    const valid=window.operations.at(-1).repairPlan==='a'.repeat(64);
    document.querySelector('[data-action="repair-plan"]').click();await wait();
    const count=window.operations.length;form.elements.appDir.value='/srv/changed';form.elements.appDir.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('[data-action="repair"]').click();await wait();
    return {valid,invalidated:window.operations.length===count,overflow:document.documentElement.scrollWidth>innerWidth,actions:window.operations.map(x=>x.action)};
  })()`)
  assert.equal(result.valid, true); assert.equal(result.invalidated, true); assert.equal(result.overflow, false)
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  if (process.env.ADMIN_TEST_SCREENSHOT) await fs.writeFile(process.env.ADMIN_TEST_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
  console.log(JSON.stringify({ browserRepairFlow: 'passed', ...result }))
} finally {
  socket?.close(); chrome.kill()
  await new Promise(resolve => chrome.once('exit', resolve))
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
