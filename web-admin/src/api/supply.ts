import { api } from './client'
export interface SupplyComponent { meter: string; phase: string; dimensions?: Record<string, string>; amount: string; unitSize: string }
export interface SupplyPlan { components: SupplyComponent[]; version: number }
export interface SupplyOffer { version: number; enabled: boolean; saleMarkup: SupplyComponent[]; supplyMarkup: SupplyComponent[]; pointsPerCny: string }
export interface SupplyRow { model: { id: string; name: string; taskType: string; price: SupplyPlan }; sale?: SupplyPlan; supply?: SupplyPlan; offer: SupplyOffer | null; enabled?: boolean }
export interface SupplyBalance { wallet: { balance: string; reserved: string }; entries: { id: string; organizationId: string; kind: string; amount: string; at: number }[]; usage: { requestId: string; state: string; salesAmount?: string; firstMargin?: string; secondMargin?: string }[]; unsettled: number }
export const supplyCatalog = () => api<SupplyRow[]>('/api/supply/catalog')
export const supplyBalance = () => api<SupplyBalance>('/api/supply/balance')
export const saveOffer = (input: unknown) => api('/api/supply/offers', { method: 'POST', body: JSON.stringify(input) })
export const creditChild = (childId: string, input: unknown) => api(`/api/supply/children/${encodeURIComponent(childId)}/credit`, { method: 'POST', body: JSON.stringify(input) })
