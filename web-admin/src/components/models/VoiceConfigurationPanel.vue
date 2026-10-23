<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Mic2, RefreshCw, ShieldAlert } from '@lucide/vue'
import * as api from '@/api/model-service'
import { toUserMessage } from '@/api/client'
import type { ModelProvider, VoiceConfiguration } from '@/types/model-service'

const props = defineProps<{ providers: ModelProvider[] }>()
const data = ref<VoiceConfiguration>({ accounts: [], models: [] })
const loading = ref(false), saving = ref(false), message = ref(''), error = ref('')
const form = reactive({ providerId: '', accountName: 'MiniMax 固定账号', region: '', key: '', confirmSameAccount: false })
const account = computed(() => data.value.accounts.find(item => item.providerId === form.providerId))

async function load() {
  loading.value = true; error.value = ''
  try {
    data.value = await api.getVoiceConfiguration()
    form.providerId ||= data.value.accounts[0]?.providerId || props.providers[0]?.id || ''
  } catch (cause) { error.value = toUserMessage(cause) }
  finally { loading.value = false }
}
async function saveAccount() {
  if (!form.providerId || !form.accountName.trim()) { error.value = '请先选择服务商并填写上游账号名称'; return }
  saving.value = true; error.value = ''; message.value = ''
  try { await api.createVoiceAccount({ providerId: form.providerId, name: form.accountName, region: form.region }); message.value = '固定上游账号已创建'; await load() }
  catch (cause) { error.value = toUserMessage(cause) } finally { saving.value = false }
}
async function saveKey() {
  if (!account.value || !form.key.trim() || !form.confirmSameAccount) { error.value = '请填写 Key，并确认固定账号风险提示'; return }
  saving.value = true; error.value = ''; message.value = ''
  try { await api.addVoiceKey(account.value.id, { key: form.key, confirmSameAccount: true }); form.key = ''; form.confirmSameAccount = false; message.value = 'Key 校验并加密保存成功'; await load() }
  catch (cause) { error.value = toUserMessage(cause) } finally { saving.value = false }
}
onMounted(load)
</script>

<template>
  <section class="voice-config panel-card">
    <header><span class="entity-avatar"><Mic2 :size="18" /></span><div><h2>MiniMax 语音服务</h2><p>私有音色固定使用同一个上游账号和一个 Key，不参与 Key 池轮询。</p></div><button class="text-button" :disabled="loading" @click="load"><RefreshCw :size="15" :class="{ spinning: loading }" />刷新</button></header>
    <div class="voice-warning"><ShieldAlert :size="18" /><span><strong>不要随意更换 Key。</strong>更换到其他 MiniMax 账号后，历史训练音色将无法访问；存在私有音色时系统会阻止删除或覆盖。</span></div>
    <div class="voice-form-grid">
      <label><span>MiniMax 服务商</span><select v-model="form.providerId"><option value="">请选择</option><option v-for="item in providers" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label><span>固定上游账号名称</span><input v-model.trim="form.accountName" :disabled="Boolean(account)" /></label>
      <label><span>区域（可选）</span><input v-model.trim="form.region" :disabled="Boolean(account)" placeholder="国内站可留空" /></label>
      <div class="voice-action"><span>{{ account ? `${account.name} · ${account.keyPreview || '尚未配置 Key'}` : '尚未创建固定账号' }}</span><button v-if="!account" class="secondary-button" :disabled="saving" @click="saveAccount">创建账号</button></div>
    </div>
    <div v-if="account && !account.keyCount" class="voice-key-row">
      <label><span>唯一 MiniMax Key</span><input v-model.trim="form.key" type="password" autocomplete="new-password" placeholder="保存后仅显示末四位" /></label>
      <label class="voice-confirm"><input v-model="form.confirmSameAccount" type="checkbox" /><span>我确认该 Key 属于长期固定的 MiniMax 账号，并已了解换号会导致私有音色不可用。</span></label>
      <button class="secondary-button" :disabled="saving" @click="saveKey">校验并保存 Key</button>
    </div>
    <div class="voice-pricing-link"><strong>模型能力和价格已分离</strong><span>在本页下方配置 MiniMax 语音协议，再前往“计费中心 → 语音与音频”维护试听、首次启用和配音价格。</span></div>
    <p v-if="message" class="voice-message success">{{ message }}</p><p v-if="error" class="voice-message error">{{ error }}</p>
  </section>
</template>

<style scoped>
.voice-config { padding: 20px; margin-bottom: 18px; display: grid; gap: 16px; }
.voice-config header { display: flex; align-items: center; gap: 12px; }.voice-config header div { flex: 1; }.voice-config h2 { margin: 0; font-size: 17px; }.voice-config p { margin: 4px 0 0; color: var(--color-text-secondary); }
.voice-warning { display: flex; gap: 10px; padding: 12px 14px; color: #7c4a08; background: #fff8e8; border: 1px solid #f2d59a; border-radius: 12px; }
.voice-form-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }.voice-form-grid.prices { grid-template-columns: repeat(3, minmax(0, 1fr)); padding-top: 14px; border-top: 1px solid var(--color-border-soft); }
.voice-form-grid label,.voice-key-row label { display: grid; gap: 6px; font-size: 12px; color: var(--color-text-secondary); }.voice-form-grid input,.voice-form-grid select,.voice-key-row input { width: 100%; }
.voice-action { display: flex; align-items: center; justify-content: space-between; gap: 10px; grid-column: 1 / -1; color: var(--color-text-secondary); }
.voice-key-row { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(300px, 2fr) auto; align-items: end; gap: 12px; }.voice-confirm { display: flex !important; flex-direction: row; align-items: center; gap: 8px !important; }.voice-confirm input { width: auto; }
.voice-pricing-link { display: grid; gap: 4px; padding-top: 14px; border-top: 1px solid var(--color-border-soft); }.voice-pricing-link span { color: var(--color-text-secondary); font-size: 13px; }
.voice-message { font-size: 13px; }.voice-message.success { color: var(--color-success); }.voice-message.error { color: var(--color-danger); }
@media (max-width: 900px) { .voice-form-grid,.voice-form-grid.prices,.voice-key-row { grid-template-columns: 1fr; } }
</style>
