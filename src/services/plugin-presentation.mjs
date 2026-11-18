import { isIP } from 'node:net'

const defaults = {
  github: {
    description: '查询有权限访问的 GitHub 仓库、Pull Request、Issue 和 Actions 运行记录。适用于接手项目、代码审查、故障排查和发布复盘，可按仓库、分支或时间范围整理进度，并附上原始链接。',
    tags: ['仓库调研', '代码评审', 'Issue 跟进', 'CI 排障', '发布复盘', '项目周报'],
    guide: '在本机安装 GitHub CLI（gh），执行 gh auth login 并登录对应的 GitHub 主机。点击下方示例后，把占位的仓库、PR 编号或时间范围换成实际信息。使用 GitHub Enterprise 时请给出主机地址。评论、合并或重跑工作流前，可先让 Agent 列出拟执行的操作。',
    examples: [
      '快速了解 [仓库地址] 的用途、默认分支和主要入口，并整理贡献指南中的上手步骤。',
      '列出 [仓库地址] 过去一周合并的 PR，按功能、修复和维护分组，附上原始链接。',
      '检查 [仓库地址] 的 PR #[编号]，总结改动、审查意见、检查结果和待处理事项。',
      '梳理 [仓库地址] 中仍未关闭的高优先级 Issue，按影响范围和跟进状态排序。',
      '分析 [仓库地址] 最近一次失败的 Actions 运行，指出失败阶段、关键日志和建议排查步骤。',
      '汇总 [仓库地址] 自 [版本标签] 以来的重要改动，起草一份可供审核的发布说明。',
    ],
  },
  feishu: {
    description: '查询飞书中已授权的日历、文档、表格和群聊消息。可整理会议安排、提取文档决策、汇总表格数据，并从指定群聊中梳理待办和风险，适合日常协作、会议准备与项目复盘。',
    tags: ['会议准备', '日程统筹', '文档总结', '表格分析', '群聊回顾', '项目周报'],
    guide: '在本机安装飞书 CLI（lark-cli），按提示完成初始化和账号授权。使用国际版 Lark 时请明确说明。查询文档、表格或群聊时，优先提供链接、名称或时间范围。编辑文档、发送消息或创建日程前，可先要求预览。',
    examples: [
      '查看我今天的飞书日程，按时间列出会议主题、组织者和加入方式，并标记时间冲突。',
      '阅读 [飞书文档链接]，提取关键决策、行动项、负责人和截止日期，附上原文链接。',
      '分析 [飞书表格链接] 的项目进度，找出逾期事项和空缺负责人，并按优先级汇总。',
      '回顾 [飞书群聊] 最近 7 天的讨论，整理关键结论、待确认问题和后续跟进事项。',
      '根据 [需求文档链接] 和 [会议纪要链接]，整理本周进展、主要风险和需要决策的事项。',
      '查找我本周剩余的飞书空闲时段，推荐三个 30 分钟的候选会议时间。',
    ],
  },
  wecom: {
    description: '在已授权的企业微信身份下查询文档、微盘文件、邮件、日历和会话消息。可集中梳理资料、客户邮件和团队讨论，便于准备会议、跟进事项与交接工作。',
    tags: ['企业文档', '微盘资料', '邮件跟进', '日程安排', '会话回顾', '工作交接'],
    guide: '在本机安装企业微信 CLI（wecom-cli），通过官方流程授权对应企业。使用多个企业身份时，请写明所属企业。提供关键词、链接或查询时间以缩小范围。发送邮件、发消息或修改资料前，可先要求预览。',
    examples: [
      '在企业微信文档中搜索 [项目关键词]，按更新时间列出相关资料、摘要和链接。',
      '整理企业微信微盘 [文件夹名称] 下的项目资料，列出文件类型、用途和最近更新时间。',
      '梳理最近 7 天和 [客户名称] 有关的企业微信邮件，提取待回复事项、责任人和期限。',
      '查看我今天的企业微信日程，汇总会议顺序、参与人和冲突时段。',
      '回顾 [企业微信群聊] 最近 3 天的消息，列出已确认的决定和仍需跟进的问题。',
      '在企业微信中查找 [项目名称] 的交接文档和相关邮件，整理交接清单并注明来源。',
    ],
  },
  dingtalk: {
    description: '在指定钉钉组织内查询日程、文档、待办和消息。可归纳项目沟通、整理团队会议与任务进度，适合跨部门协作、待办跟进和会议前资料准备。',
    tags: ['组织协作', '日程管理', '文档查找', '待办跟进', '消息回顾', '项目协调'],
    guide: '在本机安装钉钉 CLI（dws），执行 dws auth login 完成授权。存在多个组织时，请明确选择组织和账号。查询时提供时间范围、群聊或文档链接。创建待办、修改文档或发消息前，可先让 Agent 展示草稿。',
    examples: [
      '查看我今天的钉钉日程，整理会议时间、主题和参与人，并标出冲突。',
      '在 [钉钉组织] 中查找 [项目关键词] 相关文档，按相关性列出摘要和链接。',
      '列出我在 [钉钉组织] 的未完成待办，分成已逾期、今天到期和本周到期三组。',
      '回顾 [钉钉群聊] 最近一周关于 [项目名称] 的消息，整理已定事项、行动项和风险。',
      '根据 [钉钉文档链接] 和本周待办，整理下次项目例会的议程与待确认问题。',
      '汇总 [项目名称] 在 [钉钉组织] 的近期会议与待办，整理一份按负责人分组的跟进清单。',
    ],
  },
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
