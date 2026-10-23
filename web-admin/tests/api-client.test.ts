import { ApiError, api, toUserMessage } from '@/api/client'

describe('API client', () => {
  it('unwraps successful API responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, data: { id: 'agent-1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(api<{ id: string }>('/api/example')).resolves.toEqual({ id: 'agent-1' })
  })

  it('throws a typed error for failed responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: false, error: '无权操作' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(api('/api/example')).rejects.toEqual(expect.objectContaining({ message: '无权操作', status: 403 }))
  })

  it('does not expose raw database errors to operators', () => {
    expect(toUserMessage(new Error("Duplicate entry 'agent-1' for key 'PRIMARY'"))).toBe('数据保存失败，系统已记录问题，请刷新后重试')
    expect(toUserMessage(new Error("Field 'summary' doesn't have a default value"))).toBe('数据保存失败，系统已记录问题，请刷新后重试')
  })
})
