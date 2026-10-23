const INTERNAL_RUNTIME_PATTERNS = [
  [/xai[-_]grok(?:[-_][A-Za-z0-9]+)*/gi, 'agent-runtime'],
  [/xai-org/gi, 'runtime-upstream'],
  [/grok-build/gi, 'agent-runtime-source'],
  [/GROK_BINARY/g, 'AGENT_RUNTIME_BINARY'],
]

const WINDOWS_BUILD_WORKSPACE = /[A-Za-z]:\\Agent\\build-workers\\[^\s"'`]+/gi
const POSIX_BUILD_WORKSPACE = /\/(?:srv|opt|var|tmp)\/[^\s"'`]*build-workers?\/[^\s"'`]+/gi

export function redactPublicBuildLog(value) {
  let output = String(value || '')
    .replace(WINDOWS_BUILD_WORKSPACE, '[build-workspace]')
    .replace(POSIX_BUILD_WORKSPACE, '[build-workspace]')

  for (const [pattern, replacement] of INTERNAL_RUNTIME_PATTERNS) {
    output = output.replace(pattern, replacement)
  }
  return output
}
