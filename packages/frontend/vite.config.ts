import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Frontend dev server su :5173 (origine consentita dal CORS del backend).
// Il backend gira su :4000 (API base: /api/v1). Il proxy evita problemi CORS in dev.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // VitePWA per ultimo: genera il service worker sull'output finale del bundle,
    // deve vedere gli asset già prodotti dagli altri plugin.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'WorkFlow360',
        short_name: 'WF360',
        description: 'Gestione cantieri e ore operai',
        theme_color: '#2563eb',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
