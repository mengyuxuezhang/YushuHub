import { writeClipboardText } from '@/utils/clipboard'

describe('clipboard compatibility', () => {
  it('uses the Clipboard API when the browser permits it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    await writeClipboardText(' CODE-123 ')

    expect(writeText).toHaveBeenCalledWith('CODE-123')
  })

  it('falls back to a temporary textarea on HTTP or denied clipboard access', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    await writeClipboardText('REDEEM-456')

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })
})
