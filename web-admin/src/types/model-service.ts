export type RecordStatus = 'enabled' | 'disabled'

export interface ModelProvider { id: string; name: string; protocol: string; baseUrl: string; status: RecordStatus; isDefault: boolean; timeoutMs: number; sortOrder: number; notes: string; keyMode?: 'pool' | 'single_voice'; keyCount?: number; modelCount?: number; isSystem?: boolean; updatedAt?: string }
export interface ModelProviderKey { id: string; providerId: string; providerModelId?: string; modelId?: string; modelName?: string; upstreamAccountId: string; upstreamAccountName?: string; keyPreview: string; status: RecordStatus; weight: number; lastUsedAt?: string; successCount: number; failureCount: number; lastError?: string; notes: string; updatedAt?: string }
export interface ModelUpstreamAccount { id: string; providerId: string; providerName: string; name: string; region: string; status: RecordStatus; notes: string; keyCount: number; activeKeyCount: number; resourceCount: number; pendingTaskCount: number; updatedAt?: string }
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export type ReasoningAdapter = 'openai' | 'deepseek' | 'openrouter'
export interface ModelReasoningConfig { enabled: boolean; adapter: ReasoningAdapter; efforts: ReasoningEffort[]; defaultEffort: ReasoningEffort | '' }
export interface ProviderModel { id: string; providerId: string; providerName: string; modelId: string; displayName: string; description: string; modelType: 'text' | 'image' | 'video' | 'audio' | 'search'; endpointPath: string; status: RecordStatus; isDefault: boolean; capabilities: string[]; reasoning: ModelReasoningConfig; contextWindow: number; sortOrder: number; isSystem?: boolean; updatedAt?: string }
export type BillingType = 'per_token' | 'per_request' | 'per_image_resolution'
export interface PricingMultipliers { input: number; output: number; request: number; resolutions: Record<string, number> }
export interface ModelPricingRule { id: string; providerId: string; providerName: string; providerModelId: string; modelId: string; displayName: string; billingType: BillingType; inputPointsPerMTokens: number; outputPointsPerMTokens: number; pointsPerRequest: number; resolutionPoints?: Record<string, number>; inputCostPointsPerMTokens: number; outputCostPointsPerMTokens: number; costPointsPerRequest: number; resolutionCostPoints?: Record<string, number>; consumptionMultiplier: number; multipliers: PricingMultipliers; isSystem?: boolean; status: RecordStatus; updatedAt?: string }
export interface ModelTestResult { ok?: boolean; skipped?: boolean; message: string; keyPreview?: string; }
export interface ModelKeyUsageRecord { id: string; userId: string; username: string; displayName: string; requestId: string; modelName: string; providerName: string; providerKeyPreview: string; promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number; pointsDelta: number; deductStatus: string; note: string; createdAt: string }

export interface VoiceUpstreamAccount { id: string; providerId: string; name: string; region: string; status: RecordStatus; keyCount: number; keyPreview?: string }
export interface VoiceModelConfiguration { id: string; name: string; modelId: string; providerId: string; adapter?: string; capabilityStatus?: RecordStatus; previewPoints?: number | null; activationPoints?: number | null; synthesisPoints?: number | null }
export interface VoiceConfiguration { accounts: VoiceUpstreamAccount[]; models: VoiceModelConfiguration[] }
export interface KeyVoiceResource { id: string; name: string; status: string; userId: string; createdAt: string }
export interface VoiceDeletionResult { id: string; voiceId: string; status: string; errorCode: string }
