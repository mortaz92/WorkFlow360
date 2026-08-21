import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { createApp } from '../../app';
import { db } from '../../core/db';
import { users, projects, tasks, corrections, companies } from '../../core/db/schema';
import { signAccessToken } from '../auth/auth.service';

const app = createApp();
const BCRYPT_TEST_COST = 4;

const ADMIN_EMAIL = 'corr-test-admin@workflow360.local';
const PM_EMAIL = 'corr-test-pm@workflow360.local';
const RESOURCE_EMAIL = 'corr-test-resource@workflow360.local';

let companyId: string;
let adminToken: string;
let pmToken: string;
let resourceToken: string;
let pmId: string;
let projectId: string;
let taskId: string;
let correctionId: string;

const created: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);
  const [company] = await db.insert(companies).values({ name: 'CorrTestCo' }).returning();
  companyId = company.id;
  const [admin] = await db.insert(users).values({ email: ADMIN_EMAIL, passwordHash, name: 'Admin C', role: 'admin', companyId }).returning();
  // Era 'qa' prima del 20/08: ruolo rimosso (decisione utente), MANAGER_ROLES
  // ora è solo admin/project_manager — questo attore diventa un project_manager, non un
  // operaio, perché il test verifica proprio "un manager (diverso dall'admin) può creare".
  const [pm] = await db.insert(users).values({ email: PM_EMAIL, passwordHash, name: 'PM C', role: 'project_manager', companyId }).returning();
  const [resource] = await db.insert(users).values({ email: RESOURCE_EMAIL, passwordHash, name: 'Resource C', role: 'operaio', companyId }).returning();
  pmId = pm.id;

  adminToken = signAccessToken({ id: admin.id, email: admin.email, role: admin.role, companyId });
  pmToken = signAccessToken({ id: pm.id, email: pm.email, role: pm.role, companyId });
  resourceToken = signAccessToken({ id: resource.id, email: resource.email, role: resource.role, companyId });

  const [project] = await db.insert(projects).values({ name: 'Progetto per Correction Vitest', companyId, projectNumber: 1 }).returning();
  projectId = project.id;
  const [task] = await db.insert(tasks).values({ projectId, title: 'Task per Correction Vitest', companyId }).returning();
  taskId = task.id;
  created.push(projectId, taskId);
});

afterAll(async () => {
  await db.delete(corrections).where(eq(corrections.taskId, taskId)).catch(() => {});
  await db.delete(tasks).where(eq(tasks.id, taskId)).catch(() => {});
  await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
  await db.delete(users).where(eq(users.email, ADMIN_EMAIL)).catch(() => {});
  await db.delete(users).where(eq(users.email, PM_EMAIL)).catch(() => {});
  await db.delete(users).where(eq(users.email, RESOURCE_EMAIL)).catch(() => {});
  await db.delete(companies).where(eq(companies.id, companyId)).catch(() => {});
});

describe('POST /api/v1/corrections', () => {
  it('un project_manager segnala una correzione', async () => {
    const res = await request(app)
      .post('/api/v1/corrections')
      .set('Authorization', `Bearer ${pmToken}`)
      .send({ taskId, reportedBy: pmId, description: 'Bug nel calcolo ore', severity: 'high' });
    expect(res.status).toBe(201);
    expect(res.body.correction.description).toBe('Bug nel calcolo ore');
    expect(res.body.correction.status).toBe('open');
    correctionId = res.body.correction.id;
    created.push(correctionId);
  });

  it('task inesistente -> 404', async () => {
    const res = await request(app)
      .post('/api/v1/corrections')
      .set('Authorization', `Bearer ${pmToken}`)
      .send({ taskId: '00000000-0000-0000-0000-000000000000', reportedBy: pmId, description: 'X' });
    expect(res.status).toBe(404);
  });

  it('descrizione vuota -> 400', async () => {
    const res = await request(app)
      .post('/api/v1/corrections')
      .set('Authorization', `Bearer ${pmToken}`)
      .send({ taskId, reportedBy: pmId, description: '' });
    expect(res.status).toBe(400);
  });

  it('un operaio NON puo creare -> 403', async () => {
    const res = await request(app)
      .post('/api/v1/corrections')
      .set('Authorization', `Bearer ${resourceToken}`)
      .send({ taskId, reportedBy: pmId, description: 'Vietato' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/corrections', () => {
  it('un operaio NON puo leggere (403)', async () => {
    const res = await request(app).get('/api/v1/corrections').set('Authorization', `Bearer ${resourceToken}`);
    expect(res.status).toBe(403);
  });

  it('filtra per taskId', async () => {
    const res = await request(app)
      .get(`/api/v1/corrections?taskId=${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });
});

describe('PATCH /api/v1/corrections/:id', () => {
  it('un admin cambia status in approved', async () => {
    const res = await request(app)
      .patch(`/api/v1/corrections/${correctionId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body.correction.status).toBe('approved');
  });

  it('body vuoto -> 400', async () => {
    const res = await request(app)
      .patch(`/api/v1/corrections/${correctionId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/v1/corrections/:id', () => {
  it('un admin elimina la correzione', async () => {
    const res = await request(app)
      .delete(`/api/v1/corrections/${correctionId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
  });

  it('dopo eliminazione GET -> 404', async () => {
    const res = await request(app)
      .get(`/api/v1/corrections/${correctionId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
