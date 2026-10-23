<script setup lang="ts">
import { Check, X } from '@lucide/vue'
import MarketAssetField from './MarketAssetField.vue'
import type { CuratedAgent, CuratedAgentInput, DeliveryPolicy, MarketDependencyOption } from '@/types/markets'

defineProps<{
  open: boolean
  editingId: string
  saving: boolean
  errorMessage: string
  form: CuratedAgentInput
  distributionForm: { enabled: boolean; deliveryPolicy: DeliveryPolicy; audienceType: 'all' | 'membership_cards'; membershipCardIds: string[] }
  currentAgent: CuratedAgent | null
  skills: MarketDependencyOption[]
  mcps: MarketDependencyOption[]
  canDistribute: boolean
}>()

defineEmits<{
  close: []
  save: []
  saveDistribution: []
  setStatus: [status: 'published' | 'disabled']
}>()
</script>

<template>
  <div v-if="open" class="drawer-backdrop-v2">
    <aside class="form-drawer-v2" role="dialog" aria-modal="true" aria-labelledby="agent-drawer-title">
      <header class="drawer-header"><div><span class="eyebrow">{{ editingId ? 'Edit agent' : 'Create agent' }}</span><h2 id="agent-drawer-title">{{ editingId ? '编辑专家' : '新建专家' }}</h2></div><button type="button" class="icon-button" aria-label="关闭" :disabled="saving" @click="$emit('close')"><X :size="18" /></button></header>
      <div class="drawer-body">
        <section v-if="editingId && currentAgent" class="form-section"><div class="section-heading"><span>6</span><div><h3>发布状态</h3><p>停用后总后台目录和下游市场将不再提供此专家。</p></div></div><label><span>状态</span><select :value="currentAgent.status" :disabled="saving" @change="$emit('setStatus', ($event.target as HTMLSelectElement).value as 'published' | 'disabled')"><option value="published">已发布</option><option value="disabled">已停用</option></select></label></section>
        <section class="form-section"><div class="section-heading"><span>1</span><div><h3>基本信息</h3><p>用于市场展示和版本识别。</p></div></div>
          <div class="form-grid-v2"><label><span>专家 ID</span><input v-model.trim="form.id" :disabled="Boolean(editingId)" placeholder="例如 data-analyst" /></label><label><span>版本号</span><input v-model.trim="form.version" placeholder="1.0.0" /></label></div>
          <label><span>名称</span><input v-model.trim="form.name" placeholder="请输入专家名称" /></label>
          <label><span>用途说明</span><textarea v-model.trim="form.description" rows="3" placeholder="说明这个专家能解决什么问题" /></label>
          <MarketAssetField v-model="form.iconUrl" label="专家图标（可选）" />
        </section>
        <section class="form-section"><div class="section-heading"><span>2</span><div><h3>市场展示</h3><p>配置专家卡片、详情页和客户端快捷提问。</p></div></div>
          <div class="form-grid-v2"><label><span>发布者</span><input v-model.trim="form.publisherName" maxlength="120" placeholder="例如 小台" /></label><label><span>使用量文案（可选）</span><input v-model.trim="form.usageLabel" maxlength="80" placeholder="例如 201.9 万次使用" /></label></div>
          <label><span>身份标签（最多 4 个）</span><div class="repeatable-fields"><div v-for="(_item, index) in form.profileLabels" :key="`profile-${index}`" class="repeatable-field"><input v-model.trim="form.profileLabels[index]" maxlength="40" placeholder="例如 专家" /><button type="button" class="icon-button" aria-label="删除身份标签" @click="form.profileLabels.splice(index, 1)"><X :size="15" /></button></div><button v-if="form.profileLabels.length < 4" type="button" class="secondary-button" @click="form.profileLabels.push('')">添加身份标签</button></div></label>
          <label><span>擅长领域（最多 8 个）</span><div class="repeatable-fields"><div v-for="(_item, index) in form.expertiseTags" :key="`expertise-${index}`" class="repeatable-field"><input v-model.trim="form.expertiseTags[index]" maxlength="40" placeholder="例如 响应式网页" /><button type="button" class="icon-button" aria-label="删除擅长领域" @click="form.expertiseTags.splice(index, 1)"><X :size="15" /></button></div><button v-if="form.expertiseTags.length < 8" type="button" class="secondary-button" @click="form.expertiseTags.push('')">添加擅长领域</button></div></label>
          <label><span>试试这样问我（最多 6 条）</span><div class="repeatable-fields"><div v-for="(_item, index) in form.starterPrompts" :key="`starter-${index}`" class="repeatable-field"><textarea v-model.trim="form.starterPrompts[index]" maxlength="500" rows="2" placeholder="输入用户可以直接采用的示例问题" /><button type="button" class="icon-button" aria-label="删除示例问题" @click="form.starterPrompts.splice(index, 1)"><X :size="15" /></button></div><button v-if="form.starterPrompts.length < 6" type="button" class="secondary-button" @click="form.starterPrompts.push('')">添加示例问题</button></div></label>
        </section>
        <section class="form-section"><div class="section-heading"><span>3</span><div><h3>行为指令</h3><p>定义专家的角色、工作方式和输出要求。</p></div></div>
          <label><span>行为指令</span><textarea v-model.trim="form.prompt" rows="8" placeholder="输入专家的系统指令、边界和输出要求" /></label>
        </section>
        <section class="form-section"><div class="section-heading"><span>4</span><div><h3>能力依赖</h3><p>选择运行该专家必须获得授权的技能和 MCP。</p></div></div>
          <div class="dependency-columns"><div><h4>技能（{{ form.skillIds.length }}）</h4><div class="choice-list"><label v-for="skill in skills" :key="skill.id" class="choice-item"><input v-model="form.skillIds" type="checkbox" :value="skill.id" /><span><strong>{{ skill.name }}</strong><small>{{ skill.id }}</small></span><Check :size="15" /></label><p v-if="!skills.length" class="muted-empty">暂无已发布技能</p></div></div><div><h4>MCP（{{ form.mcpIds.length }}）</h4><div class="choice-list"><label v-for="mcp in mcps" :key="mcp.id" class="choice-item"><input v-model="form.mcpIds" type="checkbox" :value="mcp.id" /><span><strong>{{ mcp.name }}</strong><small>{{ mcp.id }}</small></span><Check :size="15" /></label><p v-if="!mcps.length" class="muted-empty">暂无已发布 MCP</p></div></div></div>
        </section>
        <section class="form-section"><div class="section-heading"><span>5</span><div><h3>市场投放</h3><p>专家发布后统一进入个人专家市场。</p></div></div><div class="market-choice-grid"><div class="selected"><strong>个人专家市场</strong><span>面向当前组织的终端用户</span><Check :size="17" /></div></div></section>
        <section v-if="editingId && currentAgent?.status === 'published' && canDistribute" class="form-section"><div class="section-heading"><span>6</span><div><h3>当前组织分发</h3><p>依赖必须先按相同用户范围完成分发。</p></div></div><label class="switch-row"><span><strong>向当前组织用户上架</strong><small>关闭后用户市场中将不再显示</small></span><input v-model="distributionForm.enabled" type="checkbox" /></label><label><span>交付策略</span><select v-model="distributionForm.deliveryPolicy"><option value="market">市场展示</option><option value="recommended">推荐更新</option><option value="auto_install">自动安装</option></select></label><button type="button" class="secondary-button" :disabled="saving" @click="$emit('saveDistribution')">保存分发设置</button></section>
        <p v-if="errorMessage" class="drawer-error" role="alert">{{ errorMessage }}</p>
      </div>
      <footer class="drawer-footer"><button type="button" class="secondary-button" :disabled="saving" @click="$emit('close')">取消</button><button v-if="!editingId || currentAgent?.editable" type="button" class="primary-button" :disabled="saving" @click="$emit('save')">{{ saving ? '正在保存…' : editingId ? '保存专家' : '创建专家' }}</button></footer>
    </aside>
  </div>
</template>
