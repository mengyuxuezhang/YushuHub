    const $ = (id) => document.getElementById(id);
    const apiPrefix = window.location.pathname.startsWith('/ai-admin') ? '/ai-admin' : '';
    const centerSupplierManagementEnabled = window.CENTER_SUPPLIER_MANAGEMENT_ENABLED;
    let me = null, users = [], userGroups = [], roleTemplates = [], projects = [], builds = [], workers = [], centerSuppliers = [], endUsers = [], membershipCards = [], membershipModelOptions = [], paymentConfigs = [], paymentOrders = [], creditLedger = [], redeemCodes = [], redeemBatches = [], redeemMembershipOptions = [], modelProviders = [], modelProviderKeys = [], providerModels = [], modelPricingRules = [], curatedSkills = [], curatedDistributions = [], curatedMcps = [], curatedMcpDistributions = [], curatedAgents = [], curatedAgentDistributions = [], permissionCatalog = [], sourceInfo = { version: '' }, platformSettings = {}, supplierLicense = {}, selfUpdate = null, modelServiceUpdate = null, curatedSkillUpdate = null, curatedMcpUpdate = null, curatedAgentUpdate = null, diagnostics = null, selectedBuildLogId = '', selectedCuratedSkillId = '', selectedCuratedMcpId = '', selectedCuratedAgentId = '', curatedSyncJobId = '', curatedMcpSyncJobId = '', curatedAgentSyncJobId = '', activePermissionTab = 'roleTemplates', activeRoleTemplateTab = 'info', activeMembershipTab = 'basic', activePaymentTab = 'config', permissionEditorDirty = false, paymentSettingsDirty = { wechat: false, alipay: false }, platformSettingsDirty = false, dismissedModelUpdateSignature = '', dismissedCuratedUpdateSignature = '', dismissedCuratedMcpUpdateSignature = '', dismissedCuratedAgentUpdateSignature = '', forcedUpdateInProgress = false, curatedSyncRunning = false, curatedMcpSyncRunning = false, curatedAgentSyncRunning = false, operationToastTimer = null, refreshInFlight = null, liveRefreshInFlight = null, remoteStatusLoading = true;
    let creditLedgerPage = { total: 0, page: 1, pageSize: 20, totalPages: 1, filteredConsumed: 0, totalConsumed: 0 };
    let userPermissions = new Set();
    let endUserModelAccessTargetId = '', endUserMembershipTargetId = '', endUserModelAccessModels = [], endUserAllowedModelIds = [], userGroupMemberTargetId = '', userGroupMemberIds = [], userGroupPermissionTargetId = '', userGroupPermissionKeys = [];
    const pageMeta = {
      dashboard: ['仪表盘', '运营全景概览 · 数据实时聚合'],
      projectList: ['AI 项目', '查看 AI 项目、版本状态和测试版打包进度'],
      projectEditor: ['新建/编辑项目', '维护贴牌资料、客户端菜单和品牌展示信息'],
      builds: ['构建发布', 'Windows 构建机任务、测试包与正式更新'],
      agents: ['后台账号', '为组织管理员、运营、财务、技术和只读岗位分配登录账号'],
      organizations: ['组织主体', '管理平台、一级代理、二级代理及其可转授能力'],
      userGroups: ['账号分组', '按组织、渠道或岗位沉淀后台账号分组'],
      permissions: ['权限管理', '统一规划角色、权限点和菜单可见性'],
      authStatus: ['授权状态', '查看官方构建中心授予当前供应商的能力边界'],
      centerSuppliers: ['供应商接入', '分配官方构建中心的供应商 ID 和 Token'],
      platformBrand: ['后台品牌', '配置后台名称、品牌标识和主题色'],
      platformBuildCenter: ['官方构建中心', '维护供应商接入地址和授权凭据'],
      platformStorage: ['安装包存储', '配置构建产物的本地或 OSS 托管方式'],
      platformEmail: ['邮件服务', '配置终端用户验证码和密码找回邮件'],
      updates: ['系统更新', '检查并应用 AI 管理后台的新版本'],
      diagnostics: ['系统诊断', '公网访问、更新文件和运行日志排查'],
      security: ['账号安全', '修改当前登录账号密码'],
      licenses: ['安装包授权', '后续用于控制安装包注册、设备绑定和授权状态'],
      endUsers: ['终端用户', '管理客户端注册用户、渠道来源和账号状态'],
      memberships: ['会员卡', '创建会员等级、套餐和会员权益说明'],
      paymentConfig: ['支付配置', '配置当前管理账号的微信与支付宝收款渠道'],
      paymentOrders: ['支付订单', '查询会员支付订单并同步渠道支付状态'],
      keys: ['消耗流水', '终端用户模型调用扣费和积分变动记录'],
      redeemCodes: ['兑换码', '批量生成积分或会员卡兑换码并追踪兑换状态'],
      providers: ['服务商', '维护 OpenAI 兼容供应商和默认接入策略'],
      modelKeys: ['Key 池', '维护当前账号 Key 池，终端用户按来源账号自动轮询可用 Key'],
      providerModels: ['模型管理', '维护不同服务商对应的上游模型和展示名称'],
      pricingRules: ['计费规则', '按服务商和模型维护按次或按 token 的积分价格'],
      mcp: ['精选 MCP', '发布固定版本、安全校验并默认停用的托管 MCP'],
      skills: ['精选技能市场', '官方技能发布、签名保护、会员授权与二级分发'],
      curatedAgents: ['精选专家', '配置专家、必需技能与 MCP，并在依赖权限完整后分发'],
    };
    const plannedContent = {
      licenses: ['安装包授权', '注册激活、设备绑定、试用期、离线授权和封禁策略会放在这里。', ['授权码/机器码管理', '版本可用范围', '试用与到期策略']],
    };
    const defaultClientMenus = [
      { key: 'chat', label: '聊天', path: '/chat', order: 10 },
      { key: 'dashboard', label: '仪表盘', path: '/', order: 20 },
      { key: 'sessions', label: '历史对话', path: '/sessions', order: 40 },
      { key: 'scheduled', label: '定时任务', path: '/scheduled-tasks', order: 50 },
      { key: 'phone', label: '手机控制', path: '/phone', order: 60 },
      { key: 'mcp', label: 'MCP 配置', path: '/mcp', order: 70 },
      { key: 'skills', label: '技能管理', path: '/skills', order: 80 },
      { key: 'about', label: '关于我们', path: '/about', order: 90 },
      { key: 'settings', label: '通用设置', path: '/settings', order: 100 },
    ];

    async function api(path, options = {}) {
      const response = await fetch(apiPrefix + path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) throw new Error(data.error || '请求失败');
      return data.data;
    }
    function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
    const organizationView = window.createOrganizationView({ api, $, escapeHtml, can: (key) => can(key), getMe: () => me });
    function setActionFeedback(elementId, message = '', tone = '') {
      const element = $(elementId);
      if (!element) return;
      element.textContent = message;
      element.className = 'action-feedback' + (tone ? (' ' + tone) : '') + (message ? '' : ' hidden');
    }
    function showOperationToast(message, tone = 'succeeded') {
      const region = $('operationToastRegion');
      if (!region) return;
      if (operationToastTimer) clearTimeout(operationToastTimer);
      region.innerHTML = '<div class="operation-toast ' + escapeHtml(tone) + '" role="status">' + escapeHtml(message) + '</div>';
      operationToastTimer = setTimeout(() => { region.innerHTML = ''; operationToastTimer = null; }, tone === 'failed' ? 6500 : 4000);
    }
    async function runActionWithFeedback({ button, busyText, messageId, successMessage, action }) {
      const restoreButton = setButtonBusy(button, busyText);
      setActionFeedback(messageId, busyText, 'running');
      try {
        const value = await action();
        const message = typeof successMessage === 'function' ? successMessage(value) : successMessage;
        setActionFeedback(messageId, message, 'succeeded');
        showOperationToast(message, 'succeeded');
        return { ok: true, value };
      } catch (error) {
        const message = '操作失败：' + (error?.message || '未知错误');
        setActionFeedback(messageId, message, 'failed');
        showOperationToast(message, 'failed');
        return { ok: false, error };
      } finally {
        restoreButton();
      }
    }
    function formatBytes(value) {
      const bytes = Number(value || 0);
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let size = bytes;
      let index = 0;
      while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
      return (index === 0 ? size.toFixed(0) : size.toFixed(size >= 10 ? 1 : 2)) + ' ' + units[index];
    }
    function transferProgressHtml(progress, compact = false) {
      if (!progress || !progress.status || progress.status === 'completed' || progress.status === 'cancelled') return '';
      const percent = Math.max(0, Math.min(100, Number(progress.overallPercent || progress.currentFilePercent || 0)));
      const currentFile = progress.currentFile ? escapeHtml(progress.currentFile) : '准备同步测试包';
      const fileText = progress.totalFiles ? escapeHtml((progress.currentFileIndex || 0) + '/' + progress.totalFiles) : '';
      const byteText = progress.totalBytes ? formatBytes(progress.transferredBytes) + ' / ' + formatBytes(progress.totalBytes) : formatBytes(progress.transferredBytes);
      const label = progress.status === 'failed' ? ('同步失败：' + escapeHtml(progress.error || '请查看日志')) : currentFile;
      const detail = compact ? Math.floor(percent) + '%' : [fileText, byteText, Math.floor(percent) + '%'].filter(Boolean).join(' · ');
      return '<div class="transfer-progress"><div class="progress-meta"><span>' + label + '</span><span>' + escapeHtml(detail) + '</span></div><div class="progress-track"><div class="progress-fill" style="width:' + percent + '%"></div></div></div>';
    }
    function statusText(status) { return { queued: '排队中', running: '构建中', succeeded: '已完成', failed: '失败' }[status] || status || '-'; }
    function roleText(role) { return role === 'admin' ? '管理岗位' : '业务岗位'; }
    function userStatusText(status) { return status === 'disabled' ? '已停用' : '启用中'; }
    function ownerName(id) { const user = users.find((item) => item.id === id); return user?.displayName || user?.username || '-'; }
    function ownerLabel(item = {}) {
      return item.ownerDisplayName || item.ownerUsername || ownerName(item.ownerUserId) || item.ownerUserId || '-';
    }
    function ownerSourceHtml(item = {}) {
      const name = ownerLabel(item);
      const role = item.ownerRole ? roleText(item.ownerRole) : '';
      const readonly = item.canOperate === false ? '<span class="tag neutral">只读</span>' : '';
      return '<strong>' + escapeHtml(name) + '</strong>' + (role ? '<div class="muted small">' + escapeHtml(role) + '</div>' : '') + (item.ownerUserId ? '<div class="muted small mono">' + escapeHtml(item.ownerUserId) + '</div>' : '') + readonly;
    }
    function isCenterDelegatedBuild(build = {}) { return Boolean(String(build.centerSupplierId || '').trim()); }
    function buildSourceHtml(build = {}) {
      if (!isCenterDelegatedBuild(build)) return ownerSourceHtml(build);
      const supplier = centerSuppliers.find((item) => item.id === build.centerSupplierId);
      const supplierName = supplier?.name || build.centerSupplierId;
      const requestedBy = build.requestedBy ? '<div class="muted small">请求账号：' + escapeHtml(build.requestedBy) + '</div>' : '';
      return '<strong>供应商代构建</strong><div class="muted small">' + escapeHtml(supplierName) + '</div><div class="muted small mono">' + escapeHtml(build.centerSupplierId) + '</div>' + requestedBy + '<span class="tag neutral">只读</span>';
    }
    function agentAccountName(id) { const user = users.find((item) => item.id === id || item.username === id); return user?.username || id || '-'; }
    function sourceAgentAccount(user) {
      const direct = user?.sourceAgentId ? agentAccountName(user.sourceAgentId) : '';
      if (direct) return direct;
      const project = user?.sourceProjectId ? projects.find((item) => item.id === user.sourceProjectId) : null;
      return project?.ownerUserId ? agentAccountName(project.ownerUserId) : '';
    }
    function sourceProjectInfo(source = {}) {
      const projectId = source.sourceProjectId || source.usedSourceProjectId || source.usedUserSourceProjectId || '';
      const centerProjectId = source.centerProjectId || source.usedCenterProjectId || source.usedUserCenterProjectId || '';
      const project = projectId ? projects.find((item) => item.id === projectId) : null;
      return {
        id: projectId,
        centerId: centerProjectId,
        name: project?.appName || project?.brandName || project?.shortName || '',
      };
    }
    function sourceProjectHtml(source = {}) {
      const info = sourceProjectInfo(source);
      const lines = [];
      if (info.name) lines.push('项目：' + info.name);
      if (info.id) lines.push('项目ID：' + info.id);
      if (info.centerId && info.centerId !== info.id) lines.push('中心ID：' + info.centerId);
      if (source.channelCode || source.usedChannelCode || source.usedUserChannelCode) lines.push('渠道：' + (source.channelCode || source.usedChannelCode || source.usedUserChannelCode));
      return lines.length ? lines.map((line) => '<div>' + escapeHtml(line) + '</div>').join('') : '';
    }
    function sourceDeviceHtml(source = {}) {
      const deviceName = source.deviceName || source.usedDeviceName || source.usedUserDeviceName || '';
      const deviceId = source.deviceId || source.usedDeviceId || source.usedUserDeviceId || '';
      const appVersion = source.appVersion || source.usedAppVersion || source.usedUserAppVersion || '';
      return '<div>' + escapeHtml(deviceName || '-') + '</div><div>版本：' + escapeHtml(appVersion || '-') + '</div><div class="mono">' + escapeHtml(shortId(deviceId || '')) + '</div>';
    }
    function syncUserPermissions() { userPermissions = new Set(Array.isArray(me?.permissionKeys) ? me.permissionKeys : []); }
    function can(permissionKey) { return userPermissions.has(permissionKey); }
    function canAny(permissionKeys) { return permissionKeys.some((key) => can(key)); }
    function hasSupplierAbility(field) { return centerSupplierManagementEnabled || supplierLicense[field] !== false; }
    function canManageModelService() { return canAny(['model_providers.manage', 'model_keys.manage', 'provider_models.manage', 'pricing_rules.manage']); }
    function canCustomizeApiProviders() { return canManageModelService() && hasSupplierAbility('allowCustomApiProviders'); }
    function canWriteModelProviders() { return canCustomizeApiProviders() && me.role !== 'agent'; }
    function customApiProviderDeniedMessage() { return '当前供应商授权未开通自定义 API 服务商，请使用总后台默认服务商'; }
    function modelProviderWriteDeniedMessage() { return me.role === 'agent' ? '代理商账号只能查看和同步服务商，不能新增、编辑、禁用或删除服务商' : customApiProviderDeniedMessage(); }
    function syncAbilityTabs() {
      if (!me) return;
      const canManageAgents = can('users.manage') && hasSupplierAbility('allowAgentManagement');
      const canViewOrganizations = can('organizations.view');
      const canManageGroups = can('user_groups.manage') && hasSupplierAbility('allowAgentManagement');
      const canManagePermissions = can('permissions.manage') && hasSupplierAbility('allowAgentManagement');
      const canViewAuthStatus = can('authorization.view');
      const canManageCenterSuppliers = can('center_suppliers.manage') && centerSupplierManagementEnabled && hasSupplierAbility('allowSupplierManagement');
      const canOpenUserCenter = canViewOrganizations || canManageAgents || canManageGroups || canManagePermissions || canViewAuthStatus || canManageCenterSuppliers;
      $('userCenterTab').classList.toggle('hidden', !canOpenUserCenter);
      $('userCenterTab').dataset.tab = canViewOrganizations ? 'organizations' : canManageAgents ? 'agents' : canManageGroups ? 'userGroups' : canManagePermissions ? 'permissions' : canViewAuthStatus ? 'authStatus' : 'centerSuppliers';
      $('userCenterSubnav').classList.toggle('hidden', !canOpenUserCenter);
      $('organizationsSubtab').classList.toggle('hidden', !canViewOrganizations);
      $('agentsSubtab').classList.toggle('hidden', !canManageAgents);
      $('userGroupsSubtab').classList.toggle('hidden', !canManageGroups);
      document.querySelectorAll('.subtab[data-tab="permissions"]').forEach((item) => item.classList.toggle('hidden', !canManagePermissions));
      document.querySelectorAll('.subtab[data-tab="authStatus"]').forEach((item) => item.classList.toggle('hidden', !canViewAuthStatus));
      $('centerSuppliersTab').classList.toggle('hidden', !canManageCenterSuppliers);
      $('platformTab').classList.toggle('hidden', !can('platform_settings.manage') || !hasSupplierAbility('allowPlatformSettings'));
      document.querySelectorAll('.tab[data-tab="projectList"]').forEach((item) => item.classList.toggle('hidden', !can('projects.manage')));
      document.querySelectorAll('.tab[data-tab="builds"]').forEach((item) => item.classList.toggle('hidden', !canAny(['builds.create', 'builds.publish'])));
      document.querySelectorAll('.tab[data-tab="endUsers"]').forEach((item) => item.classList.toggle('hidden', !can('end_users.manage')));
      document.querySelectorAll('.tab[data-tab="memberships"]').forEach((item) => item.classList.toggle('hidden', !can('memberships.manage')));
      document.querySelectorAll('.tab[data-group="payments"]').forEach((item) => item.classList.toggle('hidden', !can('payments.manage')));
      document.querySelectorAll('.subnav[data-parent="payments"] .subtab').forEach((item) => item.classList.toggle('hidden', !can('payments.manage')));
      document.querySelectorAll('.tab[data-tab="keys"]').forEach((item) => item.classList.toggle('hidden', !can('credits.manage')));
      document.querySelectorAll('.tab[data-tab="redeemCodes"]').forEach((item) => item.classList.toggle('hidden', !can('redeem_codes.manage')));
      $('modelServiceTab').classList.toggle('hidden', !canManageModelService());
      $('modelServiceTab').dataset.tab = canManageModelService() ? 'providers' : 'security';
      $('modelServiceSubnav').classList.toggle('hidden', !canManageModelService());
      $('providersSubtab').classList.toggle('hidden', !canManageModelService());
      document.querySelectorAll('.subtab[data-tab="modelKeys"]').forEach((item) => item.classList.toggle('hidden', !can('model_keys.manage')));
      document.querySelectorAll('.subtab[data-tab="providerModels"]').forEach((item) => item.classList.toggle('hidden', !can('provider_models.manage')));
      document.querySelectorAll('.subtab[data-tab="pricingRules"]').forEach((item) => item.classList.toggle('hidden', !can('pricing_rules.manage')));
      $('checkLegacyModelKeyBtn').classList.toggle('hidden', !can('platform_settings.manage'));
      $('updatesTab').classList.toggle('hidden', !can('self_update.manage'));
      $('diagnosticsTab').classList.toggle('hidden', !can('diagnostics.view'));
      document.querySelectorAll('.tab[data-tab="skills"]').forEach((item) => item.classList.toggle('hidden', !canAny(['curated_skills.view', 'curated_skills.distribute'])));
      document.querySelectorAll('.tab[data-tab="mcp"]').forEach((item) => item.classList.toggle('hidden', !canAny(['curated_mcps.view', 'curated_mcps.distribute'])));
      document.querySelectorAll('.tab[data-tab="curatedAgents"]').forEach((item) => item.classList.toggle('hidden', !canAny(['curated_agents.view', 'curated_agents.distribute'])));
    }
    function buildFileUrl(baseUrl, fileName) {
      if (!baseUrl || !fileName) return '';
      const encoded = encodeURIComponent(fileName).replace(/%2F/g, '/');
      try {
        const parsed = new URL(baseUrl);
        return '//' + parsed.host + parsed.pathname.replace(/\/$/, '') + '/' + encoded;
      } catch {
        return baseUrl.replace(/\/$/, '') + '/' + encoded;
      }
    }
    function installerFile(build) {
      return (build.files || []).find((name) => String(name).toLowerCase().endsWith('.exe')) || '';
    }
    function isActiveBuild(build) { return build?.status === 'queued' || build?.status === 'running'; }
    function activeBuildForProject(projectId) { return builds.find((b) => b.projectId === projectId && isActiveBuild(b)) || null; }
    function latestBuildForProject(projectId) { return builds.filter((b) => b.projectId === projectId).sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0] || null; }
    function shortId(value) { return String(value || '').slice(0, 8); }
    function buildProgressText(build) {
      if (!build) return '';
      const worker = build.claimedBy ? ' · 构建机 ' + build.claimedBy : '';
      return statusText(build.status) + '：' + shortId(build.id) + worker + ' · ' + formatTime(build.updatedAt || build.createdAt);
    }
    function latestReleasedBuild(projectId) { return builds.filter((b) => b.projectId === projectId && b.status === 'succeeded' && b.releasedAt).sort((a, b) => String(b.releasedAt || b.finishedAt || b.updatedAt || '').localeCompare(String(a.releasedAt || a.finishedAt || a.updatedAt || '')))[0] || null; }
    function projectVersionState(project) {
      const latest = latestReleasedBuild(project.id);
      if (!latest) return { text: '未发布', stale: true };
      if (sourceInfo.version && latest.version !== sourceInfo.version) return { text: 'Agent 可更新：v' + sourceInfo.version, stale: true };
      return { text: '已同步 v' + (latest.version || '-'), stale: false };
    }
    function suggestId(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
    function formatTime(value) { const date = new Date(value || ''); return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', { hour12: false }); }
    function formatPoints(value) { return Number(value || 0).toFixed(6).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1'); }
    function formatUsd(value) { return '$' + Number(value || 0).toFixed(6).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1'); }
    function ledgerTypeText(type) { return { recharge: '充值', redeem: '兑换', adjust: '调整', consume: '消费' }[type] || type || '-'; }
    function fileToDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); }
    async function uploadFromInput(inputId, targetId, previewId) {
      const file = $(inputId).files?.[0]; if (!file) return;
      const dataUrl = await fileToDataUrl(file);
      const saved = await api('/api/uploads', { method: 'POST', body: JSON.stringify({ filename: file.name, dataUrl }) });
      $(targetId).value = saved.url; $(previewId).src = saved.url;
    }
    function showUploadError(error) {
      const message = error?.message || '上传失败，请检查图片格式和大小';
      $('formMsg').textContent = message;
      alert(message);
    }
    const defaultLoginContent = {
      kicker: 'AI OPERATIONS PLATFORM', panelEyebrow: '安全访问', panelTitle: '用户登录', panelSubtitle: '登录管理控制台',
      accountLabel: '账号', accountPlaceholder: '请输入管理员或代理商账号', passwordLabel: '密码', passwordPlaceholder: '请输入密码',
      submitText: '登录', securityText: '连接已加密，请使用授权账号登录', interactionHint: '拖动旋转 · 双击恢复',
      signals: [
        { title: 'AI Agent', subtitle: '专家编排' }, { title: '智能决策', subtitle: '模型驱动分析' },
        { title: 'RPA 自动化', subtitle: '流程自动执行' }, { title: '数据分析', subtitle: '洞察业务趋势' },
      ],
      capabilities: [
        { title: 'AI 专家', subtitle: '自主学习，智能决策' }, { title: 'RPA 自动化', subtitle: '流程自动化，降本增效' },
        { title: '数据驱动', subtitle: '洞察数据，驱动业务' }, { title: '安全可靠', subtitle: '企业级安全保障' },
      ],
    };
    function normalizeLoginContentClient(value = {}) {
      const raw = value && typeof value === 'object' ? value : {};
      const mergePairs = (key) => defaultLoginContent[key].map((fallback, index) => ({ ...fallback, ...(Array.isArray(raw[key]) ? raw[key][index] : {}) }));
      return { ...defaultLoginContent, ...raw, signals: mergePairs('signals'), capabilities: mergePairs('capabilities') };
    }
    const crystalFaceKeys = ['front', 'back', 'right', 'left', 'top', 'bottom'];
    function normalizeCrystalFaceTextsClient(value = {}) {
      const raw = value && typeof value === 'object' ? value : {};
      return Object.fromEntries(crystalFaceKeys.map((key) => [key, Object.prototype.hasOwnProperty.call(raw, key) ? String(raw[key] ?? '').trim().slice(0, 12) : '']));
    }
    function applyPlatformSettings(settings = {}) {
      platformSettings = settings || {};
      const systemName = platformSettings.systemName || 'AI 管理后台';
      const subtitle = platformSettings.systemSubtitle || '贴牌构建、代理权限与发布管理';
      const loginTitle = platformSettings.loginTitle || systemName;
      const loginSubtitle = platformSettings.loginSubtitle || subtitle;
      const loginContent = normalizeLoginContentClient(platformSettings.loginContent);
      const crystalFaceTexts = normalizeCrystalFaceTextsClient(platformSettings.crystalFaceTexts);
      const primaryColor = platformSettings.primaryColor || '#1677ff';
      const configuredLogoText = Object.prototype.hasOwnProperty.call(platformSettings, 'logoText') ? String(platformSettings.logoText ?? '').slice(0, 4) : 'Y';
      document.title = systemName;
      document.querySelectorAll('#appView .brand h1').forEach((item) => item.textContent = systemName);
      document.querySelectorAll('#appView .brand .small').forEach((item) => item.textContent = subtitle);
      document.querySelectorAll('#loginView .brand-mark, #appView .brand-mark').forEach((item) => { item.textContent = configuredLogoText; item.style.background = primaryColor; });
      if ($('loginBrandName')) $('loginBrandName').textContent = systemName;
      if ($('loginBrandSubtitle')) $('loginBrandSubtitle').textContent = subtitle;
      if ($('loginHeroTitle')) $('loginHeroTitle').textContent = loginTitle;
      if ($('loginHeroSubtitle')) $('loginHeroSubtitle').textContent = loginSubtitle;
      const loginTextBindings = {
        loginKicker: loginContent.kicker, loginPanelEyebrow: loginContent.panelEyebrow, loginPanelTitle: loginContent.panelTitle,
        loginPanelSubtitle: loginContent.panelSubtitle, loginAccountLabel: loginContent.accountLabel, loginPasswordLabel: loginContent.passwordLabel,
        loginSubmitText: loginContent.submitText, loginSecurityText: loginContent.securityText, loginInteractionHint: loginContent.interactionHint,
      };
      Object.entries(loginTextBindings).forEach(([id, value]) => { if ($(id)) $(id).textContent = value; });
      if ($('loginUser')) $('loginUser').placeholder = loginContent.accountPlaceholder;
      if ($('loginPass')) $('loginPass').placeholder = loginContent.passwordPlaceholder;
      loginContent.signals.forEach((item, index) => {
        if ($('loginSignalTitle' + index)) $('loginSignalTitle' + index).textContent = item.title;
        if ($('loginSignalSubtitle' + index)) $('loginSignalSubtitle' + index).textContent = item.subtitle;
      });
      loginContent.capabilities.forEach((item, index) => {
        if ($('loginCapabilityTitle' + index)) $('loginCapabilityTitle' + index).textContent = item.title;
        if ($('loginCapabilitySubtitle' + index)) $('loginCapabilitySubtitle' + index).textContent = item.subtitle;
      });
      crystalFaceKeys.forEach((key) => {
        const id = 'loginCrystalFace' + key.charAt(0).toUpperCase() + key.slice(1);
        if ($(id)) $(id).textContent = crystalFaceTexts[key];
      });
      if ($('loginCopyrightName')) $('loginCopyrightName').textContent = systemName;
      if ($('loginCopyrightYear')) $('loginCopyrightYear').textContent = String(new Date().getFullYear());
      if ($('loginView')) {
        const backgroundUrl = platformSettings.loginBackgroundUrl || '';
        $('loginView').style.setProperty('--login-background-image', backgroundUrl ? ('url(' + JSON.stringify(backgroundUrl) + ')') : 'none');
        $('loginView').style.setProperty('--login-panel-color', platformSettings.loginPanelColor || '#0b2142');
      }
      document.documentElement.style.setProperty('--primary-color', primaryColor);
    }
    async function loadPublicPlatformSettings() {
      try {
        const settings = await api('/api/public-settings');
        applyPlatformSettings(settings);
        return settings;
      } catch {
        applyPlatformSettings(platformSettings);
        return platformSettings;
      }
    }
    function renderClientMenuEditor(menus = []) {
      const configs = Array.isArray(menus) ? menus : [];
      const byKey = new Map(configs.map((item) => [item.key, item]));
      const builtInRows = defaultClientMenus.map((base) => ({ ...base, ...(byKey.get(base.key) || {}), type: 'route', builtIn: true }));
      const externalRows = configs.filter((item) => (item.type === 'external' || item.url) && !defaultClientMenus.some((base) => base.key === item.key)).map((item, index) => ({ ...item, type: 'external', builtIn: false, order: item.order || 200 + index }));
      $('clientMenuRows').innerHTML = [...builtInRows, ...externalRows].sort((a, b) => Number(a.order || 0) - Number(b.order || 0)).map((item) => {
        const visible = item.visible !== false;
        const typeText = item.type === 'external' ? '外部链接' : '内置菜单';
        const target = item.type === 'external' ? (item.url || '') : (item.path || '');
        const readonly = item.type === 'external' ? '' : ' readonly';
        const removeButton = item.builtIn ? '<span class="muted small">内置</span>' : '<button type="button" class="secondary remove-menu-btn">删除</button>';
        const orderControl = '<div class="menu-order-wrap"><button type="button" class="ghost drag-menu-handle" draggable="true" title="拖拽排序">☰</button><input class="menu-order" type="number" value="' + escapeHtml(item.order || 0) + '" /></div>';
        const openMode = item.openMode === 'internal' ? 'internal' : 'system';
        const openModeControl = item.type === 'external' ? '<select class="menu-open-mode"><option value="system"' + (openMode === 'system' ? ' selected' : '') + '>系统浏览器打开</option><option value="internal"' + (openMode === 'internal' ? ' selected' : '') + '>客户端内置浏览器打开</option></select>' : '<span class="muted small">客户端内置</span>';
        const showAddressBar = item.showAddressBar !== false;
        const addressControl = item.type === 'external' ? '<label class="small"><input class="menu-show-address" type="checkbox" ' + (showAddressBar ? 'checked' : '') + (openMode === 'internal' ? '' : ' disabled') + ' /> 显示</label>' : '<span class="muted small">-</span>';
        return '<tr class="client-menu-row" draggable="false" data-key="' + escapeHtml(item.key) + '" data-type="' + escapeHtml(item.type) + '" data-path="' + escapeHtml(item.path || '') + '"><td><input class="menu-visible" type="checkbox" ' + (visible ? 'checked' : '') + ' /></td><td><input class="menu-label" autocomplete="off" value="' + escapeHtml(item.label || '') + '" /></td><td class="muted">' + typeText + '</td><td>' + orderControl + '</td><td>' + openModeControl + '</td><td>' + addressControl + '</td><td><input class="menu-url" value="' + escapeHtml(target) + '"' + readonly + ' /></td><td>' + removeButton + '</td></tr>';
      }).join('');
      bindClientMenuRows();
    }
    function updateClientMenuOrders() {
      Array.from(document.querySelectorAll('.client-menu-row')).forEach((row, index) => {
        const order = row.querySelector('.menu-order');
        if (order) order.value = String((index + 1) * 10);
      });
    }
    function bindClientMenuRows() {
      document.querySelectorAll('.remove-menu-btn').forEach((button) => button.onclick = () => { button.closest('tr')?.remove(); updateClientMenuOrders(); });
      document.querySelectorAll('.drag-menu-handle').forEach((handle) => {
        handle.ondragstart = (event) => {
          const row = handle.closest('tr');
          if (!row) return;
          row.classList.add('menu-row-dragging');
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', row.dataset.key || '');
        };
        handle.ondragend = () => {
          document.querySelectorAll('.menu-row-dragging').forEach((row) => row.classList.remove('menu-row-dragging'));
          updateClientMenuOrders();
        };
      });
      document.querySelectorAll('.client-menu-row').forEach((row) => {
        const openMode = row.querySelector('.menu-open-mode');
        const showAddress = row.querySelector('.menu-show-address');
        if (openMode && showAddress) openMode.onchange = () => { showAddress.disabled = openMode.value !== 'internal'; };
        row.ondragover = (event) => {
          const dragging = document.querySelector('.menu-row-dragging');
          if (!dragging || dragging === row) return;
          event.preventDefault();
          const rect = row.getBoundingClientRect();
          const after = event.clientY > rect.top + rect.height / 2;
          row.parentNode.insertBefore(dragging, after ? row.nextSibling : row);
        };
        row.ondrop = (event) => { event.preventDefault(); updateClientMenuOrders(); };
      });
    }
    function addClientMenuRow() {
      const key = 'link-' + Date.now().toString(36);
      const row = document.createElement('tr');
      row.className = 'client-menu-row';
      row.dataset.key = key;
      row.dataset.type = 'external';
      row.innerHTML = '<td><input class="menu-visible" type="checkbox" checked /></td><td><input class="menu-label" autocomplete="off" placeholder="使用教程" /></td><td class="muted">外部链接</td><td><div class="menu-order-wrap"><button type="button" class="ghost drag-menu-handle" draggable="true" title="拖拽排序">☰</button><input class="menu-order" type="number" value="200" /></div></td><td><select class="menu-open-mode"><option value="system">系统浏览器打开</option><option value="internal">客户端内置浏览器打开</option></select></td><td><label class="small"><input class="menu-show-address" type="checkbox" checked disabled /> 显示</label></td><td><input class="menu-url" placeholder="https://example.com" /></td><td><button type="button" class="secondary remove-menu-btn">删除</button></td>';
      $('clientMenuRows').appendChild(row);
      bindClientMenuRows();
      updateClientMenuOrders();
      row.querySelector('.menu-label').focus();
    }
    function collectClientMenus() {
      return Array.from(document.querySelectorAll('.client-menu-row')).map((row, index) => {
        const type = row.dataset.type || 'route';
        const visible = row.querySelector('.menu-visible').checked;
        const label = row.querySelector('.menu-label').value.trim();
        const order = Number(row.querySelector('.menu-order').value || index + 1);
        const target = row.querySelector('.menu-url').value.trim();
        const openMode = row.querySelector('.menu-open-mode')?.value === 'internal' ? 'internal' : 'system';
        const showAddressBar = row.querySelector('.menu-show-address')?.checked !== false;
        const key = row.dataset.key || suggestId(label) || 'menu-' + (index + 1);
        if (type === 'external') return { key, label, visible, order, type: 'external', url: target, openMode, showAddressBar };
        return { key, label, visible, order, type: 'route', path: row.dataset.path || target };
      }).filter((item) => {
        if (!item.visible) return Boolean(item.key);
        return item.type === 'external' ? Boolean(item.label && item.url) : Boolean(item.label && item.path);
      });
    }
    function collectProject() {
      return { id: $('id').value, ownerUserId: $('ownerUserId').value, clientMode: 'personal', appName: $('appName').value, brandName: $('brandName').value, shortName: $('shortName').value, logoUrl: $('logoUrl').value, iconUrl: $('iconUrl').value, contactQrUrl: $('contactQrUrl').value, loginLogoUrl: $('loginLogoUrl').value, loginBackgroundUrl: $('loginBackgroundUrl').value, loginTitle: $('loginTitle').value, loginSubtitle: $('loginSubtitle').value, loginHeroTitle: $('loginHeroTitle').value, loginHeroSubtitle: $('loginHeroSubtitle').value, modelTutorialUrl: $('modelTutorialUrl').value, themeColor: $('themeColor').value, aboutText: $('aboutText').value, status: $('projectStatus').value, menus: collectClientMenus() };
    }
    function projectOwnerSource(selectedId = '') {
      if (me.role !== 'admin') return [me];
      const self = users.find((item) => item.id === me.id) || me;
      const agents = users.filter((item) => item.role === 'agent' && (item.status !== 'disabled' || item.id === selectedId));
      return [self, ...agents.filter((item) => item.id !== self.id)];
    }
    function defaultProjectOwnerId(selectedId = '') {
      const source = projectOwnerSource(selectedId);
      return selectedId || source[0]?.id || me?.id || '';
    }
    function fillProject(project) {
      $('id').value = project?.id || ''; $('id').disabled = Boolean(project?.id); $('ownerUserId').value = defaultProjectOwnerId(project?.ownerUserId || '');
      $('appName').value = project?.appName || ''; $('brandName').value = project?.brandName || ''; $('shortName').value = project?.shortName || '';
      $('logoUrl').value = project?.logoUrl || ''; $('iconUrl').value = project?.iconUrl || ''; $('contactQrUrl').value = project?.contactQrUrl || ''; $('loginLogoUrl').value = project?.loginLogoUrl || ''; $('loginBackgroundUrl').value = project?.loginBackgroundUrl || ''; $('loginTitle').value = project?.loginTitle || ''; $('loginSubtitle').value = project?.loginSubtitle || ''; $('loginHeroTitle').value = project?.loginHeroTitle || ''; $('loginHeroSubtitle').value = project?.loginHeroSubtitle || ''; $('modelTutorialUrl').value = project?.modelTutorialUrl || ''; $('themeColor').value = project?.themeColor || '#2563eb';
      $('aboutText').value = project?.aboutText || ''; $('projectStatus').value = project?.status || 'enabled'; $('logoPreview').src = project?.logoUrl || ''; $('iconPreview').src = project?.iconUrl || ''; $('contactPreview').src = project?.contactQrUrl || ''; $('loginLogoPreview').src = project?.loginLogoUrl || project?.logoUrl || ''; $('loginBackgroundPreview').src = project?.loginBackgroundUrl || '';
      renderClientMenuEditor(project?.menus || []);
      $('formMsg').textContent = project ? '正在编辑：' + project.id : '';
      updateProjectBuildAction();
    }
    function updateProjectBuildAction() {
      const projectId = $('id').value;
      const project = projectId ? projects.find((item) => item.id === projectId) : null;
      const canOperateProject = !project || project.canOperate !== false;
      const active = projectId ? activeBuildForProject(projectId) : null;
      $('saveProjectBtn').disabled = !canOperateProject;
      $('buildBtn').disabled = !canOperateProject || Boolean(active);
      $('buildBtn').textContent = !canOperateProject ? '当前账号不可打包' : (active ? (active.status === 'running' ? '构建中' : '已排队') : '保存并打包测试版');
    }
    function renderRoleTemplateOptions(selectedId = '') {
      const select = $('agentRoleTemplate');
      if (!select) return;
      const options = roleTemplates.filter((item) => item.status !== 'disabled');
      select.innerHTML = '<option value="">请选择角色模板</option>' + options.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + '</option>').join('');
      select.value = options.some((item) => item.id === selectedId) ? selectedId : '';
      updateAgentTemplateHint();
    }
    function updateAgentTemplateHint() {
      const template = roleTemplates.find((item) => item.id === ($('agentRoleTemplate')?.value || ''));
      if ($('agentRole')) $('agentRole').value = 'admin';
      if ($('agentRoleTemplateHint')) $('agentRoleTemplateHint').textContent = template ? (template.description || ('已选择：' + template.name)) : '选择模板后直接使用该模板权限，无需再选择岗位类型。';
    }
    function collectAgent() {
      const template = roleTemplates.find((item) => item.id === ($('agentRoleTemplate')?.value || ''));
      if (!template) throw new Error('请选择角色模板');
      return { id: $('agentId').value, username: $('agentUsername').value, displayName: $('agentDisplayName').value, role: 'admin', roleTemplateId: template.id, dataScope: 'self', status: $('agentStatus').value, password: $('agentPassword').value, maxProjects: $('agentMaxProjects').value, maxBuilds: $('agentMaxBuilds').value };
    }
    function fillAgent(user) {
      const editing = Boolean(user?.id);
      $('agentId').value = user?.id || '';
      $('agentUsername').value = user?.username || '';
      $('agentUsername').disabled = editing;
      $('agentUsername').placeholder = editing ? '编辑时不能修改登录账号' : 'agent-a';
      $('agentDisplayName').value = user?.displayName || '';
      $('agentDataScope').value = user?.dataScope || 'self';
      const fallbackTemplateId = user ? (user.role === 'admin' ? 'supplier-admin' : 'agent-operator') : '';
      renderRoleTemplateOptions(user?.roleTemplateId || fallbackTemplateId);
      $('agentStatus').value = user?.status || 'enabled';
      $('agentPassword').value = '';
      $('agentPassword').placeholder = editing ? '留空表示不修改密码' : '新账号必填，至少 8 位';
      $('agentMaxProjects').value = user?.maxProjects || 0;
      $('agentMaxBuilds').value = user?.maxBuilds || 0;
      $('agentMsg').textContent = editing ? '正在编辑：' + (user.username || user.id) : '';
    }
    function collectUserGroup() { return { id: $('userGroupId').value, name: $('userGroupName').value, description: $('userGroupDescription').value, sortOrder: $('userGroupSortOrder').value, status: $('userGroupStatus').value }; }
    function renderUserGroupMembers() {
      const list = $('userGroupMemberList');
      if (!list) return;
      if (!userGroupMemberTargetId) {
        list.innerHTML = '<p class="muted">请先保存分组，再维护成员。</p>';
        $('saveUserGroupMembersBtn').disabled = true;
        return;
      }
      $('saveUserGroupMembersBtn').disabled = false;
      const selected = new Set(userGroupMemberIds || []);
      list.innerHTML = users.length ? users.map((user) => {
        return '<label class="card" style="display:flex;gap:10px;align-items:flex-start"><input class="user-group-member-check" type="checkbox" value="' + escapeHtml(user.id) + '" ' + (selected.has(user.id) ? 'checked' : '') + ' /><span><strong>' + escapeHtml(user.displayName || user.username) + '</strong><div class="muted small">' + escapeHtml(user.username) + ' · ' + escapeHtml(roleText(user.role)) + '</div></span></label>';
      }).join('') : '<p class="muted">暂无可选账号。</p>';
    }
    async function loadUserGroupMembers(groupId) {
      userGroupMemberTargetId = groupId || '';
      userGroupMemberIds = [];
      if (!userGroupMemberTargetId) {
        renderUserGroupMembers();
        return;
      }
      $('userGroupMembersMsg').textContent = '正在加载成员...';
      try {
        const data = await api('/api/user-groups/' + encodeURIComponent(userGroupMemberTargetId) + '/members');
        userGroupMemberIds = data.userIds || [];
        $('userGroupMembersMsg').textContent = '已加载 ' + userGroupMemberIds.length + ' 个成员';
      } catch (err) {
        $('userGroupMembersMsg').textContent = err.message;
      }
      renderUserGroupMembers();
    }
    function renderUserGroupPermissions() {
      const list = $('userGroupPermissionList');
      if (!list) return;
      if (!userGroupPermissionTargetId) {
        list.innerHTML = '<p class="muted">请先保存分组，再维护权限。</p>';
        $('saveUserGroupPermissionsBtn').disabled = true;
        return;
      }
      $('saveUserGroupPermissionsBtn').disabled = false;
      const selected = new Set(userGroupPermissionKeys || []);
      if (!Array.isArray(permissionCatalog) || permissionCatalog.length === 0) {
        list.innerHTML = '<p class="muted">暂无权限点数据。</p>';
        return;
      }
      list.innerHTML = permissionCatalog.map((group) => {
        const items = group.permissions || [];
        const rows = items.map((item) => {
          const constrained = item.supplierAbility ? supplierLicense[item.supplierAbility] !== false : true;
          const tags = [
            '<span class="status queued">' + escapeHtml(roleRequirementText(item.role)) + '</span>',
            item.supplierAbility ? '<span class="status ' + (constrained ? 'succeeded' : 'failed') + '">' + escapeHtml(item.supplierAbility) + '</span>' : '',
            item.officialCenterOnly ? '<span class="status running">仅官方总后台</span>' : '',
            item.planned ? '<span class="status queued">规划中</span>' : '',
          ].filter(Boolean).join(' ');
          return '<label class="card" style="display:flex;gap:10px;align-items:flex-start"><input class="user-group-permission-check" type="checkbox" value="' + escapeHtml(item.key) + '" ' + (selected.has(item.key) ? 'checked' : '') + ' /><span><strong>' + escapeHtml(item.name) + '</strong><div class="muted small">' + escapeHtml(item.description || '-') + '</div><div class="muted mono small">' + escapeHtml(item.key) + '</div><div style="margin-top:6px">' + tags + '</div></span></label>';
        }).join('');
        return '<div><h4>' + escapeHtml(group.group || '未分组') + '</h4><div class="plan-grid" style="grid-template-columns:1fr">' + rows + '</div></div>';
      }).join('');
    }
    async function loadUserGroupPermissions(groupId) {
      userGroupPermissionTargetId = groupId || '';
      userGroupPermissionKeys = [];
      if (!userGroupPermissionTargetId) {
        renderUserGroupPermissions();
        return;
      }
      $('userGroupPermissionsMsg').textContent = '正在加载权限...';
      try {
        const data = await api('/api/user-groups/' + encodeURIComponent(userGroupPermissionTargetId) + '/permissions');
        userGroupPermissionKeys = data.permissionKeys || [];
        $('userGroupPermissionsMsg').textContent = '已加载 ' + userGroupPermissionKeys.length + ' 个权限点';
      } catch (err) {
        $('userGroupPermissionsMsg').textContent = err.message;
      }
      renderUserGroupPermissions();
    }
    function fillUserGroup(group) {
      $('userGroupId').value = group?.id || '';
      $('userGroupName').value = group?.name || '';
      $('userGroupDescription').value = group?.description || '';
      $('userGroupSortOrder').value = group?.sortOrder || 0;
      $('userGroupStatus').value = group?.status || 'enabled';
      $('saveUserGroupBtn').textContent = group?.id ? '保存分组' : '新建分组';
      $('userGroupMsg').textContent = group ? '正在编辑：' + group.name : '';
      loadUserGroupMembers(group?.id || '');
      loadUserGroupPermissions(group?.id || '');
    }
    function collectCenterSupplier() { return { id: $('centerSupplierId').value, name: $('centerSupplierName').value, status: $('centerSupplierStatus').value, licenseType: $('centerSupplierLicenseType').value, maxProjects: $('centerSupplierMaxProjects').value, maxBuilds: $('centerSupplierMaxBuilds').value, allowAgentManagement: $('centerSupplierAllowAgentManagement').checked, allowSupplierManagement: $('centerSupplierAllowSupplierManagement').checked, allowPlatformSettings: $('centerSupplierAllowPlatformSettings').checked, allowCustomBrand: $('centerSupplierAllowCustomBrand').checked, allowCustomApiProviders: $('centerSupplierAllowCustomApiProviders').checked }; }
    function fillCenterSupplier(supplier) { $('centerSupplierId').value = supplier?.id || ''; $('centerSupplierName').value = supplier?.name || ''; $('centerSupplierStatus').value = supplier?.status || 'enabled'; $('centerSupplierLicenseType').value = supplier?.licenseType === 'internal' ? 'internal' : 'partner'; $('centerSupplierMaxProjects').value = supplier?.maxProjects || 0; $('centerSupplierMaxBuilds').value = supplier?.maxBuilds || 0; $('centerSupplierAllowAgentManagement').checked = supplier ? Boolean(supplier.allowAgentManagement) : true; $('centerSupplierAllowSupplierManagement').checked = supplier ? Boolean(supplier.allowSupplierManagement) : false; $('centerSupplierAllowPlatformSettings').checked = supplier ? Boolean(supplier.allowPlatformSettings) : true; $('centerSupplierAllowCustomBrand').checked = supplier ? Boolean(supplier.allowCustomBrand) : true; $('centerSupplierAllowCustomApiProviders').checked = supplier ? Boolean(supplier.allowCustomApiProviders) : false; $('centerSupplierDeployConfig').value = supplier?.deploymentConfig || ''; $('centerSupplierMsg').textContent = supplier ? '正在编辑：' + supplier.id + (supplier.tokenPreview ? ' · Token 尾号 ' + supplier.tokenPreview : '') : ''; }
    function collectLoginContent() {
      const value = (id) => $(id)?.value || '';
      return {
        kicker: value('settingLoginKicker'), panelEyebrow: value('settingLoginPanelEyebrow'), panelTitle: value('settingLoginPanelTitle'),
        panelSubtitle: value('settingLoginPanelSubtitle'), accountLabel: value('settingLoginAccountLabel'), accountPlaceholder: value('settingLoginAccountPlaceholder'),
        passwordLabel: value('settingLoginPasswordLabel'), passwordPlaceholder: value('settingLoginPasswordPlaceholder'), submitText: value('settingLoginSubmitText'),
        securityText: value('settingLoginSecurityText'), interactionHint: value('settingLoginInteractionHint'),
        signals: Array.from({ length: 4 }, (_, index) => ({ title: value('settingLoginSignalTitle' + index), subtitle: value('settingLoginSignalSubtitle' + index) })),
        capabilities: Array.from({ length: 4 }, (_, index) => ({ title: value('settingLoginCapabilityTitle' + index), subtitle: value('settingLoginCapabilitySubtitle' + index) })),
      };
    }
    function collectPlatformSettings() {
      const crystalFaceTexts = Object.fromEntries(crystalFaceKeys.map((key) => {
        const id = 'settingCrystalFace' + key.charAt(0).toUpperCase() + key.slice(1);
        return [key, $(id)?.value || ''];
      }));
      return { systemName: $('settingSystemName').value, systemSubtitle: $('settingSystemSubtitle').value, loginTitle: $('settingLoginTitle')?.value || '', loginSubtitle: $('settingLoginSubtitle')?.value || '', loginBackgroundUrl: $('settingLoginBackgroundUrl')?.value || '', loginPanelColor: $('settingLoginPanelColor')?.value || '#0b2142', loginContent: collectLoginContent(), primaryColor: $('settingPrimaryColor').value, logoText: $('settingLogoText').value, crystalFaceTexts, buildCenterUrl: $('settingBuildCenterUrl').value, buildCenterSupplierId: $('settingBuildCenterSupplierId').value, buildCenterToken: $('settingBuildCenterToken').value, artifactStorageMode: $('settingArtifactStorageMode')?.value || 'local', ossAccessKeyId: $('settingOssAccessKeyId')?.value || '', ossAccessKeySecret: $('settingOssAccessKeySecret')?.value || '', ossBucket: $('settingOssBucket')?.value || '', ossEndpoint: $('settingOssEndpoint')?.value || '', ossPublicBaseUrl: $('settingOssPublicBaseUrl')?.value || '', ossPrefix: $('settingOssPrefix')?.value || '', smtpHost: $('settingSmtpHost')?.value || '', smtpPort: $('settingSmtpPort')?.value || 465, smtpSecure: Boolean($('settingSmtpSecure')?.checked), smtpUser: $('settingSmtpUser')?.value || '', smtpPass: $('settingSmtpPass')?.value || '', smtpFromName: $('settingSmtpFromName')?.value || '', smtpFromEmail: $('settingSmtpFromEmail')?.value || '', modelGatewayBaseUrl: $('settingModelGatewayBaseUrl').value, modelUsageBaseUrl: $('settingModelUsageBaseUrl').value, modelGatewayKey: $('settingModelGatewayKey').value, modelPointsPerUsd: $('settingModelPointsPerUsd').value };
    }
    function collectBuildCenterConfig() {
      return { buildCenterUrl: $('settingBuildCenterUrl').value, buildCenterSupplierId: $('settingBuildCenterSupplierId').value, buildCenterToken: $('settingBuildCenterToken').value };
    }
    function fillPlatformSettings(settings = {}) {
      platformSettingsDirty = false;
      $('settingSystemName').value = settings.systemName || '';
      $('settingSystemSubtitle').value = settings.systemSubtitle || '';
      $('settingPrimaryColor').value = settings.primaryColor || '#1677ff';
      $('settingLogoText').value = Object.prototype.hasOwnProperty.call(settings, 'logoText') ? String(settings.logoText ?? '') : 'Y';
      const crystalFaceTexts = normalizeCrystalFaceTextsClient(settings.crystalFaceTexts);
      crystalFaceKeys.forEach((key) => {
        const id = 'settingCrystalFace' + key.charAt(0).toUpperCase() + key.slice(1);
        if ($(id)) $(id).value = crystalFaceTexts[key];
      });
      if ($('settingLoginTitle')) $('settingLoginTitle').value = settings.loginTitle || '';
      if ($('settingLoginSubtitle')) $('settingLoginSubtitle').value = settings.loginSubtitle || '';
      if ($('settingLoginPanelColor')) $('settingLoginPanelColor').value = settings.loginPanelColor || '#0b2142';
      if ($('settingLoginBackgroundUrl')) $('settingLoginBackgroundUrl').value = settings.loginBackgroundUrl || '';
      if ($('settingLoginBackgroundPreview')) { $('settingLoginBackgroundPreview').src = settings.loginBackgroundUrl || ''; $('settingLoginBackgroundPreview').classList.toggle('empty', !settings.loginBackgroundUrl); }
      const loginContent = normalizeLoginContentClient(settings.loginContent);
      const loginContentFields = {
        settingLoginKicker: loginContent.kicker, settingLoginPanelEyebrow: loginContent.panelEyebrow, settingLoginPanelTitle: loginContent.panelTitle,
        settingLoginPanelSubtitle: loginContent.panelSubtitle, settingLoginAccountLabel: loginContent.accountLabel, settingLoginAccountPlaceholder: loginContent.accountPlaceholder,
        settingLoginPasswordLabel: loginContent.passwordLabel, settingLoginPasswordPlaceholder: loginContent.passwordPlaceholder, settingLoginSubmitText: loginContent.submitText,
        settingLoginSecurityText: loginContent.securityText, settingLoginInteractionHint: loginContent.interactionHint,
      };
      Object.entries(loginContentFields).forEach(([id, value]) => { if ($(id)) $(id).value = value; });
      loginContent.signals.forEach((item, index) => {
        if ($('settingLoginSignalTitle' + index)) $('settingLoginSignalTitle' + index).value = item.title;
        if ($('settingLoginSignalSubtitle' + index)) $('settingLoginSignalSubtitle' + index).value = item.subtitle;
      });
      loginContent.capabilities.forEach((item, index) => {
        if ($('settingLoginCapabilityTitle' + index)) $('settingLoginCapabilityTitle' + index).value = item.title;
        if ($('settingLoginCapabilitySubtitle' + index)) $('settingLoginCapabilitySubtitle' + index).value = item.subtitle;
      });
      $('settingBuildCenterUrl').value = settings.buildCenterUrl || '';
      $('settingBuildCenterSupplierId').value = settings.buildCenterSupplierId || '';
      $('settingBuildCenterToken').value = '';
      $('settingBuildCenterToken').placeholder = settings.buildCenterTokenConfigured ? ('已配置，尾号 ' + (settings.buildCenterTokenPreview || '未知') + '，留空不修改') : '请输入官方构建中心 Token';
      if ($('settingArtifactStorageMode')) $('settingArtifactStorageMode').value = settings.artifactStorageMode || 'local';
      if ($('settingOssAccessKeyId')) $('settingOssAccessKeyId').value = settings.ossAccessKeyId || '';
      if ($('settingOssAccessKeySecret')) {
        $('settingOssAccessKeySecret').value = '';
        $('settingOssAccessKeySecret').placeholder = settings.ossAccessKeySecretConfigured ? ('已配置，尾号 ' + (settings.ossAccessKeySecretPreview || '未知') + '，留空不修改') : '请输入 AccessKey Secret';
      }
      if ($('settingOssBucket')) $('settingOssBucket').value = settings.ossBucket || '';
      if ($('settingOssEndpoint')) $('settingOssEndpoint').value = settings.ossEndpoint || '';
      if ($('settingOssPublicBaseUrl')) $('settingOssPublicBaseUrl').value = settings.ossPublicBaseUrl || '';
      if ($('settingOssPrefix')) $('settingOssPrefix').value = settings.ossPrefix || '';
      if ($('settingSmtpHost')) $('settingSmtpHost').value = settings.smtpHost || '';
      if ($('settingSmtpPort')) $('settingSmtpPort').value = settings.smtpPort || 465;
      if ($('settingSmtpSecure')) $('settingSmtpSecure').checked = settings.smtpSecure !== false;
      if ($('settingSmtpUser')) $('settingSmtpUser').value = settings.smtpUser || '';
      if ($('settingSmtpPass')) {
        $('settingSmtpPass').value = '';
        $('settingSmtpPass').placeholder = settings.smtpPassConfigured ? ('已配置，尾号 ' + (settings.smtpPassPreview || '未知') + '，留空不修改') : '请输入 SMTP 密码或授权码';
      }
      if ($('settingSmtpFromName')) $('settingSmtpFromName').value = settings.smtpFromName || 'Agent AI';
      if ($('settingSmtpFromEmail')) $('settingSmtpFromEmail').value = settings.smtpFromEmail || '';
      $('settingModelGatewayBaseUrl').value = settings.modelGatewayBaseUrl || 'https://api.mengyunet.cn/v1';
      $('settingModelUsageBaseUrl').value = settings.modelUsageBaseUrl || 'https://api.vectorengine.ai';
      $('settingModelGatewayKey').value = '';
      $('settingModelGatewayKey').placeholder = settings.modelGatewayKeyConfigured ? '已配置，留空不修改' : '请输入模型服务 Key';
      $('settingModelPointsPerUsd').value = settings.modelPointsPerUsd || 1000;
    }
    async function adjustCredits(userId) {
      const amount = prompt('请输入调整积分，正数充值，负数扣减');
      if (!amount) return;
      const note = prompt('备注，可留空') || '';
      await api('/api/end-users/' + encodeURIComponent(userId) + '/credits', { method: 'POST', body: JSON.stringify({ amount, note }) });
      await refresh();
    }
    function providerName(id) { return modelProviders.find((item) => item.id === id)?.name || id || '-'; }
    function modelLabel(id) {
      const model = providerModels.find((item) => item.id === id);
      return model ? (model.displayName + ' · ' + model.modelId) : id || '-';
    }
    function capabilityLabel(value) {
      return ({ text: '文本', vision: '多模态识图', tools: '工具调用', reasoning: '推理', search: '联网搜索' }[value]) || value;
    }
    function capabilitySummary(capabilities = []) {
      return (capabilities || []).map(capabilityLabel).join('、') || '-';
    }
    function modelTypeLabel(type) {
      return ({ text: '文本模型', image: '图片模型', video: '视频模型', audio: '音频模型', search: '搜索模型' }[type]) || '文本模型';
    }
    function pricingForModel(modelId) {
      return modelPricingRules.find((item) => item.providerModelId === modelId && item.status !== 'disabled') || modelPricingRules.find((item) => item.providerModelId === modelId) || null;
    }
    function providerOptions(selectedId = '') {
      const options = modelProviders.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name + ' · ' + item.id) + '</option>').join('');
      return options || '<option value="">暂无服务商</option>';
    }
    function providerFilterOptions() {
      return '<option value="">全部服务商</option>' + modelProviders.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + '</option>').join('');
    }
    function refreshProviderSelects() {
      const providerSelects = ['modelKeyProviderId', 'providerModelProviderId'];
      providerSelects.forEach((id) => {
        const selected = $(id).value;
        $(id).innerHTML = providerOptions(selected);
        if (selected && modelProviders.some((item) => item.id === selected)) $(id).value = selected;
      });
      ['modelKeyProviderFilter', 'providerModelProviderFilter', 'pricingProviderFilter'].forEach((id) => {
        const element = $(id);
        if (!element) return;
        const selected = element.value;
        element.innerHTML = providerFilterOptions();
        if (selected && modelProviders.some((item) => item.id === selected)) element.value = selected;
      });
      const selectedModel = $('pricingProviderModelId').value;
      $('pricingProviderModelId').innerHTML = providerModels.length
        ? providerModels.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(providerName(item.providerId) + ' · ' + item.displayName + ' · ' + item.modelId) + '</option>').join('')
        : '<option value="">暂无模型</option>';
      if (selectedModel && providerModels.some((item) => item.id === selectedModel)) $('pricingProviderModelId').value = selectedModel;
    }
    function toggleDrawer(name, visible) {
      const drawer = $(name + 'Drawer');
      const backdrop = $(name + 'DrawerBackdrop');
      if (!drawer || !backdrop) return;
      drawer.classList.toggle('hidden', !visible);
      backdrop.classList.toggle('hidden', !visible);
    }
    function resetProviderFilters() {
      ['providerSearchFilter', 'providerStatusFilter', 'modelKeyProviderFilter', 'modelKeyStatusFilter', 'providerModelSearchFilter', 'providerModelProviderFilter', 'providerModelStatusFilter', 'pricingProviderFilter', 'pricingBillingFilter', 'pricingStatusFilter'].forEach((id) => {
        const element = $(id);
        if (element) element.value = '';
      });
    }
    function collectModelProvider() {
      return { id: $('modelProviderId').value, name: $('modelProviderName').value, baseUrl: $('modelProviderBaseUrl').value, status: $('modelProviderStatus').value, isDefault: $('modelProviderDefault').value === '1', timeoutMs: $('modelProviderTimeoutMs').value, sortOrder: $('modelProviderSortOrder').value, notes: $('modelProviderNotes').value };
    }
    function fillModelProvider(provider) {
      $('modelProviderId').value = provider?.id || '';
      $('modelProviderId').disabled = Boolean(provider?.id);
      $('modelProviderName').value = provider?.name || '';
      $('modelProviderBaseUrl').value = provider?.baseUrl || '';
      $('modelProviderStatus').value = provider?.status || 'enabled';
      $('modelProviderDefault').value = provider?.isDefault ? '1' : '0';
      $('modelProviderTimeoutMs').value = provider?.timeoutMs || 120000;
      $('modelProviderSortOrder').value = provider?.sortOrder || 0;
      $('modelProviderNotes').value = provider?.notes || '';
      $('modelProviderMsg').textContent = provider ? '正在编辑：' + provider.id : '';
    }
    function collectModelKey() {
      return { id: $('modelKeyId').value, key: $('modelKeyValue').value, status: $('modelKeyStatus').value, weight: $('modelKeyWeight').value, notes: $('modelKeyNotes').value };
    }
    function fillModelKey(key) {
      $('modelKeyId').value = key?.id || '';
      $('modelKeyProviderId').value = key?.providerId || modelProviders[0]?.id || '';
      $('modelKeyValue').value = '';
      $('modelKeyValue').placeholder = key ? '已配置 ' + (key.keyPreview || '') + '，留空不修改' : '请输入模型服务 Key';
      $('modelKeyStatus').value = key?.status || 'enabled';
      $('modelKeyWeight').value = key?.weight || 1;
      $('modelKeyNotes').value = key?.notes || '';
      $('modelKeyMsg').textContent = key ? '正在编辑：' + (key.keyPreview || key.id) : '';
    }
    function updateProviderModelEndpointPlaceholder() {
      const type = $('providerModelType')?.value || 'text';
      const placeholders = {
        text: '文本默认 /chat/completions',
        image: '图片生成默认 /images/generations，可填 /images/edits',
        search: '搜索默认 /v1/web-search',
        video: '请输入视频模型接口端点',
        audio: '请输入音频模型接口端点',
      };
      if ($('providerModelEndpointPath')) $('providerModelEndpointPath').placeholder = placeholders[type] || placeholders.text;
    }
    function collectProviderModel() {
      const capabilities = [];
      const modelType = $('providerModelType').value;
      if (modelType === 'search') {
        capabilities.push('search');
      } else {
        if ($('providerModelCapText').checked) capabilities.push('text');
        if ($('providerModelCapVision').checked) capabilities.push('vision');
        if ($('providerModelCapTools').checked) capabilities.push('tools');
        if ($('providerModelCapReasoning').checked) capabilities.push('reasoning');
      }
      $('providerModelCapabilities').value = capabilities.join(',');
      return { id: $('providerModelId').value, providerId: $('providerModelProviderId').value, modelId: $('providerModelModelId').value, displayName: $('providerModelDisplayName').value, description: $('providerModelDescription').value, modelType, endpointPath: $('providerModelEndpointPath').value, status: $('providerModelStatus').value, isDefault: $('providerModelDefault').value === '1', contextWindow: $('providerModelContextWindow').value, sortOrder: $('providerModelSortOrder').value, capabilities: $('providerModelCapabilities').value };
    }
    function fillProviderModel(model) {
      const capabilities = new Set(model?.capabilities || ['text']);
      $('providerModelId').value = model?.id || '';
      $('providerModelProviderId').value = model?.providerId || modelProviders[0]?.id || '';
      $('providerModelModelId').value = model?.modelId || '';
      $('providerModelDisplayName').value = model?.displayName || '';
      $('providerModelDescription').value = model?.description || '';
      $('providerModelType').value = model?.modelType || 'text';
      $('providerModelEndpointPath').value = model?.endpointPath || '';
      updateProviderModelEndpointPlaceholder();
      $('providerModelStatus').value = model?.status || 'enabled';
      $('providerModelDefault').value = model?.isDefault ? '1' : '0';
      $('providerModelContextWindow').value = model?.contextWindow || 0;
      $('providerModelSortOrder').value = model?.sortOrder || 0;
      $('providerModelCapText').checked = (model?.modelType || 'text') !== 'search' && (capabilities.has('text') || capabilities.size === 0);
      $('providerModelCapVision').checked = capabilities.has('vision');
      $('providerModelCapTools').checked = capabilities.has('tools');
      $('providerModelCapReasoning').checked = capabilities.has('reasoning');
      $('providerModelCapabilities').value = Array.from(capabilities).join(',');
      $('providerModelMsg').textContent = model ? '正在编辑：' + model.id : '';
    }
    async function testProviderModelConnection() {
      const payload = collectProviderModel();
      $('providerModelMsg').textContent = ['text', 'search'].includes(payload.modelType) ? '正在测试连通性...' : '当前分类暂不执行自动连通性测试';
      const result = await api('/api/provider-models/test', { method: 'POST', body: JSON.stringify(payload) });
      $('providerModelMsg').textContent = result.skipped ? result.message : ('连通性测试通过：' + (result.keyPreview || 'Key 池可用'));
      return result;
    }
    function syncResultText(scope, result) {
      const item = result?.[scope] || {};
      return '同步完成：新增 ' + (item.added || 0) + '，更新 ' + (item.updated || 0) + '，删除 ' + (item.deleted || 0) + '，跳过 ' + (item.skipped || 0);
    }
    async function syncModelService(scope, messageId) {
      const labels = { providers: '服务商', models: '模型', pricingRules: '计费规则' };
      if (!confirm('确认从总后台同步' + (labels[scope] || '模型服务配置') + '吗？本地已自定义的条目不会被覆盖。')) return;
      const message = $(messageId);
      if (message) message.textContent = '正在同步总后台配置...';
      const result = await api('/api/model-service/sync', { method: 'POST', body: JSON.stringify({ scope }) });
      await refresh();
      const text = syncResultText(scope, result);
      if (message) message.textContent = text;
      alert(text);
    }
    function collectPricingRule() {
      return { id: $('pricingRuleId').value, providerModelId: $('pricingProviderModelId').value, billingType: $('pricingBillingType').value, inputPointsPerMTokens: $('pricingInputPoints').value, outputPointsPerMTokens: $('pricingOutputPoints').value, pointsPerRequest: $('pricingRequestPoints').value, status: $('pricingStatus').value };
    }
    function fillPricingRule(rule) {
      $('pricingRuleId').value = rule?.id || '';
      $('pricingProviderModelId').value = rule?.providerModelId || providerModels[0]?.id || '';
      $('pricingBillingType').value = rule?.billingType || 'per_token';
      $('pricingInputPoints').value = rule?.inputPointsPerMTokens || 0;
      $('pricingOutputPoints').value = rule?.outputPointsPerMTokens || 0;
      $('pricingRequestPoints').value = rule?.pointsPerRequest || 0;
      $('pricingStatus').value = rule?.status || 'enabled';
      $('pricingRuleMsg').textContent = rule ? '正在编辑：' + rule.id : '';
    }
    async function loadProviderConfig() {
      if (!canManageModelService()) {
        modelProviders = [];
        modelProviderKeys = [];
        providerModels = [];
        modelPricingRules = [];
        return;
      }
      const [providersResult, keysResult, modelsResult, pricingResult] = await Promise.all([
        canAny(['model_providers.manage', 'model_keys.manage', 'provider_models.manage', 'pricing_rules.manage']) ? api('/api/model-providers').catch(() => []) : [],
        can('model_keys.manage') ? api('/api/model-provider-keys').catch(() => []) : [],
        can('provider_models.manage') ? api('/api/provider-models').catch(() => []) : [],
        can('pricing_rules.manage') ? api('/api/model-pricing-rules').catch(() => []) : [],
      ]);
      modelProviders = providersResult;
      modelProviderKeys = keysResult;
      providerModels = modelsResult;
      modelPricingRules = pricingResult;
    }
    async function loadSelfUpdateStatus() {
      if (!can('self_update.manage')) return { ok: true };
      try { selfUpdate = await api('/api/self-update/status'); return { ok: true }; }
      catch (err) { selfUpdate = { configured: false, error: err.message, currentVersion: '', latestVersion: '', updateAvailable: false, lastLog: '' }; return { ok: false, error: err }; }
    }
    function unavailableSupplierLicense(error) {
      return { verified: false, message: error?.message || String(error || ''), allowAgentManagement: false, allowSupplierManagement: false, allowPlatformSettings: true, allowCustomBrand: false, allowCustomApiProviders: false };
    }
    async function refreshLiveStatus({ renderAfter = true } = {}) {
      if (liveRefreshInFlight) return liveRefreshInFlight;
      liveRefreshInFlight = (async () => {
        const sourceRequest = api('/api/source-version').then((value) => { sourceInfo = value; });
        const licenseRequest = api('/api/license').then((value) => { supplierLicense = value; }).catch((error) => { if (!supplierLicense?.verified) supplierLicense = unavailableSupplierLicense(error); });
        const workerRequest = canAny(['builds.create', 'builds.publish', 'diagnostics.view'])
          ? api('/api/workers').then((value) => { workers = value; }).catch(() => {})
          : Promise.resolve();
        const buildRequest = canAny(['builds.create', 'builds.publish'])
          ? api('/api/builds').then((value) => { builds = value; }).catch(() => {})
          : Promise.resolve();
        await Promise.allSettled([sourceRequest, licenseRequest, workerRequest, buildRequest]);
        remoteStatusLoading = false;
        syncAbilityTabs();
        if (renderAfter) {
          renderMetrics();
          renderDashboard();
          renderProjects();
          renderBuilds();
          renderAuthStatus();
          updateProjectBuildAction();
        }
      })().finally(() => { liveRefreshInFlight = null; });
      return liveRefreshInFlight;
    }
    async function performRefresh({ skipSession = false } = {}) {
      if (!skipSession) {
        const session = await api('/api/me').catch(() => null);
        if (session?.loggedIn && session.user) {
          me = session.user;
          syncUserPermissions();
        }
      }
      const localBuildPath = '/api/builds?sync=0';
      const creditRequest = can('credits.manage')
        ? loadCreditLedger({ page: 1, renderAfter: false }).catch(() => { creditLedger = []; creditLedgerPage = { total: 0, page: 1, pageSize: 20, totalPages: 1, filteredConsumed: 0, totalConsumed: 0 }; })
        : Promise.resolve().then(() => { creditLedger = []; });
      await Promise.all([
        (canAny(['users.manage', 'user_groups.manage', 'permissions.manage']) ? api('/api/users').catch(() => [me]) : Promise.resolve([me])).then((value) => { users = value; }),
        (canAny(['user_groups.manage', 'permissions.manage']) ? api('/api/user-groups').catch(() => []) : Promise.resolve([])).then((value) => { userGroups = value; }),
        (can('permissions.manage') ? api('/api/role-templates').catch(() => []) : Promise.resolve([])).then((value) => { roleTemplates = value; }),
        (can('center_suppliers.manage') && centerSupplierManagementEnabled ? api('/api/center-suppliers').catch(() => []) : Promise.resolve([])).then((value) => { centerSuppliers = value; }),
        (can('permissions.manage') ? api('/api/permissions/catalog').catch(() => []) : Promise.resolve([])).then((value) => { permissionCatalog = value; }),
        (can('projects.manage') ? api('/api/projects').catch(() => []) : Promise.resolve([])).then((value) => { projects = value; }),
        (canAny(['builds.create', 'builds.publish']) ? api(localBuildPath).catch(() => []) : Promise.resolve([])).then((value) => { builds = value; }),
        (can('end_users.manage') ? api('/api/end-users').catch(() => []) : Promise.resolve([])).then((value) => { endUsers = value; }),
        (can('memberships.manage') ? api('/api/membership-cards').catch(() => []) : Promise.resolve([])).then((value) => { membershipCards = value; }),
        (can('memberships.manage') ? api('/api/membership-cards/model-options').catch(() => []) : Promise.resolve([])).then((value) => { membershipModelOptions = value; }),
        (can('payments.manage') ? api('/api/payment-configs').catch(() => []) : Promise.resolve([])).then((value) => { paymentConfigs = value; }),
        (can('payments.manage') ? api('/api/payment-orders').catch(() => []) : Promise.resolve([])).then((value) => { paymentOrders = value; }),
        creditRequest,
        (can('redeem_codes.manage') ? api('/api/redeem-codes').catch(() => []) : Promise.resolve([])).then((value) => { redeemCodes = value; }),
        (can('redeem_codes.manage') ? api('/api/redeem-code-batches').catch(() => []) : Promise.resolve([])).then((value) => { redeemBatches = value; }),
        (can('redeem_codes.manage') ? api('/api/redeem-codes/membership-options').catch(() => []) : Promise.resolve([])).then((value) => { redeemMembershipOptions = value; }),
        (can('curated_skills.view') ? api('/api/curated-skills').catch(() => []) : Promise.resolve([])).then((value) => { curatedSkills = value; }),
        (can('curated_skills.view') ? api('/api/curated-skill-distributions').catch(() => []) : Promise.resolve([])).then((value) => { curatedDistributions = value; }),
        (can('curated_mcps.view') ? api('/api/curated-mcps').catch(() => []) : Promise.resolve([])).then((value) => { curatedMcps = value; }),
        (can('curated_mcps.view') ? api('/api/curated-mcp-distributions').catch(() => []) : Promise.resolve([])).then((value) => { curatedMcpDistributions = value; }),
        (can('curated_agents.view') ? api('/api/curated-agents').catch(() => []) : Promise.resolve([])).then((value) => { curatedAgents = value; }),
        (can('curated_agents.view') ? api('/api/curated-agent-distributions').catch(() => []) : Promise.resolve([])).then((value) => { curatedAgentDistributions = value; }),
        loadProviderConfig(),
        api('/api/platform-settings').then((value) => { platformSettings = value; }).catch(() => {}),
      ]);
      render();
      if (can('organizations.view')) await organizationView.refresh().catch(() => {});
      applyPlatformSettings(platformSettings);
      if (can('platform_settings.manage') && hasSupplierAbility('allowPlatformSettings') && !platformSettingsDirty && !document.activeElement?.id?.startsWith('setting')) fillPlatformSettings(platformSettings);
      if (!maybeShowUpdateReminder() && !maybeShowModelUpdateReminder() && !maybeShowCuratedUpdateReminder()) maybeShowCuratedMcpUpdateReminder();
      if (can('self_update.manage')) void loadSelfUpdateStatus().then(() => { renderSelfUpdate(); maybeShowUpdateReminder(); });
      void refreshLiveStatus();
    }
    async function refresh(options = {}) {
      if (refreshInFlight) return refreshInFlight;
      refreshInFlight = performRefresh(options).finally(() => { refreshInFlight = null; });
      return refreshInFlight;
    }
    function renderOwnerOptions() {
      const selectedId = $('ownerUserId').value;
      const source = projectOwnerSource(selectedId);
      $('ownerUserId').innerHTML = source.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.displayName || item.username) + '</option>').join('');
      $('ownerUserId').value = defaultProjectOwnerId(selectedId);
      $('ownerUserId').disabled = me.role !== 'admin';
    }
    function renderMetrics() {
      const staleCount = projects.filter((p) => projectVersionState(p).stale).length;
      const onlineWorkers = workers.filter((w) => w.online).length;
      $('sourceVersion').textContent = sourceInfo.version ? 'v' + sourceInfo.version : (remoteStatusLoading ? '加载中…' : '未配置'); $('projectMetric').textContent = projects.length; $('successMetric').textContent = builds.filter((b) => b.status === 'succeeded' && b.releasedAt).length; $('staleMetric').textContent = sourceInfo.version ? staleCount : 0; $('workerMetric').textContent = remoteStatusLoading ? '连接中…' : (onlineWorkers > 0 ? onlineWorkers + ' 在线' : '离线'); $('projectCount').textContent = projects.length; $('buildCount').textContent = builds.length; $('agentCount').textContent = users.length; $('centerSupplierCount').textContent = centerSuppliers.length; $('endUserCount').textContent = endUsers.length; $('membershipCount').textContent = membershipCards.length; $('providerCount').textContent = modelProviders.length;
      if (sourceInfo.version) {
        const notes = sourceInfo.releaseNotes ? '<div class="source-release-notes">' + escapeHtml(sourceInfo.releaseNotes) + '</div>' : '';
        const historyButton = Array.isArray(sourceInfo.history) && sourceInfo.history.length ? '<button class="secondary" id="sourceHistoryBtn">查看历史更新</button>' : '';
        const detail = staleCount > 0
          ? '有 ' + staleCount + ' 个 AI 项目尚未发布当前 Agent 源码版本。请先打包测试版，下载安装到本机验证无误后，再点击“推送给用户”发布到正式更新地址。'
          : '当前 AI 项目已同步到最新版。需要回看版本变化时，可查看历史更新。';
        $('versionNotice').classList.remove('hidden');
        $('versionNotice').innerHTML = '<div><strong>当前 Agent 最新版 v' + escapeHtml(sourceInfo.version || '-') + '</strong><div class="small">' + escapeHtml(detail) + '</div>' + notes + '</div><div class="notice-actions">' + historyButton + '<button class="secondary" id="refreshVersionBtn">刷新</button></div>';
        $('refreshVersionBtn').onclick = refresh;
        if ($('sourceHistoryBtn')) $('sourceHistoryBtn').onclick = openSourceHistoryDrawer;
      }
      else { $('versionNotice').classList.add('hidden'); $('versionNotice').innerHTML = ''; }
    }
    function renderDashboard() {
      const recent = builds.slice(0, 6);
      $('recentBuildRows').innerHTML = recent.length ? recent.map((b) => '<tr><td>' + escapeHtml(b.projectId) + '</td><td>' + escapeHtml(b.version ? 'v' + b.version : '-') + '</td><td><span class="status ' + escapeHtml(b.status) + '">' + escapeHtml(statusText(b.status)) + '</span></td><td class="muted">' + escapeHtml(formatTime(b.updatedAt || b.createdAt)) + '</td></tr>').join('') : '<tr><td colspan="4" class="muted">暂无构建任务</td></tr>';
    }
    function renderProjects() {
      const keyword = ($('projectSearchFilter')?.value || '').trim().toLowerCase();
      const statusFilter = $('projectStatusFilter')?.value || '';
      const filteredProjects = projects.filter((p) => {
        const text = [p.id, p.appId, p.appName, p.brandName, p.shortName, ownerLabel(p), p.ownerUserId].join(' ').toLowerCase();
        return (!keyword || text.includes(keyword)) && (!statusFilter || p.status === statusFilter);
      });
      if ($('projectFooter')) $('projectFooter').textContent = '共 ' + filteredProjects.length + ' 条';
      $('projectRows').innerHTML = filteredProjects.map((p) => {
        const state = projectVersionState(p);
        const latest = latestReleasedBuild(p.id);
        const active = activeBuildForProject(p.id);
        const recent = latestBuildForProject(p.id);
        const canOperateProject = p.canOperate !== false;
        const buildSummary = active
          ? '<div class="build-inline"><div><span class="status ' + escapeHtml(active.status) + '">' + escapeHtml(statusText(active.status)) + '</span></div><div class="muted small">' + escapeHtml(buildProgressText(active)) + '</div><div class="inline-actions"><button class="secondary view-build-btn" data-build-id="' + escapeHtml(active.id) + '">查看构建</button></div></div>'
          : (recent ? '<div class="muted small">最近打包：' + escapeHtml(statusText(recent.status)) + ' · ' + escapeHtml(formatTime(recent.updatedAt || recent.createdAt)) + '</div>' : '');
        const buildButtonText = active ? (active.status === 'running' ? '构建中' : '已排队') : '打包测试版';
        const actions = canOperateProject
          ? '<button class="secondary edit-project-btn" data-project-id="' + escapeHtml(p.id) + '">编辑</button><button class="build-project-btn" data-project-id="' + escapeHtml(p.id) + '" ' + (active ? 'disabled' : '') + '>' + escapeHtml(buildButtonText) + '</button><button class="table-action danger delete-project-btn" data-project-id="' + escapeHtml(p.id) + '">删除</button>'
          : '<span class="muted small">仅可查看</span>' + (recent ? '<button class="secondary view-build-btn" data-build-id="' + escapeHtml(recent.id) + '">查看构建</button>' : '');
        return '<tr><td><strong>' + escapeHtml(p.id) + '</strong><div class="muted mono">' + escapeHtml(p.appId || '') + '</div></td><td>' + escapeHtml(p.appName) + '<div class="muted">' + escapeHtml(p.brandName) + '</div></td><td>' + ownerSourceHtml(p) + '</td><td><span class="status ' + (state.stale ? 'queued' : 'succeeded') + '">' + escapeHtml(state.text) + '</span><div class="muted small">最近发布：' + escapeHtml(latest?.version || '-') + '</div>' + buildSummary + '</td><td><div class="inline-actions">' + actions + '</div></td></tr>';
      }).join('') || '<tr><td colspan="5" class="muted">暂无项目。</td></tr>';
      document.querySelectorAll('.edit-project-btn').forEach((button) => button.onclick = () => { fillProject(projects.find((p) => p.id === button.dataset.projectId)); switchTab('projectEditor'); });
      document.querySelectorAll('.build-project-btn').forEach((button) => button.onclick = () => startBuild(button.dataset.projectId, button));
      document.querySelectorAll('.delete-project-btn').forEach((button) => button.onclick = async () => {
        const project = projects.find((p) => p.id === button.dataset.projectId);
        if (!project) return;
        if (!confirm('确认永久删除项目“' + project.id + '”吗？关联构建记录和该项目下终端用户数据会一起删除。')) return;
        await api('/api/projects/' + encodeURIComponent(project.id), { method: 'DELETE' });
        await refresh();
      });
      document.querySelectorAll('.view-build-btn').forEach((button) => button.onclick = () => showBuildDetail(button.dataset.buildId));
    }
    function renderBuilds() {
      const workerStatus = $('workerStatusFilter')?.value || '';
      const filteredWorkers = workers.filter((w) => !workerStatus || (workerStatus === 'online' ? w.online : !w.online));
      if ($('workerFooter')) $('workerFooter').textContent = '共 ' + filteredWorkers.length + ' 条';
      $('workerRows').innerHTML = filteredWorkers.length ? filteredWorkers.map((w) => { const workerVersion = String(w.metadata?.packageVersion || '').trim(); const expectedVersion = String(w.expectedPackageVersion || sourceInfo.version || '').trim(); const matchesSource = w.versionMatchesSource === true || Boolean(workerVersion && expectedVersion && workerVersion.replace(/^v/i, '') === expectedVersion.replace(/^v/i, '')); const onlineText = !expectedVersion ? '在线 · 源码版本未获取' : (matchesSource ? '在线 · 版本匹配' : '在线 · 待同步到 v' + expectedVersion.replace(/^v/i, '')); return '<tr><td><strong>' + escapeHtml(w.id) + '</strong><div class="muted small">' + escapeHtml(workerVersion ? 'Desktop v' + workerVersion : '未上报 Desktop 版本') + '</div></td><td><span class="status ' + (w.online ? (matchesSource ? 'succeeded' : 'queued') : 'failed') + '">' + escapeHtml(w.online ? onlineText : '离线') + '</span></td><td>' + escapeHtml(w.currentBuildId || '-') + '</td><td class="muted">' + escapeHtml(formatTime(w.lastSeenAt)) + '</td></tr>'; }).join('') : '<tr><td colspan="4" class="muted">暂无构建机心跳。请确认官方 worker 已配置 AI_WORKER_TOKEN 并连接该后台。</td></tr>';
      const buildKeyword = ($('buildSearchFilter')?.value || '').trim().toLowerCase();
      const buildStatus = $('buildStatusFilter')?.value || '';
      const filteredBuilds = builds.filter((b) => {
        const text = [b.projectId, b.projectName, b.version, b.id, ownerLabel(b), b.ownerUserId].join(' ').toLowerCase();
        return (!buildKeyword || text.includes(buildKeyword)) && (!buildStatus || b.status === buildStatus);
      });
      if ($('buildFooter')) $('buildFooter').textContent = '共 ' + filteredBuilds.length + ' 条';
      $('buildRows').innerHTML = filteredBuilds.map((b) => {
        const centerDelegated = isCenterDelegatedBuild(b);
        const testLatestUrl = buildFileUrl(b.publicUrl, 'latest.yml');
        const testInstallerUrl = buildFileUrl(b.publicUrl, installerFile(b));
        const releaseLatestUrl = buildFileUrl(b.releaseUrl, 'latest.yml');
        const releaseInstallerUrl = buildFileUrl(b.releaseUrl, installerFile(b));
        const links = [
          b.publicUrl
            ? '<div>测试：<a href="' + escapeHtml(testLatestUrl) + '" target="_blank">latest.yml</a>' + (testInstallerUrl ? ' · <a href="' + escapeHtml(testInstallerUrl) + '" target="_blank">安装包</a>' : '') + '</div>'
            : (centerDelegated && b.status === 'succeeded' ? '<div class="muted">测试：已同步至供应商并清理</div>' : ''),
          b.releaseUrl
            ? '<div>正式：<a href="' + escapeHtml(releaseLatestUrl) + '" target="_blank">latest.yml</a>' + (releaseInstallerUrl ? ' · <a href="' + escapeHtml(releaseInstallerUrl) + '" target="_blank">安装包</a>' : '') + '</div>'
            : (centerDelegated ? '<div class="muted">正式：由供应商后台发布</div>' : '<div class="muted">正式：未推送</div>'),
        ].filter(Boolean).join('');
        const isPublishing = b.releaseStatus === 'publishing';
        const releaseFailed = b.releaseStatus === 'failed';
        const canOperateBuild = b.canOperate !== false && !centerDelegated;
        const releaseButton = canOperateBuild && b.status === 'succeeded' && !b.releasedAt && !isPublishing ? '<button class="publish-build-btn" data-build-id="' + escapeHtml(b.id) + '">' + escapeHtml(releaseFailed ? '重新推送' : '推送给用户') + '</button>' : '';
        const finishButton = canOperateBuild && isActiveBuild(b) ? '<button class="secondary finish-build-btn" data-build-id="' + escapeHtml(b.id) + '">结束</button>' : '';
        const releasedText = b.releasedAt ? '<span class="status succeeded">已推送</span>' : (isPublishing ? '<span class="status running">推送中</span>' : (releaseFailed ? '<span class="status failed">推送失败</span>' : ''));
        const releaseError = releaseFailed && b.releaseError ? '<div class="muted">' + escapeHtml(b.releaseError) + '</div>' : '';
        const transferProgress = transferProgressHtml(b.transferProgress, true);
        const retryButton = canOperateBuild && b.status === 'failed' ? '<button class="secondary retry-build-btn" data-build-id="' + escapeHtml(b.id) + '">重试</button>' : '';
        const readonlyText = canOperateBuild ? '' : '<span class="muted small">仅可查看日志</span>';
        return '<tr><td><strong>' + escapeHtml(b.projectId) + '</strong>' + (b.projectName ? '<div class="muted small">' + escapeHtml(b.projectName) + '</div>' : '') + '<div class="muted small mono">' + escapeHtml(shortId(b.id)) + '</div></td><td>' + buildSourceHtml(b) + '</td><td>' + escapeHtml(b.version ? 'v' + b.version : '-') + '</td><td><span class="status ' + escapeHtml(b.status) + '">' + escapeHtml(statusText(b.status)) + '</span>' + (releasedText ? '<div style="margin-top:6px">' + releasedText + '</div>' : '') + (b.error ? '<div class="muted">' + escapeHtml(b.error) + '</div>' : '') + transferProgress + releaseError + '</td><td>' + (links || '-') + '</td><td class="muted">' + escapeHtml(formatTime(b.updatedAt || b.createdAt)) + '</td><td><div class="inline-actions"><button class="secondary build-log-btn" data-build-id="' + escapeHtml(b.id) + '">日志</button>' + finishButton + retryButton + releaseButton + readonlyText + '</div></td></tr>';
      }).join('') || '<tr><td colspan="7" class="muted">暂无构建任务。</td></tr>';
      document.querySelectorAll('.build-log-btn').forEach((button) => button.onclick = () => showBuildDetail(button.dataset.buildId));
      document.querySelectorAll('.finish-build-btn').forEach((button) => button.onclick = async () => {
        if (!confirm('确认手动结束这个构建任务吗？结束后状态会标记为失败，并允许重新构建。')) return;
        await api('/api/builds/' + encodeURIComponent(button.dataset.buildId) + '/finish', { method: 'POST', body: JSON.stringify({ reason: '管理员手动结束构建任务' }) });
        await refresh();
      });
      document.querySelectorAll('.retry-build-btn').forEach((button) => button.onclick = async () => {
        const restoreButton = setButtonBusy(button, '重试中...');
        try {
          const build = await api('/api/builds/' + encodeURIComponent(button.dataset.buildId) + '/retry', { method: 'POST', body: '{}' });
          await refresh();
          alert('已重新提交构建任务：' + statusText(build.status) + ' · ' + shortId(build.id));
        } catch (err) {
          alert(err.message || '重试失败，请稍后再试');
        } finally {
          restoreButton();
        }
      });
      document.querySelectorAll('.publish-build-btn').forEach((button) => button.onclick = async () => {
        if (!confirm('确认推送给用户吗？请先安装测试地址中的安装包，确认功能和品牌信息无误。发布后客户端会收到这个版本更新。')) return;
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = '推送中...';
        try {
          await api('/api/builds/' + encodeURIComponent(button.dataset.buildId) + '/publish', { method: 'POST', body: '{}' });
          await refresh();
          alert('已开始推送，安装包会在后台复制到正式更新目录。文件较大时可能需要几分钟，请在列表中查看推送状态。');
        } catch (err) {
          alert(err.message || '推送失败，请稍后重试');
          button.disabled = false;
          button.textContent = originalText;
        }
      });
      if (selectedBuildLogId && !$('buildLogDrawer').classList.contains('hidden')) updateBuildLogDrawer(selectedBuildLogId);
    }
    function isSuperAdminAccount(user) { return !!user && (user.id === 'admin' || String(user.username || '').toLowerCase() === 'admin'); }
    function renderAgents() {
      if (me.role !== 'admin') return;
      if ($('agentRoleFilter')) {
        const selectedFilter = $('agentRoleFilter').value;
        $('agentRoleFilter').innerHTML = '<option value="">全部角色模板</option>' + roleTemplates.filter((item) => item.status !== 'disabled').map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + '</option>').join('');
        $('agentRoleFilter').value = roleTemplates.some((item) => item.id === selectedFilter) ? selectedFilter : '';
      }
      const keyword = ($('agentSearchFilter')?.value || '').trim().toLowerCase();
      const roleTemplateId = $('agentRoleFilter')?.value || '';
      const status = $('agentStatusFilter')?.value || '';
      const filteredUsers = users.filter((u) => {
        const text = [u.username, u.displayName, u.id].join(' ').toLowerCase();
        return (!keyword || text.includes(keyword)) && (!roleTemplateId || u.roleTemplateId === roleTemplateId) && (!status || u.status === status);
      });
      if ($('agentFooter')) $('agentFooter').textContent = '共 ' + filteredUsers.length + ' 条';
      $('agentRows').innerHTML = filteredUsers.map((u) => {
        const protectedUser = isSuperAdminAccount(u) || u.id === me.id;
        const action = protectedUser && !isSuperAdminAccount(me)
          ? '<span class="muted">受保护</span>'
          : '<button class="table-action edit-agent-btn" data-user-id="' + escapeHtml(u.id) + '">编辑</button>' + (protectedUser ? '' : '<button class="table-action danger delete-agent-btn" data-user-id="' + escapeHtml(u.id) + '">删除</button>');
        const template = roleTemplates.find((item) => item.id === u.roleTemplateId);
        return '<tr><td><strong>' + escapeHtml(u.username) + '</strong><div class="muted mono">' + escapeHtml(u.id) + '</div></td><td>' + escapeHtml(u.displayName) + '</td><td><strong>' + escapeHtml(template?.name || '未设置模板') + '</strong></td><td><span class="muted">项目 ' + escapeHtml(u.maxProjects || '不限') + '</span><div class="muted small">构建 ' + escapeHtml(u.maxBuilds || '不限') + '</div></td><td><span class="status ' + (u.status === 'enabled' ? 'succeeded' : 'failed') + '">' + escapeHtml(userStatusText(u.status)) + '</span></td><td>' + action + '</td></tr>';
      }).join('') || '<tr><td colspan="6" class="muted">暂无账号。</td></tr>';
      document.querySelectorAll('.edit-agent-btn').forEach((button) => button.onclick = () => { fillAgent(users.find((u) => u.id === button.dataset.userId)); toggleDrawer('agent', true); });
      document.querySelectorAll('.delete-agent-btn').forEach((button) => button.onclick = async () => {
        const user = users.find((u) => u.id === button.dataset.userId);
        if (!user) return;
        if (!confirm('确认永久删除后台账号“' + user.username + '”吗？该账号名下不能存在项目、构建或终端用户。')) return;
        await api('/api/users/' + encodeURIComponent(user.id), { method: 'DELETE' });
        await refresh();
      });
    }
    function renderUserGroups() {
      if (me.role !== 'admin' || !$('userGroupRows')) return;
      const keyword = ($('userGroupSearchFilter')?.value || '').trim().toLowerCase();
      const status = $('userGroupStatusFilter')?.value || '';
      const filteredGroups = userGroups.filter((group) => {
        const text = [group.id, group.name, group.description].join(' ').toLowerCase();
        return (!keyword || text.includes(keyword)) && (!status || group.status === status);
      });
      $('userGroupFooter').textContent = '共 ' + filteredGroups.length + ' 条';
      $('userGroupRows').innerHTML = filteredGroups.length ? filteredGroups.map((group) => {
        const action = '<button class="table-action edit-user-group-btn" data-group-id="' + escapeHtml(group.id) + '">编辑</button>' + (group.memberCount > 0 ? '' : '<button class="table-action danger delete-user-group-btn" data-group-id="' + escapeHtml(group.id) + '">删除</button>');
        return '<tr><td><strong>' + escapeHtml(group.name) + '</strong><div class="muted mono">' + escapeHtml(group.id) + '</div></td><td>' + escapeHtml(group.description || '-') + '</td><td>' + escapeHtml(group.memberCount || 0) + '</td><td>' + escapeHtml(group.sortOrder || 0) + '</td><td><span class="status ' + (group.status === 'enabled' ? 'succeeded' : 'failed') + '">' + escapeHtml(group.status === 'enabled' ? '启用' : '停用') + '</span></td><td>' + action + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="muted">暂无账号分组。</td></tr>';
      document.querySelectorAll('.edit-user-group-btn').forEach((button) => button.onclick = () => { fillUserGroup(userGroups.find((group) => group.id === button.dataset.groupId)); toggleDrawer('userGroup', true); });
      document.querySelectorAll('.delete-user-group-btn').forEach((button) => button.onclick = async () => {
        const group = userGroups.find((item) => item.id === button.dataset.groupId);
        if (!group) return;
        if (!confirm('确认永久删除账号分组“' + group.name + '”吗？')) return;
        await api('/api/user-groups/' + encodeURIComponent(group.id), { method: 'DELETE' });
        await refresh();
      });
    }
    function renderCenterSuppliers() {
      if (me.role !== 'admin') return;
      const keyword = ($('centerSupplierSearchFilter')?.value || '').trim().toLowerCase();
      const status = $('centerSupplierStatusFilter')?.value || '';
      const filteredSuppliers = centerSuppliers.filter((s) => {
        const text = [s.id, s.name].join(' ').toLowerCase();
        return (!keyword || text.includes(keyword)) && (!status || s.status === status);
      });
      if ($('centerSupplierFooter')) $('centerSupplierFooter').textContent = '共 ' + filteredSuppliers.length + ' 条';
      $('centerSupplierRows').innerHTML = filteredSuppliers.length ? filteredSuppliers.map((s) => {
        const usedProjects = Number(s.usedProjects || 0);
        const usedBuilds = Number(s.usedBuilds ?? s.buildCount ?? 0);
        const projectUsage = s.projectUsageSynced === false ? '待下游同步' : (s.maxProjects ? (usedProjects + '/' + s.maxProjects) : (usedProjects + '/不限'));
        const quota = 'OEM ' + escapeHtml(projectUsage) + '<div class="muted small">构建 ' + escapeHtml(s.maxBuilds ? (usedBuilds + '/' + s.maxBuilds) : (usedBuilds + '/不限')) + '</div>';
        const licenseText = { partner: '同行代理', internal: '内部测试' }[s.licenseType] || '同行代理';
        const ability = [s.allowAgentManagement ? '后台账号' : '', s.allowSupplierManagement ? '供应商接入' : '', s.allowPlatformSettings ? '平台设置' : '', s.allowCustomBrand ? '自定义品牌' : '', s.allowCustomApiProviders ? '自定义 API' : ''].filter(Boolean).join(' / ') || '无';
        return '<tr><td><strong>' + escapeHtml(s.name) + '</strong><div class="muted mono">' + escapeHtml(s.id) + '</div><div class="muted small">Token 尾号：' + escapeHtml(s.tokenPreview || '-') + '</div></td><td><span class="status ' + (s.status === 'enabled' ? 'succeeded' : 'failed') + '">' + escapeHtml(s.status === 'enabled' ? '启用中' : '已停用') + '</span><div class="muted small">' + escapeHtml(licenseText) + '</div></td><td>' + quota + '<div class="muted small">' + escapeHtml(ability) + '</div></td><td><div class="muted small">最近连接：' + escapeHtml(formatTime(s.lastSeenAt)) + '</div><div class="muted small">最近构建：' + escapeHtml(formatTime(s.lastBuildAt)) + '</div></td><td><button class="table-action edit-center-supplier-btn" data-supplier-id="' + escapeHtml(s.id) + '">编辑</button><button class="table-action warning reset-center-token-btn" data-supplier-id="' + escapeHtml(s.id) + '">重置 Token</button></td></tr>';
      }).join('') : '<tr><td colspan="5" class="muted">暂无供应商。创建后会自动生成供应商 ID 和 Token。</td></tr>';
      document.querySelectorAll('.edit-center-supplier-btn').forEach((button) => button.onclick = () => { fillCenterSupplier(centerSuppliers.find((s) => s.id === button.dataset.supplierId)); toggleDrawer('centerSupplier', true); });
      document.querySelectorAll('.reset-center-token-btn').forEach((button) => button.onclick = async () => {
        if (!confirm('确认重置该供应商 Token 吗？旧 Token 会立即失效，供应商需要更新 .env。')) return;
        const saved = await api('/api/center-suppliers/' + encodeURIComponent(button.dataset.supplierId) + '/reset-token', { method: 'POST', body: '{}' });
        $('centerSupplierMsg').textContent = 'Token 已重置，请立即复制新的部署配置';
        await refresh();
        fillCenterSupplier(saved);
        toggleDrawer('centerSupplier', true);
      });
    }
    function endUserModelAccessLabel(count) {
      return Number(count || 0) > 0 ? ('已限制 ' + count + ' 个模型') : '全部启用模型';
    }
    function renderEndUserModelAccessList() {
      const selected = new Set(endUserAllowedModelIds);
      $('endUserModelAccessList').innerHTML = endUserModelAccessModels.length ? endUserModelAccessModels.map((model) => {
        const disabled = model.status !== 'enabled' || model.providerStatus !== 'enabled';
        const tags = '<div class="model-access-meta"><span class="tag">' + escapeHtml(model.providerName || model.providerId || '-') + '</span><span class="tag neutral">' + escapeHtml(disabled ? '已停用' : '可用') + '</span>' + (model.isDefault ? '<span class="tag warn">默认</span>' : '') + '</div>';
        return '<label class="model-access-item' + (disabled ? ' disabled' : '') + '"><input class="end-user-model-access-checkbox" type="checkbox" value="' + escapeHtml(model.id) + '"' + (selected.has(model.id) ? ' checked' : '') + (disabled ? ' disabled' : '') + ' /><div><strong>' + escapeHtml(model.displayName || model.modelId || model.id) + '</strong><div class="muted mono">' + escapeHtml(model.modelId || model.id) + '</div>' + tags + '</div></label>';
      }).join('') : '<p class="muted">暂无模型，请先在模型服务中维护模型。</p>';
    }
    async function openEndUserModelAccess(userId) {
      endUserModelAccessTargetId = userId || '';
      endUserModelAccessModels = [];
      endUserAllowedModelIds = [];
      $('endUserModelAccessMsg').textContent = '正在加载模型授权...';
      $('endUserModelDrawerMeta').textContent = '';
      $('endUserModelAccessList').innerHTML = '';
      toggleDrawer('endUserModel', true);
      try {
        const data = await api('/api/end-users/' + encodeURIComponent(endUserModelAccessTargetId) + '/model-access');
        endUserModelAccessModels = data.models || [];
        endUserAllowedModelIds = data.allowedModelIds || [];
        const user = data.user || endUsers.find((item) => item.id === endUserModelAccessTargetId) || {};
        $('endUserModelDrawerMeta').textContent = (user.displayName || user.username || endUserModelAccessTargetId) + ' · ' + endUserModelAccessLabel(endUserAllowedModelIds.length);
        $('endUserModelAccessMsg').textContent = endUserAllowedModelIds.length ? '勾选后，该用户只可使用选中的启用模型。' : '未勾选任何模型时，该用户可使用全部启用模型。';
        renderEndUserModelAccessList();
      } catch (err) {
        $('endUserModelAccessMsg').textContent = err.message || '加载失败';
      }
    }
    async function saveEndUserModelAccess(clear = false) {
      if (!endUserModelAccessTargetId) return;
      const modelIds = clear ? [] : Array.from(document.querySelectorAll('.end-user-model-access-checkbox:checked')).map((item) => item.value);
      $('endUserModelAccessMsg').textContent = '正在保存...';
      try {
        const data = await api('/api/end-users/' + encodeURIComponent(endUserModelAccessTargetId) + '/model-access', { method: 'POST', body: JSON.stringify({ modelIds }) });
        endUserAllowedModelIds = data.allowedModelIds || [];
        const current = endUsers.find((item) => item.id === endUserModelAccessTargetId);
        if (current) current.allowedModelCount = endUserAllowedModelIds.length;
        const user = data.user || current || {};
        $('endUserModelDrawerMeta').textContent = (user.displayName || user.username || endUserModelAccessTargetId) + ' · ' + endUserModelAccessLabel(endUserAllowedModelIds.length);
        $('endUserModelAccessMsg').textContent = clear ? '已恢复为全部启用模型' : '模型授权已保存';
        renderEndUserModelAccessList();
        renderEndUsers();
      } catch (err) {
        $('endUserModelAccessMsg').textContent = err.message || '保存失败';
      }
    }
    function membershipStatusText(status) { return status === 'disabled' ? '禁用' : status === 'cancelled' ? '已取消' : status === 'expired' ? '已过期' : '启用'; }
    function membershipPackageText(pkg = {}) {
      const parts = [];
      parts.push(Number(pkg.durationDays || 0) > 0 ? Number(pkg.durationDays) + ' 天' : '永久');
      if (Number(pkg.bonusPoints || 0) > 0) parts.push('赠 ' + formatPoints(pkg.bonusPoints) + ' 积分');
      if (Number(pkg.price || 0) > 0) parts.push('￥' + Number(pkg.price).toFixed(2).replace(/\.00$/, ''));
      return parts.join(' · ');
    }
    function membershipCardPackage(card = {}) {
      return card?.package || (Array.isArray(card?.packages) ? card.packages[0] : null) || null;
    }
    function membershipLabel(membership) {
      if (!membership) return '<span class="muted">暂无会员</span>';
      const expires = membership.expiresAt ? formatTime(membership.expiresAt) : '永久';
      const models = Number(membership.allowedModelCount || 0) > 0 ? ('限定 ' + membership.allowedModelCount + ' 个模型') : '全部启用模型';
      return '<strong>' + escapeHtml(membership.cardName || membership.cardId || '-') + '</strong><div class="muted small">等级 ' + escapeHtml(membership.cardLevel || '-') + ' · ' + escapeHtml(membership.packageName || '-') + '</div><div class="muted small">到期：' + escapeHtml(expires) + '</div><div class="muted small">模型：' + escapeHtml(models) + '</div>';
    }
    function fillMembership(card) {
      $('membershipId').value = card?.id || '';
      $('membershipName').value = card?.name || '';
      $('membershipLevel').value = card?.level || 1;
      $('membershipBackgroundUrl').value = card?.backgroundUrl || '';
      $('membershipBackgroundPreview').src = card?.backgroundUrl || '';
      $('membershipDiscountPercent').value = card?.discountPercent ?? 100;
      const modules = new Set(card?.discountModules || []);
      document.querySelectorAll('.membership-module').forEach((item) => { item.checked = modules.has(item.value); });
      $('membershipRedeemOnly').value = card?.redeemOnly ? '1' : '0';
      $('membershipStatus').value = card?.status || 'enabled';
      $('membershipDescription').value = card?.description || '';
      renderMembershipModelAccess(card?.allowedModelIds || []);
      renderMembershipPackages(membershipCardPackage(card) || { name: '会员权益', durationDays: 30, bonusPoints: 0, pointsDurationDays: 0, price: 0, originalPrice: 0, showOriginalPrice: false }, Boolean(card?.systemBuiltin));
      $('membershipMsg').textContent = card ? '正在编辑：' + card.name : '';
      switchMembershipTab('basic');
    }
    function modelTypeText(type) { return { text: '文本', image: '图片', video: '视频', audio: '音频', search: '搜索' }[type] || type || '-'; }
    function renderMembershipModelAccess(allowedModelIds = []) {
      const selected = new Set(allowedModelIds || []);
      $('membershipModelAccessList').innerHTML = membershipModelOptions.length ? membershipModelOptions.map((model) => {
        const disabled = model.status !== 'enabled' || model.providerStatus !== 'enabled';
        const tags = '<div class="model-access-meta"><span class="tag">' + escapeHtml(model.providerName || model.providerId || '-') + '</span><span class="tag neutral">' + escapeHtml(modelTypeText(model.modelType)) + '</span><span class="tag neutral">' + escapeHtml(disabled ? '已停用' : '可用') + '</span></div>';
        return '<label class="model-access-item' + (disabled ? ' disabled' : '') + '"><input class="membership-model-access-checkbox" type="checkbox" value="' + escapeHtml(model.id) + '"' + (selected.has(model.id) ? ' checked' : '') + (disabled ? ' disabled' : '') + ' /><div><strong>' + escapeHtml(model.displayName || model.modelId || model.id) + '</strong><div class="muted mono">' + escapeHtml(model.modelId || model.id) + '</div>' + tags + '</div></label>';
      }).join('') : '<p class="muted">暂无模型，请先在“模型服务 -> 模型管理”中维护模型。</p>';
    }
    function renderMembershipPackages(value = {}, systemBuiltin = false) {
      const item = Array.isArray(value) ? (value[0] || {}) : (value || {});
      const durationDays = systemBuiltin ? 0 : Number(item.durationDays || 0);
      $('membershipPackageRows').innerHTML =
        '<div class="membership-package-row" data-system-builtin="' + (systemBuiltin ? '1' : '0') + '">' +
          '<div class="form-grid"><div><label>权益名称</label><input class="membership-package-name" value="' + escapeHtml(item.name || '') + '" placeholder="会员权益" /></div><div><label>会员时长（天）</label><input class="membership-package-duration" type="number" min="0" value="' + escapeHtml(durationDays) + '"' + (systemBuiltin ? ' disabled title="系统免费会员固定永久"' : '') + ' />' + (systemBuiltin ? '<div class="muted small">系统固定为 0（永久）</div>' : '<div class="muted small">填写 0 表示永久</div>') + '</div></div>' +
          '<div class="form-grid"><div><label>赠送积分</label><input class="membership-package-points" type="number" min="0" step="0.000001" value="' + escapeHtml(item.bonusPoints || 0) + '" /></div><div><label>积分时长（天）</label><input class="membership-package-points-duration" type="number" min="0" value="' + escapeHtml(item.pointsDurationDays || 0) + '" /></div></div>' +
          '<div class="form-grid"><div><label>显示价格（元）</label><input class="membership-package-price" type="number" min="0" step="0.01" value="' + escapeHtml(item.price || 0) + '" /></div><div><label>原价（元）</label><input class="membership-package-original-price" type="number" min="0" step="0.01" value="' + escapeHtml(item.originalPrice || 0) + '" /></div></div>' +
          '<label><input class="membership-package-show-original" type="checkbox"' + (item.showOriginalPrice ? ' checked' : '') + ' /> 显示原价</label>' +
        '</div>';
    }
    function collectMembershipPackages() {
      const row = document.querySelector('.membership-package-row');
      if (!row) return [];
      const item = {
        name: row.querySelector('.membership-package-name')?.value || '',
        durationDays: row.dataset.systemBuiltin === '1' ? 0 : Number(row.querySelector('.membership-package-duration')?.value || 0),
        bonusPoints: Number(row.querySelector('.membership-package-points')?.value || 0),
        pointsDurationDays: Number(row.querySelector('.membership-package-points-duration')?.value || 0),
        price: Number(row.querySelector('.membership-package-price')?.value || 0),
        originalPrice: Number(row.querySelector('.membership-package-original-price')?.value || 0),
        showOriginalPrice: Boolean(row.querySelector('.membership-package-show-original')?.checked),
      };
      return String(item.name || '').trim() ? [item] : [];
    }
    function collectMembership() {
      return {
        id: $('membershipId').value,
        name: $('membershipName').value,
        level: Number($('membershipLevel').value || 1),
        backgroundUrl: $('membershipBackgroundUrl').value,
        discountPercent: Number($('membershipDiscountPercent').value || 100),
        discountModules: Array.from(document.querySelectorAll('.membership-module:checked')).map((item) => item.value),
        redeemOnly: $('membershipRedeemOnly').value === '1',
        status: $('membershipStatus').value,
        description: $('membershipDescription').value,
        modelIds: Array.from(document.querySelectorAll('.membership-model-access-checkbox:checked')).map((item) => item.value),
        package: collectMembershipPackages()[0],
      };
    }
    function switchMembershipTab(tab) {
      activeMembershipTab = tab || 'basic';
      document.querySelectorAll('[data-membership-tab]').forEach((button) => button.classList.toggle('active', button.dataset.membershipTab === activeMembershipTab));
      $('membershipBasicPanel').classList.toggle('hidden', activeMembershipTab !== 'basic');
      $('membershipPackagesPanel').classList.toggle('hidden', activeMembershipTab !== 'packages');
      $('membershipModelsPanel').classList.toggle('hidden', activeMembershipTab !== 'models');
      $('membershipDescriptionPanel').classList.toggle('hidden', activeMembershipTab !== 'description');
    }
    function renderMemberships() {
      const keyword = ($('membershipSearchFilter')?.value || '').trim().toLowerCase();
      const status = $('membershipStatusFilter')?.value || '';
      const filtered = membershipCards.filter((card) => {
        const membershipPackage = membershipCardPackage(card);
        const text = [card.name, card.id, card.level, membershipPackage?.name, membershipPackageText(membershipPackage || {})].join(' ').toLowerCase();
        return (!keyword || text.includes(keyword)) && (!status || card.status === status);
      });
      $('membershipCardMetric').textContent = membershipCards.length;
      $('membershipEnabledMetric').textContent = membershipCards.filter((item) => item.status === 'enabled').length;
      $('membershipPackageMetric').textContent = membershipCards.filter((item) => Number(membershipCardPackage(item)?.durationDays || 0) === 0).length;
      $('membershipRedeemOnlyMetric').textContent = membershipCards.filter((item) => item.redeemOnly).length;
      $('membershipDiscountMetric').textContent = membershipCards.filter((item) => Number(item.discountPercent || 100) < 100 || (item.discountModules || []).length).length;
      $('membershipFooter').textContent = '共 ' + filtered.length + ' 条';
      $('membershipRows').innerHTML = filtered.length ? filtered.map((card) => {
        const membershipPackage = membershipCardPackage(card);
        const packageHtml = membershipPackage ? '<div><strong>' + escapeHtml(membershipPackage.name) + '</strong><div class="muted small">' + escapeHtml(membershipPackageText(membershipPackage)) + '</div></div>' : '-';
        const discount = Number(card.discountPercent || 100) < 100 ? formatPoints(card.discountPercent) + '%' : '未启用';
        const moduleText = (card.discountModules || []).length ? '<div class="muted small">模块：' + escapeHtml(card.discountModules.length) + ' 项</div>' : '<div class="muted small">折扣模块预留</div>';
        const statusClass = card.status === 'enabled' ? 'succeeded' : 'failed';
        const modelLimit = (card.allowedModelIds || []).length ? '<div class="muted small">可用模型：' + escapeHtml((card.allowedModelIds || []).length) + ' 个</div>' : '<div class="muted small">可用模型：全部启用模型</div>';
        const builtinTag = card.systemBuiltin ? '<span class="tag warn">系统内置</span>' : '';
        const actions = '<button class="table-action edit-membership-btn" data-card-id="' + escapeHtml(card.id) + '">编辑</button>' + (!card.systemBuiltin && card.status === 'enabled' ? '<button class="table-action warning disable-membership-btn" data-card-id="' + escapeHtml(card.id) + '">停用</button>' : '') + (!card.systemBuiltin ? '<button class="table-action danger delete-membership-btn" data-card-id="' + escapeHtml(card.id) + '">删除</button>' : '<span class="muted small">不可删除</span>');
        const bg = card.backgroundUrl ? '<img class="membership-table-bg" src="' + escapeHtml(card.backgroundUrl) + '" alt="" />' : '<div class="membership-table-bg empty"></div>';
        return '<tr><td><div class="membership-card-cell">' + bg + '<div><strong>' + escapeHtml(card.name) + '</strong><div class="muted mono">' + escapeHtml(card.id) + '</div><div class="inline-actions"><span class="tag neutral">等级 ' + escapeHtml(card.level) + '</span>' + builtinTag + '</div>' + modelLimit + '</div></div></td><td>' + packageHtml + '</td><td><strong>' + escapeHtml(discount) + '</strong>' + moduleText + '</td><td>' + (card.redeemOnly ? '<span class="status queued">只可兑换</span>' : '<span class="muted">正常购买/分配</span>') + '</td><td><span class="status ' + statusClass + '">' + membershipStatusText(card.status) + '</span></td><td class="muted small">' + escapeHtml(card.description || '-') + '</td><td>' + actions + '</td></tr>';
      }).join('') : '<tr><td colspan="7" class="muted">暂无会员卡，请先新增会员卡。</td></tr>';
      document.querySelectorAll('.edit-membership-btn').forEach((button) => button.onclick = () => { fillMembership(membershipCards.find((item) => item.id === button.dataset.cardId)); toggleDrawer('membership', true); });
      document.querySelectorAll('.disable-membership-btn').forEach((button) => button.onclick = async () => { if (!confirm('确认停用该会员卡吗？')) return; await api('/api/membership-cards/' + encodeURIComponent(button.dataset.cardId), { method: 'DELETE' }); await refresh(); });
      document.querySelectorAll('.delete-membership-btn').forEach((button) => button.onclick = async () => { if (!confirm('确认永久删除该会员卡吗？已有用户使用的会员卡不能删除。')) return; await api('/api/membership-cards/' + encodeURIComponent(button.dataset.cardId) + '/delete', { method: 'DELETE' }); await refresh(); });
    }
    function paymentConfig(provider) { return paymentConfigs.find((item) => item.provider === provider) || {}; }
    function paymentStatusText(status) {
      return { creating: '创建中', pending: '待支付', paid: '已支付', closed: '已关闭', failed: '失败', refunded: '已退款' }[status] || status || '-';
    }
    function paymentStatusClass(status) {
      return status === 'paid' ? 'succeeded' : status === 'pending' || status === 'creating' ? 'queued' : status === 'failed' ? 'failed' : 'neutral';
    }
    function paymentProviderText(provider, mode) {
      if (provider === 'wechat') return '微信支付 · Native';
      return mode === 'page' ? '支付宝 · 电脑网站' : '支付宝 · 当面付';
    }
    function switchPaymentTab(tab) {
      activePaymentTab = tab === 'orders' ? 'orders' : 'config';
      document.querySelectorAll('[data-payment-tab]').forEach((button) => button.classList.toggle('active', button.dataset.paymentTab === activePaymentTab));
      $('paymentConfigPanel').classList.toggle('hidden', activePaymentTab !== 'config');
      $('paymentOrdersPanel').classList.toggle('hidden', activePaymentTab !== 'orders');
    }
    function updateAlipayCertificateFields() {
      $('alipayCertificateFields').classList.toggle('hidden', $('alipayPaymentKeyMode').value !== 'certificate');
      const precreateEnabled = $('alipayPaymentFaceToFaceEnabled').checked;
      const pageEnabled = $('alipayPaymentPagePayEnabled').checked;
      const options = [];
      if (precreateEnabled) options.push(['precreate', '当面付扫码']);
      if (pageEnabled) options.push(['page', '电脑网站支付']);
      const previous = $('alipayPaymentDefaultMode').value;
      $('alipayPaymentDefaultMode').innerHTML = options.length ? options.map(([value, label]) => '<option value="' + value + '">' + label + '</option>').join('') : '<option value="">请先启用支付产品</option>';
      if (options.some(([value]) => value === previous)) $('alipayPaymentDefaultMode').value = previous;
    }
    function setPaymentConfigBadge(provider, config) {
      const badge = $(provider === 'wechat' ? 'wechatConfigBadge' : 'alipayConfigBadge');
      const enabled = config.status === 'enabled';
      badge.className = 'status ' + (enabled ? 'succeeded' : 'neutral');
      badge.textContent = enabled ? (config.lastTestStatus === 'succeeded' ? '已启用 · 已检测' : '已启用') : '已停用';
    }
    function fillPaymentConfig(provider) {
      if (provider === 'wechat') {
        const wechat = paymentConfig('wechat');
        $('wechatPaymentStatus').value = wechat.status || 'disabled';
        $('wechatPaymentPublicBaseUrl').value = wechat.publicBaseUrl || '';
        $('wechatPaymentAppId').value = wechat.appId || '';
        $('wechatPaymentMchId').value = wechat.mchId || '';
        $('wechatPaymentMerchantSerialNo').value = wechat.merchantSerialNo || '';
        $('wechatPaymentPlatformPublicKeyId').value = wechat.platformPublicKeyId || '';
        $('wechatPaymentNativeEnabled').checked = wechat.nativeEnabled !== false;
        $('wechatPaymentNotifyUrl').value = wechat.notifyUrl || '';
        $('wechatPaymentApiV3Key').value = '';
        $('wechatPaymentMerchantPrivateKey').value = '';
        $('wechatPaymentPlatformPublicKey').value = '';
        $('wechatPaymentApiV3Key').placeholder = wechat.apiV3KeyConfigured ? '已安全保存，留空表示不修改' : '请输入 32 字节 API v3 密钥';
        $('wechatPaymentMerchantPrivateKey').placeholder = wechat.merchantPrivateKeyConfigured ? '已安全保存，留空表示不修改' : '粘贴 apiclient_key.pem 内容';
        $('wechatPaymentPlatformPublicKey').placeholder = wechat.platformPublicKeyConfigured ? '已安全保存，留空表示不修改' : '粘贴微信支付平台公钥或证书';
        $('wechatPaymentMsg').textContent = wechat.lastTestMessage || '';
        setPaymentConfigBadge('wechat', wechat);
        return;
      }
      const alipay = paymentConfig('alipay');
      $('alipayPaymentStatus').value = alipay.status || 'disabled';
      $('alipayPaymentEnvironment').value = alipay.environment || 'production';
      $('alipayPaymentPublicBaseUrl').value = alipay.publicBaseUrl || '';
      $('alipayPaymentAppId').value = alipay.appId || '';
      $('alipayPaymentSellerId').value = alipay.sellerId || '';
      $('alipayPaymentKeyMode').value = alipay.keyMode || 'public_key';
      $('alipayPaymentAppCertSn').value = alipay.appCertSn || '';
      $('alipayPaymentRootCertSn').value = alipay.alipayRootCertSn || '';
      $('alipayPaymentFaceToFaceEnabled').checked = Boolean(alipay.faceToFaceEnabled);
      $('alipayPaymentPagePayEnabled').checked = alipay.pagePayEnabled !== false;
      updateAlipayCertificateFields();
      $('alipayPaymentDefaultMode').value = alipay.defaultMode || ($('alipayPaymentFaceToFaceEnabled').checked ? 'precreate' : 'page');
      $('alipayPaymentNotifyUrl').value = alipay.notifyUrl || '';
      $('alipayPaymentAppPrivateKey').value = '';
      $('alipayPaymentPublicKey').value = '';
      $('alipayPaymentAppPrivateKey').placeholder = alipay.appPrivateKeyConfigured ? '已安全保存，留空表示不修改' : '粘贴支付宝应用私钥';
      $('alipayPaymentPublicKey').placeholder = alipay.alipayPublicKeyConfigured ? '已安全保存，留空表示不修改' : '粘贴支付宝公钥或支付宝公钥证书';
      $('alipayPaymentMsg').textContent = alipay.lastTestMessage || '';
      setPaymentConfigBadge('alipay', alipay);
    }
    function collectPaymentConfig(provider) {
      if (provider === 'wechat') return {
        status: $('wechatPaymentStatus').value,
        publicBaseUrl: $('wechatPaymentPublicBaseUrl').value,
        appId: $('wechatPaymentAppId').value,
        mchId: $('wechatPaymentMchId').value,
        merchantSerialNo: $('wechatPaymentMerchantSerialNo').value,
        platformPublicKeyId: $('wechatPaymentPlatformPublicKeyId').value,
        nativeEnabled: $('wechatPaymentNativeEnabled').checked,
        apiV3Key: $('wechatPaymentApiV3Key').value,
        merchantPrivateKey: $('wechatPaymentMerchantPrivateKey').value,
        platformPublicKey: $('wechatPaymentPlatformPublicKey').value,
      };
      return {
        status: $('alipayPaymentStatus').value,
        environment: $('alipayPaymentEnvironment').value,
        publicBaseUrl: $('alipayPaymentPublicBaseUrl').value,
        appId: $('alipayPaymentAppId').value,
        sellerId: $('alipayPaymentSellerId').value,
        keyMode: $('alipayPaymentKeyMode').value,
        appCertSn: $('alipayPaymentAppCertSn').value,
        alipayRootCertSn: $('alipayPaymentRootCertSn').value,
        faceToFaceEnabled: $('alipayPaymentFaceToFaceEnabled').checked,
        pagePayEnabled: $('alipayPaymentPagePayEnabled').checked,
        defaultMode: $('alipayPaymentDefaultMode').value,
        appPrivateKey: $('alipayPaymentAppPrivateKey').value,
        alipayPublicKey: $('alipayPaymentPublicKey').value,
      };
    }
    async function loadPayments() {
      if (!can('payments.manage')) return;
      [paymentConfigs, paymentOrders] = await Promise.all([api('/api/payment-configs'), api('/api/payment-orders')]);
      renderPayments();
    }
    async function savePaymentConfig(provider) {
      const message = $(provider === 'wechat' ? 'wechatPaymentMsg' : 'alipayPaymentMsg');
      message.textContent = '正在保存...';
      try {
        await api('/api/payment-configs/' + provider, { method: 'POST', body: JSON.stringify(collectPaymentConfig(provider)) });
        paymentSettingsDirty[provider] = false;
        await loadPayments();
        message.textContent = '配置已加密保存';
      } catch (err) { message.textContent = err.message; }
    }
    async function testPaymentConfig(provider) {
      const message = $(provider === 'wechat' ? 'wechatPaymentMsg' : 'alipayPaymentMsg');
      if (paymentSettingsDirty[provider]) { message.textContent = '请先保存当前支付配置，再执行检测'; return; }
      message.textContent = '正在连接官方查单接口检测签名与验签...';
      try {
        const result = await api('/api/payment-configs/' + provider + '/test', { method: 'POST', body: '{}' });
        await loadPayments();
        message.textContent = result.message || '配置检测通过';
      } catch (err) { message.textContent = err.message; }
    }
    function renderPaymentOrders() {
      const keyword = ($('paymentOrderSearchFilter')?.value || '').trim().toLowerCase();
      const provider = $('paymentOrderProviderFilter')?.value || '';
      const status = $('paymentOrderStatusFilter')?.value || '';
      const filtered = paymentOrders.filter((order) => {
        const text = [order.orderNo, order.username, order.displayName, order.cardName, order.packageName, order.providerTradeNo].join(' ').toLowerCase();
        return (!keyword || text.includes(keyword)) && (!provider || order.provider === provider) && (!status || order.status === status);
      });
      const paidOrders = paymentOrders.filter((item) => item.status === 'paid');
      $('paymentOrderCount').textContent = paymentOrders.length;
      $('paymentOrderMetric').textContent = paymentOrders.length;
      $('paymentPendingMetric').textContent = paymentOrders.filter((item) => item.status === 'pending' || item.status === 'creating').length;
      $('paymentPaidMetric').textContent = paidOrders.length;
      $('paymentAmountMetric').textContent = '￥' + (paidOrders.reduce((sum, item) => sum + Number(item.amountFen || 0), 0) / 100).toFixed(2);
      $('paymentOrderFooter').textContent = '共 ' + filtered.length + ' 条';
      $('paymentOrderRows').innerHTML = filtered.length ? filtered.map((order) => {
        const user = '<strong>' + escapeHtml(order.displayName || order.username || order.userId) + '</strong><div class="muted mono small">' + escapeHtml(order.username || order.userId) + '</div>';
        const actions = ['creating', 'pending'].includes(order.status)
          ? '<button class="table-action query-payment-order-btn" data-order-id="' + escapeHtml(order.id) + '">查单</button><button class="table-action warning close-payment-order-btn" data-order-id="' + escapeHtml(order.id) + '">关闭</button>'
          : '<button class="table-action query-payment-order-btn" data-order-id="' + escapeHtml(order.id) + '">刷新状态</button>';
        const error = order.lastError ? '<div class="small" style="color:#b42318">' + escapeHtml(order.lastError) + '</div>' : '';
        return '<tr><td><strong class="mono">' + escapeHtml(order.orderNo) + '</strong><div class="muted small">平台单号：' + escapeHtml(order.providerTradeNo || '-') + '</div>' + error + '</td><td>' + user + '</td><td><strong>' + escapeHtml(order.cardName) + '</strong><div class="muted small">' + escapeHtml(order.packageName) + '</div></td><td><strong>￥' + (Number(order.amountFen || 0) / 100).toFixed(2) + '</strong></td><td>' + escapeHtml(paymentProviderText(order.provider, order.mode)) + '</td><td><span class="status ' + paymentStatusClass(order.status) + '">' + escapeHtml(paymentStatusText(order.status)) + '</span></td><td><div class="muted small">创建：' + escapeHtml(formatTime(order.createdAt)) + '</div><div class="muted small">支付：' + escapeHtml(formatTime(order.paidAt)) + '</div><div class="muted small">过期：' + escapeHtml(formatTime(order.expiresAt)) + '</div></td><td>' + actions + '</td></tr>';
      }).join('') : '<tr><td colspan="8" class="muted">暂无支付订单。</td></tr>';
      document.querySelectorAll('.query-payment-order-btn').forEach((button) => button.onclick = async () => {
        try { await api('/api/payment-orders/' + encodeURIComponent(button.dataset.orderId) + '/query', { method: 'POST', body: '{}' }); await loadPayments(); }
        catch (err) { alert(err.message); }
      });
      document.querySelectorAll('.close-payment-order-btn').forEach((button) => button.onclick = async () => {
        if (!confirm('确认关闭该未支付订单吗？')) return;
        try { await api('/api/payment-orders/' + encodeURIComponent(button.dataset.orderId) + '/close', { method: 'POST', body: '{}' }); await loadPayments(); }
        catch (err) { alert(err.message); }
      });
    }
    function renderPayments() {
      if (!$('paymentConfigPanel')) return;
      if (!paymentSettingsDirty.wechat) fillPaymentConfig('wechat');
      if (!paymentSettingsDirty.alipay) fillPaymentConfig('alipay');
      renderPaymentOrders();
      switchPaymentTab(activePaymentTab);
    }
    function updateEndUserMembershipPackageOptions() {
      const card = membershipCards.find((item) => item.id === $('endUserMembershipCard').value);
      const membershipPackage = membershipCardPackage(card);
      $('endUserMembershipPackageInfo').textContent = membershipPackage ? membershipPackage.name + ' · ' + membershipPackageText(membershipPackage) : '暂无可用权益';
      const isPermanentFree = Boolean(card?.systemBuiltin);
      $('endUserMembershipExpiresAt').disabled = isPermanentFree;
      if (isPermanentFree) $('endUserMembershipExpiresAt').value = '';
    }
    function openEndUserMembership(userId) {
      endUserMembershipTargetId = userId || '';
      const user = endUsers.find((item) => item.id === endUserMembershipTargetId) || {};
      $('endUserMembershipDrawerMeta').textContent = (user.displayName || user.username || userId) + ' · ' + (user.membership?.cardName || '暂无会员');
      const enabledCards = membershipCards.filter((item) => item.status === 'enabled');
      $('endUserMembershipCard').innerHTML = enabledCards.length ? enabledCards.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name + ' · 等级 ' + item.level) + '</option>').join('') : '<option value="">暂无启用会员卡</option>';
      $('endUserMembershipCard').value = user.membership?.cardId || enabledCards[0]?.id || '';
      updateEndUserMembershipPackageOptions();
      $('endUserMembershipExpiresAt').value = '';
      $('endUserMembershipMsg').textContent = enabledCards.length ? '' : '请先创建并启用会员卡';
      toggleDrawer('endUserMembership', true);
    }
    async function saveEndUserMembership() {
      if (!endUserMembershipTargetId) return;
      const cardId = $('endUserMembershipCard').value;
      if (!cardId) throw new Error('请先选择会员卡');
      await api('/api/end-users/' + encodeURIComponent(endUserMembershipTargetId) + '/membership', {
        method: 'POST',
        body: JSON.stringify({ cardId, expiresAt: $('endUserMembershipExpiresAt').value }),
      });
      $('endUserMembershipMsg').textContent = '会员已保存';
      await refresh();
      toggleDrawer('endUserMembership', false);
    }
    async function cancelEndUserMembership() {
      if (!endUserMembershipTargetId) return;
      if (!confirm('确认将该用户恢复为所属账号的基础免费会员吗？')) return;
      await api('/api/end-users/' + encodeURIComponent(endUserMembershipTargetId) + '/membership', { method: 'DELETE' });
      await refresh();
      toggleDrawer('endUserMembership', false);
    }
    function fillEndUserCreateForm() {
      $('endUserCreateUsername').value = '';
      $('endUserCreateEmail').value = '';
      $('endUserCreateDisplayName').value = '';
      $('endUserCreatePassword').value = '';
      $('endUserCreateStatus').value = 'enabled';
      setActionFeedback('endUserCreateMsg');
    }
    async function createEndUserAccount() {
      const payload = {
        username: $('endUserCreateUsername').value.trim(),
        email: $('endUserCreateEmail').value.trim(),
        displayName: $('endUserCreateDisplayName').value.trim(),
        password: $('endUserCreatePassword').value,
        status: $('endUserCreateStatus').value,
      };
      if (!payload.username || !payload.email || !payload.password) {
        setActionFeedback('endUserCreateMsg', '请填写登录账号、邮箱和初始密码', 'failed');
        return;
      }
      const result = await runActionWithFeedback({
        button: $('saveEndUserBtn'),
        busyText: '正在创建...',
        messageId: 'endUserCreateMsg',
        successMessage: '终端用户账号创建成功，可直接登录客户端',
        action: () => api('/api/end-users', { method: 'POST', body: JSON.stringify(payload) }),
      });
      if (!result.ok) return;
      $('endUserCreatePassword').value = '';
      await refresh();
      toggleDrawer('endUser', false);
    }
    function renderEndUsers() {
      const keyword = ($('endUserSearchFilter')?.value || '').trim().toLowerCase();
      const status = $('endUserStatusFilter')?.value || '';
      const filteredUsers = endUsers.filter((u) => {
        const projectInfo = sourceProjectInfo(u);
        const text = [u.username, u.email, u.displayName, u.deviceName, u.deviceId, u.sourceProjectId, projectInfo.name, projectInfo.centerId, u.channelCode, sourceAgentAccount(u)].join(' ').toLowerCase();
        return (!keyword || text.includes(keyword)) && (!status || u.status === status);
      });
      if ($('endUserFooter')) $('endUserFooter').textContent = '共 ' + filteredUsers.length + ' 条';
      $('endUserRows').innerHTML = filteredUsers.length ? filteredUsers.map((u) => {
        const source = sourceProjectHtml(u) + (sourceAgentAccount(u) ? '<div>代理账号：' + escapeHtml(sourceAgentAccount(u)) + '</div>' : '');
        const statusClass = u.status === 'enabled' ? 'succeeded' : 'failed';
        const statusTextValue = u.status === 'enabled' ? '启用中' : '已停用';
        const nextStatus = u.status === 'enabled' ? 'disabled' : 'enabled';
        const actionText = u.status === 'enabled' ? '停用' : '启用';
        const proxyReady = modelProviders.some((item) => item.status === 'enabled') && modelProviderKeys.some((item) => item.status === 'enabled') && providerModels.some((item) => item.status === 'enabled') && modelPricingRules.some((item) => item.status === 'enabled');
        const keyStatus = proxyReady ? '<span class="status succeeded">Key 池接入</span>' : '<span class="status queued">待配置 Key 池</span>';
        const modelAccess = '<div class="muted small">模型授权：' + escapeHtml(endUserModelAccessLabel(u.allowedModelCount)) + '</div>';
        const keyCell = (proxyReady ? '<span class="muted">使用来源账号 Key 池轮询</span>' : '<span class="muted">请先在模型服务中配置当前账号 Key 和计费规则</span>') + modelAccess;
        const membershipCell = membershipLabel(u.membership);
        const canOperateUser = u.canOperate !== false;
        const membershipAction = canOperateUser && can('memberships.manage') ? '<button class="table-action end-user-membership-btn" data-user-id="' + escapeHtml(u.id) + '">分配会员</button>' : '';
        const operationActions = canOperateUser
          ? membershipAction + '<button class="table-action end-user-models-btn" data-user-id="' + escapeHtml(u.id) + '">模型授权</button><button class="table-action end-user-credit-btn" data-user-id="' + escapeHtml(u.id) + '">调整积分</button><button class="table-action warning end-user-status-btn" data-user-id="' + escapeHtml(u.id) + '" data-status="' + nextStatus + '">' + actionText + '</button><button class="table-action end-user-password-btn" data-user-id="' + escapeHtml(u.id) + '">重置密码</button>'
          : '<span class="muted small">非当前账号名下，仅可查看</span>';
        return '<tr><td><strong>' + escapeHtml(u.displayName || u.username) + '</strong><div class="muted mono">' + escapeHtml(u.username) + '</div><div class="muted small mono">邮箱：' + escapeHtml(u.email || '-') + '</div></td><td><span class="status ' + statusClass + '">' + statusTextValue + '</span><div style="margin-top:6px">' + keyStatus + '</div></td><td><strong>' + escapeHtml(formatPoints(u.creditBalance)) + '</strong><div class="muted small">积分</div></td><td>' + membershipCell + '</td><td>' + keyCell + '</td><td class="muted small">' + (source || '-') + '</td><td><div class="muted small">' + sourceDeviceHtml(u) + '</div></td><td><div class="muted small">注册：' + escapeHtml(formatTime(u.createdAt)) + '</div><div class="muted small">登录：' + escapeHtml(formatTime(u.lastLoginAt)) + '</div></td><td><div class="inline-actions">' + operationActions + '</div></td></tr>';
      }).join('') : '<tr><td colspan="9" class="muted">暂无终端用户。客户端注册后会显示在这里。</td></tr>';
      document.querySelectorAll('.end-user-status-btn').forEach((button) => button.onclick = async () => { await api('/api/end-users/' + encodeURIComponent(button.dataset.userId) + '/status', { method: 'POST', body: JSON.stringify({ status: button.dataset.status }) }); await refresh(); });
      document.querySelectorAll('.end-user-password-btn').forEach((button) => button.onclick = async () => { const password = prompt('请输入新的终端用户密码，至少 6 位'); if (!password) return; await api('/api/end-users/' + encodeURIComponent(button.dataset.userId) + '/password', { method: 'POST', body: JSON.stringify({ password }) }); alert('终端用户密码已重置'); });
      document.querySelectorAll('.end-user-credit-btn').forEach((button) => button.onclick = () => adjustCredits(button.dataset.userId));
      document.querySelectorAll('.end-user-models-btn').forEach((button) => button.onclick = () => openEndUserModelAccess(button.dataset.userId));
      document.querySelectorAll('.end-user-membership-btn').forEach((button) => button.onclick = () => openEndUserMembership(button.dataset.userId));
    }
    function renderLedgerFilterOptions() {
      const ownerSelect = $('ledgerOwnerFilter');
      const selectedOwner = ownerSelect?.value || '';
      ownerSelect.classList.toggle('hidden', me.role !== 'admin');
      if (me.role === 'admin') {
        const agents = users.filter((item) => item.role === 'agent');
        const ownerOptions = '<option value="">全部代理商及平台</option><option value="' + escapeHtml(me.id) + '">只看自己（' + escapeHtml(me.displayName || me.username) + '）</option>'
          + agents.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.displayName || item.username) + '</option>').join('');
        if (ownerSelect.innerHTML !== ownerOptions) {
          ownerSelect.innerHTML = ownerOptions;
          ownerSelect.value = selectedOwner;
        }
      }
      const selectedUser = $('ledgerUserFilter')?.value || '';
      const visibleUsers = selectedOwner ? endUsers.filter((item) => String(item.operationOwnerUserId || '') === selectedOwner) : endUsers;
      const userOptions = '<option value="">全部用户</option>' + visibleUsers.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.displayName || item.username) + '</option>').join('');
      if ($('ledgerUserFilter').innerHTML !== userOptions) {
        $('ledgerUserFilter').innerHTML = userOptions;
        $('ledgerUserFilter').value = visibleUsers.some((item) => item.id === selectedUser) ? selectedUser : '';
      }
    }
    async function loadModelServiceUpdateStatus() {
      if (!canAny(['model_providers.manage', 'provider_models.manage', 'pricing_rules.manage'])) {
        modelServiceUpdate = null;
        return null;
      }
      try {
        modelServiceUpdate = await api('/api/model-service/update-status');
      } catch (err) {
        modelServiceUpdate = { updateAvailable: false, error: err.message, scopes: {} };
      }
      return modelServiceUpdate;
    }
    async function loadCuratedSkillUpdateStatus() {
      if (!canAny(['curated_skills.view', 'curated_skills.distribute'])) {
        curatedSkillUpdate = null;
        return null;
      }
      try {
        curatedSkillUpdate = await api('/api/curated-skill-sync/update-status');
      } catch (err) {
        curatedSkillUpdate = { enabled: false, updateAvailable: false, error: err.message, items: [] };
      }
      $('syncCuratedSkillsBtn')?.classList.toggle('hidden', !curatedSkillUpdate?.enabled || !canAny(['curated_skills.view', 'curated_skills.distribute']));
      if ($('syncCuratedSkillsBtn')) $('syncCuratedSkillsBtn').disabled = curatedSyncRunning;
      return curatedSkillUpdate;
    }
    async function loadCuratedAgentUpdateStatus() {
      if (!canAny(['curated_agents.view', 'curated_agents.distribute'])) {
        curatedAgentUpdate = null;
        return null;
      }
      try { curatedAgentUpdate = await api('/api/curated-agent-sync/update-status'); }
      catch (err) { curatedAgentUpdate = { enabled: false, updateAvailable: false, error: err.message, items: [] }; }
      renderCuratedAgentSyncStatus();
      return curatedAgentUpdate;
    }
    async function loadCreditLedger({ page = 1, renderAfter = true } = {}) {
      if (!can('credits.manage')) return;
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(Number($('creditLedgerPageSize')?.value || creditLedgerPage.pageSize || 20)),
      });
      const userId = $('ledgerUserFilter')?.value || '';
      const changeType = $('ledgerTypeFilter')?.value || '';
      const ownerUserId = me.role === 'admin' ? ($('ledgerOwnerFilter')?.value || '') : '';
      if (userId) params.set('userId', userId);
      if (changeType) params.set('changeType', changeType);
      if (ownerUserId) params.set('ownerUserId', ownerUserId);
      const result = await api('/api/credits/ledger?' + params.toString());
      creditLedger = Array.isArray(result?.items) ? result.items : [];
      creditLedgerPage = {
        total: Number(result?.total || 0),
        page: Number(result?.page || page),
        pageSize: Number(result?.pageSize || params.get('pageSize') || 20),
        totalPages: Math.max(1, Number(result?.totalPages || 1)),
        filteredConsumed: Number(result?.filteredConsumed || 0),
        totalConsumed: Number(result?.totalConsumed || 0),
      };
      if (renderAfter) renderKeys();
    }
    function renderKeys() {
      renderLedgerFilterOptions();
      $('creditUserMetric').textContent = String(creditLedgerPage.total);
      $('creditBalanceMetric').textContent = formatPoints(creditLedgerPage.filteredConsumed);
      $('creditConsumedMetric').textContent = formatPoints(creditLedgerPage.totalConsumed);
      const keyPoolReady = modelProviderKeys.some((item) => item.status === 'enabled') && modelPricingRules.some((item) => item.status === 'enabled');
      $('creditGatewayMetric').textContent = keyPoolReady ? '已配置' : '待配置';
      $('creditLedgerRows').innerHTML = creditLedger.length ? creditLedger.map((item) => {
        const delta = Number(item.pointsDelta || 0);
        const tone = delta < 0 ? 'failed' : 'succeeded';
        const userText = item.displayName || item.username || item.userId || '-';
        const model = item.modelName ? escapeHtml(item.modelName) : '-';
        const provider = item.providerName ? '<div class="muted small">' + escapeHtml(item.providerName) + (item.providerKeyPreview ? ' · ' + escapeHtml(item.providerKeyPreview) : '') + '</div>' : '';
        const tokens = item.totalTokens ? '<div class="muted small">输入 ' + escapeHtml(item.promptTokens || 0) + ' · 输出 ' + escapeHtml(item.completionTokens || 0) + ' · 总计 ' + escapeHtml(item.totalTokens || 0) + '</div>' : '';
        const status = item.deductStatus && item.deductStatus !== 'succeeded' ? '<div class="muted small">扣费状态：' + escapeHtml(item.deductStatus) + '</div>' : '';
        return '<tr><td class="muted small">' + escapeHtml(formatTime(item.createdAt)) + '</td><td>' + escapeHtml(userText) + '<div class="muted small">个人用户</div></td><td><span class="status ' + tone + '">' + escapeHtml((delta > 0 ? '+' : '') + formatPoints(delta)) + '</span><div class="muted small">' + escapeHtml(ledgerTypeText(item.changeType)) + '</div></td><td>' + model + provider + tokens + status + '</td><td class="muted small">' + escapeHtml(item.note || '-') + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="muted">暂无积分流水。</td></tr>';
      $('creditLedgerPageInfo').textContent = '共 ' + creditLedgerPage.total + ' 条 · 第 ' + creditLedgerPage.page + ' / ' + creditLedgerPage.totalPages + ' 页';
      $('creditLedgerPageSize').value = String(creditLedgerPage.pageSize);
      $('creditLedgerPrevBtn').disabled = creditLedgerPage.page <= 1;
      $('creditLedgerNextBtn').disabled = creditLedgerPage.page >= creditLedgerPage.totalPages;
    }
    function redeemStatusText(item) {
      if (!item) return '-';
      if (item.status === 'unused' && item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now()) return '已过期';
      return { unused: '未使用', used: '已兑换', disabled: '已停用' }[item.status] || item.status || '-';
    }
    function redeemStatusClass(item) {
      if (!item) return 'neutral';
      if (item.status === 'used') return 'succeeded';
      if (item.status === 'disabled' || (item.status === 'unused' && item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now())) return 'failed';
      return 'queued';
    }
    function redeemBenefitText(item) {
      if (item?.rewardType === 'membership') {
        const card = item.membershipCardName || item.membershipCardId || '会员卡';
        const membershipPackage = item.membershipPackageName || item.membershipPackage?.name || '默认权益';
        const bonusPoints = Number(item.membershipPackage?.bonusPoints || 0);
        return card + ' / ' + membershipPackage + (bonusPoints > 0 ? '（赠 ' + formatPoints(bonusPoints) + ' 积分）' : '');
      }
      return formatPoints(item?.points || 0) + ' 积分';
    }
    function redeemBenefitHtml(item) {
      if (item?.rewardType === 'membership') {
        const bonusPoints = Number(item.membershipPackage?.bonusPoints || 0);
        return '<span class="pill">会员卡</span><div><strong>' + escapeHtml(item.membershipCardName || item.membershipCardId || '会员卡') + '</strong></div><div class="muted small">' + escapeHtml(item.membershipPackageName || item.membershipPackage?.name || '默认权益') + (bonusPoints > 0 ? ' · 赠 ' + escapeHtml(formatPoints(bonusPoints)) + ' 积分' : '') + '</div>';
      }
      return '<span class="pill">积分</span><div><strong>' + escapeHtml(formatPoints(item?.points || 0)) + '</strong></div>';
    }
    function updateRedeemMembershipPackageOptions() {
      const cardId = $('redeemMembershipCardId')?.value || '';
      const card = redeemMembershipOptions.find((item) => item.id === cardId);
      const membershipPackage = membershipCardPackage(card);
      $('redeemMembershipPackageInfo').textContent = membershipPackage ? membershipPackage.name + ' · ' + membershipPackageText(membershipPackage) : '暂无可用权益';
    }
    function updateRedeemMembershipCardOptions() {
      const selected = $('redeemMembershipCardId')?.value || '';
      $('redeemMembershipCardId').innerHTML = redeemMembershipOptions.length
        ? redeemMembershipOptions.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name || item.id) + '</option>').join('')
        : '<option value="">暂无可用会员卡</option>';
      if (redeemMembershipOptions.some((item) => item.id === selected)) $('redeemMembershipCardId').value = selected;
      updateRedeemMembershipPackageOptions();
    }
    function updateRedeemRewardTypeFields() {
      const rewardType = $('redeemRewardType')?.value === 'membership' ? 'membership' : 'points';
      $('redeemPointsFields').classList.toggle('hidden', rewardType !== 'points');
      $('redeemMembershipFields').classList.toggle('hidden', rewardType !== 'membership');
      $('redeemPoints').required = rewardType === 'points';
      $('redeemMembershipCardId').required = rewardType === 'membership';
      $('redeemBatchName').placeholder = rewardType === 'membership' ? '例如：黄金会员月卡' : '例如：100 积分体验券';
      if (rewardType === 'membership') updateRedeemMembershipCardOptions();
    }
    function collectRedeemCodePayload() {
      const rewardType = $('redeemRewardType').value === 'membership' ? 'membership' : 'points';
      const payload = {
        name: $('redeemBatchName').value,
        rewardType,
        quantity: $('redeemQuantity').value,
        expiresAt: $('redeemExpiresAt').value,
        note: $('redeemNote').value,
      };
      if (rewardType === 'membership') {
        payload.membershipCardId = $('redeemMembershipCardId').value;
      } else {
        payload.points = $('redeemPoints').value;
      }
      return payload;
    }
    function fillRedeemCodeForm() {
      $('redeemRewardType').value = 'points';
      $('redeemBatchName').value = '';
      $('redeemPoints').value = '';
      $('redeemQuantity').value = 10;
      $('redeemExpiresAt').value = '';
      $('redeemNote').value = '';
      $('redeemGeneratedCodes').value = '';
      $('redeemCodeMsg').textContent = '';
      updateRedeemMembershipCardOptions();
      updateRedeemRewardTypeFields();
    }
    function maskedRedeemCode(value, preview = '') {
      const code = String(value || '');
      if (!code) return preview || '-';
      if (code.length <= 12) return code;
      return code.slice(0, 7) + '********' + code.slice(-6);
    }
    function redeemCreatorHtml(item) {
      const username = item.createdByUsername || item.createdBy || '';
      const displayName = item.createdByDisplayName || username || '未知账号';
      const role = item.createdByRole === 'agent' ? '代理商' : (item.createdByRole === 'admin' ? '平台管理员' : '');
      return '<strong>' + escapeHtml(displayName) + '</strong><div class="muted mono">' + escapeHtml(username || '-') + '</div>' + (role ? '<span class="pill">' + escapeHtml(role) + '</span>' : '');
    }
    async function copyTextToClipboard(text, messageId = 'redeemCodeMsg') {
      const value = String(text || '');
      if (!value) { if ($(messageId)) $(messageId).textContent = '暂无可复制内容'; return false; }
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(value);
          if ($(messageId)) $(messageId).textContent = '已复制';
          return true;
        }
      } catch {}
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      if ($(messageId)) $(messageId).textContent = copied ? '已复制' : '复制失败，请手动复制';
      return copied;
    }
    async function generateRedeemCodes() {
      $('redeemCodeMsg').textContent = '正在生成兑换码...';
      const result = await api('/api/redeem-codes/generate', { method: 'POST', body: JSON.stringify(collectRedeemCodePayload()) });
      $('redeemGeneratedCodes').value = (result.codes || []).join(String.fromCharCode(10));
      $('redeemCodeMsg').textContent = '已生成 ' + (result.codes || []).length + ' 个' + (result.batch?.rewardType === 'membership' ? '会员卡' : '积分') + '兑换码（' + redeemBenefitText(result.batch) + '），请及时复制保存明文。';
      await refresh();
      toggleDrawer('redeemCode', true);
    }
    async function copyRedeemCodes() {
      const textarea = $('redeemGeneratedCodes');
      const text = textarea.value;
      if (!text) { $('redeemCodeMsg').textContent = '暂无可复制的兑换码'; return; }
      await copyTextToClipboard(text);
    }
    function renderRedeemCodes() {
      if (!can('redeem_codes.manage')) return;
      const status = $('redeemCodeStatusFilter')?.value || '';
      const keyword = ($('redeemCodeSearchFilter')?.value || '').trim().toLowerCase();
      const filtered = redeemCodes.filter((item) => {
        const effectiveStatus = item.status === 'unused' && item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now() ? 'expired' : item.status;
        const redeemProject = sourceProjectInfo({ sourceProjectId: item.usedSourceProjectId || item.usedUserSourceProjectId, centerProjectId: item.usedCenterProjectId || item.usedUserCenterProjectId });
        const text = [item.codePreview, item.batchName, item.membershipCardName, item.membershipPackageName, item.usedByUsername, item.usedByDisplayName, item.createdByUsername, item.createdByDisplayName, item.note, item.usedSourceProjectId, item.usedUserSourceProjectId, redeemProject.name, redeemProject.centerId, item.usedChannelCode, item.usedUserChannelCode, item.usedDeviceName, item.usedUserDeviceName, item.usedDeviceId, item.usedUserDeviceId].join(' ').toLowerCase();
        return (!status || effectiveStatus === status) && (!keyword || text.includes(keyword));
      });
      const unused = redeemCodes.filter((item) => item.status === 'unused' && !(item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now())).length;
      const used = redeemCodes.filter((item) => item.status === 'used').length;
      $('redeemCodeCount').textContent = redeemCodes.length;
      $('redeemBatchMetric').textContent = redeemBatches.length;
      $('redeemUnusedMetric').textContent = unused;
      $('redeemUsedMetric').textContent = used;
      $('redeemCodeFooter').textContent = '共 ' + filtered.length + ' 条';
      $('redeemCodeRows').innerHTML = filtered.length ? filtered.map((item) => {
        const user = item.usedByUsername ? escapeHtml(item.usedByDisplayName || item.usedByUsername) + '<div class="muted mono">' + escapeHtml(item.usedByUsername) + '</div>' : '-';
        const redeemSourceDetail = sourceProjectHtml({
          sourceProjectId: item.usedSourceProjectId || item.usedUserSourceProjectId,
          centerProjectId: item.usedCenterProjectId || item.usedUserCenterProjectId,
          channelCode: item.usedChannelCode || item.usedUserChannelCode,
        }) + '<div class="muted small" style="margin-top:6px">' + sourceDeviceHtml({
          deviceName: item.usedDeviceName || item.usedUserDeviceName,
          deviceId: item.usedDeviceId || item.usedUserDeviceId,
          appVersion: item.usedAppVersion || item.usedUserAppVersion,
        }) + '</div>';
        const redeemSource = item.usedAt ? redeemSourceDetail : '-';
        const creator = redeemCreatorHtml(item);
        const hasPlain = Boolean(item.codePlain);
        const codeText = hasPlain ? maskedRedeemCode(item.codePlain, item.codePreview) : (item.codePreview || '-');
        const codeActions = hasPlain ? '<button class="table-action view-redeem-code-btn" data-code-id="' + escapeHtml(item.id) + '">查看</button><button class="table-action copy-redeem-code-btn" data-code-id="' + escapeHtml(item.id) + '">复制</button>' : '<span class="muted small">历史码仅保留尾号</span>';
        const actions = (item.status === 'unused' ? '<button class="table-action warning disable-redeem-code-btn" data-code-id="' + escapeHtml(item.id) + '">停用</button>' : '') + (item.status === 'used' ? '<span class="muted small">已兑换</span>' : '<button class="table-action danger delete-redeem-code-btn" data-code-id="' + escapeHtml(item.id) + '">删除</button>');
        return '<tr><td><strong class="mono redeem-code-value" data-code-id="' + escapeHtml(item.id) + '" data-visible="0">' + escapeHtml(codeText) + '</strong><div class="inline-actions" style="margin-top:6px">' + codeActions + '</div></td><td>' + escapeHtml(item.batchName || item.batchId || '-') + '<div class="muted small">' + escapeHtml(item.note || '') + '</div></td><td>' + creator + '</td><td>' + redeemBenefitHtml(item) + '</td><td><span class="status ' + redeemStatusClass(item) + '">' + escapeHtml(redeemStatusText(item)) + '</span></td><td>' + user + '</td><td class="muted small">' + redeemSource + '</td><td><div class="muted small">创建：' + escapeHtml(formatTime(item.createdAt)) + '</div><div class="muted small">使用：' + escapeHtml(formatTime(item.usedAt)) + '</div><div class="muted small">有效期：' + escapeHtml(formatTime(item.expiresAt)) + '</div></td><td>' + actions + '</td></tr>';
      }).join('') : '<tr><td colspan="9" class="muted">暂无兑换码。</td></tr>';
      $('redeemBatchRows').innerHTML = redeemBatches.length ? redeemBatches.map((batch) => {
        const counts = '未用 ' + (batch.unusedCount || 0) + ' · 已兑 ' + (batch.usedCount || 0) + ' · 停用 ' + (batch.disabledCount || 0) + ' · 过期 ' + (batch.expiredCount || 0);
        return '<tr><td><strong>' + escapeHtml(batch.name || batch.id) + '</strong><div class="muted mono">' + escapeHtml(batch.id) + '</div></td><td>' + redeemCreatorHtml(batch) + '</td><td>' + redeemBenefitHtml(batch) + '</td><td>' + escapeHtml(batch.quantity || 0) + '<div class="muted small">' + escapeHtml(counts) + '</div></td><td><span class="status ' + (batch.status === 'enabled' ? 'succeeded' : 'failed') + '">' + escapeHtml(batch.status === 'enabled' ? '启用' : '停用') + '</span></td><td>' + escapeHtml(formatTime(batch.expiresAt)) + '</td><td class="muted small">' + escapeHtml(batch.note || '-') + '</td></tr>';
      }).join('') : '<tr><td colspan="7" class="muted">暂无兑换码批次。</td></tr>';
      document.querySelectorAll('.disable-redeem-code-btn').forEach((button) => button.onclick = async () => {
        if (!confirm('确认停用该兑换码吗？停用后终端用户将无法兑换。')) return;
        await api('/api/redeem-codes/' + encodeURIComponent(button.dataset.codeId), { method: 'DELETE' });
        await refresh();
      });
      document.querySelectorAll('.delete-redeem-code-btn').forEach((button) => button.onclick = async () => {
        if (!confirm('确认永久删除该兑换码吗？已删除的兑换码无法恢复。')) return;
        await api('/api/redeem-codes/' + encodeURIComponent(button.dataset.codeId) + '/delete', { method: 'DELETE' });
        await refresh();
      });
      document.querySelectorAll('.view-redeem-code-btn').forEach((button) => button.onclick = () => {
        const item = redeemCodes.find((code) => code.id === button.dataset.codeId);
        if (!item?.codePlain) return;
        const target = Array.from(document.querySelectorAll('.redeem-code-value')).find((element) => element.dataset.codeId === button.dataset.codeId);
        if (!target) return;
        const visible = target.dataset.visible === '1';
        target.dataset.visible = visible ? '0' : '1';
        target.textContent = visible ? maskedRedeemCode(item.codePlain, item.codePreview) : item.codePlain;
        button.textContent = visible ? '查看' : '隐藏';
      });
      document.querySelectorAll('.copy-redeem-code-btn').forEach((button) => button.onclick = async () => {
        const item = redeemCodes.find((code) => code.id === button.dataset.codeId);
        await copyTextToClipboard(item?.codePlain || '', 'redeemCodeMsg');
      });
    }
    function renderProviders() {
      refreshProviderSelects();
      const canModifyProviders = canWriteModelProviders();
      const providerWriteDenied = modelProviderWriteDeniedMessage();
      if ($('openModelProviderDrawerBtn')) {
        $('openModelProviderDrawerBtn').disabled = !canModifyProviders;
        $('openModelProviderDrawerBtn').title = canModifyProviders ? '' : providerWriteDenied;
      }
      if ($('newModelProviderBtn')) {
        $('newModelProviderBtn').disabled = !canModifyProviders;
        $('newModelProviderBtn').title = canModifyProviders ? '' : providerWriteDenied;
      }
      if ($('saveModelProviderBtn')) {
        $('saveModelProviderBtn').disabled = !canModifyProviders;
        $('saveModelProviderBtn').title = canModifyProviders ? '' : providerWriteDenied;
      }
      if ($('providerMetric')) $('providerMetric').textContent = String(modelProviders.length);
      if ($('providerKeyMetric')) $('providerKeyMetric').textContent = String(modelProviderKeys.length);
      if ($('providerModelMetric')) $('providerModelMetric').textContent = String(providerModels.length);
      if ($('pricingMetric')) $('pricingMetric').textContent = String(modelPricingRules.length);
      const providerKeyword = ($('providerSearchFilter')?.value || '').trim().toLowerCase();
      const providerStatus = $('providerStatusFilter')?.value || '';
      const filteredProviders = modelProviders.filter((provider) => {
        const text = [provider.id, provider.name, provider.baseUrl].join(' ').toLowerCase();
        return (!providerKeyword || text.includes(providerKeyword)) && (!providerStatus || provider.status === providerStatus);
      });
      $('modelProviderFooter').textContent = '共 ' + filteredProviders.length + ' 条';
      $('modelProviderRows').innerHTML = filteredProviders.length ? filteredProviders.map((provider) => {
        const keyCount = modelProviderKeys.filter((item) => item.providerId === provider.id && item.status !== 'disabled').length;
        const modelCount = providerModels.filter((item) => item.providerId === provider.id && item.status !== 'disabled').length;
        const disabledAttr = canModifyProviders ? '' : ' disabled title="' + escapeHtml(providerWriteDenied) + '"';
        return '<tr><td><strong>' + escapeHtml(provider.name) + '</strong><div class="muted mono">' + escapeHtml(provider.id) + '</div>' + (provider.isDefault ? '<span class="tag warn">默认</span>' : '') + '</td><td><span class="status ' + (provider.status === 'enabled' ? 'succeeded' : 'failed') + '">' + escapeHtml(provider.status === 'enabled' ? '启用' : '禁用') + '</span></td><td><div>Key ' + escapeHtml(keyCount) + '</div><div class="muted small">模型 ' + escapeHtml(modelCount) + '</div></td><td>' + escapeHtml(provider.sortOrder || 0) + '</td><td><button class="table-action edit-model-provider-btn" data-provider-id="' + escapeHtml(provider.id) + '"' + disabledAttr + '>编辑</button><button class="table-action warning disable-model-provider-btn" data-provider-id="' + escapeHtml(provider.id) + '"' + disabledAttr + '>禁用</button><button class="table-action danger delete-model-provider-btn" data-provider-id="' + escapeHtml(provider.id) + '"' + disabledAttr + '>删除</button></td></tr>';
      }).join('') : '<tr><td colspan="5" class="muted">暂无服务商。</td></tr>';
      const keyProvider = $('modelKeyProviderFilter')?.value || '';
      const keyStatus = $('modelKeyStatusFilter')?.value || '';
      const filteredKeys = modelProviderKeys.filter((key) => (!keyProvider || key.providerId === keyProvider) && (!keyStatus || key.status === keyStatus));
      $('modelKeyFooter').textContent = '共 ' + filteredKeys.length + ' 条';
      $('modelKeyRows').innerHTML = filteredKeys.length ? filteredKeys.map((key) => {
        const disabledAttr = '';
        return '<tr><td><span class="tag">' + escapeHtml(providerName(key.providerId)) + '</span><div class="muted mono">' + escapeHtml(key.providerId) + '</div></td><td class="mono">' + escapeHtml(key.keyPreview || '-') + '<div class="muted small">' + escapeHtml(key.notes || '') + '</div></td><td><span class="status ' + (key.status === 'enabled' ? 'succeeded' : 'failed') + '">' + escapeHtml(key.status === 'enabled' ? '启用' : '禁用') + '</span></td><td>' + escapeHtml(key.weight || 1) + '</td><td><div class="muted small">成功：' + escapeHtml(key.successCount || 0) + ' / 失败：' + escapeHtml(key.failureCount || 0) + '</div><div class="muted small">最近轮询：' + escapeHtml(formatTime(key.lastUsedAt)) + '</div></td><td><button class="table-action edit-model-key-btn" data-key-id="' + escapeHtml(key.id) + '"' + disabledAttr + '>编辑</button><button class="table-action warning disable-model-key-btn" data-key-id="' + escapeHtml(key.id) + '"' + disabledAttr + '>禁用</button><button class="table-action danger delete-model-key-btn" data-key-id="' + escapeHtml(key.id) + '"' + disabledAttr + '>删除</button></td></tr>';
      }).join('') : '<tr><td colspan="6" class="muted">暂无 Key。后续模型调用会从启用 Key 中轮询。</td></tr>';
      const modelKeyword = ($('providerModelSearchFilter')?.value || '').trim().toLowerCase();
      const modelProvider = $('providerModelProviderFilter')?.value || '';
      const modelStatus = $('providerModelStatusFilter')?.value || '';
      const filteredModels = providerModels.filter((model) => {
        const text = [model.displayName, model.modelId, model.id, model.description].join(' ').toLowerCase();
        return (!modelKeyword || text.includes(modelKeyword)) && (!modelProvider || model.providerId === modelProvider) && (!modelStatus || model.status === modelStatus);
      });
      $('providerModelFooter').textContent = '共 ' + filteredModels.length + ' 条';
      $('providerModelRows').innerHTML = filteredModels.length ? filteredModels.map((model) => {
        const rule = pricingForModel(model.id);
        const pricingStatus = rule ? (rule.status === 'enabled' ? '<span class="status succeeded">已配置</span>' : '<span class="status failed">已停用</span>') : '<span class="muted">未配置</span>';
        const endpoint = model.endpointPath || (model.modelType === 'image' ? '/images/generations' : (model.modelType === 'search' ? '/v1/web-search' : '/chat/completions'));
        const disabledAttr = '';
        const description = model.description ? '<div class="muted small" title="' + escapeHtml(model.description) + '">' + escapeHtml(model.description) + '</div>' : '';
        return '<tr><td><strong>' + escapeHtml(model.displayName) + '</strong>' + (model.isDefault ? ' <span class="tag warn">默认</span>' : '') + '<div class="muted small">' + escapeHtml(modelTypeLabel(model.modelType)) + '</div>' + description + '</td><td class="mono">' + escapeHtml(model.modelId) + '<div class="muted small">' + escapeHtml(endpoint) + '</div></td><td>' + escapeHtml(providerName(model.providerId)) + '</td><td><div class="muted small">' + escapeHtml(capabilitySummary(model.capabilities)) + '</div><div class="muted small">上下文：' + escapeHtml(model.contextWindow || '-') + '</div></td><td><span class="status ' + (model.status === 'enabled' ? 'succeeded' : 'failed') + '">' + escapeHtml(model.status === 'enabled' ? '启用' : '禁用') + '</span></td><td>' + pricingStatus + '</td><td>' + escapeHtml(model.sortOrder || 0) + '</td><td><button class="table-action edit-provider-model-btn" data-model-id="' + escapeHtml(model.id) + '"' + disabledAttr + '>编辑</button><button class="table-action edit-pricing-rule-btn" data-model-id="' + escapeHtml(model.id) + '"' + disabledAttr + '>计费</button><button class="table-action warning disable-provider-model-btn" data-model-id="' + escapeHtml(model.id) + '"' + disabledAttr + '>禁用</button><button class="table-action danger delete-provider-model-btn" data-model-id="' + escapeHtml(model.id) + '"' + disabledAttr + '>删除</button></td></tr>';
      }).join('') : '<tr><td colspan="8" class="muted">暂无模型。</td></tr>';
      const pricingProvider = $('pricingProviderFilter')?.value || '';
      const pricingBilling = $('pricingBillingFilter')?.value || '';
      const pricingStatus = $('pricingStatusFilter')?.value || '';
      const filteredRules = modelPricingRules.filter((rule) => (!pricingProvider || rule.providerId === pricingProvider) && (!pricingBilling || rule.billingType === pricingBilling) && (!pricingStatus || rule.status === pricingStatus));
      $('pricingRuleFooter').textContent = '共 ' + filteredRules.length + ' 条';
      $('pricingRuleRows').innerHTML = filteredRules.length ? filteredRules.map((rule) => {
        const model = providerModels.find((item) => item.id === rule.providerModelId);
        const price = rule.billingType === 'per_request' ? (formatPoints(rule.pointsPerRequest) + ' 积分 / 次') : ('输入 ' + formatPoints(rule.inputPointsPerMTokens) + ' · 输出 ' + formatPoints(rule.outputPointsPerMTokens) + ' 积分/M tokens');
        const billing = rule.billingType === 'per_request' ? '按次' : '按 token';
        const disabledAttr = '';
        return '<tr><td>' + escapeHtml(providerName(model?.providerId || rule.providerId)) + '</td><td><strong>' + escapeHtml(model?.displayName || rule.displayName || rule.providerModelId) + '</strong><div class="muted mono">' + escapeHtml(model?.modelId || rule.modelId || rule.providerModelId) + '</div></td><td>' + escapeHtml(billing) + '</td><td>' + escapeHtml(price) + '</td><td><span class="status ' + (rule.status === 'enabled' ? 'succeeded' : 'failed') + '">' + escapeHtml(rule.status === 'enabled' ? '启用' : '禁用') + '</span></td><td><button class="table-action edit-pricing-rule-row-btn" data-rule-id="' + escapeHtml(rule.id) + '"' + disabledAttr + '>编辑</button><button class="table-action warning disable-pricing-rule-btn" data-rule-id="' + escapeHtml(rule.id) + '"' + disabledAttr + '>禁用</button><button class="table-action danger delete-pricing-rule-btn" data-rule-id="' + escapeHtml(rule.id) + '"' + disabledAttr + '>删除</button></td></tr>';
      }).join('') : '<tr><td colspan="6" class="muted">暂无计费规则。</td></tr>';
      document.querySelectorAll('.edit-model-provider-btn').forEach((button) => button.onclick = () => { if (!canWriteModelProviders()) { $('modelProviderMsg').textContent = modelProviderWriteDeniedMessage(); return; } fillModelProvider(modelProviders.find((item) => item.id === button.dataset.providerId)); toggleDrawer('modelProvider', true); });
      document.querySelectorAll('.disable-model-provider-btn').forEach((button) => button.onclick = async () => { if (!canWriteModelProviders()) { $('modelProviderMsg').textContent = modelProviderWriteDeniedMessage(); return; } if (!confirm('确认停用该服务商吗？')) return; await api('/api/model-providers/' + encodeURIComponent(button.dataset.providerId), { method: 'DELETE' }); await refresh(); });
      document.querySelectorAll('.delete-model-provider-btn').forEach((button) => button.onclick = async () => { if (!canWriteModelProviders()) { $('modelProviderMsg').textContent = modelProviderWriteDeniedMessage(); return; } if (!confirm('确认永久删除该服务商吗？关联 Key、模型、计费规则和用户模型授权都会一起删除。')) return; await api('/api/model-providers/' + encodeURIComponent(button.dataset.providerId) + '/delete', { method: 'DELETE' }); await refresh(); });
      document.querySelectorAll('.edit-model-key-btn').forEach((button) => button.onclick = () => { fillModelKey(modelProviderKeys.find((item) => item.id === button.dataset.keyId)); toggleDrawer('modelKey', true); });
      document.querySelectorAll('.disable-model-key-btn').forEach((button) => button.onclick = async () => { if (!confirm('确认停用该 Key 吗？')) return; await api('/api/model-provider-keys/' + encodeURIComponent(button.dataset.keyId), { method: 'DELETE' }); await refresh(); });
      document.querySelectorAll('.delete-model-key-btn').forEach((button) => button.onclick = async () => { if (!confirm('确认永久删除该 Key 吗？')) return; await api('/api/model-provider-keys/' + encodeURIComponent(button.dataset.keyId) + '/delete', { method: 'DELETE' }); await refresh(); });
      document.querySelectorAll('.edit-provider-model-btn').forEach((button) => button.onclick = () => { fillProviderModel(providerModels.find((item) => item.id === button.dataset.modelId)); toggleDrawer('providerModel', true); });
      document.querySelectorAll('.disable-provider-model-btn').forEach((button) => button.onclick = async () => { if (!confirm('确认停用该模型吗？')) return; await api('/api/provider-models/' + encodeURIComponent(button.dataset.modelId), { method: 'DELETE' }); await refresh(); });
      document.querySelectorAll('.delete-provider-model-btn').forEach((button) => button.onclick = async () => { if (!confirm('确认永久删除该模型吗？关联计费规则和用户模型授权都会一起删除。')) return; await api('/api/provider-models/' + encodeURIComponent(button.dataset.modelId) + '/delete', { method: 'DELETE' }); await refresh(); });
      document.querySelectorAll('.edit-pricing-rule-btn').forEach((button) => button.onclick = () => { fillPricingRule(pricingForModel(button.dataset.modelId) || { providerModelId: button.dataset.modelId }); switchTab('pricingRules'); toggleDrawer('pricingRule', true); });
      document.querySelectorAll('.edit-pricing-rule-row-btn').forEach((button) => button.onclick = () => { fillPricingRule(modelPricingRules.find((item) => item.id === button.dataset.ruleId)); toggleDrawer('pricingRule', true); });
      document.querySelectorAll('.disable-pricing-rule-btn').forEach((button) => button.onclick = async () => { if (!confirm('确认停用该计费规则吗？')) return; await api('/api/model-pricing-rules/' + encodeURIComponent(button.dataset.ruleId), { method: 'DELETE' }); await refresh(); });
      document.querySelectorAll('.delete-pricing-rule-btn').forEach((button) => button.onclick = async () => { if (!confirm('确认永久删除该计费规则吗？')) return; await api('/api/model-pricing-rules/' + encodeURIComponent(button.dataset.ruleId) + '/delete', { method: 'DELETE' }); await refresh(); });
    }
    function renderSelfUpdate() {
      if (me.role !== 'admin' || !$('updatesView')) return;
      const status = selfUpdate || {};
      $('selfCurrentVersion').textContent = status.currentVersion ? 'v' + status.currentVersion : '-';
      $('selfLatestVersion').textContent = status.latestVersion ? 'v' + status.latestVersion : '-';
      $('selfUpdateState').textContent = status.configured === false ? '未配置' : (status.updateAvailable ? '可升级' : '已是最新');
      $('selfManifestUrl').textContent = status.manifestUrl || '-';
      if (document.activeElement !== $('selfManifestUrlInput')) $('selfManifestUrlInput').value = status.manifestUrl || '';
      $('selfReleaseNotes').textContent = status.releaseNotes || status.error || '暂无发布说明';
      const history = Array.isArray(status.history) ? status.history.slice(0, 20) : [];
      $('selfUpdateHistory').innerHTML = history.length ? history.map((item) => '<div class="release-history-item"><div class="release-history-head"><strong>v' + escapeHtml(item.version || '-') + '</strong><span class="muted small">' + escapeHtml(formatTime(item.publishedAt)) + '</span></div><div class="release-history-notes">' + escapeHtml(item.releaseNotes || '暂无更新说明') + '</div></div>').join('') : '<p class="muted">暂无历史版本。</p>';
      $('selfUpdateLog').textContent = status.lastLog || '暂无日志';
      $('applyUpdateBtn').disabled = status.configured === false || !status.updateAvailable;
      $('checkUpdateBtn').disabled = false;
    }
    function updateReminderReleaseNotes(status = {}) {
      return status.releaseNotes || '暂无更新说明';
    }
    function maybeShowUpdateReminder() {
      const status = selfUpdate || {};
      const latestVersion = String(status.latestVersion || '').trim();
      if (!can('self_update.manage') || (!forcedUpdateInProgress && (!status.updateAvailable || !latestVersion))) {
        $('updateReminderBackdrop')?.classList.add('hidden');
        return false;
      }
      $('updateReminderCurrentVersion').textContent = status.currentVersion ? 'v' + status.currentVersion : '-';
      $('updateReminderLatestVersion').textContent = latestVersion ? 'v' + latestVersion : '-';
      $('updateReminderPublishedAt').textContent = status.publishedAt ? formatTime(status.publishedAt) : '';
      $('updateReminderNotes').textContent = updateReminderReleaseNotes(status);
      $('updateReminderBackdrop').classList.remove('hidden');
      return true;
    }
    async function applySelfUpdate({ forced = false } = {}) {
      if (!forced && !confirm('确认立即升级后台吗？升级过程中服务会自动重启，通常需要几十秒恢复。')) return;
      const button = forced ? $('applyForcedUpdateBtn') : $('applyUpdateBtn');
      button.disabled = true;
      if (forced) {
        forcedUpdateInProgress = true;
        $('forcedUpdateMessage').textContent = '正在下载并应用更新，请不要关闭页面...';
        $('applyForcedUpdateBtn').textContent = '正在更新...';
        maybeShowUpdateReminder();
      } else {
        $('selfUpdateLog').textContent = '正在下载并应用更新，请稍候...';
      }
      try {
        selfUpdate = await api('/api/self-update/apply', { method: 'POST', body: '{}' });
        renderSelfUpdate();
        const message = '升级已执行，后台正在重启。页面将在服务恢复后自动刷新。';
        $('selfUpdateLog').textContent = message;
        $('forcedUpdateMessage').textContent = message;
        $('applyForcedUpdateBtn').textContent = '正在重启...';
        setTimeout(() => location.reload(), 12000);
      } catch (err) {
        forcedUpdateInProgress = false;
        if (forced) {
          $('forcedUpdateMessage').textContent = '升级失败：' + err.message;
          $('applyForcedUpdateBtn').textContent = '重试更新';
        } else {
          $('selfUpdateLog').textContent = err.message;
        }
        await loadSelfUpdateStatus();
        renderSelfUpdate();
        maybeShowUpdateReminder();
        button.disabled = false;
      }
    }
    function modelUpdateScopeDefinitions() {
      return [
        { key: 'providers', label: '服务商', permission: 'model_providers.manage' },
        { key: 'models', label: '模型管理', permission: 'provider_models.manage' },
        { key: 'pricingRules', label: '计费规则', permission: 'pricing_rules.manage' },
      ];
    }
    function availableModelUpdateScopes() {
      const scopes = modelServiceUpdate?.scopes || {};
      return modelUpdateScopeDefinitions().filter((item) => can(item.permission) && Number(scopes[item.key]?.added || 0) > 0);
    }
    function closeModelUpdateReminder() {
      const signature = String(modelServiceUpdate?.signature || '').trim();
      if (signature) dismissedModelUpdateSignature = signature;
      $('modelUpdateReminderBackdrop')?.classList.add('hidden');
      if (!maybeShowCuratedUpdateReminder()) maybeShowCuratedMcpUpdateReminder();
    }
    function maybeShowModelUpdateReminder() {
      if (!$('updateReminderBackdrop')?.classList.contains('hidden')) return false;
      const signature = String(modelServiceUpdate?.signature || '').trim();
      const available = availableModelUpdateScopes();
      if (!modelServiceUpdate?.updateAvailable || !signature || !available.length || dismissedModelUpdateSignature === signature) {
        $('modelUpdateReminderBackdrop')?.classList.add('hidden');
        return false;
      }
      $('modelUpdateReminderList').innerHTML = available.map((definition) => {
        const scope = modelServiceUpdate.scopes[definition.key] || {};
        const names = (scope.items || []).map((item) => item.name || item.id).filter(Boolean);
        const hiddenCount = Math.max(0, Number(scope.added || 0) - names.length);
        const detail = names.join('、') + (hiddenCount ? '，另有 ' + hiddenCount + ' 项' : '');
        return '<div class="model-update-reminder-item"><strong>' + escapeHtml(definition.label) + '新增 ' + escapeHtml(scope.added || 0) + ' 项</strong><div class="model-update-reminder-names">' + escapeHtml(detail || '存在新增配置') + '</div></div>';
      }).join('');
      $('modelUpdateReminderMessage').textContent = modelServiceUpdate.checkedAt ? '检查时间：' + formatTime(modelServiceUpdate.checkedAt) : '';
      $('applyModelUpdateReminderBtn').disabled = false;
      $('applyModelUpdateReminderBtn').textContent = '立即更新';
      $('modelUpdateReminderBackdrop').classList.remove('hidden');
      return true;
    }
    async function applyModelServiceUpdates() {
      const available = availableModelUpdateScopes();
      if (!available.length) {
        closeModelUpdateReminder();
        return;
      }
      const button = $('applyModelUpdateReminderBtn');
      button.disabled = true;
      button.textContent = '正在更新...';
      const summaries = [];
      try {
        for (const definition of available) {
          $('modelUpdateReminderMessage').textContent = '正在同步' + definition.label + '...';
          const result = await api('/api/model-service/sync', { method: 'POST', body: JSON.stringify({ scope: definition.key }) });
          summaries.push(definition.label + '：' + syncResultText(definition.key, result));
        }
        dismissedModelUpdateSignature = String(modelServiceUpdate?.signature || '');
        await loadProviderConfig();
        await loadModelServiceUpdateStatus();
        render();
        $('modelUpdateReminderBackdrop').classList.add('hidden');
        alert('模型服务更新完成\n' + summaries.join('\n'));
      } catch (err) {
        $('modelUpdateReminderMessage').textContent = '更新失败：' + err.message;
        button.disabled = false;
        button.textContent = '重新更新';
      }
    }
    function closeCuratedUpdateReminder() {
      if (curatedSyncRunning) return;
      const signature = String(curatedSkillUpdate?.signature || '').trim();
      if (signature) dismissedCuratedUpdateSignature = signature;
      $('curatedUpdateReminderBackdrop')?.classList.add('hidden');
      maybeShowCuratedMcpUpdateReminder();
    }
    function maybeShowCuratedUpdateReminder() {
      if (!$('updateReminderBackdrop')?.classList.contains('hidden') || !$('modelUpdateReminderBackdrop')?.classList.contains('hidden') || !$('curatedMcpUpdateReminderBackdrop')?.classList.contains('hidden') || !$('curatedAgentUpdateReminderBackdrop')?.classList.contains('hidden')) return false;
      const signature = String(curatedSkillUpdate?.signature || '').trim();
      const items = Array.isArray(curatedSkillUpdate?.items) ? curatedSkillUpdate.items : [];
      if (curatedSyncRunning) { $('curatedUpdateReminderBackdrop').classList.remove('hidden'); return true; }
      if (!curatedSkillUpdate?.enabled || !curatedSkillUpdate?.updateAvailable || !signature || !items.length || dismissedCuratedUpdateSignature === signature) {
        $('curatedUpdateReminderBackdrop')?.classList.add('hidden');
        return false;
      }
      const changeText = { added: '新增', updated: '升级', removed: '下架' };
      $('curatedUpdateReminderList').innerHTML = items.map((item) => '<div class="model-update-reminder-item"><strong>' + escapeHtml(changeText[item.changeType] || '更新') + ' · ' + escapeHtml(item.name || item.id) + '</strong><div class="model-update-reminder-names">' + escapeHtml(item.version ? ('v' + item.version) : '') + '</div></div>').join('');
      $('curatedUpdateReminderMessage').textContent = '新增 ' + Number(curatedSkillUpdate.added || 0) + ' 项，升级 ' + Number(curatedSkillUpdate.updated || 0) + ' 项，下架 ' + Number(curatedSkillUpdate.removed || 0) + ' 项';
      $('applyCuratedUpdateReminderBtn').disabled = false;
      $('applyCuratedUpdateReminderBtn').textContent = '立即同步';
      $('applyCuratedUpdateReminderBtn').dataset.completed = '';
      $('curatedSyncProgress').className = 'curated-sync-progress hidden';
      $('curatedUpdateReminderBackdrop').classList.remove('hidden');
      return true;
    }
    function closeCuratedMcpUpdateReminder() {
      if (curatedMcpSyncRunning) return;
      const signature = String(curatedMcpUpdate?.signature || '').trim();
      if (signature) dismissedCuratedMcpUpdateSignature = signature;
      $('curatedMcpUpdateReminderBackdrop')?.classList.add('hidden');
      maybeShowCuratedAgentUpdateReminder();
    }
    function maybeShowCuratedMcpUpdateReminder() {
      if (!$('updateReminderBackdrop')?.classList.contains('hidden') || !$('modelUpdateReminderBackdrop')?.classList.contains('hidden') || !$('curatedUpdateReminderBackdrop')?.classList.contains('hidden') || !$('curatedAgentUpdateReminderBackdrop')?.classList.contains('hidden')) return false;
      const signature = String(curatedMcpUpdate?.signature || '').trim();
      const items = Array.isArray(curatedMcpUpdate?.items) ? curatedMcpUpdate.items : [];
      if (curatedMcpSyncRunning) { $('curatedMcpUpdateReminderBackdrop').classList.remove('hidden'); return true; }
      if (!curatedMcpUpdate?.enabled || !curatedMcpUpdate?.updateAvailable || !signature || !items.length || dismissedCuratedMcpUpdateSignature === signature) {
        $('curatedMcpUpdateReminderBackdrop')?.classList.add('hidden');
        return false;
      }
      const changeText = { added: '新增', updated: '升级', removed: '下架' };
      $('curatedMcpUpdateReminderList').innerHTML = items.map((item) => '<div class="model-update-reminder-item"><strong>' + escapeHtml(changeText[item.changeType] || '更新') + ' · ' + escapeHtml(item.name || item.id) + '</strong><div class="model-update-reminder-names">' + escapeHtml(item.version ? ('v' + item.version) : '') + '</div></div>').join('');
      $('curatedMcpUpdateReminderMessage').textContent = '新增 ' + Number(curatedMcpUpdate.added || 0) + ' 项，升级 ' + Number(curatedMcpUpdate.updated || 0) + ' 项，下架 ' + Number(curatedMcpUpdate.removed || 0) + ' 项';
      $('applyCuratedMcpUpdateReminderBtn').disabled = false;
      $('applyCuratedMcpUpdateReminderBtn').textContent = '立即同步';
      $('applyCuratedMcpUpdateReminderBtn').dataset.completed = '';
      $('curatedMcpReminderProgress').className = 'curated-sync-progress hidden';
      $('curatedMcpUpdateReminderBackdrop').classList.remove('hidden');
      return true;
    }
    function closeCuratedAgentUpdateReminder() {
      if (curatedAgentSyncRunning) return;
      const signature = String(curatedAgentUpdate?.signature || '').trim();
      if (signature) dismissedCuratedAgentUpdateSignature = signature;
      $('curatedAgentUpdateReminderBackdrop')?.classList.add('hidden');
    }
    function maybeShowCuratedAgentUpdateReminder() {
      if (!$('updateReminderBackdrop')?.classList.contains('hidden') || !$('modelUpdateReminderBackdrop')?.classList.contains('hidden') || !$('curatedUpdateReminderBackdrop')?.classList.contains('hidden') || !$('curatedMcpUpdateReminderBackdrop')?.classList.contains('hidden')) return false;
      const signature = String(curatedAgentUpdate?.signature || '').trim();
      const items = Array.isArray(curatedAgentUpdate?.items) ? curatedAgentUpdate.items : [];
      if (curatedAgentSyncRunning) { $('curatedAgentUpdateReminderBackdrop').classList.remove('hidden'); return true; }
      if (!curatedAgentUpdate?.enabled || !curatedAgentUpdate?.updateAvailable || !signature || !items.length || dismissedCuratedAgentUpdateSignature === signature) {
        $('curatedAgentUpdateReminderBackdrop')?.classList.add('hidden');
        return false;
      }
      const changeText = { added: '新增', updated: '升级', removed: '下架' };
      $('curatedAgentUpdateReminderList').innerHTML = items.map((item) => '<div class="model-update-reminder-item"><strong>' + escapeHtml(changeText[item.changeType] || '更新') + ' · ' + escapeHtml(item.name || item.id) + '</strong><div class="model-update-reminder-names">' + escapeHtml(item.version ? ('v' + item.version) : '') + '</div></div>').join('');
      $('curatedAgentUpdateReminderMessage').textContent = '新增 ' + Number(curatedAgentUpdate.added || 0) + ' 项，升级 ' + Number(curatedAgentUpdate.updated || 0) + ' 项，下架 ' + Number(curatedAgentUpdate.removed || 0) + ' 项';
      $('applyCuratedAgentUpdateReminderBtn').disabled = false;
      $('applyCuratedAgentUpdateReminderBtn').textContent = '立即同步';
      $('applyCuratedAgentUpdateReminderBtn').dataset.completed = '';
      $('curatedAgentReminderProgress').className = 'curated-sync-progress hidden';
      $('curatedAgentUpdateReminderBackdrop').classList.remove('hidden');
      return true;
    }
    function renderCuratedAgentReminderProgress(job = {}) {
      const stageText = { queued: '准备同步', checking: '检查目录', catalog: '目录已获取', skipped: '跳过冲突项', imported: '专家已处理', cleanup: '处理下架项', reporting: '上报结果', completed: '同步完成', failed: '同步失败' };
      const percent = Math.max(0, Math.min(100, Number(job.percent || 0)));
      const progress = $('curatedAgentReminderProgress');
      progress.className = 'curated-sync-progress' + (job.status === 'completed' ? ' completed' : '') + (job.status === 'failed' ? ' failed' : '');
      $('curatedAgentReminderProgressStage').textContent = stageText[job.stage] || '正在同步';
      $('curatedAgentReminderProgressPercent').textContent = Math.round(percent) + '%';
      $('curatedAgentReminderProgressFill').style.width = percent + '%';
      $('curatedAgentReminderProgressMessage').textContent = job.error ? ('失败原因：' + job.error) : (job.message || '正在同步精选专家…');
      $('curatedAgentReminderProgressCount').textContent = Number(job.total || 0) > 0 ? (Math.min(Number(job.current || 0), Number(job.total || 0)) + ' / ' + Number(job.total || 0)) : '';
    }
    function renderCuratedMcpReminderProgress(job = {}) {
      const stageText = { queued: '准备同步', checking: '检查目录', catalog: '目录已获取', saving: '写入 MCP', cleanup: '处理下架项', reporting: '上报结果', completed: '同步完成', failed: '同步失败' };
      const percent = Math.max(0, Math.min(100, Number(job.percent || 0)));
      const progress = $('curatedMcpReminderProgress');
      progress.className = 'curated-sync-progress' + (job.status === 'completed' ? ' completed' : '') + (job.status === 'failed' ? ' failed' : '');
      $('curatedMcpReminderProgressStage').textContent = stageText[job.stage] || '正在同步';
      $('curatedMcpReminderProgressPercent').textContent = Math.round(percent) + '%';
      $('curatedMcpReminderProgressFill').style.width = percent + '%';
      $('curatedMcpReminderProgressMessage').textContent = job.error ? ('失败原因：' + job.error) : (job.message || '正在同步精选 MCP…');
      $('curatedMcpReminderProgressCount').textContent = Number(job.total || 0) > 0 ? (Math.min(Number(job.current || 0), Number(job.total || 0)) + ' / ' + Number(job.total || 0)) : '';
    }
    function renderCuratedSyncProgress(job = {}) {
      const stageText = { queued: '准备同步', checking: '检查目录', catalog: '目录已获取', downloading: '下载技能包', verifying: '校验签名', saving: '写入候选库', checked: '检查版本', skipped: '跳过冲突项', imported: '技能已处理', cleanup: '处理下架项', reporting: '上报结果', completed: '同步完成', failed: '同步失败' };
      const percent = Math.max(0, Math.min(100, Number(job.percent || 0)));
      const progress = $('curatedSyncProgress');
      progress.className = 'curated-sync-progress' + (job.status === 'completed' ? ' completed' : '') + (job.status === 'failed' ? ' failed' : '');
      $('curatedSyncProgressStage').textContent = stageText[job.stage] || '正在同步';
      $('curatedSyncProgressPercent').textContent = Math.round(percent) + '%';
      $('curatedSyncProgressFill').style.width = percent + '%';
      $('curatedSyncProgressMessage').textContent = job.error ? ('失败原因：' + job.error) : (job.message || '正在同步精选技能…');
      $('curatedSyncProgressCount').textContent = Number(job.total || 0) > 0 ? (Math.min(Number(job.current || 0), Number(job.total || 0)) + ' / ' + Number(job.total || 0)) : '';
    }
    function setCuratedSyncControls(running) {
      curatedSyncRunning = running;
      $('closeCuratedUpdateReminderIconBtn').disabled = running;
      $('closeCuratedUpdateReminderBtn').disabled = running;
      $('applyCuratedUpdateReminderBtn').disabled = running;
      if ($('syncCuratedSkillsBtn')) $('syncCuratedSkillsBtn').disabled = running;
    }
    async function waitForCuratedSyncJob(jobId) {
      for (;;) {
        const job = await api('/api/curated-skill-sync/jobs/' + encodeURIComponent(jobId));
        renderCuratedSyncProgress(job);
        if (job.status !== 'running') return job;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    async function applyCuratedSkillUpdates() {
      const button = $('applyCuratedUpdateReminderBtn');
      if (button.dataset.completed === '1') { closeCuratedUpdateReminder(); return; }
      setCuratedSyncControls(true);
      button.textContent = '正在同步...';
      renderCuratedSyncProgress({ status: 'running', stage: 'queued', message: '正在创建同步任务…', percent: 0 });
      try {
        const started = await api('/api/curated-skill-sync', { method: 'POST', body: JSON.stringify({ async: true }) });
        curatedSyncJobId = started.id;
        renderCuratedSyncProgress(started);
        const job = await waitForCuratedSyncJob(curatedSyncJobId);
        if (job.status !== 'completed') throw new Error(job.error || job.message || '同步任务失败');
        const result = job.result || {};
        dismissedCuratedUpdateSignature = String(curatedSkillUpdate?.signature || '');
        await loadCuratedSkillUpdateStatus();
        curatedSkills = can('curated_skills.view') ? await api('/api/curated-skills').catch(() => []) : [];
        curatedDistributions = can('curated_skills.view') ? await api('/api/curated-skill-distributions').catch(() => []) : [];
        renderCuratedSkills();
        const failed = Array.isArray(result.failed) ? result.failed.length : 0;
        $('curatedUpdateReminderMessage').textContent = '同步完成：新增 ' + Number(result.added || 0) + ' 项，升级 ' + Number(result.updated || 0) + ' 项，下架 ' + Number(result.removed || 0) + (failed ? ('，失败 ' + failed + ' 项') : '，全部成功');
        showOperationToast('精选技能同步完成', 'succeeded');
        button.dataset.completed = '1';
        button.textContent = '完成';
      } catch (err) {
        $('curatedUpdateReminderMessage').textContent = '同步失败：' + err.message;
        renderCuratedSyncProgress({ status: 'failed', stage: 'failed', message: '同步失败', error: err.message, percent: Number($('curatedSyncProgressPercent').textContent.replace('%', '')) || 0 });
        button.dataset.completed = '';
        button.textContent = '重新同步';
        showOperationToast('精选技能同步失败：' + err.message, 'failed');
      } finally {
        curatedSyncJobId = '';
        setCuratedSyncControls(false);
      }
    }
    function renderDiagnostics() {
      const data = diagnostics || {};
      const checks = [
        ['后台 API', data.apiCheckUrl || '-'],
        ['客户端注册', data.clientRegisterUrl || '-'],
        ['正式更新示例', data.updateCheckExampleUrl || '-'],
      ];
      (data.updateCheckUrls || []).forEach((item) => {
        checks.push(['已发布项目 ' + (item.projectId || '-'), item.latestUrl || '-']);
      });
      if (data.protocolFallback?.apiCheckUrl) checks.push(['后台 API 备用协议', data.protocolFallback.apiCheckUrl]);
      if (data.protocolFallback?.clientRegisterUrl) checks.push(['客户端注册备用协议', data.protocolFallback.clientRegisterUrl]);
      if (data.protocolFallback?.updateCheckExampleUrl) checks.push(['正式更新备用示例', data.protocolFallback.updateCheckExampleUrl]);
      $('diagnosticChecks').innerHTML = checks.map(([label, url]) => '<div><h3>' + escapeHtml(label) + '</h3><p class="muted mono">' + escapeHtml(url) + '</p></div>').join('');
      $('diagnosticLog').textContent = diagnostics ? JSON.stringify(data, null, 2) : '点击刷新诊断';
    }
    async function loadDiagnostics() {
      diagnostics = await api('/api/diagnostics');
      renderDiagnostics();
    }
    function setSelfUpdateMessage(message, tone = '') {
      const element = $('selfUpdateMessage');
      if (!element) return;
      element.classList.remove('hidden', 'succeeded', 'failed', 'queued');
      if (tone) element.classList.add(tone);
      element.textContent = message;
    }
    function checkedUpdateMessage() {
      const status = selfUpdate || {};
      const checkedAt = new Date().toLocaleString('zh-CN', { hour12: false });
      if (status.configured === false) return '检查完成：当前未配置更新源，请先配置 AI_ADMIN_UPDATE_MANIFEST_URL。检查时间：' + checkedAt;
      if (status.updateAvailable) return '检查完成：发现新版本 v' + (status.latestVersion || '-') + '，当前版本 v' + (status.currentVersion || '-') + '。检查时间：' + checkedAt;
      return '检查完成：当前已是最新版本 v' + (status.currentVersion || status.latestVersion || '-') + '。检查时间：' + checkedAt;
    }
    function renderPlanned(tab) {
      const content = plannedContent[tab] || ['规划模块', '当前先预留入口，后续按业务优先级实现。', ['数据模型', '操作入口', '权限策略']];
      $('plannedTitle').textContent = content[0];
      $('plannedSubtitle').textContent = pageMeta[tab]?.[1] || '该能力会按业务优先级逐步实现';
      $('plannedCardTitle').textContent = content[0] + '能力';
      $('plannedDescription').textContent = content[1];
      $('plannedCards').innerHTML = content[2].map((item) => '<div class="card"><h3>' + escapeHtml(item) + '</h3><p class="muted small" style="margin-top:8px">入口已预留，后续会接入真实数据、权限和操作流程。</p></div>').join('');
    }
    function renderAuthStatus() {
      if (!$('authStatusSummary') || !$('authAbilityCards')) return;
      const license = supplierLicense || {};
      const licenseTypeText = { partner: '同行代理', internal: '内部测试' }[license.licenseType] || '同行代理';
      const quotaText = (used, max) => max ? ((used || 0) + ' / ' + max) : '不限';
      const summary = [
        ['授权状态', license.verified ? '已校验' : '未校验'],
        ['授权主体', license.id || license.supplierId || platformSettings.buildCenterSupplierId || '-'],
        ['授权类型', licenseTypeText],
        ['OEM 项目额度', quotaText(license.usedProjects, license.maxProjects)],
        ['构建次数额度', quotaText(license.usedBuilds, license.maxBuilds)],
      ];
      $('authStatusSummary').innerHTML = summary.map(([label, value]) => '<div class="metric"><span class="muted">' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>').join('');
      $('authStatusMessage').textContent = license.message || (license.verified ? '授权正常。' : '未连接官方构建中心时，本地权限只用于体验，不代表官方构建授权。');
      const abilities = [
        ['允许管理后台账号', 'allowAgentManagement'],
        ['允许供应商接入管理', 'allowSupplierManagement'],
        ['允许平台设置', 'allowPlatformSettings'],
        ['允许自定义品牌', 'allowCustomBrand'],
        ['允许自定义 API 服务商', 'allowCustomApiProviders'],
      ];
      $('authAbilityCards').innerHTML = abilities.map(([label, field]) => {
        const enabled = license[field] !== false;
        return '<div class="card"><h3>' + escapeHtml(label) + '</h3><p class="status ' + (enabled ? 'succeeded' : 'failed') + '">' + (enabled ? '已开通' : '未开通') + '</p><p class="muted small" style="margin-top:8px">官方授权字段：' + escapeHtml(field) + '</p></div>';
      }).join('');
    }
    function roleRequirementText(role) {
      return '全部模板可选';
    }
    function supplierAbilityText(ability) {
      return {
        allowAgentManagement: '需具备成员与下级管理授权',
        allowSupplierManagement: '需具备一级代理管理授权',
        allowPlatformSettings: '需具备平台设置授权',
        allowCustomBrand: '需具备自定义品牌授权',
        allowCustomApiProviders: '需具备自定义模型服务授权',
      }[ability] || '受上级主体授权限制';
    }
    function roleCanUsePermissionClient(role, item) {
      if (!item) return false;
      if (item.role === 'admin') return role === 'admin';
      if (item.role === 'agent') return role === 'agent';
      if (item.role === 'admin_or_agent') return role === 'admin' || role === 'agent';
      return false;
    }
    function permissionTags(item) {
      const constrained = item.supplierAbility ? supplierLicense[item.supplierAbility] !== false : true;
      return [
        '<span class="status queued">' + escapeHtml(roleRequirementText(item.role)) + '</span>',
        item.supplierAbility ? '<span class="status ' + (constrained ? 'succeeded' : 'failed') + '">' + escapeHtml(supplierAbilityText(item.supplierAbility)) + '</span>' : '',
        item.officialCenterOnly ? '<span class="status running">仅官方平台</span>' : '',
        item.planned ? '<span class="status queued">规划中</span>' : '',
      ].filter(Boolean).join(' ');
    }
    function permissionListHtml(className, selectedKeys = [], options = {}) {
      const selected = new Set(selectedKeys || []);
      const mode = options.mode || 'checkbox';
      const groups = permissionCatalog || [];
      if (!groups.length) return '<div class="permission-empty">暂无权限点数据。</div>';
      const headerLabel = mode === 'preview' ? '结果' : '启用';
      const body = groups.map((group) => {
        const rows = (group.permissions || []).map((item) => {
          const isDisabled = false;
          const isSelected = selected.has(item.key);
          const control = mode === 'preview'
            ? '<span class="status ' + (isSelected ? 'succeeded' : 'failed') + '">' + (isSelected ? '生效' : '无权限') + '</span>'
            : '<input class="' + className + '" type="checkbox" value="' + escapeHtml(item.key) + '" ' + (isSelected ? 'checked' : '') + (isDisabled ? ' disabled' : '') + ' />';
          const rowTag = mode === 'preview' ? 'div' : 'label';
          const disabledTag = '';
          return '<' + rowTag + ' class="permission-row' + (isDisabled ? ' disabled' : '') + '"><span>' + control + '</span><span class="permission-name"><strong>' + escapeHtml(item.name) + '</strong><span class="muted mono small">' + escapeHtml(item.key) + '</span></span><span class="permission-desc">' + escapeHtml(item.description || '-') + '</span><span class="permission-tags">' + permissionTags(item) + disabledTag + '</span></' + rowTag + '>';
        }).join('');
        return '<div class="permission-section-row">' + escapeHtml(group.group || '未分组') + '</div>' + rows;
      }).join('');
      return '<div class="permission-table"><div class="permission-row header"><span>' + headerLabel + '</span><span>权限点</span><span>说明</span><span>岗位与主体限制</span></div>' + body + '</div>';
    }
    function switchPermissionPanel(tab) {
      activePermissionTab = tab || 'roleTemplates';
      document.querySelectorAll('[data-permission-tab]').forEach((button) => button.classList.toggle('active', button.dataset.permissionTab === activePermissionTab));
      ['roleTemplates', 'groupPermissions', 'permissionPreview', 'permissionCatalog'].forEach((key) => {
        const panel = $(key + 'PermissionPanel');
        if (panel) panel.classList.toggle('hidden', key !== activePermissionTab);
      });
      if (activePermissionTab === 'roleTemplates') switchRoleTemplatePanel(activeRoleTemplateTab);
    }
    function switchRoleTemplatePanel(tab) {
      activeRoleTemplateTab = tab || 'info';
      document.querySelectorAll('[data-role-template-tab]').forEach((button) => button.classList.toggle('active', button.dataset.roleTemplateTab === activeRoleTemplateTab));
      if ($('roleTemplateInfoSubPanel')) $('roleTemplateInfoSubPanel').classList.toggle('hidden', activeRoleTemplateTab !== 'info');
      if ($('roleTemplatePermissionsSubPanel')) $('roleTemplatePermissionsSubPanel').classList.toggle('hidden', activeRoleTemplateTab !== 'permissions');
    }
    function markPermissionEditorDirty() {
      permissionEditorDirty = true;
    }
    function permissionEditorHasFocus() {
      return Boolean(document.activeElement?.closest?.('#permissionsView'));
    }
    function permissionEditorShouldKeepLocalState() {
      return !$('permissionsView')?.classList.contains('hidden') && permissionEditorDirty;
    }
    function renderPermissionCatalogTable() {
      return (permissionCatalog || []).map((group) => {
        const rows = (group.permissions || []).map((item) => '<tr><td><strong>' + escapeHtml(item.name) + '</strong><div class="muted mono small">' + escapeHtml(item.key) + '</div></td><td>' + escapeHtml(item.description || '-') + '</td><td>' + permissionTags(item) + '</td></tr>').join('');
        return '<div style="margin-bottom:14px"><h3 style="margin:0 0 8px">' + escapeHtml(group.group || '未分组') + '</h3><div class="table-scroll"><table><thead><tr><th>权限点</th><th>说明</th><th>岗位与主体限制</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
      }).join('');
    }
    function renderRoleTemplateEditor() {
      if (!$('roleTemplateSelect')) return;
      const currentValue = $('roleTemplateSelect').value;
      $('roleTemplateSelect').innerHTML = '<option value="">新建模板</option>' + roleTemplates.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + '</option>').join('');
      const selected = roleTemplates.find((item) => item.id === currentValue) || roleTemplates[0] || null;
      if (selected) $('roleTemplateSelect').value = selected.id;
      $('roleTemplateName').value = selected?.name || '';
      $('roleTemplateDescription').value = selected?.description || '';
      $('roleTemplateBaseRole').value = 'admin';
      $('roleTemplateSortOrder').value = selected?.sortOrder || 0;
      $('roleTemplateStatus').value = selected?.status || 'enabled';
      $('roleTemplatePermissionList').innerHTML = permissionListHtml('role-template-permission-check', selected?.permissionKeys || []);
      $('roleTemplateMsg').textContent = selected ? ('正在编辑：' + selected.name) : '正在新建角色模板';
    }
    function collectRoleTemplate() {
      return { id: $('roleTemplateSelect').value, name: $('roleTemplateName').value, description: $('roleTemplateDescription').value, baseRole: 'admin', sortOrder: $('roleTemplateSortOrder').value, status: $('roleTemplateStatus').value };
    }
    function renderPermissionGroupEditor() {
      if (!$('permissionGroupSelect')) return;
      const currentValue = $('permissionGroupSelect').value;
      $('permissionGroupSelect').innerHTML = userGroups.length ? userGroups.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + '</option>').join('') : '<option value="">暂无账号分组</option>';
      if (currentValue && userGroups.some((item) => item.id === currentValue)) $('permissionGroupSelect').value = currentValue;
      loadPermissionGroupSelection($('permissionGroupSelect').value || '').catch((err) => { $('permissionGroupMsg').textContent = err.message; });
    }
    async function loadPermissionGroupSelection(groupId) {
      if (!$('permissionGroupPermissionList')) return;
      if (!groupId) {
        $('permissionGroupPermissionList').innerHTML = '<p class="muted">请先创建账号分组。</p>';
        $('permissionGroupCount').value = '0';
        return;
      }
      $('permissionGroupMsg').textContent = '正在加载分组权限...';
      const data = await api('/api/user-groups/' + encodeURIComponent(groupId) + '/permissions');
      $('permissionGroupPermissionList').innerHTML = permissionListHtml('permission-group-check', data.permissionKeys || []);
      $('permissionGroupCount').value = String((data.permissionKeys || []).length);
      $('permissionGroupMsg').textContent = '已加载：' + (data.group?.name || groupId);
    }
    function renderPermissionPreviewOptions() {
      if (!$('permissionPreviewUserSelect')) return;
      const currentValue = $('permissionPreviewUserSelect').value;
      $('permissionPreviewUserSelect').innerHTML = users.length ? users.map((item) => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.displayName || item.username) + ' · ' + escapeHtml(roleText(item.role)) + '</option>').join('') : '<option value="">暂无后台账号</option>';
      if (currentValue && users.some((item) => item.id === currentValue)) $('permissionPreviewUserSelect').value = currentValue;
    }
    async function loadPermissionPreview() {
      const userId = $('permissionPreviewUserSelect')?.value || '';
      if (!userId) return;
      $('permissionPreviewMsg').textContent = '正在加载权限预览...';
      const data = await api('/api/users/' + encodeURIComponent(userId) + '/permission-preview');
      const sourceText = { group: '账号分组', template: '角色模板', 'default-template': '默认角色模板', 'role-default': '角色默认权限' }[data.sourceMode] || data.sourceMode;
      $('permissionPreviewSource').value = sourceText;
      $('permissionPreviewSummary').innerHTML = [
        ['账号', (data.user?.displayName || data.user?.username || '-') + ' · ' + roleText(data.user?.role)],
        ['角色模板', data.roleTemplate?.name || '未选择'],
        ['账号分组', (data.groups || []).map((item) => item.group?.name).filter(Boolean).join(' / ') || '未加入'],
        ['所属主体', data.organizationContext?.organizationId || data.user?.primaryOrganizationId || '-'],
        ['主体级别', ({ 0: '官方平台', 1: '一级代理', 2: '二级代理' }[Number(data.organizationContext?.organizationLevel)] || '-')],
        ['数据范围', ({ self: '仅本组织', children: '仅直属下级', subtree: '本组织及直属下级', platform: '官方平台全局' }[data.organizationContext?.dataScope] || '-')],
        ['最终权限', (data.effectivePermissionKeys || []).length + ' 个'],
      ].map(([label, value]) => '<div class="metric"><span class="muted">' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>').join('');
      const effective = new Set(data.effectivePermissionKeys || []);
      $('permissionPreviewList').innerHTML = permissionListHtml('', Array.from(effective), { mode: 'preview' });
      $('permissionPreviewMsg').textContent = '预览已更新';
    }
    function renderPermissions() {
      if (!$('permissionCatalogList')) return;
      if (permissionEditorShouldKeepLocalState()) return;
      if (!Array.isArray(permissionCatalog) || permissionCatalog.length === 0) {
        $('permissionCatalogList').innerHTML = '<div class="permission-empty">暂无权限点数据。</div>';
        return;
      }
      renderRoleTemplateEditor();
      renderPermissionGroupEditor();
      renderPermissionPreviewOptions();
      $('permissionCatalogList').innerHTML = renderPermissionCatalogTable();
      switchPermissionPanel(activePermissionTab);
      switchRoleTemplatePanel(activeRoleTemplateTab);
    }
    function renderCuratedSkills() {
      $('curatedSkillCount').textContent = curatedSkills.length;
      $('openCuratedSkillDrawerBtn').classList.toggle('hidden', !can('curated_skills.manage'));
      $('curatedSkillRows').innerHTML = curatedSkills.length ? curatedSkills.map((skill) => {
        const distribution = curatedDistributions.find((item) => item.skill_id === skill.id);
        const canDelete = can('curated_skills.manage') && skill.createdBy === me?.id;
        const action = '<button class="table-action edit-curated-skill" data-skill-id="' + escapeHtml(skill.id) + '">管理</button>' + (canDelete ? '<button class="table-action danger delete-curated-skill" data-skill-id="' + escapeHtml(skill.id) + '" data-skill-name="' + escapeHtml(skill.name) + '">删除</button>' : '');
        const source = skill.sourceType === 'official_sync' ? '<span class="tag queued">总后台同步</span> ' : '';
        const publishedText = skill.sourceType === 'official_sync' ? '总后台已发布' : (centerSupplierManagementEnabled ? '已发布到下游' : '已发布');
        const statusText = { draft: '草稿（未发布）', published: publishedText, disabled: '已下架' }[skill.status] || skill.status || '-';
        return '<tr><td><strong>' + escapeHtml(skill.name) + '</strong><div class="muted small mono">' + escapeHtml(skill.id) + '</div></td><td>' + source + '<span class="tag ' + (skill.distributionType === 'protected' ? 'queued' : 'succeeded') + '">' + (skill.distributionType === 'protected' ? '保护' : '公开') + '</span></td><td>' + escapeHtml(skill.currentVersion || '-') + '</td><td>' + escapeHtml(statusText) + '</td><td>' + (distribution?.enabled ? '本账号已上架 · ' + escapeHtml(distribution.delivery_policy || '') : '本账号未上架') + '</td><td>' + action + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="muted">暂无官方精选技能。</td></tr>';
      document.querySelectorAll('.edit-curated-skill').forEach((button) => button.onclick = () => openCuratedSkill(button.dataset.skillId));
      document.querySelectorAll('.delete-curated-skill').forEach((button) => button.onclick = async () => {
        if (!confirm('确定删除技能“' + button.dataset.skillName + '”吗？相关版本、分发和安装记录会一并删除，此操作不可恢复。')) return;
        try { await api('/api/curated-skills/' + encodeURIComponent(button.dataset.skillId), { method: 'DELETE' }); await refresh(); }
        catch (err) { alert(err.message); }
      });
    }
    function renderCuratedMcps() {
      if (!$('curatedMcpRows')) return;
      $('curatedMcpCount').textContent = curatedMcps.length;
      $('createCuratedMcpBtn').classList.toggle('hidden', !can('curated_mcps.manage'));
      $('curatedMcpRows').innerHTML = curatedMcps.length ? curatedMcps.map((item) => {
        const distribution = curatedMcpDistributions.find((entry) => entry.mcp_id === item.id);
        const status = { draft: '草稿', published: '已发布', disabled: '已下架' }[item.status] || item.status;
        const source = item.sourceType === 'official_sync' ? '<span class="tag queued">总后台同步</span> ' : '';
        const canDelete = can('curated_mcps.manage') && item.sourceType !== 'official_sync' && item.createdBy === me?.id;
        const actions = '<button class="table-action manage-curated-mcp" data-id="' + escapeHtml(item.id) + '">管理</button>' + (canDelete ? '<button class="table-action danger delete-curated-mcp" data-id="' + escapeHtml(item.id) + '" data-name="' + escapeHtml(item.name) + '">删除</button>' : '');
        return '<tr><td>' + source + '<strong>' + escapeHtml(item.name) + '</strong><div class="muted small">' + escapeHtml(item.description || '暂无说明') + '</div><div class="muted small mono">' + escapeHtml(item.id) + '</div></td><td>' + escapeHtml(item.category || '其他') + '</td><td><span class="tag ' + (item.status === 'published' ? 'succeeded' : 'queued') + '">' + escapeHtml(status) + '</span></td><td>' + (distribution?.enabled ? '已下发 · ' + escapeHtml(distribution.delivery_policy) : '未下发') + '</td><td>' + actions + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="muted">暂无精选 MCP，请先创建配置。</td></tr>';
      document.querySelectorAll('.manage-curated-mcp').forEach((button) => button.onclick = () => openCuratedMcp(button.dataset.id).catch((error) => alert(error.message)));
      document.querySelectorAll('.delete-curated-mcp').forEach((button) => button.onclick = async () => {
        if (!confirm('确定删除 MCP“' + button.dataset.name + '”吗？相关版本、分发和安装记录会一并删除，此操作不可恢复。')) return;
        try { await api('/api/curated-mcps/' + encodeURIComponent(button.dataset.id), { method: 'DELETE' }); await refresh(); }
        catch (error) { alert(error.message); }
      });
    }
    function renderCuratedMcpSyncStatus(job = null) {
      if (!$('curatedMcpSyncNotice')) return;
      const enabled = Boolean(curatedMcpUpdate?.enabled);
      $('syncCuratedMcpsBtn').classList.toggle('hidden', !enabled || !canAny(['curated_mcps.manage', 'curated_mcps.distribute']));
      $('syncCuratedMcpsBtn').disabled = curatedMcpSyncRunning;
      const updateAvailable = Boolean(curatedMcpUpdate?.updateAvailable);
      $('curatedMcpSyncNotice').classList.toggle('hidden', !job && !updateAvailable);
      const percent = Math.max(0, Math.min(100, Number(job?.percent || 0)));
      $('curatedMcpSyncProgress').style.width = percent + '%';
      if (job && (curatedMcpSyncRunning || !$('curatedMcpUpdateReminderBackdrop')?.classList.contains('hidden'))) renderCuratedMcpReminderProgress(job);
      if (job) {
        $('curatedMcpSyncTitle').textContent = job.status === 'completed' ? '总后台 MCP 同步完成' : (job.status === 'failed' ? '总后台 MCP 同步失败' : '正在同步总后台 MCP');
        $('curatedMcpSyncMessage').textContent = job.error ? ('失败原因：' + job.error) : (job.message || '正在同步…');
        return;
      }
      $('curatedMcpSyncTitle').textContent = '检测到总后台 MCP 更新';
      $('curatedMcpSyncMessage').textContent = '新增 ' + Number(curatedMcpUpdate?.added || 0) + ' 项，升级 ' + Number(curatedMcpUpdate?.updated || 0) + ' 项，下架 ' + Number(curatedMcpUpdate?.removed || 0) + ' 项。点击“同步总后台”应用更新。';
    }
    async function loadCuratedMcpUpdateStatus() {
      try { curatedMcpUpdate = await api('/api/curated-mcp-sync/update-status'); }
      catch (_error) { curatedMcpUpdate = { enabled: false, updateAvailable: false, items: [] }; }
      renderCuratedMcpSyncStatus();
      return curatedMcpUpdate;
    }
    async function waitForCuratedMcpSyncJob(jobId) {
      for (;;) {
        const job = await api('/api/curated-mcp-sync/jobs/' + encodeURIComponent(jobId));
        renderCuratedMcpSyncStatus(job);
        if (job.status !== 'running') return job;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    async function syncCuratedMcps() {
      if (curatedMcpSyncRunning) return;
      const reminderButton = $('applyCuratedMcpUpdateReminderBtn');
      if (reminderButton.dataset.completed === '1') { closeCuratedMcpUpdateReminder(); return; }
      curatedMcpSyncRunning = true;
      $('closeCuratedMcpUpdateReminderIconBtn').disabled = true;
      $('closeCuratedMcpUpdateReminderBtn').disabled = true;
      reminderButton.disabled = true;
      reminderButton.textContent = '正在同步...';
      renderCuratedMcpSyncStatus({ status: 'running', stage: 'queued', message: '正在创建同步任务…', percent: 0 });
      try {
        const started = await api('/api/curated-mcp-sync', { method: 'POST', body: JSON.stringify({ async: true }) });
        curatedMcpSyncJobId = started.id;
        const job = await waitForCuratedMcpSyncJob(started.id);
        if (job.status !== 'completed') throw new Error(job.error || job.message || '同步任务失败');
        curatedMcps = await api('/api/curated-mcps'); curatedMcpDistributions = await api('/api/curated-mcp-distributions');
        await loadCuratedMcpUpdateStatus(); renderCuratedMcps();
        const result = job.result || {};
        const message = '同步完成：新增 ' + Number(result.added || 0) + ' 项，升级 ' + Number(result.updated || 0) + ' 项，下架 ' + Number(result.removed || 0) + ' 项。';
        dismissedCuratedMcpUpdateSignature = String(curatedMcpUpdate?.signature || '');
        renderCuratedMcpSyncStatus({ status: 'completed', stage: 'completed', percent: 100, message });
        $('curatedMcpUpdateReminderMessage').textContent = message;
        reminderButton.dataset.completed = '1';
        reminderButton.textContent = '完成';
        showOperationToast('精选 MCP 同步完成', 'succeeded');
      } catch (error) {
        renderCuratedMcpSyncStatus({ status: 'failed', stage: 'failed', error: error.message, percent: Number($('curatedMcpReminderProgressPercent').textContent.replace('%', '')) || 0 });
        $('curatedMcpUpdateReminderMessage').textContent = '同步失败：' + error.message;
        reminderButton.dataset.completed = '';
        reminderButton.textContent = '重新同步';
        showOperationToast('精选 MCP 同步失败：' + error.message, 'failed');
      } finally {
        curatedMcpSyncJobId = ''; curatedMcpSyncRunning = false; $('syncCuratedMcpsBtn').disabled = false;
        $('closeCuratedMcpUpdateReminderIconBtn').disabled = false;
        $('closeCuratedMcpUpdateReminderBtn').disabled = false;
        reminderButton.disabled = false;
      }
    }
    function renderCuratedAgentSyncStatus(job = null) {
      if (!$('curatedAgentSyncNotice')) return;
      const enabled = Boolean(curatedAgentUpdate?.enabled);
      $('syncCuratedAgentsBtn').classList.toggle('hidden', !enabled || !canAny(['curated_agents.manage', 'curated_agents.distribute']));
      $('syncCuratedAgentsBtn').disabled = curatedAgentSyncRunning;
      const updateAvailable = Boolean(curatedAgentUpdate?.updateAvailable);
      $('curatedAgentSyncNotice').classList.toggle('hidden', !job && !updateAvailable);
      const percent = Math.max(0, Math.min(100, Number(job?.percent || 0)));
      $('curatedAgentSyncProgress').style.width = percent + '%';
      if (job && (curatedAgentSyncRunning || !$('curatedAgentUpdateReminderBackdrop')?.classList.contains('hidden'))) renderCuratedAgentReminderProgress(job);
      if (job) {
        $('curatedAgentSyncTitle').textContent = job.status === 'completed' ? '总后台专家同步完成' : (job.status === 'failed' ? '总后台专家同步失败' : '正在同步总后台专家');
        $('curatedAgentSyncMessage').textContent = job.error ? ('失败原因：' + job.error) : (job.message || '正在同步…');
        return;
      }
      $('curatedAgentSyncTitle').textContent = '检测到总后台专家更新';
      $('curatedAgentSyncMessage').textContent = '新增 ' + Number(curatedAgentUpdate?.added || 0) + ' 项，升级 ' + Number(curatedAgentUpdate?.updated || 0) + ' 项，下架 ' + Number(curatedAgentUpdate?.removed || 0) + ' 项。点击“同步总后台”应用更新。';
    }
    async function waitForCuratedAgentSyncJob(jobId) {
      for (;;) {
        const job = await api('/api/curated-agent-sync/jobs/' + encodeURIComponent(jobId));
        renderCuratedAgentSyncStatus(job);
        if (job.status !== 'running') return job;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    async function syncCuratedAgents() {
      if (curatedAgentSyncRunning) return;
      const reminderButton = $('applyCuratedAgentUpdateReminderBtn');
      if (reminderButton.dataset.completed === '1') { closeCuratedAgentUpdateReminder(); return; }
      curatedAgentSyncRunning = true;
      $('closeCuratedAgentUpdateReminderIconBtn').disabled = true;
      $('closeCuratedAgentUpdateReminderBtn').disabled = true;
      reminderButton.disabled = true;
      reminderButton.textContent = '正在同步...';
      renderCuratedAgentSyncStatus({ status: 'running', stage: 'queued', message: '正在创建同步任务…', percent: 0 });
      try {
        const started = await api('/api/curated-agent-sync', { method: 'POST', body: JSON.stringify({ async: true }) });
        curatedAgentSyncJobId = started.id;
        const job = await waitForCuratedAgentSyncJob(started.id);
        if (job.status !== 'completed') throw new Error(job.error || job.message || '同步任务失败');
        curatedAgents = await api('/api/curated-agents'); curatedAgentDistributions = await api('/api/curated-agent-distributions');
        const previousSignature = String(curatedAgentUpdate?.signature || '');
        await loadCuratedAgentUpdateStatus(); renderCuratedAgents();
        const result = job.result || {};
        const failed = Array.isArray(result.failed) ? result.failed.length : 0;
        const message = '同步完成：新增 ' + Number(result.added || 0) + ' 项，升级 ' + Number(result.updated || 0) + ' 项，下架 ' + Number(result.removed || 0) + (failed ? ('，失败 ' + failed + ' 项') : '，全部成功');
        dismissedCuratedAgentUpdateSignature = previousSignature;
        renderCuratedAgentSyncStatus({ status: 'completed', stage: 'completed', percent: 100, message });
        $('curatedAgentUpdateReminderMessage').textContent = message;
        reminderButton.dataset.completed = '1'; reminderButton.textContent = '完成';
        showOperationToast('精选专家同步完成', 'succeeded');
      } catch (error) {
        renderCuratedAgentSyncStatus({ status: 'failed', stage: 'failed', error: error.message, percent: Number($('curatedAgentReminderProgressPercent').textContent.replace('%', '')) || 0 });
        $('curatedAgentUpdateReminderMessage').textContent = '同步失败：' + error.message;
        reminderButton.dataset.completed = ''; reminderButton.textContent = '重新同步';
        showOperationToast('精选专家同步失败：' + error.message, 'failed');
      } finally {
        curatedAgentSyncJobId = ''; curatedAgentSyncRunning = false; $('syncCuratedAgentsBtn').disabled = false;
        $('closeCuratedAgentUpdateReminderIconBtn').disabled = false;
        $('closeCuratedAgentUpdateReminderBtn').disabled = false;
        reminderButton.disabled = false;
      }
    }
    function updateCuratedMcpTransportFields() {
      const transport = $('curatedMcpTransport').value;
      const remote = transport === 'remote';
      const json = transport === 'json';
      $('curatedMcpRemoteFields').classList.toggle('hidden', !remote);
      $('curatedMcpStdioFields').classList.toggle('hidden', remote || json);
      $('curatedMcpJsonFields').classList.toggle('hidden', !json);
    }
    function curatedMcpConfigFromJson() {
      let parsed;
      try { parsed = JSON.parse($('curatedMcpJson').value); }
      catch (error) { throw new Error('MCP JSON 格式错误：' + error.message); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP JSON 必须是对象');
      if (parsed.mcpServers !== undefined) {
        if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) throw new Error('mcpServers 必须是对象');
        const entries = Object.entries(parsed.mcpServers);
        if (entries.length !== 1) throw new Error('每个精选 MCP 版本的 JSON 必须且只能包含一个 mcpServers 配置');
        parsed = entries[0][1];
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP 服务器配置必须是对象');
      const remoteUrl = String(parsed.url || parsed.httpUrl || '').trim();
      if (remoteUrl) return { transport: 'remote', url: remoteUrl };
      const command = String(parsed.command || '').trim();
      if (!command) throw new Error('MCP JSON 缺少 command 或远程 url');
      if (!Array.isArray(parsed.args)) throw new Error('MCP JSON 的 args 必须是数组');
      const rawEnv = parsed.env === undefined ? {} : parsed.env;
      if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) throw new Error('MCP JSON 的 env 必须是对象');
      const env = {};
      Object.entries(rawEnv).forEach(([name, value]) => {
        const normalizedName = String(name).trim();
        const normalizedValue = value === null || value === undefined ? '' : String(value).trim();
        env[normalizedName] = normalizedValue || '${' + normalizedName + '}';
      });
      return { transport: 'stdio', command, args: parsed.args.map((item) => String(item)), env };
    }
    function curatedMcpConfigFromForm() {
      if ($('curatedMcpTransport').value === 'json') return curatedMcpConfigFromJson();
      if ($('curatedMcpTransport').value === 'remote') return { transport: 'remote', url: $('curatedMcpRemoteUrl').value.trim() };
      const packageName = $('curatedMcpPackage').value.trim();
      const args = $('curatedMcpArgs').value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      if (packageName) args.push(packageName);
      const env = {};
      $('curatedMcpEnv').value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).forEach((line) => {
        const separator = line.indexOf('='); if (separator < 1) throw new Error('环境变量格式应为 NAME=${NAME}');
        env[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
      });
      return { transport: 'stdio', command: $('curatedMcpCommand').value, args, env };
    }
    async function openCuratedMcp(mcpId = '') {
      selectedCuratedMcpId = mcpId || '';
      const detail = mcpId ? await api('/api/curated-mcps/' + encodeURIComponent(mcpId)) : null;
      const officialSync = detail?.sourceType === 'official_sync';
      $('curatedMcpDrawerTitle').textContent = detail ? detail.name : '新建精选 MCP';
      $('curatedMcpDrawerSource').textContent = officialSync ? '来源：总后台同步（内容只读）' : (detail ? '来源：本地创建' : '先保存基本信息，再创建版本');
      $('curatedMcpId').value = detail?.id || ''; $('curatedMcpId').disabled = Boolean(detail);
      $('curatedMcpName').value = detail?.name || ''; $('curatedMcpDescription').value = detail?.description || '';
      $('curatedMcpCategory').value = detail?.category || ''; $('curatedMcpTags').value = (detail?.tags || []).join(', '); $('curatedMcpIconUrl').value = detail?.iconUrl || '';
      $('curatedMcpDelivery').value = detail?.defaultDeliveryPolicy || 'market';
      $('curatedMcpMarketPersonal').checked = true;
      ['curatedMcpName', 'curatedMcpDescription', 'curatedMcpCategory', 'curatedMcpTags', 'curatedMcpIconUrl', 'curatedMcpDelivery'].forEach((id) => { $(id).disabled = officialSync; });
      $('saveCuratedMcpBtn').classList.toggle('hidden', officialSync); $('curatedMcpVersionEditor').classList.toggle('hidden', !detail || officialSync);
      setActionFeedback('curatedMcpMsg', officialSync ? '该 MCP 由总后台同步，基本信息和版本只读；你可以配置本账号的用户分发。' : '', '');
      $('curatedMcpVersion').value = ''; $('curatedMcpMinDesktopVersion').value = '3.0.0-beta.13'; $('curatedMcpReleaseNotes').value = '';
      $('curatedMcpTransport').value = 'stdio'; $('curatedMcpCommand').value = 'npx.cmd'; $('curatedMcpPackage').value = ''; $('curatedMcpArgs').value = '-y'; $('curatedMcpEnv').value = ''; $('curatedMcpRemoteUrl').value = ''; $('curatedMcpJson').value = ''; updateCuratedMcpTransportFields();
      $('curatedMcpVersionList').innerHTML = (detail?.versions || []).map((version) => {
        const config = version.config || {}; const configText = config.transport === 'remote' ? config.url : ([config.command, ...(config.args || [])].filter(Boolean).join(' '));
        const action = version.status === 'draft' && can('curated_mcps.publish') && !officialSync ? '<button class="publish-curated-mcp-version secondary" data-version-id="' + escapeHtml(version.id) + '">发布版本</button>' : '<span class="tag ' + (version.status === 'published' ? 'succeeded' : 'queued') + '">' + escapeHtml({ draft: '草稿', published: '已发布', revoked: '已撤销' }[version.status] || version.status) + '</span>';
        return '<div class="notice"><div><strong>v' + escapeHtml(version.version) + '</strong><div class="muted small">' + escapeHtml(version.releaseNotes || '无更新说明') + '</div><div class="muted small mono">' + escapeHtml(configText || '-') + '</div></div>' + action + '</div>';
      }).join('') || (detail ? '<p class="muted small">暂无版本，请在上方创建首个版本草稿。</p>' : '');
      document.querySelectorAll('.publish-curated-mcp-version').forEach((button) => button.onclick = async () => {
        await runActionWithFeedback({ button, busyText: '正在发布...', messageId: 'curatedMcpMsg', successMessage: 'MCP 版本已发布', action: async () => {
          await api('/api/curated-mcps/' + encodeURIComponent(selectedCuratedMcpId) + '/versions/' + encodeURIComponent(button.dataset.versionId) + '/publish', { method: 'POST', body: JSON.stringify({ marketTypes: ['personal'] }) });
          await refresh(); await openCuratedMcp(selectedCuratedMcpId);
        } });
      });
      const distribution = curatedMcpDistributions.find((item) => item.mcp_id === mcpId) || {};
      const publishedVersions = (detail?.versions || []).filter((version) => version.status === 'published');
      $('curatedMcpDistributionEnabled').checked = Boolean(distribution.enabled); $('curatedMcpDistributionDelivery').value = distribution.delivery_policy || detail?.defaultDeliveryPolicy || 'market'; $('curatedMcpVersionPolicy').value = distribution.version_policy || 'manual';
      $('curatedMcpSelectedVersion').innerHTML = publishedVersions.map((version) => '<option value="' + escapeHtml(version.id) + '">v' + escapeHtml(version.version) + '</option>').join('') || '<option value="">暂无已发布版本</option>'; $('curatedMcpSelectedVersion').value = distribution.selected_version_id || detail?.currentVersionId || '';
      $('curatedMcpAudienceType').value = distribution.audienceType || 'all'; const selectedCards = new Set(distribution.membershipCardIds || []);
      $('curatedMcpMembershipChoices').innerHTML = membershipCards.map((card) => '<label class="model-access-item"><input class="curated-mcp-membership-check" type="checkbox" value="' + escapeHtml(card.id) + '"' + (selectedCards.has(card.id) ? ' checked' : '') + ' /> <span>' + escapeHtml(card.name) + '</span></label>').join('');
      $('saveCuratedMcpDistributionBtn').disabled = !detail || !publishedVersions.length || !can('curated_mcps.distribute');
      $('curatedMcpDrawer').classList.remove('hidden'); $('curatedMcpBackdrop').classList.remove('hidden');
    }
    function closeCuratedMcp() { $('curatedMcpDrawer').classList.add('hidden'); $('curatedMcpBackdrop').classList.add('hidden'); }
    async function openCuratedSkill(skillId = '') {
      selectedCuratedSkillId = skillId || '';
      let detail = null;
      if (skillId) detail = await api('/api/curated-skills/' + encodeURIComponent(skillId));
      $('curatedSkillId').value = detail?.id || ''; $('curatedSkillId').disabled = Boolean(detail);
      $('curatedSkillName').value = detail?.name || ''; $('curatedSkillDescription').value = detail?.description || '';
      $('curatedSkillCategory').value = detail?.category || ''; $('curatedSkillTags').value = (detail?.tags || []).join(', ');
      $('curatedSkillType').value = detail?.distributionType || 'public'; $('curatedSkillType').disabled = Boolean(detail && detail.status !== 'draft');
      $('curatedSkillDelivery').value = detail?.defaultDeliveryPolicy || 'market';
      $('curatedSkillMarketPersonal').checked = true;
      const distribution = curatedDistributions.find((item) => item.skill_id === skillId) || {};
      $('curatedDistributionEnabled').checked = Boolean(distribution.enabled); $('curatedDistributionDelivery').value = distribution.delivery_policy || detail?.defaultDeliveryPolicy || 'market'; $('curatedVersionPolicy').value = distribution.version_policy || 'manual';
      const publishedVersions = (detail?.versions || []).filter((version) => version.status === 'published'); $('curatedSelectedVersion').innerHTML = publishedVersions.map((version) => '<option value="' + escapeHtml(version.id) + '">v' + escapeHtml(version.version) + '</option>').join(''); $('curatedSelectedVersion').value = distribution.selected_version_id || detail?.currentVersionId || '';
      $('curatedAudienceType').value = distribution.audienceType || 'all'; const selectedCards = new Set(distribution.membershipCardIds || []);
      $('curatedMembershipChoices').innerHTML = membershipCards.map((card) => '<label class="model-access-item"><input class="curated-membership-check" type="checkbox" value="' + escapeHtml(card.id) + '"' + (selectedCards.has(card.id) ? ' checked' : '') + ' /> <span>' + escapeHtml(card.name) + '</span></label>').join('');
      const officialSync = detail?.sourceType === 'official_sync';
      $('saveCuratedSkillBtn').classList.toggle('hidden', officialSync);
      $('uploadCuratedVersionBtn').classList.toggle('hidden', officialSync);
      setActionFeedback('curatedSkillMsg', officialSync ? '该技能由总后台同步，技能内容只读；你可以在下方配置本账号的用户分发。' : '', '');
      const publishActionText = centerSupplierManagementEnabled ? '发布到下游' : '发布供本账号上架';
      const publishedStatusText = officialSync ? '总后台已发布' : (centerSupplierManagementEnabled ? '已发布到下游' : '已发布');
      $('curatedVersionList').innerHTML = (detail?.versions || []).map((version) => '<div class="notice"><div><strong>v' + escapeHtml(version.version) + '</strong><div class="muted small">' + escapeHtml(version.releaseNotes || '无更新说明') + '</div></div>' + (version.status === 'draft' && can('curated_skills.publish') && !officialSync ? '<button class="publish-curated-version secondary" data-version-id="' + escapeHtml(version.id) + '">' + publishActionText + '</button>' : '<span class="tag succeeded">' + escapeHtml({ draft: '草稿', published: publishedStatusText, revoked: '已撤销' }[version.status] || version.status) + '</span>') + '</div>').join('');
      document.querySelectorAll('.publish-curated-version').forEach((button) => button.onclick = async () => {
        await runActionWithFeedback({ button, busyText: '正在发布...', messageId: 'curatedSkillMsg', successMessage: '技能版本已发布', action: async () => {
          await api('/api/curated-skills/' + encodeURIComponent(skillId) + '/versions/' + encodeURIComponent(button.dataset.versionId) + '/publish', { method: 'POST', body: JSON.stringify({ marketTypes: ['personal'] }) });
          await refresh(); await openCuratedSkill(skillId);
        } });
      });
      $('curatedSkillDrawer').classList.remove('hidden'); $('curatedSkillBackdrop').classList.remove('hidden');
    }
    function closeCuratedSkill() { $('curatedSkillDrawer').classList.add('hidden'); $('curatedSkillBackdrop').classList.add('hidden'); }
    function renderCuratedAgents() {
      if (!$('curatedAgentRows')) return;
      renderCuratedAgentSyncStatus();
      $('curatedAgentCount').textContent = curatedAgents.length;
      $('createCuratedAgentBtn').classList.toggle('hidden', !can('curated_agents.manage'));
      $('curatedAgentRows').innerHTML = curatedAgents.length ? curatedAgents.map((agent) => {
        const distribution = curatedAgentDistributions.find((item) => item.agent_id === agent.id);
        const dependencyText = (agent.dependencies || []).map((item) => (item.type === 'skill' ? '技能 ' : 'MCP ') + item.id).join('、') || '无依赖';
        const deleteButton = agent.editable && can('curated_agents.manage') ? ' <button class="danger delete-curated-agent" data-id="' + escapeHtml(agent.id) + '">删除</button>' : '';
        const source = agent.sourceType === 'official_sync' ? '<span class="tag queued">总后台同步</span> ' : '';
        const statusText = agent.status === 'published' ? '已发布' : (agent.status === 'disabled' ? '已下架' : '草稿');
        return '<tr><td>' + source + '<strong>' + escapeHtml(agent.name) + '</strong><div class="muted small mono">' + escapeHtml(agent.id) + '</div></td><td>v' + escapeHtml(agent.version) + '</td><td class="small">' + escapeHtml(dependencyText) + '</td><td><span class="tag ' + (agent.status === 'published' ? 'succeeded' : 'queued') + '">' + escapeHtml(statusText) + '</span></td><td>' + escapeHtml(distribution?.enabled ? '已上架' : '未上架') + '</td><td><button class="secondary edit-curated-agent" data-id="' + escapeHtml(agent.id) + '">' + (agent.editable ? '编辑' : '查看') + '</button>' + deleteButton + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="muted">还没有精选专家。</td></tr>';
      document.querySelectorAll('.edit-curated-agent').forEach((button) => button.onclick = () => openCuratedAgent(button.dataset.id));
      document.querySelectorAll('.delete-curated-agent').forEach((button) => button.onclick = async () => { if (!confirm('删除这个专家？')) return; await api('/api/curated-agents/' + encodeURIComponent(button.dataset.id), { method: 'DELETE' }); await refresh(); });
    }
    function closeCuratedAgent() { $('curatedAgentDrawer').classList.add('hidden'); $('curatedAgentBackdrop').classList.add('hidden'); }
    function openCuratedAgent(id = '') {
      selectedCuratedAgentId = id;
      const agent = curatedAgents.find((item) => item.id === id) || null;
      const distribution = curatedAgentDistributions.find((item) => item.agent_id === id) || null;
      $('curatedAgentDrawerTitle').textContent = agent ? '编辑精选专家' : '新建精选专家';
      $('curatedAgentId').value = agent?.id || ''; $('curatedAgentId').disabled = Boolean(agent);
      $('curatedAgentName').value = agent?.name || ''; $('curatedAgentDescription').value = agent?.description || ''; $('curatedAgentPrompt').value = agent?.prompt || '';
      $('curatedAgentVersion').value = agent?.version || '1.0.0'; $('curatedAgentPermission').value = agent?.permissionMode || 'default'; $('curatedAgentIconUrl').value = agent?.iconUrl || '';
      $('curatedAgentMarketPersonal').checked = true;
      const selectedSkills = new Set((agent?.dependencies || []).filter((item) => item.type === 'skill').map((item) => item.id));
      const selectedMcps = new Set((agent?.dependencies || []).filter((item) => item.type === 'mcp').map((item) => item.id));
      $('curatedAgentSkillChoices').innerHTML = curatedSkills.filter((item) => item.status === 'published').map((item) => '<label><input class="curated-agent-skill-check" type="checkbox" value="' + escapeHtml(item.id) + '" ' + (selectedSkills.has(item.id) ? 'checked' : '') + ' /> ' + escapeHtml(item.name) + '</label>').join('') || '<span class="muted small">没有已发布技能</span>';
      $('curatedAgentMcpChoices').innerHTML = curatedMcps.filter((item) => item.status === 'published').map((item) => '<label><input class="curated-agent-mcp-check" type="checkbox" value="' + escapeHtml(item.id) + '" ' + (selectedMcps.has(item.id) ? 'checked' : '') + ' /> ' + escapeHtml(item.name) + '</label>').join('') || '<span class="muted small">没有已发布 MCP</span>';
      $('curatedAgentDistributionEnabled').checked = Boolean(distribution?.enabled); $('curatedAgentDelivery').value = distribution?.delivery_policy || 'market'; $('curatedAgentAudienceType').value = distribution?.audienceType || 'all';
      const cardIds = new Set(distribution?.membershipCardIds || []); $('curatedAgentMembershipChoices').innerHTML = membershipCards.map((card) => '<label><input class="curated-agent-membership-check" type="checkbox" value="' + escapeHtml(card.id) + '" ' + (cardIds.has(card.id) ? 'checked' : '') + ' /> ' + escapeHtml(card.name) + '</label>').join('');
      const editable = !agent || Boolean(agent.editable);
      $('saveCuratedAgentBtn').disabled = !editable || !can('curated_agents.manage');
      $('publishCuratedAgentBtn').disabled = !agent || !agent.editable || agent.status === 'published' || !can('curated_agents.publish');
      $('saveCuratedAgentDistributionBtn').disabled = !agent || agent.status !== 'published' || !can('curated_agents.distribute'); setActionFeedback('curatedAgentSaveMsg'); setActionFeedback('curatedAgentMsg');
      $('curatedAgentDrawer').classList.remove('hidden'); $('curatedAgentBackdrop').classList.remove('hidden');
    }
    function curatedAgentPayload() {
      return { id: $('curatedAgentId').value.trim(), name: $('curatedAgentName').value.trim(), description: $('curatedAgentDescription').value.trim(), prompt: $('curatedAgentPrompt').value.trim(), version: $('curatedAgentVersion').value.trim(), permissionMode: $('curatedAgentPermission').value, iconUrl: $('curatedAgentIconUrl').value.trim(), marketTypes: ['personal'], skillIds: Array.from(document.querySelectorAll('.curated-agent-skill-check')).filter((item) => item.checked).map((item) => item.value), mcpIds: Array.from(document.querySelectorAll('.curated-agent-mcp-check')).filter((item) => item.checked).map((item) => item.value) };
    }
    function render() { renderOwnerOptions(); renderMetrics(); renderDashboard(); renderProjects(); renderBuilds(); renderAgents(); renderUserGroups(); renderCenterSuppliers(); renderEndUsers(); renderMemberships(); renderPayments(); renderKeys(); renderRedeemCodes(); renderProviders(); renderCuratedSkills(); renderCuratedMcps(); renderCuratedAgents(); renderAuthStatus(); renderPermissions(); renderSelfUpdate(); updateProjectBuildAction(); }
    function updateBuildLogDrawer(buildId) {
      const build = builds.find((b) => b.id === buildId);
      if (!build) return;
      $('buildLogMeta').textContent = build.projectId + ' · ' + (build.version ? 'v' + build.version : '-') + ' · ' + statusText(build.status) + ' · ' + formatTime(build.updatedAt || build.createdAt);
      $('buildLogProgress').innerHTML = transferProgressHtml(build.transferProgress);
      $('logBox').textContent = build.log || build.error || '暂无日志';
    }
    function showBuildDetail(buildId) {
      selectedBuildLogId = buildId || '';
      switchTab('builds');
      updateBuildLogDrawer(selectedBuildLogId);
      $('buildLogBackdrop').classList.remove('hidden');
      $('buildLogDrawer').classList.remove('hidden');
    }
    function closeBuildLogDrawer() {
      $('buildLogBackdrop').classList.add('hidden');
      $('buildLogDrawer').classList.add('hidden');
    }
    function closeSourceHistoryDrawer() {
      $('sourceHistoryBackdrop').classList.add('hidden');
      $('sourceHistoryDrawer').classList.add('hidden');
    }
    function openSourceHistoryDrawer() {
      const history = Array.isArray(sourceInfo.history) ? sourceInfo.history.slice(0, 20) : [];
      $('sourceHistoryMeta').textContent = sourceInfo.version ? '当前最新版 v' + sourceInfo.version + ' · 最近 ' + history.length + ' 个版本' : '查看当前可打包 Agent 版本历史';
      $('sourceHistoryList').innerHTML = history.length ? history.map((item) => {
        const notes = item.releaseNotes || '暂无发布说明';
        return '<div class="release-history-item"><div class="release-history-head"><strong>v' + escapeHtml(item.version || '-') + '</strong><span class="muted small">' + escapeHtml(formatTime(item.publishedAt)) + '</span></div><div class="release-history-notes">' + escapeHtml(notes) + '</div></div>';
      }).join('') : '<p class="muted">暂无更新历史。</p>';
      $('sourceHistoryBackdrop').classList.remove('hidden');
      $('sourceHistoryDrawer').classList.remove('hidden');
    }
    function updateSubnavState(tab) {
      const groups = {
        projects: ['projectList', 'projectEditor'],
        userCenter: ['organizations', 'agents', 'userGroups', 'permissions', 'authStatus', 'centerSuppliers'],
        payments: ['paymentConfig', 'paymentOrders'],
        modelService: ['providers', 'modelKeys', 'providerModels', 'pricingRules'],
        platformSettings: ['platformBrand', 'platformBuildCenter', 'platformStorage', 'platformEmail'],
      };
      document.querySelectorAll('.subnav').forEach((nav) => {
        const tabs = groups[nav.dataset.parent] || [];
        nav.classList.toggle('open', tabs.includes(tab));
      });
    }
    function canOpenTab(tab) {
      const requirements = {
        dashboard: [],
        security: [],
        projectList: ['projects.manage'],
        projectEditor: ['projects.manage'],
        builds: ['builds.create', 'builds.publish'],
        agents: ['users.manage'],
        organizations: ['organizations.view'],
        userGroups: ['user_groups.manage'],
        permissions: ['permissions.manage'],
        authStatus: ['authorization.view'],
        centerSuppliers: ['center_suppliers.manage'],
        endUsers: ['end_users.manage'],
        memberships: ['memberships.manage'],
        paymentConfig: ['payments.manage'],
        paymentOrders: ['payments.manage'],
        keys: ['credits.manage'],
        redeemCodes: ['redeem_codes.manage'],
        providers: ['model_providers.manage', 'model_keys.manage', 'provider_models.manage', 'pricing_rules.manage'],
        modelKeys: ['model_keys.manage'],
        providerModels: ['provider_models.manage'],
        pricingRules: ['pricing_rules.manage'],
        platformBrand: ['platform_settings.manage'],
        platformBuildCenter: ['platform_settings.manage'],
        platformStorage: ['platform_settings.manage'],
        platformEmail: ['platform_settings.manage'],
        updates: ['self_update.manage'],
        diagnostics: ['diagnostics.view'],
        skills: ['curated_skills.view', 'curated_skills.distribute'],
        mcp: ['curated_mcps.view', 'curated_mcps.distribute'],
        curatedAgents: ['curated_agents.view', 'curated_agents.distribute'],
      };
      const required = requirements[tab];
      return !required || required.length === 0 || canAny(required);
    }
    function firstAllowedTab() {
      return ['dashboard', 'projectList', 'builds', 'organizations', 'agents', 'userGroups', 'permissions', 'authStatus', 'centerSuppliers', 'endUsers', 'memberships', 'paymentConfig', 'paymentOrders', 'keys', 'redeemCodes', 'mcp', 'skills', 'curatedAgents', 'providers', 'modelKeys', 'providerModels', 'pricingRules', 'platformBrand', 'platformBuildCenter', 'platformStorage', 'platformEmail', 'updates', 'diagnostics', 'security'].find(canOpenTab) || 'security';
    }
    function switchTab(tab) {
      if (!canOpenTab(tab)) tab = firstAllowedTab();
      const isPlanned = Boolean(plannedContent[tab]);
      const modelServiceTabs = ['providers', 'modelKeys', 'providerModels', 'pricingRules'];
      const userCenterTabs = ['organizations', 'agents', 'userGroups', 'permissions', 'authStatus', 'centerSuppliers'];
      const paymentTabs = ['paymentConfig', 'paymentOrders'];
      const platformTabs = ['platformBrand', 'platformBuildCenter', 'platformStorage', 'platformEmail'];
      document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item.dataset.tab === tab || (item.dataset.tab === 'projectList' && tab === 'projectEditor') || (item.dataset.group === 'userCenter' && userCenterTabs.includes(tab)) || (item.dataset.group === 'payments' && paymentTabs.includes(tab)) || (item.dataset.group === 'modelService' && modelServiceTabs.includes(tab)) || (item.dataset.group === 'platformSettings' && platformTabs.includes(tab))));
      document.querySelectorAll('.subtab').forEach((item) => item.classList.toggle('active', item.dataset.tab === tab));
      updateSubnavState(tab);
      $('dashboardView').classList.toggle('hidden', tab !== 'dashboard');
      $('projectListView').classList.toggle('hidden', tab !== 'projectList');
      $('projectEditorView').classList.toggle('hidden', tab !== 'projectEditor');
      $('buildsView').classList.toggle('hidden', tab !== 'builds');
      $('organizationsView').classList.toggle('hidden', tab !== 'organizations');
      $('agentsView').classList.toggle('hidden', tab !== 'agents');
      $('userGroupsView').classList.toggle('hidden', tab !== 'userGroups');
      $('centerSuppliersView').classList.toggle('hidden', tab !== 'centerSuppliers');
      $('authStatusView').classList.toggle('hidden', tab !== 'authStatus');
      $('permissionsView').classList.toggle('hidden', tab !== 'permissions');
      $('endUsersView').classList.toggle('hidden', tab !== 'endUsers');
      $('membershipsView').classList.toggle('hidden', tab !== 'memberships');
      $('paymentsView').classList.toggle('hidden', !paymentTabs.includes(tab));
      if (paymentTabs.includes(tab)) switchPaymentTab(tab === 'paymentOrders' ? 'orders' : 'config');
      $('keysView').classList.toggle('hidden', tab !== 'keys');
      $('redeemCodesView').classList.toggle('hidden', tab !== 'redeemCodes');
      $('providersView').classList.toggle('hidden', tab !== 'providers');
      $('modelKeysView').classList.toggle('hidden', tab !== 'modelKeys');
      $('providerModelsView').classList.toggle('hidden', tab !== 'providerModels');
      $('pricingRulesView').classList.toggle('hidden', tab !== 'pricingRules');
      $('skillsView').classList.toggle('hidden', tab !== 'skills');
      $('mcpView').classList.toggle('hidden', tab !== 'mcp');
      $('curatedAgentsView').classList.toggle('hidden', tab !== 'curatedAgents');
      $('platformView').classList.toggle('hidden', !platformTabs.includes(tab));
      document.querySelectorAll('[data-platform-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.platformPanel !== tab));
      $('updatesView').classList.toggle('hidden', tab !== 'updates');
      $('diagnosticsView').classList.toggle('hidden', tab !== 'diagnostics');
      $('securityView').classList.toggle('hidden', tab !== 'security');
      $('plannedView').classList.toggle('hidden', !isPlanned);
      if (isPlanned) renderPlanned(tab);
      if (tab === 'diagnostics') loadDiagnostics().catch((err) => { $('diagnosticLog').textContent = err.message; });
      if (tab === 'organizations') organizationView.refresh().catch((err) => { $('childOrganizationSummary').textContent = err.message; });
      if (tab === 'skills') loadCuratedSkillUpdateStatus().then(() => maybeShowCuratedUpdateReminder()).catch(() => {});
      if (tab === 'mcp') loadCuratedMcpUpdateStatus().then(() => maybeShowCuratedMcpUpdateReminder()).catch(() => {});
      if (tab === 'curatedAgents') loadCuratedAgentUpdateStatus().then(() => maybeShowCuratedAgentUpdateReminder()).catch(() => {});
      const meta = pageMeta[tab] || pageMeta.dashboard;
      $('pageTitle').textContent = meta[0];
      $('pageSubtitle').textContent = meta[1];
    }
    function setButtonBusy(button, busyText) {
      if (!button) return () => {};
      const originalText = button.textContent;
      const originalDisabled = button.disabled;
      button.textContent = busyText;
      button.disabled = true;
      return () => { button.textContent = originalText; button.disabled = originalDisabled; };
    }
    async function startBuild(projectId, button) {
      const active = activeBuildForProject(projectId);
      if (active) {
        $('formMsg').textContent = '该 AI 项目已有测试版构建任务：' + buildProgressText(active) + '。可在“构建发布”查看日志。';
        await refresh();
        return active;
      }
      const restoreButton = setButtonBusy(button, '正在提交...');
      try {
        const build = await api('/api/builds', { method: 'POST', body: JSON.stringify({ projectId, version: sourceInfo.version || '' }) });
        $('formMsg').textContent = build.alreadyActive
          ? '该 AI 项目已有测试版构建任务：' + buildProgressText(build) + '。可在“构建发布”查看日志。'
          : '测试版打包任务已提交：' + statusText(build.status) + ' · ' + shortId(build.id) + '。本页会自动刷新状态，也可到“构建发布”查看日志。';
        await refresh();
        return build;
      } finally {
        restoreButton();
        updateProjectBuildAction();
      }
    }
    document.querySelectorAll('.tab').forEach((button) => button.onclick = () => {
      if ($('appView').classList.contains('side-collapsed')) $('appView').classList.remove('side-collapsed');
      switchTab(button.dataset.tab);
    });
    document.querySelectorAll('.subtab').forEach((button) => button.onclick = () => switchTab(button.dataset.tab));
    document.querySelectorAll('[data-permission-tab]').forEach((button) => button.onclick = () => switchPermissionPanel(button.dataset.permissionTab));
    document.querySelectorAll('[data-role-template-tab]').forEach((button) => button.onclick = () => switchRoleTemplatePanel(button.dataset.roleTemplateTab));
    $('sideCollapseBtn').onclick = () => $('appView').classList.toggle('side-collapsed');
    $('buildLogBackdrop').onclick = closeBuildLogDrawer;
    $('closeBuildLogBtn').onclick = closeBuildLogDrawer;
    $('sourceHistoryBackdrop').onclick = closeSourceHistoryDrawer;
    $('closeSourceHistoryBtn').onclick = closeSourceHistoryDrawer;
    $('applyForcedUpdateBtn').onclick = () => applySelfUpdate({ forced: true });
    $('closeModelUpdateReminderIconBtn').onclick = closeModelUpdateReminder;
    $('closeModelUpdateReminderBtn').onclick = closeModelUpdateReminder;
    $('applyModelUpdateReminderBtn').onclick = applyModelServiceUpdates;
    $('modelUpdateReminderBackdrop').onclick = (event) => { if (event.target === $('modelUpdateReminderBackdrop')) closeModelUpdateReminder(); };
    $('closeCuratedUpdateReminderIconBtn').onclick = closeCuratedUpdateReminder;
    $('closeCuratedUpdateReminderBtn').onclick = closeCuratedUpdateReminder;
    $('applyCuratedUpdateReminderBtn').onclick = applyCuratedSkillUpdates;
    $('curatedUpdateReminderBackdrop').onclick = (event) => { if (event.target === $('curatedUpdateReminderBackdrop')) closeCuratedUpdateReminder(); };
    $('closeCuratedMcpUpdateReminderIconBtn').onclick = closeCuratedMcpUpdateReminder;
    $('closeCuratedMcpUpdateReminderBtn').onclick = closeCuratedMcpUpdateReminder;
    $('applyCuratedMcpUpdateReminderBtn').onclick = syncCuratedMcps;
    $('curatedMcpUpdateReminderBackdrop').onclick = (event) => { if (event.target === $('curatedMcpUpdateReminderBackdrop')) closeCuratedMcpUpdateReminder(); };
    $('closeCuratedAgentUpdateReminderIconBtn').onclick = closeCuratedAgentUpdateReminder;
    $('closeCuratedAgentUpdateReminderBtn').onclick = closeCuratedAgentUpdateReminder;
    $('applyCuratedAgentUpdateReminderBtn').onclick = syncCuratedAgents;
    $('curatedAgentUpdateReminderBackdrop').onclick = (event) => { if (event.target === $('curatedAgentUpdateReminderBackdrop')) closeCuratedAgentUpdateReminder(); };
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!$('sourceHistoryDrawer').classList.contains('hidden')) closeSourceHistoryDrawer();
      else if ($('updateReminderBackdrop').classList.contains('hidden') && !$('modelUpdateReminderBackdrop').classList.contains('hidden')) closeModelUpdateReminder();
      else if ($('updateReminderBackdrop').classList.contains('hidden') && $('modelUpdateReminderBackdrop').classList.contains('hidden') && !$('curatedUpdateReminderBackdrop').classList.contains('hidden')) closeCuratedUpdateReminder();
      else if ($('updateReminderBackdrop').classList.contains('hidden') && $('modelUpdateReminderBackdrop').classList.contains('hidden') && $('curatedUpdateReminderBackdrop').classList.contains('hidden') && !$('curatedMcpUpdateReminderBackdrop').classList.contains('hidden')) closeCuratedMcpUpdateReminder();
      else if ($('updateReminderBackdrop').classList.contains('hidden') && $('modelUpdateReminderBackdrop').classList.contains('hidden') && $('curatedUpdateReminderBackdrop').classList.contains('hidden') && $('curatedMcpUpdateReminderBackdrop').classList.contains('hidden') && !$('curatedAgentUpdateReminderBackdrop').classList.contains('hidden')) closeCuratedAgentUpdateReminder();
    });
    $('copyBuildLogBtn').onclick = async () => { try { await navigator.clipboard.writeText($('logBox').textContent || ''); $('buildLogMeta').textContent = '日志已复制'; } catch { $('buildLogMeta').textContent = '复制失败，请手动选中日志复制'; } };
    let loginCaptchaChallengeId = '';
    async function refreshLoginCaptcha() {
      $('loginCaptcha').value = '';
      const challenge = await api('/api/login/captcha');
      loginCaptchaChallengeId = challenge.challengeId;
      $('loginCaptchaImage').src = challenge.imageDataUrl;
    }
    $('loginCaptchaImageBtn').onclick = () => refreshLoginCaptcha().catch((err) => { $('loginError').textContent = err.message; });
    refreshLoginCaptcha().catch((err) => { $('loginError').textContent = err.message; });
    $('loginBtn').onclick = async () => {
      const restoreButton = setButtonBusy($('loginBtn'), '正在登录...');
      $('loginError').textContent = '';
      try {
        await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('loginUser').value, password: $('loginPass').value, challengeId: loginCaptchaChallengeId, captchaAnswer: $('loginCaptcha').value }) });
        await boot();
      } catch (err) {
        $('loginError').textContent = err.message;
        await refreshLoginCaptcha().catch(() => {});
      } finally {
        restoreButton();
      }
    };
    $('toggleLoginPasswordBtn').onclick = () => {
      const showPassword = $('loginPass').type === 'password';
      $('loginPass').type = showPassword ? 'text' : 'password';
      $('toggleLoginPasswordBtn').textContent = showPassword ? '隐藏' : '查看';
      $('toggleLoginPasswordBtn').setAttribute('aria-label', showPassword ? '隐藏密码' : '显示密码');
      $('toggleLoginPasswordBtn').title = showPassword ? '隐藏密码' : '显示密码';
      $('loginPass').focus();
    };
    ['loginUser', 'loginPass'].forEach((id) => $(id).addEventListener('keydown', (event) => { if (event.key === 'Enter') $('loginBtn').click(); }));
    function initLoginCrystalInteraction() {
      const stage = document.querySelector('.login-orbit-stage');
      if (!stage) return;
      let dragging = false, pointerId = null, lastX = 0, lastY = 0, rotationX = -18, rotationY = 0, velocityX = 0, velocityY = 0, inertiaFrame = 0;
      const renderRotation = () => {
        rotationX = Math.max(-75, Math.min(75, rotationX));
        stage.style.setProperty('--cube-rotate-x', rotationX.toFixed(2) + 'deg');
        stage.style.setProperty('--cube-rotate-y', rotationY.toFixed(2) + 'deg');
      };
      const stopInertia = () => { if (inertiaFrame) cancelAnimationFrame(inertiaFrame); inertiaFrame = 0; stage.classList.remove('is-inertia'); };
      const runInertia = () => {
        stopInertia();
        stage.classList.add('is-inertia', 'is-user-rotated');
        const tick = () => {
          velocityX *= .92; velocityY *= .92;
          rotationX += velocityX; rotationY += velocityY;
          renderRotation();
          if (Math.abs(velocityX) + Math.abs(velocityY) > .08) inertiaFrame = requestAnimationFrame(tick);
          else { inertiaFrame = 0; stage.classList.remove('is-inertia'); }
        };
        inertiaFrame = requestAnimationFrame(tick);
      };
      stage.addEventListener('pointerdown', (event) => {
        stopInertia(); dragging = true; pointerId = event.pointerId; lastX = event.clientX; lastY = event.clientY; velocityX = 0; velocityY = 0;
        stage.classList.add('is-dragging', 'is-user-rotated'); stage.setPointerCapture(pointerId);
      });
      stage.addEventListener('pointermove', (event) => {
        if (!dragging || event.pointerId !== pointerId) return;
        const deltaX = event.clientX - lastX, deltaY = event.clientY - lastY; lastX = event.clientX; lastY = event.clientY;
        velocityY = deltaX * .42; velocityX = -deltaY * .34; rotationY += velocityY; rotationX += velocityX; renderRotation();
      });
      const finishDrag = (event) => {
        if (!dragging || event.pointerId !== pointerId) return;
        dragging = false; stage.classList.remove('is-dragging'); if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId); pointerId = null; runInertia();
      };
      stage.addEventListener('pointerup', finishDrag); stage.addEventListener('pointercancel', finishDrag);
      stage.addEventListener('dblclick', () => {
        stopInertia(); rotationX = -18; rotationY = 0; renderRotation(); stage.classList.remove('is-user-rotated', 'is-dragging');
      });
    }
    initLoginCrystalInteraction();
    $('logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {}); location.reload(); };
    $('newProjectBtn').onclick = () => fillProject(null); $('newProjectTopBtn').onclick = () => { fillProject(null); switchTab('projectEditor'); }; $('backProjectListBtn').onclick = () => switchTab('projectList'); $('refreshBuildsBtn').onclick = refresh; $('refreshEndUsersBtn').onclick = refresh; $('refreshMembershipsBtn').onclick = refresh; $('refreshPaymentsBtn').onclick = loadPayments; $('refreshCreditsBtn').onclick = () => loadCreditLedger({ page: creditLedgerPage.page }); $('refreshRedeemCodesBtn').onclick = refresh; $('refreshProvidersBtn').onclick = refresh; $('refreshModelKeysBtn').onclick = refresh; $('refreshProviderModelsBtn').onclick = refresh; $('refreshPricingRulesBtn').onclick = refresh; $('syncProvidersBtn').onclick = () => syncModelService('providers', 'modelProviderMsg'); $('syncProviderModelsBtn').onclick = () => syncModelService('models', 'providerModelMsg'); $('syncPricingRulesBtn').onclick = () => syncModelService('pricingRules', 'pricingRuleMsg'); $('appName').addEventListener('input', () => { if (!$('id').value && !$('id').disabled) $('id').value = suggestId($('appName').value); });
    ['projectSearchFilter', 'projectStatusFilter'].forEach((id) => { const el = $(id); if (el) el.oninput = renderProjects; if (el) el.onchange = renderProjects; });
    $('filterProjectsBtn').onclick = renderProjects;
    ['workerStatusFilter', 'buildSearchFilter', 'buildStatusFilter'].forEach((id) => { const el = $(id); if (el) el.oninput = renderBuilds; if (el) el.onchange = renderBuilds; });
    $('filterWorkersBtn').onclick = renderBuilds;
    $('filterBuildsBtn').onclick = renderBuilds;
    ['endUserSearchFilter', 'endUserStatusFilter'].forEach((id) => { const el = $(id); if (el) el.oninput = renderEndUsers; if (el) el.onchange = renderEndUsers; });
    $('filterEndUsersBtn').onclick = renderEndUsers;
    $('openEndUserDrawerBtn').onclick = () => { fillEndUserCreateForm(); toggleDrawer('endUser', true); };
    $('closeEndUserDrawerBtn').onclick = () => toggleDrawer('endUser', false);
    $('endUserDrawerBackdrop').onclick = () => toggleDrawer('endUser', false);
    $('saveEndUserBtn').onclick = createEndUserAccount;
    ['membershipSearchFilter', 'membershipStatusFilter'].forEach((id) => { const el = $(id); if (el) el.oninput = renderMemberships; if (el) el.onchange = renderMemberships; });
    $('filterMembershipsBtn').onclick = renderMemberships;
    $('ledgerOwnerFilter').onchange = renderLedgerFilterOptions;
    $('filterLedgerBtn').onclick = () => loadCreditLedger({ page: 1 });
    $('creditLedgerPageSize').onchange = () => loadCreditLedger({ page: 1 });
    $('creditLedgerPrevBtn').onclick = () => loadCreditLedger({ page: Math.max(1, creditLedgerPage.page - 1) });
    $('creditLedgerNextBtn').onclick = () => loadCreditLedger({ page: Math.min(creditLedgerPage.totalPages, creditLedgerPage.page + 1) });
    document.querySelectorAll('#paymentConfigPanel input:not([readonly]), #paymentConfigPanel select, #paymentConfigPanel textarea').forEach((element) => {
      const markDirty = () => {
        const provider = element.closest('[data-payment-provider]')?.dataset.paymentProvider;
        if (provider) paymentSettingsDirty[provider] = true;
      };
      element.addEventListener('input', markDirty);
      element.addEventListener('change', markDirty);
    });
    $('alipayPaymentKeyMode').onchange = updateAlipayCertificateFields;
    $('alipayPaymentFaceToFaceEnabled').onchange = updateAlipayCertificateFields;
    $('alipayPaymentPagePayEnabled').onchange = updateAlipayCertificateFields;
    $('saveWechatPaymentBtn').onclick = () => savePaymentConfig('wechat');
    $('testWechatPaymentBtn').onclick = () => testPaymentConfig('wechat');
    $('saveAlipayPaymentBtn').onclick = () => savePaymentConfig('alipay');
    $('testAlipayPaymentBtn').onclick = () => testPaymentConfig('alipay');
    ['paymentOrderSearchFilter', 'paymentOrderProviderFilter', 'paymentOrderStatusFilter'].forEach((id) => { const el = $(id); if (el) el.oninput = renderPaymentOrders; if (el) el.onchange = renderPaymentOrders; });
    $('filterPaymentOrdersBtn').onclick = renderPaymentOrders;
    $('openRedeemCodeDrawerBtn').onclick = () => { fillRedeemCodeForm(); toggleDrawer('redeemCode', true); };
    $('closeRedeemCodeDrawerBtn').onclick = () => toggleDrawer('redeemCode', false);
    $('redeemCodeDrawerBackdrop').onclick = () => toggleDrawer('redeemCode', false);
    $('generateRedeemCodesBtn').onclick = () => generateRedeemCodes().catch((err) => { $('redeemCodeMsg').textContent = err.message; });
    $('copyRedeemCodesBtn').onclick = () => copyRedeemCodes();
    $('redeemRewardType').onchange = updateRedeemRewardTypeFields;
    $('redeemMembershipCardId').onchange = updateRedeemMembershipPackageOptions;
    ['redeemCodeSearchFilter', 'redeemCodeStatusFilter'].forEach((id) => { const el = $(id); if (el) el.oninput = renderRedeemCodes; if (el) el.onchange = renderRedeemCodes; });
    $('filterRedeemCodesBtn').onclick = renderRedeemCodes;
    $('closeEndUserModelDrawerBtn').onclick = () => toggleDrawer('endUserModel', false);
    $('endUserModelDrawerBackdrop').onclick = () => toggleDrawer('endUserModel', false);
    $('saveEndUserModelAccessBtn').onclick = () => saveEndUserModelAccess(false);
    $('clearEndUserModelAccessBtn').onclick = () => saveEndUserModelAccess(true);
    $('closeEndUserMembershipDrawerBtn').onclick = () => toggleDrawer('endUserMembership', false);
    $('endUserMembershipDrawerBackdrop').onclick = () => toggleDrawer('endUserMembership', false);
    $('endUserMembershipCard').onchange = updateEndUserMembershipPackageOptions;
    $('saveEndUserMembershipBtn').onclick = () => saveEndUserMembership().catch((err) => { $('endUserMembershipMsg').textContent = err.message; });
    $('cancelEndUserMembershipBtn').onclick = () => cancelEndUserMembership().catch((err) => { $('endUserMembershipMsg').textContent = err.message; });
    $('openMembershipDrawerBtn').onclick = () => { fillMembership(null); toggleDrawer('membership', true); };
    $('closeMembershipDrawerBtn').onclick = () => toggleDrawer('membership', false);
    $('membershipDrawerBackdrop').onclick = () => toggleDrawer('membership', false);
    document.querySelectorAll('[data-membership-tab]').forEach((button) => button.onclick = () => switchMembershipTab(button.dataset.membershipTab));
    $('membershipBackgroundUploadBtn').onclick = () => $('membershipBackgroundFile').click();
    $('membershipBackgroundFile').onchange = () => uploadFromInput('membershipBackgroundFile', 'membershipBackgroundUrl', 'membershipBackgroundPreview').catch((err) => { $('membershipMsg').textContent = err.message; });
    $('newMembershipBtn').onclick = () => fillMembership(null);
    $('saveMembershipBtn').onclick = async () => { try { const saved = await api('/api/membership-cards', { method: 'POST', body: JSON.stringify(collectMembership()) }); $('membershipMsg').textContent = '已保存：' + saved.name; await refresh(); fillMembership(saved); } catch (err) { $('membershipMsg').textContent = err.message; } };
    $('addClientMenuBtn').onclick = addClientMenuRow;
    $('resetClientMenusBtn').onclick = () => renderClientMenuEditor([]);
    $('logoUploadBtn').onclick = () => $('logoFile').click(); $('iconUploadBtn').onclick = () => $('iconFile').click(); $('contactUploadBtn').onclick = () => $('contactFile').click(); $('loginLogoUploadBtn').onclick = () => $('loginLogoFile').click(); $('loginBackgroundUploadBtn').onclick = () => $('loginBackgroundFile').click();
    $('logoFile').onchange = async () => { try { await uploadFromInput('logoFile', 'logoUrl', 'logoPreview'); } catch (err) { showUploadError(err); } };
    $('iconFile').onchange = async () => { try { await uploadFromInput('iconFile', 'iconUrl', 'iconPreview'); } catch (err) { showUploadError(err); } };
    $('contactFile').onchange = async () => { try { await uploadFromInput('contactFile', 'contactQrUrl', 'contactPreview'); } catch (err) { showUploadError(err); } };
    $('loginLogoFile').onchange = async () => { try { await uploadFromInput('loginLogoFile', 'loginLogoUrl', 'loginLogoPreview'); } catch (err) { showUploadError(err); } };
    $('loginBackgroundFile').onchange = async () => { try { await uploadFromInput('loginBackgroundFile', 'loginBackgroundUrl', 'loginBackgroundPreview'); } catch (err) { showUploadError(err); } };
    $('settingLoginBackgroundUploadBtn').onclick = () => $('settingLoginBackgroundFile').click();
    $('settingLoginBackgroundFile').onchange = async () => {
      try {
        await uploadFromInput('settingLoginBackgroundFile', 'settingLoginBackgroundUrl', 'settingLoginBackgroundPreview');
        platformSettingsDirty = true;
        $('platformMsg').textContent = '登录背景已上传，请保存平台设置';
      } catch (err) {
        $('platformMsg').textContent = err.message || '登录背景上传失败';
      }
    };
    $('clearSettingLoginBackgroundBtn').onclick = () => {
      $('settingLoginBackgroundUrl').value = '';
      $('settingLoginBackgroundPreview').removeAttribute('src');
      $('settingLoginBackgroundPreview').classList.add('empty');
      platformSettingsDirty = true;
      $('platformMsg').textContent = '已选择纯 CSS 动态主视觉，请保存平台设置';
    };
    $('saveProjectBtn').onclick = async () => { try { const saved = await api('/api/projects', { method: 'POST', body: JSON.stringify(collectProject()) }); $('formMsg').textContent = '已保存：' + saved.id; await refresh(); fillProject(saved); } catch (err) { $('formMsg').textContent = err.message; alert(err.message || '保存失败'); } };
    $('buildBtn').onclick = async () => { const restoreButton = setButtonBusy($('buildBtn'), '正在保存...'); try { const saved = await api('/api/projects', { method: 'POST', body: JSON.stringify(collectProject()) }); restoreButton(); await startBuild(saved.id, $('buildBtn')); fillProject(saved); } catch (err) { $('formMsg').textContent = err.message; alert(err.message || '提交构建失败'); } finally { restoreButton(); updateProjectBuildAction(); } };
    $('openAgentDrawerBtn').onclick = () => { fillAgent(null); toggleDrawer('agent', true); };
    $('closeAgentDrawerBtn').onclick = () => toggleDrawer('agent', false);
    $('agentDrawerBackdrop').onclick = () => toggleDrawer('agent', false);
    $('newAgentBtn').onclick = () => fillAgent(null); $('saveAgentBtn').onclick = async () => { try { const saved = await api('/api/users', { method: 'POST', body: JSON.stringify(collectAgent()) }); $('agentMsg').textContent = '已保存：' + saved.username; await refresh(); fillAgent(saved); } catch (err) { $('agentMsg').textContent = err.message; } };
    $('agentRoleTemplate').onchange = updateAgentTemplateHint;
    ['agentSearchFilter', 'agentRoleFilter', 'agentStatusFilter'].forEach((id) => { const el = $(id); if (el) el.oninput = renderAgents; if (el) el.onchange = renderAgents; });
    $('filterAgentsBtn').onclick = renderAgents;
    $('openUserGroupDrawerBtn').onclick = () => { fillUserGroup(null); toggleDrawer('userGroup', true); };
    $('closeUserGroupDrawerBtn').onclick = () => toggleDrawer('userGroup', false);
    $('userGroupDrawerBackdrop').onclick = () => toggleDrawer('userGroup', false);
    $('newUserGroupBtn').onclick = () => fillUserGroup(null);
    $('saveUserGroupBtn').onclick = async () => { try { const saved = await api('/api/user-groups', { method: 'POST', body: JSON.stringify(collectUserGroup()) }); $('userGroupMsg').textContent = '已保存：' + saved.name; await refresh(); fillUserGroup(saved); } catch (err) { $('userGroupMsg').textContent = err.message; } };
    $('saveUserGroupMembersBtn').onclick = async () => {
      try {
        if (!userGroupMemberTargetId) throw new Error('请先保存分组')
        const userIds = Array.from(document.querySelectorAll('.user-group-member-check')).filter((input) => input.checked).map((input) => input.value);
        const saved = await api('/api/user-groups/' + encodeURIComponent(userGroupMemberTargetId) + '/members', { method: 'POST', body: JSON.stringify({ userIds }) });
        userGroupMemberIds = saved.userIds || [];
        $('userGroupMembersMsg').textContent = '成员已保存：' + userGroupMemberIds.length + ' 个';
        await refresh();
        renderUserGroupMembers();
      } catch (err) {
        $('userGroupMembersMsg').textContent = err.message;
      }
    };
    $('saveUserGroupPermissionsBtn').onclick = async () => {
      try {
        if (!userGroupPermissionTargetId) throw new Error('请先保存分组')
        const permissionKeys = Array.from(document.querySelectorAll('.user-group-permission-check')).filter((input) => input.checked).map((input) => input.value);
        const saved = await api('/api/user-groups/' + encodeURIComponent(userGroupPermissionTargetId) + '/permissions', { method: 'POST', body: JSON.stringify({ permissionKeys }) });
        userGroupPermissionKeys = saved.permissionKeys || [];
        $('userGroupPermissionsMsg').textContent = '权限已保存：' + userGroupPermissionKeys.length + ' 个';
        renderUserGroupPermissions();
      } catch (err) {
        $('userGroupPermissionsMsg').textContent = err.message;
      }
    };
    ['userGroupSearchFilter', 'userGroupStatusFilter'].forEach((id) => { const el = $(id); if (el) el.oninput = renderUserGroups; if (el) el.onchange = renderUserGroups; });
    $('filterUserGroupsBtn').onclick = renderUserGroups;
    $('openCenterSupplierDrawerBtn').onclick = () => { fillCenterSupplier(null); toggleDrawer('centerSupplier', true); };
    $('closeCenterSupplierDrawerBtn').onclick = () => toggleDrawer('centerSupplier', false);
    $('centerSupplierDrawerBackdrop').onclick = () => toggleDrawer('centerSupplier', false);
    $('newCenterSupplierBtn').onclick = () => fillCenterSupplier(null);
    $('saveCenterSupplierBtn').onclick = async () => { try { const saved = await api('/api/center-suppliers', { method: 'POST', body: JSON.stringify(collectCenterSupplier()) }); $('centerSupplierMsg').textContent = saved.token ? '已生成新 Token，请立即复制部署配置' : '供应商已保存'; await refresh(); fillCenterSupplier(saved); } catch (err) { $('centerSupplierMsg').textContent = err.message; } };
    $('copyCenterSupplierConfigBtn').onclick = async () => { try { await navigator.clipboard.writeText($('centerSupplierDeployConfig').value || ''); $('centerSupplierMsg').textContent = '部署配置已复制'; } catch { $('centerSupplierMsg').textContent = '复制失败，请手动选中文本复制'; } };
    ['centerSupplierSearchFilter', 'centerSupplierStatusFilter'].forEach((id) => { const el = $(id); if (el) el.oninput = renderCenterSuppliers; if (el) el.onchange = renderCenterSuppliers; });
    $('filterCenterSuppliersBtn').onclick = renderCenterSuppliers;
    $('openModelProviderDrawerBtn').onclick = () => { if (!canWriteModelProviders()) { $('modelProviderMsg').textContent = modelProviderWriteDeniedMessage(); return; } fillModelProvider(null); toggleDrawer('modelProvider', true); };
    $('closeModelProviderDrawerBtn').onclick = () => toggleDrawer('modelProvider', false);
    $('modelProviderDrawerBackdrop').onclick = () => toggleDrawer('modelProvider', false);
    $('newModelProviderBtn').onclick = () => { if (!canWriteModelProviders()) { $('modelProviderMsg').textContent = modelProviderWriteDeniedMessage(); return; } fillModelProvider(null); };
    $('saveModelProviderBtn').onclick = async () => { try { if (!canWriteModelProviders()) throw new Error(modelProviderWriteDeniedMessage()); const saved = await api('/api/model-providers', { method: 'POST', body: JSON.stringify(collectModelProvider()) }); $('modelProviderMsg').textContent = '已保存：' + saved.name; await refresh(); fillModelProvider(saved); } catch (err) { $('modelProviderMsg').textContent = err.message; } };
    $('openModelKeyDrawerBtn').onclick = () => { fillModelKey(null); toggleDrawer('modelKey', true); };
    $('closeModelKeyDrawerBtn').onclick = () => toggleDrawer('modelKey', false);
    $('modelKeyDrawerBackdrop').onclick = () => toggleDrawer('modelKey', false);
    $('newModelKeyBtn').onclick = () => fillModelKey(null);
    $('saveModelKeyBtn').onclick = async () => { try { const providerId = $('modelKeyProviderId').value; const saved = await api('/api/model-providers/' + encodeURIComponent(providerId) + '/keys', { method: 'POST', body: JSON.stringify(collectModelKey()) }); $('modelKeyMsg').textContent = '已保存 Key：' + (saved.keyPreview || saved.id); await refresh(); fillModelKey(saved); } catch (err) { $('modelKeyMsg').textContent = err.message; } };
    $('checkLegacyModelKeyBtn').onclick = async () => { try { const status = await api('/api/model-gateway/legacy-key-status'); $('modelKeyMsg').textContent = status.configured ? ('旧平台 Mengyu Key 已配置：' + (status.preview || '已配置') + '，地址：' + (status.baseUrl || '-')) : '旧平台 Mengyu Key 未配置，需要重新提供或在 Key 池中添加'; } catch (err) { $('modelKeyMsg').textContent = err.message; } };
    $('openProviderModelDrawerBtn').onclick = () => { fillProviderModel(null); toggleDrawer('providerModel', true); };
    $('closeProviderModelDrawerBtn').onclick = () => toggleDrawer('providerModel', false);
    $('providerModelDrawerBackdrop').onclick = () => toggleDrawer('providerModel', false);
    $('newProviderModelBtn').onclick = () => fillProviderModel(null);
    $('providerModelType').onchange = updateProviderModelEndpointPlaceholder;
    $('testProviderModelBtn').onclick = async () => { try { await testProviderModelConnection(); } catch (err) { $('providerModelMsg').textContent = '连通性测试失败：' + (err.message || '未知错误'); } };
    $('saveProviderModelBtn').onclick = async () => {
      try {
        const payload = collectProviderModel();
        if (!payload.id && ['text', 'search'].includes(payload.modelType)) await testProviderModelConnection();
        const saved = await api('/api/provider-models', { method: 'POST', body: JSON.stringify(payload) });
        $('providerModelMsg').textContent = '已保存模型：' + saved.displayName;
        await refresh();
        fillProviderModel(saved);
      } catch (err) {
        $('providerModelMsg').textContent = err.message || '保存失败';
      }
    };
    $('openPricingRuleDrawerBtn').onclick = () => { fillPricingRule(null); toggleDrawer('pricingRule', true); };
    $('closePricingRuleDrawerBtn').onclick = () => toggleDrawer('pricingRule', false);
    $('pricingRuleDrawerBackdrop').onclick = () => toggleDrawer('pricingRule', false);
    $('newPricingRuleBtn').onclick = () => fillPricingRule(null);
    $('savePricingRuleBtn').onclick = async () => { try { const saved = await api('/api/model-pricing-rules', { method: 'POST', body: JSON.stringify(collectPricingRule()) }); $('pricingRuleMsg').textContent = '已保存计费规则：' + modelLabel(saved.providerModelId); await refresh(); fillPricingRule(saved); } catch (err) { $('pricingRuleMsg').textContent = err.message; } };
    ['providerSearchFilter', 'providerStatusFilter', 'modelKeyProviderFilter', 'modelKeyStatusFilter', 'providerModelSearchFilter', 'providerModelProviderFilter', 'providerModelStatusFilter', 'pricingProviderFilter', 'pricingBillingFilter', 'pricingStatusFilter'].forEach((id) => { const el = $(id); if (el) el.onchange = renderProviders; });
    ['providerSearchFilter', 'providerModelSearchFilter'].forEach((id) => { const el = $(id); if (el) el.oninput = renderProviders; });
    $('filterProvidersBtn').onclick = renderProviders;
    $('filterModelKeysBtn').onclick = renderProviders;
    $('filterProviderModelsBtn').onclick = renderProviders;
    $('filterPricingRulesBtn').onclick = renderProviders;
    [
      'settingSystemName', 'settingSystemSubtitle', 'settingLoginTitle', 'settingLoginSubtitle', 'settingLoginPanelColor', 'settingLoginBackgroundUrl',
      'settingLoginKicker', 'settingLoginPanelEyebrow', 'settingLoginPanelTitle', 'settingLoginPanelSubtitle', 'settingLoginAccountLabel',
      'settingLoginAccountPlaceholder', 'settingLoginPasswordLabel', 'settingLoginPasswordPlaceholder', 'settingLoginSubmitText',
      'settingLoginSecurityText', 'settingLoginInteractionHint',
      ...Array.from({ length: 4 }, (_, index) => ['settingLoginSignalTitle' + index, 'settingLoginSignalSubtitle' + index, 'settingLoginCapabilityTitle' + index, 'settingLoginCapabilitySubtitle' + index]).flat(),
      'settingPrimaryColor', 'settingLogoText', ...crystalFaceKeys.map((key) => 'settingCrystalFace' + key.charAt(0).toUpperCase() + key.slice(1)),
      'settingBuildCenterUrl', 'settingBuildCenterSupplierId', 'settingBuildCenterToken', 'settingArtifactStorageMode',
      'settingOssAccessKeyId', 'settingOssAccessKeySecret', 'settingOssBucket', 'settingOssEndpoint', 'settingOssPublicBaseUrl', 'settingOssPrefix',
      'settingSmtpHost', 'settingSmtpPort', 'settingSmtpSecure', 'settingSmtpUser', 'settingSmtpPass', 'settingSmtpFromName', 'settingSmtpFromEmail',
      'settingModelGatewayBaseUrl', 'settingModelUsageBaseUrl', 'settingModelGatewayKey', 'settingModelPointsPerUsd',
    ].forEach((id) => { const el = $(id); if (el) { el.addEventListener('input', () => { platformSettingsDirty = true; }); el.addEventListener('change', () => { platformSettingsDirty = true; }); } });
    $('savePlatformSettingsBtn').onclick = async () => {
      await runActionWithFeedback({
        button: $('savePlatformSettingsBtn'),
        busyText: '正在保存平台设置...',
        messageId: 'platformMsg',
        successMessage: '平台设置保存成功，登录页品牌与晶体配置已生效',
        action: async () => {
          const saved = await api('/api/platform-settings', { method: 'POST', body: JSON.stringify(collectPlatformSettings()) });
          platformSettingsDirty = false;
          fillPlatformSettings(saved);
          applyPlatformSettings(saved);
          return saved;
        },
      });
    };
    $('saveBuildCenterBtn').onclick = async () => { try { const saved = await api('/api/platform-settings', { method: 'POST', body: JSON.stringify(collectPlatformSettings()) }); $('buildCenterMsg').textContent = '官方构建中心配置已保存'; platformSettingsDirty = false; fillPlatformSettings(saved); } catch (err) { $('buildCenterMsg').textContent = err.message; } };
    $('saveArtifactStorageBtn').onclick = async () => { try { const saved = await api('/api/platform-settings', { method: 'POST', body: JSON.stringify(collectPlatformSettings()) }); $('artifactStorageMsg').textContent = '安装包存储配置已保存'; platformSettingsDirty = false; fillPlatformSettings(saved); } catch (err) { $('artifactStorageMsg').textContent = err.message; } };
    $('testSmtpSettingsBtn').onclick = async () => { try { if (platformSettingsDirty) throw new Error('请先保存邮件服务配置，再发送测试邮件'); const email = $('settingSmtpTestEmail').value.trim(); if (!email) throw new Error('请输入测试收件邮箱'); $('smtpSettingsMsg').textContent = '正在发送测试邮件...'; const result = await api('/api/platform-settings/smtp-test', { method: 'POST', body: JSON.stringify({ email }) }); $('smtpSettingsMsg').textContent = result.message || '测试邮件已发送，请检查收件邮箱'; } catch (err) { $('smtpSettingsMsg').textContent = err.message; } };
    $('saveSmtpSettingsBtn').onclick = async () => { try { const saved = await api('/api/platform-settings', { method: 'POST', body: JSON.stringify(collectPlatformSettings()) }); $('smtpSettingsMsg').textContent = '邮件服务配置已保存'; platformSettingsDirty = false; fillPlatformSettings(saved); } catch (err) { $('smtpSettingsMsg').textContent = err.message; } };
    $('testBuildCenterBtn').onclick = async () => { try { $('buildCenterMsg').textContent = '正在校验官方构建中心...'; const result = await api('/api/build-center-config/test', { method: 'POST', body: JSON.stringify(collectBuildCenterConfig()) }); const license = result.license || {}; const projectQuota = license.maxProjects ? (license.usedProjects + '/' + license.maxProjects) : '不限'; $('buildCenterMsg').textContent = result.message + '，当前在线构建机 ' + result.workerCount + ' 台' + (license.id ? '，授权类型：' + ({ partner: '同行代理', internal: '内部测试' }[license.licenseType] || '同行代理') + '，OEM 项目额度：' + projectQuota : ''); } catch (err) { $('buildCenterMsg').textContent = '校验失败：' + err.message; } };
    $('refreshAuthStatusBtn').onclick = async () => { try { supplierLicense = await api('/api/license'); renderAuthStatus(); syncAbilityTabs(); } catch (err) { $('authStatusMessage').textContent = err.message; } };
    $('refreshPermissionCatalogBtn').onclick = async () => {
      try {
        permissionEditorDirty = false;
        permissionCatalog = await api('/api/permissions/catalog');
        roleTemplates = await api('/api/role-templates').catch(() => []);
        userGroups = await api('/api/user-groups').catch(() => []);
        users = await api('/api/users').catch(() => users);
        renderPermissions();
      } catch (err) {
        $('permissionCatalogList').innerHTML = '<div class="card"><p class="muted">' + escapeHtml(err.message) + '</p></div>';
      }
    };
    $('roleTemplateSelect').onchange = () => {
      permissionEditorDirty = false;
      renderRoleTemplateEditor();
    };
    $('newRoleTemplateBtn').onclick = () => {
      permissionEditorDirty = true;
      $('roleTemplateSelect').value = '';
      $('roleTemplateName').value = '';
      $('roleTemplateDescription').value = '';
      $('roleTemplateBaseRole').value = 'admin';
      $('roleTemplateSortOrder').value = '0';
      $('roleTemplateStatus').value = 'enabled';
      $('roleTemplatePermissionList').innerHTML = permissionListHtml('role-template-permission-check', []);
      $('roleTemplateMsg').textContent = '正在新建角色模板';
    };
    $('permissionsView').addEventListener('input', (event) => {
      if (['roleTemplateName', 'roleTemplateDescription', 'roleTemplateSortOrder'].includes(event.target?.id)) markPermissionEditorDirty();
    });
    $('permissionsView').addEventListener('change', (event) => {
      const target = event.target;
      if (!target) return;
      if (target.classList?.contains('role-template-permission-check') || target.classList?.contains('permission-group-check')) markPermissionEditorDirty();
      if (['roleTemplateStatus'].includes(target.id)) markPermissionEditorDirty();
    });
    $('saveRoleTemplateBtn').onclick = async () => {
      try {
        const saved = await api('/api/role-templates', { method: 'POST', body: JSON.stringify(collectRoleTemplate()) });
        roleTemplates = await api('/api/role-templates');
        $('roleTemplateSelect').value = saved.id;
        permissionEditorDirty = false;
        renderRoleTemplateEditor();
        $('roleTemplateMsg').textContent = '模板已保存：' + saved.name;
      } catch (err) {
        $('roleTemplateMsg').textContent = err.message;
      }
    };
    async function saveRoleTemplatePermissionsAction() {
      const buttons = [$('saveRoleTemplatePermissionsBtn'), $('saveRoleTemplatePermissionsBottomBtn')].filter(Boolean);
      const restores = buttons.map((button) => setButtonBusy(button, '正在保存...'));
      setActionFeedback('roleTemplatePermissionMsg', '正在保存模板权限...', 'running');
      try {
        const templateId = $('roleTemplateSelect').value;
        if (!templateId) throw new Error('请先保存角色模板');
        const permissionKeys = Array.from(document.querySelectorAll('.role-template-permission-check')).filter((input) => input.checked).map((input) => input.value);
        const saved = await api('/api/role-templates/' + encodeURIComponent(templateId) + '/permissions', { method: 'POST', body: JSON.stringify({ permissionKeys }) });
        roleTemplates = await api('/api/role-templates');
        $('roleTemplateSelect').value = saved.id;
        permissionEditorDirty = false;
        renderRoleTemplateEditor();
        const message = '保存成功：模板“' + saved.name + '”已启用 ' + (saved.permissionKeys || []).length + ' 项权限';
        setActionFeedback('roleTemplatePermissionMsg', message, 'succeeded');
        showOperationToast(message, 'succeeded');
      } catch (err) {
        const message = '保存失败：' + (err?.message || '未知错误');
        setActionFeedback('roleTemplatePermissionMsg', message, 'failed');
        showOperationToast(message, 'failed');
      } finally { restores.forEach((restore) => restore()); }
    }
    $('saveRoleTemplatePermissionsBtn').onclick = saveRoleTemplatePermissionsAction;
    $('saveRoleTemplatePermissionsBottomBtn').onclick = saveRoleTemplatePermissionsAction;
    $('permissionGroupSelect').onchange = () => loadPermissionGroupSelection($('permissionGroupSelect').value).catch((err) => { $('permissionGroupMsg').textContent = err.message; });
    $('savePermissionGroupBtn').onclick = async () => {
      try {
        const groupId = $('permissionGroupSelect').value;
        if (!groupId) throw new Error('请选择账号分组');
        const permissionKeys = Array.from(document.querySelectorAll('.permission-group-check')).filter((input) => input.checked).map((input) => input.value);
        const saved = await api('/api/user-groups/' + encodeURIComponent(groupId) + '/permissions', { method: 'POST', body: JSON.stringify({ permissionKeys }) });
        $('permissionGroupCount').value = String((saved.permissionKeys || []).length);
        permissionEditorDirty = false;
        $('permissionGroupMsg').textContent = '分组权限已保存：' + (saved.permissionKeys || []).length + ' 个';
      } catch (err) {
        $('permissionGroupMsg').textContent = err.message;
      }
    };
    $('loadPermissionPreviewBtn').onclick = () => loadPermissionPreview().catch((err) => { $('permissionPreviewMsg').textContent = err.message; });
    $('permissionPreviewUserSelect').onchange = () => loadPermissionPreview().catch((err) => { $('permissionPreviewMsg').textContent = err.message; });
    $('checkUpdateBtn').onclick = async () => {
      $('checkUpdateBtn').disabled = true;
      setSelfUpdateMessage('正在检查更新，请稍候...', 'queued');
      $('selfUpdateLog').textContent = '正在检查更新...';
      const result = await loadSelfUpdateStatus();
      renderSelfUpdate();
      if (result.ok) {
        setSelfUpdateMessage(checkedUpdateMessage(), selfUpdate?.updateAvailable ? 'queued' : 'succeeded');
      } else {
        setSelfUpdateMessage('检查失败：' + (result.error?.message || '无法获取更新信息'), 'failed');
      }
    };
    $('saveUpdateSourceBtn').onclick = async () => {
      $('saveUpdateSourceBtn').disabled = true;
      try {
        const saved = await api('/api/self-update/config', { method: 'POST', body: JSON.stringify({ manifestUrl: $('selfManifestUrlInput').value.trim() }) });
        $('selfUpdateSourceMsg').textContent = '更新源已保存：' + (saved.manifestUrl || '-');
        await loadSelfUpdateStatus();
        renderSelfUpdate();
      } catch (err) {
        $('selfUpdateSourceMsg').textContent = err.message;
      } finally {
        $('saveUpdateSourceBtn').disabled = false;
      }
    };
    $('resetUpdateSourceBtn').onclick = async () => {
      $('selfManifestUrlInput').value = '';
      $('saveUpdateSourceBtn').click();
    };
    $('refreshDiagnosticsBtn').onclick = async () => { try { $('diagnosticLog').textContent = '正在刷新诊断...'; await loadDiagnostics(); } catch (err) { $('diagnosticLog').textContent = err.message; } };
    $('copyDiagnosticsBtn').onclick = async () => { try { await navigator.clipboard.writeText($('diagnosticLog').textContent || ''); } catch { $('diagnosticLog').textContent += '\n\n复制失败，请手动选中文本复制。'; } };
    $('downloadDiagnosticsBtn').onclick = () => {
      const blob = new Blob([$('diagnosticLog').textContent || ''], { type: 'application/json;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'agent-ai-diagnostics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    };
    $('applyUpdateBtn').onclick = () => applySelfUpdate();
    $('changePasswordBtn').onclick = async () => { try { if ($('newPassword').value !== $('confirmPassword').value) throw new Error('两次输入的新密码不一致'); await api('/api/me/password', { method: 'POST', body: JSON.stringify({ oldPassword: $('oldPassword').value, newPassword: $('newPassword').value }) }); $('oldPassword').value = ''; $('newPassword').value = ''; $('confirmPassword').value = ''; $('passwordMsg').textContent = '密码已更新'; } catch (err) { $('passwordMsg').textContent = err.message; } };
    $('refreshCuratedSkillsBtn').onclick = async () => { await refresh(); await loadCuratedSkillUpdateStatus(); if (!maybeShowCuratedUpdateReminder()) showOperationToast('精选技能列表已刷新', 'succeeded'); };
    $('syncCuratedSkillsBtn').onclick = async () => {
      await loadCuratedSkillUpdateStatus();
      if (maybeShowCuratedUpdateReminder()) return;
      showOperationToast('总后台暂无精选技能更新', 'succeeded');
    };
    $('refreshCuratedMcpsBtn').onclick = async () => { await refresh(); await loadCuratedMcpUpdateStatus(); if (!maybeShowCuratedMcpUpdateReminder()) showOperationToast('精选 MCP 列表已刷新', 'succeeded'); };
    $('syncCuratedMcpsBtn').onclick = () => syncCuratedMcps();
    $('createCuratedMcpBtn').onclick = () => openCuratedMcp().catch((error) => alert(error.message));
    $('closeCuratedMcpDrawerBtn').onclick = closeCuratedMcp; $('curatedMcpBackdrop').onclick = closeCuratedMcp;
    $('curatedMcpTransport').onchange = updateCuratedMcpTransportFields;
    $('saveCuratedMcpBtn').onclick = async () => {
      await runActionWithFeedback({ button: $('saveCuratedMcpBtn'), busyText: '正在保存基本信息...', messageId: 'curatedMcpMsg', successMessage: 'MCP 基本信息已保存', action: async () => {
        const payload = { id: $('curatedMcpId').value.trim(), name: $('curatedMcpName').value.trim(), description: $('curatedMcpDescription').value.trim(), category: $('curatedMcpCategory').value.trim(), tags: $('curatedMcpTags').value.split(',').map((item) => item.trim()).filter(Boolean), iconUrl: $('curatedMcpIconUrl').value.trim(), defaultDeliveryPolicy: $('curatedMcpDelivery').value, marketTypes: ['personal'] };
        const saved = selectedCuratedMcpId ? await api('/api/curated-mcps/' + encodeURIComponent(selectedCuratedMcpId), { method: 'PATCH', body: JSON.stringify(payload) }) : await api('/api/curated-mcps', { method: 'POST', body: JSON.stringify(payload) });
        selectedCuratedMcpId = saved.id; await refresh(); await openCuratedMcp(saved.id);
        return saved;
      } });
    };
    $('createCuratedMcpVersionBtn').onclick = async () => {
      await runActionWithFeedback({ button: $('createCuratedMcpVersionBtn'), busyText: '正在保存版本草稿...', messageId: 'curatedMcpMsg', successMessage: 'MCP 版本草稿已保存，请在版本列表中发布', action: async () => {
        if (!selectedCuratedMcpId) throw new Error('请先保存 MCP 基本信息');
        await api('/api/curated-mcps/' + encodeURIComponent(selectedCuratedMcpId) + '/versions', { method: 'POST', body: JSON.stringify({ version: $('curatedMcpVersion').value.trim(), minDesktopVersion: $('curatedMcpMinDesktopVersion').value.trim(), releaseNotes: $('curatedMcpReleaseNotes').value.trim(), config: curatedMcpConfigFromForm() }) });
        await refresh(); await openCuratedMcp(selectedCuratedMcpId);
      } });
    };
    $('saveCuratedMcpDistributionBtn').onclick = async () => {
      await runActionWithFeedback({ button: $('saveCuratedMcpDistributionBtn'), busyText: '正在保存分发...', messageId: 'curatedMcpMsg', successMessage: 'MCP 分发设置已保存', action: async () => {
        if (!selectedCuratedMcpId) throw new Error('请先选择 MCP');
        const membershipCardIds = Array.from(document.querySelectorAll('.curated-mcp-membership-check')).filter((item) => item.checked).map((item) => item.value);
        await api('/api/curated-mcp-distributions/' + encodeURIComponent(selectedCuratedMcpId), { method: 'PUT', body: JSON.stringify({ enabled: $('curatedMcpDistributionEnabled').checked, selectedVersionId: $('curatedMcpSelectedVersion').value, deliveryPolicy: $('curatedMcpDistributionDelivery').value, versionPolicy: $('curatedMcpVersionPolicy').value, audienceType: $('curatedMcpAudienceType').value, membershipCardIds }) });
        await refresh();
      } });
    };
    $('openCuratedSkillDrawerBtn').onclick = () => openCuratedSkill().catch((err) => alert(err.message));
    $('closeCuratedSkillDrawerBtn').onclick = closeCuratedSkill; $('curatedSkillBackdrop').onclick = closeCuratedSkill;
    $('saveCuratedSkillBtn').onclick = async () => {
      await runActionWithFeedback({ button: $('saveCuratedSkillBtn'), busyText: '正在保存技能草稿...', messageId: 'curatedSkillMsg', successMessage: '技能草稿已保存', action: async () => {
        const payload = { id: $('curatedSkillId').value.trim(), name: $('curatedSkillName').value.trim(), description: $('curatedSkillDescription').value.trim(), category: $('curatedSkillCategory').value.trim(), tags: $('curatedSkillTags').value.split(',').map((item) => item.trim()).filter(Boolean), distributionType: $('curatedSkillType').value, defaultDeliveryPolicy: $('curatedSkillDelivery').value, marketTypes: ['personal'] };
        const saved = selectedCuratedSkillId ? await api('/api/curated-skills/' + encodeURIComponent(selectedCuratedSkillId), { method: 'PATCH', body: JSON.stringify(payload) }) : await api('/api/curated-skills', { method: 'POST', body: JSON.stringify(payload) });
        selectedCuratedSkillId = saved.id; await refresh(); await openCuratedSkill(saved.id);
        return saved;
      } });
    };
    $('uploadCuratedVersionBtn').onclick = async () => {
      await runActionWithFeedback({ button: $('uploadCuratedVersionBtn'), busyText: '正在上传版本草稿...', messageId: 'curatedSkillMsg', successMessage: '技能版本已上传，请检查后发布', action: async () => {
        if (!selectedCuratedSkillId) throw new Error('请先保存技能草稿'); const file = $('curatedPackageFile').files?.[0]; if (!file) throw new Error('请选择技能 ZIP');
        const form = new FormData(); form.append('package', file); form.append('version', $('curatedVersion').value.trim()); form.append('minDesktopVersion', $('curatedMinDesktopVersion').value.trim()); form.append('releaseNotes', $('curatedReleaseNotes').value.trim());
        const response = await fetch(apiPrefix + '/api/curated-skills/' + encodeURIComponent(selectedCuratedSkillId) + '/versions', { method: 'POST', credentials: 'same-origin', body: form }); const payload = await response.json().catch(() => ({})); if (!response.ok || payload.success === false) throw new Error(payload.error || '上传失败');
        await refresh(); await openCuratedSkill(selectedCuratedSkillId);
      } });
    };
    $('saveCuratedDistributionBtn').onclick = async () => {
      await runActionWithFeedback({ button: $('saveCuratedDistributionBtn'), busyText: '正在保存分发...', messageId: 'curatedSkillMsg', successMessage: '技能分发设置已保存', action: async () => {
        if (!selectedCuratedSkillId) throw new Error('请先选择技能'); const membershipCardIds = Array.from(document.querySelectorAll('.curated-membership-check')).filter((item) => item.checked).map((item) => item.value);
        await api('/api/curated-skill-distributions/' + encodeURIComponent(selectedCuratedSkillId), { method: 'PUT', body: JSON.stringify({ enabled: $('curatedDistributionEnabled').checked, selectedVersionId: $('curatedSelectedVersion').value, deliveryPolicy: $('curatedDistributionDelivery').value, versionPolicy: $('curatedVersionPolicy').value, audienceType: $('curatedAudienceType').value, membershipCardIds }) });
        await refresh();
      } });
    };
    $('refreshCuratedAgentsBtn').onclick = async () => { await refresh(); await loadCuratedAgentUpdateStatus(); if (!maybeShowCuratedAgentUpdateReminder()) showOperationToast('精选专家列表已刷新', 'succeeded'); };
    $('syncCuratedAgentsBtn').onclick = () => syncCuratedAgents();
    $('createCuratedAgentBtn').onclick = () => openCuratedAgent();
    $('closeCuratedAgentDrawerBtn').onclick = closeCuratedAgent; $('curatedAgentBackdrop').onclick = closeCuratedAgent;
    $('saveCuratedAgentBtn').onclick = async () => {
      await runActionWithFeedback({ button: $('saveCuratedAgentBtn'), busyText: '正在保存专家...', messageId: 'curatedAgentSaveMsg', successMessage: ({ saved, creating }) => creating ? `保存成功：专家“${saved.name}”（${saved.id}）已创建为草稿，可继续发布或关闭窗口` : `保存成功：专家“${saved.name}”已更新`, action: async () => {
        const payload = curatedAgentPayload();
        if (!selectedCuratedAgentId && curatedAgents.some((item) => item.id === payload.id)) throw new Error(`专家 ID “${payload.id}” 已存在，请从列表中打开该专家进行编辑`);
        const creating = !selectedCuratedAgentId;
        const saved = selectedCuratedAgentId ? await api('/api/curated-agents/' + encodeURIComponent(selectedCuratedAgentId), { method: 'PATCH', body: JSON.stringify(payload) }) : await api('/api/curated-agents', { method: 'POST', body: JSON.stringify(payload) });
        curatedAgents = [saved, ...curatedAgents.filter((item) => item.id !== saved.id)];
        selectedCuratedAgentId = saved.id; renderCuratedAgents(); openCuratedAgent(saved.id); return { saved, creating };
      } });
    };
    $('publishCuratedAgentBtn').onclick = async () => {
      await runActionWithFeedback({ button: $('publishCuratedAgentBtn'), busyText: '正在发布...', messageId: 'curatedAgentSaveMsg', successMessage: '专家已按所选市场发布', action: async () => { if (!selectedCuratedAgentId) throw new Error('请先保存专家'); const payload = curatedAgentPayload(); if (!payload.marketTypes.length) throw new Error('请至少选择一个投放市场'); await api('/api/curated-agents/' + encodeURIComponent(selectedCuratedAgentId) + '/publish', { method: 'POST', body: JSON.stringify({ marketTypes: payload.marketTypes }) }); await refresh(); openCuratedAgent(selectedCuratedAgentId); } });
    };
    $('saveCuratedAgentDistributionBtn').onclick = async () => {
      await runActionWithFeedback({ button: $('saveCuratedAgentDistributionBtn'), busyText: '正在校验依赖权限...', messageId: 'curatedAgentMsg', successMessage: '专家分发设置已保存', action: async () => {
        if (!selectedCuratedAgentId) throw new Error('请先保存并发布专家');
        const membershipCardIds = Array.from(document.querySelectorAll('.curated-agent-membership-check')).filter((item) => item.checked).map((item) => item.value);
        await api('/api/curated-agent-distributions/' + encodeURIComponent(selectedCuratedAgentId), { method: 'PUT', body: JSON.stringify({ enabled: $('curatedAgentDistributionEnabled').checked, deliveryPolicy: $('curatedAgentDelivery').value, audienceType: $('curatedAgentAudienceType').value, membershipCardIds }) }); await refresh();
      } });
    };
    async function boot() {
      await loadPublicPlatformSettings();
      const session = await api('/api/me');
      if (!session.loggedIn) { $('loginView').classList.remove('hidden'); return; }
      me = session.user;
      syncUserPermissions();
      $('currentUser').textContent = (me.displayName || me.username) + ' · ' + roleText(me.role);
      $('loginView').classList.add('hidden');
      $('appView').classList.remove('hidden');
      $('logoutBtn').classList.remove('hidden');
      syncAbilityTabs();
      $('buildCenterSettingsCard').classList.toggle('hidden', centerSupplierManagementEnabled);
      switchTab('dashboard');
      await refresh({ skipSession: true });
      await Promise.all([loadModelServiceUpdateStatus(), loadCuratedSkillUpdateStatus(), loadCuratedMcpUpdateStatus(), loadCuratedAgentUpdateStatus()]);
      if (!maybeShowModelUpdateReminder() && !maybeShowCuratedUpdateReminder() && !maybeShowCuratedMcpUpdateReminder()) maybeShowCuratedAgentUpdateReminder();
      fillProject(null);
      setInterval(() => { void refreshLiveStatus(); }, 15_000);
      setInterval(async () => {
        await loadCuratedSkillUpdateStatus();
        if (!maybeShowCuratedUpdateReminder()) maybeShowCuratedMcpUpdateReminder();
      }, 60_000);
      setInterval(async () => {
        await loadCuratedMcpUpdateStatus();
        if (!maybeShowCuratedMcpUpdateReminder()) maybeShowCuratedAgentUpdateReminder();
      }, 60_000);
      setInterval(async () => {
        await loadCuratedAgentUpdateStatus();
        maybeShowCuratedAgentUpdateReminder();
      }, 60_000);
    }
    boot().catch(async () => { applyPlatformSettings(platformSettings); $('loginView').classList.remove('hidden'); });
