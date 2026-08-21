# WorkFlow360 — Piano MVP (SaaS gestione ore operai)

> **Scopo:** trasformare il backend già esistente in un SaaS vendibile ad aziende di
> manutenzione/costruzioni. L'azienda (utente) gestisce commesse e vede le ore dei
> suoi operai; l'operaio inserisce le sue ore da telefono/PC.
> Generato da Hermes Agent l'08/08/2026 leggendo lo stato reale su disco.

---

## 1. Modello di funzionamento (confermato)

```
AZIENDA (utente/admin)                 OPERAIO (lavoratore)
├── crea commesse                       ├── vede TUTTI i cantieri dell'azienda
│   (a contratto / a consuntivo)        ├── inserisce ore per cantiere:
├── crea operai (sub-account)           │     · ordinario / straordinario
└── vede ore di TUTTI i suoi operai     │     · notturno / festivo
    → report per commessa / operaio     ├── inserisce permessi e ferie
                                        ├── vede storico delle sue ore
                                        └── modifica le sue ore (errori)
```

- 📱 **Mobile + PC**: unica PWA React (stessa app, stesso codice) → funziona su
  Android, Windows, iPhone, Mac, qualsiasi OS con browser. Si "installa" come app.
- 🏢 **Multi-tenant**: Neotekna SRL ≠ Perluce SRL → zero dati in comune.
- 🔒 **Operaio vede solo il suo**: dashboard filtrata per sé.
- 💳 **Billing**: NON ora. Si attiva solo quando il lavoro funziona.

---

## 2. Cosa riusiamo dal backend esistente (GIA FATTO, 74 test verdi)

| Modulo | Stato | Riuso per MVP |
|---|---|---|
| auth (JWT) | ✅ | Login azienda + operaio |
| users + ruoli | ✅ | Base, da aggiungere ruolo `operaio` |
| projects (commesse) | ✅ | Commesse a contratto/consuntivo |
| tasks | ✅ | (opzionale MVP) |
| timeLogs (ore) | ✅ | Base ore, da estendere con tipi |
| corrections | ✅ | (fase successiva) |
| auditLog | ✅ | Già append-only |

**Non ricominciamo da zero: il 70% del backend c'è.**

---

## 3. Cosa MANCA (dettagliato)

### A. Ruolo `operaio` (nuovo)
- Aggiungere `operaio` a `userRoleEnum` (oggi: admin, project_manager, resource, stakeholder, qa).
- Permessi operaio:
  - GET `/projects` → vede TUTTI i cantieri della sua azienda (non solo assegnati)
  - POST `/time-logs` → inserisce ore (sue)
  - PATCH `/time-logs/:id` → modifica SOLO le sue ore
  - GET `/time-logs?mine=1` → vede solo le sue
  - POST permessi/ferie (stessa tabella, tipo dedicato)
  - GET storico proprio

### B. Estensione schema (ore + commesse)
`projects`:
- `tipo_commessa: enum('contratto','consuntivo')` (default consuntivo)
  → **SOLO etichetta, nessun prezzo/importo nel DB**. L'operaio vede su che cantiere
  lavora e capisce da solo se è contratto o consuntivo. L'azienda non inserisce prezzi.
- `company_id` (multi-tenant, v. punto C)

`timeLogs` (riformato):
- `tipo: enum('ordinario','straordinario','notturno','festivo','permesso','ferie')`
  → **UNICA tabella** per tutte le registrazioni. È l'operaio a scegliere cosa
  inserire (ora di quale tipo, oppure permesso/ferie). Nessuna tabella separata.
- `company_id`
- mantenere `hoursWorked`, `date`, `notes`, `taskId` (taskId opzionale per MVP)
- ⚠️ Oggi `timeLogs.hoursWorked` è `numeric(10,2)` e `userId` ha `onDelete:'restrict'`
  → va bene, ma va aggiunto `tipo` e reso coerente con permessi/ferie.

### C. Multi-tenant (BLOCANTE per vendere)
- Aggiungere `company_id` a: users, projects, tasks, timeLogs, corrections, auditLog.
- Nuovo modulo `companies/` (creazione azienda, profilo).
- Middleware `requireCompanyScope`: ogni query filtra per `company_id` dell'utente
  loggato. Nessuna query "global".
- Seed/primo avvio: crea la prima azienda e il primo admin.

### D. Permessi "operaio = solo sue ore"
- In `timeLogs.service`: `listTimeLogs` e `updateTimeLog` devono filtrare per
  `userId === req.user.id` quando il ruolo è `operaio`.
- L'azienda (admin/PM) vede tutto di `company_id` suo.

### E. Frontend PWA (TUTTO DA ZERO)
`packages/frontend` oggi è placeholder vuoto. Da costruire:
- **Setup**: Vite + React + TypeScript + React Router + React Query
- **Auth**: login (JWT access + refresh in cookie httpOnly)
- **Dashboard Azienda** (PC/tablet):
  - lista commesse (filtro contratto/consuntivo)
  - crea commessa / crea operaio
  - vista ore per operaio e per commessa
  - report (totale ore per tipo, per commessa) — CSV/PDF base
- **Dashboard Operaio** (mobile-first):
  - lista cantieri (tutti della sua azienda)
  - form inserimento ora (tipo + data + note) con pochi tap
  - inserimento permesso/ferie
  - storico personale + modifica

### F. Billing — DOPO (non MVP)
Stripe/PayPal solo quando il prodotto funziona. Non blocca.

---

## 4. Piano a fasi (senza salti)

| Fase | Lavoro | Output | Complessità | Stato |
|---|---|---|---|---|
| **F1** | Multi-tenant: `company_id` + modulo `companies` + middleware scoping + filtro service | Aziende isolate (Neotekna ≠ Perluce) | media | ✅ FATTO (78/78 test) |
| **F2** | Ruolo `operaio` + permessi "solo sue ore" | Operaio vede cantieri, inserisce le proprie ore/lavoro/materiali | bassa/media | ✅ FATTO |
| **F3** | Estensione schema `tipo_commessa`, `tipo` ore, permessi/ferie | Dati completi | media | ✅ FATTO dentro F1 |
| **F4** | Test backend estesi (multi-tenant + operaio) | Verifica reale | — | ✅ FATTO |
| **F5** | Frontend PWA — setup + auth + dashboard azienda | Azienda usa l'app (login, cantieri, utenti) | alta | ✅ FATTO |
| **F6** | Frontend PWA — dashboard operaio (mobile) | Operaio inserisce ore+lavoro+materiali | alta | ✅ FATTO |
| **F7** | Report base (ore per commessa/operaio) | Valore per l'azienda | media | ✅ FATTO |
| **F8** | Verifica end-to-end locale + istruzioni avvio | MVP pronto | — | ✅ FATTO |
| **F10** | UI admin: creazione lavori (task) nel cantiere | Admin gestisce ciclo completo | bassa | ✅ FATTO |
| **F9** | (dopo) Billing + deploy | Vendibile | media | 🔜 |

---

## 5. Suggerimento di prezzo (per quando vendi)
- Canone per **operaio attivo**: 5–10 €/mese (es. 10 operai = 50–100 €/mese azienda)
- Oppure canone fisso azienda + extra per operaio
- Il valore è: sapere quanto costa ogni cantiere (consuntivo) vs quanto incassi (contratto).

---

## 6. Note / decisioni da confermare
- **"A contatto"** interpretato come **"a contratto"** (prezzo fisso) vs "a consuntivo"
  (ore fatte). Confermato da utente l'08/08.
- **Permessi/ferie**: gestiti nella stessa tabella `timeLogs` col `tipo` dedicato
  (scelta consigliata per semplicità). Da confermare.
- **Mobile**: PWA (non app nativa) per coprire tutti gli OS con un solo codice.
- **Billing**: disattivato finché il lavoro non funziona (scelta utente).
- **Registrazione azienda**: self-service AUTONOMA (nessuna approvazione manuale da parte
  dell'admin-SaaS). Sicurezza automatica: email reale + no domini disposable + conferma
  email + Turnstile (CAPTCHA) + rate-limit IP + honeypot + isolamento multi-tenant (F1).
- **Limite 3 account admin per azienda** (es. 3 soci): `MAX_USERS_PER_COMPANY = 3`,
  hard-block al 4° admin con 409 CONFLICT. Gli altri ruoli (operai, resource, qa,
  project_manager) sono illimitati. Tutti gli admin hanno la stessa libertà. (Fatto)
- **Campo "lavoro svolto" + tabella materiali**: `time_logs.work_description` (testo
  libero, l'operaio descrive cosa ha fatto, indipendente da contratto/consuntivo) +
  tabella `time_log_materials` (nome, quantità, unità) per la lista materiali usati in
  cantiere. Strutturata per report "materiale per commessa". (Fatto)
- **F7 report (fatto)**: modulo backend `reports` con `GET /reports/hours-by-project` e
  `/hours-by-user` (solo admin/PM, 403 per operaio). Aggregazioni SQL con breakdown per tipo
  (ordinario/straordinario/notturno/festivo/permesso/ferie). Frontend: pagina `/report` con due
  tabelle, link dalla dashboard admin. Backend 93/93 test verdi. Verificato nel browser reale.
 - **F8 verifica + istruzioni (fatto)**: README.md con setup completo (Docker Postgres, migrate,
 backend :4000, frontend :5173 PWA, seed). Flusso dati Project→Task→TimeLog documentato.
 Verifica end-to-end nel browser: admin login → report; operaio login → inserisce ore.
 - **F6 ruolo operaio (fatto)**: dashboard operaio mobile-first. Login reindirizza gli `operaio` su
 `/operaio` (altri ruoli su `/dashboard`). L'operaio seleziona cantiere → task (lavoro) →
 registra ore (tipo: ordinario/straordinario/notturno/festivo/permesso/ferie) + lavoro svolto +
 materiali dinamici. Vede SOLO le proprie registrazioni, con Modifica/Elimina. Il `taskId` inviato
 è un TASK reale (non il project): il modello è Project→Task→TimeLog. Verificato nel browser reale.
 - **F10 creazione lavori nella dashboard admin (fatto)**: la DashboardPage admin ora carica i
 task di ogni cantiere (`GET /tasks?projectId=`) e mostra un form "aggiungi lavoro" sotto ciascun
 cantiere (`POST /tasks`). Così l'admin gestisce l'intero ciclo: cantiere -> lavoro -> dipendente.
 Verificato nel browser reale.

 - **RESTYLE FRONTEND PROFESSIONALE (fatto, 09/08)**: Tailwind v4 (`@tailwindcss/vite`, zero
 config), sidebar fissa a sinistra per Dashboard/Report (collassa a hamburger overlay sotto i
 1024px), OperaioPage resta senza sidebar (mobile-first, confermato con l'utente). Palette blu
 professionale + grigi (coincide quasi esattamente con la scala di default Tailwind, nessun
 `@theme` custom necessario). Corrette anche 2 falle scoperte durante il lavoro: icone PWA
 mancanti su disco (manifest le dichiarava, ora generate) e zoom bloccato nel viewport
 (`user-scalable=no` rimosso — problema di accessibilità per operai in cantiere con
 guanti/sole). Corretto anche un bug reale preesistente nel selettore cantiere/lavoro
 dell'OperaioPage (race condition su stato React) trovato dal controllo multi-agente.
 Verificato end-to-end nel browser reale (login admin e operaio, creazione cantiere/lavoro,
 registrazione ore) e con `npm run build`/`tsc -b` puliti. Dettagli completi in `.claude/memory/session.md`.

 ## 8. Cose da fare (non MVP)
- **REGISTRAZIONE PUBBLICA AUTONOMA** (decisa ma non fatta, prossimo passo): sicurezza automatica (email
  reale+disposable block, conferma, Turnstile, rate-limit IP, honeypot).
- **F9: billing (Stripe/PayPal) + deploy** (post-MVP).
- **⚠️ Backend non compila in produzione**: `npm run build` (packages/backend) = `tsc -p
  tsconfig.json`, che fallisce con ~20 errori TypeScript reali (companyId mancante in vari
  punti, un import rotto in core/tenant.ts, tipi non allineati in reports.service.ts e
  timeLogs.routes.ts). `npm run dev` (tsx) e i test (vitest) non fanno type-check completo,
  per questo il problema è passato inosservato finché non si è lanciato `tsc --noEmit` per
  caso. Da risolvere PRIMA di qualsiasi deploy reale (Fase 9) — vedi registro-attriti.md.

---

## 7. Prossimo passo
Avviare **F1 (multi-tenant)** sul backend esistente, poi F2/F3, testare, e infine
il frontend (F5/F6). Ogni fase verificata con test reali contro PostgreSQL.
