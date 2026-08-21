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
        // Identità stabile dell'app installata: senza `id`, il browser la deduce da
        // start_url e cambiare quest'ultimo domani farebbe comparire una SECONDA app
        // invece di aggiornare quella già installata sul telefono dell'operaio.
        id: '/',
        // 'any maskable' sulle icone esistenti: su Android l'icona viene ritagliata a
        // cerchio/goccia secondo il launcher. Sono le stesse PNG senza padding di
        // sicurezza dedicato, quindi i bordi possono essere tagliati — compromesso
        // accettato: meglio di un'icona con lo sfondo bianco squadrato di default.
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
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
