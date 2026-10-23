export function pm2NameFromPublicUrl(value) {
  const parsed = new URL(String(value || '').trim())
  const identity = parsed.host.toLowerCase()
  const slug = identity.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34) || 'site'
  let hash = 2166136261
  for (const char of identity) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  const suffix = (hash >>> 0).toString(36).padStart(7, '0').slice(-7)
  return `agent-ai-admin-${slug}-${suffix}`.slice(0, 63)
}

function clientApp(derivePm2Name) {
  const storageKey = 'agent-ai-admin-deployer-config-v2'
  const log = document.querySelector('#log')
  const statusTexts = [...document.querySelectorAll('[data-status]')]
  const actionButtons = [...document.querySelectorAll('[data-action]')]
  const resultDialog = document.querySelector('#testResultDialog')
  const testActions = new Set(['ssh-check', 'db-check', 'admin-build-check', 'check', 'version-check', 'configure-proxy'])

  function setStatus(message, tone = '') {
    for (const item of statusTexts) {
      item.textContent = message
      item.dataset.tone = tone
    }
  }

  function showTestResult({ title, succeeded, detail }) {
    const isConfiguration = title === '配置反向代理'
    resultDialog.dataset.tone = succeeded ? 'success' : 'danger'
    resultDialog.querySelector('[data-result-icon]').textContent = succeeded ? '✓' : '!'
    resultDialog.querySelector('[data-result-title]').textContent = title
    resultDialog.querySelector('[data-result-summary]').textContent = succeeded ? (isConfiguration ? '配置成功' : '检测通过') : (isConfiguration ? '配置失败' : '检测未通过')
    resultDialog.querySelector('[data-result-detail]').textContent = String(detail || '').trim() || '未返回详细信息'
    if (resultDialog.open) resultDialog.close()
    resultDialog.showModal()
  }

  resultDialog.querySelector('[data-result-close]').addEventListener('click', () => resultDialog.close())
  resultDialog.addEventListener('click', (event) => {
    if (event.target === resultDialog) resultDialog.close()
  })

  function updateVersionSummary(output) {
    const current = output.match(/^current_version=(.+)$/m)?.[1]?.trim()
    const latest = output.match(/^latest_version=(.+)$/m)?.[1]?.trim()
    const available = output.match(/^update_available=(true|false)$/m)?.[1]
    const notes = output.match(/^release_notes=(.*)$/m)?.[1]?.trim()
    if (!current || !latest || !available) return
    document.querySelector('[data-version-current]').textContent = current
    document.querySelector('[data-version-latest]').textContent = latest
    const state = document.querySelector('[data-version-state]')
    state.textContent = available === 'true' ? '发现可用更新' : '当前已是最新版本'
    state.dataset.available = available
    document.querySelector('[data-version-notes]').textContent = notes || '更新清单未提供版本说明'
  }

  function savedState() {
    try { return JSON.parse(localStorage.getItem(storageKey) || '{}') }
    catch { return {} }
  }

  function serialize(form) {
    const output = {}
    for (const element of form.elements) {
      if (!element.name || element.type === 'file' || element.type === 'button') continue
      output[element.name] = element.type === 'checkbox' ? element.checked : element.value
    }
    return output
  }

  function setSource(form, source) {
    const mode = source === 'local' ? 'local' : 'online'
    form.querySelector('[name=packageSource]').value = mode
    for (const button of form.querySelectorAll('[data-source]')) button.classList.toggle('active', button.dataset.source === mode)
    form.querySelector('[data-online-source]').hidden = mode !== 'online'
    form.querySelector('[data-local-source]').hidden = mode !== 'local'
  }

  function syncPm2Name(form) {
    const url = form.querySelector('[name=publicUrl]')?.value || ''
    const target = form.querySelector('[name=pm2Name]')
    if (!target) return
    try { target.value = derivePm2Name(url) }
    catch { target.value = '' }
  }

  function restore(form) {
    const data = savedState()[form.id] || {}
    for (const [name, value] of Object.entries(data)) {
      const element = form.elements.namedItem(name)
      if (!element || element.type === 'file') continue
      if (element.type === 'checkbox') element.checked = Boolean(value)
      else element.value = String(value ?? '')
    }
    setSource(form, data.packageSource)
    syncPm2Name(form)
  }

  function save(form) {
    const state = savedState()
    state[form.id] = serialize(form)
    localStorage.setItem(storageKey, JSON.stringify(state))
    setStatus(`${form.dataset.title}配置已保存（包含密码）`, 'success')
  }

  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.addEventListener('click', () => {
      for (const item of document.querySelectorAll('[data-tab]')) item.classList.toggle('active', item === tab)
      for (const panel of document.querySelectorAll('[data-panel]')) panel.classList.toggle('active', panel.dataset.panel === tab.dataset.tab)
    })
  }

  for (const form of document.querySelectorAll('form')) {
    restore(form)
    form.querySelector('[name=publicUrl]')?.addEventListener('input', () => syncPm2Name(form))
    for (const button of form.querySelectorAll('[data-source]')) button.addEventListener('click', () => setSource(form, button.dataset.source))
  }

  for (const button of document.querySelectorAll('[data-save]')) {
    button.addEventListener('click', () => save(document.querySelector(`#${button.dataset.save}`)))
  }

  document.querySelector('[data-clear]')?.addEventListener('click', () => {
    localStorage.removeItem(storageKey)
    setStatus('已清除当前浏览器保存的全部部署配置', 'warning')
  })

  function validateFields(form, names) {
    for (const name of names) {
      const field = form.elements.namedItem(name)
      if (field && !field.checkValidity()) {
        field.reportValidity()
        return false
      }
    }
    return true
  }

  async function run(button) {
    const action = button.dataset.action
    const panel = button.closest('[data-panel]')
    const form = panel.querySelector('form')
    const isFresh = panel.dataset.panel === 'fresh'
    const focusedFields = action === 'ssh-check'
      ? ['host', 'username', 'password']
      : action === 'db-check'
        ? (isFresh ? ['host', 'username', 'password', 'dbHost', 'dbPort', 'dbName', 'dbUser'] : ['host', 'username', 'password', 'appDir'])
        : action === 'admin-build-check'
          ? (isFresh ? ['publicUrl', 'adminUser', 'adminPassword', 'buildCenterUrl', 'supplierId', 'buildCenterToken'] : ['host', 'username', 'password', 'appDir'])
          : action === 'configure-proxy'
            ? ['host', 'username', 'password', 'appDir', 'publicUrl']
            : null
    if (focusedFields ? !validateFields(form, focusedFields) : !form.reportValidity()) return
    const input = serialize(form)
    input.action = action
    input.pm2Name = form.elements.pm2Name.value

    if (action === 'reset-password' && !input.newPassword) {
      form.elements.newPassword.focus()
      setStatus('请填写新的管理员密码', 'danger')
      return
    }

    if (action === 'upgrade' || action === 'fresh-install') {
      if (input.packageSource === 'local') {
        const file = form.elements.packageFile.files?.[0]
        if (!file) {
          setStatus('请选择本地 ZIP 安装包', 'danger')
          return
        }
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192))
        input.packageData = btoa(binary)
        input.packageName = file.name
      } else if (!input.packageUrl) {
        form.elements.packageUrl.focus()
        setStatus('请填写在线更新清单或 ZIP 地址', 'danger')
        return
      }
    }

    actionButtons.forEach((item) => { item.disabled = true })
    setStatus(`正在执行：${button.textContent.trim()}`, 'running')
    log.textContent = `> ${button.textContent.trim()}\n\n`

    try {
      const response = await fetch('run', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-deployer-token': new URLSearchParams(location.search).get('t') || ''
        },
        body: JSON.stringify(input)
      })
      if (response.status === 401) {
        save(form)
        setStatus('部署工具已重启，正在恢复配置并刷新安全令牌…', 'warning')
        location.replace('/')
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        log.textContent += decoder.decode(chunk.value)
        log.scrollTop = log.scrollHeight
      }
      if (action === 'version-check') updateVersionSummary(log.textContent)
      const succeeded = response.ok && /退出码:\s*0\s*$/.test(log.textContent)
      setStatus(succeeded ? '操作执行成功' : (response.ok ? '操作执行失败，请检查下方日志' : `操作失败（HTTP ${response.status}）`), succeeded ? 'success' : 'danger')
      if (testActions.has(action)) {
        showTestResult({
          title: button.textContent.trim(),
          succeeded,
          detail: log.textContent.replace(/^>[^\n]*\n+/, '').replace(/\n?退出码:\s*\d+\s*$/, '')
        })
      }
    } catch (error) {
      log.textContent += `\n请求失败：${error.message}\n`
      setStatus('无法连接部署工具服务', 'danger')
      if (testActions.has(action)) showTestResult({ title: button.textContent.trim(), succeeded: false, detail: `请求失败：${error.message}` })
    } finally {
      actionButtons.forEach((item) => { item.disabled = false })
    }
  }

  actionButtons.forEach((button) => button.addEventListener('click', () => run(button)))
}

export function renderPage({ serverLocalMode = false } = {}) {
  const freshConnection = serverLocalMode
    ? `<section class="section"><div class="section-title"><div><h3>当前服务器</h3><span>命令直接在宝塔服务器本机执行，无需 SSH</span></div><button type="button" class="button secondary" data-action="ssh-check">检测服务器环境</button></div><div class="grid"><div class="callout"><strong>服务器本地模式：</strong>请保持宝塔终端中的启动进程运行；关闭终端或按 Ctrl+C 后本页面停止。</div><label class="field full"><span class="field-label">应用目录 <b class="required">*</b><em>每套实例必须独立</em></span><input class="input" name="appDir" placeholder="/www/wwwroot/admin-example-com" required></label></div></section>`
    : `<section class="section"><div class="section-title"><div><h3>服务器连接</h3><span>通过 SSH 在目标服务器执行</span></div><button type="button" class="button secondary" data-action="ssh-check">测试 SSH</button></div><div class="grid"><label class="field"><span class="field-label">SSH 服务器 <b class="required">*</b></span><input class="input" name="host" placeholder="192.0.2.10 或域名" required></label><label class="field"><span class="field-label">SSH 用户</span><input class="input" name="username" value="root" required></label><label class="field"><span class="field-label">SSH 密码</span><input class="input" name="password" type="password" autocomplete="new-password" required></label><label class="field full"><span class="field-label">应用目录 <b class="required">*</b><em>每套实例必须独立</em></span><input class="input" name="appDir" placeholder="/www/wwwroot/admin-example-com" required></label></div></section>`
  const maintenanceConnection = serverLocalMode
    ? `<section class="section"><div class="section-title"><div><h3>本机实例</h3><span>从当前宝塔服务器直接读取和维护</span></div><button type="button" class="button secondary" data-action="ssh-check">检测服务器环境</button></div><div class="grid"><label class="field full"><span class="field-label">应用目录 <b class="required">*</b></span><input class="input" name="appDir" placeholder="/www/wwwroot/admin-example-com" required></label></div></section>`
    : `<section class="section"><div class="section-title"><div><h3>实例连接</h3><span>保存内容包含 SSH 密码</span></div><button type="button" class="button secondary" data-action="ssh-check">测试 SSH</button></div><div class="grid"><label class="field"><span class="field-label">SSH 服务器 <b class="required">*</b></span><input class="input" name="host" required></label><label class="field"><span class="field-label">SSH 用户</span><input class="input" name="username" value="root" required></label><label class="field"><span class="field-label">SSH 密码</span><input class="input" name="password" type="password" autocomplete="new-password" required></label><label class="field full"><span class="field-label">应用目录 <b class="required">*</b></span><input class="input" name="appDir" placeholder="/www/wwwroot/admin-example-com" required></label></div></section>`
  const databaseCheckLabel = serverLocalMode ? '直接连接当前服务器数据库，不开放数据库公网端口' : '通过 SSH 隧道验证当前账号，不暴露数据库端口'
  const maintenanceDatabaseLabel = serverLocalMode ? '自动读取目标实例 .env，在当前服务器验证' : '自动读取目标实例 .env，通过 SSH 隧道验证'
  const footerMode = serverLocalMode ? '所有部署操作均在当前宝塔服务器本机执行。' : '所有远端操作均通过 SSH 执行。'
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Agent AI Admin 部署中心</title>
  <style>
    :root{color-scheme:light;--bg:#f2f5f9;--surface:#fff;--surface-soft:#f8fafc;--text:#162033;--muted:#64748b;--line:#dce3ec;--primary:#2357d9;--primary-hover:#1948bd;--primary-soft:#edf3ff;--danger:#c0362c;--warning:#a86409;--success:#16835f;--shadow:0 18px 55px rgba(27,39,68,.1);--radius:16px}
    @media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0c121d;--surface:#121b29;--surface-soft:#172233;--text:#edf4ff;--muted:#9aacbf;--line:#26364b;--primary:#6f96ff;--primary-hover:#87a8ff;--primary-soft:#17294d;--danger:#ff8a80;--warning:#f5bd66;--success:#55d3a4;--shadow:0 20px 70px rgba(0,0,0,.28)}}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% -10%,rgba(64,108,230,.13),transparent 34%),var(--bg);color:var(--text);font:14px/1.55 Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}button,input{font:inherit}button{cursor:pointer}.shell{max-width:1240px;margin:0 auto;padding:26px 22px 42px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:20px}.brand{display:flex;align-items:center;gap:13px}.brand-mark{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;color:#fff;font-weight:800;letter-spacing:-.5px;background:linear-gradient(145deg,#2357d9,#6c48dc);box-shadow:0 8px 22px rgba(35,87,217,.3)}h1{font-size:21px;line-height:1.2;margin:0}.subtitle{color:var(--muted);margin-top:4px;font-size:13px}.security-note{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--muted);font-size:12px}.security-note i{width:7px;height:7px;border-radius:50%;background:var(--success)}.workspace{background:var(--surface);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);overflow:hidden}.tabs{display:flex;align-items:center;gap:4px;padding:10px;border-bottom:1px solid var(--line);background:var(--surface-soft)}.tab{border:0;background:transparent;color:var(--muted);padding:10px 16px;border-radius:10px;font-weight:650}.tab.active{color:var(--primary);background:var(--surface);box-shadow:0 2px 10px rgba(30,50,80,.08)}.tab small{display:block;font-size:11px;font-weight:400;margin-top:1px}.panel{display:none}.panel.active{display:block}.panel-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding:22px 24px 4px}.panel-head h2{font-size:18px;margin:0 0 4px}.panel-head p{margin:0;color:var(--muted)}.head-actions{display:flex;gap:8px;flex-wrap:wrap}.button{border:1px solid transparent;border-radius:9px;padding:9px 13px;background:var(--primary);color:#fff;font-weight:650;transition:.16s ease}.button:hover{background:var(--primary-hover);transform:translateY(-1px)}.button:disabled{opacity:.5;cursor:wait;transform:none}.button.secondary{background:var(--surface);border-color:var(--line);color:var(--text)}.button.secondary:hover{background:var(--surface-soft)}.button.danger{background:var(--danger)}.form-layout{padding:18px 24px 24px;display:grid;gap:16px}.section{border:1px solid var(--line);border-radius:var(--radius);padding:18px;background:var(--surface)}.section-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.section-title h3{font-size:14px;margin:0}.section-title span{font-size:12px;color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.field{display:flex;flex-direction:column;gap:6px;min-width:0}.field.wide{grid-column:span 2}.field.full{grid-column:1/-1}.field-label{display:flex;align-items:center;justify-content:space-between;font-weight:650;font-size:13px}.field-label em{font-style:normal;color:var(--muted);font-size:11px;font-weight:400}.input{width:100%;height:40px;border:1px solid var(--line);border-radius:9px;padding:0 11px;background:var(--surface-soft);color:var(--text);outline:none;transition:.15s}.input:focus{border-color:var(--primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--primary) 15%,transparent);background:var(--surface)}.input[readonly]{color:var(--primary);background:var(--primary-soft);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}.help{font-size:11px;color:var(--muted)}.auto-value{height:40px;border:1px dashed color-mix(in srgb,var(--primary) 45%,var(--line));border-radius:9px;padding:0 11px;display:flex;align-items:center;justify-content:space-between;background:var(--primary-soft);color:var(--primary);font-weight:650}.auto-value small{font-weight:400;color:var(--muted)}.callout{grid-column:1/-1;padding:12px 14px;border-radius:11px;background:var(--primary-soft);border:1px solid color-mix(in srgb,var(--primary) 25%,var(--line));color:var(--text)}.callout strong{color:var(--primary)}.source-switch{display:inline-flex;padding:3px;background:var(--surface-soft);border:1px solid var(--line);border-radius:10px}.source-switch button{border:0;background:transparent;color:var(--muted);padding:7px 12px;border-radius:7px;font-weight:600}.source-switch button.active{background:var(--surface);color:var(--primary);box-shadow:0 2px 8px rgba(30,50,80,.09)}.version-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.version-item{padding:13px 14px;border:1px solid var(--line);border-radius:11px;background:var(--surface-soft)}.version-item span{display:block;color:var(--muted);font-size:11px;margin-bottom:4px}.version-item strong{font-size:16px}.version-state[data-available=true]{color:var(--warning)}.version-state[data-available=false]{color:var(--success)}.version-notes{grid-column:1/-1;color:var(--muted);font-size:12px;padding:4px 2px 0}[hidden]{display:none!important}.operation-bar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:17px 24px;border-top:1px solid var(--line);background:var(--surface-soft)}.operations{display:flex;gap:8px;flex-wrap:wrap}.status{font-size:12px;color:var(--muted)}.status[data-tone=success]{color:var(--success)}.status[data-tone=danger]{color:var(--danger)}.status[data-tone=warning]{color:var(--warning)}.status[data-tone=running]{color:var(--primary)}.console{margin:0;border-top:1px solid #263246;background:#0b111c;color:#d5e2f2;padding:18px 22px;min-height:250px;max-height:430px;overflow:auto;white-space:pre-wrap;font:12px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace}.result-dialog{width:min(520px,calc(100vw - 32px));padding:0;border:0;border-radius:18px;background:var(--surface);color:var(--text);box-shadow:0 28px 80px rgba(8,20,45,.28)}.result-dialog::backdrop{background:rgba(11,20,38,.46);backdrop-filter:blur(3px)}.result-card{padding:24px}.result-head{display:flex;align-items:flex-start;gap:14px}.result-icon{display:grid;place-items:center;flex:0 0 42px;width:42px;height:42px;border-radius:50%;font-size:22px;font-weight:800;background:#e8f8ef;color:var(--success)}.result-dialog[data-tone=danger] .result-icon{background:#ffebee;color:var(--danger)}.result-copy{min-width:0;flex:1}.result-copy h3{margin:1px 0 2px;font-size:17px}.result-copy p{margin:0;color:var(--success);font-weight:650}.result-dialog[data-tone=danger] .result-copy p{color:var(--danger)}.result-detail{margin:18px 0 0;max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;padding:13px 14px;border:1px solid var(--line);border-radius:11px;background:var(--surface-soft);color:var(--muted);font:12px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace}.result-actions{display:flex;justify-content:flex-end;margin-top:18px}.footer-note{display:flex;justify-content:space-between;gap:20px;color:var(--muted);font-size:12px;margin-top:14px;padding:0 4px}.required{color:var(--danger)}
    @media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.field.wide{grid-column:1/-1}.topbar{align-items:flex-start}.security-note{border-radius:10px}.operation-bar{align-items:flex-start;flex-direction:column}}
    @media(max-width:620px){.shell{padding:12px}.topbar{display:block}.security-note{margin-top:12px}.tabs{display:grid;grid-template-columns:1fr 1fr}.tab{padding:9px 6px}.panel-head{padding:18px 16px 2px;display:block}.head-actions{margin-top:12px}.form-layout{padding:14px 16px 18px}.section{padding:14px}.grid,.version-summary{grid-template-columns:1fr}.field.wide,.field.full,.version-notes{grid-column:auto}.auto-value{height:auto;min-height:46px;align-items:flex-start;flex-direction:column;justify-content:center}.operation-bar{padding:15px 16px}.operations{width:100%}.operations .button{flex:1;min-width:120px}.console{padding:15px;min-height:220px}.footer-note{display:block}.footer-note span{display:block;margin-top:5px}}
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand"><div class="brand-mark">AI</div><div><h1>Agent AI Admin 部署中心</h1><div class="subtitle">多实例安装、升级、回滚与运行维护</div></div></div>
      <div class="security-note"><i></i>配置保存在当前浏览器本地，包含你选择保存的全部密码</div>
    </header>
    <main class="workspace">
      <nav class="tabs"><button type="button" class="tab active" data-tab="fresh">首次安装<small>创建一套独立实例</small></button><button type="button" class="tab" data-tab="maint">升级与维护<small>管理已部署实例</small></button></nav>

      <section class="panel active" data-panel="fresh">
        <div class="panel-head"><div><h2>首次安装</h2><p>为一个公网域名部署独立的应用目录、Node 端口与 PM2 进程。</p></div><div class="head-actions"><button type="button" class="button secondary" data-save="freshForm">保存全部配置</button><button type="button" class="button secondary" data-clear>清除已保存配置</button></div></div>
        <form id="freshForm" class="form-layout" data-title="首次安装">
          ${freshConnection}
          <section class="section"><div class="section-title"><h3>实例标识与端口</h3><span>域名、端口和进程一一对应</span></div><div class="grid">
            <label class="field wide"><span class="field-label">后台公网 URL <b class="required">*</b></span><input class="input" name="publicUrl" type="url" placeholder="https://admin.example.com" required></label>
            <label class="field"><span class="field-label">Node 监听地址</span><input class="input" name="adminHost" value="127.0.0.1" required></label>
            <div class="field"><span class="field-label">Node 端口 <em>无需填写</em></span><div class="auto-value">自动分配 <small>优先使用 7077，并避开已占用端口</small></div><input type="hidden" name="adminPort" value="auto"></div>
            <label class="field wide"><span class="field-label">PM2 名称 <em>根据公网 URL 自动生成</em></span><input class="input" name="pm2Name" readonly tabindex="-1" placeholder="填写公网 URL 后自动生成"></label>
            <label class="field full"><span class="field-label">宝塔反向代理</span><span class="callout"><input type="checkbox" name="autoProxy" checked> 安装完成后自动把该域名反向代理到自动分配的 Node 端口</span></label>
            <div class="callout"><strong>自动端口规则：</strong>新目录从 7077 开始选择未监听、未被其他 Admin 配置占用的端口；目标目录已有配置时沿用原端口。安装成功后会在日志中显示实际端口。</div>
          </div></section>
          <section class="section"><div class="section-title"><div><h3>数据库</h3><span>${databaseCheckLabel}</span></div><button type="button" class="button secondary" data-action="db-check">测试数据库</button></div><div class="grid">
            <label class="field"><span class="field-label">数据库地址</span><input class="input" name="dbHost" value="127.0.0.1" required></label>
            <label class="field"><span class="field-label">数据库端口</span><input class="input" name="dbPort" type="number" min="1" max="65535" value="3306" required></label>
            <label class="field"><span class="field-label">数据库名 <b class="required">*</b></span><input class="input" name="dbName" required></label>
            <label class="field"><span class="field-label">数据库用户 <b class="required">*</b></span><input class="input" name="dbUser" required></label>
            <label class="field wide"><span class="field-label">数据库密码</span><input class="input" name="dbPassword" type="password" autocomplete="new-password"></label>
          </div></section>
          <section class="section"><div class="section-title"><div><h3>管理员与构建中心</h3><span>校验管理员参数；构建中心未配置时自动跳过</span></div><button type="button" class="button secondary" data-action="admin-build-check">测试本节</button></div><div class="grid">
            <label class="field"><span class="field-label">管理员账号 <b class="required">*</b></span><input class="input" name="adminUser" value="admin" required></label>
            <label class="field wide"><span class="field-label">管理员密码 <b class="required">*</b></span><input class="input" name="adminPassword" type="password" minlength="8" autocomplete="new-password" required></label>
            <label class="field wide"><span class="field-label">构建中心 URL <em>选填，可部署后设置</em></span><input class="input" name="buildCenterUrl" type="url" placeholder="https://center.okpa.cn（可留空）"></label>
            <label class="field"><span class="field-label">Supplier ID <em>选填</em></span><input class="input" name="supplierId"></label>
            <label class="field full"><span class="field-label">构建中心 Token <em>选填，可部署后设置</em></span><input class="input" name="buildCenterToken" type="password" autocomplete="new-password"></label>
          </div></section>
          <section class="section"><div class="section-title"><h3>安装包</h3><div class="source-switch"><button type="button" class="active" data-source="online">在线拉取</button><button type="button" data-source="local">本地 ZIP</button></div></div><div class="grid">
            <input type="hidden" name="packageSource" value="online">
            <label class="field full" data-online-source><span class="field-label">更新清单或 ZIP 地址</span><input class="input" name="packageUrl" value="https://updates.okpa.cn/agent/ai-admin/latest.json"></label>
            <label class="field full" data-local-source hidden><span class="field-label">选择安装包</span><input class="input" name="packageFile" type="file" accept=".zip,application/zip"></label>
          </div></section>
        </form>
        <div class="operation-bar"><div class="operations"><button type="button" class="button" data-action="fresh-install">开始首次安装</button></div><span class="status" data-status>等待操作</span></div>
      </section>

      <section class="panel" data-panel="maint">
        <div class="panel-head"><div><h2>升级与维护</h2><p>通过公网 URL 自动定位 PM2 名称，管理服务器上的指定实例。</p></div><div class="head-actions"><button type="button" class="button secondary" data-save="maintForm">保存全部配置</button><button type="button" class="button secondary" data-clear>清除已保存配置</button></div></div>
        <form id="maintForm" class="form-layout" data-title="升级与维护">
          ${maintenanceConnection}
          <section class="section"><div class="section-title"><div><h3>实例身份</h3><span>必须与首次安装时保持一致</span></div><div class="operations"><button type="button" class="button secondary" data-action="check">测试实例</button><button type="button" class="button secondary" data-action="configure-proxy">配置反向代理</button></div></div><div class="grid">
            <label class="field wide"><span class="field-label">后台公网 URL <b class="required">*</b></span><input class="input" name="publicUrl" type="url" placeholder="https://admin.example.com" required></label>
            <div class="field"><span class="field-label">管理端口 <em>无需填写</em></span><div class="auto-value">自动读取 <small>来自目标目录 .env</small></div><input type="hidden" name="adminPort" value="auto"></div>
            <label class="field full"><span class="field-label">PM2 名称 <em>根据公网 URL 自动生成</em></span><input class="input" name="pm2Name" readonly tabindex="-1" placeholder="填写公网 URL 后自动生成"></label>
            <div class="callout"><strong>维护识别：</strong>工具通过应用目录读取该实例的实际端口，并根据公网 URL 生成 PM2 名称，不再要求人工记忆端口。</div>
          </div></section>
          <section class="section"><div class="section-title"><div><h3>数据库状态</h3><span>${maintenanceDatabaseLabel}</span></div><button type="button" class="button secondary" data-action="db-check">测试数据库</button></div><div class="callout"><strong>无需重复填写：</strong>维护检测使用该实例已经保存的数据库地址、账号、密码和库名。</div></section>
          <section class="section"><div class="section-title"><div><h3>管理端与构建中心</h3><span>检查管理端接口；已启用构建中心时同时校验凭据</span></div><button type="button" class="button secondary" data-action="admin-build-check">测试服务</button></div><div class="callout"><strong>可独立检测：</strong>未配置构建中心时仅检查管理端，不会把构建中心作为升级前置条件。</div></section>
          <section class="section"><div class="section-title"><div><h3>版本状态</h3><span>对比服务器当前版本与在线更新清单</span></div><button type="button" class="button secondary" data-action="version-check">检测版本</button></div><div class="version-summary">
            <div class="version-item"><span>当前版本</span><strong data-version-current>尚未检测</strong></div>
            <div class="version-item"><span>最新版本</span><strong data-version-latest>尚未检测</strong></div>
            <div class="version-item"><span>更新状态</span><strong class="version-state" data-version-state>等待检测</strong></div>
            <div class="version-notes" data-version-notes>检测不会下载升级包，也不会重启服务。</div>
          </div></section>
          <section class="section"><div class="section-title"><h3>升级包</h3><div class="source-switch"><button type="button" class="active" data-source="online">在线拉取</button><button type="button" data-source="local">本地 ZIP</button></div></div><div class="grid">
            <input type="hidden" name="packageSource" value="online">
            <label class="field full" data-online-source><span class="field-label">更新清单或 ZIP 地址</span><input class="input" name="packageUrl" value="https://updates.okpa.cn/agent/ai-admin/latest.json"></label>
            <label class="field full" data-local-source hidden><span class="field-label">选择升级包</span><input class="input" name="packageFile" type="file" accept=".zip,application/zip"></label>
          </div></section>
          <section class="section"><div class="section-title"><h3>维护参数</h3><span>仅在对应操作时使用</span></div><div class="grid">
            <label class="field"><span class="field-label">回滚版本</span><input class="input" name="version" placeholder="留空自动选择上一版本"></label>
            <label class="field"><span class="field-label">管理员账号</span><input class="input" name="user" value="admin"></label>
            <label class="field"><span class="field-label">新管理员密码</span><input class="input" name="newPassword" type="password" minlength="8" autocomplete="new-password"></label>
          </div></section>
        </form>
        <div class="operation-bar"><div class="operations"><button type="button" class="button" data-action="upgrade">开始升级</button><button type="button" class="button secondary" data-action="rollback">回滚版本</button><button type="button" class="button secondary" data-action="diagnose">运行诊断</button><button type="button" class="button secondary" data-action="install-supervisor">安装自愈服务</button><button type="button" class="button danger" data-action="reset-password">重置密码</button></div><span class="status" data-status>等待操作</span></div>
      </section>
      <pre class="console" id="log">部署工具已就绪，等待操作...</pre>
    </main>
    <dialog class="result-dialog" id="testResultDialog" aria-labelledby="testResultTitle">
      <div class="result-card"><div class="result-head"><div class="result-icon" data-result-icon>✓</div><div class="result-copy"><h3 id="testResultTitle" data-result-title>检测结果</h3><p data-result-summary>检测通过</p></div></div><pre class="result-detail" data-result-detail></pre><div class="result-actions"><button type="button" class="button" data-result-close>知道了</button></div></div>
    </dialog>
    <div class="footer-note"><span>${footerMode}</span><span>配置保存在浏览器 localStorage；服务器页面使用临时令牌并会自动到期。</span></div>
  </div>
  <script>(${clientApp.toString()})(${pm2NameFromPublicUrl.toString()})</script>
</body>
</html>`
}
