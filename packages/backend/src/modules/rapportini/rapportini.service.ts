import crypto from 'node:crypto';
import ms from 'ms';
import { and, asc, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import {
  companies,
  projects,
  rapportini,
  tasks,
  timeLogMaterials,
  timeLogs,
  users,
  type RapportinoStatus,
} from '../../core/db/schema';
import { CONFIG } from '../../core/config';
import { isUniqueViolation, uniqueViolationConstraint } from '../../core/db/isUniqueViolation';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../../core/errors';
import { escapeHtml } from '../../core/escapeHtml';
import { isManager } from '../../core/roles';
import { sendEmail } from '../../core/mail';
import { generateOpaqueToken, hashOpaqueToken } from '../../core/tokens';
import { recordAudit } from '../auditLog/auditLog.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { assertFirmaPngDisegnabile, validaFirmaPng } from './firmaPng';
import { buildRapportinoPdf, formatOreIt, type FirmaPdf } from './rapportino.pdf';
import {
  SNAPSHOT_VERSIONE,
  rapportinoSnapshotSchema,
  type CreatedRapportino,
  type FirmaContesto,
  type FirmaEsito,
  type FirmaInput,
  type PaginatedRapportini,
  type PublicRapportino,
  type RapportinoListItem,
  type RapportinoSnapshot,
  type SnapshotMateriale,
  type SnapshotRiga,
} from './rapportini.types';

// Stesso sottoinsieme di metodi comune a `db` e a un client di transazione già usato in
// timeLogs.service.ts: permette agli helper di lettura di girare indifferentemente
// dentro o fuori una transazione, senza leggere da uno snapshot diverso da quello delle
// scritture della stessa operazione.
type Queryable = Pick<typeof db, 'select'>;

const SIGNING_TOKEN_BYTES = 32;
// Stati in cui il rapportino tiene bloccate le proprie ore.
const STATI_BLOCCANTI: RapportinoStatus[] = ['in_firma', 'firmato'];
// Nome dell'indice UNIQUE PARZIALE creato a mano in drizzle/0012_rapportino_partial_unique.sql.
// Serve a distinguerlo dall'ALTRO vincolo UNIQUE della stessa tabella (project+date+revision):
// un 23505 dice "duplicato", non QUALE duplicato, e attribuire il messaggio sbagliato
// manderebbe l'utente a cercare un rapportino in attesa di firma che non esiste.
const VINCOLO_UNO_IN_FIRMA = 'rapportini_project_id_date_in_firma_unique';
// Nome del terzo UNIQUE della tabella (company_id, numero), dichiarato in
// schema/rapportini.ts: distinguerlo dagli altri due serve a non dire all'utente di
// annullare un rapportino in attesa di firma quando il conflitto riguarda il progressivo.
const VINCOLO_NUMERO = 'rapportini_company_id_numero_unique';

function formatDataIt(value: Date): string {
  const due = (n: number) => String(n).padStart(2, '0');
  return `${due(value.getDate())}/${due(value.getMonth() + 1)}/${value.getFullYear()}`;
}

function formatDataIsoIt(isoDate: string): string {
  const [anno, mese, giorno] = isoDate.split('-');
  return giorno && mese && anno ? `${giorno}/${mese}/${anno}` : isoDate;
}

// Quantità materiali: numeric(12,3) arriva da Postgres come "6.000", e nello snapshot si
// scrive "6" — stessa normalizzazione per le righe e per i totali, così lo stesso numero
// non finisce scritto in due modi diversi dentro lo stesso documento (e quindi dentro
// l'hash che lo sigilla).
//
// È una normalizzazione di MEMORIA, non di presentazione: il punto resta il separatore
// decimale, perché questo valore viene riletto con Number() da calcolaTotali per sommare
// le righe — con la virgola diventerebbe NaN e i totali del documento sparirebbero. La
// lettura italiana ("12,5") la applicano le rese, ognuna con la propria funzione:
// formatQuantitaIt nel PDF, formatQuantita nel frontend.
function formatQuantita(valore: number): string {
  return String(Number(valore.toFixed(3)));
}

// JSON canonico: chiavi ordinate ricorsivamente, così lo stesso contenuto produce sempre
// la stessa stringa e quindi lo stesso hash. Senza questo, l'ordine di serializzazione
// degli oggetti (che dipende dall'ordine di inserimento delle proprietà) renderebbe
// l'hash inutile come prova di integrità: due snapshot identici darebbero hash diversi.
function canonicalizza(valore: unknown): unknown {
  if (Array.isArray(valore)) return valore.map(canonicalizza);
  if (valore !== null && typeof valore === 'object') {
    const ordinato: Record<string, unknown> = {};
    for (const chiave of Object.keys(valore as Record<string, unknown>).sort()) {
      ordinato[chiave] = canonicalizza((valore as Record<string, unknown>)[chiave]);
    }
    return ordinato;
  }
  return valore;
}

export function hashSnapshot(snapshot: RapportinoSnapshot): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalizza(snapshot))).digest('hex');
}

/**
 * Rilegge `snapshot_json` dal database validandone la forma invece di fidarsi di un cast.
 *
 * Restituisce il valore ORIGINALE, non quello prodotto da Zod, e non è un dettaglio: gli
 * oggetti Zod scartano di default le chiavi che non conoscono, quindi restituire l'output
 * del parse significherebbe calcolare `hashSnapshot` su un oggetto potenzialmente diverso
 * da quello salvato — l'hash non corrisponderebbe più e la verifica d'integrità qui sotto
 * segnalerebbe una corruzione inesistente ogni volta che lo snapshot guadagna un campo.
 * Zod fa da guardia sulla forma; l'oggetto che circola resta byte per byte quello scritto.
 */
function leggiSnapshot(row: { id: string; snapshotJson: unknown }): RapportinoSnapshot {
  const esito = rapportinoSnapshotSchema.safeParse(row.snapshotJson);
  if (!esito.success) {
    console.error(
      `[RAPPORTINI] Snapshot del rapportino ${row.id} non conforme:`,
      esito.error.flatten().fieldErrors,
    );
    throw new Error(`Lo snapshot del rapportino ${row.id} non ha una struttura leggibile`);
  }
  return row.snapshotJson as RapportinoSnapshot;
}

/**
 * Ricalcola l'hash dello snapshot e lo confronta con quello registrato alla creazione.
 *
 * NON blocca la richiesta: un documento che il cliente ha firmato deve restare leggibile e
 * stampabile anche se il confronto fallisce — negarne la visione peggiorerebbe la
 * situazione invece di ripararla. Il punto è che la discrepanza smetta di essere
 * invisibile: `snapshot_hash` è stato scritto alla creazione e fino a qui non lo
 * rileggeva nessuno, quindi non dimostrava niente. Un disallineamento significa
 * corruzione dei dati oppure una modifica fatta fuori dall'applicazione (una UPDATE a
 * mano sul database): entrambi i casi vanno visti nei log, non scoperti in tribunale.
 */
/*
 * PERCHÉ IL N° PROGRESSIVO NON È COPERTO DA QUESTA PROVA (decisione, non dimenticanza).
 *
 * `snapshot_hash` copre `snapshot_json` e basta. Il numero rosso del documento — quello
 * con cui il cliente lo ritrova — sta in COLONNA, quindi una UPDATE fatta a mano sul
 * database lo cambierebbe senza che nulla se ne accorga: esattamente lo scenario per cui
 * `snapshot_hash` esiste. L'osservazione è giusta; la conclusione "aggiungiamo una colonna
 * document_hash" no, per tre ragioni concrete.
 *
 * 1. Non è raggiungibile dall'applicazione. Le uniche UPDATE su `rapportini` in tutto il
 *    codice scrivono status, cancel_reason, unlocked_*, email_* e signer_* (verificato:
 *    cinque punti, nessuno tocca `numero`). Il numero si scrive alla INSERT e mai più.
 *    Non esiste una richiesta HTTP che possa cambiarlo.
 * 2. Una colonna aggiunta ora nascerebbe VUOTA proprio sui documenti che contano. Tutti i
 *    rapportini già firmati avrebbero document_hash NULL, e riempirla con un backfill
 *    significherebbe calcolarla dalle righe che potrebbero essere già state alterate: il
 *    backfill certificherebbe l'alterazione invece di rivelarla. Una prova d'integrità
 *    creata dopo il fatto non prova niente sul prima.
 * 3. Contro una UPDATE fatta fuori dall'applicazione, la difesa vera non è un'altra
 *    colonna scritta dalla stessa applicazione: sono i privilegi sul database (niente
 *    UPDATE per l'utente applicativo su questa tabella) o un trigger. Vive a un altro
 *    livello, non qui.
 *
 * E una prova esterna sul numero esiste già, senza scrivere una riga di codice: il PDF
 * viene generato CON il numero stampato sopra e spedito al cliente, con l'azienda in copia
 * nascosta (vedi inviaRapportinoFirmato). Sono due caselle di posta fuori da questo
 * database. Un numero cambiato dopo la firma non corrisponderebbe più al documento che
 * entrambi hanno in mano — che è più di quanto dimostrerebbe una colonna in più.
 *
 * NON si tocca invece l'input di `hashSnapshot` per infilarci il numero: cambierebbe il
 * risultato per OGNI rapportino già scritto, e da quel momento ogni documento esistente
 * risulterebbe "INTEGRITÀ VIOLATA" — si romperebbe la prova che funziona per estenderne
 * la portata a un caso che non è raggiungibile.
 */
function verificaIntegritaSnapshot(row: { id: string; snapshotJson: unknown; snapshotHash: string }): void {
  let calcolato: string;
  try {
    calcolato = hashSnapshot(leggiSnapshot(row));
  } catch (err) {
    console.error(`[RAPPORTINI] INTEGRITÀ: impossibile ricalcolare l'hash del rapportino ${row.id}:`, err);
    return;
  }
  if (calcolato !== row.snapshotHash) {
    console.error(
      `[RAPPORTINI] INTEGRITÀ VIOLATA sul rapportino ${row.id}: hash registrato ${row.snapshotHash}, ` +
        `hash ricalcolato ${calcolato}. Lo snapshot è stato alterato dopo la creazione ` +
        '(corruzione dei dati o modifica fuori dall\'applicazione).',
    );
  }
}

async function caricaMaterialiPerTimeLog(
  queryable: Queryable,
  timeLogIds: string[],
  companyId: string,
): Promise<Map<string, SnapshotMateriale[]>> {
  const perTimeLog = new Map<string, SnapshotMateriale[]>();
  if (timeLogIds.length === 0) return perTimeLog;

  const righe = await queryable
    .select({
      timeLogId: timeLogMaterials.timeLogId,
      name: timeLogMaterials.name,
      code: timeLogMaterials.code,
      quantity: timeLogMaterials.quantity,
      unit: timeLogMaterials.unit,
    })
    .from(timeLogMaterials)
    .where(and(inArray(timeLogMaterials.timeLogId, timeLogIds), eq(timeLogMaterials.companyId, companyId)))
    // `id` come secondo criterio: due materiali con lo STESSO nome (stesso articolo con
    // due codici diversi) lascerebbero altrimenti l'ordine alla decisione di Postgres, e
    // due costruzioni consecutive dello stesso snapshot potrebbero uscire in ordine
    // diverso — cioè con due hash diversi, e un 409 "le ore sono cambiate" immotivato.
    .orderBy(asc(timeLogMaterials.name), asc(timeLogMaterials.id));

  for (const riga of righe) {
    const lista = perTimeLog.get(riga.timeLogId) ?? [];
    lista.push({
      nome: riga.name,
      quantita: formatQuantita(Number(riga.quantity)),
      unita: riga.unit,
      codice: riga.code,
    });
    perTimeLog.set(riga.timeLogId, lista);
  }
  return perTimeLog;
}

function calcolaTotali(righe: SnapshotRiga[]): RapportinoSnapshot['totali'] {
  let oreTotali = 0;
  const perTipo: Record<string, number> = {};
  const materiali = new Map<
    string,
    { nome: string; unita: string; codice: string | null; quantita: number; chiave: string }
  >();

  for (const riga of righe) {
    const ore = Number(riga.ore);
    oreTotali += ore;
    perTipo[riga.tipo] = (perTipo[riga.tipo] ?? 0) + ore;
    for (const materiale of riga.materiali) {
      // Chiave nome+unità e non solo nome: 3 "m" e 3 "pz" dello stesso articolo non
      // sono 6 di niente, sommarli produrrebbe un totale privo di significato.
      // Per la stessa ragione ci sta dentro anche il CODICE: 3 pezzi del codice A e 3
      // del codice B non sono 6 pezzi di un codice. Fuori dalla chiave bisognerebbe
      // scegliere quale dei due stampare accanto alla quantità sommata, e qualunque
      // scelta produrrebbe una riga FALSA su un documento firmato. Conseguenza voluta e
      // visibile: lo stesso articolo scritto una volta col codice e una senza dà DUE
      // righe — un'anomalia che l'operaio vede e corregge, invece di una fusione muta.
      const chiave = JSON.stringify([materiale.nome, materiale.unita, materiale.codice ?? '']);
      const corrente = materiali.get(chiave) ?? {
        nome: materiale.nome,
        unita: materiale.unita,
        codice: materiale.codice ?? null,
        quantita: 0,
        // La chiave viene CONSERVATA, non solo usata per la Map: serve all'ordinamento
        // qui sotto come criterio finale. Vedi il commento là per il motivo.
        chiave,
      };
      corrente.quantita += Number(materiale.quantita);
      materiali.set(chiave, corrente);
    }
  }

  // Il rapportino può quindi mostrare PIÙ RIGHE materiali del report di cantiere, che
  // aggrega per nome+unità (reports.service.ts) su mesi di registrazioni in cui lo stesso
  // articolo è stato scritto a volte col codice e a volte senza. Le quantità totali
  // restano coerenti; è il numero di righe a poter differire. Divergenza consapevole,
  // scritta qui perché fra sei mesi sembrerebbe un bug.
  return {
    oreTotali: oreTotali.toFixed(2),
    perTipo: Object.fromEntries(Object.entries(perTipo).map(([tipo, ore]) => [tipo, ore.toFixed(2)])),
    // Ordinamento TOTALE (nome, poi unità, poi codice, poi la chiave di aggregazione) e
    // non più il solo nome: col codice nella chiave i pareggi sul nome sono la norma, e
    // l'ordine deve restare deterministico perché createRapportino calcola l'hash dello
    // snapshot DUE volte e li confronta — un ordine instabile farebbe fallire ogni
    // creazione con un 409 "le ore sono cambiate" che non corrisponde a nessun cambiamento.
    //
    // Due dettagli che sembrano pignoleria e non lo sono:
    // 1. `localeCompare` con locale ESPLICITO 'it'. Senza, il criterio di confronto è
    //    quello della macchina: la stessa versione del codice ordinerebbe in modo diverso
    //    sul portatile dello sviluppatore e nel container di Render, a seconda di LANG.
    //    Un documento firmato non può dipendere dalle variabili d'ambiente di chi lo
    //    genera.
    // 2. La CHIAVE di aggregazione come ultimo criterio, confrontata per code point (`<`),
    //    non con localeCompare. Il confronto per locale può restituire 0 su stringhe
    //    DIVERSE — i caratteri ignorabili come il soft hyphen (U+00AD) o lo zero-width
    //    joiner non contano nulla per l'ordinamento — e due voci dichiarate "pari"
    //    resterebbero nell'ordine in cui la Map le ha ricevute, cioè nell'ordine in cui
    //    l'operaio ha inserito le righe. Ma quelle due voci hanno chiavi diverse (per
    //    definizione: sono due voci distinte della Map), quindi la chiave separa sempre e
    //    l'ordine finale è totale.
    materiali: [...materiali.values()]
      .sort(
        (a, b) =>
          a.nome.localeCompare(b.nome, 'it') ||
          a.unita.localeCompare(b.unita, 'it') ||
          (a.codice ?? '').localeCompare(b.codice ?? '', 'it') ||
          (a.chiave < b.chiave ? -1 : a.chiave > b.chiave ? 1 : 0),
      )
      .map((m) => ({ nome: m.nome, quantita: formatQuantita(m.quantita), unita: m.unita, codice: m.codice })),
  };
}

/**
 * Costruisce lo snapshot di un cantiere/giorno leggendo i dati COMPLETI (nomi, email,
 * titoli) invece dei soli id: il documento deve restare leggibile identico anche dopo
 * l'anonimizzazione GDPR di un utente (`DELETE /users/:id`), che sostituisce nome ed
 * email in modo irreversibile. Non persiste nulla.
 *
 * `preparatoIl` è un parametro e non `new Date()` calcolato qui dentro perché
 * createRapportino costruisce lo snapshot DUE volte per confrontarne l'hash (vedi la
 * seconda presa di lock là): con un istante diverso a ogni chiamata i due hash
 * differirebbero sempre, e il confronto segnalerebbe una modifica concorrente a ogni
 * singola creazione.
 */
async function buildSnapshot(
  queryable: Queryable,
  projectId: string,
  date: string,
  companyId: string,
  preparatoDa: AuthenticatedUser,
  preparatoIl: string = new Date().toISOString(),
): Promise<RapportinoSnapshot> {
  const [project] = await queryable
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .limit(1);
  if (!project) {
    throw new NotFoundError('Cantiere non trovato');
  }

  const [azienda] = await queryable.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!azienda) {
    throw new NotFoundError('Azienda non trovata');
  }

  const [preparatore] = await queryable
    .select({ name: users.name })
    .from(users)
    .where(and(eq(users.id, preparatoDa.id), eq(users.companyId, companyId)))
    .limit(1);
  if (!preparatore) {
    throw new NotFoundError('Utente non trovato');
  }

  const righeGrezze = await queryable
    .select({
      id: timeLogs.id,
      tipo: timeLogs.tipo,
      hoursWorked: timeLogs.hoursWorked,
      startTime: timeLogs.startTime,
      endTime: timeLogs.endTime,
      workDescription: timeLogs.workDescription,
      notes: timeLogs.notes,
      userId: users.id,
      userName: users.name,
      taskId: tasks.id,
      taskTitle: tasks.title,
    })
    .from(timeLogs)
    // companyId ripetuto sulle join e non solo su timeLogs: la riga delle ore è già
    // ristretta all'azienda, quindi oggi il filtro non cambia il risultato (nessun
    // endpoint permette di collegare un'ora a un lavoro di un'altra azienda). Sta qui
    // per la stessa ragione per cui c'è in caricaMaterialiPerTimeLog: ogni join di
    // questo modulo porta il proprio vincolo di tenant addosso, così l'isolamento non
    // dipende dal ricordarsi che "tanto lo garantisce la tabella a monte".
    .innerJoin(tasks, and(eq(timeLogs.taskId, tasks.id), eq(tasks.companyId, companyId)))
    .innerJoin(users, and(eq(timeLogs.userId, users.id), eq(users.companyId, companyId)))
    .where(and(eq(timeLogs.companyId, companyId), eq(tasks.projectId, projectId), eq(timeLogs.date, date)))
    // createdAt come secondo criterio: lo split automatico ordinario/notturno/
    // straordinario produce 2-3 righe con la stessa data e lo stesso operaio, e senza
    // un ordine stabile due snapshot dello stesso giorno avrebbero hash diversi.
    // `id` come TERZO criterio, perché i primi due non bastano a garantire un ordine
    // totale: `created_at` è `defaultNow()`, cioè transaction_timestamp(), che resta
    // COSTANTE per tutta una transazione — righe inserite nella stessa transazione hanno
    // lo stesso identico istante. Oggi non capita solo perché createTimeLog non avvolge
    // lo split in una transazione, cioè per una circostanza di un ALTRO modulo: il
    // giorno in cui la si aggiungesse (cosa del tutto ragionevole da fare), due
    // costruzioni dello stesso snapshot potrebbero uscire in ordine diverso e ogni
    // creazione fallirebbe con un 409 immotivato. Stesso criterio già usato in
    // caricaMaterialiPerTimeLog, per la stessa ragione.
    .orderBy(asc(users.name), asc(timeLogs.createdAt), asc(timeLogs.id));

  const materialiPerTimeLog = await caricaMaterialiPerTimeLog(
    queryable,
    righeGrezze.map((r) => r.id),
    companyId,
  );

  const righe: SnapshotRiga[] = righeGrezze.map((r) => ({
    timeLogId: r.id,
    operaio: { id: r.userId, nome: r.userName },
    lavoro: { taskId: r.taskId, titolo: r.taskTitle },
    tipo: r.tipo,
    ore: r.hoursWorked,
    oraInizio: r.startTime,
    oraFine: r.endTime,
    descrizioneLavoro: r.workDescription,
    note: r.notes,
    materiali: materialiPerTimeLog.get(r.id) ?? [],
  }));

  return {
    versione: SNAPSHOT_VERSIONE,
    azienda: {
      nome: azienda.name,
      vat: azienda.vat,
      indirizzo: azienda.address,
      email: azienda.email,
      telefono: azienda.phone,
    },
    cantiere: {
      id: project.id,
      projectNumber: project.projectNumber,
      code: project.code,
      nome: project.name,
      clientName: project.clientName,
      tipoCommessa: project.tipoCommessa,
      // Valorizzato SEMPRE, anche a null, mai omesso quando manca: una chiave presente
      // solo a volte darebbe due forme di JSON per lo stesso tipo di documento, e quindi
      // due hash costruiti su strutture diverse.
      indirizzo: project.address,
    },
    date,
    righe,
    totali: calcolaTotali(righe),
    preparatoIl,
    preparatoDa: { userId: preparatoDa.id, nome: preparatore.name },
  };
}

// Un operaio può preparare/creare il rapportino solo del cantiere e del giorno in cui ha
// davvero lavorato: è lui che ha il cliente davanti. Admin/PM non hanno questo vincolo.
function assertPuoPrepararlo(snapshot: RapportinoSnapshot, actingUser: AuthenticatedUser): void {
  if (isManager(actingUser.role)) return;
  if (!snapshot.righe.some((riga) => riga.operaio.id === actingUser.id)) {
    throw new ForbiddenError('Puoi preparare il rapportino solo dei cantieri e dei giorni in cui hai registrato ore');
  }
}

function assertPuoLeggerlo(row: typeof rapportini.$inferSelect, actingUser: AuthenticatedUser): void {
  if (isManager(actingUser.role)) return;
  if (row.createdBy !== actingUser.id) {
    throw new ForbiddenError('Puoi vedere solo i rapportini che hai preparato tu');
  }
}

/**
 * Stato da MOSTRARE, che non sempre coincide con quello salvato in colonna.
 *
 * Il passaggio a 'scaduto' avviene una sola volta, pigramente, dentro createRapportino per
 * lo stesso cantiere/giorno: finché nessuno riprova a creare quel rapportino, la riga
 * resta scritta 'in_firma' anche mesi dopo la scadenza. Chi la legge (dettaglio, elenco,
 * messaggio di rifiuto su una PATCH) vedrebbe "in attesa di firma" per un link che non è
 * più firmabile da nessuno: non un ritardo di aggiornamento, un'informazione falsa.
 *
 * Solo presentazione: la colonna NON viene toccata da qui. Il lucchetto sulle ore continua
 * a valere finché `time_logs.rapportino_id` è valorizzato, indipendentemente da come lo
 * stato viene mostrato — un rapportino scaduto tiene le sue ore finché non lo si annulla.
 */
function statoPresentato(row: { status: RapportinoStatus; expiresAt: Date }): RapportinoStatus {
  return row.status === 'in_firma' && row.expiresAt < new Date() ? 'scaduto' : row.status;
}

function toPublicRapportino(row: typeof rapportini.$inferSelect): PublicRapportino {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    date: row.date,
    numero: row.numero,
    revision: row.revision,
    status: statoPresentato(row),
    totalHours: row.totalHours,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    snapshot: leggiSnapshot(row),
    snapshotHash: row.snapshotHash,
    signerName: row.signerName,
    signerEmail: row.signerEmail,
    signedAt: row.signedAt,
    expiresAt: row.expiresAt,
    emailSentAt: row.emailSentAt,
    emailLastError: row.emailLastError,
    cancelReason: row.cancelReason,
    unlockedAt: row.unlockedAt,
    unlockedBy: row.unlockedBy,
    unlockReason: row.unlockReason,
  };
}

export async function anteprimaRapportino(
  projectId: string,
  date: string,
  companyId: string,
  actingUser: AuthenticatedUser,
): Promise<RapportinoSnapshot> {
  const snapshot = await buildSnapshot(db, projectId, date, companyId, actingUser);
  assertPuoPrepararlo(snapshot, actingUser);
  return snapshot;
}

// Libera le ore di un rapportino: unico punto che sa che "sbloccare" significa azzerare
// time_logs.rapportino_id. Usato da annullamento, sblocco amministrativo e scadenza.
async function liberaOre(
  tx: Pick<typeof db, 'update'>,
  rapportinoIds: string[],
  companyId: string,
): Promise<void> {
  if (rapportinoIds.length === 0) return;
  await tx
    .update(timeLogs)
    .set({ rapportinoId: null })
    .where(and(inArray(timeLogs.rapportinoId, rapportinoIds), eq(timeLogs.companyId, companyId)));
}

export async function createRapportino(
  projectId: string,
  date: string,
  companyId: string,
  actingUser: AuthenticatedUser,
): Promise<CreatedRapportino> {
  return db.transaction(async (tx) => {
    // ORDINE DEI LOCK DI QUESTA TRANSAZIONE: projects -> time_logs -> companies.
    //
    // Non è l'ordine che verrebbe naturale (prima il contenitore, poi il contenuto) ed è
    // deliberato, perché nell'ordine contano anche i lock che NESSUNO SCRIVE: ogni INSERT
    // prende un FOR KEY SHARE implicito sulle righe referenziate dalle proprie foreign
    // key, e FOR KEY SHARE CONFLIGGE con FOR UPDATE. updateTimeLog (timeLogs.service.ts)
    // blocca la riga delle ore con FOR UPDATE e poi inserisce in time_log_materials, la
    // cui FK verso companies prende FOR KEY SHARE sulla riga dell'azienda: fa quindi
    // time_logs -> companies senza che quel secondo lock compaia in una riga di codice.
    // Finché QUI il FOR UPDATE su companies era la PRIMA istruzione l'ordine era opposto,
    // le due transazioni si aspettavano a vicenda e Postgres rispondeva:
    //   ERROR: deadlock detected
    //   CONTEXT: while locking tuple in relation "companies"
    //   SQL statement "SELECT 1 FROM ONLY "public"."companies" x WHERE "id" = $1
    //                  FOR KEY SHARE OF x"
    // Riprodotto dal vivo su Postgres reale creando un rapportino mentre si modificavano
    // le ore con materiali — non è un rischio teorico. Prendendo companies per ULTIMO
    // l'ordine coincide con quello di updateTimeLog e il ciclo non si chiude più.
    //
    // Il commento che stava qui prima dichiarava l'ordine companies -> projects ->
    // time_logs "sicuro comunque": era proprio quello a causare il deadlock, perché
    // guardava solo i FOR UPDATE scritti a mano e ignorava i lock impliciti delle FK.
    //
    // Esisteva anche una variante che Postgres non avrebbe potuto nemmeno diagnosticare:
    // una scrittura fatta su una connessione DIVERSA da quella della transazione che
    // tiene i lock non compare nel grafo delle attese, quindi non produce un "deadlock
    // detected" ma un'attesa infinita che esaurisce il pool e fa cadere l'applicazione.
    // Era il caso di recordAudit, che usava il `db` globale: ora accetta il `tx` del
    // chiamante (vedi auditLog.service.ts).
    //
    // Chi aggiunge un lock qui dentro rispetti questa sequenza, e conti anche le foreign
    // key delle proprie INSERT.

    // FOR UPDATE sulla riga del cantiere: serializza due creazioni concorrenti sullo
    // stesso cantiere, così il calcolo di MAX(revision)+1 e il controllo delle ore già
    // bloccate non corrono su uno stato che intanto è cambiato — stesso idioma di
    // createProject (projects.service.ts) per lo stesso tipo di race condition.
    const [project] = await tx
      .select({ id: projects.id, tipoCommessa: projects.tipoCommessa })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .for('update')
      .limit(1);
    if (!project) {
      throw new NotFoundError('Cantiere non trovato');
    }
    if (project.tipoCommessa !== 'consuntivo') {
      throw new ConflictError(
        'Il rapportino firmato dal cliente esiste solo per le commesse a consuntivo: ' +
          'su una commessa a contratto il cliente non sottoscrive le ore giornaliere.',
      );
    }

    // Un rapportino mai firmato entro la scadenza non deve tenere in ostaggio né le ore
    // né lo slot dell'UNIQUE parziale: si chiude come 'scaduto' e libera le sue righe,
    // altrimenti l'operaio che riprova dopo un quarto d'ora resterebbe bloccato per
    // sempre su quel giorno.
    const scaduti = await tx
      .update(rapportini)
      .set({ status: 'scaduto' })
      .where(
        and(
          eq(rapportini.projectId, projectId),
          eq(rapportini.date, date),
          eq(rapportini.status, 'in_firma'),
          lt(rapportini.expiresAt, new Date()),
        ),
      )
      .returning({ id: rapportini.id });
    await liberaOre(
      tx,
      scaduti.map((r) => r.id),
      companyId,
    );

    // Le righe del giorno vengono BLOCCATE PRIMA di leggerle per lo snapshot, non dopo.
    // Senza questo lock resterebbe aperta una finestra tra la lettura e la scrittura di
    // rapportino_id: una PATCH concorrente potrebbe cambiare le ore in mezzo, e il
    // rapportino finirebbe per bloccare righe diverse da quelle che il cliente ha visto
    // e firmato — esattamente la divergenza che questo modulo esiste per impedire.
    // Un solo SELECT senza join (le task del cantiere sono già risolte a parte): con la
    // join, il FOR UPDATE bloccherebbe anche righe di tasks e users che non c'entrano.
    const taskDelCantiere = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.companyId, companyId)));
    if (taskDelCantiere.length > 0) {
      await tx
        .select({ id: timeLogs.id })
        .from(timeLogs)
        .where(
          and(
            eq(timeLogs.companyId, companyId),
            inArray(
              timeLogs.taskId,
              taskDelCantiere.map((t) => t.id),
            ),
            eq(timeLogs.date, date),
          ),
        )
        .for('update');
    }

    // Istante unico per entrambe le costruzioni dello snapshot: se ognuna mettesse il
    // proprio `new Date()` in `preparatoIl`, i due hash sarebbero diversi per definizione
    // e il confronto qui sotto scatterebbe sempre.
    const preparatoIl = new Date().toISOString();
    const snapshot = await buildSnapshot(tx, projectId, date, companyId, actingUser, preparatoIl);
    assertPuoPrepararlo(snapshot, actingUser);

    if (snapshot.righe.length === 0) {
      throw new ValidationError(
        `Nessuna ora registrata su questo cantiere per il ${formatDataIsoIt(date)}: non c'è niente da far firmare.`,
      );
    }

    const timeLogIdsCandidati = snapshot.righe.map((riga) => riga.timeLogId);

    // SECONDO lock, sugli id ESATTI dello snapshot appena costruito. Il primo lock qui
    // sopra blocca le righe che in quel momento corrispondevano a (lavori del cantiere,
    // giorno): è un lock su un PREDICATO, e updateTimeLog permette di cambiare `date` e
    // `taskId`: una PATCH concorrente può quindi spostare una riga DENTRO quel giorno
    // dopo che il lock è stato preso, senza che quella riga sia mai stata bloccata.
    // Bloccare per id e ricostruire lo snapshot chiude la finestra: se nel frattempo
    // qualcosa è cambiato, i due hash non coincidono e la creazione viene rifiutata
    // invece di produrre un documento che non corrisponde alle ore del giorno.
    await tx
      .select({ id: timeLogs.id })
      .from(timeLogs)
      .where(and(inArray(timeLogs.id, timeLogIdsCandidati), eq(timeLogs.companyId, companyId)))
      .for('update');

    const snapshotVerificato = await buildSnapshot(tx, projectId, date, companyId, actingUser, preparatoIl);
    if (hashSnapshot(snapshotVerificato) !== hashSnapshot(snapshot)) {
      throw new ConflictError(
        'Le ore di questo giorno sono cambiate mentre il rapportino veniva preparato: riprova.',
      );
    }

    // Ore già legate a un rapportino ancora vincolante (in firma o firmato): riassegnarle
    // in silenzio a una nuova revisione toglierebbe il lucchetto proprio al documento
    // che il cliente ha firmato, che resterebbe "firmato" mentre le sue ore tornano
    // modificabili. Va sbloccato o annullato prima, esplicitamente.
    // Nessun filtro su rapportini.company_id qui, ed è deliberato: le ore sono già
    // ristrette all'azienda (timeLogIds viene da uno snapshot scoped su companyId), e
    // questo è un controllo PROTETTIVO. Aggiungendo il filtro, un eventuale collegamento
    // anomalo verso un'altra azienda smetterebbe di essere contato e la creazione
    // passerebbe: nel dubbio deve bloccare, non lasciar fare.
    const timeLogIds = snapshotVerificato.righe.map((riga) => riga.timeLogId);
    const [{ bloccate }] = await tx
      .select({ bloccate: sql<number>`count(*)::int` })
      .from(timeLogs)
      .innerJoin(rapportini, eq(timeLogs.rapportinoId, rapportini.id))
      .where(and(inArray(timeLogs.id, timeLogIds), inArray(rapportini.status, STATI_BLOCCANTI)));
    if (bloccate > 0) {
      throw new ConflictError(
        'Alcune ore di questo giorno appartengono già a un rapportino in attesa di firma o firmato: ' +
          'annullalo (o chiedi a un amministratore di sbloccarlo) prima di prepararne uno nuovo.',
      );
    }

    const [{ ultimaRevisione }] = await tx
      .select({ ultimaRevisione: sql<number>`coalesce(max(${rapportini.revision}), 0)::int` })
      .from(rapportini)
      .where(and(eq(rapportini.projectId, projectId), eq(rapportini.date, date)));

    // ULTIMO lock della transazione (vedi l'ordine dichiarato in cima): la riga
    // dell'AZIENDA, che serializza il calcolo di MAX(numero)+1 fra due creazioni
    // concorrenti della stessa azienda — stesso idioma di createProject in
    // projects.service.ts, e stessa ragione: un retry ottimistico sotto concorrenza reale
    // falliva circa una richiesta su tre.
    // Sta QUI e non in cima perché è l'unico punto dell'ordine in cui non può fare da
    // anello di un ciclo: da questa istruzione in avanti la transazione esegue soltanto
    // una INSERT su rapportini e una UPDATE su righe di time_logs che ha già bloccato,
    // quindi non attende più nessuno. La correttezza del progressivo è intatta: il lock
    // viene preso PRIMA del MAX e tenuto fino al COMMIT, che è tutto ciò che serve.
    // Effetto accettato (invariato): la creazione si serializza PER AZIENDA e non più per
    // cantiere. La transazione contiene solo letture di database — nessuna chiamata di
    // rete, nessun PDF (alla creazione non viene generato) — quindi resta breve.
    const [azienda] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId))
      .for('update')
      .limit(1);
    if (!azienda) {
      // Irraggiungibile in pratica: buildSnapshot qui sopra ha già letto la riga
      // dell'azienda e lancia lo stesso NotFoundError se manca. Resta come guardia, così
      // il lock non passa in silenzio su zero righe se un domani quella lettura sparisse.
      throw new NotFoundError('Azienda non trovata');
    }

    // Progressivo per AZIENDA, calcolato sotto il lock appena preso: nessun contatore
    // separato da tenere allineato, e un rapportino annullato consuma comunque il proprio
    // numero, perché la sua riga resta in tabella (annullaRapportino cambia solo lo stato)
    // e continua a contare nel MAX — che è esattamente la semantica di un blocco a
    // ricalco, dove la pagina strappata non torna disponibile.
    const [{ ultimoNumero }] = await tx
      .select({ ultimoNumero: sql<number>`coalesce(max(${rapportini.numero}), 0)::int` })
      .from(rapportini)
      .where(eq(rapportini.companyId, companyId));

    const signingToken = generateOpaqueToken(SIGNING_TOKEN_BYTES);
    const expiresAt = new Date(Date.now() + ms(CONFIG.RAPPORTINO_SIGN_EXPIRES_IN));

    let inserito: typeof rapportini.$inferSelect;
    try {
      [inserito] = await tx
        .insert(rapportini)
        .values({
          companyId,
          projectId,
          date,
          revision: (ultimaRevisione ?? 0) + 1,
          numero: (ultimoNumero ?? 0) + 1,
          createdBy: actingUser.id,
          snapshotJson: snapshotVerificato,
          snapshotHash: hashSnapshot(snapshotVerificato),
          totalHours: snapshotVerificato.totali.oreTotali,
          tokenHash: hashOpaqueToken(signingToken),
          expiresAt,
        })
        .returning();
    } catch (err) {
      // Due UNIQUE diversi possono scattare su questa insert, e dirlo storto manda
      // l'utente a cercare un problema che non ha: l'indice parziale
      // (project_id, date) WHERE status='in_firma' è l'ultima difesa contro due
      // rapportini in attesa di firma sullo stesso giorno, mentre
      // (project_id, date, revision) protegge il progressivo delle revisioni. Il primo
      // è un conflitto che l'utente può risolvere (annulla o fai sbloccare); il secondo
      // significa che due creazioni hanno calcolato lo stesso MAX(revision)+1, e la
      // risposta giusta è "riprova", non "ne esiste già uno in attesa di firma".
      if (isUniqueViolation(err)) {
        if (uniqueViolationConstraint(err) === VINCOLO_UNO_IN_FIRMA) {
          throw new ConflictError(
            'Esiste già un rapportino in attesa di firma per questo cantiere e questo giorno.',
          );
        }
        // Terzo UNIQUE possibile su questa insert: il progressivo per azienda. Col lock
        // sulla riga dell'azienda è irraggiungibile — è la stessa "rete di sicurezza"
        // già dichiarata per projectNumber e per revision, non un caso atteso.
        if (uniqueViolationConstraint(err) === VINCOLO_NUMERO) {
          throw new ConflictError(
            'Il numero progressivo è stato assegnato a un altro rapportino nello stesso istante: riprova.',
          );
        }
        throw new ConflictError(
          'Un altro rapportino per questo cantiere e questo giorno è stato creato nello stesso momento: riprova.',
        );
      }
      throw err;
    }

    await tx
      .update(timeLogs)
      .set({ rapportinoId: inserito.id })
      .where(and(inArray(timeLogs.id, timeLogIds), eq(timeLogs.companyId, companyId)));

    // signingToken viaggia solo in questa risposta: in database ne resta unicamente
    // l'hash, quindi non è recuperabile in nessun altro modo. Se l'operaio perde la
    // schermata deve creare un nuovo rapportino.
    return { rapportino: toPublicRapportino(inserito), signingToken, expiresAt };
  });
}

export async function getRapportinoById(
  id: string,
  companyId: string,
  actingUser: AuthenticatedUser,
): Promise<PublicRapportino> {
  const [row] = await db
    .select()
    .from(rapportini)
    .where(and(eq(rapportini.id, id), eq(rapportini.companyId, companyId)))
    .limit(1);
  if (!row) {
    throw new NotFoundError('Rapportino non trovato');
  }
  assertPuoLeggerlo(row, actingUser);
  verificaIntegritaSnapshot(row);
  return toPublicRapportino(row);
}

export interface ListRapportiniFilters {
  projectId?: string;
  date?: string;
  status?: RapportinoStatus;
}

// Il filtro per stato deve selezionare quello che l'utente VEDE, non quello scritto in
// colonna: altrimenti "mostrami gli scaduti" salterebbe proprio le righe rimaste
// 'in_firma' oltre la scadenza (che l'elenco mostra come scadute), e "mostrami quelli in
// attesa di firma" restituirebbe righe etichettate 'scaduto'. Filtro e presentazione
// devono usare la stessa definizione, altrimenti l'elenco contraddice sé stesso.
function condizioneStato(status: RapportinoStatus) {
  const adesso = new Date();
  if (status === 'scaduto') {
    return or(
      eq(rapportini.status, 'scaduto'),
      and(eq(rapportini.status, 'in_firma'), lt(rapportini.expiresAt, adesso)),
    );
  }
  if (status === 'in_firma') {
    return and(eq(rapportini.status, 'in_firma'), gte(rapportini.expiresAt, adesso));
  }
  return eq(rapportini.status, status);
}

export async function listRapportini(
  page: number,
  limit: number,
  companyId: string,
  filters?: ListRapportiniFilters,
): Promise<PaginatedRapportini> {
  const offset = (page - 1) * limit;
  const conditions = [
    eq(rapportini.companyId, companyId),
    ...(filters?.projectId ? [eq(rapportini.projectId, filters.projectId)] : []),
    ...(filters?.date ? [eq(rapportini.date, filters.date)] : []),
    ...(filters?.status ? [condizioneStato(filters.status)] : []),
  ];

  // Colonne elencate una per una, MAI un db.select() nudo come in listTimeLogs/
  // listCorrections: lì le righe sono piccole, qui ogni riga porta con sé lo snapshot
  // completo del giorno (jsonb) e l'immagine della firma in base64 — decine o centinaia
  // di KB per riga, moltiplicati per la pagina intera, per mostrare un elenco che di
  // quei due campi non usa nulla. Chi aggiunge una colonna qui la aggiunga a mano.
  const [rows, [{ count }]] = await Promise.all([
    db
      .select({
        id: rapportini.id,
        projectId: rapportini.projectId,
        date: rapportini.date,
        numero: rapportini.numero,
        revision: rapportini.revision,
        status: rapportini.status,
        totalHours: rapportini.totalHours,
        createdBy: rapportini.createdBy,
        createdAt: rapportini.createdAt,
        signerName: rapportini.signerName,
        signedAt: rapportini.signedAt,
        expiresAt: rapportini.expiresAt,
        emailSentAt: rapportini.emailSentAt,
        unlockedAt: rapportini.unlockedAt,
      })
      .from(rapportini)
      .where(and(...conditions))
      .orderBy(desc(rapportini.date), desc(rapportini.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(rapportini)
      .where(and(...conditions)),
  ]);

  // Stesso stato presentato del dettaglio: un elenco che dice "in attesa di firma" e un
  // dettaglio che sulla stessa riga dice "scaduto" sarebbero due verità diverse sullo
  // stesso documento, e chi legge non ha modo di sapere quale delle due contava.
  const righe: RapportinoListItem[] = rows.map((row) => ({ ...row, status: statoPresentato(row) }));

  return { rapportini: righe, total: count, page, limit };
}

function assertPuoGestirlo(row: typeof rapportini.$inferSelect, actingUser: AuthenticatedUser): void {
  if (isManager(actingUser.role)) return;
  if (row.createdBy !== actingUser.id) {
    throw new ForbiddenError('Puoi gestire solo i rapportini che hai preparato tu');
  }
}

export async function annullaRapportino(
  id: string,
  reason: string | null,
  companyId: string,
  actingUser: AuthenticatedUser,
): Promise<PublicRapportino> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(rapportini)
      .where(and(eq(rapportini.id, id), eq(rapportini.companyId, companyId)))
      .for('update')
      .limit(1);
    if (!row) {
      throw new NotFoundError('Rapportino non trovato');
    }
    assertPuoGestirlo(row, actingUser);
    if (row.status !== 'in_firma') {
      throw new ConflictError(
        `Si può annullare solo un rapportino in attesa di firma (questo è "${row.status}"). ` +
          'Un rapportino già firmato dal cliente non si annulla: si sblocca, e resta agli atti.',
      );
    }

    const [aggiornato] = await tx
      .update(rapportini)
      .set({ status: 'annullato', cancelReason: reason })
      .where(eq(rapportini.id, row.id))
      .returning();
    await liberaOre(tx, [row.id], companyId);

    // Traccia di audit come per lo sblocco, e per un motivo preciso: creare un rapportino
    // blocca le ore dell'intera giornata di TUTTI gli operai di quel cantiere (è il
    // funzionamento voluto — il cliente firma una volta sola per la squadra), quindi
    // creare e annullare in ciclo è un modo per tenere quelle ore inutilizzabili senza
    // lasciare alcuna traccia. L'audit non impedisce l'abuso, ma lo rende ricostruibile.
    // Azione 'UPDATE' e non 'DELETE': la riga resta, cambia stato e libera le sue ore —
    // `annullato: true` nei changes dice quale aggiornamento è stato, senza ambiguità.
    // `tx` esplicito: la traccia deve stare nella STESSA transazione dell'annullamento
    // (o entrambi o nessuno) e sulla STESSA connessione, per non aprire un'attesa
    // circolare invisibile a Postgres — il perché completo è in auditLog.service.ts.
    await recordAudit(
      {
        companyId,
        userId: actingUser.id,
        action: 'UPDATE',
        entityType: 'rapportino',
        entityId: row.id,
        changes: { annullato: true, motivo: reason, oreLiberate: true },
      },
      tx,
    );

    return toPublicRapportino(aggiornato);
  });
}

export async function sbloccaRapportino(
  id: string,
  reason: string,
  companyId: string,
  actingUser: AuthenticatedUser,
): Promise<PublicRapportino> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(rapportini)
      .where(and(eq(rapportini.id, id), eq(rapportini.companyId, companyId)))
      .for('update')
      .limit(1);
    if (!row) {
      throw new NotFoundError('Rapportino non trovato');
    }
    // Ridondante finché la rotta monta requireRole('admin'), e messo qui apposta: se un
    // domani quel middleware venisse allentato o la funzione richiamata da un altro punto,
    // la garanzia sparirebbe in silenzio, senza che nulla in questo file lo segnali. Per
    // un admin/PM è comunque un passaggio a vuoto (isManager esce subito).
    assertPuoGestirlo(row, actingUser);
    if (row.status !== 'firmato') {
      throw new ConflictError(`Si può sbloccare solo un rapportino firmato (questo è "${row.status}").`);
    }

    // Lo sblocco tocca SOLO il lucchetto sulle ore. Stato e snapshot restano intatti per
    // sempre: quello che il cliente ha visto e firmato non si riscrive, nemmeno da
    // amministratore. Le ore corrette dopo lo sblocco andranno in un nuovo rapportino.
    const [aggiornato] = await tx
      .update(rapportini)
      .set({ unlockedAt: new Date(), unlockedBy: actingUser.id, unlockReason: reason })
      .where(eq(rapportini.id, row.id))
      .returning();
    await liberaOre(tx, [row.id], companyId);

    // `tx` esplicito, stessa ragione dell'annullamento qui sopra.
    await recordAudit(
      {
        companyId,
        userId: actingUser.id,
        action: 'UPDATE',
        entityType: 'rapportino',
        entityId: row.id,
        changes: { sbloccato: true, motivo: reason, oreLiberate: true },
      },
      tx,
    );

    return toPublicRapportino(aggiornato);
  });
}

function firmaPerPdf(row: typeof rapportini.$inferSelect): FirmaPdf {
  return {
    firmatarioNome: row.signerName,
    firmatarioEmail: row.signerEmail,
    firmaPngBase64: row.signaturePng,
    firmatoIl: row.signedAt,
  };
}

function nomeFilePdf(snapshot: RapportinoSnapshot, revision: number): string {
  const cantiere = (snapshot.cantiere.code ?? `cantiere-${snapshot.cantiere.projectNumber}`)
    .replace(/[^a-zA-Z0-9-_]/g, '-');
  return `rapportino-${cantiere}-${snapshot.date}-rev${revision}.pdf`;
}

export interface PdfRapportino {
  filename: string;
  contenuto: Buffer;
}

/**
 * Genera il PDF trasformando un fallimento in un errore che NOMINA il rapportino.
 *
 * I due punti che la usano (rigenerazione da `GET /:id/pdf` e rinvio dell'email) lavorano
 * su una firma già validata al momento della sottoscrizione, quindi non dovrebbero poter
 * fallire: la firma che non si riusciva a disegnare viene ora respinta prima del commit
 * (vedi signRapportino). "Non dovrebbe poter fallire" non è però una garanzia, e senza
 * questo involucro un'incoerenza arrivata da chissà dove diventerebbe un 500 con uno
 * stack trace di pdfkit che non dice di quale documento si stia parlando. Non nasconde
 * l'errore: lo rilancia con la causa allegata, dopo averlo scritto nei log.
 */
async function generaPdfDifensivo(
  row: typeof rapportini.$inferSelect,
  snapshot: RapportinoSnapshot,
): Promise<Buffer> {
  try {
    // La firma salvata viene ricontrollata PRIMA di darla a pdfkit, e non è una ripetizione
    // inutile della validazione fatta al momento della firma: quella protegge solo ciò che
    // entra da oggi in poi. Una riga scritta prima di questa correzione può contenere un
    // PNG con dati compressi illeggibili, e png-js lancia l'errore dentro la callback
    // asincrona di zlib.inflate — un uncaughtException che nessun try/catch qui attorno
    // può prendere e che farebbe TERMINARE IL PROCESSO a ogni richiesta del PDF (vedi
    // firmaPng.ts). Il controllo è sincrono: se fallisce, questo catch lo traduce in un
    // errore che nomina il rapportino, cioè una richiesta fallita invece del backend giù.
    if (row.signaturePng) assertFirmaPngDisegnabile(row.signaturePng);
    // Il numero viaggia a parte dallo snapshot perché sta in colonna: viene assegnato
    // all'INSERT, mentre lo snapshot è costruito prima (l'anteprima ne produce uno per un
    // rapportino che ancora non esiste). Stesso trattamento già riservato a `revision`.
    return await buildRapportinoPdf(snapshot, firmaPerPdf(row), { numero: row.numero });
  } catch (err) {
    console.error(`[RAPPORTINI] Generazione del PDF fallita per il rapportino ${row.id}:`, err);
    throw new Error(`Impossibile generare il PDF del rapportino ${row.id}`, { cause: err });
  }
}

// Il PDF viene RIGENERATO a ogni richiesta dallo snapshot: non è mai salvato su disco né
// messo in cache. Il disco di Render è effimero (si azzera a ogni deploy) e una copia in
// cache potrebbe sopravvivere a uno sblocco o a una correzione, diventando un documento
// che non corrisponde più a nessuno stato reale.
export async function generaPdfRapportino(
  id: string,
  companyId: string,
  actingUser: AuthenticatedUser,
): Promise<PdfRapportino> {
  const [row] = await db
    .select()
    .from(rapportini)
    .where(and(eq(rapportini.id, id), eq(rapportini.companyId, companyId)))
    .limit(1);
  if (!row) {
    throw new NotFoundError('Rapportino non trovato');
  }
  assertPuoLeggerlo(row, actingUser);
  verificaIntegritaSnapshot(row);

  const snapshot = leggiSnapshot(row);
  return {
    filename: nomeFilePdf(snapshot, row.revision),
    contenuto: await generaPdfDifensivo(row, snapshot),
  };
}

// L'immagine della firma NON compare MAI nel corpo HTML dell'email (niente
// <img src="data:image/png;base64,...">): quasi tutti i client di posta bloccano o
// scartano le immagini inline in data-URI, e il risultato sarebbe un'email che sembra
// mostrare una firma assente. La firma vive solo dentro il PDF allegato, dove è parte
// del documento. Non è una limitazione da "sistemare" aggiungendo l'immagine qui.
//
// OGNI valore interpolato passa da escapeHtml. Il caso che lo impone è `firmatarioNome`:
// arriva dall'endpoint PUBBLICO di firma, dove l'unico controllo è la lunghezza, quindi
// può contenere marcatori HTML scelti da chiunque possieda il link — e questa email
// finisce anche all'azienda in copia nascosta. Anche i campi "interni" (nome del
// cantiere, dell'azienda) sono comunque testo scritto da persone: passano di qui perché
// un'escape applicata solo dove sembra servire smette di essere applicata il giorno in
// cui cambia la provenienza del dato, e nessuno se ne accorge.
function emailRapportinoHtml(snapshot: RapportinoSnapshot, firmatarioNome: string): string {
  const etichettaCantiere = snapshot.cantiere.code ?? `Cantiere #${snapshot.cantiere.projectNumber}`;
  return (
    `<p>Gentile ${escapeHtml(firmatarioNome)},</p>` +
    `<p>in allegato il rapportino dei lavori del <strong>${formatDataIsoIt(snapshot.date)}</strong> ` +
    `per il cantiere <strong>${escapeHtml(etichettaCantiere)} — ${escapeHtml(snapshot.cantiere.nome)}</strong>, ` +
    `da lei sottoscritto in cantiere.</p>` +
    // formatOreIt e non il valore grezzo dello snapshot: là le ore stanno come le
    // restituisce Postgres ("7.50"), mentre il PDF allegato e il foglio che il cliente ha
    // firmato a schermo scrivono entrambi "7,5". Questa email è l'unica delle tre rese che
    // al cliente resta in casella: vederci un numero scritto in un terzo modo lo mette nella
    // posizione di dover verificare che siano lo stesso numero.
    `<p>Ore totali riconosciute: <strong>${escapeHtml(formatOreIt(snapshot.totali.oreTotali))}</strong>.</p>` +
    `<p>Il documento attesta esclusivamente le quantità (ore lavorate e materiali impiegati): ` +
    `non contiene prezzi né importi.</p>` +
    `<p>${escapeHtml(snapshot.azienda.nome)}</p>`
  );
}

// Riceve il PDF GIÀ costruito invece di generarselo. Alla firma è il presupposto della
// correzione più importante di questo modulo: il PDF viene prodotto prima del commit, e
// se non si riesce a produrlo la firma non viene nemmeno registrata (vedi
// signRapportino). Rigenerarlo qui vanificherebbe quella prova, riportando un fallimento
// di generazione dopo che il token è ormai consumato.
async function inviaRapportinoFirmato(
  row: typeof rapportini.$inferSelect,
  destinatario: string,
  snapshot: RapportinoSnapshot,
  pdf: Buffer,
): Promise<{ inviata: boolean; errore?: string }> {
  const esito = await sendEmail({
    to: destinatario,
    // In copia nascosta l'azienda stessa: è l'unico archivio del documento firmato che
    // sopravvive fuori da questo database (piano free, disco effimero, nessun backup
    // automatico — vedi render.yaml). Assente companies.email, resta solo il database.
    // L'indirizzo viene dallo snapshot e non dalla tabella companies: è quello valido
    // quando il documento è nato. Compromesso consapevole — un rinvio molto successivo
    // a un cambio di email aziendale finirebbe al vecchio indirizzo.
    ...(snapshot.azienda.email ? { bcc: snapshot.azienda.email } : {}),
    subject: `Rapportino del ${formatDataIsoIt(snapshot.date)} — ${snapshot.cantiere.nome}`,
    html: emailRapportinoHtml(snapshot, row.signerName ?? 'Cliente'),
    attachments: [{ filename: nomeFilePdf(snapshot, row.revision), content: pdf.toString('base64') }],
  });

  return { inviata: esito.sent, errore: esito.error };
}

// La riga del rapportino registra SEMPRE l'esito reale dell'invio: `email_sent_at`
// valorizzato solo se l'email è partita davvero. Un "inviata" scritto per ottimismo
// renderebbe impossibile accorgersi che il cliente non ha mai ricevuto il documento.
//
// In caso di fallimento `email_sent_at` viene lasciato com'è, NON azzerato: se un invio
// precedente era riuscito, quel documento È stato consegnato una volta, e cancellarne la
// data perché un rinvio successivo è fallito riscriverebbe un fatto già accaduto.
async function registraEsitoEmail(rapportinoId: string, esito: { inviata: boolean; errore?: string }): Promise<void> {
  await db
    .update(rapportini)
    .set(
      esito.inviata
        ? { emailSentAt: new Date(), emailLastError: null }
        : { emailLastError: esito.errore ?? 'Errore di invio non specificato' },
    )
    .where(eq(rapportini.id, rapportinoId));
}


/**
 * Firma pubblica: l'UNICO punto non autenticato di questo modulo. Il cliente non è un
 * utente del sistema, firma di persona sul dispositivo dell'operaio tramite un token
 * monouso a scadenza breve.
 */
export async function signRapportino(
  token: string,
  input: FirmaInput,
  contesto: FirmaContesto,
): Promise<FirmaEsito> {
  const firmaPngPulita = validaFirmaPng(input.firmaPng);
  const tokenHash = hashOpaqueToken(token);

  const { firmato, pdf, snapshot } = await db.transaction(async (tx) => {
    // FOR UPDATE: due invii simultanei dello stesso link (doppio tap sul tablet, o due
    // schede aperte) vengono serializzati da Postgres invece di correre entrambi sulla
    // riga "non ancora firmata" — il secondo, quando riprende, la trova già 'firmato' e
    // viene rifiutato. Stesso idioma e stessa ragione di resetPassword (auth.service.ts).
    const [row] = await tx
      .select()
      .from(rapportini)
      .where(eq(rapportini.tokenHash, tokenHash))
      .for('update')
      .limit(1);

    // Un solo messaggio per OGNI motivo di rifiuto (token inesistente, scaduto, già
    // firmato, annullato): un errore diverso per ciascun caso direbbe a chi prova token
    // a caso quando ne ha indovinato uno "quasi giusto". Stessa regola già applicata al
    // reset password (vedi i commenti in auth.routes.ts).
    if (!row || row.status !== 'in_firma' || row.expiresAt < new Date()) {
      throw new UnauthorizedError('Link non valido o scaduto');
    }
    // Se il chiamante dichiara anche l'id (client aggiornati), deve combaciare con quello
    // risolto dal token: senza questo controllo, chi conosce due signingToken propri
    // potrebbe far firmare al cliente l'anteprima di un rapportino (mostrata dall'id
    // nell'URL) mentre in realtà si consuma il token di un altro — stesso messaggio
    // generico degli altri rifiuti, per non rivelare quale dei due controlli è fallito.
    if (input.rapportinoId && input.rapportinoId !== row.id) {
      throw new UnauthorizedError('Link non valido o scaduto');
    }

    const snapshotFirmato = leggiSnapshot(row);
    // Stesso istante nel PDF e nella colonna signed_at: se fossero due `new Date()`
    // distinti, il documento consegnato al cliente direbbe un orario di firma diverso da
    // quello registrato nel database.
    const firmatoIl = new Date();

    // IL PDF SI COSTRUISCE PRIMA DELLA SCRITTURA, e questo ordine è il punto della
    // funzione, non un dettaglio di stile. La firma è un PNG che arriva da fuori:
    // superata la validazione di forma può comunque avere un corpo che pdfkit non
    // riesce a disegnare, e finché la generazione avveniva DOPO il commit il risultato
    // era un vicolo cieco — riga già 'firmato', token consumato, cliente che non può
    // ritentare, ore bloccate, e ogni successiva richiesta del PDF o rinvio dell'email
    // destinata allo stesso errore per sempre (`annulla` rifiuta perché lo stato non è
    // più 'in_firma', `sblocca` libera le ore ma non ripara la firma illeggibile).
    // Provandolo prima, un fallimento costa una richiesta rifiutata mentre il cliente è
    // ancora lì col dito sullo schermo: la transazione va in rollback, il token resta
    // valido e basta rifirmare.
    let pdfFirmato: Buffer;
    try {
      pdfFirmato = await buildRapportinoPdf(
        snapshotFirmato,
        {
          firmatarioNome: input.firmatarioNome,
          firmatarioEmail: input.firmatarioEmail,
          firmaPngBase64: firmaPngPulita,
          firmatoIl,
        },
        { numero: row.numero },
      );
    } catch (err) {
      console.error(`[RAPPORTINI] Firma rifiutata: PDF non generabile per il rapportino ${row.id}:`, err);
      throw new ValidationError('Impossibile elaborare la firma: riprova');
    }

    const [aggiornato] = await tx
      .update(rapportini)
      .set({
        status: 'firmato',
        signerName: input.firmatarioNome,
        signerEmail: input.firmatarioEmail,
        signaturePng: firmaPngPulita,
        signedAt: firmatoIl,
        signedIp: contesto.ip,
        signedUserAgent: contesto.userAgent,
      })
      .where(eq(rapportini.id, row.id))
      .returning();
    return { firmato: aggiornato, pdf: pdfFirmato, snapshot: snapshotFirmato };
  });

  // Email DOPO il commit, mai dentro la transazione: un invio lento terrebbe aperto il
  // lock sulla riga, e un invio fallito farebbe rollback della firma appena acquisita.
  // La firma è il dato che non si può ricostruire (il cliente è andato via): se l'email
  // non parte si registra l'errore e si dice la verità a chi ha firmato, ma la firma
  // resta acquisita. Il PDF allegato è quello già costruito dentro la transazione, non
  // uno rigenerato: è la stessa copia di cui si è dimostrata la producibilità prima di
  // consumare il token.
  const esito = await inviaRapportinoFirmato(firmato, input.firmatarioEmail, snapshot, pdf);
  await registraEsitoEmail(firmato.id, esito);

  return { firmato: true, emailInviata: esito.inviata };
}

export async function reinviaEmailRapportino(
  id: string,
  email: string | undefined,
  companyId: string,
  actingUser: AuthenticatedUser,
): Promise<{ emailInviata: boolean; destinatario: string }> {
  const [row] = await db
    .select()
    .from(rapportini)
    .where(and(eq(rapportini.id, id), eq(rapportini.companyId, companyId)))
    .limit(1);
  if (!row) {
    throw new NotFoundError('Rapportino non trovato');
  }
  assertPuoGestirlo(row, actingUser);
  // Solo da 'firmato': questo endpoint rispedisce un documento già sottoscritto, non
  // riapre la firma. Il token di firma non viene rigenerato né toccato.
  if (row.status !== 'firmato') {
    throw new ConflictError(`Si può rinviare via email solo un rapportino firmato (questo è "${row.status}").`);
  }

  // Scegliere il destinatario è un privilegio di gestione, non un dettaglio dell'invio:
  // `assertPuoGestirlo` lascia passare anche l'operaio che ha preparato il rapportino, e
  // senza questo controllo quell'operaio potrebbe farsi recapitare il PDF firmato — con
  // dentro le ore di tutti i colleghi della giornata e i dati del cliente — a un
  // indirizzo qualunque, scelto da lui. Per chi non è admin/PM la destinazione resta
  // quella che il cliente ha indicato firmando; indicarla esplicitamente uguale a quella
  // è consentito (non sposta il documento da nessuna parte) per non far fallire un
  // frontend che precompila il campo.
  if (email && !isManager(actingUser.role) && email !== row.signerEmail) {
    throw new ForbiddenError(
      'Solo un amministratore o un project manager può inviare il rapportino a un indirizzo ' +
        'diverso da quello del firmatario',
    );
  }

  const destinatario = email ?? row.signerEmail;
  if (!destinatario) {
    throw new ValidationError('Nessun indirizzo email a cui inviare: indicane uno nella richiesta');
  }

  const snapshot = leggiSnapshot(row);
  const pdf = await generaPdfDifensivo(row, snapshot);
  const esito = await inviaRapportinoFirmato(row, destinatario, snapshot, pdf);
  await registraEsitoEmail(row.id, esito);

  // Rispedire è l'unico modo per far uscire dal sistema un documento firmato: chi l'ha
  // chiesto e verso dove devono restare scritti. Azione 'EXPORT' e non 'UPDATE' perché è
  // esattamente questo che succede — il rapportino esce dall'applicazione verso un
  // indirizzo esterno; la riga non cambia. Fuori dal percorso critico e in try/catch: un
  // errore qui non deve trasformare un'email partita in una richiesta fallita.
  try {
    await recordAudit({
      companyId,
      userId: actingUser.id,
      action: 'EXPORT',
      entityType: 'rapportino',
      entityId: row.id,
      changes: { rinviata: true, destinatario, inviata: esito.inviata },
    });
  } catch (err) {
    console.error(`[RAPPORTINI] Voce di audit del rinvio non registrata per il rapportino ${row.id}:`, err);
  }

  return { emailInviata: esito.inviata, destinatario };
}

/**
 * Lucchetto lato ore: chiamata da updateTimeLog/deleteTimeLog per rifiutare la modifica
 * di ore che appartengono a un rapportino ancora vincolante. Vive qui e non in
 * timeLogs.service.ts perché è una regola del rapportino, non delle ore.
 */
export async function assertOreNonBloccateDaRapportino(
  queryable: Queryable,
  rapportinoId: string | null,
  companyId: string,
): Promise<void> {
  if (!rapportinoId) return;

  const [row] = await queryable
    .select({ status: rapportini.status, signedAt: rapportini.signedAt, expiresAt: rapportini.expiresAt })
    .from(rapportini)
    .where(and(eq(rapportini.id, rapportinoId), eq(rapportini.companyId, companyId)))
    .limit(1);
  if (!row) {
    // La foreign key garantisce che il rapportino esista finché rapportino_id non è
    // NULL: se manca, qualcosa ha aggirato il vincolo e il caso va reso visibile invece
    // di essere interpretato come "nessun blocco" (che sbloccherebbe ore firmate).
    throw new Error(`rapportino_id ${rapportinoId} non corrisponde a nessun rapportino dell'azienda ${companyId}`);
  }

  if (row.status === 'in_firma') {
    // Il passaggio a 'scaduto' è pigro (avviene solo se qualcuno riprova a creare il
    // rapportino di quel cantiere/giorno), quindi qui una riga può essere ancora scritta
    // 'in_firma' pur avendo un link ormai inutilizzabile. Dire "in attesa di firma" in
    // quel caso manderebbe l'utente ad aspettare un cliente che non potrà mai firmare:
    // il blocco resta identico — le ore sono ancora agganciate al rapportino — ma il
    // messaggio deve indicare l'azione che sblocca davvero la situazione, cioè annullarlo.
    if (row.expiresAt < new Date()) {
      throw new ConflictError(
        'Queste ore appartengono a un rapportino scaduto senza firma: annullalo prima di modificare queste ore.',
      );
    }
    throw new ConflictError(
      'Queste ore fanno parte di un rapportino in attesa di firma del cliente: annullalo prima di modificare queste ore.',
    );
  }
  if (row.status === 'firmato') {
    const quando = row.signedAt ? formatDataIt(row.signedAt) : 'data non registrata';
    throw new ConflictError(
      `Queste ore sono state firmate dal cliente il ${quando}: serve uno sblocco da parte di un amministratore.`,
    );
  }
}
