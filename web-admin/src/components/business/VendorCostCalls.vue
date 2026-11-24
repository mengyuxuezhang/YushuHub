<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useAuthStore } from '@/stores/auth'
import DataPagination from '@/components/common/DataPagination.vue'
import { reconcileCostCall, type CostCall } from '@/api/vendor-cost'
import { toUserMessage } from '@/api/client'
const props = defineProps<{
  calls: CostCall[]
  page: number
  pageSize: number
  callTotal: number
  totalPages: number
  pending: boolean
  loading: boolean
  error: string
  total: { imageCalls: number; images: number | null }
}>()
const emit = defineEmits<{ page: [number]; size: [number]; pending: [boolean]; updated: []; reload: [] }>()
const auth = useAuthStore()
const canReconcile = computed(() => auth.can('credits.manage'))
const selected = ref<CostCall | null>(null),
  cost = ref(''),
  sales = ref(''),
  evidence = ref(''),
  formError = ref(''),
  saving = ref(false)
const form = ref<HTMLFormElement | null>(null)
async function open(call: CostCall) {
  selected.value = call
  cost.value = ''
  sales.value = ''
  evidence.value = ''
  formError.value = ''
  await nextTick()
  form.value?.scrollIntoView({ block: 'center' })
}
watch(
  () => props.calls,
  () => {
    selected.value = null
  },
)
async function save() {
  if (!selected.value || saving.value) return
  saving.value = true
  formError.value = ''
  try {
    await reconcileCostCall(selected.value.id, {
      cost: cost.value || undefined,
      sales: sales.value || undefined,
      evidence: evidence.value,
    })
    selected.value = null
    emit('updated')
  } catch (error) {
    formError.value = toUserMessage(error)
  } finally {
    saving.value = false
  }
}
const sources: Record<string, string> = { desktop: '电脑端', android: '安卓端', admin: '后台', unknown: '未知' }
const kinds: Record<string, string> = {
  text: '文本',
  image: '生图',
  audio: '音频',
  search: '搜索',
  vector: '向量',
  video: '视频',
  other: '其他',
}
const money = (n: number | string) =>
  Number(n).toLocaleString('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
    maximumFractionDigits: 12,
  })
const points = (n: number | string) => Number(n ?? 0).toLocaleString('zh-CN', { maximumFractionDigits: 6 })
const coveredMoney = (value: number | string | null, known?: number) =>
  value == null || known === 0 ? '待核算' : money(value)
</script>
<template>
  <div class="panel-card cost-section">
    <h2>逐笔调用</h2>
    <label
      ><input
        type="checkbox"
        :checked="pending"
        @change="emit('pending', ($event.target as HTMLInputElement).checked)"
      />
      只看待核算</label
    >
    <p v-if="loading" role="status">正在查询调用…</p>
    <p v-else-if="error" role="alert">
      {{ error }} <button class="text-button" @click="emit('reload')">重试</button>
    </p>
    <p v-else-if="!calls.length">没有符合条件的调用</p>
    <form v-if="selected" ref="form" class="reconcile-form" @submit.prevent="save">
      <h3>补录调用金额</h3>
      <div>{{ selected.displayName || selected.username }} · {{ selected.requestId || selected.id }}</div>
      <label v-if="selected.amount == null"
        >厂商成本（元） <input v-model.trim="cost" inputmode="decimal" placeholder="按厂商账单填写"
      /></label>
      <label v-if="selected.sales == null"
        >消费销售额（元） <input v-model.trim="sales" inputmode="decimal" placeholder="按历史售价填写"
      /></label>
      <label
        >核算依据 <input v-model.trim="evidence" maxlength="500" required placeholder="账单号或历史报价与用量依据"
      /></label>
      <p v-if="formError" role="alert">{{ formError }}</p>
      <div>
        <button class="primary-button" :disabled="saving || !(cost || sales)">保存补录</button>
        <button type="button" class="text-button" :disabled="saving" @click="selected = null">取消</button>
      </div>
    </form>
    <p v-if="total.imageCalls">生图 {{ total.imageCalls }} 次 · 可确认出图 {{ total.images ?? '未记录' }} 张</p>
    <div v-if="calls.length && !error" class="data-table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>发生时间（北京时间）</th>
            <th>用户 / 部门</th>
            <th>终端</th>
            <th>调用类型</th>
            <th>厂商成本</th>
            <th>消费销售额</th>
            <th>消耗积分</th>
            <th>消费毛利</th>
            <th v-if="canReconcile">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in calls" :key="c.id">
            <td>
              {{ c.usedAt }}<small class="cell-note">{{ c.requestId || c.id }}</small>
            </td>
            <td>{{ c.displayName || c.username }} · {{ c.departmentName }}</td>
            <td>{{ sources[c.source] || '未知' }}</td>
            <td>{{ kinds[c.kind] }} {{ c.kind === 'image' && c.images != null ? c.images + ' 张' : '' }}</td>
            <td>
              {{ coveredMoney(c.amount)
              }}<small v-if="c.costEvidence" class="cell-note" :title="c.costEvidence">已补录</small>
            </td>
            <td>
              {{ coveredMoney(c.sales)
              }}<small v-if="c.salesEvidence" class="cell-note" :title="c.salesEvidence">已补录</small>
            </td>
            <td>{{ points(c.points) }}</td>
            <td :class="{ 'negative-margin': Number(c.margin) < 0 }">{{ coveredMoney(c.margin) }}</td>
            <td v-if="canReconcile">
              <button
                v-if="c.amount == null || c.sales == null"
                type="button"
                class="text-button"
                @click="open(c)"
              >
                补录
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <DataPagination
      :page="page"
      :page-size="pageSize"
      :total="callTotal"
      :total-pages="totalPages"
      :loading="loading || saving"
      allow-jump
      @update:page="emit('page', $event)"
      @update:page-size="emit('size', $event)"
    />
  </div>
</template>
<style scoped>
.cost-section {
  padding: 18px;
  min-width: 0;
}
.cost-section h2 {
  font-size: 17px;
  margin: 0 0 12px;
}
.negative-margin {
  color: #b42318;
}
.reconcile-form {
  display: grid;
  gap: 10px;
  margin: 12px 0;
  padding: 16px;
  border: 1px solid #b6beca;
  border-radius: 8px;
}
.reconcile-form label {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.reconcile-form input {
  width: min(100%, 360px);
  padding: 8px;
  border: 1px solid #b6beca;
  border-radius: 6px;
  background: transparent;
  color: inherit;
}
</style>
