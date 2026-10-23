import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const run = promisify(execFile)

export async function inspectVoiceAudio(bytes, format, { executable = process.env.AI_FFPROBE_BIN || 'ffprobe' } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 20 * 1024 * 1024 || !['wav', 'mp3', 'm4a'].includes(format)) throw new Error('VOICE_AUDIO_INVALID')
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-voice-inspect-'))
  try {
    const file = path.join(root, `recording.${format}`)
    await writeFile(file, bytes, { mode: 0o600, flag: 'wx' })
    const { stdout } = await run(executable, ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration,format_name:stream=codec_type', '-of', 'json', file], { windowsHide: true, timeout: 15000, maxBuffer: 65536 })
    const data = JSON.parse(stdout)
    const duration = Number(data.format?.duration)
    const formats = String(data.format?.format_name || '').split(',')
    if (!Number.isFinite(duration) || duration < 10 || duration > 300 || !formats.includes(format === 'm4a' ? 'mov' : format) || !data.streams?.length || data.streams.some(stream => stream.codec_type !== 'audio')) throw new Error('VOICE_AUDIO_INVALID')
    return { duration }
  } catch (error) {
    throw Object.assign(new Error(error?.code === 'ENOENT' ? '服务器尚未配置录音校验工具' : '录音须为 10 秒至 5 分钟的 MP3、M4A 或 WAV 文件，且不超过 20 MB'), { code: 'VOICE_AUDIO_INVALID', statusCode: 400 })
  } finally { await rm(root, { recursive: true, force: true }) }
}
