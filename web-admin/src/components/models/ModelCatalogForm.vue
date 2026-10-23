<script setup lang="ts">
defineProps<{ form: Record<string, any>; providers: Array<{ id: string; name: string }> }>()
const capabilities = [
  { key: 'text', label: '文本', hint: '纯文本对话生成' }, { key: 'vision', label: '识图', hint: '支持图片输入与理解' },
  { key: 'tool_calls', label: '工具', hint: '支持函数调用/工具调用' }, { key: 'reasoning', label: '推理', hint: '支持深度思考与推理过程' },
  { key: 'image_generation', label: '图片生成', hint: '用于文生图模型' }, { key: 'search', label: '搜索', hint: '联网搜索或搜索类模型' },
]
const efforts = [{ key: 'none', label: '关闭' }, { key: 'minimal', label: '极轻' }, { key: 'low', label: '轻' }, { key: 'medium', label: '中' }, { key: 'high', label: '高' }, { key: 'xhigh', label: '极高' }]
function toggleCapability(form: Record<string, any>, key: string, checked: boolean) {
  const values = Array.isArray(form.capabilities) ? [...form.capabilities] : []
  form.capabilities = checked ? [...new Set([...values, key])] : values.filter((item) => item !== key)
}
function toggleEffort(form: Record<string, any>, key: string, checked: boolean) {
  const values = Array.isArray(form.reasoning?.efforts) ? [...form.reasoning.efforts] : []
  form.reasoning.efforts = checked ? [...new Set([...values, key])] : values.filter((item) => item !== key)
  if (!form.reasoning.efforts.includes(form.reasoning.defaultEffort)) form.reasoning.defaultEffort = form.reasoning.efforts[0] || ''
}
</script>

<template>
  <label><span>所属服务商</span><select v-model="form.providerId"><option v-for="item in providers" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
  <div class="form-grid-v2"><label><span>上游模型 ID</span><input v-model.trim="form.modelId" placeholder="gpt-5" /></label><label><span>展示名称</span><input v-model.trim="form.displayName" /></label></div>
  <label><span>模型类型</span><select v-model="form.modelType"><option value="text">文本</option><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option><option value="search">搜索</option></select><small>系统会根据模型类型自动配置调用任务、协议和端点，无需手工填写技术参数。</small></label>
  <div class="form-grid-v2"><label><span>上下文窗口</span><input v-model.number="form.contextWindow" type="number" min="0" /></label><label><span>排序</span><input v-model.number="form.sortOrder" type="number" /></label></div>
  <div class="capabilities-editor"><span class="field-label">模型能力<small>客户端选择模型时会据此展示能力标签</small></span><div class="capability-checkboxes"><label v-for="opt in capabilities" :key="opt.key" class="capability-check"><input type="checkbox" :checked="form.capabilities?.includes(opt.key)" @change="(e) => toggleCapability(form, opt.key, (e.target as HTMLInputElement).checked)" /><span><strong>{{ opt.label }}</strong><small>{{ opt.hint }}</small></span></label></div></div>
  <div class="reasoning-editor"><label class="switch-row"><span><strong>支持思考强度</strong><small>客户端只展示实际支持的选项</small></span><input v-model="form.reasoning.enabled" type="checkbox" /></label><template v-if="form.reasoning.enabled"><div class="form-grid-v2"><label><span>上游适配方式</span><select v-model="form.reasoning.adapter"><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="openrouter">OpenRouter</option></select></label><label><span>默认强度</span><select v-model="form.reasoning.defaultEffort"><option v-for="opt in efforts.filter((item) => form.reasoning.efforts.includes(item.key))" :key="opt.key" :value="opt.key">{{ opt.label }}</option></select></label></div><span class="field-label">可选强度</span><div class="effort-options"><label v-for="opt in efforts" :key="opt.key"><input type="checkbox" :checked="form.reasoning.efforts.includes(opt.key)" @change="(e) => toggleEffort(form, opt.key, (e.target as HTMLInputElement).checked)" />{{ opt.label }}</label></div></template></div>
  <label><span>说明</span><textarea v-model.trim="form.description" rows="3" /></label>
  <label class="switch-row"><span><strong>设为服务商默认模型</strong><small>用于未指定模型时的默认路由</small></span><input v-model="form.isDefault" type="checkbox" /></label>
</template>

<style scoped>
.capabilities-editor { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
.field-label { font-size: 13px; font-weight: 600; color: var(--color-text-secondary); display: flex; flex-direction: column; gap: 2px; }
.field-label small { font-weight: 400; color: var(--color-text-tertiary); }
.capability-checkboxes { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px 14px; }
.capability-check { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid var(--color-border-soft); border-radius: 8px; background: var(--color-surface-2); cursor: pointer; }
.capability-check input { margin-top: 3px; }.capability-check span { display: flex; flex-direction: column; gap: 2px; }.capability-check strong { font-size: 13px; }.capability-check small { font-size: 11px; color: var(--color-text-tertiary); }
.reasoning-editor { display: grid; gap: 10px; margin: 10px 0; padding: 12px; border: 1px solid var(--color-border-soft); border-radius: 10px; background: var(--color-surface-2); }
.effort-options { display: flex; flex-wrap: wrap; gap: 8px; }.effort-options label { display: inline-flex; align-items: center; gap: 5px; padding: 6px 9px; border: 1px solid var(--color-border-soft); border-radius: 7px; background: var(--color-surface-1); font-size: 12px; }
</style>
