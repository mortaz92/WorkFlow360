import zlib from 'node:zlib';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { and, asc, eq, sql } from 'drizzle-orm';

// L'invio email è sostituito da un doppio, e non per comodità: le asserzioni su
// `emailInviata === false` altrimenti dipenderebbero dall'ASSENZA di RESEND_API_KEY
// nell'ambiente di chi esegue i test. Su una macchina dove quella chiave è configurata,
// gli stessi test manderebbero email vere a indirizzi @test.local (e fallirebbero).
// Un test non deve mai cambiare esito in base a una variabile d'ambiente né toccare la
// rete. Il doppio permette anche di ispezionare l'HTML prodotto, che è l'unico modo per
// verificare davvero l'escape dei valori interpolati.
vi.mock('../../core/mail', () => ({
  sendEmail: vi.fn(),
}));

import { createApp } from '../../app';
import { db } from '../../core/db';
import { auditLog, companies, projects, rapportini, tasks, timeLogMaterials, timeLogs, users } from '../../core/db/schema';
import { isUniqueViolation, uniqueViolationConstraint } from '../../core/db/isUniqueViolation';
import { sendEmail } from '../../core/mail';
import { signAccessToken } from '../auth/auth.service';
import { hashSnapshot } from './rapportini.service';
import type { RapportinoSnapshot } from './rapportini.types';

const app = createApp();
const BCRYPT_TEST_COST = 4;
const sendEmailMock = vi.mocked(sendEmail);

// PNG 1x1 reale: i byte magici sono quelli veri, quindi supera la validazione lato
// server esattamente come una firma tracciata su un tablet — nessun mock.
const FIRMA_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Chunk IHDR sintatticamente valido: è quello che validaFirmaPng legge per conoscere le
// dimensioni dichiarate. Serve a costruire PNG che superano la validazione di forma pur
// essendo indecifrabili (corpo assente), e PNG che dichiarano dimensioni assurde.
function chunkIhdr(larghezza: number, altezza: number): Buffer {
  const dati = Buffer.alloc(13);
  dati.writeUInt32BE(larghezza, 0);
  dati.writeUInt32BE(altezza, 4);
  dati[8] = 8; // bit depth
  dati[9] = 6; // color type RGBA
  const lunghezza = Buffer.alloc(4);
  lunghezza.writeUInt32BE(13, 0);
  return Buffer.concat([lunghezza, Buffer.from('IHDR', 'ascii'), dati, Buffer.alloc(4)]);
}

// Chunk generico: 4 byte di lunghezza, 4 di tipo, i dati, 4 di CRC. Il CRC è finto
// (zeri) ed è deliberato: png-js NON verifica i CRC, quindi un PNG con CRC sbagliati
// arriva comunque fino alla decompressione — che è esattamente il punto del test qui
// sotto. Un CRC vero non cambierebbe nulla e nasconderebbe questo fatto.
function chunkPng(tipo: string, dati: Buffer): Buffer {
  const lunghezza = Buffer.alloc(4);
  lunghezza.writeUInt32BE(dati.length, 0);
  return Buffer.concat([lunghezza, Buffer.from(tipo, 'ascii'), dati, Buffer.alloc(4)]);
}

// IDAT VERO: i byte di un'immagine RGBA tutta trasparente, filtro 0 su ogni riga (un byte
// di filtro + larghezza × 4 byte di pixel), compressi con zlib come vuole il formato. È
// l'unico modo di costruire un PNG che si decomprima davvero — serve ai test che devono
// superare la validazione per arrivare a misurare altro (il limite del body parser).
function chunkIdatValido(larghezza: number, altezza: number): Buffer {
  const grezzi = Buffer.alloc(altezza * (1 + larghezza * 4));
  return chunkPng('IDAT', zlib.deflateSync(grezzi));
}

function dataUriPng(...parti: Buffer[]): string {
  return `data:image/png;base64,${Buffer.concat([PNG_MAGIC, ...parti]).toString('base64')}`;
}

// Header PNG perfettamente valido (100x50) e NESSUN dato immagine: supera prefisso, byte
// magici, IHDR e limiti di dimensione, ma pdfkit non riesce a disegnarlo
// ("Incomplete or corrupt PNG file"). È esattamente la firma che, prima della correzione,
// faceva fallire la generazione del PDF DOPO che la firma era già stata registrata.
const FIRMA_PNG_CORROTTA = dataUriPng(chunkIhdr(100, 50));

// L'ALTRO PNG rotto, quello che faceva TERMINARE IL PROCESSO. Struttura completa e
// credibile — magic, IHDR 2×2 a 8 bit di tipo colore 6 (RGBA, quello che produce il
// canvas della firma), IDAT, IEND — ma con quattro byte di spazzatura al posto dei dati
// compressi. Supera prefisso, base64, byte magici, IHDR e limiti di dimensione: png-js
// non verifica i CRC e non si accorge di nulla, e l'errore arriva da zlib.inflate DENTRO
// la sua callback asincrona, dove nessun try/catch sincrono può prenderlo. Riprodotto dal
// vivo: "ESITO: NON CATTURABILE — eccezione non gestita: incorrect header check", e il
// processo sopravviveva solo perché il test aveva registrato apposta un
// process.on('uncaughtException') che in produzione non esisteva.
// Caso DIVERSO da FIRMA_PNG_CORROTTA qui sopra, che non ha nessun IDAT e fallisce in modo
// sincrono dentro png-js: quello era già gestito, questo no.
const FIRMA_PNG_IDAT_ILLEGGIBILE = dataUriPng(
  chunkIhdr(2, 2),
  chunkPng('IDAT', Buffer.from([0xde, 0xad, 0xbe, 0xef])),
  chunkPng('IEND', Buffer.alloc(0)),
);

const DATA_LAVORI = '2026-09-01';
const ALTRA_DATA = '2026-09-02';
const DATA_FIRMATO_LOCK = '2026-09-04';
const DATA_CROSS_TENANT = '2026-09-05';
const DATA_COLLEGA = '2026-09-06';
const DATA_ANNULLATO_ORACOLO = '2026-09-07';
const DATA_SCADUTO_ORACOLO = '2026-09-08';
const DATA_PDF_CORROTTO = '2026-09-09';
const DATA_CONCORRENZA_CREATE = '2026-09-10';
const DATA_CONCORRENZA_FIRMA = '2026-09-11';
const DATA_RACE_TARGET = '2026-09-13';
const DATA_VINCOLO_UNICO = '2026-09-14';
const DATA_SCADENZA_PRESENTATA = '2026-09-15';
const DATA_REINVIO = '2026-09-16';
const DATA_INTEGRITA = '2026-09-17';
const DATA_RACE_INVARIANTE = '2026-09-18';
const DATA_NUMERO_PRIMO = '2026-10-01';
const DATA_NUMERO_SECONDO = '2026-10-02';
const DATA_NUMERO_ANNULLATO = '2026-10-03';
const DATA_NUMERO_ELENCO = '2026-10-04';
const DATE_NUMERO_CONCORRENTI = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
const DATA_DESTINAZIONE = '2026-10-11';
const DATA_SENZA_DESTINAZIONE = '2026-10-12';
const DATA_CODICI_RIGHE = '2026-10-13';
const DATA_CODICI_AGGREGATO = '2026-10-14';
const DATA_PDF_COMPLETO = '2026-10-15';
const DATA_DEADLOCK = '2026-10-16';
const DATA_PNG_ILLEGGIBILE = '2026-10-17';
const DATA_EMAIL_ORE = '2026-10-18';

// Numero fuori dalla sequenza reale, per le due insert dirette che DEVONO fallire su un
// altro vincolo: riusare un numero già assegnato le farebbe fallire sull'UNIQUE del
// progressivo, cioè su un vincolo diverso da quello che quei test vogliono dimostrare.
const NUMERO_FUORI_SEQUENZA = 900001;

let companyId: string;
let adminId: string;
let operaioId: string;
let altroOperaioId: string;
let adminToken: string;
let pmToken: string;
let operaioToken: string;
let altroOperaioToken: string;
let projectId: string;
let contrattoProjectId: string;
let taskId: string;
let contrattoTaskId: string;

async function inserisciOre(date: string, userId: string, hours: string, task = taskId): Promise<string> {
  const [row] = await db
    .insert(timeLogs)
    .values({ companyId, taskId: task, userId, tipo: 'ordinario', hoursWorked: hours, date, startTime: '08:00' })
    .returning();
  return row.id;
}

async function inserisciMateriale(
  timeLogId: string,
  nome: string,
  quantita: string,
  unita: string,
  codice: string | null,
): Promise<void> {
  await db
    .insert(timeLogMaterials)
    .values({ companyId, timeLogId, name: nome, quantity: quantita, unit: unita, code: codice });
}

async function creaRapportino(token: string, date: string, project = projectId) {
  return request(app)
    .post('/api/v1/rapportini')
    .set('Authorization', `Bearer ${token}`)
    .send({ projectId: project, date });
}

// Ogni firma arriva da un indirizzo diverso, dichiarato con X-Forwarded-For (app.ts
// imposta 'trust proxy' a 1, quindi diventa req.ip). Non è un trucco per aggirare un
// controllo: la rotta di firma ha un rate limit stretto (20 per quarto d'ora per IP,
// pensato per il brute-force sul token) e senza questo l'intero file condividerebbe un
// unico contatore. Il risultato sarebbe che aggiungere un test qualsiasi fa fallire per
// 429 un test scritto mesi prima, in un punto del file che con esso non c'entra nulla —
// cioè esattamente la dipendenza dall'ordine di esecuzione che si vuole eliminare. Nella
// realtà i firmatari sono su dispositivi e reti diverse: un IP per firma è il caso vero.
let firmeEmesse = 0;
function ipDiTurno(): string {
  firmeEmesse += 1;
  return `10.0.${Math.floor(firmeEmesse / 250)}.${(firmeEmesse % 250) + 1}`;
}

// Firma: il token viaggia nel CORPO, non nell'URL (vedi rapportini.routes.ts — evita che
// finisca nei log di requestLogger, che stampa req.originalUrl a ogni richiesta).
function firma(token: string, corpo: Record<string, unknown> = {}, userAgent?: string) {
  const req = request(app).post('/api/v1/rapportini/firma').set('X-Forwarded-For', ipDiTurno());
  if (userAgent) req.set('User-Agent', userAgent);
  return req.send({
    token,
    firmatarioNome: 'Cliente',
    firmatarioEmail: 'cliente@test.local',
    firmaPng: FIRMA_PNG,
    ...corpo,
  });
}

/**
 * Aspetta che almeno una connessione di questo database sia ferma ad attendere un lock.
 *
 * Serve a rendere DETERMINISTICO l'interleaving del test sul deadlock: senza, si potrebbe
 * solo sperare che la creazione del rapportino abbia già raggiunto il suo `FOR UPDATE` su
 * time_logs prima che la transazione pilotata a mano vada avanti — e un test che a volte
 * riproduce lo scenario e a volte no non dimostra nulla, in nessuna delle due direzioni.
 * Se l'attesa non si presenta entro il tetto, si ferma con un errore esplicito invece di
 * proseguire e passare per il motivo sbagliato.
 */
async function attendiUnBackendInAttesaDiLock(timeoutMs = 5000): Promise<void> {
  const scadenza = Date.now() + timeoutMs;
  while (Date.now() < scadenza) {
    const righe = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (Number(righe[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    "Nessuna connessione si è messa in attesa di un lock entro il tetto: l'interleaving " +
      'non è stato riprodotto e il test non starebbe dimostrando niente.',
  );
}

async function leggiRapportino(id: string) {
  const [row] = await db.select().from(rapportini).where(eq(rapportini.id, id)).orderBy(asc(rapportini.id)).limit(1);
  return row;
}

/** Prepara un rapportino già firmato su un giorno dedicato, restituendo id e ore incluse. */
async function preparaFirmato(date: string, userId = operaioId, token = operaioToken) {
  const timeLogId = await inserisciOre(date, userId, '7');
  const creato = await creaRapportino(token, date);
  expect(creato.status).toBe(201);
  const rapportinoId: string = creato.body.rapportino.id;
  const esito = await firma(creato.body.signingToken);
  expect(esito.status).toBe(200);
  return { rapportinoId, timeLogId };
}

// `preparatoIl` è l'unico campo dello snapshot che cambia a ogni costruzione:
// neutralizzarlo isola ciò che il confronto di createRapportino osserva davvero, cioè le
// ore del giorno. Dentro createRapportino l'istante è lo stesso per entrambe le
// costruzioni, proprio perché il confronto riguardi le ore e non l'orologio.
function conPreparatoIlFisso(snapshot: RapportinoSnapshot): RapportinoSnapshot {
  return { ...snapshot, preparatoIl: '1970-01-01T00:00:00.000Z' };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);
  const [company] = await db
    .insert(companies)
    .values({ name: 'RapportiniTestCo', vat: 'IT12345678901', email: 'azienda@rapportini.local', address: 'Via Test 1' })
    .returning();
  companyId = company.id;

  const [admin] = await db
    .insert(users)
    .values({ email: 'rapportini-admin@workflow360.local', passwordHash, name: 'Admin Rapportini', role: 'admin', companyId })
    .returning();
  const [pm] = await db
    .insert(users)
    .values({ email: 'rapportini-pm@workflow360.local', passwordHash, name: 'PM Rapportini', role: 'project_manager', companyId })
    .returning();
  const [operaio] = await db
    .insert(users)
    .values({ email: 'rapportini-operaio@workflow360.local', passwordHash, name: 'Mario Rossi', role: 'operaio', companyId })
    .returning();
  const [altroOperaio] = await db
    .insert(users)
    .values({ email: 'rapportini-operaio2@workflow360.local', passwordHash, name: 'Luigi Bianchi', role: 'operaio', companyId })
    .returning();

  adminId = admin.id;
  operaioId = operaio.id;
  altroOperaioId = altroOperaio.id;
  adminToken = signAccessToken({ id: admin.id, email: admin.email, role: 'admin', companyId });
  pmToken = signAccessToken({ id: pm.id, email: pm.email, role: 'project_manager', companyId });
  operaioToken = signAccessToken({ id: operaio.id, email: operaio.email, role: 'operaio', companyId });
  altroOperaioToken = signAccessToken({ id: altroOperaio.id, email: altroOperaio.email, role: 'operaio', companyId });

  const [project] = await db
    .insert(projects)
    .values({
      name: 'Cantiere Rapportini Vitest',
      companyId,
      projectNumber: 1,
      code: 'RAP-01',
      tipoCommessa: 'consuntivo',
      clientName: 'Comune di Testville',
    })
    .returning();
  projectId = project.id;
  const [task] = await db.insert(tasks).values({ projectId, title: 'Posa pavimento', companyId }).returning();
  taskId = task.id;

  const [contrattoProject] = await db
    .insert(projects)
    .values({ name: 'Cantiere a contratto Vitest', companyId, projectNumber: 2, tipoCommessa: 'contratto' })
    .returning();
  contrattoProjectId = contrattoProject.id;
  const [contrattoTask] = await db
    .insert(tasks)
    .values({ projectId: contrattoProjectId, title: 'Lavoro a contratto', companyId })
    .returning();
  contrattoTaskId = contrattoTask.id;
});

beforeEach(() => {
  // Default deterministico: l'invio "non riesce" come su un ambiente senza chiave, ma per
  // scelta esplicita del test e non per una variabile d'ambiente assente.
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ sent: false, error: 'RESEND_API_KEY non configurata (doppio di test)' });
});

afterAll(async () => {
  // Ordine obbligato dalle foreign key: rapportini ha RESTRICT verso projects e users,
  // quindi va svuotata prima di loro (time_logs.rapportino_id è SET NULL e non ostacola).
  await db.delete(rapportini).where(eq(rapportini.companyId, companyId)).catch(() => {});
  await db.delete(auditLog).where(eq(auditLog.companyId, companyId)).catch(() => {});
  await db.delete(timeLogs).where(eq(timeLogs.companyId, companyId)).catch(() => {});
  await db.delete(tasks).where(eq(tasks.companyId, companyId)).catch(() => {});
  await db.delete(projects).where(eq(projects.companyId, companyId)).catch(() => {});
  await db.delete(users).where(eq(users.companyId, companyId)).catch(() => {});
  await db.delete(companies).where(eq(companies.id, companyId)).catch(() => {});
});

describe('GET /api/v1/rapportini/anteprima', () => {
  it("costruisce lo snapshot senza persistere nulla e copia dentro nomi e dati dell'azienda", async () => {
    await inserisciOre(DATA_LAVORI, operaioId, '6');

    const res = await request(app)
      .get(`/api/v1/rapportini/anteprima?projectId=${projectId}&date=${DATA_LAVORI}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    // v2: la forma dello snapshot ha guadagnato l'indirizzo del cantiere e il codice dei
    // materiali. Il valore atteso resta scritto per esteso (non `SNAPSHOT_VERSIONE`),
    // altrimenti l'asserzione seguirebbe qualunque cambio invece di segnalarlo.
    expect(res.body.anteprima.versione).toBe(2);
    expect(res.body.anteprima.azienda.nome).toBe('RapportiniTestCo');
    expect(res.body.anteprima.cantiere.clientName).toBe('Comune di Testville');
    expect(res.body.anteprima.righe).toHaveLength(1);
    // Nome copiato dentro lo snapshot, non un id da risolvere dopo: è tutto il punto.
    expect(res.body.anteprima.righe[0].operaio.nome).toBe('Mario Rossi');
    expect(res.body.anteprima.totali.oreTotali).toBe('6.00');

    const salvati = await db.select().from(rapportini).where(eq(rapportini.projectId, projectId));
    expect(salvati).toHaveLength(0);
  });

  it("un operaio che non ha lavorato su quel cantiere/giorno non può preparare l'anteprima (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/rapportini/anteprima?projectId=${projectId}&date=${DATA_LAVORI}`)
      .set('Authorization', `Bearer ${altroOperaioToken}`);
    expect(res.status).toBe(403);
  });

  it('un operaio che HA lavorato su quel cantiere/giorno vede la propria anteprima (200)', async () => {
    const res = await request(app)
      .get(`/api/v1/rapportini/anteprima?projectId=${projectId}&date=${DATA_LAVORI}`)
      .set('Authorization', `Bearer ${operaioToken}`);
    expect(res.status).toBe(200);
  });
});

describe('POST /api/v1/rapportini', () => {
  it('rifiuta una commessa a contratto (409)', async () => {
    await inserisciOre(DATA_LAVORI, operaioId, '4', contrattoTaskId);
    const res = await creaRapportino(adminToken, DATA_LAVORI, contrattoProjectId);
    expect(res.status).toBe(409);
  });

  it('rifiuta un giorno senza ore registrate (400)', async () => {
    const res = await creaRapportino(adminToken, '2026-09-30');
    expect(res.status).toBe(400);
  });

  it('crea il rapportino e restituisce il token di firma una sola volta', async () => {
    const res = await creaRapportino(operaioToken, DATA_LAVORI);
    expect(res.status).toBe(201);
    expect(res.body.rapportino.status).toBe('in_firma');
    expect(res.body.rapportino.revision).toBe(1);
    expect(res.body.rapportino.totalHours).toBe('6.00');
    expect(typeof res.body.signingToken).toBe('string');
    expect(res.body.signingToken.length).toBeGreaterThan(20);

    // Il token in chiaro non è ricostruibile da nessun'altra risposta: in database ne
    // esiste solo l'hash, e il dettaglio non lo espone in nessuna forma.
    const dettaglio = await request(app)
      .get(`/api/v1/rapportini/${res.body.rapportino.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(dettaglio.status).toBe(200);
    expect(JSON.stringify(dettaglio.body)).not.toContain(res.body.signingToken);
  });

  it("un secondo rapportino sullo stesso cantiere/giorno viene rifiutato finché il primo è in firma (409)", async () => {
    const res = await creaRapportino(adminToken, DATA_LAVORI);
    expect(res.status).toBe(409);
  });

  it("l'UNIQUE parziale impedisce due righe 'in_firma' sullo stesso cantiere/giorno anche scrivendo diretto sul database", async () => {
    const [esistente] = await db
      .select()
      .from(rapportini)
      .where(and(eq(rapportini.projectId, projectId), eq(rapportini.status, 'in_firma')))
      .orderBy(asc(rapportini.createdAt))
      .limit(1);
    expect(esistente).toBeDefined();

    // Revisione diversa (l'UNIQUE su project+date+revision non c'entra): quello che deve
    // scattare è l'indice parziale WHERE status = 'in_firma'. L'errore va verificato per
    // CODICE e per VINCOLO: un `rejects.toThrow()` nudo passerebbe anche se a fallire
    // fosse un NOT NULL, una foreign key o un refuso nel test, cioè proprio i casi in cui
    // il vincolo che si vuole dimostrare non è mai entrato in gioco.
    const errore = await db
      .insert(rapportini)
      .values({
        companyId,
        projectId,
        date: DATA_LAVORI,
        revision: 99,
        numero: NUMERO_FUORI_SEQUENZA,
        createdBy: adminId,
        snapshotJson: esistente.snapshotJson,
        snapshotHash: esistente.snapshotHash,
        totalHours: '1.00',
        tokenHash: 'hash-fittizio-per-il-test-del-vincolo',
        expiresAt: new Date(Date.now() + 60_000),
      })
      .then(() => null)
      .catch((err: unknown) => err);

    expect(errore).not.toBeNull();
    expect((errore as { code?: string }).code).toBe('23505');
    expect(isUniqueViolation(errore)).toBe(true);
    expect(uniqueViolationConstraint(errore)).toBe('rapportini_project_id_date_in_firma_unique');
  });

  it("il vincolo sul progressivo di revisione è un vincolo DIVERSO, e si distingue dal nome", async () => {
    const [esistente] = await db
      .select()
      .from(rapportini)
      .where(and(eq(rapportini.projectId, projectId), eq(rapportini.status, 'in_firma')))
      .orderBy(asc(rapportini.createdAt))
      .limit(1);

    // Stato 'annullato': l'indice parziale (che vale solo su 'in_firma') non entra in
    // gioco, quindi a scattare è per forza (project_id, date, revision). Se i due vincoli
    // non fossero distinguibili, l'utente si vedrebbe dire "ne esiste già uno in attesa di
    // firma" per un conflitto che con la firma non c'entra nulla.
    const errore = await db
      .insert(rapportini)
      .values({
        companyId,
        projectId,
        date: DATA_LAVORI,
        revision: esistente.revision,
        numero: NUMERO_FUORI_SEQUENZA + 1,
        status: 'annullato',
        createdBy: adminId,
        snapshotJson: esistente.snapshotJson,
        snapshotHash: esistente.snapshotHash,
        totalHours: '1.00',
        tokenHash: 'hash-fittizio-per-il-vincolo-di-revisione',
        expiresAt: new Date(Date.now() + 60_000),
      })
      .then(() => null)
      .catch((err: unknown) => err);

    expect(isUniqueViolation(errore)).toBe(true);
    expect(uniqueViolationConstraint(errore)).toBe('rapportini_project_id_date_revision_unique');
  });
});

describe('Lucchetto sulle ore di un rapportino', () => {
  let timeLogBloccatoId: string;

  beforeAll(async () => {
    const [row] = await db
      .select({ id: timeLogs.id })
      .from(timeLogs)
      .where(and(eq(timeLogs.companyId, companyId), eq(timeLogs.taskId, taskId), eq(timeLogs.date, DATA_LAVORI)))
      .orderBy(asc(timeLogs.createdAt))
      .limit(1);
    timeLogBloccatoId = row.id;
  });

  it('la creazione ha davvero scritto rapportino_id sulle ore incluse', async () => {
    const [row] = await db
      .select({ rapportinoId: timeLogs.rapportinoId })
      .from(timeLogs)
      .where(eq(timeLogs.id, timeLogBloccatoId))
      .orderBy(asc(timeLogs.id))
      .limit(1);
    expect(row.rapportinoId).not.toBeNull();
  });

  it('PATCH su ore in attesa di firma -> 409, e le ore restano invariate', async () => {
    const res = await request(app)
      .patch(`/api/v1/time-logs/${timeLogBloccatoId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ hoursWorked: '7' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('in attesa di firma');

    const [row] = await db
      .select({ hoursWorked: timeLogs.hoursWorked })
      .from(timeLogs)
      .where(eq(timeLogs.id, timeLogBloccatoId))
      .orderBy(asc(timeLogs.id))
      .limit(1);
    expect(row.hoursWorked).toBe('6.00');
  });

  it('DELETE su ore in attesa di firma -> 409, la riga esiste ancora', async () => {
    const res = await request(app)
      .delete(`/api/v1/time-logs/${timeLogBloccatoId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(409);

    const righe = await db.select({ id: timeLogs.id }).from(timeLogs).where(eq(timeLogs.id, timeLogBloccatoId));
    expect(righe).toHaveLength(1);
  });

  it('registrare ORE NUOVE su quel cantiere/giorno resta consentito (non appartengono a nessun rapportino)', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, userId: altroOperaioId, hoursWorked: '2', date: DATA_LAVORI, startTime: '18:00' });
    expect(res.status).toBe(201);
    expect(res.body.timeLogs[0].rapportinoId).toBeNull();
  });
});

describe('Ore bloccate da un rapportino FIRMATO', () => {
  let rapportinoFirmatoId: string;
  let oraFirmataId: string;

  beforeAll(async () => {
    const esito = await preparaFirmato(DATA_FIRMATO_LOCK);
    rapportinoFirmatoId = esito.rapportinoId;
    oraFirmataId = esito.timeLogId;
  });

  it('DELETE su ore firmate dal cliente -> 409, la riga esiste ancora', async () => {
    const res = await request(app)
      .delete(`/api/v1/time-logs/${oraFirmataId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('firmate dal cliente');

    const righe = await db.select({ id: timeLogs.id }).from(timeLogs).where(eq(timeLogs.id, oraFirmataId));
    expect(righe).toHaveLength(1);
  });

  it('registrare ORE NUOVE su un giorno già firmato resta consentito (201)', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, userId: altroOperaioId, hoursWorked: '3', date: DATA_FIRMATO_LOCK, startTime: '17:00' });
    expect(res.status).toBe(201);
    expect(res.body.timeLogs[0].rapportinoId).toBeNull();
  });

  it("ma un nuovo rapportino per quel giorno viene rifiutato: alcune ore sono già firmate (409)", async () => {
    const res = await creaRapportino(adminToken, DATA_FIRMATO_LOCK);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('già a un rapportino');

    // Il rapportino firmato non è stato toccato dal tentativo fallito.
    const row = await leggiRapportino(rapportinoFirmatoId);
    expect(row.status).toBe('firmato');
  });
});

describe('POST /api/v1/rapportini/firma (rotta pubblica)', () => {
  let rapportinoId: string;
  let signingToken: string;

  beforeAll(async () => {
    // Il rapportino creato nei test sopra è ancora 'in_firma' ma il suo token non è più
    // disponibile qui: se ne prepara uno nuovo su un altro giorno.
    await inserisciOre(ALTRA_DATA, operaioId, '8');
    const res = await creaRapportino(operaioToken, ALTRA_DATA);
    rapportinoId = res.body.rapportino.id;
    signingToken = res.body.signingToken;
  });

  it('token inesistente -> 401 generico', async () => {
    const res = await firma('token-che-non-esiste-affatto');
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Link non valido o scaduto');
  });

  it("un'immagine che non è un PNG viene rifiutata anche se il prefisso lo dichiara (400)", async () => {
    const res = await firma(signingToken, {
      firmaPng: `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`,
    });
    expect(res.status).toBe(400);

    // Nessun effetto collaterale: il rapportino è ancora firmabile.
    const row = await leggiRapportino(rapportinoId);
    expect(row.status).toBe('in_firma');
  });

  it('rapportinoId che non combacia con quello risolto dal token -> stesso 401 generico, nessuno dei due firmato', async () => {
    await inserisciOre('2026-09-23', operaioId, '6');
    await inserisciOre('2026-09-24', operaioId, '6');
    const rapA = await creaRapportino(operaioToken, '2026-09-23');
    const rapB = await creaRapportino(operaioToken, '2026-09-24');

    // Il token è di A, l'id dichiarato è di B: deve fallire come un token invalido, non
    // come un errore diverso (altrimenti si potrebbe distinguere questo caso da un token
    // sbagliato, esattamente la fuga di informazione che il messaggio unico evita altrove).
    const res = await firma(rapA.body.signingToken, { rapportinoId: rapB.body.rapportino.id });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Link non valido o scaduto');

    const a = await leggiRapportino(rapA.body.rapportino.id);
    const b = await leggiRapportino(rapB.body.rapportino.id);
    expect(a.status).toBe('in_firma');
    expect(b.status).toBe('in_firma');

    // Con l'id giusto (quello che un client aggiornato manda davvero) la firma riesce.
    const ok = await firma(rapA.body.signingToken, { rapportinoId: rapA.body.rapportino.id });
    expect(ok.status).toBe(200);
  });

  it('firma valida: 200, stato firmato, firma e contesto registrati', async () => {
    const res = await firma(
      signingToken,
      { firmatarioNome: 'Ing. Verdi', firmatarioEmail: 'verdi@test.local' },
      'Vitest/1.0',
    );

    expect(res.status).toBe(200);
    expect(res.body.firmato).toBe(true);
    // Il doppio di core/mail dichiara un invio non riuscito: la risposta lo riporta
    // invece di affermare un invio mai avvenuto.
    expect(res.body.emailInviata).toBe(false);

    const row = await leggiRapportino(rapportinoId);
    expect(row.status).toBe('firmato');
    expect(row.signerName).toBe('Ing. Verdi');
    expect(row.signedAt).not.toBeNull();
    expect(row.signedUserAgent).toBe('Vitest/1.0');
    // Salvata senza il prefisso "data:", che non fa parte dell'immagine.
    expect(row.signaturePng?.startsWith('data:')).toBe(false);
    expect(row.signaturePng?.startsWith('iVBORw0KGgo')).toBe(true);
    // L'email non è partita: l'errore è registrato, email_sent_at resta vuoto.
    expect(row.emailSentAt).toBeNull();
    expect(row.emailLastError).not.toBeNull();
  });

  it("l'email porta il PDF in allegato e l'azienda in copia nascosta", async () => {
    await preparaFirmato('2026-09-19');

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const inviata = sendEmailMock.mock.calls[0][0];
    expect(inviata.to).toBe('cliente@test.local');
    expect(inviata.bcc).toBe('azienda@rapportini.local');
    expect(inviata.attachments).toHaveLength(1);
    // L'allegato è un PDF vero, non un segnaposto.
    expect(Buffer.from(inviata.attachments![0].content, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('lo stesso token una seconda volta -> stesso 401 generico di un token inesistente', async () => {
    const res = await firma(signingToken, { firmatarioNome: 'Altro', firmatarioEmail: 'altro@test.local' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Link non valido o scaduto');
  });

  it('token scaduto -> stesso 401 generico', async () => {
    await inserisciOre('2026-09-03', operaioId, '5');
    const creato = await creaRapportino(operaioToken, '2026-09-03');
    await db
      .update(rapportini)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(rapportini.id, creato.body.rapportino.id));

    const res = await firma(creato.body.signingToken);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Link non valido o scaduto');
  });

  it("un rapportino scaduto non blocca più il giorno: passa a 'scaduto', libera le ore e se ne può creare un altro", async () => {
    const [primo] = await db
      .select({ id: rapportini.id })
      .from(rapportini)
      .where(and(eq(rapportini.projectId, projectId), eq(rapportini.date, '2026-09-03')))
      .orderBy(asc(rapportini.revision))
      .limit(1);

    const res = await creaRapportino(operaioToken, '2026-09-03');
    expect(res.status).toBe(201);
    expect(res.body.rapportino.revision).toBe(2);

    // Il vecchio rapportino non è rimasto "in attesa di firma" per sempre: la creazione
    // successiva lo ha davvero chiuso come scaduto...
    const vecchio = await leggiRapportino(primo.id);
    expect(vecchio.status).toBe('scaduto');

    // ...e ha davvero tolto il lucchetto dalle sue ore, che sono infatti finite nel nuovo
    // rapportino invece di restare bloccate da un documento morto.
    const ancoraSue = await db
      .select({ id: timeLogs.id })
      .from(timeLogs)
      .where(eq(timeLogs.rapportinoId, primo.id));
    expect(ancoraSue).toHaveLength(0);
  });

  it('token di un rapportino ANNULLATO -> stesso 401 generico', async () => {
    await inserisciOre(DATA_ANNULLATO_ORACOLO, operaioId, '4');
    const creato = await creaRapportino(operaioToken, DATA_ANNULLATO_ORACOLO);
    const annulla = await request(app)
      .post(`/api/v1/rapportini/${creato.body.rapportino.id}/annulla`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Cliente assente' });
    expect(annulla.status).toBe(200);

    const res = await firma(creato.body.signingToken);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Link non valido o scaduto');
  });

  it("token di un rapportino già passato a 'scaduto' -> stesso 401 generico", async () => {
    await inserisciOre(DATA_SCADUTO_ORACOLO, operaioId, '4');
    const creato = await creaRapportino(operaioToken, DATA_SCADUTO_ORACOLO);
    await db
      .update(rapportini)
      .set({ status: 'scaduto' })
      .where(eq(rapportini.id, creato.body.rapportino.id));

    const res = await firma(creato.body.signingToken);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Link non valido o scaduto');
  });

  it('le ore firmate ora rispondono 409 con il messaggio della firma, non con quello dell\'attesa', async () => {
    const [riga] = await db
      .select({ id: timeLogs.id })
      .from(timeLogs)
      .where(and(eq(timeLogs.companyId, companyId), eq(timeLogs.date, ALTRA_DATA)))
      .orderBy(asc(timeLogs.createdAt))
      .limit(1);

    const res = await request(app)
      .patch(`/api/v1/time-logs/${riga.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ hoursWorked: '3' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('firmate dal cliente');
  });

  it('GET /:id/pdf genera un PDF vero a partire dallo snapshot', async () => {
    const res = await request(app)
      .get(`/api/v1/rapportini/${rapportinoId}/pdf`)
      .set('Authorization', `Bearer ${adminToken}`)
      .buffer(true)
      .parse((res2, cb) => {
        const parti: Buffer[] = [];
        res2.on('data', (c: Buffer) => parti.push(c));
        res2.on('end', () => cb(null, Buffer.concat(parti)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('Validazione della firma PNG', () => {
  it('un PNG che dichiara dimensioni assurde viene rifiutato PRIMA di essere decodificato (400)', async () => {
    // 20000x20000 in RGBA sarebbero 1,6 GB una volta decodificati: su un'istanza da 512MB
    // il processo verrebbe terminato dal sistema, non "solleverebbe un'eccezione".
    const res = await firma('token-qualsiasi', { firmaPng: dataUriPng(chunkIhdr(20000, 20000)) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('dimensioni non plausibili');
  });

  it('un PNG con dimensioni nulle viene rifiutato (400)', async () => {
    const res = await firma('token-qualsiasi', { firmaPng: dataUriPng(chunkIhdr(0, 0)) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('dimensioni nulle');
  });

  it("byte magici giusti ma nessuna intestazione IHDR -> rifiutato (400)", async () => {
    const res = await firma('token-qualsiasi', { firmaPng: dataUriPng(Buffer.alloc(64)) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('IHDR');
  });

  it('una firma oltre il tetto di dimensione viene rifiutata (400)', async () => {
    // Oltre 500KB una volta decodificata: il controllo scatta sulla lunghezza della
    // stringa base64, prima che Buffer.from allochi alcunché.
    const enorme = dataUriPng(chunkIhdr(100, 50), Buffer.alloc(600 * 1024));
    const res = await firma('token-qualsiasi', { firmaPng: enorme });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('dimensione massima');
  });

});

// Prima della correzione, UNA sola richiesta di questo blocco faceva TERMINARE IL PROCESSO
// backend: tutti i clienti giù. Il token usato è REALE e non inventato, ed è il punto —
// con un token finto la richiesta verrebbe respinta con un 401 prima ancora di arrivare a
// pdfkit, e il test passerebbe senza aver mai riprodotto niente. È anche esattamente
// l'attacco: qualunque utente autenticato, foss'anche un operaio, crea un rapportino,
// riceve il signingToken nella risposta e chiama la rotta pubblica di firma con questo
// PNG. Il rate limiter non è un argine, perché conta in memoria (MemoryStore di
// express-rate-limit, app.ts) e il riavvio gli azzera i contatori: il tetto di 20 firme
// per quarto d'ora non limita il numero di cadute.
describe('Firma con un PNG i cui dati compressi sono illeggibili (faceva cadere il processo)', () => {
  let rapportinoId: string;
  let signingToken: string;

  beforeAll(async () => {
    await inserisciOre(DATA_PNG_ILLEGGIBILE, operaioId, '6');
    const creato = await creaRapportino(operaioToken, DATA_PNG_ILLEGGIBILE);
    rapportinoId = creato.body.rapportino.id;
    signingToken = creato.body.signingToken;
  });

  it('risponde 400, NON registra la firma e soprattutto NON fa cadere il processo', async () => {
    const pidPrima = process.pid;

    const res = await firma(signingToken, { firmaPng: FIRMA_PNG_IDAT_ILLEGGIBILE });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Impossibile elaborare la firma');

    const row = await leggiRapportino(rapportinoId);
    expect(row.status).toBe('in_firma');
    expect(row.signaturePng).toBeNull();

    // Senza la correzione qui non ci si arriverebbe nemmeno: l'eccezione non gestita
    // lanciata dentro la callback di zlib avrebbe già chiuso il processo (nel test, il
    // worker di vitest). Il controllo sul pid e la chiamata di health dicono che il
    // processo è LO STESSO e che risponde ancora.
    expect(process.pid).toBe(pidPrima);
    const dopo = await request(app).get('/api/v1/health');
    expect(dopo.status).toBe(200);
  });

  it('il token NON è stato consumato: il cliente rifirma subito con una firma buona', async () => {
    const res = await firma(signingToken, { firmatarioNome: 'Cliente Dopo PNG Rotto' });
    expect(res.status).toBe(200);

    const row = await leggiRapportino(rapportinoId);
    expect(row.status).toBe('firmato');
    expect(row.signerName).toBe('Cliente Dopo PNG Rotto');
  });
});

// Il caso che ha motivato lo spostamento della generazione del PDF PRIMA del commit.
describe('Firma con un PNG che il generatore PDF non riesce a disegnare', () => {
  let rapportinoId: string;
  let signingToken: string;

  beforeAll(async () => {
    await inserisciOre(DATA_PDF_CORROTTO, operaioId, '6');
    const creato = await creaRapportino(operaioToken, DATA_PDF_CORROTTO);
    rapportinoId = creato.body.rapportino.id;
    signingToken = creato.body.signingToken;
  });

  it('risponde 400 e NON registra la firma: il rapportino resta firmabile', async () => {
    const res = await firma(signingToken, { firmaPng: FIRMA_PNG_CORROTTA });

    // Prima della correzione qui arrivava un 500: il PDF veniva generato DOPO il commit,
    // quindi la riga era già 'firmato', il token già consumato e la posizione irrecuperabile.
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Impossibile elaborare la firma');

    const row = await leggiRapportino(rapportinoId);
    expect(row.status).toBe('in_firma');
    expect(row.signedAt).toBeNull();
    expect(row.signaturePng).toBeNull();
    expect(row.signerName).toBeNull();
  });

  it('il token NON è stato consumato: il cliente può rifirmare subito con una firma buona', async () => {
    const res = await firma(signingToken, { firmatarioNome: 'Cliente Ripetente' });
    expect(res.status).toBe(200);

    const row = await leggiRapportino(rapportinoId);
    expect(row.status).toBe('firmato');
    expect(row.signerName).toBe('Cliente Ripetente');
  });

  it('il PDF di quel rapportino si genera regolarmente (la firma registrata è valida)', async () => {
    const res = await request(app)
      .get(`/api/v1/rapportini/${rapportinoId}/pdf`)
      .set('Authorization', `Bearer ${adminToken}`)
      .buffer(true)
      .parse((res2, cb) => {
        const parti: Buffer[] = [];
        res2.on('data', (c: Buffer) => parti.push(c));
        res2.on('end', () => cb(null, Buffer.concat(parti)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe("Iniezione HTML nell'email del rapportino firmato", () => {
  it('il nome del firmatario finisce nel corpo HTML già neutralizzato', async () => {
    await inserisciOre('2026-09-21', operaioId, '5');
    const creato = await creaRapportino(operaioToken, '2026-09-21');

    const res = await firma(creato.body.signingToken, {
      firmatarioNome: '<script>alert("xss")</script>',
      firmatarioEmail: 'cliente@test.local',
    });
    expect(res.status).toBe(200);

    const html = sendEmailMock.mock.calls[0][0].html;
    // Il nome arriva dall'endpoint pubblico: nel corpo dell'email non deve poter aprire
    // un tag. L'azienda riceve questa stessa email in copia nascosta.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;xss&quot;');
  });

  // L'email è l'unica delle tre rese del documento che al cliente resta in casella: il PDF
  // allegato e il foglio che ha firmato a schermo scrivono entrambi "7,5", mentre qui
  // compariva "7.50", preso di peso dallo snapshot (dove le ore stanno come le restituisce
  // Postgres). Lo stesso numero scritto in tre modi mette chi legge nella posizione di
  // dover verificare che sia davvero lo stesso numero.
  it('le ore totali sono scritte come sul documento ("7,5"), non come le tiene il database ("7.50")', async () => {
    await inserisciOre(DATA_EMAIL_ORE, operaioId, '7.5');
    const creato = await creaRapportino(operaioToken, DATA_EMAIL_ORE);
    expect(creato.status).toBe(201);
    // Nello snapshot il valore grezzo RESTA: è la memoria del documento e non deve
    // cambiare. A cambiare è solo il modo in cui lo si scrive a chi lo legge.
    expect(creato.body.rapportino.snapshot.totali.oreTotali).toBe('7.50');

    expect((await firma(creato.body.signingToken)).status).toBe(200);

    const html = sendEmailMock.mock.calls[0][0].html ?? '';
    expect(html).toContain('<strong>7,5</strong>');
    expect(html).not.toContain('7.50');
  });
});

describe("Verifica dell'hash dello snapshot", () => {
  it("l'hash resta stabile attraverso il salvataggio e la rilettura da jsonb", async () => {
    await inserisciOre(DATA_INTEGRITA, operaioId, '6');
    const creato = await creaRapportino(operaioToken, DATA_INTEGRITA);
    expect(creato.status).toBe(201);

    // Postgres normalizza e riordina le chiavi di una colonna jsonb: senza la
    // canonicalizzazione (chiavi ordinate) di hashSnapshot, lo stesso identico contenuto
    // riletto dal database produrrebbe un hash diverso e la verifica d'integrità
    // segnalerebbe una corruzione a ogni lettura. Il giro reale sul database è l'unico
    // modo di dimostrarlo: un confronto in memoria non toccherebbe quel comportamento.
    const row = await leggiRapportino(creato.body.rapportino.id);
    expect(hashSnapshot(row.snapshotJson as RapportinoSnapshot)).toBe(row.snapshotHash);
  });

  it("una modifica dello snapshot fuori dall'applicazione viene segnalata nei log, senza negare il documento", async () => {
    const [row] = await db
      .select()
      .from(rapportini)
      .where(and(eq(rapportini.companyId, companyId), eq(rapportini.date, DATA_INTEGRITA)))
      .orderBy(asc(rapportini.createdAt))
      .limit(1);

    const alterato = JSON.parse(JSON.stringify(row.snapshotJson)) as RapportinoSnapshot;
    alterato.righe[0].ore = '99.00';
    await db.update(rapportini).set({ snapshotJson: alterato }).where(eq(rapportini.id, row.id));

    const errori = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(app)
        .get(`/api/v1/rapportini/${row.id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Il documento resta leggibile: negarlo peggiorerebbe la situazione invece di
      // ripararla. Quello che non deve succedere è che la discrepanza passi inosservata.
      expect(res.status).toBe(200);
      const messaggi = errori.mock.calls.map((c) => String(c[0])).join('\n');
      expect(messaggi).toContain('INTEGRITÀ VIOLATA');
      expect(messaggi).toContain(row.id);
    } finally {
      errori.mockRestore();
    }
  });
});

describe('Stato presentato di un rapportino scaduto ma ancora scritto "in_firma"', () => {
  let scadutoId: string;
  let oraScadutaId: string;

  beforeAll(async () => {
    oraScadutaId = await inserisciOre(DATA_SCADENZA_PRESENTATA, operaioId, '6');
    const creato = await creaRapportino(operaioToken, DATA_SCADENZA_PRESENTATA);
    scadutoId = creato.body.rapportino.id;
    // Scadenza forzata SENZA toccare la colonna status: è esattamente lo stato in cui si
    // trova una riga finché nessuno riprova a creare il rapportino di quel giorno.
    await db
      .update(rapportini)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(rapportini.id, scadutoId));
  });

  it('la colonna sul database resta "in_firma" (nessuna scrittura fuori dal percorso di creazione)', async () => {
    const row = await leggiRapportino(scadutoId);
    expect(row.status).toBe('in_firma');
  });

  it('il dettaglio lo presenta come "scaduto"', async () => {
    const res = await request(app)
      .get(`/api/v1/rapportini/${scadutoId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.rapportino.status).toBe('scaduto');
  });

  it("l'elenco lo presenta come \"scaduto\" e i filtri seguono la stessa definizione", async () => {
    const scaduti = await request(app)
      .get(`/api/v1/rapportini?status=scaduto&date=${DATA_SCADENZA_PRESENTATA}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(scaduti.status).toBe(200);
    expect(scaduti.body.rapportini.map((r: { id: string }) => r.id)).toContain(scadutoId);
    expect(scaduti.body.rapportini.every((r: { status: string }) => r.status === 'scaduto')).toBe(true);

    // Un filtro che continuasse a leggere la sola colonna lo restituirebbe qui: sarebbe
    // l'elenco che contraddice lo stato che esso stesso mostra.
    const inFirma = await request(app)
      .get(`/api/v1/rapportini?status=in_firma&date=${DATA_SCADENZA_PRESENTATA}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(inFirma.body.rapportini.map((r: { id: string }) => r.id)).not.toContain(scadutoId);
  });

  it('il rifiuto sulle ore dice che è SCADUTO, non che si aspetta una firma', async () => {
    const res = await request(app)
      .patch(`/api/v1/time-logs/${oraScadutaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ hoursWorked: '7' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('scaduto senza firma');

    // Il blocco vale comunque: uno stato presentato diverso non allenta il lucchetto.
    const [row] = await db
      .select({ hoursWorked: timeLogs.hoursWorked })
      .from(timeLogs)
      .where(eq(timeLogs.id, oraScadutaId))
      .orderBy(asc(timeLogs.id))
      .limit(1);
    expect(row.hoursWorked).toBe('6.00');
  });
});

describe('Limite di dimensione del corpo sulla rotta di firma', () => {
  // PNG grande ma DAVVERO decodificabile: IHDR + un chunk ausiliario ignorato da qualunque
  // decodificatore (è lì solo a fare peso) + un IDAT vero + IEND. Il riempimento sta in un
  // chunk e non sciolto in coda perché la validazione ora decomprime i dati immagine per
  // davvero (vedi firmaPng.ts, correzione del PNG che faceva cadere il processo): 200KB di
  // zeri buttati dopo l'IHDR non sono un PNG, verrebbero respinti con un 400 e questo test
  // misurerebbe la validazione invece del body parser, che è ciò che gli interessa.
  // La richiesta viene poi respinta per il token inesistente, quindi non arriva mai al PDF.
  const pngGrande = dataUriPng(
    chunkIhdr(100, 50),
    chunkPng('zzZz', Buffer.alloc(200 * 1024)),
    chunkIdatValido(100, 50),
    chunkPng('IEND', Buffer.alloc(0)),
  );

  it('accetta un corpo oltre i 100KB di default (il parser da 1mb è montato prima di quello globale)', async () => {
    const res = await firma('token-inesistente-per-il-test-di-dimensione', { firmaPng: pngGrande });
    // 401 e non 413: il corpo è stato letto per intero, poi respinto per il token.
    expect(res.status).toBe(401);
  });

  it('lo stesso corpo su una rotta normale viene rifiutato dal limite globale (413)', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, hoursWorked: '1', date: DATA_LAVORI, notes: pngGrande });
    expect(res.status).toBe(413);
  });
});

describe('POST /api/v1/rapportini/:id/sblocca', () => {
  let rapportinoFirmatoId: string;
  let snapshotPrima: string;

  beforeAll(async () => {
    const [row] = await db
      .select()
      .from(rapportini)
      .where(and(eq(rapportini.companyId, companyId), eq(rapportini.date, ALTRA_DATA), eq(rapportini.status, 'firmato')))
      .orderBy(asc(rapportini.createdAt))
      .limit(1);
    rapportinoFirmatoId = row.id;
    snapshotPrima = JSON.stringify(row.snapshotJson);
  });

  it('un project_manager NON può sbloccare (403): è un intervento da amministratore', async () => {
    const res = await request(app)
      .post(`/api/v1/rapportini/${rapportinoFirmatoId}/sblocca`)
      .set('Authorization', `Bearer ${pmToken}`)
      .send({ reason: 'Errore nelle ore' });
    expect(res.status).toBe(403);
  });

  it('senza motivo -> 400', async () => {
    const res = await request(app)
      .post(`/api/v1/rapportini/${rapportinoFirmatoId}/sblocca`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("l'admin sblocca: le ore tornano modificabili, ma stato e snapshot restano intatti", async () => {
    const res = await request(app)
      .post(`/api/v1/rapportini/${rapportinoFirmatoId}/sblocca`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Ore registrate sul cantiere sbagliato' });
    expect(res.status).toBe(200);

    const row = await leggiRapportino(rapportinoFirmatoId);
    // Il documento firmato non cambia MAI: né lo stato, né il contenuto sottoscritto.
    expect(row.status).toBe('firmato');
    expect(JSON.stringify(row.snapshotJson)).toBe(snapshotPrima);
    expect(row.unlockedAt).not.toBeNull();
    expect(row.unlockedBy).toBe(adminId);
    expect(row.unlockReason).toBe('Ore registrate sul cantiere sbagliato');

    // Il lucchetto è sparito dalle ore.
    const bloccate = await db
      .select({ id: timeLogs.id })
      .from(timeLogs)
      .where(eq(timeLogs.rapportinoId, rapportinoFirmatoId));
    expect(bloccate).toHaveLength(0);
  });

  it('dopo lo sblocco il PATCH sulle ore passa (200)', async () => {
    const [riga] = await db
      .select({ id: timeLogs.id })
      .from(timeLogs)
      .where(and(eq(timeLogs.companyId, companyId), eq(timeLogs.date, ALTRA_DATA)))
      .orderBy(asc(timeLogs.createdAt))
      .limit(1);

    const res = await request(app)
      .patch(`/api/v1/time-logs/${riga.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ notes: 'corretta dopo sblocco' });
    expect(res.status).toBe(200);
  });

  it('lo sblocco lascia una voce di audit', async () => {
    const righe = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.companyId, companyId), eq(auditLog.entityId, rapportinoFirmatoId)))
      .orderBy(asc(auditLog.timestamp));
    expect(righe.length).toBeGreaterThan(0);
    expect(righe[0].entityType).toBe('rapportino');
    expect(righe[0].userId).toBe(adminId);
    expect((righe[0].changesJson as { sbloccato?: boolean }).sbloccato).toBe(true);
  });

  it('sbloccare un rapportino non firmato -> 409', async () => {
    const [inFirma] = await db
      .select({ id: rapportini.id })
      .from(rapportini)
      .where(and(eq(rapportini.companyId, companyId), eq(rapportini.date, DATA_LAVORI), eq(rapportini.status, 'in_firma')))
      .orderBy(asc(rapportini.createdAt))
      .limit(1);

    const res = await request(app)
      .post(`/api/v1/rapportini/${inFirma.id}/sblocca`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'prova' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/v1/rapportini/:id/annulla', () => {
  it('annullare un rapportino in firma libera le sue ore e lascia una voce di audit', async () => {
    const [inFirma] = await db
      .select({ id: rapportini.id })
      .from(rapportini)
      .where(and(eq(rapportini.companyId, companyId), eq(rapportini.date, DATA_LAVORI), eq(rapportini.status, 'in_firma')))
      .orderBy(asc(rapportini.createdAt))
      .limit(1);

    const res = await request(app)
      .post(`/api/v1/rapportini/${inFirma.id}/annulla`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Il cliente non era in cantiere' });
    expect(res.status).toBe(200);
    expect(res.body.rapportino.status).toBe('annullato');

    const ancoraBloccate = await db
      .select({ id: timeLogs.id })
      .from(timeLogs)
      .where(eq(timeLogs.rapportinoId, inFirma.id));
    expect(ancoraBloccate).toHaveLength(0);

    // Creare un rapportino blocca le ore dell'intera giornata di tutta la squadra: senza
    // traccia, creare e annullare in ciclo sarebbe un modo per tenere quelle ore
    // inutilizzabili senza lasciare alcun segno di chi l'ha fatto.
    const righe = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.companyId, companyId), eq(auditLog.entityId, inFirma.id)))
      .orderBy(asc(auditLog.timestamp));
    expect(righe).toHaveLength(1);
    expect(righe[0].entityType).toBe('rapportino');
    expect(righe[0].userId).toBe(adminId);
    expect((righe[0].changesJson as { annullato?: boolean }).annullato).toBe(true);
    expect((righe[0].changesJson as { motivo?: string }).motivo).toBe('Il cliente non era in cantiere');
  });
});

describe('GET /api/v1/rapportini (elenco)', () => {
  it('un operaio non accede all\'elenco di azienda (403)', async () => {
    const res = await request(app).get('/api/v1/rapportini').set('Authorization', `Bearer ${operaioToken}`);
    expect(res.status).toBe(403);
  });

  it("l'elenco NON trascina snapshot e firma su ogni riga", async () => {
    const res = await request(app)
      .get(`/api/v1/rapportini?projectId=${projectId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.rapportini.length).toBeGreaterThan(0);
    for (const riga of res.body.rapportini) {
      expect(riga.snapshot).toBeUndefined();
      expect(riga.signaturePng).toBeUndefined();
    }
  });

  it('filtra per stato', async () => {
    const res = await request(app)
      .get('/api/v1/rapportini?status=firmato')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.rapportini.every((r: { status: string }) => r.status === 'firmato')).toBe(true);
  });
});

describe('POST /api/v1/rapportini/:id/reinvia-email', () => {
  let rapportinoOperaioId: string;

  beforeAll(async () => {
    // Preparato DALL'OPERAIO: è il caso in cui assertPuoGestirlo lo lascia passare, cioè
    // quello in cui la scelta libera del destinatario sarebbe un'esfiltrazione.
    const esito = await preparaFirmato(DATA_REINVIO);
    rapportinoOperaioId = esito.rapportinoId;
  });

  it('non riapre la firma e dice la verità sull\'esito dell\'invio', async () => {
    const res = await request(app)
      .post(`/api/v1/rapportini/${rapportinoOperaioId}/reinvia-email`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'altro-indirizzo@test.local' });
    expect(res.status).toBe(200);
    expect(res.body.destinatario).toBe('altro-indirizzo@test.local');
    // Il doppio di core/mail dichiara un invio non riuscito: mai affermare il contrario.
    expect(res.body.emailInviata).toBe(false);

    const row = await leggiRapportino(rapportinoOperaioId);
    expect(row.status).toBe('firmato');
  });

  it("un operaio NON può dirottare il documento firmato su un indirizzo scelto da lui (403)", async () => {
    const res = await request(app)
      .post(`/api/v1/rapportini/${rapportinoOperaioId}/reinvia-email`)
      .set('Authorization', `Bearer ${operaioToken}`)
      .send({ email: 'indirizzo-dell-operaio@test.local' });
    expect(res.status).toBe(403);
    // Nessun invio tentato: il rifiuto precede la generazione del PDF e l'invio.
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("lo stesso operaio può però rispedirlo al firmatario originale (200)", async () => {
    const res = await request(app)
      .post(`/api/v1/rapportini/${rapportinoOperaioId}/reinvia-email`)
      .set('Authorization', `Bearer ${operaioToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.destinatario).toBe('cliente@test.local');
  });

  it("l'invio riuscito viene registrato per quello che è", async () => {
    sendEmailMock.mockResolvedValueOnce({ sent: true });
    const res = await request(app)
      .post(`/api/v1/rapportini/${rapportinoOperaioId}/reinvia-email`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.emailInviata).toBe(true);

    const row = await leggiRapportino(rapportinoOperaioId);
    expect(row.emailSentAt).not.toBeNull();
    expect(row.emailLastError).toBeNull();
  });

  it('ogni rinvio lascia una voce di audit con destinatario e autore', async () => {
    const righe = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.companyId, companyId), eq(auditLog.entityId, rapportinoOperaioId)))
      .orderBy(asc(auditLog.timestamp));

    const esportazioni = righe.filter((r) => r.action === 'EXPORT');
    expect(esportazioni.length).toBeGreaterThanOrEqual(3);
    expect(esportazioni[0].entityType).toBe('rapportino');
    expect((esportazioni[0].changesJson as { destinatario?: string }).destinatario).toBe(
      'altro-indirizzo@test.local',
    );
    expect(esportazioni[0].userId).toBe(adminId);
    // Il rinvio fatto dall'operaio è attribuito a lui, non a chi ha creato il documento.
    expect(esportazioni[1].userId).toBe(operaioId);
  });

  it('rinviare un rapportino non firmato -> 409', async () => {
    const [annullato] = await db
      .select({ id: rapportini.id })
      .from(rapportini)
      .where(and(eq(rapportini.companyId, companyId), eq(rapportini.status, 'annullato')))
      .orderBy(asc(rapportini.createdAt))
      .limit(1);

    const res = await request(app)
      .post(`/api/v1/rapportini/${annullato.id}/reinvia-email`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(409);
  });
});

describe('Un operaio sul rapportino di un COLLEGA della stessa azienda', () => {
  let rapportinoDelCollegaId: string;

  beforeAll(async () => {
    // Preparato da altroOperaio; chi tenta di toccarlo è operaio: stessa azienda, ma non
    // è il preparatore e non è un manager.
    await inserisciOre(DATA_COLLEGA, altroOperaioId, '5');
    const creato = await creaRapportino(altroOperaioToken, DATA_COLLEGA);
    rapportinoDelCollegaId = creato.body.rapportino.id;
  });

  it('non può leggerlo (403)', async () => {
    const res = await request(app)
      .get(`/api/v1/rapportini/${rapportinoDelCollegaId}`)
      .set('Authorization', `Bearer ${operaioToken}`);
    expect(res.status).toBe(403);
  });

  it('non può scaricarne il PDF (403)', async () => {
    const res = await request(app)
      .get(`/api/v1/rapportini/${rapportinoDelCollegaId}/pdf`)
      .set('Authorization', `Bearer ${operaioToken}`);
    expect(res.status).toBe(403);
  });

  it('non può annullarlo (403), e il rapportino resta in firma', async () => {
    const res = await request(app)
      .post(`/api/v1/rapportini/${rapportinoDelCollegaId}/annulla`)
      .set('Authorization', `Bearer ${operaioToken}`)
      .send({ reason: 'tentativo' });
    expect(res.status).toBe(403);

    const row = await leggiRapportino(rapportinoDelCollegaId);
    expect(row.status).toBe('in_firma');
  });

  it('non può rinviarne l\'email (403)', async () => {
    const res = await request(app)
      .post(`/api/v1/rapportini/${rapportinoDelCollegaId}/reinvia-email`)
      .set('Authorization', `Bearer ${operaioToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('non può sbloccarlo (403: la rotta è riservata agli admin)', async () => {
    const res = await request(app)
      .post(`/api/v1/rapportini/${rapportinoDelCollegaId}/sblocca`)
      .set('Authorization', `Bearer ${operaioToken}`)
      .send({ reason: 'tentativo' });
    expect(res.status).toBe(403);
  });

  it('il preparatore, invece, lo legge e lo annulla (è suo)', async () => {
    const lettura = await request(app)
      .get(`/api/v1/rapportini/${rapportinoDelCollegaId}`)
      .set('Authorization', `Bearer ${altroOperaioToken}`);
    expect(lettura.status).toBe(200);

    const annulla = await request(app)
      .post(`/api/v1/rapportini/${rapportinoDelCollegaId}/annulla`)
      .set('Authorization', `Bearer ${altroOperaioToken}`)
      .send({ reason: 'ci ho ripensato' });
    expect(annulla.status).toBe(200);
  });
});

describe('Il ramo di conflitto sul vincolo UNIQUE passa dal SERVICE, non da una insert diretta', () => {
  it("un rapportino 'in_firma' rimasto senza ore agganciate produce comunque un 409 pulito", async () => {
    await inserisciOre(DATA_VINCOLO_UNICO, operaioId, '6');
    const primo = await creaRapportino(operaioToken, DATA_VINCOLO_UNICO);
    expect(primo.status).toBe(201);

    // Si sgancia il lucchetto lasciando la riga 'in_firma': è l'incoerenza contro cui
    // l'indice parziale è "l'ultima difesa". Senza questo passaggio il service si
    // fermerebbe prima, al controllo sulle ore già bloccate, e il ramo che traduce la
    // violazione UNIQUE in un 409 non verrebbe mai eseguito da nessun test.
    await db
      .update(timeLogs)
      .set({ rapportinoId: null })
      .where(eq(timeLogs.rapportinoId, primo.body.rapportino.id));

    const secondo = await creaRapportino(operaioToken, DATA_VINCOLO_UNICO);
    expect(secondo.status).toBe(409);
    // Il messaggio è quello del vincolo giusto: scelto per NOME del vincolo, non dedotto
    // dal solo codice 23505 (che vale anche per il progressivo di revisione).
    expect(secondo.body.error.message).toContain('già un rapportino in attesa di firma');
  });
});

describe('Concorrenza reale', () => {
  it('N creazioni simultanee sullo stesso cantiere/giorno: una sola passa, una sola riga a database', async () => {
    await inserisciOre(DATA_CONCORRENZA_CREATE, operaioId, '6');

    const esiti = await Promise.all(
      Array.from({ length: 4 }, () => creaRapportino(operaioToken, DATA_CONCORRENZA_CREATE)),
    );
    const stati = esiti.map((r) => r.status);

    expect(stati.filter((s) => s === 201)).toHaveLength(1);
    expect(stati.filter((s) => s === 409)).toHaveLength(3);
    // Nessuna deve degenerare in un errore di sistema: un conflitto è una risposta
    // prevista, non un guasto.
    expect(stati.filter((s) => s >= 500)).toHaveLength(0);

    const righe = await db
      .select({ id: rapportini.id })
      .from(rapportini)
      .where(and(eq(rapportini.projectId, projectId), eq(rapportini.date, DATA_CONCORRENZA_CREATE)));
    expect(righe).toHaveLength(1);
  });

  it('N firme simultanee con lo STESSO token: una sola vale, le altre ricevono il 401 generico', async () => {
    await inserisciOre(DATA_CONCORRENZA_FIRMA, operaioId, '6');
    const creato = await creaRapportino(operaioToken, DATA_CONCORRENZA_FIRMA);
    const token: string = creato.body.signingToken;

    const esiti = await Promise.all(Array.from({ length: 4 }, () => firma(token)));
    const stati = esiti.map((r) => r.status);

    expect(stati.filter((s) => s === 200)).toHaveLength(1);
    expect(stati.filter((s) => s === 401)).toHaveLength(3);
    expect(stati.filter((s) => s >= 500)).toHaveLength(0);

    const row = await leggiRapportino(creato.body.rapportino.id);
    expect(row.status).toBe('firmato');
    expect(row.signedAt).not.toBeNull();
    // Una sola firma è stata registrata, quindi una sola email è stata composta.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('una PATCH che corre insieme a una creazione non lascia divergenza tra snapshot e database', async () => {
    await inserisciOre(DATA_RACE_INVARIANTE, operaioId, '6');
    // Riga su un ALTRO giorno, che la PATCH prova a spostare dentro quello del rapportino
    // mentre il rapportino viene preparato: è il caso che il primo lock (su predicato) non
    // copre, perché quella riga non appartiene ancora al giorno bloccato. Intestata a un
    // altro operaio per non incrociare il tetto di 8h ordinarie al giorno per persona.
    const rigaDaSpostare = await inserisciOre('2026-09-12', altroOperaioId, '2');

    const [creazione, patch] = await Promise.all([
      creaRapportino(operaioToken, DATA_RACE_INVARIANTE),
      request(app)
        .patch(`/api/v1/time-logs/${rigaDaSpostare}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ date: DATA_RACE_INVARIANTE }),
    ]);

    expect(creazione.status).toBeLessThan(500);
    expect(patch.status).toBeLessThan(500);

    // L'invariante che conta: se il rapportino è nato, le ore che il database gli
    // attribuisce sono ESATTAMENTE quelle che il cliente vedrebbe nello snapshot. Mai una
    // riga bloccata che non compare nel documento, mai una riga nel documento lasciata
    // libera di cambiare.
    if (creazione.status === 201) {
      const idNelloSnapshot = (creazione.body.rapportino.snapshot as RapportinoSnapshot).righe
        .map((r) => r.timeLogId)
        .sort();
      const bloccate = await db
        .select({ id: timeLogs.id })
        .from(timeLogs)
        .where(eq(timeLogs.rapportinoId, creazione.body.rapportino.id));
      expect(bloccate.map((r) => r.id).sort()).toEqual(idNelloSnapshot);
    }
  });

  // Il deadlock che questo test riproduce è stato osservato dal vivo su Postgres reale:
  //   ERROR: deadlock detected
  //   CONTEXT: while locking tuple in relation "companies"
  //   SQL statement "SELECT 1 FROM ONLY "public"."companies" x WHERE "id" = $1
  //                  FOR KEY SHARE OF x"
  // Meccanismo: createRapportino prendeva `companies FOR UPDATE` come PRIMA istruzione e
  // poi aspettava le righe di time_logs; updateTimeLog tiene la riga di time_logs e,
  // inserendo in time_log_materials, fa scattare il controllo della foreign key verso
  // companies, che prende FOR KEY SHARE — e FOR KEY SHARE confligge con FOR UPDATE.
  // Ciclo chiuso. La correzione è l'ordine dei lock dichiarato in createRapportino
  // (projects -> time_logs -> companies): companies è ora l'ULTIMO lock.
  //
  // L'interleaving NON è affidato al caso (due richieste HTTP in parallelo lo colgono solo
  // per fortuna, ed è il motivo per cui 287 test verdi convivevano col difetto): qui la
  // transazione della PATCH è pilotata a mano, un'istruzione alla volta, e la creazione
  // parte solo dopo che la riga delle ore è già bloccata.
  it('creazione del rapportino e modifica delle ore con materiali non si bloccano a vicenda (deadlock companies/time_logs)', async () => {
    const timeLogId = await inserisciOre(DATA_DEADLOCK, operaioId, '6');

    let creazione: ReturnType<typeof creaRapportino> | undefined;
    let erroreDellaPatch: unknown;
    try {
      await db.transaction(async (tx) => {
        // 1. La PATCH prende la riga delle ore: è la prima istruzione di updateTimeLog.
        await tx.select({ id: timeLogs.id }).from(timeLogs).where(eq(timeLogs.id, timeLogId)).for('update');

        // 2. La creazione parte adesso e va a sbattere su quella riga bloccata.
        creazione = creaRapportino(operaioToken, DATA_DEADLOCK);
        await attendiUnBackendInAttesaDiLock();

        // 3. La PATCH inserisce i materiali: la FK di time_log_materials verso companies
        //    chiede FOR KEY SHARE sulla riga dell'azienda. Prima della correzione era qui
        //    che Postgres rispondeva "deadlock detected".
        await tx
          .insert(timeLogMaterials)
          .values({ companyId, timeLogId, name: 'Cavo', quantity: '12.000', unit: 'm', code: null });
      });
    } catch (err) {
      erroreDellaPatch = err;
    }

    // La creazione viene sempre attesa, anche se la PATCH è fallita: lasciarla pendente
    // significherebbe una promise non gestita e una connessione ancora occupata.
    const esitoCreazione = creazione ? await creazione : undefined;

    // Messaggio per esteso e non un toBeUndefined(): quando fallisce, il testo del
    // deadlock è l'informazione che serve a chi legge il rapporto dei test.
    expect(erroreDellaPatch ? String(erroreDellaPatch) : null).toBeNull();
    expect(esitoCreazione?.status).toBe(201);
  });
});

describe('Rilevamento della modifica concorrente (il confronto fra i due snapshot)', () => {
  it('due letture consecutive dello stesso giorno danno lo stesso hash: nessun rifiuto immotivato', async () => {
    await inserisciOre(DATA_RACE_TARGET, operaioId, '6');

    const primo = await request(app)
      .get(`/api/v1/rapportini/anteprima?projectId=${projectId}&date=${DATA_RACE_TARGET}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const secondo = await request(app)
      .get(`/api/v1/rapportini/anteprima?projectId=${projectId}&date=${DATA_RACE_TARGET}`)
      .set('Authorization', `Bearer ${adminToken}`);

    // Se il confronto producesse falsi positivi, createRapportino rifiuterebbe OGNI
    // creazione: questa è la metà della verifica che protegge dal rimedio peggiore del male.
    expect(hashSnapshot(conPreparatoIlFisso(primo.body.anteprima))).toBe(
      hashSnapshot(conPreparatoIlFisso(secondo.body.anteprima)),
    );
  });

  it("una riga spostata dentro il giorno cambia l'hash: è il confronto che fa scattare il rifiuto", async () => {
    const prima = await request(app)
      .get(`/api/v1/rapportini/anteprima?projectId=${projectId}&date=${DATA_RACE_TARGET}`)
      .set('Authorization', `Bearer ${adminToken}`);

    // Riga di un altro giorno spostata dentro DATA_RACE_TARGET: esattamente la mutazione
    // che il lock su predicato non può impedire, perché quella riga non era nell'insieme
    // bloccato. È la ragione per cui createRapportino ricostruisce e riconfronta.
    // Intestata a un ALTRO operaio: il tetto di 8h ordinarie al giorno è per persona, e
    // sommarla a chi ha già 6h su quel giorno farebbe fallire la PATCH per un motivo
    // (il tetto) che con questa verifica non c'entra nulla.
    const daSpostare = await inserisciOre('2026-09-22', altroOperaioId, '3');
    const patch = await request(app)
      .patch(`/api/v1/time-logs/${daSpostare}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ date: DATA_RACE_TARGET });
    expect(patch.status).toBe(200);

    const dopo = await request(app)
      .get(`/api/v1/rapportini/anteprima?projectId=${projectId}&date=${DATA_RACE_TARGET}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(hashSnapshot(conPreparatoIlFisso(prima.body.anteprima))).not.toBe(
      hashSnapshot(conPreparatoIlFisso(dopo.body.anteprima)),
    );
    // E la riga spostata è davvero entrata nel giorno: senza questo, l'hash diverso
    // potrebbe dipendere da tutt'altro.
    expect((dopo.body.anteprima as RapportinoSnapshot).righe.map((r) => r.timeLogId)).toContain(daSpostare);
  });
});

describe('Isolamento multi-tenant', () => {
  let altraCompanyId: string;
  let altroAdminToken: string;
  let rapportinoAltruiVisibile: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);
    const [altraCompany] = await db.insert(companies).values({ name: 'AltraCoRapportini' }).returning();
    altraCompanyId = altraCompany.id;
    const [altroAdmin] = await db
      .insert(users)
      .values({ email: 'rapportini-altro-admin@workflow360.local', passwordHash, name: 'Admin Altro', role: 'admin', companyId: altraCompanyId })
      .returning();
    altroAdminToken = signAccessToken({ id: altroAdmin.id, email: altroAdmin.email, role: 'admin', companyId: altraCompanyId });

    // Un rapportino FIRMATO dell'azienda A: così ogni endpoint d'azione (annulla, sblocca,
    // pdf, reinvia) ha uno stato in cui, se non fosse per il filtro sull'azienda,
    // risponderebbe qualcosa di diverso da un 404.
    const esito = await preparaFirmato(DATA_CROSS_TENANT);
    rapportinoAltruiVisibile = esito.rapportinoId;
  });

  // Questa azienda resta deliberatamente SENZA rapportini propri: il test dell'elenco qui
  // sotto pretende una lista vuota, ed è l'unico modo di dimostrare che non vede quelli
  // dell'altra azienda. La verifica del progressivo per azienda vive quindi in un blocco
  // a parte, con un'azienda tutta sua.
  afterAll(async () => {
    await db.delete(users).where(eq(users.companyId, altraCompanyId)).catch(() => {});
    await db.delete(companies).where(eq(companies.id, altraCompanyId)).catch(() => {});
  });

  it("un admin di un'altra azienda non vede il rapportino (404, non 403)", async () => {
    const res = await request(app)
      .get(`/api/v1/rapportini/${rapportinoAltruiVisibile}`)
      .set('Authorization', `Bearer ${altroAdminToken}`);
    expect(res.status).toBe(404);
  });

  it("un admin di un'altra azienda non lo vede nemmeno nell'elenco", async () => {
    const res = await request(app).get('/api/v1/rapportini').set('Authorization', `Bearer ${altroAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.rapportini).toHaveLength(0);
  });

  it('nemmeno gli endpoint di AZIONE attraversano il confine: 404 su ognuno, riga intatta', async () => {
    const prima = await leggiRapportino(rapportinoAltruiVisibile);

    const azioni = await Promise.all([
      request(app)
        .post(`/api/v1/rapportini/${rapportinoAltruiVisibile}/annulla`)
        .set('Authorization', `Bearer ${altroAdminToken}`)
        .send({ reason: 'tentativo da altra azienda' }),
      request(app)
        .post(`/api/v1/rapportini/${rapportinoAltruiVisibile}/sblocca`)
        .set('Authorization', `Bearer ${altroAdminToken}`)
        .send({ reason: 'tentativo da altra azienda' }),
      request(app)
        .get(`/api/v1/rapportini/${rapportinoAltruiVisibile}/pdf`)
        .set('Authorization', `Bearer ${altroAdminToken}`),
      request(app)
        .post(`/api/v1/rapportini/${rapportinoAltruiVisibile}/reinvia-email`)
        .set('Authorization', `Bearer ${altroAdminToken}`)
        .send({ email: 'esfiltrazione@altra-azienda.local' }),
    ]);

    for (const azione of azioni) {
      expect(azione.status).toBe(404);
    }
    // Nessun invio partito verso l'azienda che ha provato a rispedirselo.
    expect(sendEmailMock).not.toHaveBeenCalled();

    const dopo = await leggiRapportino(rapportinoAltruiVisibile);
    expect(dopo.status).toBe(prima.status);
    expect(dopo.unlockedAt).toBeNull();
    expect(dopo.cancelReason).toBeNull();
    expect(dopo.signerEmail).toBe(prima.signerEmail);
  });
});

// Il numero è progressivo PER AZIENDA ed è quindi CONDIVISO da tutti i test di questo
// file, che lavorano su una sola azienda: le asserzioni qui sono sempre RELATIVE
// ("il secondo vale il primo più uno"), mai assolute. Un `=== 1` diventerebbe falso il
// giorno in cui qualcuno aggiunge un test che crea un rapportino più in alto nel file.
describe('N° progressivo del rapportino', () => {
  it('ogni rapportino nasce con un numero, e due creazioni consecutive danno n e n+1', async () => {
    await inserisciOre(DATA_NUMERO_PRIMO, operaioId, '5');
    const primo = await creaRapportino(operaioToken, DATA_NUMERO_PRIMO);
    expect(primo.status).toBe(201);
    expect(typeof primo.body.rapportino.numero).toBe('number');

    await inserisciOre(DATA_NUMERO_SECONDO, operaioId, '5');
    const secondo = await creaRapportino(operaioToken, DATA_NUMERO_SECONDO);
    expect(secondo.status).toBe(201);
    expect(secondo.body.rapportino.numero).toBe(primo.body.rapportino.numero + 1);
  });

  it('un rapportino annullato CONSUMA il suo numero: il successivo non lo riusa', async () => {
    await inserisciOre(DATA_NUMERO_ANNULLATO, operaioId, '5');
    const primo = await creaRapportino(operaioToken, DATA_NUMERO_ANNULLATO);
    expect(primo.status).toBe(201);
    const numeroAnnullato: number = primo.body.rapportino.numero;

    const annulla = await request(app)
      .post(`/api/v1/rapportini/${primo.body.rapportino.id}/annulla`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Cliente assente' });
    expect(annulla.status).toBe(200);

    // Stesso cantiere e stesso giorno: è la revisione 2 di quel giorno, ma un numero
    // NUOVO nella numerazione dell'azienda — come una pagina strappata dal blocco, che
    // non torna disponibile.
    const secondo = await creaRapportino(operaioToken, DATA_NUMERO_ANNULLATO);
    expect(secondo.status).toBe(201);
    expect(secondo.body.rapportino.revision).toBe(2);
    expect(secondo.body.rapportino.numero).toBe(numeroAnnullato + 1);

    const riga = await leggiRapportino(primo.body.rapportino.id);
    expect(riga.numero).toBe(numeroAnnullato);
    expect(riga.status).toBe('annullato');
  });

  it("il numero compare anche nell'ELENCO, che ha una proiezione di colonne scritta a mano", async () => {
    await inserisciOre(DATA_NUMERO_ELENCO, operaioId, '5');
    const creato = await creaRapportino(operaioToken, DATA_NUMERO_ELENCO);
    expect(creato.status).toBe(201);

    const elenco = await request(app)
      .get(`/api/v1/rapportini?date=${DATA_NUMERO_ELENCO}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(elenco.status).toBe(200);

    // listRapportini elenca le colonne una per una (per non trascinare snapshot e firma
    // in ogni riga dell'elenco): una colonna nuova va aggiunta a mano lì, e dimenticarla
    // non produce nessun errore — solo un campo `undefined` nella risposta.
    const riga = elenco.body.rapportini.find((r: { id: string }) => r.id === creato.body.rapportino.id);
    expect(riga).toBeDefined();
    expect(riga.numero).toBe(creato.body.rapportino.numero);
  });

  it('N creazioni simultanee nella stessa azienda: nessun numero duplicato e nessun buco', async () => {
    // Giorni DIVERSI, a differenza del test di concorrenza sullo stesso cantiere/giorno
    // (dove per costruzione ne passa una sola): qui devono riuscire TUTTE, ed è l'unico
    // modo di mettere alla prova il calcolo di MAX(numero)+1 sotto contesa reale.
    for (const data of DATE_NUMERO_CONCORRENTI) {
      await inserisciOre(data, operaioId, '5');
    }

    const esiti = await Promise.all(DATE_NUMERO_CONCORRENTI.map((data) => creaRapportino(operaioToken, data)));
    expect(esiti.map((r) => r.status)).toEqual([201, 201, 201, 201]);

    const numeri: number[] = esiti.map((r) => r.body.rapportino.numero);
    expect(new Set(numeri).size).toBe(DATE_NUMERO_CONCORRENTI.length);
    const ordinati = [...numeri].sort((a, b) => a - b);
    for (let i = 1; i < ordinati.length; i++) {
      expect(ordinati[i]).toBe(ordinati[i - 1] + 1);
    }
  });
});

// Azienda tutta sua, e non quella del blocco "Isolamento multi-tenant": là l'azienda deve
// restare senza rapportini propri, perché un test pretende che il suo elenco sia VUOTO.
describe('Il progressivo è per azienda, non globale', () => {
  let terzaCompanyId: string;
  let terzoAdminToken: string;
  let terzoProjectId: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);
    const [company] = await db.insert(companies).values({ name: 'TerzaCoRapportini' }).returning();
    terzaCompanyId = company.id;
    const [admin] = await db
      .insert(users)
      .values({ email: 'rapportini-terzo-admin@workflow360.local', passwordHash, name: 'Admin Terzo', role: 'admin', companyId: terzaCompanyId })
      .returning();
    terzoAdminToken = signAccessToken({ id: admin.id, email: admin.email, role: 'admin', companyId: terzaCompanyId });

    const [project] = await db
      .insert(projects)
      .values({ name: 'Cantiere Terza', companyId: terzaCompanyId, projectNumber: 1, tipoCommessa: 'consuntivo' })
      .returning();
    const [task] = await db
      .insert(tasks)
      .values({ projectId: project.id, title: 'Lavoro terzo', companyId: terzaCompanyId })
      .returning();
    await db.insert(timeLogs).values({
      companyId: terzaCompanyId,
      taskId: task.id,
      userId: admin.id,
      tipo: 'ordinario',
      hoursWorked: '5',
      date: DATA_LAVORI,
      startTime: '08:00',
    });
    terzoProjectId = project.id;
  });

  // Ordine obbligato dalle foreign key, lo stesso dell'afterAll principale: rapportini ha
  // RESTRICT verso projects e users e va quindi svuotata per prima.
  afterAll(async () => {
    await db.delete(rapportini).where(eq(rapportini.companyId, terzaCompanyId)).catch(() => {});
    await db.delete(timeLogs).where(eq(timeLogs.companyId, terzaCompanyId)).catch(() => {});
    await db.delete(tasks).where(eq(tasks.companyId, terzaCompanyId)).catch(() => {});
    await db.delete(projects).where(eq(projects.companyId, terzaCompanyId)).catch(() => {});
    await db.delete(users).where(eq(users.companyId, terzaCompanyId)).catch(() => {});
    await db.delete(companies).where(eq(companies.id, terzaCompanyId)).catch(() => {});
  });

  it("il primo rapportino di un'azienda nuova parte da 1, non dal seguito della numerazione altrui", async () => {
    const res = await request(app)
      .post('/api/v1/rapportini')
      .set('Authorization', `Bearer ${terzoAdminToken}`)
      .send({ projectId: terzoProjectId, date: DATA_LAVORI });

    expect(res.status).toBe(201);
    // Asserzione ASSOLUTA, e qui si può: è l'unico rapportino di questa azienda. Altrove
    // nel file i numeri sono condivisi da tutti i test e si confrontano solo differenze.
    expect(res.body.rapportino.numero).toBe(1);
  });
});

describe('Destinazione del cantiere e codice dei materiali', () => {
  let projectDestinazioneId: string;
  let taskDestinazioneId: string;
  let aggregato: { nome: string; quantita: string; unita: string; codice: string | null }[];

  beforeAll(async () => {
    const [project] = await db
      .insert(projects)
      .values({
        name: 'Cantiere con Destinazione',
        companyId,
        projectNumber: 3,
        code: 'RAP-DEST',
        tipoCommessa: 'consuntivo',
        clientName: 'Cinema Arena',
        address: 'Via delle Prove 42, Testville',
      })
      .returning();
    projectDestinazioneId = project.id;
    const [task] = await db
      .insert(tasks)
      .values({ projectId: projectDestinazioneId, title: 'Impianto elettrico', companyId })
      .returning();
    taskDestinazioneId = task.id;

    // Un solo rapportino che contiene tutti e tre i casi di aggregazione: stesso codice,
    // codici diversi, uno col codice e uno senza.
    const timeLogId = await inserisciOre(DATA_CODICI_AGGREGATO, operaioId, '6', taskDestinazioneId);
    await inserisciMateriale(timeLogId, 'Cavo', '3', 'm', 'C-1');
    await inserisciMateriale(timeLogId, 'Cavo', '2', 'm', 'C-1');
    await inserisciMateriale(timeLogId, 'Tubo', '1', 'pz', 'T-1');
    await inserisciMateriale(timeLogId, 'Tubo', '1', 'pz', 'T-2');
    await inserisciMateriale(timeLogId, 'Vite', '4', 'pz', null);
    await inserisciMateriale(timeLogId, 'Vite', '4', 'pz', 'V-1');

    const creato = await creaRapportino(operaioToken, DATA_CODICI_AGGREGATO, projectDestinazioneId);
    expect(creato.status).toBe(201);
    aggregato = (creato.body.rapportino.snapshot as RapportinoSnapshot).totali.materiali as typeof aggregato;
  });

  it("l'indirizzo del cantiere finisce nello snapshot come `cantiere.indirizzo`", async () => {
    await inserisciOre(DATA_DESTINAZIONE, operaioId, '4', taskDestinazioneId);
    const res = await request(app)
      .get(`/api/v1/rapportini/anteprima?projectId=${projectDestinazioneId}&date=${DATA_DESTINAZIONE}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.anteprima.cantiere.indirizzo).toBe('Via delle Prove 42, Testville');
  });

  it('un cantiere senza indirizzo dà `indirizzo: null`, non una chiave assente', async () => {
    await inserisciOre(DATA_SENZA_DESTINAZIONE, operaioId, '4');
    const res = await request(app)
      .get(`/api/v1/rapportini/anteprima?projectId=${projectId}&date=${DATA_SENZA_DESTINAZIONE}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    // La chiave DEVE esserci: valorizzarla sempre, anche a null, è ciò che tiene una sola
    // forma di JSON per tutti i documenti nuovi — e quindi un hash calcolato su una
    // struttura sola.
    expect(res.body.anteprima.cantiere).toHaveProperty('indirizzo');
    expect(res.body.anteprima.cantiere.indirizzo).toBeNull();
  });

  it('il codice del materiale finisce nella riga dello snapshot', async () => {
    const timeLogId = await inserisciOre(DATA_CODICI_RIGHE, operaioId, '4', taskDestinazioneId);
    await inserisciMateriale(timeLogId, 'Faretto LED', '2', 'pz', 'FL-220');

    const res = await request(app)
      .get(`/api/v1/rapportini/anteprima?projectId=${projectDestinazioneId}&date=${DATA_CODICI_RIGHE}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const materiali = (res.body.anteprima as RapportinoSnapshot).righe[0].materiali;
    expect(materiali).toHaveLength(1);
    expect(materiali[0].codice).toBe('FL-220');
  });

  it('stesso nome, stessa unità e STESSO codice: una voce sola, sommata', async () => {
    const cavi = aggregato.filter((m) => m.nome === 'Cavo');
    expect(cavi).toHaveLength(1);
    expect(cavi[0].quantita).toBe('5');
    expect(cavi[0].codice).toBe('C-1');
  });

  it('codici DIVERSI non si sommano: due voci distinte, ognuna col proprio codice', async () => {
    const tubi = aggregato.filter((m) => m.nome === 'Tubo');
    expect(tubi).toHaveLength(2);
    // Confronto SENZA riordinare: l'ordine dei materiali aggregati è parte del contratto
    // (nome, poi unità, poi codice) perché l'hash dello snapshot viene calcolato due volte
    // e confrontato — un ordine instabile farebbe fallire ogni creazione.
    expect(tubi.map((m) => m.codice)).toEqual(['T-1', 'T-2']);
    // Nessuna delle due porta la quantità dell'altra: sommandole si otterrebbe "2 pz di
    // un codice" che nessuno ha mai usato.
    expect(tubi.every((m) => m.quantita === '1')).toBe(true);
  });

  it('uno col codice e uno senza restano DUE voci: l\'anomalia si vede, invece di fondersi in silenzio', async () => {
    const viti = aggregato.filter((m) => m.nome === 'Vite');
    expect(viti).toHaveLength(2);
    // La voce senza codice viene prima: nell'ordinamento il codice assente vale stringa
    // vuota. Anche qui il confronto è sull'ordine reale, non su una copia riordinata.
    expect(viti.map((m) => m.codice)).toEqual([null, 'V-1']);
  });

  it('il PDF di un rapportino con destinazione e codici si genera davvero', async () => {
    const timeLogId = await inserisciOre(DATA_PDF_COMPLETO, operaioId, '7', taskDestinazioneId);
    await inserisciMateriale(timeLogId, 'Canalina', '12', 'm', 'CN-40');
    await inserisciMateriale(timeLogId, 'Morsetti', '30', 'pz', null);
    const creato = await creaRapportino(operaioToken, DATA_PDF_COMPLETO, projectDestinazioneId);
    expect(creato.status).toBe(201);

    const res = await request(app)
      .get(`/api/v1/rapportini/${creato.body.rapportino.id}/pdf`)
      .set('Authorization', `Bearer ${adminToken}`)
      .buffer(true)
      .parse((res2, cb) => {
        const parti: Buffer[] = [];
        res2.on('data', (c: Buffer) => parti.push(c));
        res2.on('end', () => cb(null, Buffer.concat(parti)));
      });

    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

// Il caso che rende obbligatorio `.nullish()` (e non `.nullable()`) nello schema Zod
// dello snapshot: un documento firmato PRIMA di questa versione non ha la chiave
// `indirizzo` né i `codice` dei materiali. Con `.nullable()` il parse fallirebbe e ogni
// lettura, PDF o rinvio email di quel documento risponderebbe 500 per sempre.
describe('Snapshot v1 riletto e ristampato', () => {
  // Id FISSI e non quelli generati dalle insert: senza, lo snapshot cambierebbe a ogni
  // corsa e non potrebbe esistere un valore d'oro dell'hash (vedi sotto). Sono id interni
  // allo snapshot, cioè copie storiche: le colonne project_id/created_by della riga
  // puntano ai record veri, e sono quelle che il servizio usa per i controlli di accesso.
  const V1_CANTIERE_ID = '00000000-0000-4000-8000-0000000000a1';
  const V1_UTENTE_ID = '00000000-0000-4000-8000-0000000000a2';

  // Snapshot nella forma v1: nessun `indirizzo` nel cantiere, nessun `codice` nei
  // materiali. Letterale e costante, per poterne fissare l'hash.
  const SNAPSHOT_V1 = {
    versione: 1,
    azienda: { nome: 'SnapshotV1Co', vat: null, indirizzo: null, email: null, telefono: null },
    cantiere: {
      id: V1_CANTIERE_ID,
      projectNumber: 1,
      code: null,
      nome: 'Cantiere V1',
      clientName: 'Vecchio Cliente',
      tipoCommessa: 'consuntivo',
    },
    date: DATA_LAVORI,
    righe: [
      {
        timeLogId: '00000000-0000-4000-8000-000000000001',
        operaio: { id: V1_UTENTE_ID, nome: 'Admin V1' },
        lavoro: { taskId: '00000000-0000-4000-8000-000000000002', titolo: 'Lavoro di allora' },
        tipo: 'ordinario',
        ore: '8.00',
        oraInizio: '08:00',
        oraFine: '17:00',
        descrizioneLavoro: 'Descrizione di allora',
        note: 'Nota di allora',
        materiali: [{ nome: 'Cemento', quantita: '10', unita: 'sacchi' }],
      },
    ],
    totali: {
      oreTotali: '8.00',
      perTipo: { ordinario: '8.00' },
      materiali: [{ nome: 'Cemento', quantita: '10', unita: 'sacchi' }],
    },
    preparatoIl: '2026-01-15T09:00:00.000Z',
    preparatoDa: { userId: V1_UTENTE_ID, nome: 'Admin V1' },
  } as RapportinoSnapshot;

  // VALORE D'ORO: lo sha256 dello snapshot qui sopra, scritto a mano e non calcolato.
  // È l'unica forma che si rompe se `hashSnapshot` cambia — la canonicalizzazione, la
  // serializzazione, l'algoritmo. Calcolarlo nel test con la funzione corrente (com'era
  // prima) è una tautologia: qualunque modifica alla funzione sposterebbe insieme il
  // valore atteso e quello osservato, e il test resterebbe verde mentre TUTTI gli hash
  // già scritti a database diventano incompatibili — cioè mentre ogni rapportino firmato
  // comincia a risultare "INTEGRITÀ VIOLATA" senza che nessuno sia mai stato alterato.
  // Ottenuto con un'implementazione indipendente (chiavi ordinate ricorsivamente + sha256
  // del JSON) e verificato che coincida con quella del servizio.
  const HASH_ORO_SNAPSHOT_V1 = '3abba56369ee19e77fb3648b968fb717909b4f08945526b06bdadcfaf515e196';

  let v1CompanyId: string;
  let v1AdminToken: string;
  let v1RapportinoId: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);
    // Azienda dedicata: il numero scritto a mano qui sotto sposterebbe il MAX della
    // numerazione e falserebbe le asserzioni relative degli altri test.
    const [company] = await db.insert(companies).values({ name: 'SnapshotV1Co' }).returning();
    v1CompanyId = company.id;
    const [admin] = await db
      .insert(users)
      .values({ email: 'rapportini-v1-admin@workflow360.local', passwordHash, name: 'Admin V1', role: 'admin', companyId: v1CompanyId })
      .returning();
    v1AdminToken = signAccessToken({ id: admin.id, email: admin.email, role: 'admin', companyId: v1CompanyId });

    const [project] = await db
      .insert(projects)
      .values({ name: 'Cantiere V1', companyId: v1CompanyId, projectNumber: 1, tipoCommessa: 'consuntivo' })
      .returning();

    const [row] = await db
      .insert(rapportini)
      .values({
        companyId: v1CompanyId,
        projectId: project.id,
        date: DATA_LAVORI,
        revision: 1,
        numero: 1,
        status: 'in_firma',
        createdBy: admin.id,
        snapshotJson: SNAPSHOT_V1,
        // Il valore d'oro scritto a mano, NON hashSnapshot(SNAPSHOT_V1): la riga a
        // database deve somigliare a una scritta mesi fa da una versione precedente del
        // codice, non a una calcolata adesso dalla versione corrente. È ciò che rende
        // sensato il controllo d'integrità che il servizio esegue a ogni lettura.
        snapshotHash: HASH_ORO_SNAPSHOT_V1,
        totalHours: '8.00',
        tokenHash: 'hash-fittizio-snapshot-v1',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    v1RapportinoId = row.id;
  });

  afterAll(async () => {
    await db.delete(rapportini).where(eq(rapportini.companyId, v1CompanyId)).catch(() => {});
    await db.delete(projects).where(eq(projects.companyId, v1CompanyId)).catch(() => {});
    await db.delete(users).where(eq(users.companyId, v1CompanyId)).catch(() => {});
    await db.delete(companies).where(eq(companies.id, v1CompanyId)).catch(() => {});
  });

  it("l'hash di uno snapshot v1 è ancora quello di allora (valore d'oro)", () => {
    expect(hashSnapshot(SNAPSHOT_V1)).toBe(HASH_ORO_SNAPSHOT_V1);
  });

  it('si legge ancora (200) nonostante le chiavi nuove non esistano', async () => {
    const res = await request(app)
      .get(`/api/v1/rapportini/${v1RapportinoId}`)
      .set('Authorization', `Bearer ${v1AdminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.rapportino.snapshot.versione).toBe(1);
    expect(res.body.rapportino.snapshot.cantiere.indirizzo).toBeUndefined();
    expect(res.body.rapportino.snapshot.totali.materiali[0].codice).toBeUndefined();
  });

  it('e si ristampa ancora: il generatore PDF regge i campi assenti', async () => {
    const res = await request(app)
      .get(`/api/v1/rapportini/${v1RapportinoId}/pdf`)
      .set('Authorization', `Bearer ${v1AdminToken}`)
      .buffer(true)
      .parse((res2, cb) => {
        const parti: Buffer[] = [];
        res2.on('data', (c: Buffer) => parti.push(c));
        res2.on('end', () => cb(null, Buffer.concat(parti)));
      });

    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  // Senza questa asserzione i due test qui sopra resterebbero verdi anche se OGNI
  // rapportino v1 venisse registrato come corrotto: verificaIntegritaSnapshot non blocca
  // la richiesta, logga e basta (per scelta — un documento firmato deve restare leggibile
  // anche se il confronto fallisce). "200 e comincia con %PDF-" non dice nulla su ciò che
  // è successo nei log, ed è proprio lì che vive l'unico segnale di corruzione.
  it("né la lettura né la stampa segnalano un'integrità violata", async () => {
    const errori = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const lettura = await request(app)
        .get(`/api/v1/rapportini/${v1RapportinoId}`)
        .set('Authorization', `Bearer ${v1AdminToken}`);
      expect(lettura.status).toBe(200);

      const stampa = await request(app)
        .get(`/api/v1/rapportini/${v1RapportinoId}/pdf`)
        .set('Authorization', `Bearer ${v1AdminToken}`)
        .buffer(true)
        .parse((res2, cb) => {
          const parti: Buffer[] = [];
          res2.on('data', (c: Buffer) => parti.push(c));
          res2.on('end', () => cb(null, Buffer.concat(parti)));
        });
      expect(stampa.status).toBe(200);

      const messaggi = errori.mock.calls.map((c) => String(c[0])).join('\n');
      expect(messaggi).not.toContain('INTEGRITÀ');
    } finally {
      errori.mockRestore();
    }
  });
});
