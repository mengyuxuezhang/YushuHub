import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
export default defineConfig({ root: fileURLToPath(new URL('./', import.meta.url)), base: '/license-center/', plugins: [vue()], resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: fileURLToPath(new URL('../web/license-center', import.meta.url)), emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('./license-center.html', import.meta.url)) } } })
