export type PricingGroup = 'text' | 'image' | 'audio' | 'video' | 'vector'
export type ChargePhase = 'request' | 'preview' | 'activation' | 'usage'
export type PricingMeter = 'request' | 'input_tokens' | 'output_tokens' | 'cached_tokens' | 'image' | 'additional_input_images' | 'billable_characters' | 'audio_seconds' | 'video_seconds' | 'vector_inputs' | 'resource_activation'

export interface PricingComponent {
  id?: string
  meter: PricingMeter
  phase: ChargePhase
  unitSize: number
  minimumUnits: number
  rounding: 'none' | 'ceil' | 'floor' | 'nearest'
  dimensions: Record<string, string>
  costAmount: number
  costCurrency: string
  salePoints: number
  status: 'enabled' | 'disabled'
}
export interface PricingPlan {
  id: string
  providerId: string
  providerName: string
  providerModelId: string
  modelId: string
  displayName: string
  capabilityId: string
  taskType: string
  version: number
  status: 'draft' | 'enabled' | 'disabled'
  consumptionMultiplier: number
  isProtected?: boolean
  components: PricingComponent[]
  updatedAt?: string
}
export interface ModelCapability {
  id: string
  providerModelId: string
  modelId: string
  displayName: string
  providerId: string
  taskType: string
  protocolAdapter: string
  configRevision: number
  status: 'enabled' | 'disabled'
  isSystem?: boolean
  upstreamAccountId?: string
  connectionRole?: string
  endpointPath?: string
}
export interface ExchangeRate { currency: string; cnyRate: number; updatedAt?: string }
export interface ProtocolDescriptor {
  id: string
  tasks: string[]
  transport: 'http' | 'websocket' | 'sdk'
  executor: 'sync' | 'async_job' | 'stream' | 'session'
  requiresCredential: boolean
  connectionRole: string
  endpoints: { taskType: string; field: string; method: string; template: string }[]
}
