const MAX_REFERENCE_BYTES = 8 * 1024 * 1024
const MAX_BATCH_BYTES = 14 * 1024 * 1024
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function referenceFile(dataUrl, index) {
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl)
  if (!match) throw invalid('图片编辑的参考图仅支持 PNG、JPEG 或 WebP')
  const encoded = match[2].replace(/\s/g, '')
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > MAX_REFERENCE_BYTES ||
    bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw invalid('参考图过大或数据无效')
  const format = match[1].toLowerCase().replace(/^jpg$/, 'jpeg')
  const valid = format === 'png' ? bytes.subarray(0, 8).equals(pngHeader) :
    format === 'jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff :
      bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
  if (!valid) throw invalid('参考图内容与文件格式不匹配')
  return { bytes, format, name: 'reference-' + (index + 1) + '.' + format }
}

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'IMAGE_TASK_INPUT_INVALID' })
}

export function buildOpenAiEditForm(fields, referenceImages) {
  const files = referenceImages.map(referenceFile)
  if (files.reduce((total, file) => total + file.bytes.length, 0) > MAX_BATCH_BYTES) throw invalid('参考图总大小过大，请压缩后重试')
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.set(key, String(value))
  const field = files.length === 1 ? 'image' : 'image[]'
  for (const file of files) body.append(field, new Blob([file.bytes], { type: 'image/' + file.format }), file.name)
  return body
}
