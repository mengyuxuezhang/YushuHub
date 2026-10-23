import css from '@/components/delivery/login-design.css?raw'

export const loginDesigns = [
  { id: 'nature', name: '自然留白', color: '#eaf1e9', accent: '#2d6752' },
  { id: 'minimal', name: '极简光白', color: '#eef2fb', accent: '#325ce7' },
  { id: 'orbit', name: '深空蓝', color: '#141c29', accent: '#a8c7ff' },
  { id: 'editorial', name: '暖调编辑部', color: '#f5eee2', accent: '#ab4e31' },
] as const

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const text = (value: unknown, fallback: string, max: number) => String(value || fallback).trim().slice(0, max)

// No scripts, forms, navigation or Electron bridge in the preview frame.
export function loginPreviewDocument(form: Record<string, any>, baseUrl: string): string {
  const design = loginDesigns.some(item => item.id === form.loginDesign) ? form.loginDesign : 'nature'
  const app = text(form.appName, form.brandName || '应用名称', 80)
  const description = text(form.description, `${app} Desktop`, 500)
  let logo = ''
  try {
    const value = String(form.loginLogoUrl || form.logoUrl || '').trim()
    if (value) {
      const url = new URL(value, baseUrl)
      if (['https:', 'http:'].includes(url.protocol)) logo = url.href
    }
  } catch { /* Invalid draft URL: leave the logo area empty. */ }
  const field = (label: string, placeholder: string, type = 'text') => `<label><span>${label}</span><input type="${type}" readonly placeholder="${placeholder}" /></label>`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src http: https:; form-action 'none'; base-uri 'none'"><style>html,body{margin:0;padding:0}${css}</style></head><body>
  <div class="lp-screen" data-design="${design}"><header class="window-chrome" aria-label="窗口按钮效果预览"><div class="window-chrome-trailing"><div class="window-controls">
  <button class="window-control" aria-label="最小化（预览）"><svg viewBox="0 0 16 16"><path d="M3 8.5h10"/></svg></button><button class="window-control" aria-label="最大化（预览）"><svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx=".5"/></svg></button><button class="window-control window-control-close" aria-label="关闭（预览）"><svg viewBox="0 0 16 16"><path d="m4 4 8 8m0-8-8 8"/></svg></button>
  </div></div></header><main class="lp-layout"><section class="lp-story">
  ${logo ? `<img class="lp-logo" src="${escape(logo)}" alt="${escape(app)}" referrerpolicy="no-referrer">` : ''}
  <p class="lp-brand">${escape(text(form.brandName, app, 80))}</p><div class="lp-copy"><h1>${escape(text(form.loginHeroTitle, app, 255))}</h1><p>${escape(text(form.loginHeroSubtitle, description, 500))}</p></div>
  <div class="lp-art" aria-hidden="true"><i></i><i></i><b>✦</b></div></section><section class="lp-panel">
  <header class="lp-heading"><h2>${escape(text(form.loginTitle, app, 160))}</h2><p>${escape(text(form.loginSubtitle, `${app} Desktop`, 255))}</p></header>
  <div class="auth-tabs"><button class="active">登录</button><button>注册</button><button>找回密码</button></div><form><h2>登录账户</h2>
  ${field('账号或邮箱', '请输入账号或邮箱')}${field('密码', '请输入密码', 'password')}
  <label><span>验证码</span><div class="auth-captcha-row"><input readonly placeholder="输入图中字符"><button type="button" class="auth-captcha-image" aria-label="验证码示意">A 7 K 2 P</button></div></label>
  <div class="auth-remember-options"><label><input type="checkbox"><span>记住账号</span></label><label><input type="checkbox"><span>记住密码（系统加密存储）</span></label></div><button class="primary" type="button">登录</button>
  </form></section></main></div></body></html>`
}
