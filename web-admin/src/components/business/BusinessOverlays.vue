<script setup lang="ts">
import BusinessDrawer from './BusinessDrawer.vue'
import EndUserModelAccessDrawer from './EndUserModelAccessDrawer.vue'
import EndUserMembershipDrawer from './EndUserMembershipDrawer.vue'
import type { BusinessSection } from '@/composables/business/useBusinessOperations'
defineProps<{ section: BusinessSection; b: any }>()
</script>
<template>
  <BusinessDrawer :open="b.drawerOpen.value" :section="section" :form="b.form" :options="b.options.value" :saving="b.saving.value" :error-message="b.errorMessage.value" :editing-id="b.editingId.value" @close="b.drawerOpen.value=false" @save="b.save" />
  <EndUserModelAccessDrawer :open="b.modelAccessOpen.value" :user="b.modelAccessUser.value" :models="b.modelAccessModels.value" :selected-ids="b.modelAccessSelectedIds.value" :loading="b.modelAccessLoading.value" :saving="b.modelAccessSaving.value" :error-message="b.modelAccessError.value" @update:selected-ids="b.modelAccessSelectedIds.value=$event" @close="b.modelAccessOpen.value=false" @save="b.saveModelAccess" />
  <EndUserMembershipDrawer :open="b.membershipOpen.value" :user="b.membershipUser.value" :cards="b.membershipCards.value" :selected-card-id="b.membershipSelectedCardId.value" :loading="b.membershipLoading.value" :saving="b.membershipSaving.value" :error-message="b.membershipError.value" @update:selected-card-id="b.membershipSelectedCardId.value=$event" @close="b.membershipOpen.value=false" @save="b.saveMembership" @cancel-membership="b.cancelMembership" />
  <div v-if="b.dialogTarget.value" class="dialog-backdrop"><div class="confirm-dialog password-dialog"><h2>{{b.dialogMode.value==='password'?'重置终端用户密码':'人工调整积分'}}</h2><p>{{b.dialogTarget.value.displayName||b.dialogTarget.value.username}}</p><p v-if="b.dialogMode.value==='credits'">当前积分：{{b.dialogTarget.value.creditBalance??0}}；正数增加积分，负数扣减积分。</p><label><span>{{b.dialogMode.value==='password'?'新密码（至少 6 位）':'积分变动值'}}</span><input v-model="b.dialogValue.value" :type="b.dialogMode.value==='password'?'password':'number'" /></label><div class="dialog-actions"><button class="secondary-button" @click="b.dialogTarget.value=null">取消</button><button class="primary-button" @click="b.submitDialog">确认</button></div></div></div>
</template>
