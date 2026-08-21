# WorkFlow360 — SaaS multi-tenant per aziende di manutenzione/costruzioni

Traccia le ore dei cantieri e degli operai, isolando ogni azienda (multi-tenant).
Gli operai registrano dal telefono le proprie ore + lavoro svolto + materiali; gli admin
vedono report per commessa e per operaio.

## Stack
- **Backend**: Express + TypeScript + Drizzle ORM + PostgreSQL
- **Frontend**: React + Vite + TypeScript (PWA, installabile su mobile)
- **Auth**: JWT (access token), bcrypt, isolamento per `companyId`
- **Multi-tenant**: ogni azienda ha il proprio `companyId`; i dati non si incrociano mai

## Prerequisiti
- Node.js 24+
- Docker Desktop (per PostgreSQL)
- npm

## 1. Database (Docker)
Dalla root del progetto:
```bash
docker compose up -d
```
Crea il container `workflow360-postgres-1` su `localhost:5432`.
Connessione: `postgresql://workflow360:workflow360@localhost:5432/workflow360`

Applica lo schema (migrazioni Drizzle):
```bash
cd packages/backend
npx drizzle-kit migrate
```

## 2. Backend
```bash
cd packages/backend
cp .env.example .env   # se non esiste; altrimenti crea .env con:
#   DATABASE_URL=postgresql://workflow360:workflow360@localhost:5432/workflow360
#   PORT=4000
#   NODE_ENV=development
#   JWT_SECRET=<stringa-random-casuale>
#   CORS_ORIGINS=http://localhost:5173
npm install
npm run dev            # avvio con hot-reload su :4000
```
Test:
```bash
npx vitest run         # 93 test verdi (multi-tenant + operaio + report)
```

### Seed dati di sviluppo (opzionale)
Crea un'azienda demo, un admin e un cantiere+task di esempio:
```bash
cd packages/backend
npx tsx scripts/seed-dev.ts
# Admin:  admin@neotekna.it / Admin123!
# (poi crea un operaio dalla dashboard admin: operaio@neotekna.it / Operaio123!)
```

## 3. Frontend (PWA)
```bash
cd packages/frontend
npm install
npm run dev            # dev server su :5173 (proxy /api -> :4000)
```
Apri `http://localhost:5173`. Da mobile: "Aggiungi a schermata home" per installare la PWA.

Build di produzione:
```bash
npm run build          # output in dist/ (service worker PWA incluso)
npm run preview        # serve la build
```

## Ruoli
- **admin** (max 3 per azienda, hard-block al 4°): gestisce cantieri, utenti, vede i report
- **project_manager**: come admin per la gestione cantieri
- **operaio**: vede TUTTI i cantieri, inserisce SOLO le proprie ore + lavoro + materiali,
  permessi/ferie, vede e modifica/cancella solo le proprie registrazioni
- altri ruoli (resource, qa, stakeholder): lettura limitata

## Flusso dati
```
Azienda (companyId)
  └─ Cantiere (project)
       └─ Lavoro (task)
            └─ Ore (time_log)  ← l'operaio registra qui
                 └─ Materiali (time_log_materials)
```
Report: `GET /api/v1/reports/hours-by-project` e `/hours-by-user` (solo admin/PM).

## Stato MVP
- ✅ F1 multi-tenant isolato
- ✅ Limite 3 admin per azienda
- ✅ workDescription + materiali per commessa
- ✅ F2 ruolo operaio (backend + frontend mobile)
- ✅ F5 frontend (login + dashboard azienda)
- ✅ F6 dashboard operaio (inserisce ore)
- ✅ F7 report (ore per commessa / operaio)
- 🔜 F9 (dopo MVP): billing (Stripe/PayPal), deploy, registrazione pubblica autonoma

## Sicurezza
- Le API key/secret NON vanno mai in chat né in git. Usa `.env` (già in `.gitignore`).
- L'isolamento multi-tenant è garantito da `companyId` su ogni query lato backend.
- L'operaio non può né leggere né modificare le ore di colleghi (403 enforced).
