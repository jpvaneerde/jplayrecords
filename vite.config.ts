import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    // The API server: npm run dev:server
    proxy: { '/api': 'http://127.0.0.1:8788', '/covers': 'http://127.0.0.1:8788', '/d/': 'http://127.0.0.1:8788' },
  },
  preview: { host: '127.0.0.1', port: 5174, strictPort: true },
})
