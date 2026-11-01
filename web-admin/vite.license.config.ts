import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { renameSync } from 'node:fs'
const output = fileURLToPath(new URL('../web/license-center/', import.meta.url))
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), base: '/license-center/',
  plugins: [vue(), { name: 'license-center-entry', closeBundle() { renameSync(output + 'license-center.html', output + 'index.html') } }],
  build: { outDir: output, emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('license-center.html', import.meta.url)), output: { entryFileNames: 'assets/[name]-[hash].js' } } },
})
