import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { auditLog } from '../../core/db/schema';
import { NotFoundError } from '../../core/errors';
import type { PaginatedAuditLogs, PublicAuditLog, RecordAuditInput } from './auditLog.types';

// Sottoinsieme comune a `db` e a un client di transazione, stesso tipo già usato in
// rapportini.service.ts e timeLogs.service.ts: permette a recordAudit di scrivere sulla
// connessione del chiamante invece che su una presa dal pool.
type Scrivibile = Pick<typeof db, 'insert'>;

function toPublicAuditLog(row: typeof auditLog.$inferSelect): PublicAuditLog {
  const { ...publicRow } = row;
  return publicRow;
}

export async function listAuditLogs(
  page: number,
  limit: number,
  companyId: string,
  filters?: { entityType?: string; userId?: string },
): Promise<PaginatedAuditLogs> {
  const offset = (page - 1) * limit;
  // companyId è sempre presente (non opzionale, a differenza di entityType/userId):
  // l'audit log è per definizione scoped a un'azienda, mai una scelta del chiamante.
  const conditions = [
    eq(auditLog.companyId, companyId),
    filters?.entityType ? eq(auditLog.entityType, filters.entityType) : undefined,
    filters?.userId ? eq(auditLog.userId, filters.userId) : undefined,
  ].filter(Boolean);

  const [rows, [{ count }]] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(and(...(conditions as ReturnType<typeof eq>[])))
      .orderBy(desc(auditLog.timestamp))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(and(...(conditions as ReturnType<typeof eq>[]))),
  ]);

  return { auditLogs: rows.map(toPublicAuditLog), total: count, page, limit };
}

/**
 * Scrive una voce di audit. `scrivibile` è il `tx` del chiamante quando la chiamata
 * avviene dentro una transazione, e va SEMPRE passato in quel caso.
 *
 * Due ragioni, entrambe emerse da un difetto reale:
 * 1. Sul `db` globale questa INSERT prende una connessione DIVERSA da quella della
 *    transazione chiamante. La INSERT in audit_log prende un FOR KEY SHARE implicito
 *    sulla riga di companies (foreign key): se un'altra transazione tiene quella riga in
 *    FOR UPDATE e a sua volta aspetta un lock tenuto dal chiamante, si forma un'attesa
 *    circolare che Postgres NON vede — il grafo delle attese non contiene il legame
 *    "il chiamante aspetta il ritorno di questa chiamata", perché è nel codice, non nel
 *    database. Niente "deadlock detected": due connessioni appese per sempre, e il pool
 *    che si svuota una richiesta alla volta finché l'applicazione non risponde più.
 * 2. Su una connessione separata la voce di audit NON partecipa alla transazione: se il
 *    chiamante fa rollback, resta scritta una traccia di una modifica mai avvenuta.
 *
 * Il default `db` resta per i chiamanti che NON sono in transazione (es. il rinvio email
 * in rapportini.service.ts, dove l'audit è volutamente fuori dal percorso critico).
 */
export function recordAudit(input: RecordAuditInput, scrivibile: Scrivibile = db): Promise<PublicAuditLog> {
  return scrivibile
    .insert(auditLog)
    .values({
      companyId: input.companyId,
      userId: input.userId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      changesJson: input.changes ?? null,
    })
    .returning()
    .then(([row]) => toPublicAuditLog(row));
}

export async function getAuditLogById(id: string, companyId: string): Promise<PublicAuditLog> {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.id, id), eq(auditLog.companyId, companyId)))
    .limit(1);
  if (!row) {
    throw new NotFoundError('Voce di audit non trovata');
  }
  return toPublicAuditLog(row);
}
