import net from 'node:net'

function validPort(value, label) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label}必须是 1 到 65535 之间的整数`)
  }
  return port
}

export async function isPortAvailable(port, host = '127.0.0.1') {
  return await new Promise((resolve) => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', () => resolve(false))
    probe.listen(port, host, () => probe.close(() => resolve(true)))
  })
}

export async function selectGuiPort(env = process.env, start = 47821, attempts = 20, host = '127.0.0.1') {
  if (env.AGENT_ADMIN_DEPLOYER_PORT) {
    return validPort(env.AGENT_ADMIN_DEPLOYER_PORT, 'AGENT_ADMIN_DEPLOYER_PORT')
  }

  const first = validPort(start, '起始端口')
  for (let offset = 0; offset < attempts && first + offset <= 65535; offset += 1) {
    const candidate = first + offset
    if (await isPortAvailable(candidate, host)) return candidate
  }
  throw new Error(`无法在 ${first} 到 ${Math.min(first + attempts - 1, 65535)} 之间找到空闲端口`)
}
