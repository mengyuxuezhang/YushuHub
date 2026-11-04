export function createBuildSyncCoordinator() {
  const pending = new Map()
  function run(scope, work) {
    if (pending.has(scope)) return pending.get(scope)
    const task = Promise.resolve().then(work).finally(() => pending.delete(scope))
    pending.set(scope, task)
    return task
  }
  return { run }
}

export async function syncBeforeBuildList(mode, { background, foreground, onError = () => {} }) {
  if (mode === 'background') { void Promise.resolve().then(background).catch(onError); return }
  if (mode !== false) await foreground()
}
