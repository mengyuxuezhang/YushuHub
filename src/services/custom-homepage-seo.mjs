import { parse } from 'parse5'

const PUBLIC_ROOT = '/_custom-homepage/'
const LOCAL_ORIGIN = 'https://custom-homepage.invalid'
const META_NAMES = new Set(['description', 'keywords', 'robots', 'theme-color', 'application-name', 'apple-mobile-web-app-title', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'])
const META_PROPERTIES = new Set(['og:type', 'og:locale', 'og:site_name', 'og:title', 'og:description', 'og:image', 'og:image:alt', 'og:url'])
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const text = node => node.nodeName === '#text' ? node.value : (node.childNodes || []).map(text).join('')
const attrs = node => Object.fromEntries((node.attrs || []).map(attr => [attr.name, attr.value]))

function safeUrl(value, local = false) {
  if (!value) return ''
  try {
    const input = String(value).trim()
    const url = new URL(local && input.startsWith('/') && !input.startsWith('//') && !input.startsWith(PUBLIC_ROOT) ? PUBLIC_ROOT + input.slice(1) : input, LOCAL_ORIGIN + PUBLIC_ROOT)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return ''
    if (url.origin === LOCAL_ORIGIN) return local && url.pathname.startsWith(PUBLIC_ROOT) ? url.pathname + url.search + url.hash : ''
    return url.href
  } catch { return '' }
}

// 只重建允许的静态 SEO 标签，不执行上传脚本，也不复制任意标签/事件属性。
export function createHomepagePresentation(html = '') {
  const document = parse(String(html))
  const head = document.childNodes.find(node => node.tagName === 'html')?.childNodes.find(node => node.tagName === 'head')
  const nodes = head?.childNodes || []
  const title = text(nodes.find(node => node.tagName === 'title') || {}).trim().slice(0, 300) || 'AI 创作工作台'
  const tags = [`<title>${escape(title)}</title>`]
  const seen = new Set()
  let description = ''
  let canonical = ''
  for (const node of nodes) {
    const a = attrs(node)
    if (node.tagName === 'meta') {
      const kind = a.property ? 'property' : 'name'
      const key = String(a[kind] || '').toLowerCase()
      if (!(kind === 'property' ? META_PROPERTIES : META_NAMES).has(key) || seen.has(key)) continue
      let content = String(a.content || '').slice(0, 2000)
      if (['og:image', 'twitter:image'].includes(key)) content = safeUrl(content, true)
      if (key === 'og:url') content = safeUrl(content)
      if (!content) continue
      seen.add(key)
      if (key === 'description') description = content
      tags.push(`<meta ${kind}="${key}" content="${escape(content)}">`)
    }
    if (node.tagName === 'link') {
      const rel = String(a.rel || '').toLowerCase()
      if (!['icon', 'shortcut icon', 'apple-touch-icon', 'canonical'].includes(rel) || seen.has(rel)) continue
      const url = safeUrl(a.href, rel !== 'canonical')
      if (!url) continue
      seen.add(rel)
      if (rel === 'canonical') canonical = url
      tags.push(`<link rel="${rel}" href="${escape(url)}">`)
    }
    if (node.tagName === 'script' && a.type === 'application/ld+json') {
      try {
        const data = JSON.parse(text(node))
        if (data['@context'] !== 'https://schema.org') continue
        const graph = (data['@graph'] || [data]).filter(item => ['WebSite', 'SoftwareApplication'].includes(item['@type'])).map(item => {
          const result = { '@type': item['@type'] }
          for (const key of ['@id', 'name', 'description', 'inLanguage', 'operatingSystem', 'applicationCategory', 'url', 'image']) {
            if (typeof item[key] !== 'string') continue
            const value = ['@id', 'url', 'image'].includes(key) ? safeUrl(item[key], key === 'image') : item[key].slice(0, 2000)
            if (value) result[key] = value
          }
          return result
        })
        if (graph.length) tags.push(`<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')}</script>`)
      } catch { /* Invalid structured data is ignored, never executed. */ }
    }
  }
  const shell = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${tags.join('')}<style>html,body,iframe{width:100%;height:100%;margin:0;border:0}body{overflow:hidden;background:#fff}iframe{display:block}</style></head><body><iframe title="${escape(title)}" src="${PUBLIC_ROOT}" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation"></iframe><noscript><h1>${escape(title)}</h1><p>${escape(description)}</p><a href="${PUBLIC_ROOT}">浏览完整官网</a></noscript></body></html>`
  const files = canonical ? {
    'robots.txt': { type: 'text/plain', content: `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${new URL('sitemap.xml', canonical).href}\n` },
    'sitemap.xml': { type: 'application/xml', content: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escape(canonical)}</loc></url></urlset>\n` },
  } : {}
  return { shell, files }
}
