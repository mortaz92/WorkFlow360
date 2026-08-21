// Crea la PRIMA azienda e il PRIMO utente admin di un'installazione (tipicamente in
// produzione, dove non esiste ancora nessuno che possa creare utenti dalla dashboard).
//
// USO (dal PC locale, puntando al database di produzione):
//   cd packages/backend
//   DATABASE_URL="postgresql://...?sslmode=require" \
//   (require, non verify-full: la libreria "postgres" usata qui non riconosce
//   quel valore, il server rifiuterebbe la connessione con "SSL/TLS required" —
//   verificato dal vivo il 21/08 contro il database reale)
//   BOOTSTRAP_COMPANY_NAME="Neotekna SRL" \
//   BOOTSTRAP_ADMIN_NAME="Mario Rossi" \
//   BOOTSTRAP_ADMIN_EMAIL="mario@neotekna.it" \
//   BOOTSTRAP_ADMIN_PASSWORD="..." \
//   npm run bootstrap:admin
//
// Va lanciato UNA VOLTA SOLA: si rifiuta di partire se nel database esiste già anche un
// solo utente. Non crea dati demo (nessun cantiere, nessun lavoro finto): a differenza di
// scripts/seed-dev.ts, che serve allo sviluppo locale, qui il database è quello vero.
//
// Connessione al database creata QUI, non importata da ../src/core/db: quel modulo
// dipende da CONFIG, che valida l'INTERA configurazione dell'app (JWT secret, MAIL_FROM,
// tutto) — cose che questo script non userà mai, perché non avvia un server. Con
// l'import di CONFIG, un .env locale con un JWT secret ancora segnaposto (lo scenario
// più comune: si arriva a questo passo copiando .env.example) blocca lo script con un
// errore sui segreti JWT mentre si sta solo creando un amministratore.
import bcrypt from 'bcrypt';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { BCRYPT_COST, looksLikePlaceholder } from '../src/core/constants';
import { emailSchema } from '../src/core/validation';
import { companies, users } from '../src/core/db/schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[BOOTSTRAP] Manca DATABASE_URL (nessun valore predefinito: deve puntare al database vero).');
  process.exit(1);
}
const queryClient = postgres(databaseUrl);
const db = drizzle(queryClient, { schema: { companies, users } });

// Non è la policy di sicurezza del prodotto, è il minimo sindacale per l'unico account
// che all'inizio può fare tutto: una password corta qui vale quanto nessuna password.
const MIN_PASSWORD_LENGTH = 10;

interface BootstrapInput {
  companyName: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
}

/**
 * Legge i dati SOLO dalle variabili d'ambiente, senza alcun valore di default: un default
 * qui significherebbe un admin con credenziali note pubblicamente su un database vero.
 * Elenca tutte le variabili mancanti in una volta invece di fermarsi alla prima.
 */
function readInput(): BootstrapInput {
  const raw = {
    companyName: process.env.BOOTSTRAP_COMPANY_NAME?.trim(),
    adminName: process.env.BOOTSTRAP_ADMIN_NAME?.trim(),
    adminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL?.trim(),
    // La password NON viene ripulita con trim(): spazi iniziali/finali sono caratteri
    // legittimi e toglierli creerebbe un account con una password diversa da quella scelta.
    adminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  };

  const envNames: Record<keyof BootstrapInput, string> = {
    companyName: 'BOOTSTRAP_COMPANY_NAME',
    adminName: 'BOOTSTRAP_ADMIN_NAME',
    adminEmail: 'BOOTSTRAP_ADMIN_EMAIL',
    adminPassword: 'BOOTSTRAP_ADMIN_PASSWORD',
  };

  const missing = (Object.keys(envNames) as (keyof BootstrapInput)[]).filter((key) => !raw[key]);

  if (missing.length > 0) {
    console.error("[BOOTSTRAP] Mancano queste variabili d'ambiente (obbligatorie, nessun valore predefinito):");
    for (const key of missing) {
      console.error(`  - ${envNames[key]}`);
    }
    console.error('\n[BOOTSTRAP] Nessuna modifica al database. Imposta le variabili e rilancia.');
    process.exit(1);
  }

  const password = raw.adminPassword as string;
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`[BOOTSTRAP] La password deve avere almeno ${MIN_PASSWORD_LENGTH} caratteri. Nessuna modifica al database.`);
    process.exit(1);
  }
  // Un placeholder di esempio (es. copiato per sbaglio da GUIDA-DEPLOY.md) può essere
  // abbastanza lungo da superare il controllo sopra: bloccalo comunque per contenuto,
  // non solo per lunghezza — altrimenti l'admin nascerebbe con una password nota a
  // chiunque legga la documentazione.
  if (looksLikePlaceholder(password)) {
    console.error('[BOOTSTRAP] BOOTSTRAP_ADMIN_PASSWORD sembra ancora un segnaposto della guida, non una password vera. Nessuna modifica al database.');
    process.exit(1);
  }

  // .toLowerCase() dentro emailSchema, non solo .email(): un'email creata con un case
  // diverso da quello poi digitato al login fallirebbe con "credenziali non valide"
  // (Postgres confronta stringhe exact-match) — bug reale, riprodotto col primo admin
  // creato in produzione il 20/08 (creato con una maiuscola nel dominio, login con
  // dominio minuscolo rifiutato).
  const emailResult = emailSchema.safeParse(raw.adminEmail);
  if (!emailResult.success) {
    console.error(`[BOOTSTRAP] BOOTSTRAP_ADMIN_EMAIL non è un indirizzo email valido: ${raw.adminEmail}`);
    console.error('[BOOTSTRAP] Nessuna modifica al database.');
    process.exit(1);
  }

  return {
    companyName: raw.companyName as string,
    adminName: raw.adminName as string,
    adminEmail: emailResult.data,
    adminPassword: password,
  };
}

// Chiave arbitraria ma fissa per il lock consultivo Postgres — condivisa da tutte le
// esecuzioni di QUESTO script (mai da un altro), così due lanci in parallelo (es. due
// terminali dimenticati aperti sulla stessa DATABASE_URL) si mettono in coda invece di
// leggere entrambi "database vuoto" e creare due aziende radice distinte.
const BOOTSTRAP_LOCK_KEY = 726352001;

async function main(): Promise<void> {
  const input = readInput();
  const passwordHash = await bcrypt.hash(input.adminPassword, BCRYPT_COST);

  // Lock + conteggio + insert nella STESSA transazione: un conteggio fuori dal lock (o in
  // una transazione separata dall'insert) lascerebbe comunque la finestra in cui due
  // esecuzioni leggono entrambe "0 utenti" prima che una delle due scriva. Col lock preso
  // per primo, la seconda esecuzione aspetta che la prima commiti (o vada in rollback) e
  // rilegge un conteggio già aggiornato.
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);

    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(users);
    if (count > 0) {
      return { alreadyPopulated: true as const, count };
    }

    // Azienda e admin nella stessa transazione: un utente senza azienda non è creabile
    // (company_id è notNull + FK) e un'azienda senza nessun utente sarebbe inutilizzabile.
    const [company] = await tx.insert(companies).values({ name: input.companyName }).returning({ id: companies.id });
    const [user] = await tx
      .insert(users)
      .values({
        companyId: company.id,
        email: input.adminEmail,
        name: input.adminName,
        role: 'admin',
        passwordHash,
      })
      .returning({ id: users.id });
    return { alreadyPopulated: false as const, companyId: company.id, userId: user.id };
  });

  if (result.alreadyPopulated) {
    console.error(`[BOOTSTRAP] Nel database esistono già ${result.count} utenti: uso improprio evitato, nessuna modifica.`);
    console.error('[BOOTSTRAP] I nuovi utenti si creano dalla dashboard, con un account admin.');
    process.exit(1);
  }

  const { companyId, userId } = result;

  // Nessuna password stampata, in nessuna forma (nemmeno mascherata o come lunghezza):
  // questi log finiscono nel terminale di chi lancia lo script e, se lanciato da una CI,
  // in un archivio di log condiviso.
  console.log('[BOOTSTRAP] Creazione completata.');
  console.log(`  Azienda: ${input.companyName} (${companyId})`);
  console.log(`  Admin:   ${input.adminEmail} (${userId})`);
  console.log('[BOOTSTRAP] Accedi dal frontend con questa email e la password che hai scelto.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[BOOTSTRAP] Errore:', err);
    process.exit(1);
  });
