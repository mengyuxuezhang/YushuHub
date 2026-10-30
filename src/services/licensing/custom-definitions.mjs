import { identifier, failure } from './protocol.mjs'
import { priceStructure, publicSupplyPlan, validateSupplyPrice } from './pricing.mjs'
import { validatePrivateVoiceMeters } from './private-voice-pricing.mjs'

export const emptyCustomDefinitions = () => ({ roots: {} })
const tasks = { 'openai.chat': 'chat', 'openai.images': 'image_generation', 'bocha.search': 'web_search', 'minimax.speech': 'speech_synthesis', 'minimax.speech_async': 'speech_synthesis', 'minimax.private_voice': 'speech_synthesis' }
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max

// Low-frequency reviewed definitions have immutable history. Connection data
// and secrets remain in the original provider and encrypted credential tables.
export function customDefinitionService({ store, managed, fileIds = [], now = Date.now }) {
  const recordsFor = (state, rootId) => Object.hasOwn(state.roots, rootId) ? state.roots[rootId] : {}
  function requireCustom(root) {
    if (root.level !== 1 || root.modelMode !== 'custom') throw failure('MODEL_FIXED', '仅自定义一级可以审核自接模型', 403)
  }
  return {
    async definitions(rootId) { return Object.values(recordsFor(await store.read(), rootId)).map(record => record.definition) },
    async version(rootId, id, version) { const records = recordsFor(await store.read(), rootId); return Object.hasOwn(records, id) ? records[id].history.find(item => item.definition.version === version)?.definition : undefined },
    async list(root) {
      requireCustom(root)
      return { candidates: await managed.candidates(root), records: Object.values(recordsFor(await store.read(), root.id)).map(({ revision, definition, history }) => ({ revision, definition, updatedAt: history.at(-1).at, updatedBy: history.at(-1).actor })), fileModelIds: fileIds }
    },
    async save(root, input, actor) {
      requireCustom(root)
      const id = identifier(input.providerModelId)
      if (fileIds.includes(id)) throw failure('FILE_MODEL_CONFLICT', '该模型由受控文件管理，请先完成显式迁入，不能静默覆盖', 409)
      if (!['enabled', 'disabled'].includes(input.status) || !Object.hasOwn(tasks, input.adapter)) throw failure('INVALID_DEFINITION', '模型状态或适配器无效')
      if (input.currency !== 'CNY' || typeof input.memo !== 'string' || input.memo.trim().length < 3 || input.memo.length > 500) throw failure('COST_REVIEW_REQUIRED', '须核定人民币成本并填写3至500字依据')
      if (!Array.isArray(input.costComponents) || !input.costComponents.length || input.costComponents.length > 32
        || input.costComponents.some(item => !item || typeof item.amount !== 'string' || typeof item.unitSize !== 'string')) throw failure('INVALID_PRICE', '成本与单位须使用十进制文本')
      const cost = publicSupplyPlan(validateSupplyPrice({ version: 1, currency: 'CNY', components: input.costComponents }))
      const definition = { id, providerModelId: id, version: 0, status: input.status, adapter: input.adapter, taskType: tasks[input.adapter],
        price: { ...cost, components: cost.components.map(item => ({ ...item, amount: '0.000000' })) }, supplierCost: cost }
      if (input.clientId !== undefined) {
        if (typeof input.clientId !== 'string' || !input.clientId.length || input.clientId.length > 160 || /[\u0000-\u0020\u007f]/.test(input.clientId)) throw failure('INVALID_ID', '客户端模型标识无效')
        definition.clientId = input.clientId
      }
      const required = { chat: ['request', 'input_tokens', 'cached_tokens', 'output_tokens'], image_generation: ['request', 'image'], web_search: ['request'], speech_synthesis: ['request', 'billable_characters'] }[definition.taskType]
      if (input.adapter === 'minimax.private_voice') validatePrivateVoiceMeters(cost)
      else if (required.some(meter => !cost.components.some(item => item.meter === meter && (item.phase || 'usage') === (meter === 'request' ? 'request' : 'usage')))
        || cost.components.some(item => !required.includes(item.meter))) throw failure('UNPRICED_USAGE', '须明确填写此适配器的全部计量项')
      if (input.adapter === 'openai.chat') {
        if (!integer(input.contextWindow, 1, 10_000_000) || !integer(input.maxOutputTokens, 1, input.contextWindow)) throw failure('INVALID_BOUND', '文本须填写有效上下文和输出上限')
        Object.assign(definition, { contextWindow: input.contextWindow, maxOutputTokens: input.maxOutputTokens, supportsStreaming: input.supportsStreaming === true })
      }
      if (input.adapter === 'openai.images') {
        if (!integer(input.maxImages, 1, 10)) throw failure('INVALID_BOUND', '图片单次上限须为1至10')
        definition.maxImages = input.maxImages
      }
      if (definition.taskType === 'speech_synthesis') {
        const candidate = (await managed.candidates(root)).find(item => item.id === id)
        if (!Array.isArray(input.allowedVoiceIds) || input.allowedVoiceIds.length > 200 || new Set(input.allowedVoiceIds).size !== input.allowedVoiceIds.length
          || (input.status === 'enabled' && ((!input.allowedVoiceIds.length && input.adapter !== 'minimax.private_voice') || input.allowedVoiceIds.some(voice => !candidate?.voices.some(item => item.id === voice))))) throw failure('VOICE_NOT_AUTHORIZED', '只能批准本模型已登记的启用公共音色', 403)
        definition.allowedVoiceIds = input.allowedVoiceIds
        definition.publicVoices = (candidate?.voices || []).filter(voice => input.allowedVoiceIds.includes(voice.id))
      }
      // Verify scope/endpoint/capacity before the state transaction. Rechecked
      // on every new call; disabling never needs an upstream request or a Key.
      if (definition.status === 'enabled') {
        const execution = await managed.resolve(definition, root)
        definition.clientId ||= execution.clientId
      }
      return store.transaction(state => {
        const records = Object.hasOwn(state.roots, root.id) ? state.roots[root.id] : (state.roots[root.id] = {})
        const previous = Object.hasOwn(records, id) ? records[id] : undefined
        if (input.expectedRevision !== (previous?.revision || 0)) throw failure('VERSION_CONFLICT', '供货定义已变更，请刷新', 409)
        if (previous && (previous.definition.adapter !== definition.adapter || priceStructure(previous.definition.price) !== priceStructure(definition.price))) throw failure('METERING_IMMUTABLE', '已审核模型不能更换适配器或计量结构，请使用新模型身份', 409)
        if (Object.values(records).some(record => record.definition.id !== id && (record.definition.clientId || record.definition.id) === (definition.clientId || id))) throw failure('MODEL_ID_CONFLICT', '客户端模型标识与已有审核模型重复', 409)
        definition.version = (previous?.revision || 0) + 1
        definition.price.version = definition.version; definition.supplierCost.version = definition.version
        const record = { revision: definition.version, definition, history: [...(previous?.history || []), { at: now(), actor: identifier(actor), memo: input.memo.trim(), definition: structuredClone(definition) }] }
        records[id] = record
        return { revision: record.revision, definition, updatedAt: record.history.at(-1).at, updatedBy: actor }
      })
    },
  }
}
