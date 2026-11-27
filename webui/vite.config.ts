import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

const BACKEND = process.env.VITE_BACKEND ?? 'http://127.0.0.1:8765'

function stripLegacyKatexFonts() {
  return {
    name: 'strip-legacy-katex-fonts',
    generateBundle(_options: unknown, bundle: Record<string, unknown>) {
      for (const fileName of Object.keys(bundle)) {
        if (/KaTeX_.*\.(?:woff|ttf)$/i.test(fileName)) {
          delete bundle[fileName]
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), stripLegacyKatexFonts()],
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
    sourcemap: false,
    rollupOptions: {
      input: { main: path.resolve(__dirname, 'index.html'), dialog: path.resolve(__dirname, 'dialog.html') },
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          const normalized = id.replace(/\\/g, '/')
          if (
            normalized.includes('/node_modules/react/')
            || normalized.includes('/node_modules/react-dom/')
            || normalized.includes('/node_modules/scheduler/')
            || normalized.includes('/node_modules/react-router-dom/')
            || normalized.includes('/node_modules/react-router/')
            || normalized.includes('/node_modules/@remix-run/router/')
          ) {
            return 'vendor-react'
          }
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
