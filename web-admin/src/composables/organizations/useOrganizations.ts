import { computed, onMounted, reactive, ref } from 'vue'
import * as api from '@/api/organization'
import { toUserMessage } from '@/api/client'
import { useFeedbackStore } from '@/stores/feedback'
import type { Capability, Organization, OrganizationAudit, OrganizationContext } from '@/types/organization'
import { localExpiryInput } from '@/utils/supplier-license'

export function useOrganizations() {
  const feedback = useFeedbackStore(), context = ref<OrganizationContext | null>(null), organizations = ref<Organization[]>([]), selected = ref<Organization | null>(null), capabilities = ref<Capability[]>([]), audit = ref<OrganizationAudit[]>([])
  const loading = ref(false), saving = ref(false), drawerOpen = ref(false), resetTarget = ref<Organization | null>(null), resetPasswordValue = ref(''), search = ref(''), searchField = ref('all'), appliedSearch = ref(''), appliedSearchField = ref('all'), status = ref('all'), errorMessage = ref(''), activeDetail = ref<'capabilities'|'audit'>('capabilities')
  const form = reactive({ id: '', name: '', username: '', displayName: '', password: '', status: 'enabled', maxProjects: 0, maxBuilds: 0, neverExpires: true, expiresAt: '' })
  const rows = computed(() => { const q=appliedSearch.value.toLowerCase(); return organizations.value.filter(x=>(status.value==='all'||x.status===status.value)&&(!q||({name:[x.name],id:[x.id],owner:[x.ownerUsername,x.ownerDisplayName]}[appliedSearchField.value]||[x.name,x.id,x.ownerUsername,x.ownerDisplayName]).some(value=>String(value||'').toLowerCase().includes(q)))) })
  function submitSearch(){appliedSearch.value=search.value.trim();appliedSearchField.value=searchField.value}
  function resetSearch(){search.value='';searchField.value='all';appliedSearch.value='';appliedSearchField.value='all';status.value='all'}
  const groupedCapabilities = computed(() => {
    const order = ['个人业务', '通用能力', '渠道管理', '平台专属']
    const map = new Map<string, Capability[]>()
    for (const capability of capabilities.value) {
      const category = capability.category || '通用能力'
      if (!map.has(category)) map.set(category, [])
      map.get(category)!.push(capability)
    }
    return [...map.entries()].sort(([left], [right]) => (order.indexOf(left) < 0 ? 99 : order.indexOf(left)) - (order.indexOf(right) < 0 ? 99 : order.indexOf(right)))
  })
  const canCreateChildren = computed(() => context.value?.organizationLevel === 1)
  const transferableCapabilityMap = computed(() => new Map((context.value?.capabilities || []).filter(x=>x.enabled&&x.transferable).map(x=>[x.key,x])))
  const canTransferProjectQuota = computed(() => transferableCapabilityMap.value.has('projects.manage'))
  const canTransferBuildQuota = computed(() => transferableCapabilityMap.value.has('builds.create'))
  async function load() { loading.value=true; try { [context.value,organizations.value]=await Promise.all([api.getOrganizationContext(),api.listChildOrganizations()]) } catch(e){feedback.notify(toUserMessage(e),'error')} finally{loading.value=false} }
  function openCreate(){Object.assign(form,{id:'',name:'',username:'',displayName:'',password:'',status:'enabled',maxProjects:0,maxBuilds:0,neverExpires:!context.value?.expiresAt,expiresAt:localExpiryInput(context.value?.expiresAt)});errorMessage.value='';drawerOpen.value=true}
  function openEdit(item:Organization){Object.assign(form,{id:item.id,name:item.name,username:item.ownerUsername,displayName:item.ownerDisplayName,password:'',status:item.status,maxProjects:0,maxBuilds:0,neverExpires:!item.expiresAt,expiresAt:localExpiryInput(item.expiresAt)});errorMessage.value='';drawerOpen.value=true}
  async function save(){if(saving.value)return;if(!form.name.trim()||(!form.id&&(!form.username.trim()||form.password.length<8))){errorMessage.value='请填写组织名称，新建时需填写管理员账号和至少 8 位密码';return}
    const parentExpiry = context.value?.expiresAt
    const expiryTime = form.neverExpires ? null : new Date(form.expiresAt).getTime()
    if(!form.neverExpires && (!form.expiresAt || !Number.isFinite(expiryTime))){errorMessage.value='请选择有效的授权到期时间';return}
    if(parentExpiry && (expiryTime === null || expiryTime > Date.parse(parentExpiry))){errorMessage.value='二级代理到期时间不能超过一级代理，不能设置永不过期';return}
    const expiresAt = expiryTime === null ? null : new Date(expiryTime).toISOString()
    saving.value=true;try{
      let payload: Record<string, unknown>
      if(form.id){payload=form}else{
        const capabilities: { key: string; limitValue: number }[] = []
        const maxProjects = Math.max(0, Math.floor(Number(form.maxProjects) || 0))
        const maxBuilds = Math.max(0, Math.floor(Number(form.maxBuilds) || 0))
        if(maxProjects>0&&canTransferProjectQuota.value)capabilities.push({key:'projects.manage',limitValue:maxProjects})
        if(maxBuilds>0&&canTransferBuildQuota.value)capabilities.push({key:'builds.create',limitValue:maxBuilds})
        payload={...form,capabilities}
      }
      payload = {...payload, expiresAt}
      const saved=form.id?await api.updateChildOrganization(form.id,payload):await api.createChildOrganization(payload)
      if(selected.value?.id===saved.id)selected.value=saved
      const i=organizations.value.findIndex(x=>x.id===saved.id);if(i>=0)organizations.value.splice(i,1,saved);else organizations.value.unshift(saved);feedback.notify(`二级代理“${saved.name}”保存成功`,'success');drawerOpen.value=false
    }catch(e){errorMessage.value=toUserMessage(e)}finally{saving.value=false}}
  async function select(item:Organization){selected.value=item;activeDetail.value='capabilities';try{const[assigned,logs]=await Promise.all([api.listCapabilities(item.id),api.listOrganizationAudit(item.id).catch(()=>[])]);const personalAssigned=assigned.filter(x=>!x.key.startsWith('enterprise_'));const assignedByKey=new Map(personalAssigned.map(x=>[x.key,x]));capabilities.value=(context.value?.capabilities||[]).filter(x=>x.transferable&&x.enabled&&!x.key.startsWith('enterprise_')).map(x=>({...x,...assignedByKey.get(x.key),enabled:assignedByKey.has(x.key)}));audit.value=logs}catch(e){feedback.notify(toUserMessage(e),'error')}}
  async function saveCapabilitySelection(){if(!selected.value||saving.value)return;saving.value=true;try{capabilities.value=await api.saveCapabilities(selected.value.id,capabilities.value.filter(x=>x.enabled));feedback.notify('下级代理能力授权已保存','success')}catch(e){feedback.notify(toUserMessage(e),'error')}finally{saving.value=false}}
  function isCapabilityGroupFullyEnabled(items: Capability[]){return items.length>0&&items.every(item=>item.enabled)}
  function toggleCapabilityGroup(items: Capability[]){const enabled=!isCapabilityGroupFullyEnabled(items);for(const item of items)item.enabled=enabled}
  function resetPassword(item:Organization){resetTarget.value=item;resetPasswordValue.value=''}
  async function confirmResetPassword(){if(!resetTarget.value||resetPasswordValue.value.length<8){feedback.notify('新密码至少 8 位','warning');return}saving.value=true;try{await api.resetChildPassword(resetTarget.value.id,resetPasswordValue.value);feedback.notify('管理员密码已重置，原会话已失效','success');resetTarget.value=null}catch(e){feedback.notify(toUserMessage(e),'error')}finally{saving.value=false}}
  async function remove(item:Organization){const ok=await feedback.confirm({title:`删除“${item.name}”？`,message:'仅空组织可删除，操作不可恢复。',confirmText:'删除组织',tone:'danger'});if(!ok)return;try{await api.deleteChildOrganization(item.id);organizations.value=organizations.value.filter(x=>x.id!==item.id);if(selected.value?.id===item.id)selected.value=null;feedback.notify('二级代理已删除','success')}catch(e){feedback.notify(toUserMessage(e),'error')}}
  onMounted(load); return {context,organizations,selected,capabilities,groupedCapabilities,audit,loading,saving,drawerOpen,resetTarget,resetPasswordValue,search,searchField,status,errorMessage,activeDetail,form,rows,canCreateChildren,canTransferProjectQuota,canTransferBuildQuota,transferableCapabilityMap,load,openCreate,openEdit,save,select,isCapabilityGroupFullyEnabled,toggleCapabilityGroup,saveCapabilitySelection,resetPassword,confirmResetPassword,remove,submitSearch,resetSearch}
}
