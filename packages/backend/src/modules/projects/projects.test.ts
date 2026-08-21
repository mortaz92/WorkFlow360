import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { eq, inArray } from 'drizzle-orm';
import { createApp } from '../../app';
import { db } from '../../core/db';
import { users, projects, companies, tasks, timeLogs } from '../../core/db/schema';
import { signAccessToken } from '../auth/auth.service';

const app = createApp();
const BCRYPT_TEST_COST = 4;

const ADMIN_EMAIL = 'projects-test-admin@workflow360.local';
const MANAGER_EMAIL = 'projects-test-manager@workflow360.local';
const RESOURCE_EMAIL = 'projects-test-resource@workflow360.local';

let companyId: string;
let adminId: string;
let adminToken: string;
let managerToken: string;
let resourceToken: string;

const createdProjectIds: string[] = [];
let createdProjectId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);
  const [company] = await db.insert(companies).values({ name: 'ProjectsTestCo' }).returning();
  companyId = company.id;
  const [admin] = await db.insert(users).values({ email: ADMIN_EMAIL, passwordHash, name: 'Admin P', role: 'admin', companyId }).returning();
  const [manager] = await db.insert(users).values({ email: MANAGER_EMAIL, passwordHash, name: 'Manager P', role: 'project_manager', companyId }).returning();
  const [resource] = await db.insert(users).values({ email: RESOURCE_EMAIL, passwordHash, name: 'Resource P', role: 'operaio', companyId }).returning();
  adminId = admin.id;

  adminToken = signAccessToken({ id: admin.id, email: admin.email, role: admin.role, companyId });
  managerToken = signAccessToken({ id: manager.id, email: manager.email, role: manager.role, companyId });
  resourceToken = signAccessToken({ id: resource.id, email: resource.email, role: resource.role, companyId });
});

afterAll(async () => {
  if (createdProjectIds.length > 0) {
    await db.delete(projects).where(inArray(projects.id, createdProjectIds)).catch(() => {});
  }
  await db.delete(users).where(eq(users.email, ADMIN_EMAIL)).catch(() => {});
  await db.delete(users).where(eq(users.email, MANAGER_EMAIL)).catch(() => {});
  await db.delete(users).where(eq(users.email, RESOURCE_EMAIL)).catch(() => {});
  await db.delete(companies).where(eq(companies.id, companyId)).catch(() => {});
});

describe('POST /api/v1/projects', () => {
  it('un admin può creare un progetto', async () => {
    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Progetto Test Vitest', status: 'in_progress' });
    expect(res.status).toBe(201);
    expect(res.body.project.name).toBe('Progetto Test Vitest');
    expect(res.body.project.status).toBe('in_progress');
    createdProjectId = res.body.project.id;
    createdProjectIds.push(createdProjectId);
  });

  it('un manager può creare un progetto', async () => {
    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ name: 'Progetto Manager Vitest' });
    expect(res.status).toBe(201);
    createdProjectIds.push(res.body.project.id);
  });

  it('un resource (solo lettura) NON può creare → 403', async () => {
    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${resourceToken}`)
      .send({ name: 'Progetto Vietato' });
    expect(res.status).toBe(403);
  });

  it('nome vuoto → 400', async () => {
    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '' });
    expect(res.status).toBe(400);
  });

  it('tipoCommessa "contratto" viene salvato davvero (non ignorato)', async () => {
    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Progetto Tipo Vitest', tipoCommessa: 'contratto' });
    expect(res.status).toBe(201);
    expect(res.body.project.tipoCommessa).toBe('contratto');
    createdProjectIds.push(res.body.project.id);
  });

  it('senza tipoCommessa esplicito, il default resta "consuntivo"', async () => {
    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Progetto Tipo Default Vitest' });
    expect(res.status).toBe(201);
    expect(res.body.project.tipoCommessa).toBe('consuntivo');
    createdProjectIds.push(res.body.project.id);
  });

  it('projectNumber è assegnato ed è progressivo per azienda', async () => {
    const first = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Progetto Numero A Vitest' });
    expect(first.status).toBe(201);
    expect(typeof first.body.project.projectNumber).toBe('number');
    createdProjectIds.push(first.body.project.id);

    const second = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Progetto Numero B Vitest' });
    expect(second.status).toBe(201);
    createdProjectIds.push(second.body.project.id);

    expect(second.body.project.projectNumber).toBe(first.body.project.projectNumber + 1);
  });

  it('5 creazioni realmente concorrenti ricevono tutte 200/201 e numeri unici (nessuna collisione)', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request(app)
          .post('/api/v1/projects')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ name: `Progetto Concorrente ${i} Vitest` }),
      ),
    );
    responses.forEach((res) => {
      expect(res.status).toBe(201);
      createdProjectIds.push(res.body.project.id);
    });
    const numbers = responses.map((res) => res.body.project.projectNumber);
    expect(new Set(numbers).size).toBe(5); // tutti diversi, nessuna collisione sotto concorrenza vera
  });
});

describe('POST /api/v1/projects — codice cantiere (code)', () => {
  it('un cantiere può essere creato con un codice scritto a mano', async () => {
    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Cantiere Con Codice Vitest', code: 'CANT-01-VITEST' });
    expect(res.status).toBe(201);
    expect(res.body.project.code).toBe('CANT-01-VITEST');
    createdProjectIds.push(res.body.project.id);
  });

  it('senza codice, il campo resta null (non una stringa vuota)', async () => {
    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Cantiere Senza Codice Vitest' });
    expect(res.status).toBe(201);
    expect(res.body.project.code).toBeNull();
    createdProjectIds.push(res.body.project.id);
  });

  it('due cantieri della STESSA azienda con lo stesso codice → 400, non 500', async () => {
    const first = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Cantiere Duplicato A Vitest', code: 'DUP-VITEST' });
    expect(first.status).toBe(201);
    createdProjectIds.push(first.body.project.id);

    const second = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Cantiere Duplicato B Vitest', code: 'DUP-VITEST' });
    expect(second.status).toBe(400);
  });

  it('una stringa vuota o solo spazi equivale a nessun codice (non collide con un altro cantiere senza codice)', async () => {
    const first = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Cantiere Codice Vuoto A Vitest', code: '   ' });
    expect(first.status).toBe(201);
    expect(first.body.project.code).toBeNull();
    createdProjectIds.push(first.body.project.id);

    const second = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Cantiere Codice Vuoto B Vitest', code: '' });
    expect(second.status).toBe(201);
    expect(second.body.project.code).toBeNull();
    createdProjectIds.push(second.body.project.id);
  });

  it('due cantieri di AZIENDE DIVERSE possono avere lo stesso codice (scoping per company_id)', async () => {
    const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);
    const [otherCompany] = await db.insert(companies).values({ name: 'ProjectsTestCo Altra' }).returning();
    const [otherAdmin] = await db
      .insert(users)
      .values({ email: 'projects-test-admin-2@workflow360.local', passwordHash, name: 'Admin P2', role: 'admin', companyId: otherCompany.id })
      .returning();
    const otherAdminToken = signAccessToken({ id: otherAdmin.id, email: otherAdmin.email, role: otherAdmin.role, companyId: otherCompany.id });

    const mine = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Cantiere Cross-Tenant Mio Vitest', code: 'CROSS-TENANT-VITEST' });
    expect(mine.status).toBe(201);
    createdProjectIds.push(mine.body.project.id);

    const other = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${otherAdminToken}`)
      .send({ name: 'Cantiere Cross-Tenant Altro Vitest', code: 'CROSS-TENANT-VITEST' });
    expect(other.status).toBe(201);

    await db.delete(projects).where(eq(projects.id, other.body.project.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, otherAdmin.id)).catch(() => {});
    await db.delete(companies).where(eq(companies.id, otherCompany.id)).catch(() => {});
  });
});

describe('GET /api/v1/projects', () => {
  it('un resource può leggere la lista (204)', async () => {
    const res = await request(app).get('/api/v1/projects').set('Authorization', `Bearer ${resourceToken}`);
    expect(res.status).toBe(200);
    expect(res.body.projects).toBeInstanceOf(Array);
  });

  it('senza token → 401', async () => {
    const res = await request(app).get('/api/v1/projects');
    expect(res.status).toBe(401);
  });

  it('filtra per tipoCommessa: un cantiere a contratto non compare tra i consuntivo e viceversa', async () => {
    const contratto = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Filtro Tipo Contratto Vitest', tipoCommessa: 'contratto' });
    createdProjectIds.push(contratto.body.project.id);
    const consuntivo = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Filtro Tipo Consuntivo Vitest', tipoCommessa: 'consuntivo' });
    createdProjectIds.push(consuntivo.body.project.id);

    const soloContratto = await request(app)
      .get('/api/v1/projects?tipoCommessa=contratto&limit=100')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(soloContratto.status).toBe(200);
    const idsContratto = soloContratto.body.projects.map((p: { id: string }) => p.id);
    expect(idsContratto).toContain(contratto.body.project.id);
    expect(idsContratto).not.toContain(consuntivo.body.project.id);

    const soloConsuntivo = await request(app)
      .get('/api/v1/projects?tipoCommessa=consuntivo&limit=100')
      .set('Authorization', `Bearer ${adminToken}`);
    const idsConsuntivo = soloConsuntivo.body.projects.map((p: { id: string }) => p.id);
    expect(idsConsuntivo).toContain(consuntivo.body.project.id);
    expect(idsConsuntivo).not.toContain(contratto.body.project.id);
  });

  it('filtra per status (lista separata da virgole)', async () => {
    const bloccato = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Filtro Status Bloccato Vitest', status: 'blocked' });
    createdProjectIds.push(bloccato.body.project.id);

    const res = await request(app)
      .get('/api/v1/projects?status=completed,blocked&limit=100')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.projects.map((p: { id: string }) => p.id);
    expect(ids).toContain(bloccato.body.project.id);
    res.body.projects.forEach((p: { status: string }) => {
      expect(['completed', 'blocked']).toContain(p.status);
    });
  });
});

describe('GET /api/v1/projects/summary', () => {
  it('i conteggi per tipo e per stato sono coerenti con il totale', async () => {
    const res = await request(app).get('/api/v1/projects/summary').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const sumByTipo = res.body.byTipo.contratto + res.body.byTipo.consuntivo;
    const sumByStatus =
      res.body.byStatus.pending + res.body.byStatus.in_progress + res.body.byStatus.completed + res.body.byStatus.blocked;
    expect(sumByTipo).toBe(res.body.total);
    expect(sumByStatus).toBe(res.body.total);
    expect(res.body.total).toBeGreaterThan(0); // questa suite ha già creato progetti sopra
  });

  it('un resource può leggerlo (stesso livello di fiducia della lista)', async () => {
    const res = await request(app).get('/api/v1/projects/summary').set('Authorization', `Bearer ${resourceToken}`);
    expect(res.status).toBe(200);
  });

  it('senza token → 401', async () => {
    const res = await request(app).get('/api/v1/projects/summary');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/projects/:id', () => {
  it('restituisce il progetto creato', async () => {
    const res = await request(app)
      .get(`/api/v1/projects/${createdProjectId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.project.id).toBe(createdProjectId);
  });

  it('id non valido → 400', async () => {
    const res = await request(app)
      .get('/api/v1/projects/non-un-uuid')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('id inesistente → 404', async () => {
    const res = await request(app)
      .get('/api/v1/projects/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/v1/projects/:id', () => {
  it('un admin può aggiornare lo status', async () => {
    const res = await request(app)
      .patch(`/api/v1/projects/${createdProjectId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'completed' });
    expect(res.status).toBe(200);
    expect(res.body.project.status).toBe('completed');
  });

  it('body vuoto → 400', async () => {
    const res = await request(app)
      .patch(`/api/v1/projects/${createdProjectId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('un resource NON può aggiornare → 403', async () => {
    const res = await request(app)
      .patch(`/api/v1/projects/${createdProjectId}`)
      .set('Authorization', `Bearer ${resourceToken}`)
      .send({ status: 'blocked' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/v1/projects/:id', () => {
  it('blocca l\'eliminazione se un task del cantiere ha ore registrate collegate (409)', async () => {
    const [project] = await db.insert(projects).values({ name: 'Cantiere con ore', companyId, projectNumber: 999 }).returning();
    const [task] = await db.insert(tasks).values({ projectId: project.id, title: 'Lavoro con ore', companyId }).returning();
    const [log] = await db
      .insert(timeLogs)
      .values({ companyId, userId: adminId, taskId: task.id, tipo: 'ordinario', hoursWorked: '2', date: '2026-08-01' })
      .returning();

    const res = await request(app).delete(`/api/v1/projects/${project.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(409);

    // Ripulisce (ordine per via delle FK: righe ore -> task -> cantiere).
    await db.delete(timeLogs).where(eq(timeLogs.id, log.id));
    await db.delete(tasks).where(eq(tasks.id, task.id));
    await db.delete(projects).where(eq(projects.id, project.id));
  });

  it('un admin può eliminare il progetto', async () => {
    const res = await request(app)
      .delete(`/api/v1/projects/${createdProjectId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
  });

  it('dopo l\'eliminazione GET -> 404', async () => {
    const res = await request(app)
      .get(`/api/v1/projects/${createdProjectId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
