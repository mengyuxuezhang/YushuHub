export async function writeClipboardText(text: unknown): Promise<void> {
  const value = String(text ?? '').trim()
  if (!value) throw new Error('没有可复制的内容')

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return
    }
  } catch {
    // HTTP 页面或浏览器权限策略可能拒绝 Clipboard API，继续使用兼容回退。
  }

  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.readOnly = true
  textarea.style.position = 'fixed'
  textarea.style.top = '-1000px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)
  try {
    if (!document.execCommand?.('copy')) throw new Error('浏览器未允许复制')
  } finally {
    textarea.remove()
  }
}
