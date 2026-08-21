import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { createApp } from '../../app';
import { db } from '../../core/db';
import { users, auditLog, companies } from '../../core/db/schema';
import { signAccessToken } from '../auth/auth.service';
import { recordAudit } from './auditLog.service';

const app = createApp();
const BCRYPT_TEST_COST = 4;

const ADMIN_EMAIL = 'audit-test-admin@workflow360.local';
const RESOURCE_EMAIL = 'audit-test-resource@workflow360.local';
const OTHER_ADMIN_EMAIL = 'audit-test-other-admin@workflow360.local';

let companyId: string;
let otherCompanyId: string;
let adminToken: string;
let resourceToken: string;
let otherAdminToken: string;
let adminId: string;
let auditId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);
  const [company] = await db.insert(companies).values({ name: 'AuditTestCo' }).returning();
  companyId = company.id;
  const [otherCompany] = await db.insert(companies).values({ name: 'AuditTestCo Altra' }).returning();
  otherCompanyId = otherCompany.id;

  const [admin] = await db.insert(users).values({ email: ADMIN_EMAIL, passwordHash, name: 'Admin A', role: 'admin', companyId }).returning();
  const [resource] = await db.insert(users).values({ email: RESOURCE_EMAIL, passwordHash, name: 'Resource A', role: 'operaio', companyId }).returning();
  const [otherAdmin] = await db
    .insert(users)
    .values({ email: OTHER_ADMIN_EMAIL, passwordHash, name: 'Admin B', role: 'admin', companyId: otherCompanyId })
    .returning();
  adminId = admin.id;

  adminToken = signAccessToken({ id: admin.id, email: admin.email, role: admin.role, companyId });
  resourceToken = signAccessToken({ id: resource.id, email: resource.email, role: resource.role, companyId });
  otherAdminToken = signAccessToken({ id: otherAdmin.id, email: otherAdmin.email, role: otherAdmin.role, companyId: otherCompanyId });

  // Inserisce una voce di audit via recordAudit() (l'unico canale di scrittura consentito).
  const row = await recordAudit({
    companyId,
    userId: adminId,
    action: 'CREATE',
    entityType: 'project',
    entityId: '00000000-0000-0000-0000-0000000000ab',
    changes: { name: 'Test' },
  });
  auditId = row.id;
});

afterAll(async () => {
  await db.delete(auditLog).where(eq(auditLog.id, auditId)).catch(() => {});
  await db.delete(users).where(eq(users.email, ADMIN_EMAIL)).catch(() => {});
  await db.delete(users).where(eq(users.email, RESOURCE_EMAIL)).catch(() => {});
  await db.delete(users).where(eq(users.email, OTHER_ADMIN_EMAIL)).catch(() => {});
  await db.delete(companies).where(eq(companies.id, companyId)).catch(() => {});
  await db.delete(companies).where(eq(companies.id, otherCompanyId)).catch(() => {});
});

describe('GET /api/v1/audit-logs', () => {
  it('un admin puo leggere (200)', async () => {
    const res = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.auditLogs).toBeInstanceOf(Array);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  // Prima permesso ("trasparenza audit"), in contraddizione con CLAUDE.md che documenta
  // esplicitamente questa rotta come riservata ad admin/PM — allineato al documento.
  it('un resource NON puo leggere (403)', async () => {
    const res = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${resourceToken}`);
    expect(res.status).toBe(403);
  });

  it('senza token -> 401', async () => {
    const res = await request(app).get('/api/v1/audit-logs');
    expect(res.status).toBe(401);
  });

  it('filtra per entityType', async () => {
    const res = await request(app)
      .get('/api/v1/audit-logs?entityType=project')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.auditLogs.every((a: { entityType: string }) => a.entityType === 'project')).toBe(true);
  });

  it('isolamento multi-tenant: un admin di un\'altra azienda non vede la voce creata qui', async () => {
    const res = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${otherAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.auditLogs.some((a: { id: string }) => a.id === auditId)).toBe(false);
  });
});

describe('GET /api/v1/audit-logs/:id', () => {
  it('restituisce la voce creata', async () => {
    const res = await request(app)
      .get(`/api/v1/audit-logs/${auditId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.auditLog.id).toBe(auditId);
    expect(res.body.auditLog.action).toBe('CREATE');
  });

  it('id non valido -> 400', async () => {
    const res = await request(app)
      .get('/api/v1/audit-logs/non-un-uuid')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('id inesistente -> 404', async () => {
    const res = await request(app)
      .get('/api/v1/audit-logs/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('isolamento multi-tenant: un admin di un\'altra azienda riceve 404 (non 200 con dati altrui)', async () => {
    const res = await request(app)
      .get(`/api/v1/audit-logs/${auditId}`)
      .set('Authorization', `Bearer ${otherAdminToken}`);
    expect(res.status).toBe(404);
  });
});
