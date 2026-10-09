import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [svelte()],
  server: { proxy: { '/api': 'http://127.0.0.1:7031', '/mcp': 'http://127.0.0.1:7031' } },
  build: {
    sourcemap: true,
    rolldownOptions: {
      input: { app: fileURLToPath(new URL('./index.html', import.meta.url)), 'plugin-host': fileURLToPath(new URL('./src/app/public-runtime.ts', import.meta.url)) },
      preserveEntrySignatures: 'strict',
      output: { entryFileNames: 'assets/[name].js' },
    },
  },
});
