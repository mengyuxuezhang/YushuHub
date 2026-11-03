import { router } from '@/router'
import { navigationSections } from '@/router/navigation'

describe('authorization navigation', () => {
  it('registers a dedicated authorization page and redirects the retired organization route', () => {
    expect(router.resolve('/authorization').name).toBe('authorization')
    expect(router.resolve('/organizations').redirectedFrom).toBeUndefined()
    expect(router.getRoutes().find(route => route.path === '/organizations')?.redirect).toBe('/authorization')
    const items = navigationSections.flatMap(section => section.items)
    expect(items.some(item => item.path === '/authorization')).toBe(true)
    expect(items.some(item => item.path === '/organizations')).toBe(false)
  })
})
