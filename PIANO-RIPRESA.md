# WORKFLOW360 — Piano di Ripresa

> **Scopo:** riallineare lo stato dopo l'interruzione per limite token e definire
> il prossimo passo concreto. Generato da Hermes Agent il 2026-08-08 leggendo i file reali.
> Nessun codice viene scritto qui: è solo piano + verifica.

## 1. Dove ci siamo fermati (da session.md, 05/08/2026)
- ✅ **Fase 1-3** Setup infrastrutturale: monorepo, Express+TS, Drizzle+7 tabelle, middleware sicurezza, health check reale.
- ✅ **Fase 4-6** Autenticazione: modulo `auth/` completo (login/refresh/logout/me), JWT access+refresh con rotazione e revoca, rate-limit dedicato, 11 test Vitest verdi.
- ⏭️ **Fase 7-9** Gestione Utenti e Ruoli = **PROSSIMO PASSO (non iniziata)**.
- 🕳️ Frontend = placeholder vuoto (previsto Fase 10-12).

## 2. Cosa esiste davvero su disco (verificato oggi)
```
backend/src/modules/auth/   → routes, service, middleware, types, test  (COMPLETO)
backend/src/modules/users/  → routes, service, types, test             (COMPLETO, ma solo utente di test)
backend/src/core/           → config, errors, middleware, db (schema 7 tabelle, seed)
backend/drizzle/            → 2 migrazioni (0000, 0001) + meta
schema tabelle: users, projects, tasks, time_logs, corrections, audit_log, refresh_tokens
frontend/                   → SOLO package.json placeholder (nessun codice)
.claude/memory/session.md   → aggiornato e dettagliato (ottimo)
```

⚠️ **Nota migrazioni:** session.md dice "3 file migrazioni", su disco ne ho viste 2
(`0000_old_miracleman.sql`, `0001_dashing_darwin.sql`) + `meta/`. Da verificare all'avvio
che lo schema sia coerente (specialmente il campo `role` su `users` che Fase 7-9 deve aggiungere).

## 3. PRE-REQUISITI per riprendere
- [ ] **Docker Desktop** installato e avviato (per PostgreSQL via `npm run db:up`).
      → Docker NON è stato verificato sulla macchina. Da controllare prima di Fase 7-9.
- [ ] `.env` presente (session.md dice già rigenerato con secret 32-byte). Verificare esista.
- [ ] `npm install` alla radice (monorepo workspaces) eseguito.
- [ ] Decidire se il campo `role` va aggiunto ora a `users` (nuova migrazione Drizzle).

## 4. PIANO FASE 7-9 — Gestione Utenti e Ruoli (prossimo passo)
Segui il pattern PIATTO già usato (no sotto-cartelle):

1. **Enum ruoli** → `users.types.ts` o `core/constants.ts`: `admin | manager | developer | client | qa`
2. **Migrazione Drizzle** → aggiunge `role` (default `developer`) a `users` + (se serve) tabella `roles`.
3. **`users.service.ts`** → CRUD: create (solo admin), list, get, update, deactivate (`active=false`, NON delete per tracciabilità).
4. **`users.routes.ts`** → `POST/GET/GET :id/PATCH/DELETE /api/v1/users/*`.
5. **`requireRole(...)`** in `auth.middleware.ts` → estende `requireAuth`.
6. **Protezione** → rotte `/users/*` con `requireAuth` + `requireRole('admin')`.
7. **`users.test.ts`** → Vitest: CRUD + RBAC (solo admin crea, ruolo sbagliato → 403, disattivato non login).

## 5. ROADMAP (30 fasi, riassunto)
```
Fase 1-3   ✅ Setup infra
Fase 4-6   ✅ Auth
Fase 7-9   ⏭️  Utenti e Ruoli   ← RIPRENDIAMO QUI
Fase 10-12    Frontend base (React+Vite+React Query)
Fase 13-..    Progetti / Task / TimeLog / Correzioni / Audit
Fase 28-30    PWA
```

## 6. REGOLE da rispettare (da .claude/CLAUDE.md)
- Non committare senza conferma esplicita (mai `.env`, segreti).
- Fedeltà ai fatti: non inventare dati/mancanti.
- Un'astrazione nasce da 3+ casi reali (no repo layer ora).
- Aggiornare `session.md` a ogni fase (continuità).
- Pattern moduli piatto.

## 7. PROSSIMA AZIONE CONCRETA (quando riprendi)
Chiedimi: **"riprendi WorkFlow360 Fase 7-9"** → io:
1. Verifico Docker + `.env` + `npm install`.
2. Aggiungo campo `role` (migrazione).
3. Implemento modulo `users/` + `requireRole`.
4. Eseguo i test Vitest.
5. Aggiorno `session.md`.

(NON eseguo ora perché richiede Docker/Postgres e vuoi riprendere domani/quando vuoi.)
