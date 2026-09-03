import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { CONFIG } from '../config';
import * as schema from './schema';

// Due tetti di tempo impostati su OGNI connessione, come rete di sicurezza: un blocco che
// scade è un errore diagnosticabile (arriva con la query che lo ha causato, e finisce nei
// log), un blocco eterno no — resta appeso, tiene occupata una connessione del pool e si
// manifesta molto più tardi, come "l'applicazione non risponde più".
//   - lock_timeout: una singola istruzione che aspetta un lock di riga per più di 5s si
//     arrende. Le transazioni di questo progetto durano decine di millisecondi e non
//     fanno chiamate di rete al loro interno (l'email del rapportino parte DOPO il
//     commit, apposta): 5s non è una soglia che il traffico normale possa sfiorare, è la
//     spia di un'attesa patologica — vedi l'ordine dei lock dichiarato in
//     createRapportino (rapportini.service.ts), scritto dopo un deadlock reale.
//   - idle_in_transaction_session_timeout: una transazione aperta e poi rimasta ferma per
//     30s viene chiusa da Postgres. Protegge dal caso in cui il codice apra una
//     transazione e resti in attesa di qualcosa che non arriva mai, tenendo intanto i
//     propri lock e bloccando tutti gli altri.
// I due valori sono in MILLISECONDI: Postgres interpreta così un intero senza unità, ed è
// anche il tipo che postgres.js dichiara per questi parametri (`number`, non `'5s'`).
const LOCK_TIMEOUT_MS = 5000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30000;

const queryClient = postgres(CONFIG.DATABASE_URL, {
  connection: {
    lock_timeout: LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
  },
});

export const db = drizzle(queryClient, { schema });
