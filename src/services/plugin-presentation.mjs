import { isIP } from 'node:net'

const defaults = {
  github: { tags: ['仓库', 'PR', 'Issue'], guide: '在本机安装 GitHub CLI（gh），执行 gh auth login 完成授权。聊天中点「技能」搜索 GitHub，给出仓库地址或 OWNER/REPO。', examples: ['列出这个 GitHub 仓库最近合并的 5 个 PR，并总结改动。', '检查指定仓库最新一次 Actions 失败的原因。'] },
  feishu: { tags: ['文档', '表格', '日历'], guide: '在本机安装飞书 CLI（lark-cli），按 CLI 提示初始化并登录飞书账号。聊天中点「技能」搜索飞书，并说明要查询的日历或资源。', examples: ['查看我今天有权限读取的飞书日程。', '按这个飞书文档链接总结重点。'] },
  wecom: { tags: ['文档', '邮件', '日程'], guide: '在本机安装企业微信 CLI（wecom-cli），完成企业微信授权。聊天中点「技能」搜索企业微信，指定需要读取的内容及所属企业。', examples: ['在企业微信中查找包含指定关键词的文档。', '查询今天的企业微信日程。'] },
  dingtalk: { tags: ['文档', '日程', '待办'], guide: '在本机安装钉钉 CLI（dws），执行 dws auth login 完成授权。聊天中点「技能」搜索钉钉，说明要查询的组织和资源。', examples: ['查看我今天的钉钉日程。', '在指定的钉钉组织里查找待办。'] },
}

export function pluginPresentation(pluginId, saved) {
  if (saved) return typeof saved === 'string' ? JSON.parse(saved) : saved
  return { title: '', description: '', iconUrl: '', guide: '', tags: [], examples: [], ...defaults[pluginId] }
}

export function parsePluginPresentation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('插件资料格式无效')
  function field(key, max) {
    if (typeof input[key] !== 'string' || input[key].trim().length > max) throw new Error('插件资料字段超出长度限制')
    return input[key].trim()
  }
  function list(key, max, limit) {
    const value = input[key]
    if (!Array.isArray(value) || value.length > limit || value.some(item => typeof item !== 'string' || !item.trim() || item.trim().length > max)) throw new Error('请检查标签或使用示例的数量和长度')
    return [...new Set(value.map(item => item.trim()))]
  }
  const iconUrl = field('iconUrl', 2_048)
  if (iconUrl) {
    const url = new URL(iconUrl, 'https://local.invalid')
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || isIP(url.hostname.replace(/^\[|\]$/g, ''))
      || (iconUrl.startsWith('/') && (!/^\/uploads\/[a-z0-9._/-]+$/i.test(iconUrl) || url.pathname !== iconUrl))
      || (!iconUrl.startsWith('/') && !iconUrl.startsWith('https://'))) throw new Error('头像需要使用上传图片或有效的 HTTPS 图片地址')
  }
  return {
    title: field('title', 64), description: field('description', 240), iconUrl,
    guide: field('guide', 2_000), tags: list('tags', 24, 8), examples: list('examples', 200, 6),
  }
}
