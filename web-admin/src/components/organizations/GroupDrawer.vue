<script setup lang="ts">
import { X } from '@lucide/vue'
import type { AdminAccount, PermissionItem } from '@/types/organization'
defineProps<{open:boolean;form:Record<string,any>;accounts:AdminAccount[];catalog:PermissionItem[];saving:boolean;errorMessage:string}>()
defineEmits<{close:[];save:[]}>()
</script>
<template><div v-if="open" class="drawer-backdrop-v2"><aside class="form-drawer-v2 group-drawer" role="dialog" aria-label="配置账号组"><header class="drawer-header"><div><span class="eyebrow">Permission composition</span><h2>配置账号组</h2></div><button class="icon-button" @click="$emit('close')"><X :size="18"/></button></header><div class="drawer-body">
<section class="form-section"><div class="section-heading"><span>1</span><div><h3>分组信息</h3><p>账号组只叠加权限，不改变成员的组织归属、岗位和数据范围。</p></div></div><label><span>组名</span><input v-model.trim="form.name"/></label><label><span>说明</span><textarea v-model.trim="form.description" rows="2"/></label><label><span>状态</span><select v-model="form.status"><option value="enabled">启用</option><option value="disabled">停用</option></select></label></section>
<section class="form-section"><div class="section-heading"><span>2</span><div><h3>选择内部成员</h3><p>这里只显示当前组织内的账号。</p></div></div><div class="selection-list"><label v-for="item in accounts" :key="item.id"><input v-model="form.userIds" type="checkbox" :value="item.id"/><span><strong>{{item.displayName}}</strong><small>{{item.username}}</small></span></label><p v-if="!accounts.length" class="muted-empty">暂无可选内部成员</p></div></section>
<section class="form-section"><div class="section-heading"><span>3</span><div><h3>追加权限</h3><p>最终权限仍受岗位、组织能力和数据范围共同约束。</p></div></div><div class="selection-list"><label v-for="item in catalog" :key="item.key"><input v-model="form.permissionKeys" type="checkbox" :value="item.key"/><span><strong>{{item.name}}</strong><small>{{item.key}} · {{item.group||'其他'}}</small></span></label></div></section>
<p v-if="errorMessage" class="drawer-error">{{errorMessage}}</p></div><footer class="drawer-footer"><button class="primary-button" :disabled="saving" @click="$emit('save')">{{saving?'保存中…':'保存账号组配置'}}</button></footer></aside></div></template>
