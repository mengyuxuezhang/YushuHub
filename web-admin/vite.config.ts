import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: '/admin/v2/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: '../web/admin-v2',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5178,
    proxy: {
      '/api': 'http://127.0.0.1:7077',
      '/uploads': 'http://127.0.0.1:7077',
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
  },
})
