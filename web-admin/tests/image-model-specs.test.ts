import { createApp, h, nextTick, reactive } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import ImageModelSpecEditor from '@/components/models/ImageModelSpecEditor.vue'
import PricingPlanDrawer from '@/components/models/PricingPlanDrawer.vue'
import { listModelCapabilities, saveModelCapability } from '@/api/pricing-center'
import { imagePricingComponents } from '@/utils/image-pricing'
import { meterLabels } from '@/utils/pricing-labels'
vi.mock('@/api/pricing-center',()=>({listModelCapabilities:vi.fn(),saveModelCapability:vi.fn()}))
const cleanup: (()=>void)[]=[]
afterEach(()=>{cleanup.splice(0).forEach(fn=>fn());vi.clearAllMocks()})
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,0));await nextTick()}
const capability:any={id:'cap',providerModelId:'model',taskType:'image_generation',protocolAdapter:'openai.images',endpointPath:'/custom/images',config:{endpoints:{submit:'/custom/images'},parameters:{keep:true},image:{version:1,adapter:'openai',template:'custom',defaultSize:'4096x4096',quality:'',usage:'openai',tokenBudget:{input:1000,output:2000},maxReferences:0,specs:[{size:'1024x1024',resolution:'1K',aspectRatio:'1:1'},{size:'4096x4096',resolution:'4K',aspectRatio:'1:1'}]}}}
function mount(component:any,props:any){const host=document.createElement('div');document.body.append(host);const app=createApp({render:()=>h(component,props)});app.mount(host);cleanup.push(()=>{app.unmount();host.remove()});return host}
function select(label:string){const node=[...document.body.querySelectorAll('label')].find(node=>node.querySelector('span')?.textContent===label);return node?.querySelector('select') as HTMLSelectElement}
async function change(node:HTMLSelectElement,value:string){node.value=value;node.dispatchEvent(new Event('change',{bubbles:true}));await nextTick()}
it('loads model-specific defaults and emits explicit specs for the parent model transaction',async()=>{
  vi.mocked(listModelCapabilities).mockResolvedValue([structuredClone(capability)])
  vi.mocked(saveModelCapability).mockImplementation(async input=>input as never)
  const changed=vi.fn();mount(ImageModelSpecEditor,{modelId:'model',onChange:changed});await settle()
  expect(select('默认规格').value).toBe('4096x4096')
  await change(select('快速模板'),'seedream')
  expect(select('默认规格').value).toBe('2K')
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({adapter:'seedream',maxReferences:10,defaultSize:'2K'}))
  expect(saveModelCapability).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('与模型配置一并保存')
})
it('image pricing exposes three modes, configured resolution rows and optional token detail without reference surcharge',async()=>{
  const form=reactive({sourcePlanId:'',capabilityId:'cap',status:'enabled',consumptionMultiplier:1,components:imagePricingComponents(capability,'request')})
  mount(PricingPlanDrawer,{open:true,saving:false,form,capabilities:[capability],selectedCapability:capability,meterOptions:[],meterLabels,membershipOptions:[{id:'vip',name:'验收套餐',usable:true,unitPriceCny:0.1,package:{name:'验收',price:10,bonusPoints:100}}]})
  expect([...select('图片计费方式').options].map(option=>option.value)).toEqual(['request','resolution','token'])
  await change(select('图片计费方式'),'resolution')
  expect(form.components.map(item=>item.dimensions.resolution)).toEqual(['1K','4K'])
  expect(document.body.textContent).not.toContain('首张参考图免费')
  await change(select('积分换算套餐'),'vip');expect(form.components.every(item=>item.pricingCardId==='vip')).toBe(true)
  await change(select('图片计费方式'),'token')
  expect(form.components.map(item=>item.meter)).toEqual(['input_tokens','output_tokens'])
  ;[...document.body.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent==='展开分项价格')!.click();await nextTick()
  expect(form.components).toHaveLength(5)
  expect(document.body.textContent).toContain('单次预占约')
})
