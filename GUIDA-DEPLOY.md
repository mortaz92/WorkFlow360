# Guida al deploy di WorkFlow360 su Render

Questa guida spiega, passo per passo, come mettere WorkFlow360 online.
È scritta per chi non è tecnico. Fai un passo alla volta, nell'ordine indicato.
Non saltare passi: ognuno usa qualcosa creato in quello prima.

Alla fine avrai tre cose online:

1. **Il database** — dove vivono i dati (aziende, utenti, cantieri, ore).
2. **Il backend** — il "motore" che risponde alle richieste.
3. **Il frontend** — il sito che apri dal telefono o dal computer.

Servono circa 45 minuti la prima volta.

---

## Prima di cominciare

Ti serve:

- Un account gratuito su [render.com](https://render.com).
- Il progetto caricato su GitHub (Render legge il codice da lì).
- Il computer dove hai il progetto, con Node installato (serve solo all'ultimo passo).

Tieni aperto un blocco note: durante la guida dovrai copiare due indirizzi web
(quello del backend e quello del frontend) e riusarli più avanti.

> **Avviso importante sul piano gratuito del database.**
> Il piano gratuito di Postgres su Render, storicamente, **scade dopo un periodo
> limitato** (in passato 90 giorni, poi 30) e **non fa backup automatici**: alla
> scadenza il database viene cancellato e i dati con lui.
> Le condizioni cambiano nel tempo: **controlla la pagina dei prezzi di Render il
> giorno in cui crei il database**, prima di metterci dentro dati veri di lavoro.
> Finché resti sul piano gratuito, fai un backup a mano ogni settimana con questo
> comando dal tuo computer (l'indirizzo lo trovi al Passo 7, "External Database URL"):
>
> ```
> pg_dump "INCOLLA_QUI_L_EXTERNAL_DATABASE_URL" > backup-workflow360.sql
> ```
>
> Se i dati contano davvero, passa al piano a pagamento: costa poco e include i backup.

---

## Prima scelta: due strade per creare i servizi

Il progetto contiene un file `render.yaml` che descrive già database, backend e sito,
comandi compresi. Puoi usarlo, oppure creare tutto a mano. **Scegli una delle due,
non mescolarle**: se segui il Blueprint e poi rifai anche il Passo 1 a mano, ti
ritrovi con **due database** con lo stesso nome e non sai più quale usa il backend.

- **Strada A — Blueprint (consigliata, più veloce e senza rischio di dimenticare
  un'impostazione)**: su Render clicca **New** > **Blueprint**, scegli il repository
  di WorkFlow360. Render legge `render.yaml` e propone da solo database, backend e
  sito, con build command, start command, regole di cache e di rewrite già corrette.
  **Salta i Passi 1, 2 e 5** (i campi lì descritti li compila Render): vai dritto al
  **Passo 3** per le variabili del backend, poi **Passo 4**, poi al **Passo 6** per
  `VITE_API_BASE_URL`, poi **Passo 7** in poi.
- **Strada B — a mano**: segui **tutti** i passi da 1 a 9, in ordine, senza saltare
  nulla — in particolare non dimenticare le regole di cache del Passo 5, che il
  Blueprint include da solo e la creazione manuale no.

---

## Passo 1 — Crea il database (solo Strada B)

1. Entra su Render e clicca **New** > **Postgres**.
2. Nome: `workflow360-db`.
3. Database: `workflow360`. User: `workflow360`.
4. Region (regione): **Frankfurt**. Segnatela: gli altri due servizi devono stare
   nella stessa, altrimenti si parlano passando per Internet invece che dalla rete
   interna di Render (più lento e meno sicuro).
5. Plan: **Free** (ma rileggi l'avviso qui sopra).
6. Clicca **Create Database** e aspetta che lo stato diventi **Available**
   (uno o due minuti).

---

## Passo 2 — Crea il backend (solo Strada B)

1. Clicca **New** > **Web Service** e scegli il repository di WorkFlow360.
2. Name: `workflow360-api`.
3. Region: **la stessa del database** (Frankfurt).
4. Branch: `master`.
5. Root Directory: **lascia vuoto**. Deve restare la cartella principale del progetto,
   non `packages/backend`: il progetto è un "monorepo" e le librerie si installano
   tutte insieme dalla radice.
6. Runtime: **Node**.
7. Build Command (copia e incolla esattamente):

   ```
   npm ci --include=dev && npm run build --workspace=packages/backend
   ```

8. Start Command (copia e incolla esattamente):

   ```
   cd packages/backend && node dist/core/db/migrate.js && node dist/index.js
   ```

9. Instance Type: **Free**.
10. **Non creare ancora il servizio**: prima le variabili, al passo seguente.

---

## Passo 3 — Le variabili del backend

*(Con entrambe le strade: qui il Blueprint ti chiede solo queste variabili, i campi tecnici sopra li ha già compilati da solo.)*

Sempre nella pagina del backend, sezione **Environment** (o "Advanced" > "Add
Environment Variable"), aggiungi queste voci. Sono le "impostazioni" del motore.

| Nome | Valore da mettere |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | **non scriverlo a mano**: usa "Add from database" e scegli `workflow360-db` (Internal Connection String) |
| `JWT_ACCESS_SECRET` | una password lunga e casuale, almeno 32 caratteri (vedi sotto) |
| `JWT_REFRESH_SECRET` | un'altra, **diversa** dalla precedente, almeno 32 caratteri |
| `JWT_ACCESS_EXPIRES_IN` | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | `7d` |
| `PASSWORD_RESET_EXPIRES_IN` | `1h` |
| `MAIL_FROM` | `WorkFlow360 <onboarding@resend.dev>` |
| `RESEND_API_KEY` | la tua chiave Resend, oppure lascia vuoto (senza, le email di recupero password non partono, ma tutto il resto funziona) |
| `TZ` | `Europe/Rome` |

Per generare i due segreti, apri il terminale sul tuo computer e lancia due volte:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Copia il risultato del primo comando in `JWT_ACCESS_SECRET` e quello del secondo in
`JWT_REFRESH_SECRET`. Non devono essere uguali. Non condividerli con nessuno.

**Due variabili le lasciamo per dopo**: `CORS_ORIGINS` e `APP_BASE_URL`. Servono
l'indirizzo del frontend, che ancora non esiste. Le aggiungiamo al Passo 5.

**`PORT` non va impostata**: la decide Render da sé e il backend la legge da solo.

Adesso clicca **Create Web Service**. Il primo avvio richiede qualche minuto.

---

## Passo 4 — Controlla che il backend sia vivo

1. In alto nella pagina del servizio trovi il suo indirizzo, tipo
   `https://workflow360-api.onrender.com`. **Copialo nel blocco note.**
2. Apri nel browser quell'indirizzo con `/api/v1/health` in fondo:

   ```
   https://workflow360-api.onrender.com/api/v1/health
   ```

3. Devi vedere una riga simile a questa:

   ```json
   {"status":"ok","env":"production","db":"connected"}
   ```

**Se vedi `db: connected`, database e backend si parlano: il grosso è fatto.**

Se invece la pagina dà errore, apri la scheda **Logs** del servizio su Render e leggi
le ultime righe: se dice che manca una variabile, torna al Passo 3 e aggiungila.

---

## Passo 5 — Crea il frontend (il sito) (solo Strada B)

1. Clicca **New** > **Static Site** e scegli lo stesso repository.
2. Name: `workflow360-web`.
3. Branch: `master`. Root Directory: **lascia vuoto** (come per il backend).
4. Build Command:

   ```
   npm ci --include=dev && npm run build --workspace=packages/frontend
   ```

5. Publish Directory:

   ```
   packages/frontend/dist
   ```

6. Environment Variable — aggiungi **una sola** voce:

   | Nome | Valore |
   |---|---|
   | `VITE_API_BASE_URL` | l'indirizzo del backend copiato al Passo 4, **con `/api/v1` in fondo, senza barra finale**, es. `https://workflow360-api.onrender.com/api/v1` |

7. Vai in **Redirects/Rewrites** e aggiungi una regola:
   - Source: `/*`
   - Destination: `/index.html`
   - Action: **Rewrite**

   Serve per non prendere un errore "404" quando ricarichi una pagina interna
   (per esempio quella di un cantiere).

8. Vai in **Headers** e aggiungi queste due regole (il Blueprint le include da solo, a
   mano vanno aggiunte qui — senza, dopo un aggiornamento del sito il telefono può
   continuare a mostrare la versione vecchia con una schermata bianca):

   | Path | Nome header | Valore |
   |---|---|---|
   | `/*` | `Cache-Control` | `no-cache` |
   | `/assets/*` | `Cache-Control` | `public, max-age=31536000, immutable` |

9. Clicca **Create Static Site**, aspetta la fine della build e **copia l'indirizzo del
   sito** (tipo `https://workflow360-web.onrender.com`) nel blocco note.

---

## Passo 6 — Torna sul backend e completa le due variabili

Ora che conosci l'indirizzo del sito, torna nella pagina del **backend**
(`workflow360-api`) > **Environment** e aggiungi:

| Nome | Valore |
|---|---|
| `CORS_ORIGINS` | l'indirizzo del frontend, es. `https://workflow360-web.onrender.com` |
| `APP_BASE_URL` | lo stesso identico indirizzo |

Attenzione a due dettagli che fanno perdere ore:

- **niente barra finale** (`.onrender.com`, non `.onrender.com/`);
- **`https://` e non `http://`**.

Salva: Render riavvia il backend da solo (uno o due minuti).

Senza questo passo il sito si apre ma ogni operazione fallisce, perché il browser
blocca le chiamate verso un indirizzo che il backend non ha dichiarato come amico.

---

## Passo 7 — Crea il primo amministratore

Il database è vuoto: non esiste ancora nessun utente, quindi non puoi entrare da
nessuna parte. Questo passo si fa **una volta sola**, dal tuo computer.

Fallo **solo dopo** che il Passo 4 ti ha risposto `db: connected`: è l'avvio del backend
che crea le tabelle nel database, e prima di quello non c'è nulla da riempire.

1. Su Render, apri la pagina del **database** e copia la **External Database URL**
   (quella "esterna", non la "internal": stai chiamando da casa, non da dentro Render).
2. Apri il terminale nella cartella del progetto ed entra in `packages/backend`:

   ```
   cd packages/backend
   ```

3. Lancia questo comando, sostituendo le parti in maiuscolo. Nota il
   `?sslmode=verify-full` aggiunto in fondo all'indirizzo del database (non
   `require`: quella modalità cifra la connessione ma non controlla che il server
   dall'altra parte sia davvero quello giusto — con `verify-full` sì).

   Su **Windows (PowerShell)**:

   ```powershell
   $env:DATABASE_URL="INCOLLA_EXTERNAL_DATABASE_URL?sslmode=verify-full"
   $env:BOOTSTRAP_COMPANY_NAME="Nome Della Tua Azienda"
   $env:BOOTSTRAP_ADMIN_NAME="Nome Cognome"
   $env:BOOTSTRAP_ADMIN_EMAIL="tua@email.it"
   $env:BOOTSTRAP_ADMIN_PASSWORD="INCOLLA_QUI_UNA_TUA_PASSWORD_VERA_ALMENO_10_CARATTERI"
   npm run bootstrap:admin
   ```

   Su **Mac/Linux**:

   ```bash
   DATABASE_URL="INCOLLA_EXTERNAL_DATABASE_URL?sslmode=verify-full" \
   BOOTSTRAP_COMPANY_NAME="Nome Della Tua Azienda" \
   BOOTSTRAP_ADMIN_NAME="Nome Cognome" \
   BOOTSTRAP_ADMIN_EMAIL="tua@email.it" \
   BOOTSTRAP_ADMIN_PASSWORD="INCOLLA_QUI_UNA_TUA_PASSWORD_VERA_ALMENO_10_CARATTERI" \
   npm run bootstrap:admin
   ```

4. Devi leggere `[BOOTSTRAP] Creazione completata.` con il nome azienda e l'email.
   La password non viene mai stampata: è giusto così, la conosci solo tu.

5. **Subito dopo, pulisci la cronologia del terminale.** I comandi qui sopra contengono
   la password dell'admin e l'indirizzo completo del database (utente e password
   inclusi), e il terminale li salva per sempre in un file di testo sul tuo computer.

   Su **Windows (PowerShell)**:

   ```powershell
   Clear-Content (Get-PSReadLineOption).HistorySavePath
   ```

   Su **Mac/Linux (bash)**:

   ```bash
   history -c && history -w
   ```

Cose utili da sapere su questo comando:

- Se nel database esiste **già anche un solo utente**, si ferma e non tocca niente.
  È una protezione voluta: gli utenti successivi si creano dalla dashboard.
- Se una variabile manca, te lo dice per nome e non scrive nulla nel database.
- La password deve avere **almeno 10 caratteri**, altrimenti rifiuta.
- Sul tuo computer deve esistere il file `.env` nella cartella principale del progetto
  (quello che usi per lo sviluppo): il backend controlla anche le altre impostazioni
  all'avvio. Se non ce l'hai, copialo da `.env.example`.

---

## Passo 8 — Prova dal telefono

1. Apri l'indirizzo del frontend dal telefono.
2. Accedi con l'email e la password del Passo 7.
3. Se entri nella dashboard, **è online e funziona**.
4. Per installarla come app: menu del browser > "Aggiungi a schermata Home".
   Comparirà l'icona di WorkFlow360 come una normale app.

Se il login gira all'infinito o dà errore di rete, quasi sempre è una di queste due:

- `VITE_API_BASE_URL` sbagliata (manca `/api/v1` in fondo) → correggila nel frontend
  e **rilancia la build** (le impostazioni del sito entrano nel pacchetto al momento
  della build, non dopo);
- `CORS_ORIGINS` sbagliata sul backend (barra finale, o `http` invece di `https`).

---

## Passo 9 — Tieni sveglio il servizio gratuito

Sul piano gratuito, Render **spegne il backend dopo circa 15 minuti di inattività**.
La prima richiesta successiva lo risveglia, ma può metterci **quasi un minuto**: per
un operaio che deve registrare le ore sembra un'app rotta.

Rimedio gratuito: un servizio esterno che "bussa" ogni pochi minuti.

1. Registrati su [uptimerobot.com](https://uptimerobot.com) (piano gratuito).
2. **Add New Monitor** > tipo **HTTP(s)**.
3. URL: l'indirizzo di controllo del backend, cioè
   `https://workflow360-api.onrender.com/api/v1/health`.
4. Monitoring Interval: **5 minuti** (va bene anche 10).
5. Salva.

Bonus: se il backend cade davvero, UptimeRobot ti manda un'email.

Nota onesta: questo riduce le attese, non le elimina del tutto, e non aggira i limiti
di ore gratuite mensili di Render. Se il gestionale diventa lo strumento di lavoro
quotidiano dell'azienda, il piano a pagamento del backend (niente spegnimenti) è la
soluzione seria.

---

## Ogni volta che aggiorni il codice

1. Fai `git push` sul branch `master`.
2. Render se ne accorge da solo e ricostruisce backend e frontend.
3. Il backend, all'avvio, applica da solo le eventuali migrazioni del database.
   Se una migrazione fallisce, **il servizio non parte apposta**: meglio fermo che
   attivo sopra un database in uno stato sconosciuto. In quel caso apri i **Logs**
   e leggi l'errore.

---

## Se qualcosa non va: dove guardare

| Sintomo | Dove guardare |
|---|---|
| Il sito si apre ma il login dà errore di rete | `VITE_API_BASE_URL` (frontend) e `CORS_ORIGINS` (backend) |
| `/api/v1/health` dà errore | **Logs** del backend su Render |
| `db: connected` non compare | `DATABASE_URL` collegata al database, stessa region |
| Il primo accesso non funziona | rilancia il Passo 7 e leggi il messaggio: se dice che esistono già utenti, l'admin c'è già |
| Pagina bianca dopo un aggiornamento | ricarica forzando l'aggiornamento (Ctrl+F5), o chiudi e riapri l'app installata |
| Prima apertura lentissima | è il risveglio del piano gratuito: vedi Passo 9 |
