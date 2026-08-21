import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { createApp } from '../../app';
import { db } from '../../core/db';
import { users, projects, tasks, companies } from '../../core/db/schema';
import { signAccessToken } from '../auth/auth.service';

const app = createApp();
const BCRYPT_TEST_COST = 4;

const ADMIN_EMAIL = 'tasks-test-admin@workflow360.local';
const PM_EMAIL = 'tasks-test-pm@workflow360.local';
const RESOURCE_EMAIL = 'tasks-test-resource@workflow360.local';
const OPERAIO_EMAIL = 'tasks-test-operaio@workflow360.local';
const OPERAIO_INACTIVE_EMAIL = 'tasks-test-operaio-inactive@workflow360.local';
const OTHER_COMPANY_OPERAIO_EMAIL = 'tasks-test-other-company-operaio@workflow360.local';

let companyId: string;
let otherCompanyId: string;
let adminId: string;
let pmId: string;
let operaioId: string;
let operaioInactiveId: string;
let otherCompanyOperaioId: string;
let adminToken: string;
let pmToken: string;
let resourceToken: string;
let projectId: string;
let taskId: string;
let completedProjectId: string;

const created: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);
  const [company] = await db.insert(companies).values({ name: 'TasksTestCo' }).returning();
  companyId = company.id;
  const [otherCompany] = await db.insert(companies).values({ name: 'TasksTestCo Altra Azienda' }).returning();
  otherCompanyId = otherCompany.id;
  const [admin] = await db.insert(users).values({ email: ADMIN_EMAIL, passwordHash, name: 'Admin T', role: 'admin', companyId }).returning();
  const [pm] = await db.insert(users).values({ email: PM_EMAIL, passwordHash, name: 'PM T', role: 'project_manager', companyId }).returning();
  // Era 'resource' prima del 20/08 (ruolo rimosso): qui serve un utente autenticato ma
  // NON-manager per i test "non può creare/leggere assignable-users", quindi diventa un
  // operaio — MA per il test più sotto "rifiuta assignedTo di un non-operaio" un operaio
  // sarebbe sbagliato (diventerebbe assegnabile!), per quel caso si usa pmId invece.
  const [resource] = await db.insert(users).values({ email: RESOURCE_EMAIL, passwordHash, name: 'Resource T', role: 'operaio', companyId }).returning();
  const [operaio] = await db.insert(users).values({ email: OPERAIO_EMAIL, passwordHash, name: 'Operaio T', role: 'operaio', companyId }).returning();
  const [operaioInactive] = await db
    .insert(users)
    .values({ email: OPERAIO_INACTIVE_EMAIL, passwordHash, name: 'Operaio Inattivo T', role: 'operaio', companyId, active: false })
    .returning();
  const [otherCompanyOperaio] = await db
    .insert(users)
    .values({ email: OTHER_COMPANY_OPERAIO_EMAIL, passwordHash, name: 'Operaio Altra Azienda T', role: 'operaio', companyId: otherCompanyId })
    .returning();
  adminId = admin.id;
  pmId = pm.id;
  operaioId = operaio.id;
  operaioInactiveId = operaioInactive.id;
  otherCompanyOperaioId = otherCompanyOperaio.id;

  adminToken = signAccessToken({ id: admin.id, email: admin.email, role: admin.role, companyId });
  pmToken = signAccessToken({ id: pm.id, email: pm.email, role: pm.role, companyId });
  resourceToken = signAccessToken({ id: resource.id, email: resource.email, role: resource.role, companyId });

  const [project] = await db.insert(projects).values({ name: 'Progetto per Task Vitest', companyId, projectNumber: 1 }).returning();
  projectId = project.id;
  created.push(projectId);

  const [completedProject] = await db
    .insert(projects)
    .values({ name: 'Progetto Chiuso per Task Vitest', companyId, projectNumber: 2, status: 'completed' })
    .returning();
  completedProjectId = completedProject.id;
});

afterAll(async () => {
  await db.delete(tasks).where(eq(tasks.projectId, projectId)).catch(() => {});
  await db.delete(tasks).where(eq(tasks.projectId, completedProjectId)).catch(() => {});
  await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
  await db.delete(projects).where(eq(projects.id, completedProjectId)).catch(() => {});
  await db.delete(users).where(eq(users.email, ADMIN_EMAIL)).catch(() => {});
  await db.delete(users).where(eq(users.email, PM_EMAIL)).catch(() => {});
  await db.delete(users).where(eq(users.email, RESOURCE_EMAIL)).catch(() => {});
  await db.delete(users).where(eq(users.email, OPERAIO_EMAIL)).catch(() => {});
  await db.delete(users).where(eq(users.email, OTHER_COMPANY_OPERAIO_EMAIL)).catch(() => {});
  await db.delete(companies).where(eq(companies.id, otherCompanyId)).catch(() => {});
  await db.delete(users).where(eq(users.email, OPERAIO_INACTIVE_EMAIL)).catch(() => {});
  await db.delete(companies).where(eq(companies.id, companyId)).catch(() => {});
});

describe('POST /api/v1/tasks', () => {
  it('un admin crea un task legato al progetto', async () => {
    const res = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ projectId, title: 'Task Vitest 1', priority: 'high' });
    expect(res.status).toBe(201);
    expect(res.body.task.title).toBe('Task Vitest 1');
    expect(res.body.task.projectId).toBe(projectId);
    taskId = res.body.task.id;
    created.push(taskId);
  });

  it('projectId inesistente -> 404', async () => {
    const res = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ projectId: '00000000-0000-0000-0000-000000000000', title: 'Orfano' });
    expect(res.status).toBe(404);
  });

  it('cantiere chiuso (status completed) -> 409, nessun nuovo lavoro', async () => {
    const res = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ projectId: completedProjectId, title: 'Lavoro su cantiere chiuso' });
    expect(res.status).toBe(409);
  });

  it('title vuoto -> 400', async () => {
    const res = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ projectId, title: '' });
    expect(res.status).toBe(400);
  });

  it('un operaio NON puo creare -> 403', async () => {
    const res = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${resourceToken}`)
      .send({ projectId, title: 'Vietato' });
    expect(res.status).toBe(403);
  });

  it('assegna un dipendente (assignedTo) alla creazione', async () => {
    const res = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ projectId, title: 'Task assegnato alla creazione', assignedTo: operaioId });
    expect(res.status).toBe(201);
    expect(res.body.task.assignedTo).toBe(operaioId);
    created.push(res.body.task.id);
  });

  it('senza assignedTo il task resta non assegnato (null)', async () => {
    const res = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ projectId, title: 'Task non assegnato' });
    expect(res.status).toBe(201);
    expect(res.body.task.assignedTo).toBeNull();
    created.push(res.body.task.id);
  });

  it('rifiuta assignedTo di un utente di UN\'ALTRA azienda (isolamento multi-tenant, 404)', async () => {
    const res = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ projectId, title: 'Task assegnazione cross-tenant', assignedTo: otherCompanyOperaioId });
    expect(res.status).toBe(404);
  });

  it('rifiuta assignedTo di un utente non-operaio (es. project_manager) -> 404', async () => {
    // NON usare l'utente "resource" di questo file: dopo la rimozione del ruolo
    // 'resource' (20/08) quell'utente è un operaio vero, verrebbe accettato come
    // assegnatario invece di essere rifiutato — pmId resta un non-operaio genuino.
    const res = await request(app)
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ projectId, title: 'Task assegnato a un non-operaio', assignedTo: pmId });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/tasks/assignable-users', () => {
  it('un admin vede solo operai attivi (id+nome, non altri ruoli, non inattivi)', async () => {
    const res = await request(app).get('/api/v1/tasks/assignable-users').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids: string[] = res.body.users.map((u: { id: string }) => u.id);
    expect(ids).toContain(operaioId);
    expect(ids).not.toContain(operaioInactiveId);
    expect(ids).not.toContain(adminId);
    const operaioRow = res.body.users.find((u: { id: string }) => u.id === operaioId);
    expect(Object.keys(operaioRow).sort()).toEqual(['id', 'name']);
  });

  it('un project_manager puo leggerlo (200)', async () => {
    const res = await request(app).get('/api/v1/tasks/assignable-users').set('Authorization', `Bearer ${pmToken}`);
    expect(res.status).toBe(200);
  });

  it('un operaio NON puo leggerlo -> 403', async () => {
    const res = await request(app).get('/api/v1/tasks/assignable-users').set('Authorization', `Bearer ${resourceToken}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/tasks', () => {
  it('un operaio puo leggere (200)', async () => {
    const res = await request(app).get('/api/v1/tasks').set('Authorization', `Bearer ${resourceToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tasks).toBeInstanceOf(Array);
  });

  it('filtra per projectId', async () => {
    const res = await request(app)
      .get(`/api/v1/tasks?projectId=${projectId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });
});

describe('PATCH /api/v1/tasks/:id', () => {
  it('un admin aggiorna status e priority', async () => {
    const res = await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'in_progress', priority: 'urgent' });
    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('in_progress');
    expect(res.body.task.priority).toBe('urgent');
  });

  it('body vuoto -> 400', async () => {
    const res = await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('assegna un dipendente a un task esistente (era non assegnato)', async () => {
    const res = await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: operaioId });
    expect(res.status).toBe(200);
    expect(res.body.task.assignedTo).toBe(operaioId);
  });

  it('rimuove l\'assegnazione impostando assignedTo a null', async () => {
    const res = await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: null });
    expect(res.status).toBe(200);
    expect(res.body.task.assignedTo).toBeNull();
  });

  it('rifiuta un aggiornamento che assegna a un utente di un\'altra azienda (404)', async () => {
    const res = await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assignedTo: otherCompanyOperaioId });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/v1/tasks/:id', () => {
  it('blocca l\'eliminazione se il task ha ore registrate collegate (409)', async () => {
    const logRes = await request(app)
      .post('/api/v1/time-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ taskId, userId: adminId, hoursWorked: '2', date: '2026-08-01', startTime: '08:00' });
    expect(logRes.status).toBe(201);
    const timeLogId: string = logRes.body.timeLogs[0].id;

    const delRes = await request(app).delete(`/api/v1/tasks/${taskId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(delRes.status).toBe(409);

    // Ripulisce la riga ore così il test sotto (eliminazione riuscita) trova il task
    // davvero senza ore collegate, coerente con lo scenario che deve verificare.
    await request(app).delete(`/api/v1/time-logs/${timeLogId}`).set('Authorization', `Bearer ${adminToken}`);
  });

  it('un admin elimina il task', async () => {
    const res = await request(app)
      .delete(`/api/v1/tasks/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
  });

  it('dopo eliminazione GET -> 404', async () => {
    const res = await request(app)
      .get(`/api/v1/tasks/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
