import crypto from 'node:crypto'
import { canonicalAccounting } from '../../repositories/accounting.mjs'
import { failure, identifier } from './protocol.mjs'
import { createAccountingMonitor, emptyMonitorState, enqueueOperationalNotice } from './accounting-monitor.mjs'

const DAY = 86_400_000, GAP = 90_000
const digest = value => crypto.createHash('sha256').update(canonicalAccounting(value)).digest('hex')
const counts = ['unknownRequests', 'debts', 'accountingMismatches', 'activeHolds', 'pendingEvents', 'oldestHoldAgeMs', 'oldestEventAgeMs', 'canaryAgeMs', 'rejectedRequests', 'recoveryErrors']
export const emptyPilotObservation = () => ({ ...emptyMonitorState(), observation: null })
const integer = n => Number.isSafeInteger(n) && n >= 0

// Only aggregate counters are signed. Never include prompts, user IDs, cookies,
// credentials, model output or a webhook address in these reports.
export function signPilotSample(sample, privateKey) {
  const payload = Buffer.from(canonicalAccounting(sample)).toString('base64url')
  return { payload, signature: crypto.sign(null, Buffer.from(`yushu-pilot-v1\n${payload}`), privateKey).toString('base64url') }
}
function verifiedSample(envelope, source, trialId, timestamp) {
  if (!envelope || typeof envelope.payload !== 'string' || envelope.payload.length > 16_384 || typeof envelope.signature !== 'string'
    || envelope.signature.length > 128 || !crypto.verify(null, Buffer.from(`yushu-pilot-v1\n${envelope.payload}`), source.publicKey, Buffer.from(envelope.signature, 'base64url'))) throw new Error('signature')
  const value = JSON.parse(Buffer.from(envelope.payload, 'base64url'))
  if (value.trialId !== trialId || value.sourceId !== source.id || !integer(value.sequence) || value.sequence === 0 || !integer(value.observedAt)
    || value.observedAt > timestamp + 5000 || timestamp - value.observedAt > GAP || value.version !== source.version || value.codeSha256 !== source.codeSha256) throw new Error('binding')
  if (typeof value.available !== 'boolean') throw new Error('availability')
  if (value.available) {
    if (!value.metrics || counts.some(key => !integer(value.metrics[key])) || typeof value.metrics.licenseRejected !== 'boolean'
      || (source.kind === 'first' || value.metrics.licenseAgeMs !== undefined) && !integer(value.metrics.licenseAgeMs)) throw new Error('metrics')
    if (Object.keys(value.metrics).some(key => ![...counts, 'licenseRejected', 'licenseAgeMs'].includes(key))) throw new Error('unknown metric')
  } else if (value.metrics !== undefined && value.metrics !== null) throw new Error('unavailable metrics')
  if (!Array.isArray(value.canaries) || value.canaries.length > 2 || new Set(value.canaries.map(c => c.requestHash)).size !== value.canaries.length) throw new Error('canary evidence')
  for (const [index, canary] of value.canaries.entries()) {
    if (!canary || typeof canary.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(canary.requestHash) || typeof canary.amountMicros !== 'string' || !/^(?:0|[1-9]\d{0,17})$/.test(canary.amountMicros) || !integer(canary.recordedAt)
      || canary.recordedAt > value.observedAt + 5000 || index > 0 && canary.recordedAt > value.canaries[index - 1].recordedAt
      || Object.keys(canary).some(key => !['requestHash', 'amountMicros', 'recordedAt'].includes(key))) throw new Error('canary evidence')
  }
  if (value.available && value.canaries.length && Math.abs(value.metrics.canaryAgeMs - Math.max(0, value.observedAt - value.canaries[0].recordedAt)) > 5000) throw new Error('canary age')
  if (Object.keys(value).some(key => !['trialId', 'sourceId', 'sequence', 'observedAt', 'version', 'codeSha256', 'available', 'metrics', 'canaries'].includes(key))) throw new Error('unknown field')
  return value
}
function checks(sample, kind) {
  if (!sample.available) return ['SOURCE_UNAVAILABLE']
  const m = sample.metrics, bad = []
  if (!sample.canaries.length) bad.push('CANARY_UNCONFIRMED')
  for (const [key, code] of [['unknownRequests', 'UNKNOWN_REQUESTS'], ['debts', 'DEBT'], ['accountingMismatches', 'ACCOUNTING_MISMATCH'], ['recoveryErrors', 'RECOVERY_ERROR']]) if (m[key] > 0) bad.push(code)
  if (m.rejectedRequests >= 10) bad.push('OFFICIAL_REJECTION')
  if (m.oldestHoldAgeMs >= 300_000) bad.push('STALE_HOLD')
  if (m.pendingEvents >= 100 || m.oldestEventAgeMs >= 120_000) bad.push('STALE_EVENT')
  if (m.canaryAgeMs >= 600_000) bad.push('CANARY_STALE')
  if (m.licenseRejected || (kind === 'first' && m.licenseAgeMs >= 120_000)) bad.push('LICENSE_SYNC')
  return bad
}
function status(value) {
  return { trialId: value.id, phase: value.completedAt ? 'completed' : value.issues.some(issue => !issue.reviewedAt) ? 'review-required' : value.healthy ? 'observing' : 'interrupted',
    startedAt: value.startedAt, healthySince: value.healthySince, healthyMs: value.healthyMs, requiredMs: value.durationMs,
    samples: value.samples, windowSamples: value.windowSamples, interruptions: value.interruptions, checkedAt: value.checkedAt,
    completedAt: value.completedAt, unresolvedIssues: value.issues.filter(issue => !issue.reviewedAt).map(({ id, sourceId, code, at }) => ({ id, sourceId, code, at })),
    failed: value.failed, failureCounts: { ...value.failureCounts }, chain: value.chain, configurationSha256: value.fingerprint,
    sources: value.sources.map(s => ({ id: s.id, kind: s.kind, version: s.version, codeSha256: s.codeSha256, sequence: value.sourceState[s.id]?.sequence ?? null, observedAt: value.sourceState[s.id]?.observedAt ?? null })) }
}
export function createPilotObservation({ store, vault, now = Date.now, fetchImpl = fetch }) {
  const delivery = createAccountingMonitor({ store, vault, now, fetchImpl, book: 'pilot-observation', collect: async () => ({}) })
  return {
    configure: delivery.configure, drain: delivery.drain,
    async begin(input, actor) {
      identifier(input.id); identifier(actor)
      if (!Array.isArray(input.sources) || input.sources.length !== 2 || new Set(input.sources.map(s => s.id)).size !== input.sources.length
        || input.durationMs !== undefined && (!integer(input.durationMs) || input.durationMs < 7 * DAY || input.durationMs > 30 * DAY)) throw failure('INVALID_PILOT', '需一套一级及官方供货采集源、不少于7天的连续观察', 400)
      const sources = input.sources.map(source => {
        identifier(source.id)
        if (!['first', 'official'].includes(source.kind) || typeof source.version !== 'string' || source.version.length > 80 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/.test(source.version)
          || !/^[a-f0-9]{64}$/.test(source.codeSha256) || typeof source.publicKey !== 'string' || source.publicKey.length > 4096
          || crypto.createPublicKey(source.publicKey).asymmetricKeyType !== 'ed25519') throw failure('INVALID_PILOT', '采集源的版本、代码摘要及签名公钥无效', 400)
        return { id: source.id, kind: source.kind, version: source.version, codeSha256: source.codeSha256, publicKey: source.publicKey }
      })
      if (!sources.some(s => s.kind === 'first') || !sources.some(s => s.kind === 'official')) throw failure('INVALID_PILOT', '必须同时观察一级和官方供货', 400)
      const config = { id: input.id, durationMs: input.durationMs ?? 7 * DAY, sources }, fingerprint = digest(config)
      return store.transaction(state => {
        if (state.observation) {
          if (state.observation.fingerprint !== fingerprint) throw failure('PILOT_ALREADY_STARTED', '不能覆盖已有试点或静默更换采集源', 409)
          return status(state.observation)
        }
        const timestamp = now()
        state.observation = { ...config, fingerprint, actor, startedAt: timestamp, checkedAt: null, healthySince: null, healthyMs: 0, samples: 0, windowSamples: 0,
          interruptions: 0, healthy: false, failed: [], issues: [], sourceState: {}, history: [], failureCounts: {}, completedAt: null, generation: 0, chain: digest(config) }
        return status(state.observation)
      })
    },
    async tick(envelopes) {
      return store.transaction(state => {
        const p = state.observation, timestamp = now()
        if (!p) throw failure('PILOT_NOT_STARTED', '试点未初始化', 409)
        if (p.completedAt) return status(p)
        if (!integer(timestamp)) throw failure('PILOT_CLOCK_INVALID', '观察时钟无效', 409)
        if (p.checkedAt !== null && timestamp < p.checkedAt) {
          if (!p.failed.includes('CLOCK_REVERSED')) {
            p.interruptions++; p.generation++
            enqueueOperationalNotice(state, { id: digest([p.id, p.generation]), kind: 'firing', text: `【TEST试点中断】试点=${p.id}；观察时钟倒退，连续计时已清零，须校时。` }, timestamp)
          }
          p.healthy = false; p.pairHealthy = false; p.healthySince = null; p.healthyMs = 0; p.windowSamples = 0; p.failed = ['CLOCK_REVERSED']; p.samples++
          p.failureCounts.CLOCK_REVERSED = Math.min(Number.MAX_SAFE_INTEGER, (p.failureCounts.CLOCK_REVERSED || 0) + 1)
          p.chain = digest([p.chain, timestamp, 'CLOCK_REVERSED'])
          p.history = [...p.history.slice(-10080), { at: p.checkedAt, receivedClock: timestamp, healthy: false, failureCount: 1, failedHash: digest(p.failed), chain: p.chain }]
          return status(p)
        }
        const failed = [], sampleKeys = [], validated = new Map(), oldIssueCount = p.issues.length; let quiescent = true
        for (const source of p.sources) {
          let sample, key, bad
          const previous = p.sourceState[source.id]
          try {
            sample = verifiedSample(envelopes?.[source.id], source, p.id, timestamp); key = digest(sample)
            if (previous && (sample.sequence < previous.sequence || sample.sequence === previous.sequence && key !== previous.key)) throw new Error('replay')
            bad = checks(sample, source.kind)
          } catch { failed.push(`${source.id}:REPORT_REJECTED`); continue }
          sampleKeys.push([source.id, sample.sequence, key])
          validated.set(source.id, sample)
          if (sample.canaries.some(canary => previous?.canaries?.some(old => old.requestHash === canary.requestHash && (old.amountMicros !== canary.amountMicros || old.recordedAt !== canary.recordedAt)))) bad.push('ACCOUNTING_MISMATCH')
          const financial = bad.includes('ACCOUNTING_MISMATCH')
          quiescent &&= sample.available && sample.metrics.activeHolds === 0 && sample.metrics.pendingEvents === 0
          if (financial && !previous?.financial) {
            if (p.issues.length >= 1000) throw failure('PILOT_ISSUE_LIMIT', '试点差异记录已满，须人工处理', 409)
            p.issues.push({ id: digest([p.id, source.id, sample.sequence]), sourceId: source.id, code: 'ACCOUNTING_MISMATCH', at: timestamp })
          }
          p.sourceState[source.id] = { sequence: sample.sequence, key, financial, healthy: bad.length === 0, observedAt: sample.observedAt, canaries: sample.canaries }
          failed.push(...bad.map(code => `${source.id}:${code}`))
        }
        const firstId = p.sources.find(s => s.kind === 'first').id, officialId = p.sources.find(s => s.kind === 'official').id
        const first = validated.get(firstId), official = validated.get(officialId)
        let latestMatched = false, crossMismatch = false
        if (first?.available && official?.available) {
          const common = first.canaries.flatMap(a => official.canaries.filter(b => b.requestHash === a.requestHash).map(b => ({ a, b })))
          crossMismatch = common.some(({ a, b }) => a.amountMicros !== b.amountMicros)
          if (crossMismatch) {
            failed.push('CANARY_AMOUNT_MISMATCH')
            if (!p.crossMismatch) {
              if (p.issues.length >= 1000) throw failure('PILOT_ISSUE_LIMIT', '试点差异记录已满，须人工处理', 409)
              p.issues.push({ id: digest([p.id, 'canary', first.sequence, official.sequence]), sourceId: firstId, code: 'CANARY_AMOUNT_MISMATCH', at: timestamp })
            }
          } else if (!common.some(({ a, b }) => timestamp - Math.min(a.recordedAt, b.recordedAt) < 600_000)) failed.push('CANARY_CHAIN_UNCONFIRMED')
          latestMatched = Boolean(first.canaries[0] && first.canaries[0].requestHash === official.canaries[0]?.requestHash)
        }
        p.crossMismatch = crossMismatch; p.pairHealthy = failed.length === 0
        const bundle = digest(sampleKeys)
        // An identical report at the same instant is an idempotent retry.
        if (timestamp === p.checkedAt && bundle === p.lastBundle && !failed.length) return status(p)
        const gap = p.checkedAt !== null && timestamp - p.checkedAt > GAP
        if (gap) failed.push('OBSERVATION_GAP')
        if (p.issues.some(issue => !issue.reviewedAt)) failed.push('FINANCIAL_REVIEW_REQUIRED')
        const healthy = failed.length === 0
        if (!healthy) { if (p.healthy || gap) p.interruptions++; p.healthySince = null; p.healthyMs = 0; p.windowSamples = 0 }
        else if (!p.healthy || p.healthySince === null) { p.healthySince = timestamp; p.healthyMs = 0; p.windowSamples = 1 }
        else { p.healthyMs += timestamp - p.checkedAt; p.windowSamples++ }
        p.samples++; p.checkedAt = timestamp; p.lastBundle = bundle; p.chain = digest([p.chain, timestamp, bundle, failed])
        for (const code of failed) p.failureCounts[code] = Math.min(Number.MAX_SAFE_INTEGER, (p.failureCounts[code] || 0) + 1)
        p.history = [...p.history.slice(-10080), { at: timestamp, healthy, failureCount: failed.length, failedHash: digest(failed), chain: p.chain }]
        if (healthy && quiescent && latestMatched && p.healthyMs >= p.durationMs && p.windowSamples >= Math.ceil(p.durationMs / 60_000) + 1) p.completedAt = timestamp
        if (healthy !== p.healthy || p.samples === 1 || p.completedAt || digest(failed) !== digest(p.failed) || p.issues.length > oldIssueCount) {
          p.generation++
          enqueueOperationalNotice(state, { id: digest([p.id, p.generation]), kind: p.completedAt ? 'completed' : healthy ? 'resolved' : 'firing',
            text: `【TEST试点${p.completedAt ? '连续观察完成' : healthy ? '开始/恢复计时' : '中断'}】试点=${p.id}；失败项=${failed.join(',') || '无'}；未核对资金差异=${p.issues.filter(i => !i.reviewedAt).length}；此结果不批准生产切换。` }, timestamp)
        }
        p.healthy = healthy; p.failed = failed
        return status(p)
      })
    },
    async review(issueId, evidenceId, actor) {
      identifier(evidenceId); identifier(actor)
      return store.transaction(state => {
        const p = state.observation, issue = p?.issues.find(i => i.id === issueId)
        if (!issue) throw failure('PILOT_ISSUE_NOT_FOUND', '资金差异记录不存在', 404)
        if (issue.reviewedAt) {
          if (issue.evidenceId !== evidenceId || issue.actor !== actor) throw failure('IDEMPOTENCY_CONFLICT', '不能覆盖已有核对依据', 409)
          return status(p)
        }
        const source = p.sourceState[issue.sourceId]
        const timestamp = now(), fresh = p.sources.every(s => {
          const observedAt = p.sourceState[s.id]?.observedAt
          return integer(observedAt) && observedAt <= timestamp + 5000 && timestamp - observedAt <= GAP
        })
        if (!p.pairHealthy || !fresh || !source?.healthy || source.financial || p.failed.includes(`${issue.sourceId}:REPORT_REJECTED`)) throw failure('PILOT_ISSUE_STILL_ACTIVE', '需先取得两侧新鲜正常签名报告及一致的原调用凭据', 409)
        Object.assign(issue, { reviewedAt: now(), evidenceId, actor }); p.healthy = false; p.healthySince = null; p.healthyMs = 0; p.windowSamples = 0
        return status(p)
      })
    },
    async state() { const state = await store.read(); return { observation: state.observation ? status(state.observation) : null, delivery: await delivery.state() } },
  }
}
