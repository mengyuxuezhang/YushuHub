import { createCuratedAgent } from '@/api/curated-agents'
import type { CuratedAgentInput } from '@/types/markets'

const input: CuratedAgentInput = {
  id: 'data-analyst', name: '数据分析师', description: '分析业务数据', prompt: '请分析数据', iconUrl: '', publisherName: '数据团队', profileLabels: ['专家'], usageLabel: '', expertiseTags: ['趋势分析'], starterPrompts: ['分析这份数据的主要趋势'], version: '1.0.0', permissionMode: 'default', skillIds: [], mcpIds: [], marketTypes: ['personal'],
}

function response(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

describe('curated agent save recovery', () => {
  it('returns the newly created agent normally', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => response(201, { success: true, data: { ...input, status: 'draft', dependencies: [], editable: true } }))
    await expect(createCuratedAgent(input)).resolves.toEqual(expect.objectContaining({ recovered: false, agent: expect.objectContaining({ id: input.id }) }))
  })

  it('rechecks the list when the create result is unknown', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('network connection closed'))
      .mockImplementationOnce(() => response(200, { success: true, data: [{ ...input, status: 'draft', dependencies: [], editable: true }] }))

    await expect(createCuratedAgent(input)).resolves.toEqual(expect.objectContaining({ recovered: true, agent: expect.objectContaining({ id: input.id }) }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('opens an already-created editable agent after a duplicate response', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => response(409, { success: false, error: '专家 ID 已存在' }))
      .mockImplementationOnce(() => response(200, { success: true, data: [{ ...input, status: 'draft', dependencies: [], editable: true }] }))

    await expect(createCuratedAgent(input)).resolves.toEqual(expect.objectContaining({ recovered: true }))
  })

  it('does not treat another owner\'s conflicting ID as a successful save', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => response(409, { success: false, error: '专家 ID 已被占用' }))
      .mockImplementationOnce(() => response(200, { success: true, data: [{ ...input, status: 'published', dependencies: [], editable: false }] }))

    await expect(createCuratedAgent(input)).rejects.toThrow('专家 ID 已被占用')
  })
})
