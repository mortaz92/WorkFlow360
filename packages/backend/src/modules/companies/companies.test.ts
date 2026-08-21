import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { createApp } from '../../app';
import { db } from '../../core/db';
import { users, companies, projects } from '../../core/db/schema';
import { signAccessToken } from '../auth/auth.service';

const app = createApp();
const BCRYPT_TEST_COST = 4;

const NEOTEKNA = 'Neotekna SRL';
const PERLUCE = 'Perluce SRL';

let neoteknaId: string;
let perluceId: string;
let neoTtoken: string;
let perToken: string;
let neoProjectId: string;

const created: { table: string; id: string }[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);
  const [neo] = await db.insert(companies).values({ name: NEOTEKNA, vat: 'IT0001' }).returning();
  const [per] = await db.insert(companies).values({ name: PERLUCE, vat: 'IT0002' }).returning();
  neoteknaId = neo.id;
  perluceId = per.id;
  created.push({ table: 'companies', id: neo.id }, { table: 'companies', id: per.id });

  const [neoAdmin] = await db
    .insert(users)
    .values({ email: 'neo-admin@x.local', passwordHash, name: 'Neo Admin', role: 'admin', companyId: neo.id })
    .returning();
  const [perAdmin] = await db
    .insert(users)
    .values({ email: 'per-admin@x.local', passwordHash, name: 'Per Admin', role: 'admin', companyId: per.id })
    .returning();

  neoTtoken = signAccessToken({ id: neoAdmin.id, email: neoAdmin.email, role: 'admin', companyId: neo.id });
  perToken = signAccessToken({ id: perAdmin.id, email: perAdmin.email, role: 'admin', companyId: per.id });

  const [proj] = await db.insert(projects).values({ name: 'Cantiere Neo', companyId: neo.id, projectNumber: 1 }).returning();
  neoProjectId = proj.id;
  created.push({ table: 'projects', id: proj.id });
});

afterAll(async () => {
  for (const c of created.filter((x) => x.table === 'projects')) {
    await db.delete(projects).where(eq(projects.id, c.id)).catch(() => {});
  }
  await db.delete(users).where(eq(users.email, 'neo-admin@x.local')).catch(() => {});
  await db.delete(users).where(eq(users.email, 'per-admin@x.local')).catch(() => {});
  await db.delete(companies).where(eq(companies.id, neoteknaId)).catch(() => {});
  await db.delete(companies).where(eq(companies.id, perluceId)).catch(() => {});
});

describe('Multi-tenant: isolamento aziende', () => {
  // Prima l'elenco era il catalogo GLOBALE (ogni azienda cliente del SaaS, con P.IVA/
  // email/telefono, visibile a chiunque autenticato di qualunque azienda — trovato da
  // un agente di sicurezza in questa sessione). Corretto: ogni azienda vede SOLO se
  // stessa, coerente con l'isolamento già applicato a progetti/ore/utenti/audit log.
  it("l'elenco aziende mostra SOLO la propria azienda, non le altre", async () => {
    const res = await request(app).get('/api/v1/companies').set('Authorization', `Bearer ${neoTtoken}`);
    expect(res.status).toBe(200);
    const names = res.body.companies.map((c: { name: string }) => c.name);
    expect(names).toContain(NEOTEKNA);
    expect(names).not.toContain(PERLUCE);
    expect(res.body.companies).toHaveLength(1);
  });

  it('GET /companies/:id di un\'altra azienda -> 404', async () => {
    const res = await request(app).get(`/api/v1/companies/${perluceId}`).set('Authorization', `Bearer ${neoTtoken}`);
    expect(res.status).toBe(404);
  });

  it('GET /companies/:id della propria azienda -> 200', async () => {
    const res = await request(app).get(`/api/v1/companies/${neoteknaId}`).set('Authorization', `Bearer ${neoTtoken}`);
    expect(res.status).toBe(200);
    expect(res.body.company.name).toBe(NEOTEKNA);
  });

  it('Neotekna vede i SUOI progetti e solo i suoi', async () => {
    const res = await request(app)
      .get('/api/v1/projects')
      .set('Authorization', `Bearer ${neoTtoken}`);
    expect(res.status).toBe(200);
    expect(res.body.projects.some((p: { id: string }) => p.id === neoProjectId)).toBe(true);
    // tutti i progetti restituiti appartengono a Neotekna
    expect(res.body.projects.every((p: { companyId: string }) => p.companyId === neoteknaId)).toBe(true);
  });

  it('Perluce NON vede il progetto di Neotekna (isolamento 404)', async () => {
    const res = await request(app)
      .get(`/api/v1/projects/${neoProjectId}`)
      .set('Authorization', `Bearer ${perToken}`);
    // Il progetto appartiene a Neotekna => Perluce riceve 404 (isolamento)
    expect(res.status).toBe(404);
  });

  it('ogni azienda ha il proprio companyId nel token', async () => {
    const resNeo = await request(app).get('/api/v1/companies').set('Authorization', `Bearer ${neoTtoken}`);
    const resPer = await request(app).get('/api/v1/companies').set('Authorization', `Bearer ${perToken}`);
    expect(resNeo.status).toBe(200);
    expect(resPer.status).toBe(200);
    expect(resNeo.body.companies.find((c: { name: string }) => c.name === NEOTEKNA).id).toBe(neoteknaId);
    expect(resPer.body.companies.find((c: { name: string }) => c.name === PERLUCE).id).toBe(perluceId);
  });
});
