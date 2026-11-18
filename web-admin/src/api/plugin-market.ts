import { api } from './client'

export interface PluginPresentation {
  title: string
  description: string
  iconUrl: string
  guide: string
  tags: string[]
  examples: string[]
}
export interface PluginVersion {
  id: string
  version: string
  title: string
  description: string
  presentation: PluginPresentation
}
export interface PluginGrant {
  project_id: string
  plugin_id: string
  version: string
}
export interface PluginMarket {
  versions: PluginVersion[]
  centerMode?: boolean
  official?: PluginVersion[]
  grants: PluginGrant[]
  projects: { id: string; name: string }[]
  counts: (PluginGrant & { count: number })[]
}
const root = '/api/plugin-market'
export const getPluginMarket = () => api<PluginMarket>(root)
export const publishBundledPlugin = (id: string) => api<PluginVersion>(root + '/bundled/' + encodeURIComponent(id), { method: 'POST' })
export function uploadPlugin(file: File) {
  const body = new FormData()
  body.append('package', file)
  return api<PluginVersion>(root + '/versions', { method: 'POST', body })
}
export const savePluginPresentation = (id: string, profile: PluginPresentation) =>
  api<PluginPresentation>(root + '/profiles/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(profile) })
export const syncOfficialPlugins = () => api<{ enabled: boolean; total: number }>(root + '/sync', { method: 'POST' })
export const setOfficialPluginVersion = (id: string, version: string | null) =>
  api(root + '/official/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ version }) })
export const savePluginGrant = (projectId: string, pluginId: string, version: string) =>
  api(root + '/grants/' + encodeURIComponent(projectId) + '/' + encodeURIComponent(pluginId), {
    method: 'PUT', body: JSON.stringify({ version }),
  })
export const revokePluginGrant = (projectId: string, pluginId: string) =>
  api(root + '/grants/' + encodeURIComponent(projectId) + '/' + encodeURIComponent(pluginId), { method: 'DELETE' })
