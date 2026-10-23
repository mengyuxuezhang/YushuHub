(function organizationViewModule(global) {
  function createOrganizationView(deps) {
    const { api, $, escapeHtml, can, getMe } = deps;
    let context = null;
    let children = [];
    let capabilityDialogOrganizationId = '';
    const categoryOrder = ['通用能力', '个人业务', '渠道管理', '平台专属'];

    function presetCapabilityKeys(items) {
      const categories = new Set(['通用能力', '个人业务']);
      return items.filter((item) => categories.has(item.category || '通用能力')).map((item) => item.key);
    }

    function capabilityPickerHtml(id, items, selectedKeys, options = {}) {
      const selected = new Set(selectedKeys || []);
      const groups = new Map();
      items.forEach((item) => {
        const category = item.category || '通用能力';
        const group = item.group || '其他能力';
        const key = category + '::' + group;
        if (!groups.has(key)) groups.set(key, { category, group, values: [] });
        groups.get(key).values.push(item);
      });
      const entries = Array.from(groups.values()).sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category));
      const tabs = categoryOrder.map((category) => {
        const count = items.filter((item) => (item.category || '通用能力') === category).length;
        return count ? '<button class="capability-category-tab' + (category === '通用能力' ? ' active' : '') + '" type="button" data-category="' + escapeHtml(category) + '">' + escapeHtml(category) + ' <span>' + count + '</span></button>' : '';
      }).join('');
      const optionsHtml = entries.map(({ category, group, values }) => '<div class="capability-picker-group" data-category="' + escapeHtml(category) + '"><div class="capability-picker-group-title"><span>' + escapeHtml(group) + '</span><span>' + values.length + ' 项</span></div>' + values.map((item) => '<label class="capability-picker-option" data-category="' + escapeHtml(category) + '" data-search="' + escapeHtml([item.name, item.description, group, category].join(' ').toLowerCase()) + '"><input type="checkbox" value="' + escapeHtml(item.key) + '"' + (selected.has(item.key) ? ' checked' : '') + '><span><strong>' + escapeHtml(item.name || '未命名能力') + '</strong>' + (item.description ? '<small>' + escapeHtml(item.description) + '</small>' : '') + (item.limitValue ? '<small>授权上限：' + Number(item.limitValue) + '</small>' : '') + '</span></label>').join('') + '</div>').join('');
      return '<div class="capability-picker' + (options.inline ? ' inline open' : '') + '" data-picker-id="' + escapeHtml(id) + '">' + (options.inline ? '' : '<button class="capability-picker-trigger" type="button"><span><strong class="capability-picker-count"></strong><small>点击展开并按能力分类选择</small></span><span class="capability-picker-arrow">⌄</span></button>') + '<div class="capability-picker-panel' + (options.inline ? '' : ' hidden') + '"><div class="capability-category-tabs">' + tabs + '<button class="capability-category-tab" type="button" data-category="selected">只看已选</button></div><div class="capability-picker-toolbar"><input class="capability-picker-search" placeholder="搜索能力名称或说明"><button class="secondary capability-select-all" type="button">本类全选</button><button class="ghost capability-clear-all" type="button">本类清空</button></div><div class="capability-picker-groups">' + (optionsHtml || '<div class="muted">当前没有可转授能力。</div>') + '</div></div><div class="capability-picker-selected"></div></div>';
    }

    function bindCapabilityPicker(container, options = {}) {
      const picker = container.querySelector('.capability-picker');
      if (!picker) return;
      const panel = picker.querySelector('.capability-picker-panel');
      const trigger = picker.querySelector('.capability-picker-trigger');
      const checks = () => Array.from(picker.querySelectorAll('.capability-picker-option input'));
      let activeCategory = '通用能力';
      const applyFilter = () => {
        const keyword = picker.querySelector('.capability-picker-search').value.trim().toLowerCase();
        picker.querySelectorAll('.capability-picker-option').forEach((item) => {
          const categoryMatch = activeCategory === 'selected' ? item.querySelector('input').checked : item.dataset.category === activeCategory;
          item.classList.toggle('hidden', !categoryMatch || (Boolean(keyword) && !item.dataset.search.includes(keyword)));
        });
        picker.querySelectorAll('.capability-picker-group').forEach((group) => group.classList.toggle('hidden', !group.querySelector('.capability-picker-option:not(.hidden)')));
      };
      const update = () => {
        const selected = checks().filter((input) => input.checked);
        const count = picker.querySelector('.capability-picker-count');
        if (count) count.textContent = selected.length ? ('已选择 ' + selected.length + ' 项能力') : '请选择可转授能力';
        const tags = picker.querySelector('.capability-picker-selected');
        tags.innerHTML = selected.slice(0, 6).map((input) => '<span class="tag">' + escapeHtml(input.closest('label').querySelector('strong').textContent) + '</span>').join('') + (selected.length > 6 ? '<span class="tag neutral">另有 ' + (selected.length - 6) + ' 项</span>' : '');
        applyFilter();
      };
      if (trigger) trigger.onclick = () => { panel.classList.toggle('hidden'); picker.classList.toggle('open', !panel.classList.contains('hidden')); };
      picker.querySelector('.capability-picker-search').oninput = applyFilter;
      picker.querySelectorAll('.capability-category-tab').forEach((tab) => { tab.onclick = () => { activeCategory = tab.dataset.category; picker.querySelectorAll('.capability-category-tab').forEach((item) => item.classList.toggle('active', item === tab)); applyFilter(); }; });
      picker.querySelector('.capability-select-all').onclick = () => { checks().filter((input) => !input.closest('label').classList.contains('hidden')).forEach((input) => { input.checked = true; }); update(); };
      picker.querySelector('.capability-clear-all').onclick = () => { checks().filter((input) => !input.closest('label').classList.contains('hidden')).forEach((input) => { input.checked = false; }); update(); };
      checks().forEach((input) => input.onchange = update);
      update();
      if (options.onReady) options.onReady(picker);
    }

    const selectedCapabilityKeys = (container) => Array.from(container.querySelectorAll('.capability-picker-option input:checked')).map((input) => input.value);
    const closeCapabilityDialog = () => {
      capabilityDialogOrganizationId = '';
      $('organizationCapabilityDialog').classList.add('hidden');
      $('organizationCapabilityDialogBackdrop').classList.add('hidden');
    };
    const deploymentText = (value) => ({ official_center: '官方平台', local: '本地部署', inherited: '依托上级' }[value] || value || '-');
    const levelText = (value) => ({ 0: '官方平台', 1: '一级代理', 2: '二级代理' }[Number(value)] || ('L' + value));

    function render() {
      if (!context) return;
      $('organizationContextCard').innerHTML = '<div class="section-head"><div><h2>' + escapeHtml(levelText(context.organizationLevel)) + '</h2><p>' + escapeHtml(context.organizationId) + '</p></div><span class="status ' + (context.organizationStatus === 'enabled' ? 'succeeded' : 'failed') + '">' + (context.organizationStatus === 'enabled' ? '授权有效' : '主体已停用') + '</span></div>'
        + '<div class="summary"><div class="metric"><span class="muted">部署归属</span><strong>' + escapeHtml(deploymentText(context.deploymentMode)) + '</strong></div><div class="metric"><span class="muted">数据范围</span><strong>' + escapeHtml(context.dataScope || '-') + '</strong></div><div class="metric"><span class="muted">有效能力</span><strong>' + Number((context.capabilityKeys || []).filter((key) => key !== '*').length) + '</strong></div></div>';
      const canCreate = Number(context.organizationLevel) === 1 && can('organizations.children.manage');
      $('createChildOrganizationCard').classList.toggle('hidden', !canCreate);
      const transferable = (context.capabilities || []).filter((item) => item.enabled && item.transferable && item.key !== '*');
      $('childOrganizationCapabilities').innerHTML = capabilityPickerHtml('new-child-capabilities', transferable, presetCapabilityKeys(transferable));
      bindCapabilityPicker($('childOrganizationCapabilities'));
      $('childOrganizationSummary').textContent = '共 ' + children.length + ' 个直属下级主体。';
      const canManageChildren = Number(context.organizationLevel) === 1;
      $('childOrganizationRows').innerHTML = children.length ? children.map((item) => '<tr><td><strong>' + escapeHtml(item.name) + '</strong><div class="muted mono">' + escapeHtml(item.externalId || item.id) + '</div></td><td><strong class="mono">' + escapeHtml(item.ownerUsername || '-') + '</strong><div class="muted small">' + escapeHtml(item.ownerDisplayName || '初始管理员') + '</div></td><td>' + escapeHtml(levelText(item.agentLevel)) + '<div class="muted">' + escapeHtml(deploymentText(item.deploymentMode)) + '</div></td><td><span class="status ' + (item.status === 'enabled' ? 'succeeded' : 'failed') + '">' + (item.status === 'enabled' ? '启用' : '停用') + '</span></td><td><div class="inline-actions">' + (canManageChildren && can('organizations.capabilities.manage') ? '<button class="secondary organization-capability-btn" data-id="' + escapeHtml(item.id) + '">配置能力</button>' : '') + (canManageChildren && can('organizations.children.manage') ? '<button class="secondary organization-password-btn" data-id="' + escapeHtml(item.id) + '" data-name="' + escapeHtml(item.name) + '">重置密码</button><button class="secondary organization-status-btn" data-id="' + escapeHtml(item.id) + '" data-status="' + (item.status === 'enabled' ? 'disabled' : 'enabled') + '">' + (item.status === 'enabled' ? '停用' : '启用') + '</button><button class="warning organization-delete-btn" data-id="' + escapeHtml(item.id) + '" data-name="' + escapeHtml(item.name) + '">删除</button>' : '<span class="muted">请在供应商接入管理</span>') + '</div></td></tr>').join('') : '<tr><td colspan="5" class="muted">暂无直属下级主体。</td></tr>';
      document.querySelectorAll('.organization-password-btn').forEach((button) => {
        button.onclick = async () => {
          const password = window.prompt('请为“' + button.dataset.name + '”设置新密码（至少 8 位）：');
          if (password === null) return;
          button.disabled = true;
          try {
            await api('/api/organizations/children/' + encodeURIComponent(button.dataset.id) + '/reset-password', { method: 'POST', body: JSON.stringify({ password }) });
            $('childOrganizationMsg').textContent = '管理员密码已重置。';
          } catch (error) { $('childOrganizationMsg').textContent = error.message; }
          finally { button.disabled = false; }
        };
      });
      document.querySelectorAll('.organization-delete-btn').forEach((button) => {
        button.onclick = async () => {
          if (!window.confirm('确定删除直属下级主体“' + button.dataset.name + '”吗？\n\n只有尚未产生业务数据的主体可以删除；已有数据的主体请改为停用。')) return;
          button.disabled = true;
          try {
            await api('/api/organizations/children/' + encodeURIComponent(button.dataset.id), { method: 'DELETE' });
            $('childOrganizationMsg').textContent = '直属下级主体已删除。';
            await refresh();
          } catch (error) { $('childOrganizationMsg').textContent = error.message; }
          finally { button.disabled = false; }
        };
      });
      document.querySelectorAll('.organization-status-btn').forEach((button) => {
        button.onclick = async () => {
          button.disabled = true;
          try {
            await api('/api/organizations/children/' + encodeURIComponent(button.dataset.id), { method: 'PATCH', body: JSON.stringify({ status: button.dataset.status }) });
            await refresh();
          } catch (error) {
            $('childOrganizationMsg').textContent = error.message;
          } finally { button.disabled = false; }
        };
      });
      document.querySelectorAll('.organization-capability-btn').forEach((button) => {
        button.onclick = async () => {
          try {
            const assigned = await api('/api/organizations/' + encodeURIComponent(button.dataset.id) + '/capabilities');
            const available = (context.capabilities || []).filter((item) => item.enabled && item.transferable && item.key !== '*');
            const assignedKeys = new Set(assigned.filter((item) => item.enabled).map((item) => item.key));
            capabilityDialogOrganizationId = button.dataset.id;
            $('configuredOrganizationCapabilities').innerHTML = capabilityPickerHtml('configured-child-capabilities', available, available.filter((item) => assignedKeys.has(item.key)).map((item) => item.key), { inline: true });
            bindCapabilityPicker($('configuredOrganizationCapabilities'));
            $('organizationCapabilityDialogMsg').textContent = '';
            $('organizationCapabilityDialog').classList.remove('hidden');
            $('organizationCapabilityDialogBackdrop').classList.remove('hidden');
          } catch (error) { $('childOrganizationMsg').textContent = error.message; }
        };
      });
    }

    async function refresh() {
      if (!getMe() || !can('organizations.view')) return;
      [context, children] = await Promise.all([
        api('/api/organizations/context'),
        api('/api/organizations/children'),
      ]);
      render();
    }

    function bind() {
      $('refreshOrganizationsBtn').onclick = () => refresh().catch((error) => { $('childOrganizationSummary').textContent = error.message; });
      $('childOrganizationForm').onsubmit = async (event) => {
        event.preventDefault();
        const button = event.submitter;
        button.disabled = true;
        $('childOrganizationMsg').textContent = '正在创建…';
        try {
          const capabilities = selectedCapabilityKeys($('childOrganizationCapabilities'));
          await api('/api/organizations/children', { method: 'POST', body: JSON.stringify({
            name: $('childOrganizationName').value,
            username: $('childOrganizationUsername').value,
            password: $('childOrganizationPassword').value,
            capabilities,
          }) });
          event.target.reset();
          $('childOrganizationMsg').textContent = '二级代理已创建。';
          await refresh();
        } catch (error) {
          $('childOrganizationMsg').textContent = error.message;
        } finally { button.disabled = false; }
      };
      $('closeOrganizationCapabilityDialogBtn').onclick = closeCapabilityDialog;
      $('cancelOrganizationCapabilityDialogBtn').onclick = closeCapabilityDialog;
      $('organizationCapabilityDialogBackdrop').onclick = closeCapabilityDialog;
      $('saveOrganizationCapabilityDialogBtn').onclick = async () => {
        if (!capabilityDialogOrganizationId) return;
        const button = $('saveOrganizationCapabilityDialogBtn');
        button.disabled = true;
        $('organizationCapabilityDialogMsg').textContent = '正在保存能力配置...';
        try {
          const requested = selectedCapabilityKeys($('configuredOrganizationCapabilities'));
          await api('/api/organizations/' + encodeURIComponent(capabilityDialogOrganizationId) + '/capabilities', { method: 'PUT', body: JSON.stringify({ capabilities: requested }) });
          $('childOrganizationMsg').textContent = '下级能力授权已更新。';
          closeCapabilityDialog();
        } catch (error) { $('organizationCapabilityDialogMsg').textContent = error.message; }
        finally { button.disabled = false; }
      };
    }

    bind();
    return { refresh };
  }

  global.createOrganizationView = createOrganizationView;
})(window);
