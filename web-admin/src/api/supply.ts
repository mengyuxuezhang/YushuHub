import { api } from './client'
export interface SupplyComponent { meter: string; phase: string; dimensions?: Record<string, string>; amount: string; unitSize: string }
export interface SupplyPlan { components: SupplyComponent[]; version: number }
export interface SupplyOffer { version: number; enabled: boolean; saleMarkup: SupplyComponent[]; supplyMarkup: SupplyComponent[]; pointsPerCny: string; consumptionMultiplier?: string; priceEffectiveAt?: number }
export interface SupplyRow { model: { id: string; name: string; taskType: string; price: SupplyPlan }; sale?: SupplyPlan; supply?: SupplyPlan; offer: SupplyOffer | null; enabled?: boolean; priceNotices?: { effectiveAt: number; sale: SupplyPlan; supply?: SupplyPlan; pointsPerCny: string; consumptionMultiplier: string }[] }
export interface SupplyTotals { requestCount: number; pendingCount: number; salesAmount: string; listSalesAmount: string; upstreamAmount?: string; supplyAmount: string; firstMargin?: string; secondMargin: string; marketingSubsidy: string; points: string; supplyRefunds?: string; prepaymentCorrections?: string; netMargin?: string }
export interface SupplyEntry { id: string; organizationId: string; kind: string; amount: string; at: number; reverses?: string; actor?: string; reason?: string }
export interface SupplyBalance { wallet: { balance: string; reserved: string }; totals?: SupplyTotals | null; entries: SupplyEntry[]; usage: { requestId: string; state: string; salesAmount?: string; listSalesAmount?: string; marketingSubsidy?: string; upstreamAmount?: string; supplyAmount?: string; firstMargin?: string; secondMargin?: string }[]; unsettled: number }
export const supplyCatalog = () => api<SupplyRow[]>('/api/supply/catalog')
export const supplyBalance = () => api<SupplyBalance>('/api/supply/balance')
export const saveOffer = (input: unknown) => api<SupplyOffer>('/api/supply/offers', { method: 'POST', body: JSON.stringify(input) })
export const creditChild = (childId: string, input: unknown) => api(`/api/supply/children/${encodeURIComponent(childId)}/credit`, { method: 'POST', body: JSON.stringify(input) })
export const reverseChildEntry = (childId: string, input: unknown) => api(`/api/supply/children/${encodeURIComponent(childId)}/reverse`, { method: 'POST', body: JSON.stringify(input) })
export interface CustomSupplyDefinition { id: string; version: number; status: string; adapter: string; clientId?: string; contextWindow?: number; maxOutputTokens?: number; maxImages?: number; supportsStreaming?: boolean; allowedVoiceIds?: string[]; supplierCost: SupplyPlan }
export interface CustomSupplyCandidate { id: string; clientId: string; name: string; modelType: string; contextWindow: number; providerId: string; adapters: string[]; voices: { id: string; name: string }[]; costComponents: SupplyComponent[] }
export interface CustomSupplyReview { candidates: CustomSupplyCandidate[]; records: { revision: number; definition: CustomSupplyDefinition; updatedAt: number; updatedBy: string }[]; fileModelIds: string[] }
export const customSupplyReview = () => api<CustomSupplyReview>('/api/supply/custom-models')
export const saveCustomSupplyDefinition = (input: unknown) => api('/api/supply/custom-models', { method: 'PUT', body: JSON.stringify(input) })
