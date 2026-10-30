import { failure } from './licensing/protocol.mjs'

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
export function paymentMerchantBinding(provider, config) {
  if (!['wechat', 'alipay'].includes(provider) || !validId(config?.appId)
    || (provider === 'wechat' && !validId(config.mchId)) || (provider === 'alipay' && config.sellerId && !validId(config.sellerId))) throw failure('PAYMENT_MERCHANT_INVALID', '原支付商户身份无效，须核对配置', 409)
  return provider === 'wechat' ? { version: 1, provider, appId: config.appId, mchId: config.mchId }
    : { version: 1, provider, appId: config.appId, sellerId: config.sellerId || '', environment: config.environment === 'sandbox' ? 'sandbox' : 'production' }
}
