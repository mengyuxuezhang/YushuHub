<script setup lang="ts">
import { computed, watch } from 'vue'
import type { ModelProvider, ProviderModel } from '@/types/model-service'

const props = defineProps<{ form: Record<string, any>; providers: ModelProvider[]; models?: ProviderModel[] }>()
const providerModels = computed(() => (props.models || []).filter(item => item.providerId === props.form.providerId))
const missingModel = computed(() => Boolean(props.form.providerModelId && !providerModels.value.some(item => item.id === props.form.providerModelId)))
watch(() => props.form.providerId, (value, previous) => { if (previous && value !== previous && !props.form.id) props.form.providerModelId = '' })
const selectedProvider = computed(() => props.providers.find((item) => item.id === props.form.providerId))
const singleVoiceKey = computed(() => selectedProvider.value?.keyMode === 'single_voice')
</script>

<template>
  <label><span>所属服务商</span><select v-model="form.providerId" :disabled="Boolean(form.id)"><option v-for="item in providers" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
  <div v-if="singleVoiceKey" class="managed-key-notice"><strong>MiniMax 语音固定使用一个 Key</strong><span>系统会自动绑定音色资源账号。请勿随意更换 Key，否则上游已训练音色可能无法继续使用。</span></div>
  <label><span>适用模型</span><select v-model="form.providerModelId" aria-label="适用模型"><option value="">所有模型通用</option><option v-for="item in providerModels" :key="item.id" :value="item.id">{{ item.displayName }} · {{ item.modelId }}</option><option v-if="missingModel" :value="form.providerModelId">{{ form.modelName || form.modelId || '原绑定模型' }}（已删除或当前不可见）</option></select><small>默认适用于当前服务商下所有模型；指定后，此 Key 仅用于所选模型。</small></label>
  <label><span>API Key</span><input v-model.trim="form.key" type="password" :placeholder="form.id ? '留空保持原 Key 不变' : '输入新的 API Key'" autocomplete="new-password" /><small v-if="singleVoiceKey">保存时会校验 Key 是否能正常访问 MiniMax 语音服务。</small></label>
  <div class="form-grid-v2"><label v-if="!singleVoiceKey"><span>轮询权重</span><input v-model.number="form.weight" type="number" min="1" max="1000" /></label><label><span>状态</span><select v-model="form.status"><option value="enabled">启用</option><option value="disabled">停用</option></select></label></div>
  <label v-if="singleVoiceKey && form.id && form.key" class="risk-confirm"><input v-model="form.confirmKeyReplacement" type="checkbox" /><span>我确认更换 Key，并了解已有私有音色可能失效</span></label>
  <label><span>备注</span><textarea v-model.trim="form.notes" rows="3" /></label>
</template>

<style scoped>
.managed-key-notice { display: grid; gap: 4px; padding: 12px 14px; border: 1px solid #f2d28a; border-radius: 10px; background: #fff9e9; color: #72510a; }
.managed-key-notice strong { font-size: 13px; }
.managed-key-notice span { font-size: 12px; line-height: 1.55; }
.risk-confirm { display: flex; flex-direction: row; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 8px; background: var(--color-surface-2); }
.risk-confirm input { width: auto; }
</style>
