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
import { buildRapportinoPdf, type FirmaPdf } from './rapportino.pdf';
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
const PREFISSO_DATA_PNG = 'data:image/png;base64,';
const FIRMA_MAX_BYTES = 500 * 1024;
// Il base64 usa 4 caratteri per ogni 3 byte: la stringa in arrivo è circa 4/3 dei byte
// che rappresenta. Serve a rifiutare un payload sovradimensionato PRIMA di decodificarlo
// (vedi validaFirmaPng), non a misurarlo con precisione — il controllo esatto sui byte
// decodificati resta comunque, subito dopo.
const FIRMA_MAX_BASE64_CHARS = Math.ceil((FIRMA_MAX_BYTES * 4) / 3) + 4;
// Gli 8 byte iniziali obbligatori di ogni file PNG (RFC 2083).
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Struttura dell'header PNG: dopo i magic byte, il primo chunk DEVE essere IHDR
// (RFC 2083 §11.2.2). Offset assoluti dall'inizio del file:
//   8..11  lunghezza del chunk    12..15 tipo del chunk ("IHDR")
//   16..19 larghezza (big-endian) 20..23 altezza (big-endian)
const PNG_OFFSET_TIPO_CHUNK = 12;
const PNG_OFFSET_LARGHEZZA = 16;
const PNG_OFFSET_ALTEZZA = 20;
const PNG_HEADER_MIN_BYTES = 24;
// Tetto sulle dimensioni DICHIARATE nell'IHDR. La firma di un cliente è un tratto su un
// canvas da tablet: poche centinaia di pixel per lato. Questi limiti sono già larghissimi
// per quell'uso, e servono a tutt'altro — un PNG può dichiarare dimensioni enormi restando
// minuscolo da compresso (una "bomba di decompressione"), e chi lo decodifica alloca
// larghezza × altezza × 4 byte PRIMA di accorgersi che è assurdo. Su Render il backend gira
// con 512MB (plan free, vedi render.yaml): un'allocazione simile non lancia un'eccezione
// che si possa intercettare con un try/catch, fa terminare il processo dal sistema mentre
// un cliente sta firmando. Per questo il controllo sta PRIMA di qualunque decodifica.
const FIRMA_MAX_LARGHEZZA_PX = 2000;
const FIRMA_MAX_ALTEZZA_PX = 1000;
// Stati in cui il rapportino tiene bloccate le proprie ore.
const STATI_BLOCCANTI: RapportinoStatus[] = ['in_firma', 'firmato'];
// Nome dell'indice UNIQUE PARZIALE creato a mano in drizzle/0012_rapportino_partial_unique.sql.
// Serve a distinguerlo dall'ALTRO vincolo UNIQUE della stessa tabella (project+date+revision):
// un 23505 dice "duplicato", non QUALE duplicato, e attribuire il messaggio sbagliato
// manderebbe l'utente a cercare un rapportino in attesa di firma che non esiste.
const VINCOLO_UNO_IN_FIRMA = 'rapportini_project_id_date_in_firma_unique';

function formatDataIt(value: Date): string {
  const due = (n: number) => String(n).padStart(2, '0');
  return `${due(value.getDate())}/${due(value.getMonth() + 1)}/${value.getFullYear()}`;
}

function formatDataIsoIt(isoDate: string): string {
  const [anno, mese, giorno] = isoDate.split('-');
  return giorno && mese && anno ? `${giorno}/${mese}/${anno}` : isoDate;
}

// Quantità materiali: numeric(12,3) arriva da Postgres come "6.000". Sul documento che
// firma il cliente si scrive "6", non "6.000" — stessa normalizzazione per le righe e
// per i totali, così due numeri uguali non appaiono mai scritti in due modi diversi.
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
      quantity: timeLogMaterials.quantity,
      unit: timeLogMaterials.unit,
    })
    .from(timeLogMaterials)
    .where(and(inArray(timeLogMaterials.timeLogId, timeLogIds), eq(timeLogMaterials.companyId, companyId)))
    .orderBy(asc(timeLogMaterials.name));

  for (const riga of righe) {
    const lista = perTimeLog.get(riga.timeLogId) ?? [];
    lista.push({ nome: riga.name, quantita: formatQuantita(Number(riga.quantity)), unita: riga.unit });
    perTimeLog.set(riga.timeLogId, lista);
  }
  return perTimeLog;
}

function calcolaTotali(righe: SnapshotRiga[]): RapportinoSnapshot['totali'] {
  let oreTotali = 0;
  const perTipo: Record<string, number> = {};
  const materiali = new Map<string, { nome: string; unita: string; quantita: number }>();

  for (const riga of righe) {
    const ore = Number(riga.ore);
    oreTotali += ore;
    perTipo[riga.tipo] = (perTipo[riga.tipo] ?? 0) + ore;
    for (const materiale of riga.materiali) {
      // Chiave nome+unità e non solo nome: 3 "m" e 3 "pz" dello stesso articolo non
      // sono 6 di niente, sommarli produrrebbe un totale privo di significato.
      const chiave = JSON.stringify([materiale.nome, materiale.unita]);
      const corrente = materiali.get(chiave) ?? { nome: materiale.nome, unita: materiale.unita, quantita: 0 };
      corrente.quantita += Number(materiale.quantita);
      materiali.set(chiave, corrente);
    }
  }

  return {
    oreTotali: oreTotali.toFixed(2),
    perTipo: Object.fromEntries(Object.entries(perTipo).map(([tipo, ore]) => [tipo, ore.toFixed(2)])),
    materiali: [...materiali.values()]
      .sort((a, b) => a.nome.localeCompare(b.nome))
      .map((m) => ({ nome: m.nome, quantita: formatQuantita(m.quantita), unita: m.unita })),
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
    .orderBy(asc(users.name), asc(timeLogs.createdAt));

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
    await recordAudit({
      companyId,
      userId: actingUser.id,
      action: 'UPDATE',
      entityType: 'rapportino',
      entityId: row.id,
      changes: { annullato: true, motivo: reason, oreLiberate: true },
    });

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

    await recordAudit({
      companyId,
      userId: actingUser.id,
      action: 'UPDATE',
      entityType: 'rapportino',
      entityId: row.id,
      changes: { sbloccato: true, motivo: reason, oreLiberate: true },
    });

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
    return await buildRapportinoPdf(snapshot, firmaPerPdf(row));
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
    `<p>Ore totali riconosciute: <strong>${escapeHtml(snapshot.totali.oreTotali)}</strong>.</p>` +
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

function validaFirmaPng(valore: string): string {
  if (!valore.startsWith(PREFISSO_DATA_PNG)) {
    throw new ValidationError(`La firma deve essere un'immagine PNG nel formato "${PREFISSO_DATA_PNG}..."`);
  }
  const base64 = valore.slice(PREFISSO_DATA_PNG.length);
  // Buffer.from(..., 'base64') non fallisce mai su input sporco: scarta i caratteri che
  // non riconosce e restituisce comunque qualcosa. Il controllo dell'alfabeto va fatto
  // prima, altrimenti "non è base64" diventerebbe indistinguibile da "è un PNG strano".
  if (base64.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new ValidationError('La firma non è codificata correttamente in base64');
  }
  // Tetto misurato sulla STRINGA, prima di decodificarla: Buffer.from alloca l'intero
  // contenuto decodificato: controllare la dimensione dopo significherebbe pagare
  // l'allocazione per intero proprio per gli input che si vogliono rifiutare, cioè
  // esattamente quelli che un attaccante ha interesse a spedire grandi e in serie.
  if (base64.length > FIRMA_MAX_BASE64_CHARS) {
    throw new ValidationError(
      `La firma supera la dimensione massima consentita (${Math.round(FIRMA_MAX_BYTES / 1024)} KB)`,
    );
  }

  const bytes = Buffer.from(base64, 'base64');
  // Controllo dei byte magici, non solo del prefisso dichiarato: il prefisso lo scrive
  // il client e può dichiarare qualsiasi cosa. Senza questo, l'endpoint pubblico
  // diventerebbe un modo per depositare contenuto arbitrario nel database e farselo
  // restituire da un altro endpoint travestito da immagine.
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new ValidationError('Il contenuto della firma non è un file PNG valido');
  }
  if (bytes.length > FIRMA_MAX_BYTES) {
    throw new ValidationError(
      `La firma supera la dimensione massima consentita (${Math.round(FIRMA_MAX_BYTES / 1024)} KB)`,
    );
  }

  // I magic byte dicono soltanto "comincia come un PNG": sono 8 byte che chiunque può
  // anteporre a qualunque cosa. Qui si legge l'IHDR, il primo chunk obbligatorio, e si
  // controlla che le dimensioni DICHIARATE siano plausibili per una firma tracciata a
  // dito su un tablet, PRIMA che qualcuno provi a decodificare l'immagine. È il punto
  // in cui si ferma una "bomba di decompressione": pochi KB compressi che dichiarano
  // decine di migliaia di pixel per lato e che, decodificati, chiedono al processo più
  // memoria di quanta ne abbia (512MB su Render). Quella allocazione non si intercetta
  // con un try/catch — il processo viene terminato dal sistema, e con lui ogni altra
  // richiesta in corso. Per questo il limite viene prima, e non ci si affida al fatto
  // che poco più sotto la generazione del PDF sia comunque protetta.
  if (bytes.length < PNG_HEADER_MIN_BYTES || bytes.toString('ascii', PNG_OFFSET_TIPO_CHUNK, PNG_OFFSET_LARGHEZZA) !== 'IHDR') {
    throw new ValidationError("Il contenuto della firma non è un file PNG valido (intestazione IHDR assente)");
  }
  const larghezza = bytes.readUInt32BE(PNG_OFFSET_LARGHEZZA);
  const altezza = bytes.readUInt32BE(PNG_OFFSET_ALTEZZA);
  // Zero non è una dimensione ammessa da RFC 2083 e manderebbe in errore il decodificatore.
  if (larghezza === 0 || altezza === 0) {
    throw new ValidationError('Il contenuto della firma non è un file PNG valido (dimensioni nulle)');
  }
  if (larghezza > FIRMA_MAX_LARGHEZZA_PX || altezza > FIRMA_MAX_ALTEZZA_PX) {
    throw new ValidationError(
      `La firma dichiara dimensioni non plausibili (${larghezza}×${altezza} pixel): ` +
        `il massimo consentito è ${FIRMA_MAX_LARGHEZZA_PX}×${FIRMA_MAX_ALTEZZA_PX}`,
    );
  }
  return base64;
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
      pdfFirmato = await buildRapportinoPdf(snapshotFirmato, {
        firmatarioNome: input.firmatarioNome,
        firmatarioEmail: input.firmatarioEmail,
        firmaPngBase64: firmaPngPulita,
        firmatoIl,
      });
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
