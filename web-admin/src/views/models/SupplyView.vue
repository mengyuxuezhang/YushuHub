<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { creditChild, saveOffer, supplyBalance, supplyCatalog } from '@/api/supply'
import type { SupplyBalance, SupplyComponent, SupplyRow } from '@/api/supply'
import { useAuthStore } from '@/stores/auth'
const auth = useAuthStore(), rows = ref<SupplyRow[]>([]), balance = ref<SupplyBalance | null>(null), selected = ref<SupplyRow | null>(null)
const error = ref(''), busy = ref(false), message = ref(''), saleMarkup = ref<SupplyComponent[]>([]), supplyMarkup = ref<SupplyComponent[]>([])
const first = computed(() => auth.user?.organizationContext?.organizationLevel === 1)
const form = reactive({ enabled: true, pointsPerCny: '1', consumptionMultiplier: '1' }), credit = reactive({ childId: '', amount: '', receipt: '', requestId: crypto.randomUUID() })
async function perform(operation: () => Promise<unknown>) { busy.value = true; error.value = ''; message.value = ''; try { await operation() } catch (e) { error.value = e instanceof Error ? e.message : '操作失败' } finally { busy.value = false } }
async function load() { [rows.value, balance.value] = await Promise.all([supplyCatalog(), supplyBalance()]) }
function edit(row: SupplyRow) {
  selected.value = row
  const empty = row.model.price.components.map(item => ({ ...item, amount: '0.000000' }))
  saleMarkup.value = JSON.parse(JSON.stringify(row.offer?.saleMarkup?.length ? row.offer.saleMarkup : empty))
  supplyMarkup.value = JSON.parse(JSON.stringify(row.offer?.supplyMarkup?.length ? row.offer.supplyMarkup : empty))
  form.enabled = row.offer?.enabled ?? true; form.pointsPerCny = row.offer?.pointsPerCny || '1'
  form.consumptionMultiplier = row.offer?.consumptionMultiplier ?? '1'
}
async function save() { if (!selected.value) return; await perform(async () => { await saveOffer({ modelId: selected.value!.model.id, ...form, saleMarkup: saleMarkup.value, supplyMarkup: supplyMarkup.value, expectedVersion: selected.value!.offer?.version || 0 }); selected.value = null; await load(); message.value = '供货配置已保存' }) }
async function topup() { await perform(async () => { await creditChild(credit.childId, credit); credit.requestId = crypto.randomUUID(); credit.amount = ''; credit.receipt = ''; await load(); message.value = '充值已审核入账' }) }
onMounted(() => perform(load))
</script>
<template>
  <section class="management-page supply-page"><header class="page-heading"><div><h1>模型供货与收益</h1><p>按上游供货价加价，分别记录用户积分与代理预付额度。</p></div><button class="secondary-button" :disabled="busy" @click="perform(load)">刷新</button></header>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
    <article v-if="balance" class="panel-card"><h2>{{ first ? '供货经营' : '上游预付余额' }}</h2><p v-if="!first">余额 ¥{{ balance.wallet.balance }} · 预占 ¥{{ balance.wallet.reserved }}</p><p>待结算请求 {{ balance.unsettled }} 笔</p><div v-if="balance.totals"><p>累计原价 ¥{{ balance.totals.listSalesAmount }} · 折后计价 ¥{{ balance.totals.salesAmount }} · 营销补贴 ¥{{ balance.totals.marketingSubsidy }}</p><p>累计供货支出 ¥{{ first ? balance.totals.upstreamAmount : balance.totals.supplyAmount }} · 本级价差 ¥{{ first ? balance.totals.firstMargin : balance.totals.secondMargin }}</p><small>仅汇总已结算调用；充值不计入利润，计价金额不代表现金收入。</small></div></article>
    <article class="panel-card"><h2>授权模型与价格</h2><div class="table-scroll"><table><thead><tr><th>模型</th><th>供货状态</th><th>配置</th></tr></thead><tbody><tr v-for="row in rows" :key="row.model.id"><td>{{ row.model.name || row.model.id }}<small>{{ row.model.taskType }}</small></td><td>{{ row.offer?.enabled ? '已启用' : '尚未启用' }}</td><td><button class="secondary-button" @click="edit(row)">设置加价</button></td></tr></tbody></table></div><p v-if="!rows.length">暂无可供货模型，请先核对中心授权和上游配置。</p></article>
    <form v-if="selected" class="panel-card" @submit.prevent="save"><h2>{{ selected.model.name }} · 加价设置</h2><label><input v-model="form.enabled" type="checkbox" />启用供货</label><label>每人民币对应积分<input v-model="form.pointsPerCny" type="text" inputmode="decimal" required /></label><label>终端消费倍率<input v-model="form.consumptionMultiplier" type="text" inputmode="decimal" required /></label><p>倍率仅调整终端积分，可设为0；会员折扣在受理时核对，上游供货费用照常结算。赠送积分消费不等于现金收入。</p><div class="markup-grid"><section><h3>用户售价加价额</h3><label v-for="item in saleMarkup" :key="`${item.meter}:${item.phase}:${JSON.stringify(item.dimensions)}`">{{ item.meter }} · {{ item.phase }} {{ item.dimensions }}<input v-model="item.amount" type="text" inputmode="decimal" required /></label></section><section v-if="first"><h3>二级供货加价额</h3><label v-for="item in supplyMarkup" :key="`${item.meter}:${item.phase}:${JSON.stringify(item.dimensions)}`">{{ item.meter }} · {{ item.phase }} {{ item.dimensions }}<input v-model="item.amount" type="text" inputmode="decimal" required /></label></section></div><button class="primary-button" :disabled="busy">保存</button><button type="button" class="secondary-button" @click="selected = null">取消</button></form>
    <form v-if="first && auth.can('organizations.children.manage')" class="panel-card" @submit.prevent="topup"><h2>审核二级充值</h2><p>确认已线下收款后入账；同一凭证只能入账一次。</p><label>二级组织ID<input v-model="credit.childId" required /></label><label>收款金额（元）<input v-model="credit.amount" type="text" inputmode="decimal" required /></label><label>收款凭证编号<input v-model="credit.receipt" minlength="3" required /></label><button class="primary-button" :disabled="busy">审核入账</button></form>
    <article v-if="balance" class="panel-card"><h2>最近100条调用与价差</h2><div class="table-scroll"><table><thead><tr><th>请求</th><th>状态</th><th>原价</th><th>折后计价金额</th><th>供货支出</th><th>营销补贴</th><th>本级价差</th></tr></thead><tbody><tr v-for="item in balance.usage" :key="item.requestId"><td>{{ item.requestId }}</td><td>{{ item.state }}</td><td>{{ item.listSalesAmount || '待结算' }}</td><td>{{ item.salesAmount || '待结算' }}</td><td>{{ (first ? item.upstreamAmount : item.supplyAmount) || '待结算' }}</td><td>{{ item.marketingSubsidy || '待结算' }}</td><td>{{ (first ? item.firstMargin : item.secondMargin) || '待结算' }}</td></tr></tbody></table></div></article>
  </section>
</template>
<style scoped>.supply-page article,.supply-page form{padding:24px;margin:18px 0}.supply-page label{display:flex;gap:8px;align-items:center;margin:12px 0}.supply-page input{padding:8px;max-width:320px}.supply-page small{display:block}.table-scroll{overflow:auto}.supply-page table{width:100%;text-align:left;border-collapse:collapse}.supply-page td,.supply-page th{padding:12px;border-bottom:1px solid #e2e8f0}.markup-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:20px}</style>
