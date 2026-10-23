import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { MiniMaxAdapter } from '../src/services/minimax-adapter.mjs'
import { inspectVoiceAudio } from '../src/services/voice-audio.mjs'

const [mode, keyFile, sampleFile, outputDirectory] = process.argv.slice(2)
if (!['catalog', 'clone', 'preview', 'activate', 'cleanup'].includes(mode) || !keyFile || !sampleFile || !outputDirectory) throw new Error('Usage: probe-minimax-voice.mjs catalog|clone|preview|activate|cleanup key-file authorized-audio output-directory')
const context = { apiKey: (await readFile(keyFile, 'utf8')).replace(/^\uFEFF/, '').trim(), baseUrl: 'https://api.minimaxi.com', timeoutMs: 120000 }
const adapter = new MiniMaxAdapter()
const root = path.resolve(outputDirectory)
const stateFile = path.join(root, 'probe-state.json')
await mkdir(root, { recursive: true, mode: 0o700 })
try {
  if (mode === 'catalog') {
    const voices = await adapter.systemVoices(context)
    console.log(JSON.stringify({ mode, succeeded: true, systemVoiceCount: voices.length }))
  } else if (mode === 'clone') {
    // Exclusive creation prevents a rerun from accidentally repeating paid work.
    const state = { voiceId: `AgentTest${randomUUID().replaceAll('-', '')}`, model: 'speech-2.8-turbo', phase: 'prepared', fileId: '' }
    await writeFile(stateFile, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
    const bytes = await readFile(sampleFile)
    await inspectVoiceAudio(bytes, 'wav')
    state.phase = 'uploading'
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 })
    state.fileId = await adapter.upload(context, bytes, 'wav')
    state.phase = 'cloning'
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 })
    const result = await adapter.clone(context, { ...state, text: '你好，这是一段经过授权的音色测试，用于检查声音是否清晰自然。' })
    state.phase = 'preview_ready'
    state.previewUrl = result.previewUrl
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 })
    console.log(JSON.stringify({ mode, succeeded: true, previewReady: true }))
  } else if (mode === 'preview') {
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    const bytes = await adapter.previewAudio(state.previewUrl)
    await writeFile(path.join(root, 'preview.mp3'), bytes, { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({ mode, succeeded: true, audioBytes: bytes.length }))
  } else if (mode === 'activate') {
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    if (state.phase !== 'preview_ready') throw new Error('PROBE_NOT_READY_OR_ALREADY_ATTEMPTED')
    state.phase = 'activating'
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 })
    const result = await adapter.invoke(context, { model: state.model, voiceId: state.voiceId, text: '你好，音色启用测试已经完成。' })
    await writeFile(path.join(root, 'activation.mp3'), result.bytes, { mode: 0o600, flag: 'wx' })
    state.phase = 'active'
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 })
    console.log(JSON.stringify({ mode, succeeded: true, durationSec: result.durationSec, characters: result.characters }))
  } else {
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    if (state.phase === 'deleted') throw new Error('PROBE_ALREADY_CLEANED')
    if (!/^AgentTest[a-f0-9]{32}$/.test(state.voiceId)) throw new Error('PROBE_STATE_INVALID')
    await adapter.deleteVoice(context, state.voiceId)
    if (state.fileId) await adapter.deleteFile(context, state.fileId)
    state.phase = 'deleted'
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 })
    console.log(JSON.stringify({ mode, succeeded: true }))
  }
} catch (error) {
  console.log(JSON.stringify({ mode, succeeded: false, code: /^[A-Z0-9_]+$/.test(error.code || error.message) ? error.code || error.message : 'PROBE_FAILED', outcomeUnknown: error.outcomeUnknown === true }))
  process.exitCode = 1
}
