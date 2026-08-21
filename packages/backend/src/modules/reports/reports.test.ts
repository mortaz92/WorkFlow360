import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { createApp } from '../../app';
import { db } from '../../core/db';
import { users, companies, projects, tasks, timeLogs } from '../../core/db/schema';
import { signAccessToken } from '../auth/auth.service';

const BCRYPT_TEST_COST = 4; // volutamente basso per velocizzare i test — MAI in produzione
const app = createApp();

describe('Reports (F7)', () => {
  let companyId: string;
  let adminToken: string;
  let operaioToken: string;
  let operaioId: string;
  let operaioSenzaOreId: string;
  let projectId: string;
  let taskId: string;

  beforeAll(async () => {
    const companyPasswordHash = await bcrypt.hash('ReportTest123!', BCRYPT_TEST_COST);
    const [company] = await db
      .insert(companies)
      .values({ name: 'ReportTestCo' })
      .returning();
    companyId = company.id;

    const [admin] = await db
      .insert(users)
      .values({ email: 'report-admin@workflow360.local', passwordHash: companyPasswordHash, name: 'Report Admin', role: 'admin', companyId })
      .returning();
    adminToken = signAccessToken({ id: admin.id, email: admin.email, role: 'admin', companyId });

    const [op] = await db
      .insert(users)
      .values({ email: 'report-op@workflow360.local', passwordHash: companyPasswordHash, name: 'Report Op', role: 'operaio', companyId })
      .returning();
    operaioId = op.id;
    operaioToken = signAccessToken({ id: op.id, email: op.email, role: 'operaio', companyId });

    // Operaio SENZA nessuna ora registrata: deve comunque comparire nel report
    // ore-per-utente (con 0 ore), non sparire finché non registra la prima giornata.
    const [opSenzaOre] = await db
      .insert(users)
      .values({ email: 'report-op-nuovo@workflow360.local', passwordHash: companyPasswordHash, name: 'Report Op Nuovo', role: 'operaio', companyId })
      .returning();
    operaioSenzaOreId = opSenzaOre.id;

    const [project] = await db
      .insert(projects)
      .values({ companyId, projectNumber: 1, name: 'Cantiere Report', tipoCommessa: 'consuntivo', status: 'in_progress' })
      .returning();
    projectId = project.id;

    const [task] = await db
      .insert(tasks)
      .values({ companyId, projectId, title: 'Lavoro report', status: 'in_progress' })
      .returning();
    taskId = task.id;

    await db.insert(timeLogs).values([
      { companyId, taskId, userId: operaioId, tipo: 'ordinario', hoursWorked: '3.5', date: '2026-08-01' },
      { companyId, taskId, userId: operaioId, tipo: 'straordinario', hoursWorked: '2', date: '2026-08-02' },
    ]);
  });

  afterAll(async () => {
    await db.delete(timeLogs).where(eq(timeLogs.companyId, companyId)).catch(() => {});
    await db.delete(tasks).where(eq(tasks.companyId, companyId)).catch(() => {});
    await db.delete(projects).where(eq(projects.companyId, companyId)).catch(() => {});
    await db.delete(users).where(eq(users.companyId, companyId)).catch(() => {});
    await db.delete(companies).where(eq(companies.id, companyId)).catch(() => {});
  });

  it('admin vede il report ore-per-commessa con totali corretti', async () => {
    const res = await request(app).get('/api/v1/reports/hours-by-project').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
    expect(Number(res.body.reports[0].totalHours)).toBeCloseTo(5.5);
    expect(Number(res.body.reports[0].ordinary)).toBeCloseTo(3.5);
    expect(Number(res.body.reports[0].straordinario)).toBeCloseTo(2);
    expect(res.body.reports[0].logCount).toBe(2);
  });

  it('admin vede il report ore-per-utente, inclusi gli operai senza ancora nessuna ora', async () => {
    const res = await request(app).get('/api/v1/reports/hours-by-user').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(2); // Report Op (5.5h) + Report Op Nuovo (0h)
    const conOre = res.body.reports.find((r: { userId: string }) => r.userId === operaioId);
    const senzaOre = res.body.reports.find((r: { userId: string }) => r.userId === operaioSenzaOreId);
    expect(Number(conOre.totalHours)).toBeCloseTo(5.5);
    expect(senzaOre).toBeDefined();
    expect(Number(senzaOre.totalHours)).toBe(0);
    expect(senzaOre.logCount).toBe(0);
  });

  it('periodo: chi non ha ore in quel range compare comunque a zero, non sparisce (LEFT JOIN)', async () => {
    // Trappola specifica: il filtro data su un LEFT JOIN da users va nella condizione
    // di JOIN, mai in WHERE — altrimenti diventa un INNER JOIN di fatto e un dipendente
    // senza ore nel periodo sparirebbe dal report paghe invece di comparire con 0.
    const res = await request(app)
      .get('/api/v1/reports/hours-by-user?from=2026-09-01&to=2026-09-30')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(2); // nessuno dei due operai sparisce
    const conOre = res.body.reports.find((r: { userId: string }) => r.userId === operaioId);
    expect(Number(conOre.totalHours)).toBe(0); // le sue ore vere sono ad agosto, fuori da settembre
    expect(conOre.logCount).toBe(0);
  });

  it('periodo: filtra correttamente le ore del commessa (INNER JOIN, non tocca la presenza del cantiere)', async () => {
    const res = await request(app)
      .get('/api/v1/reports/hours-by-project?from=2026-08-01&to=2026-08-01')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
    expect(Number(res.body.reports[0].totalHours)).toBeCloseTo(3.5); // solo il log dell'1/8, non quello del 2/8
    expect(res.body.reports[0].projectNumber).toBe(1);
    expect(res.body.reports[0].tipoCommessa).toBe('consuntivo');
  });

  it('periodo invertito (from > to) -> 400, non zero ore silenzioso', async () => {
    const res = await request(app)
      .get('/api/v1/reports/hours-by-project?from=2026-08-31&to=2026-08-01')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('operaio NON puo vedere i report (403)', async () => {
    const res = await request(app).get('/api/v1/reports/hours-by-project').set('Authorization', `Bearer ${operaioToken}`);
    expect(res.status).toBe(403);
  });

  it('senza token -> 401', async () => {
    const res = await request(app).get('/api/v1/reports/hours-by-project');
    expect(res.status).toBe(401);
  });

  it('admin vede il dettaglio del cantiere (stato, dipendenti coinvolti, ore totali)', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/projects/${projectId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.project.id).toBe(projectId);
    expect(res.body.project.status).toBe('in_progress');
    expect(res.body.project.employeeCount).toBe(1); // solo operaioId ha registrato ore
    expect(Number(res.body.project.totalHours)).toBeCloseTo(5.5);
    expect(res.body.project.materials).toEqual([]); // nessun materiale registrato in questo fixture
    // employees[]: ore per singolo dipendente, non solo il conteggio.
    expect(res.body.project.employees).toHaveLength(1);
    expect(res.body.project.employees[0].userId).toBe(operaioId);
    expect(Number(res.body.project.employees[0].totalHours)).toBeCloseTo(5.5);
    expect(Number(res.body.project.employees[0].ordinary)).toBeCloseTo(3.5);
    expect(Number(res.body.project.employees[0].straordinario)).toBeCloseTo(2);
  });

  it('dettaglio cantiere: id inesistente -> 404', async () => {
    const res = await request(app)
      .get('/api/v1/reports/projects/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('admin vede il dettaglio del dipendente (ore con cantiere/lavoro associato)', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/users/${operaioId}/time-logs`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.userId).toBe(operaioId);
    expect(res.body.user.timeLogs).toHaveLength(2);
    expect(res.body.user.timeLogs[0].projectId).toBe(projectId);
    expect(Number(res.body.user.totalHours)).toBeCloseTo(5.5);
    // Scomposizione per tipo, stessa forma del report ore-per-utente.
    expect(Number(res.body.user.ordinary)).toBeCloseTo(3.5);
    expect(Number(res.body.user.straordinario)).toBeCloseTo(2);
    expect(Number(res.body.user.notturno)).toBe(0);
  });

  it('operaio NON può vedere il dettaglio di un dipendente (403)', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/users/${operaioId}/time-logs`)
      .set('Authorization', `Bearer ${operaioToken}`);
    expect(res.status).toBe(403);
  });

  describe('Archiviazione ore (15 giorni dalla fine mese / cantiere chiuso)', () => {
    let vecchioProjectId: string;
    let vecchioTaskId: string;
    let chiusoProjectId: string;
    let chiusoTaskId: string;

    beforeAll(async () => {
      // Data ben oltre 15 giorni dalla fine del suo mese, qualunque sia "oggi": entra
      // nell'Archivio per la regola della data, a prescindere dallo stato del cantiere.
      const [vecchioProject] = await db
        .insert(projects)
        .values({ companyId, projectNumber: 90, name: 'Cantiere Vecchio Archiviato', status: 'in_progress' })
        .returning();
      vecchioProjectId = vecchioProject.id;
      const [vecchioTask] = await db.insert(tasks).values({ companyId, projectId: vecchioProjectId, title: 'Lavoro vecchio' }).returning();
      vecchioTaskId = vecchioTask.id;
      await db.insert(timeLogs).values({ companyId, taskId: vecchioTaskId, userId: operaioId, tipo: 'ordinario', hoursWorked: '4', date: '2020-01-15' });

      // Cantiere CHIUSO con un'ora di data odierna: archiviato per stato del cantiere,
      // non per la data (che da sola sarebbe ancora attiva).
      const [chiusoProject] = await db
        .insert(projects)
        .values({ companyId, projectNumber: 91, name: 'Cantiere Chiuso Archiviato', status: 'completed' })
        .returning();
      chiusoProjectId = chiusoProject.id;
      const [chiusoTask] = await db.insert(tasks).values({ companyId, projectId: chiusoProjectId, title: 'Lavoro su chiuso' }).returning();
      chiusoTaskId = chiusoTask.id;
      const oggi = new Date().toISOString().slice(0, 10);
      await db.insert(timeLogs).values({ companyId, taskId: chiusoTaskId, userId: operaioId, tipo: 'ordinario', hoursWorked: '3', date: oggi });
    });

    it('un\'ora vecchia (oltre 15gg dalla fine mese) NON compare nel report attivo per commessa', async () => {
      const res = await request(app).get('/api/v1/reports/hours-by-project').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.reports.find((r: { projectId: string }) => r.projectId === vecchioProjectId)).toBeUndefined();
    });

    it('la stessa ora vecchia COMPARE nel report archiviato (?archived=true)', async () => {
      const res = await request(app).get('/api/v1/reports/hours-by-project?archived=true').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const row = res.body.reports.find((r: { projectId: string }) => r.projectId === vecchioProjectId);
      expect(row).toBeDefined();
      expect(Number(row.totalHours)).toBeCloseTo(4);
    });

    it('un cantiere chiuso è archiviato anche con un\'ora di OGGI (per stato, non per data)', async () => {
      const attivo = await request(app).get('/api/v1/reports/hours-by-project').set('Authorization', `Bearer ${adminToken}`);
      expect(attivo.body.reports.find((r: { projectId: string }) => r.projectId === chiusoProjectId)).toBeUndefined();

      const archiviato = await request(app).get('/api/v1/reports/hours-by-project?archived=true').set('Authorization', `Bearer ${adminToken}`);
      const row = archiviato.body.reports.find((r: { projectId: string }) => r.projectId === chiusoProjectId);
      expect(row).toBeDefined();
      expect(Number(row.totalHours)).toBeCloseTo(3);
    });

    it('ore-per-utente: le ore vecchie/archiviate non gonfiano il totale attivo dell\'operaio', async () => {
      // L'operaio ha 5.5h attive (fixture principale) + 4h vecchie + 3h su cantiere
      // chiuso: il report ATTIVO deve contare solo le 5.5h, non le altre 7h.
      const res = await request(app).get('/api/v1/reports/hours-by-user').set('Authorization', `Bearer ${adminToken}`);
      const row = res.body.reports.find((r: { userId: string }) => r.userId === operaioId);
      expect(Number(row.totalHours)).toBeCloseTo(5.5);
    });

    it('ore-per-utente ARCHIVIATE: mostra solo le 7h (vecchie + cantiere chiuso), non le 5.5h attive', async () => {
      const res = await request(app).get('/api/v1/reports/hours-by-user?archived=true').set('Authorization', `Bearer ${adminToken}`);
      const row = res.body.reports.find((r: { userId: string }) => r.userId === operaioId);
      expect(row).toBeDefined();
      expect(Number(row.totalHours)).toBeCloseTo(7);
    });
  });

  describe('Registro cronologico cantiere (Archivio)', () => {
    it('admin vede il registro, righe ordinate per data decrescente', async () => {
      const res = await request(app)
        .get(`/api/v1/reports/projects/${projectId}/timeline`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(2);
      expect(res.body.total).toBe(2);
      expect(res.body.entries[0].date).toBe('2026-08-02'); // più recente prima
      expect(res.body.entries[0].userName).toBe('Report Op');
      expect(res.body.entries[0].materials).toEqual([]); // nessun materiale in questo fixture
    });

    it('registro cantiere: id inesistente -> 404 (non 200 con lista vuota)', async () => {
      const res = await request(app)
        .get('/api/v1/reports/projects/00000000-0000-0000-0000-000000000000/timeline')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
    });

    it('registro cantiere: rispetta il periodo', async () => {
      const res = await request(app)
        .get(`/api/v1/reports/projects/${projectId}/timeline?from=2026-08-02&to=2026-08-02`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].date).toBe('2026-08-02');
    });

    it('operaio NON può vedere il registro (403)', async () => {
      const res = await request(app)
        .get(`/api/v1/reports/projects/${projectId}/timeline`)
        .set('Authorization', `Bearer ${operaioToken}`);
      expect(res.status).toBe(403);
    });
  });
});
