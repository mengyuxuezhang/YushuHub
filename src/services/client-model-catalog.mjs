export const CLIENT_MODEL_ORDER_SQL = 'm.client_sort_order IS NULL, m.client_sort_order ASC, p.sort_order ASC, m.sort_order ASC, m.created_at ASC, m.id ASC'

export function resolveClientChatModels(models) {
  const chatModels = models.filter(model => model.modelType === 'text')
  const defaultModel = chatModels.find(model => model.configured && model.isClientDefault)
    || chatModels.find(model => model.configured && model.isDefault)
    || chatModels.find(model => model.configured)
    || chatModels.find(model => model.isDefault)
    || chatModels[0]
  return {
    models: models.map((entry) => {
      const { isClientDefault: _preferred, ...model } = entry
      return { ...model, isDefault: entry === defaultModel }
    }),
    defaultModelId: defaultModel?.id || '',
    configured: chatModels.some(model => model.configured),
  }
}
