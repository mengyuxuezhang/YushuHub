import assert from 'node:assert/strict'
import { agentCommerceRuntime } from '../src/services/licensing/commerce-runtime.mjs'

// Called only by the disposable resource acceptance harness. The real adapter
// and SQL wallet run; the fetch boundary is an in-memory fictional supplier.
export async function verifyLegacyStageRuntime({ pool, keyFile, proposal, rootId, organizationId, ownerId, api, createUser }) {
  const [[database]] = await pool.query('SELECT DATABASE() AS name')
  assert.match(database.name, /^yushu_resources_local_[a-f0-9]+$/)
  const root = { id: rootId, level: 1, modelMode: 'custom', version: 1, localOrganizationId: organizationId, billingOwnerUserId: ownerId }
  let supplierCalls = 0, runtime
  function start() {
    return agentCommerceRuntime({ database: () => pool, client: { claims: async () => root, recoveryIdentity: async () => root },
      benefits: async () => ({ discount: '0.8', fixture: 'installed-migration-benefit' }),
      env: { AI_MODEL_CREDENTIAL_KEY_PATH: keyFile, AI_AGENT_CUSTOM_MODELS_FILE: '', AI_SUPPLY_PRIVATE_VOICE_ENABLED: '0' },
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://legacy-provider.example/v1/chat/completions')
        assert.equal(options.headers.Authorization, 'Bearer fictional-stage-key')
        const body = JSON.parse(options.body)
        assert.equal(body.model, 'legacy-model-client'); assert.equal(body.max_tokens, 1)
        supplierCalls++
        return new Response(JSON.stringify({ choices: [{ message: { content: 'fictional staged result' } }],
          usage: { prompt_tokens: 17, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 3 } } }))
      } })
  }
  const input = { requestId: 'installed-stage-call', modelId: 'legacy-model', request: { messages: [{ role: 'user', content: 'fixture' }], max_tokens: 1 } }
  try {
    await createUser('stage-runtime-user', ownerId, organizationId)
    await pool.query("UPDATE ai_end_users SET credit_balance=10 WHERE id='stage-runtime-user'")
    runtime = start()
    await assert.rejects((await runtime.service()).submit(root, 'stage-runtime-user', input), { code: 'MODEL_UNAVAILABLE' })
    assert.equal(supplierCalls, 0)
    await api('/api/model-providers/legacy-provider/keys', { apiKey: 'fictional-stage-key', providerModelId: 'legacy-model' }, 'POST')
    const definitionInput = { providerModelId: 'legacy-model', clientId: 'legacy-model-client', status: 'enabled', currency: 'CNY',
      adapter: 'openai.chat', contextWindow: 100, maxOutputTokens: 20, costComponents: proposal.supplierCost.components, memo: proposal.costReview, expectedRevision: 1 }
    assert.equal((await api('/api/supply/custom-models', definitionInput, 'PUT')).revision, 2)
    await assert.rejects((await runtime.service()).submit(root, 'stage-runtime-user', input), { code: 'MODEL_NOT_OFFERED' })
    assert.equal(supplierCalls, 0)
    const offerInput = { modelId: 'legacy-model', enabled: true, expectedVersion: 1, pointsPerCny: proposal.pointsPerCny,
      consumptionMultiplier: proposal.consumptionMultiplier, saleMarkup: proposal.saleMarkup, supplyMarkup: proposal.saleMarkup }
    assert.equal((await api('/api/supply/offers', offerInput, 'POST')).version, 2)
    const result = await (await runtime.service()).submit(root, 'stage-runtime-user', input)
    assert.equal(result.state, 'settled'); assert.equal(result.points, '0.000152'); assert.equal(result.upstreamAmount, '0.100004')
    assert.equal(result.snapshot.model.providerModelId, 'legacy-model'); assert.equal(result.snapshot.model.version, 2)
    assert.equal(result.snapshot.offerVersion, 2); assert.equal(result.snapshot.discount, '0.800000')
    assert.equal(result.snapshot.authorization.grantId, rootId)
    assert.equal((await (await runtime.service()).submit(root, 'stage-runtime-user', input)).points, result.points)
    runtime.stop(); runtime = start()
    assert.equal((await (await runtime.service()).recover(root, 'stage-runtime-user', input.requestId)).points, result.points)
    assert.equal(supplierCalls, 1)
    const [[user]] = await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='stage-runtime-user'")
    assert.equal(String(user.credit_balance), '9.999848')
    const [[hold]] = await pool.query("SELECT released FROM accounting_holds WHERE book='commerce-v2' AND request_id=?", [input.requestId])
    assert.equal(Number(hold.released), 1)
    const [[ledger]] = await pool.query('SELECT COUNT(*) AS n FROM ai_credit_ledger WHERE user_id=? AND request_id=?', ['stage-runtime-user', input.requestId])
    assert.equal(Number(ledger.n), 2)
    await api('/api/supply/offers', { ...offerInput, enabled: false, expectedVersion: 2 }, 'POST')
    await api('/api/supply/custom-models', { ...definitionInput, status: 'disabled', expectedRevision: 2 }, 'PUT')
    return { installedRuntimeSettlement: true, disabledGatesEnforced: true, restartNoDuplicateCharge: true, mockedSupplierCalls: supplierCalls, paidSupplierCalls: 0 }
  } finally { runtime?.stop() }
}
