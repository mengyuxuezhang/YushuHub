import { migrationHash } from '../legacy-import.mjs'

// Fictional deployment only. Never put real source snapshots in this fixture.
export function legacySnapshotFixture(pkg, now) {
  return { batchId: 'legacy-batch', snapshot: { schemaVersion: 1, sourceId: 'legacy-deployment', capturedAt: now,
    organizations: [{ id: 'old-local-root', legacySupplierId: 'imported-first', name: '虚构历史一级', agentLevel: 1, allowCustomApiProviders: false, status: 'enabled', expiresAt: null,
      instanceId: 'legacy-instance', domain: 'https://legacy.example.com', usage: { projects: 1, builds: 2 } }],
    capabilities: [...pkg.capabilities.map(cap => ({ ...cap, organizationId: 'old-local-root', limitValue: cap.key === 'projects.manage' ? 1 : cap.key === 'builds.create' ? 10 : 0 })),
      { organizationId: 'old-local-root', key: 'organizations.capabilities.manage', enabled: true, limitValue: 0 }],
    projects: [{ id: 'old-project', organizationId: 'old-local-root' }], builds: [{ id: 'old-build', organizationId: 'old-local-root' }],
    proofs: Object.fromEntries(['users', 'balances', 'memberships', 'orders', 'ledger', 'modelAccess', 'modelPrices', 'projects', 'builds'].map(group => [group, { count: ['projects', 'builds'].includes(group) ? 1 : 0, hash: migrationHash([]) }])) },
    mapping: { oldOrganizationId: 'old-local-root', grantId: 'imported-first', packageId: 'first-fixed', packageVersion: 1, domain: 'https://legacy.example.com', instanceId: 'legacy-instance', officialModelIds: [], unlimitedExpiryReview: '历史无限期已核对' } }
}
