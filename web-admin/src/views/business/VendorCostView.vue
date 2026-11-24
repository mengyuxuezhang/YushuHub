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

const month = ref(new Date(Date.now() + 28800000).toISOString().slice(0, 7))
const source = ref(''),
  type = ref(''),
  department = ref(''),
  page = ref(1)
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
  [month, source, type],
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
async function load() {
  const request = ++revision
  busy.value = true
  error.value = ''
  const q = new URLSearchParams({ month: month.value, source: source.value, type: type.value })
  try {
    const departmentQuery = new URLSearchParams(q)
    departmentQuery.set('department', department.value)
    const [summary, detail, breakdown] = await Promise.all([
      costGroups(q),

      costCalls(
        new URLSearchParams({ ...Object.fromEntries(q), department: department.value, page: String(page.value) }),
      ),
      department.value ? costMembers(departmentQuery) : Promise.resolve([]),
    ])
    if (request === revision) {
      groups.value = summary
      calls.value = detail
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
watch([month, source, type, department, page], load, { immediate: true })
type Total = { calls: number; known: number; amount: number; imageCalls: number; images: number | null }
function sum(rows: CostGroup[]): Total {
  return rows.reduce<Total>(
    (a, g) => ({
      calls: a.calls + Number(g.calls),
      known: a.known + Number(g.known),
      amount: a.amount + Number(g.amount),
      imageCalls: a.imageCalls + Number(g.imageCalls),
      images: g.images == null ? a.images : (a.images ?? 0) + Number(g.images),
    }),
    { calls: 0, known: 0, amount: 0, imageCalls: 0, images: null },
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
  const days = new Date(Number(month.value.slice(0, 4)), Number(month.value.slice(5)), 0).getDate()
  return Array.from({ length: days }, (_, i) => {
    const day = String(i + 1).padStart(2, '0')
    return { day, ...sum(visible.value.filter((g) => g.day === month.value + '-' + day)) }
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
</script>
<template>
  <section ref="dashboard" class="management-page cost-page">
    <header class="page-heading">
      <div>
        <h1>成本看板</h1>
        <p>按调用时的厂商报价与实际用量核算，金额以人民币展示。</p>
      </div>
      <label>账期（北京时间） <input v-model="month" type="month" required /></label>
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
          <small>当月可核算厂商成本（元）</small
          ><strong>{{ !total.calls ? '本月暂无调用' : total.known ? money(total.amount) : '暂无法核算' }}</strong>
        </div>
        <div class="panel-card">
          <small>成本覆盖率</small
          ><strong>{{ total.calls ? ((total.known / total.calls) * 100).toFixed(1) + '%' : '—' }}</strong
          ><small>{{ total.known }} / {{ total.calls }} 次调用</small>
        </div>
        <div class="panel-card">
          <small>待核算调用</small><strong>{{ total.calls - total.known }} 笔</strong>
        </div>
      </div>
      <div v-if="department" class="panel-card cost-section">
        <h2>{{ rank.find((d) => d.key === department)?.name }} · 成员成本排行</h2>
        <div class="data-table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>成员</th>
                <th>可核算成本</th>
                <th>调用次数</th>
                <th>待核算</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="member in members" :key="member.userId">
                <td>
                  <strong>{{ member.displayName || member.username }}</strong
                  ><small v-if="member.displayName" class="cell-note">{{ member.username }}</small>
                </td>
                <td>
                  <strong>{{ member.amount == null ? '待核算' : money(member.amount) }}</strong>
                </td>
                <td>{{ member.calls }}</td>
                <td>{{ member.calls - member.known }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!members.length">暂无成员消费记录</p>
        </div>
      </div>
      <div v-if="total.calls" class="panel-card cost-section">
        <h2>每日成本趋势</h2>
        <div class="cost-bars">
          <div
            v-for="d in trend"
            :key="d.day"
            tabindex="0"
            :title="d.day + '日 · ' + (d.known ? money(d.amount) : d.calls ? '待核算' : '无调用')"
          >
            <i :style="{ height: (d.amount / peak) * 85 + 1 + 'px' }"></i><small>{{ d.day }}</small>
          </div>
        </div>
      </div>
      <div class="panel-card cost-section">
        <h2>部门成本排行</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>部门</th>
              <th>可核算成本</th>
              <th>已核算 / 总调用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in rank" :key="d.key">
              <td>
                <button class="text-button" @click="openDepartment(d.key)">{{ d.org }} · {{ d.name }}</button>
              </td>
              <td>{{ d.known ? money(d.amount) : '待核算' }}</td>
              <td>{{ d.known }} / {{ d.calls }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="panel-card cost-section">
        <h2>逐笔调用</h2>
        <p v-if="total.imageCalls">
          生图 {{ total.imageCalls }} 次 · 可确认出图 {{ total.images ?? '未记录' }} 张
        </p>
        <div class="data-table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>发生时间（北京时间）</th>
                <th>用户 / 部门</th>
                <th>终端</th>
                <th>调用类型</th>
                <th>厂商成本</th>
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
                <td>{{ c.amount == null ? '待核算' : money(c.amount) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <nav v-if="total.calls > 20" class="cost-filters">
          <button :disabled="page === 1" @click="page--">上一页</button>{{ page }} /
          {{ Math.ceil(total.calls / 20)
          }}<button :disabled="page * 20 >= total.calls" @click="page++">下一页</button>
        </nav>
      </div></template
    >
  </section>
</template>
<style scoped>
.cost-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  scroll-margin-top: 84px;
  gap: 16px;
}
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
  grid-template-columns: 2fr 1fr 1fr;
  gap: 14px;
}
.cost-stats > div,
.cost-section {
  padding: 18px;
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
