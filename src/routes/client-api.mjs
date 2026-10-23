import { randomUUID } from 'node:crypto'
import { requireClientAuth, getClientAuthUser } from '../middleware/auth.mjs'
import { db } from '../db/pool.mjs'
import { writeAppLog } from '../utils/log.mjs'
import { classifyProviderHttpError, classifyProviderTransportError } from '../services/model-proxy-errors.mjs'
import { redeemCodeForEndUser } from '../services/redeem-codes.mjs'
import { createModelProxyLifecycle, isDownstreamAbortReason } from '../services/model-proxy-lifecycle.mjs'
import { clientBillingErrorResponse } from '../services/client-billing.mjs'
import { applyModelReasoning } from '../services/model-reasoning.mjs'
import { sendLoginProtectionError } from '../services/login-protection.mjs'

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.floor(number)))
}

function normalizeBochaFreshness(value) {
  const raw = String(value || '').trim()
  if (['noLimit', 'oneDay', 'oneWeek', 'oneMonth', 'oneYear'].includes(raw)) return raw
  return 'noLimit'
}

function normalizeSearchResultItem(item = {}) {
  return {
    title: String(item.name || item.title || '').trim(),
    url: String(item.url || '').trim(),
    displayUrl: String(item.displayUrl || '').trim(),
    snippet: String(item.summary || item.snippet || '').trim(),
    summary: String(item.summary || '').trim(),
    siteName: String(item.siteName || '').trim(),
    siteIcon: String(item.siteIcon || '').trim(),
    publishedAt: String(item.datePublished || item.dateLastCrawled || '').trim(),
    language: String(item.language || '').trim(),
  }
}

function modelPreference(model = {}) {
  return (model.configured === true ? 4 : 0)
    + (model.isDefault === true ? 2 : 0)
    + (Number(model.contextWindow || 0) > 0 ? 1 : 0)
}

export function dedupeClientModelCatalog(catalog = {}) {
  const dedupe = (items) => {
    const unique = new Map()
    for (const model of Array.isArray(items) ? items : []) {
      const id = String(model?.id || '').trim()
      if (!id) continue
      const current = unique.get(id)
      if (!current || modelPreference(model) > modelPreference(current)) unique.set(id, model)
    }
    return [...unique.values()]
  }
  return {
    ...catalog,
    models: dedupe(catalog.models),
    searchModels: dedupe(catalog.searchModels),
  }
}

function normalizeBochaSearchPayload(payload = {}, context, requestBody = {}) {
  const webPages = Array.isArray(payload?.data?.webPages?.value) ? payload.data.webPages.value : []
  const images = Array.isArray(payload?.data?.images?.value) ? payload.data.images.value : []
  const videos = Array.isArray(payload?.data?.videos?.value) ? payload.data.videos.value : []
  return {
    query: String(requestBody.query || payload?.data?.queryContext?.originalQuery || '').trim(),
    providerId: context.provider.id,
    providerName: context.provider.name,
    modelId: context.model.modelId,
    requestId: String(payload?.log_id || ''),
    results: webPages.map(normalizeSearchResultItem).filter((item) => item.title || item.url),
    images,
    videos,
    rawCode: payload?.code,
    rawMessage: payload?.msg || payload?.message || '',
  }
}

export function registerClientApiRoutes(app, deps) {
  const {
    registerEndUser,
    requestEndUserRegistrationCode,
    loginEndUser,
    sanitizeEndUser,
    findEndUserById,
    findEndUserWithMembershipById,
    changeEndUserPassword,
    requestEndUserPasswordReset,
    confirmEndUserPasswordReset,
    keyOwnerUserIdForEndUser,
    listCreditLedger,
    listCreditLedgerPage,
    listClientModelCatalog,
    resolveModelProxyContext,
    generateImageForClient,
    recordModelKeySuccess,
    recordModelKeyFailure,
    recordModelKeyUsageFailure,
    deductCreditsForLocalUsage,
    getClientCreditState,
    assertClientModelRequestAllowed,
    loginProtection,
  } = deps

  app.post('/api/client/auth/register', async (req, res) => {
    try {
      res.json({ success: true, data: await registerEndUser(req.body || {}) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/client/auth/registration-code/request', async (req, res) => {
    try {
      res.json({ success: true, data: await requestEndUserRegistrationCode(req.body || {}, req) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/client/auth/login-captcha', (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store')
      res.json({ success: true, data: loginProtection.createChallenge('client', req) })
    } catch (err) {
      if (!sendLoginProtectionError(res, err)) {
        res.status(500).json({ success: false, error: '登录验证服务暂时不可用' })
      }
    }
  })

  app.post('/api/client/auth/login', async (req, res) => {
    const principal = String(req.body?.username || '').trim().toLowerCase()
    try {
      loginProtection.assertLoginAllowed('client', principal, req)
      loginProtection.verifyCaptcha('client', req.body || {}, req)
      res.json({ success: true, data: await loginEndUser(req.body || {}) })
    } catch (err) {
      if (sendLoginProtectionError(res, err)) return
      if (err instanceof Error && ['账号或密码不正确', '账号已被停用，请联系管理员'].includes(err.message)) {
        const retryAfterSeconds = loginProtection.recordFailure('client', principal, req)
        if (retryAfterSeconds > 0) {
          res.setHeader('Retry-After', String(retryAfterSeconds))
          res.status(429).json({ success: false, code: 'LOGIN_RATE_LIMITED', error: '登录尝试过于频繁，请稍后再试' })
          return
        }
      }
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/client/auth/me', async (req, res) => {
    try {
      const user = await getClientAuthUser(req)
      if (!user) {
        res.status(401).json({ success: false, error: '未登录或账号已停用' })
        return
      }
      const fullUser = await (findEndUserWithMembershipById || findEndUserById)(user.id)
      res.json({ success: true, data: { user: sanitizeEndUser(fullUser) } })
    } catch (err) {
      res.status(401).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/client/auth/password', async (req, res) => {
    try {
      const user = await getClientAuthUser(req)
      if (!user) {
        res.status(401).json({ success: false, error: '未登录或账号已停用' })
        return
      }
      const fullUser = await findEndUserById(user.id)
      res.json({ success: true, data: await changeEndUserPassword(fullUser, req.body || {}) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/client/auth/password-reset/request', async (req, res) => {
    try {
      res.json({ success: true, data: await requestEndUserPasswordReset(req.body || {}, req) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/client/auth/password-reset/confirm', async (req, res) => {
    try {
      res.json({ success: true, data: await confirmEndUserPasswordReset(req.body || {}) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/client/credits/me', requireClientAuth, async (req, res) => {
    try {
      const user = await (findEndUserWithMembershipById || findEndUserById)(req.clientUser.id)
      const keyOwnerUserId = await keyOwnerUserIdForEndUser(req.clientUser.id)
      const [rows] = await db().query(
        `SELECT
        (SELECT COUNT(*) FROM ai_model_providers WHERE status = 'enabled') AS providers,
        (SELECT COUNT(*) FROM ai_model_provider_keys WHERE owner_user_id = ? AND status = 'enabled') AS key_count,
        (SELECT COUNT(*) FROM ai_provider_models WHERE status = 'enabled') AS models,
        (SELECT COUNT(*) FROM ai_model_pricing_rules WHERE status = 'enabled') AS rules`,
        [keyOwnerUserId],
      )
      const configured = Number(rows[0]?.providers || 0) > 0 && Number(rows[0]?.key_count || 0) > 0 && Number(rows[0]?.models || 0) > 0 && Number(rows[0]?.rules || 0) > 0
      const billing = await getClientCreditState(user)
      res.json({
        success: true,
        data: {
          user: sanitizeEndUser(user),
          ...billing,
          modelProxyConfigured: configured,
          modelPointsPerUsd: 0,
        },
      })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/client/credits/ledger', requireClientAuth, async (req, res) => {
    try {
      if (req.query.page === undefined && req.query.pageSize === undefined) {
        res.json({ success: true, data: await listCreditLedger(req.clientUser.id, req.query.limit || 100) })
        return
      }
      const page = await listCreditLedgerPage({
        userId: req.clientUser.id,
        page: req.query.page || 1,
        pageSize: req.query.pageSize || req.query.limit || 20,
      })
      // The shared ledger query exposes an administrator-wide `totalConsumed`
      // metric. A client account must only ever receive its own aggregate.
      res.json({ success: true, data: clientScopedCreditLedgerPage(page) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/client/redeem-codes/redeem', requireClientAuth, async (req, res) => {
    try {
      res.json({ success: true, data: await redeemCodeForEndUser(req.clientUser.id, req.body?.code, req.body || {}) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/client/model/models', requireClientAuth, async (req, res) => {
    try {
      res.json({ success: true, data: dedupeClientModelCatalog(await listClientModelCatalog(req.clientUser.id)) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/client/model/v1/chat/completions', requireClientAuth, async (req, res) => {
    let context
    let proxyLifecycle
    let proxyRequestId = ''
    let proxyStartedAt = 0
    try {
      const user = await findEndUserById(req.clientUser.id)
      let upstreamBody = { ...(req.body || {}) }
      const resolvedContext = await resolveModelProxyContext(upstreamBody.model, req.clientUser.id, 'text')
      await assertClientModelRequestAllowed(user, resolvedContext.pricingRule)
      context = resolvedContext
      if (context.model.modelType !== 'text') {
        res.status(400).json({ error: { message: '当前模型分类暂不支持聊天调用，请选择文本模型' } })
        return
      }
      upstreamBody = applyModelReasoning(upstreamBody, context.model)
      upstreamBody.model = context.model.modelId
      if (upstreamBody.stream === true) {
        upstreamBody.stream_options = { ...(upstreamBody.stream_options || {}), include_usage: true }
      }
      const endpointPath = context.endpointPath || '/chat/completions'
      const upstreamUrl = `${String(context.provider.baseUrl || '').replace(/\/$/, '')}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`
      const providerTimeoutMs = Math.max(10000, Number(context.provider.timeoutMs || 120000))
      proxyRequestId = String(req.headers['x-request-id'] || randomUUID())
      proxyStartedAt = Date.now()
      const proxyLogContext = {
        requestId: proxyRequestId,
        userId: req.clientUser.id,
        providerId: context.provider.id,
        providerName: context.provider.name,
        modelId: context.model.modelId,
      }
      proxyLifecycle = createModelProxyLifecycle({
        req,
        res,
        timeoutMs: providerTimeoutMs,
        onAbort: (reason) => writeAppLog('model-proxy', JSON.stringify({
          event: 'aborted',
          ...proxyLogContext,
          reason,
          elapsedMs: Date.now() - proxyStartedAt,
        })),
      })
      writeAppLog('model-proxy', JSON.stringify({
        event: 'request',
        ...proxyLogContext,
        timeoutMs: providerTimeoutMs,
        stream: upstreamBody.stream === true,
        messageCount: Array.isArray(upstreamBody.messages) ? upstreamBody.messages.length : 0,
        toolCount: Array.isArray(upstreamBody.tools) ? upstreamBody.tools.length : 0,
      }))
      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.key.apiKey}`,
          'content-type': 'application/json',
          accept: req.headers.accept || 'application/json',
        },
        signal: proxyLifecycle.signal,
        body: JSON.stringify(upstreamBody),
      })
      proxyLifecycle.clearHeaderTimeout()
      writeAppLog('model-proxy', JSON.stringify({
        event: 'upstream_headers',
        ...proxyLogContext,
        status: upstream.status,
        ttfbMs: Date.now() - proxyStartedAt,
        upstreamRequestId: upstream.headers.get('x-request-id') || '',
      }))
      const contentType = upstream.headers.get('content-type') || 'application/json'
      const providerHttpError = classifyProviderHttpError(upstream.status)
      res.status(providerHttpError?.status || upstream.status)
      res.setHeader('Content-Type', contentType)
      const copyHeaders = ['cache-control', 'x-request-id']
      for (const name of copyHeaders) {
        const value = upstream.headers.get(name)
        if (value) res.setHeader(name, value)
      }
      if (!upstream.ok) {
        const text = await upstream.text()
        await recordModelKeyFailure(context.key.id, text)
        let errorReason = text
        try {
          const payload = JSON.parse(text)
          errorReason = payload?.error?.message || payload?.message || payload?.error || text
          if (typeof errorReason !== 'string') errorReason = JSON.stringify(errorReason)
        } catch {
          // Keep the upstream response body as the failure reason when it is not JSON.
        }
        await recordModelKeyUsageFailure(
          req.clientUser.id,
          context,
          upstream.headers.get('x-request-id') || proxyRequestId,
          `上游请求失败 (HTTP ${upstream.status}): ${String(errorReason || '未知错误').slice(0, 220)}`,
        ).catch((err) => writeAppLog('credits', `记录上游失败调用明细失败：${err instanceof Error ? err.message : String(err)}`))
        if (providerHttpError) {
          res.setHeader('X-Agent-Error-Code', providerHttpError.code)
          res.status(providerHttpError.status).json({
            error: {
              code: providerHttpError.code,
              message: providerHttpError.message,
              type: 'provider_auth_error',
            },
          })
          return
        }
        res.send(text)
        return
      }
      const finishDeduct = async (usage, requestId = '') => {
        try {
          await deductCreditsForLocalUsage(req.clientUser.id, context, usage || {}, requestId, usage ? {} : { deductStatus: 'missing_usage' })
        } catch (err) {
          writeAppLog('credits', err instanceof Error ? err.message : String(err))
        }
      }
      if (String(contentType).includes('text/event-stream')) {
        const reader = upstream.body?.getReader()
        if (!reader) {
          res.end()
          await finishDeduct(null, upstream.headers.get('x-request-id') || '')
          await recordModelKeySuccess(context.key.id)
          return
        }
        const decoder = new TextDecoder()
        let buffer = ''
        let streamUsage = null
        let streamRequestId = upstream.headers.get('x-request-id') || ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(Buffer.from(value))
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() || ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (!data || data === '[DONE]') continue
            try {
              const event = JSON.parse(data)
              if (event.usage) streamUsage = event.usage
              if (event.id) streamRequestId = String(event.id)
            } catch {
              // Ignore non-JSON SSE frames.
            }
          }
        }
        res.end()
        await finishDeduct(streamUsage, streamRequestId)
        await recordModelKeySuccess(context.key.id)
        writeAppLog('model-proxy', JSON.stringify({
          event: 'completed',
          ...proxyLogContext,
          status: upstream.status,
          durationMs: Date.now() - proxyStartedAt,
          usageReceived: Boolean(streamUsage),
        }))
        return
      }
      const text = await upstream.text()
      let usage = null
      let requestId = upstream.headers.get('x-request-id') || ''
      try {
        const payload = JSON.parse(text)
        usage = payload?.usage || null
        requestId = String(payload?.id || requestId || '')
      } catch {
        // Keep response passthrough even if the provider returns non-JSON.
      }
      if (usage) {
        await deductCreditsForLocalUsage(req.clientUser.id, context, usage, requestId)
      } else {
        await deductCreditsForLocalUsage(req.clientUser.id, context, {}, requestId, { deductStatus: 'missing_usage' })
      }
      await recordModelKeySuccess(context.key.id)
      res.send(text)
      writeAppLog('model-proxy', JSON.stringify({
        event: 'completed',
        ...proxyLogContext,
        status: upstream.status,
        durationMs: Date.now() - proxyStartedAt,
        usageReceived: Boolean(usage),
      }))
    } catch (err) {
      const abortReason = proxyLifecycle?.abortReason || ''
      const downstreamAborted = isDownstreamAbortReason(abortReason)
      if (context?.key?.id && !downstreamAborted) await recordModelKeyFailure(context.key.id, err)
      if (context?.key?.id && !downstreamAborted) {
        await recordModelKeyUsageFailure(
          req.clientUser.id,
          context,
          proxyRequestId,
          `代理请求失败：${err instanceof Error ? err.message : String(err)}`,
        ).catch((recordErr) => writeAppLog('credits', `记录代理失败调用明细失败：${recordErr instanceof Error ? recordErr.message : String(recordErr)}`))
      }
      writeAppLog('model-proxy', JSON.stringify({
        event: 'failed',
        requestId: proxyRequestId,
        providerId: context?.provider?.id || '',
        providerName: context?.provider?.name || '',
        modelId: context?.model?.modelId || '',
        reason: abortReason || 'proxy_error',
        elapsedMs: proxyStartedAt ? Date.now() - proxyStartedAt : 0,
        error: err instanceof Error ? err.message : String(err),
      }))
      if (downstreamAborted || res.destroyed || !res.writable) return
      if (res.headersSent) {
        writeAppLog('credits', err instanceof Error ? err.message : String(err))
        res.end()
        return
      }
      const transportFailure = classifyProviderTransportError(err, abortReason)
      const billingFailure = clientBillingErrorResponse(err)
      const failure = billingFailure || transportFailure
      if (failure?.code) res.setHeader('X-Agent-Error-Code', failure.code)
      res.status(failure?.status || 400).json({
        error: { code: failure?.code || '', message: failure?.message || (err instanceof Error ? err.message : String(err)) },
      })
    } finally {
      proxyLifecycle?.cleanup()
    }
  })

  app.post('/api/client/images/generate', requireClientAuth, async (req, res) => {
    try {
      const user = await findEndUserById(req.clientUser.id)
      const context = await resolveModelProxyContext(req.body?.model || '', req.clientUser.id, 'image')
      await assertClientModelRequestAllowed(user, context.pricingRule)
      const data = await generateImageForClient(req.clientUser.id, req.body || {}, context)
      res.json({ success: true, data })
    } catch (err) {
      const billingFailure = clientBillingErrorResponse(err)
      if (billingFailure?.code) res.setHeader('X-Agent-Error-Code', billingFailure.code)
      const statusCode = billingFailure?.status || err?.statusCode || 400
      res.status(statusCode).json({
        success: false,
        code: billingFailure?.code || '',
        error: billingFailure?.message || (err instanceof Error ? err.message : String(err)),
      })
    }
  })

  app.post('/api/client/model/search', requireClientAuth, async (req, res) => {
    let context
    try {
      const user = await findEndUserById(req.clientUser.id)
      const query = String(req.body?.query || '').trim()
      if (!query) {
        res.status(400).json({ success: false, error: '请输入搜索关键词' })
        return
      }
      const resolvedContext = await resolveModelProxyContext(req.body?.model || req.body?.modelId || '', req.clientUser.id, 'search')
      await assertClientModelRequestAllowed(user, resolvedContext.pricingRule)
      context = resolvedContext
      const endpointPath = context.endpointPath || '/v1/web-search'
      const upstreamUrl = `${String(context.provider.baseUrl || '').replace(/\/$/, '')}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`
      const count = clampInt(req.body?.count ?? req.body?.maxResults, 1, 10, 5)
      const upstreamBody = {
        query,
        summary: req.body?.summary === undefined ? true : Boolean(req.body.summary),
        freshness: normalizeBochaFreshness(req.body?.freshness),
        count,
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.max(10000, Number(context.provider.timeoutMs || 30000)))
      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.key.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify(upstreamBody),
      }).finally(() => clearTimeout(timer))
      const text = await upstream.text()
      let payload = null
      try {
        payload = text ? JSON.parse(text) : null
      } catch {}
      if (!upstream.ok) {
        await recordModelKeyFailure(context.key.id, text)
        const errorReason = payload?.error?.message || payload?.message || payload?.msg || text || upstream.statusText
        await recordModelKeyUsageFailure(
          req.clientUser.id,
          context,
          upstream.headers.get('x-request-id') || payload?.log_id || '',
          `上游请求失败 (HTTP ${upstream.status}): ${String(errorReason || '未知错误').slice(0, 220)}`,
        ).catch((err) => writeAppLog('credits', `记录搜索失败调用明细失败：${err instanceof Error ? err.message : String(err)}`))
        res.status(upstream.status).json({ success: false, error: payload?.message || payload?.msg || text || upstream.statusText })
        return
      }
      const data = normalizeBochaSearchPayload(payload || {}, context, upstreamBody)
      await deductCreditsForLocalUsage(req.clientUser.id, context, {}, data.requestId, {
        deductStatus: context.pricingRule.billingType === 'per_request' ? 'succeeded' : 'missing_usage',
        note: context.pricingRule.billingType === 'per_request' ? '搜索模型调用扣费' : '搜索模型调用成功，但当前计费规则不是按次，未扣费',
      })
      await recordModelKeySuccess(context.key.id)
      res.json({ success: true, data })
    } catch (err) {
      if (context?.key?.id) await recordModelKeyFailure(context.key.id, err)
      if (context?.key?.id) {
        await recordModelKeyUsageFailure(
          req.clientUser.id,
          context,
          '',
          `搜索请求失败：${err instanceof Error ? err.message : String(err)}`,
        ).catch((recordErr) => writeAppLog('credits', `记录搜索失败调用明细失败：${recordErr instanceof Error ? recordErr.message : String(recordErr)}`))
      }
      const billingFailure = clientBillingErrorResponse(err)
      if (billingFailure?.code) res.setHeader('X-Agent-Error-Code', billingFailure.code)
      res.status(billingFailure?.status || 400).json({
        success: false,
        code: billingFailure?.code || '',
        error: billingFailure?.message || (err instanceof Error ? err.message : String(err)),
      })
    }
  })
}

export function clientScopedCreditLedgerPage(page = {}) {
  const filteredConsumed = Number(page.filteredConsumed || 0)
  return { ...page, filteredConsumed, totalConsumed: filteredConsumed }
}
