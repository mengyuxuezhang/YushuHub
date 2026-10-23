import { completed, pending } from './registry.mjs'
import { usageEvent } from '../compound-pricing.mjs'

export class MockVideoJobAdapter {
  id = 'mock.video_jobs'
  supports(taskType) { return taskType === 'video_generation' }
  async submit(_context, request, capability) {
    return pending({ adapterId: this.id, configRevision: Number(capability.configRevision || 1), remoteId: `mock-${Date.now()}`, pollState: {
      polls: 0, seconds: Math.max(1, Math.min(60, Number(request.seconds || 5))), resolution: String(request.resolution || '720p'),
    } })
  }
  async poll(_context, job) {
    if (Number(job.pollState?.polls || 0) < 1) return pending({ ...job, pollState: { ...job.pollState, polls: Number(job.pollState?.polls || 0) + 1 } })
    return completed({ assets: [{ kind: 'video', mimeType: 'video/mp4', mock: true }] }, [
      usageEvent('video_seconds', Number(job.pollState.seconds || 5), { dimensions: { resolution: String(job.pollState.resolution || '720p') } }),
    ])
  }
}

export class MockEmbeddingAdapter {
  id = 'mock.embeddings'
  supports(taskType) { return taskType === 'embedding' }
  async submit(_context, request) {
    const inputs = Array.isArray(request.inputs) ? request.inputs.map(String) : []
    const tokens = inputs.reduce((total, value) => total + Math.max(1, Math.ceil([...value].length / 4)), 0)
    return completed({ embeddings: inputs.map((_, index) => [index, 0, 1]) }, [usageEvent('input_tokens', tokens), usageEvent('vector_inputs', inputs.length)])
  }
}
