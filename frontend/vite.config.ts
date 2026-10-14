import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { proxy: { '/api': 'http://127.0.0.1:7031', '/mcp': 'http://127.0.0.1:7031' } },
  build: {
    sourcemap: true,
    rolldownOptions: {
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        'plugin-host': fileURLToPath(new URL('./src/app/public-runtime.ts', import.meta.url)),
        'browser-plugin-harness': fileURLToPath(new URL('./scripts/browser-plugin-harness.ts', import.meta.url)),
        'browser-theme-harness': fileURLToPath(new URL('./scripts/browser-theme-harness.ts', import.meta.url)),
        'browser-product-harness': fileURLToPath(new URL('./scripts/browser-product-harness.ts', import.meta.url)),
      },
      external: ['/__production_host__'],
      preserveEntrySignatures: 'strict',
      output: { entryFileNames: 'assets/[name].js' },
    },
  },
});
