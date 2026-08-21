import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { createApp } from '../../app';
import { db } from '../../core/db';
import { users, refreshTokens, passwordResetTokens, companies } from '../../core/db/schema';

// Stesso schema di hashing di auth.service.ts (SHA-256, non esportato: è un dettaglio
// interno, non un'API del modulo). Serve qui per inserire un token di reset "come se"
// fosse stato generato da requestPasswordReset, senza dover intercettare l'email reale
// per leggere il valore in chiaro — che il sistema, per progetto, non espone mai via HTTP.
function hashTokenForTest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createResetTokenForTest(userId: string, opts: { expired?: boolean; used?: boolean } = {}): Promise<string> {
  const tokenValue = crypto.randomBytes(32).toString('base64url');
  await db.insert(passwordResetTokens).values({
    userId,
    tokenHash: hashTokenForTest(tokenValue),
    expiresAt: opts.expired ? new Date(Date.now() - 1000) : new Date(Date.now() + 60 * 60 * 1000),
    usedAt: opts.used ? new Date() : null,
  });
  return tokenValue;
}

const app = createApp();

const TEST_EMAIL = 'auth-test@workflow360.local';
const TEST_PASSWORD = 'TestPassword123!';
const BCRYPT_TEST_COST = 4; // volutamente basso per velocizzare i test — MAI in produzione
let testUserId: string;
let companyId: string;

// @types/superagent tipizza gli header come Record<string, string>, ma per
// "set-cookie" il valore reale a runtime è sempre un array (una entry per cookie).
function getSetCookies(res: request.Response): string[] {
  return res.headers['set-cookie'] as unknown as string[];
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, BCRYPT_TEST_COST);
  const [company] = await db.insert(companies).values({ name: 'AuthTestCo' }).returning();
  companyId = company.id;
  const [user] = await db
    .insert(users)
    .values({ email: TEST_EMAIL, passwordHash, name: 'Auth Test', role: 'operaio', companyId })
    .returning();
  testUserId = user.id;
});

afterAll(async () => {
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, testUserId));
  await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, testUserId));
  await db.delete(users).where(eq(users.id, testUserId));
  await db.delete(companies).where(eq(companies.id, companyId));
});

describe('POST /api/v1/auth/login', () => {
  it('rifiuta password sbagliata con 401 generico', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: TEST_EMAIL, password: 'password-sbagliata' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rifiuta un email inesistente con lo stesso messaggio (no user enumeration)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'non-esiste@workflow360.local', password: 'qualsiasi' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Credenziali non valide');
  });

  it('accetta credenziali corrette e imposta il cookie httpOnly di refresh', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.body.user.email).toBe(TEST_EMAIL);

    const cookies = getSetCookies(res) ?? [];
    expect(cookies.some((c) => c.startsWith('wf360_refresh=') && c.includes('HttpOnly'))).toBe(true);
  });
});

describe('GET /api/v1/auth/me', () => {
  it('rifiuta senza token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('accetta con un access token valido', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(TEST_EMAIL);
  });

  it('rifiuta un access token valido se l\'utente è stato disattivato nel frattempo', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    await db.update(users).set({ active: false }).where(eq(users.id, testUserId));
    try {
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`);
      expect(res.status).toBe(401);
    } finally {
      await db.update(users).set({ active: true }).where(eq(users.id, testUserId));
    }
  });
});

describe('POST /api/v1/auth/login — body malformato', () => {
  it('risponde 400 (non 500) su un JSON non valido', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('questo non è json valido {{{');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('ruota il refresh token: il vecchio non è più riutilizzabile dopo un refresh', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const originalCookie = getSetCookies(login)[0];

    const first = await request(app).post('/api/v1/auth/refresh').set('Cookie', originalCookie);
    expect(first.status).toBe(200);
    expect(first.body.accessToken).toBeTypeOf('string');

    const reuse = await request(app).post('/api/v1/auth/refresh').set('Cookie', originalCookie);
    expect(reuse.status).toBe(401);
  });

  // Il vecchio test verificava solo che l'accessToken fosse una stringa, non che
  // funzionasse davvero: un bug reale (companyId mancante nel payload dopo un
  // refresh) è passato inosservato per questo, rompendo ogni sessione al primo
  // refresh automatico. Qui si verifica il comportamento osservabile: il token
  // refreshato deve autenticare una richiesta reale, non solo "esistere".
  it('il nuovo access token dopo il refresh autentica correttamente una richiesta reale', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const cookie = getSetCookies(login)[0];

    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(refreshed.status).toBe(200);

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.companyId).toBe(companyId);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revoca il refresh token corrente: un refresh successivo fallisce', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const cookie = getSetCookies(login)[0];

    const logoutRes = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie);
    expect(logoutRes.status).toBe(204);

    const refreshAfterLogout = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(refreshAfterLogout.status).toBe(401);
  });
});

describe('POST /api/v1/auth/forgot-password', () => {
  it('email inesistente -> 200 con lo stesso messaggio di un\'email valida (no enumeration)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'non-esiste@workflow360.local' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/registrato/);
  });

  it('formato email non valido -> 400', async () => {
    const res = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'non-una-email' });
    expect(res.status).toBe(400);
  });

  // Due comportamenti in un solo test (non due) per restare sotto il rate limiter
  // dedicato di questa rotta (5/15min, deliberatamente stretto — vedi app.ts): un
  // file di test che sommasse troppe richieste sulla stessa rotta finirebbe bloccato
  // dal proprio stesso limite, un problema di ambiente di test, non del codice.
  it('email valida e attiva -> 200, crea un token pendente; una seconda richiesta invalida il precedente', async () => {
    const first = await request(app).post('/api/v1/auth/forgot-password').send({ email: TEST_EMAIL });
    expect(first.status).toBe(200);

    const afterFirst = await db
      .select()
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, testUserId), isNull(passwordResetTokens.usedAt)));
    expect(afterFirst.length).toBe(1);

    const second = await request(app).post('/api/v1/auth/forgot-password').send({ email: TEST_EMAIL });
    expect(second.status).toBe(200);

    // Mai due link validi insieme: la seconda richiesta invalida il token della prima.
    const afterSecond = await db
      .select()
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, testUserId), isNull(passwordResetTokens.usedAt)));
    expect(afterSecond.length).toBe(1);
  });

  it('utente disattivato -> 200 (stesso messaggio), ma NESSUN token creato', async () => {
    await db.update(users).set({ active: false }).where(eq(users.id, testUserId));
    try {
      const before = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, testUserId));
      const res = await request(app).post('/api/v1/auth/forgot-password').send({ email: TEST_EMAIL });
      expect(res.status).toBe(200);
      const after = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, testUserId));
      expect(after.length).toBe(before.length); // invariato: nessuna riga nuova
    } finally {
      await db.update(users).set({ active: true }).where(eq(users.id, testUserId));
    }
  });

});

describe('POST /api/v1/auth/reset-password', () => {
  const RESET_PASSWORD = 'NuovaPassword456!';

  it('token valido -> 204, la password cambia davvero (login vecchio fallisce, nuovo funziona)', async () => {
    const token = await createResetTokenForTest(testUserId);
    const res = await request(app).post('/api/v1/auth/reset-password').send({ token, password: RESET_PASSWORD });
    expect(res.status).toBe(204);

    // Verifica diretta sull'hash in DB, non via /login: evita di consumare altre
    // richieste sul rate limiter del login (10/15min), già impegnato dagli altri
    // test di questo file — la correttezza del login in sé è già coperta a fondo
    // dalla suite POST /api/v1/auth/login più sopra.
    const [row] = await db.select().from(users).where(eq(users.id, testUserId)).limit(1);
    expect(await bcrypt.compare(RESET_PASSWORD, row.passwordHash)).toBe(true);
    expect(await bcrypt.compare(TEST_PASSWORD, row.passwordHash)).toBe(false);

    // Ripristina la password originale per non intaccare gli altri test di questo file.
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, BCRYPT_TEST_COST);
    await db.update(users).set({ passwordHash }).where(eq(users.id, testUserId));
  });

  // 401 (UnauthorizedError), non 400: stesso codice già usato per un refresh token
  // invalido/scaduto (rotateRefreshToken in auth.service.ts) — un token di reset è
  // concettualmente lo stesso tipo di credenziale, quindi la stessa semantica HTTP.
  it('lo stesso token usato una seconda volta -> 401 (monouso)', async () => {
    const token = await createResetTokenForTest(testUserId, { used: true });
    const res = await request(app).post('/api/v1/auth/reset-password').send({ token, password: RESET_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('token scaduto -> 401', async () => {
    const token = await createResetTokenForTest(testUserId, { expired: true });
    const res = await request(app).post('/api/v1/auth/reset-password').send({ token, password: RESET_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('token inesistente -> 401', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'token-mai-esistito', password: RESET_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('password troppo corta -> 400', async () => {
    const token = await createResetTokenForTest(testUserId);
    const res = await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'corta' });
    expect(res.status).toBe(400);
  });

  it('resettare la password revoca tutti i refresh token esistenti dell\'utente', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const cookie = getSetCookies(login)[0];

    const token = await createResetTokenForTest(testUserId);
    const reset = await request(app).post('/api/v1/auth/reset-password').send({ token, password: RESET_PASSWORD });
    expect(reset.status).toBe(204);

    const refreshAfterReset = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(refreshAfterReset.status).toBe(401);

    // Ripristina la password originale per non intaccare gli altri test di questo file.
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, BCRYPT_TEST_COST);
    await db.update(users).set({ passwordHash }).where(eq(users.id, testUserId));
  });
});
