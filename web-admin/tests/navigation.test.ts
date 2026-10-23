import { canAccessNavigationItem, moduleNavigationItems } from '@/router/navigation'

describe('permission-aware navigation', () => {
  it('contains every planned migration module with explicit phase metadata', () => {
    expect(moduleNavigationItems.length).toBeGreaterThanOrEqual(18)
    expect(moduleNavigationItems.every((item) => item.phase)).toBe(true)
  })

  it('shows a protected module when its permission is granted', () => {
    const projects = moduleNavigationItems.find((item) => item.path === '/projects')
    expect(projects).toBeTruthy()
    expect(canAccessNavigationItem(projects!, (permission) => permission === 'projects.manage')).toBe(true)
    expect(canAccessNavigationItem(projects!, () => false)).toBe(false)
  })

  it('does not expose the retired enterprise module', () => {
    expect(moduleNavigationItems.find((item) => item.path === '/enterprise')).toBeUndefined()
    expect(moduleNavigationItems.flatMap((item) => item.permissions)).not.toContain('enterprise_usage.view')
  })

  it('shows supplier access only at the official center', () => {
    const suppliers = moduleNavigationItems.find((item) => item.path === '/center-suppliers')
    expect(suppliers?.officialCenterOnly).toBe(true)
    expect(canAccessNavigationItem(suppliers!, () => true, 0)).toBe(true)
    expect(canAccessNavigationItem(suppliers!, () => true, 1)).toBe(false)
    expect(canAccessNavigationItem(suppliers!, () => true, 2)).toBe(false)
  })

  it('keeps resource accounts and technical capabilities out of navigation', () => {
    expect(moduleNavigationItems.some((item) => item.path === '/models/accounts')).toBe(false)
    expect(moduleNavigationItems.some((item) => item.path === '/models/capabilities')).toBe(false)
    expect(moduleNavigationItems.filter((item) => item.path.startsWith('/billing/')).map((item) => item.path)).toEqual([
      '/billing/text', '/billing/image', '/billing/audio', '/billing/video', '/billing/vector',
    ])
    expect(moduleNavigationItems.filter((item) => ['/billing/video', '/billing/vector'].includes(item.path)).every((item) => item.subtitle === '功能开发中')).toBe(true)
    expect(moduleNavigationItems.some((item) => item.path === '/models/pricing')).toBe(false)
  })
})
