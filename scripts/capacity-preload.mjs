// Isolated benchmark only: observation and loopback-only egress. No business substitutions.
import mysql from 'mysql2/promise'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import http from 'node:http'
import https from 'node:https'
const nativeFetch = globalThis.fetch
let denied = 0
function allowed(value) {
  const u = new URL(String(value?.url || value))
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    denied++; throw new Error('CAPACITY_EGRESS_DENIED: ' + u.hostname)
  }
}
globalThis.fetch = (url, options) => { allowed(url); return nativeFetch(url, options) }
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
  measurements = { query: [], acquire: [], sql: {}, enqueued: 0, queuePeak: 0, writablePeak: 0, backpressure: 0 }
  peak = process.memoryUsage().rss; cpuStart = process.cpuUsage(); started = performance.now(); delay.reset()
}
reset()
const responseWrite = http.ServerResponse.prototype.write
http.ServerResponse.prototype.write = function (...args) {
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
process.on('message', msg => {
  if (msg.command === 'reset') reset()
  const cpu = process.cpuUsage(cpuStart)
  process.send?.({ id: msg.id, rssMiB: process.memoryUsage().rss/1048576, peakRssMiB: peak/1048576,
    cpuCorePercent: (cpu.user+cpu.system)/((performance.now()-started)*10),
    eventLoopP99Ms: delay.percentile(99)/1e6, eventLoopMaxMs: delay.max/1e6,
    query: summary(measurements.query), acquire: summary(measurements.acquire),
    enqueued: measurements.enqueued, queuePeak: measurements.queuePeak, writablePeak: measurements.writablePeak,
    backpressure: measurements.backpressure, denied,
    topSql: Object.entries(measurements.sql).sort((a,b)=>b[1].ms-a[1].ms).slice(0,12) })
})
