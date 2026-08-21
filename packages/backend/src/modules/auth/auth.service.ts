import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import ms from 'ms';
import { z } from 'zod';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../../core/db';
import { users, refreshTokens, passwordResetTokens, userRoleEnum } from '../../core/db/schema';
import { CONFIG } from '../../core/config';
import { BCRYPT_COST } from '../../core/constants';
import { sendEmail } from '../../core/mail';
import { UnauthorizedError } from '../../core/errors';
import type { AccessTokenPayload, AuthenticatedUser } from './auth.types';

const REFRESH_TOKEN_BYTES = 48;
const PASSWORD_RESET_TOKEN_BYTES = 32;

// Hash bcrypt di una password inesistente, calcolato una sola volta all'avvio:
// serve a confrontare comunque qualcosa quando l'email non esiste (vedi verifyCredentials).
// Stesso costo delle password reali (BCRYPT_COST), per non rendere il timing distinguibile.
const dummyPasswordHash = bcrypt.hashSync('nessuna-password-corrisponde-a-questo-hash', BCRYPT_COST);

// Il refresh token è un valore casuale opaco, non un JWT: la revoca (logout,
// rotazione) deve poter invalidare un token istantaneamente lato server, cosa
// che un JWT autocontenuto non permette senza un registro di revoca comunque.
// Si salva solo l'hash: il token ha 384 bit di entropia casuale (non è una
// password scelta da un umano), quindi un brute-force è già impossibile a
// prescindere dalla velocità dell'hash — SHA-256 basta, bcrypt rallenterebbe
// solo le query legittime senza aggiungere sicurezza reale.
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateRefreshTokenValue(): string {
  return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

export function signAccessToken(user: AuthenticatedUser): string {
  const payload: AccessTokenPayload = { sub: user.id, email: user.email, role: user.role, companyId: user.companyId };
  // @types/jsonwebtoken vuole un literal type per expiresIn (es. "15m"), non una
  // "string" generica: la nostra viene da una env var validata a runtime da Zod,
  // non può essere tipizzata staticamente più di così senza un cast esplicito.
  const options: jwt.SignOptions = { expiresIn: CONFIG.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'] };
  return jwt.sign(payload, CONFIG.JWT_ACCESS_SECRET, options);
}

const accessTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  role: z.enum(userRoleEnum.enumValues),
  companyId: z.string().min(1),
});

export function verifyAccessToken(token: string): AccessTokenPayload {
  // jwt.verify garantisce firma e scadenza valide, ma il tipo di ritorno è un
  // JwtPayload generico: verifichiamo anche la FORMA del payload, così un token
  // valido ma con un contenuto inatteso (bug futuro, chiave compromessa) non
  // arriva a req.user con campi mancanti o del tipo sbagliato.
  const decoded = jwt.verify(token, CONFIG.JWT_ACCESS_SECRET);
  const parsed = accessTokenPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new UnauthorizedError('Token di accesso non valido o scaduto');
  }
  return parsed.data;
}

export async function verifyCredentials(email: string, password: string): Promise<AuthenticatedUser> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  // bcrypt.compare viene chiamato SEMPRE, anche quando l'utente non esiste
  // (confrontando con un hash fittizio): se saltassimo il confronto per email
  // inesistente, il tempo di risposta rivelerebbe quali email sono registrate
  // (timing side-channel), anche restituendo lo stesso messaggio di errore.
  const hashToCompare = user?.passwordHash ?? dummyPasswordHash;
  const passwordMatches = await bcrypt.compare(password, hashToCompare);

  if (!user || !user.active || !passwordMatches) {
    throw new UnauthorizedError('Credenziali non valide');
  }

  return { id: user.id, email: user.email, role: user.role, companyId: user.companyId };
}

export async function issueRefreshToken(userId: string): Promise<string> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    throw new UnauthorizedError('Utente non valido');
  }
  const tokenValue = generateRefreshTokenValue();
  const expiresAt = new Date(Date.now() + ms(CONFIG.JWT_REFRESH_EXPIRES_IN));

  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hashToken(tokenValue),
    expiresAt,
  });

  return tokenValue;
}

export async function rotateRefreshToken(
  oldTokenValue: string,
): Promise<{ user: AuthenticatedUser; refreshToken: string }> {
  const oldHash = hashToken(oldTokenValue);

  return db.transaction(async (tx) => {
    // SELECT ... FOR UPDATE blocca la riga per la durata della transazione: due
    // refresh simultanei con lo stesso token vengono serializzati da Postgres
    // invece di correre entrambi sulla stessa riga "non ancora revocata" — il
    // secondo, quando riprende, la trova già revocata dal primo e fallisce.
    const [record] = await tx
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, oldHash), isNull(refreshTokens.revokedAt)))
      .for('update')
      .limit(1);

    if (!record || record.expiresAt < new Date()) {
      throw new UnauthorizedError('Refresh token non valido o scaduto');
    }

    const [user] = await tx.select().from(users).where(eq(users.id, record.userId)).limit(1);
    if (!user || !user.active) {
      throw new UnauthorizedError('Refresh token non valido o scaduto');
    }

    // Rotazione: il token appena usato viene revocato subito, nella stessa
    // transazione dell'emissione del nuovo — se qualcuno riusa il vecchio token
    // dopo questo punto (es. un token rubato), lo trova già revocato.
    await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, record.id));

    const newTokenValue = generateRefreshTokenValue();
    const newExpiresAt = new Date(Date.now() + ms(CONFIG.JWT_REFRESH_EXPIRES_IN));
    await tx.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: hashToken(newTokenValue),
      expiresAt: newExpiresAt,
    });

    return {
      user: { id: user.id, email: user.email, role: user.role, companyId: user.companyId },
      refreshToken: newTokenValue,
    };
  });
}

export async function revokeRefreshToken(tokenValue: string): Promise<void> {
  const tokenHash = hashToken(tokenValue);
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.tokenHash, tokenHash));
}

function generatePasswordResetTokenValue(): string {
  return crypto.randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString('base64url');
}

function passwordResetEmailHtml(resetUrl: string): string {
  return (
    `<p>Hai richiesto di reimpostare la password del tuo account WorkFlow360.</p>` +
    `<p><a href="${resetUrl}">Clicca qui per scegliere una nuova password</a></p>` +
    `<p>Il link scade tra un'ora. Se non sei stato tu a richiederlo, ignora pure questa email: la tua password resta invariata.</p>`
  );
}

// Anti-enumerazione: risponde sempre "fatto" a chi chiama (la rotta in auth.routes.ts
// restituisce sempre 200 con lo stesso corpo), esista o no l'email, sia attivo o no
// l'utente — stesso principio già usato in verifyCredentials con l'hash fittizio.
// Un account disattivato non deve poter rientrare tramite il reset: active===false
// è trattato esattamente come "non esiste" ai fini di questo flusso.
export async function requestPasswordReset(email: string): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !user.active) {
    return;
  }

  // Invalida ogni token pendente dello stesso utente: una seconda richiesta di reset
  // non deve lasciare in vita due link validi contemporaneamente.
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));

  const tokenValue = generatePasswordResetTokenValue();
  const expiresAt = new Date(Date.now() + ms(CONFIG.PASSWORD_RESET_EXPIRES_IN));
  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: hashToken(tokenValue),
    expiresAt,
  });

  const resetUrl = `${CONFIG.APP_BASE_URL}/reset-password?token=${tokenValue}`;
  await sendEmail({
    to: user.email,
    subject: 'Reimposta la tua password WorkFlow360',
    html: passwordResetEmailHtml(resetUrl),
  });
}

export async function resetPassword(tokenValue: string, newPassword: string): Promise<void> {
  const tokenHash = hashToken(tokenValue);

  await db.transaction(async (tx) => {
    // FOR UPDATE: due richieste con lo stesso token vanno serializzate, la seconda lo
    // trova già usato — stesso idioma di rotateRefreshToken sopra, stessa ragione.
    const [record] = await tx
      .select()
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.tokenHash, tokenHash), isNull(passwordResetTokens.usedAt)))
      .for('update')
      .limit(1);

    if (!record || record.expiresAt < new Date()) {
      throw new UnauthorizedError('Link non valido o scaduto');
    }

    const [user] = await tx.select().from(users).where(eq(users.id, record.userId)).limit(1);
    if (!user || !user.active) {
      throw new UnauthorizedError('Link non valido o scaduto');
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    await tx.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, record.id));

    // Cambiare la password senza chiudere le sessioni aperte lascerebbe chi avesse
    // rubato la vecchia password dentro per altri JWT_REFRESH_EXPIRES_IN (7 giorni di
    // default) — il punto più facile da dimenticare in questo flusso, non un dettaglio.
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));
  });
}
