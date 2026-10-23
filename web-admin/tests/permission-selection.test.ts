import { isPermissionGroupFullySelected, togglePermissionGroupSelection } from '@/utils/permission-selection'

const items = [
  { key: 'one', name: '权限一' },
  { key: 'two', name: '权限二' },
  { key: 'three', name: '权限三' },
]

describe('permission selection', () => {
  it('keeps a single selected permission independent from its siblings', () => {
    expect(togglePermissionGroupSelection(['one'], [items[1]])).toEqual(['one', 'two'])
  })

  it('selects and clears one complete permission group', () => {
    const selected = togglePermissionGroupSelection([], items)
    expect(selected).toEqual(['one', 'two', 'three'])
    expect(isPermissionGroupFullySelected(selected, items)).toBe(true)
    expect(togglePermissionGroupSelection(selected, items)).toEqual([])
  })
})
