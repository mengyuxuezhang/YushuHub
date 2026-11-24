<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  costGroups,
  costCalls,
  costMembers,
  type CostMember,
  type CostCall,
  type CostGroup,
} from '@/api/vendor-cost'
import { toUserMessage } from '@/api/client'
import VendorCostCalls from '@/components/business/VendorCostCalls.vue'
import VendorCostPeriod from '@/components/business/VendorCostPeriod.vue'
import { datePreset } from '@/utils/user-usage'

const range = ref(datePreset('month'))
const dayInMs = 86400000
const source = ref(''),
  type = ref(''),
  department = ref(''),
  page = ref(1)
const pageSize = ref(20),
  pending = ref(false),
  callTotal = ref(0),
  totalPages = ref(0),
  callsBusy = ref(false),
  callsError = ref('')
function setPageSize(value: number) {
  pageSize.value = value
  page.value = 1
}
function setPending(value: boolean) {
  pending.value = value
  page.value = 1
}
const groups = ref<CostGroup[]>([]),
  calls = ref<CostCall[]>([]),
  members = ref<CostMember[]>([]),
  error = ref(''),
  busy = ref(false)
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
watch(
  [range, source, type],
  () => {
    department.value = ''
    page.value = 1
  },
  { flush: 'sync' },
)
watch(
  department,
  () => {
    page.value = 1
  },
  { flush: 'sync' },
)
const dashboard = ref<HTMLElement | null>(null)
let scrollToMembers = false
function openDepartment(key: string) {
  if (department.value === key) {
    dashboard.value?.scrollIntoView({ block: 'start' })
    return
  }
  scrollToMembers = true
  department.value = key
}
let revision = 0
function reportQuery() {
  return new URLSearchParams({ ...range.value, source: source.value, type: type.value })
}
let callRevision = 0
async function loadCalls() {
  const request = ++callRevision
  callsBusy.value = true
  callsError.value = ''
  const q = reportQuery()
  q.set('department', department.value)
  q.set('page', String(page.value))
  q.set('pageSize', String(pageSize.value))
  if (pending.value) q.set('pending', '1')
  try {
    const result = await costCalls(q)
    if (request !== callRevision) return
    calls.value = result.items
    callTotal.value = result.total
    totalPages.value = result.totalPages
    if (page.value !== result.page) page.value = result.page
  } catch (error) {
    if (request === callRevision) callsError.value = toUserMessage(error)
  } finally {
    if (request === callRevision) callsBusy.value = false
  }
}
async function loadSummary() {
  const request = ++revision
  busy.value = true
  error.value = ''
  const q = reportQuery()
  try {
    const departmentQuery = new URLSearchParams(q)
    departmentQuery.set('department', department.value)
    const [summary, breakdown] = await Promise.all([
      costGroups(q),
      department.value ? costMembers(departmentQuery) : Promise.resolve([]),
    ])
    if (request === revision) {
      groups.value = summary
      members.value = breakdown
    }
  } catch (e) {
    if (request === revision) error.value = toUserMessage(e)
  } finally {
    if (request === revision) {
      busy.value = false
      if (scrollToMembers) {
        scrollToMembers = false
        await nextTick()
        dashboard.value?.scrollIntoView({ block: 'start' })
      }
    }
  }
}
function load() {
  return Promise.all([loadSummary(), loadCalls()])
}
watch([range, source, type, department], loadSummary, { immediate: true })
watch([range, source, type, department, page, pageSize, pending], loadCalls, { immediate: true })
type Total = {
  calls: number
  known: number
  amount: number
  imageCalls: number
  images: number | null
  sales: number
  salesKnown: number
  margin: number
  marginKnown: number
  points: number
}
function sum(rows: CostGroup[]): Total {
  return rows.reduce<Total>(
    (a, g) => ({
      calls: a.calls + Number(g.calls),
      known: a.known + Number(g.known),
      amount: a.amount + Number(g.amount),
      sales: a.sales + Number(g.sales ?? 0),
      salesKnown: a.salesKnown + Number(g.salesKnown ?? 0),
      points: a.points + Number(g.points ?? 0),
      margin: a.margin + Number(g.margin ?? 0),
      marginKnown: a.marginKnown + Number(g.marginKnown ?? 0),
      imageCalls: a.imageCalls + Number(g.imageCalls),
      images: g.images == null ? a.images : (a.images ?? 0) + Number(g.images),
    }),
    {
      calls: 0,
      known: 0,
      amount: 0,
      imageCalls: 0,
      images: null,
      sales: 0,
      salesKnown: 0,
      margin: 0,
      marginKnown: 0,
      points: 0,
    },
  )
}
const visible = computed(() =>
  groups.value.filter((g) => !department.value || g.departmentKey === department.value),
)
const total = computed(() => sum(visible.value))
const rank = computed(() => {
  const buckets = new Map<string, CostGroup[]>()
  for (const g of groups.value) {
    const rows = buckets.get(g.departmentKey) ?? []
    rows.push(g)
    buckets.set(g.departmentKey, rows)
  }
  return [...buckets]
    .map(([key, rows]) => ({ key, name: rows[0].departmentName, org: rows[0].organizationName, ...sum(rows) }))
    .sort((a, b) => b.amount - a.amount)
})
const trend = computed(() => {
  const from = Date.parse(range.value.startDate),
    to = Date.parse(range.value.endDate)
  const days = (to - from) / dayInMs + 1
  const step = days > 45 ? 7 : 1
  return Array.from({ length: Math.ceil(days / step) }, (_, index) => {
    const start = from + index * step * dayInMs
    const startKey = new Date(start).toISOString().slice(0, 10)
    const endKey = new Date(Math.min(start + (step - 1) * dayInMs, to)).toISOString().slice(0, 10)
    return {
      key: startKey,
      day: startKey.slice(5),
      label: step === 1 ? startKey : startKey + ' 至 ' + endKey,
      ...sum(visible.value.filter((g) => g.day >= startKey && g.day <= endKey)),
    }
  })
})
const peak = computed(() => Math.max(...trend.value.map((d) => d.amount), 1e-12))
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
  <section ref="dashboard" class="management-page cost-page">
    <header class="page-heading">
      <div>
        <h1>成本看板</h1>
        <p>消费销售额按调用时的售价和用量计算，充值实收见支付中心。毛利仅汇总售价与成本均已核算的调用。</p>
      </div>
      <VendorCostPeriod v-model="range" />
    </header>
    <nav class="cost-filters">
      <label
        >终端
        <select v-model="source">
          <option value="">全部终端</option>
          <option v-for="(label, key) in sources" :key="key" :value="key">{{ label }}</option>
        </select></label
      >
      <label
        >调用类型
        <select v-model="type">
          <option value="">全部类型</option>
          <option v-for="(label, key) in kinds" :key="key" :value="key">{{ label }}</option>
        </select></label
      >
      <label
        >部门
        <select v-model="department">
          <option value="">全部部门</option>
          <option v-for="d in rank" :key="d.key" :value="d.key">{{ d.org }} · {{ d.name }}</option>
        </select></label
      >
    </nav>
    <p v-if="error" role="alert">{{ error }} <button @click="load">重试</button></p>
    <p v-else-if="busy" role="status">正在加载成本…</p>
    <template v-else
      ><div class="cost-stats">
        <div class="panel-card">
          <small>可核算厂商成本（元）</small
          ><strong>{{ !total.calls ? '本期暂无调用' : total.known ? money(total.amount) : '暂无法核算' }}</strong>
        </div>
        <div class="panel-card">
          <small>可核算消费销售额</small
          ><strong>{{ total.calls ? coveredMoney(total.sales, total.salesKnown) : '—' }}</strong
          ><small>{{ total.salesKnown }} / {{ total.calls }} 笔已核算</small>
        </div>
        <div class="panel-card">
          <small>消耗积分</small><strong>{{ points(total.points) }}</strong
          ><small>调用实扣</small>
        </div>
        <div class="panel-card">
          <small>可核算消费毛利</small
          ><strong :class="{ 'negative-margin': total.margin < 0 }">{{
            total.calls ? coveredMoney(total.margin, total.marginKnown) : '—'
          }}</strong
          ><small>{{ total.marginKnown }} / {{ total.calls }} 笔已核算</small>
        </div>
        <div class="panel-card">
          <small>成本覆盖率</small
          ><strong>{{ total.calls ? ((total.known / total.calls) * 100).toFixed(1) + '%' : '—' }}</strong
          ><small>{{ total.known }} / {{ total.calls }} 次调用</small>
        </div>
        <div class="panel-card">
          <small>成本待核算调用</small><strong>{{ total.calls - total.known }} 笔</strong>
        </div>
      </div>
      <div v-if="department" class="panel-card cost-section">
        <h2>{{ rank.find((d) => d.key === department)?.name }} · 成员消费明细</h2>
        <div class="data-table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>成员</th>
                <th>厂商成本</th>
                <th>消费销售额</th>
                <th>消耗积分</th>
                <th>消费毛利</th>
                <th>调用次数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="member in members" :key="member.userId">
                <td>
                  <strong>{{ member.displayName || member.username }}</strong
                  ><small v-if="member.displayName" class="cell-note">{{ member.username }}</small>
                </td>
                <td>
                  <strong>{{ coveredMoney(member.amount) }}</strong>
                  <small v-if="member.known < member.calls" class="cell-note"
                    >{{ member.known }}/{{ member.calls }} 已核算</small
                  >
                </td>
                <td>
                  {{ coveredMoney(member.sales)
                  }}<small v-if="member.salesKnown < member.calls" class="cell-note"
                    >{{ member.salesKnown }}/{{ member.calls }} 已核算</small
                  >
                </td>
                <td>{{ points(member.points) }}</td>
                <td :class="{ 'negative-margin': Number(member.margin) < 0 }">
                  {{ coveredMoney(member.margin)
                  }}<small v-if="member.marginKnown < member.calls" class="cell-note"
                    >{{ member.marginKnown }}/{{ member.calls }} 已核算</small
                  >
                </td>
                <td>{{ member.calls }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!members.length">暂无成员消费记录</p>
        </div>
      </div>
      <div v-if="total.calls" class="panel-card cost-section">
        <h2>成本趋势</h2>
        <div class="cost-bars">
          <div
            v-for="d in trend"
            :key="d.key"
            tabindex="0"
            :title="d.label + ' · ' + (d.known ? money(d.amount) : d.calls ? '待核算' : '无调用')"
          >
            <i :style="{ height: (d.amount / peak) * 85 + 1 + 'px' }"></i><small>{{ d.day }}</small>
          </div>
        </div>
      </div>
      <div class="panel-card cost-section">
        <h2>部门消费排行</h2>
        <div class="data-table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>部门</th>
                <th>厂商成本</th>
                <th>消费销售额</th>
                <th>消耗积分</th>
                <th>消费毛利</th>
                <th>调用次数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in rank" :key="d.key">
                <td>
                  <button class="text-button" @click="openDepartment(d.key)">{{ d.org }} · {{ d.name }}</button>
                </td>
                <td>
                  {{ coveredMoney(d.amount, d.known)
                  }}<small v-if="d.known < d.calls" class="cell-note">{{ d.known }}/{{ d.calls }} 已核算</small>
                </td>
                <td>
                  {{ coveredMoney(d.sales, d.salesKnown)
                  }}<small v-if="d.salesKnown < d.calls" class="cell-note"
                    >{{ d.salesKnown }}/{{ d.calls }} 已核算</small
                  >
                </td>
                <td>{{ points(d.points) }}</td>
                <td :class="{ 'negative-margin': d.margin < 0 }">
                  {{ coveredMoney(d.margin, d.marginKnown)
                  }}<small v-if="d.marginKnown < d.calls" class="cell-note"
                    >{{ d.marginKnown }}/{{ d.calls }} 已核算</small
                  >
                </td>
                <td>{{ d.calls }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <VendorCostCalls
        :calls="calls"
        :total="total"
        :page="page"
        :page-size="pageSize"
        :call-total="callTotal"
        :total-pages="totalPages"
        :pending="pending"
        :loading="callsBusy"
        :error="callsError"
        @page="page = $event"
        @size="setPageSize"
        @pending="setPending"
        @updated="load"
        @reload="loadCalls"
      />
    </template>
  </section>
</template>
<style scoped>
.cost-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  scroll-margin-top: 84px;
  gap: 16px;
}
.billing-period,
.cost-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
}
.cost-page select,
.cost-page input {
  padding: 7px;
  border: 1px solid #b6beca;
  border-radius: 6px;
  background: transparent;
  color: inherit;
}
.cost-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(152px, 1fr));
  gap: 14px;
}
.cost-stats > div,
.cost-section {
  padding: 18px;
}
.negative-margin {
  color: #b42318;
}
.cost-stats strong {
  display: block;
  font-size: clamp(19px, 2vw, 32px);
  margin: 8px 0;
}
.cost-section h2 {
  font-size: 17px;
  margin: 0 0 12px;
}
.cost-bars {
  display: flex;
  gap: 4px;
  overflow-x: auto;
}
.cost-bars > div {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  min-height: 110px;
}
.cost-bars i {
  width: 78%;
  background: #347c96;
  border-radius: 3px;
}
.cost-bars small {
  font-size: 10px;
}
@media (max-width: 700px) {
  .cost-stats {
    grid-template-columns: 1fr;
  }
  .cost-section {
    overflow: auto;
  }
}
</style>
