import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../../app';
import { db } from '../../core/db';
import { users, projects, tasks, timeLogs, companies, auditLog } from '../../core/db/schema';
import { signAccessToken } from '../auth/auth.service';

const app = createApp();
const BCRYPT_TEST_COST = 4;

const ADMIN_EMAIL = 'timelog-test-admin@workflow360.local';
const PM_EMAIL = 'timelog-test-pm@workflow360.local';
const RESOURCE_EMAIL = 'timelog-test-resource@workflow360.local';

let companyId: string;
let adminToken: string;
let pmToken: string;
let resourceToken: string;
let adminId: string;
let projectId: string;
let taskId: string;
let timeLogId: string;
let completedProjectTaskId: string;

const created: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);
  const [company] = await db.insert(companies).values({ name: 'TimeLogTestCo' }).returning();
  companyId = company.id;
  const [admin] = await db.insert(users).values({ email: ADMIN_EMAIL, passwordHash, name: 'Admin TL', role: 'admin', companyId }).returning();
  const [pm] = await db.insert(users).values({ email: PM_EMAIL, passwordHash, name: 'PM TL', role: 'project_manager', companyId }).returning();
  const [resource] = await db.insert(users).values({ email: RESOURCE_EMAIL, passwordHash, name: 'Resource TL', role: 'operaio', companyId }).returning();
  adminId = admin.id;

  adminToken = signAccessToken({ id: admin.id, email: admin.email, role: admin.role, companyId });
  pmToken = signAccessToken({ id: pm.id, email: pm.email, role: pm.role, companyId });
  resourceToken = signAccessToken({ id: resource.id, email: resource.email, role: resource.role, companyId });

  const [project] = await db.insert(projects).values({ name: 'Progetto per TimeLog Vitest', companyId, projectNumber: 1 }).returning();
  projectId = project.id;
  const [task] = await db.insert(tasks).values({ projectId, title: 'Task per TimeLog Vitest', companyId }).returning();
  taskId = task.id;
  created.push(projectId, taskId);

  const [completedProject] = await db
    .insert(projects)
    .values({ name: 'Progetto Chiuso per TimeLog Vitest', companyId, projectNumber: 2, status: 'completed' })
    .returning();
  const [completedProjectTask] = await db
    .insert(tasks)
    .values({ projectId: completedProject.id, title: 'Task su cantiere chiuso', companyId })
    .returning();
  completedProjectTaskId = completedProjectTask.id;
});

afterAll(async () => {
  await db.delete(timeLogs).where(eq(timeLogs.taskId, taskId)).catch(() => {});
  await db.delete(tasks).where(eq(tasks.id, taskId)).catch(() => {});
  await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
  // Cantiere chiuso creato per il test sotto (409 su nuove ore): stesso motivo del
  // commento sotto su companyId, se non lo si toglie esplicitamente il DELETE della
  // company fallisce silenziosamente per RESTRICT e la company resta orfana.
  await db.delete(tasks).where(eq(tasks.id, completedProjectTaskId)).catch(() => {});
  await db.delete(projects).where(eq(projects.name, 'Progetto Chiuso per TimeLog Vitest')).catch(() => {});
  // Per companyId, non per i 3 email fissi: il describe annidato "F2 — ruolo operaio"
  // (righe sotto) crea un quarto utente (operaio-f2@...) con il proprio afterAll che
  // dovrebbe già rimuoverlo — ma se per qualunque motivo quell'afterAll non arriva a
  // completarsi (osservato dal vivo: 23 aziende "TimeLogTestCo" accumulate nel DB di
  // sviluppo da esecuzioni passate), l'utente orfano fa fallire silenziosamente questo
  // delete della company (RESTRICT su users.company_id) dietro un `.catch(() => {})` che
  // nasconde l'errore — la company resta per sempre. Cancellare per companyId elimina
  // l'intera classe di bug: qualunque utente finisca sotto questa company di test,
  // creato oggi o da un futuro `it` aggiunto qui, viene rimosso comunque.
  await db.delete(users).where(eq(users.companyId, companyId)).catch(() => {});
  await db.delete(companies).where(eq(companies.id, companyId)).catch(() => {});
});

describe('POST /api/v1/time-logs', () => {
  it('un admin registra ore + lavoro svolto + materiali su un task', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        taskId,
        userId: adminId,
        hoursWorked: '3.5',
        date: '2026-08-08',
        startTime: '08:00',
        workDescription: 'Montaggio tubazione rame e saldatura giunti',
        materials: [
          { name: 'Tubo rame Ø22mm', quantity: '6', unit: 'm' },
          { name: 'Raccordo a T', quantity: '4', unit: 'pz' },
        ],
      });
    expect(res.status).toBe(201);
    // 08:00 + 3.5h è tutto in fascia diurna e sotto il tetto di 8h: nessuno split,
    // una sola riga "ordinario" nell'array.
    expect(res.body.timeLogs).toHaveLength(1);
    expect(res.body.timeLogs[0].hoursWorked).toBe('3.50');
    expect(res.body.timeLogs[0].workDescription).toBe('Montaggio tubazione rame e saldatura giunti');
    expect(res.body.timeLogs[0].materials).toHaveLength(2);
    expect(res.body.timeLogs[0].materials[0].name).toBe('Tubo rame Ø22mm');
    expect(Number(res.body.timeLogs[0].materials[0].quantity)).toBe(6);
    expect(res.body.timeLogs[0].materials[0].unit).toBe('m');
    timeLogId = res.body.timeLogs[0].id;
    created.push(timeLogId);
  });

  it('ore non positive -> 400', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, userId: adminId, hoursWorked: '0', date: '2026-08-08' });
    expect(res.status).toBe(400);
  });

  it('cantiere chiuso (status completed) -> 409, nessuna nuova ora', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId: completedProjectTaskId, userId: adminId, hoursWorked: '2', date: '2026-08-08' });
    expect(res.status).toBe(409);
  });

  it('task inesistente -> 404', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId: '00000000-0000-0000-0000-000000000000', userId: adminId, hoursWorked: '2', date: '2026-08-08', startTime: '08:00' });
    expect(res.status).toBe(404);
  });

  // Il test "un ruolo non-privilegiato non può creare -> 403" (con 'resource') è stato
  // rimosso il 20/08: dopo la riduzione a 3 ruoli (admin/project_manager/operaio),
  // allowSelfOrManager('operaio', ...MANAGER_ROLES) ammette TUTTI i ruoli
  // rimasti — non esiste più nessun utente autenticato che riceva 403 nel registrare
  // ore proprie. Il caso che questo test verificava non può più esistere.

  it('accetta endTime accanto a startTime e lo salva', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, userId: adminId, hoursWorked: '4', date: '2026-08-16', startTime: '08:00', endTime: '12:00' });
    expect(res.status).toBe(201);
    expect(res.body.timeLogs[0].endTime.startsWith('12:00')).toBe(true);
    created.push(res.body.timeLogs[0].id);
  });

  it('endTime resta sempre facoltativo, anche con tipo ordinario (a differenza di startTime)', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, userId: adminId, hoursWorked: '2', date: '2026-08-16', startTime: '13:00' });
    expect(res.status).toBe(201);
    expect(res.body.timeLogs[0].endTime).toBeNull();
    created.push(res.body.timeLogs[0].id);
  });
});

// Il codice articolo è facoltativo, ma il modo in cui "assente" viene rappresentato non
// lo è: sul rapportino il codice entra nella chiave con cui i materiali vengono aggregati,
// quindi una stringa vuota e un null darebbero due voci distinte per lo stesso articolo
// su un documento che il cliente firma.
describe('POST /api/v1/time-logs — codice del materiale', () => {
  const DATA_CODICI = '2026-08-20';

  async function creaConMateriale(materiale: Record<string, unknown>) {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        taskId,
        userId: adminId,
        hoursWorked: '1',
        date: DATA_CODICI,
        startTime: '08:00',
        materials: [materiale],
      });
    if (res.status === 201) created.push(res.body.timeLogs[0].id);
    return res;
  }

  it('il codice inviato viene salvato e restituito', async () => {
    const res = await creaConMateriale({ name: 'Faretto LED', quantity: '2', unit: 'pz', code: 'FL-220' });
    expect(res.status).toBe(201);
    expect(res.body.timeLogs[0].materials[0].code).toBe('FL-220');
  });

  it('codice omesso -> null, non stringa vuota', async () => {
    const res = await creaConMateriale({ name: 'Nastro isolante', quantity: '1', unit: 'pz' });
    expect(res.status).toBe(201);
    expect(res.body.timeLogs[0].materials[0].code).toBeNull();
  });

  it('codice di soli spazi -> null; con spazi ai lati -> ripulito', async () => {
    const soloSpazi = await creaConMateriale({ name: 'Guaina', quantity: '3', unit: 'm', code: '   ' });
    expect(soloSpazi.status).toBe(201);
    expect(soloSpazi.body.timeLogs[0].materials[0].code).toBeNull();

    const conSpazi = await creaConMateriale({ name: 'Guaina', quantity: '3', unit: 'm', code: '  GU-16  ' });
    expect(conSpazi.status).toBe(201);
    expect(conSpazi.body.timeLogs[0].materials[0].code).toBe('GU-16');
  });

  it('codice oltre i 50 caratteri -> 400, non un errore del driver travestito da 500', async () => {
    const res = await creaConMateriale({ name: 'Cavo', quantity: '1', unit: 'm', code: 'X'.repeat(51) });
    expect(res.status).toBe(400);
  });

  it('PATCH: i materiali sono un REPLACE, quindi rimandarli senza codice lo azzera', async () => {
    const creato = await creaConMateriale({ name: 'Morsetto', quantity: '5', unit: 'pz', code: 'MO-9' });
    expect(creato.status).toBe(201);
    const id = creato.body.timeLogs[0].id;

    // Stesso materiale con il codice: sopravvive alla modifica di un altro campo solo
    // perché viene rimandato: l'update sostituisce l'intera lista, non la fonde.
    const conCodice = await request(app)
      .patch(`/api/v1/time-logs/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ materials: [{ name: 'Morsetto', quantity: '6', unit: 'pz', code: 'MO-9' }] });
    expect(conCodice.status).toBe(200);
    expect(conCodice.body.timeLog.materials[0].code).toBe('MO-9');

    const senzaCodice = await request(app)
      .patch(`/api/v1/time-logs/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ materials: [{ name: 'Morsetto', quantity: '6', unit: 'pz' }] });
    expect(senzaCodice.status).toBe(200);
    expect(senzaCodice.body.timeLog.materials[0].code).toBeNull();
  });
});

describe('Split automatico ordinario -> notturno / straordinario', () => {
  it('ore diurne sotto il tetto di 8h: nessuno split, una sola riga', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, userId: adminId, hoursWorked: '6', date: '2026-08-10', startTime: '08:00' });
    expect(res.status).toBe(201);
    expect(res.body.timeLogs).toHaveLength(1);
    expect(res.body.timeLogs[0].tipo).toBe('ordinario');
    expect(res.body.timeLogs[0].hoursWorked).toBe('6.00');
    created.push(res.body.timeLogs[0].id);
  });

  it('oltre le 8 ore ordinario nello stesso giorno: il resto diventa straordinario', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        taskId, userId: adminId, hoursWorked: '10', date: '2026-08-11', startTime: '06:00',
        materials: [{ name: 'Vernice', quantity: '2', unit: 'litri' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.timeLogs).toHaveLength(2);
    const ordinario = res.body.timeLogs.find((t: { tipo: string }) => t.tipo === 'ordinario');
    const straordinario = res.body.timeLogs.find((t: { tipo: string }) => t.tipo === 'straordinario');
    expect(ordinario.hoursWorked).toBe('8.00');
    expect(straordinario.hoursWorked).toBe('2.00');
    // I materiali vanno SOLO sulla prima riga (ordinario), mai duplicati sulla seconda.
    expect(ordinario.materials).toHaveLength(1);
    expect(straordinario.materials).toHaveLength(0);
    created.push(ordinario.id, straordinario.id);
  });

  it('turno che attraversa la fascia notturna 22:00-06:00 viene diviso in ordinario + notturno', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, userId: adminId, hoursWorked: '8', date: '2026-08-12', startTime: '20:00' });
    expect(res.status).toBe(201);
    expect(res.body.timeLogs).toHaveLength(2);
    const ordinario = res.body.timeLogs.find((t: { tipo: string }) => t.tipo === 'ordinario');
    const notturno = res.body.timeLogs.find((t: { tipo: string }) => t.tipo === 'notturno');
    expect(ordinario.hoursWorked).toBe('2.00'); // 20:00-22:00
    expect(notturno.hoursWorked).toBe('6.00'); // 22:00-04:00
    created.push(ordinario.id, notturno.id);
  });

  it('turno interamente nella fascia notturna: una sola riga "notturno", nessun "ordinario"', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, userId: adminId, hoursWorked: '5', date: '2026-08-13', startTime: '23:00' });
    expect(res.status).toBe(201);
    expect(res.body.timeLogs).toHaveLength(1);
    expect(res.body.timeLogs[0].tipo).toBe('notturno');
    expect(res.body.timeLogs[0].hoursWorked).toBe('5.00');
    created.push(res.body.timeLogs[0].id);
  });

  it('il tetto di 8h è cumulativo: due registrazioni diurne nello stesso giorno superano il tetto alla seconda', async () => {
    const first = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, userId: adminId, hoursWorked: '5', date: '2026-08-14', startTime: '08:00' });
    expect(first.body.timeLogs).toHaveLength(1);
    expect(first.body.timeLogs[0].hoursWorked).toBe('5.00');

    const second = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, userId: adminId, hoursWorked: '4', date: '2026-08-14', startTime: '14:00' });
    expect(second.body.timeLogs).toHaveLength(2);
    const ordinario = second.body.timeLogs.find((t: { tipo: string }) => t.tipo === 'ordinario');
    const straordinario = second.body.timeLogs.find((t: { tipo: string }) => t.tipo === 'straordinario');
    expect(ordinario.hoursWorked).toBe('3.00'); // 5 già presenti + 3 = 8, il tetto
    expect(straordinario.hoursWorked).toBe('1.00');

    created.push(first.body.timeLogs[0].id, ordinario.id, straordinario.id);
  });

  // Dal 19/08 (deciso con l'utente): senza ora di inizio nessun automatismo è
  // possibile né per la fascia notturna né per il tetto 8h/giorno — le ore restano
  // integralmente 'ordinario' su una sola riga, ANCHE oltre le 8h.
  it('senza ora di inizio con tipo ordinario (default): si salva comunque, una sola riga, niente split', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, userId: adminId, hoursWorked: '10', date: '2026-08-15' });
    expect(res.status).toBe(201);
    expect(res.body.timeLogs).toHaveLength(1);
    expect(res.body.timeLogs[0].tipo).toBe('ordinario');
    expect(res.body.timeLogs[0].hoursWorked).toBe('10.00'); // oltre le 8h, nessun tetto senza ora di inizio
    expect(res.body.timeLogs[0].startTime).toBeNull();
    created.push(res.body.timeLogs[0].id);
  });

  it('tipo diverso da "ordinario" non richiede ora di inizio e non viene mai diviso', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, userId: adminId, hoursWorked: '9', date: '2026-08-16', tipo: 'ferie' });
    expect(res.status).toBe(201);
    expect(res.body.timeLogs).toHaveLength(1);
    expect(res.body.timeLogs[0].tipo).toBe('ferie');
    expect(res.body.timeLogs[0].hoursWorked).toBe('9.00'); // nessun tetto per ferie
    created.push(res.body.timeLogs[0].id);
  });
});

describe('GET /api/v1/time-logs', () => {
  it('un operaio puo leggere (200)', async () => {
    const res = await request(app).get('/api/v1/time-logs').set('Authorization', `Bearer ${resourceToken}`);
    expect(res.status).toBe(200);
    expect(res.body.timeLogs).toBeInstanceOf(Array);
  });

  it('filtra per taskId', async () => {
    const res = await request(app)
      .get(`/api/v1/time-logs?taskId=${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /api/v1/time-logs/:id', () => {
  it('un admin legge una riga di un altro utente (200)', async () => {
    const res = await request(app).get(`/api/v1/time-logs/${timeLogId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  // timeLogId appartiene ad adminId (creato con userId: adminId più sopra), non a
  // resource: prima del fix, la route testava solo role==='operaio' e lasciava passare
  // resource/qa/stakeholder — la stessa lista (GET senza id) li limita già alle proprie
  // righe, quindi era una regola diversa sulla stessa risorsa.
  it("un operaio NON legge la riga di un altro utente (403), anche se la lista lo limita già alle proprie", async () => {
    const res = await request(app).get(`/api/v1/time-logs/${timeLogId}`).set('Authorization', `Bearer ${resourceToken}`);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/v1/time-logs/:id', () => {
  it('un admin aggiorna le ore', async () => {
    const res = await request(app)
      .patch(`/api/v1/time-logs/${timeLogId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ hoursWorked: '5' });
    expect(res.status).toBe(200);
    expect(res.body.timeLog.hoursWorked).toBe('5.00');
  });

  // Il tetto 8h/giorno scattava solo alla creazione: creare 9h (split 8 ordinario + 1
  // straordinario) e poi fare PATCH della riga ordinario a 20h la lasciava a 20h senza
  // rispezzare. timeLogId è "ordinario" (tipo di default, mai cambiato) e a questo punto
  // ha 5h dal test sopra: un PATCH a 20h deve essere rifiutato (0 altre righe ordinario
  // stesso giorno + 20h > 8h), non silenziosamente accettato.
  it('rifiuta un aggiornamento che sfora il tetto 8h ordinario/giorno (400)', async () => {
    const res = await request(app)
      .patch(`/api/v1/time-logs/${timeLogId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ hoursWorked: '20' });
    expect(res.status).toBe(400);

    // Prova diretta che non è stato applicato: le ore restano quelle del test precedente.
    const check = await request(app).get(`/api/v1/time-logs/${timeLogId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(check.body.timeLog.hoursWorked).toBe('5.00');
  });

  // Coerenza con la creazione: una riga 'ordinario' SENZA ora di inizio nota non ha
  // mai avuto il tetto 8h applicato (vedi test di creazione sopra), quindi anche un
  // PATCH che la porta oltre le 8h deve passare — bloccarla solo in modifica
  // applicherebbe un vincolo mai imposto alla sua creazione.
  it('un aggiornamento oltre 8h su una riga ordinario SENZA ora di inizio non viene bloccato', async () => {
    const created2 = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, userId: adminId, hoursWorked: '2', date: '2026-08-17' });
    expect(created2.status).toBe(201);
    expect(created2.body.timeLogs[0].startTime).toBeNull();
    const noStartTimeLogId = created2.body.timeLogs[0].id;
    created.push(noStartTimeLogId);

    const res = await request(app)
      .patch(`/api/v1/time-logs/${noStartTimeLogId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ hoursWorked: '12' });
    expect(res.status).toBe(200);
    expect(res.body.timeLog.hoursWorked).toBe('12.00');
  });

  it('aggiorna endTime su una riga esistente', async () => {
    const res = await request(app)
      .patch(`/api/v1/time-logs/${timeLogId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ endTime: '17:30' });
    expect(res.status).toBe(200);
    expect(res.body.timeLog.endTime.startsWith('17:30')).toBe(true);
  });

  it('body vuoto -> 400', async () => {
    const res = await request(app)
      .patch(`/api/v1/time-logs/${timeLogId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/v1/time-logs/:id — modifica ore altrui (admin/PM), taskId, riassegnazione', () => {
  let secondTaskId: string;
  let otherCompanyTaskId: string;
  let otherCompanyId: string;
  let operaioId: string;
  let operaioToken: string;
  let operaioTwoId: string;
  let correctionTimeLogId: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);

    const [secondTask] = await db.insert(tasks).values({ projectId, title: 'Secondo task Vitest', companyId }).returning();
    secondTaskId = secondTask.id;
    created.push(secondTaskId);

    const [operaio] = await db
      .insert(users)
      .values({ email: 'timelog-test-operaio-correzione@workflow360.local', passwordHash, name: 'Operaio Correzione', role: 'operaio', companyId })
      .returning();
    operaioId = operaio.id;
    operaioToken = signAccessToken({ id: operaio.id, email: operaio.email, role: 'operaio', companyId });

    const [operaioTwo] = await db
      .insert(users)
      .values({ email: 'timelog-test-operaio-due@workflow360.local', passwordHash, name: 'Operaio Due', role: 'operaio', companyId })
      .returning();
    operaioTwoId = operaioTwo.id;

    // Azienda diversa, per verificare che taskId/userId di riassegnazione siano
    // scoped alla company di chi chiama (stesso principio già verificato altrove
    // in questo progetto per projects/users/reports).
    const [otherCompany] = await db.insert(companies).values({ name: 'TimeLogOtherCo Vitest' }).returning();
    otherCompanyId = otherCompany.id;
    const [otherProject] = await db.insert(projects).values({ name: 'Altro cantiere', companyId: otherCompanyId, projectNumber: 1 }).returning();
    const [otherTask] = await db.insert(tasks).values({ projectId: otherProject.id, title: 'Altro task', companyId: otherCompanyId }).returning();
    otherCompanyTaskId = otherTask.id;

    const [row] = await db
      .insert(timeLogs)
      .values({ companyId, taskId, userId: operaioId, tipo: 'ordinario', hoursWorked: '3', date: '2026-08-10', startTime: '08:00' })
      .returning();
    correctionTimeLogId = row.id;
  });

  afterAll(async () => {
    await db.delete(auditLog).where(eq(auditLog.companyId, companyId)).catch(() => {});
    await db.delete(timeLogs).where(eq(timeLogs.taskId, secondTaskId)).catch(() => {});
    await db.delete(tasks).where(eq(tasks.id, secondTaskId)).catch(() => {});
    await db.delete(users).where(eq(users.id, operaioId)).catch(() => {});
    await db.delete(users).where(eq(users.id, operaioTwoId)).catch(() => {});
    await db.delete(tasks).where(eq(tasks.id, otherCompanyTaskId)).catch(() => {});
    await db.delete(users).where(eq(users.companyId, otherCompanyId)).catch(() => {});
    await db.delete(companies).where(eq(companies.id, otherCompanyId)).catch(() => {});
  });

  it('bug corretto: taskId in PATCH sposta davvero la registrazione (prima veniva scartato in silenzio)', async () => {
    const res = await request(app)
      .patch(`/api/v1/time-logs/${correctionTimeLogId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId: secondTaskId });
    expect(res.status).toBe(200);
    expect(res.body.timeLog.taskId).toBe(secondTaskId);

    const [row] = await db.select({ taskId: timeLogs.taskId }).from(timeLogs).where(eq(timeLogs.id, correctionTimeLogId)).limit(1);
    expect(row.taskId).toBe(secondTaskId);
  });

  it('taskId di un\'altra azienda -> 404 (non applicato)', async () => {
    const res = await request(app)
      .patch(`/api/v1/time-logs/${correctionTimeLogId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId: otherCompanyTaskId });
    expect(res.status).toBe(404);
  });

  it('un admin riassegna la registrazione a un altro dipendente', async () => {
    const res = await request(app)
      .patch(`/api/v1/time-logs/${correctionTimeLogId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: operaioTwoId });
    expect(res.status).toBe(200);
    expect(res.body.timeLog.userId).toBe(operaioTwoId);
  });

  it('userId di un utente di un\'altra azienda -> 404', async () => {
    const [otherUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.companyId, otherCompanyId))
      .limit(1);
    // Nessun utente nell'altra azienda in questo fixture: verifica invece con un uuid
    // inesistente, stesso percorso di codice (utente non trovato scoped a companyId).
    const res = await request(app)
      .patch(`/api/v1/time-logs/${correctionTimeLogId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: otherUser?.id ?? '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(404);
  });

  it('un operaio che invia userId su una PROPRIA registrazione: il campo viene ignorato, non rifiutato', async () => {
    const [ownRow] = await db
      .insert(timeLogs)
      .values({ companyId, taskId: secondTaskId, userId: operaioId, tipo: 'permesso', hoursWorked: '2', date: '2026-08-11' })
      .returning();
    const res = await request(app)
      .patch(`/api/v1/time-logs/${ownRow.id}`)
      .set('Authorization', `Bearer ${operaioToken}`)
      .send({ userId: operaioTwoId, notes: 'nota aggiornata' });
    expect(res.status).toBe(200);
    // userId NON cambiato (ignorato), ma il resto del PATCH è comunque applicato.
    expect(res.body.timeLog.userId).toBe(operaioId);
    expect(res.body.timeLog.notes).toBe('nota aggiornata');
    await db.delete(timeLogs).where(eq(timeLogs.id, ownRow.id)).catch(() => {});
  });

  it('riassegnare rispetta il tetto 8h/giorno del DESTINATARIO, non del proprietario originale', async () => {
    // operaioTwoId ha già 8h ordinario il 10/08 sul task originale. Nota: NON pulire
    // questo fixture con un delete per userId=operaioTwoId — a questo punto della
    // suite correctionTimeLogId è STATO GIÀ riassegnato a operaioTwoId (test sopra),
    // e un delete così ampio cancellerebbe anche quella riga, rompendo i test dopo.
    const [pienoTetto] = await db
      .insert(timeLogs)
      .values({ companyId, taskId, userId: operaioTwoId, tipo: 'ordinario', hoursWorked: '8', date: '2026-08-10', startTime: '08:00' })
      .returning();
    const [altraRiga] = await db
      .insert(timeLogs)
      .values({ companyId, taskId, userId: operaioId, tipo: 'ordinario', hoursWorked: '3', date: '2026-08-10', startTime: '08:00' })
      .returning();

    // Riassegnare questa riga a operaioTwoId supererebbe il suo tetto (8h già + 3h = 11h).
    const res = await request(app)
      .patch(`/api/v1/time-logs/${altraRiga.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: operaioTwoId });
    expect(res.status).toBe(400);

    await db.delete(timeLogs).where(eq(timeLogs.id, pienoTetto.id)).catch(() => {});
    await db.delete(timeLogs).where(eq(timeLogs.id, altraRiga.id)).catch(() => {});
  });

  it('un admin che modifica ore non sue lascia una traccia in audit_log', async () => {
    const res = await request(app)
      .patch(`/api/v1/time-logs/${correctionTimeLogId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ notes: 'corretta da admin' });
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.companyId, companyId), eq(auditLog.entityId, correctionTimeLogId), eq(auditLog.action, 'UPDATE')));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].userId).toBe(adminId);
  });

  it('un operaio che modifica le PROPRIE ore NON lascia traccia in audit_log', async () => {
    const [ownRow] = await db
      .insert(timeLogs)
      .values({ companyId, taskId: secondTaskId, userId: operaioId, tipo: 'permesso', hoursWorked: '1', date: '2026-08-12' })
      .returning();
    await request(app).patch(`/api/v1/time-logs/${ownRow.id}`).set('Authorization', `Bearer ${operaioToken}`).send({ hoursWorked: '2' });

    const rows = await db.select().from(auditLog).where(and(eq(auditLog.companyId, companyId), eq(auditLog.entityId, ownRow.id)));
    expect(rows.length).toBe(0);
    await db.delete(timeLogs).where(eq(timeLogs.id, ownRow.id)).catch(() => {});
  });
});

describe('F2 — ruolo operaio', () => {
  // Operaio della stessa azienda usata negli altri test (companyId condiviso).
  let operaioId: string;
  let operaioToken: string;
  let operaioTimeLogId: string;
  let adminTimeLogId: string;

  beforeAll(async () => {
    // Idempotenza: rimuovi eventuali residui di esecuzioni precedenti.
    await db.delete(users).where(eq(users.email, 'operaio-f2@workflow360.local')).catch(() => {});
    const operaioPasswordHash = await bcrypt.hash('OperaioTest123!', BCRYPT_TEST_COST);
    const [op] = await db
      .insert(users)
      .values({ email: 'operaio-f2@workflow360.local', passwordHash: operaioPasswordHash, name: 'Operaio F2', role: 'operaio', companyId })
      .returning();
    operaioId = op.id;
    operaioToken = signAccessToken({ id: op.id, email: op.email, role: 'operaio', companyId });
    // L'admin registra un'ora per SÉ (così l'operaio NON è il proprietario).
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, userId: adminId, hoursWorked: '2', date: '2026-08-09', startTime: '08:00' });
    adminTimeLogId = res.body.timeLogs[0].id;
  });

  afterAll(async () => {
    await db.delete(timeLogs).where(eq(timeLogs.id, adminTimeLogId)).catch(() => {});
    await db.delete(timeLogs).where(eq(timeLogs.id, operaioTimeLogId)).catch(() => {});
    await db.delete(users).where(eq(users.id, operaioId)).catch(() => {});
  });

  it('l\'operaio vede TUTTI i cantieri della sua azienda (GET /projects)', async () => {
    const res = await request(app).get('/api/v1/projects').set('Authorization', `Bearer ${operaioToken}`);
    expect(res.status).toBe(200);
    expect(res.body.projects.some((p: { id: string }) => p.id === projectId)).toBe(true);
  });

  it('l\'operaio puo inserire le PROPRIE ore (201) e vengono registrate a lui', async () => {
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${operaioToken}`)
      .send({ taskId, hoursWorked: '4', date: '2026-08-09', startTime: '08:00', workDescription: 'Posa pavimento', materials: [{ name: 'Piastrella', quantity: '10', unit: 'mq' }] });
    expect(res.status).toBe(201);
    expect(res.body.timeLogs[0].userId).toBe(operaioId); // forzato a sé stesso, ignora userId nel body
    operaioTimeLogId = res.body.timeLogs[0].id;
  });

  it('l\'operaio NON puo inserire ore per un altro utente (forzato a sé)', async () => {
    // Il body chiede userId=adminId, ma il service lo ignora e usa l'operaio.
    const res = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${operaioToken}`)
      .send({ taskId, userId: adminId, hoursWorked: '1', date: '2026-08-09', startTime: '09:00' });
    expect(res.status).toBe(201);
    expect(res.body.timeLogs[0].userId).toBe(operaioId);
  });

  it('l\'operaio vede SOLO le proprie ore (no quelle dell\'admin)', async () => {
    const res = await request(app).get('/api/v1/time-logs').set('Authorization', `Bearer ${operaioToken}`);
    expect(res.status).toBe(200);
    expect(res.body.timeLogs.every((t: { userId: string }) => t.userId === operaioId)).toBe(true);
  });

  it('l\'operaio NON puo leggere le ore di un collega (403)', async () => {
    const res = await request(app).get(`/api/v1/time-logs/${adminTimeLogId}`).set('Authorization', `Bearer ${operaioToken}`);
    expect(res.status).toBe(403);
  });

  it('l\'operaio NON puo modificare le ore di un collega (403)', async () => {
    const res = await request(app)
      .patch(`/api/v1/time-logs/${adminTimeLogId}`)
      .set('Authorization', `Bearer ${operaioToken}`)
      .send({ hoursWorked: '9' });
    expect(res.status).toBe(403);
  });

  it('l\'operaio NON puo cancellare le ore di un collega (403)', async () => {
    const res = await request(app).delete(`/api/v1/time-logs/${adminTimeLogId}`).set('Authorization', `Bearer ${operaioToken}`);
    expect(res.status).toBe(403);
  });

  it('l\'operaio puo modificare le PROPRIE ore (200)', async () => {
    const res = await request(app)
      .patch(`/api/v1/time-logs/${operaioTimeLogId}`)
      .set('Authorization', `Bearer ${operaioToken}`)
      .send({ hoursWorked: '5', workDescription: 'Posa pavimento corretta' });
    expect(res.status).toBe(200);
    expect(res.body.timeLog.hoursWorked).toBe('5.00');
  });

  it('l\'operaio puo cancellare le PROPRIE ore (204)', async () => {
    const res = await request(app).delete(`/api/v1/time-logs/${operaioTimeLogId}`).set('Authorization', `Bearer ${operaioToken}`);
    expect(res.status).toBe(204);
    operaioTimeLogId = ''; // già cancellata
  });
});

describe('DELETE /api/v1/time-logs/:id', () => {
  it('un admin elimina il consuntivo', async () => {
    const res = await request(app)
      .delete(`/api/v1/time-logs/${timeLogId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
  });

  it('dopo eliminazione GET -> 404', async () => {
    const res = await request(app)
      .get(`/api/v1/time-logs/${timeLogId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
