import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { and, eq, inArray } from 'drizzle-orm';
import { createApp } from '../../app';
import { db } from '../../core/db';
import { users, companies, auditLog, refreshTokens } from '../../core/db/schema';
import { ForbiddenError } from '../../core/errors';
import { signAccessToken } from '../auth/auth.service';
import { anonymizeUser, updateUser } from './users.service';

const app = createApp();

const BCRYPT_TEST_COST = 4; // volutamente basso per velocizzare i test — MAI in produzione

// Due admin di test: servono a poter verificare sia il caso "ultimo admin bloccato"
// sia il caso "ce n'è un altro, l'operazione può procedere".
const ADMIN_ONE_EMAIL = 'users-test-admin-1@workflow360.local';
const ADMIN_TWO_EMAIL = 'users-test-admin-2@workflow360.local';
const RESOURCE_EMAIL = 'users-test-resource@workflow360.local';

let companyId: string;
let adminOneId: string;
let adminTwoId: string;
let resourceId: string;
let adminOneToken: string;
let resourceToken: string;

const createdUserIds: string[] = [];
const createdCompanyIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);

  const [company] = await db.insert(companies).values({ name: 'UsersTestCo' }).returning();
  companyId = company.id;
  createdCompanyIds.push(companyId);

  const [adminOne] = await db
    .insert(users)
    .values({ email: ADMIN_ONE_EMAIL, passwordHash, name: 'Admin Uno', role: 'admin', companyId })
    .returning();
  const [adminTwo] = await db
    .insert(users)
    .values({ email: ADMIN_TWO_EMAIL, passwordHash, name: 'Admin Due', role: 'admin', companyId })
    .returning();
  const [resource] = await db
    .insert(users)
    .values({ email: RESOURCE_EMAIL, passwordHash, name: 'Risorsa Test', role: 'operaio', companyId })
    .returning();

  adminOneId = adminOne.id;
  adminTwoId = adminTwo.id;
  resourceId = resource.id;

  adminOneToken = signAccessToken({ id: adminOne.id, email: adminOne.email, role: adminOne.role, companyId });
  resourceToken = signAccessToken({ id: resource.id, email: resource.email, role: resource.role, companyId });
});

afterAll(async () => {
  // Prima le voci di audit: DELETE /users/:id (anonimizzazione) ne scrive una per ogni
  // utente rimosso, e audit_log.company_id ha un vincolo RESTRICT verso companies —
  // senza questa riga il DELETE della company qui sotto fallirebbe, facendo fallire
  // l'intero file per un problema di pulizia e non di codice.
  if (createdCompanyIds.length > 0) {
    await db.delete(auditLog).where(inArray(auditLog.companyId, createdCompanyIds));
  }
  const ids = [adminOneId, adminTwoId, resourceId, ...createdUserIds].filter(Boolean);
  if (ids.length > 0) {
    await db.delete(users).where(inArray(users.id, ids));
  }
  if (createdCompanyIds.length > 0) {
    await db.delete(companies).where(inArray(companies.id, createdCompanyIds));
  }
});

describe('RBAC su /api/v1/users', () => {
  it('rifiuta un ruolo non-admin con 403', async () => {
    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${resourceToken}`);
    expect(res.status).toBe(403);
  });

  it('rifiuta senza token con 401', async () => {
    const res = await request(app).get('/api/v1/users');
    expect(res.status).toBe(401);
  });

  it('accetta un admin con 200', async () => {
    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${adminOneToken}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toBeInstanceOf(Array);
    expect(res.body.total).toBeTypeOf('number');
  });
});

describe('POST /api/v1/users', () => {
  it('crea un utente e non restituisce mai passwordHash', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminOneToken}`)
      .send({ email: 'nuovo-utente@workflow360.local', name: 'Nuovo Utente', role: 'operaio', password: 'PasswordValida1' });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('nuovo-utente@workflow360.local');
    expect(res.body.user.passwordHash).toBeUndefined();
    createdUserIds.push(res.body.user.id);
  });

  it('rifiuta un email duplicata con 400 (non 500)', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminOneToken}`)
      .send({ email: ADMIN_ONE_EMAIL, name: 'Duplicato', role: 'operaio', password: 'PasswordValida1' });

    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/v1/users/:id — body vuoto', () => {
  it('rifiuta un body senza campi con 400', async () => {
    const res = await request(app)
      .patch(`/api/v1/users/${resourceId}`)
      .set('Authorization', `Bearer ${adminOneToken}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/v1/users/:id — email', () => {
  it('email già in uso da un altro utente -> 400 (non 500)', async () => {
    // Prima di questa sessione updateUser() non intercettava la violazione UNIQUE
    // sull'email (solo createUser() lo faceva): senza il fix, questa richiesta
    // sarebbe risposta con un 500 generico invece di un errore chiaro.
    const res = await request(app)
      .patch(`/api/v1/users/${resourceId}`)
      .set('Authorization', `Bearer ${adminOneToken}`)
      .send({ email: ADMIN_TWO_EMAIL });
    expect(res.status).toBe(400);
  });

  it('un admin può cambiare l\'email di un dipendente a un valore libero', async () => {
    const nuovaEmail = 'users-test-resource-nuova@workflow360.local';
    const res = await request(app)
      .patch(`/api/v1/users/${resourceId}`)
      .set('Authorization', `Bearer ${adminOneToken}`)
      .send({ email: nuovaEmail });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(nuovaEmail);

    // Verifica diretta sul DB, non solo sulla risposta HTTP.
    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, resourceId)).limit(1);
    expect(row.email).toBe(nuovaEmail);

    // Ripristinata: gli altri test di questo file assumono ancora RESOURCE_EMAIL.
    await db.update(users).set({ email: RESOURCE_EMAIL }).where(eq(users.id, resourceId));
  });
});

describe('Guardia auto-disattivazione', () => {
  it("un admin non può disattivare se stesso", async () => {
    const res = await request(app)
      .patch(`/api/v1/users/${adminOneId}`)
      .set('Authorization', `Bearer ${adminOneToken}`)
      .send({ active: false });
    expect(res.status).toBe(403);
  });
});

// Il conteggio della guardia è GLOBALE su tutta la tabella users, non scoped ai soli
// dati di test — e chiunque riesca a passare requireRole('admin') su una richiesta HTTP
// reale è per forza esso stesso un admin attivo in quel momento, il che porterebbe il
// conteggio ad almeno 2 (attore + bersaglio) ogni volta che attore e bersaglio sono
// utenti distinti: non si può quindi costruire "ultimo admin, attore diverso dal
// bersaglio" con una richiesta HTTP genuina. La guardia esiste per un caso più stretto
// (un token JWT con ruolo admin ancora valido ma il cui ruolo reale in DB è stato
// abbassato nel frattempo: requireRole si fida del ruolo nel JWT, non lo rilegge dal DB
// a ogni richiesta) — qui la testiamo direttamente a livello di servizio, indipendente
// da come l'autorizzazione è stata ottenuta, isolando il conteggio reale di admin
// attivi del DB con backup/ripristino nel finally.
describe('Guardia ultimo admin attivo (invariante di servizio)', () => {
  async function withOnlyAdminOneActive(run: () => Promise<void>): Promise<void> {
    // Scoped a companyId (azienda di questo file di test): la guardia che questo helper
    // simula è ORA per azienda (fix cross-tenant di questa sessione), quindi non c'è più
    // motivo di toccare admin di ALTRE aziende. Prima non c'era questo filtro e disattivava
    // OGNI admin attivo del database intero, inclusi account reali (verificato da un
    // agente di test con campionamento diretto del DB: ha sorpreso admin@workflow360.local
    // e l'admin reale dell'utente disattivati per la durata del test) — rischio di lock-out
    // vero se l'esecuzione si interrompe prima del ripristino nel finally.
    const otherActiveAdmins = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.active, true), eq(users.companyId, companyId)));
    const idsToSuspend = otherActiveAdmins.map((a) => a.id).filter((id) => id !== adminOneId);

    if (idsToSuspend.length > 0) {
      await db.update(users).set({ active: false }).where(inArray(users.id, idsToSuspend));
    }
    try {
      await run();
    } finally {
      if (idsToSuspend.length > 0) {
        await db.update(users).set({ active: true }).where(inArray(users.id, idsToSuspend));
      }
    }
  }

  it('blocca la disattivazione quando resterebbe zero admin attivi', async () => {
    await withOnlyAdminOneActive(async () => {
      await expect(
        updateUser(adminOneId, { active: false }, { id: 'attore-esterno-simulato', email: 'x@x.local', role: 'admin', companyId }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it("blocca la retrocessione di ruolo quando l'admin è l'unico attivo", async () => {
    await withOnlyAdminOneActive(async () => {
      await expect(
        updateUser(adminOneId, { role: 'operaio' }, { id: 'attore-esterno-simulato', email: 'x@x.local', role: 'admin', companyId }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it("permette l'operazione quando esiste un altro admin attivo (percorso positivo via HTTP)", async () => {
    const res = await request(app)
      .patch(`/api/v1/users/${adminTwoId}`)
      .set('Authorization', `Bearer ${adminOneToken}`)
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.user.active).toBe(false);

    // ripristina per non alterare lo stato atteso dagli altri test
    await db.update(users).set({ active: true }).where(eq(users.id, adminTwoId));
  });

  it('con ESATTAMENTE 2 admin attivi: disattivarne uno lascia il secondo protetto, mai zero', async () => {
    // Caso limite esplicito: isola il conteggio reale a solo {adminOne, adminTwo} (non 3+
    // come nel test sopra, dove il conteggio include anche altri admin reali del DB).
    // adminOne disattiva adminTwo (conteggio=2, permesso). A quel punto adminTwo non è più
    // attivo: un suo tentativo di disattivare adminOne deve essere bloccato (conteggio=1),
    // e adminOne non può comunque auto-disattivarsi. L'invariante "mai zero admin attivi"
    // deve reggere anche in questo caso limite, non solo con 3+ admin di margine.
    await withOnlyAdminOneActive(async () => {
      await db.update(users).set({ active: true }).where(eq(users.id, adminTwoId));

      const res1 = await request(app)
        .patch(`/api/v1/users/${adminTwoId}`)
        .set('Authorization', `Bearer ${adminOneToken}`)
        .send({ active: false });
      expect(res1.status).toBe(200);

      await expect(
        updateUser(adminOneId, { active: false }, { id: adminTwoId, email: ADMIN_TWO_EMAIL, role: 'admin', companyId }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const stillActive = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.active, true)));
      expect(stillActive.length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('Isolamento multi-tenant su PATCH/DELETE /api/v1/users/:id', () => {
  // Azienda dedicata con i propri 2 admin: serve a dimostrare che l'azienda principale
  // di questo file (companyId, con adminOne+adminTwo sani) NON "copre" per errore
  // l'invariante di QUESTA azienda — prima del fix il conteggio globale avrebbe
  // permesso di azzerare gli admin di qui semplicemente perché ne esistevano altri
  // altrove nel sistema.
  let otherCompanyId: string;
  let otherAdminOneId: string;
  let otherAdminTwoId: string;
  let otherAdminOneToken: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);
    const [company] = await db.insert(companies).values({ name: 'IsolationTestCo' }).returning();
    otherCompanyId = company.id;
    const [a1] = await db
      .insert(users)
      .values({ email: 'isolation-admin-1@workflow360.local', passwordHash, name: 'Iso Admin 1', role: 'admin', companyId: otherCompanyId })
      .returning();
    const [a2] = await db
      .insert(users)
      .values({ email: 'isolation-admin-2@workflow360.local', passwordHash, name: 'Iso Admin 2', role: 'admin', companyId: otherCompanyId })
      .returning();
    otherAdminOneId = a1.id;
    otherAdminTwoId = a2.id;
    otherAdminOneToken = signAccessToken({ id: a1.id, email: a1.email, role: 'admin', companyId: otherCompanyId });
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.companyId, otherCompanyId)).catch(() => {});
    await db.delete(companies).where(eq(companies.id, otherCompanyId)).catch(() => {});
  });

  it('un admin non vede/modifica un utente di un\'altra azienda (404, non 200 con dati altrui)', async () => {
    const res = await request(app)
      .patch(`/api/v1/users/${otherAdminOneId}`)
      .set('Authorization', `Bearer ${adminOneToken}`)
      .send({ active: false });
    expect(res.status).toBe(404);

    // Prova diretta che NON è stato modificato: ancora attivo nel DB.
    const [row] = await db.select({ active: users.active }).from(users).where(eq(users.id, otherAdminOneId));
    expect(row.active).toBe(true);
  });

  it(
    "l'invariante 'ultimo admin attivo' è per azienda: l'azienda principale del file (2+ admin sani) " +
      'non maschera lo zero-admin di questa azienda separata',
    async () => {
      // otherAdminOne disattiva otherAdminTwo: consentito, restano 0 admin attivi qui
      // (otherAdminOne stesso NON è toccato da questa chiamata, ma verifichiamo comunque
      // lo stato reale subito dopo prima del passo successivo).
      const res1 = await request(app)
        .patch(`/api/v1/users/${otherAdminTwoId}`)
        .set('Authorization', `Bearer ${otherAdminOneToken}`)
        .send({ active: false });
      expect(res1.status).toBe(200);

      // Ora otherAdminOne è l'UNICO admin attivo di questa azienda. Nel resto del
      // sistema (azienda principale del file) restano adminOne+adminTwo attivi: se il
      // conteggio della guardia fosse ancora globale, questa chiamata passerebbe (bug).
      // Retrocessione di RUOLO su se stessi, non disattivazione: `active:false` su se
      // stessi verrebbe comunque bloccato dalla guardia PRECEDENTE "non puoi disattivare
      // il tuo stesso account" (righe 120-122 di users.service.ts), che non guarda affatto
      // companyId — un test così passerebbe per il motivo sbagliato anche senza il fix per
      // azienda (trovato da un agente di test rilanciando la suite con quel filtro rimosso:
      // 16/16 verdi comunque). La retrocessione di ruolo non ha quella guardia, quindi
      // arriva davvero al conteggio scoped per azienda che questo test deve esercitare.
      const res2 = await request(app)
        .patch(`/api/v1/users/${otherAdminOneId}`)
        .set('Authorization', `Bearer ${otherAdminOneToken}`)
        .send({ role: 'operaio' });
      expect(res2.status).toBe(403);

      const [row] = await db.select({ active: users.active, role: users.role }).from(users).where(eq(users.id, otherAdminOneId));
      expect(row.active).toBe(true);
      expect(row.role).toBe('admin');

      // ripristina per non alterare lo stato atteso da eventuali altri test
      await db.update(users).set({ active: true }).where(eq(users.id, otherAdminTwoId));
    },
  );
});

describe('POST /api/v1/users — limite 3 utenti per azienda', () => {
  // Azienda dedicata per non collidere con i 3 utenti creati in beforeAll
  // (adminOne/adminTwo/resource appartengono tutti a companyId di questo file).
  let limitCompanyId: string;
  let limitAdminToken: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);
    const [company] = await db.insert(companies).values({ name: 'LimitTestCo' }).returning();
    limitCompanyId = company.id;
    const [admin] = await db
      .insert(users)
      .values({ email: 'limit-admin@workflow360.local', passwordHash, name: 'Limit Admin', role: 'admin', companyId: limitCompanyId })
      .returning();
    limitAdminToken = signAccessToken({ id: admin.id, email: admin.email, role: 'admin', companyId: limitCompanyId });
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.companyId, limitCompanyId)).catch(() => {});
    await db.delete(companies).where(eq(companies.id, limitCompanyId)).catch(() => {});
  });

  it('consente di creare fino a 3 amministratori totali (201)', async () => {
    // La company parte con 1 admin (limit-admin), quindi ne accetta altri 2 (totale 3).
    for (let i = 1; i <= 2; i++) {
      const res = await request(app)
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${limitAdminToken}`)
        .send({ email: `limit-u${i}@workflow360.local`, name: `U${i}`, role: 'admin', password: 'PasswordValida1' });
      expect(res.status).toBe(201);
    }
  });

  it('blocca il 4° amministratore con 409 Conflict', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${limitAdminToken}`)
      .send({ email: 'limit-u4@workflow360.local', name: 'U4', role: 'admin', password: 'PasswordValida1' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  // Il tetto valeva solo alla creazione: si aggirava creando un utente con un altro
  // ruolo e promuovendolo subito dopo via PATCH. A questo punto l'azienda ha già 3
  // admin (limit-admin, limit-u1, limit-u2) dal test sopra.
  it('blocca la promozione ad admin via PATCH quando il tetto è già raggiunto (409)', async () => {
    const createRes = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${limitAdminToken}`)
      .send({ email: 'limit-promote@workflow360.local', name: 'Da Promuovere', role: 'operaio', password: 'PasswordValida1' });
    expect(createRes.status).toBe(201);

    const patchRes = await request(app)
      .patch(`/api/v1/users/${createRes.body.user.id}`)
      .set('Authorization', `Bearer ${limitAdminToken}`)
      .send({ role: 'admin' });
    expect(patchRes.status).toBe(409);
    expect(patchRes.body.error.code).toBe('CONFLICT');

    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, createRes.body.user.id));
    expect(row.role).toBe('operaio');
  });
});

// DELETE /:id non è più un soft-delete (era `active:false` e basta): oggi anonimizza
// davvero i dati personali — diritto alla cancellazione GDPR. La riga utente resta, perché
// le ore lavorate ci sono collegate via userId e vanno conservate per la contabilità.
// La sospensione reversibile è rimasta un'operazione distinta: PATCH /:id con
// `{active:false}`, che NON tocca nome ed email (coperta dai describe più sopra).
describe('DELETE /api/v1/users/:id (anonimizzazione)', () => {
  const SUFFISSO_ANONIMO = '@anonimizzato.workflow360.local';

  // Azienda dedicata con UN SOLO admin attivo: serve al caso "ultimo admin", che
  // nell'azienda principale del file non è costruibile (lì adminOne e adminTwo sono
  // entrambi attivi, come richiedono gli altri test).
  let gdprCompanyId: string;
  let soloAdminId: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash('TestPassword123!', BCRYPT_TEST_COST);
    const [company] = await db.insert(companies).values({ name: 'GdprTestCo' }).returning();
    gdprCompanyId = company.id;
    const [soloAdmin] = await db
      .insert(users)
      .values({ email: 'gdpr-solo-admin@workflow360.local', passwordHash, name: 'Solo Admin', role: 'admin', companyId: gdprCompanyId })
      .returning();
    soloAdminId = soloAdmin.id;
  });

  afterAll(async () => {
    await db.delete(auditLog).where(eq(auditLog.companyId, gdprCompanyId)).catch(() => {});
    await db.delete(users).where(eq(users.companyId, gdprCompanyId)).catch(() => {});
    await db.delete(companies).where(eq(companies.id, gdprCompanyId)).catch(() => {});
  });

  // Ogni test si crea il proprio bersaglio: l'anonimizzazione è irreversibile, riusarne
  // uno tra test diversi li renderebbe dipendenti dall'ordine di esecuzione.
  async function creaDipendente(email: string, password: string, department: string | null = null): Promise<string> {
    const passwordHash = await bcrypt.hash(password, BCRYPT_TEST_COST);
    const [row] = await db
      .insert(users)
      .values({ email, passwordHash, name: 'Mario Rossi', role: 'operaio', companyId, department })
      .returning();
    createdUserIds.push(row.id);
    return row.id;
  }

  it('sostituisce nome ed email nella risposta e disattiva l\'account', async () => {
    const id = await creaDipendente('gdpr-base@workflow360.local', 'DaRimuovere123!');

    const res = await request(app).delete(`/api/v1/users/${id}`).set('Authorization', `Bearer ${adminOneToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Utente rimosso');
    expect(res.body.user.email.endsWith(SUFFISSO_ANONIMO)).toBe(true);
    expect(res.body.user.active).toBe(false);
    // La riga deve restare: è ciò che tiene in piedi le ore lavorate collegate a userId.
    expect(res.body.user.id).toBe(id);
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('cancella davvero i dati personali sul DB (reparto azzerato, password non più valida)', async () => {
    const id = await creaDipendente('gdpr-db@workflow360.local', 'DaRimuovere123!', 'Cantiere Nord');
    const [prima] = await db.select().from(users).where(eq(users.id, id)).limit(1);

    const res = await request(app).delete(`/api/v1/users/${id}`).set('Authorization', `Bearer ${adminOneToken}`);
    expect(res.status).toBe(200);

    // Verifica sul DB, non sulla risposta HTTP: è il database che non deve più contenere
    // i dati personali, la risposta potrebbe mostrare valori ripuliti su una riga intatta.
    const [dopo] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    expect(dopo.department).toBeNull();
    expect(dopo.name).toBe('Utente rimosso');
    expect(dopo.email).not.toBe('gdpr-db@workflow360.local');
    expect(dopo.email.endsWith(SUFFISSO_ANONIMO)).toBe(true);
    expect(dopo.active).toBe(false);
    // Confronto diretto degli hash: un tentativo di login fallirebbe comunque per
    // `active:false` (vedi verifyCredentials), quindi un 401 NON proverebbe che la
    // vecchia password è stata sostituita — solo che l'account è spento.
    expect(dopo.passwordHash).not.toBe(prima.passwordHash);
    // Il ruolo resta: serve alle statistiche aggregate e da solo non identifica nessuno.
    expect(dopo.role).toBe('operaio');
  });

  it("un login con l'account rimosso fallisce (caso già coperto quando era un soft-delete)", async () => {
    const id = await creaDipendente('da-disattivare@workflow360.local', 'DaDisattivare123!');

    const res = await request(app).delete(`/api/v1/users/${id}`).set('Authorization', `Bearer ${adminOneToken}`);
    expect(res.status).toBe(200);

    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'da-disattivare@workflow360.local', password: 'DaDisattivare123!' });
    expect(loginRes.status).toBe(401);
  });

  it('un admin non può anonimizzare se stesso', async () => {
    // Precondizione esplicita: adminTwo è attivo, quindi adminOne NON è l'ultimo admin —
    // senza questa verifica un 403 potrebbe arrivare dalla guardia sbagliata (ultimo
    // admin) e il test passerebbe per il motivo sbagliato.
    const [altro] = await db.select({ active: users.active }).from(users).where(eq(users.id, adminTwoId)).limit(1);
    expect(altro.active).toBe(true);

    const res = await request(app).delete(`/api/v1/users/${adminOneId}`).set('Authorization', `Bearer ${adminOneToken}`);
    expect(res.status).toBe(403);

    const [row] = await db.select().from(users).where(eq(users.id, adminOneId)).limit(1);
    expect(row.email).toBe(ADMIN_ONE_EMAIL);
    expect(row.active).toBe(true);
  });

  // Stesso invariante già coperto per la disattivazione/retrocessione (describe "Guardia
  // ultimo admin attivo"), verificato qui sul secondo percorso che può azzerare gli admin
  // di un'azienda. A livello di servizio per lo stesso motivo spiegato lì: con una
  // richiesta HTTP genuina attore e bersaglio distinti implicano già 2 admin attivi.
  it("non permette di anonimizzare l'ultimo admin attivo dell'azienda", async () => {
    await expect(
      anonymizeUser(soloAdminId, {
        id: 'attore-esterno-simulato',
        email: 'x@x.local',
        role: 'admin',
        companyId: gdprCompanyId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const [row] = await db.select().from(users).where(eq(users.id, soloAdminId)).limit(1);
    expect(row.email).toBe('gdpr-solo-admin@workflow360.local');
    expect(row.name).toBe('Solo Admin');
    expect(row.active).toBe(true);
  });

  it('una seconda DELETE sullo stesso utente risponde 409, non un 200 silenzioso', async () => {
    const id = await creaDipendente('gdpr-due-volte@workflow360.local', 'DaRimuovere123!');

    const prima = await request(app).delete(`/api/v1/users/${id}`).set('Authorization', `Bearer ${adminOneToken}`);
    expect(prima.status).toBe(200);
    const emailAnonima = prima.body.user.email;

    const seconda = await request(app).delete(`/api/v1/users/${id}`).set('Authorization', `Bearer ${adminOneToken}`);
    expect(seconda.status).toBe(409);
    expect(seconda.body.error.code).toBe('CONFLICT');

    // L'email sintetica non è stata riscritta da un secondo giro.
    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, id)).limit(1);
    expect(row.email).toBe(emailAnonima);
  });

  it("revoca i refresh token: una sessione aperta dell'utente non si rinnova più", async () => {
    const email = 'gdpr-sessione@workflow360.local';
    const password = 'SessioneAperta123!';
    const id = await creaDipendente(email, password);

    const login = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(login.status).toBe(200);
    // @types/superagent tipizza gli header come Record<string, string>, ma per
    // "set-cookie" il valore reale a runtime è sempre un array (stesso cast in auth.test.ts).
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0];

    const del = await request(app).delete(`/api/v1/users/${id}`).set('Authorization', `Bearer ${adminOneToken}`);
    expect(del.status).toBe(200);

    const refresh = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(refresh.status).toBe(401);

    // Il 401 qui sopra da solo NON prova la revoca: rotateRefreshToken rifiuta comunque un
    // utente non attivo, e l'anonimizzazione disattiva sempre — lo stesso 401 arriverebbe
    // anche senza revocare nulla. La prova che i token siano stati davvero revocati (e non
    // solo resi inutili finché l'utente è spento) sta nella colonna revoked_at.
    const righe = await db
      .select({ revokedAt: refreshTokens.revokedAt })
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, id));
    expect(righe.length).toBeGreaterThan(0);
    expect(righe.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it("lascia una voce di audit che NON contiene il vecchio nome né la vecchia email", async () => {
    const email = 'gdpr-audit@workflow360.local';
    const id = await creaDipendente(email, 'DaRimuovere123!', 'Ufficio Tecnico');

    const res = await request(app).delete(`/api/v1/users/${id}`).set('Authorization', `Bearer ${adminOneToken}`);
    expect(res.status).toBe(200);

    const righe = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.companyId, companyId), eq(auditLog.entityId, id), eq(auditLog.action, 'DELETE')));
    expect(righe.length).toBe(1);
    expect(righe[0].entityType).toBe('users');
    expect(righe[0].userId).toBe(adminOneId);

    // Il punto dell'anonimizzazione è che quei dati non esistano più DA NESSUNA PARTE:
    // un audit log che li conserva sposta il problema di tabella invece di risolverlo.
    const tracciato = JSON.stringify(righe[0].changesJson);
    expect(tracciato).not.toContain(email);
    expect(tracciato).not.toContain('Mario Rossi');
    expect(tracciato).not.toContain('Ufficio Tecnico');
  });
});
