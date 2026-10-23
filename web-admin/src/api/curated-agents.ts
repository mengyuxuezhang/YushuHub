import { ApiError, api } from './client'
import type { AgentDistribution, CuratedAgent, CuratedAgentInput, DeliveryPolicy, MarketDependencyOption } from '@/types/markets'

export interface SaveAgentResult {
  agent: CuratedAgent
  recovered: boolean
}

export function listCuratedAgents() {
  return api<CuratedAgent[]>('/api/curated-agents')
}

export function listAgentDistributions() {
  return api<AgentDistribution[]>('/api/curated-agent-distributions')
}

export async function listAgentDependencyOptions() {
  const [skills, mcps] = await Promise.all([
    api<MarketDependencyOption[]>('/api/curated-skills').catch(() => []),
    api<MarketDependencyOption[]>('/api/curated-mcps').catch(() => []),
  ])
  return {
    skills: skills.filter((item) => item.status === 'published'),
    mcps: mcps.filter((item) => item.status === 'published'),
  }
}

export async function createCuratedAgent(input: CuratedAgentInput): Promise<SaveAgentResult> {
  try {
    return { agent: await api<CuratedAgent>('/api/curated-agents', { method: 'POST', body: JSON.stringify(input) }), recovered: false }
  } catch (error) {
    const shouldVerify = !(error instanceof ApiError) || error.status === 0 || error.status === 409 || error.status >= 500
    if (!shouldVerify) throw error
    const existing = (await listCuratedAgents().catch(() => [])).find((item) => item.id === input.id && item.editable)
    if (existing) return { agent: existing, recovered: true }
    throw error
  }
}

export function updateCuratedAgent(id: string, input: CuratedAgentInput) {
  return api<CuratedAgent>(`/api/curated-agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) })
}

export function publishCuratedAgent(id: string, marketTypes: string[]) {
  return api<{ id: string; status: string }>(`/api/curated-agents/${encodeURIComponent(id)}/publish`, { method: 'POST', body: JSON.stringify({ marketTypes }) })
}

export function updateCuratedAgentStatus(id: string, status: 'published' | 'disabled') {
  return api<CuratedAgent>(`/api/curated-agents/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) })
}

export function deleteCuratedAgent(id: string) {
  return api<{ deleted: boolean }>(`/api/curated-agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function saveAgentDistribution(agentId: string, input: { enabled: boolean; deliveryPolicy: DeliveryPolicy; audienceType: 'all' | 'membership_cards'; membershipCardIds: string[] }) {
  return api<AgentDistribution>(`/api/curated-agent-distributions/${encodeURIComponent(agentId)}`, { method: 'PUT', body: JSON.stringify(input) })
}

export function getAgentSyncStatus() {
  return api<{ enabled: boolean; updateAvailable: boolean; added?: number; updated?: number; removed?: number }>('/api/curated-agent-sync/update-status')
}

export function startAgentSync() {
  return api<{ id: string; status: string; message: string; percent: number }>('/api/curated-agent-sync', { method: 'POST', body: JSON.stringify({ async: true }) })
}
