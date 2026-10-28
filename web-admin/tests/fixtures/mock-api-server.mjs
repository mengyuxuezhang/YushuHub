import http from 'node:http'
import fs from 'node:fs'

const PORT = Number(process.env.ADMIN_MOCK_API_PORT || 7077)

const agents = [{ id: 'agent-1', name: '业务助手', description: '协助处理日常业务', prompt: '请协助用户处理业务', version: '1.0.0', permissionMode: 'default', status: 'published', dependencies: [], marketTypes: ['personal'], editable: true, updatedAt: new Date().toISOString() }]
const skills = [{ id: 'skill-1', name: '数据分析', description: '分析结构化业务数据', category: '数据工具', tags: ['分析', '报表'], distributionType: 'public', defaultDeliveryPolicy: 'market', status: 'published', currentVersion: '1.0.0', currentVersionId: 'skill-version-1', sourceType: 'local', updatedAt: new Date().toISOString() }]
const mcps = [{ id: 'mcp-1', name: '浏览器工具', description: '安全访问浏览器调试能力', category: '浏览器', tags: ['调试'], defaultDeliveryPolicy: 'market', status: 'published', currentVersionId: 'mcp-version-1', sourceType: 'local', updatedAt: new Date().toISOString() }]

const responses = {
  '/api/public-settings': { systemName: 'Agent AI 测试平台', systemSubtitle: '总控制中心', logoText: 'AI', primaryColor: '#4f46e5' },
  '/api/me': { loggedIn: true, user: { id: 'test-admin', username: 'admin-test', displayName: '测试管理员', organizationName: '官方平台', role: 'admin', positionType: 'platform_operator', organizationContext: { organizationId: 'platform', organizationLevel: 0 }, permissionKeys: ['*'] } },
  '/api/source-version': { configured: true, version: '3.0.0-beta.96', publishedAt: '2026-08-14T08:00:00Z', releaseNotes: '完善 Agent 客户端构建与运行能力。', commit: '1234567890abcdef1234567890abcdef12345678', history: [{ version: '3.0.0-beta.96', publishedAt: '2026-08-14T08:00:00Z', releaseNotes: '完善 Agent 客户端构建与运行能力。' }, { version: '3.0.0-beta.95', publishedAt: '2026-08-13T08:00:00Z', releaseNotes: '优化客户端更新稳定性。' }] },
  '/api/projects': [{ id: 'project-personal', clientMode: 'personal', appName: '个人助手', brandName: 'Agent AI', shortName: 'AI', themeColor: '#4f46e5', status: 'enabled', canOperate: true }],
  '/api/builds': { items: [{ id: 'build-1', projectId: 'project-personal', projectName: '个人助手', version: '1.4.0-test.1', status: 'running', brand: { clientMode: 'personal' }, canOperate: true, delegatedToCenter: false, updatedAt: new Date().toISOString() }, { id: 'build-2', projectId: 'project-personal', projectName: '个人助手', version: '1.3.2', status: 'succeeded', brand: { clientMode: 'personal' }, canOperate: true, delegatedToCenter: true, updatedAt: new Date().toISOString() }], total: 2, page: 1, pageSize: 20, totalPages: 1 },
  '/api/workers': [{ id: 'worker-1', online: true, status: 'online', currentBuildId: '', lastSeenAt: new Date().toISOString(), expectedPackageVersion: '1.2.3-test.ui.1', versionMatchesSource: true, metadata: { platform: 'win32', packageVersion: '1.2.3-test.ui.1' } }, { id: 'worker-2', online: false, status: 'offline', currentBuildId: '', lastSeenAt: new Date(Date.now() - 3600000).toISOString(), expectedPackageVersion: '1.2.3-test.ui.1', versionMatchesSource: false, metadata: { platform: 'win32', packageVersion: '1.2.2' } }],
  '/api/curated-agents': agents,
  '/api/curated-agent-distributions': [],
  '/api/curated-agent-sync/update-status': { enabled: false, updateAvailable: false },
  '/api/curated-skills': skills,
  '/api/curated-skill-distributions': [],
  '/api/curated-skill-sync/update-status': { enabled: false, updateAvailable: false },
  '/api/curated-mcps': mcps,
  '/api/curated-mcp-distributions': [],
  '/api/curated-mcp-sync/update-status': { enabled: false, updateAvailable: false },
  '/api/model-providers': [{ id: 'openai', name: 'OpenAI Compatible', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1', status: 'enabled', isDefault: true, timeoutMs: 120000, sortOrder: 0, notes: '', keyCount: 1, modelCount: 1, updatedAt: new Date().toISOString() }],
  '/api/model-provider-keys': [{ id: 'key-1', providerId: 'openai', keyPreview: 'sk-****1234', status: 'enabled', weight: 1, successCount: 12, failureCount: 0, notes: '', updatedAt: new Date().toISOString() }],
  '/api/provider-models': [{ id: 'openai-gpt-test', providerId: 'openai', providerName: 'OpenAI Compatible', modelId: 'gpt-test', displayName: 'GPT Test', description: '测试模型', modelType: 'text', endpointPath: '/chat/completions', status: 'enabled', isDefault: true, capabilities: ['text'], contextWindow: 128000, sortOrder: 0, updatedAt: new Date().toISOString() }],
  '/api/model-pricing-rules': [{ id: 'price-1', providerId: 'openai', providerName: 'OpenAI Compatible', providerModelId: 'openai-gpt-test', modelId: 'gpt-test', displayName: 'GPT Test', billingType: 'per_token', inputPointsPerMTokens: 100, outputPointsPerMTokens: 200, pointsPerRequest: 0, status: 'enabled', updatedAt: new Date().toISOString() }],
  '/api/organizations/context': { organizationId: 'agent-root', organizationName: '一级代理测试组织', organizationLevel: 1, rootOrganizationId: 'agent-root', deploymentMode: 'local', dataScope: 'subtree', capabilities: [{ key: 'projects.manage', name: '项目管理', description: '管理本组织项目', enabled: true, transferable: true, limitValue: 10 }] },
  '/api/center-suppliers': [{ id: 'supplier-demo', name: '演示一级代理', status: 'enabled', licenseType: 'partner', authorizationVersion: 2, tokenPreview: '12345678', maxProjects: 10, maxBuilds: 100, usedProjects: 2, usedBuilds: 12, projectUsageSynced: true, allowAgentManagement: true, allowSupplierManagement: false, allowPlatformSettings: true, allowCustomBrand: true, allowCustomApiProviders: false }],
  '/api/organizations/children': [{ id: 'org-a1', name: '二级代理 A1', agentLevel: 2, parentOrganizationId: 'agent-root', deploymentMode: 'inherited', status: 'enabled', ownerUserId: 'a1-admin-id', ownerUsername: 'a1-admin', ownerDisplayName: 'A1 管理员', updatedAt: new Date().toISOString() }],
  '/api/organizations/org-a1/capabilities': [{ key: 'projects.manage', name: '项目管理', description: '管理本组织项目', enabled: true, transferable: false, limitValue: 2 }],
  '/api/organizations/org-a1/audit-logs': [{ id: 'audit-1', actorUserId: 'admin', eventType: 'organization_created', targetType: 'organization', targetId: 'org-a1', detail: {}, createdAt: new Date().toISOString() }],
  '/api/users': [{ id: 'member-1', username: 'operator', displayName: '运营人员', roleTemplateId: 'operator', primaryOrganizationId: 'agent-root', dataScope: 'self', status: 'enabled', updatedAt: new Date().toISOString() }],
  '/api/users/member-1/permission-preview': { user: { id: 'member-1', username: 'operator', displayName: '运营人员', roleTemplateId: 'operator', primaryOrganizationId: 'agent-root', dataScope: 'self', status: 'enabled' }, sourceMode: 'role-template-and-groups', roleTemplate: { id: 'operator', name: '运营' }, groups: [{ id: 'finance', name: '财务报表组' }], sourcePermissionKeys: ['projects.manage', 'payments.manage'], effectivePermissionKeys: ['projects.manage'], organizationContext: { organizationName: '一级代理测试组织', dataScope: 'self', capabilities: [] } },
  '/api/role-templates': [{ id: 'operator', organizationId: '', name: '运营', description: '日常运营岗位', baseRole: 'admin', status: 'enabled', sortOrder: 10, systemBuiltin: true, permissionKeys: ['projects.manage'] }],
  '/api/permissions/catalog': [{ key: 'projects.manage', name: '项目管理', description: '管理项目', group: '项目' }, { key: 'payments.manage', name: '支付管理', description: '管理支付', group: '财务' }],
  '/api/user-groups': [{ id: 'finance', organizationId: 'agent-root', name: '财务报表组', description: '财务查看', status: 'enabled', sortOrder: 0, memberCount: 1 }],
  '/api/user-groups/finance/members': { group: { id: 'finance', name: '财务报表组' }, users: [{ id: 'member-1', username: 'operator', displayName: '运营人员' }], userIds: ['member-1'] },
  '/api/user-groups/finance/permissions': { group: { id: 'finance', name: '财务报表组' }, permissionKeys: ['payments.manage'] },
  '/api/end-users': [{ id: 'end-user-1', username: 'customer-a', displayName: '个人用户 A', email: 'customer@example.com', sourceAgentId: 'agent-root', pointsBalance: 880, membershipName: '专业会员', status: 'enabled', createdAt: new Date().toISOString() }],
  '/api/membership-cards': [{ id: 'free', name: '免费会员', level: 0, status: 'enabled', description: '系统永久免费权益', systemBuiltin: true, redeemOnly: false, allowedModelIds: [], package: { name: '免费权益', durationDays: 0, bonusPoints: 0, pointsDurationDays: 0, price: 0, originalPrice: 0 } }, { id: 'pro', name: '专业会员', level: 2, status: 'enabled', description: '适合高频个人用户', systemBuiltin: false, redeemOnly: false, allowedModelIds: ['openai-gpt-test'], package: { name: '专业版月卡', durationDays: 30, bonusPoints: 1000, pointsDurationDays: 30, price: 29.9, originalPrice: 39.9 } }],
  '/api/membership-cards/model-options': [{ id: 'openai-gpt-test', modelId: 'gpt-test', displayName: 'GPT Test', providerId: 'openai', providerName: 'OpenAI Compatible', status: 'enabled', providerStatus: 'enabled' }],
  '/api/payment-configs': [{ provider: 'wechat', status: 'enabled', appId: 'wx-test', mchId: 'mch-test', publicBaseUrl: 'https://pay.example.com', apiV3KeyConfigured: true, merchantPrivateKeyConfigured: true, lastTestStatus: 'succeeded' }, { provider: 'alipay', status: 'disabled', appId: '', sellerId: '', publicBaseUrl: '', appPrivateKeyConfigured: false, lastTestStatus: '' }],
  '/api/payment-orders': [{ id: 'order-1', orderNo: 'PAY20260814001', userId: 'end-user-1', username: 'customer-a', displayName: '个人用户 A', provider: 'wechat', amountYuan: 29.9, status: 'paid', createdAt: new Date().toISOString() }],
  '/api/credits/ledger': { items: [{ id: 'credit-1', userId: 'end-user-1', username: 'customer-a', displayName: '个人用户 A', changeType: 'grant', pointsDelta: 1000, balanceAfter: 1880, note: '会员赠送', createdAt: new Date().toISOString() }], total: 1, page: 1, pageSize: 50, totalPages: 1 },
  '/api/redeem-codes': [{ id: 'code-1', codePreview: '****-ABCD', batchId: 'batch-1', batchName: '八月活动', rewardType: 'points', points: 100, status: 'unused', usedByUsername: '', createdAt: new Date().toISOString() }],
  '/api/redeem-code-batches': [{ id: 'batch-1', name: '八月活动', quantity: 10, status: 'enabled' }],
  '/api/redeem-codes/membership-options': [{ id: 'pro', name: '专业会员' }],
  '/api/platform-settings': { systemName: 'Agent AI 测试平台', systemSubtitle: '总控制中心', primaryColor: '#4f46e5', logoText: 'AI', buildCenterUrl: 'https://build.example.com', buildCenterTokenConfigured: true, artifactStorageMode: 'oss', ossBucket: 'agent-builds', ossAccessKeySecretConfigured: true, smtpHost: 'smtp.example.com', smtpPort: 465, smtpUser: 'mailer', smtpPassConfigured: true, smtpFromEmail: 'noreply@example.com', modelGatewayBaseUrl: 'https://models.example.com', modelGatewayKeyConfigured: true },
  '/api/custom-homepage': { enabled: true, configured: true, updatedAt: new Date().toISOString(), sourceName: 'acceptance-fixture.zip', fileCount: 3, totalBytes: 4096, previewUrl: '/_custom-homepage/', limits: { archiveBytes: 52428800, extractedBytes: 209715200, files: 2000, htmlBytes: 2097152 } },
  '/api/self-update/status': { configured: true, currentVersion: '1.2.3-test.ui.1', latestVersion: '1.2.3-test.ui.1', updateAvailable: false, manifestUrl: 'https://updates.example.com/admin/latest.json', releaseNotes: '测试版本/测试代码，请勿更新', history: [{ version: '1.2.3-test.ui.1', publishedAt: '2026-08-14T08:00:00Z', releaseNotes: '测试版本/测试代码，请勿更新' }, { version: '1.2.2', publishedAt: '2026-08-13T08:00:00Z', releaseNotes: '修复智能体保存问题。' }], lastLog: 'Version check completed: no update available.' },
  '/api/diagnostics': { generatedAt: new Date().toISOString(), version: '1.2.3-test.ui.1', node: 'v24.14.0', pm2Name: 'agent-ai-admin-test', listen: 'http://127.0.0.1:7467', apiCheckUrl: 'https://example.com/api/me', clientRegisterUrl: 'https://example.com/api/client/auth/register', updateCheckExampleUrl: 'https://example.com/updates/<项目ID>/latest.yml', updateCheckUrls: [{ projectId: 'project-personal', latestUrl: 'https://example.com/updates/project-personal/latest.yml' }], recentBuilds: [{ id: 'build-2', projectId: 'project-personal', status: 'succeeded' }] },
  '/api/logout': null,
}

if (process.env.ADMIN_HISTORY_PREVIEW === '1') {
  const readArchive = name => JSON.parse(fs.readFileSync(new URL(`../../../docs/${name}`, import.meta.url), 'utf8'))
  const admin = readArchive('ADMIN_RELEASE_ARCHIVE.json'), agent = readArchive('AGENT_RELEASE_ARCHIVE.json')
  responses['/api/self-update/status'] = { configured: true, runningVersion: admin[0].version, currentVersion: admin[0].version, latestVersion: admin[0].version, updateAvailable: false, manifestUrl: 'https://updates.example.com/admin/latest.json', releaseNotes: admin[0].releaseNotes, history: admin, lastLog: '本地交互预览：已读取 Git 版本档案。' }
  responses['/api/source-version'] = { configured: true, ...agent[0], history: agent }
}

const usageMetrics={inputTokens:null,outputTokens:150,cachedTokens:0,images:2,audioCharacters:20,audioSeconds:1.5,completeness:{inputTokens:1}};
const usageUser={...usageMetrics,userId:'end-user-1',username:'customer-a',displayName:'个人用户 A',organizationName:'测试组织',projectName:'测试项目',requests:6,activeDays:2,points:6,lastUsedAt:'2026-10-09 12:00:00'};
const usageSummary={...usageMetrics,users:1,requests:6,points:6};
const usageTrend=[{date:'2026-10-08',users:1,requests:2,points:2},{date:'2026-10-09',users:1,requests:4,points:4}];
const usagePage={items:[usageUser],total:1,page:1,pageSize:20,totalPages:1};
responses['/api/reports/user-usage/options']={projects:[{id:'p',name:'测试项目'}],models:[{id:'text-model',name:'文本模型'}]};
responses['/api/reports/user-usage/overview']={summary:usageSummary,trend:usageTrend,notes:['免费调用计入已完成请求，缺失计量显示未记录。']};
responses['/api/reports/user-usage/users']=usagePage;
responses['/api/reports/user-usage/users/end-user-1']={user:usageUser,summary:usageSummary,trend:usageTrend,models:[{...usageSummary,model:'text-model',type:'text'}],calls:{...usagePage,items:[{...usageMetrics,id:'call',requestId:'request',usedAt:'2026-10-09 12:00:00',points:6,model:'text-model',type:'text'}]}};

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url || '/', `http://${req.headers.host}`).pathname
  if (path === '/api/curated-agents' && req.method === 'POST') {
    const body = await readBody(req)
    const created = { ...body, status: 'draft', dependencies: [...(body.skillIds || []).map((id) => ({ type: 'skill', id, required: true })), ...(body.mcpIds || []).map((id) => ({ type: 'mcp', id, required: true }))], editable: true, updatedAt: new Date().toISOString() }
    agents.unshift(created)
    res.writeHead(201, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ success: true, data: created }))
    return
  }
  if (req.method === 'GET' && path === '/api/curated-skills/skill-1') {
    const detail = { ...skills[0], marketTypes: ['personal'], versions: [{ id: 'skill-version-1', version: '1.0.0', releaseNotes: '首个稳定版本', status: 'published', createdAt: new Date().toISOString() }] }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ success: true, data: detail }))
    return
  }
  if (req.method === 'GET' && path === '/api/curated-mcps/mcp-1') {
    const detail = { ...mcps[0], marketTypes: ['personal'], versions: [{ id: 'mcp-version-1', version: '1.0.0', releaseNotes: '固定依赖版本', status: 'published', createdAt: new Date().toISOString() }] }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ success: true, data: detail }))
    return
  }
  if (!(path in responses)) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ success: false, error: `Mock route not found: ${path}` }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ success: true, data: responses[path] }))
})

server.listen(PORT, '127.0.0.1', () => console.log(`Admin mock API listening on http://127.0.0.1:${PORT}`))
