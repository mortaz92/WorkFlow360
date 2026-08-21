# WorkFlow360 — context for frontend (F5/F6 PWA)

## Obiettivo
Costruire il frontend PWA (React + Vite + TypeScript) in `packages/frontend` che consuma il
backend Express già completo in `packages/backend`. Il backend gira su `http://localhost:4000`
(API base: `http://localhost:4000/api/v1`). CORS consentito per `http://localhost:5173`.

## Stack richiesto
- **Vite** + **React 18** + **TypeScript** (strict).
- **React Router v6** per il routing.
- **vite-plugin-pwa** per il service worker (PWA installabile, funziona offline lato cache UI).
- Chiamate API con `fetch` (niente axios se non necessario) o `ky`. Gestire token JWT in
  `localStorage` (chiave `wf360_token`).
- **No** librerie UI pesanti se non necessario; usare CSS semplice o Tailwind (se facile da
  aggiungere). Preferire qualcosa di mobile-first perché gli operai useranno lo smartphone.

## API backend (riassunto — tutti gli endpoint richiedono `Authorization: Bearer <token>`)

### Auth
- `POST /api/v1/auth/login`  body: `{ email, password }` → `{ token, user: { id, email, role, companyId } }`
- Ruoli possibili: `admin`, `project_manager`, `resource`, `qa`, `stakeholder`, `operaio`.
- `POST /api/v1/auth/forgot-password` body: `{ email }` → sempre `200` con lo stesso messaggio,
  esista o no l'email (anti-enumerazione). Se l'utente esiste ed è attivo, invia un'email via
  Resend con un link di reset (`RESEND_API_KEY` facoltativa: senza, il backend si avvia comunque
  e logga soltanto). Rate-limited (5/15min).
- `POST /api/v1/auth/reset-password` body: `{ token, password }` → `204`, oppure `401` generico
  per qualunque motivo di rifiuto (token inesistente/scaduto/già usato, utente disattivato — mai
  distinto; stesso codice già usato per un refresh token invalido). Revoca tutti i refresh token
  dell'utente. Rate-limited (10/15min).

### Users (solo admin; max 3 admin per azienda, hard-limit 409)
- `GET /api/v1/users` → lista utenti della propria azienda (paginato: page, limit)
- `POST /api/v1/users` body: `{ email, name, role, password }` → crea utente (solo admin)
- `GET /api/v1/users/:id`, `PATCH /api/v1/users/:id`, `DELETE /api/v1/users/:id` (soft delete)

### Companies
- `GET /api/v1/companies` → elenco aziende (catalogo globale)
- `POST /api/v1/companies` body: `{ name, vat?, email?, phone?, address? }` → crea azienda

### Projects (cantieri) — tutti gli autenticati possono leggere
- `GET /api/v1/projects` → cantieri della propria azienda
- `POST /api/v1/projects` body: `{ name, code?, tipo: 'contratto'|'consuntivo', clientName?, address?, status? }`
- `GET /api/v1/projects/:id`, `PATCH`, `DELETE`

### Tasks (lavori nei cantieri)
- `GET /api/v1/tasks?projectId=`, `POST /api/v1/tasks` (richiede projectId), `GET/PATCH /api/v1/tasks/:id`.
- `assignedTo` (uuid dell'operaio, o `null` per disassegnare) in `POST`/`PATCH`: solo admin/project_manager
  possono impostarlo, e solo a un operaio **attivo della stessa azienda** (`assertAssignableUser`
  in tasks.service.ts — 404 se non qualifica, non un 403: il modello è "non trovato tra gli
  assegnabili", non "permesso negato"). La risposta include sempre `assignedToName` (risolto
  server-side con un leftJoin), mai da ricostruire lato client incrociando altre liste.
- `GET /api/v1/tasks/assignable-users` (solo admin/project_manager) → `{ users: [{id, name}] }`,
  SOLO operai attivi dell'azienda: popola la dropdown "Assegna a" senza esporre l'elenco
  utenti completo (quello è riservato ad admin via `/users`).

### Time logs (consuntivi ore) — **centrale per l'operaio**
- `GET /api/v1/time-logs` → lista ore. **Un operaio vede SOLO le proprie**; admin/PM vedono tutto
  (o solo quelle di un utente con `?userId=`).
- `POST /api/v1/time-logs` body:
  ```json
  {
    "taskId": "uuid",
    "hoursWorked": "3.5",
    "date": "2026-08-09",
    "tipo": "ordinario",          // opzionale, default 'ordinario'
    "startTime": "08:00",         // facoltativo anche con tipo 'ordinario' (dal 19/08): se
                                   // presente alimenta il calcolo automatico della fascia
                                   // notturna/straordinario, se assente nessun automatismo
                                   // scatta e le ore restano integralmente nel tipo scelto
    "endTime": "17:00",           // sempre facoltativo, per qualunque tipo: solo informativo,
                                   // non entra in alcun calcolo — null su ogni riga se la
                                   // registrazione viene divisa in più porzioni (vedi sotto)
    "workDescription": "stringa", // COSA ha fatto l'operaio
    "notes": "stringa",
    "materials": [                // lista materiali usati
      { "name": "Tubo rame", "quantity": "6", "unit": "m" }
    ]
  }
  ```
  - `tipo` ∈ `ordinario|straordinario|notturno|festivo|permesso|ferie`
  - L'**operaio NON invia `userId`**: il backend lo forza al proprio id. Gli admin/PM possono
    passare `userId` per conto di altri; se lo omettono registrano per sé stessi (non un errore).
  - Risposta: **`{ timeLogs: [...] }`**, un array — una registrazione 'ordinario' oltre le 8h/notte
    diventa 2-3 righe reali (ordinario/notturno/straordinario), create automaticamente.
- `GET /api/v1/time-logs/:id`, `PATCH /api/v1/time-logs/:id`, `DELETE /api/v1/time-logs/:id`
  - Operaio può modificare/cancellare SOLO le proprie righe (403 se tocca quelle altrui).
  - `PATCH` accetta `startTime`/`endTime`/`workDescription`/`notes` anche a `null` esplicito per
    cancellarli (il frontend deve inviare `null`, non omettere il campo: omesso = "non toccare").
  - Risposta: `{ timeLog: { id, taskId, userId, tipo, hoursWorked, date, startTime, endTime, workDescription, notes, materials: [{id,name,quantity,unit}], createdAt } }` (singolare — PATCH aggiorna sempre UNA riga già esistente, non rifà lo split).

### Corrections (correzioni ore)
- `GET/POST /api/v1/corrections` — gestione correzioni (admin/PM).

### Audit logs
- `GET /api/v1/audit-logs` — solo admin/PM.

## Regole multi-tenant (IMPORTANTE)
- Ogni azienda è isolata: i dati non si incrociano MAI. Il token JWT contiene `companyId`.
- L'operaio vede TUTTI i cantieri (projects) della sua azienda, ma SOLO le proprie ore.

## Cosa fare in F5 (questa fase)
1. Setup Vite + React + TS + vite-plugin-pwa in `packages/frontend` (con `package.json`,
   `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`).
2. Client API (`src/lib/api.ts`) con fetch + gestione token + refresh.
3. **Pagina di Login** (email + password) → salva token, redirect alla dashboard.
4. **Dashboard azienda** (vista admin): elenco cantieri (projects), pulsante "nuovo cantiere",
   elenco utenti (users), form creazione utente/cantiere. Mobile-first.
5. Routing protetto: se non loggato → login; se loggato → dashboard.
6. **NON** implementare ancora la vista operaio dettagliata (quella è F6), ma il login deve
   funzionare per QUALSIASI ruolo e mostrare la dashboard di base.
7. `npm install` e `npm run build` devono passare senza errori TS.
8. Scrivere un `README` breve con come avviare (`npm run dev` su :5173, backend su :4000).

## Stato frontend (aggiornato — tutto gia' fatto)
- F5: login + dashboard azienda (Cantieri + Utenti + bottone Report) — `src/pages/DashboardPage.tsx`
- F6: dashboard operaio (`/operaio`) — `src/pages/OperaioPage.tsx`
- F7: report (`/report`) — `src/pages/ReportPage.tsx` (link nella dashboard admin)
- F10: nella dashboard admin, sotto ogni cantiere c'e' il form "aggiungi lavoro" che crea un
  task (`POST /tasks`) e mostra i lavori esistenti. L'admin gestisce l'intero ciclo
  cantiere -> lavoro -> dipendente senza toccare il backend/DB manualmente.

## DA FARE (priorita' da concordare con l'utente)
- **RESTYLE FRONTEND PROFESSIONALE**: l'UI attuale e' funzionale ma grezza. L'utente vuole
  aspetto da gestionale/SaaS serio. Valutare Tailwind + sidebar + card + tabelle styled.
  CHIEDERE CONFERMA SULLO STILE (colori, sidebar vs topbar, chiaro/scuro) prima di rifare tutto.
- Registrazione pubblica autonoma (decisa ma non fatta): sicurezza automatica.
- F9: billing (Stripe/PayPal) + deploy.

## Vincoli
- Lingua UI: **italiano**.
- Mobile-first (gli operai usano smartphone).
- Niente backend finto: chiamare le API reali su :4000.
- Non mischiare con altri progetti: tutto dentro `packages/frontend`.
- File chiave gia' esistenti: `src/App.tsx` (routing), `src/lib/api.ts` (client),
  `src/lib/types.ts` (tipi), `src/pages/{LoginPage,DashboardPage,OperaioPage,ReportPage}.tsx`.
- Verifica: `npm run build` deve compilare TS strict; il dev server gira con `npm run dev --host`.
