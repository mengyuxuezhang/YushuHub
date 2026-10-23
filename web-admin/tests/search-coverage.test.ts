import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const sourceRoot = join(process.cwd(), 'src')
const read = (path: string) => readFileSync(join(sourceRoot, path), 'utf8')

describe('admin search coverage', () => {
  it('keeps every list surface on the shared explicit search toolbar', () => {
    const surfaces = [
      'views/markets/AgentMarketView.vue',
      'views/markets/CatalogMarketView.vue',
      'components/models/ModelSearchToolbar.vue',
      'views/organizations/OrganizationsView.vue',
      'views/organizations/AccountsView.vue',
      'views/organizations/PermissionsView.vue',
      'components/business/BusinessSearchToolbar.vue',
      'views/delivery/DeliverySystemView.vue',
      'components/delivery/WorkerPanel.vue',
    ]
    for (const surface of surfaces) expect(read(surface), surface).toContain('SearchToolbar')
  })

  it('does not reintroduce a page-owned primitive list toolbar', () => {
    const vueFiles: string[] = []
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (entry.name.endsWith('.vue')) vueFiles.push(path)
      }
    }
    visit(sourceRoot)
    const offenders = vueFiles
      .filter((path) => !path.endsWith(join('components', 'common', 'SearchToolbar.vue')))
      .filter((path) => readFileSync(path, 'utf8').includes('class="list-toolbar panel-card'))
      .map((path) => path.slice(sourceRoot.length + 1))
    expect(offenders).toEqual([])
  })

  it('retains the mobile stacking contract for fields and actions', () => {
    const markets = read('styles/markets.css')
    const responsive = read('styles/responsive.css')
    expect(markets).toContain('.query-toolbar{flex-wrap:wrap}')
    expect(markets).toContain('.query-toolbar .search-control{flex:1 1 240px;min-width:180px}')
    expect(markets).toContain('.query-toolbar>select:not(.query-field){flex:0 1 140px;min-width:120px;max-width:100%}')
    expect(responsive).toContain('.list-toolbar { align-items: stretch; flex-direction: column; }')
    expect(responsive).toContain('.query-toolbar .query-field { flex: none; width: 100%; max-width: none; }')
    expect(responsive).toContain('.query-toolbar .search-control { width: 100%; min-width: 0; }')
    expect(responsive).toContain('.query-actions button { flex: 1; }')
  })
})
