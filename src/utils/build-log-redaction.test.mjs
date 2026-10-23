import assert from 'node:assert/strict'
import test from 'node:test'

import { redactPublicBuildLog } from './build-log-redaction.mjs'

test('redacts internal runtime names and Windows build workspaces', () => {
  const input = [
    'D:\\Agent\\build-workers\\agent-ai-desktop-v3-beta1\\desktop\\target\\release\\xai-grok-pager.exe',
    'crate xai_grok_runtime from xai-org/grok-build uses GROK_BINARY',
  ].join('\n')

  const output = redactPublicBuildLog(input)

  assert.equal(output.includes('xai'), false)
  assert.equal(output.includes('grok'), false)
  assert.equal(output.includes('D:\\Agent\\build-workers'), false)
  assert.match(output, /\[build-workspace\]/)
  assert.match(output, /agent-runtime/)
  assert.match(output, /AGENT_RUNTIME_BINARY/)
})

test('preserves ordinary electron-builder diagnostics', () => {
  const input = 'Invalid configuration object. electron-builder 26.15.3 exited with code 1.'
  assert.equal(redactPublicBuildLog(input), input)
})
