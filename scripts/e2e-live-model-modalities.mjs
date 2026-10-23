import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import mysql from 'mysql2/promise'

import { loadLocalEnv, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from '../src/config/env.mjs'
import { MODEL_CREDENTIAL_KEY_PATH, VOICE_ARTIFACT_ROOT } from '../src/config/paths.mjs'
import { ModelCredentialVault } from '../src/services/model-credentials.mjs'
import { hashPassword } from '../src/utils/crypto.mjs'

loadLocalEnv()

const baseUrl = String(process.env.ADMIN_BASE_URL || 'http://127.0.0.1:7079').replace(/\/$/, '')
const modelIds = {
  text: process.env.E2E_TEXT_MODEL_ID || 'deepseek-deepseek-v4-flash-vision-exp',
  image: process.env.E2E_IMAGE_MODEL_ID || 'system-model-seedream-pro',
  audio: process.env.E2E_AUDIO_MODEL_ID || 'p252-minimax-speech-supplier2',
}
const skipTextImage = process.env.E2E_SKIP_TEXT_IMAGE === '1'
const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`
const userId = randomUUID()
const username = `modal-e2e-${stamp}`.slice(0, 48)
const password = `Model-${randomBytes(18).toString('base64url')}!`
const deviceId = `modal-e2e-${stamp}`
const voiceOperationIds = []
let pool
let token = ''

async function request(pathname, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let value
  try { value = text ? JSON.parse(text) : null } catch { value = text }
  if (!response.ok || value?.success === false) {
    const detail = String(value?.error?.message || value?.error || value?.code || text || response.statusText).slice(0, 500)
    throw new Error(`${method} ${pathname} failed (${response.status}): ${detail}`)
  }
  return value
}

const auth = () => ({ authorization: `Bearer ${token}` })

async function retryExplicitOverload(work, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await work() } catch (error) {
      lastError = error
      if (!/failed \(502\):.*(?:overload|unable to handle additional requests)/i.test(String(error?.message)) || attempt === attempts) throw error
      await new Promise(resolve => setTimeout(resolve, attempt * 2000))
    }
  }
  throw lastError
}

async function cleanup() {
  for (const id of voiceOperationIds) await rm(path.join(VOICE_ARTIFACT_ROOT, `${id}.mp3`), { force: true }).catch(() => {})
  if (!pool) return
  for (const table of ['ai_voice_operations', 'ai_model_operations', 'ai_end_user_sessions', 'ai_end_user_events', 'ai_end_user_model_access', 'ai_credit_ledger']) {
    await pool.query(`DELETE FROM ${table} WHERE user_id=?`, [userId]).catch(() => {})
  }
  await pool.query('DELETE FROM ai_end_users WHERE id=?', [userId]).catch(() => {})
}

try {
  pool = await mysql.createPool({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME, charset: 'utf8mb4', connectionLimit: 2 })
  const [models] = await pool.query(`SELECT m.id,m.model_id,m.model_type,m.organization_id,k.owner_user_id
    FROM ai_provider_models m JOIN ai_model_providers p ON p.id=m.provider_id AND p.status='enabled'
    JOIN ai_model_provider_keys k ON k.provider_id=p.id AND k.status='enabled'
    WHERE m.id IN (?,?,?) AND m.status='enabled' GROUP BY m.id,m.model_id,m.model_type,m.organization_id,k.owner_user_id`,
  [modelIds.text, modelIds.image, modelIds.audio])
  assert.equal(models.length, 3, 'one or more funded model configurations are unavailable')
  const organizations = new Set(models.map(item => item.organization_id))
  assert.equal(organizations.size, 1, 'test models must belong to the same organization')
  const context = models.find(item => item.id === modelIds.text)
  assert(context?.owner_user_id, 'model owner is unavailable')
  const textModel = models.find(item => item.id === modelIds.text)
  const imageModel = models.find(item => item.id === modelIds.image)
  assert(textModel && imageModel, 'text or image model context is unavailable')

  if (process.env.E2E_AUDIO_KEY_FILE) {
    const plaintext = (await readFile(process.env.E2E_AUDIO_KEY_FILE, 'utf8')).trim()
    const [keys] = await pool.query(`SELECT k.id,k.upstream_account_id,k.key_preview FROM ai_model_provider_keys k
      JOIN ai_provider_models m ON m.provider_id=k.provider_id
      WHERE m.id=? AND k.status='enabled' AND k.secret_ciphertext IS NOT NULL`, [modelIds.audio])
    assert.equal(keys.length, 1, 'audio model must have exactly one encrypted credential')
    assert(plaintext.length >= 8 && plaintext.endsWith(String(keys[0].key_preview).slice(-4)), 'authorized audio Key does not match the configured credential preview')
    const ciphertext = await new ModelCredentialVault(MODEL_CREDENTIAL_KEY_PATH).seal(plaintext, keys[0].upstream_account_id)
    await pool.query('UPDATE ai_model_provider_keys SET secret_ciphertext=? WHERE id=?', [ciphertext, keys[0].id])
  }

  await pool.query(`INSERT INTO ai_end_users
    (id,username,email,display_name,password_hash,status,source_agent_id,app_version,device_id,device_name,credit_balance,organization_id)
    VALUES (?,?,?,?,?,'enabled',?,'3.0.10',?,'三模态真实联调',10000,?)`,
  [userId, username, `${username}@example.invalid`, '三模态真实联调', hashPassword(password), context.owner_user_id, deviceId, context.organization_id])
  await pool.query('INSERT INTO ai_end_user_model_access (user_id,provider_model_id) VALUES (?,?),(?,?),(?,?)',
    [userId, modelIds.text, userId, modelIds.image, userId, modelIds.audio])

  const login = await request('/api/client/auth/login', { method: 'POST', body: { username, password, deviceId, deviceName: '三模态真实联调', appVersion: '3.0.10' } })
  token = String(login?.data?.token || '')
  assert(token, 'client login did not return a token')
  const before = Number((await request('/api/client/credits/me', { headers: auth() }))?.data?.creditBalance)

  const catalog = await request('/api/client/model/models', { headers: auth() })
  const clientModels = Array.isArray(catalog?.data) ? catalog.data : catalog?.data?.models || []
  for (const row of models) assert(clientModels.some(item => item.id === row.model_id || item.id === row.id), `${row.model_type} model is absent from the Desktop catalog`)

  let text = null, textContent = '', image = null, imageBytes = Buffer.alloc(0)
  if (!skipTextImage) {
    text = await request('/api/client/model/v1/chat/completions', { method: 'POST', headers: auth(), body: {
      model: textModel.model_id, stream: false, max_tokens: 256, messages: [{ role: 'user', content: '只回复：三模态联调成功' }],
    } })
    textContent = String(text?.choices?.[0]?.message?.content || '')
    assert(textContent.trim(), 'text model returned no assistant content')

    image = await retryExplicitOverload(() => request('/api/client/images/generate', { method: 'POST', headers: auth(), body: {
      model: imageModel.model_id, prompt: '极简白色背景上的一枚蓝色圆形图标，柔和棚拍光线，不含文字', size: '1K', outputFormat: 'jpeg', watermark: false,
    } }))
    const imageUrl = String(image?.data?.images?.[0]?.url || '')
    assert(imageUrl, 'image model returned no image URL')
    const imageResponse = await fetch(imageUrl)
    assert(imageResponse.ok, `generated image download failed (${imageResponse.status})`)
    imageBytes = Buffer.from(await imageResponse.arrayBuffer())
    assert(imageBytes.length > 128, 'generated image is empty')
  }

  const voices = await request('/api/client/voices', { headers: auth() })
  const audioModel = voices?.data?.models?.find(item => item.id === modelIds.audio)
  const systemVoice = voices?.data?.voices?.find(item => item.modelId === modelIds.audio && item.category === 'system' && item.status === 'enabled')
  assert(audioModel && systemVoice, 'MiniMax model or system voice is unavailable to Desktop')
  const synthesis = await request('/api/client/voices/synthesize', { method: 'POST', headers: auth(), body: {
    modelId: modelIds.audio, voiceId: systemVoice.id, text: '你好，文本、图片和语音模型联调成功。', speed: 1, idempotencyKey: randomUUID(),
  } })
  assert.equal(synthesis?.data?.status, 'succeeded', `voice synthesis failed: ${synthesis?.data?.errorCode || 'unknown'}`)
  voiceOperationIds.push(synthesis.data.id)
  const audioResponse = await fetch(`${baseUrl}/api/client/voices/tasks/${synthesis.data.id}/audio`, { headers: auth() })
  assert(audioResponse.ok, `voice artifact download failed (${audioResponse.status})`)
  const audioBytes = Buffer.from(await audioResponse.arrayBuffer())
  assert(audioBytes.length > 128, 'voice artifact is empty')

  const after = Number((await request('/api/client/credits/me', { headers: auth() }))?.data?.creditBalance)
  console.log(JSON.stringify({
    success: true,
    catalog: { text: true, image: true, audio: true },
    text: skipTextImage ? { skipped: true } : { model: modelIds.text, responseCharacters: [...textContent].length, usage: text?.usage || null },
    image: skipTextImage ? { skipped: true } : { model: modelIds.image, images: image.data.images.length, bytes: imageBytes.length, sha256: createHash('sha256').update(imageBytes).digest('hex') },
    audio: { model: modelIds.audio, systemVoices: voices.data.voices.filter(item => item.modelId === modelIds.audio && item.category === 'system').length, bytes: audioBytes.length, sha256: createHash('sha256').update(audioBytes).digest('hex'), settledPoints: synthesis.data.settledPoints },
    credits: { before, after, charged: Math.round((before - after) * 1_000_000) / 1_000_000 },
  }))
} finally {
  await cleanup()
  await pool?.end().catch(() => {})
}
