import { createApp } from './app';
import { CONFIG } from './core/config';

const app = createApp();

const server = app.listen(CONFIG.PORT, () => {
  console.log(`[SERVER] WorkFlow360 backend in ascolto sulla porta ${CONFIG.PORT} (${CONFIG.NODE_ENV})`);
});

// RETE DI SICUREZZA, non un modo per continuare a girare dopo un errore.
//
// Node termina il processo quando un'eccezione arriva in cima allo stack senza gestore, e
// finora questo file non ne registrava nessuno: un throw ASINCRONO dentro una libreria —
// il caso reale è png-js, che rilancia l'errore di zlib dentro la callback di inflate,
// dove nessun try/catch del chiamante può arrivare (vedi firmaPng.ts) — faceva sparire il
// backend per tutti i clienti senza lasciare altra traccia che l'uscita del processo.
// La causa a monte è chiusa (quel PNG viene ora decompresso e validato in modo sincrono
// prima di arrivare a pdfkit); questo gestore copre il RESTO del processo, cioè qualunque
// altra libreria possa fare la stessa cosa in un punto che ancora non conosciamo.
//
// Chiude comunque, e deliberatamente: dopo un'eccezione non gestita lo stato del processo
// è indefinito, e restare in piedi servirebbe solo a rispondere in modo imprevedibile. La
// differenza che fa è che il motivo finisce nei log PRIMA di sparire (senza, resta solo
// un processo uscito e nessuna spiegazione) e che le richieste già in corso vengono
// servite invece di essere troncate. Il timer di scorta impedisce che una connessione
// appesa rimandi la chiusura all'infinito; `unref()` gli toglie il diritto di tenere vivo
// il processo quando invece tutto si è chiuso prima.
const USCITA_FORZATA_MS = 5000;

process.on('uncaughtException', (err, origine) => {
  console.error(`[SERVER] Eccezione non gestita (${origine}): il processo si chiude.`, err);
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), USCITA_FORZATA_MS).unref();
});
