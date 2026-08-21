# WorkFlow360 — Frontend PWA

Interfaccia mobile-first (React + Vite + TypeScript + vite-plugin-pwa) per WorkFlow360.
Consuma il backend Express su `http://localhost:4000`.

## Avvio in sviluppo
1. Avvia il backend (vedi `packages/backend`): deve rispondere su `:4000` con CORS
   abilitato per `http://localhost:5173` (configurazione in `.env` nella radice del
   monorepo, non dentro `packages/backend/` — vedi `config/index.ts`).
2. In questa cartella:
   ```bash
   npm install
   npm run dev        # Vite su http://localhost:5173
   ```
   Il proxy Vite rimappa `/api` → `http://localhost:4000`, quindi niente problemi CORS in dev.

## Build di produzione
```bash
npm run build      # tsc + vite build → dist/ (incl. service worker PWA)
npm run preview    # serve la build locale
```

## Struttura
- `src/lib/api.ts` — client API (fetch + token JWT in localStorage, chiave `wf360_token`)
- `src/lib/types.ts` — tipi del dominio
- `src/pages/LoginPage.tsx` — login email+password
- `src/pages/DashboardPage.tsx` — dashboard azienda (cantieri + utenti, form creazione)
- `src/App.tsx` — routing + protezione rotte

## Credenziali di demo (seed)
```bash
cd packages/backend && npx tsx scripts/seed-dev.ts
# admin@neotekna.it / [REDACTED]
```
(Non usare il seed in produzione.)

## Note
- UI in italiano, mobile-first (gli operai usano smartphone).
- Il service worker rende l'app installabile (PWA) e cachea l'UI.
- F6 (dashboard operaio: inserimento ore + lavoro + materiali) ancora da fare.
