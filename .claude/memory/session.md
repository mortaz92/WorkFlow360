# WorkFlow360 — Stato Sessione

## 24/08 (continuazione) — Audit vendibilità SaaS + i 3 punti critici trovati

Dopo il push del restyle (sezioni sotto), l'utente ha chiesto se il progetto è "vendibile come SaaS". Fatto un audit reale con 6 agenti paralleli in sola lettura (sicurezza/auth, multi-tenancy, fatturazione, legale/GDPR, test/CI/monitoraggio, documentazione), pubblicato come artifact. **Risultato onesto**: sicurezza/multi-tenancy solidi (bcrypt, JWT validati a startup, isolamento dati per company_id verificato senza rischio IDOR, `trust proxy` già corretto — chiude il punto 5 dell'handoff 21/08), ma tre buchi critici confermati: backup DB non automatico, nessuna base legale (privacy/ToS/cancellazione dati), nessuna fatturazione/onboarding self-service (quest'ultimo giudicato "importante" non "critico" per un modello a un cliente per deploy).

**L'utente ha chiesto di sistemare i 3 punti critici.** Scelte esplicite dell'utente (bottoni): backup → solo istruzioni migliori, non costruire automazione; privacy/ToS → bozza completa scritta da me con avviso "va rivista da un avvocato"; cancellazione dati → anonimizzazione (non hard-delete), per non rompere lo storico ore/fatturazione.

**Fatto:**
- **Backup**: espansa `GUIDA-DEPLOY.md` con due opzioni concrete (upgrade piano Render a pagamento, oppure backup gratuito schedulato con Task Scheduler di Windows sul PC dell'utente, passo-passo). Nessuna automazione scritta nel repo, come richiesto.
- **Privacy/ToS**: nuove `packages/frontend/src/pages/PrivacyPage.tsx` e `TermsPage.tsx`, rotte pubbliche `/privacy` e `/termini` in `App.tsx` (aggiunte anche a `PUBLIC_PATHS`), link nel footer di `LoginPage.tsx`. Contenuto scritto da zero, GDPR-informato, con placeholder `[DA COMPLETARE: ...]` ben visibili per i dati che nessuno mi ha mai fornito (ragione sociale, P.IVA, indirizzo, contatto DPO, foro competente) — **MAI inventati**. Banner giallo "Bozza non ancora validata" in cima a entrambe le pagine, che cita esplicitamente la questione dell'art. 4 Statuto dei Lavoratori (autorizzazione/accordo sindacale per strumenti che tracciano ore per cantiere) come questione SEPARATA che l'informativa da sola non risolve — segnalata all'utente anche in chat prima di scrivere il codice. **Queste pagine non vanno pubblicate/usate con clienti reali finché un avvocato non le rivede.**
- **Anonimizzazione dati (DELETE /api/v1/users/:id)**: prima era un soft-delete (`active:false`, identico a PATCH). Ora anonimizza davvero: `name:'Utente rimosso'`, email sostituita con `deleted-<id>@anonimizzato.workflow360.local` (deterministica, libera l'email vera per riuso), `department:null`, `passwordHash` sostituito con hash di un valore casuale, `active:false`, refresh token revocati nella stessa transazione, voce di audit log SENZA i vecchi dati personali. Riga utente e `role` mantenuti (ore lavorate restano collegate per obblighi contabili). Guardie anti-lockout condivise con `updateUser` tramite una nuova funzione `assertCanRemoveAdminAccess` (mai su se stessi, mai l'ultimo admin attivo dell'azienda) — refactor per non duplicare l'invariante più delicato del file. File toccati: `users.service.ts`, `users.routes.ts`, `users.test.ts` (8 nuovi test), fatto da un agente developer in background con uno spec molto preciso, poi **rivisto riga per riga da me manualmente** (non solo fidandomi del report dell'agente). Aggiunto anche il pulsante "Rimuovi definitivamente" in `DipendenteDetailPage.tsx` (prima non esisteva NESSUNA UI per cancellare un dipendente), con conferma esplicita che avvisa dell'irreversibilità, e `deleteUser` in `lib/api.ts`. Aggiornata la riga ormai falsa in `CLAUDE.md` ("DELETE... soft delete" → descrizione reale).
- **Bug reale trovato e corretto, non richiesto ma bloccante**: `components/ui/Toast.tsx` aveva `import React from 'react'` in fondo al file invece che in cima — causava `Cannot access 'React' before initialization` e rompeva l'INTERA app in `npm run dev` (probabile motivo per cui la verifica visiva del restyle esteso, sessione precedente, non era mai stata fatta). Corretto spostando l'import in cima.

**⚠️ NON verificato con test automatici, da dire chiaramente**: Docker Desktop non è mai partito in questo ambiente (stesso problema della sessione precedente — motore WSL `docker-desktop` resta `Stopped`, `docker ps`/`docker info` restano appesi), confermato con DUE tentativi indipendenti (l'agente developer + un mio poll separato, ~5 minuti di retry ciascuno). **I test vitest per l'anonimizzazione non sono mai stati eseguiti** (falliscono tutti in `beforeAll` con `ECONNREFUSED 127.0.0.1:5432`, insieme a TUTTA la suite esistente — non è un problema introdotto da questa sessione). Compensato con: `npx tsc --noEmit` pulito (verificato da me in autonomia, non solo dall'agente) sia su backend che frontend, `vite build` di produzione pulito (66 moduli, +2 rispetto alla baseline per le due nuove pagine), verifica visiva reale nel browser di `/privacy`, `/termini` e del footer di `/login` (contenuto renderizzato, link funzionanti), e una revisione manuale riga-per-riga della logica di `anonymizeUser`/`assertCanRemoveAdminAccess` e dei suoi 8 test — nessun difetto trovato, ma questa NON è una prova pari a un test eseguito con successo.

**Commit creato dopo questa nota** (vedi sezione successiva): hash `1698c9f`, solo locale, non pushato.

## 24/08 (continuazione 2) — Docker sbloccato, gli 8 test dell'anonimizzazione girati DAVVERO

**Causa reale del blocco Docker, trovata leggendo i log invece di ritentare alla cieca** (log in `%LOCALAPPDATA%\Docker\log\host\com.docker.backend.exe.log`): il motore crashava sempre allo stesso punto, `starting services: initializing Inference manager: listening on unix://C:/Users/morta/AppData/Local/Docker/run/dockerInference: remove ...: The file cannot be accessed by the system.` — un file socket Unix residuo in `%LOCALAPPDATA%\Docker\run\` (insieme a `dockerEthernetVfkit` e `userAnalyticsOtlpHttp.sock`) che Windows non riusciva a cancellare (né `rm`, né `Remove-Item` con processi Docker terminati, stesso errore "Impossibile accedere al file" — non era un problema di lock, il tipo di file socket-Unix-su-NTFS non è cancellabile con le API normali). **Soluzione che ha funzionato**: rinominare l'INTERA cartella `run` (operazione sulla cartella padre, non tocca i file problematici singolarmente) — `Rename-Item` riuscito dove `Remove-Item` sui singoli file falliva sempre. Poi: `taskkill` di tutti i processi Docker, rilancio di `Docker Desktop.exe` (percorso vero: `%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe`, NON `C:\Program Files\Docker\...`), Docker ricrea la cartella `run` da zero e parte pulito. **Se ricapita**: stessa procedura, non serve "Reset to factory defaults" (che Docker Desktop proponeva e che avrebbe cancellato tutto).

Con Docker su: `docker compose up -d postgres` (già configurato in `docker-compose.yml`, credenziali `workflow360`/`workflow360`, porta 5432 — combacia con `DATABASE_URL` in `.env`), poi `npx drizzle-kit migrate` in `packages/backend` (pulito, nessuna migrazione pendente), poi `npx vitest run`:

**189/189 test passati, 10 file di test, inclusi tutti e 8 i nuovi test dell'anonimizzazione** (`users.test.ts`, 26 test totali, 7.9s). Nessun fallimento, nessuno skippato. Questa è ora una verifica reale, non più solo type-check + revisione manuale — la cautela nel messaggio di commit `1698c9f` ("test mai eseguiti") è quindi superata dai fatti: sono stati eseguiti dopo, e passano tutti. Non ho ancora deciso con l'utente se modificare il messaggio del commit esistente o lasciarlo com'era e basta (la regola del progetto sconsiglia di default il git amend).

## ⚠️ RIPRESA 24/08 — trovato lavoro NON salvato di una sessione precedente (22/08), mai documentato

**Nota tecnica sull'ambiente**: sessione partita ancora una volta nel worktree SBAGLIATO (`solana-bot-web\.claude\worktrees\workflow360-render-deploy-ad4ec8`) — stesso problema già segnalato negli handoff del 20/08 e 21/08. Operato con percorsi assoluti su `C:\Users\morta\OneDrive\Skrivbord\workflow360`, mai `cd` implicito.

**Punto 1 di "Prossimi passi" (handoff 21/08) VERIFICATO CON DATI REALI, non chiedendo all'utente**: aperta `https://workflow360-web.onrender.com/login` in un browser pulito (nessuna cache locale), letto l'albero DOM reale — bottone "Mostra password" presente (`ref_8`, `type="button"`), poi controllato via JS eseguito nella pagina: `display:flex`, `visibility:visible`, `opacity:1`, rettangolo 40×42px dentro il viewport 1280×720, contiene l'SVG a forma di occhio corretto. **L'icona è deployata e funziona** — il problema del 21/08 era quasi certamente cache locale del service worker sul dispositivo dell'utente, non un bug reale.

**SCOPERTA IMPORTANTE, non presente in nessun handoff né in questo file prima d'ora**: `git status` sul repository mostra modifiche NON committate, con timestamp **22/08 (tra le 21:07 e le 21:37)** — cioè una sessione intera è avvenuta dopo l'handoff del 21/08 e non ha mai salvato/documentato nulla (nessun handoff scritto, nessuna voce in questo file, nessun commit).

Contenuto del lavoro non salvato — un restyle UI significativo:
- **Nuova cartella `packages/frontend/src/components/ui/`** (mai tracciata da git): `Badge.tsx`, `Button.tsx`, `Card.tsx`, `EmptyState.tsx`, `Input.tsx`, `Select.tsx`, `Skeleton.tsx`, `Table.tsx`, `Textarea.tsx`, `Toast.tsx`, `index.ts` — una vera e propria libreria di componenti UI, 11 file.
- **Nuovo `packages/frontend/tailwind.config.ts`** (mai tracciato): config in stile Tailwind v3 classico con scale colore custom (`primary`, `surface`, ecc.).
- **Modificati e non committati**: `AppLayout.tsx` (+250/-~90 righe), `icons.tsx` (+70), `ForgotPasswordPage.tsx` (+103/-~70), `LoginPage.tsx` (+165/-~120), `ResetPasswordPage.tsx` (+152/-~100).

**Incoerenza tecnica trovata leggendo il codice reale (non presunta)**: il progetto usa Tailwind **v4** con plugin Vite zero-config (`@tailwindcss/vite`, `index.css` con `@import "tailwindcss"` — decisione esplicita e documentata più sotto in questo file, sessione del 09/08). Il nuovo `tailwind.config.ts` è in stile v3 (oggetto `theme.extend.colors` classico). In Tailwind v4 un file `tailwind.config.ts` non viene letto automaticamente: serve una direttiva `@config "./tailwind.config.ts"` dentro `index.css`, che **non risulta modificato** (non è tra i file toccati). Quindi, allo stato attuale, quel file di configurazione con ogni probabilità **non ha alcun effetto** — la sessione del 22/08 sembra essersi interrotta a metà, prima di collegare la nuova config.

**NON toccato/deciso in autonomia** (serve una decisione dell'utente, non deducibile dal codice): se questo lavoro va ripreso e completato, rivisto, o scartato. Nessun file è stato modificato o eliminato durante questa verifica.

**Decisione dell'utente (bottoni): "Completalo ora".** Lavoro di completamento fatto in questa sessione:

- **Aggiunta la riga mancante** in `packages/frontend/src/index.css`: `@config "../tailwind.config.ts";` subito dopo `@import "tailwindcss";`. Verificato che Tailwind v4 (versione installata 4.3.3, plugin `@tailwindcss/vite`) supporta davvero questa direttiva **con un test reale, non a teoria**: build di produzione (`npm run build --workspace=packages/frontend`) e poi grep nel CSS compilato per classi che esistono SOLO nel nuovo `tailwind.config.ts` (`shadow-card`, `bg-primary-950`) — entrambe presenti nel bundle finale. Se non lo fossero state, la config sarebbe stata silenziosamente ignorata.
- **`npx tsc -b` e `vite build` puliti** (fanno parte dello script `build` del frontend) — nessun errore nei nuovi componenti `components/ui/*` né nelle pagine restilizzate.
- **Verifica visiva nel browser** (dev server locale `npm run dev:frontend` su porta 5173, workaround `nohup` sempre necessario per questo progetto — vedi note precedenti, PID del processo node: **7920**, da terminare a mano se non serve più): `/login`, `/forgot-password`, `/reset-password` renderizzano correttamente, nessun errore console legato al restyle. Dark mode verificato via `prefers-color-scheme` (sfondo `rgb(10,10,10)` = `surface-950` in dark, `rgb(250,250,250)` = `surface-50` in light — coincide esattamente con i valori del nuovo `tailwind.config.ts`, non dedotto). Toggle mostra/nascondi password in `LoginPage.tsx` e `ResetPasswordPage.tsx` verificato funzionante (l'attributo `type` dell'input cambia realmente tra `password`/`text`).
- **Login locale testato**: risposta 500 attesa e non allarmante — Docker/Postgres non erano attivi in questa sessione (`docker ps` fallito, demone non in esecuzione) e il backend locale (`dev:backend`) non è stato avviato, quindi il proxy Vite su `/api/v1/auth/login` non aveva nulla dietro. **Nessun dato reale è uscito verso l'esterno**: la richiesta restava su `localhost:5173`, mai verso il backend di produzione (confermato leggendo `.env` locale: `VITE_API_BASE_URL=http://localhost:4000/api/v1`). L'email admin reale comparsa nel campo durante il test era autofill del browser per l'origine locale (credenziale salvata da una sessione locale precedente), non qualcosa che ho digitato io; la password inviata era una stringa di prova inventata per il test, non quella reale.

**⚠️ IMPORTANTE, da comunicare esplicitamente all'utente — la parte NON completata**: il restyle del 22/08 copre SOLO 4 file (`LoginPage`, `ForgotPasswordPage`, `ResetPasswordPage`, `AppLayout` + `icons.tsx` + la nuova libreria `components/ui/`). **Tutte le altre pagine dell'app** (`DashboardPage`, `CantieriPage`, `CantiereDetailPage`, `DipendentiPage`, `DipendenteDetailPage`, `ReportPage`, `ArchivioPage`, `OperaioPage` e i componenti che usano, es. `TabellaOre`, `RegistroCantiere`) **restano sul vecchio sistema** (classi `.btn-primary`/`.card`/`.field` da `index.css`, palette `blue-*`/`gray-*` standard, **nessun supporto dark mode**) — verificato con un grep mirato su `DashboardPage.tsx` (zero occorrenze di `dark:`/`surface-`/`primary-600`). Conseguenza pratica: una volta loggato, l'utente vedrebbe una sidebar/header (AppLayout) con supporto dark mode accanto a pagine di contenuto che restano sempre chiare e con la vecchia palette — incoerenza visiva reale, non ipotetica. Estendere il nuovo design system al resto dell'app è un lavoro sostanzialmente più grande (8+ pagine, più componenti condivisi) e NON è stato fatto in questa sessione — decisione lasciata all'utente se/quando procedere.

**Non ancora fatto**: nessun commit. Per la regola del progetto (REGOLA PUBBLICAZIONE) commit/push passano sempre da conferma esplicita dell'utente — in attesa.

## Estensione del restyle a tutta l'app (24/08, stessa sessione) — COMPLETATA

Dopo il commit `c9198f0` (solo login/password), l'utente ha chiesto di estendere il design system al resto dell'app (bottoni: "Estendi a tutta l'app ora" + "Sì, prepara il commit"). Lanciati 5 agenti `developer` in parallelo, ciascuno su file non sovrapposti (mappatura fatta a mano leggendo gli import reali, non presunta): Dashboard (solo), Cantieri (CantieriPage+CantiereDetailPage+RegistroCantiere), Dipendenti (DipendentiPage+DipendenteDetailPage+TimeLogEditForm), Report/Archivio (ReportPage+ArchivioPage+TabellaOre condiviso), Operaio (solo, 631 righe).

**Due interruzioni prima del successo**: un primo giro è morto con errori "ENOTFOUND" su tutti e 5 (poi capito essere un crash dell'intero processo Claude Code, non un problema di rete — verificato con `git status` che nessun agente aveva scritto nulla su disco, nessun lavoro perso); un secondo giro (4 dei 5, uno dimenticato nel retry) è morto con "hit your session limit, resets 2:40pm (Europe/Rome)" — un vero limite di utilizzo, non un errore transiente. Aspettato che l'orologio locale superasse quell'orario, poi rilanciati tutti e 5 con successo.

**Bug reale trovato e corretto centralmente PRIMA che si propagasse**: l'agente Dashboard (il primo a finire) ha scoperto che `Input.tsx`/`Select.tsx`/`Textarea.tsx` in `components/ui/` non avevano MAI un bordo visibile — il preflight di Tailwind v4 azzera `border-width` di default (`border: 0 solid` su `*`), e questi 3 componenti impostavano solo il *colore* del bordo (`border-surface-300`), mai la classe `border` che ne imposta lo spessore. Verificato personalmente leggendo `node_modules/tailwindcss/preflight.css` prima di fidarmi. **Corretto in `components/ui/Input.tsx`, `Select.tsx`, `Textarea.tsx`** (aggiunta la classe `border` a `baseStyles` in tutti e tre) prima di rilanciare gli altri 4 agenti, così nessuno ha dovuto lavorarci attorno pagina per pagina. Bug preesistente dal 22/08, quindi presente anche nelle pagine login/password già committate in `c9198f0` — ora risolto per tutte.

**Secondo bug reale trovato (dall'agente Report/Archivio) e corretto centralmente**: in stampa (Report/Archivio sono le uniche pagine stampate davvero), il tema scuro del sistema operativo resta attivo nel PDF del browser — quindi testo quasi bianco (`dark:text-surface-100` e simili) su una pagina di stampa che i browser rendono comunque bianca (tolgono gli sfondi di default, ma non i colori del testo) → testo invisibile. **Corretto in `packages/frontend/src/index.css`** dentro `@media print`: forzato `color: #111827 !important` + `background-color: transparent !important` su tutto, più bordi tabella grigi fissi. Si perde la codifica a colori dei badge in stampa, accettato come compromesso: leggibilità sempre garantita è la priorità.

**Tutti e 5 gli agenti hanno finito con `npx tsc --noEmit` pulito** sui propri file, e la build centrale finale (`npm run build --workspace=packages/frontend`) è pulita su tutto: `tsc -b` + `vite build`, 64 moduli, nessun errore. `git status` conferma esattamente i 15 file attesi modificati (nessuna sovrapposizione a sorpresa tra agenti).

**Non fatto deliberatamente — segnalato, non eseguito** (REGOLA ORDINE: si segnala a consegna, non si rifattorizza di propria iniziativa mentre il rischio di regressione è concreto): le costanti di stile (`ALERT_ERRORE`, `RIGA_ELENCO`, `LINK_DETTAGLIO`, `TESTO_ATTENUATO`, ecc.) sono duplicate in 10 file — ben oltre la soglia di 3 casi reali del progetto per estrarre un'astrazione condivisa. **Verificato però che NON sono tutte byte-identiche** (es. `RIGA_ELENCO` ha `p-3`+`shadow-card` in Dashboard/Operaio ma non in CantieriPage, che ha spostato il padding sul `<Link>` esterno) — un consolidamento va fatto con attenzione, confrontando ogni valore prima di unificarlo, non con un find-and-replace. Consigliato `/ordina` come sessione dedicata futura.

**Non verificato dal vivo nel browser**: tentato avvio di Docker Desktop per un giro di login reale, non partito in tempo ragionevole (90s) — abbandonato, non insistito oltre. La verifica di questa estensione resta quindi statica (build, tipi, revisione riga per riga di ogni agente sul proprio diff), non visiva. Le pagine login/password del commit precedente erano invece state verificate dal vivo nel browser.

**Secondo commit fatto**: `d0f370b` — "style: design system esteso a tutte le pagine dell'app", 16 file (incluso session.md), tramite agente devops, nessun segreto trovato.

**PUSH ESEGUITO (24/08), CONFERMATO DALL'UTENTE A BOTTONI ("Sì, pusha")**: `git push origin master`, `c38a830..d0f370b`, fast-forward, nessun force. **Hash confermato sul remote** con `git ls-remote origin`: `d0f370bf0261f190b326cff628e6315a037fdc2d` identico su HEAD e refs/heads/master. Deploy Render ripartito automaticamente per ENTRAMBI i servizi (workflow360-api e workflow360-web, entrambi su branch master). **Non verificato l'esito del deploy** (l'agente non ha accesso al pannello Render) — da controllare nei log che le migrazioni backend partano pulite e che il frontend mostri il nuovo design system.

**Stato a fine sessione**: entrambi i commit del restyle (c9198f0 + d0f370b) sono live su GitHub e hanno fatto ripartire il deploy. I punti 2-8 di "Prossimi passi" dell'handoff originale del 21/08 (verifica stabilità login, rotazione password DB di produzione mai confermata, decisione su RESEND_API_KEY, verifica empirica trust proxy, pulizia README/CLAUDE.md, eventuale Capacitor, valutazione piano DB gratuito) restano TUTTI aperti, non toccati in questa sessione — la sessione è stata assorbita dal restyle scoperto/completato su richiesta esplicita dell'utente.


**Data e ora salvataggio:** 21/08/2026, dopo il primo DEPLOY REALE su Render (successo) + fix post-deploy

## 🎉 PRIMO DEPLOY REALE COMPLETATO (21/08) — app online e funzionante

Blueprint creato su Render (database `workflow360-db` + backend `workflow360-api` + frontend `workflow360-web`, tutti piano Free). URL pubblici: `https://workflow360-web.onrender.com` (frontend), `https://workflow360-api.onrender.com` (backend).

**Primo tentativo FALLITO** con `PostgresError: type "tipo_commessa" does not exist` — bug preesistente scoperto solo ora (drift storico: quel tipo enum esisteva già sul DB locale, creato a mano prima delle migrazioni vere, mai catturato in nessun file `.sql`). Corretto con un blocco `DO/EXCEPTION` in `drizzle/0002_yellow_salo.sql` (commit `5e8c295`), verificato sicuro da applicare a una migrazione già "superata" cronologicamente su altri DB (drizzle-orm decide solo per timestamp, mai per hash/contenuto — verificato leggendo `node_modules/drizzle-orm/pg-core/dialect.js`). **Secondo tentativo: successo**, "Migrazioni applicate con successo", servizio live.

**Poi aggiunta la rotta `PATCH /companies/:id`** (commit `a8851a8`) su richiesta esplicita dell'utente: voleva creare un'azienda demo col bootstrap per mostrarla ai clienti, ma prima non c'era modo di rinominarla dopo. Deployata con successo.

**Bootstrap del primo admin fatto** (`npm run bootstrap:admin` lanciato dall'utente dal suo PC) — MA prima ha richiesto la scoperta e correzione di 2 problemi reali:
1. **`sslmode=verify-full` non funziona con la libreria `postgres` usata dal progetto** — supporta solo `true|prefer|require` (verificato dal README della libreria in `node_modules`). Era stato consigliato `verify-full` in una sessione precedente (raccomandazione del security agent, MAI verificata contro la libreria reale) — **CORRETTO in `bootstrap-admin.ts` (commento d'uso) e `GUIDA-DEPLOY.md`: torna a `sslmode=require`.**
2. **Bug reale scoperto USANDO il sistema**: login falliva con "credenziali non valide" per l'admin appena creato. Causa: l'email è stata creata con un case diverso da quello poi digitato al login (`Gmail.com` vs `gmail.com`), e **il confronto email nel backend è case-sensitive** (nessuna normalizzazione da nessuna parte, verificato in `auth.service.ts`/`LoginPage.tsx`). **CORRETTO ALLA RADICE su richiesta esplicita dell'utente**: nuovo `core/validation.ts` con `emailSchema` (trim+lowercase prima del check di formato), usato in `users.routes.ts` (create+update) e `auth.routes.ts` (login+forgot-password) e in `bootstrap-admin.ts`/`seed-dev.ts`. **Nuova migrazione `0010_normalize_user_emails.sql`** (+ snapshot `0010`, + entry nel journal) che normalizza a minuscolo le email GIÀ salvate (incluso l'account admin appena creato in produzione) — senza questa, il fix del codice da solo non avrebbe risolto il problema per l'utente esistente.

**Bonus richiesto dall'utente**: toggle "mostra/nascondi password" (icona occhio) nel form di login (`LoginPage.tsx`) — verificato dal vivo nel browser che alterna `type="password"`/`type="text"` correttamente.

**Verificato dopo tutte le correzioni**: `npx tsc --noEmit` pulito, `npm run db:generate` → "No schema changes" (schema TS e snapshot coerenti), `npm run db:migrate` in locale → applicata senza rompere nulla, `npm test` → **182/182 verdi**, `npm run build` backend E frontend puliti.

**⚠️ SEGRETI ESPOSTI IN CHAT DURANTE QUESTA SESSIONE — l'utente ne è stato avvisato**: la password del database di produzione (l'intera External Database URL, con utente+password) è finita scritta in chiaro in chat DUE VOLTE durante il debug del bootstrap. Consigliato esplicitamente all'utente di rigenerarla da Render appena possibile — **non confermato se l'ha fatto**, da chiedere/verificare alla ripresa. Anche la password scelta per l'admin (debole, valore volutamente NON riportato in un file versionato) è finita in chat una volta prima che venisse cambiata — l'utente ha poi impostato una password diversa non vista da me per il bootstrap effettivo, quella dovrebbe essere pulita.

**[SUPERATO - GIA FATTO il 21/08, NON RIESEGUIRE]** commit + push di questo giro di fix (email case-insensitive, fix sslmode, toggle password): eseguito dall'agente devops, remote allineato su `c38a830` - vedi il blocco "PUSH #2 ESEGUITO 21/08" piu in alto in questo file. Dopo il push, il deploy Render partirà da solo (auto-deploy); verificare che `db:migrate` applichi la 0010 senza errori sul DB di produzione, poi far riprovare il login all'utente con l'email in minuscolo (dovrebbe funzionare anche con la maiuscola originale, ora che il confronto è case-insensitive).

Restano aperti da prima: verifica empirica `trust proxy` (M4 del giro security del 20/08, mai fatta), rotazione della password del DB di produzione (appena segnalata sopra, da confermare), `README.md`/`CLAUDE.md` con info superate (fuori scope).

---
**Progetto:** C:\Users\morta\OneDrive\Skrivbord\workflow360

## PUSH #2 ESEGUITO 21/08 - fix login email case-insensitive su GitHub, deploy Render ripartito

**AZIONE GIA FATTA, NON RIESEGUIRE.** `git push origin master` eseguito il 21/08 dall'agente devops, dopo conferma esplicita dell'utente a bottoni ("Si, pusha"). E' il SECONDO push della giornata: viene DOPO quello documentato piu in basso (`c4e2ddf..5e8c295`), non lo sostituisce.

- Push: `a8851a8..c38a830  master -> master`, fast-forward, nessun force. Questa volta il classificatore dei permessi NON ha bloccato il comando.
- **Hash confermato sul remote** con `git ls-remote origin`: `c38a8304a10915bc100e217f2591cd19c8e6181e` sia su `HEAD` sia su `refs/heads/master` - identico al locale, allineamento verificato e non dedotto. `git status` mostra `## master...origin/master` senza "ahead".
- Commit pushati (2): `4d1ea12` (login email case-insensitive: nuovo `core/validation.ts`, rotte auth+users, `bootstrap-admin.ts`/`seed-dev.ts`, migrazione `0010_normalize_user_emails.sql` con snapshot e journal, toggle occhio in `LoginPage.tsx`, `sslmode=require` in `GUIDA-DEPLOY.md`) e `c38a830` (correzione della data nei commenti). Totale 10 file, +1491/-26 righe.
- Controllo segreti rifatto sul diff prima del push: nessun `.env`, nessuna chiave. Gli unici match della scansione sono nomi di variabili, un `DATABASE_URL` placeholder nella guida e la password demo `Admin123!` in `seed-dev.ts` - preesistente (non introdotta da questi commit) e protetta da `refuseIfNotLocal()`.
- Conseguenza: Render fa auto-deploy su ogni push a `master`, quindi il deploy del backend e ripartito da solo al momento del push, senza altre azioni.

**PROSSIMO PASSO ESATTO**: verificare nel log di deploy Render che `db:migrate` applichi la migrazione `0010` senza errori sul DB di produzione, poi far riprovare il login all'utente (deve funzionare sia con l'email tutta minuscola sia con la maiuscola originale). L'agente non ha accesso al pannello Render: quella verifica la fa l'utente. Avvertenza gia imparata al push precedente: una sonda su `/api/v1/health` subito dopo il push NON dimostra che sia in linea la build nuova, Render tiene su la vecchia istanza finche la nuova non e pronta.

**NON VERIFICATO, resta aperto**: rotazione della password del DB di produzione esposta in chat (segnalata all'utente, mai confermata); verifica empirica di `trust proxy` (M4 del giro security del 20/08).

---


## PUSH ESEGUITO 21/08 — il codice e su GitHub, il deploy Render e ripartito

**AZIONE GIA FATTA, NON RIESEGUIRE.** `git push origin master` eseguito il 21/08 dall'agente devops, dopo conferma esplicita dell'utente a bottoni ("Si, pusha"). Aggiorna e supera le note piu in basso che dicono "nessun remote configurato" e "deploy vero NON ancora iniziato": erano vere il 20/08, non lo sono piu.

- Remote: `origin` = https://github.com/mortaz92/WorkFlow360.git (branch `master`).
- Push: `c4e2ddf..5e8c295  master -> master`, fast-forward, nessun force.
- **Hash confermato sul remote** con `git ls-remote origin`: `5e8c295860ce66252f8ec16fb5e4b7d467006243` sia su `HEAD` sia su `refs/heads/master` — identico al locale, allineamento verificato non dedotto.
- Contenuto pushato: il fix migrazione `5e8c295` ("fix: crea il tipo enum tipo_commessa nella migrazione che lo usa"), 1 solo file (`packages/backend/drizzle/0002_yellow_salo.sql`, +12 righe). Controllo segreti rifatto sul commit prima del push: nessun file sensibile.
- Conseguenza: **Render fa auto-deploy su ogni push a `master`** — il deploy e ripartito da solo al momento del push, senza altre azioni.

**PROSSIMO PASSO ESATTO**: verificare l'esito del deploy sul pannello Render (log del build e del `migrate`) e che il backend risponda su `/api/v1/health`. L'agente non ha accesso a Render: la verifica dei log la fa l'utente, oppure si controlla l'endpoint pubblico quando l'URL e noto. Il punto che il fix doveva risolvere era `PostgresError: type "tipo_commessa" does not exist` durante le migrazioni: se ricompare, il fix non ha coperto il caso.

**Resta aperto e NON fatto**: la verifica empirica di `trust proxy: 1` (M4 del giro security) — richiede il servizio vivo, si fa dopo che il deploy e confermato ok.

**Non committato**: questo file (`session.md`) risulta modificato nell'albero di lavoro. Le modifiche sono solo note di sessione, nessun codice.

**Sonda health fatta subito dopo il push (dato grezzo, con il suo limite)**: `GET https://workflow360-api.onrender.com/api/v1/health` -> **HTTP 200 in 0,31s**, corpo `{"status":"ok","env":"production","db":"connected"}`. Due avvertenze da non perdere: (1) quell'URL non e stato fornito dall'utente, l'ho **dedotto** dal nome servizio `workflow360-api` in `render.yaml` — plausibile, non confermato; (2) una risposta 200 a ~2 minuti dal push, senza cold start, **non dimostra che sia gia in linea la build del commit `5e8c295`**: quasi certamente risponde l'istanza precedente, Render tiene su la vecchia finche la nuova non e pronta. Quindi: il servizio e vivo e il database raggiungibile, **ma l'esito del fix migrazione resta da verificare** nel log di deploy Render (o risondando l'endpoint quando il deploy risulta completato).

## 🚀 NUOVO TEMA APERTO 20/08 — deploy pubblico su Render + PWA

**PRIMO COMMIT FATTO (20/08, tramite l'agente `devops` come da regola)**: hash `45af9c706fa6ab67b5b2f17b4676b00ae7e69c3d` (`45af9c7`), branch `master`, 148 file / 37.548 righe. Nessun remote configurato → commit puramente locale, nessun push fatto né possibile. Controllo segreti indipendente fatto da devops su 4 livelli (nomi file sensibili, `.env` reale escluso via `.gitignore`, scansione pattern chiavi API/PostgreSQL/private key nei 148 file, credenziali hardcoded nei test) — **zero segreti trovati**. `.gitignore` corretto PRIMA del commit: aggiunte `.env.*` + `!.env.example` (prima copriva solo il file esatto `.env`) e `dev-dist/`. `package-lock.json` incluso (serve per `npm ci` nel deploy).

**Nota minore non ancora decisa**: `.claude/memory/session.md.backup` è entrato nel commit — non è un segreto, solo un backup manuale ora ridondante (la storia la tiene git da qui in avanti). Da chiedere all'utente se toglierlo con un commit di pulizia dedicato, non deciso di mia iniziativa.

**Ordine seguito su richiesta esplicita dell'utente**: PRIMA il commit dello stato attuale (fatto ora), POI la FASE 0 del piano (correzioni al codice) — invertito rispetto al mio primo suggerimento, ma è esattamente quello che l'architect aveva consigliato ("due commit distinti: 1) stato attuale, 2) preparazione al deploy").

## ✅ FASE 0 COMPLETATA (20/08) — correzioni applicate, verificate, SECOND0 COMMIT NON ANCORA FATTO

**Implementazione fatta dall'agente `developer`**, poi **rivista a mano da me file per file** (non solo fidandosi del suo report), poi **security review indipendente dall'agente `security`** (ha trovato problemi REALI verificati, non ipotesi — 1 ALTO, 5 MEDI, 5 BASSI), tutti corretti da me subito dopo. Poi un agente `reviewer` per l'ultimo controllo di qualità (lanciato in background, esito non ancora arrivato quando questo file è stato scritto — controllare se ha trovato altro).

**File creati**: `packages/backend/scripts/bootstrap-admin.ts`, `render.yaml`, `.node-version` (contenuto `24` — nota: `@types/node` è `^20`, disallineamento minore, non bloccante), `GUIDA-DEPLOY.md`.
**File eliminato**: `packages/backend/src/core/db/seed.ts` (bug preesistente, mai eseguibile, sostituito da `scripts/seed-dev.ts`).
**File modificati**: `core/tenant.ts` (fix import), `core/errors/ConflictError.ts` (fix tipo), `app.ts`, `scripts/seed-dev.ts`, `core/config/index.ts`, `packages/backend/package.json`, `packages/frontend/src/lib/api.ts`, `vite.config.ts`, `index.html`, `.env.example`, `.gitignore`.

**Verificato con dati reali (non presunto)**: Docker/Postgres si era fermato durante la sessione (Docker Desktop non era in esecuzione, riavviato da `C:\Users\morta\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe` — nota il percorso REALE, diverso da quello standard `C:\Program Files\Docker\...` che NON esiste su questa macchina) — dopo il riavvio: `npx tsc --noEmit` backend pulito (0 errori, i 3 preesistenti spariti), `npm run build --workspace=packages/backend` OK, `npm test --workspace=packages/backend` → **178/178 verdi con DB reale**, `npm run build --workspace=packages/frontend` OK (confermato dal developer, non ancora ri-verificato da me dopo il giro di sicurezza ma nessun file frontend è stato toccato in quel giro).

**PROBLEMI TROVATI DA ME LEGGENDO I FILE (prima ancora della security review)**:
- `render.yaml` e `GUIDA-DEPLOY.md` dicevano `branch: main` in 3 punti — **branch reale del repo è `master`** (verificato con `git branch --show-current`). Corretto ovunque: sarebbe stato un deploy silenziosamente rotto (Render non avrebbe trovato il branch).
- `bootstrap-admin.ts` stampava la lunghezza di una password rifiutata, in contraddizione con un commento poco sotto che garantiva "nessuna password stampata, in nessuna forma, nemmeno come lunghezza". Tolto.

**PROBLEMI TROVATI DALLA SECURITY REVIEW (agente `security`, tutti verificati sul codice reale, non ipotesi) — TUTTI CORRETTI**:
- **[ALTO] A1**: `scripts/seed-dev.ts` non aveva NESSUNA guardia contro l'uso in produzione — password admin default `Admin123!` scritta nel repository, e lo scenario di innesco è proprio la procedura della guida (`DATABASE_URL` di produzione resta nell'env della sessione PowerShell dopo il bootstrap; un lancio successivo e disattento di `seed-dev.ts` nella stessa finestra scriverebbe sul DB vero). **Corretto**: nuova funzione `refuseIfNotLocal()` in testa a `main()`, blocca se `NODE_ENV=production` O se l'host di `DATABASE_URL` non è `localhost`/`127.0.0.1`.
- **[MEDIO] M2**: i placeholder in `GUIDA-DEPLOY.md` (password admin, 38 caratteri) e `.env.example` (JWT secrets, 58 caratteri) erano abbastanza LUNGHI da superare i controlli di validazione — un copia-incolla acritico avrebbe creato credenziali reali note pubblicamente nel repository. **Corretto**: nuovo controllo per-contenuto (non solo per-lunghezza) in `core/config/index.ts` (`superRefine`, rifiuta JWT secret con "replace_me"/"incolla_qui" nel valore, E rifiuta se i due secret sono identici) e in `bootstrap-admin.ts` (stessa regex sulla password). Il placeholder esistente in `.env.example` conteneva già "REPLACE_ME" quindi ora viene bloccato automaticamente senza nemmeno doverlo riscrivere. Placeholder della password nella guida riscritto in stile "INCOLLA_QUI_..." per coerenza con gli altri placeholder della guida.
- **[MEDIO] M3**: un Origin CORS non consentita faceva `callback(new Error(...))` in `app.ts` — questo salta DIRETTAMENTE all'error handler (bypassando i rate limiter, montati dopo) E scrive uno stack trace completo nei log ad ogni tentativo (un attaccante può floodare i log del piano free di Render con richieste `Origin` a piacere). **Corretto**: `callback(null, false)` (la richiesta prosegue senza header CORS — bloccata comunque lato browser — ma passa regolarmente dai rate limiter), più un `console.warn` leggero al posto dello stack trace.
- **[MEDIO] M4**: `trust proxy: 1` è corretto SE Render è un solo hop di proxy, ma non è verificato — se sbagliato, il rate limit sul login (10/15min) diventerebbe condiviso da TUTTI gli utenti invece che per persona (DoS banale sul login). **Non una correzione di codice**: da verificare EMPIRICAMENTE dopo il primo deploy reale, loggando `req.ip` vs `req.headers['x-forwarded-for']` su `/api/v1/health` chiamato da un telefono in rete dati (deve coincidere con l'IP pubblico del telefono). **PROMEMORIA PER LA PROSSIMA SESSIONE POST-DEPLOY**, non ancora fatto.
- **[MEDIO] M5**: 5 variabili NON segrete (`JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`, `PASSWORD_RESET_EXPIRES_IN`, `MAIL_FROM`, `TZ`) erano `sync: false` in `render.yaml` — se create su Render con valore vuoto (facile per sbaglio), il default Zod NON scatta (scatta solo su `undefined`, non su stringa vuota) e `ms('')` lancia un'eccezione: ogni login risponderebbe 500. **Corretto**: `value:` esplicito nel blueprint per tutte e 5.
- **[BASSO] B1**: il controllo "database vuoto" in `bootstrap-admin.ts` (query count) e l'insert erano in transazioni separate — race condition teorica se lo script venisse lanciato 2 volte in parallelo (probabilità bassissima, comando manuale). **Corretto**: `pg_advisory_xact_lock` + conteggio + insert tutti nella STESSA transazione.
- **[BASSO] B2**: il commento su `skipPreflight` sosteneva un beneficio che di fatto non esiste (il middleware `cors()` chiude già ogni OPTIONS con 204 prima che arrivi ai rate limiter — verificato leggendo il sorgente reale di `cors` in `node_modules`). **Corretto**: commento riscritto per dire la verità (è "difesa in profondità" per un futuro riordino dei middleware, non una protezione attiva oggi).
- **[BASSO] B3**: la guida usava `?sslmode=require` per la connessione al DB di produzione dal PC locale — quella modalità CIFRA ma NON verifica il certificato del server (verificato nel sorgente di `postgres.js`: `require` imposta `rejectUnauthorized = false`), quindi un attaccante in posizione di MITM sulla rete locale potrebbe intercettare la connessione. **Corretto**: `?sslmode=verify-full` nella guida.
- **[BASSO] B4**: `/api/v1/health` (interrogato da UptimeRobot ogni 5-10 min) era sotto il rate limiter generico (300/15min) — rischio basso ma a costo zero da escludere. **Corretto**: nuovo `skipHealthCheck` sull'`apiRateLimiter`.
- **[BASSO] B5**: stesso problema di A1/bootstrap ma in `seed-dev.ts` — stampava `'*'.repeat(password.length)`. **Corretto**: tolto.
- **Coerenza minore**: `core/constants.ts` dichiara `BCRYPT_COST` "condiviso... con il seed di sviluppo" ma `seed-dev.ts` usava `10` hardcoded — commento falso. **Corretto**: ora usa `BCRYPT_COST` importato.

**BUG PREESISTENTE TROVATO PER CASO, FUORI SCOPE, NON CORRETTO**: `scripts/seed-dev.ts` ha 2 errori di tipo se controllato con le opzioni del tsconfig (mai fatto prima: `scripts/` è escluso da `include: ["src"]` del tsconfig, quindi questo file non è MAI stato type-checkato dal progetto) — riga con `clientName` (colonna che NON esiste nello schema `projects`, verificato) e riga con `priority: 'media'` (l'enum reale è `['low','medium','high','urgent']`, non esiste 'media'). Bug preesistente, non introdotto in questa sessione (verificato con `git diff`: quelle righe non sono state toccate). **Se l'utente usa ancora `seed-dev.ts` per popolare dati demo locali, probabilmente fallisce all'insert del progetto/task** — da segnalare e correggere in una sessione futura dedicata, non qui.

**Docker Desktop — nota tecnica per sessioni future**: il percorso standard `C:\Program Files\Docker\Docker\Docker Desktop.exe` NON esiste su questa macchina. L'eseguibile reale è in `C:\Users\morta\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe`. Se Docker risulta fermo, avviarlo da lì con `Start-Process`, aspettare ~20-30s, poi `docker ps`.

## ✅ SECONDO GIRO — `reviewer` (agente, background) ha trovato altri problemi REALI, TUTTI CORRETTI

Nota metodologica del reviewer: il suo sub-agente aveva Bash disabilitato, quindi 2 dei controlli richiesti (tsc su bootstrap-admin.ts, tsc -b frontend) non li ha potuti eseguire — l'ha dichiarato esplicitamente ("non è 0 problemi confermati, è un controllo non eseguito") invece di far finta di niente. Li ho rilanciati io con Bash dopo le correzioni: entrambi puliti.

- **[ALTO] A1 — il più grave trovato in questo giro, causato da una MIA correzione precedente**: il nuovo controllo anti-placeholder aggiunto in `config/index.ts` (sessione precedente di questo stesso pomeriggio) si applicava ANCHE quando si lancia `bootstrap-admin.ts`, perché quello script importava `db` da `../src/core/db`, che a sua volta importa `CONFIG` — cioè valida l'INTERA configurazione dell'app (JWT secret, MAIL_FROM, tutto), non solo quello che lo script usa davvero. La guida stessa dice all'utente, all'ultimo passo (Passo 7), di copiare `.env.example` se non ha un `.env` locale — ma quel file ha JWT secret placeholder che il controllo appena aggiunto rifiuta. Risultato: l'utente non tecnico si sarebbe bloccato all'ultimo passo con un errore sui segreti JWT mentre stava solo creando un amministratore. **Corretto alla radice** (non con una patch): `bootstrap-admin.ts` ora crea la propria connessione Postgres/Drizzle standalone (legge solo `DATABASE_URL` da `process.env`, non importa più `core/db`/`CONFIG`) — uno script monouso che non avvia un server non ha motivo di dover validare segreti che non usa mai.
- **[MEDIO] M2**: `looksLikePlaceholder` era duplicata identica in `config/index.ts` e `bootstrap-admin.ts` — stessa regola di sicurezza, due copie che potevano divergere. **Corretto**: spostata in `core/constants.ts` (dove già vive `BCRYPT_COST`), importata da entrambi.
- **[MEDIO] M3**: la regola `Cache-Control: no-cache` su `/index.html` in `render.yaml` non copre quello che i browser chiedono davvero (`/` o un deep-link tipo `/cantieri/123`, mai la stringa esatta `/index.html`) — quindi la protezione contro la "schermata bianca dopo un deploy" di fatto non scattava mai nel caso reale. **Corretto**: invertito l'approccio, `/*` → no-cache di default, `/assets/*` (i file con hash di Vite) → cache lunga immutabile.
- **[MEDIO] M4**: `GUIDA-DEPLOY.md` intrecciava le due strade (Blueprint vs manuale) — la nota sul Blueprint compariva SOLO dentro il Passo 2, dopo che il Passo 1 aveva già fatto creare un database a mano: chi sceglieva il Blueprint dopo aver letto tutto in ordine si ritrovava con **due database duplicati** con lo stesso nome. Inoltre gli header di cache (M3) esistevano solo nel Blueprint, non nella strada manuale. **Corretto**: nuova sezione "Prima scelta" subito dopo l'avviso sul piano free, PRIMA del Passo 1, che spiega le due strade e dice esplicitamente quali passi saltare con ciascuna; Passi 1/2/5 marcati "(solo Strada B)"; aggiunta la tabella degli header mancanti al Passo 5 manuale.
- **[MEDIO] M5**: 5 blocchi `rateLimit({...})` in `app.ts`, 85 righe, che ripetevano 5 volte il formato standard dell'errore (`{error:{code,message,details}}`) — soglia di duplicazione ampiamente superata (5 casi reali, non 2 ipotetici), rischio concreto di deriva del formato. **Corretto**: funzione `createRateLimiter(limit, message)` condivisa, i 5 blocchi ora sono una riga ciascuno.
- **[MEDIO] M6**: nessuna normalizzazione della barra finale su `VITE_API_BASE_URL` (frontend) e `CORS_ORIGINS` (backend) — sono i due errori più probabili quando si incolla un URL dal pannello Render (il browser la aggiunge quasi sempre), e la guida li segnalava solo a parole ("attenzione, niente barra finale"). **Corretto**: `.replace(/\/+$/, '')` in entrambi i punti, più un `console.warn` se `CORS_ORIGINS` risulta vuota in produzione.
- **[BASSO] B1-B6 tutti corretti**: commento d'uso di `bootstrap-admin.ts` aggiornato a `verify-full` (era rimasto `require`); commento in `render.yaml` che diceva "queste 5 hanno un default" quando sono 4 (TZ è un caso diverso, non ha default in Zod); `.env.example` — riga `VITE_API_BASE_URL` ora commentata (prima contraddiceva il commento sopra che diceva "senza valore usa il percorso relativo"), aggiunta `TZ=Europe/Rome` mancante; `app.ts` — rotta `/api/v1/health` spostata SOPRA `apiRateLimiter` invece di uno `skipHealthCheck` basato su una stringa scollegata dalla rotta vera (eliminato il rischio di rottura silenziosa se un domani il prefisso `/api` cambiasse); commento su `BCRYPT_COST` che elencava "chi lo usa" (ormai 4 punti, ne mancava uno) — tolto l'elenco, tenuto solo il "perché".
- **Trovato anche da me, non dal reviewer**: `GUIDA-DEPLOY.md` riga 35 rimandava al "Passo 6" per la External Database URL, che in realtà è nel Passo 7 — refuso preesistente (non mio), corretto.
- **NON applicato, deliberatamente**: B7 del reviewer (far compilare la build del frontend senza portarsi dietro il workspace backend/bcrypt) — il reviewer stesso dice "da provare prima di adottare, non ho potuto testarla"; troppo rischioso da cambiare in `render.yaml` senza poterlo verificare su un deploy Render reale. B8 (README.md/CLAUDE.md con info obsolete: ruoli ancora a 6, endpoint login descritto diverso da come risponde davvero, 93 test invece di 178) — esplicitamente FUORI SCOPE per questa sessione secondo lo stesso reviewer, "vale una passata dedicata". **Da fare in una sessione futura, non dimenticare.**

**RIVERIFICATO DOPO TUTTE LE CORREZIONI DI QUESTO SECONDO GIRO (dati reali, non presunti)**: `npx tsc --noEmit` backend pulito, `bootstrap-admin.ts` standalone pulito, `npm run build` backend E frontend entrambi puliti, `npm test` backend → **178/178 verdi con DB reale** (invariato). `seed-dev.ts` standalone dà ancora gli stessi 2 errori preesistenti (non nuovi, confermato di nuovo).

## ✅ SECONDO COMMIT FATTO (20/08, tramite l'agente `devops`)

**Hash `c4e2ddf`** — "feat: preparazione al primo deploy pubblico su Render (backend + Postgres + PWA)". 17 file (934 righe aggiunte, 133 rimosse): 4 nuovi (`render.yaml`, `.node-version`, `GUIDA-DEPLOY.md`, `bootstrap-admin.ts`), 1 eliminato (`core/db/seed.ts`), 12 modificati. Working tree pulito dopo. Nessun push (nessun remote configurato, invariato).

**Controllo segreti indipendente (devops, non fidandosi dei giri precedenti)**: zero segreti reali trovati. Unico riscontro dalla scansione a pattern: le credenziali Docker locali già presenti in `.env.example` dal primo commit (`workflow360:workflow360@localhost`), non un segreto vero. `.env` reale confermato ignorato da git (`git status --ignored`).

**Due cose segnalate da devops, da tenere a mente**:
1. `.claude/memory/session.md` (questo file) è entrato anche in questo commit — era già tracciato dal primo commit, quindi per tenere l'albero pulito è stato incluso di nuovo. Se in futuro si preferisce NON avere le note di sessione nella storia git del progetto, va tolto dal tracking con un commit dedicato (non deciso, da chiedere all'utente se rilevante).
2. `scripts/seed-dev.ts` riga 39 ha ancora `'Admin123!'` come default — preesistente dal primo commit, MAI stato un problema perché non era mai stato usato su un DB reale, e questo stesso commit gli aggiunge la guardia (`refuseIfNotLocal`) che ora impedisce esplicitamente di usarlo contro Render. Non va "rigenerato": è un default di sviluppo, non un segreto di produzione.

## 🎯 STATO ATTUALE: codice pronto, deploy vero NON ancora iniziato

Il lavoro di preparazione (FASE 0 + 2 giri di controllo indipendenti + 2 commit separati) è concluso. **Prossimo passo dipende dall'utente**: seguire `GUIDA-DEPLOY.md` per creare i servizi veri su Render (richiede il suo account — l'agente non ha accesso a Render). Due sotto-punti ancora aperti quando si arriva a quel momento:
1. Il repository va prima pubblicato su GitHub (Render legge il codice da lì) — non ancora fatto, nessun remote configurato. Da chiedere esplicitamente prima di aggiungerne uno.
2. **Dopo** il primo deploy reale (non prima, serve il servizio vivo per testarlo): verificare empiricamente `trust proxy: 1` — loggare `req.ip` vs `req.headers['x-forwarded-for']` su `/api/v1/health` chiamato da un telefono in rete dati, deve coincidere con l'IP pubblico del telefono (altrimenti il rate limit sul login diventa condiviso da tutti gli utenti invece che per persona).

**Rimane fuori scope, per una sessione futura dedicata**: `README.md`/`CLAUDE.md` con informazioni superate (6 ruoli invece di 3, endpoint login descritto diverso da come risponde davvero, conteggio test sbagliato).

**Decisioni prese con l'utente (bottoni):** obiettivo "app vera per desktop (qualsiasi SO) e telefono (qualsiasi tipo), facile da scaricare". Scelto: (1) **solo PWA** per ora, non store nativi/Capacitor (eventuale passo successivo); (2) **hosting: Render** per backend+DB (l'utente lo usa già per il bot Solana, familiarità col piano free che si addormenta).

**Consultato l'agente `architect`** (interrotto una volta per limite di sessione esterno "session limit", ripreso con successo via `SendMessage` sullo stesso agentId — stesso pattern già visto il 18/08, non un bug). Piano completo prodotto, leggendo il codice REALE (non supposizioni). Riassunto per chi riprende:

**SCOPERTA CRITICA (blocca tutto se non corretta)**: `packages/frontend/src/lib/api.ts` riga 5, `API_BASE = '/api/v1'` — **hardcoded**, non legge mai `import.meta.env.VITE_API_BASE_URL` nonostante `.env.example` la documenti già. Funziona oggi SOLO grazie al proxy Vite in dev. Pubblicato così com'è, ogni chiamata API va in 404 (login incluso). Fix: una riga, con fallback su `'/api/v1'` per non rompere lo sviluppo locale.

**Architettura consigliata**: 3 servizi Render separati — Postgres gestito, Web Service Node (backend), **Static Site** (frontend, NON servito dal backend: sul piano free il web service si addormenta, con un service unico si addormenterebbe anche la schermata di login).

**I 3 errori TS preesistenti SONO bloccanti per il deploy** (non solo cosmetici come si pensava prima): `packages/backend/tsconfig.json` non ha `noEmitOnError`, quindi `tsc` scrive comunque `dist/` ma esce con codice diverso da zero — Render considera il build fallito lì. Verdetto per ciascuno:
- `core/tenant.ts` — import type sbagliato, zero rischio runtime (i tipi spariscono a compile-time), un minuto da correggere (percorso verso `src/modules/auth/auth.types`).
- `core/errors/ConflictError.ts` — tipo `details` da allineare ad `AppError` (`Record<string,unknown>` invece di `unknown`).
- `core/db/seed.ts` — **consigliato ELIMINARLO**, non ripararlo: l'insert manca `companyId` che è `notNull`+FK, quindi fallirebbe anche a runtime se mai eseguito; esiste già `scripts/seed-dev.ts` che fa la cosa giusta. Togliere anche lo script `db:seed` da `package.json`.

**Due correzioni di sicurezza mai fatte, trovate leggendo il codice (non nella richiesta originale dell'utente)**:
1. Manca `app.set('trust proxy', 1)` in `app.ts` — su Render tutte le richieste passano dal loro proxy, quindi senza questo `express-rate-limit` vede sempre lo stesso IP per tutti → il limite "10 login/15min" diventa condiviso da TUTTA l'azienda, non per persona. Va `1` (un proxy), mai `true` (si fiderebbe di IP falsificati).
2. Le richieste `OPTIONS` (preflight CORS, inevitabili con frontend/backend su domini diversi) vengono contate dai rate limiter → un limite di "10" diventa in pratica "5" reali. Serve `skip` sulle OPTIONS nei 4 limiter di `app.ts` + `maxAge` nelle opzioni CORS.

**RISCHIO PIÙ SIGNIFICATIVO TROVATO (non era nella lista dell'utente)**: il backend ha già `POST /api/v1/auth/refresh` completo e funzionante (rotazione token, revoca), ma **il frontend non lo chiama MAI** — zero `credentials: 'include'` in tutto `packages/frontend/src`. Il cookie di refresh viene emesso e mai usato. In locale non si nota (si ricarica in continuazione durante lo sviluppo). Con operai veri: dopo 15 minuti (`JWT_ACCESS_EXPIRES_IN`) la sessione scade nel mezzo del lavoro, `api.ts:72` cancella il token, schermata di login mentre l'operaio stava scrivendo le ore. Piano: **soluzione rapida per partire** = allungare la scadenza (es. 8h, un turno di lavoro) accettando il rischio (token rubato valido più a lungo, non revocabile prima della scadenza) — **soluzione corretta da fare come primo lavoro DOPO il deploy** = collegare davvero il refresh nel frontend (richiede anche cambiare il cookie da `sameSite:'lax'` a `'none'`+`secure:true` in `auth.routes.ts:39`, dato che frontend/backend saranno su domini diversi — e questo poi richiede protezioni CSRF esplicite).

**Limite strutturale trovato**: `companies.routes.ts` ha SOLO rotte GET — nessun modo di creare la prima azienda/admin da interfaccia su un DB di produzione vuoto. `scripts/seed-dev.ts` esistente NON è sicuro per produzione (password `Admin123!` scritta nel codice, crea dati demo finti, `bcrypt.hash(password,10)` hardcoded invece di usare `BCRYPT_COST`). Piano: nuovo script `scripts/bootstrap-admin.ts` — legge tutto da env vars senza default, si rifiuta di partire se esiste già anche un solo utente nel DB, nessun dato demo, non stampa mai la password. Va lanciato una sola volta dal PC dell'utente puntando alla External Database URL (la Shell di Render è solo sui piani a pagamento).

**Comandi di deploy (punto delicato per via degli npm workspaces — root directory del repo, non `packages/backend`)**:
- Backend build: `npm ci --include=dev` (obbligatorio `--include=dev`: con `NODE_ENV=production` npm salterebbe `typescript`, che è devDependency, e il build fallirebbe con "tsc: not found") poi `npm run build --workspace=packages/backend`.
- Backend start: `cd packages/backend` poi `node dist/core/db/migrate.js` (migrazioni ad OGNI avvio, non nel build — se una migrazione fallisce il servizio non parte, comportamento voluto) poi `node dist/index.js`.
- Frontend build: `npm ci --include=dev` poi `npm run build --workspace=packages/frontend` (attenzione: `noUnusedLocals`/`noUnusedParameters` attivi nel tsconfig frontend — un solo import inutilizzato fa fallire il build, MAI verificato dal vivo dall'architect).
- Frontend publish dir: `packages/frontend/dist`, con **rewrite obbligatoria `/*` → `/index.html` (200)** — senza, ricaricare la pagina su una rotta tipo `/cantieri/123` dà 404 del CDN (errore classico con `BrowserRouter`, invisibile finché non capita al primo utente vero).
- Migrazioni: **mai `drizzle-kit push` in produzione** (altera lo schema direttamente, può cancellare colonne su dati reali) — solo `migrate` con i file SQL già committati in `drizzle/` (10 migrazioni esistenti, non in `.gitignore`, corretto così).

**Altri rischi elencati dall'architect, in ordine di probabilità**: CORS a confronto esatto (`app.ts:113`, una barra finale o `http` vs `https` rompe tutto con un errore CORS generico poco leggibile); service worker che serve una UI vecchia dopo un deploy se non si impostano header `Cache-Control: no-cache` su `index.html`/`sw.js`/`manifest.webmanifest` nello Static Site (altrimenti rischio di schermata bianca); risveglio a freddo ~50s dopo inattività (UptimeRobot su `/api/v1/health`, che fa anche un `select 1` quindi tiene sveglia pure la connessione DB); **occhio al monte-ore mensile Render (storicamente 750h) se il bot Solana ha già un servizio free tenuto sveglio 24/7 — i due insieme potrebbero sforare**, da controllare sull'account prima di attivare un secondo ping; recupero-password che promette un'email che non arriva se `RESEND_API_KEY` non è configurata (decidere: configurarla, o nascondere il link "Password dimenticata" per ora); `TZ=Europe/Rome` consigliata per `computeArchiveCutoffISO()` (Render gira in UTC, scarto di poche ore rilevante solo nel giorno esatto del confine dei 15gg archivio); dati personali reali (nomi/email/ore dipendenti) su infrastruttura gratuita senza backup — non blocca oggi ma diventa questione contrattuale se il progetto passa da prova a pilota con un'azienda vera.

**Cosa fare prima del PRIMO commit** (poco): controllare che nei file di appunti (`PIANO-*.md`, `README.md`, `CLAUDE.md`, `docs/handoffs/*`) non ci siano credenziali reali incollate per errore; chiudere i buchi nel `.gitignore` (`.env.*` con eccezione `!.env.example`, più `dev-dist/` — oggi copre solo il file esatto `.env`); confermare che `package-lock.json` è incluso (necessario per `npm ci`).

**Cosa fare DOPO il primo commit, PRIMA di aprire Render** (secondo commit separato, consigliato dall'architect per poter distinguere "stato di partenza" da "modifiche per il deploy"): i 3 fix TS, `trust proxy`+skip OPTIONS, fix `api.ts`, nuovi file (`render.yaml`, `.node-version`, `bootstrap-admin.ts`, `GUIDA-DEPLOY.md`), **provare `npm run build` di ENTRAMBI i pacchetti in locale prima di toccare Render** (mai verificato dal vivo dall'architect, che non ha eseguito comandi — solo letto tsconfig/package.json).

**Onestà sui limiti del piano** (dichiarati esplicitamente dall'architect): non ha eseguito nessun comando (build mai provato dal vivo, specialmente il frontend con `noUnusedLocals` attivo); le politiche Render citate (scadenza Postgres free, monte-ore 750h, Shell solo a pagamento) sono ricordi, non pagine lette oggi — da riverificare sul sito prima di farci affidamento, soprattutto la scadenza del DB free.

**PROSSIMO PASSO ESATTO**: nessuna riga di codice ancora scritta per questo tema. Da chiedere all'utente: via libera per iniziare con la FASE 0 del piano (le correzioni al codice, tutte in locale, nessun account Render ancora necessario)?

---

## ⚡⚡ RIPRESA 20/08 — verifica finale rimozione ruoli COMPLETATA, in attesa decisione utente

**Nota tecnica sull'ambiente**: questa sessione è partita in un worktree git del progetto SBAGLIATO (`solana-bot-web\.claude\worktrees\restyle-cantieri-archivio-ruoli-d9c214` — nome del worktree coincidente per puro caso/copia col nome dell'handoff, ma repo diverso). Operato con percorsi assoluti su `C:\Users\morta\OneDrive\Skrivbord\workflow360` (stesso workaround già documentato nell'handoff per `preview_start`), MAI dentro il worktree del bot Solana. Se si riprende ancora da un worktree/sessione "primaria" diversa da questa cartella, ripetere lo stesso approccio: percorsi assoluti, non `cd` implicito.

**Eseguito il punto 1 di "Prossimi passi" dell'handoff 20/08:**
- Docker/Postgres già attivo (`workflow360-postgres-1`, up da ore). Backend (`tsx src/index.ts`, porta 4000) era già in esecuzione da una sessione precedente — verificato via `netstat`+`wmic` che il processo fosse davvero quello, non un residuo. Frontend NON era attivo, avviato ora (`nohup npm run dev:frontend`, porta 5173, workaround browser confermato di nuovo necessario: `preview_start` con `{name}` non risolveva questo progetto).
- **(a) Login** `admin@workflow360.local`/`Admin123!` → funziona, dashboard carica.
- **(b) Form "Nuovo utente"** → select "Ruolo" mostra ESATTAMENTE 3 opzioni: Amministratore, Responsabile progetti, Operaio. Verificato leggendo il testo reso della pagina dopo login.
- **(c) `npm test` in `packages/backend`** → **178/178 test verdi, 10 file di test, 0 falliti** (durata 22,23s). Nota: l'handoff parlava di "179" come numero visto in una sessione precedente (17/08) — 178 è il numero attuale dopo tutte le modifiche di questa sessione (rimozione test obsoleto in `timeLogs.test.ts`, vedi handoff punto 17); non è una discrepanza da correggere, è il conteggio reale post-migrazione.

**Task "rimozione ruoli da 6 a 3" dichiarato CHIUSO e verificato end-to-end** (migrazione DB applicata + codice + test + verifica visiva reale nel browser).

**Punto 2 dell'handoff — UNIFICAZIONE `*_MANAGER_ROLES` FATTA E VERIFICATA (20/08, subito dopo):**
L'utente ha confermato di procedere (bottoni). Creato `packages/backend/src/core/roles.ts` con `MANAGER_ROLES: UserRole[] = ['admin','project_manager']` + `isManager(role)`. Sostituite le 4 costanti duplicate:
- Rimosse `PROJECT_MANAGER_ROLES` (`projects.types.ts`), `TASK_MANAGER_ROLES` (`tasks.types.ts`), `TIMELOG_MANAGER_ROLES` (`timeLogs.types.ts`), `CORRECTION_MANAGER_ROLES` (`corrections.types.ts`) — con l'import `UserRole` ormai inutilizzato in quei 4 file, tolto anche quello.
- Aggiornati i 5 punti che le importavano (`projects.routes.ts`, `tasks.routes.ts`, `timeLogs.routes.ts`, `corrections.routes.ts`, `reports.routes.ts`) a importare `MANAGER_ROLES` da `../../core/roles`.
- `timeLogs.service.ts` aveva una **terza** copia locale (`const MANAGER_ROLES = [...] as const` + `isManager()` privata, non solo le 4 costanti trovate dall'architect) — anche questa sostituita con l'import condiviso, stessa firma (`isManager(role: string)`), tutti i 6 punti di chiamata invariati.
- Commenti che nominavano i vecchi identificatori aggiornati di conseguenza (`tasks.routes.ts`, `tasks.service.ts`, `corrections.routes.ts`, `timeLogs.test.ts`, `corrections.test.ts`) — nessuna logica di test toccata, solo testo.
- **`COMPANY_MANAGER_ROLES`** (`companies.types.ts`, solo `['admin']`) **lasciato intatto apposta**: semantica diversa (gestione utenti/azienda riservata al solo admin, non ai PM) — non è un duplicato del gruppo unificato.

**Verificato dopo il refactor:**
- `npx tsc --noEmit` backend → stessi e soli 3 errori preesistenti (`seed.ts`, `ConflictError.ts`, `core/tenant.ts`), zero nuovi.
- `npm test` backend → **178/178 verdi**, invariato rispetto a prima del refactor (comportamento a runtime confermato identico, non solo compilazione).
- `npx tsc -b` frontend → pulito (il refactor è solo backend, nessun file frontend toccato).
- **Verifica dal vivo nel browser**: dashboard ricaricata dopo il refactor (backend gira con `tsx watch`, si è ricaricato da solo) → login ancora valido, cantieri/dipendenti/form "Nuovo utente" (3 ruoli) tutti renderizzati correttamente, cioè le rotte protette da `requireRole(...MANAGER_ROLES)` funzionano end-to-end.

**Refactor dichiarato CHIUSO e verificato.** Nessun commit fatto (repo ancora 0 commit, non riproporlo di iniziativa — vedi sotto).

**PROSSIMO PASSO ESATTO**: nessuna azione in coda. Prossimo tema aperto (punto 3 dell'handoff, mai iniziato): **"deve funzionare come una semplice app ovunque, PC e telefono, per poterlo vendere"** — probabile deploy pubblico (oggi solo `localhost`), nessuna decisione hosting presa. Da chiedere all'utente quando torna se ha già un hosting in mente o va scelto insieme.

Restano aperti, invariati dalla sessione 19/08 (vedi sezione sotto): i 3 errori TS preesistenti (`seed.ts`, `ConflictError.ts`, `core/tenant.ts`), il bug `clearToken()` su 401 pubblico (segnalato, non corretto, fuori scope), repo **ancora 0 commit** (non riproporlo di iniziativa).

---

## ⚡ Leggi questo per primo se riprendi il lavoro

### PROSSIMO PASSO ESATTO (19/08 sera — sostituisce la versione precedente qui sotto, ormai superata: quel lavoro è FINITO e verificato)

**La sessione precedente (17-18/08) aveva lasciato 8 funzionalità implementate ma in attesa della verifica visiva dell'utente.** L'utente ha fatto quella verifica e ha segnalato 5 problemi/richieste concrete (screenshot alla mano). **Tutti e 5 sono stati implementati, testati (172/172 test Vitest verdi, `tsc -b` pulito) e verificati visivamente nel browser reale contro backend+DB veri** (non solo compilazione):

1. **Codice cantiere scritto a mano dall'admin** — nuovo campo `code` (varchar 50, nullable, UNIQUE per azienda), migrazione `0007` applicata. Si AFFIANCA a `projectNumber`/`formatProjectId`, non lo sostituisce (decisione tecnica dell'architect, confermata). Nuova funzione `etichettaCantiere()` in `format.ts`, unico punto che decide "mostra il codice se c'è, altrimenti il formato automatico" — usata in tutte e 5 le pagine che prima chiamavano `formatProjectId` direttamente.
2. **Recupero password via email per QUALSIASI ruolo (admin incluso)** — scelto dall'utente esplicitamente dopo aver fatto notare il rischio "unico admin che dimentica la password, nessuno che gliela resetta". Nuova tabella `password_reset_tokens` (migrazione `0008`), nuovo modulo `core/mail` (fetch diretto a Resend, NESSUNA dipendenza npm nuova), `requestPasswordReset`/`resetPassword` in `auth.service.ts`, due rotte con rate limiter dedicato, due pagine frontend nuove (ForgotPassword/ResetPassword). **`RESEND_API_KEY` non è ancora configurata dall'utente** (facoltativa per design: il backend logga e basta senza inviare davvero, verificato dal vivo). **Avvertimento dato all'utente ma non ancora confermato letto**: senza un dominio verificato su Resend, il mittente di prova consegna solo all'indirizzo del titolare dell'account Resend, non ai dipendenti.
3. **Nome del lavoro (task) modificabile** — bug reale: il backend accettava già `title` in PATCH, mancava solo l'input nel form di modifica di `TaskRow`. Un solo file toccato, nessuna decisione architetturale.
4. **"Ora di inizio" facoltativa anche per tipo 'ordinario'** — decisione dell'utente in due passaggi: prima "rendila facoltativa", poi (dopo che l'architect ha trovato una contraddizione tecnica reale: il sistema fa DUE automatismi distinti, non uno — fascia notturna E tetto 8h/giorno) l'utente ha scelto esplicitamente di disattivare **entrambi** quando manca l'orario, non solo quello notturno. Tolto anche il blocco equivalente in `updateTimeLog` (altrimenti una riga creata senza automatismo diventava non correggibile oltre le 8h).
5. **Cronologia ore raggruppata per giorno+lavoro** — nuovo helper puro `groupTimeLogs.ts` (raggruppamento lato frontend, non backend — motivato dall'architect: il pulsante "Modifica" lavora su UNA registrazione, un'API che raggruppasse dovrebbe comunque riesporre gli id singoli). Riga di gruppo con badge-somma per tipo + colonna "Totale", dettaglio espandibile con "Modifica" sulla singola registrazione — **verificato dal vivo**: due registrazioni stesso giorno/lavoro (10h ordinario + 2h permesso) appaiono su UNA riga con badge affiancati e totale 12,0.

**Come sono stati chiariti i punti ambigui**: 6 domande a bottoni con l'utente PRIMA di scrivere codice (formato del codice cantiere, gestione del recupero password quando l'unico admin resta bloccato, quale servizio email, comportamento esatto del tetto 8h senza ora di inizio, raggruppamento per giorno-e-basta o giorno-e-cantiere/lavoro). Poi consultato l'**architect** con tutte le decisioni già prese, per il piano tecnico (migrazioni, file, ordine, rischi non ovvi) — piano seguito quasi alla lettera, con un solo scostamento **motivato**: lo status HTTP di reset-password rifiutato è 401 (non il 400 genericamente suggerito), per coerenza con `rotateRefreshToken` che usa già 401 per lo stesso tipo di errore (token invalido/scaduto).

**Ordine di esecuzione**: Fase 0 (helper raggruppamento) → Fase 1 (punti 3+5, solo frontend) → Fase 2 (punto 1, migrazione additiva) → Fase 3 (punto 4, tocca il calcolo paghe) → Fase 4 (punto 2, la più delicata: nuova tabella + servizio esterno). Stesso criterio "additivo prima, dati sensibili dopo" già usato nel round precedente.

**5 test miei sbagliati alla prima stesura, poi corretti** (non un problema del codice di produzione): 3 si aspettavano 400 invece di 401 sul reset-password (disallineamento tra quello che avevo implementato e quello che avevo scritto nel test); 2 fallivano per essere andati oltre il rate limiter (5/15min su forgot-password, 10/15min su login) **sommando troppe richieste nello stesso file di test** — corretti riducendo le chiamate ridondanti (es. verificare la password vecchia via bcrypt.compare sull'hash in DB invece che via una chiamata HTTP a /login in più).

**⚠️ Verifica visiva nel browser di QUESTA sessione — nota tecnica per il futuro**: il click/Invio simulato dal pannello Browser non attivava l'handler `onSubmit` di React in questa build (nessun errore, la richiesta HTTP semplicemente non partiva) — bypassato con `form.requestSubmit()` via JavaScript per ogni form. Non è un bug del codice (la stessa build funziona normalmente per un utente reale), è un limite del tool di automazione in questo ambiente — utile saperlo se càpita di nuovo in una sessione futura, prima di sospettare un bug che non c'è.

**🐛 Bug reale trovato per caso durante la verifica (fuori scope, SEGNALATO ma non corretto)**: `packages/frontend/src/lib/api.ts`, funzione `request()`, fa `clearToken()` su QUALUNQUE risposta 401 — anche da rotte pubbliche chiamate con `{auth:false}` (login, forgot-password, reset-password). Riprodotto dal vivo: un admin loggato che genera un 401 testando un link di reset-password non valido si ritrova disconnesso dalla propria sessione valida altrove. Segnalato con `spawn_task` (chip visibile all'utente), non corretto: fuori dallo scope degli 8+5 punti richiesti.

**Dati di verifica lasciati nel DB locale di sviluppo (non in produzione, nessun rischio)**: un cantiere di prova "Cantiere Verifica Visiva" (codice `VERIFICA-02-MODIFICATO` dopo un test di modifica), un lavoro "Impianto elettrico piano 1 (rinominato)", due registrazioni ore (10h ordinario + 2h permesso) sull'utente admin del seed. Lasciati volutamente (coerente con dati di test già presenti da sessioni precedenti, es. "Test Operaio Verifica") — l'utente può cancellarli lui stesso se vuole (nota: `deleteProject` rifiuta se ci sono ore collegate, va prima segnato "Completato" per spostarlo in Archivio, oppure cancellato a mano dal DB).

**Punto esatto di ripresa se interrotto ora**: nessuna azione in coda da parte mia. Se l'utente torna:
- Se vuole attivare davvero il recupero password: serve che configuri `RESEND_API_KEY` nel `.env` (mai chiesta in chiaro, la scrive lui) e valuti se verificare un dominio su Resend.
- Il repository ha ancora **0 commit** (mai fatto nessun commit in questo progetto, invariato da settimane) — NON riproporlo di propria iniziativa, aspettare che sia l'utente a chiederlo.
- **Restano aperte dalle sessioni precedenti, indipendenti da questo lavoro**: (1) lavoro visivo/brand "Enterprise Trust" in PAUSA non abbandonata — riprendere solo su richiesta esplicita; (2) verifica FASE 5 originale (assegnazione lavoro/dipendente + "Annulla" in `TaskRow`, campo "Ora di fine" in `OperaioPage`) mai confermata visivamente da nessuno — potrebbe essere stata coperta di riflesso dalla verifica di questa sessione (ho toccato entrambe le aree) ma non darlo per scontato, chiedere esplicitamente se non la menziona.

---

### Sessione 17-18/08 — Classificazione cantieri, dettagli ore, Archivio, Modifica (COMPLETATA — 8/8 punti implementati e testati, in attesa solo della verifica visiva dell'utente)

Emersa mentre l'utente controllava la dashboard attuale a metà di un lavoro separato sul restyle visivo (palette "Enterprise Trust" — vedi sezione dedicata più sotto, in pausa non abbandonata). Chiarita punto per punto con l'utente (non indovinata):

**Gli 8 punti richiesti:**
1. ID cantiere formattato per tipo: `{projectNumber}CO` se consuntivo, `ID.{projectNumber}` se a contratto. **Confermato dall'utente**: i valori d'esempio che aveva scritto (26222CO, ID.26892) erano solo stile, non numeri reali; stesso `project_number` progressivo di oggi, **nessuna doppia numerazione** — solo formattazione a display. Nessuna modifica DB.
2. Dashboard: via tile "Cantieri totali" → due conteggi separati (consuntivo/contratto). Via riga "Ore per tipo". Via card "Segnalazioni aperte" (**confermato dall'utente di toglierla**, dopo che le ho spiegato cos'è: mostra il modulo "corrections", oggi inutilizzato da nessuno).
3. Pagina Cantieri: liste separate per tipo invece di elenco unico misto.
4. Dettaglio Cantiere: oggi `employeeCount` è solo un numero — serve ore per singolo dipendente coinvolto in quel cantiere (nuova aggregazione).
5. Dettaglio Dipendente: oggi solo `totalHours` — serve la stessa scomposizione per tipo che ha già il Report.
6. **Report — il gap vero, confermato leggendo il codice** (non supposizione): `getHoursByProject`/`getHoursByUser` prendono SOLO `companyId`, nessun parametro data da nessuna parte (verificato in `lib/api.ts`, `reports.service.ts`, `reports.routes.ts`). Somma tutto lo storico da sempre, inutilizzabile per calcolare "le ore di maggio" per la busta paga. Il breakdown per tipo invece **esiste già**, non serve ricostruirlo. Ferie: l'utente ha confermato che vanno bene in ore come tutto il resto, non serve convertirle in giorni.
7. Nuova sezione "Archivio" sotto Report. **Nessun piano precedente trovato nonostante session.md lo referenziasse** (vedi correzione in cima al file) — progettato da zero. L'utente vuole ENTRAMBE le cose: (a) i cantieri con stato "completed" tenuti separati da quelli attivi in Cantieri, (b) per ogni cantiere un registro cronologico dettagliato (ogni ora/materiale/dipendente nel tempo, non solo i numeri di riepilogo). **Decisione presa il 18/08 che SOSTITUISCE quella del 10/08**: il registro va mostrato **sia** nella pagina Archivio **sia** nel dettaglio di un cantiere ancora attivo (non solo pagina separata come deciso il 10/08 — l'utente ha cambiato idea dopo aver visto il trade-off). **Cantieri "bloccati"**: restano tra gli attivi, NON vanno in Archivio (possono ripartire).
8. "Modifica" su cantieri/dipendenti/report/archivio, per correggere errori. **Di gran lunga il punto più grande dei 8** (valutazione esplicita dell'architect): sono tre funzionalità diverse cucite insieme, l'unica che tocca dati sensibili per la busta paga, va stimata e testata a parte, non in coda alle altre.

**Tre fatti verificati dall'architect che cambiano il quadro rispetto a quanto pensavo:**
- **Il backend permette GIÀ a admin/PM di modificare le ore di un altro operaio** (`timeLogs.service.ts`, controllo `isManager(actingUser.role) || existing.userId === actingUser.id`) — non serve allargare i permessi, manca solo l'interfaccia.
- **Bug reale trovato (non nella mia richiesta iniziale, scoperto dall'architect)**: il campo `taskId` in PATCH `/time-logs` viene accettato dal frontend (`UpdateTimeLogInput`, inviato da `OperaioPage.tsx`) ma lo schema Zod di update in `timeLogs.routes.ts` non lo dichiara → Zod lo scarta in silenzio, zero errore. Oggi "sposta questa registrazione sul cantiere giusto" **non fa nulla**. È esattamente il caso d'uso principale del punto 8 — fix a costo basso, valore alto.
- `recordAudit()` esiste, tabella `audit_log` pronta, ma **zero chiamate in produzione** — mai collegata a nessun modulo.
- **Nessuna migrazione database necessaria per nessuno degli 8 punti.** L'unica eventuale (rimandabile) è un indice composito `(company_id, date)` su `time_logs` se i report diventano lenti.

**Due decisioni prodotto residue, prese dall'utente (18/08):**
- Email dipendente: **deve essere modificabile** dal form "Modifica" (l'architect consigliava di no per semplicità, ma l'utente la vuole) — significa più lavoro del previsto: va aggiunta a `updateUserSchema` E va aggiunto un controllo su email duplicata (`isUniqueViolation`) in `updateUser()`, che oggi esiste solo in `createUser()` — senza, un'email già in uso risponderebbe con un 500 generico invece di un errore chiaro.

**Ordine di implementazione proposto dall'architect (non ancora confermato con l'utente — prossimo passo):**
- Fase 0: helper frontend (`formatProjectId`, mese→range) + estrazione componente tabella ore condiviso (`TabellaOre`, usato da Report/dettaglio cantiere/dettaglio dipendente).
- Fase 1: letture backend, tutte additive — filtri su `listProjects`, `GET /projects/summary`, parametri `from`/`to` su reports (**trappola da non sbagliare**: nella query `getHoursByUser` che usa LEFT JOIN, il filtro data va dentro la ON del join, MAI nella WHERE, altrimenti diventa un INNER JOIN e i dipendenti a zero ore spariscono dal report paghe), `employees[]` nel dettaglio cantiere, scomposizione per tipo nel dettaglio dipendente, nuovo endpoint timeline per l'Archivio.
- Fase 2: frontend delle nuove viste (Cantieri a tab, Dashboard, periodo su Report, dettaglio dipendente/cantiere, Archivio).
- Fase 3 (separata, dopo): le tre "Modifica" (cantiere/dipendente/time_log) — l'unica fase che scrive dati, va per ultima perché l'editor si raggiunge dalle viste della fase 2.

**Rischi principali segnalati dall'architect**: LEFT JOIN + filtro data in WHERE (report paghe sbagliato in silenzio); riassegnazione `userId` di una registrazione ore serve ricalcolare il tetto 8h/giorno sull'utente e la data *effettivi*, non quelli originali; audit + modifica vanno nella stessa transazione DB (altrimenti la correzione riesce e la traccia no, o viceversa).

**Stato attuale (aggiornato)**: utente ha confermato di seguire l'ordine dell'architect. **Fase 0 e Fase 1 completate e verificate**, codice scritto e testato:

- **Fase 0**: `formatProjectId()`/`monthToRange()` in `lib/format.ts`; `TotaleTable` (era locale a ReportPage) estratta in `components/TabellaOre.tsx`.
- **Fase 1 backend (tutta additiva, nessuna migrazione)**:
  - `reports.service.ts`/`reports.routes.ts`: `getHoursByProject`/`getHoursByUser`/`getProjectDetail`/`getUserTimeLogDetail` accettano tutti un `range?: {from, to}` opzionale (query string `?from=YYYY-MM-DD&to=YYYY-MM-DD`, 400 se `from > to`). **Trappola LEFT JOIN rispettata**: in `getHoursByUser` il filtro data sta nella condizione di JOIN, non in WHERE — verificato con un test dedicato (dipendente con ore solo in un altro mese compare comunque, con 0). `getProjectDetail` ha ora `employees: ProjectEmployeeRow[]` (ore per singolo dipendente nel cantiere, non solo un conteggio — `employeeCount` resta per compatibilità, ora è `employees.length`). `getUserTimeLogDetail` ha la scomposizione per tipo (stessi campi di `HoursByUserRow`). Nuovo `getProjectTimeline()` + `GET /reports/projects/:id/timeline` (Archivio, 7b): lettura paginata non aggregata, ordinata `date desc, createdAt desc` (tie-break per lo split automatico), materiali caricati in batch (no N+1). `HoursByProjectRow` ha ora anche `projectNumber`/`tipoCommessa` per il formato ID.
  - **Bug preesistente corretto** (non nella richiesta originale, trovato sistemando `sumByTipo`): la funzione aveva un'annotazione esplicita `: unknown` che cancellava il tipo più preciso di `sql<string>` e si propagava a ogni `.select()` che la usava — è la causa esatta dell'errore "reports.service.ts, tipi unknown" già elencato come preesistente in una sessione precedente (10/08). Rimossa l'annotazione, ora tipizzato correttamente. Con questo fix restano solo 4 file con errori preesistenti (seed.ts, ConflictError.ts, tenant.ts, auditLog.types.ts) — non 7 come documentato prima: auth.service.ts e timeLogs.routes.ts non hanno più errori (probabilmente sistemati incidentalmente in una sessione successiva al 10/08, non verificato quando).
  - `projects.service.ts`/`projects.routes.ts`: `listProjects()` accetta `filters?: {tipoCommessa?, status?[]}` (nessun filtro = comportamento invariato, non rompe `OperaioPage` che chiama senza filtri). Nuovo `getProjectsSummary()` + `GET /projects/summary` (conteggi per tipo/stato in una sola query group-by), registrato **prima** di `GET /:id` (stessa trappola di routing di `/assignable-users`), aperto a chiunque autenticato come gli altri read di questo router.
  - **Verificato**: `npx tsc -b packages/backend` pulito (a parte i 4 preesistenti sopra), **146/146 test Vitest verdi** (era 141 prima di questa sessione: +12 nuovi test — 7 su reports, 5 su projects — su periodo/LEFT-JOIN/timeline/filtri/summary).

**Fase 2 completata (frontend)**:
- `lib/types.ts`/`lib/api.ts`: allineati a tutte le nuove forme backend (`ProjectEmployeeRow`, `ProjectsSummary`, `ProjectTimeline`/`ProjectTimelineEntry`, `DateRange`, `ListProjectsFilters`), `buildQuery()` helper per le query string opzionali. `UserTimeLogRow` (backend e frontend) ha ora anche `tipoCommessa` (mancava, aggiunto per poter formattare l'ID anche nelle righe della cronologia dipendente — piccola estensione scoperta implementando, non prevista nel piano originale).
- `CantieriPage.tsx`: riscritta a tab (Consuntivo/A contratto), paginazione indipendente per tab, `NewProjectForm` senza più tendina tipo (usa il tipo della tab attiva — evita di creare un cantiere nella tab sbagliata).
- `DashboardPage.tsx`: 2 tile (consuntivo/contratto) al posto di "Cantieri totali" via `api.getProjectsSummary()`; rimossi "Ore per tipo" e "Segnalazioni aperte" (confermato dall'utente dopo spiegazione). `badgeClassForSeverity`/`REPORT_KEY_BY_TIPO` rimossi da `format.ts` (diventati morti dopo la rimozione, verificato con grep prima di cancellare).
- `ReportPage.tsx`: selettore `<input type="month">` + bottone "Tutto lo storico" (default = tutto lo storico, comportamento invariato per chi non lo tocca). Il periodo scelto compare nell'area stampabile, non in un blocco `.no-print`.
- `DipendenteDetailPage.tsx`: badge-row "Ore per tipo" (stessa forma tolta dalla dashboard, spostata qui su riferimento esplicito dell'utente — "come ore per tipo nel dashboard").
- `CantiereDetailPage.tsx`: nuova sezione `TabellaOre` con le ore per singolo dipendente (`detail.employees`), più `RegistroCantiere` in fondo alla pagina.
- **Decisione 18/08 applicata**: `RegistroCantiere` (nuovo componente, `components/RegistroCantiere.tsx`) è visibile SIA nel dettaglio di un cantiere attivo SIA dalla nuova `ArchivioPage.tsx` (che elenca solo i cantieri `status=completed` — `blocked` resta tra gli attivi) — sostituisce la vecchia decisione del 10/08 che lo voleva solo su pagina separata.
- Route `/archivio` + voce menu in `AppLayout.tsx` (gate admin/project_manager, come Report/Dipendenti).
- **Verificato**: `tsc -b` pulito su entrambi i pacchetti (solo i 4 errori preesistenti), **146/146 test backend ancora verdi**, nessun errore in console/HMR nel browser reale (navigato su /login, bundle compila ed esegue senza eccezioni). **NON verificato visivamente** (stesso limite di sempre: il pannello Browser di questa sessione non è loggato, non posso digitare la password nemmeno per l'account seed) — da chiedere all'utente come nelle sessioni precedenti.

L'utente ha scelto di saltare la verifica visiva per ora e procedere con la Fase 3 ("controlliamo tutto insieme alla fine").

**Fase 3 completata (la più delicata — modifica cantiere/dipendente/ore)**:
- **Cantiere**: `ProjectEditForm` in `CantiereDetailPage.tsx` (nome/tipoCommessa/status) — il backend (`PATCH /projects/:id`) accettava già tutto, mancava solo la UI. Cambiare status a "completed" è anche il modo in cui un cantiere finisce in Archivio (nessun bottone "archivia" separato).
- **Dipendente**: `UserEditForm` in `DipendenteDetailPage.tsx`, **solo admin** (`/users` è admin-only, a differenza di `/dipendenti` che PM può vedere — il form non viene nemmeno renderizzato per un PM). **Email ora modificabile**, come richiesto esplicitamente dall'utente contro il consiglio dell'architect: aggiunta a `updateUserSchema` + `updateUser()` ora cattura la violazione UNIQUE Postgres (23505) come fa già `createUser()` — senza, un'email duplicata avrebbe risposto 500 invece di un errore chiaro. Due nuovi test di regressione.
- **Ore (time_log)**: `TimeLogEditForm.tsx`, componente condiviso usato sia da `RegistroCantiere` sia dalla cronologia ore in `DipendenteDetailPage` (un solo editor, due punti di ingresso, come suggerito dall'architect). Permesso ad admin/PM (RBAC già presente prima di questa sessione, non serviva estenderlo). Tre correzioni reali al backend:
  1. **Bug corretto**: `taskId` in PATCH veniva scartato in silenzio da Zod (mai dichiarato nello schema) nonostante il frontend lo inviasse già — "sposta questa registrazione sul cantiere giusto" non faceva nulla, senza errore. Aggiunto a `updateSchema` e `UpdateTimeLogInput`.
  2. **Riassegnazione dipendente** (`userId` in PATCH): applicata SOLO se chi chiama è admin/PM (altrimenti ignorata, non rifiutata — stesso anti-tampering di `createTimeLog`), validata same-company. Il tetto 8h/giorno ordinario viene ricalcolato sull'utente e la data EFFETTIVI dopo la riassegnazione, non su quelli originali — verificato con un test che riassegnare a un dipendente già a 8h quel giorno viene bloccato (400).
  3. **Audit trail**: `recordAudit()` esisteva ma non era mai stata chiamata da codice di produzione prima di questa sessione — ora scrive una riga (`UPDATE`/`DELETE`) quando chi modifica/cancella NON è il proprietario originale della riga (sempre un admin/PM che corregge un operaio). Verificato che un operaio che modifica le proprie ore NON lascia traccia (solo le correzioni altrui contano).
  4. Tutto `updateTimeLog`/`deleteTimeLog` ora gira in `db.transaction` con `FOR UPDATE` sulla riga (stesso idioma già in uso nel progetto per users/projects) — prima non serviva, ora aggiorna anche `timeLogMaterials` e `audit_log` nella stessa operazione logica.
- **Bonus, due bug preesistenti in meno** (non richiesti, trovati e corretti mentre si toccava codice adiacente): tipo `AuditAction` mancante nello schema (`schema/auditLog.ts` esportava solo l'enum Drizzle, non il tipo TS derivato — mai notato perché `recordAudit` non veniva mai chiamata davvero prima d'ora); funzione `sumByTipo` in `reports.service.ts` con annotazione `: unknown` esplicita che cancellava un tipo più preciso (Fase 1). **Errori preesistenti passati da 7 file a 3** (seed.ts, ConflictError.ts, tenant.ts — tutti fuori dal perimetro toccato in questa sessione).
- **Verificato**: `npx tsc -b` pulito su entrambi i pacchetti (solo i 3 errori residui sopra), **156/156 test backend verdi** (+18 nuovi in questa fase: 8 su timeLogs riassegnazione/audit/bug taskId, 2 su users email, altri di regressione), nessun errore applicativo in console (un solo `ERR_NETWORK_IO_SUSPENDED` per una risorsa accessoria, tipico di una tab del browser rimasta sospesa a lungo — non un bug del codice, la pagina di login renderizza correttamente). **Non verificato visivamente** — stesso limite di sempre.

**Stato finale**: tutti e 8 i punti della richiesta utente sono implementati e testati lato backend/type-check. Prossimo passo: l'utente farà la verifica visiva completa (sua scelta esplicita: "controlliamo tutto insieme alla fine"). Nessun commit ancora fatto (0 commit nel repo, come da regola — serve conferma esplicita).

---

### STATO VERIFICATO AL SALVATAGGIO (12/08, dopo FASE 5 e i fix conseguenti)
- **Backend: 134/134 test Vitest verdi**, RIVERIFICATO dopo i fix FASE 5 (non solo il numero pre-FASE-5): 2 esecuzioni pulite consecutive, **exit code controllato esplicitamente** (`echo $?` = 0 entrambe le volte — lezione di questo stesso progetto, vedi punto 12 nella sessione 10/08 notte, "`| tail` maschera un fallimento").
- **Frontend + backend: `npx tsc -b packages/backend packages/frontend` pulito su ENTRAMBI dopo i fix** — stessi ~18 errori preesistenti di sempre (seed.ts, ConflictError.ts, core/tenant.ts, auditLog.types.ts, reports.service.ts), zero nuovi. Le due righe di `timeLogs.routes.ts` (95/132) che erano nella lista preesistente **sono state corrette in questa sessione** (vedi FASE 5 sotto) — non ci sono più.
- **Git: 0 commit, tutto ancora non versionato** — invariato, confermato di nuovo con `git status` (ogni file del progetto risulta `??`, MAI esistito un commit in questo repository). NON committare senza chiedere esplicitamente all'utente — se/quando lo fa, sarà il PRIMO commit nella storia del progetto, non un commit incrementale: vale la pena dirlo esplicitamente all'utente prima di procedere, non darlo per scontato come un commit qualsiasi.
- **Docker Desktop + Postgres**: erano spenti anche a metà di QUESTA sessione (serviva Postgres per far girare la suite reale dopo i fix FASE 5) — riavviati di nuovo (`Start-Process 'Docker Desktop.exe'`, percorso vero: `C:\Users\morta\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe`, NON `C:\Program Files\Docker\...` che non esiste su questa macchina; poi `docker compose up -d` dalla root del progetto), ora attivi e verificati con `pg_isready`. I server applicativi (backend porta 4000, frontend porta 5173) NON sono stati riavviati in questa sessione — solo il DB.

### PROSSIMO PASSO ESATTO
**FASE 5 completata: 3/3 agenti tornati** (tester, security, reviewer — nessuno perso, a differenza di altre volte in questo progetto). Rilievi reali confermati (non "0 problemi"), inclusi 2 bug seri: un crash 500 dal vivo su `POST /time-logs` senza `userId`, e un bug di correttezza nel mio stesso lavoro di questa sessione (il nome del dipendente assegnato appariva "Non assegnato" per ruoli diversi da admin/PM anche quando il lavoro ERA assegnato). Tutti i rilievi con un impatto concreto e diretto sulle due funzionalità di questa sessione sono stati **corretti e riverificati** (elenco completo e dettagliato più sotto, sezione "FASE 5"). Alcuni rilievi più ampi/preesistenti sono stati **segnalati all'utente ma NON toccati** (decisione sua se e quando affrontarli) — anche questi elencati sotto con il motivo per cui non sono stati corretti d'ufficio.

**Punto esatto di ripresa se interrotto ora**: FASE 5 e tutti i fix conseguenti (inclusa `auth.middleware.ts`, corretta su conferma esplicita dell'utente) sono completi e verificati (134/134 test, `tsc -b` invariato, exit code 0 controllato). **L'utente ha risposto "No, non ancora" sul primo commit del repository** — resta tutto non versionato, non riproporre la domanda senza che sia l'utente a tornarci su. Nessun agente in background pendente, nessun task aperto in questa sessione.

**Task secondario ancora non implementato (invariato da sessioni precedenti)**: "Archivio Cantieri" — piano già pronto dall'architect, vedi sezioni sessioni precedenti sotto.

**Problemi noti aperti (MEDIO/BASSO, non bloccanti):**
- Pattern di costruzione condizioni in `auditLog.service.ts` da allineare ai moduli fratelli.
- Test di isolamento multi-tenant da rafforzare in generale (NOTA 12/08: quello specifico su `tasks.assignedTo` è stato trovato e corriso in questa sessione, vedi sotto — ma potrebbero essercene altri non ancora cercati in altri moduli).
- `badgeClassForSeverity` in `format.ts` da rendere esaustiva via `Record` invece di `switch`.
- ~20 errori preesistenti in `npx tsc -b packages/backend` (vedi sopra) — mai affrontati, fuori scope di ogni sessione finora.
- Alcuni commenti imprecisi da correggere (elenco completo nel corpo del file sotto la sezione "Sessione 10/08 notte", punto 10).

### EPISODIO DA NON DIMENTICARE (risolto, ma istruttivo)
Durante la sessione notte del 10/08, il fix `companyId` sulla guardia "ultimo admin" in `users.service.ts` è sparito e ricomparso da solo tra due letture ravvicinate dello stesso file (probabile salvataggio intermedio di un editor esterno colto a metà — l'utente lavora spesso in parallelo in VS Code). Verificato con i test reali che ora è presente e funzionante (16/16 verdi in `users.test.ts`, inclusi i 2 di isolamento multi-tenant). Se riprendi il lavoro e trovi di nuovo il filtro mancante a riga ~135 di `users.service.ts` (query `activeAdmins`), NON è stato rimosso consapevolmente — rileggere il file e verificare con `npx vitest run src/modules/users` prima di qualunque altra cosa.

### Sessione 12/08 — Assegnazione dipendente + Ora di fine

Ripresa da questa stessa richiesta rimasta aperta dall'11/08 07:32. L'utente ha chiarito le ambiguità con 3 domande dirette:
1. Dove assegnare: **sia creazione che modifica** del Lavoro.
2. Assegnazione: **facoltativa**, non obbligatoria.
3. Ora di fine: **si affianca** a "Ore" (che resta manuale) — nessun calcolo automatico, solo informativa.

**Scoperta prima di implementare**: non esisteva NESSUN form di modifica di un Lavoro (solo creazione) — la lista lavori in `CantiereDetailPage.tsx` era testo statico non cliccabile, e `api.updateTask` non esisteva in `lib/api.ts` pur essendo `PATCH /tasks/:id` già completo lato backend. Costruire "modifica" per l'assegnazione è stato quindi un pezzo di lavoro più grande del previsto — l'utente ha confermato di volerlo comunque.

**1. Endpoint nuovo `GET /api/v1/tasks/assignable-users`** (`packages/backend/src/modules/tasks/{tasks.routes.ts,tasks.service.ts,tasks.types.ts}`): scelto un endpoint DEDICATO invece di allargare `GET /users` (che resta riservato solo ad admin) — chi gestisce i task (`TASK_MANAGER_ROLES` = admin+project_manager) può leggerlo, ma non l'intero CRUD utenti. Restituisce solo `{id, name}` di operai attivi della company del chiamante. Registrato PRIMA di `GET /:id` nel router (altrimenti Express lo instraderebbe lì, trattando "assignable-users" come un id non valido) — `requireRole(...TASK_MANAGER_ROLES)` applicato direttamente sulla singola rotta, non sul `.use('/', ...)` globale del router (quello resta per la sezione di sola scrittura più sotto).

**2. Bug di isolamento multi-tenant trovato e corretto**: `assignedTo` era già accettato dall'API (FK verso `users.id`, senza scoping per company) ma non era mai stato sfruttabile perché nessuna UI lo esponeva. Costruendoci sopra una UI il buco diventava concretamente raggiungibile: un admin avrebbe potuto assegnare un task a un id utente di UN'ALTRA azienda, se lo conosceva/indovinava. **Corretto in `tasks.service.ts`**: nuova funzione `assertAssignableUser(userId, companyId)` (stessa company + role='operaio' + active=true), chiamata sia in `createTask` che in `updateTask` prima di salvare `assignedTo`. Test di regressione aggiunti (cross-tenant → 404, assegnazione a un non-operaio → 404).

**3. Frontend** (`CantiereDetailPage.tsx`): dropdown "Assegna a" (facoltativa) nel form di creazione lavoro; nuovo componente `TaskRow` con modalità di modifica inline (bottone "Assegna" → dropdown + Salva/Annulla) per lavori esistenti. Se chi guarda la pagina non è admin/project_manager, la chiamata a `/assignable-users` prende 403, gestito silenziosamente (stesso pattern già esistente per `kpiForbidden`): la lista resta vuota, la UI di assegnazione sparisce, il resto della pagina funziona comunque.

**4. "Ora di fine" su `time_logs`**: nuova colonna `end_time` (migrazione Drizzle `0006_sturdy_mister_sinister.sql`, stesso pattern della `0005` che aveva aggiunto `start_time`). SEMPRE facoltativa, anche con tipo `'ordinario'` (a differenza di `startTime`, obbligatoria in quel caso) — deliberatamente NON entra nel calcolo automatico ordinario/notturno/straordinario (`nightHoursInShift`/`DAILY_ORDINARY_CAP_HOURS` in `timeLogs.service.ts`, non toccato). Propagata su ogni riga generata dallo split automatico (stesso trattamento di `startTime`). Rinominata la costante Zod `START_TIME` → `TIME_HHMM` in `timeLogs.routes.ts` per riuso onesto su entrambi i campi. Frontend (`OperaioPage.tsx`): input accanto a "Ora di inizio", propagato in `resetForm`/`startEdit`/`repeatLast`/`handleSubmit`, mostrato nello storico come "(da HH:MM a HH:MM)".

**5. Verifica**: `npm test --workspace=packages/backend` → 134/134 (era 121, +13: 7 su `tasks.test.ts`, 3 su `timeLogs.test.ts`, 3 sul fix multi-tenant). `npx tsc -b` pulito su entrambi i pacchetti (gli errori preesistenti nel backend, vedi sopra, non sono di questa sessione — confermato confrontando col contenuto dei file letto PRIMA di ogni modifica, non per sentito dire). FASE 5 (tester/security/reviewer) lanciata in background, esito non ancora noto al momento di questo salvataggio — vedi "PROSSIMO PASSO ESATTO" in cima al file.

**File toccati fino a qui in questa sessione** (prima di FASE 5):
- `packages/backend/src/core/db/schema/timeLogs.ts` (+endTime)
- `packages/backend/drizzle/0006_sturdy_mister_sinister.sql` (nuova migrazione)
- `packages/backend/src/modules/timeLogs/{timeLogs.routes.ts,timeLogs.service.ts,timeLogs.types.ts}`
- `packages/backend/src/modules/tasks/{tasks.routes.ts,tasks.service.ts,tasks.types.ts}`
- `packages/backend/src/modules/tasks/tasks.test.ts`, `packages/backend/src/modules/timeLogs/timeLogs.test.ts`
- `packages/frontend/src/pages/CantiereDetailPage.tsx`, `packages/frontend/src/pages/OperaioPage.tsx`
- `packages/frontend/src/lib/{api.ts,types.ts}`

### FASE 5 — 3/3 agenti tornati, rilievi reali confermati, tutti i fix con impatto diretto applicati

**Tester** ha eseguito prove dal vivo contro Postgres reale (non solo lettura statica), riproducendo 9 bug con probe concreti (payload/risposta osservati, non dedotti). **Security** ha letto il codice reale (routes/service/types/middleware/schema/migrazione/test) e trovato 5 problemi, poi verificati io stesso in modo indipendente (non fidato a occhio). **Reviewer** ha letto tutto il codice toccato + `index.css`/`format.ts`/CLAUDE.md/session.md, trovato 1 ALTO + 5 MEDI + 10 BASSI. Le tre liste si sovrappongono su più punti (stesso bug trovato da 2 o 3 agenti indipendentemente) — segnale di affidabilità, non rumore duplicato.

**Corretti, in ordine di gravità (tutti riverificati con `tsc -b` + suite Vitest completa dopo ogni gruppo di fix, 134/134 finale, exit code controllato esplicitamente):**

1. **[CRITICO, riprodotto dal vivo dal tester]** `POST /time-logs` da admin/PM senza `userId` esplicito → **500** (`UNDEFINED_VALUE: Undefined values are not allowed`), con l'ESATTO payload che manda `OperaioPage` (che non invia mai `userId` e non ha guardia di ruolo, quindi chiunque autenticato può arrivarci). `timeLogs.service.ts`: `targetUserId = isManager(...) ? (input.userId ?? actingUser.id) : actingUser.id` (prima: nessun `?? actingUser.id`, `undefined` finiva in un confronto Drizzle che il driver Postgres rifiuta). `CreateTimeLogInput.userId` reso opzionale (era dichiarato obbligatorio, mai stato allineato allo schema Zod che lo era già).
2. **[ALTO, trovato dal reviewer, confermato con probe dal tester]** Il nome del dipendente assegnato risolto **lato client incrociando `assignableUsers`** (lista vuota per ruoli non-manager per via del 403, e comunque priva di operai disattivati/promossi) → ogni Lavoro appariva "Non assegnato" per `resource`/`qa`/`stakeholder`/`operaio` **anche quando era davvero assegnato**, e per un operaio disattivato la stessa cosa succedeva pure ad admin/PM, con l'aggravante che il bottone "Assegna" per correggerlo spariva insieme. Un mio commento (righe 19-22 originali di `CantiereDetailPage.tsx`) dichiarava il comportamento OPPOSTO — falso, corretto insieme al codice. **Fix strutturale, non un cerotto**: `tasks.service.ts` ora fa un `leftJoin` su `users` in `listTasks`/`getTaskById` e restituisce `assignedToName` già risolto (nuovo campo in `PublicTask`/`Task`); `createTask`/`updateTask` ri-leggono con `getTaskById` dopo la scrittura per includerlo. Il frontend non incrocia più nulla — legge `task.assignedToName` direttamente. Risolve anche il caso "operaio disattivato" per costruzione (il leftJoin non filtra per `active`).
3. **[ALTO effettivo, trovato dal tester con un caso riprodotto]** `TaskRow` (`CantiereDetailPage.tsx`): `useState(task.assignedTo)` inizializzato solo al mount, il componente sopravvive ai refetch (stessa `key`). Effetti concreti dimostrati: "Annulla" non annullava davvero (la scelta scartata restava in stato e veniva salvata al giro successivo); **due utenti in parallelo**: il secondo, aprendo "Assegna" su un lavoro appena riassegnato da un collega, vedeva ancora il valore vecchio congelato al mount e poteva **sovrascrivere in silenzio** l'assegnazione appena fatta dal primo. Fix: `syncAndToggle()` risincronizza `assignedTo` dal prop `task` corrente sia all'apertura della modifica sia su Annulla — la bozza riparte sempre dal valore vero e attuale, mai da uno stato congelato.
4. **[MEDIO, confermato dal vivo dal tester]** `endTime` non cancellabile una volta salvato: `endTime || undefined` elimina la chiave dal JSON (il backend supporta `PATCH {endTime:null}` e cancella correttamente — verificato che il difetto era SOLO frontend). Nuovo tipo `UpdateTimeLogInput` (diverso da `Partial<CreateTimeLogInput>` apposta: l'update deve poter dire "cancella" con `null`, la creazione deve poter dire "non fornito" con `undefined` — sono semantiche diverse, non lo stesso tipo con meno campi). `handleSubmit` ora costruisce payload diversi per create vs update.
5. **[MEDIO, misurato dal tester con esempi concreti]** `endTime` duplicato identico su ogni riga generata dallo split automatico → dato oggettivamente falso (una riga da 2h che dichiarava una finestra di 10h; un caso da 30h produceva 3 righe che dichiaravano TUTTE la stessa finestra di 9h). `timeLogs.service.ts`: `endTime` scritto solo quando la registrazione NON si divide (`portions.length === 1`), `null` su ogni riga quando si divide — stesso principio già applicato ai materiali, con un commento che spiega perché `startTime` invece resta duplicato (è vero per ogni porzione, `endTime` sull'intera registrazione originale non lo è più una volta spezzata).
6. **[MEDIO/ALTO combinato, reviewer M4 + tester A8/A9]** "Ora di inizio/fine" visibili solo per `tipo==='ordinario'`, ma lo stato non si svuotava cambiando tipo → orari fantasma su righe ferie/permesso nello storico; e chi registra straordinario/festivo non poteva indicarli affatto pur essendo accettati dal backend per ogni tipo. Fix: campi sempre visibili (startTime obbligatorio solo per ordinario), invece di nascosti-ma-ancora-inviati — quello che l'operaio vede è sempre quello che verrà salvato.
7. **[BASSO/MEDIO per impatto reale, security+tester]** Filtro `?userId=` su `GET /time-logs` morto (`listQuerySchema` non lo dichiarava, errore tsc mai notato) — aggiunto.
8. **[BASSO/MEDIO per impatto reale, tester B4]** `api.listTasks` senza `limit` → default backend 20, un cantiere con più di 20 lavori nascondeva i più vecchi (non assegnabili né modificabili). Aggiunto `&limit=100`, stesso principio già applicato ai cantieri (`PROJECTS_FETCH_LIMIT`).
9. **[MEDIO, reviewer M7]** `CLAUDE.md` di progetto aggiornato: endpoint `GET /tasks/assignable-users`, `assignedTo`/`assignedToName` in Tasks, `startTime`/`endTime` nel body di `/time-logs`, e corretta la forma di risposta POST già sbagliata da prima (`{timeLog}` documentato, `{timeLogs:[]}` quello vero).

**Segnalati all'utente, poi decisi con AskUserQuestion:**
- **`auth.middleware.ts` righe 33-45 — CORRETTO su richiesta esplicita dell'utente** (impatto su TUTTA l'app, non solo questa sessione, quindi chiesta conferma prima di toccarlo): `requireAuth` leggeva la riga utente fresca dal DB (per invalidare subito un account disattivato) ma costruiva `req.user` dal **payload del JWT**, non dalla riga appena letta — `role`/`companyId` potevano restare quelli di quando il token era stato emesso per l'intera sua durata (`JWT_ACCESS_EXPIRES_IN`, default 15m; scenario concreto: un `project_manager` retrocesso da un admin avrebbe continuato a gestire i task col vecchio ruolo fino a 15 minuti). Ora `req.user` è costruito da `user` (la riga già letta per il controllo `active`, zero query in più), non da `payload`. **Riverificato dopo il fix**: `tsc -b` invariato (18 errori preesistenti, zero nuovi), 134/134 test ancora verdi, exit code 0.
- **[sistemico, bassa gravità] `companyId` esposto in ogni risposta** di `GET /tasks` e `GET /time-logs` (`toPublicTask`/`toPublicTimeLog` fanno `const {...x} = row` che non filtra nulla). Non è un leak cross-tenant (il chiamante ce l'ha già nel proprio JWT), ma è incoerente con `AssignableUser` (solo id+name, deliberatamente). Refactor più ampio (tocca il pattern in più moduli), fuori scope di questa sessione.
- **[minore, giudizio discutibile] `assertAssignableUser` risponde 404 invece di 400/422** quando l'assegnatario non qualifica. Difendibile in entrambi i modi (404 = "non trovato tra gli assegnabili" vs 400 = "input non valido"); lasciato 404, coerente con l'omonima funzione già esistente prima di questa sessione.
- **[espansione di scope, non un bug] `endTime` invisibile nei report manager** (`reports.service.ts` non lo seleziona, quindi si vede solo nello storico dell'operaio). Se l'obiettivo finale è "il manager verifica gli orari del turno", questo è il punto dove servirebbe — ma non era nella richiesta originale.
- **[out of scope, debug residuo] `packages/backend/src/modules/timeLogs/zzprobe2.test.ts`**: file di debug in `src/` (finisce anche in `dist/`), 8 dei 9 `it()` senza un vero `expect` (passano qualunque cosa risponda il server), uno fa un `UPDATE users SET active=false` diretto con restore a fine test. Contribuiva silenziosamente al conteggio "134/134" senza verificare nulla. Segnalazione per `/ordina`, non cancellato d'ufficio (regola del progetto: mai io stesso file "di troppo" senza che sia esplicitamente un mio residuo).
- **[osservazione di prodotto, non un bug] `assignedTo` non è consumato da nessuna parte** oltre `CantiereDetailPage` (grep su tutto `packages/`): l'operaio non vede da nessuna parte quali lavori gli sono stati assegnati, nulla filtra/notifica in base all'assegnazione. Se l'obiettivo era "assegnare per far sapere al dipendente cosa fare", la metà utile *per lui* non esiste ancora — natural next step, non implementato (fuori dalla richiesta originale "assegna nel form").
- **[fragilità nota, non sfruttabile oggi, 3 agenti concordi]** `tasks.routes.ts`: `/assignable-users` è protetta da un `requireRole` inline (riga 77), mentre le altre scritture si affidano a un `.use('/', requireRole(...))` posizionale più sotto (riga 98) — chi aggiungesse una rotta pensando "tanto c'è lo `use` sotto" la aprirebbe per sbaglio a ogni ruolo autenticato. Non sfruttabile oggi (verificato dal tester: nessuna variante di path/case/trailing-slash lo aggira) e coperto dai test esistenti se qualcuno lo rompesse per errore — segnalato, non rifattorizzato.

### Sessione 10/08 notte — Dashboard admin, vista operaio, fix sicurezza audit log
Ripresa la sessione dopo la chiusura di "sera". Lavoro svolto, tutto verificato con dati reali (non solo letto sul codice), in ordine:

**1. Icona "Cantieri" nel menu, era un casco (`HardHatIcon`) → ora una gru (`CraneIcon`)**. Su segnalazione dell'utente. Primo tentativo (disegno libero) sostituito su richiesta con uno basato su un'immagine di riferimento generata con Higgsfield (semplificata per restare leggibile a 20px: tetto spiovente + gancio, senza il traliccio a X dell'originale, troppo fine per un'icona piccola). Confermato dall'utente. File: `packages/frontend/src/components/icons.tsx`, `AppLayout.tsx`, `DashboardPage.tsx`.

**2. Falso allarme investigato PRIMA di "correggerlo"**: l'utente aveva chiesto di sistemare come priorità il bug "refresh-token senza companyId" segnalato nella sessione precedente. Riletto il codice: `companyId` c'è già in `rotateRefreshToken()` (auth.service.ts riga 138-141). Verificato con chiamata HTTP reale (login→refresh→uso token): 200 OK, nessun 401. File non modificato da prima della segnalazione originale (mtime 14:29, invariato). Conclusione: la segnalazione di sicurezza della sessione precedente era quasi certamente un errore del security agent (analisi statica), non un bug reale. Segnalato in `registro-attriti.md` (`~/.claude/registro-attriti.md`, voce 2026-08-10).

**3. Fix sicurezza reale, trovato mentre si progettavano i miglioramenti dashboard**: `listAuditLogs()`/`getAuditLogById()` in `packages/backend/src/modules/auditLog/auditLog.service.ts` **non filtravano MAI per companyId** — qualunque utente autenticato, di qualunque azienda, poteva leggere `GET /api/v1/audit-logs` di TUTTE le aziende (query verificata riga per riga, poi confermata con `and(eq(auditLog.companyId, companyId), ...)` mancante). Impatto pratico oggi basso (nessun punto del codice chiama ancora `recordAudit()` in produzione, tabella probabilmente vuota) ma il bug di codice era reale e sarebbe diventato pericoloso alla prima integrazione futura. **Corretto**: aggiunto il filtro `companyId` (stesso pattern di `tasks.service.ts`), route aggiornate per passare `req.user.companyId`. **2 nuovi test di regressione** in `auditLog.test.ts` (utente di un'altra azienda: non vede la voce in lista, riceve 404 sull'id diretto) — **111/111 test verdi** dopo il fix (era 109).

**4. Dashboard ADMIN arricchita** (richiesta utente: "mancano informazioni"), pacchetto a zero nuovo backend scelto dall'utente su proposta del designer:
   - **Scomposizione ore per tipo** (ordinario/straordinario/notturno/festivo/permesso/ferie) sotto la tile "Ore registrate" — dati già disponibili da `getHoursByUser()`, nessuna chiamata in più.
   - **Classifica "Cantieri per ore consumate"** (top 5, barra proporzionale, link al dettaglio) — usa `getHoursByProject()`, già esistente ma prima usato solo in `/report`.
   - **Tile "Segnalazioni aperte"**: collega per la PRIMA VOLTA il modulo backend `corrections` (esisteva completo e testato ma zero uso nel frontend) — nuova `api.listCorrections()`, nuovo tipo `Correction`. Conteggio "aperte" = `status==='open'` sulle 100 più recenti (nessun filtro per status lato server); se le segnalazioni totali superano 100 il conteggio si etichetta come parziale invece di spacciarlo per il totale reale.
   - File: `DashboardPage.tsx`, `lib/api.ts`, `lib/types.ts`, `lib/format.ts` (+`badgeClassForSeverity`), `index.css` (+`.badge-high`/`.badge-critical`).

**5. Vista OPERAIO riscritta quasi per intero** (richiesta utente: "mancano funzioni"), stesso criterio zero-nuovo-backend:
   - Due schede **"Registra ore" / "Storico"** (la pagina cresceva troppo per uno scroll unico).
   - **Conferma visiva dopo il salvataggio** che spiega lo split automatico (es. "Salvate 9,0h → divise automaticamente in 2,0h ordinario + 7,0h notturno") — la risposta `POST /time-logs` con più righe esisteva già, prima veniva ignorata dal frontend.
   - **"Ripeti ultima registrazione"**: precompila cantiere/lavoro/ora di inizio dall'ultima riga. ~~TimeLog non porta il projectId, cerca tra i task di ogni cantiere~~ **SUPERATO dal fix del punto 8**: ora usa `GET /tasks/:id` direttamente (costo costante, corretto anche con più di 20 cantieri).
   - **"Ultimi 7 giorni"**: una riga per giorno, giorni senza ore in evidenza rossa (oggi escluso dall'evidenza se vuoto — mostra "Non ancora registrato", non un falso allarme).
   - **Selezione lavoro con descrizione+stato** invece di tendina cieca coi soli titoli.
   - **Icone SVG vere** (`DocumentIcon`/`PackageIcon`) al posto delle emoji 🛠/📦, uniche rimaste nell'app.
   - File: `OperaioPage.tsx` (riscritta), `lib/api.ts` (`listTimeLogs` ora accetta un limite, passato 100 invece del default 20).
   - **Verificato interamente con un operaio di prova reale** (creato via API, poi cancellato insieme a cantiere/task/time-log di test): split 9h→2h+7h confermato in un salvataggio vero, "ripeti ultima" confermato precompilare l'ora, "ultimi 7 giorni" confermato mostrare i buchi in rosso, icone confermate via ispezione DOM (path SVG esatti, non emoji). `tsc -b` pulito su entrambi i pacchetti, `npm run build` frontend pulito.

**6. Richiesta nuova emersa a metà sessione, non ancora implementata**: "Archivio Cantieri", vedi task aperto in cima a questo file.

**7. Secondo fix sicurezza reale, trovato dopo il fallimento dell'agente security** (session limit, vedi sopra) seguendo comunque la sua ultima traccia visibile ("Found something significant in `users.service.ts`") — investigato io stesso, senza aspettare un riavvio dell'agente:

`updateUser()` in `packages/backend/src/modules/users/users.service.ts` aveva **tre punti senza filtro companyId** (lettura del target, conteggio "admin attivi" per la guardia anti-lockout, UPDATE finale) — a differenza di `getUserById()`/`listUsers()` nello STESSO file, che il filtro ce l'hanno già: un'incoerenza interna al file, non una scelta deliberata. Effetto pratico, più grave del bug dell'audit log perché qui si tratta di SCRITTURA non solo lettura:
- Un admin di un'azienda poteva leggere/modificare (inclusa la disattivazione) un utente di un'ALTRA azienda conoscendone solo l'id.
- La guardia "non rimuovere l'ultimo admin attivo" contava gli admin attivi **su tutto il sistema**, non per azienda: se l'Azienda A aveva 5 admin e l'Azienda B ne aveva 1 solo, un admin di A poteva disattivare l'unico admin di B — il conteggio globale restava comunque > 1 (sé stesso + il bersaglio), quindi la guardia non scattava mai per proteggere l'azienda del bersaglio. Un blocco totale dell'accesso per l'Azienda B, causato da un'azienda diversa.
- Interessante: il file di test aveva già un commento che riconosceva esplicitamente "il conteggio della guardia è GLOBALE su tutta la tabella users" — la natura globale era nota, ma il ragionamento nel commento copriva solo il caso "auto-lockout via richiesta HTTP" (impossibile perché l'attore stesso è sempre un admin attivo che gonfia il conteggio), non il caso cross-tenant che ho trovato (dove è proprio l'attore di un'ALTRA azienda a gonfiare il conteggio, mascherando lo zero locale del bersaglio).

**Corretto**: aggiunto `eq(users.companyId, actingUser.companyId)` a tutti e tre i punti. **Scoperto e corretto anche un errore di tipo preesistente** (non tra i ~20 già noti) in `users.test.ts`: 3 chiamate dirette a `updateUser()` passavano un oggetto attore senza `companyId` (campo obbligatorio in `AuthenticatedUser`) — invisibile perché `vitest` non fa type-check completo, visibile solo con `tsc --noEmit`. Corretto passando il `companyId` reale già disponibile nello scope del test. **Aggiunti 2 nuovi test di regressione cross-tenant** (un admin non vede/modifica un utente di un'altra azienda → 404; l'invariante "ultimo admin" è per azienda, verificato con un'azienda dedicata mentre l'azienda principale del file resta con admin sani → dimostra che il conteggio sano altrove non maschera più lo zero locale). **113/113 test verdi** (era 111), `tsc --noEmit` pulito su entrambi i file toccati.

**8. Reviewer su dashboard/operaio: trovati 4 bug ALTO nel mio stesso lavoro appena "verificato"** — sfuggiti perché il mio test aveva un solo cantiere/un solo giorno. Tutti corretti:
   - **Selezione cantiere/lavoro che saltava al primo cantiere dopo OGNI salvataggio** (`OperaioPage.tsx`): `loadAll()` faceva doppio lavoro (ricarica dati + sceglie cantiere di default) e veniva richiamata anche dopo submit/delete, causando un mismatch tra `taskId` e i task effettivamente in `tasks`. Corretto separando i due compiti (`loadAll(selectDefaultProject)`, preselezione solo al mount); `resetForm()` non tocca più cantiere/lavoro.
   - **Date calcolate in UTC invece che locale**: `isoDate()` usava `toISOString()`, che tra mezzanotte e le 1-2 di notte (ora italiana) dà il giorno PRECEDENTE — rilevante perché l'app ha turni notturni fino alle 6. Corretto con un formatter in data locale.
   - **`repeatLast()` ricostruito**: cercava tra i task di OGNI cantiere dell'operaio (premessa sbagliata: l'operaio vede TUTTI i cantieri dell'azienda, non "pochi"; inoltre `listProjects()` senza parametri si fermava a 20). Ora usa `GET /api/v1/tasks/:id` (esiste già, accessibile all'operaio, scoped per azienda) — costo costante. `loadAll()` ora chiede `listProjects(1,100)`. Anche: non ripete più il `tipo` (rischio di ripetere una riga generata dallo split automatico, mai scelta dall'operaio).
   - Vari MEDIO/BASSO: `TIPI_ORDER`/`REPORT_KEY_BY_TIPO` estratti in `lib/format.ts` (era già al 3° uso, non al 2° come dicevo in un commento); `listCorrections` nella dashboard isolata in un try/catch separato (prima un suo fallimento svuotava tutta la dashboard); "Storico" mostra "N di TOTALE" invece di spacciare il numero scaricato per il totale; weekend esclusi dall'evidenza rossa nel riepilogo 7 giorni + ferie/permesso mostrati separatamente dalle ore lavorate (coerente con la decisione sull'Archivio Cantieri, punto 10); `.btn-danger` (mai usata) ora sul pulsante "Elimina".
   - **113/113 test verdi**, `tsc -b` pulito su entrambi i pacchetti dopo tutte le correzioni.

**9. Fix sicurezza #3, trovato dal security agent al rilancio**: IDOR su `GET /api/v1/time-logs/:id` — il controllo bloccava solo `role==='operaio'`, lasciando `resource`/`qa`/`stakeholder` leggere le ore di QUALUNQUE collega per id diretto, anche se la lista (`GET` senza id) li limita già alle proprie righe (stessa risorsa, due regole diverse). Corretto spostando il controllo dentro `getTimeLogById()` (ora prende anche `actingUser`, coerente con `updateTimeLog`/`deleteTimeLog` che già lo fanno così), riusando `isManager()` già esistente nel service invece del controllo ad-hoc nella route. **2 nuovi test di regressione** (`timeLogs.test.ts`). **28/28 test verdi** in quel modulo.

**10. Problemi reali trovati, NON ancora corretti — decisione dell'utente richiesta prima di toccarli:**
   - **[ALTO] `companies.service.ts`: `listCompanies()`/`getCompanyById()` non hanno NESSUN filtro companyId** — ogni utente autenticato, incluso un operaio, riceve nome/P.IVA/email/telefono/indirizzo di TUTTE le aziende clienti del sistema (l'intera anagrafica clienti del SaaS). Non è una svista isolata: `companies.test.ts` **asserisce** questo comportamento come voluto ("catalogo globale"), e `DashboardPage.tsx` ci ha già costruito sopra un filtro lato client (scarica tutto, mostra solo la propria) — quindi è una decisione di design, sbagliata per un multi-tenant ma deliberata, non va corretta in silenzio.
   - **[MEDIO] Divergenza reale tra CLAUDE.md e codice, verificata da me stesso**: CLAUDE.md riga 64 dice "`GET/POST /api/v1/corrections` — gestione correzioni (admin/PM)" e riga 67 "`GET /api/v1/audit-logs` — solo admin/PM". Il codice (di entrambi i moduli, non toccato da me) monta solo `requireAuth`, e in `auditLog.test.ts` c'è un test PREESISTENTE (non mio) che asserisce esplicitamente il comportamento più permissivo ("un resource puo leggere (200) — trasparenza audit"). Due fonti autorevoli in contraddizione: non ho scelto da solo quale sia quella giusta.
   - **[MEDIO] `updateUser()` non applica il tetto di 3 admin/azienda**: `createUser()` lo controlla (409 al 4°), ma una `PATCH /:id` con `{"role":"admin"}` promuove un utente esistente senza limite — si aggira il tetto creando 3 `resource` e promuovendoli.
   - **[MEDIO, fuori dal perimetro dei file toccati in sessione] `core/db/seed.ts`**: password di default `'Admin123!'` nel sorgente. Oggi non sfruttabile (l'insert del seed omette `companyId`, obbligatorio nello schema → fallirebbe comunque), ma è comunque una cattiva pratica da correggere.
   - Altri BASSO, vedi report completo dell'agente security (non trascritti qui per brevità): nessun test cross-tenant per `tasks`/`timeLogs`/`corrections`/`reports` (il codice è corretto oggi, verificato query per query, ma senza rete di protezione futura); `reportedBy` falsificabile in `corrections`; pattern fragile `router.use('/', requireRole(...))` montato dopo le GET in 4 file (una nuova rotta scritta nel punto sbagliato diventa silenziosamente pubblica o silenziosamente riservata, nessun test se ne accorgerebbe).

**12. Rilancio tester: la mia affermazione "113/113 verde" era sbagliata — causa trovata e corretta.** Il tester ha rilanciato la suite 8 volte: 6 fallite, sempre lo stesso sintomo (401 invece di 204/404 in `timeLogs.test.ts`). **Causa reale, non dedotta**: `withOnlyAdminOneActive()` in `users.test.ts` disattivava TUTTI gli admin del database (nessun filtro companyId), inclusi account reali — **provato con un campionamento diretto del DB durante l'esecuzione**: per una finestra di tempo erano disattivati anche `admin@workflow360.local` e l'admin reale dell'utente (`admin@neotekna.it`). Rischio concreto: se la suite si fosse interrotta in quella finestra (crash/timeout), l'utente sarebbe rimasto bloccato fuori dalla sua app. **Corretto**: filtro `companyId` aggiunto a quell'helper (la guardia che simula è ormai per azienda dal fix #7, non serve più toccare admin di altre aziende). **Verificato con 3 esecuzioni pulite consecutive, controllando l'exit code reale** (non solo l'output visivo — il tester ha segnalato che `| tail` maschera un fallimento).

Lo stesso rilancio ha anche trovato che **il mio test di regressione "l'invariante è per azienda" passava per il motivo sbagliato** (stesso token come attore e bersaglio → scattava la guardia "non puoi disattivare te stesso", che non guarda companyId, non quella che volevo testare). Corretto usando una retrocessione di ruolo su se stessi invece di un'auto-disattivazione. **Verificato rompendo di proposito il fix e controllando che il test ora fallisca davvero, poi ripristinato** — 16/16 verde.

**13. Due fix approvati dall'utente, implementati:**
- **`companies.service.ts`**: `listCompanies()`/`getCompanyById()` non avevano NESSUN filtro companyId — ogni utente autenticato (operaio incluso) leggeva nome/P.IVA/email/telefono/indirizzo di TUTTE le aziende clienti del sistema. `companies.test.ts` lo asseriva come voluto ("catalogo globale") — l'utente ha confermato di limitarlo. Corretto (anche `updateCompany`, non raggiungibile oggi ma sistemato per coerenza), test riscritti per la nuova regola, +2 nuovi test cross-tenant su `GET /companies/:id`.
- **audit-log e corrections limitati ad admin/PM** (corrections: PM+QA, riusando `CORRECTION_MANAGER_ROLES` già esistente — il QA le scrive, doveva poterle anche leggere). CLAUDE.md già lo documentava così, il codice+test dicevano il contrario ("trasparenza audit") — allineato al documento su richiesta esplicita dell'utente. Test aggiornati.
- **117/117 test verdi**, `tsc --noEmit` invariato (stessi ~30 errori preesistenti, zero nuovi).

**14. Trovati dal tester, NON ancora corretti (bug reali con dati reali, non ipotesi):**
- **[ALTA] Cancellare un cantiere/lavoro cancella in CASCATA tutte le ore registrate, senza nessun avviso** (FK `time_logs.task_id`→`tasks`: CASCADE, `tasks.project_id`→`projects`: CASCADE — provato: 15 registrazioni/100mila ore sparite con un solo DELETE). Incoerente col resto del progetto, che protegge deliberatamente `time_logs.user_id` con RESTRICT. Non raggiungibile da un click nel frontend oggi (nessun bottone elimina-cantiere), ma la rotta è viva e documentata.
- **[ALTA] Tetto 3 admin/azienda aggirabile**: `createUser` lo controlla, `updateUser` no — si promuove un utente esistente a admin via PATCH senza limite (stesso rilievo del security agent, confermato con prova reale: portato un'azienda di test da 2 a 5 admin).
- **[ALTA] Tetto 8h/giorno ordinario aggirabile**: lo split scatta solo alla CREAZIONE, non alla modifica — un operaio può creare 9h (split 8+1) poi fare PATCH a 20h sulla riga "ordinario", che resta 20h senza risplittare. Regola di business aggirata in due passaggi dallo stesso utente che dovrebbe rispettarla.
- **[MEDIA] Dashboard: "Dipendenti (operai)" e "Utenti (N/3 admin max)" contano su `listUsers()` senza parametri, troncato a 20** — con più di 20 utenti i numeri mostrati sono sbagliati (provato con 30 utenti reali: tile diceva 15, pagina Dipendenti ne mostrava 25). Bug preesistente (non introdotto in questa sessione), ma nello stesso file appena toccato.
- **[MEDIA] "Cantieri per ore consumate" (mia aggiunta A2) somma ferie/permesso nel ranking** — incoerente con la separazione già fatta altrove nella stessa sessione (OperaioPage, decisione Archivio Cantieri). Da escludere allo stesso modo.
- **[BASSA] `repeatLast()` ripropone la registrazione con la DATA più alta, non quella inserita più di recente** (`ORDER BY date` senza tie-break su `createdAt`) — con una riga di test a data futura nel DB reale (vedi sotto), ripeteva quella.
- **Righe con date/valori sospetti nei dati REALI dell'utente** (`mortaza09bakhshi@gmail.com`, azienda Neotekna SRL): 4 registrazioni create oggi (14:36-19:26) durante questa sessione, una con data 2026-09-10 (futura di un mese) e tipo "notturno" senza `start_time`, un'altra "ordinario" senza `start_time` (obbligatorio per quel tipo se inserito dal form vero) — sembrano residuo di test di un agente che ha lavorato sui dati reali invece che su un'azienda isolata. **Non cancellate**: serve conferma esplicita dell'utente, sono nel suo account reale. ID per riferimento: `14f7b0b2-e86e-49b2-9b65-973212e17e3a` (2026-09-10), `766b81b0-07a2-40a0-b414-5135f66614dc` (ordinario senza start_time).

**15. Tutti e 3 i rimedi approvati dall'utente sul punto 14, implementati e verificati:**
   - **4 righe di test-residuo cancellate** dall'account reale dell'utente (Neotekna SRL) — confermate come residuo, 0 righe rimaste per quell'utente dopo la pulizia (l'account non aveva altre ore reali registrate).
   - **Cancellazione cantiere/lavoro bloccata (409) se hanno ore registrate collegate** — `projects.service.ts`/`tasks.service.ts`, +3 nuovi test (2 che provano il blocco con ore vere collegate, verificano anche che i dati non vengano toccati).
   - **Tetto 3 admin/azienda esteso alla promozione via PATCH** (`users.service.ts`) — **primo tentativo aveva un bug vero, catturato dal test che ho scritto io stesso**: `SELECT ... FOR UPDATE` non è ammesso da Postgres insieme a `count(*)` (errore 500, non 409) — copiato per errore dal pattern sbagliato. Corretto rimuovendo `.for('update')` dalla query di conteggio (stesso motivo per cui `createUser()` non lo usa).
   - **Tetto 8h ordinario/giorno esteso al PATCH** (`timeLogs.service.ts`) — prima si applicava solo alla creazione, una riga "ordinario" poteva essere portata a qualunque valore via PATCH senza rispezzare. Ora un aggiornamento che sfora il tetto (sommato alle altre righe ordinario dello stesso giorno) viene rifiutato con 400, non applicato in silenzio.
   - **Dashboard "Cantieri per ore lavorate"** (rinominata da "per ore consumate"): non somma più ferie/permesso nella classifica, coerente con la stessa distinzione applicata altrove nella sessione.
   - **121/121 test verdi, confermato con 3 esecuzioni pulite e controllo esplicito dell'exit code** (non solo l'output visivo — lezione imparata dal tester su questo stesso file poche ore prima).

**11. Due richieste dell'utente arrivate a metà lavoro, non ancora chiarite/implementate:**
   - Nel modulo "Lavoro (task)", indicare/assegnare un dipendente specifico (il campo `tasks.assignedTo` esiste già in schema ma nessun form lo valorizza — trovato dall'architect in una sessione precedente di oggi). Richiesta ancora ambigua (chi assegna a chi, dove nel form) — da chiarire con l'utente prima di implementare.
   - Nel form ore dell'operaio, aggiungere "Ora di fine" accanto a "Ora di inizio" — chiaro COSA, ma non ancora chiarito se deve SOSTITUIRE il campo "Ore" attuale (calcolando le ore automaticamente da inizio/fine) o affiancarlo (ore ancora inserite a mano, l'ora di fine solo come informazione aggiuntiva). Cambia il disegno della funzione, da decidere prima di scrivere codice.

- **Ultimo lavoro (verificato a metà — vedi aggiornamento sotto)**: redesign completo della dashboard su riferimento immagine fornito dall'utente (sidebar blu navy, KPI con icona circolare, tabella "Cantieri recenti" con ricerca funzionante). Type-check e build puliti, codice confermato servito correttamente dal dev server via curl diretto — ma il pannello browser di automazione si è bloccato ripetutamente in questa sessione (problema di tooling, non del codice: il backend rispondeva regolarmente in parallelo) e non è stato possibile scattare uno screenshot reale. **Primo passo utile alla ripresa: aprire http://localhost:5173 in un browser vero e controllare a occhio che il redesign sia corretto**, prima di considerare la feature definitivamente chiusa.

### Aggiornamento 10/08 (nuova sessione) — verifica parziale del redesign
Server backend/frontend/Postgres risultati ancora attivi (porte 4000/5173/5432 confermate in LISTENING con `netstat`, non riavviati). Login riuscito con l'utente seed (`admin@workflow360.local`) nel browser di automazione, senza il blocco che aveva impedito la verifica nella sessione precedente. **Confermato via CSS calcolato su pagina realmente caricata** (non solo curl sul sorgente): sidebar con `bg-slate-900` presente nel DOM, 3 tile KPI con `border-radius` effettivamente circolare e `background-color` corrispondente a emerald-600 (oklch coerente con la palette Tailwind), sezione "Cantieri recenti" con casella di ricerca presente, **zero errori in console**. **Non ottenuto**: uno screenshot pixel-reale (stesso problema di tooling di pannello-non-visualizzato) — quindi il giudizio estetico finale ("è bello/leggibile come nell'immagine di riferimento") resta da fare a occhio umano; questo controllo conferma solo che il codice renderizza senza errori con le classi/colori attesi, non l'aspetto complessivo. L'account seed non ha cantieri propri, quindi la ricerca "Cantieri recenti" non è stata testata funzionalmente con dati (già testata con dati reali nella sessione precedente sull'account Neotekna SRL).
- **121/121 test Vitest verdi**, nessun errore TypeScript nuovo (restano ~20 errori preesistenti già documentati, non bloccanti per `npm run dev`, bloccanti per `npm run build` del backend — vedi sezione dedicata più sotto).
- **Nota già risolta, non richiede nessuna azione**: il tester aveva segnalato una discrepanza `ACCESS_TOKEN_TTL_MINUTES`/`JWT_ACCESS_EXPIRES_IN`, ma quella era nel file `packages/backend/.env` **orfano che è già stato rimosso in questa sessione** (task #20). Verificato ora: il vero `.env.example` nella radice del progetto usa già i nomi corretti (`JWT_ACCESS_EXPIRES_IN`/`JWT_REFRESH_EXPIRES_IN`) — nessuna incoerenza residua.

---

## Sessione 10/08 pomeriggio — Numero cantiere, dettaglio cantiere/dipendenti, report PDF

Richiesta utente: dashboard "non professionale/non moderna" + 4 funzionalità concrete:
1. Numero identificativo + data creazione per ogni cantiere nella lista.
2. Click su un cantiere → stato, quanti dipendenti ci hanno lavorato, quanto materiale usato.
3. Lista dipendenti → click → tutte le sue ore con cantiere/lavoro associato.
4. Report scaricabile PDF + stampabile.

**Decisioni prese con l'utente (AskUserQuestion, tutte raccomandate confermate):** voce "Dipendenti" in sidebar dedicata; icone SVG disegnate a mano (no libreria icone, no emoji); numero cantiere progressivo PER AZIENDA (non globale); sviluppo tutto insieme poi verifica finale.

**Consultati designer + architect (Task tool) prima di scrivere codice** — sintesi del piano approvato dall'utente prima dello sviluppo. Nota: l'architect ha sbagliato un fatto (ha detto "il frontend non ha ancora pagine, solo main.tsx" — FALSO, verificato io stesso leggendo i file reali: il frontend è completo da giorni). Scartata quell'affermazione, il resto della sua analisi tecnica era corretto e riverificato.

### Backend — fatto e verificato con dati reali
- **Migrazione** `drizzle/0004_gigantic_vance_astro.sql`: colonna `project_number` su `projects`, backfill via `ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at, id)` per i cantieri già esistenti, poi `NOT NULL` + `UNIQUE(company_id, project_number)`. **Applicata al DB reale**, verificato con query diretta: i 4 cantieri preesistenti hanno ricevuto #1-#4 correttamente.
- `projects.service.ts`: `createProject()` calcola il numero (MAX+1 per company) con un retry singolo (max 2 tentativi totali, mai infinito) su collisione `UNIQUE` — race condition rara ma possibile sotto concorrenza vera, accettata per il volume reale del progetto (poche commesse create da admin/PM, non migliaia/secondo).
- `reports.service.ts`: due nuove funzioni — `getProjectDetail()` (stato, dipendenti distinti coinvolti via `COUNT(DISTINCT time_logs.user_id)`, materiale aggregato per nome+unità, ore totali) e `getUserTimeLogDetail()` (tutte le righe timeLog di un dipendente con cantiere/lavoro associato via join task→project). Nuove rotte `GET /reports/projects/:id` e `GET /reports/users/:id/time-logs`, stesso gate `requireRole(admin, project_manager)` del resto del router report.
- **Test:** 100/100 Vitest verdi (era 95/95 prima, +5 miei: progressione projectNumber, dettaglio cantiere, dettaglio dipendente, 404, RBAC operaio). Un fallimento intermittente di 2 test preesistenti (timeLogs.test.ts, 401 invece di 204/404) si è verificato UNA volta in esecuzione parallela e non si è ripetuto al rerun (19/19 verde isolato) — flake preesistente del setup di test in parallelo su Postgres condiviso, non una mia regressione.
- **Type-check completo (`tsc --noEmit`):** zero errori NUOVI. Restano gli stessi ~20 errori preesistenti già documentati sopra (seed.ts, ConflictError.ts, tenant.ts, auditLog.types.ts, auth.service.ts, timeLogs.routes.ts, reports.service.ts righe del vecchio `sumByTipo` — bug preesistente, non toccato).

### Frontend — fatto e verificato nel browser reale
- `components/icons.tsx` (nuovo): 10 icone SVG disegnate a mano con forme geometriche di base (non copiate da libreria) — Calendar/Users/Package/Clock/ArrowRight/ArrowLeft/Printer/CheckCircle/AlertCircle/Mail.
- `index.css`: nuove classi `.stat-tile` (KPI), badge di stato (`badge-pending/in_progress/completed/blocked`), `@media print` (nasconde `.no-print`, pulisce i bordi delle card per la stampa).
- `CantieriPage.tsx` riscritta: mostra `#numero`, nome, data creazione, badge tipo+stato, link "Dettagli →". **Rimossa la vecchia fetch N+1 dei lavori per ogni cantiere della pagina** (era già segnalata come problema di scala non risolto nella sessione precedente) — ora i lavori si vedono nella pagina di dettaglio, un side-effect positivo della nuova architettura.
- `CantiereDetailPage.tsx` (nuova, rotta `/cantieri/:id`): header con numero/nome/badge, 3 KPI tile (dipendenti coinvolti, ore totali, materiali diversi), lista materiale aggregato, lista lavori + form "aggiungi lavoro" (spostato qui da CantieriPage).
- `DipendentiPage.tsx` (nuova, rotta `/dipendenti`, voce sidebar dedicata) + `DipendenteDetailPage.tsx` (rotta `/dipendenti/:id`): KPI tile (ore totali, cantieri diversi, registrazioni) + tabella cronologia ore con link al cantiere.
- `DashboardPage.tsx`: 3 KPI tile con dati reali (cantieri totali, **dipendenti = solo ruolo "operaio"**, ore totali registrate calcolate sommando il report esistente — nessun numero inventato/stimato). Corretto durante la verifica: la prima versione contava TUTTI gli utenti (inclusi admin/PM) sotto l'etichetta "Dipendenti", disallineato da cosa mostra la pagina Dipendenti collegata — ora conta solo `role === 'operaio'`.
- `ReportPage.tsx`: pulsante "Stampa / Scarica PDF" (`window.print()` + CSS `@media print`) — **zero nuove dipendenze**: "Salva come PDF" nel dialogo di stampa del browser è già un vero export PDF. Deliberatamente NON aggiunta una libreria (pdfkit/jsPDF): nessun requisito attuale (invio email automatico, pixel-perfect da server) lo giustifica.
- **Type-check (`tsc -b`) e `npm run build` frontend:** puliti, zero errori.
- **Verificato nel browser reale** (localhost:5173, login admin@workflow360.local): creati cantieri/lavori/ore/materiali di prova via chiamate HTTP reali, navigato in tutte le nuove pagine, confermato che ogni numero mostrato corrisponde ai dati reali inseriti, poi **ripulito tutto** (0 cantieri di test residui).

### Pulizia dati di test orfani — richiesta esplicitamente dall'utente ("sistema tutto") dopo la consegna
**Correzione a una nota scritta sopra in questa stessa sessione:** avevo scritto che la company seed si chiamava "TimeLogTestCo" — FALSO, verificato: il nome vero è "Azienda Default (migrazione)". Quello che avevo visto era un bug preesistente di `DashboardPage.tsx` (non toccato, vedi sotto): `api.listCompanies()` restituisce il catalogo GLOBALE di tutte le aziende (non solo la propria), e `companies[0]` prende semplicemente la prima della lista — con 23 aziende di test "TimeLogTestCo" nel database, una di quelle finiva mostrata al posto dell'azienda vera dell'utente loggato.

**Scoperta durante l'indagine**: non erano "8 utenti sparsi", ma **23 aziende intere** create da `timeLogs.test.ts` (una ad ogni esecuzione dei test, `beforeAll` crea "TimeLogTestCo" ma l'`afterAll` — che nel codice sembra corretto — evidentemente non arriva sempre a completarsi, quasi certamente per run di test interrotti manualmente in sessioni passate, non un bug nel codice del test). Prima di cancellare qualunque cosa ho verificato con query dirette: (1) tutte le 23 avevano **zero progetti/ore collegati** — debris puro; (2) `companies.test.ts` usa ANCHE il nome "Neotekna SRL" come fixture di test, lo stesso nome dell'azienda reale dell'utente (80f2f214-...) — rischio concreto di cancellare dati veri per un nome uguale. Verificato che la Neotekna SRL reale ha VAT/email diversi dalla fixture di test e i suoi 4 cantieri reali (Cantiere Centro, schiocchi, museo civico, stazione) — **confermati intatti dopo la pulizia** con una query diretta.

**Rimosso**: 9 utenti di test orfani dalla company seed (zero righe collegate, verificato prima) + 23 aziende "TimeLogTestCo" con i loro utenti (cascata manuale: time_logs→corrections→tasks→users→companies, tutte con 0 righe reali tranne 1 utente residuo). Il database ora ha **2 sole aziende reali**: la seed (1 admin) e Neotekna SRL (dati reali dell'utente, intatti).

### Redesign dashboard su riferimento visivo dell'utente (immagine Higgsfield)
L'utente ha indicato l'URL dell'immagine generata con Higgsfield all'inizio della sessione e ha chiesto "voglio che il dashboard abbia questo design". Scaricata e ispezionata l'immagine (non solo dedotta dal prompt originale) per estrarre i token esatti: sidebar blu navy scuro (slate-900) con icone bianche, badge KPI con icona circolare verde smeraldo (non più quadrata/piccola), tabella "Cantieri recenti" inline in dashboard con ricerca + numeri cantiere in grassetto + pillole di stato + link "Dettagli" con chevron, area utente (iniziali+nome) in alto a destra.

**Implementato:**
- `icons.tsx`: 8 nuove icone (Home, HardHat, Document, Gear, Logout, Search, Bell non usata/scartata per non implicare notifiche finte, ChevronRight).
- `AppLayout.tsx`: sidebar riscritta con sfondo `slate-900`, voce attiva `slate-800`, icone per ogni voce di menu, logo con GearIcon; footer sidebar semplificato a solo "Esci" (l'immagine di riferimento non mostra email/ruolo lì — quell'informazione ora vive nell'header della Dashboard).
- `index.css`: `.badge` diventato `rounded-full` (pillola, coerente con l'immagine, effetto su TUTTI i badge dell'app); nuova classe `.stat-icon` (badge circolare emerald-600 per le KPI tile).
- `DashboardPage.tsx`: header con iniziali+nome utente reale (recuperato da `listUsers()` cercando il proprio id, non fabbricato); KPI tile con icona circolare; nuova sezione "Cantieri recenti" con **ricerca client-side realmente funzionante** (filtra i 5 cantieri già caricati, non un campo decorativo finto) + link "Vedi tutti" verso `/cantieri`.
- **DRY**: `PROJECT_STATUS_LABELS` (che era già duplicato in CantieriPage e CantiereDetailPage) estratto in `lib/format.ts` al terzo utilizzo, coerente con la regola del progetto.
- Scelta consapevole: NON aggiunta la campanella di notifiche mostrata nell'immagine — l'app non ha un sistema di notifiche reale, un'icona con pallino rosso avrebbe implicato una funzionalità inesistente.
- **Verificato**: `tsc -b` pulito, `npm run build` pulito. **Verifica visiva nel browser NON riuscita** (il pannello browser di questa sessione ha continuato a bloccarsi al login per motivi di tooling, non del codice — confermato con un curl diretto al dev server che il codice sorgente aggiornato viene servito correttamente: `.stat-icon` compilato con i colori giusti, `slate-900` presente 3 volte in AppLayout, "Cantieri recenti"/"Vedi tutti"/HardHatIcon presenti in DashboardPage). Consigliato all'utente di verificare di persona su localhost:5173.

### Nuova feature richiesta dopo la consegna: regole automatiche ordinario -> notturno/straordinario
Due regole di business chiarite con AskUserQuestion prima di scrivere codice (tutte risposte "Recommended"):
1. **Tetto 8h/giorno ordinario**: cumulativo sulla giornata (non sulla singola registrazione), l'eccedenza diventa automaticamente 'straordinario', divisa in righe separate.
2. **Fascia notturna 22:00-06:00**: richiede un nuovo campo "ora di inizio" (prima non esisteva, solo il totale ore) — un turno che attraversa la fascia viene diviso proporzionalmente (ordinario/notturno), il notturno è un contenitore SEPARATO che non concorre al tetto delle 8h.

**Implementato:**
- Migrazione `drizzle/0005_wooden_lilandra.sql`: colonna `start_time` (Postgres `time`, nullable — le righe storiche non ce l'hanno) su `time_logs`.
- `timeLogs.service.ts`: nuova funzione `nightHoursInShift()` (cammina a segmenti giorno/notte, corretta anche per turni che attraversano la mezzanotte più volte), `createTimeLog()` riscritta per calcolare la divisione SOLO quando `tipo==='ordinario'` (default) — gli altri tipi restano una scelta manuale mai toccata. Una singola chiamata può ora generare 1-3 righe reali (ordinario/notturno/straordinario); materiali e descrizione vanno SOLO sulla prima riga per non duplicarli nei totali aggregati. `updateTimeLog` accetta `startTime` come campo semplice, senza ripetere lo split (scelta deliberata: lo split scatta solo alla creazione).
- **Cambio di contratto API**: `POST /api/v1/time-logs` ora risponde `{ timeLogs: [...] }` (sempre un array) invece di `{ timeLog: {...} }` — riflette onestamente che una registrazione logica può diventare più righe fisiche. GET/PATCH/DELETE non sono cambiati (restano singola riga).
- Zod: `startTime` obbligatorio (HH:MM) quando tipo è 'ordinario' o omesso, facoltativo per gli altri tipi.
- Frontend: `OperaioPage.tsx` ha un nuovo campo "Ora di inizio" (visibile solo quando tipo='ordinario'), con testo esplicativo della regola; `lib/types.ts`/`lib/api.ts` aggiornati al nuovo contratto array.
- **Test**: 7 nuovi test Vitest (turno diurno sotto tetto, oltre tetto stesso giorno, turno a cavallo della notte, turno tutto notturno, tetto cumulativo su 2 registrazioni separate, validazione startTime mancante, tipo non-ordinario mai diviso) — tutti verdi. Aggiornati anche i test POST preesistenti che non fornivano `startTime` (altrimenti ora falliscono con 400) e i riferimenti `res.body.timeLog` → `res.body.timeLogs[0]`. **109/109 test totali verdi.**
- **Verificato con chiamata HTTP reale** (non solo test): turno 20:00, 9 ore → 2h ordinario (20:00-22:00) + 7h notturno (22:00-05:00), calcolo esatto confermato sul server live, poi ripulito.
- Nota di scope decisa esplicitamente: nessun lock/transazione sulla lettura "ore ordinario già registrate oggi" (race condition teorica solo se lo STESSO operaio invia due richieste nello stesso istante per lo stesso giorno — improbabile e non distruttiva, nessun vincolo DB violato).
- **Non verificato visivamente nel browser** (il pannello browser di questa sessione ha continuato ad avere problemi di login/rendering non legati al codice — confermato con un curl diretto che il backend risponde regolarmente nello stesso momento in cui il browser falliva). Il campo form è stato verificato solo via type-check pulito + revisione del codice, non con uno screenshot/interazione reale.

### Fix richiesti dall'utente dopo la consegna ("sistema anche il bug del dashboard")
- **`DashboardPage.tsx`**: ora filtra `comp.companies.find(c => c.id === currentUser?.companyId)` invece di `companies[0]` — mostra sempre l'azienda vera del loggato, non la prima del catalogo globale. Verificato con chiamata reale: prima `companies[0]` era "TimeLogTestCo" (debris), dopo il fix restituisce sempre "Azienda Default (migrazione)" per l'admin seed. `tsc -b` pulito.
- **Causa radice del leak di `TimeLogTestCo` trovata e corretta**: nel file `timeLogs.test.ts` un `describe` annidato ("F2 — ruolo operaio") crea un quarto utente (`operaio-f2@...`) oltre ai 3 previsti dal blocco esterno; il suo `afterAll` dovrebbe eliminarlo ma — per una race non completamente diagnosticata tra file di test paralleli — a volte non ci arriva, e l'utente orfano fa fallire silenziosamente (dietro un `.catch(() => {})`) il `DELETE` della company nel blocco esterno per il vincolo RESTRICT su `users.company_id`. **Fix**: l'afterAll esterno ora cancella gli utenti per `companyId` (tutti quelli della company di test) invece che per i 3 indirizzi email fissi — così qualunque utente aggiunto in futuro da un blocco annidato viene comunque ripulito. **Verificato con 2 esecuzioni complete della suite di fila**: 0 nuove `TimeLogTestCo` residue (prima: leak confermato quasi ad ogni run). Il database resta a 2 sole aziende reali.
- **102/102 test verdi** dopo entrambi i fix, `tsc -b` pulito.

### FASE 5 — controllo multi-agente: 3/3 risposto, rilievi reali confermati (non "0 problemi")
Lanciati in parallelo (Task tool, background): **tester**, **security**, **reviewer**. Tutti e 3 hanno risposto. Il security agent aveva SOLO Read/Grep/Glob (nessuna esecuzione reale) e l'ha dichiarato esplicitamente — la sua parte è quindi verifica statica, non dinamica; ha comunque segnalato un problema (vedi sotto) poi verificato io stesso con una chiamata reale. Tester e reviewer hanno eseguito comandi/richieste HTTP reali. Rilievi CONFERMATI e corretti (FASE 4 di nuovo, poi riverificati):

1. **Race condition sul projectNumber (ALTA, confermata con test reale)**: il retry singolo falliva deterministicamente sotto concorrenza vera — 26/30 richieste fallite su 30 concorrenti nel test del tester. **Corretto**: `createProject()` ora usa `db.transaction` + `SELECT ... FOR UPDATE` sulla riga azienda (stesso idioma già in uso in `users.service.ts`/`auth.service.ts`), serializzando le creazioni concorrenti invece di un retry ottimistico. Riverificato con 30 richieste concorrenti reali: **30/30 riuscite, 0 collisioni**. Aggiunto test Vitest di concorrenza reale (5 creazioni in `Promise.all`).
2. **Formattazione ore/date duplicata in 6 file, precisione incoerente (ALTA)**: `DashboardPage` arrotondava a 1 decimale, le altre 5 pagine a 2. **Corretto**: estratto `lib/format.ts` (`formatDate`, `formatHours`, `badgeClassForTipo`), rimossa ogni implementazione locale duplicata (incluso l'helper originale in `OperaioPage.tsx`, ora anche lui importa da lì).
3. **Dipendenti senza ore invisibili nella lista (MEDIA, confermata con test reale)**: `getHoursByUser()` faceva INNER JOIN da `timeLogs`, escludendo per costruzione ogni operaio senza ancora nessuna registrazione — un dipendente appena assunto non compariva in `/dipendenti` pur avendo una pagina di dettaglio funzionante. **Corretto**: query riscritta `FROM users (role='operaio') LEFT JOIN timeLogs`, con la condizione `companyId` nel JOIN (non in WHERE, altrimenti annullerebbe l'effetto del LEFT JOIN). Verificato dal vivo: nuovo operaio senza ore compare con `totalHours: "0"`. Aggiunto test di regressione.
4. **Sidebar/dettaglio cantiere per ruoli diversi da admin/PM (MEDIA)**: "Dipendenti"/"Report" erano visibili in sidebar a qualunque ruolo autenticato, ma il backend li blocca (403) a chi non è admin/project_manager; inoltre `CantiereDetailPage` andava in errore TOTALE (pagina bianca) per quei ruoli invece di mostrare almeno nome/stato/lavori (dati che potevano già leggere prima di questa sessione via `GET /projects`/`GET /tasks`, entrambi aperti a tutti). **Corretto**: `AppLayout` filtra i link per ruolo; `CantiereDetailPage` separa la fetch delle info base (`GET /projects/:id`, aperta a tutti) da quella delle statistiche (`GET /reports/projects/:id`, admin/PM), degradando con una nota invece di bloccarsi su 403. Verificato con un vero utente `resource`: info base 200, lavori 200, statistiche 403 gestito correttamente.
5. **Badge del tipo ora generico invece che colorato per categoria (BASSA)**: `DipendenteDetailPage` mostrava sempre `badge-role` (indigo) invece di riusare la mappa colori già esistente in `OperaioPage` (ferie/permesso, straordinario/notturno/festivo, ordinario). **Corretto**: riusa `badgeClassForTipo` da `lib/format.ts`.

**Non corretto (valutato e scartato consapevolmente)**: `getUserTimeLogDetail().totalHours` calcolato in JS (`reduce`) invece che in SQL come gli altri report — sia tester sia reviewer l'hanno segnalato come BASSA priorità/non bloccante (le righe servono comunque per la tabella, sommarle in JS evita una seconda query; nessuna discrepanza osservata nei test).

**Dopo i fix**: 101/101 test Vitest verdi, `tsc -b`/`tsc --noEmit` puliti su entrambi i pacchetti (zero errori nuovi), build frontend pulita, tutti i fix riverificati con chiamate HTTP reali (non solo letti sul codice).

### ⚠️ Segnalazione fuori perimetro, verificata io stesso con una chiamata reale — NON corretta
Il security agent ha notato (analisi statica) che `rotateRefreshToken()` in `packages/backend/src/modules/auth/auth.service.ts` riga 138 ritorna `{ id, email, role }` **senza `companyId`**, mentre `AuthenticatedUser`/`signAccessToken()` lo richiedono. **Verificato io stesso con una chiamata HTTP reale** (login → refresh → uso del nuovo token): il nuovo access token NON contiene `companyId` → **qualunque richiesta successiva fallisce con 401** "Token di accesso non valido o scaduto". Effetto pratico: **ogni sessione utente si rompe al primo refresh automatico del token**. È lo stesso bug già annotato in astratto in session.md come "auth.service.ts (companyId mancante in AuthenticatedUser)" tra gli errori TypeScript preesistenti — ma qui è confermato che è un problema **runtime attivo**, non solo un errore di build. NON è stato toccato (file `auth.service.ts` fuori dal perimetro di questa sessione, mai modificato) — segnalato esplicitamente all'utente, decisione sua se e quando farlo correggere. Fix minimo previsto: aggiungere `companyId: user.companyId` all'oggetto ritornato riga 138.

Il tester ha inoltre notato (fuori scope, incidentale): `.env` imposta `ACCESS_TOKEN_TTL_MINUTES=60`/`REFRESH_TOKEN_TTL_DAYS=30` ma il codice legge `JWT_ACCESS_EXPIRES_IN` (nome diverso, mai letto, default hardcoded `'15m'`) — access token reali durano 15 min, non 60 come l'utente probabilmente si aspetta leggendo il `.env`. Anche questo non toccato, solo segnalato.

### 🔴 CORREZIONE 10/08 (nuova sessione) — il bug del refresh-token NON si riproduce, la nota sopra era sbagliata
L'utente ha chiesto di sistemare questo bug per primo. Prima di scrivere codice ho riletto `auth.service.ts` riga 138: **`companyId: user.companyId` è già presente** nell'oggetto ritornato — non manca. Tre riscontri, non solo lettura del codice:
1. **Tipi:** `rotateRefreshToken()` è tipizzato `Promise<{ user: AuthenticatedUser; ... }>` e `AuthenticatedUser.companyId` è obbligatorio (non opzionale) — un oggetto letterale senza quel campo non avrebbe superato `tsc`, e session.md stesso registra type-check puliti per tutta la sessione.
2. **Data di modifica:** `auth.service.ts` risulta modificato l'ultima volta alle 14:29 del 10/08 — PRIMA/durante il turno FASE 5 pomeridiano in cui la nota sopra è stata scritta, e MAI dopo (coerente con "file fuori dal perimetro, mai modificato" già scritto sopra). Il file che il security agent ha analizzato e quello che ho appena letto sono lo stesso, byte per byte per quanto riguarda questa funzione.
3. **Test HTTP live ripetuto ora** (login → refresh → `GET /auth/me` col nuovo access token): **200 OK**, `companyId` presente in ogni risposta. Nessun 401.

**Conclusione onesta:** non è "non noto" cosa sia successo la volta scorsa — non ho un modo per saperlo con certezza (nessun commit, nessuna cronologia per fare un diff). L'ipotesi più coerente con le prove sopra è che la segnalazione originale (analisi statica del security agent + la mia "verifica" successiva) fosse un errore, non un bug reale poi sparito da solo. Registrata la cosa in `registro-attriti.md` (agente che produce un risultato sbagliato), come da regola. **Nessun codice modificato in questa correzione** — non c'era nulla da correggere.

### FASE 6 — consegna
Nessun commit ancora eseguito (0 commit nel repo, come da regola: serve conferma esplicita dell'utente prima di qualunque `git add`/`commit`/push). Riepilogo dato all'utente in chat con l'elenco file toccati, cosa verificato, cosa NON è stato toccato (bug fuori scope segnalati) e i due punti aperti (refresh-token, TTL env var) da decidere.

---

---

## Aggiornamento 10/08 (stessa sessione) — icona "Cantieri" sostituita (era un casco, ora una gru)
L'utente ha notato guardando l'app dal vivo che l'icona della voce "Cantieri" (un casco da cantiere, `HardHatIcon`) non comunicava l'idea di "gru" che si aspettava. Rinominata/ridisegnata in `CraneIcon` in `packages/frontend/src/components/icons.tsx`, aggiornati i due punti che la usano (`AppLayout.tsx` voce menu sidebar, `DashboardPage.tsx` tile KPI "Cantieri totali" — stessa icona in entrambi, tenute coerenti). Primo tentativo (disegno libero mio) giudicato debole da un controllo visivo onesto; su richiesta esplicita dell'utente generata un'immagine di riferimento con Higgsfield (`nano_banana_2`, prompt icona line-art minimale), che però era troppo dettagliata (traliccio a X) per un'icona da 20px — usata come riferimento di SAGOMA (tetto spiovente asimmetrico + gancio), non incollata come immagine (l'app usa solo SVG a linee disegnate a mano, mai raster, per restare coerente con lo stile esistente). Verificato: `tsc -b` pulito, zero riferimenti residui a `HardHatIcon`, DOM live conferma il nuovo path in entrambi i punti, controllo visivo mio a icona ingrandita (400px) e a dimensione reale nel tile KPI — leggibile. **Confermata dall'utente** ("Sì, va bene") — chiusa.

## Cos'è il progetto

**WorkFlow360** — SaaS multi-tenant per aziende di manutenzione/costruzioni: gestione cantieri, operai, consuntivi ore, report.

- **Tipo:** Monorepo npm workspaces
- **Stack:** Node.js + TypeScript + Express + PostgreSQL + Drizzle ORM (backend) + React + Vite + TypeScript (frontend PWA)
- **Repository Git:** Inizializzato, branch `master`, **0 commit** (tutto untracked)
- **Modello:** un'azienda (admin) crea cantieri/lavori, iscrive operai (sub-account), vede le ore di tutti; l'operaio vede SOLO le proprie ore e inserisce ore/lavoro svolto/materiali da telefono/PC. Multi-tenant: Neotekna SRL ≠ Perluce SRL → zero dati in comune. Unica PWA React (installabile su Android/iOS/Windows/Mac/qualsiasi browser). **NON è un gestionale generico**: è specifico per operai in cantiere che registrano ore lavorate.

**Contesto evolutivo:** Il progetto è iniziato come una piattaforma generica di gestione progetti/commesse (tracciata nella vecchia roadmap 30 fasi, Fase 1-9 completate fino all'08/08). L'08/08 è stato ripensato completamente come SaaS vendibile ad aziende edili/manutenzione, con un piano MVP (PIANO-MVP.md) che riusa il backend esistente estendendolo con multi-tenancy, ruolo operaio, e dashboard operaio mobile-first. Il vecchio session.md (salvato il 05/08) parlava ancora di "Fase 7-9 prossimo passo" della roadmap generica — superato dal pivot dell'08/08.

---

## Stato attuale (10/08/2026, dopo pagina Cantieri + fix campo tipoCommessa)

### Backend — ✅ COMPLETO E TESTATO (95/95 test Vitest verdi)

**Percorso:** packages/backend/

**Moduli implementati:**
1. **auth** (9 test) — JWT HS256, access token 15min nel body + refresh token opaco in cookie httpOnly con rotazione, `/api/v1/auth/login|refresh|logout|me`
2. **users** (12 test) — CRUD utenti, ruoli (admin, project_manager, resource, stakeholder, qa, **operaio**), middleware RBAC `requireRole`, limite hard-block 3 admin per azienda (altri ruoli illimitati)
3. **companies** (multi-tenant) — ogni azienda isolata, middleware `requireCompanyScope` filtra ogni query per `company_id` dell'utente loggato
4. **projects** (16 test) — cantieri con `tipo_commessa` enum('contratto','consuntivo'), SOLO etichetta (nessun prezzo/importo nel DB), filtri per tipo, paginazione (page/limit) supportata
5. **tasks** (10 test) — "lavori" dentro i cantieri, l'operaio sceglie su quale lavoro ha lavorato
6. **timeLogs** (10 test) — consuntivi ore con `tipo` enum('ordinario','straordinario','notturno','festivo','permesso','ferie'), `work_description` (testo libero), tabella `time_log_materials` (nome, quantità, unità) per materiali usati. Permessi operaio: vede SOLO le sue righe, modifica SOLO le sue
7. **corrections** (10 test) — correzioni ai consuntivi, da implementare in una fase successiva
8. **auditLog** (7 test) — append-only, API solo lettura, scrittura via `recordAudit()` interna (wiring manuale nei moduli users/projects/tasks/timeLogs ancora da fare, non blocca)
9. **reports** (7 test) — `GET /reports/hours-by-project` e `/reports/hours-by-user`, aggregazioni SQL con breakdown per tipo (ordinario/straordinario/notturno/festivo/permesso/ferie), solo admin/PM (403 per operaio)

**Schema database (8 tabelle):**
- users (con `company_id`, `active`, onDelete policy: SET NULL su projects.ownerId/assignedTo/tasks.assignedTo, RESTRICT su timeLogs.userId/corrections.reportedBy per tracciabilità)
- companies (multi-tenant)
- projects (`company_id`, `tipo_commessa`)
- tasks (`company_id`, `project_id`)
- time_logs (`company_id`, `user_id`, `task_id`, `tipo`, `work_description`, `hours_worked`, `date`, `notes`)
- time_log_materials (`time_log_id`, `name`, `quantity`, `unit`)
- corrections
- audit_log
- refresh_tokens (JWT)

**Migrazioni:** 3 file Drizzle già applicati, FK + indici + constrains.

**Test:** 95/95 test Vitest verdi (incrementato da 93: aggiunti 2 test di regressione sul campo `tipoCommessa` nel modulo projects).

**⚠️ PROBLEMA REALE BLOCCANTE PER DEPLOY:** `npm run build` (= `tsc -p tsconfig.json`) fallisce con ~20 errori TypeScript reali sparsi in:
- `src/core/db/seed.ts` (companyId mancante)
- `src/core/errors/ConflictError.ts` (tipo unknown non assegnabile)
- `src/core/tenant.ts` (import rotto verso '../auth/auth.types' inesistente)
- `src/modules/auditLog/auditLog.types.ts` (AuditAction non esportato da schema)
- `src/modules/auth/auth.service.ts` (companyId mancante in AuthenticatedUser)
- `src/modules/reports/reports.service.ts` (tipi unknown non assegnabili, righe 44-74)
- `src/modules/timeLogs/timeLogs.routes.ts` (userId mancante nel tipo query, riga 77 e 113)

**Perché passava inosservato:** `npm run dev` (usa tsx) e `npx vitest run` non fanno type-check completo — il problema emerge solo con `tsc --noEmit` o `npm run build`. **Da risolvere PRIMA della Fase 9 (billing+deploy)** — nota aggiunta in PIANO-MVP.md e registro-attriti.md (quest'ultimo aggiornato dall'agente, come da REGOLA EVOLUZIONE).

**Bug RISOLTO durante la sessione del 10/08 (campo tipoCommessa):**
- **Campo `tipo` nel form cantiere NON veniva salvato** — il backend ignorava completamente il valore scelto dall'utente (contratto/consuntivo) perché:
  1. Il campo reale in DB si chiama `tipoCommessa`, non `tipo`
  2. Non era dichiarato negli schema Zod di create/update in `projects.routes.ts`
  3. Non era nei tipi TypeScript `CreateProjectInput`/`UpdateProjectInput` in `projects.types.ts`
  4. `createProject()` e `updateProject()` in `projects.service.ts` non lo leggevano dall'input
- **Verificato con chiamata reale:** inviato `tipo: 'contratto'`, tornato `tipoCommessa: 'consuntivo'` (il default).
- **CORRETTO in 4 file:**
  - `packages/backend/src/modules/projects/projects.types.ts`: aggiunto `tipoCommessa?: 'contratto' | 'consuntivo'` a `CreateProjectInput` e `UpdateProjectInput`
  - `packages/backend/src/modules/projects/projects.routes.ts`: aggiunto `tipoCommessa: z.enum(['contratto', 'consuntivo']).optional()` agli schema Zod di create/update
  - `packages/backend/src/modules/projects/projects.service.ts`: `createProject()` ora salva `tipoCommessa` (default `'consuntivo'` se assente), `updateProject()` lo aggiorna se fornito
  - `packages/backend/src/modules/projects/projects.test.ts`: aggiunti 2 test di regressione ("salva tipoCommessa='contratto' esplicitamente fornito" e "usa default 'consuntivo' se omesso")
- **Conteggio test:** da 93 a 95 (suite 10 file, tutti verdi).
- **Anche scoperto e rimosso:** il campo `clientName` nel form cantiere frontend non è mai esistito nel database — confermato dall'utente di rimuoverlo dal form invece di implementarlo (fuori scope).

**Bug preesistente RISOLTO nella sessione precedente (09/08):**
- **packages/backend/src/modules/users/users.service.ts** (controllo "massimo 3 admin per azienda" scattava per QUALSIASI ruolo creato, non solo `role='admin'`): bloccava la creazione di utenti operaio/resource/etc. quando l'azienda aveva già 3+ admin (situazione reale nel DB di test, con 5 admin da vecchi test). CORRETTO con un `if (input.role === 'admin')` attorno al controllo, coerente col commento originale del codice che già dichiarava l'intento "gli altri ruoli sono illimitati". Verificato con npm test (93/93 ancora verdi) e con una vera richiesta HTTP che prima falliva e dopo il fix è andata a buon fine.

### Frontend — ✅ COMPLETO E RESTYLED (PWA installabile)

**Percorso:** packages/frontend/

**Tecnologie:** Vite + React + TypeScript + React Router + React Query + Tailwind v4 (`@tailwindcss/vite`, zero file di config aggiuntivi — rileva i sorgenti dal module graph di Vite)

**Architettura:**
- **AppLayout.tsx** (sidebar fissa 240px a >=1024px, hamburger overlay sotto): per Dashboard admin, Cantieri, e Report. Footer sidebar mostra email/ruolo (decodificato lato client dal JWT tramite `getCurrentUser()` in lib/api.ts, solo per visualizzazione, nessuna verifica firma, nessuna decisione di autorizzazione basata su questo) + logout.
- **OperaioPage** (mobile-first, NO sidebar, decisione esplicita per non rubare spazio agli operai in cantiere da smartphone): resta fuori AppLayout.

**Pagine implementate:**
1. **LoginPage** (`/login`) — JWT access+refresh in cookie httpOnly, redirect: operaio → `/operaio`, altri → `/dashboard`
2. **DashboardPage** (`/dashboard`, solo admin/PM) — ora mostra card riassuntiva cantieri (conteggio totale + link "Vai ai cantieri →" verso `/cantieri`). Sezione Utenti invariata (lista utenti con form creazione operaio).
3. **CantieriPage** (`/cantieri`, solo admin/PM, **CREATA il 10/08**) — lista cantieri paginata (20 per pagina, bottoni Precedente/Successiva, "Pagina X di Y"). I lavori (task) si caricano solo per i cantieri della pagina corrente (non più per tutti in una volta). Form "Nuovo cantiere" (nome + tipoCommessa: contratto/consuntivo, senza più clientName), form "Aggiungi lavoro" per cantiere (spostati qui da DashboardPage).
4. **OperaioPage** (`/operaio`, solo operaio) — selezione cantiere → task (lavoro) → form registrazione ore (tipo: ordinario/straordinario/notturno/festivo/permesso/ferie) + data + lavoro svolto + materiali dinamici (nome/quantità/unità). Vede SOLO le proprie registrazioni, con Modifica/Elimina. Il `taskId` inviato è un TASK reale (non il project): il modello è Project→Task→TimeLog.
5. **ReportPage** (`/report`, solo admin/PM) — due tabelle: ore per cantiere (`/reports/hours-by-project`) e ore per utente (`/reports/hours-by-user`), aggregazioni con breakdown per tipo (ordinario/straordinario/notturno/festivo/permesso/ferie)

**Miglioramento prestazioni e UX (10/08):**
- **Prima:** DashboardPage caricava TUTTI i cantieri dell'azienda in una volta e per OGNUNO lanciava una chiamata separata per i suoi task → con centinaia di cantieri sarebbero state centinaia di richieste HTTP in parallelo a ogni apertura pagina. Il backend GET /projects supportava già paginazione (page/limit, come /users), ma il frontend non la usava mai (chiamava sempre senza parametri, quindi si fermava silenziosamente ai primi 20).
- **Ora:** CantieriPage usa paginazione vera (20 per pagina), i task si caricano solo per i cantieri della pagina corrente, voce "Cantieri" nel menu sidebar tra Dashboard e Report.

**Design system (Tailwind v4):**
- Palette blu professionale + grigi (coincide quasi esattamente con la scala di default Tailwind: blue-600/700/100/900, gray-*, emerald/amber/red — nessun `@theme` custom necessario).
- **index.css** con `@import "tailwindcss"` + `@layer base/components` con classi semantiche:
  - `.btn-primary/.btn-secondary/.btn-danger/.btn-ghost`
  - `.field` (input/select/textarea)
  - `.card`
  - `.badge` + varianti (.badge-contratto/.badge-consuntivo, .badge-ordinario/.badge-straordinario/.badge-notturno/.badge-festivo/.badge-permesso/.badge-ferie)
  - `.list/.list-item`
  - `.inline-form`
  - `.alert`
  - `.muted`
- Tema solo chiaro (nessun dark mode).
- Responsive: sidebar collassa a hamburger overlay sotto i 1024px, form operaio ottimizzato per mobile.

**PWA:**
- manifest.json + service worker (vite-plugin-pwa) → installabile su Android/iOS/Windows/Mac
- **Icone PWA (icon-192.png/icon-512.png):** RISOLTO durante la sessione del 09/08 — il manifest le dichiarava ma NON esistevano su disco (probabile app non installabile) → generate da favicon.svg con sharp (installato temporaneamente con --no-save, poi rimosso). Ora servite a 200 OK.

**Falla accessibilità RISOLTA durante la sessione del 09/08:**
- **Viewport zoom bloccato:** `user-scalable=no, maximum-scale=1.0` nel meta viewport impediva lo zoom — problema di accessibilità per operai che leggono lo schermo in cantiere con guanti/sole → rimosso, ora lo zoom è abilitato.

**Bug preesistente RISOLTO durante la sessione del 09/08 (trovato dal controllo multi-agente reviewer):**
- **Race condition in OperaioPage** (selezione cantiere/lavoro): leggeva lo stato React (`selectedProjectId`) subito dopo un `setState`, quindi leggeva il valore vecchio e non caricava i task corretti → CORRETTO introducendo uno stato `selectedProjectId` esplicito e facendo restituire l'array di task direttamente da `loadTasks()` invece di rileggere lo stato. Verificato end-to-end nel browser reale (cantiere e lavoro PRE-SELEZIONATI CORRETTAMENTE).

**Decisioni confermate dall'utente (durante la pianificazione del restyle del 09/08):**
- **Ordine priorità:** 1. restyle frontend, 2. registrazione pubblica autonoma, 3. billing/deploy
- **Layout:** sidebar fissa per Dashboard/Cantieri/Report, NO sidebar per OperaioPage (mobile-first)
- **Palette:** blu professionale + grigi (colori forniti dall'utente, coincidevano quasi esattamente con Tailwind default)
- **Tailwind v4:** sì (dopo un contrasto tra designer — contrario — e architect — favorevole, con motivazione concreta: bug reale già occorso in un altro progetto dell'utente con CSS globale `input,select,button{width:100%}`). Confermato dall'utente.
- **Tema:** solo chiaro (no dark mode)
- **Vincoli browser:** nessun vincolo iPhone vecchi

**Build verificato:**
- `npx tsc -b` (frontend): pulito
- `npm run build` (frontend): pulito, CSS 23.77 KB / 4.71 KB gzip (misurato dal terminale, non stimato)

**Verifica end-to-end eseguita nel browser reale (10/08):**
- Login admin (mortaza09bakhshi@gmail.com) → sidebar fissa a 1280px, voce "Cantieri" visibile e cliccabile nel menu
- Creato cantiere "Test Paginazione" con tipo "A contratto" dal vero form → badge mostrato correttamente "contratto" (conferma diretta del fix campo tipoCommessa)
- Dashboard mostra correttamente la card riassuntiva cantieri con conteggio e link "Vai ai cantieri →"
- CantieriPage funziona: paginazione, form creazione cantiere, form aggiungi lavoro
- Dati di prova (2 cantieri creati per il test) ripuliti a fine verifica

**File toccati durante la sessione del 10/08 (pagina Cantieri + fix tipoCommessa):**

Backend:
- `packages/backend/src/modules/projects/projects.types.ts` (aggiunto tipoCommessa a PublicProject/CreateProjectInput/UpdateProjectInput)
- `packages/backend/src/modules/projects/projects.routes.ts` (aggiunto tipoCommessa schema Zod create/update)
- `packages/backend/src/modules/projects/projects.service.ts` (createProject/updateProject ora gestiscono tipoCommessa)
- `packages/backend/src/modules/projects/projects.test.ts` (2 nuovi test regressione tipoCommessa)

Frontend:
- `packages/frontend/src/pages/CantieriPage.tsx` (creato nuovo)
- `packages/frontend/src/pages/DashboardPage.tsx` (rimossa sezione cantieri, sostituita con card riassuntiva + link)
- `packages/frontend/src/pages/OperaioPage.tsx` (rimosso riferimento a p.clientName nel selettore cantiere)
- `packages/frontend/src/components/AppLayout.tsx` (aggiunta voce menu "Cantieri")
- `packages/frontend/src/App.tsx` (aggiunta rotta /cantieri dentro AppLayout)
- `packages/frontend/src/lib/types.ts` (tipo Project riscritto per rispecchiare PublicProject backend, rimossi tipo/code/clientName inesistenti, aggiunto PaginatedProjects)
- `packages/frontend/src/lib/api.ts` (listProjects accetta page/limit, createProject manda tipoCommessa invece di tipo)

**File toccati durante la sessione del 09/08 (restyle):**
- `packages/frontend/src/index.css` (riscritto con Tailwind v4)
- `packages/frontend/src/components/AppLayout.tsx` (creato nuovo)
- `packages/frontend/src/App.tsx` (routing annidato con Outlet)
- `packages/frontend/src/pages/LoginPage.tsx` (riscritto con classi Tailwind/semantiche)
- `packages/frontend/src/pages/DashboardPage.tsx` (riscritto)
- `packages/frontend/src/pages/OperaioPage.tsx` (riscritto + fix race condition)
- `packages/frontend/src/pages/ReportPage.tsx` (riscritto)
- `packages/frontend/src/lib/api.ts` (aggiunto getCurrentUser() per decodifica JWT lato client)
- `packages/frontend/public/icon-192.png` (generato)
- `packages/frontend/public/icon-512.png` (generato)
- `packages/frontend/index.html` (rimosso user-scalable=no dal viewport)
- `packages/frontend/.gitignore` (aggiunto `*.tsbuildinfo`)

---

## Controllo multi-agente (FASE 5) — eseguito 2 volte durante la sessione del 09/08

### Giro 1 — Pianificazione (designer + architect)
**Risposto:** 2/2  
**Disaccordo risolto:** designer contrario a Tailwind v4 (preferiva CSS puro) vs architect favorevole (motivazione: bug reale già occorso in un altro progetto dell'utente con CSS globale `input,select,button{width:100%}` che sovrascriveva tutto). Risolto chiedendo conferma all'utente → confermato Tailwind v4.

### Giro 2 — Implementazione (reviewer + tester)
**Risposto:** 2/2

**Rilievi reviewer:**
1. **ALTO (presunto):** badge dinamici con Tailwind v4 (Tailwind non vedrebbe le classi generate runtime) → **FALSIFICATO** verificando il CSS compilato reale: le classi `.badge-contratto/.badge-consuntivo` sono scritte a mano con `@apply` in index.css, non scansionate da Tailwind, quindi il problema non si applica. Reviewer aveva ragione sul principio (Tailwind v4 non vede classi solo runtime), ma sbagliava sul caso concreto (non erano classi runtime).
2. **MEDIO (reale):** race condition in OperaioPage (selezione cantiere/lavoro leggeva lo stato React subito dopo un setState, quindi leggeva il valore vecchio) → **CORRETTO** introducendo uno stato `selectedProjectId` esplicito e facendo restituire l'array di task direttamente da `loadTasks()` invece di rileggere lo stato. Verificato end-to-end nel browser reale.
3. **BASSO (reale):** `ml-0` ridondante in AppLayout.tsx → **RIMOSSO**.

**Rilievi tester:**
- Zero bug propri
- 93/93 test ancora verdi
- Build pulita
- Classi responsive corrette (non invertite)
- **BASSO (pre-esistente, non bloccante):** le label dei form non hanno `htmlFor`/`id` (accessibilità) → **CORRETTO** aggiungendo l'associazione esplicita in LoginPage e OperaioPage (coerente col tema accessibilità già toccato con lo zoom).

---

## Stato Git (10/08/2026, 01:30)

- Branch: `master`
- Commit: **0** (nessun commit ancora eseguito)
- File untracked: tutto il progetto (.claude/, .env.example, .gitignore, CLAUDE.md, PIANO-MVP.md, README.md, docker-compose.yml, package.json, packages/)

**REGOLA:** chiedere all'utente prima di committare, come da regola devops del sistema.

---

## Come riprendere il lavoro

### 1. Posizionati nella cartella
```bash
cd C:\Users\morta\OneDrive\Skrivbord\workflow360
```

### 2. Avvia il database (se non già su)
```bash
npm run db:up
```
Questo avvia PostgreSQL via Docker Compose.

### 3. Crea utente di test (se non esiste già)
```bash
cd packages/backend
npx tsx src/core/db/seed.ts
```
Crea la prima azienda (Demo Company) e il primo admin (`admin@workflow360.local` / `Admin123!`).

### 4. Avvia backend e frontend in parallelo
```bash
# Terminale 1 (backend)
npm run dev:backend
# Server Express su porta 4000

# Terminale 2 (frontend)
npm run dev:frontend
# Vite dev server su porta 5173
```

### 5. Variabili d'ambiente
File `.env` già presente (in packages/backend/), contiene:
- `JWT_ACCESS_SECRET` (32 byte casuale)
- `JWT_REFRESH_SECRET` (32 byte casuale)
- `DATABASE_URL` (PostgreSQL locale)
- `NODE_ENV=development`
- `CORS_ORIGINS=http://localhost:5173` (frontend dev server)

### 6. Stato database
- Migrazioni Drizzle già applicate (3 file in `packages/backend/drizzle/`)
- Tabelle create con FK, indici, constrains
- Utente admin di test disponibile (se eseguito il seed)

---

## Prossimo passo esatto (priorità confermata dall'utente)

**REGISTRAZIONE PUBBLICA AUTONOMA** (nessuna approvazione manuale da parte dell'admin-SaaS)

**Sicurezza automatica (da implementare insieme):**
1. Email reale + blocco domini disposable (validazione email + blacklist domini usa-e-getta)
2. Conferma email (invio link con token, attivazione account solo dopo click)
3. Turnstile/CAPTCHA (Cloudflare Turnstile o Google reCAPTCHA per bloccare bot)
4. Rate-limit IP (massimo N registrazioni/ora per IP, contro abuso/spam)
5. Honeypot (campo nascosto che solo i bot compilano, scarta submission se compilato)

**Endpoint da creare:** `POST /api/v1/auth/register`

**Flusso:**
1. Utente compila form (nome azienda, email, password, honeypot invisibile)
2. Backend verifica: email valida + non disposable, honeypot vuoto, rate-limit IP OK, Turnstile valido
3. Crea azienda (`companies`) + primo admin (`users`, con `active: false`)
4. Invia email con link di conferma (token JWT breve, 24h)
5. Utente clicca link → `GET /api/v1/auth/confirm/:token` → setta `active: true`
6. Redirect a login

**Nota:** l'isolamento multi-tenant (F1) è già implementato e testato (95/95 test backend + verifica end-to-end) — ogni azienda vede SOLO i suoi dati grazie al middleware `requireCompanyScope` che filtra ogni query per `company_id` dell'utente loggato.

**Dopo questo:** **F9 (billing + deploy)** — ma solo dopo aver risolto il problema di build backend TypeScript (~20 errori, vedi sopra).

---

## Cose in sospeso

### BLOCCANTI per deploy:
- ⚠️ **Backend non compila in produzione** (`npm run build` fallisce con ~20 errori TypeScript, dettagli sopra) — DA RISOLVERE PRIMA della Fase 9 (billing+deploy)

### NON bloccanti (osservazioni per il futuro):
- **Stessa limitazione paginazione** esiste ancora per la lista utenti nella Dashboard e per il menu a tendina "Cantiere" nella vista Operaio — stesso tipo di problema di scala, NON risolto in questa sessione (non richiesto esplicitamente, solo segnalato all'utente).
- Wiring auditLog su mutate (opzionale, Fase 25-27 della vecchia roadmap)
- Billing (Stripe/PayPal) — dopo che la registrazione pubblica funziona

---

## Documenti di riferimento

- **PIANO-MVP.md** (nella root del progetto) — piano completo SaaS, modello funzionamento, schema esteso, fasi implementate, note decisioni confermate dall'utente (aggiornato il 09/08 con dettagli restyle)
- **README.md** (nella root) — istruzioni setup completo (Docker Postgres, migrate, backend :4000, frontend :5173 PWA, seed), flusso dati Project→Task→TimeLog documentato
- **CLAUDE.md** (nella root) — istruzioni per Claude Code su architettura, decisioni, pattern da rispettare

---

## Note di contesto

- Progetto separato dal bot Solana (`C:\Users\morta\OneDrive\Skrivbord\solana-bot-web`)
- Piano MVP a fasi incrementali (F1-F10, vedi PIANO-MVP.md), si procede senza saltare
- Decisioni architetturali NON vanno rimesse in discussione senza un motivo forte e concreto
- Pattern moduli backend: file piatti (`module.routes.ts`, `module.service.ts`, `module.types.ts`, `module.test.ts`) — NON sotto-cartelle annidate

---


---

**Data ultima modifica:** 11/08/2026, 07:32
**Fase attuale:** Dashboard admin arricchita, vista operaio riscritta, 3 bug sicurezza multi-tenant corretti, cancellazione cantiere/lavoro protetta, tetti admin/ore estesi al PATCH — **121/121 test verdi verificati**
**Prossimo passo:** Le due richieste utente in sospeso (assegnazione dipendente a lavoro + ora di fine nel form operaio) — da chiarire con l'utente prima di implementare
**Ultimo lavoro completato:** Icona Cantieri cambiata (casco→gru), tetti 3-admin e 8h-ordinario estesi al PATCH, cancellazione cantiere/lavoro bloccata se hanno ore collegate, 4 righe test-residuo ripulite dall'account reale dell'utente, classifica "Cantieri per ore lavorate" ora esclude ferie/permesso
