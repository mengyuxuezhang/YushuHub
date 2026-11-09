// Fictional loopback-only protocol fixture; never production center policy.
export function fixtureDeploymentClaims(now = Date.now()) {
  return { aud: 'deployment', id: 'fixture-native-license', businessId: 'fixture-native-license',
    name: 'Native fixture', instanceId: 'fixture-stable-instance', level: 1, hierarchy: 'single',
    domain: 'https://127.0.0.1:17444', modelMode: 'custom', version: 1,
    iat: now, exp: now + 86_400_000, expiresAt: new Date(now + 86_400_000).toISOString(),
    capabilities: ['users.manage', 'end_users.manage', 'platform_settings.manage', 'projects.manage',
      'model_providers.manage', 'model_keys.manage', 'memberships.manage', 'credits.manage']
      .map(key => ({ key, enabled: true })),
    quotas: { projects: { mode: 'limited', value: 10 }, builds: { mode: 'limited', value: 100 } } }
}
