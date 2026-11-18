<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { listModelCapabilities } from '@/api/pricing-center'
import type { ModelCapability } from '@/types/pricing-center'

const props = defineProps<{ modelId?: string }>()
const emit = defineEmits<{ change: [value: any]; loading: [value: boolean] }>()
const capability = ref<ModelCapability>(), busy = ref(false), message = ref('')
const form = reactive<any>({})
function preset(name: string) {
  Object.assign(form, { version: 1, template: name, adapter: name === 'seedream' ? 'seedream' : 'openai', quality: '', usage: 'none', editEndpointPath: '', tokenBudget: { input: 32768, output: 32768 }, maxReferences: name === 'seedream' ? 10 : 0,
    defaultSize: name === 'seedream' ? '2K' : '1024x1024', specs: name === 'seedream'
      ? ['1K', '1.5K', '2K'].map(size => ({ size, resolution: size, aspectRatio: 'auto' }))
      : [{ size: '1024x1024', resolution: '1K', aspectRatio: '1:1' }, { size: '1536x1024', resolution: '1.5K', aspectRatio: '3:2' }, { size: '1024x1536', resolution: '1.5K', aspectRatio: '2:3' }] })
}
let revision = 0
watch(() => props.modelId, async id => {
  const current = ++revision; capability.value = undefined; busy.value = false; emit('loading', false); message.value = ''; preset('openai')
  if (!id) { emit('change', JSON.parse(JSON.stringify(form))); return }
  busy.value = true; emit('loading', true)
  try {
    const items = await listModelCapabilities()
    if (current !== revision) return
    capability.value = items.find(item => item.providerModelId === id && item.taskType === 'image_generation')
    if (capability.value?.config?.image) Object.assign(form, JSON.parse(JSON.stringify(capability.value.config.image)))
    emit('change', JSON.parse(JSON.stringify(form)))
  } catch (error) { if (current === revision) message.value = String(error) }
  finally { if (current === revision) { busy.value = false; emit('loading', false) } }
}, { immediate: true })
watch(form, () => { if (!busy.value && (!props.modelId || capability.value)) emit('change', JSON.parse(JSON.stringify(form))) }, { deep: true })
</script>

<template>
  <section class="image-spec-editor">
    <h3>图片生成规格</h3>
    <p>客户端自动适配，用户无需选择技术尺寸。请按当前服务商实际支持的规格配置。</p>
    <p>与模型配置一并保存；分辨率档位变化后，请同步检查图片计费方案。</p>
    <fieldset :disabled="busy || Boolean(modelId && !capability)">
      <label><span>快速模板</span><select :value="form.template" :disabled="busy" @change="preset(($event.target as HTMLSelectElement).value)"><option value="openai">OpenAI 兼容像素尺寸</option><option value="seedream">Seedream 档位与参考图</option><option value="custom" disabled>已自定义规格</option></select><small>模板只是起点，选择后仍需核对服务商支持范围并保存。</small></label>
      <div v-for="(spec,index) in form.specs" :key="index" class="spec-row">
        <label><span>接口尺寸</span><input v-model.trim="spec.size" placeholder="1024x1024 或 2K" maxlength="32" /></label>
        <label><span>计费档位</span><input v-model.trim="spec.resolution" placeholder="1K、2K、4K" maxlength="32" /></label>
        <label><span>画面比例</span><input v-model.trim="spec.aspectRatio" placeholder="1:1 或 auto" /></label>
        <button class="text-button danger" :disabled="form.specs.length <= 1" @click.prevent="form.specs.splice(index,1);form.template='custom'">移除</button>
      </div>
      <button class="secondary-button" @click.prevent="form.specs.push({size:'',resolution:'',aspectRatio:'auto'});form.template='custom'">添加规格</button>
      <label><span>默认规格</span><select v-model="form.defaultSize"><option v-for="spec in form.specs" :key="spec.size" :value="spec.size">{{ spec.size }} · {{ spec.aspectRatio }}</option></select></label>
      <details><summary>高级设置：协议、质量、参考图和 Token</summary>
        <div v-for="(spec,index) in form.specs" :key="index" class="spec-row"><label><span>{{ spec.size }} 返回最少像素（可选）</span><input v-model.number="spec.minPixels" type="number" min="1" max="67108864" /></label><label><span>返回最多像素（可选）</span><input v-model.number="spec.maxPixels" type="number" min="1" max="67108864" /></label></div>
        <small>档位接口可能返回实际像素值，模板会设置对应范围；自定义档位需按供应商文档填写，超出范围保留待核对。</small>
        <label><span>参数协议</span><select v-model="form.adapter"><option value="openai">OpenAI 兼容图片</option><option value="seedream">Seedream 图片参数</option></select></label>
        <label><span>固定默认质量</span><select v-model="form.quality"><option value="">不传，由上游默认</option><option v-for="item in ['auto','low','medium','high','standard','hd']" :key="item" :value="item">{{ item }}</option></select></label>
        <label><span>最多参考图</span><input v-model.number="form.maxReferences" type="number" min="0" max="10" /><small>0 表示只支持文生图。请按服务商实际支持填写。</small></label>
        <label v-if="form.adapter === 'openai' && form.maxReferences > 0"><span>图片编辑端点</span><input v-model.trim="form.editEndpointPath" placeholder="/images/edits" maxlength="200" /><small>相对于服务商基址。留空使用 /images/edits。有参考图时才调用此端点。</small></label>
        <label><span>Token 用量</span><select v-model="form.usage"><option value="none">未确认可靠用量，仅按次或分辨率计费</option><option value="openai">已确认返回 OpenAI 图片 usage</option></select></label>
        <template v-if="form.usage==='openai'"><label><span>每类输入 Token 预占上限</span><input v-model.number="form.tokenBudget.input" type="number" min="1" max="1000000" /></label><label><span>输出 Token 预占上限</span><input v-model.number="form.tokenBudget.output" type="number" min="1" max="1000000" /></label><small>按上限预占积分，成功后按实际用量退差额；用量缺失或费用超过预占时保留任务待核对，不自动重复生成。</small></template>
      </details>
    </fieldset>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.image-spec-editor{display:grid;gap:12px;border:1px solid var(--color-border-soft);padding:16px;border-radius:12px}.image-spec-editor fieldset{display:grid;gap:12px;min-width:0;margin:0;padding:0;border:0}.image-spec-editor label{display:flex;flex-direction:column;gap:6px;min-width:0}.image-spec-editor label>span{font-size:12px}.image-spec-editor select,.image-spec-editor input{width:100%;min-width:0;min-height:38px;box-sizing:border-box}.image-spec-editor h3,.image-spec-editor p{margin:0}.image-spec-editor p,.image-spec-editor small{font-size:12px;color:var(--color-text-secondary)}.spec-row{display:grid;grid-template-columns:1.2fr 1fr 1fr auto;gap:8px;align-items:end}.spec-row input{width:100%;min-width:0;box-sizing:border-box}.image-spec-editor details{display:grid;padding:8px 0}.image-spec-editor details label{margin-top:10px}@media(max-width:650px){.spec-row{grid-template-columns:1fr 1fr}}
</style>
