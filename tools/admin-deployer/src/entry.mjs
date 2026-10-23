if (process.env.AGENT_ADMIN_DEPLOYER_INTERNAL_CLI === '1') {
  await import('./cli.mjs')
} else {
  await import('./gui.mjs')
}
