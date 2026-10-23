import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const base = new URL(process.env.VOICE_E2E_BASE_URL || 'http://127.0.0.1:18082/')
const adminUsername = process.env.VOICE_E2E_ADMIN_USER || ''
const adminPassword = process.env.VOICE_E2E_ADMIN_PASSWORD || ''
const key = (await readFile(process.env.VOICE_E2E_KEY_FILE || '', 'utf8')).trim()
const audioFile = process.env.VOICE_E2E_AUDIO_FILE || ''
if (!adminUsername || !adminPassword || key.length < 8 || !audioFile) throw new Error('VOICE_E2E_CONFIGURATION_REQUIRED')

async function call(route, { body, cookie, token, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(new URL(route, base), { method, headers: { accept: 'application/json', ...(body === undefined || body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }), redirect: 'manual' })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.success) throw new Error(`${route}: ${response.status} ${payload?.error || payload?.code || 'invalid response'}`)
  return { data: payload.data, response }
}
async function expectDenied(route, { body, token, status = 404 } = {}) {
  const response = await fetch(new URL(route, base), { method: body === undefined ? 'GET' : 'POST', headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  if (response.status !== status) throw new Error(`${route}: expected ${status}, received ${response.status}`)
}

const login = await call('api/login', { body: { username: adminUsername, password: adminPassword } })
const cookie = String(login.response.headers.get('set-cookie') || '').split(';')[0]
if (!cookie) throw new Error('ADMIN_COOKIE_MISSING')

const providerId = 'minimax-voice-e2e'
const modelId = 'minimax-speech-e2e'
await call('api/model-providers', { cookie, body: { id: providerId, name: 'MiniMax 语音 E2E', protocol: 'openai-compatible', baseUrl: 'https://api.minimaxi.com', timeoutMs: 120000, status: 'enabled', notes: '隔离联调数据' } })
await call('api/provider-models', { cookie, body: { id: modelId, providerId, modelId: 'speech-2.8-turbo', displayName: 'MiniMax Speech 2.8 Turbo E2E', modelType: 'audio', endpointPath: '/v1/t2a_v2', status: 'enabled', capabilities: ['audio'] } })
await call('api/model-pricing-rules', { cookie, body: { id: 'minimax-voice-price-e2e', providerModelId: modelId, billingType: 'per_request', pointsPerRequest: 0, costPointsPerRequest: 0, consumptionMultiplier: 1, status: 'enabled' } })

let configuration = (await call('api/voice-configuration', { cookie })).data
let account = configuration.accounts.find(item => item.providerId === providerId)
if (!account) account = { id: (await call('api/voice-configuration/accounts', { cookie, body: { providerId, name: 'MiniMax 固定测试账号' } })).data.id, keyCount: 0 }
if (!Number(account.keyCount)) await call(`api/voice-configuration/accounts/${account.id}/keys`, { cookie, body: { key, confirmSameAccount: true } })
await call('api/voice-configuration/models', { cookie, body: { modelId, adapter: 'minimax.t2a', previewPoints: 1, activationPoints: 1, synthesisPoints: 1, enabled: true } })

const suffix = randomUUID().slice(0, 8)
const username = `voice-e2e-${suffix}`
const endPassword = `Voice-${randomUUID()}!`
const endUser = (await call('api/end-users', { cookie, body: { username, email: `${username}@example.test`, displayName: '语音联调用户', password: endPassword, status: 'enabled' } })).data
if (process.env.VOICE_E2E_DESKTOP_CREDENTIAL_FILE) await writeFile(process.env.VOICE_E2E_DESKTOP_CREDENTIAL_FILE, `${JSON.stringify({ username, password: endPassword })}\n`, { mode: 0o600 })
await call(`api/end-users/${endUser.id}/credits`, { cookie, body: { amount: 100, note: 'MiniMax 私有音色 E2E' } })
await call(`api/end-users/${endUser.id}/model-access`, { cookie, body: { modelIds: [modelId] } })
const session = (await call('api/client/auth/login', { body: { username, password: endPassword, deviceId: `voice-e2e-${suffix}` } })).data
const token = session.token

const audio = await readFile(audioFile)
const trainingKey = randomUUID()
const trainingForm = () => { const train = new FormData(); train.set('modelId', modelId); train.set('name', `联调音色 ${suffix}`); train.set('text', '你好，这是一段经过授权的音色联调试听。'); train.set('consent', 'true'); train.set('confirmedPoints', '1'); train.set('idempotencyKey', trainingKey); train.set('audio', new Blob([audio]), audioFile.toLowerCase().endsWith('.m4a') ? 'recording.m4a' : audioFile.toLowerCase().endsWith('.mp3') ? 'recording.mp3' : 'recording.wav'); return train }
const training = (await call('api/client/voices/train', { token, body: trainingForm() })).data
if (training.status !== 'succeeded') throw new Error(`training status ${training.status}`)
const repeatedTraining = (await call('api/client/voices/train', { token, body: trainingForm() })).data
if (repeatedTraining.id !== training.id) throw new Error('idempotent training returned a different task')

const attackerName = `voice-e2e-attacker-${suffix}`
const attackerPassword = `Voice-${randomUUID()}!`
await call('api/end-users', { cookie, body: { username: attackerName, email: `${attackerName}@example.test`, displayName: '音色隔离联调用户', password: attackerPassword, status: 'enabled' } })
const attacker = (await call('api/client/auth/login', { body: { username: attackerName, password: attackerPassword, deviceId: `voice-e2e-attacker-${suffix}` } })).data
await expectDenied(`api/client/voices/${training.voiceId}/preview`, { token: attacker.token })
await expectDenied('api/client/voices/delete', { token: attacker.token, body: { voiceId: training.voiceId, idempotencyKey: randomUUID() } })
await expectDenied('api/client/voices/synthesize', { token: attacker.token, body: { modelId, voiceId: training.voiceId, text: '越权测试', speed: 1, idempotencyKey: randomUUID() } })
const previewResponse = await fetch(new URL(`api/client/voices/${training.voiceId}/preview`, base), { headers: { authorization: `Bearer ${token}` } })
const preview = new Uint8Array(await previewResponse.arrayBuffer())
if (!previewResponse.ok || preview.length < 128) throw new Error('preview unavailable')
const activation = (await call('api/client/voices/activate', { token, body: { voiceId: training.voiceId, confirmedPoints: 1, idempotencyKey: randomUUID() } })).data
if (activation.status !== 'succeeded') throw new Error(`activation status ${activation.status}`)
const synthesis = (await call('api/client/voices/synthesize', { token, body: { modelId, voiceId: training.voiceId, text: '你好，统一模型管理和私有音色联调已经完成。', speed: 1, idempotencyKey: randomUUID() } })).data
if (synthesis.status !== 'succeeded') throw new Error(`synthesis status ${synthesis.status}`)
const audioResponse = await fetch(new URL(`api/client/voices/tasks/${synthesis.id}/audio`, base), { headers: { authorization: `Bearer ${token}` } })
const output = new Uint8Array(await audioResponse.arrayBuffer())
if (!audioResponse.ok || output.length < 128) throw new Error('synthesis audio unavailable')
if (process.env.VOICE_E2E_OUTPUT_FILE) await writeFile(process.env.VOICE_E2E_OUTPUT_FILE, output, { mode: 0o600 })
const deletion = (await call('api/client/voices/delete', { token, body: { voiceId: training.voiceId, idempotencyKey: randomUUID() } })).data
if (deletion.status !== 'succeeded') throw new Error(`deletion status ${deletion.status}`)
process.stdout.write(`${JSON.stringify({ success: true, userId: endUser.id, voiceId: training.voiceId, idempotencyVerified: true, isolationVerified: true, previewBytes: preview.length, outputBytes: output.length, outputSha256: createHash('sha256').update(output).digest('hex'), deleted: true })}\n`)
