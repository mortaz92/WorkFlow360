import type { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { users } from '../../core/db/schema';
import { ForbiddenError, UnauthorizedError } from '../../core/errors';
import { verifyAccessToken } from './auth.service';
import type { UserRole } from './auth.types';

const BEARER_PREFIX = 'Bearer ';

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith(BEARER_PREFIX)) {
    next(new UnauthorizedError('Token di accesso mancante'));
    return;
  }

  const token = authHeader.slice(BEARER_PREFIX.length);

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    next(new UnauthorizedError('Token di accesso non valido o scaduto'));
    return;
  }

  let user;
  try {
    // La firma valida del JWT da sola non basta: se l'admin disattiva l'utente,
    // un access token già emesso deve smettere di funzionare subito, non aspettare
    // la sua scadenza naturale (fino a 15 minuti di finestra altrimenti).
    [user] = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
    if (!user || !user.active) {
      next(new UnauthorizedError('Utente non autorizzato'));
      return;
    }
  } catch (err) {
    next(err);
    return;
  }

  // Costruito dalla riga DB appena letta, non dal payload del token: ruolo e companyId
  // nel JWT restano quelli di quando è stato emesso, fino a JWT_ACCESS_EXPIRES_IN (15m
  // di default) più vecchi della realtà. Esempio concreto (FASE 5, 12/08): un
  // project_manager retrocesso da un admin continuerebbe a gestire i task col vecchio
  // ruolo per l'intera finestra del token, se req.user venisse dal payload — qui sopra
  // la riga fresca serve comunque per il controllo `active`, usarla per intero non
  // costa nessuna query in più.
  req.user = { id: user.id, email: user.email, role: user.role, companyId: user.companyId };
  next();
}

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      // requireRole presuppone che requireAuth sia già passato prima nella catena
      // (req.user popolato). Se manca, chi ha montato le rotte ha sbagliato l'ordine
      // dei middleware: è un bug di programmazione, non un'autorizzazione mancata —
      // va trattato come 500 (errore interno), non come 401/403, altrimenti
      // nasconderebbe l'errore di configurazione dietro un codice che sembra corretto.
      next(new Error('requireRole chiamato senza requireAuth: req.user non è popolato'));
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      next(new ForbiddenError('Permesso negato: ruolo non autorizzato per questa operazione'));
      return;
    }

    next();
  };
}

/**
 * Middleware di scrittura "operaio-friendly": lascia passare
 *  - il ruolo "alwaysAllowed" (es. operaio: può scrivere le proprie risorse), e
 *  - i ruoli manager (es. admin, project_manager).
 * Il controllo fine ("solo le proprie righe") resta nel service, non qui.
 */
export function allowSelfOrManager(alwaysAllowed: UserRole, ...managerRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new Error('allowSelfOrManager chiamato senza requireAuth: req.user non è popolato'));
      return;
    }
    const allowed = [alwaysAllowed, ...managerRoles];
    if (!allowed.includes(req.user.role)) {
      next(new ForbiddenError('Permesso negato: ruolo non autorizzato per questa operazione'));
      return;
    }
    next();
  };
}
