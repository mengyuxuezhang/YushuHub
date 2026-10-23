<script setup lang="ts">import{CreditCard,Globe2,KeyRound,X}from'@lucide/vue';import RedeemCodeForm from '@/components/business/RedeemCodeForm.vue';import type{BusinessSection}from'@/composables/business/useBusinessOperations';defineProps<{open:boolean;section:BusinessSection;form:Record<string,any>;options:any[];saving:boolean;errorMessage:string;editingId:string}>();defineEmits<{close:[];save:[]}>()</script>
<template><div v-if="open" class="drawer-backdrop-v2"><aside class="form-drawer-v2 business-drawer" role="dialog"><header class="drawer-header"><div><span class="eyebrow">Business operation</span><h2>{{section==='end-users'?'新增终端用户':section==='memberships'?(editingId?'编辑会员卡':'新增会员卡'):section==='payments'?'支付服务配置':'生成兑换码'}}</h2></div><button class="icon-button" @click="$emit('close')"><X :size="18"/></button></header><div class="drawer-body">
<template v-if="section==='end-users'"><div class="member-identity-note"><strong>个人终端用户</strong><span>此处账号用于 Desktop，不创建管理后台权限。</span></div><div class="form-grid-v2"><label><span>登录账号</span><input v-model.trim="form.username"/></label><label><span>姓名</span><input v-model.trim="form.displayName"/></label><label><span>邮箱</span><input v-model.trim="form.email" type="email"/></label><label><span>初始密码</span><input v-model="form.password" type="password"/></label><label><span>来源项目 ID（选填）</span><input v-model.trim="form.sourceProjectId" placeholder="填写本组织 AI 项目 ID"/><small>开通受限客户端账号时必填，系统校验项目管理权限。</small></label></div></template>
<template v-else-if="section==='memberships'"><section class="form-section"><div class="form-grid-v2"><label><span>会员卡 ID</span><input v-model.trim="form.id" :disabled="Boolean(editingId)" minlength="2" maxlength="64" pattern="[a-z0-9][a-z0-9_-]{1,63}" placeholder="至少 2 位，例如 vip_monthly"/><small>2–64 位小写字母、数字、短横线或下划线；创建后不可修改。</small></label><label><span>名称</span><input v-model.trim="form.name"/></label><label><span>等级</span><input v-model.number="form.level" type="number" min="1"/></label><label><span>状态</span><select v-model="form.status"><option value="enabled">启用</option><option value="disabled">停用</option></select></label></div><label><span>说明</span><textarea v-model.trim="form.description" rows="2"/></label></section><section class="form-section"><h3>唯一权益包</h3><div class="form-grid-v2"><label><span>权益名称</span><input v-model.trim="form.package.name"/></label><label><span>会员时长（0 为永久）</span><input v-model.number="form.package.durationDays" type="number" min="0"/></label><label><span>赠送积分</span><input v-model.number="form.package.bonusPoints" type="number" min="0"/></label><label><span>积分有效期（天）</span><input v-model.number="form.package.pointsDurationDays" type="number" min="0"/></label><label><span>价格（元）</span><input v-model.number="form.package.price" type="number" min="0" step="0.01"/></label><label><span>原价（元）</span><input v-model.number="form.package.originalPrice" type="number" min="0" step="0.01"/></label></div></section><section class="form-section"><h3>可用模型</h3><p>未选择表示可使用全部启用模型。</p><div class="selection-list"><label v-for="item in options" :key="item.id"><input v-model="form.modelIds" type="checkbox" :value="item.id"/><span><strong>{{item.displayName||item.modelId}}</strong><small>{{item.providerName||item.providerId}}</small></span></label></div></section></template>
<template v-else-if="section==='payments'">
  <div class="member-identity-note payment-security-note"><KeyRound :size="18"/><div><strong>密钥不会回填</strong><span>敏感字段留空表示保持服务器现有值；连接检测与保存分开执行。</span></div></div>
  <section class="form-section payment-config-section">
    <div class="section-heading"><span><Globe2 :size="15"/></span><div><h3>渠道与应用</h3><p>设置启用状态、回调域名和支付应用身份。</p></div></div>
    <div class="form-grid-v2">
      <label><span>渠道状态</span><select v-model="form.status"><option value="enabled">启用</option><option value="disabled">停用</option></select><small v-if="form.status==='disabled'">停用时仅保存参数，客户端不会开放购买。</small></label>
      <label><span>公网基础地址</span><input v-model.trim="form.publicBaseUrl" type="url" placeholder="https://pay.example.com"/></label>
      <label><span>应用 ID</span><input v-model.trim="form.appId" autocomplete="off" placeholder="请输入支付应用 ID"/></label>
      <label v-if="form.provider==='wechat'"><span>微信支付商户号</span><input v-model.trim="form.mchId" autocomplete="off" placeholder="请输入商户号"/></label>
      <label v-else><span>卖家支付宝用户 ID（选填）</span><input v-model.trim="form.sellerId" autocomplete="off" inputmode="numeric" placeholder="以 2088 开头的支付宝 PID"/><small>普通直连商户可留空；不是应用 ID 或支付宝登录账号。</small></label>
    </div>
  </section>
  <section class="form-section payment-config-section payment-secret-section">
    <div class="section-heading"><span><CreditCard :size="15"/></span><div><h3>签名凭据</h3><p>凭据只在本次填写时可见，保存后由服务器加密保管。</p></div></div>
    <template v-if="form.provider==='wechat'">
      <label><span>API v3 Key</span><input v-model="form.apiV3Key" type="password" autocomplete="new-password" placeholder="留空保持现有值"/></label>
      <label><span>商户私钥</span><textarea v-model="form.merchantPrivateKey" rows="5" autocomplete="off" spellcheck="false" placeholder="粘贴商户私钥；留空保持现有值"/></label>
    </template>
    <template v-else>
      <label><span>应用私钥</span><textarea v-model="form.appPrivateKey" rows="5" autocomplete="off" spellcheck="false" placeholder="粘贴应用私钥；留空保持现有值"/></label>
      <label><span>支付宝公钥</span><textarea v-model="form.alipayPublicKey" rows="5" autocomplete="off" spellcheck="false" placeholder="粘贴支付宝公钥；留空保持现有值"/></label>
    </template>
  </section>
</template>
<template v-else><RedeemCodeForm :form="form" :options="options" /></template>
<p v-if="errorMessage" class="drawer-error">{{errorMessage}}</p></div><footer class="drawer-footer"><button class="primary-button" :disabled="saving" @click="$emit('save')">{{saving?'处理中…':section==='redeem-codes'?'生成兑换码':'保存'}}</button></footer></aside></div></template>
