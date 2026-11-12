// Isolated benchmark only: observation and loopback-only egress. No business substitutions.
import mysql from 'mysql2/promise'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import http from 'node:http'
import https from 'node:https'
const nativeFetch = globalThis.fetch
let denied = 0
let transportErrors = {}
const syntheticPorts = String(process.env.CAPACITY_UPSTREAM_PORTS || '').split(',').filter(Boolean).map(Number)
let syntheticRound = 0
function allowed(value) {
  const u = new URL(String(value?.url || value))
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    denied++; throw new Error('CAPACITY_EGRESS_DENIED: ' + u.hostname)
  }
}
globalThis.fetch = (url, options) => {
  allowed(url)
  const parsed = new URL(String(url?.url || url))
  if (syntheticPorts.length && parsed.origin === process.env.CAPACITY_MOCK_ORIGIN && parsed.pathname === '/v1/chat/completions') {
    const port = syntheticPorts[syntheticRound++ % syntheticPorts.length]
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid synthetic tunnel port')
    parsed.port = String(port);url = parsed;allowed(url)
  }
  return nativeFetch(url, options).catch(error => {
    const code = String(error?.cause?.code || error?.code || error?.name || 'unknown')
    transportErrors[code] = (transportErrors[code] || 0) + 1
    throw error
  })
}
for (const module of [http, https]) {
  const request = module.request
  module.request = function (...args) {
    const a = args[0]
    if (typeof a === 'string' || a instanceof URL) allowed(a)
    else if (!['127.0.0.1', 'localhost', '::1'].includes(a.hostname || a.host || 'localhost')) throw Error('CAPACITY_HTTP_EGRESS_DENIED')
    return request.apply(this, args)
  }
}
const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable()
let measurements, peak, cpuStart, started
function reset() {
  transportErrors = {}
  measurements = { query: [], acquire: [], arrivals: [], ingress: [], firstWrites: [], sql: {}, enqueued: 0, queuePeak: 0, writablePeak: 0, backpressure: 0 }
  peak = process.memoryUsage().rss; cpuStart = process.cpuUsage(); started = performance.now(); delay.reset()
}
reset()
const received = Symbol('capacityHttpReceived'), wrote = Symbol('capacityHttpWrote')
const serverEmit = http.Server.prototype.emit
http.Server.prototype.emit = function (event, ...args) {
  if (event === 'request' && String(args[0]?.url || '').split('?')[0] === '/api/client/model/v1/chat/completions') {
    args[1][received] = performance.now()
    measurements.arrivals.push(args[1][received] - started)
    const sent = Number(args[0].headers['x-capacity-sent-at'])
    if (Number.isFinite(sent) && sent > 0) measurements.ingress.push(Math.max(0, Date.now() - sent))
  }
  return serverEmit.call(this, event, ...args)
}
const responseWrite = http.ServerResponse.prototype.write
http.ServerResponse.prototype.write = function (...args) {
  if (this[received] !== undefined && !this[wrote]) {
    this[wrote] = true;measurements.firstWrites.push(performance.now() - this[received])
  }
  const result = responseWrite.apply(this, args)
  measurements.writablePeak = Math.max(measurements.writablePeak, this.writableLength)
  if (!result) measurements.backpressure++
  return result
}
function observe(object, name, list, sql = false) {
  const original = object[name]
  object[name] = async function (...args) {
    const t = performance.now()
    try { return await original.apply(this, args) }
    finally {
      const ms = performance.now() - t
      measurements[list].push(ms)
      if (sql) {
        const key = String(args[0]?.sql || args[0]).replace(/\s+/g, ' ').slice(0, 180)
        const item = measurements.sql[key] ||= { count: 0, ms: 0, max: 0 }
        item.count++; item.ms += ms; item.max = Math.max(item.max, ms)
      }
    }
  }
}
const createPool = mysql.createPool
mysql.createPool = function (options) {
  if (options.host !== '127.0.0.1' || !String(options.database).startsWith('capacity_')) throw Error('CAPACITY_DB_GUARD')
  const pool = createPool.call(this, process.env.CAPACITY_POOL_SIZE ? { ...options, connectionLimit: Number(process.env.CAPACITY_POOL_SIZE) } : options)
  observe(pool, 'query', 'query', true)
  const get = pool.getConnection.bind(pool)
  pool.getConnection = async () => {
    const t = performance.now(), c = await get()
    measurements.acquire.push(performance.now() - t)
    if (!c.__observed) { observe(c, 'query', 'query', true); c.__observed = true }
    return c
  }
  pool.pool.on('enqueue', () => { measurements.enqueued++ })
  setInterval(() => {
    measurements.queuePeak = Math.max(measurements.queuePeak, pool.pool._connectionQueue.length)
  }, 25).unref()
  return pool
}
setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 50).unref()
const summary = values => {
  const a = [...values].sort((a,b) => a-b)
  return { n: a.length, p50: a[Math.floor(a.length*.5)] || 0, p95: a[Math.floor(a.length*.95)] || 0, max: a.at(-1) || 0 }
}
function snapshot(id) {
  const cpu = process.cpuUsage(cpuStart)
  return { id, rssMiB: process.memoryUsage().rss/1048576, peakRssMiB: peak/1048576,
    cpuCorePercent: (cpu.user+cpu.system)/((performance.now()-started)*10),
    eventLoopP99Ms: delay.percentile(99)/1e6, eventLoopMaxMs: delay.max/1e6,
    query: summary(measurements.query), acquire: summary(measurements.acquire),
    httpArrival: summary(measurements.arrivals), firstWrite: summary(measurements.firstWrites),
    httpIngress: summary(measurements.ingress),
    enqueued: measurements.enqueued, queuePeak: measurements.queuePeak, writablePeak: measurements.writablePeak,
    backpressure: measurements.backpressure, denied, transportErrors,
    topSql: Object.entries(measurements.sql).sort((a,b)=>b[1].ms-a[1].ms).slice(0,12) }
}
process.on('message', msg => {
  if (msg.command === 'reset') reset()
  process.send?.(snapshot(msg.id))
})
// Optional private metrics for isolated remote tests; never enabled by product configuration.
let observerServer
if (process.env.CAPACITY_METRICS_PORT) {
  if (!process.env.CAPACITY_METRICS_TOKEN) throw Error('A private benchmark metrics token is required')
  observerServer = http.createServer((req, res) => {
    if (req.headers['x-capacity-token'] !== process.env.CAPACITY_METRICS_TOKEN) { res.writeHead(403);res.end();return }
    if (req.url === '/reset' && req.method === 'POST') reset()
    else if (req.url !== '/snapshot' || req.method !== 'GET') {res.writeHead(404);res.end();return}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(snapshot()))
  })
  observerServer.listen(Number(process.env.CAPACITY_METRICS_PORT),'127.0.0.1')
}

export async function closeCapacityObserver() {
  delay.disable()
  if (observerServer) {
    await new Promise(resolve => observerServer.close(resolve))
    observerServer = null
  }
}
