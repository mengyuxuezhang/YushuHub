import type { ModelCapability, PricingComponent } from '@/types/pricing-center'
export type ImageBillingMode = 'request' | 'resolution' | 'token'
export function imageBillingMode(items: PricingComponent[]): ImageBillingMode {
  return items.some(item => ['input_tokens','output_tokens','cached_tokens'].includes(item.meter)) ? 'token' : items.some(item => item.meter === 'image') ? 'resolution' : 'request'
}
export function imagePricingComponents(capability: ModelCapability | undefined, mode: ImageBillingMode, detailed = false): PricingComponent[] {
  const item = (meter: PricingComponent['meter'], dimensions = {}): PricingComponent => ({ meter, dimensions, phase: meter === 'request' ? 'request' : 'usage', unitSize: meter.includes('tokens') ? 1000000 : 1, minimumUnits: 0, rounding: 'none', costAmount: 0, costCurrency: 'CNY', salePoints: 0, salePriceCny: 0, pricingCardId: '', status: 'enabled' })
  if (mode === 'request') return [item('request')]
  if (mode === 'resolution') return [...new Set<string>((capability?.config?.image?.specs || []).map((spec: {resolution: string}) => spec.resolution))].map(resolution => item('image', {resolution}))
  return detailed ? [item('input_tokens',{modality:'text'}),item('input_tokens',{modality:'image'}),item('cached_tokens',{modality:'text'}),item('cached_tokens',{modality:'image'}),item('output_tokens')] : [item('input_tokens'),item('output_tokens')]
}
