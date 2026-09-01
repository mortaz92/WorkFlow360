import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { and, asc, eq } from 'drizzle-orm';

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
import { auditLog, companies, projects, rapportini, tasks, timeLogs, users } from '../../core/db/schema';
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

function dataUriPng(...parti: Buffer[]): string {
  return `data:image/png;base64,${Buffer.concat([PNG_MAGIC, ...parti]).toString('base64')}`;
}

// Header PNG perfettamente valido (100x50) e NESSUN dato immagine: supera prefisso, byte
// magici, IHDR e limiti di dimensione, ma pdfkit non riesce a disegnarlo
// ("Incomplete or corrupt PNG file"). È esattamente la firma che, prima della correzione,
// faceva fallire la generazione del PDF DOPO che la firma era già stata registrata.
const FIRMA_PNG_CORROTTA = dataUriPng(chunkIhdr(100, 50));

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
    expect(res.body.anteprima.versione).toBe(1);
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
  // PNG "grande" ma STRUTTURALMENTE valido (header IHDR corretto + riempimento): supera
  // la validazione di forma e serve solo a misurare il body parser — la richiesta viene
  // poi respinta dal token inesistente, quindi non arriva mai al generatore PDF.
  const pngGrande = dataUriPng(chunkIhdr(100, 50), Buffer.alloc(200 * 1024));

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
