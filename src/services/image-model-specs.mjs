// Explicit provider capabilities, independent of the upstream model name.
const invalid = message => Object.assign(new Error(message), { statusCode: 400, code: 'IMAGE_SPEC_INVALID' })
export const IMAGE_SPEC_TEMPLATES = Object.freeze({
  openai: { adapter: 'openai', defaultSize: '1024x1024', quality: '', usage: 'none', maxReferences: 0, specs: [
    { size: '1024x1024', resolution: '1K', aspectRatio: '1:1' },
    { size: '1536x1024', resolution: '1.5K', aspectRatio: '3:2' },
    { size: '1024x1536', resolution: '1.5K', aspectRatio: '2:3' },
  ] },
  seedream: { adapter: 'seedream', defaultSize: '2K', quality: '', usage: 'none', maxReferences: 10, specs: [
    { size: '1K', resolution: '1K', aspectRatio: 'auto' }, { size: '1.5K', resolution: '1.5K', aspectRatio: 'auto' }, { size: '2K', resolution: '2K', aspectRatio: 'auto' },
  ] },
})
export function imageSpecTemplate(name = 'openai') {
  if (!IMAGE_SPEC_TEMPLATES[name]) throw invalid('未知图片规格模板')
  return structuredClone({ version: 1, template: name, ...IMAGE_SPEC_TEMPLATES[name], tokenBudget: { input: 32768, output: 32768 } })
}
export function normalizeImageSpecs(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('请配置图片生成规格')
  if (input.version !== 1) throw invalid('图片规格版本不受支持')
  if (!['openai', 'seedream'].includes(input.adapter)) throw invalid('请选择支持的图片协议模板')
  if (!Array.isArray(input.specs) || !input.specs.length || input.specs.length > 30) throw invalid('请配置1至30项图片规格')
  const seen = new Set()
  const specs = input.specs.map(item => {
    const size = String(item.size || '').trim()
    const resolution = String(item.resolution || '').trim()
    const aspectRatio = String(item.aspectRatio || 'auto').trim()
    if (!/^(?:[1-9](?:\.5)?K|[1-9]\d{2,4}x[1-9]\d{2,4})$/.test(size) || seen.has(size)) throw invalid('图片规格格式无效或重复')
    const pixels = /^(\d+)x(\d+)$/.exec(size)
    if (pixels && (Number(pixels[1]) > 16384 || Number(pixels[2]) > 16384 || Number(pixels[1]) * Number(pixels[2]) > 67108864)) throw invalid('图片规格超过安全像素上限')
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(resolution)) throw invalid('分辨率档位格式无效')
    if (!/^(auto|[1-9]\d?:[1-9]\d?)$/.test(aspectRatio)) throw invalid('画面比例格式无效')
    seen.add(size)
    const legacyBounds = input.adapter === 'seedream' ? ({ '1K': [921600,1156055], '1.5K': [1156056,2610000], '2K': [2610001,4624220] })[size] : null
    const area = pixels ? Number(pixels[1]) * Number(pixels[2]) : null
    const minPixels = (item.minPixels === '' ? undefined : item.minPixels) ?? legacyBounds?.[0] ?? area
    const maxPixels = (item.maxPixels === '' ? undefined : item.maxPixels) ?? legacyBounds?.[1] ?? area
    if ((minPixels != null || maxPixels != null) && (![minPixels,maxPixels].every(n=>Number.isSafeInteger(n)&&n>0&&n<=67108864) || minPixels>maxPixels)) throw invalid('返回图片像素范围无效')
    return { size, resolution, aspectRatio, ...(minPixels != null ? { minPixels, maxPixels } : {}) }
  })
  const defaultSize = String(input.defaultSize || '')
  if (!seen.has(defaultSize)) throw invalid('默认规格必须属于已配置规格')
  const maxReferences = Number(input.maxReferences ?? 0)
  if (!Number.isSafeInteger(maxReferences) || maxReferences < 0 || maxReferences > 10) throw invalid('参考图数量应为 0 到 10')
  const editEndpointPath = input.adapter === 'openai' && maxReferences > 0
    ? String(input.editEndpointPath || '/images/edits').trim()
    : ''
  if (input.adapter === 'openai' && maxReferences > 0 &&
      (editEndpointPath.length > 200 || !/^(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/.test(editEndpointPath))) throw invalid('请填写服务商基址下的图片编辑端点路径，例如 /images/edits')
  const quality = String(input.quality || '')
  if (!['', 'auto', 'low', 'medium', 'high', 'standard', 'hd'].includes(quality)) throw invalid('默认质量无效')
  if (input.adapter === 'seedream' && quality) throw invalid('Seedream模板不发送quality参数，请保持上游默认质量')
  const usage = input.usage || 'none'
  if (!['none', 'openai'].includes(usage)) throw invalid('Token用量协议无效')
  const tokenBudget = { input: Number(input.tokenBudget?.input ?? 32768), output: Number(input.tokenBudget?.output ?? 32768) }
  if (Object.values(tokenBudget).some(n => !Number.isSafeInteger(n) || n < 1 || n > 1000000)) throw invalid('单次Token预占上限无效')
  return { version: 1, template: String(input.template || 'custom').slice(0, 32), adapter: input.adapter, defaultSize, specs, maxReferences, ...(editEndpointPath ? { editEndpointPath } : {}), quality, usage, tokenBudget }
}
export function configuredImageSpecs(config) {
  const data = typeof config === 'string' ? JSON.parse(config || '{}') : config || {}
  return data.image ? normalizeImageSpecs(data.image) : null
}
export function selectImageSpec(config, size) {
  const requested = !size || size === 'auto' ? config.defaultSize : size
  const spec = config.specs.find(item => item.size === requested)
  if (!spec) throw invalid('此模型不支持所选图片规格，请重新查询模型目录')
  return spec
}

export function outputImageSpec(config, selected, returnedSize) {
  const normalized = normalizeImageSpecs(config)
  const exact = normalized.specs.find(item => item.size === returnedSize)
  if (exact) return exact
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(String(returnedSize || ''))
  const spec = normalized.specs.find(item => item.size === selected.size)
  if (match && spec && !spec.size.includes('x') && spec.minPixels != null) {
    const area = Number(match[1]) * Number(match[2])
    if (Number(match[1]) <= 16384 && Number(match[2]) <= 16384 && area >= spec.minPixels && area <= spec.maxPixels) return spec
  }
  throw invalid('返回图片尺寸不符合该模型所选档位，请核对原任务')
}
