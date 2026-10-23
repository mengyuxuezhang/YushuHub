export type MarketType = 'personal'
export type DeliveryPolicy = 'market' | 'recommended' | 'auto_install'

export interface CuratedDependency {
  type: 'skill' | 'mcp'
  id: string
  required?: boolean
}

export interface CuratedAgent {
  id: string
  name: string
  description: string
  prompt: string
  iconUrl?: string
  publisherName: string
  profileLabels: string[]
  usageLabel: string
  expertiseTags: string[]
  starterPrompts: string[]
  version: string
  permissionMode: string
  status: string
  dependencies: CuratedDependency[]
  marketTypes: MarketType[]
  sourceType?: string
  editable: boolean
  updatedAt?: string
  createdAt?: string
}

export interface CuratedAgentInput {
  id: string
  name: string
  description: string
  prompt: string
  iconUrl: string
  publisherName: string
  profileLabels: string[]
  usageLabel: string
  expertiseTags: string[]
  starterPrompts: string[]
  version: string
  permissionMode: string
  skillIds: string[]
  mcpIds: string[]
  marketTypes: MarketType[]
}

export interface AgentDistribution {
  id: string
  agent_id?: string
  agentId?: string
  enabled: boolean | number
  delivery_policy?: DeliveryPolicy
  deliveryPolicy?: DeliveryPolicy
  status: string
  audienceType?: 'all' | 'membership_cards'
  membershipCardIds?: string[]
}

export interface MarketDependencyOption {
  id: string
  name: string
  status?: string
}
