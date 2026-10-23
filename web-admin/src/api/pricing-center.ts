import { api } from './client'
import type { ExchangeRate, ModelCapability, PricingComponent, PricingGroup, PricingPlan, ProtocolDescriptor } from '@/types/pricing-center'

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
export const listPricingPlans = (group: PricingGroup) => api<PricingPlan[]>(`/api/pricing-plans?group=${encodeURIComponent(group)}`)
export const savePricingPlan = (input: { sourcePlanId?: string; capabilityId: string; taskType: string; status: string; consumptionMultiplier: number; components: PricingComponent[] }) => api<PricingPlan>('/api/pricing-plans', json(input))
export const setPricingPlanStatus = (id: string, status: 'enabled' | 'disabled') => api<PricingPlan>(`/api/pricing-plans/${encodeURIComponent(id)}/status`, json({ status }))
export const deletePricingPlan = (id: string) => api<{ id: string; deleted: boolean }>(`/api/pricing-plans/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const listModelCapabilities = () => api<ModelCapability[]>('/api/model-capabilities')
export const listExchangeRates = () => api<ExchangeRate[]>('/api/pricing-exchange-rates')
export const saveExchangeRate = (currency: string, cnyRate: number) => api<ExchangeRate[]>('/api/pricing-exchange-rates', json({ currency, cnyRate }))
export const listProtocols = () => api<ProtocolDescriptor[]>('/api/model-protocols')
export const saveModelCapability = (input: Record<string, unknown>) => api<ModelCapability>('/api/model-capabilities', json(input))
export const deleteModelCapability = (id: string) => api<{ id: string; deleted: boolean }>(`/api/model-capabilities/${encodeURIComponent(id)}`, { method: 'DELETE' })
