import path from 'node:path'
import { supplyVoiceRepository } from '../../repositories/supply-voices.mjs'
import { supplyVoiceArtifacts } from '../../repositories/supply-voice-artifacts.mjs'

// Opt-in storage. Schema changes remain the explicit migration command's job.
export function privateVoiceStorage({ pool, book, directory, retentionDays = 30, inspectAudio, bindingGuard, now = Date.now }) {
  if (!directory) return null
  if (!path.isAbsolute(directory)) throw new Error('Private voice storage requires an absolute controlled directory')
  const voices = supplyVoiceRepository({ pool, book, directory: path.join(directory, 'recordings'), inspectAudio, bindingGuard, now })
  const artifacts = supplyVoiceArtifacts({ pool, voices, book, directory: path.join(directory, 'audio'), retentionMs: Number(retentionDays) * 86_400_000, now })
  let cleaning = false
  return { voices, artifacts, book,
    assertReady: () => voices.assertReady(),
    async clean() {
      if (cleaning) return
      cleaning = true
      try { await voices.pruneExpiredUploads(); await voices.pruneSafeSources(); await artifacts.pruneExpired() }
      finally { cleaning = false }
    },
  }
}
