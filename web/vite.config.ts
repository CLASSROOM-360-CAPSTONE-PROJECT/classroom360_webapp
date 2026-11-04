import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // The scheduler's solver (OR-Tools CP-SAT compiled to WebAssembly) runs in a Web Worker.
  // It must not be pre-bundled, or its .wasm file is looked up in the wrong place.
  optimizeDeps: { exclude: ['cpsat-js'] },
  worker: { format: 'es' },
})
