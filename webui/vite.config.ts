import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

const BACKEND = process.env.VITE_BACKEND ?? 'http://127.0.0.1:8765'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          const normalized = id.replace(/\\/g, '/')
          if (normalized.includes('/react-markdown/') || normalized.includes('/remark-gfm/') || normalized.includes('/micromark') || normalized.includes('/mdast') || normalized.includes('/unist')) {
            return 'vendor-markdown'
          }
          if (normalized.includes('/cron-parser/') || normalized.includes('/cronstrue/')) {
            return 'vendor-scheduler'
          }
          return undefined
        },
      },
    },
  },
})
