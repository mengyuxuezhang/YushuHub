<script setup lang="ts">
import { CalendarClock, Gift } from '@lucide/vue'

defineProps<{ form: Record<string, any>; options: any[] }>()
</script>

<template>
  <section class="form-section redeem-code-form">
    <div class="section-heading">
      <span><Gift :size="15" /></span>
      <div><h3>生成规则</h3><p>设置批次、权益内容和兑换有效期。</p></div>
    </div>
    <div class="form-grid-v2 redeem-code-grid">
      <label><span>批次名称</span><input v-model.trim="form.batchName" placeholder="例如：新用户活动" /></label>
      <label><span>生成数量</span><input v-model.number="form.quantity" type="number" min="1" max="1000" /></label>
      <label><span>权益类型</span><select v-model="form.rewardType"><option value="points">积分</option><option value="membership">会员</option></select></label>
      <label v-if="form.rewardType === 'points'"><span>积分数量</span><input v-model.number="form.points" type="number" min="1" /></label>
      <label v-else><span>会员卡</span><select v-model="form.membershipCardId"><option value="" disabled>请选择会员卡</option><option v-for="item in options.filter(x => x.optionType === 'membership')" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label class="redeem-expiry-field"><span><CalendarClock :size="14" />有效期</span><input v-model="form.expiresAt" type="datetime-local" /></label>
    </div>
    <label class="redeem-note-field"><span>备注</span><textarea v-model.trim="form.note" rows="3" placeholder="选填，用于说明本批兑换码用途" /></label>
  </section>
</template>
