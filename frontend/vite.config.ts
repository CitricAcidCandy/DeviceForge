import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { generatePublicUi, publicUiEntries } from './scripts/generate-public-ui.ts';

export default defineConfig({
  plugins: [
    {
      name: 'deviceforge-public-ui',
      async configResolved(config) { await generatePublicUi(config.root); },
      async handleHotUpdate(context) {
        const path = context.file.replaceAll('\\', '/');
        if (publicUiEntries.some((entry) => path.endsWith(`/src/app/${entry.source}`))) {
          await generatePublicUi(context.server.config.root);
          context.server.ws.send({ type: 'full-reload' });
        }
      },
    },
    react(), tailwindcss(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    dedupe: ['react', 'react-dom'],
  },
  ssr: { noExternal: ['@deviceforge/browser-debugger'] },
  define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(process.env['VITE_API_BASE_URL'] ?? '') },
  build: {
    sourcemap: true,
    rolldownOptions: {
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        'plugin-host': fileURLToPath(new URL('./src/app/public-runtime.ts', import.meta.url)),
        'browser-plugin-harness': fileURLToPath(new URL('./scripts/browser-plugin-harness.ts', import.meta.url)),
        'browser-service-harness': fileURLToPath(new URL('./scripts/browser-service-harness.ts', import.meta.url)),
        'browser-theme-harness': fileURLToPath(new URL('./scripts/browser-theme-harness.ts', import.meta.url)),
        'browser-product-harness': fileURLToPath(new URL('./scripts/browser-product-harness.ts', import.meta.url)),
        'performance-acceptance-harness': fileURLToPath(new URL('./scripts/performance-acceptance-harness.tsx', import.meta.url)),
        'debugger-browser-harness': fileURLToPath(new URL('./scripts/debugger-browser-harness.ts', import.meta.url)),
      },
      external: ['/__production_host__'],
      preserveEntrySignatures: 'strict',
      output: { entryFileNames: 'assets/[name].js' },
    },
  },
});
